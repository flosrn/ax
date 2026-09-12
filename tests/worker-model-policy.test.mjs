// What a worker is allowed to run on, one proposition per rule.
//
// The policy is pure, so every test here is the real function against real
// inputs — no temp repo, no probe subprocess, no host. The probe's OUTPUT is
// what this module consumes, and that is supplied directly: the shape
// `{selector, model, effort, available, reason?}` is the contract between this
// file and the target extension, and it is exercised verbatim.
//
// The two properties worth the most here are negative. A candidate list that
// found nothing available must THROW rather than route to `@default` — a silent
// downgrade would put a worker on a model nobody chose, under a green suite.
// And an unsupported effort must be refused rather than clamped, because
// clamping invents the one decision the operator spelled out.
//
// The model ids below are invented strings (`vendor-a/…`). Naming a real
// provider here would smuggle a provider dependency into a module whose whole
// point is that it has none.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFER_LABEL } from '../src/worker/model-confirmation.mjs';
import {
  MODEL_CAPABILITIES,
  MODEL_MODES,
  confirmationQuestionId,
  modelConfirmationQuestion,
  modelPolicy,
  splitSelector,
} from '../src/worker/model-policy.mjs';

/** A project that opted in: three tier roles, one label floor. */
const MODELS = {
  efficient: '@worker-efficient',
  balanced: '@worker-balanced',
  intensive: '@worker-intensive',
};
const FLOORS = { 'domain:security': 'intensive' };

/** One probe entry. `available` defaults to true; the selector is canonical. */
const found = (model, effort, extra = {}) => ({
  selector: `${model}:${effort}`,
  model,
  effort,
  available: true,
  ...extra,
});

const BALANCED_PROBE = [
  found('vendor-a/mid', 'medium'),
  found('vendor-b/mid', 'high'),
];

/**
 * The refusal a call threw, for the tests that assert what it SAYS.
 * `assert.throws` returns undefined, so a message assertion needs the error
 * itself — and an operator who is told "no" without being told which candidate
 * failed and why has to go read the probe by hand.
 */
const refusal = call => {
  try {
    call();
  } catch (error) {
    return error;
  }
  return assert.fail('expected a refusal, got a policy');
};

// ── the two policies ─────────────────────────────────────────────────────────

test('a project that configured no worker roles keeps the old decision, with no routing on it', () => {
  const policy = modelPolicy({ models: {}, floors: {} });

  assert.equal(policy.version, 1);
  assert.equal(policy.selector, '@default');
  assert.equal(policy.source, 'default');
  assert.match(policy.reason, /preserving @default/);
  // The v2 fields are ABSENT, not null: a record written before this routing
  // existed reads back identically, and the transport has nothing to attach.
  for (const field of ['mode', 'requestedSelector', 'candidates', 'effort']) {
    assert.equal(Object.hasOwn(policy, field), false, field);
  }
});

test('an unconfigured project still honours an explicit model, and still records no candidates', () => {
  const policy = modelPolicy({ model: 'vendor-a/mid:medium', models: {} });

  assert.equal(policy.version, 1);
  assert.equal(policy.selector, 'vendor-a/mid:medium');
  assert.equal(policy.source, 'explicit');
  assert.equal(Object.hasOwn(policy, 'candidates'), false);
});

test('a stated mode opts an unconfigured project INTO the strict path, model and all', () => {
  // `--model-mode pinned` reading as "v1, unrestricted" would be the opposite
  // of pinning: the flag would weaken the very guarantee it asks for.
  const pinned = modelPolicy({ models: {}, mode: 'pinned', model: 'vendor-a/mid:medium' });

  assert.equal(pinned.version, 2);
  assert.equal(pinned.mode, 'pinned');
  assert.equal(pinned.requestedSelector, 'vendor-a/mid:medium');
  assert.deepEqual(pinned.candidates, []);

  const probed = modelPolicy({
    models: {},
    mode: 'pinned',
    model: 'vendor-a/mid:medium',
    candidates: BALANCED_PROBE,
  });

  assert.deepEqual(probed.candidates, ['vendor-a/mid:medium']);
  assert.equal(probed.effort, 'medium');
});

