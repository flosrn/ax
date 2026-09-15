// WHICH ROLE a worker dispatch runs on. A role, and never a model.
//
// The division of labour is the whole design. AX decides a CLASS of work —
// routine, standard or deep — and hands the child the OMP role configured for
// it. Which concrete model, which account and which provider answer that role
// is the gateway's decision (OmniRoute) and OMP's role configuration, read on
// the host that serves the request. Nothing here expands a role into candidates,
// probes a target, compares quotas or names a vendor: a second opinion about
// models is a second table to keep in sync, and the one that loses is always the
// one a human edited last.
//
// Pure. The inputs are the orchestrator's assessment, this project's configured
// roles, the ticket's labels, and — in `ask` mode — the class a human actually
// chose in a native `ask` dialog, already verified by ./model-confirmation.mjs.
// No I/O.
//
// THREE MODES, and each answers a different question about who decides:
//   auto   — the orchestrator assesses the class from the assignment it read.
//            No assessment is not an error: it routes the CONSERVATIVE class
//            (`standard`), never the cheapest configured one.
//   manual — the OPERATOR named the class, in prose, and the orchestrator
//            carried it here as `--capability <class> --because <why>`. There is
//            nothing to assess, so an absent class refuses.
//   ask    — the class is chosen in a native `ask` dialog, in THIS session, for
//            THIS request. The preliminary decision carries the menu and a
//            recommendation; only a verified answer decides, and the answer
//            outranks both the recommendation and any label floor.
//
// FAIL-CLOSED. A class this project configured no role for throws. A mode with
// nothing to decide from throws. A project that configured NO roles at all is
// the opt-out: it keeps `@default`, exactly as it did before any of this
// existed, and every mode past `auto` refuses there rather than inventing a
// route it was never given.

import { createHash } from 'node:crypto';

// One spelling of the decline option, shared with the reader that verifies it:
// two would turn a deliberate defer into a forged-answer refusal. One-way
// import; that module takes nothing from here.
import { DEFER_LABEL } from './model-confirmation.mjs';

/** Work classes, cheapest first. Index order IS the floor comparison. */
export const MODEL_CAPABILITIES = ['routine', 'standard', 'deep'];

/** Who decides the class. `auto` is the default, so an old dispatch is unchanged. */
export const MODEL_MODES = ['auto', 'manual', 'ask'];

/** The class an absent assessment routes to: conservative, never cheapest. */
export const DEFAULT_CAPABILITY = 'standard';

/** What each class means, in the one sentence a human reads in the ask dialog. */
const CLASS_DESCRIPTION = {
  routine: 'a decided solution, a bounded surface and known verification',
  standard: 'ordinary implementation, or not enough evidence to go lower',
  deep: 'unresolved design, difficult diagnosis or consequential changes',
};

const configHash = (models, floors) =>
  createHash('sha256').update(JSON.stringify({ version: 1, models, floors })).digest('hex');

/** The classes this project configured a role for, in class order. */
const configuredClasses = models =>
  MODEL_CAPABILITIES.filter(cls => String(models?.[cls] ?? '').trim() !== '');


/**
 * Raise the assessed class to the highest floor its labels demand, and name
 * them. A floor is a RECOMMENDATION: it raises what AX would assess, and never
 * a class a human named (see `operatorChose` below).
 */
function raise(assessed, floors, labels) {
  let capability = assessed;
  const floorLabels = [];
  for (const label of labels ?? []) {
    const floor = Object.hasOwn(floors ?? {}, label) ? floors[label] : undefined;
    if (MODEL_CAPABILITIES.indexOf(floor) > MODEL_CAPABILITIES.indexOf(capability)) {
      capability = floor;
      floorLabels.length = 0;
      floorLabels.push(label);
    } else if (floor === capability && capability !== assessed) {
      floorLabels.push(label);
    }
  }
  return { capability, floorLabels };
}

/**
 * Decide a worker's role.
 *
 * @param {object} [options]
 * @param {string} [options.model]      legacy explicit `--model`: the operator's own
 *                                      selector, honoured in `auto` only — it cannot
 *                                      stand in for a class a human was asked to choose
 * @param {string} [options.capability] the class: one of MODEL_CAPABILITIES. The
 *                                      orchestrator's assessment in `auto`, the
 *                                      operator's choice in `manual`
 * @param {object} [options.models]     `dispatch.models`: class -> OMP role alias
 * @param {object} [options.floors]     `dispatch.modelFloors`: ticket label -> class
 * @param {string[]} [options.labels]   the ticket's labels
 * @param {string} [options.because]    the assessment's reason, appended to `reason`
 * @param {string} [options.mode]       one of MODEL_MODES; absent is `auto`
 * @param {{capability: string, reference: string}} [options.approval]
 *                                      the VERIFIED answer to this request's ask
 *                                      question. `ask` with none is the preliminary
 *                                      decision — it carries the menu and is `pending`
 * @returns {{version: 1, policyHash: string, mode: string, requestedCapability: string|null,
 *            capability: string, selector: string, source: string, floorLabels: string[],
 *            reason: string, classes: string[], recommended: string|null,
 *            confirmation: string|null, pending?: true}}
 * @throws {Error} every refusal above; dispatch catches and declines before mutating
 */
