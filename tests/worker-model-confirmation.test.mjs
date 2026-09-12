// The confirmation reader: did THIS human approve THIS model decision?
//
// The propositions under test are the ways a transcript can look like consent
// without being any: a timeout that auto-selects the recommended candidate and
// writes it into `selectedOptions`; typed free text that says yes; a cancelled
// or chat-redirected ask; an answer to a question id that no longer describes
// the decision; a menu that was drawn before an effort changed; a result that
// was never written at all. Every one of them must refuse, and none of them may
// throw — the caller refuses before placement, and a throw there is a crash.
//
// THE FIXTURES ARE THE REAL SHAPES, not a convenient invention. They were
// sampled from the omp bundle's ask `execute` and from 487 ask results on disk
// under ~/.omp/agent/sessions (2026-09-13): the call is an assistant
// `toolCall` with `name:'ask'` and `arguments.questions[]`, a ONE-question
// answer is flat details with no id, a 2+-question answer is `details.results[]`
// with ids, a cancel is `details:{}` with `isError`, and a chat redirect is
// `details:{chatRedirect:true}`.
//
// Real files, no mocked filesystem: every case writes a JSONL into a tmpdir and
// reads it through the module's own default `readFileSync`. The injected `read`
// is exercised once, on its own, because it is part of the exported API.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFER_LABEL, readModelConfirmation } from '../src/worker/model-confirmation.mjs';

const ASK_ID = 'call_bC7rTd0hZ1qFhPq9wQ2mXk4T';
const QID = 'ax-model:ofmchat-412:9f2c1d7b41e6';
const TEXT = 'Which model should the worker for ofmchat-412 run on?';
const SONNET = 'anthropic/claude-sonnet-5:medium';
const CODEX = 'openai/gpt-6-codex:high';
const CANDIDATES = [SONNET, CODEX];

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-model-confirmation-'));

/** A native ask Question, as ./model-policy.mjs builds it: label IS the selector. */
const question = ({ id = QID, text = TEXT, labels = [...CANDIDATES, DEFER_LABEL], multi } = {}) => ({
  id,
  question: text,
  header: 'Worker model',
  options: labels.map(label => ({ label, description: `run the worker on ${label}` })),
  ...(multi === undefined ? { multi: false } : { multi }),
  recommended: 0,
});

/** The originating assistant turn, with the fields a real one carries. */
const call = ({ id = ASK_ID, questions = [question()] } = {}) => JSON.stringify({
  type: 'message',
  id: 'a1',
  parentId: 'u0',
  timestamp: '2026-09-13T08:12:04.201Z',
  message: {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id,
      name: 'ask',
      arguments: { i: 'Confirming the worker model', questions },
      streamIndex: 0,
      intent: 'Confirming the worker model',
    }],
    api: 'openai-completions',
    provider: 'omniroute-oai',
    model: 'astra-6',
    stopReason: 'toolUse',
    timestamp: 1789208775219,
  },
});

/** A ONE-question answer: flat details, and no question id anywhere in it. */
const flat = ({
  id = ASK_ID,
  text = TEXT,
  labels = [...CANDIDATES, DEFER_LABEL],
  selectedOptions = [SONNET],
  customInput,
  note,
  timedOut,
  multi = false,
  isError = false,
  details,
} = {}) => JSON.stringify({
  type: 'message',
  id: 'r1',
  parentId: 'a1',
  timestamp: '2026-09-13T08:12:41.918Z',
  message: {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'ask',
    content: [{ type: 'text', text: `User selected: ${selectedOptions[0] ?? ''}` }],
    details: details ?? {
      question: text,
      options: labels,
      multi,
      selectedOptions,
      ...(customInput === undefined ? {} : { customInput }),
      ...(note === undefined ? {} : { note }),
      ...(timedOut === undefined ? {} : { timedOut }),
    },
    isError,
    timestamp: 1789208561906,
  },
});

/** A 2+-question answer: `details.results[]`, each entry naming its question. */
const grouped = ({ id = ASK_ID, results } = {}) => JSON.stringify({
  type: 'message',
  id: 'r1',
  parentId: 'a1',
  message: {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'ask',
    content: [{ type: 'text', text: 'User answers:\n…' }],
    details: { results },
    isError: false,
    timestamp: 1789208561906,
  },
});

