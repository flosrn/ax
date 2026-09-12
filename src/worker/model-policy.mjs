// WHICH OMP selectors a worker dispatch may run on, and in which order.
//
// Pure: the orchestrator's assessment, the project's configured roles, and the
// candidate list a real probe produced on the target. No I/O, and no provider
// named here.
//
// v1 is a project that configured no worker roles and stated no mode:
// `@default`, no candidates, no target check — byte-identical to what dispatch
// recorded before this routing existed. v2 is everything else, and carries the
// mode, the requested alias, the ordered available candidates and the effort.
//
// FAIL-CLOSED. A tier with no configured role, a model or effort no candidate
// offers, and a probe that found nothing available all THROW. Falling back to
// `@default` would answer "the target cannot serve this" with a silent
// downgrade onto a model nobody chose, and an unsupported effort is the probe's
// refusal, never something to round down.

import { createHash } from 'node:crypto';

// One spelling of the decline option, shared with the reader that verifies it:
// two would turn a deliberate defer into a forged-answer refusal. One-way
// import; that module takes nothing from here.
import { DEFER_LABEL } from './model-confirmation.mjs';

/** Tier ids, cheapest first. Index order IS the floor comparison. */
export const MODEL_CAPABILITIES = ['efficient', 'balanced', 'intensive'];

export const MODEL_MODES = ['auto', 'pinned', 'confirm'];

/** OMP's own thinking levels — the only suffixes a selector may carry. */
export const MODEL_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// The probe wire. It lives here because this is the only module BOTH sides
// import: the dispatcher's ./model-probe.mjs (which re-exports these for its
// own callers) and the target extension omp/model/probe.ts, which already
// reaches this file for the selector vocabulary.

/** The env key the request travels in. Never argv: argv in print mode is the prompt. */
export const SELECTORS_ENV = 'AX_MODEL_SELECTORS';

/** The prefix of the one line the probe prints, and the only line anyone reads. */
export const PROBE_PREFIX = 'AX_MODEL_PROBE=';

/**
 * Split `provider/id:effort`. Strict on the suffix: only a real thinking level
 * is an effort, so `vendor/id:latest` keeps its tag rather than being
 * truncated into a different model, and `@alias` yields a null effort.
 *
 * @param {string} value
 * @returns {{ model: string, effort: string | null }}
 */
export function splitSelector(value) {
  const spec = String(value ?? '').trim();
  const cut = spec.lastIndexOf(':');
  if (cut <= 0) return { model: spec, effort: null };
  const tail = spec.slice(cut + 1).toLowerCase();
  return MODEL_EFFORTS.includes(tail) ? { model: spec.slice(0, cut), effort: tail } : { model: spec, effort: null };
}

const configHash = (version, models, floors) =>
  createHash('sha256').update(JSON.stringify({ version, models, floors })).digest('hex');

/** Opted in to worker roles? One non-empty role is enough. */
const declaresRoles = models =>
  models !== null && typeof models === 'object' && Object.values(models).some(v => String(v ?? '').trim() !== '');

/** Raise the assessed tier to the highest floor its labels demand, and name them. */
function raise(assessed, floors, labels) {
  let tier = assessed;
  const floorLabels = [];
  for (const label of labels ?? []) {
    const floor = Object.hasOwn(floors ?? {}, label) ? floors[label] : undefined;
    if (MODEL_CAPABILITIES.indexOf(floor) > MODEL_CAPABILITIES.indexOf(tier)) {
      tier = floor;
      floorLabels.length = 0;
      floorLabels.push(label);
    } else if (floor === tier && tier !== assessed) {
      floorLabels.push(label);
    }
  }
  return { tier, floorLabels };
}

/**
 * One probe entry, canonicalized. The probe is the authority on effort, so a
 * missing or unknown one is ITS error — clamping would invent the decision the
 * operator spelled out. A `selector` disagreeing with its own model/effort is a
 * broken probe, and preferring either half would be a hidden default.
 */