test('an unconfigured project cannot route a tier it never configured, whatever the mode', () => {
  assert.throws(() => modelPolicy({ models: {}, mode: 'confirm' }), /declares no balanced role/);
  assert.throws(() => modelPolicy({ models: {}, mode: 'pinned' }), /nothing to pin to/);
  assert.throws(() => modelPolicy({ models: {}, candidates: BALANCED_PROBE }), /probes nothing/);
});

test('a configured project with no assessment routes to its balanced role rather than @default', () => {
  const policy = modelPolicy({ models: MODELS, floors: FLOORS });

  assert.equal(policy.version, 2);
  assert.equal(policy.requestedSelector, '@worker-balanced');
  assert.equal(policy.selector, '@worker-balanced');
  assert.equal(policy.capability, 'balanced');
  assert.equal(policy.requestedCapability, null);
  assert.equal(policy.source, 'default');
  assert.equal(policy.mode, 'auto');
  // Pre-probe: dispatch asks for the selector first, probes it, then asks again.
  assert.deepEqual(policy.candidates, []);
  assert.equal(policy.effort, null);
});

test('a preliminary decision carries the effort an alias spells out', () => {
  const policy = modelPolicy({ models: { balanced: '@worker-balanced:high' } });

  assert.equal(policy.selector, '@worker-balanced:high');
  assert.equal(policy.effort, 'high');
});

// ── what the probe decides ───────────────────────────────────────────────────

test('the chosen candidate carries the effort the probe reported, not one derived here', () => {
  const policy = modelPolicy({ capability: 'balanced', models: MODELS, candidates: BALANCED_PROBE });

  assert.equal(policy.selector, 'vendor-a/mid:medium');
  assert.equal(policy.effort, 'medium');
  assert.deepEqual(policy.candidates, ['vendor-a/mid:medium', 'vendor-b/mid:high']);
  assert.equal(policy.requestedSelector, '@worker-balanced');
  assert.equal(policy.source, 'capability');
});

test('the probe order is the authority: the same two models reversed change the selector', () => {
  const policy = modelPolicy({
    capability: 'balanced',
    models: MODELS,
    candidates: [...BALANCED_PROBE].reverse(),
  });

  assert.equal(policy.selector, 'vendor-b/mid:high');
  assert.equal(policy.effort, 'high');
});

test('one model at two efforts cannot be PLACED, because the runtime approves one effort per model', () => {
  // omp/model/routing.ts keys the enforcement map by model identity, so two
  // efforts for one model is an ambiguous approval and is refused at
  // enforcement. Refusing it here names the configuration that caused it.
  const twice = [found('vendor-a/mid', 'low'), found('vendor-a/mid', 'high')];
  const boom = refusal(() => modelPolicy({ capability: 'balanced', models: MODELS, candidates: twice }));

  assert.match(boom.message, /vendor-a\/mid at both low and high/);
  assert.match(boom.message, /one effort per model/);
  assert.throws(
    () => modelPolicy({ mode: 'pinned', capability: 'balanced', models: MODELS, candidates: twice }),
    /at both low and high/,
  );

  // `confirm` may OFFER both: the operator's answer collapses the menu to one
  // candidate (dispatch freezes `candidates` to the approved selector) before
  // anything is placed, so the ambiguity never reaches the runtime.
  const menu = modelPolicy({ mode: 'confirm', capability: 'balanced', models: MODELS, candidates: twice });

  assert.deepEqual(menu.candidates, ['vendor-a/mid:low', 'vendor-a/mid:high']);
  assert.equal(menu.effort, 'low');
});