export function modelPolicy({
  model = '',
  capability = '',
  models = {},
  floors = {},
  labels = [],
  because = '',
  mode,
  approval = null,
} = {}) {
  const named = String(model ?? '').trim();
  const assessment = String(capability ?? '').trim();
  const asked = mode === undefined || mode === null ? '' : String(mode).trim();
  if (asked !== '' && !MODEL_MODES.includes(asked)) {
    throw new Error(`--model-mode expects ${MODEL_MODES.join(', ')}, not "${asked}"`);
  }
  if (assessment !== '' && !MODEL_CAPABILITIES.includes(assessment)) {
    throw new Error(`--capability expects ${MODEL_CAPABILITIES.join(', ')}, not "${assessment}"`);
  }
  const resolvedMode = asked === '' ? 'auto' : asked;
  const classes = configuredClasses(models);
  const opensRoles = classes.length > 0;

  // A LEGACY OVERRIDE CANNOT ANSWER A QUESTION ADDRESSED TO A HUMAN. `--model`
  // still exists for the consumers that pin one, and in `auto` it is exactly
  // what it always was. In `manual` and `ask` the class is somebody's decision
  // on purpose, and honouring a selector there would spend a mode whose whole
  // point is that a human chose — silently, and with the mode still recorded.
  if (named !== '' && resolvedMode !== 'auto') {
    throw new Error(
      `--model is the legacy explicit override and is only honoured in auto mode; ${resolvedMode} mode routes the class ${resolvedMode === 'ask' ? 'a human picks in the ask dialog' : 'the operator named'}, so drop one of the two`,
    );
  }

  // The modes that decide FROM configured classes need some to decide from.
  if (!opensRoles && resolvedMode !== 'auto') {
    throw new Error(
      `dispatch.models configures no worker roles, so there is no class for ${resolvedMode} mode to ${resolvedMode === 'ask' ? 'offer' : 'route'}; configure routine, standard or deep first`,
    );
  }

  const approved = approval === null || approval === undefined ? null : approval;
  if (approved !== null) {
    if (resolvedMode !== 'ask') {
      throw new Error('an approved class is the answer to an ask question; it cannot be applied in another mode');
    }
    const chosen = String(approved.capability ?? '').trim();
    if (!classes.includes(chosen)) {
      throw new Error(`the approved class ${chosen === '' ? '<empty>' : chosen} is not one this project configures (${classes.join(', ')})`);
    }
  }
  if (resolvedMode === 'manual' && assessment === '') {
    throw new Error('--model-mode manual routes the class the operator named; pass --capability routine, standard or deep with the --because they gave');
  }

  // WHO CHOSE decides whether a label floor applies. A floor RAISES AN
  // ASSESSMENT: it never overrides a class a human named, in prose (`manual`) or
  // in the dialog (`ask`) — that would spend the operator's decision on a class
  // they did not pick, which is the one thing both modes exist to prevent — and
  // it never overrides a selector the operator named with `--model`.
  //
  // AN UNASSESSED DISPATCH HAS NOTHING TO RAISE. `standard` is already the
  // conservative answer to "nobody classified this", and letting a label push it
  // to `deep` would report a class as assessed on the strength of a label the
  // orchestrator never weighed. A project that wants a label to decide states
  // the assessment.
  const operatorChose = resolvedMode === 'manual' || approved !== null;
  const assessed = (approved === null ? assessment : approved.capability) || DEFAULT_CAPABILITY;
  const floorable = named === '' && !operatorChose && assessment !== '' ? labels : [];
  const { capability: cls, floorLabels } = raise(assessed, floors, floorable);

  const tail = String(because ?? '').trim() === '' ? '' : ` — ${because}`;
  let source = 'default';
  if (named !== '') source = 'explicit';
  else if (approved !== null) source = 'approved';
  else if (resolvedMode === 'manual') source = 'manual';
  else if (floorLabels.length > 0) source = 'floor';
  else if (assessment !== '') source = 'capability';
  const why = {
    explicit: 'explicit model',
    approved: `operator chose ${cls} in this session\u2019s ask`,
    manual: `operator named ${cls}`,
    floor: `risk floor: ${floorLabels.join(', ')}`,
    capability: `orchestrator capability: ${cls}`,
    default: opensRoles ? `unclassified: conservative ${DEFAULT_CAPABILITY} route` : 'unclassified: preserving @default',
  }[source];

  // THE OPT-OUT, and the only place `@default` is still an answer: a project
  // that configured no roles at all keeps the model it had before any routing
  // existed. A project that configured SOME and not this class is a
  // configuration gap, and is named rather than silently downgraded.
  const pending = resolvedMode === 'ask' && approved === null;
  let selector;
  if (pending) selector = '';
  else if (named !== '') selector = named;
  else if (!opensRoles) selector = '@default';
  else {
    selector = String(models[cls] ?? '').trim();
    if (selector === '') {
      throw new Error(
        `dispatch.models declares no ${cls} role${floorLabels.length > 0 ? ` (raised by ${floorLabels.join(', ')})` : ''}; configure it, assess another class, or name a --model`,
      );
    }
  }

  // THE RECOMMENDATION, computed the same way the assessment would have been:
  // it is what `auto` would have routed, which is the only honest thing to put
  // in front of a human. Kept on the answered decision too, so the record shows
  // what was recommended beside what was chosen.
  const suggested = raise(assessment || DEFAULT_CAPABILITY, floors, assessment === '' ? [] : labels).capability;
  const recommended = resolvedMode === 'ask' && classes.includes(suggested) ? suggested : null;
  const decision = {
    version: 1,
    policyHash: configHash(models, floors),
    mode: resolvedMode,
    requestedCapability: assessment || null,
    capability: cls,
    selector,
    source,
    floorLabels,
    reason: `${why}${tail}`,
    classes,
    recommended,
    confirmation: approved === null ? null : String(approved.reference ?? '').trim() || null,
  };
  // PENDING IS NOT A DECISION. An `ask` dispatch with no verified answer has a
  // menu and a recommendation and nothing else; the caller prints the question
  // and stops. Marked on the object so a placement path cannot mistake the
  // recommendation for a choice, and absent from everything else so a recorded
  // decision never carries it.
  return resolvedMode === 'ask' && approved === null ? { ...decision, pending: true } : decision;
}