function candidateOf(entry, at, requested) {
  const where = `probe candidate ${at} for ${requested}`;
  if (entry === null || typeof entry !== 'object') throw new Error(`${where} is not an object`);
  const model = String(entry.model ?? '').trim();
  const effort = String(entry.effort ?? '').trim().toLowerCase();
  const selector = String(entry.selector ?? '').trim();
  if (model === '') throw new Error(`${where} named no model`);
  if (effort === '') throw new Error(`${where} (${model}) reported no effort; the probe must report one, it is not defaulted here`);
  if (!MODEL_EFFORTS.includes(effort)) {
    throw new Error(`${where} (${model}) reported effort "${effort}", which is not one of ${MODEL_EFFORTS.join(', ')}; unsupported effort is refused, never clamped`);
  }
  if (selector !== '' && selector !== `${model}:${effort}`) {
    throw new Error(`${where} disagrees with itself: selector "${selector}" is not "${model}:${effort}"`);
  }
  return { selector: `${model}:${effort}`, model, effort, available: entry.available === true, reason: String(entry.reason ?? '').trim() };
}

/**
 * The probed candidates an explicit `--model` allows.
 *
 * An ALIAS is what the probe was asked to expand, so everything it returned is
 * this request — the alias itself is never compared to a concrete model id
 * (that mismatch refused every `--model @alias` dispatch). A concrete id is
 * matched by model, and its effort is derived from the candidate that covers it
 * when the operator wrote none. Either way an explicit effort selects, never
 * rounds.
 */
function allowedBy(wanted, probed) {
  const { model: bare, effort } = splitSelector(wanted);
  const offered = () => probed.map(c => c.selector).join(', ');
  if (bare.startsWith('@')) {
    if (effort === null) return probed;
    const atEffort = probed.filter(c => c.effort === effort);
    if (atEffort.length === 0) {
      throw new Error(`${wanted}: the probe expanded ${bare} to ${offered()}, none at effort ${effort}; effort is never clamped`);
    }
    return atEffort;
  }
  const sameModel = probed.filter(c => c.model === bare);
  if (sameModel.length === 0) {
    throw new Error(`${wanted} is not among the candidates configured for this worker (${offered()}); a model outside the configured set has no effort to derive`);
  }
  if (effort === null) return sameModel;
  const exact = sameModel.filter(c => c.effort === effort);
  if (exact.length === 0) {
    throw new Error(`${wanted} is not among the candidates configured for this worker; ${bare} is configured at ${sameModel.map(c => c.effort).join(', ')} and effort is never clamped`);
  }
  return exact;
}

/**
 * ONE APPROVED EFFORT PER MODEL on a route that will actually be placed.
 *
 * The runtime enforces the route through a fallback map keyed by model identity
 * (omp/model/routing.ts), so one model at two efforts is an ambiguous approval
 * and is refused there. Refusing it here names the configuration that caused it
 * instead of failing after the probe. `confirm` is exempt: its menu may offer
 * both, and the operator's answer collapses it to one candidate before
 * anything is placed.
 */
function oneEffortPerModel(chosen, requested) {
  const efforts = new Map();
  for (const candidate of chosen) {
    const seen = efforts.get(candidate.model);
    if (seen !== undefined && seen !== candidate.effort) {
      throw new Error(
        `${requested} offers ${candidate.model} at both ${seen} and ${candidate.effort}; a placed route approves one effort per model, so configure one of them — or use --model-mode confirm to choose between them`,
      );
    }
    efforts.set(candidate.model, candidate.effort);
  }
}

