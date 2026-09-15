// The confirmation reader: did THIS human choose THIS class?
//
// The propositions under test are the ways a transcript can look like a choice
// without being one: a timeout that auto-selects the recommended class and
// writes it into `selectedOptions`; typed free text that says yes; a cancelled
// or chat-redirected ask; an answer to a question id that no longer describes
// the decision; a menu drawn before the project's classes changed; a result that
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
// The option labels are WORK CLASSES, because that is all this question ever
// offers: no model, no effort and no provider is named on either side of it.
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
const TEXT = 'Which class should ofmchat-412 be dispatched as? Recommended standard (capability).';
const ROUTINE = 'routine';
const STANDARD = 'standard';
const DEEP = 'deep';
const CLASSES = [ROUTINE, STANDARD, DEEP];

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-model-confirmation-'));

/** A native ask Question, as ./model-policy.mjs builds it: the label IS the class. */
const question = ({ id = QID, text = TEXT, labels = [...CLASSES, DEFER_LABEL], multi } = {}) => ({
  id,
  question: text,
  header: 'worker class for ofmchat-412',
  options: labels.map(label => ({ label, description: `dispatch this as ${label}` })),
  ...(multi === undefined ? { multi: false } : { multi }),
  recommended: 1,
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
      arguments: { i: 'Choosing the worker class', questions },
      streamIndex: 0,
      intent: 'Choosing the worker class',
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
  labels = [...CLASSES, DEFER_LABEL],
  selectedOptions = [STANDARD],
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
    return { ...readModelConfirmation(reference, { questionId: QID, choices: CLASSES, ...options }), path, reference };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a chosen class is the answer, and the answer is that class itself', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [DEEP] })]);
  assert.equal(got.ok, true);
  assert.equal(got.choice, DEEP);
  assert.equal(got.reference, `${got.path}#${ASK_ID}`);
  assert.equal(got.reason, undefined);
});

test('any offered class can be chosen, not only the recommended one', () => {
  // The whole point of asking: the human may go BELOW what was recommended.
  const got = readWith([boot, call(), flat({ selectedOptions: [ROUTINE] })]);
  assert.deepEqual({ ok: got.ok, choice: got.choice }, { ok: true, choice: ROUTINE });
});

test('a note alongside the selection does not disturb it', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [DEEP], note: 'the lock design is still open' })]);
  assert.deepEqual({ ok: got.ok, choice: got.choice }, { ok: true, choice: DEEP });
});

test('a grouped answer is attributed by question id, not by position', () => {
  const questions = [question({ id: 'unrelated', text: 'Ship it?', labels: ['yes', 'no'] }), question()];
  const results = [
    { id: 'unrelated', question: 'Ship it?', options: ['yes', 'no'], multi: false, selectedOptions: ['yes'] },
    { id: QID, question: TEXT, options: [...CLASSES, DEFER_LABEL], multi: false, selectedOptions: [DEEP] },
  ];
  const got = readWith([boot, call({ questions }), grouped({ results })]);
  assert.deepEqual({ ok: got.ok, choice: got.choice }, { ok: true, choice: DEEP });
});