/** One transcript on disk, and the reference that names its ask. */
function transcriptOf(lines, { id = ASK_ID, name = 'session.jsonl' } = {}) {
  const dir = scratch();
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path, reference: `${path}#${id}` };
}

const boot = JSON.stringify({ type: 'session', version: 3, id: 'sess', cwd: '/Users/fake/Code/proj' });

const readWith = (lines, options, fixture = {}) => {
  const { dir, path, reference } = transcriptOf(lines, fixture);
  try {
    return { ...readModelConfirmation(reference, { questionId: QID, candidates: CANDIDATES, ...options }), path, reference };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a chosen candidate is the approval, and the answer is the selector itself', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [CODEX] })]);
  assert.equal(got.ok, true);
  assert.equal(got.selector, CODEX);
  assert.equal(got.reference, `${got.path}#${ASK_ID}`);
  assert.equal(got.reason, undefined);
});

test('any proposed candidate can be chosen, not only the recommended one', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [SONNET] })]);
  assert.deepEqual({ ok: got.ok, selector: got.selector }, { ok: true, selector: SONNET });
});

test('a note alongside the selection does not disturb it', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [CODEX], note: 'use the cheap one next time' })]);
  assert.deepEqual({ ok: got.ok, selector: got.selector }, { ok: true, selector: CODEX });
});

test('a grouped answer is attributed by question id, not by position', () => {
  const questions = [question({ id: 'unrelated', text: 'Ship it?', labels: ['yes', 'no'] }), question()];
  const results = [
    { id: 'unrelated', question: 'Ship it?', options: ['yes', 'no'], multi: false, selectedOptions: ['yes'] },
    { id: QID, question: TEXT, options: [...CANDIDATES, DEFER_LABEL], multi: false, selectedOptions: [CODEX] },
  ];
  const got = readWith([boot, call({ questions }), grouped({ results })]);
  assert.deepEqual({ ok: got.ok, selector: got.selector }, { ok: true, selector: CODEX });
});

test('a timeout auto-selection is refused even though it records a real selection', () => {
  // This is the measured shape: OMP picks the recommended option and writes it.
  const got = readWith([boot, call(), flat({ selectedOptions: [SONNET], timedOut: true })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /timed out/);
  assert.equal(got.selector, undefined);
});

test('a timeout inside a grouped answer is refused too', () => {
  const results = [{ id: QID, question: TEXT, options: [...CANDIDATES, DEFER_LABEL], multi: false, selectedOptions: [SONNET], timedOut: true }];
  const got = readWith([boot, call(), grouped({ results })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /timed out/);
});

test('typed text is never parsed as an approval, not even an exact selector', () => {
  const yes = readWith([boot, call(), flat({ selectedOptions: [], customInput: 'yes, go with sonnet' })]);
  assert.equal(yes.ok, false);
  assert.match(yes.reason, /custom input/);

  const typed = readWith([boot, call(), flat({ selectedOptions: [], customInput: CODEX })]);
  assert.equal(typed.ok, false);
  assert.match(typed.reason, /custom input/);
  assert.equal(typed.selector, undefined);
});

test('a cancelled ask is a refusal, whatever a caller hoped it meant', () => {
  const got = readWith([boot, call(), flat({ details: {}, isError: true })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /failed or was cancelled/);
});

test('an interrupt-skipped ask is a refusal', () => {
  const got = readWith([boot, call(), flat({ details: { __synthetic: true, source: 'interrupt_skipped', executed: false }, isError: true })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /failed or was cancelled/);
});

test('choosing to chat instead of answering is not an answer', () => {
  const got = readWith([boot, call(), flat({ details: { chatRedirect: true, questions: [TEXT] } })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /chatting/);
});

test('an unanswered question never defaults to the first candidate', () => {
  const got = readWith([boot, call()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /no result/);
  assert.equal(got.selector, undefined);
});

test('a deferred decision is named as a defer, not as a forged answer', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [DEFER_LABEL] })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /deferred/);
});

test('a forged id refuses: the result exists but its call asked another question', () => {
  const got = readWith([boot, call({ questions: [question({ id: 'ax-model:ofmchat-412:0000deadbeef' })] }), flat()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /different decision/);
});

test('a result bolted onto an ask this transcript never made refuses', () => {
  const got = readWith([boot, flat()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /did not make/);
});

test('an effort change staled the approval: the asked menu no longer offers the candidate', () => {
  // The stored answer is intact; the decision moved to :high underneath it.
  const moved = ['anthropic/claude-sonnet-5:high', CODEX];
  const got = readWith([boot, call(), flat({ selectedOptions: [CODEX] })], { candidates: moved });
  assert.equal(got.ok, false);
  assert.match(got.reason, /decision changed since it was asked/);
  assert.match(got.reason, /claude-sonnet-5:high/);
});

test('an added candidate stales the approval as well', () => {
  const grown = [...CANDIDATES, 'xai/grok-5:medium'];
  const got = readWith([boot, call(), flat({ selectedOptions: [CODEX] })], { candidates: grown });
  assert.equal(got.ok, false);
  assert.match(got.reason, /decision changed since it was asked/);
});

test('a candidate dropped from the policy cannot be the selection', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [SONNET] })], { candidates: [CODEX] });
  assert.equal(got.ok, false);
  assert.match(got.reason, /not a current candidate/);
});

