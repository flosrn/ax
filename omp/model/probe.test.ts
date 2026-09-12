/**
 * The probe, driven against a FAKE FACADE that answers exactly what a real host
 * answers: `list()` of authenticated records, `resolve()` with the runtime's own
 * fuzziness, and `getModelRole()` with raw configured strings, suffixes intact.
 *
 * Every case below is a way a candidate list has been or would be wrong on a
 * real machine: an effort taken from the wrong member of a comma list, an effort
 * the model does not implement, a typo that fuzzy-matched a neighbour, a model
 * nobody is authenticated for, and a role that expands into itself. None of them
 * fails loudly at dispatch; all of them silently serve the wrong model, which is
 * why each is asserted as a REFUSAL rather than as a best effort.
 */

import { expect, test } from 'bun:test';

import modelProbe, {
  MAX_EXPANSION_DEPTH,
  PROBE_PREFIX,
  SELECTORS_ENV,
  expandSelectors,
  formatProbe,
  probeRequests,
  readSelectors,
  runProbe,
  type ProbeDeps,
} from './probe';

/** A thinking ladder, as a catalog record carries one. */
interface FakeThinking {
  efforts?: string[];
  effortMap?: Record<string, string>;
  requiresEffort?: boolean;
}

/** An authenticated record, as `ctx.models.list()` hands them over. */
interface FakeModel {
  provider: string;
  id: string;
  thinking?: FakeThinking | null;
}

const model = (provider: string, id: string, thinking?: FakeThinking | null): FakeModel => ({
  provider,
  id,
  ...(thinking === undefined ? {} : { thinking }),
});

const SONNET = model('anthropic', 'claude-sonnet-5', { efforts: ['minimal', 'low', 'medium', 'high'] });
const GROK = model('xai-oauth', 'grok-4.5', { efforts: ['low', 'high'] });
/** The shape this whole effort check exists for: a ladder with no `medium`. */
const DEEPSEEK = model('deepseek', 'deepseek-v4', { efforts: ['high', 'max'] });
/** A host that spells one user-facing effort differently on the wire. */
const MAPPED = model('cline-pass', 'kimi-k3', { efforts: ['max'], effortMap: { high: 'max' } });
const NO_THINKING = model('openai', 'gpt-5.2-chat', null);
const REQUIRES = model('google', 'gemini-3-pro', { efforts: ['low', 'high'], requiresEffort: true });

/**
 * A facade that resolves EXACTLY, plus one deliberate fuzzy hit — because the
 * real `resolve()` is the fuzzy matcher `--model opus` uses, and a candidate
 * list must refuse that rather than inherit it.
 */
function facade(
  authenticated: readonly FakeModel[],
  roles: Record<string, string> = {},
  fuzzy: Record<string, FakeModel> = {},
): ProbeDeps {
  const byName = new Map(authenticated.map(record => [`${record.provider}/${record.id}`, record]));
  const byId = new Map(authenticated.map(record => [record.id, record]));
  return {
    list: () => authenticated,
    resolve: spec => fuzzy[spec] ?? byName.get(spec) ?? byId.get(spec),
    configuredRole: role => roles[role],
  };
}

test('a request that is not a JSON array of selectors is an error, never an empty probe', () => {
  expect(readSelectors(undefined).errors[0]).toContain(`${SELECTORS_ENV} is empty`);
  expect(readSelectors('  ').errors[0]).toContain(`${SELECTORS_ENV} is empty`);
  expect(readSelectors('{"a":1}').errors[0]).toContain('must be a JSON array');
  expect(readSelectors('not json').errors[0]).toContain('is not JSON');
  expect(readSelectors('[]').errors[0]).toContain('empty array');
  const mixed = readSelectors('["@worker-balanced", 7, ""]');
  expect(mixed.selectors).toEqual(['@worker-balanced']);
  expect(mixed.errors[0]).toContain('non-selector entry');
  expect(readSelectors('[" @worker-balanced "]').selectors).toEqual(['@worker-balanced']);
});

test('each candidate keeps ITS OWN effort — the last comma suffix is not the list’s effort', () => {
  const { requests, errors } = expandSelectors(
    ['@worker-balanced'],
    role => (role === 'worker-balanced' ? 'anthropic/claude-sonnet-5:low,xai-oauth/grok-4.5:high,deepseek/deepseek-v4' : undefined),
  );
  expect(errors).toEqual([]);
  expect(requests.map(request => `${request.spec}=${request.effort}`)).toEqual([
    'anthropic/claude-sonnet-5=low',
    'xai-oauth/grok-4.5=high',
    // No suffix of its own and no alias-level effort: `null`, so the runtime's
    // own default applies. Inventing one here is the bug this asserts against.
    'deepseek/deepseek-v4=null',
  ]);
});