test('a timeout auto-selection is refused even though it records a real selection', () => {
  // This is the measured shape: OMP picks the recommended option and writes it.
  const got = readWith([boot, call(), flat({ selectedOptions: [STANDARD], timedOut: true })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /timed out/);
  assert.equal(got.choice, undefined);
});

test('a timeout inside a grouped answer is refused too', () => {
  const results = [{ id: QID, question: TEXT, options: [...CLASSES, DEFER_LABEL], multi: false, selectedOptions: [STANDARD], timedOut: true }];
  const got = readWith([boot, call(), grouped({ results })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /timed out/);
});

test('typed text is never parsed as a choice, not even an exactly typed class', () => {
  const yes = readWith([boot, call(), flat({ selectedOptions: [], customInput: 'yes, the cheap one' })]);
  assert.equal(yes.ok, false);
  assert.match(yes.reason, /custom input/);

  const typed = readWith([boot, call(), flat({ selectedOptions: [], customInput: DEEP })]);
  assert.equal(typed.ok, false);
  assert.match(typed.reason, /custom input/);
  assert.equal(typed.choice, undefined);
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

test('an unanswered question never defaults to the recommended class', () => {
  const got = readWith([boot, call()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /no result/);
  assert.equal(got.choice, undefined);
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

test('a class the project added since the ask stales the answer', () => {
  // The stored answer is intact; the menu the human saw no longer describes the
  // decision, so it is refused rather than translated onto the new set.
  const grown = [...CLASSES, 'exploratory'];
  const got = readWith([boot, call(), flat({ selectedOptions: [DEEP] })], { choices: grown });
  assert.equal(got.ok, false);
  assert.match(got.reason, /decision changed since it was asked/);
  assert.match(got.reason, /exploratory/);
});

test('a class dropped from the project stales the menu, and a fabricated selection is not a class', () => {
  const dropped = readWith([boot, call(), flat({ selectedOptions: [ROUTINE] })], { choices: [STANDARD, DEEP] });
  assert.equal(dropped.ok, false);
  assert.match(dropped.reason, /decision changed since it was asked/);
  assert.match(dropped.reason, /offered routine, standard, deep/);

  // The menu is this decision's own here, and the recorded selection is still
  // not on it: a label nothing offered is never translated into a class.
  const invented = readWith([boot, call(), flat({ selectedOptions: ['exploratory'] })]);
  assert.equal(invented.ok, false);
  assert.match(invented.reason, /not a class this decision offers: exploratory/);
});

test('a result echoing another question or another menu refuses', () => {
  const otherQuestion = readWith([boot, call(), flat({ text: 'Which class should ofmchat-413 be dispatched as?' })]);
  assert.equal(otherQuestion.ok, false);
  assert.match(otherQuestion.reason, /different question/);

  const otherMenu = readWith([boot, call(), flat({ labels: [...CLASSES] })]);
  assert.equal(otherMenu.ok, false);
  assert.match(otherMenu.reason, /different option list/);
});

// THE QUESTION IS THE DECISION. The id hashes the mode, the classes, the
// recommendation and the policy hash — and none of the WORDS, so an ask can
// carry the right id while posing another dialog: other prose, a description
// that recommends the expensive class, a menu with something extra on it or
// with no way to decline. Production therefore hands the reader the question
// its own builder produced, and it is compared whole.

const canonical = question();

test('the question this decision builds is read as the approval it is', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [DEEP] })], { expectedQuestion: canonical });
  assert.deepEqual({ ok: got.ok, choice: got.choice }, { ok: true, choice: DEEP });
});

test('the same id over rewritten question prose is not this decision', () => {
  const reworded = question({ text: 'Ship it?' });
  const got = readWith(
    [boot, call({ questions: [reworded] }), flat({ text: 'Ship it?', selectedOptions: [DEEP] })],
    { expectedQuestion: canonical },
  );
  assert.equal(got.ok, false);
  assert.match(got.reason, /does not ask what this decision asks/);
});

test('a rewritten header, a rewritten option description and a moved recommendation each refuse', () => {
  const headed = readWith(
    [boot, call({ questions: [{ ...canonical, header: 'worker class for ofmchat-999' }] }), flat({ selectedOptions: [DEEP] })],
    { expectedQuestion: canonical },
  );
  assert.equal(headed.ok, false);
  assert.match(headed.reason, /was headed/);

  // The prose a human actually reads beside the label — the place a steering
  // orchestrator would write its own recommendation.
  const options = canonical.options.map(option => (option.label === DEEP ? { ...option, description: 'recommended: pick this one' } : option));
  const described = readWith(
    [boot, call({ questions: [{ ...canonical, options }] }), flat({ selectedOptions: [DEEP] })],
    { expectedQuestion: canonical },
  );
  assert.equal(described.ok, false);
  assert.match(described.reason, /describes itself as/);

  const steered = readWith(
    [boot, call({ questions: [{ ...canonical, recommended: 2 }] }), flat({ selectedOptions: [DEEP] })],
    { expectedQuestion: canonical },
  );
  assert.equal(steered.ok, false);
  assert.match(steered.reason, /steered towards another class/);
});

test('an added option preview cannot change the approved presentation', () => {
  const options = canonical.options.map(option => ({ ...option, preview: 'Approve unrelated work instead' }));
  const result = readWith(
    [boot, call({ questions: [{ ...canonical, options }] }), flat({ selectedOptions: [DEEP] })],
    { expectedQuestion: canonical },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /different preview/);
});

test('a superset menu and a menu with no decline refuse at the seam, before any question is supplied', () => {
  const extra = { label: 'exploratory', description: 'a class this project does not configure' };
  const superset = readWith([
    boot,
    call({ questions: [{ ...canonical, options: [...canonical.options, extra] }] }),
    flat({ labels: [...CLASSES, DEFER_LABEL, extra.label], selectedOptions: [DEEP] }),
  ]);
  assert.equal(superset.ok, false);
  assert.match(superset.reason, /decision changed since it was asked/);
  assert.match(superset.reason, /exploratory/);

  // A question with no decline is a rubber stamp, and the decline is required
  // of the menu itself — not inferred from the answer.
  const stamp = readWith([
    boot,
    call({ questions: [question({ labels: [...CLASSES] })] }),
    flat({ labels: [...CLASSES], selectedOptions: [DEEP] }),
  ]);
  assert.equal(stamp.ok, false);
  assert.match(stamp.reason, /decision changed since it was asked/);
  assert.ok(stamp.reason.includes(DEFER_LABEL), stamp.reason);
});

test('two results for one ask id are ambiguous, and neither is chosen', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [ROUTINE] }), flat({ selectedOptions: [DEEP] })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /2 results/);
});

