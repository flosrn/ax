// The grounds, each answered through its own interface — real temp git repos
// for the git-backed ones, a channel set for the keyword detector — instead of
// only through gate()'s full argv-and-seven-stubs pipeline. gate() keeps its
// own suite; these tests exist because proving ONE ground used to require
// stubbing every other one.
//
// EVERY CLOSING CONSTRUCT HERE IS INERT unless the construct itself is the
// subject under test: this repository's own rule is that prose quoting a
// control construct arms it (docs/solutions/bugs/a-check-whose-subject-comes-
// from-the-subject.md), and these fixtures are read by the machine that acts on
// them. The armed ones name issue numbers no tracker of ours uses (#42, #1786).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  closedIssuesOf,
  closingChannels,
  commitsGround,
  declarationGround,
  gitGrounds,
  keywordGround,
  mergePolicy,
  prCommits,
  readRelease,
  releaseShape,
  threadsGround,
  ticketGround,
} from '../src/pr-grounds.mjs';
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

// ── Ground 7: the closing keyword, over every channel a merge closes from ───

/** The one channel a repository whose commit messages never reach main has. */
const bodyOnly = text => [{ kind: 'body', label: 'the body', text, sha: '' }];

/** A commit message channel: what the merge message will carry, and from where. */
const fromCommit = (sha, text) => ({ kind: 'commit', label: `commit ${sha}`, text, sha });

/** The pull request title, wherever policy makes it the subject that lands. */
const fromTitle = text => ({ kind: 'title', label: 'the PR title', text, sha: '' });