test('an unavailable candidate is dropped, and its reason is not needed to keep going', () => {
  const policy = modelPolicy({
    capability: 'balanced',
    models: MODELS,
    candidates: [
      found('vendor-a/mid', 'medium', { available: false, reason: 'no authenticated account' }),
      found('vendor-b/mid', 'high'),
    ],
  });

  assert.deepEqual(policy.candidates, ['vendor-b/mid:high']);
  assert.equal(policy.selector, 'vendor-b/mid:high');
});

test('nothing available is a refusal, never a quiet fall back to @default', () => {
  const boom = refusal(() => modelPolicy({
    capability: 'balanced',
    models: MODELS,
    candidates: [
      found('vendor-a/mid', 'medium', { available: false, reason: 'quota exhausted' }),
      found('vendor-b/mid', 'high', { available: false, reason: 'not authenticated' }),
    ],
  }));

  assert.match(boom.message, /no available candidate for @worker-balanced/);
  assert.match(boom.message, /quota exhausted/);
  assert.match(boom.message, /not authenticated/);
  assert.doesNotMatch(boom.message, /@default/);
});

test('a probe that returned an empty list dispatches nothing', () => {
  assert.throws(
    () => modelPolicy({ capability: 'balanced', models: MODELS, candidates: [] }),
    /returned no candidate/,
  );
});

test('a probe entry with no effort, or an unknown one, is the probe error it is', () => {
  assert.throws(
    () => modelPolicy({ models: MODELS, candidates: [{ model: 'vendor-a/mid', selector: 'vendor-a/mid' }] }),
    /reported no effort/,
  );
  const boom = refusal(() => modelPolicy({ models: MODELS, candidates: [{ model: 'vendor-a/mid', effort: 'ultra' }] }));
  assert.match(boom.message, /effort "ultra"/);
  assert.match(boom.message, /never clamped/);
});

test('a probe entry whose selector contradicts its own model and effort is refused', () => {
  assert.throws(
    () => modelPolicy({
      models: MODELS,
      candidates: [{ selector: 'vendor-a/mid:high', model: 'vendor-a/mid', effort: 'low', available: true }],
    }),
    /disagrees with itself/,
  );
});

// ── tiers, floors and refusals ───────────────────────────────────────────────

test('a label floor raises the assessed tier and names the label that did it', () => {
  const policy = modelPolicy({
    capability: 'efficient',
    models: MODELS,
    floors: FLOORS,
    labels: ['area:api', 'domain:security'],
    candidates: [found('vendor-c/big', 'xhigh')],
  });

  assert.equal(policy.capability, 'intensive');
  assert.equal(policy.requestedCapability, 'efficient');
  assert.equal(policy.requestedSelector, '@worker-intensive');
  assert.deepEqual(policy.floorLabels, ['domain:security']);
  assert.equal(policy.source, 'floor');
  assert.match(policy.reason, /risk floor: domain:security/);
});

test('a floor raises an unstated assessment too — the implied balanced is still automatic', () => {
  const policy = modelPolicy({
    models: MODELS,
    floors: FLOORS,
    labels: ['domain:security'],
    candidates: [found('vendor-c/big', 'xhigh')],
  });

  assert.equal(policy.capability, 'intensive');
  assert.equal(policy.requestedSelector, '@worker-intensive');
});

test('an explicit model outranks a floor', () => {
  const policy = modelPolicy({
    model: 'vendor-a/mid:medium',
    models: MODELS,
    floors: FLOORS,
    labels: ['domain:security'],
    candidates: BALANCED_PROBE,
  });

  assert.deepEqual(policy.floorLabels, []);
  assert.equal(policy.source, 'explicit');
  assert.equal(policy.selector, 'vendor-a/mid:medium');
});

test('a tier with no configured role is a configuration refusal, not a downgrade', () => {
  const boom = refusal(() => modelPolicy({
    models: { balanced: '@worker-balanced' },
    floors: FLOORS,
    labels: ['domain:security'],
  }));

  assert.match(boom.message, /declares no intensive role/);
  assert.match(boom.message, /domain:security/);
});