test('two calls carrying one ask id are ambiguous', () => {
  const got = readWith([boot, call(), call({ questions: [question({ labels: [DEEP, DEFER_LABEL] })] }), flat()]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /appears 2 times/);
});

test('two answers for one question id inside a grouped result refuse', () => {
  const results = [
    { id: QID, question: TEXT, options: [...CLASSES, DEFER_LABEL], multi: false, selectedOptions: [ROUTINE] },
    { id: QID, question: TEXT, options: [...CLASSES, DEFER_LABEL], multi: false, selectedOptions: [DEEP] },
  ];
  const got = readWith([boot, call(), grouped({ results })]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /2 answers/);
});

test('no selection, and several selections, are both refused', () => {
  const none = readWith([boot, call(), flat({ selectedOptions: [] })]);
  assert.equal(none.ok, false);
  assert.match(none.reason, /0 selected options/);

  const many = readWith([boot, call(), flat({ selectedOptions: [ROUTINE, DEEP] })]);
  assert.equal(many.ok, false);
  assert.match(many.reason, /2 selected options/);
});

test('a multi-select answer is not one decision, on either side of the pair', () => {
  const askedMulti = readWith([boot, call({ questions: [question({ multi: true })] }), flat({ multi: true, selectedOptions: [ROUTINE] })]);
  assert.equal(askedMulti.ok, false);
  assert.match(askedMulti.reason, /multi-select/);

  const answeredMulti = readWith([boot, call(), flat({ multi: true, selectedOptions: [ROUTINE] })]);
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
    message: { role: 'toolResult', toolCallId: ASK_ID, toolName: 'bash', content: [], details: { selectedOptions: [ROUTINE] }, isError: false },
  });
  const got = readWith([boot, call(), alien]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /not ask/);
});

test('a truncated final line does not hide the answer written before it', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [DEEP] }), '{"type":"message","message":{"role":"assis']);
  assert.deepEqual({ ok: got.ok, choice: got.choice }, { ok: true, choice: DEEP });
});

test('an unreadable transcript refuses and never throws', () => {
  const dir = scratch();
  try {
    const got = readModelConfirmation(`${join(dir, 'absent.jsonl')}#${ASK_ID}`, { questionId: QID, choices: CLASSES });
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
    const got = readModelConfirmation(reference, { questionId: QID, choices: CLASSES, read });
    assert.equal(got.ok, false, `${String(reference)} must refuse`);
    assert.match(got.reason, /<transcript path>#<ask toolCallId>/);
  }
});

test('a path holding a # still resolves: the split is on the last one', () => {
  const got = readWith([boot, call(), flat({ selectedOptions: [ROUTINE] })], {}, { name: 'run#3.jsonl' });
  assert.deepEqual({ ok: got.ok, choice: got.choice }, { ok: true, choice: ROUTINE });
});


test('a caller that supplies no decision to check is refused, not served', () => {
  const read = () => {
    throw new Error('must not be read');
  };
  const base = { choices: CLASSES, read };
  const noId = readModelConfirmation(`a.jsonl#${ASK_ID}`, { ...base, questionId: '  ' });
  assert.equal(noId.ok, false);
  assert.match(noId.reason, /question id/);

  const noChoices = readModelConfirmation(`a.jsonl#${ASK_ID}`, { questionId: QID, choices: [], read });
  assert.equal(noChoices.ok, false);
  assert.match(noChoices.reason, /classes the current decision offers/);

  const repeated = readModelConfirmation(`a.jsonl#${ASK_ID}`, { questionId: QID, choices: [ROUTINE, ROUTINE], read });
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /unique/);

  const deferAsChoice = readModelConfirmation(`a.jsonl#${ASK_ID}`, { questionId: QID, choices: [ROUTINE, DEFER_LABEL], read });
  assert.equal(deferAsChoice.ok, false);
  assert.match(deferAsChoice.reason, /reserved decline/);
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

const answered = (id = 'sess') => [bootOf(id), call(), flat({ selectedOptions: [DEEP] })];

const scopedRead = (tree, path, options = {}) =>
  readModelConfirmation(`${path}#${ASK_ID}`, {
    questionId: QID,
    choices: CLASSES,
    sessionsRoot: tree.sessionsRoot,
    sessionId: 'sess',
    ...options,
  });

test('the session that asked reads its own answer, and the reference names the resolved file', () => {
  const tree = sessionTree({ mine: { at: 'sessions/sess.jsonl', lines: answered() } });
  try {
    const got = scopedRead(tree, tree.paths.mine);
    assert.equal(got.ok, true);
    assert.equal(got.choice, DEEP);
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
  const tree = sessionTree({ bare: { at: 'sessions/bare.jsonl', lines: [call(), flat({ selectedOptions: [DEEP] })] } });
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