test('a result echoing another question or another menu refuses', () => {
  const otherQuestion = readWith([boot, call(), flat({ text: 'Which model should the worker run on?' })]);
  assert.equal(otherQuestion.ok, false);
  assert.match(otherQuestion.reason, /different question/);

  const otherMenu = readWith([boot, call(), flat({ labels: [SONNET, CODEX] })]);
  assert.equal(otherMenu.ok, false);
  assert.match(otherMenu.reason, /different option list/);
});

test('two results for one ask id are ambiguous, and neither is chosen', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [SONNET] }), flat({ selectedOptions: [CODEX] })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /2 results/);
});

test('two calls carrying one ask id are ambiguous', () => {
  const got = readWith([boot, call(), call({ questions: [question({ labels: [CODEX, DEFER_LABEL] })] }), flat()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /appears 2 times/);
});

test('two answers for one question id inside a grouped result refuse', () => {
  const results = [
    { id: QID, question: TEXT, options: [...CANDIDATES, DEFER_LABEL], multi: false, selectedOptions: [SONNET] },
    { id: QID, question: TEXT, options: [...CANDIDATES, DEFER_LABEL], multi: false, selectedOptions: [CODEX] },
  ];
  const got = readWith([boot, call(), grouped({ results })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /2 answers/);
});

test('no selection, and several selections, are both refused', () => {
  const none = readWith([boot, call(), flat({ selectedOptions: [] })]);
  assert.equal(none.ok, false);
  assert.match(none.reason, /0 selected options/);

  const many = readWith([boot, call(), flat({ selectedOptions: [SONNET, CODEX] })]);
  assert.equal(many.ok, false);
  assert.match(many.reason, /2 selected options/);
});

test('a multi-select answer is not a model decision, on either side of the pair', () => {
  const askedMulti = readWith([boot, call({ questions: [question({ multi: true })] }), flat({ multi: true, selectedOptions: [SONNET] })]);
  assert.equal(askedMulti.ok, false);
  assert.match(askedMulti.reason, /multi-select/);

  const answeredMulti = readWith([boot, call(), flat({ multi: true, selectedOptions: [SONNET] })]);
  assert.equal(answeredMulti.ok, false);
  assert.match(answeredMulti.reason, /multi-select/);
});

test('an unnamed flat answer to a multi-question ask cannot be attributed', () => {
  const questions = [question(), question({ id: 'second', text: 'Ship it?', labels: ['yes', 'no'] })];
  const got = readWith([boot, call({ questions }), flat()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /cannot attribute/);
});

test('a result from another tool wearing the ask id refuses', () => {
  const alien = JSON.stringify({
    type: 'message',
    message: { role: 'toolResult', toolCallId: ASK_ID, toolName: 'bash', content: [], details: { selectedOptions: [SONNET] }, isError: false },
  });
  const got = readWith([boot, call(), alien]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /not ask/);
});

test('a truncated final line does not hide the answer written before it', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [CODEX] }), '{"type":"message","message":{"role":"assis']);
  assert.deepEqual({ ok: got.ok, selector: got.selector }, { ok: true, selector: CODEX });
});

