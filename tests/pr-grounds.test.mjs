// The grounds, each answered through its own interface — real temp git repos
// for the git-backed ones, a body string for the keyword detector — instead of
// only through gate()'s full argv-and-seven-stubs pipeline. gate() keeps its
// own suite; these tests exist because proving ONE ground used to require
// stubbing every other one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { gitGrounds, keywordGround, threadsGround } from '../src/pr-grounds.mjs';
import { defaultExec } from '../src/exec.mjs';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

const realGit = (args, at) => defaultExec('git', args, at);

/** A real repository: `main` holds one commit, `feature` branches from it. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ax-pr-grounds-'));
  const git = (...args) => execFileSync('git', [...IDENTITY, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'a');
  git('branch', 'feature');
  return { root, git };
}

function commitFile(target, git, rel, content, message) {
  const path = join(target, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  git('add', '.');
  git('commit', '-q', '-m', message);
}

const options = (root, extra = {}) => ({
  git: realGit,
  root,
  baseBranch: 'main',
  headBranch: 'feature',
  mergeState: '-',
  residualDir: '',
  ...extra,
});

test('staleness: a base that advanced past the branch is a named refusal', () => {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, 'c.txt', 'c\n', 'c');
  git('checkout', '-q', 'main');
  commitFile(root, git, 'b.txt', 'b\n', 'b');

  const out = gitGrounds(options(root));
  const stale = out.refusals.find(entry => entry.message.startsWith('staleness:'));
  assert.ok(stale, 'the advanced base is a refusal, not a note');
  assert.match(stale.message, /is not an ancestor/);
  assert.match(stale.repair, /git fetch origin main/);
});

test('staleness: a branch that carries its base is current, and local-only is said out loud', () => {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, 'c.txt', 'c\n', 'c');

  const out = gitGrounds(options(root));
  assert.equal(out.refusals.length, 0);
  assert.ok(out.notes.some(entry => /staleness: .* carries .* the branch is current/.test(entry.message)));
  assert.ok(out.notes.some(entry => /no 'origin' remote/.test(entry.message)), 'no origin is a situation, never assumed');
});

test('residual findings: a branch that superseded its own findings file is refused (F-009)', () => {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, join('docs', 'residual', 'pr.md'), 'findings\n', 'residual');
  commitFile(root, git, 'src.txt', 'more\n', 'later work');

  const out = gitGrounds(options(root, { residualDir: 'docs/residual' }));
  const residual = out.refusals.find(entry => entry.message.startsWith('residual findings:'));
  assert.ok(residual, 'a superseded findings file refuses');
  assert.match(residual.message, /1 of its own commit\(s\) landed after it/);
});

test('residual findings: a branch that wrote nothing names both readings instead of picking one (F-011)', () => {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, 'src.txt', 'work\n', 'work');

  const out = gitGrounds(options(root, { residualDir: 'docs/residual' }));
  assert.equal(out.refusals.length, 0);
  assert.ok(out.notes.some(entry => /no git measurement separates them/.test(entry.message)));
});

test('residual findings: undeclared means NOT RUN, said in the account', () => {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, 'c.txt', 'c\n', 'c');

  const out = gitGrounds(options(root));
  assert.ok(out.notes.some(entry => /residual findings: NOT RUN/.test(entry.message)));
});

test('threads: an undecided CI issues NO read at all — the dependency is in the signature', () => {
  const calls = [];
  const out = threadsGround({
    run: args => {
      calls.push(args);
      throw new Error('a thread read before CI is decided is no observation (F-031)');
    },
    owner: 'gapilabs',
    name: 'gapila',
    pr: '7',
    sha: 'e'.repeat(40),
    ciDecided: false,
    invocation: () => 'ax pr gate --pr 7',
  });
  assert.equal(calls.length, 0);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /CI is not decided/);
  assert.match(out.unknowns[0].repair, /ax pr gate --pr 7/);
});

test('closing keyword: Ferme #N is intent GitHub ignores — a refusal naming the phrase (F-018)', () => {
  const out = keywordGround({ body: 'Ferme #1786 en corrigeant le routeur.', tracker: undefined, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /'Ferme #1786' closes nothing/);
  assert.match(out.refusals[0].repair, /gh pr edit 7/);
});

test('closing keyword: Closes #N is recognised', () => {
  const out = keywordGround({ body: 'Closes #42.', tracker: undefined, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.ok(out.notes.some(entry => /'Closes #42' — GitHub will close the issue/.test(entry.message)));
});

test('closing keyword: a declared tracker names the ref the verb targets, not the first mention', () => {
  const body = 'Context: GAP-377 covers the background.\n\nFixes GAP-379.';
  const out = keywordGround({ body, tracker: { name: 'Linear', pattern: 'GAP-\\d+' }, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  const named = out.notes.find(entry => /Linear/.test(entry.message));
  assert.ok(named);
  assert.match(named.message, /'GAP-379'/);
  assert.match(named.message, /GitHub closes nothing there/);
});

test('closing keyword: no keyword and no tracker ref is a REFUSAL naming the repair (AE6)', () => {
  const out = keywordGround({ body: 'Tooling fix.', tracker: undefined, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /closes no issue and expresses no intent to/);
  assert.match(out.refusals[0].repair, /gh pr edit 7 --repo gapilabs\/gapila/);
});

test('closing keyword: a base that is not the default branch refuses — the keyword is inert there', () => {
  const out = keywordGround({
    body: 'Closes #42.',
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'develop',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /base 'develop' is not the default branch 'main'/);
  assert.match(out.refusals[0].message, /inert/);
  assert.ok(out.refusals[0].repair);
});

test('closing keyword: Closes #N on the default base passes unchanged', () => {
  const out = keywordGround({
    body: 'Closes #42.',
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'main',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 0);
  assert.equal(out.unknowns.length, 0);
  assert.ok(out.notes.some(entry => /'Closes #42' — GitHub will close the issue/.test(entry.message)));
});

test('closing keyword: half of the base pair is a ground unread, never an assumed match (F-028)', () => {
  const out = keywordGround({ body: 'Closes #42.', tracker: undefined, pr: '7', slug: 'gapilabs/gapila', baseBranch: 'develop' });
  assert.equal(out.refusals.length, 0);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /default branch/);
  assert.match(out.unknowns[0].repair, /gh repo view gapilabs\/gapila --json defaultBranchRef/);
});
