/**
 * What the routing half must REFUSE, and what it must let through.
 *
 * Every case is written so that removing the guard makes it fail. That bar
 * matters more here than anywhere else in this package, because the failure this
 * machinery exists to prevent is silent by construction: a worker moved onto an
 * unapproved model by a quota fallback produces perfectly good-looking work, on
 * a model nobody approved for the ticket, and nothing says so.
 *
 * Two layers, driven separately: the decision table (a string plus an injected
 * resolver), and the factory driven the way the host drives it — handlers get
 * `(event, ctx)`. Both are needed. A previous version of this extension shipped
 * two "wiring tests" that passed while the wiring was broken, because neither
 * could reach the real call.
 */

import { describe, expect, test } from 'bun:test';

import orcaModel from './index.ts';
import {
  decodeRouting,
  fallbackChainsFor,
  readRouting,
  resolveRouting,
  validateRouting,
  type RoutingPlan,
} from './routing.ts';
import type { OrcaRunner } from './self.ts';

const HANDLE = 'term_routed';
/** A top-level session file: `<slug>/<ts>_<uuid>.jsonl`. */
const TOP_LEVEL = '/tmp/sessions/-repo/2026-09-13T09-00-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e99.jsonl';
/** A `task` subagent: one directory deeper, under the top-level session id. */
const CHILD =
  '/tmp/sessions/-repo/2026-09-13T09-00-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e99/2026-09-13T09-05-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e88.jsonl';

const OPUS = 'anthropic/claude-opus-5';
const SONNET = 'anthropic/claude-sonnet-5';
const GROK = 'xai-oauth/grok-4.5';
const BASELINE = { default: ['anthropic/claude-haiku-5:low'] };

/** A payload as the parent writes it: base64url over the JSON. */
function marker(body: unknown, model = `${OPUS}:high`): string {
  const routing = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `Do the thing.\n[omp model=${model} routing=${routing}]`;
}

/** A well-formed v2 payload, with the pieces a case wants to break. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    mode: 'auto',
    selector: `${OPUS}:high`,
    candidates: [`${OPUS}:high`, `${SONNET}:medium`],
    effort: 'high',
    ...overrides,
  };
}

/** A resolved model that reasons across the usual ladder. */
function model(identity: string, efforts: string[] = ['low', 'medium', 'high']): unknown {
  const cut = identity.indexOf('/');
  return {
    provider: identity.slice(0, cut),
    id: identity.slice(cut + 1),
    reasoning: true,
    thinking: { efforts },
  };
}

function planOf(body: Record<string, unknown>): RoutingPlan {
  const read = validateRouting(body);
  if (read.kind !== 'plan') throw new Error(`expected a plan, got ${read.kind}: ${JSON.stringify(read)}`);
  return read.plan;
}

/** Did any handler block the tool? Narrowed, never cast. */
function blocked(results: readonly unknown[]): boolean {
  return results.some(
    (result) => result !== null && typeof result === 'object' && 'block' in result && result.block === true,
  );
}

/** The system prompt a `before_agent_start` handler returned, joined. */
function promptOf(results: readonly unknown[]): string {
  const blocks: string[] = [];
  for (const result of results) {
    if (result === null || typeof result !== 'object' || !('systemPrompt' in result)) continue;
    const prompt = result.systemPrompt;
    if (Array.isArray(prompt)) blocks.push(...prompt.filter((entry): entry is string => typeof entry === 'string'));
  }
  return blocks.join('\n');
}

