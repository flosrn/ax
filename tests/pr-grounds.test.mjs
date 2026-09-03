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
 * A repository whose `feature` tip is a MERGE, in the three shapes that decide
 * the exemption: the clean merge of the base, the same merge carrying content
 * of its own (an evil merge), and a merge of some other branch.
 */
function mergedRepo({ evil = false, foreign = false } = {}) {
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
  assert.match(out.refusals[0].message, /commits since open \[DETECTOR\]: .* merges main and carries content neither parent has/);
  assert.match(out.refusals[0].message, /git diff-tree --cc/);
  assert.match(out.refusals[0].repair, /--ack-body/);
});

test('commits since open: a shape this checkout cannot read is not exempt, and the repair is the fetch (F-028, #90)', () => {
  const { root } = mergedRepo();
  // A two-parent commit whose objects this checkout does not hold: nothing
  // about it can be measured, so it refuses — and the repair is the read that
  // would decide it, never the acknowledgement of a commit nobody described.
  const absent = commitsGround(
    commitOptions(root, { commits: commitsOk([commitRow('d'.repeat(40), 'a merge this checkout lacks', LATE, [{ sha: 'e'.repeat(40) }, { sha: 'f'.repeat(40) }])]) }),
  );
  assert.equal(absent.refusals.length, 1);
  assert.match(absent.refusals[0].message, /unknown is not exempt/);
  assert.match(absent.refusals[0].repair, /git fetch origin main feature/);

  // The base ref itself unread: the reachability question has no base side.
  const unrefreshed = commitsGround(commitOptions(root, { refsRefreshed: false, commits: commitsOk([realRow(root, 'feature')]) }));
  assert.equal(unrefreshed.refusals.length, 1);
  assert.match(unrefreshed.refusals[0].message, /'main' cannot be read here/);
  assert.match(unrefreshed.refusals[0].repair, /git fetch origin main/);

  // The cleanliness read failing is the same answer: undecided, never exempt.
  const unreadable = commitsGround(
    commitOptions(root, {
      git: (args, at) => (args[0] === 'diff-tree' ? { status: 128, stdout: '', stderr: 'fatal: bad object', error: undefined } : realGit(args, at)),
      commits: commitsOk([realRow(root, 'feature')]),
    }),
  );
  assert.equal(unreadable.refusals.length, 1);
  assert.match(unreadable.refusals[0].message, /git diff-tree --cc.*could not answer/);
  assert.match(unreadable.refusals[0].repair, /git fetch origin main feature/);
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
