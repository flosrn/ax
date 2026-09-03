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
import { RUNTIME_PATHS, excludeReceipt, setup } from '../src/worktree/setup.mjs';

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

/** stdout and stderr of one call, and its exit code. */
const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('').replace(/\u001B\[\d+m/g, '') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

/** A checkout that publishes ax at `version`, with a config the schema refuses. */
function skewed(version) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-skew-')));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@flosrn/ax', version }));
  writeFileSync(join(dir, 'ax.config.json'), JSON.stringify({ project: { name: 'p' }, apps: { web: 5 } }));
  return dir;
}

test('a config refusal in a checkout carrying another ax than the one running says so (#84)', () => {
  // The measured failure: `1 problem(s) in ax.config.json` from a 0.17.0 global
  // reading a 0.18.0-dev config. The only repair that line suggests is editing
  // the config, and the config was right.
  const checkout = skewed('0.0.1-skewed');
  const refused = capture(() => setup([], { cwd: checkout }));

  assert.equal(refused.code, 1, 'the exit code is untouched');
  assert.match(refused.out, /problem\(s\) in ax\.config\.json/, 'and so is the sentence itself');
  assert.match(refused.out, /0\.0\.1-skewed/, 'the version the checkout publishes is named');
  assert.match(refused.out, /own ax/, 'with the repair that actually applies');

  // A consumer project's refusal is unchanged: it publishes no ax.
  const consumer = skewed('0.0.1-skewed');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.1-skewed' }));
  const plain = capture(() => setup([], { cwd: consumer }));
  assert.equal(plain.code, 1);
  assert.match(plain.out, /problem\(s\) in ax\.config\.json/);
  assert.doesNotMatch(plain.out, /own ax/);
});