test('an unreadable transcript refuses and never throws', () => {
  const dir = scratch();
  try {
    const got = readModelConfirmation(`${join(dir, 'absent.jsonl')}#${ASK_ID}`, { questionId: QID, candidates: CANDIDATES });
    assert.equal(got.ok, false);
    assert.match(got.reason, /cannot read the confirmation transcript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed reference is refused before any read is attempted', () => {
  const read = () => {
    throw new Error('must not be read');
  };
  for (const reference of ['', 'session.jsonl', '#call_x', 'session.jsonl#', undefined, 42]) {
    const got = readModelConfirmation(reference, { questionId: QID, candidates: CANDIDATES, read });
    assert.equal(got.ok, false, `${String(reference)} must refuse`);
    assert.match(got.reason, /<transcript path>#<ask toolCallId>/);
  }
});

test('a path holding a # still resolves: the split is on the last one', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [SONNET] })], {}, { name: 'run#3.jsonl' });
  assert.deepEqual({ ok: got.ok, selector: got.selector }, { ok: true, selector: SONNET });
});

test('the injected read is what is used, and is handed the path and utf8', () => {
  const seen = [];
  const lines = [boot, call(), flat({ selectedOptions: [CODEX] })].join('\n');
  const got = readModelConfirmation(`/nowhere/session.jsonl#${ASK_ID}`, {
    questionId: QID,
    candidates: CANDIDATES,
    read: (path, encoding) => (seen.push([path, encoding]), lines),
  });
  assert.deepEqual({ ok: got.ok, selector: got.selector }, { ok: true, selector: CODEX });
  assert.deepEqual(seen, [['/nowhere/session.jsonl', 'utf8']]);
});

test('a caller that supplies no decision to check is refused, not served', () => {
  const read = () => {
    throw new Error('must not be read');
  };
  const base = { candidates: CANDIDATES, read };
  const noId = readModelConfirmation(`a.jsonl#${ASK_ID}`, { ...base, questionId: '  ' });
  assert.equal(noId.ok, false);
  assert.match(noId.reason, /question id/);

  const noCandidates = readModelConfirmation(`a.jsonl#${ASK_ID}`, { questionId: QID, candidates: [], read });
  assert.equal(noCandidates.ok, false);
  assert.match(noCandidates.reason, /candidate selectors/);

  const repeated = readModelConfirmation(`a.jsonl#${ASK_ID}`, { questionId: QID, candidates: [SONNET, SONNET], read });
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /unique/);

  const deferAsCandidate = readModelConfirmation(`a.jsonl#${ASK_ID}`, { questionId: QID, candidates: [SONNET, DEFER_LABEL], read });
  assert.equal(deferAsCandidate.ok, false);
  assert.match(deferAsCandidate.reason, /reserved decline/);
});

test('the defer label is prose and can never be mistaken for a selector', () => {
  assert.equal(DEFER_LABEL.includes('/'), false);
  assert.equal(DEFER_LABEL.includes(':'), false);
});

// THE SCOPE GUARD. The reference is a path an orchestrator hands in, so on its
// own it can name any transcript on the disk. Scoped, it must name one this
// session recorded: inside the runtime's sessions root by realpath, and
// carrying that session's own header.

const bootOf = id => JSON.stringify({ type: 'session', version: 3, id, cwd: '/Users/fake/Code/proj' });

/** A sessions root with `files` written into named places around it. */
function sessionTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ax-model-scope-'));
  const sessionsRoot = join(dir, 'sessions');
  mkdirSync(sessionsRoot);
  const paths = {};
  for (const [name, { at, lines }] of Object.entries(files)) {
    const path = join(dir, at);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);
    paths[name] = path;
  }
  return { dir, sessionsRoot, paths };
}

