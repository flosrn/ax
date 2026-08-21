// The committed `bin/ax` runs in the one situation nothing else does: a linked
// worktree whose node_modules do not exist yet, because installing them is the
// job being asked for. Its resolution order is therefore load-bearing, and only
// a real `git worktree add` proves it — a temp directory would exercise the
// branch that never breaks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'bootstrap', 'ax');

let main = '';
let linked = '';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** A fake `ax` that reports which node_modules it was reached through. */
function installFakeAx(root, label) {
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, 'ax');
  writeFileSync(path, `#!/bin/sh\necho "resolved:${label} args:$*"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** `cwd` is where the caller stands; `scriptRoot` is the checkout carrying bin/ax. */
const runBootstrap = (cwd, scriptRoot = cwd) => {
  try {
    return { status: 0, out: execFileSync('sh', [join(scriptRoot, 'bin', 'ax'), 'doctor'], { cwd, encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

before(() => {
  main = mkdtempSync(join(tmpdir(), 'ax-main-'));
  mkdirSync(join(main, 'bin'), { recursive: true });
  writeFileSync(join(main, 'bin', 'ax'), readFileSync(BOOTSTRAP, 'utf8'));
  chmodSync(join(main, 'bin', 'ax'), 0o755);
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'fixture' }));
  git(main, 'init', '-q');
  git(main, 'add', '-A');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], {
    cwd: main,
    stdio: 'ignore',
  });
  linked = join(main, '.worktrees', 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
});

after(() => rmSync(main, { recursive: true, force: true }));

test('with no install anywhere, it fails locally and names the repair', () => {
  const result = runBootstrap(linked);
  // Deterministic and offline: never a network fetch of an unpinned version.
  assert.equal(result.status, 127);
  assert.match(result.out, /ax: not installed in/);
  // realpath, because macOS serves /var as a symlink to /private/var and the
  // shell resolves it — the point is that it names the PRIMARY checkout.
  assert.match(result.out, new RegExp(`pnpm install --dir '${realpathSync(main)}'$`, 'm'));
});

test('from a linked worktree it reaches the primary checkout install', () => {
  installFakeAx(main, 'main');
  const result = runBootstrap(linked);
  assert.equal(result.status, 0);
  assert.match(result.out, /resolved:main args:doctor/);
});

test('a worktree with its own install prefers it over the primary one', () => {
  installFakeAx(linked, 'worktree');
  const result = runBootstrap(linked);
  assert.equal(result.status, 0);
  assert.match(result.out, /resolved:worktree args:doctor/);
});

test('in the primary checkout it uses its own install', () => {
  const result = runBootstrap(main);
  assert.equal(result.status, 0);
  assert.match(result.out, /resolved:main args:doctor/);
});

test('run from a package subdirectory, it still resolves the right checkout', () => {
  // The regression this test exists for: `git rev-parse --git-common-dir`
  // answers relative to the CALLER, so asking from apps/web returned `../../.git`
  // and re-anchoring that under the root pointed two levels above the repo —
  // a directory with no install, named in the repair command.
  mkdirSync(join(main, 'apps', 'web'), { recursive: true });
  const fromMain = runBootstrap(join(main, 'apps', 'web'), main);
  assert.equal(fromMain.status, 0);
  assert.match(fromMain.out, /resolved:main args:doctor/);

  mkdirSync(join(linked, 'apps', 'web'), { recursive: true });
  const fromWorktree = runBootstrap(join(linked, 'apps', 'web'), linked);
  assert.equal(fromWorktree.status, 0);
  assert.match(fromWorktree.out, /resolved:worktree args:doctor/);
});

test('a path with a space is emitted as a command that survives being pasted', () => {
  const spaced = join(mkdtempSync(join(tmpdir(), 'ax-space-')), 'my repo');
  mkdirSync(join(spaced, 'bin'), { recursive: true });
  writeFileSync(join(spaced, 'bin', 'ax'), readFileSync(BOOTSTRAP, 'utf8'));
  chmodSync(join(spaced, 'bin', 'ax'), 0o755);
  git(spaced, 'init', '-q');

  const result = runBootstrap(spaced);
  assert.equal(result.status, 127);
  assert.match(result.out, new RegExp(`--dir '${realpathSync(spaced)}'`));
  rmSync(dirname(spaced), { recursive: true, force: true });
});
