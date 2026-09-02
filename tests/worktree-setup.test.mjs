// `ax worktree setup` — the receipts it prints, held against what it writes.
//
// Built against a REAL repository with a linked worktree, because the one thing
// this file pins is a scope claim: `info/exclude` is common state, so an ignore
// appended from a linked worktree lands in the primary checkout's git dir and
// takes effect in every checkout of the repository. A receipt that says
// otherwise sends an operator looking for dirt on a checkout they never touched
// (#99), so the sentence and the write are asserted together here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { addWorktree, excludePaths } from '../src/git.mjs';
import { RUNTIME_PATHS, excludeReceipt } from '../src/worktree/setup.mjs';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

let fixture = '';
let main = '';
let linked = '';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

before(() => {
  // realpath first: os.tmpdir() is a symlink on macOS and git answers physical
  // paths, so every path comparison below would be unequal for no reason.
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ax-setup-')));
  main = join(fixture, 'main');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q');
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  git(main, 'add', '-A');
  execFileSync('git', [...IDENTITY, 'commit', '-qm', 'fixture'], { cwd: main, stdio: 'ignore' });

  linked = join(fixture, 'wt');
  assert.equal(addWorktree({ cwd: main, path: linked, branch: 'feature/scope' }).ok, true);
});

after(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test('the ignore receipt claims the scope git implements, never a worktree-local one', () => {
  const line = excludeReceipt(RUNTIME_PATHS);
  for (const path of RUNTIME_PATHS) assert.ok(line.includes(path), `the receipt names the paths it added: ${path}`);
  // The measured defect: `in this worktree only` for a write every checkout of
  // the repository reads.
  assert.doesNotMatch(line, /this worktree/);
  assert.match(line, /repositor/, 'the scope named is the repository');
  assert.match(line, /info\/exclude/, 'and the file the operator can go read');
});

test('the scope the receipt claims is the scope the write has, from a linked worktree', () => {
  // Appended from the linked side, the entry lands in the PRIMARY checkout's
  // git dir — the file `git rev-parse --git-path info/exclude` resolves — and
  // the main checkout goes quiet about a path nobody touched there.
  const added = excludePaths(linked, ['runtime-junk/']);
  assert.deepEqual(added, ['runtime-junk/']);

  const resolved = execFileSync('git', ['-C', linked, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
  assert.equal(resolved, join(main, '.git', 'info', 'exclude'), 'there is no per-worktree exclude file to write instead');
  assert.ok(readFileSync(resolved, 'utf8').split('\n').includes('runtime-junk/'));

  mkdirSync(join(main, 'runtime-junk'), { recursive: true });
  writeFileSync(join(main, 'runtime-junk', 'x'), '');
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: main, encoding: 'utf8' });
  assert.equal(status.includes('runtime-junk'), false, 'the ignore took effect on a checkout the command never ran in');
});
