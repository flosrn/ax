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

import { draftPath, parseDraft, readDraft, requestFor } from '../src/triage/draft.mjs';

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