describe('the routing payload grammar', () => {
  test('a marker with no routing key is a legacy dispatch, untouched', () => {
    expect(readRouting('[omp model=@task]')).toEqual({ kind: 'absent' });
    expect(readRouting('no marker at all')).toEqual({ kind: 'absent' });
    expect(readRouting(null)).toEqual({ kind: 'absent' });
  });

  test('a routing key that is not base64url JSON is refused, never ignored', () => {
    expect(decodeRouting('!!!not-base64!!!').kind).toBe('refused');
    expect(decodeRouting(Buffer.from('not json', 'utf8').toString('base64url')).kind).toBe('refused');
  });

  test('an empty routing key is refused rather than read as absent', () => {
    expect(readRouting('[omp model=@task routing=]')).toMatchObject({ kind: 'refused' });
  });

  test('a marker that carries a route AND a fumbled token is refused, not read as legacy', () => {
    // `parseMarker` abandons the whole bracket at the first non-`key=value`
    // token, so the routing key is never seen. Reading that as "no route" would
    // fail open on precisely the marker most likely to have been hand-edited.
    const routing = Buffer.from(JSON.stringify(payload()), 'utf8').toString('base64url');
    expect(readRouting(`[omp model=${OPUS}:high routing=${routing} junk]`)).toMatchObject({ kind: 'refused' });
  });

  test('a malformed marker with no routing token stays legacy', () => {
    // Unchanged behaviour for a dispatch that never carried a route.
    expect(readRouting('[omp model=@task junk]')).toEqual({ kind: 'absent' });
  });

  test('a version this runtime cannot enforce is refused, not enforced as v2', () => {
    // A v3 payload's candidate semantics are not ours to guess.
    expect(validateRouting(payload({ version: 3 }))).toMatchObject({ kind: 'refused' });
    expect(validateRouting(payload({ version: '2' }))).toMatchObject({ kind: 'refused' });
  });

  test('a candidate without an effort suffix is refused, never defaulted', () => {
    expect(validateRouting(payload({ candidates: [OPUS], selector: OPUS }))).toMatchObject({
      kind: 'refused',
    });
  });

  test('an alias candidate is refused — membership must not be re-read from config', () => {
    expect(
      validateRouting(payload({ candidates: ['@worker-balanced:high'], selector: '@worker-balanced:high' })),
    ).toMatchObject({ kind: 'refused' });
  });

  test('a selector outside its own candidate list is refused', () => {
    expect(validateRouting(payload({ selector: `${GROK}:high` }))).toMatchObject({ kind: 'refused' });
  });

  test('the selected candidate may be any member, not only the first', () => {
    // `confirm` lets the operator pick any proposed candidate; a tier may approve
    // several. Position carries no authority — membership does.
    const plan = planOf(payload({ mode: 'confirm', selector: `${SONNET}:medium`, effort: 'medium' }));
    expect(plan.selected).toEqual({ selector: `${SONNET}:medium`, model: SONNET, effort: 'medium' });
    expect(plan.candidates).toHaveLength(2);
  });

  test('a pinned route may carry several candidates', () => {
    const plan = planOf(payload({ mode: 'pinned' }));
    expect(plan.mode).toBe('pinned');
    expect(plan.candidates).toHaveLength(2);
  });

  test('a restated effort that disagrees with the selected candidate is refused', () => {
    expect(validateRouting(payload({ effort: 'low' }))).toMatchObject({ kind: 'refused' });
  });

  test('one model may appear once — two efforts for one model is not an approval', () => {
    expect(validateRouting(payload({ candidates: [`${OPUS}:high`, `${OPUS}:low`] }))).toMatchObject({
      kind: 'refused',
    });
  });

  test('an empty candidate list is refused', () => {
    expect(validateRouting(payload({ candidates: [] }))).toMatchObject({ kind: 'refused' });
  });

  test('a mode outside auto|pinned|confirm is refused', () => {
    expect(validateRouting(payload({ mode: 'whatever' }))).toMatchObject({ kind: 'refused' });
  });

  test('a well-formed payload round-trips off a real marker', () => {
    const read = readRouting(marker(payload()));
    expect(read).toMatchObject({ kind: 'plan' });
    if (read.kind !== 'plan') return;
    expect(read.plan.selector).toBe(`${OPUS}:high`);
    expect(read.plan.effort).toBe('high');
    expect(read.plan.candidates.map((candidate) => candidate.selector)).toEqual([
      `${OPUS}:high`,
      `${SONNET}:medium`,
    ]);
  });
});