test('closing keyword: Ferme #N is intent GitHub ignores — a refusal naming the phrase (F-018)', () => {
  const out = keywordGround({ channels: bodyOnly('Ferme #1786 en corrigeant le routeur.'), tracker: undefined, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /'Ferme #1786' closes nothing/);
  assert.match(out.refusals[0].repair, /gh pr edit 7/);
});

test('closing keyword: Closes #N is recognised', () => {
  const out = keywordGround({ channels: bodyOnly('Closes #42.'), tracker: undefined, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.ok(out.notes.some(entry => /'Closes #42' — GitHub will close the issue/.test(entry.message)));
});

test('closing keyword: a declared tracker names the ref the verb targets, not the first mention', () => {
  const body = 'Context: GAP-377 covers the background.\n\nFixes GAP-379.';
  const out = keywordGround({ channels: bodyOnly(body), tracker: { name: 'Linear', pattern: 'GAP-\\d+' }, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  const named = out.notes.find(entry => /Linear/.test(entry.message));
  assert.ok(named);
  assert.match(named.message, /'GAP-379'/);
  assert.match(named.message, /GitHub closes nothing there/);
});

test('closing keyword: no keyword and no tracker ref is a REFUSAL naming the repair (AE6)', () => {
  const out = keywordGround({ channels: bodyOnly('Tooling fix.'), tracker: undefined, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /closes no issue and expresses no intent to/);
  assert.match(out.refusals[0].repair, /gh pr edit 7 --repo gapilabs\/gapila/);
});

test('closing keyword: a base that is not the default branch refuses — the keyword is inert there', () => {
  const out = keywordGround({
    channels: bodyOnly('Closes #42.'),
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
    channels: bodyOnly('Closes #42.'),
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
  const out = keywordGround({ channels: bodyOnly('Closes #42.'), tracker: undefined, pr: '7', slug: 'gapilabs/gapila', baseBranch: 'develop' });
  assert.equal(out.refusals.length, 0);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /default branch/);
  assert.match(out.unknowns[0].repair, /gh repo view gapilabs\/gapila --json defaultBranchRef/);
});

test('closing keyword: a construct in a commit message is closing intent, and names its channel (#86)', () => {
  // The false absence this fix removes: the body says nothing, the merge
  // message says everything, and the ground used to print "closes no issue".
  const out = keywordGround({
    channels: [{ kind: 'body', label: 'the body', text: 'A repair with no description.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: the gate\n\nCloses #42')],
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'main',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 0, 'a construct GitHub acts on is not an absence');
  assert.equal(out.unknowns.length, 0);
  const named = out.notes.find(entry => /closing keyword/.test(entry.message));
  assert.match(named.message, /'Closes #42' in commit a1b2c3d4e5f6 — GitHub will close the issue/);
  assert.doesNotMatch(named.message, /fix: the gate/, 'only the matched phrase is echoed, never the surrounding message');
});

test('closing keyword: the absence refusal names every channel it read, never the body alone (#86)', () => {
  const out = keywordGround({
    channels: [{ kind: 'body', label: 'the body', text: 'Tooling fix.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'chore: tidy'), fromCommit('b2c3d4e5f6a1', 'chore: tidy again')],
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'main',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /neither the body nor commit a1b2c3d4e5f6, commit b2c3d4e5f6a1 closes an issue/);
});

test('closing keyword: base inertness outranks the channel — a commit construct closes nothing there either (#86)', () => {
  const out = keywordGround({
    channels: [{ kind: 'body', label: 'the body', text: 'No description.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #42')],
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'develop',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /base 'develop' is not the default branch 'main'/);
  const named = out.notes.find(entry => /closing keyword/.test(entry.message));
  assert.match(named.message, /inert on this base/);
  assert.doesNotMatch(named.message, /GitHub will close the issue/);
});

test('closing keyword: a wrong-verb form in a commit message is repaired on the message, not on the body (#86)', () => {
  const out = keywordGround({
    channels: [{ kind: 'body', label: 'the body', text: 'No description.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nFerme #1786')],
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'main',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /'Ferme #1786' in commit a1b2c3d4e5f6 closes nothing/);
  assert.match(out.refusals[0].repair, /git rebase -i a1b2c3d4e5f6\^/);
});

// ── The closure set: one derivation over every channel ──────────────────────

test('closure set: the union is deduplicated, ascending, and carries the channel that named each ticket (#86)', () => {
  const closes = closedIssuesOf([
    { kind: 'body', label: 'the body', text: 'Closes #42\n\nAlso resolves #7', sha: '' },
    fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #42'),
    fromCommit('b2c3d4e5f6a1', 'fix: more\n\nFixes #11'),
  ]);
  assert.deepEqual(
    closes.map(entry => entry.issue),
    [7, 11, 42],
  );
  assert.deepEqual(
    closes.find(entry => entry.issue === 42).sources.map(source => source.label),
    ['the body', 'commit a1b2c3d4e5f6'],
  );
  assert.deepEqual(
    closes.find(entry => entry.issue === 11).sources.map(source => source.sha),
    ['b2c3d4e5f6a1'],
  );
});

test('closure set: a cross-repository target stays out of it, in a commit message exactly as in the body (#86)', () => {
  const closes = closedIssuesOf([
    { kind: 'body', label: 'the body', text: 'Closes other/repo#9', sha: '' },
    fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses https://github.com/other/repo/issues/12'),
  ]);
  assert.deepEqual(closes, []);
});

// ── Ground 9: the ticket binding, over the same set ─────────────────────────

const BOUND = { ok: true, issue: 42, source: '--issue' };

test('ticket binding: a commit message closing another ticket refuses BEFORE the merge (#86)', () => {
  const channels = [{ kind: 'body', label: 'the body', text: 'Closes #42', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nFixes #11')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /#11/);
  assert.match(out.refusals[0].message, /commit a1b2c3d4e5f6/);
  assert.match(out.refusals[0].repair, /git rebase -i a1b2c3d4e5f6\^/);
  assert.doesNotMatch(out.refusals[0].repair, /gh pr edit/, 'the repair is actionable on the message that carries it');
});

test('ticket binding: the body may still declare a sibling closure — that one is named, never refused', () => {
  const channels = bodyOnly('Closes #42\n\nCloses #99');
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.match(out.notes[0].message, /it also closes #99, which GitHub closes too/);
});

test('ticket binding: a sibling the body DECLARES is not refused when a commit repeats it (#86)', () => {
  // The construct is in the description a reviewer read; the commit message
  // only repeats it. What refuses is a closure nobody could see, not a
  // duplicated one.
  const channels = [{ kind: 'body', label: 'the body', text: 'Closes #42\n\nCloses #99', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #99')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.match(out.notes[0].message, /it also closes #99/);
});

test('ticket binding: a commit message closing the BOUND ticket satisfies the ground (#86)', () => {
  const channels = [{ kind: 'body', label: 'the body', text: 'A repair.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #42')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.match(out.notes[0].message, /commit a1b2c3d4e5f6 closes #42, the ticket this merge is for \(--issue\)/);
});

test('ticket binding: nothing closing anywhere names every channel it read (#86)', () => {
  const channels = [{ kind: 'body', label: 'the body', text: 'A repair.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /neither the body nor commit a1b2c3d4e5f6 closes a same-repository issue/);
});

test('closing keyword: a construct in the PR TITLE is closing intent, and names the title (#86)', () => {
  const out = keywordGround({
    channels: [{ kind: 'body', label: 'the body', text: 'A repair with no description.', sha: '' }, fromTitle('fix: the gate — Closes #42')],
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'main',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 0);
  assert.match(out.notes[0].message, /'Closes #42' in the PR title — GitHub will close the issue/);
});

test('closing keyword: a wrong-verb form in the title is repaired on the title (#86)', () => {
  const out = keywordGround({
    channels: [{ kind: 'body', label: 'the body', text: 'No description.', sha: '' }, fromTitle('Ferme #1786')],
    tracker: undefined,
    pr: '7',
    slug: 'gapilabs/gapila',
    baseBranch: 'main',
    defaultBranch: 'main',
  });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /'Ferme #1786' in the PR title closes nothing/);
  assert.match(out.refusals[0].repair, /gh pr edit 7 --repo gapilabs\/gapila --title/);
});

test('ticket binding: a PR TITLE closing another ticket refuses, and repairs on the title (#86)', () => {
  // The title reaches the default branch as the merge commit's subject, so a
  // construct there closes exactly like one in a commit message — and the body
  // a reviewer read declared only the bound ticket.
  const channels = [{ kind: 'body', label: 'the body', text: 'Closes #42', sha: '' }, fromTitle('fix: the gate — Fixes #11')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /the PR title closes #11/);
  assert.match(out.refusals[0].repair, /gh pr edit 7 --repo gapilabs\/gapila --title/);
});

// ── The merge-message policy, read once ────────────────────────────────────

/** ax's own, read 2026-09-03 with `gh api repos/flosrn/ax`. */
const REPO_PAYLOAD = {
  squash_merge_commit_message: 'COMMIT_MESSAGES',
  squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
  merge_commit_title: 'MERGE_MESSAGE',
  merge_commit_message: 'PR_TITLE',
  allow_squash_merge: true,
  allow_merge_commit: true,
  allow_rebase_merge: false,
};

const answering = value => () => ({ status: 0, stdout: JSON.stringify(value), stderr: '', error: undefined });
const failing = stderr => () => ({ status: 1, stdout: '', stderr, error: undefined });

test('merge policy: one gh api repos/<slug> read answers every fact the predicate needs (#86)', () => {
  const calls = [];
  const policy = mergePolicy({
    run: args => {
      calls.push(args.join(' '));
      return answering(REPO_PAYLOAD)();
    },
    slug: 'o/r',
  });
  assert.deepEqual(calls, ['api repos/o/r']);
  assert.deepEqual(policy, {
    ok: true,
    squashMessage: 'COMMIT_MESSAGES',
    squashTitle: 'COMMIT_OR_PR_TITLE',
    mergeTitle: 'MERGE_MESSAGE',
    mergeMessage: 'PR_TITLE',
    allowed: ['squash', 'merge'],
  });
});

test('merge policy: an unread or incomplete payload is a reason and a repair, never a default (#86)', () => {
  const failed = mergePolicy({ run: failing('HTTP 502'), slug: 'o/r' });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /'gh api repos\/o\/r' failed — HTTP 502/);
  assert.match(failed.repair, /gh api repos\/o\/r/);

  const partial = mergePolicy({ run: answering({ ...REPO_PAYLOAD, squash_merge_commit_message: undefined }), slug: 'o/r' });
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /'squash_merge_commit_message' is absent from the payload/);

  const none = mergePolicy({ run: answering({ ...REPO_PAYLOAD, allow_squash_merge: false, allow_merge_commit: false }), slug: 'o/r' });
  assert.equal(none.ok, false);
  assert.match(none.reason, /names no allowed merge method/);
});

test('merge policy: a value this predicate does not know is unread, never inert (#86)', () => {
  // The predicate is exhaustive over the documented values. A value it cannot
  // place would otherwise fall through every arm and read as "nothing reaches
  // the default branch" — F-028's failure with a spelling instead of an
  // absence.
  const unknown = mergePolicy({ run: answering({ ...REPO_PAYLOAD, squash_merge_commit_title: 'PR_TITLE_AND_NUMBER' }), slug: 'o/r' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /'squash_merge_commit_title' names 'PR_TITLE_AND_NUMBER'/);
  assert.match(unknown.reason, /which text reaches the default branch is undecided/);
  assert.match(unknown.repair, /gh api repos\/o\/r/);
});

// ── The commits, read once for both the detector and the channel ───────────

const commitRow = (sha, message, date = '2026-08-09T09:00:00Z', parents = [{ sha: '0'.repeat(40) }]) => ({
  sha,
  commit: { message, committer: { date } },
  parents,
});

test('pr commits: one read, named keys, and the messages come with it (#86)', () => {
  const calls = [];
  const answer = prCommits({
    run: args => {
      calls.push(args.join(' '));
      return answering([commitRow('a'.repeat(40), 'fix: one'), commitRow('b'.repeat(40), 'fix: two')])();
    },
    slug: 'o/r',
    pr: '7',
  });
  assert.deepEqual(calls, ['api repos/o/r/pulls/7/commits?per_page=100']);
  assert.equal(answer.ok, true);
  assert.deepEqual(
    answer.commits.map(entry => entry.message),
    ['fix: one', 'fix: two'],
  );
  assert.equal(answer.commits[0].when, Date.parse('2026-08-09T09:00:00Z'));
});

test('pr commits: a full page is a list this run cannot prove complete (#86)', () => {
  const rows = [];
  for (let i = 0; i < 100; i += 1) rows.push(commitRow(String(i).padStart(40, '0'), `fix: ${i}`));
  const answer = prCommits({ run: answering(rows), slug: 'o/r', pr: '7' });
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /a full page of 100 commit\(s\), so this run cannot prove the list complete/);
  assert.match(answer.repair, /gh api --paginate repos\/o\/r\/pulls\/7\/commits/);
});

test('pr commits: a payload missing a named key is the reason each consumer prefixes (#86)', () => {
  const answer = prCommits({ run: answering([{ sha: 'x' }]), slug: 'o/r', pr: '7' });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "a PR commit: 'commit' is absent from the payload");

  const out = commitsGround({ commits: answer, slug: 'o/r', pr: '7', openedAt: 0, ackBody: false, invocation: () => 'ax pr gate --pr 7' });
  assert.equal(out.unknowns.length, 1);
  assert.equal(out.unknowns[0].message, "commits since open: a PR commit: 'commit' is absent from the payload");
});

// ── Ground 6's shape rule: a clean merge FROM the base is base movement ────
//
// #90: the gate's own staleness self-repair runs `gh pr update-branch`, and the
// merge that produces is committed after the PR opened — so the detector listed
// it and refused, printing an `--ack-body` repair for a commit that did not
// exist when the caller typed the command. The exemption is a PREDICATE ON THE
// COMMIT (two parents, the second one the base reaches, and no content of its
// own), re-derived on every run, so it holds in the process that minted the
// commit and in every later one; nothing is remembered anywhere.

const OPENED_AT = Date.parse('2026-08-09T10:00:00Z');
const LATE = '2026-08-09T11:00:00Z';

/** The gate's own reading of a real commit, as the PR commits payload gives it. */
const realRow = (root, ref, date = LATE) => {
  const read = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sha = read(['rev-parse', ref]);
  return commitRow(
    sha,
    read(['log', '-1', '--format=%s', sha]),
    date,
    read(['show', '-s', '--format=%P', sha])
      .split(' ')
      .map(parent => ({ sha: parent })),
  );
};

/**
 * A repository whose `feature` tip is a MERGE, in the four shapes that decide
 * the exemption: the clean merge of the base, the same merge carrying content
 * of its own (an evil merge), a merge of some other branch, and the one that
 * broke the first predicate — a `-X ours` merge that DROPS the base's change to
 * a file, whose combined diff is empty because each path matches a parent
 * wholesale.
 */
function mergedRepo({ evil = false, foreign = false, dropsBaseChange = false } = {}) {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, 'f.txt', 'f\n', 'feature work');
  if (foreign) {
    git('checkout', '-q', '-b', 'other', 'main');
    commitFile(root, git, 'o.txt', 'o\n', 'work on another branch');
    git('checkout', '-q', 'feature');
    git('merge', '-q', '--no-ff', '-m', "Merge branch 'other' into feature", 'other');
    return { root, git };
  }
  if (dropsBaseChange) {
    // Both sides touch a.txt, and the merge keeps the branch's version: two
    // parents, the second one the base reaches, `git diff-tree --cc` EMPTY, and
    // the base's change discarded. An ordinary merge of these parents conflicts.
    commitFile(root, git, 'a.txt', 'the branch rewrote this\n', 'the branch changes a.txt');
    git('checkout', '-q', 'main');
    commitFile(root, git, 'a.txt', 'the base rewrote this\n', 'the base changes a.txt');
    git('checkout', '-q', 'feature');
    git('merge', '-q', '--no-ff', '-X', 'ours', '-m', "Merge branch 'main' into feature", 'main');
    return { root, git };
  }
  git('checkout', '-q', 'main');
  commitFile(root, git, 'b.txt', 'b\n', 'the base moved');
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'main' into feature", 'main');
  if (evil) {
    // Two parents still, and content neither of them has: the shape the rule
    // must NOT exempt, or the exemption becomes a way past the detector.
    writeFileSync(join(root, 'evil.txt'), 'smuggled\n');
    git('add', '.');
    git('commit', '-q', '--amend', '--no-edit');
  }
  return { root, git };
}

const commitOptions = (root, extra = {}) => ({
  git: realGit,
  root,
  baseBranch: 'main',
  headBranch: 'feature',
  refsRefreshed: true,
  slug: 'o/r',
  pr: '7',
  openedAt: OPENED_AT,
  ackBody: false,
  invocation: (...extras) => ['ax pr gate --pr 7', ...extras].join(' '),
  ...extra,
});

const commitsOk = rows => {
  const answer = prCommits({ run: answering(rows), slug: 'o/r', pr: '7' });
  assert.equal(answer.ok, true, answer.reason);
  return answer;
};

test('commits since open: a clean merge of the base is base movement, exempt and noted (#90)', () => {
  const { root } = mergedRepo();
  const out = commitsGround(
    commitOptions(root, { commits: commitsOk([commitRow('a'.repeat(40), 'feature work'), realRow(root, 'feature')]) }),
  );
  const sha = execFileSync('git', ['rev-parse', 'feature'], { cwd: root, encoding: 'utf8' }).trim();
  assert.deepEqual(out.refusals, [], 'the gate refused a commit it could have minted itself');
  assert.deepEqual(out.unknowns, []);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0].message, new RegExp(`commits since open: 1 base merge — exempt: ${sha.slice(0, 12)}`));
  assert.match(out.notes[0].message, /clean merge of main/);
});

test('commits since open: a caller-authored commit beside the exempt base merge still refuses, naming only it (#90)', () => {
  const { root } = mergedRepo();
  const out = commitsGround(
    commitOptions(root, {
      commits: commitsOk([commitRow('a'.repeat(40), 'feature work'), realRow(root, 'feature'), commitRow('c'.repeat(40), 'later work', LATE)]),
    }),
  );
  const merge = execFileSync('git', ['rev-parse', 'feature'], { cwd: root, encoding: 'utf8' }).trim().slice(0, 12);
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /commits since open \[DETECTOR\]: 1 commit\(s\) landed after the PR was opened \(cccccccccccc\)/);
  assert.doesNotMatch(out.refusals[0].message, new RegExp(merge), 'the base merge is named in the refusal it is exempt from');
  assert.match(out.refusals[0].repair, /--ack-body/);
  assert.ok(out.notes.some(entry => entry.message.includes('1 base merge — exempt')));
});

test('commits since open: a merge of a branch the base does not reach is work (#90)', () => {
  const { root } = mergedRepo({ foreign: true });
  const out = commitsGround(commitOptions(root, { commits: commitsOk([realRow(root, 'feature')]) }));
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /commits since open \[DETECTOR\]: .* main does not reach/);
  assert.match(out.refusals[0].repair, /--ack-body/);
  assert.deepEqual(out.notes, []);
});

test('commits since open: a base merge carrying content of its own is work, named as one (#90)', () => {
  const { root } = mergedRepo({ evil: true });
  const out = commitsGround(commitOptions(root, { commits: commitsOk([realRow(root, 'feature')]) }));
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /commits since open \[DETECTOR\]: .* its tree is not the one an ordinary merge of its parents produces/);
  assert.match(out.refusals[0].repair, /--ack-body/);
});

test('commits since open: a merge that DROPS the base\'s change is work, though its combined diff is empty (#119 P1)', () => {
  // The bypass the first predicate had. `git merge -X ours main` gives two
  // parents, a second parent the base reaches, and an EMPTY
  // `git diff-tree --cc` — because every path matches one parent wholesale —
  // while silently discarding the base's change to a.txt. Nothing about that is
  // base movement, and an exemption that admitted it would be a way past the
  // detector rather than a refinement of it.
  const { root } = mergedRepo({ dropsBaseChange: true });
  const combined = execFileSync('git', ['diff-tree', '--cc', '--no-commit-id', 'feature'], { cwd: root, encoding: 'utf8' });
  assert.equal(combined.trim(), '', 'the fixture no longer reproduces the empty combined diff');
  assert.equal(execFileSync('git', ['show', 'feature:a.txt'], { cwd: root, encoding: 'utf8' }), 'the branch rewrote this\n', "the base's change survived, so nothing was dropped");

  const out = commitsGround(commitOptions(root, { commits: commitsOk([realRow(root, 'feature')]) }));
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /commits since open \[DETECTOR\]: .* an ordinary merge of its parents CONFLICTS/);
  assert.match(out.refusals[0].repair, /--ack-body/);
  assert.deepEqual(out.notes, [], 'a dropped upstream change was reported as base movement');
});

test('commits since open: a shape this checkout cannot read is cannot-establish, never exempt and never authored work (F-028, #90)', () => {
  const { root } = mergedRepo();
  // A read that failed is this module's `unknown` — exit 3, CANNOT ESTABLISH —
  // exactly like an unreadable base ref in the staleness ground beside it. It
  // fails closed either way and the repair was already the fetch; what calling
  // it a REFUSAL got wrong is the sentence and the exit code, telling the caller
  // a transient git failure is an established named reason on exit 1 where every
  // sibling read answers exit 3 (#119 P2).
  const absent = commitsGround(
    commitOptions(root, { commits: commitsOk([commitRow('d'.repeat(40), 'a merge this checkout lacks', LATE, [{ sha: 'e'.repeat(40) }, { sha: 'f'.repeat(40) }])]) }),
  );
  assert.deepEqual(absent.refusals, []);
  assert.equal(absent.unknowns.length, 1);
  assert.match(absent.unknowns[0].message, /unknown is not exempt/);
  assert.match(absent.unknowns[0].repair, /git fetch origin main feature/);

  // The base ref itself unread: the reachability question has no base side.
  const unrefreshed = commitsGround(commitOptions(root, { refsRefreshed: false, commits: commitsOk([realRow(root, 'feature')]) }));
  assert.deepEqual(unrefreshed.refusals, []);
  assert.equal(unrefreshed.unknowns.length, 1);
  assert.match(unrefreshed.unknowns[0].message, /'main' cannot be read here/);
  assert.match(unrefreshed.unknowns[0].repair, /git fetch origin main/);

  // A git older than 2.38 has no `--write-tree` and answers 129. Fetching
  // cannot add a git capability, so the repair that names a fetch would loop
  // forever: this one names the version the read needs (#119 P2).
  const oldGit = commitsGround(
    commitOptions(root, {
      git: (args, at) => (args[0] === 'merge-tree' ? { status: 129, stdout: '', stderr: 'error: unknown option `write-tree\'', error: undefined } : realGit(args, at)),
      commits: commitsOk([realRow(root, 'feature')]),
    }),
  );
  assert.deepEqual(oldGit.refusals, []);
  assert.equal(oldGit.unknowns.length, 1);
  assert.match(oldGit.unknowns[0].message, /'git merge-tree --write-tree' is not available here/);
  assert.match(oldGit.unknowns[0].repair, /git 2\.38/);
  assert.doesNotMatch(oldGit.unknowns[0].repair, /git fetch/, 'a fetch cannot add a git capability');

  // Any OTHER failed recompute is a read to retry, so the fetch is its repair.
  const unreadable = commitsGround(
    commitOptions(root, {
      git: (args, at) => (args[0] === 'merge-tree' ? { status: 128, stdout: '', stderr: 'fatal: not a valid object name', error: undefined } : realGit(args, at)),
      commits: commitsOk([realRow(root, 'feature')]),
    }),
  );
  assert.equal(unreadable.unknowns.length, 1);
  assert.match(unreadable.unknowns[0].message, /git merge-tree --write-tree.*could not answer/);
  assert.match(unreadable.unknowns[0].repair, /git fetch origin main feature/);

  // A conflicted recompute writes a tree ANYWAY, so the exit code alone cannot
  // separate "the ordinary merge conflicts" from "the read failed" — the tree
  // id on stdout is what does. THAT one is authored content, so it refuses.
  const conflicting = commitsGround(
    commitOptions(root, {
      git: (args, at) => (args[0] === 'merge-tree' ? { status: 1, stdout: `${'9'.repeat(40)}\n`, stderr: '', error: undefined } : realGit(args, at)),
      commits: commitsOk([realRow(root, 'feature')]),
    }),
  );
  assert.deepEqual(conflicting.unknowns, []);
  assert.equal(conflicting.refusals.length, 1);
  assert.match(conflicting.refusals[0].message, /an ordinary merge of its parents CONFLICTS/);
  assert.match(conflicting.refusals[0].repair, /--ack-body/);

  // And the tree the commit itself carries has to be readable too.
  const noTree = commitsGround(
    commitOptions(root, {
      git: (args, at) => (args[0] === 'rev-parse' && String(args[1]).endsWith('^{tree}') ? { status: 128, stdout: '', stderr: 'fatal: bad revision', error: undefined } : realGit(args, at)),
      commits: commitsOk([realRow(root, 'feature')]),
    }),
  );
  assert.deepEqual(noTree.refusals, []);
  assert.equal(noTree.unknowns.length, 1);
  assert.match(noTree.unknowns[0].message, /git rev-parse .*\^\{tree\}' could not answer/);
  assert.match(noTree.unknowns[0].repair, /git fetch origin main feature/);
});

test('commits since open: --ack-body answers for every late commit and reads no git at all (#90)', () => {
  const { root } = mergedRepo();
  const reads = [];
  const out = commitsGround(
    commitOptions(root, {
      ackBody: true,
      git: (args, at) => (reads.push(args.join(' ')), realGit(args, at)),
      commits: commitsOk([realRow(root, 'feature'), commitRow('c'.repeat(40), 'later work', LATE)]),
    }),
  );
  assert.deepEqual(out.refusals, []);
  assert.match(out.notes[0].message, /commits since open: 2 acknowledged via --ack-body/);
  assert.deepEqual(reads, [], 'an acknowledged list needs no shape measured');
});

test("pr commits: a commit's parents are read by name, never assumed (F-028, #90)", () => {
  const answer = prCommits({
    run: answering([{ sha: 'a'.repeat(40), commit: { message: 'fix: one', committer: { date: '2026-08-09T09:00:00Z' } } }]),
    slug: 'o/r',
    pr: '7',
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "a PR commit: 'parents' is absent from the payload");

  const rows = commitsOk([commitRow('a'.repeat(40), 'fix: one', '2026-08-09T09:00:00Z', [{ sha: 'b'.repeat(40) }, { sha: 'c'.repeat(40) }])]);
  assert.deepEqual(rows.commits[0].parents, ['b'.repeat(40), 'c'.repeat(40)]);
});

// ── The predicate: which texts will reach the default branch? ──────────────
//
// There is no policy under which the body is the only one. GitHub always writes
// a subject and a message for the commit it lands, and every value those two
// settings can take names a text: the pull request title, the branch's commit
// messages, or a single commit's subject.

const policyOf = over => ({
  ok: true,
  squashMessage: 'PR_BODY',
  squashTitle: 'PR_TITLE',
  mergeTitle: 'MERGE_MESSAGE',
  mergeMessage: 'PR_BODY',
  allowed: ['squash'],
  ...over,
});
const commitsOf = (...messages) => ({ ok: true, commits: messages.map((message, index) => ({ sha: String(index).repeat(40).slice(0, 40), message, when: 0 })) });
const kinds = out => out.channels.map(channel => channel.kind);
const textsOf = (out, kind) => out.channels.filter(channel => channel.kind === kind).map(channel => channel.text);

test('channel: COMMIT_MESSAGES squash carries every commit message onto the default branch (#86)', () => {
  const out = closingChannels({
    policy: policyOf({ squashMessage: 'COMMIT_MESSAGES', squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: one'),
    title: 'fix: one',
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(textsOf(out, 'commit'), ['fix: one']);
  assert.match(out.notes[0].message, /squash_merge_commit_message=COMMIT_MESSAGES/);
  assert.match(out.notes[0].message, /methods evaluated: squash/);
});

test('channel: the squash SUBJECT is a channel, and which text fills it depends on the commit count (#86)', () => {
  // COMMIT_OR_PR_TITLE with exactly one commit: that commit's subject.
  const one = closingChannels({
    policy: policyOf({ squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: it\n\nCloses #42'),
    title: 'fix: it',
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(textsOf(one, 'commit'), ['fix: it']);
  assert.deepEqual(textsOf(one, 'title'), [], 'with one commit GitHub never reaches for the PR title');
  assert.match(one.notes[0].message, /squash_merge_commit_title=COMMIT_OR_PR_TITLE/);

  // Two commits: GitHub takes the PULL REQUEST TITLE instead, so that is the
  // text that lands — the case this predicate used to call inert.
  const two = closingChannels({
    policy: policyOf({ squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: it', 'fix: more'),
    title: 'fix: both halves',
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(kinds(two), ['title']);
  assert.deepEqual(textsOf(two, 'title'), ['fix: both halves']);
  assert.match(two.notes[0].message, /2 commits/);

  // PR_TITLE says so outright, whatever the branch holds.
  const always = closingChannels({ policy: policyOf(), commits: commitsOf('fix: it\n\nCloses #11'), title: 'fix: it', method: 'squash', methodGiven: true });
  assert.deepEqual(kinds(always), ['title']);
  assert.match(always.notes[0].message, /squash_merge_commit_title=PR_TITLE/);
  assert.deepEqual(textsOf(always, 'commit'), [], 'PR_BODY keeps the commit messages off the default branch');
});

test('channel: a merge commit that takes the PR title makes the title a channel too (#86)', () => {
  const titled = closingChannels({
    policy: policyOf({ allowed: ['squash', 'merge'], mergeMessage: 'PR_TITLE', squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: it'),
    title: 'fix: it',
    method: 'merge',
    methodGiven: true,
  });
  assert.ok(kinds(titled).includes('title'), 'merge_commit_message=PR_TITLE lands the title');
  assert.match(titled.notes[0].message, /merge_commit_message=PR_TITLE/);

  // A rebase writes no merge commit at all: the title never lands, the
  // messages always do.
  const rebased = closingChannels({
    policy: policyOf({ allowed: ['rebase'], squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: it'),
    title: 'fix: it',
    method: 'rebase',
    methodGiven: true,
  });
  assert.deepEqual(kinds(rebased), ['commit']);
  assert.match(rebased.notes[0].message, /verbatim/);
});

test('channel: a --merge run evaluates the method it will ISSUE, never every allowed one (#86)', () => {
  // The documented default `ax pr gate --pr N --merge` mutates with --squash
  // unconditionally, so widening to merge and rebase there refuses a merge over
  // text that cannot reach the commit this run will write.
  const merging = closingChannels({
    policy: policyOf({ allowed: ['squash', 'merge', 'rebase'] }),
    commits: commitsOf('fix: it\n\nFixes #11'),
    title: 'fix: it',
    method: 'squash',
    methodGiven: false,
    merging: true,
  });
  assert.deepEqual(kinds(merging), ['title'], 'the squash arm alone');
  assert.match(merging.notes[0].message, /methods evaluated: squash/);
  assert.doesNotMatch(merging.notes[0].message, /rebase/);

  // A DETECTOR run issues nothing, so it fails closed over every method the
  // repository allows and says which.
  const detecting = closingChannels({
    policy: policyOf({ allowed: ['squash', 'rebase'] }),
    commits: commitsOf('fix: it\n\nFixes #11'),
    title: 'fix: it',
    method: 'squash',
    methodGiven: false,
    merging: false,
  });
  assert.ok(kinds(detecting).includes('commit'), 'a repository allowing rebase lands the messages whatever squash does');
  assert.match(detecting.notes[0].message, /methods evaluated: squash, rebase/);
});

test('channel: an unread policy is an inability to establish, never "the body is the only channel" (#86)', () => {
  const out = closingChannels({
    policy: { ok: false, reason: "'gh api repos/o/r' failed — HTTP 502", repair: 'gh api repos/o/r' },
    commits: commitsOf('fix: it\n\nCloses #11'),
    title: 'fix: it',
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(out.channels, []);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /HTTP 502/);
  assert.match(out.unknowns[0].message, /F-028/);
  assert.equal(out.unknowns[0].repair, 'gh api repos/o/r');
});

test('channel: a live channel this run could not read is unread, not empty (#86)', () => {
  const out = closingChannels({
    policy: policyOf({ squashMessage: 'COMMIT_MESSAGES' }),
    commits: { ok: false, reason: 'the list is a full page', repair: 'gh api --paginate' },
    title: 'fix: it',
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(out.channels, []);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /the list is a full page/);
  assert.equal(out.unknowns[0].repair, 'gh api --paginate');
});

test('channel: an unreadable commit list still answers where only the title lands (#86)', () => {
  // PR_TITLE needs no commit list: the title is the subject whatever the branch
  // holds, so an unread list decides nothing here.
  const out = closingChannels({
    policy: policyOf(),
    commits: { ok: false, reason: 'HTTP 502', repair: 'gh api' },
    title: 'fix: it',
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(kinds(out), ['title']);
  assert.deepEqual(out.unknowns, []);
});


// ── Ground 8: the declaration guard ────────────────────────────────────────

/** A repo declaring `prGate` on main, and weakening it on feature. */
function guarded() {
  const { root, git } = repo();
  commitFile(root, git, 'ax.config.json', JSON.stringify({ prGate: { aggregate: 'CI' } }), 'declare');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--ff-only', 'main');
  commitFile(root, git, 'ax.config.json', JSON.stringify({ prGate: { checks: ['lint'] } }), 'weaken');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, git, base, sha };
}

const guardOptions = (root, extra = {}) => ({ git: realGit, root, baseBranch: 'main', refsRefreshed: true, pr: '7', slug: 'o/r', ...extra });

test('declaration guard: the after side is the VALIDATED SHA, never a branch a stale origin ref shadows', () => {
  const { root, git, base, sha } = guarded();
  // The dangerous ref: `origin/feature` left behind at the base, which is what
  // this checkout answers for the branch NAME. Resolving the guard by name
  // therefore compares the declaration against itself and reports clean.
  git('update-ref', 'refs/remotes/origin/feature', base);

  const out = declarationGround(guardOptions(root, { sha }));
  const refusal = out.refusals.find(entry => entry.message.startsWith('declaration guard:'));
  assert.ok(refusal, 'the guard read the SHA the gate validated, not the stale ref');
  assert.match(refusal.message, /edits the prGate declaration it is measured by/);
  assert.equal(out.notes.length, 0);
});

test('declaration guard: an untouched declaration at the validated SHA is a note', () => {
  const { root, git } = repo();
  commitFile(root, git, 'ax.config.json', JSON.stringify({ prGate: { aggregate: 'CI' } }), 'declare');
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--ff-only', 'main');
  commitFile(root, git, 'src.txt', 'work\n', 'work');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const out = declarationGround(guardOptions(root, { sha }));
  assert.equal(out.refusals.length, 0);
  assert.equal(out.unknowns.length, 0);
  assert.ok(out.notes.some(entry => /leaves the prGate declaration untouched/.test(entry.message)));
});

test('declaration guard: refs that were never refreshed leave the guard unread, never clean', () => {
  const { root, sha } = guarded();
  const out = declarationGround(guardOptions(root, { sha, refsRefreshed: false }));
  assert.equal(out.notes.length, 0, 'an unrefreshed base is never a clean note');
  assert.equal(out.refusals.length, 0);
  const unknown = out.unknowns.find(entry => entry.message.startsWith('declaration guard:'));
  assert.ok(unknown, 'the unrefreshed refs are named');
  assert.match(unknown.message, /could not be refreshed/);
  assert.match(unknown.repair, /git fetch origin main/);
});

test('gitGrounds carries its fetch state out, so the guard stands on the same measurement', () => {
  const { root, git } = repo();
  git('checkout', '-q', 'feature');
  commitFile(root, git, 'c.txt', 'c\n', 'c');
  assert.equal(gitGrounds(options(root)).fetchState, 'local-only', 'no origin is a situation, not a failed refresh');

  const failing = (args, at) => {
    if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:o/r.git\n', stderr: '', error: undefined };
    if (args[0] === 'fetch') return { status: 1, stdout: '', stderr: 'fatal: could not read from remote repository', error: undefined };
    return realGit(args, at);
  };
  assert.equal(gitGrounds(options(root, { git: failing })).fetchState, 'failed');
});

// ── The release shape: the one PR that has no ticket by construction (#94) ──
//
// Origin: PR #68, the release-please pull request for 0.18.0. `keywordGround`'s
// R8 hardening refused it on "the body closes no issue and expresses no intent
// to" — structurally, since a changelog names no ticket and never will — while
// `.github/workflows/test.yml` promises in its own header that the release path
// stays gateable instead of permanently hand-merged. Ruled 2026-09-02: the
// release PR is a recognized SHAPE, and the exemption belongs to the shape, so
// there is nothing an author of an ordinary PR can type to reach it.
//
// The two spellings below are measured, not chosen: `gh pr view --json author`
// answered `app/github-actions` on PR #68 while that same PR's commits payload
// answered `github-actions[bot]` — one identity, two spellings, and a literal
// comparison against either one alone fails on the other read.

const RELEASE_BODY = 'chore(main): release 0.18.0\n\n### Bug Fixes\n\n* the gate reads its own declaration (#70) closes [#42](https://github.com/o/r/issues/42)\n';

/** A commit row as the PR commits payload gives it, with the account GitHub named. */
const authored = (row, login) => ({ ...row, author: login === null ? null : { login } });

test('release shape: the default shape is the release bot and the pending label, in both spellings gh answers (#94)', () => {
  const viewSpelling = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  assert.equal(viewSpelling.ok, true);
  assert.match(viewSpelling.why, /author 'app\/github-actions'/);
  assert.match(viewSpelling.why, /label 'autorelease: pending'/);

  // The REST spelling of the same account, which is what a commit row carries.
  const restSpelling = releaseShape({ author: 'github-actions[bot]', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  assert.equal(restSpelling.ok, true);
});

test('release shape: half the shape is not the shape — a label is something an author can type (#94)', () => {
  const noLabel = releaseShape({ author: 'app/github-actions', labels: [{ name: 'bug' }], declared: readRelease(undefined) });
  assert.equal(noLabel.ok, false);
  assert.match(noLabel.why, /carries no 'autorelease: pending' label/);

  const human = releaseShape({ author: 'flosrn', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  assert.equal(human.ok, false);
  assert.match(human.why, /author 'flosrn' is not 'github-actions\[bot\]'/);
});

test('release shape: an unread half never grants the exemption (F-028, #94)', () => {
  // The shape is a POSITIVE finding: a receipt that named no author, or no
  // labels, leaves the keyword ground refusing exactly as it did before, which
  // is the direction absence is allowed to move.
  assert.equal(releaseShape({ author: '', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) }).ok, false);
  const noLabels = releaseShape({ author: 'app/github-actions', labels: undefined, declared: readRelease(undefined) });
  assert.equal(noLabels.ok, false);
  assert.match(noLabels.why, /names no labels/);
});

test('release shape: a declared label wins, and the author half still holds (#94)', () => {
  const declared = readRelease({ label: 'release: pending' });
  assert.equal(declared.ok, true);
  assert.equal(releaseShape({ author: 'app/github-actions', labels: [{ name: 'release: pending' }], declared }).ok, true);
  // The declared label does not replace the author half: a project declaring
  // its label must not turn that label into a flag its contributors can add.
  assert.equal(releaseShape({ author: 'flosrn', labels: [{ name: 'release: pending' }], declared }).ok, false);
  // And the default label is no longer the shape once another one is declared.
  assert.equal(releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared }).ok, false);

  const bot = readRelease({ label: 'release: pending', author: 'release-bot[bot]' });
  assert.equal(releaseShape({ author: 'app/release-bot', labels: [{ name: 'release: pending' }], declared: bot }).ok, true);
});

test('release shape: a declaration naming no label is unreadable, never the default shape (#94)', () => {
  assert.equal(readRelease({}).ok, false);
  assert.match(readRelease({}).reason, /prGate\.release names no label/);
  assert.match(readRelease({ label: '  ' }).reason, /prGate\.release names no label/);
  assert.match(readRelease('autorelease: pending').reason, /prGate\.release is not an object/);
  assert.match(readRelease({ label: 'release', author: '' }).reason, /prGate\.release\.author is not a login/);
  // Absent is the default shape, and says which one it is.
  const absent = readRelease(undefined);
  assert.equal(absent.ok, true);
  assert.equal(absent.label, 'autorelease: pending');
  assert.equal(absent.author, 'github-actions[bot]');
  assert.equal(absent.declared, false);
});

test('closing keyword: a release PR is a pass — no ticket by construction (#94)', () => {
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  const out = keywordGround({
    channels: bodyOnly(RELEASE_BODY),
    tracker: undefined,
    pr: '68',
    slug: 'flosrn/ax',
    baseBranch: 'main',
    defaultBranch: 'main',
    release,
  });
  assert.deepEqual(out.refusals, [], 'the release path is gateable, as test.yml promises');
  assert.deepEqual(out.unknowns, []);
  const named = out.notes.find(entry => /closing keyword/.test(entry.message));
  assert.match(named.message, /release PR — no ticket by construction/);
  assert.match(named.message, /label 'autorelease: pending'/);
});

test('closing keyword: the same changelog body without the shape still refuses (#94)', () => {
  const out = keywordGround({
    channels: bodyOnly(RELEASE_BODY),
    tracker: undefined,
    pr: '104',
    slug: 'flosrn/ax',
    baseBranch: 'main',
    defaultBranch: 'main',
    release: releaseShape({ author: 'flosrn', labels: [], declared: readRelease(undefined) }),
  });
  assert.equal(out.refusals.length, 1, 'the ground stays honest for every PR that could have a ticket');
  assert.match(out.refusals[0].message, /closes no issue and expresses no intent to/);
});

test('commits since open: the release bump is the shape\'s own output, exempt and named (#94)', () => {
  const { root } = repo();
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  const out = commitsGround(
    commitOptions(root, {
      release,
      commits: commitsOk([
        authored(commitRow('a'.repeat(40), 'feature work'), 'flosrn'),
        authored(commitRow('b'.repeat(40), 'chore(main): release 0.18.0', LATE), 'github-actions[bot]'),
      ]),
    }),
  );
  assert.deepEqual(out.refusals, [], 'the version bump release-please pushes after opening its own PR is expected');
  assert.deepEqual(out.unknowns, []);
  const named = out.notes.find(entry => /commits since open/.test(entry.message));
  assert.match(named.message, /1 release commit/);
  assert.match(named.message, /bbbbbbbbbbbb/);
  assert.match(named.message, /github-actions\[bot\]/);
});

test('commits since open: one human commit on a release PR still refuses, naming only it (#94)', () => {
  const { root } = repo();
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  const out = commitsGround(
    commitOptions(root, {
      release,
      commits: commitsOk([
        authored(commitRow('b'.repeat(40), 'chore(main): release 0.18.0', LATE), 'github-actions[bot]'),
        authored(commitRow('c'.repeat(40), 'fix: a hand edit on the release branch', LATE), 'flosrn'),
      ]),
    }),
  );
  assert.equal(out.refusals.length, 1, 'the exemption is the bot\'s commits, never the branch');
  assert.match(out.refusals[0].message, /commits since open \[DETECTOR\]: 1 commit\(s\) landed after the PR was opened \(cccccccccccc\)/);
  assert.match(out.refusals[0].repair, /--ack-body/);
});

test('commits since open: an author GitHub names as nobody is not the release bot (F-028, #94)', () => {
  const { root } = repo();
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  const out = commitsGround(
    commitOptions(root, { release, commits: commitsOk([authored(commitRow('d'.repeat(40), 'chore(main): release 0.18.0', LATE), null)]) }),
  );
  assert.equal(out.refusals.length, 1, 'an unnamed account withholds the exemption; it can never grant it');
  assert.match(out.refusals[0].message, /dddddddddddd/);
});

test('commits since open: a bot-authored commit that is not the bump still refuses — identity alone is not the exemption (#94)', () => {
  // The release App identity is reachable by every workflow this repository
  // grants its token to, so "authored by the bot" is wider than "the version
  // bump release-please wrote". A second commit under the same account, doing
  // something else, is work no body written before it describes.
  const { root } = repo();
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  const out = commitsGround(
    commitOptions(root, {
      release,
      commits: commitsOk([
        authored(commitRow('b'.repeat(40), 'chore(main): release 0.18.0', LATE), 'github-actions[bot]'),
        authored(commitRow('e'.repeat(40), 'chore(deps): bump the lockfile', LATE), 'github-actions[bot]'),
      ]),
    }),
  );
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /1 commit\(s\) landed after the PR was opened \(eeeeeeeeeeee\)/);
  assert.match(
    out.notes.find(entry => /commits since open/.test(entry.message)).message,
    /1 release commit/,
    'the bump beside it is still exempt',
  );
});

test('commits since open: the bump is recognised across release-please\'s message shapes (#94)', () => {
  const { root } = repo();
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  // The template is `chore${scope}: release${component} ${version}`: the scope
  // and the component are both optional in a project's configuration, and the
  // version may carry a SemVer prerelease or build suffix.
  for (const message of ['chore(main): release 0.18.0', 'chore: release 1.2.3', 'chore(main): release ax 0.18.0', 'chore: release v1.2.3-rc.1', 'chore: release 1.2.3+build.5']) {
    const out = commitsGround(
      commitOptions(root, { release, commits: commitsOk([authored(commitRow('b'.repeat(40), message, LATE), 'github-actions[bot]')]) }),
    );
    assert.deepEqual(out.refusals, [], `'${message}' is a release bump`);
  }
});

test('commits since open: a bot commit that merely says "release" is no bump — the version is what a bump carries (#94)', () => {
  // `\brelease\b` alone accepts prose: `chore: release-notes` and a bare
  // `chore: release` are both release-shaped words with no version behind them,
  // and the ruling exempts the bump, not the vocabulary. The last form is the
  // one a loose version tail let through: text welded onto the digits, where
  // only a SemVer prerelease or build suffix may follow.
  const { root } = repo();
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  for (const message of ['chore: release-notes', 'chore: release', 'chore(main): release the docs site', 'chore: release 1.2.3release-notes']) {
    const out = commitsGround(
      commitOptions(root, { release, commits: commitsOk([authored(commitRow('e'.repeat(40), message, LATE), 'github-actions[bot]')]) }),
    );
    assert.equal(out.refusals.length, 1, `'${message}' is not a version bump`);
    assert.match(out.refusals[0].message, /eeeeeeeeeeee/);
    assert.deepEqual(out.notes, [], 'nothing was named exempt');
  }
});

test('pr commits: the account GitHub named rides the same payload, unnamed as an empty login (#94)', () => {
  const rows = [authored(commitRow('a'.repeat(40), 'fix: one'), 'github-actions[bot]'), authored(commitRow('b'.repeat(40), 'fix: two'), null)];
  const answer = prCommits({ run: answering(rows), slug: 'o/r', pr: '7' });
  assert.equal(answer.ok, true, answer.reason);
  assert.deepEqual(
    answer.commits.map(entry => entry.authorLogin),
    ['github-actions[bot]', ''],
  );
});

test('ticket binding: Ground 9 is NOT RUN on a release PR, and says so rather than passing (#94)', () => {
  const release = releaseShape({ author: 'app/github-actions', labels: [{ name: 'autorelease: pending' }], declared: readRelease(undefined) });
  const channels = bodyOnly(RELEASE_BODY);
  const out = ticketGround({
    binding: { ok: false, reason: "no dispatch record on this host names the ticket branch 'release-please--branches--main' was dispatched for", repair: 'ax pr gate --pr 68 --issue <n>' },
    closes: closedIssuesOf(channels),
    channels,
    pr: '68',
    slug: 'flosrn/ax',
    release,
  });
  assert.deepEqual(out.refusals, []);
  assert.deepEqual(out.unknowns, [], 'an unbound release PR is not an inability to establish');
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0].message, /ticket binding: NOT RUN/);
  assert.match(out.notes[0].message, /an unrun check is never a passed one/);
});
