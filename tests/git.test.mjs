// Built against REAL repositories in a temp dir, because the whole point of
// these functions is what `git rev-parse` answers from a linked worktree and
// from a subdirectory of one. A mocked filesystem cannot have a common dir, so
// it would prove nothing about the only case that has ever broken here.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  MAIN_CHECKOUT_ENV,
  addWorktree,
  excludePaths,
  installHooks,
  isMainCheckout,
  listWorktrees,
  mainCheckout,
  removeWorktree,
  repoRoot,
} from '../src/git.mjs';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

let fixture = '';
let main = '';
/** A worktree whose path contains a space, which is the case that breaks parsers. */
let spaced = '';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

before(() => {
  // realpath up front: os.tmpdir() is a symlink on macOS and git reports
  // physical paths, so every expectation below would compare unequal.
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ax-git-')));
  main = join(fixture, 'main');
  mkdirSync(join(main, 'apps', 'web'), { recursive: true });
  git(main, 'init', '-q');
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  git(main, 'add', '-A');
  execFileSync('git', [...IDENTITY, 'commit', '-qm', 'fixture'], { cwd: main, stdio: 'ignore' });

  spaced = join(fixture, 'wt with space');
  assert.equal(addWorktree({ cwd: main, path: spaced, branch: 'feature/spaced' }).ok, true);
});