describe('resolution against the host that will actually serve it', () => {
  test('every candidate is checked, not just the one about to be served', () => {
    // The chain can move the session onto any candidate with nobody left to ask,
    // so a later candidate that does not resolve is a hole in the authorization.
    const resolution = resolveRouting(planOf(payload()), (spec) => (spec === OPUS ? model(OPUS) : undefined));
    expect(resolution).toMatchObject({ ok: false });
  });

  test('a candidate that resolves to a DIFFERENT identity is refused', () => {
    const plan = planOf(payload({ candidates: [`${OPUS}:high`], selector: `${OPUS}:high` }));
    const resolution = resolveRouting(plan, () => model(SONNET));
    expect(resolution).toMatchObject({ ok: false });
    if (resolution.ok) return;
    expect(resolution.detail).toContain('approved identity');
  });

  test('an effort the model does not support is refused, never clamped', () => {
    const plan = planOf(payload({ candidates: [`${OPUS}:xhigh`], selector: `${OPUS}:xhigh`, effort: 'xhigh' }));
    const resolution = resolveRouting(plan, () => model(OPUS, ['low', 'medium', 'high']));
    expect(resolution).toMatchObject({ ok: false });
    if (resolution.ok) return;
    expect(resolution.detail).toContain('xhigh');
  });

  test('a model that declares no thinking configuration cannot serve an effort', () => {
    const plan = planOf(payload({ candidates: [`${OPUS}:high`], selector: `${OPUS}:high` }));
    expect(resolveRouting(plan, () => ({ provider: 'anthropic', id: 'claude-opus-5' }))).toMatchObject({
      ok: false,
    });
  });

  test('effort off is refused on a model that mandates thinking', () => {
    const plan = planOf(payload({ candidates: [`${OPUS}:off`], selector: `${OPUS}:off`, effort: 'off' }));
    const mandatory = {
      provider: 'anthropic',
      id: 'claude-opus-5',
      reasoning: true,
      thinking: { efforts: ['high'], requiresEffort: true },
    };
    expect(resolveRouting(plan, () => mandatory)).toMatchObject({ ok: false });
  });

  test('a fully available set resolves, in the approved order', () => {
    const resolution = resolveRouting(planOf(payload()), (spec) => model(spec));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.resolved.map((entry) => entry.candidate.model)).toEqual([OPUS, SONNET]);
  });
});

describe('the fallback chains this route arms', () => {
  test('each candidate chains forward only, carrying the next candidate own effort', () => {
    const plan = planOf(payload({ candidates: [`${OPUS}:high`, `${SONNET}:medium`, `${GROK}:low`] }));
    expect(fallbackChainsFor(plan)).toEqual({
      [OPUS]: [`${SONNET}:medium`, `${GROK}:low`],
      [SONNET]: [`${GROK}:low`],
      [GROK]: [],
    });
  });

  test('a singleton route arms an EMPTY chain, which OMP reads as "no fallback"', () => {
    // Not an absent key: an absent key inherits the fleet's default chain, which
    // is exactly the escape this closes.
    expect(fallbackChainsFor(planOf(payload({ candidates: [`${OPUS}:high`] })))).toEqual({ [OPUS]: [] });
  });

  test('chains are keyed by model, so no role — and no pinned subagent — is touched', () => {
    expect(Object.keys(fallbackChainsFor(planOf(payload())))).toEqual([OPUS, SONNET]);
  });
});

/** Orca answers with one live dispatch on this handle, serving `spec`. */
function runnerFor(spec: string): OrcaRunner {
  return async (args) => {
    const verb = args[1] ?? '';
    if (verb === 'worker-list')
      return {
        value: {
          ok: true,
          result: {
            workers: [
              {
                agentTerminalHandle: HANDLE,
                workerState: 'running',
                dispatchStatus: 'dispatched',
                taskId: 't1',
                runId: 'r1',
                dispatchId: 'd1',
              },
            ],
            counts: {},
          },
        },
      };
    if (verb === 'task-list') return { value: { ok: true, result: { tasks: [{ id: 't1', spec }] } } };
    return { reason: `unexpected ${args.join(' ')}` };
  };
}

/**
 * The factory, driven as the host drives it.
 *
 * `stuckLevel` models the one thing `setThinkingLevel` cannot be trusted about:
 * it returns void, so a host that silently declines a level looks identical to
 * one that applied it. The read-back is the only proof, so it has to be testable.
 */