test('an unsupported tier or mode is refused by name', () => {
  assert.throws(() => modelPolicy({ capability: 'deep', models: MODELS }), /--capability expects/);
  assert.throws(() => modelPolicy({ mode: 'ask', models: MODELS }), /--model-mode expects/);
});

// ── modes ────────────────────────────────────────────────────────────────────

test('an explicit model implies pinned when the caller named no mode', () => {
  const policy = modelPolicy({ model: 'vendor-a/mid:medium', models: MODELS, candidates: BALANCED_PROBE });

  assert.equal(policy.mode, 'pinned');
  // Pinned to one exact selector: the sibling the probe also found is NOT a
  // place this worker may land, so it is not in the list the runtime enforces.
  assert.deepEqual(policy.candidates, ['vendor-a/mid:medium']);
  assert.equal(policy.effort, 'medium');
});

test('a stated auto does not unpin a named model — only confirm survives it', () => {
  // The CLI may well pass its own `auto` default alongside `--model`. If that
  // read as "route freely", naming a model would silently authorize the OTHER
  // probed candidate, and the runtime would enforce a set the operator never
  // approved.
  const pinned = modelPolicy({ mode: 'auto', model: 'vendor-a/mid:medium', models: MODELS, candidates: BALANCED_PROBE });

  assert.equal(pinned.mode, 'pinned');
  assert.deepEqual(pinned.candidates, ['vendor-a/mid:medium']);

  const confirmed = modelPolicy({ mode: 'confirm', model: 'vendor-a/mid:medium', models: MODELS, candidates: BALANCED_PROBE });

  assert.equal(confirmed.mode, 'confirm');
  assert.deepEqual(confirmed.candidates, ['vendor-a/mid:medium']);
});

test('a pinned model with no effort suffix derives it from the configured candidate', () => {
  const policy = modelPolicy({
    model: 'vendor-b/mid',
    models: MODELS,
    candidates: BALANCED_PROBE,
  });

  assert.deepEqual(policy.candidates, ['vendor-b/mid:high']);
  assert.equal(policy.effort, 'high');
});

test('an explicit ALIAS is pinned to what the probe expanded it to', () => {
  // The alias is the string the probe was ASKED about, so its candidates are
  // its expansion. Comparing `@sol-5.6` to a concrete `vendor-a/mid` finds no
  // match and refused every `--model @alias` dispatch outright.
  const policy = modelPolicy({ model: '@sol-5.6', models: MODELS, candidates: BALANCED_PROBE });

  assert.equal(policy.mode, 'pinned');
  assert.equal(policy.requestedSelector, '@sol-5.6');
  assert.deepEqual(policy.candidates, ['vendor-a/mid:medium']);
  assert.equal(policy.effort, 'medium');
});

test('an alias skips past an unavailable expansion instead of refusing', () => {
  const policy = modelPolicy({
    model: '@sol-5.6',
    models: MODELS,
    candidates: [found('vendor-a/mid', 'medium', { available: false, reason: 'quota exhausted' }), found('vendor-b/mid', 'high')],
  });

  assert.deepEqual(policy.candidates, ['vendor-b/mid:high']);
});

test('an alias with an effort suffix selects that effort among its expansion', () => {
  const policy = modelPolicy({ model: '@sol-5.6:high', models: MODELS, candidates: BALANCED_PROBE });

  assert.deepEqual(policy.candidates, ['vendor-b/mid:high']);

  const boom = refusal(() => modelPolicy({ model: '@sol-5.6:max', models: MODELS, candidates: BALANCED_PROBE }));

  assert.match(boom.message, /none at effort max/);
  assert.match(boom.message, /never clamped/);
});

test('confirm over an alias offers its whole available expansion', () => {
  const policy = modelPolicy({ mode: 'confirm', model: '@sol-5.6', models: MODELS, candidates: BALANCED_PROBE });

  assert.equal(policy.mode, 'confirm');
  assert.deepEqual(policy.candidates, ['vendor-a/mid:medium', 'vendor-b/mid:high']);
});

