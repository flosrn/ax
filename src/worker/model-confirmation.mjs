// The human's answer to a `--model-mode ask` question, read from the transcript
// where OMP itself wrote it — never from prose an agent reports. An orchestrator
// that could pass `--model-approved` would be authorizing itself, so the proof
// is the artifact the runtime produced: `<session>.jsonl#<ask toolCallId>`. This
// module reads that pair and answers one question — did THIS human choose THIS
// class, here, for this decision — and writes nothing.
//
// THE SHAPES ARE MEASURED (omp's ask tool `execute`, 2026-09-13, cross-checked
// against 487 real ask results under ~/.omp/agent/sessions):
//
//   call    {type:'toolCall', id, name:'ask', arguments:{questions:[{id, question,
//           header?, options:[{label, description?, preview?}], multi?, recommended?}]}}
//   result  {role:'toolResult', toolCallId, toolName:'ask', isError, details}
//
// and `details` has THREE shapes, all of which occur on disk:
//   - ONE question  -> flat {question, options:[label], multi, selectedOptions,
//                      customInput?, note?, timedOut?}  — and NO question id
//   - 2+ questions  -> {results:[{id, question, options, multi, selectedOptions,
//                      customInput?, note?, timedOut?}]}
//   - refusals      -> {} with isError (cancel, interrupt-skip) or
//                      {chatRedirect:true, questions:[…]}
//
// Hence three guards. IDENTITY LIVES IN THE CALL: the single-question result
// carries no question id, so the id comes from the originating toolCall and the
// result is bound to it by `toolCallId`, the one field the runtime rather than
// the model controls. A SELECTION IS A LABEL, so a work class must BE the label
// and prose lives in `description`. STALENESS IS DETECTABLE ONLY BY RE-READING
// THE QUESTION, so the asked menu must be EXACTLY the classes this decision
// offers followed by the decline — no extra option, no missing decline, no
// re-ordering — and, when the caller supplies the question its own builder
// produced, every word of the dialog is compared too: text, header, multi, the
// recommended index and each option's description. The id is a hash of the
// DECISION, not of the prose, so two asks carrying one id can word the dialog
// differently, and a human who answered other words answered another dialog.
// The result's echoed question/options are compared against the call's as
// well; an answer to a different menu is refused, never translated.
//
// WHAT IS NOT AN APPROVAL: `timedOut` (OMP auto-selects the recommended option
// and still writes a non-empty `selectedOptions` — the dialog answering, not
// the human), `customInput` (the free-text editor cannot be disabled, and typed
// text is never parsed for a class, even an exactly typed one), `isError`,
// `chatRedirect`, zero or several selections, `multi`, and a MISSING result —
// which refuses rather than defaulting to the recommended class.
//
// FAIL-CLOSED AND NON-THROWING. Every inability is `{ok:false, reason}`: an
// unreadable file, a truncated line, a forged id, a menu that no longer
// matches. The caller is `dispatch`, which refuses before placement, so no
// filesystem or parse error escapes this module.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

/**
 * The one option that is NOT a choice: the human declining to pick now.
 *
 * ONE CONSTANT, owned here and imported by the question builder in
 * ./model-policy.mjs. Two spellings would make the builder offer a decline this
 * reader does not recognise, and a deferred decision would come back as "not a
 * current choice" — a forged-answer refusal for a human who chose to wait.
 * Prose rather than a bare `defer` because a human reads it in the dialog, and
 * it cannot collide with a class label.
 */
export const DEFER_LABEL = 'Defer — do not dispatch yet';

/** A `{path, id}` reference, or null. Split on the LAST `#`: a path may hold one. */
function splitReference(reference) {
  if (typeof reference !== 'string') return null;
  const at = reference.lastIndexOf('#');
  if (at <= 0) return null;
  const path = reference.slice(0, at).trim();
  const id = reference.slice(at + 1).trim();
  if (path === '' || id === '') return null;
  return { path, id };
}