function host(options: {
  spec: string;
  thinking?: string;
  stuckLevel?: boolean;
  refuseLevel?: boolean;
  chains?: Record<string, string[]>;
  /** No configured master switch at all, as a host whose `get` answers nothing. */
  unsetModelFallback?: boolean;
}) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const applied: unknown[] = [];
  const levels: string[] = [];
  const entries: { type: string; data: Record<string, unknown> }[] = [];
  const activeTools: string[][] = [];
  const warnings: string[] = [];
  const aborts: string[] = [];
  const settingsValues: Record<string, unknown> = {
    'retry.fallbackChains': options.chains ?? { ...BASELINE },
    ...(options.unsetModelFallback === true ? {} : { 'retry.modelFallback': false }),
  };
  let level = options.thinking ?? 'low';

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    setModel(value: unknown) {
      applied.push(value);
    },
    setThinkingLevel(value: string) {
      levels.push(value);
      if (options.refuseLevel === true) return false;
      if (options.stuckLevel !== true) level = value;
      return undefined;
    },
    getThinkingLevel: () => level,
    appendEntry(type: string, data: Record<string, unknown>) {
      entries.push({ type, data });
    },
    setActiveTools(names: string[]) {
      activeTools.push(names);
    },
    getAllTools: () => [{ name: 'bash' }, { name: 'read' }],
    logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    pi: {
      settings: {
        getModelRole: () => undefined,
        get: (path: string) => settingsValues[path],
        override: (path: string, value: unknown) => {
          settingsValues[path] = value;
        },
      },
    },
  };

  orcaModel(pi as never, { handle: HANDLE, run: runnerFor(options.spec) });

  /** A handler context carrying the model the next provider request would use. */
  const ctxFor = (current: unknown, file = TOP_LEVEL): unknown => ({
    models: { resolve: (spec: string) => model(spec) },
    sessionManager: { getSessionFile: () => file },
    model: current,
    abort: () => aborts.push('abort'),
  });

  const fire = async (event: string, body: unknown, ctx: unknown): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(body, ctx));
    return results;
  };

  /** What the session is carrying, as turn-recovery would leave it after a hop. */
  const setLevel = (next: string): void => {
    level = next;
  };

  return { fire, ctxFor, setLevel, applied, levels, entries, activeTools, warnings, aborts, settingsValues };
}

/** `before_agent_start`, which is where the model is applied. */
const START = { type: 'before_agent_start', systemPrompt: ['base'] };