/**
 * Decide a worker's model.
 *
 * @param {object} [options]
 * @param {string} [options.model]      explicit `--model`, alias or concrete; implies `pinned` unless `confirm`
 * @param {string} [options.capability] assessment: one of MODEL_CAPABILITIES
 * @param {object} [options.models]     `dispatch.models`: tier -> OMP role alias
 * @param {object} [options.floors]     `dispatch.modelFloors`: ticket label -> tier
 * @param {string[]} [options.labels]   the ticket's labels
 * @param {string} [options.because]    assessment note, appended to `reason`
 * @param {string} [options.mode]       one of MODEL_MODES. Pass `undefined` when neither config
 *                                      nor flag decided one: that is the only v1 door
 * @param {Array<{selector?: string, model: string, effort: string, available?: boolean, reason?: string}>} [options.candidates]
 *                                      probe output. Omitted = not probed yet (`candidates: []`);
 *                                      supplied and empty, or all unavailable, throws
 * @param {string} [options.confirmation] approval reference the caller verified; recorded, not interpreted
 * @returns {object} v1 `{version:1, policyHash, requestedCapability, capability, selector, source, floorLabels, reason}`;
 *                   v2 adds `mode`, `requestedSelector`, `candidates`, `effort`, `confirmation`
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
  candidates,
  confirmation = '',
} = {}) {
  const wanted = String(model ?? '').trim();
  const assessment = String(capability ?? '').trim();
  const asked = mode === undefined || mode === null ? '' : String(mode).trim();
  if (asked !== '' && !MODEL_MODES.includes(asked)) {
    throw new Error(`--model-mode expects ${MODEL_MODES.join(', ')}, not "${asked}"`);
  }
  if (assessment !== '' && !MODEL_CAPABILITIES.includes(assessment)) {
    throw new Error(`--capability expects ${MODEL_CAPABILITIES.join(', ')}, not "${assessment}"`);
  }

  const tail = String(because ?? '').trim() === '' ? '' : ` — ${because}`;
  const named = wanted !== '';
  const sourceOf = floorLabels => (named ? 'explicit' : floorLabels.length > 0 ? 'floor' : assessment !== '' ? 'capability' : 'default');

  // v1: no configured roles AND no stated mode. A stated mode is an opt-in to
  // the strict path even with nothing configured — `--model-mode pinned` must
  // not read as "v1, unrestricted", which is the opposite of pinning.
  if (!declaresRoles(models) && asked === '') {
    if (candidates !== undefined) {
      throw new Error('candidates were probed but no worker roles or model mode were declared; the v1 path routes to @default and probes nothing');
    }
    const { tier, floorLabels } = raise(assessment || 'balanced', floors, named || assessment === '' ? [] : labels);
    const reason = named
      ? 'explicit model'
      : floorLabels.length > 0
        ? `risk floor: ${floorLabels.join(', ')}`
        : assessment !== ''
          ? `orchestrator capability: ${assessment}`
          : 'unclassified: preserving @default';
    return {
      version: 1,
      policyHash: configHash(1, models, floors),
      requestedCapability: assessment || null,
      capability: tier,
      selector: named ? wanted : '@default',
      source: sourceOf(floorLabels),
      floorLabels,
      reason: `${reason}${tail}`,
    };
  }

  // v2. A named model IS a pin: `auto` over it would authorize a candidate the
  // operator did not name. Only `confirm` survives, and an omitted mode is not
  // distinguished from a stated `auto` here — the model was named either way.
  const resolvedMode = named && asked !== 'confirm' ? 'pinned' : asked === '' ? 'auto' : asked;
  if (resolvedMode === 'pinned' && !named && assessment === '') {
    throw new Error('--model-mode pinned needs --model or an explicit --capability tier; there is nothing to pin to');
  }

  // FLOORS RAISE A RECOMMENDATION, NEVER A PIN. `--model-mode pinned` with an
  // explicit tier is the operator overriding the routing on purpose; letting a
  // ticket label push that to a higher tier would spend the operator's pin on a
  // model they declined. `auto` and `confirm` are recommendations, so a label
  // floor still raises those (and no assessment means the labels of an implied
  // balanced apply exactly as a stated one's).
  const pinnedTier = resolvedMode === 'pinned' && !named;
  const { tier, floorLabels } = raise(assessment || 'balanced', floors, named || pinnedTier ? [] : labels);

  let requestedSelector = wanted;
  if (!named) {
    requestedSelector = String(models[tier] ?? '').trim();
    if (requestedSelector === '') {
      throw new Error(`dispatch.models declares no ${tier} role${floorLabels.length > 0 ? ` (raised by ${floorLabels.join(', ')})` : ''}; configure it or name a --model`);
    }
  }

  const base = {
    version: 2,
    policyHash: configHash(2, models, floors),
    requestedCapability: assessment || null,
    capability: tier,
    mode: resolvedMode,
    requestedSelector,
    source: sourceOf(floorLabels),
    floorLabels,
    reason: `${
      named
        ? 'explicit model'
        : floorLabels.length > 0
          ? `risk floor: ${floorLabels.join(', ')}`
          : assessment !== ''
            ? `orchestrator capability: ${assessment}`
            : 'unclassified: configured balanced route'
    }${tail}`,
    confirmation: String(confirmation ?? '').trim() || null,
  };

  // Dispatch calls this twice: once to learn WHICH selector to probe, then
  // again with what the probe observed. An omitted list is that first call. A
  // supplied empty one is the probe having found nothing, which throws.
  if (candidates === undefined) {
    return { ...base, selector: requestedSelector, candidates: [], effort: splitSelector(requestedSelector).effort };
  }
  if (!Array.isArray(candidates)) throw new Error('candidates must be the array the target probe produced');
  if (candidates.length === 0) {
    throw new Error(`the target probe returned no candidate for ${requestedSelector}; nothing may be dispatched on an empty candidate list`);
  }

  const probed = candidates.map((entry, at) => candidateOf(entry, at, requestedSelector));
  const scoped = named ? allowedBy(wanted, probed) : probed;
  const available = scoped.filter(c => c.available);
  if (available.length === 0) {
    throw new Error(`no available candidate for ${requestedSelector}: ${scoped.map(c => `${c.selector}${c.reason === '' ? '' : ` — ${c.reason}`}`).join('; ')}`);
  }
  // Pinning a model holds the worker to ONE selector. A tier route keeps the
  // whole configured order, and `confirm` keeps the menu it will ask about.
  const chosen = resolvedMode === 'pinned' && named ? available.slice(0, 1) : available;
  if (resolvedMode !== 'confirm') oneEffortPerModel(chosen, requestedSelector);

  return { ...base, selector: chosen[0].selector, candidates: chosen.map(c => c.selector), effort: chosen[0].effort };
}

/**
 * `ax-model:<request>:<decision hash>` — the stable id of the confirmation
 * question this decision would ask. The hash covers the candidate selectors,
 * which carry effort, so retuning a candidate from `:medium` to `:high`
 * invalidates an approval collected for the old menu: the operator approved a
 * model AND an effort, not a request id.
 *
 * @param {string} request
 * @param {object} policy v2 policy with probed candidates
 * @returns {string}
 * @throws {Error} with no request, or nothing probed to confirm
 */
