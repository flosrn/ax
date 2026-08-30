// The draft is the deliverable of a triage session, and the only thing that
// crosses from the child to the human. Three parties derive its path without
// being told: the child writes it, `publish` reads it, and the operator looks at
// it. So the path is a pure function of the dispatch identity — the same
// `--request` the record is already keyed on — and nothing here may invent a
// second naming rule.
//
// Every proposition below is one refusal `publish` owes its caller. The Bash it
// replaces had no draft at all: the child applied labels itself, and the four
// issues of 2026-08-10 landed with three empty label groups each while the
// maintainer did the data entry by hand.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { draftDirFor, draftPath, parseDraft, passesIn, readDraft, requestFor } from '../src/ready/draft.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-draft-'));

// ── the identity, which is the record's identity ──────────────────────────────

test('the request names the job, the repo and the issue, in that order', () => {
  // A `brief` run on an issue already dispatched as `triage` must create its own
  // request rather than replay the triage record and re-send its instruction.
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7' }), 'triage-acme-widgets-7');
  assert.equal(requestFor({ job: 'brief', repo: 'acme/widgets', issue: '7' }), 'brief-acme-widgets-7');
});

test('the draft path is the request, under the repo’s own .scratch', () => {
  // `.scratch/` is gitignored, so a draft never reaches a diff — and never a
  // client repo's history. It is work in progress, not a deliverable file.
  assert.equal(draftPath('/w', { job: 'triage', repo: 'acme/widgets', issue: '7' }), '/w/.scratch/triage/triage-acme-widgets-7.md');
});

test('pass 1 is unsuffixed, so every record written before passes existed still resolves', () => {
  // The suffix is append-only: nothing is renamed to make room for pass 2, which
  // is what keeps a status already copied into notes, or a brief already sent,
  // pointing at the file it named.
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7' }), 'triage-acme-widgets-7');
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7', pass: 1 }), 'triage-acme-widgets-7');
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7', pass: 2 }), 'triage-acme-widgets-7-p2');
});

