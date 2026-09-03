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
const bodyOnly = text => [{ label: 'the body', text, sha: '' }];

/** A commit message channel: what the merge message will carry, and from where. */
const fromCommit = (sha, text) => ({ label: `commit ${sha}`, text, sha });

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
    channels: [{ label: 'the body', text: 'A repair with no description.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: the gate\n\nCloses #42')],
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
    channels: [{ label: 'the body', text: 'Tooling fix.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'chore: tidy'), fromCommit('b2c3d4e5f6a1', 'chore: tidy again')],
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
    channels: [{ label: 'the body', text: 'No description.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #42')],
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
    channels: [{ label: 'the body', text: 'No description.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nFerme #1786')],
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
    { label: 'the body', text: 'Closes #42\n\nAlso resolves #7', sha: '' },
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
    { label: 'the body', text: 'Closes other/repo#9', sha: '' },
    fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses https://github.com/other/repo/issues/12'),
  ]);
  assert.deepEqual(closes, []);
});

// ── Ground 9: the ticket binding, over the same set ─────────────────────────

const BOUND = { ok: true, issue: 42, source: '--issue' };

test('ticket binding: a commit message closing another ticket refuses BEFORE the merge (#86)', () => {
  const channels = [{ label: 'the body', text: 'Closes #42', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nFixes #11')];
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
  const channels = [{ label: 'the body', text: 'Closes #42\n\nCloses #99', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #99')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.match(out.notes[0].message, /it also closes #99/);
});

test('ticket binding: a commit message closing the BOUND ticket satisfies the ground (#86)', () => {
  const channels = [{ label: 'the body', text: 'A repair.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it\n\nCloses #42')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 0);
  assert.match(out.notes[0].message, /commit a1b2c3d4e5f6 closes #42, the ticket this merge is for \(--issue\)/);
});

test('ticket binding: nothing closing anywhere names every channel it read (#86)', () => {
  const channels = [{ label: 'the body', text: 'A repair.', sha: '' }, fromCommit('a1b2c3d4e5f6', 'fix: it')];
  const out = ticketGround({ binding: BOUND, closes: closedIssuesOf(channels), channels, pr: '7', slug: 'gapilabs/gapila' });
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].message, /neither the body nor commit a1b2c3d4e5f6 closes a same-repository issue/);
});

// ── The merge-message policy, read once ────────────────────────────────────

const REPO_PAYLOAD = {
  squash_merge_commit_message: 'COMMIT_MESSAGES',
  squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
  allow_squash_merge: true,
  allow_merge_commit: true,
  allow_rebase_merge: false,
};

const answering = value => () => ({ status: 0, stdout: JSON.stringify(value), stderr: '', error: undefined });
const failing = stderr => () => ({ status: 1, stdout: '', stderr, error: undefined });

test('merge policy: one gh api repos/<slug> read answers all three facts (#86)', () => {
  const calls = [];
  const policy = mergePolicy({
    run: args => {
      calls.push(args.join(' '));
      return answering(REPO_PAYLOAD)();
    },
    slug: 'o/r',
  });
  assert.deepEqual(calls, ['api repos/o/r']);
  assert.deepEqual(policy, { ok: true, squashMessage: 'COMMIT_MESSAGES', squashTitle: 'COMMIT_OR_PR_TITLE', allowed: ['squash', 'merge'] });
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

// ── The commits, read once for both the detector and the channel ───────────

const commitRow = (sha, message, date = '2026-08-09T09:00:00Z') => ({ sha, commit: { message, committer: { date } } });

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

// ── The predicate: will these messages reach the default branch? ────────────

const policyOf = over => ({ ok: true, squashMessage: 'PR_BODY', squashTitle: 'PR_TITLE', allowed: ['squash'], ...over });
const commitsOf = (...messages) => ({ ok: true, commits: messages.map((message, index) => ({ sha: String(index).repeat(40).slice(0, 40), message, when: 0 })) });

test('channel: COMMIT_MESSAGES squash carries every commit message onto the default branch (#86)', () => {
  const out = closingChannels({
    policy: policyOf({ squashMessage: 'COMMIT_MESSAGES' }),
    commits: commitsOf('fix: one', 'fix: two'),
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(
    out.commitChannels.map(channel => channel.text),
    ['fix: one', 'fix: two'],
  );
  assert.match(out.notes[0].message, /squash_merge_commit_message=COMMIT_MESSAGES/);
  assert.match(out.notes[0].message, /methods evaluated: squash/);
});

test('channel: the title arm is the single commit SUBJECT, whatever the message policy says (#86)', () => {
  const one = closingChannels({
    policy: policyOf({ squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: it\n\nCloses #42'),
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(
    one.commitChannels.map(channel => channel.text),
    ['fix: it'],
  );
  assert.match(one.notes[0].message, /squash_merge_commit_title=COMMIT_OR_PR_TITLE/);

  // Two commits close the title arm: GitHub then takes the PR title.
  const two = closingChannels({
    policy: policyOf({ squashTitle: 'COMMIT_OR_PR_TITLE' }),
    commits: commitsOf('fix: it', 'fix: more'),
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(two.commitChannels, []);
  assert.deepEqual(two.notes, []);
});

test('channel: PR_BODY and PR_TITLE contribute nothing at all — no channel, no note (#86)', () => {
  const out = closingChannels({ policy: policyOf(), commits: commitsOf('fix: it\n\nCloses #11'), method: 'squash', methodGiven: true });
  assert.deepEqual(out.commitChannels, []);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.unknowns, []);
  assert.deepEqual(out.refusals, []);
});

test('channel: --method merge lands every message verbatim whatever the squash setting is (#86)', () => {
  const out = closingChannels({ policy: policyOf(), commits: commitsOf('fix: it\n\nCloses #11'), method: 'merge', methodGiven: true });
  assert.equal(out.commitChannels.length, 1);
  assert.match(out.notes[0].message, /verbatim/);
  assert.match(out.notes[0].message, /methods evaluated: merge/);
});

test('channel: no --method evaluates EVERY allowed method and fails closed (#86)', () => {
  const out = closingChannels({
    policy: policyOf({ allowed: ['squash', 'rebase'] }),
    commits: commitsOf('fix: it\n\nCloses #11'),
    method: 'squash',
    methodGiven: false,
  });
  assert.equal(out.commitChannels.length, 1, 'a repository allowing rebase lands the messages whatever squash does');
  assert.match(out.notes[0].message, /methods evaluated: squash, rebase/);
});

test('channel: an unread policy is an inability to establish, never "the body is the only channel" (#86)', () => {
  const out = closingChannels({
    policy: { ok: false, reason: "'gh api repos/o/r' failed — HTTP 502", repair: 'gh api repos/o/r' },
    commits: commitsOf('fix: it\n\nCloses #11'),
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(out.commitChannels, []);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /HTTP 502/);
  assert.match(out.unknowns[0].message, /F-028/);
  assert.equal(out.unknowns[0].repair, 'gh api repos/o/r');
});

test('channel: a live channel this run could not read is unread, not empty (#86)', () => {
  const out = closingChannels({
    policy: policyOf({ squashMessage: 'COMMIT_MESSAGES' }),
    commits: { ok: false, reason: 'the list is a full page', repair: 'gh api --paginate' },
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(out.commitChannels, []);
  assert.equal(out.unknowns.length, 1);
  assert.match(out.unknowns[0].message, /the list is a full page/);
  assert.equal(out.unknowns[0].repair, 'gh api --paginate');
});

test('channel: an inert arm never reads the commit list as unknown (#86)', () => {
  const out = closingChannels({
    policy: policyOf(),
    commits: { ok: false, reason: 'HTTP 502', repair: 'gh api' },
    method: 'squash',
    methodGiven: true,
  });
  assert.deepEqual(out.unknowns, [], 'a channel that cannot reach main decides nothing, read or unread');
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