const refuse = reason => ({ ok: false, reason });

/** The label of an option, whichever of the two accepted forms it takes. */
function labelOf(option) {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object' && typeof option.label === 'string') return option.label;
  return null;
}

/** Element-wise string equality — the echoed menu against the asked one. */
const sameLabels = (a, b) => a.length === b.length && a.every((label, i) => label === b[i]);

/** The prose of an option, or null when it carries none. */
function descriptionOf(option) {
  if (option && typeof option === 'object' && typeof option.description === 'string') return option.description;
  return null;
}

/**
 * Does the question this transcript recorded differ from the one THIS decision
 * builds — field by field, prose included?
 *
 * Comparing the id alone was the hole: it hashes the mode, the classes, the
 * recommendation and the policy hash, and NONE of the words. An ask carrying
 * the right id could therefore pose any question at all — "Ship it?", a
 * description recommending the expensive class, a header naming another
 * request — and its answer read as approval of this dispatch. So the canonical
 * question is compared whole, and a difference names the field that differs so
 * the repair is to re-ask the built question rather than to guess.
 *
 * @returns {string|null} the refusal reason, or null when it is the same question
 */
function questionMismatch(asked, expected, questionId, callId) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return `model confirmation needs the question this decision builds, to compare against ask ${callId}`;
  }
  if (expected.id !== questionId) {
    return `the question this decision builds is ${String(expected.id)}, not ${questionId}: the comparison would be against another decision`;
  }
  const expectedOptions = Array.isArray(expected.options) ? expected.options : [];
  if (expectedOptions.length === 0) {
    return `the question this decision builds offers no options: there is nothing to compare ask ${callId} against`;
  }
  if (Object.keys(asked).some(key => !Object.hasOwn(expected, key))) {
    return `question ${questionId} in ${callId} carries fields absent from the expected question`;
  }
  if (asked.question !== expected.question) {
    return `question ${questionId} in ${callId} does not ask what this decision asks: the human answered ${JSON.stringify(asked.question)}, not ${JSON.stringify(expected.question)}`;
  }
  if ((asked.header ?? null) !== (expected.header ?? null)) {
    return `question ${questionId} in ${callId} was headed ${JSON.stringify(asked.header ?? null)}, not ${JSON.stringify(expected.header ?? null)}: the dialog framed another decision`;
  }
  if ((asked.multi ?? false) !== (expected.multi ?? false)) {
    return `question ${questionId} in ${callId} was asked with multi ${String(asked.multi ?? false)}, not ${String(expected.multi ?? false)}`;
  }
  if ((asked.recommended ?? null) !== (expected.recommended ?? null)) {
    return `question ${questionId} in ${callId} recommended option ${String(asked.recommended ?? null)}, not ${String(expected.recommended ?? null)}: the human was steered towards another class`;
  }
  const askedOptions = Array.isArray(asked.options) ? asked.options : [];
  if (askedOptions.length !== expectedOptions.length) {
    return `question ${questionId} in ${callId} offered ${askedOptions.length} options, not the ${expectedOptions.length} this decision offers`;
  }
  for (let i = 0; i < expectedOptions.length; i += 1) {
    const label = labelOf(expectedOptions[i]);
    if (labelOf(askedOptions[i]) !== label) {
      return `option ${i + 1} of question ${questionId} in ${callId} is ${JSON.stringify(labelOf(askedOptions[i]))}, not ${JSON.stringify(label)}`;
    }
    if (descriptionOf(askedOptions[i]) !== descriptionOf(expectedOptions[i])) {
      return `option ${JSON.stringify(label)} of question ${questionId} in ${callId} describes itself as ${JSON.stringify(descriptionOf(askedOptions[i]))}, not as ${JSON.stringify(descriptionOf(expectedOptions[i]))}: the human read other prose than this decision writes`;
    }
    if ((askedOptions[i]?.preview ?? null) !== (expectedOptions[i]?.preview ?? null)) {
      return `option ${JSON.stringify(label)} of question ${questionId} in ${callId} carries a different preview`;
    }
    if (typeof askedOptions[i] === 'object' && Object.keys(askedOptions[i]).some(key => !Object.hasOwn(expectedOptions[i], key))) {
      return `option ${JSON.stringify(label)} of question ${questionId} in ${callId} carries fields absent from the expected option`;
    }
  }
  return null;
}