test('the passes present in a directory are found, oldest first, whatever order the disk lists them', () => {
  const dir = scratch();
  for (const name of ['triage-acme-widgets-7-p3.json', 'triage-acme-widgets-7.json', 'triage-acme-widgets-7-p2.json']) {
    writeFileSync(join(dir, name), '{}');
  }
  assert.deepEqual(passesIn(dir, { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), [1, 2, 3]);
});

test('a neighbouring issue, job or extension is not a pass of this one', () => {
  // `…-7` is a prefix of `…-70`, and that near-miss would report a pass that
  // belongs to another ticket — then refuse a fresh dispatch on a collision that
  // does not exist.
  const dir = scratch();
  for (const name of ['triage-acme-widgets-70.json', 'brief-acme-widgets-7.json', 'triage-acme-widgets-7.md', 'triage-acme-widgets-7-p2.json']) {
    writeFileSync(join(dir, name), '{}');
  }
  assert.deepEqual(passesIn(dir, { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), [2]);
});

test('a directory that cannot be read has no passes, because a first run has none', () => {
  assert.deepEqual(passesIn(join(scratch(), 'never'), { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), []);
});

test('`-p1` is ignored rather than folded into pass 1, because one pass has one path', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'triage-acme-widgets-7-p1.json'), '{}');
  writeFileSync(join(dir, 'triage-acme-widgets-7-px.json'), '{}');
  assert.deepEqual(passesIn(dir, { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), []);
});

// ── what a draft has to say to be publishable ────────────────────────────────

test('a draft names its labels on one line per group, and publish applies exactly those', () => {
  // ax cannot require "five groups": `category, priority, complexity, source,
  // domains` is one project's vocabulary, declared in its own docs. What ax
  // knows is weaker and true everywhere — a draft names labels, or it names none.
  const draft = parseDraft(['Labels: category/bug, priority/P2', 'Labels: domains/api', '', '## Verdict', 'It reproduces.'].join('\n'));
  assert.deepEqual(draft.labels, ['category/bug', 'priority/P2', 'domains/api']);
  assert.equal(draft.body, '## Verdict\nIt reproduces.');
});

test('a draft that names no label cannot be published', () => {
  const draft = parseDraft('## Verdict\nLooks fine to me.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /names no label/);
});

test('a draft with labels and no body cannot be published either', () => {
  // The comment IS the artifact a human reads later. A label set alone is data
  // entry with no reasoning attached, which is what the label groups were
  // supposed to stop being.
  const draft = parseDraft('Labels: category/bug\n\n\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /names no verdict/);
});

test('the same label named twice is applied once, in first-seen order', () => {
  const draft = parseDraft('Labels: category/bug, priority/P2\nLabels: priority/P2, category/bug\n\nWhy.\n');
  assert.deepEqual(draft.labels, ['category/bug', 'priority/P2']);
});

test('a label line with an empty entry is a refusal, not a silently dropped label', () => {
  // A trailing comma is how a hand-edited draft loses a group without saying so.
  const draft = parseDraft('Labels: category/bug, , priority/P2\n\nWhy.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /empty label/);
});

test('a close verdict is read, and carried as a refusal to close', () => {
  // The child may conclude wontfix. Publish escalates it — it never closes an
  // issue, because closing is the one gesture a human owes the reporter.
  const draft = parseDraft('Labels: category/enhancement, state/wontfix\nClose: yes\n\nAlready built.\n');
  assert.equal(draft.ok, true);
  assert.equal(draft.close, true);
});

// ── the questions a child leaves open ────────────────────────────────────────

test('a question is collected AND left in the body, because the human reads it on the issue', () => {
  // The one directive that is not consumed. Measured 2026-08-22: three children
  // asked in three layouts ("What we still need from you", a/b/c sub-points,
  // inline forks), so answering them meant a bespoke markdown edit per ticket.
  // The number makes a ruling addressable; staying in the body is what keeps the
  // escalation visible to the person who has to answer it.
  const draft = parseDraft(
    ['Labels: state/needs-info', '', 'Two rulings are missing.', 'Q1: Does the audit event carry the actor id?', 'Q2: Is the 500 cap a floor or a ceiling?'].join('\n'),
  );
  assert.equal(draft.ok, true);
  assert.deepEqual(
    draft.questions,
    [
      { n: 1, text: 'Does the audit event carry the actor id?' },
      { n: 2, text: 'Is the 500 cap a floor or a ceiling?' },
    ],
  );
  assert.match(draft.body, /Q1: Does the audit event carry the actor id\?/);
  assert.match(draft.body, /Q2: Is the 500 cap a floor or a ceiling\?/);
});

test('an empty question is refused — an empty ask cannot be answered', () => {
  const draft = parseDraft('Labels: state/needs-info\n\nQ1:\n\nSomething is missing.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /carries no question/);
});

test('two questions on one number are refused, because a ruling could reach neither', () => {
  const draft = parseDraft('Labels: state/needs-info\n\nQ1: First?\nQ1: Second?\n\nBoth open.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /numbered Q1/);
});

test('questions that skip a number are refused, because answers are paired by number', () => {
  // `Q1, Q3` reads as three asks with one lost, or two asks misnumbered, and the
  // difference decides whether a ruling lands on the right question.
  const draft = parseDraft('Labels: state/needs-info\n\nQ1: First?\nQ3: Third?\n\nTwo open.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /1, 3/);
  assert.match(draft.reason, /run 1\.\.2 in order/);
});

test('a draft that asks nothing carries an empty question list, not an absent one', () => {
  // Callers read `.questions` unconditionally; an undefined here would be a
  // crash on the ordinary case.
  assert.deepEqual(parseDraft('Labels: category/bug\n\nIt reproduces.\n').questions, []);
});

// ── reading one off disk ─────────────────────────────────────────────────────

test('a draft that was never written is named as missing, with the path the child owed', () => {
  const root = scratch();
  const found = readDraft(root, { job: 'triage', repo: 'acme/widgets', issue: '7' });
  assert.equal(found.ok, false);
  assert.match(found.reason, /\.scratch\/triage\/triage-acme-widgets-7\.md/);
  assert.match(found.reason, /nothing to publish/);
});

test('a draft is read with its own path attached, so a refusal can name the file to fix', () => {
  const root = scratch();
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md'), 'Labels: category/bug\n\nIt reproduces.\n');
  const found = readDraft(root, { job: 'triage', repo: 'acme/widgets', issue: '7' });
  assert.equal(found.ok, true);
  assert.deepEqual(found.labels, ['category/bug']);
  assert.equal(found.path, join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md'));
});

test('a draft carries git’s own fingerprint, so an operator can re-check the version they hold', () => {
  // `git hash-object`, not an invented digest: a coordinator reads a draft,
  // decides against it, and the child that owns it may rewrite it meanwhile.
  // Measured 2026-08-22: #54 went from 106 to 117 lines after its own peer
  // report, with no signal, and every anchor taken against it was stale. A
  // fingerprint only helps if it can be verified with a command already trusted,
  // so this asserts against real `git hash-object` rather than against itself.
  const root = scratch();
  const body = 'Labels: state/needs-info\n\nQ1: Floor or ceiling?\n';
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  const path = join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md');
  writeFileSync(path, body);

  const found = readDraft(root, { job: 'triage', repo: 'acme/widgets', issue: '7' });
  const git = execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();
  assert.equal(found.sha, git);
  assert.equal(found.lines, body.split('\n').length);
  assert.equal(found.questions.length, 1);
});

test('a draft that does not exist has no fingerprint, rather than a fingerprint of nothing', () => {
  // The empty string is what `status` reads to decide between "no draft yet" and
  // "this exact draft" — a hash of `''` would be a real-looking answer to a
  // question nobody could ask.
  const found = readDraft(scratch(), { job: 'triage', repo: 'acme/widgets', issue: '7' });
  assert.equal(found.sha, '');
  assert.equal(found.lines, 0);
});

// ── the refine grammar ───────────────────────────────────────────────────────
// A refine draft is a Definition-of-Ready verdict, not a categorization: it
// carries no label directives, says its readiness out loud, and splits what the
// tracker gets (the Agent Brief) from what only the coordinator reads (the
// Verification evidence). Every ambiguity is a named refusal, because a draft
// that publishes by parser accident is the false-ready an AFK launcher acts on.

const refineDraft = (lines) => lines.join('\n');

const READY_DRAFT = refineDraft([
  'Ready: yes',
  '',
  '## Agent Brief',
  '',
  'Summary: wire the widget to the socket.',
  '',
  '## Verification',
  '',
  'G3 pass — the socket exists as the ticket assumes (src/socket.mjs).',
]);

test('a ready refine draft publishes its Brief and only its Brief', () => {
  const found = parseDraft(READY_DRAFT, 'refine');
  assert.equal(found.ok, true);
  assert.equal(found.ready, 'yes');
  assert.ok(found.body.includes('wire the widget'));
  assert.ok(!found.body.includes('G3 pass'));
  assert.ok(!found.body.includes('Ready:'));
  assert.deepEqual(found.labels, []);
  assert.deepEqual(found.remove, []);
  assert.equal(found.close, false);
});

test('a refine draft that names labels is refused whole — categorizing means it misread its job', () => {
  const found = parseDraft(refineDraft(['Ready: yes', 'Labels: enhancement', '## Agent Brief', 'x', '## Verification', 'y']), 'refine');
  assert.equal(found.ok, false);
  assert.match(found.reason, /Labels:/);
  for (const line of ['Remove labels: needs-triage', 'Close: yes']) {
    const refused = parseDraft(refineDraft(['Ready: yes', line, '## Agent Brief', 'x', '## Verification', 'y']), 'refine');
    assert.equal(refused.ok, false, line);
  }
});

test('Ready: no is a verdict, distinguishable from a malformed draft', () => {
  const found = parseDraft(refineDraft(['Ready: no', '', '## Agent Brief', '', 'Gate 2 fails: the ticket spans three slices. Split proposal: …', '', '## Verification', '', 'G2 fail — three disjoint surfaces.']), 'refine');
  assert.equal(found.ok, false);
  assert.equal(found.ready, 'no');
  assert.match(found.reason, /not ready/i);
});

test('an absent Ready directive is malformed, not a quiet not-ready', () => {
  const found = parseDraft(refineDraft(['## Agent Brief', 'x', '## Verification', 'y']), 'refine');
  assert.equal(found.ok, false);
  assert.equal(found.ready, null);
  assert.match(found.reason, /Ready/);
});

test('two Ready directives are refused — a hand edit that leaves both verdicts must not publish by accident', () => {
  const found = parseDraft(refineDraft(['Ready: yes', 'Ready: no', '## Agent Brief', 'x', '## Verification', 'y']), 'refine');
  assert.equal(found.ok, false);
  assert.equal(found.ready, null);
});

test('a Ready value that is neither yes nor no is refused', () => {
  const found = parseDraft(refineDraft(['Ready: maybe', '## Agent Brief', 'x', '## Verification', 'y']), 'refine');
  assert.equal(found.ok, false);
  assert.equal(found.ready, null);
});

test('the two sections are required, once each, Brief first', () => {
  const missingBrief = parseDraft(refineDraft(['Ready: yes', '## Verification', 'y']), 'refine');
  assert.equal(missingBrief.ok, false);
  assert.match(missingBrief.reason, /Agent Brief/);
  const missingVerif = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', 'x']), 'refine');
  assert.equal(missingVerif.ok, false);
  assert.match(missingVerif.reason, /Verification/);
  const reversed = parseDraft(refineDraft(['Ready: yes', '## Verification', 'y', '## Agent Brief', 'x']), 'refine');
  assert.equal(reversed.ok, false);
  const doubled = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', 'x', '## Agent Brief', 'z', '## Verification', 'y']), 'refine');
  assert.equal(doubled.ok, false);
});

test('a Ready line below the headings is prose, not a verdict — the sole directive must precede the Brief', () => {
  const inBrief = parseDraft(
    refineDraft(['## Agent Brief', '', 'Ready: yes', '', 'Summary: wire the widget to the socket.', '', '## Verification', 'G1 pass.']),
    'refine',
  );
  assert.equal(inBrief.ok, false);
  assert.equal(inBrief.ready, null);
  assert.equal(inBrief.body, '');

  const afterVerification = parseDraft(
    refineDraft(['## Agent Brief', '', 'Summary: wire the widget.', '', '## Verification', 'G1 pass.', 'Ready: yes']),
    'refine',
  );
  assert.equal(afterVerification.ok, false);
  assert.equal(afterVerification.ready, null);
  assert.equal(afterVerification.body, '');
});

test('an empty Brief is refused — a verdict with nothing to publish is not ready', () => {
  const found = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', '', '## Verification', 'y']), 'refine');
  assert.equal(found.ok, false);
});

test('an empty Verification is refused when Ready: yes — a heading is not the evidence', () => {
  const found = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', 'x', '## Verification', '']), 'refine');
  assert.equal(found.ok, false);
  assert.match(found.reason, /Verification/);
  const headingOnly = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', 'x', '## Verification']), 'refine');
  assert.equal(headingOnly.ok, false);
  assert.match(headingOnly.reason, /Verification/);
});


test('refine questions are collected, kept in the Brief, and numbered like everywhere else', () => {
  const found = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', 'Q1: [product] cap the import at how many rows?', 'prose', '## Verification', 'y']), 'refine');
  assert.equal(found.ok, true);
  assert.equal(found.questions.length, 1);
  assert.ok(found.body.includes('Q1:'));
  const gapped = parseDraft(refineDraft(['Ready: yes', '## Agent Brief', 'Q2: where?', '## Verification', 'y']), 'refine');
  assert.equal(gapped.ok, false);
});

test('readDraft parses with the identity’s own job, so a refine draft reads under the refine grammar', () => {
  const root = scratch();
  const identity = { job: 'refine', repo: 'acme/widgets', issue: '7' };
  mkdirSync(draftDirFor(root, identity), { recursive: true });
  writeFileSync(draftPath(root, identity), READY_DRAFT);
  const found = readDraft(root, identity);
  assert.equal(found.ok, true);
  assert.equal(found.ready, 'yes');
  assert.ok(!found.body.includes('G3 pass'));
});

test('refine drafts live under their own directory, derived from the identity alone', () => {
  const refine = { job: 'refine', repo: 'acme/widgets', issue: '7' };
  const triage = { job: 'triage', repo: 'acme/widgets', issue: '7' };
  assert.equal(draftDirFor('/repo', refine), join('/repo', '.scratch', 'refine'));
  assert.equal(draftPath('/repo', refine), join('/repo', '.scratch', 'refine', 'refine-acme-widgets-7.md'));
  assert.equal(draftPath('/repo', triage), join('/repo', '.scratch', 'triage', 'triage-acme-widgets-7.md'), 'other jobs stay byte-identical');
});