const answered = (id = 'sess') => [bootOf(id), call(), flat({ selectedOptions: [CODEX] })];

const scopedRead = (tree, path, options = {}) =>
  readModelConfirmation(`${path}#${ASK_ID}`, {
    questionId: QID,
    candidates: CANDIDATES,
    sessionsRoot: tree.sessionsRoot,
    sessionId: 'sess',
    ...options,
  });

test('the session that asked reads its own answer, and the reference names the resolved file', () => {
  const tree = sessionTree({ mine: { at: 'sessions/sess.jsonl', lines: answered() } });
  try {
    const got = scopedRead(tree, tree.paths.mine);
    assert.equal(got.ok, true);
    assert.equal(got.selector, CODEX);
    assert.equal(got.reference, `${realpathSync(tree.paths.mine)}#${ASK_ID}`);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('a foreign transcript copied into the session root is not this session answering', () => {
  const tree = sessionTree({ theirs: { at: 'sessions/other.jsonl', lines: answered('other-sess') } });
  try {
    const got = scopedRead(tree, tree.paths.theirs);
    assert.equal(got.ok, false);
    assert.match(got.reason, /was recorded for session other-sess, not sess/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('a transcript with no session header cannot be attributed to this session', () => {
  const tree = sessionTree({ bare: { at: 'sessions/bare.jsonl', lines: [call(), flat({ selectedOptions: [CODEX] })] } });
  try {
    const got = scopedRead(tree, tree.paths.bare);
    assert.equal(got.ok, false);
    assert.match(got.reason, /carries no session header/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('a transcript outside the sessions root refuses, however genuine its contents', () => {
  const tree = sessionTree({ away: { at: 'elsewhere/sess.jsonl', lines: answered() } });
  try {
    const got = scopedRead(tree, tree.paths.away);
    assert.equal(got.ok, false);
    assert.match(got.reason, /resolves outside the session root/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('containment is a path relation, not a string prefix: a sibling root does not pass', () => {
  // `<dir>/sessions-evil/…` starts with `<dir>/sessions` as a string.
  const tree = sessionTree({ lookalike: { at: 'sessions-evil/sess.jsonl', lines: answered() } });
  try {
    const got = scopedRead(tree, tree.paths.lookalike);
    assert.equal(got.ok, false);
    assert.match(got.reason, /resolves outside the session root/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('a symlink planted in the session root cannot smuggle a transcript from outside it', () => {
  const tree = sessionTree({ away: { at: 'elsewhere/sess.jsonl', lines: answered() } });
  const link = join(tree.sessionsRoot, 'sess.jsonl');
  symlinkSync(tree.paths.away, link);
  try {
    const got = scopedRead(tree, link);
    assert.equal(got.ok, false);
    assert.match(got.reason, /resolves outside the session root/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('a reference naming a file that does not exist refuses at the scope, not at the read', () => {
  const tree = sessionTree({ mine: { at: 'sessions/sess.jsonl', lines: answered() } });
  try {
    const got = scopedRead(tree, join(tree.sessionsRoot, 'absent.jsonl'));
    assert.equal(got.ok, false);
    assert.match(got.reason, /cannot resolve the confirmation transcript .*ENOENT/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test('half a scope is no scope: each side alone refuses rather than checking the other', () => {
  const tree = sessionTree({ mine: { at: 'sessions/sess.jsonl', lines: answered() } });
  try {
    const rootOnly = scopedRead(tree, tree.paths.mine, { sessionId: undefined });
    assert.equal(rootOnly.ok, false);
    assert.match(rootOnly.reason, /needs both the sessions root and the current session id/);

    const idOnly = scopedRead(tree, tree.paths.mine, { sessionsRoot: undefined });
    assert.equal(idOnly.ok, false);
    assert.match(idOnly.reason, /needs both the sessions root and the current session id/);

    const blankId = scopedRead(tree, tree.paths.mine, { sessionId: '  ' });
    assert.equal(blankId.ok, false);
    assert.match(blankId.reason, /needs both the sessions root and the current session id/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});