test('an effort the REQUEST named outranks the one config declares, all the way down', () => {
  // `@opus-5:xhigh` is the operator saying xhigh about everything that alias
  // names. A member written `:low` in config winning that argument is the
  // defect this asserts against: the request is the later, more specific
  // statement, and a dispatch that silently served `low` could not be
  // explained from what was asked for.
  const { requests } = expandSelectors(
    ['@opus-5:xhigh'],
    role => (role === 'opus-5' ? 'anthropic/claude-opus-5:low,xai-oauth/grok-4.5:high,deepseek/deepseek-v4' : undefined),
  );
  expect(requests.map(request => `${request.spec}=${request.effort}`)).toEqual([
    'anthropic/claude-opus-5=xhigh',
    'xai-oauth/grok-4.5=xhigh',
    'deepseek/deepseek-v4=xhigh',
  ]);

  // And it survives nesting: the OUTERMOST explicit effort is the one that was
  // requested, so an inner alias's own suffix cannot retune it either.
  const roles: Record<string, string> = { 'worker-intensive': '@house:low', house: 'anthropic/claude-opus-5:medium' };
  const nested = expandSelectors(['@worker-intensive:max'], role => roles[role]);
  expect(nested.requests.map(request => `${request.spec}=${request.effort}`)).toEqual(['anthropic/claude-opus-5=max']);

  // With nothing requested, each member's own configured suffix stands.
  const unrequested = expandSelectors(['@worker-intensive'], role => roles[role]);
  expect(unrequested.requests.map(request => `${request.spec}=${request.effort}`)).toEqual(['anthropic/claude-opus-5=low']);
});

test('roles expand through roles, in order, and one model reached twice is one candidate', () => {
  const roles: Record<string, string> = {
    'worker-balanced': '@house,xai-oauth/grok-4.5:high',
    house: 'anthropic/claude-sonnet-5:low,xai-oauth/grok-4.5:high',
  };
  const { requests, errors } = expandSelectors(['@worker-balanced'], role => roles[role]);
  expect(errors).toEqual([]);
  expect(requests.map(request => `${request.spec}:${request.effort}`)).toEqual([
    'anthropic/claude-sonnet-5:low',
    'xai-oauth/grok-4.5:high',
  ]);
  expect(requests[0].via).toEqual(['worker-balanced', 'house']);
});

test('a cyclic role is refused by its trail, never expanded until something breaks', () => {
  const roles: Record<string, string> = { 'worker-balanced': '@house', house: '@worker-balanced' };
  const { requests, errors } = expandSelectors(['@worker-balanced'], role => roles[role]);
  expect(requests).toEqual([]);
  expect(errors[0]).toContain('cycles: @worker-balanced → @house → @worker-balanced');
});

test('a legal chain deeper than the bound is refused rather than truncated', () => {
  // Each role names the next, so the chain is as long as the bound plus one.
  const roles: Record<string, string> = {};
  for (let index = 0; index <= MAX_EXPANSION_DEPTH + 1; index += 1) roles[`r${index}`] = `@r${index + 1}`;
  roles[`r${MAX_EXPANSION_DEPTH + 2}`] = 'anthropic/claude-sonnet-5:low';
  const { requests, errors } = expandSelectors(['@r0'], role => roles[role]);
  expect(requests).toEqual([]);
  expect(errors[0]).toContain(`more than ${MAX_EXPANSION_DEPTH} aliases deep`);
});

test('an unconfigured role and a bogus effort suffix are two different refusals', () => {
  const unconfigured = expandSelectors(['@worker-intensive'], () => undefined);
  expect(unconfigured.requests).toEqual([]);
  expect(unconfigured.errors[0]).toContain("'@worker-intensive' is not a model role this host configures");

  const bogus = expandSelectors(['@worker-balanced:mdium'], role => (role === 'worker-balanced' ? 'anthropic/claude-sonnet-5' : undefined));
  expect(bogus.requests).toEqual([]);
  // The refusal names the EFFORT, not the role: otherwise the operator is sent
  // to modelRoles to look for a role that is configured and spelled right.
  expect(bogus.errors[0]).toContain("names effort 'mdium'");
});

test('an empty role value names no candidate and says so', () => {
  const { requests, errors } = expandSelectors(['@worker-balanced'], () => ',, ,');
  expect(requests).toEqual([]);
  expect(errors[0]).toContain('lists no candidate');
});