/**
 * Every parseable JSONL entry of `text`, with the unparseable ones counted.
 *
 * A truncated final line is the ordinary shape of a session still being
 * appended to, and it must not hide the answer written before it — so a bad
 * line is skipped, exactly as ../worker/transcript.mjs does.
 */
function* entriesOf(text) {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    yield entry;
  }
}

/** The content parts of an entry that is a message with the given role. */
function partsOf(entry, role) {
  if (entry?.type !== 'message') return [];
  const message = entry.message;
  if (!message || message.role !== role) return [];
  return Array.isArray(message.content) ? message.content : [];
}

/**
 * Was THIS decision, over THESE classes, answered by the human at
 * `<path>#<ask toolCallId>`?
 *
 * @param {string} reference `<session jsonl path>#<ask toolCallId>`.
 * @param {object} options
 * @param {string} options.questionId The id the current decision produces
 *   (`ax-model:<request>:<hash>`). An answer to any other question refuses.
 * @param {string[]} options.choices The classes this project configures, in
 *   class order. Every one of them must have been on the menu, and the
 *   selection must be one of them.
 * @param {string} [options.sessionsRoot] The runtime's sessions directory. With
 *   `sessionId`, binds the reference to THIS session's own transcript. Both or
 *   neither: a half-supplied scope refuses.
 * @param {string} [options.sessionId] The dispatcher's session id, as the peer
 *   registry records it. The transcript's `session` header must carry it.
 * @param {Function} [options.read] `readFileSync`, injected by the tests.
 * @param {object} [options.expectedQuestion] The question `modelConfirmationQuestion`
 *   builds for this decision. Supplied, the asked question must match it
 *   exactly — text, header, multi, recommended index and every option label and
 *   description. Production MUST supply it: the id alone hashes no prose, so
 *   without it a rewritten dialog carrying the right id reads as approval. It
 *   stays optional only so the low-level guards can be exercised one at a time.
 * @returns {{ok: true, choice: string, reference: string}|{ok: false, reason: string}}
 */
