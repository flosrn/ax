// The authentication artifact, verified once and read once.
//
// Real temp git repositories, because two of the rules ARE git's answer: the
// artifact must be ignored (a tracked storage state is a credential in a diff),
// and its path must resolve inside the worktree that claims it. The other half
// is filesystem truth — mode, symlinks, one descriptor — and a mocked fs would
// pin the mock.
//
// The last test is the reason the value, not the path, is what Chromium
// receives (R9): between validation and launch, anything may rewrite that file.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { run } from '../src/exec.mjs';
import { loadStorageState, LOCAL_HOSTS } from '../src/debug-as/auth-state.mjs';

const ARTIFACT = 'apps/e2e/.auth/owner@example.com.json';
const ORIGIN = 'http://localhost:3110';

const git = (cwd, ...args) => run('git', args, { cwd });

/** A worktree that ignores its auth directory, as every consumer's does. */
function worktree({ ignore = 'apps/e2e/.auth/\n' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-debug-auth-')));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'ax@example.com');
  git(root, 'config', 'user.name', 'ax');
  writeFileSync(join(root, '.gitignore'), ignore);
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-qm', 'init');
  mkdirSync(join(root, 'apps', 'e2e', '.auth'), { recursive: true });
  return root;
}

/** A well-formed artifact for the loopback origin. */
const local = (origin = ORIGIN) => ({
  cookies: [{ name: 'sb-access-token', value: 'local-value', domain: 'localhost', path: '/' }],
  origins: [{ origin, localStorage: [{ name: 'sb-auth', value: 'local-value' }] }],
});

function write(root, state, { path = ARTIFACT, mode = 0o600 } = {}) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
  chmodSync(file, mode);
  return file;
}

const load = (root, options = {}) => loadStorageState({ root, relativePath: ARTIFACT, browserOrigin: ORIGIN, ...options });

test('a private, ignored, contained artifact loads as a parsed value', async () => {
  const root = worktree();
  write(root, local());

  const answer = await load(root);
  assert.equal(answer.refreshNeeded, false);
  assert.equal(answer.state.origins[0].origin, ORIGIN);
  assert.equal(answer.state.cookies[0].name, 'sb-access-token');
});

test('an artifact missing the browser origin is an adapter refresh, not a refusal', async () => {
  const root = worktree();
  write(root, local('http://localhost:3999'));

  const answer = await load(root);
  assert.equal(answer.refreshNeeded, true);
  assert.ok(answer.state, 'the value is still returned so a caller can decide');
});

test('an absent artifact names the adapter as its repair rather than refusing the run', async () => {
  const root = worktree();
  await assert.rejects(load(root), error => {
    assert.equal(error.code, 'MISSING');
    assert.ok(error.fix);
    return true;
  });
});

test('a group- or other-readable artifact refuses with the exact mode repair', async () => {
  for (const mode of [0o644, 0o640, 0o604]) {
    const root = worktree();
    write(root, local(), { mode });
    await assert.rejects(load(root), error => {
      assert.match(error.fix, /chmod 600/);
      assert.match(error.message, /read/);
      return true;
    }, String(mode));
  }
});

test('an artifact that is not ignored by git refuses before Chromium starts', async () => {
  const root = worktree({ ignore: 'node_modules/\n' });
  write(root, local());

  await assert.rejects(load(root), error => {
    assert.match(error.message, /ignored/);
    assert.ok(error.fix);
    return true;
  });
});

test('an artifact outside the worktree refuses, whether it is named relatively or absolutely', async () => {
  const root = worktree();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ax-debug-outside-')));
  write(outside, local(), { path: 'owner.json' });

  for (const relativePath of ['../ax-debug-outside/owner.json', join(outside, 'owner.json'), '../../etc/passwd']) {
    await assert.rejects(loadStorageState({ root, relativePath, browserOrigin: ORIGIN }), error => {
      assert.ok(error.fix, relativePath);
      return true;
    }, relativePath);
  }
});

