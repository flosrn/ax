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
