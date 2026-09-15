// Which ROLE a worker runs on, one proposition per rule.
//
// The policy is pure, so every test here is the real function against real
// inputs — no temp repo, no host, no subprocess. What a role expands to is
// nobody's business here: the propositions worth asserting are which CLASS a
// dispatch is, which configured role that class hands the child, and who was
// allowed to decide it.
//
// The properties worth the most are negative. A mode whose decider said nothing
// must refuse rather than route: `manual` with no class named, and `ask` with no
// verified answer, both place nothing. A class a human chose must survive a
// label floor that would have raised it, because a floor overriding a human is
// the decision they were asked for being spent on one they declined.
//
// The role names below are invented strings (`@worker-…`). Naming a model, a
// provider or an effort here would smuggle exactly the dependency this module
// exists not to have.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFER_LABEL } from '../src/worker/model-confirmation.mjs';
import {
  DEFAULT_CAPABILITY,
  MODEL_CAPABILITIES,
  MODEL_MODES,
  confirmationQuestionId,
  modelConfirmationQuestion,
  modelPolicy,
} from '../src/worker/model-policy.mjs';

/** A project that opted in: one role per class, one label floor. */
const MODELS = {
  routine: '@worker-routine',
  standard: '@worker-standard',
  deep: '@worker-deep',
};
const FLOORS = { 'domain:security': 'deep' };

/**
 * The refusal a call threw, for the tests that assert what it SAYS.
 * `assert.throws` returns undefined, so a message assertion needs the error
 * itself — and an operator told "no" without being told which class or which
 * mode refused has nothing to act on.
 */
const refusal = call => {
  try {
    call();
  } catch (error) {
    return error;
  }
  return assert.fail('expected a refusal, got a policy');
};

// ── the vocabulary ───────────────────────────────────────────────────────────


test('a typo in either vocabulary refuses, and names what was expected', () => {
  assert.match(refusal(() => modelPolicy({ models: MODELS, mode: 'confirm' })).message, /auto, manual, ask/);
  assert.match(refusal(() => modelPolicy({ models: MODELS, capability: 'intensive' })).message, /routine, standard, deep/);
});

// ── auto: the orchestrator assesses ──────────────────────────────────────────

test('auto with no assessment routes the conservative standard role, not the cheapest', () => {
  const policy = modelPolicy({ models: MODELS, floors: FLOORS });

  assert.equal(policy.mode, 'auto');
  assert.equal(policy.requestedCapability, null, 'nothing was assessed, and the record says so');
  assert.equal(policy.capability, 'standard');
  assert.equal(policy.selector, '@worker-standard');
  assert.equal(policy.source, 'default');
  assert.equal(policy.confirmation, null);
  assert.equal(policy.pending, undefined, 'auto decides here: there is nothing to wait for');
  assert.match(policy.reason, /conservative standard route/);
});

test('auto routes the class the orchestrator assessed, with its reason on the record', () => {
  const policy = modelPolicy({ models: MODELS, capability: 'routine', because: 'decided fix, one file' });

  assert.equal(policy.capability, 'routine');
  assert.equal(policy.selector, '@worker-routine');
  assert.equal(policy.source, 'capability');
  assert.equal(policy.reason, 'orchestrator capability: routine — decided fix, one file');
});

test('a label floor raises an assessment, and names the label that did it', () => {
  const policy = modelPolicy({ models: MODELS, floors: FLOORS, capability: 'routine', labels: ['domain:security'] });

  assert.equal(policy.capability, 'deep');
  assert.equal(policy.selector, '@worker-deep');
  assert.equal(policy.source, 'floor');
  assert.match(policy.reason, /risk floor: domain:security/);
});

test('a project that configured no roles keeps @default, in every direction', () => {
  // The opt-out, and the one place `@default` is still an answer: a repository
  // that never declared a class must dispatch exactly as it did before classes
  // existed.
  const unassessed = modelPolicy({ models: {}, floors: FLOORS, labels: ['domain:security'] });
  assert.equal(unassessed.selector, '@default');
  assert.equal(unassessed.classes.length, 0);
  assert.match(unassessed.reason, /preserving @default/);

  const assessed = modelPolicy({ models: {}, capability: 'deep' });
  assert.equal(assessed.selector, '@default', 'with nothing configured there is no deep role to route to');
  assert.equal(assessed.capability, 'deep');
});

test('a class this project half-configured is named, never quietly downgraded', () => {
  const boom = refusal(() => modelPolicy({ models: { routine: '@worker-routine' }, capability: 'deep' }));

  assert.match(boom.message, /declares no deep role/);
  assert.match(boom.message, /configure it, assess another class, or name a --model/);
});