test('a model outside the configured candidates has no effort to derive and is refused', () => {
  const boom = refusal(() => modelPolicy({ model: 'vendor-z/unknown', models: MODELS, candidates: BALANCED_PROBE }));

  assert.match(boom.message, /is not among the candidates configured/);
  assert.match(boom.message, /no effort to derive/);
});

test('an explicit effort the configured candidates do not offer is refused, not rounded', () => {
  const boom = refusal(() => modelPolicy({ model: 'vendor-a/mid:max', models: MODELS, candidates: BALANCED_PROBE }));

  assert.match(boom.message, /configured at medium/);
  assert.match(boom.message, /never clamped/);
});

test('pinned with neither a model nor a stated tier has nothing to pin to', () => {
  assert.throws(() => modelPolicy({ mode: 'pinned', models: MODELS }), /nothing to pin to/);
});

test('pinned to a tier keeps every candidate that tier offers', () => {
  const policy = modelPolicy({
    mode: 'pinned',
    capability: 'balanced',
    models: MODELS,
    candidates: BALANCED_PROBE,
  });

  assert.equal(policy.mode, 'pinned');
  assert.deepEqual(policy.candidates, ['vendor-a/mid:medium', 'vendor-b/mid:high']);
});

test('a label floor does not raise a PINNED tier — the operator already decided', () => {
  // A floor is a recommendation about routing this ticket automatically. Letting
  // one push an explicitly pinned tier upward would spend the operator's pin on
  // the model they declined, and the dispatch would land on @worker-intensive
  // after being told to hold at efficient.
  const policy = modelPolicy({
    mode: 'pinned',
    capability: 'efficient',
    models: MODELS,
    floors: FLOORS,
    labels: ['domain:security'],
    candidates: [found('vendor-a/small', 'low')],
  });

  assert.equal(policy.capability, 'efficient');
  assert.equal(policy.requestedSelector, '@worker-efficient');
  assert.deepEqual(policy.floorLabels, []);
  assert.equal(policy.source, 'capability');

  // auto and confirm are recommendations, so the same labels still raise them.
  for (const mode of ['auto', 'confirm']) {
    const raised = modelPolicy({
      mode,
      capability: 'efficient',
      models: MODELS,
      floors: FLOORS,
      labels: ['domain:security'],
      candidates: [found('vendor-c/big', 'xhigh')],
    });

    assert.equal(raised.capability, 'intensive', mode);
    assert.equal(raised.requestedSelector, '@worker-intensive', mode);
    assert.deepEqual(raised.floorLabels, ['domain:security'], mode);
  }
});

test('confirm with a bare model offers that model at every available effort', () => {
  const policy = modelPolicy({
    mode: 'confirm',
    model: 'vendor-a/mid',
    models: MODELS,
    candidates: [found('vendor-a/mid', 'low'), found('vendor-a/mid', 'high'), found('vendor-b/mid', 'high')],
  });

  assert.equal(policy.mode, 'confirm');
  assert.deepEqual(policy.candidates, ['vendor-a/mid:low', 'vendor-a/mid:high']);
});

// ── the confirmation question ────────────────────────────────────────────────

const CONFIRMABLE = () => modelPolicy({
  mode: 'confirm',
  capability: 'balanced',
  models: MODELS,
  candidates: BALANCED_PROBE,
  because: 'a decided surface',
});

test('the question id is stable for one decision and scoped to its request', () => {
  const first = confirmationQuestionId('req-7', CONFIRMABLE());
  const again = confirmationQuestionId('req-7', CONFIRMABLE());

  assert.equal(first, again);
  assert.match(first, /^ax-model:req-7:[0-9a-f]{16}$/);
  assert.notEqual(first, confirmationQuestionId('req-8', CONFIRMABLE()));
});