describe('the factory enforces the route', () => {
  test('the selected candidate is served at its approved effort, and armed', async () => {
    const session = host({ spec: marker(payload()) });
    await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));

    expect(session.applied).toEqual([model(OPUS)]);
    expect(session.levels).toEqual(['high']);
    // Merged over the baseline, keyed by model, never replacing what was there.
    expect(session.settingsValues['retry.fallbackChains']).toEqual({
      ...BASELINE,
      [OPUS]: [`${SONNET}:medium`],
      [SONNET]: [],
    });
    // The operator approved the sibling, so the master switch must not veto it.
    expect(session.settingsValues['retry.modelFallback']).toBe(true);
  });

  test('a confirmed route serves the chosen candidate, not the first one', async () => {
    const session = host({
      spec: marker(payload({ mode: 'confirm', selector: `${SONNET}:medium`, effort: 'medium' }), `${SONNET}:medium`),
    });
    await session.fire('before_agent_start', START, session.ctxFor(model(SONNET)));
    expect(session.applied).toEqual([model(SONNET)]);
    expect(session.levels).toEqual(['medium']);
  });

  test('the v2 receipt carries routingVersion 2 and the effort actually in force', async () => {
    const session = host({ spec: marker(payload()) });
    await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));
    const receipt = session.entries.find((entry) => entry.type === '@flosrn/ax/model-assignment');
    expect(receipt?.data).toMatchObject({
      routingVersion: 2,
      requested: `${OPUS}:high`,
      model: OPUS,
      thinking: 'high',
    });
  });

  test('an effort that did not actually take is refused, never journaled as applied', async () => {
    // The host accepts the call and keeps serving `low`. `setThinkingLevel`
    // reports nothing, so only the read-back catches this.
    const session = host({ spec: marker(payload()), thinking: 'low', stuckLevel: true });
    const out = await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));
    expect(promptOf(out)).toContain('APPROVED MODEL ROUTE REFUSED');
    expect(session.entries.some((entry) => entry.type === '@flosrn/ax/model-assignment')).toBe(false);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });

  test('a host that REFUSES the effort refuses the route, exactly like a refused model', async () => {
    // The model half of an approved candidate without its effort is not the
    // candidate, so a `false` from setThinkingLevel is not a warning to log.
    const session = host({ spec: marker(payload()), refuseLevel: true });
    const out = await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));
    expect(promptOf(out)).toContain('APPROVED MODEL ROUTE REFUSED');
    expect(session.entries.some((entry) => entry.type === '@flosrn/ax/model-assignment')).toBe(false);
  });

  test('a malformed route refuses before any model is touched, and blocks every tool', async () => {
    const session = host({ spec: 'Do it.\n[omp model=@task routing=@@@notbase64@@@]' });
    const ctx = session.ctxFor(model(OPUS));
    const out = await session.fire('before_agent_start', START, ctx);

    expect(session.applied).toEqual([]);
    expect(session.activeTools).toEqual([[]]);
    expect(promptOf(out)).toContain('APPROVED MODEL ROUTE REFUSED');
    expect(blocked(await session.fire('tool_call', { toolName: 'bash' }, ctx))).toBe(true);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });

  test('an unsupported effort refuses the whole route — no model is set at all', async () => {
    const session = host({
      spec: marker(payload({ candidates: [`${OPUS}:max`], selector: `${OPUS}:max`, effort: 'max' }), `${OPUS}:max`),
    });
    await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));
    expect(session.applied).toEqual([]);
    expect(session.levels).toEqual([]);
    expect(session.warnings.join(' ')).toContain('max');
  });

  test('a request to a model outside the approved set is aborted and the session locked', async () => {
    const session = host({ spec: marker(payload()) });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);
    expect(session.aborts).toEqual([]);

    // A quota fallback that escaped the chain: the request would go to Grok.
    await session.fire('before_provider_request', { type: 'before_provider_request', payload: {} }, session.ctxFor(model(GROK)));

    expect(session.aborts).toEqual(['abort']);
    expect(blocked(await session.fire('tool_call', { toolName: 'bash' }, ctx))).toBe(true);
    expect(session.entries.some((entry) => entry.type === '@flosrn/ax/routing-refused')).toBe(true);
    // The refusal also unwinds what it armed.
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });

  test('the payload hook returns the payload untouched — it decides IF, never WHAT', async () => {
    const session = host({ spec: marker(payload()) });
    await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));
    const body = { messages: [{ role: 'user' }] };
    const results = await session.fire(
      'before_provider_request',
      { type: 'before_provider_request', payload: body },
      session.ctxFor(model(GROK)),
    );
    expect(results[0]).toBe(body);
  });

  test('an approved sibling may serve, at ITS own effort, with its own receipt', async () => {
    const session = host({ spec: marker(payload()) });
    await session.fire('before_agent_start', START, session.ctxFor(model(OPUS)));
    await session.fire('before_provider_request', { type: 'before_provider_request', payload: {} }, session.ctxFor(model(OPUS)));

    // The chain moved the session to the sibling and carried `medium` with it.
    session.setLevel('medium');
    await session.fire('before_provider_request', { type: 'before_provider_request', payload: {} }, session.ctxFor(model(SONNET)));

    expect(session.aborts).toEqual([]);
    const receipts = session.entries.filter((entry) => entry.type === '@flosrn/ax/model-assignment');
    // The hop keeps the parent's ORIGINAL requested selector and names what serves.
    expect(receipts.at(-1)?.data).toMatchObject({
      requested: `${OPUS}:high`,
      model: SONNET,
      thinking: 'medium',
      via: 'fallback',
      routingVersion: 2,
    });
  });

  test('an approved model about to serve the WRONG effort is refused, not silently patched', async () => {
    const session = host({ spec: marker(payload()) });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);
    // Sonnet is approved at `medium`; the session is still carrying `high`.
    await session.fire('before_provider_request', { type: 'before_provider_request', payload: {} }, session.ctxFor(model(SONNET)));

    expect(session.aborts).toEqual(['abort']);
    expect(session.entries.some((entry) => entry.type === '@flosrn/ax/routing-refused')).toBe(true);
    // The session level is corrected so a later turn is not refused for the same reason.
    expect(session.levels).toEqual(['high', 'medium']);
  });

  test('the override is wound back before a tool runs, and re-armed only after the LAST one', async () => {
    // `task` and `eval` spawn children that SNAPSHOT the process settings, so a
    // parallel sibling still running must not see this session's route.
    const session = host({ spec: marker(payload()) });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toHaveProperty(OPUS);

    await session.fire('tool_call', { toolName: 'task' }, ctx);
    await session.fire('tool_call', { toolName: 'read' }, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
    expect(session.settingsValues['retry.modelFallback']).toBe(false);

    // The fast tool finishes first; the spawning one is still live.
    await session.fire('tool_result', { toolName: 'read' }, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);

    await session.fire('tool_result', { toolName: 'task' }, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toHaveProperty(OPUS);
  });

  test('a tool that never reports a result does not keep the chains down for good', async () => {
    // A blocked or cancelled call emits `tool_call` and no `tool_result`, so the
    // in-flight count stays above zero. The next top-level turn is the boundary
    // at which that leftover is provably stale, and it must re-arm there — or
    // every later request of the session runs on the fleet's default chain.
    const session = host({ spec: marker(payload()) });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);
    await session.fire('tool_call', { toolName: 'task' }, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);

    await session.fire('before_agent_start', START, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toEqual({
      ...BASELINE,
      [OPUS]: [`${SONNET}:medium`],
      [SONNET]: [],
    });
    expect(session.settingsValues['retry.modelFallback']).toBe(true);
  });

  test('a subagent turn clears nothing of the parent batch and arms nothing', async () => {
    const session = host({ spec: marker(payload()) });
    const parent = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, parent);
    await session.fire('tool_call', { toolName: 'task' }, parent);

    // The child's own turn is not the parent's turn boundary: the spawning tool
    // is still live, and re-arming here is exactly the leak the count prevents.
    await session.fire('before_agent_start', START, session.ctxFor(model(GROK), CHILD));
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);

    await session.fire('tool_result', { toolName: 'task' }, parent);
    expect(session.settingsValues['retry.fallbackChains']).toHaveProperty(OPUS);
  });

  test('a master switch this session forced on is not left behind when none was configured', async () => {
    // `get` answers nothing for it, so there is no baseline boolean to write
    // back. Writing the capture — `undefined` — is what removes our override;
    // skipping the write would leave the session's forced `true` armed.
    const session = host({ spec: marker(payload()), unsetModelFallback: true });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);
    expect(session.settingsValues['retry.modelFallback']).toBe(true);

    await session.fire('tool_call', { toolName: 'task' }, ctx);
    expect(session.settingsValues['retry.modelFallback']).toBeUndefined();
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });

  test('shutdown leaves nothing of this session behind in the settings', async () => {
    const session = host({ spec: marker(payload()) });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);
    await session.fire('session_shutdown', { type: 'session_shutdown' }, ctx);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });

  test('a route with no ctx.abort is refused BEFORE any request, not fenced with theatre', async () => {
    const session = host({ spec: marker(payload()) });
    const blind = {
      models: { resolve: (spec: string) => model(spec) },
      sessionManager: { getSessionFile: () => TOP_LEVEL },
      model: model(OPUS),
    };
    const out = await session.fire('before_agent_start', START, blind);
    expect(promptOf(out)).toContain('APPROVED MODEL ROUTE REFUSED');
    expect(session.warnings.join(' ')).toContain('ctx.abort');
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });
});