test('a concrete selector is probed as written, with its own effort', () => {
  const { candidates, errors } = probeRequests(
    expandSelectors(['xai-oauth/grok-4.5:high'], () => undefined).requests,
    facade([SONNET, GROK]),
  );
  expect(errors).toEqual([]);
  expect(candidates).toEqual([{ selector: 'xai-oauth/grok-4.5:high', model: 'xai-oauth/grok-4.5', effort: 'high', available: true }]);
});

test('an effort the model does not declare is refused, never clamped to a neighbour', () => {
  const { candidates } = probeRequests(
    expandSelectors(['deepseek/deepseek-v4:medium'], () => undefined).requests,
    facade([DEEPSEEK]),
  );
  expect(candidates[0].available).toBe(false);
  expect(candidates[0].effort).toBe('medium');
  // The ladder is quoted back, because "unsupported" without the supported set
  // is a refusal the operator cannot repair.
  expect(candidates[0].reason).toContain("does not support effort 'medium' (it declares high, max)");
  expect(candidates[0].reason).toContain('refused rather than clamped');
});

test('an effort the model maps itself is served as REQUESTED, with the wire tier only as a note', () => {
  const { candidates } = probeRequests(expandSelectors(['cline-pass/kimi-k3:high'], () => undefined).requests, facade([MAPPED]));
  expect(candidates[0].available).toBe(true);
  // The requested effort is what travels, in both the value and the selector.
  // Reporting the wire tier ('max') as the candidate's effort would hand the
  // runtime a level nobody asked for, and a pinned dispatch could not be
  // replayed from what was requested.
  expect(candidates[0].effort).toBe('high');
  expect(candidates[0].selector).toBe('cline-pass/kimi-k3:high');
  expect(candidates[0].reason).toContain("effort 'high' is requested as 'high' and served through the model's own effort map as wire tier 'max'");
});

test('a model with no thinking configuration serves no effort, and `off` needs no ladder', () => {
  const deps = facade([NO_THINKING, REQUIRES]);
  const [withEffort] = probeRequests(expandSelectors(['openai/gpt-5.2-chat:high'], () => undefined).requests, deps).candidates;
  expect(withEffort.available).toBe(false);
  expect(withEffort.reason).toContain('declares no thinking configuration');

  const [off] = probeRequests(expandSelectors(['openai/gpt-5.2-chat:off'], () => undefined).requests, deps).candidates;
  expect(off.available).toBe(true);
  expect(off.effort).toBe('off');

  // A model that REQUIRES an effort cannot be asked for none.
  const [required] = probeRequests(expandSelectors(['google/gemini-3-pro:off'], () => undefined).requests, deps).candidates;
  expect(required.available).toBe(false);
  expect(required.reason).toContain('requires a thinking effort');
});

test('a candidate that only fuzzy-matches is refused, because a typo would become a substitution', () => {
  const deps = facade([SONNET], {}, { 'anthropic/claude-sonet-5': SONNET });
  const { candidates } = probeRequests(expandSelectors(['anthropic/claude-sonet-5:low'], () => undefined).requests, deps);
  expect(candidates[0].available).toBe(false);
  expect(candidates[0].reason).toContain("only fuzzy-matches 'anthropic/claude-sonnet-5'");
});

test('a model nobody here is authenticated for is unavailable, not merely unresolved', () => {
  // Resolvable (the catalog knows it) and absent from the authenticated list —
  // the exact shape of a role naming a provider this host never logged into.
  const deps: ProbeDeps = {
    list: () => [SONNET],
    resolve: spec => (spec === 'deepseek/deepseek-v4' ? DEEPSEEK : spec === 'anthropic/claude-sonnet-5' ? SONNET : undefined),
    configuredRole: () => undefined,
  };
  const { candidates } = probeRequests(expandSelectors(['deepseek/deepseek-v4:high', 'nope/nothing'], () => undefined).requests, deps);
  expect(candidates[0].available).toBe(false);
  expect(candidates[0].reason).toContain("is not in this host's authenticated models");
  expect(candidates[1].available).toBe(false);
  expect(candidates[1].reason).toContain('does not resolve on this host');
});

test('a resolver that throws is one unavailable candidate, not a dead probe', () => {
  const deps: ProbeDeps = {
    list: () => [SONNET],
    resolve: () => {
      throw new Error('catalog unreadable');
    },
    configuredRole: () => undefined,
  };
  const { candidates } = probeRequests(expandSelectors(['anthropic/claude-sonnet-5'], () => undefined).requests, deps);
  expect(candidates[0].available).toBe(false);
  expect(candidates[0].reason).toContain('catalog unreadable');
});

