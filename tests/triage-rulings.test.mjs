// The grammar of the question channel: what an ask carries out, what a ruling
// carries back, and every way either silently loses meaning.
//
// These are pure-function tests on purpose — the grammar is the part of the
// channel that must hold with no Orca anywhere, because it is what decides what
// may enter a LIVE child that will consume it exactly once.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { questionProblem, questionsIn } from '../src/triage/draft.mjs';
import { composeAsk, composeReply, pairRulings, parseRulings, questionSpan } from '../src/triage/rulings.mjs';

const QUESTIONS = [
  { n: 1, text: 'bug or enhancement?' },
  { n: 2, text: 'which priority?' },
];

// ── the ask body ──────────────────────────────────────────────────────────────

test('composeAsk carries the request, the draft fingerprint, and the Q lines verbatim', () => {
  const body = composeAsk({ request: 'triage-acme-widgets-7', sha: 'abc123', questions: QUESTIONS });
  assert.match(body, /^triage-acme-widgets-7 /);
  assert.match(body, /draft abc123/);
  assert.match(body, /^Q1: bug or enhancement\?$/m);
  assert.match(body, /^Q2: which priority\?$/m);
});

test('the composed ask parses back to the same questions — the wire and the record cannot diverge', () => {
  const body = composeAsk({ request: 'r', sha: 's', questions: QUESTIONS });
  assert.deepEqual(questionsIn(body), QUESTIONS);
});

test('CRLF Q lines parse the same as LF — a Windows-saved draft is not an empty ask', () => {
  // Measured 2026-08-27 on ofmchat #81: three `Q<n>: [technical] …` openings at
  // column 0, legal shape, `ax triage ask` refused `carries no Q<n>: line`.
  // `questionsIn` splits on `\n` and anchors `$`, so a trailing `\r` makes the
  // line miss. Same three lines on LF parse; on CRLF they vanish.
  const lf = 'Q1: [technical] which side of the fork?\nQ2: [technical] who supplies the value?\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.deepEqual(questionsIn(lf), [
    { n: 1, text: '[technical] which side of the fork?' },
    { n: 2, text: '[technical] who supplies the value?' },
  ]);
  assert.deepEqual(questionsIn(crlf), questionsIn(lf));
});

// ── parseRulings ──────────────────────────────────────────────────────────────

test('a ruling is its marker line plus every line under it, trimmed', () => {
  const parsed = parseRulings('A1: bug.\nBecause the trace names a throw.\n\nA2: P2\n');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.rulings, [
    { n: 1, text: 'bug.\nBecause the trace names a throw.' },
    { n: 2, text: 'P2' },
  ]);
});

test('CRLF A lines parse the same as LF — a Windows-saved rulings file is not empty', () => {
  const lf = 'A1: bug.\nBecause the trace names a throw.\n\nA2: P2\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  const fromLf = parseRulings(lf);
  assert.equal(fromLf.ok, true);
  assert.deepEqual(parseRulings(crlf), fromLf);
});

test('a non-blank line before the first marker is refused BY LINE NUMBER', () => {
  const parsed = parseRulings('\nsome context the author meant\nA1: bug.\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /line 2 is under no A<n>: marker/);
});

test('a Q<n>: marker in a rulings file is refused — questions live in the draft', () => {
  const parsed = parseRulings('A1: bug.\nQ2: which priority?\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /line 2 carries a Q<n>: marker/);
});

test('an empty ruling is refused by its number', () => {
  const parsed = parseRulings('A1: bug.\nA2:\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /A2 carries no ruling/);
});

test('a doubled number is refused — the child could not tell which stands', () => {
  const parsed = parseRulings('A1: bug.\nA1: enhancement.\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /two rulings are numbered A1/);
});

test('a file with no marker at all is refused, not treated as one big answer', () => {
  const parsed = parseRulings('just prose\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /under no A<n>: marker/);
  assert.equal(parseRulings('').ok, false);
});

// ── pairRulings ───────────────────────────────────────────────────────────────

test('every question answered, no leftovers: ok', () => {
  assert.equal(pairRulings(QUESTIONS, [{ n: 2, text: 'P2' }, { n: 1, text: 'bug' }]).ok, true);
});

test('a skipped question is refused by name — a partial answer leaves the child blocked', () => {
  const paired = pairRulings(QUESTIONS, [{ n: 1, text: 'bug' }]);
  assert.equal(paired.ok, false);
  assert.match(paired.reason, /Q2 got no ruling/);
});

test('a ruling that answers no question is refused by name', () => {
  const paired = pairRulings(QUESTIONS, [{ n: 1, text: 'bug' }, { n: 2, text: 'P2' }, { n: 3, text: 'yes' }]);
  assert.equal(paired.ok, false);
  assert.match(paired.reason, /A3 answers no question/);
});

// ── composeReply ──────────────────────────────────────────────────────────────

test('the reply restates each question above its ruling, in draft order', () => {
  const body = composeReply(QUESTIONS, [{ n: 2, text: 'P2' }, { n: 1, text: 'bug' }]);
  assert.equal(body, 'Q1: bug or enhancement?\nA1: bug\n\nQ2: which priority?\nA2: P2');
});

// ── questionSpan ──────────────────────────────────────────────────────────────

test('a question set has a compact name: one, a range, or a list', () => {
  assert.equal(questionSpan([1]), 'Q1');
  assert.equal(questionSpan([1, 2, 3]), 'Q1-Q3');
  assert.equal(questionSpan([1, 4]), 'Q1, Q4');
  assert.equal(questionSpan([]), '');
});

// ── the shared question rules ─────────────────────────────────────────────────

test('questionProblem is the one definition ask and parseDraft share', () => {
  assert.equal(questionProblem(QUESTIONS), null);
  assert.match(questionProblem([{ n: 1, text: '' }]), /carries no question/);
  assert.match(questionProblem([{ n: 1, text: 'a' }, { n: 1, text: 'b' }]), /two questions are numbered Q1/);
  assert.match(questionProblem([{ n: 2, text: 'a' }]), /have to run 1\.\.1 in order/);
});