describe('what routing must NOT reach', () => {
  test('a task subagent is untouched: no abort, no block, no override', async () => {
    const session = host({ spec: marker(payload()) });
    const parent = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, parent);
    await session.fire('tool_call', { toolName: 'task' }, parent);

    const child = session.ctxFor(model(GROK), CHILD);
    const results = await session.fire('before_provider_request', { type: 'before_provider_request', payload: { c: 1 } }, child);
    expect(session.aborts).toEqual([]);
    expect(results[0]).toEqual({ c: 1 });
    expect(blocked(await session.fire('tool_call', { toolName: 'bash' }, child))).toBe(false);

    // The child's own tool results must not re-arm the parent's route either.
    await session.fire('tool_result', { toolName: 'bash' }, child);
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
  });

  test('a legacy marker keeps the pre-routing behaviour exactly', async () => {
    const session = host({ spec: `Do it.\n[omp model=${OPUS}:high]` });
    const ctx = session.ctxFor(model(OPUS));
    await session.fire('before_agent_start', START, ctx);

    expect(session.applied).toEqual([model(OPUS)]);
    expect(session.levels).toEqual(['high']);
    // No route means no enforcement: nothing armed, nothing aborted, nothing blocked.
    expect(session.settingsValues['retry.fallbackChains']).toEqual(BASELINE);
    expect(session.settingsValues['retry.modelFallback']).toBe(false);
    await session.fire('before_provider_request', { type: 'before_provider_request', payload: {} }, session.ctxFor(model(GROK)));
    expect(session.aborts).toEqual([]);
    expect(blocked(await session.fire('tool_call', { toolName: 'bash' }, ctx))).toBe(false);
  });
});