/**
 * `ax-model:<request>:<decision hash>` — the stable id of the ask question this
 * decision would pose.
 *
 * The hash covers the MENU and the configuration behind it (`policyHash` is the
 * roles and the floors), so retuning `dispatch.models.deep` from one role to
 * another invalidates an approval collected for the old configuration: the
 * human approved a class in a project that routed it somewhere specific.
 *
 * @param {string} request
 * @param {object} policy an `ask` policy with configured classes
 * @returns {string}
 * @throws {Error} with no request, or nothing to ask about
 */
export function confirmationQuestionId(request, policy) {
  const id = String(request ?? '').trim();
  if (id === '') throw new Error('a confirmation question needs the request id it is asked about');
  if (policy?.mode !== 'ask' || !Array.isArray(policy.classes) || policy.classes.length === 0) {
    throw new Error('a confirmation question needs an ask-mode policy over this project\u2019s configured classes');
  }
  const decision = JSON.stringify({
    mode: policy.mode,
    classes: policy.classes,
    recommended: policy.recommended,
    policyHash: policy.policyHash,
  });
  return `ax-model:${id}:${createHash('sha256').update(decision).digest('hex').slice(0, 16)}`;
}

/**
 * One entry of the native `ask` tool's `questions` array — and nothing else;
 * that tool is strict, so an extra field is a rejected call.
 *
 * Every option LABEL is a CLASS, because the transcript records labels and only
 * labels, and a class is the only thing this dispatch decides. No model, no
 * effort, no account and no quota appears here: those are the gateway's, and
 * offering them would ask a human to ratify a decision AX is not making. Prose
 * goes in `description`. The last option declines, since a question with no way
 * to decline is a rubber stamp.
 *
 * @param {string} request
 * @param {object} policy an `ask` policy with configured classes
 * @returns {{id: string, question: string, header: string, multi: false, recommended: number, options: {label: string, description: string}[]}}
 */
export function modelConfirmationQuestion(request, policy) {
  const id = confirmationQuestionId(request, policy);
  const recommended = policy.classes.indexOf(policy.recommended);
  const options = policy.classes.map(cls => ({
    label: cls,
    description: `${CLASS_DESCRIPTION[cls]}${cls === policy.recommended ? ` — recommended: ${policy.reason}` : ''}`,
  }));
  options.push({ label: DEFER_LABEL, description: 'do not dispatch; no class is chosen and nothing is placed' });
  return {
    id,
    header: `worker class for ${String(request).trim()}`,
    question: `Which class should ${String(request).trim()} be dispatched as? ${policy.recommended === null ? 'The assessed class is not configured; choose an available class or defer.' : `Recommended ${policy.recommended} (${policy.source}).`}`,
    multi: false,
    ...(recommended < 0 ? {} : { recommended }),
    options,
  };
}