test('an unreadable model list is an error, so no candidate is reported as proven', () => {
  const deps: ProbeDeps = {
    list: () => {
      throw new Error('not authenticated');
    },
    resolve: () => SONNET,
    configuredRole: () => undefined,
  };
  const { candidates, errors } = probeRequests(expandSelectors(['anthropic/claude-sonnet-5'], () => undefined).requests, deps);
  expect(candidates).toEqual([]);
  expect(errors[0]).toContain('authenticated model list could not be read');
});

test('the whole probe answers {candidates,errors} in configured order', () => {
  const deps = facade([SONNET, GROK, DEEPSEEK], {
    'worker-balanced': 'anthropic/claude-sonnet-5:low,deepseek/deepseek-v4:medium',
  });
  const result = runProbe(JSON.stringify(['@worker-balanced', '@worker-intensive']), deps);
  expect(result.candidates).toEqual([
    { selector: 'anthropic/claude-sonnet-5:low', model: 'anthropic/claude-sonnet-5', effort: 'low', available: true },
    {
      selector: 'deepseek/deepseek-v4:medium',
      model: 'deepseek/deepseek-v4',
      effort: 'medium',
      available: false,
      reason: "'deepseek/deepseek-v4' does not support effort 'medium' (it declares high, max) and maps no alias for it — refused rather than clamped",
    },
  ]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("'@worker-intensive' is not a model role");
  expect(formatProbe(result).startsWith(PROBE_PREFIX)).toBe(true);
  expect(formatProbe(result).endsWith('\n')).toBe(true);
  expect(JSON.parse(formatProbe(result).slice(PROBE_PREFIX.length))).toEqual(result);
});

/** The host facade the factory is installed into, with both effects captured. */
function host(roles: Record<string, string> = {}) {
  const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === 'session_start') handlers.push(handler);
    },
    pi: { settings: { getModelRole: (role: string) => roles[role] } },
  };
  return { pi, handlers, lines, exits };
}

test('the factory answers at session_start, asks to shut down, and leaves before any turn', async () => {
  const { pi, handlers, lines, exits } = host({ 'worker-balanced': 'anthropic/claude-sonnet-5:low' });
  let shutdowns = 0;
  modelProbe(pi, {
    env: { [SELECTORS_ENV]: JSON.stringify(['@worker-balanced']) },
    emit: line => lines.push(line),
    exit: code => exits.push(code),
  });
  expect(handlers).toHaveLength(1);

  await handlers[0](
    { type: 'session_start' },
    {
      models: { list: () => [SONNET], resolve: (spec: string) => (spec === 'anthropic/claude-sonnet-5' ? SONNET : undefined) },
      shutdown: () => {
        shutdowns += 1;
      },
    },
  );

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0].slice(PROBE_PREFIX.length))).toEqual({
    candidates: [{ selector: 'anthropic/claude-sonnet-5:low', model: 'anthropic/claude-sonnet-5', effort: 'low', available: true }],
    errors: [],
  });
  expect(shutdowns).toBe(1);
  // The exit is what makes "no inference" a fact: print mode wires
  // `ctx.shutdown()` to a no-op, so the turn would otherwise run.
  expect(exits).toEqual([0]);
});

test('a host with no models facade says so instead of answering "no candidates"', async () => {
  const { pi, handlers, lines, exits } = host();
  modelProbe(pi, { env: { [SELECTORS_ENV]: '["@worker-balanced"]' }, emit: line => lines.push(line), exit: code => exits.push(code) });
  await handlers[0]({ type: 'session_start' }, { sessionManager: {} });
  const answer = JSON.parse(lines[0].slice(PROBE_PREFIX.length));
  expect(answer.candidates).toEqual([]);
  expect(answer.errors[0]).toContain('exposes no models facade');
  expect(exits).toEqual([0]);
});

test('a host that refuses to shut down is still left', async () => {
  const { pi, handlers, lines, exits } = host({ 'worker-balanced': 'anthropic/claude-sonnet-5' });
  modelProbe(pi, { env: { [SELECTORS_ENV]: '["@worker-balanced"]' }, emit: line => lines.push(line), exit: code => exits.push(code) });
  await handlers[0](
    { type: 'session_start' },
    {
      models: { list: () => [SONNET], resolve: () => SONNET },
      shutdown: () => {
        throw new Error('no shutdown in this mode');
      },
    },
  );
  expect(lines).toHaveLength(1);
  expect(exits).toEqual([0]);
});