test('a candidate whose effort changed invalidates the approval collected before it', () => {
  const approved = confirmationQuestionId('req-7', CONFIRMABLE());
  const retuned = confirmationQuestionId('req-7', modelPolicy({
    mode: 'confirm',
    capability: 'balanced',
    models: MODELS,
    // Same model, same order, same availability. Only the effort moved.
    candidates: [found('vendor-a/mid', 'high'), found('vendor-b/mid', 'high')],
    because: 'a decided surface',
  }));

  assert.notEqual(approved, retuned);
});

test('a dropped alternative also invalidates it — the menu is part of the decision', () => {
  const approved = confirmationQuestionId('req-7', CONFIRMABLE());
  const narrowed = confirmationQuestionId('req-7', modelPolicy({
    mode: 'confirm',
    capability: 'balanced',
    models: MODELS,
    candidates: [found('vendor-a/mid', 'medium')],
    because: 'a decided surface',
  }));

  assert.notEqual(approved, narrowed);
});

test('no question is offered for a decision no probe stood behind', () => {
  assert.throws(() => confirmationQuestionId('req-7', modelPolicy({ models: MODELS })), /probed on the target/);
  assert.throws(() => confirmationQuestionId('req-7', modelPolicy({ models: {} })), /v2 policy/);
  assert.throws(() => confirmationQuestionId('', CONFIRMABLE()), /needs the request id/);
});

test('the question is one native ask Question whose labels are the exact selectors', () => {
  const policy = CONFIRMABLE();
  const question = modelConfirmationQuestion('req-7', policy);

  assert.equal(question.id, confirmationQuestionId('req-7', policy));
  assert.equal(question.multi, false);
  assert.equal(question.recommended, 0);
  // Labels and labels only: the transcript records the chosen LABEL, so every
  // candidate must be readable back as a selector, prose kept in `description`.
  assert.deepEqual(
    question.options.map(option => option.label),
    ['vendor-a/mid:medium', 'vendor-b/mid:high', DEFER_LABEL],
  );
  for (const selector of policy.candidates) {
    assert.ok(question.options.some(option => option.label === selector), selector);
  }
  assert.equal(question.options[0].label, policy.selector);
  assert.ok(question.options.every(option => option.description !== ''));
  // Strict tool: an unknown field is a rejected call, so the keys are pinned.
  assert.deepEqual(Object.keys(question).sort(), ['header', 'id', 'multi', 'options', 'question', 'recommended']);
  assert.ok(question.question.includes('req-7'));
  assert.ok(question.question.includes(policy.selector));
});

test('the declined option is the reader\'s own label, so a defer is never read as a forgery', () => {
  const question = modelConfirmationQuestion('req-7', CONFIRMABLE());

  assert.equal(question.options.at(-1).label, DEFER_LABEL);
  assert.equal(question.options.filter(option => option.label === DEFER_LABEL).length, 1);
});

// ── the selector convention ──────────────────────────────────────────────────

test('a selector splits only on an effort that names a real thinking level', () => {
  assert.deepEqual(splitSelector('vendor-a/mid:medium'), { model: 'vendor-a/mid', effort: 'medium' });
  assert.deepEqual(splitSelector('@worker-balanced'), { model: '@worker-balanced', effort: null });
  // A version tag is part of the id. Truncating it would silently reroute.
  assert.deepEqual(splitSelector('vendor-a/mid:latest'), { model: 'vendor-a/mid:latest', effort: null });
  assert.deepEqual(splitSelector('vendor-a/gpt-9.1:2026-01:high'), { model: 'vendor-a/gpt-9.1:2026-01', effort: 'high' });
  assert.deepEqual(splitSelector(''), { model: '', effort: null });
});

test('the tier vocabulary is ordered cheapest-first, which IS the floor comparison', () => {
  assert.deepEqual(MODEL_CAPABILITIES, ['efficient', 'balanced', 'intensive']);
  assert.deepEqual(MODEL_MODES, ['auto', 'pinned', 'confirm']);
  assert.ok(MODEL_CAPABILITIES.indexOf('intensive') > MODEL_CAPABILITIES.indexOf('balanced'));
});