// ── the legacy explicit selector ─────────────────────────────────────────────

test('an explicit --model is still honoured in auto, and outranks a label floor', () => {
  const policy = modelPolicy({ models: MODELS, floors: FLOORS, model: '@operator-pick', labels: ['domain:security'] });

  assert.equal(policy.selector, '@operator-pick');
  assert.equal(policy.source, 'explicit');
  assert.deepEqual(policy.floorLabels, [], 'a floor does not raise a selector the operator named');
});

test('an explicit --model cannot stand in for a class a human was asked to choose', () => {
  // Honouring it in either mode would spend a decision somebody made — or was
  // about to make — on one they never saw, with the mode still recorded.
  for (const mode of ['manual', 'ask']) {
    const boom = refusal(() => modelPolicy({ models: MODELS, mode, model: '@operator-pick', capability: 'routine' }));
    assert.match(boom.message, /only honoured in auto mode/);
  }
});

// ── manual: the operator names the class ─────────────────────────────────────

test('manual routes the class the operator named, and a label floor does not override it', () => {
  const policy = modelPolicy({
    models: MODELS, floors: FLOORS, mode: 'manual', capability: 'routine',
    labels: ['domain:security'], because: 'operator: the fix is decided',
  });

  assert.equal(policy.mode, 'manual');
  assert.equal(policy.capability, 'routine', 'the floor would have raised this to deep');
  assert.equal(policy.selector, '@worker-routine');
  assert.equal(policy.source, 'manual');
  assert.deepEqual(policy.floorLabels, []);
  assert.match(policy.reason, /operator named routine — operator: the fix is decided/);
});

test('manual with no class named refuses: there is nothing to route and nothing to assess', () => {
  const boom = refusal(() => modelPolicy({ models: MODELS, mode: 'manual' }));

  assert.match(boom.message, /routes the class the operator named/);
  assert.match(boom.message, /--capability routine, standard or deep/);
});

test('manual and ask refuse on a project with no configured class at all', () => {
  for (const mode of ['manual', 'ask']) {
    const boom = refusal(() => modelPolicy({ models: {}, mode, capability: 'standard' }));
    assert.match(boom.message, /configures no worker roles/);
  }
});

// ── ask: a human chooses, in this session, for this request ──────────────────

test('ask decides nothing on its own: the preliminary policy is pending, with the menu on it', () => {
  const policy = modelPolicy({ models: MODELS, floors: FLOORS, mode: 'ask', capability: 'routine' });

  assert.equal(policy.pending, true, 'nothing may be placed on this');
  assert.deepEqual(policy.classes, ['routine', 'standard', 'deep']);
  assert.equal(policy.recommended, 'routine');
  assert.equal(policy.confirmation, null);
});

test('ask can offer configured classes when the assessed class is unavailable', () => {
  const models = { routine: '@worker-routine', deep: '@worker-deep' };
  const pending = modelPolicy({ models, mode: 'ask' });
  assert.equal(pending.pending, true);
  assert.equal(pending.selector, '');
  const question = modelConfirmationQuestion('partial-menu', pending);
  assert.deepEqual(question.options.map(option => option.label), ['routine', 'deep', DEFER_LABEL]);
  assert.equal(question.recommended, undefined);
  const approved = modelPolicy({ models, mode: 'ask', approval: { capability: 'deep', reference: '/s/a.jsonl#answer' } });
  assert.equal(approved.selector, '@worker-deep');
});

test('the ask question offers CLASSES, a decline, and no model or effort anywhere', () => {
  const policy = modelPolicy({ models: MODELS, mode: 'ask', capability: 'deep', because: 'unresolved lock design' });
  const question = modelConfirmationQuestion('ofmchat-412', policy);

  assert.deepEqual(question.options.map(option => option.label), ['routine', 'standard', 'deep', DEFER_LABEL]);
  assert.equal(question.multi, false);
  assert.equal(question.options[question.recommended].label, 'deep');
  // The whole point of the correction: a human is asked which CLASS of work
  // this is, never which model or effort serves it.
  const rendered = JSON.stringify(question);
  for (const role of Object.values(MODELS)) assert.ok(!rendered.includes(role), `${role} has no business on this menu`);
  for (const effort of ['medium', 'high', 'xhigh', 'max']) assert.ok(!rendered.includes(effort));
  // The native tool is strict: an extra field is a rejected call.
  assert.deepEqual(Object.keys(question).sort(), ['header', 'id', 'multi', 'options', 'question', 'recommended']);
});