export function confirmationQuestionId(request, policy) {
  const id = String(request ?? '').trim();
  if (id === '') throw new Error('a confirmation question needs the request id it is asked about');
  if (policy?.version !== 2 || !Array.isArray(policy.candidates) || policy.candidates.length === 0) {
    throw new Error('a confirmation question needs a v2 policy whose candidates were probed on the target');
  }
  const decision = JSON.stringify({
    mode: policy.mode,
    capability: policy.capability,
    source: policy.source,
    requestedSelector: policy.requestedSelector,
    selector: policy.selector,
    effort: policy.effort,
    candidates: policy.candidates,
    policyHash: policy.policyHash,
  });
  return `ax-model:${id}:${createHash('sha256').update(decision).digest('hex').slice(0, 16)}`;
}

/**
 * One entry of the native `ask` tool's `questions` array — and nothing else;
 * that tool is strict, so an extra field is a rejected call.
 *
 * Every option LABEL is an exact candidate selector, because the transcript
 * records labels and only labels; prose goes in `description`. The last option
 * declines, since a question with no way to decline is a rubber stamp.
 * Alternative TIERS are absent on purpose: they are a different probe, so
 * choosing one needs a fresh dry-run and a fresh ask.
 *
 * @param {string} request
 * @param {object} policy v2 policy with probed candidates
 * @returns {{id: string, question: string, header: string, multi: false, recommended: number, options: {label: string, description: string}[]}}
 */
export function modelConfirmationQuestion(request, policy) {
  const id = confirmationQuestionId(request, policy);
  const options = policy.candidates.map((selector, at) => ({
    label: selector,
    description: at === 0 ? `first available candidate — ${policy.reason}` : 'configured alternative, available on the target',
  }));
  options.push({ label: DEFER_LABEL, description: 'do not dispatch; no model is chosen and nothing is placed' });
  return {
    id,
    header: `worker ${policy.capability}`,
    question: `Dispatch ${String(request).trim()} on ${policy.selector}? Requested ${policy.requestedSelector} (${policy.capability}, ${policy.source}).`,
    multi: false,
    recommended: 0,
    options,
  };
}