after(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test('repoRoot answers the working tree, from anywhere inside it', () => {
  assert.equal(repoRoot(main), main);
  assert.equal(repoRoot(join(main, 'apps', 'web')), main);
  assert.equal(repoRoot(spaced), spaced);
  assert.equal(repoRoot(fixture), undefined); // outside any repository
});

test('a linked worktree resolves to the primary checkout, not to its own parent', () => {
  assert.equal(mainCheckout(main), main);
  assert.equal(mainCheckout(spaced), main);
  // `join(worktreePath, '..')` would answer the fixture dir here — the bug this
  // function is written to avoid.
  assert.notEqual(mainCheckout(spaced), fixture);
});

test('called from a SUBDIRECTORY of a linked worktree, the relative common dir is still anchored right', () => {
  // The regression: `--git-common-dir` answers relative to the CALLER, so from
  // two levels down it returns `../../.git`. Re-anchoring that at the worktree
  // root points outside the repository entirely.
  const deep = join(spaced, 'apps', 'web');
  mkdirSync(deep, { recursive: true });
  assert.equal(mainCheckout(deep), main);
  assert.equal(mainCheckout(join(main, 'apps', 'web')), main);
});

test('isMainCheckout separates the primary checkout from its worktrees', () => {
  assert.equal(isMainCheckout(main), true);
  assert.equal(isMainCheckout(join(main, 'apps', 'web')), true);
  assert.equal(isMainCheckout(spaced), false);
  assert.equal(isMainCheckout(fixture), false);
});

test('an override env var wins, but only when it names a directory that exists', () => {
  const elsewhere = join(fixture, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  assert.equal(mainCheckout(spaced, { env: { [MAIN_CHECKOUT_ENV]: elsewhere } }), elsewhere);
  // A stale override must not shadow the real answer with a nonexistent path.
  assert.equal(mainCheckout(spaced, { env: { [MAIN_CHECKOUT_ENV]: join(fixture, 'gone') } }), main);
  assert.equal(mainCheckout(spaced, { env: {} }), main);
});

test('listWorktrees reads back a path containing a space', () => {
  const entries = listWorktrees(main);
  assert.deepEqual(
    entries.map(entry => entry.path),
    [main, spaced],
  );

  const linked = entries[1];
  assert.equal(linked.branch, 'feature/spaced'); // short name, not refs/heads/…
  assert.match(linked.head, /^[0-9a-f]{40}$/);
  assert.equal(linked.detached, false);
  assert.equal(linked.bare, false);
  assert.equal(linked.locked, false);

  // Same answer asked from the worktree, and from a subdirectory of it.
  assert.deepEqual(listWorktrees(spaced), entries);
  assert.deepEqual(listWorktrees(join(spaced, 'apps', 'web')), entries);
});

test('a detached worktree reports no branch rather than a fake one', () => {
  const detached = join(fixture, 'detached');
  assert.equal(addWorktree({ cwd: main, path: detached, base: 'HEAD' }).ok, true);
  const entry = listWorktrees(main).find(item => item.path === detached);
  assert.equal(entry.detached, true);
  assert.equal(entry.branch, undefined);
  assert.equal(removeWorktree({ cwd: main, path: detached }).ok, true);
});

test('add and remove report git failures as data, without throwing', () => {
  const taken = addWorktree({ cwd: main, path: join(fixture, 'again'), branch: 'feature/spaced' });
  assert.equal(taken.ok, false);
  assert.notEqual(taken.status, 0);
  assert.match(taken.out, /feature\/spaced/);

  const missing = removeWorktree({ cwd: main, path: join(fixture, 'never-existed') });
  assert.equal(missing.ok, false);
  assert.notEqual(missing.out, '');
});

test('excludePaths appends what is missing, once, and reports what it added', () => {
  const wanted = ['.agent/', '.ax-worktree.json', 'apps/e2e/test-results/'];
  assert.deepEqual(excludePaths(main, wanted), wanted);

  const file = join(main, '.git', 'info', 'exclude');
  assert.equal(existsSync(file), true);
  const written = readFileSync(file, 'utf8');
  for (const entry of wanted) assert.equal(written.split('\n').includes(entry), true);

  // Idempotence is the promise: session start calls this every time.
  assert.deepEqual(excludePaths(main, wanted), []);
  assert.equal(readFileSync(file, 'utf8'), written);

  // Partial overlap adds only the new entry.
  assert.deepEqual(excludePaths(main, [...wanted, 'coverage/']), ['coverage/']);
});

test('excludePaths reaches the shared exclude file from a worktree subdirectory too', () => {
  const deep = join(spaced, 'apps', 'web');
  mkdirSync(deep, { recursive: true });
  assert.deepEqual(excludePaths(deep, ['.turbo/']), ['.turbo/']);
  // info/exclude is common state, so the entry lands in the primary checkout's
  // git dir and is already present for every other worktree.
  assert.equal(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8').includes('.turbo/'), true);
  assert.deepEqual(excludePaths(main, ['.turbo/']), []);
});

test('a whole-line match, so a negation mentioning the path does not count as present', () => {
  const file = join(main, '.git', 'info', 'exclude');
  writeFileSync(file, '!.cache/keep\n');
  assert.deepEqual(excludePaths(main, ['.cache/']), ['.cache/']);
  assert.equal(readFileSync(file, 'utf8'), '!.cache/keep\n.cache/\n');
});

test('a file with no trailing newline is extended, not corrupted', () => {
  const file = join(main, '.git', 'info', 'exclude');
  writeFileSync(file, 'no-newline');
  assert.deepEqual(excludePaths(main, ['.next/']), ['.next/']);
  assert.equal(readFileSync(file, 'utf8'), 'no-newline\n.next/\n');
});

test('installHooks is a no-op when the tracked hooks directory does not exist', () => {
  assert.equal(installHooks(main, '.githooks'), false);
  assert.equal(existsSync(join(main, '.git', 'hooks-path-marker')), false);
});

test('installHooks points core.hooksPath at the tracked directory, idempotently', () => {
  mkdirSync(join(main, '.githooks'), { recursive: true });
  writeFileSync(join(main, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');

  assert.equal(installHooks(main, '.githooks'), true);
  const configured = () => execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: main, encoding: 'utf8' }).trim();
  assert.equal(configured(), '.githooks');

  assert.equal(installHooks(main, '.githooks'), true);
  assert.equal(configured(), '.githooks');

  // A relative path is what makes the repo-wide setting valid from a worktree,
  // where the directory exists at the same place in the tree.
  mkdirSync(join(spaced, '.githooks'), { recursive: true });
  assert.equal(installHooks(spaced, '.githooks'), true);
  assert.equal(configured(), '.githooks');
});