test('the question id binds the request AND the configuration behind the menu', () => {
  const base = { models: MODELS, floors: FLOORS, mode: 'ask', capability: 'standard' };
  const policy = modelPolicy(base);
  const id = confirmationQuestionId('ofmchat-412', policy);

  assert.match(id, /^ax-model:ofmchat-412:[0-9a-f]{16}$/);
  assert.equal(id, confirmationQuestionId('ofmchat-412', modelPolicy(base)), 'the same decision asks the same question');
  assert.notEqual(id, confirmationQuestionId('ofmchat-413', policy), 'another request is another question');
  // Re-routing a class invalidates an answer collected for the old routing: the
  // human approved a class in a project that routed it somewhere specific.
  const rerouted = modelPolicy({ ...base, models: { ...MODELS, deep: '@worker-deep-2' } });
  assert.notEqual(id, confirmationQuestionId('ofmchat-412', rerouted));
  // And so does adding a class the human never saw on the menu.
  const narrowed = modelPolicy({ ...base, models: { standard: '@worker-standard', deep: '@worker-deep' } });
  assert.notEqual(id, confirmationQuestionId('ofmchat-412', narrowed));
});

test('a question can only be built from an ask decision over configured classes', () => {
  assert.match(refusal(() => confirmationQuestionId('', modelPolicy({ models: MODELS, mode: 'ask' }))).message, /request id/);
  assert.match(
    refusal(() => confirmationQuestionId('ofmchat-412', modelPolicy({ models: MODELS, capability: 'deep' }))).message,
    /ask-mode policy/,
  );
});

test('the class a human chose is the decision, and it outranks recommendation and floor alike', () => {
  const chosen = modelPolicy({
    models: MODELS, floors: FLOORS, mode: 'ask', capability: 'deep', labels: ['domain:security'],
    approval: { capability: 'routine', reference: '/s/session.jsonl#call_1' },
  });

  assert.equal(chosen.pending, undefined, 'answered: this one places');
  assert.equal(chosen.capability, 'routine', 'the human went BELOW both the assessment and the floor');
  assert.equal(chosen.selector, '@worker-routine');
  assert.equal(chosen.source, 'approved');
  assert.deepEqual(chosen.floorLabels, []);
  assert.equal(chosen.recommended, 'deep', 'and the record keeps what was recommended instead');
  assert.equal(chosen.confirmation, '/s/session.jsonl#call_1', 'the artifact that authorized it, on the record');
  assert.match(chosen.reason, /operator chose routine in this session’s ask/);
});

test('an answer is only usable where a question was asked, and only for a configured class', () => {
  const outside = refusal(() => modelPolicy({
    models: MODELS, capability: 'routine', approval: { capability: 'routine', reference: '/s/session.jsonl#call_1' },
  }));
  assert.match(outside.message, /answer to an ask question/);

  for (const capability of ['', 'intensive', 'balanced']) {
    const boom = refusal(() => modelPolicy({
      models: MODELS, mode: 'ask', approval: { capability, reference: '/s/session.jsonl#call_1' },
    }));
    assert.match(boom.message, /not one this project configures/);
  }
});

// ── the recorded decision ────────────────────────────────────────────────────

test('the decision records the mode, the class, the role and who decided — and nothing about a model', () => {
  const policy = modelPolicy({ models: MODELS, floors: FLOORS, mode: 'ask', capability: 'standard',
    approval: { capability: 'deep', reference: '/s/session.jsonl#call_1' } });

  // Recovery replays THIS object rather than reclassifying a changed ticket, so
  // every field a later reader needs has to be on it.
  assert.deepEqual(Object.keys(policy).sort(), [
    'capability', 'classes', 'confirmation', 'floorLabels', 'mode', 'policyHash',
    'reason', 'recommended', 'requestedCapability', 'selector', 'source', 'version',
  ]);
  assert.equal(policy.version, 1);
  assert.match(policy.policyHash, /^[0-9a-f]{64}$/);
});

test('the policy hash covers the roles and the floors, and only those', () => {
  const hash = models => modelPolicy({ models, floors: FLOORS }).policyHash;

  assert.equal(hash(MODELS), hash({ ...MODELS }));
  assert.notEqual(hash(MODELS), hash({ ...MODELS, deep: '@worker-deep-2' }));
  assert.notEqual(
    modelPolicy({ models: MODELS, floors: FLOORS }).policyHash,
    modelPolicy({ models: MODELS, floors: { 'domain:security': 'standard' } }).policyHash,
  );
  assert.equal(
    modelPolicy({ models: MODELS, floors: FLOORS, capability: 'deep', because: 'x' }).policyHash,
    modelPolicy({ models: MODELS, floors: FLOORS }).policyHash,
    'the assessment is not the configuration',
  );
});