export function readModelConfirmation(
  reference,
  { questionId, choices, sessionsRoot, sessionId, expectedQuestion, read = readFileSync } = {},
) {
  const target = splitReference(reference);
  if (target === null) {
    return refuse('model confirmation reference must be <transcript path>#<ask toolCallId>');
  }
  if (typeof questionId !== 'string' || questionId.trim() === '') {
    return refuse('model confirmation needs the question id the current decision produces');
  }
  if (!Array.isArray(choices) || choices.length === 0 || choices.some(c => typeof c !== 'string' || c.trim() === '')) {
    return refuse('model confirmation needs the classes the current decision offers');
  }
  if (new Set(choices).size !== choices.length) {
    return refuse('classes must be unique: a repeated label cannot identify a choice');
  }
  if (choices.includes(DEFER_LABEL)) {
    return refuse(`no class may be labelled ${DEFER_LABEL}: it is the reserved decline`);
  }

  // THE SCOPE GUARD. Integrity, not authentication: anything running as this
  // user can write a transcript with a matching header, and this cannot stop
  // it. What it does stop is a reference to a transcript that is not this
  // session's — one copied in from another session, one living outside the
  // sessions root, or one reached by a symlink pointing out of it. Both halves
  // are resolved with realpath, so containment is a real path relation and not
  // a string prefix.
  const scoped = sessionsRoot !== undefined || sessionId !== undefined;
  if (scoped) {
    if (typeof sessionsRoot !== 'string' || sessionsRoot.trim() === '' || typeof sessionId !== 'string' || sessionId.trim() === '') {
      return refuse('model confirmation scope needs both the sessions root and the current session id');
    }
    let realRoot;
    let realPath;
    try {
      realRoot = realpathSync(sessionsRoot);
      realPath = realpathSync(target.path);
    } catch (error) {
      return refuse(`cannot resolve the confirmation transcript ${target.path} under ${sessionsRoot}: ${error?.code ?? 'unresolvable'}`);
    }
    const inside = relative(realRoot, realPath);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      return refuse(`confirmation transcript ${target.path} resolves outside the session root ${sessionsRoot}`);
    }
    // Everything downstream — every refusal, and the returned reference —
    // names the artifact that was actually read.
    target.path = realPath;
  }

  let text;
  try {
    text = String(read(target.path, 'utf8'));
  } catch (error) {
    // The path is named, the cause is not trusted to be printable prose.
    return refuse(`cannot read the confirmation transcript ${target.path}: ${error?.code ?? 'unreadable'}`);
  }

  // PASS ONE: the originating call. It carries the question id, the exact
  // question text and the menu — the three things the result is checked against.
  const calls = [];
  const results = [];
  const headers = [];
  for (const entry of entriesOf(text)) {
    if (entry?.type === 'session') headers.push(entry);
    for (const part of partsOf(entry, 'assistant')) {
      if (part?.type === 'toolCall' && part.name === 'ask' && part.id === target.id) calls.push(part);
    }
    if (entry?.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolCallId === target.id) {
      results.push(entry.message);
    }
  }

  // The header the runtime wrote when it opened the file. A transcript copied
  // into the session root still names the session it was recorded for.
  if (scoped) {
    const owners = new Set(headers.map(header => header.id).filter(id => typeof id === 'string' && id.trim() !== ''));
    if (owners.size === 0) {
      return refuse(`confirmation transcript ${target.path} carries no session header: it cannot be attributed to session ${sessionId}`);
    }
    if (owners.size > 1 || !owners.has(sessionId)) {
      return refuse(`confirmation transcript ${target.path} was recorded for session ${[...owners].join(', ')}, not ${sessionId}`);
    }
  }

  if (calls.length === 0) {
    return refuse(`no ask call ${target.id} in ${target.path}: the reference names a call this transcript did not make`);
  }
  if (calls.length > 1) {
    // One toolCallId is one call. Two is a rewritten or concatenated
    // transcript, and choosing between them would be choosing the answer.
    return refuse(`ask call ${target.id} appears ${calls.length} times in ${target.path}: ambiguous confirmation`);
  }

  const asked = Array.isArray(calls[0].arguments?.questions) ? calls[0].arguments.questions : null;
  if (asked === null || asked.length === 0) {
    return refuse(`ask call ${target.id} asked no questions`);
  }
  const matching = asked.filter(question => question?.id === questionId);
  if (matching.length !== 1) {
    return refuse(`ask call ${target.id} does not ask ${questionId} exactly once: the approval is for a different decision`);
  }
  const question = matching[0];
  if (typeof question.question !== 'string' || question.question.trim() === '') {
    return refuse(`question ${questionId} in ${target.id} carries no question text`);
  }
  if (question.multi === true) {
    return refuse(`question ${questionId} was asked as multi-select: a work-class decision is one choice`);
  }
  const askedLabels = (Array.isArray(question.options) ? question.options : []).map(labelOf);
  if (askedLabels.length === 0 || askedLabels.some(label => label === null)) {
    return refuse(`question ${questionId} in ${target.id} has no readable option labels`);
  }
  // THE STALENESS GUARD, EXACTLY. The menu the human saw must BE the menu this
  // decision builds: the configured classes in class order, then the decline.
  // A subset check passed a superset menu — an ask offering a class this
  // project does not configure — and passed a menu with no way to decline,
  // which is a rubber stamp, so the comparison is ordered and total.
  const expectedLabels = [...choices, DEFER_LABEL];
  if (!sameLabels(askedLabels, expectedLabels)) {
    return refuse(`question ${questionId} offered ${askedLabels.join(', ')}, not ${expectedLabels.join(', ')}: the decision changed since it was asked`);
  }
  // AND THE WORDS, when the caller brought the question it built.
  if (expectedQuestion !== undefined) {
    const mismatch = questionMismatch(question, expectedQuestion, questionId, target.id);
    if (mismatch !== null) return refuse(mismatch);
  }

  // PASS TWO: the answer. A question with no result is unanswered — never a
  // silent default to the recommended class.
  if (results.length === 0) {
    return refuse(`ask call ${target.id} has no result in ${target.path}: the question was asked and not answered`);
  }
  if (results.length > 1) {
    return refuse(`ask call ${target.id} has ${results.length} results in ${target.path}: ambiguous confirmation`);
  }
  const result = results[0];
  if (result.toolName !== 'ask') {
    return refuse(`result for ${target.id} came from ${result.toolName ?? 'an unnamed tool'}, not ask`);
  }
  if (result.isError === true) {
    return refuse(`ask ${target.id} failed or was cancelled: no answer was recorded`);
  }
  const details = result.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return refuse(`ask ${target.id} recorded no answer details`);
  }
  if (details.chatRedirect === true) {
    return refuse(`ask ${target.id} was answered by chatting instead of choosing`);
  }

  // The two answer shapes. `results` is what 2+ questions produce and is the
  // only one that names the question; the flat shape is a single question, and
  // is accepted only when the call asked exactly that one — otherwise there is
  // nothing in the record to say which question it answers.
  let record;
  if (Array.isArray(details.results)) {
    const answers = details.results.filter(answer => answer?.id === questionId);
    if (answers.length !== 1) {
      return refuse(`ask ${target.id} holds ${answers.length} answers for ${questionId}`);
    }
    record = answers[0];
  } else if (asked.length === 1) {
    record = details;
  } else {
    return refuse(`ask ${target.id} asked ${asked.length} questions but recorded one unnamed answer: cannot attribute it to ${questionId}`);
  }

  // The result echoes the question and the menu it was drawn from. They must be
  // the ones this reference's call asked — an echo that disagrees is a record
  // stitched together from two asks.
  if (record.question !== question.question) {
    return refuse(`the answer for ${questionId} echoes a different question than ask ${target.id} asked`);
  }
  const echoed = (Array.isArray(record.options) ? record.options : []).map(labelOf);
  if (echoed.some(label => label === null) || !sameLabels(echoed, askedLabels)) {
    return refuse(`the answer for ${questionId} echoes a different option list than ask ${target.id} offered`);
  }
  if (record.multi === true) {
    return refuse(`the answer for ${questionId} was recorded as multi-select: a work-class decision is one choice`);
  }
  // A timeout auto-selects the recommended option and still writes it into
  // `selectedOptions`; refused BEFORE the selection is read, because the
  // selection is real and is not the human's.
  if (record.timedOut === true) {
    return refuse(`ask ${target.id} timed out: the auto-selected option is not an approval`);
  }
  if (record.customInput !== undefined) {
    return refuse(`ask ${target.id} was answered with custom input: typed text is not one of the offered classes`);
  }
  const selected = Array.isArray(record.selectedOptions) ? record.selectedOptions : [];
  if (selected.length !== 1 || typeof selected[0] !== 'string') {
    return refuse(`ask ${target.id} recorded ${selected.length} selected options for ${questionId}: exactly one is required`);
  }
  const choice = selected[0];
  if (choice === DEFER_LABEL) {
    return refuse(`the class for ${questionId} was deferred: no class was chosen`);
  }
  if (!choices.includes(choice)) {
    return refuse(`the selected option for ${questionId} is not a class this decision offers: ${choice}`);
  }

  return { ok: true, choice, reference: `${target.path}#${target.id}` };
}