test('a symlinked artifact refuses even when its target is private and ignored', async () => {
  const root = worktree();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ax-debug-link-')));
  const target = write(outside, local(), { path: 'owner.json' });
  symlinkSync(target, join(root, ARTIFACT));

  await assert.rejects(load(root), error => {
    assert.match(error.message, /symlink|regular file/);
    assert.ok(error.fix);
    return true;
  });
});

test('a symlink directory on the path refuses even when the file itself is a regular file inside the worktree', async () => {
  const root = worktree({ ignore: 'apps/e2e/.auth/\napps/e2e/real-auth/\n' });
  write(root, local());
  const realAuth = join(root, 'apps', 'e2e', 'real-auth');
  mkdirSync(realAuth, { recursive: true });
  renameSync(join(root, ARTIFACT), join(realAuth, 'owner@example.com.json'));
  chmodSync(join(realAuth, 'owner@example.com.json'), 0o600);
  rmSync(join(root, 'apps', 'e2e', '.auth'), { recursive: true });
  symlinkSync(realAuth, join(root, 'apps', 'e2e', '.auth'));

  await assert.rejects(load(root), error => {
    assert.match(error.message, /symlink/);
    assert.ok(error.fix);
    return true;
  });
});

test('a JSON null artifact refuses with a repair, not a TypeError', async () => {
  const root = worktree();
  const file = write(root, local());
  writeFileSync(file, 'null');
  chmodSync(file, 0o600);

  await assert.rejects(load(root), error => {
    assert.ok(error.fix);
    assert.notEqual(error.name, 'TypeError');
    return true;
  });
});

test('a production cookie refuses before anything is launched', async () => {
  const root = worktree();
  write(root, {
    cookies: [
      { name: 'sb-access-token', value: 'v', domain: 'localhost', path: '/' },
      { name: 'sb-refresh-token', value: 'v', domain: '.app.example.com', path: '/' },
    ],
    origins: [{ origin: ORIGIN, localStorage: [] }],
  });

  await assert.rejects(load(root), error => {
    assert.match(error.message, /app\.example\.com/);
    assert.ok(error.fix);
    return true;
  });
});

test('a production localStorage entry refuses, even beside a correct local one', async () => {
  const root = worktree();
  write(root, {
    cookies: [],
    origins: [
      { origin: ORIGIN, localStorage: [{ name: 'sb-auth', value: 'v' }] },
      { origin: 'https://app.example.com', localStorage: [{ name: 'sb-auth', value: 'production' }] },
    ],
  });

  await assert.rejects(load(root), error => {
    assert.match(error.message, /app\.example\.com/);
    return true;
  });
});

test('the worktree\'s own recorded direct host counts as local, and nothing else does', async () => {
  const root = worktree();
  write(root, {
    cookies: [{ name: 'sb', value: 'v', domain: '127.0.0.1', path: '/' }],
    origins: [{ origin: ORIGIN, localStorage: [] }, { origin: 'http://127.0.0.1:3110', localStorage: [] }],
  });

  const answer = await load(root, { addresses: { directOrigin: 'http://127.0.0.1:3110' } });
  assert.equal(answer.refreshNeeded, false);
});

test('a malformed artifact refuses with a repair rather than a parse stack', async () => {
  const root = worktree();
  const file = write(root, local());
  writeFileSync(file, '{ not json');
  chmodSync(file, 0o600);

  await assert.rejects(load(root), error => {
    assert.ok(error.fix);
    assert.doesNotMatch(error.message, /Unexpected token.*JSON\.parse/s);
    return true;
  });
});

test('swapping the file after validation cannot change the value Chromium receives', async () => {
  const root = worktree();
  const file = write(root, local());

  const answer = await load(root);
  writeFileSync(file, JSON.stringify({ cookies: [{ name: 'sb', value: 'production', domain: '.app.example.com', path: '/' }], origins: [] }));

  assert.equal(answer.state.cookies[0].domain, 'localhost');
  assert.equal(answer.state.cookies.length, 1);
});

test('the local address vocabulary is the shared one', () => {
  assert.ok(LOCAL_HOSTS.has('localhost'));
});
