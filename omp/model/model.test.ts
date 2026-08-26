import { describe, expect, test } from 'bun:test';

import { readModelIntent, splitThinking, SUPERVISED_DEFAULT } from './alias.ts';
import orcaModel, { applyDispatchedModel, type ApplyDeps } from './index.ts';
import { findSelf, readSpecFromTranscript, resolveOrcaBin, type OrcaRunner } from './self.ts';

/**
 * These tests defend the two failures this extension was built against:
 *
 *   1. a dispatched worker silently serving the interactive default (measured:
 *      claude-opus-5 served for a task nobody assigned a model to), and
 *   2. an operator's own session having its deliberate model choice overridden.
 *
 * Every case below is written so that removing the guard makes it fail. A test
 * that stays green when the code stops refusing is defending nothing.
 */

const HANDLE = 'term_child';

/** A `worker-list` payload with one entry, shaped as Orca really returns it. */
function workerList(entries: Record<string, unknown>[]): unknown {
  return { ok: true, result: { workers: entries, counts: {} } };
}

function taskList(tasks: Record<string, unknown>[]): unknown {
  return { ok: true, result: { tasks } };
}

function fakeRunner(replies: Record<string, unknown>, calls: string[] = []): OrcaRunner {
  return async (args) => {
    calls.push(args.join(' '));
    const verb = args[1] ?? '';
    const reply = replies[verb];
    if (reply === undefined) return { reason: `no stub for ${verb}` };
    return { value: reply };
  };
}

function fakeDeps(overrides: Record<string, unknown> = {}): {
  deps: Record<string, unknown>;
  applied: unknown[];
  thinking: string[];
} {
  const applied: unknown[] = [];
  const thinking: string[] = [];
  const deps = {
    resolve: (spec: string) => ({ provider: 'stub', id: spec.replace(/^@/, '') }),
    setModel: (model: unknown) => {
      applied.push(model);
    },
    setThinkingLevel: (level: string) => {
      thinking.push(level);
    },
    ...overrides,
  };
  return { deps, applied, thinking };
}

describe('the marker contract', () => {
  test('an alias is read out of the spec', () => {
    const intent = readModelIntent('Fix the thing.\n[omp model=@smol]\nDone.');
    expect(intent).toEqual({ spec: '@smol', thinking: null, source: 'marker' });
  });

  test('a thinking suffix rides on OMP’s own convention, not a second one', () => {
    expect(readModelIntent('[omp model=@task:high]')).toEqual({
      spec: '@task',
      thinking: 'high',
      source: 'marker',
    });
  });

  test('a concrete id is accepted — refusing one would buy nothing', () => {
    expect(readModelIntent('[omp model=xai-oauth/grok-4.5]').spec).toBe('xai-oauth/grok-4.5');
  });

  test('a colon that is not a thinking level stays part of the id', () => {
    // Guessing here would silently truncate a legitimate model id.
    expect(splitThinking('vendor/model:turbo')).toEqual({ spec: 'vendor/model:turbo', thinking: null });
  });

  test('no marker lands on the supervised default, never the harness default', () => {
    const intent = readModelIntent('Just do the work.');
    expect(intent.spec).toBe(SUPERVISED_DEFAULT);
    expect(intent.source).toBe('supervised-default');
  });

  test('an unreadable spec is treated as "nobody decided", with a reason', () => {
    const intent = readModelIntent(null);
    expect(intent.spec).toBe(SUPERVISED_DEFAULT);
    expect(intent.reason).toBe('Task spec unreadable');
  });

  test('an empty marker does not resolve to the empty string', () => {
    const intent = readModelIntent('[omp model= ]');
    expect(intent.spec).toBe(SUPERVISED_DEFAULT);
    expect(intent.reason).toContain('empty');
  });
});

describe('who gets retuned', () => {
  test('no Orca handle -> untouched (an operator session keeps its choice)', async () => {
    const { deps: d, applied } = fakeDeps();
    const outcome = await applyDispatchedModel({ run: fakeRunner({}), handle: null, ...(d as any) });
    expect(outcome).toEqual({ applied: false, why: 'not-supervised' });
    expect(applied).toEqual([]);
  });

  test('a handle absent from worker-list -> untouched, and NOT reported as a fault', async () => {
    // `absent`, not `not-supervised`: Orca answered and we are not in its list.
    // At `session_start` that can still mean "not recorded yet", so the verdict
    // stays separate from "there is no Orca handle at all".
    const { deps: d, applied } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({ 'worker-list': workerList([{ agentTerminalHandle: 'term_someone_else' }]) }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome).toEqual({ applied: false, why: 'absent' });
    expect(applied).toEqual([]);
  });

  test('a settled dispatch -> untouched: the terminal may have been reused', async () => {
    const { deps: d, applied } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: HANDLE, workerState: 'succeeded', dispatchStatus: 'completed', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
        ]),
      }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.detail).toContain('no live dispatch');
    expect(applied).toEqual([]);
  });

  test('two live dispatches on one handle -> no model inferred, reason names both', async () => {
    // Picking "the first" would make the applied model depend on list order.
    const { deps: d, applied } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
          { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't2', runId: 'r1', dispatchId: 'd2' },
        ]),
      }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.why).toBe('lookup-failed');
      expect(outcome.detail).toContain('d1');
      expect(outcome.detail).toContain('d2');
    }
    expect(applied).toEqual([]);
  });

  test('an unreadable worker-list is a NAMED fault, not a silent no-op', async () => {
    const { deps: d } = fakeDeps();
    const outcome = await applyDispatchedModel({ run: fakeRunner({}), handle: HANDLE, ...(d as any) });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.why).toBe('lookup-failed');
      expect(outcome.detail).toContain('worker-list');
    }
  });
});

describe('what a supervised worker serves', () => {
  const liveWorker = workerList([
    { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
  ]);

  test('the alias its parent wrote', async () => {
    const { deps: d, applied, thinking } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({
        'worker-list': liveWorker,
        'task-list': taskList([{ id: 't1', spec: 'Do it.\n[omp model=@smol:low]' }]),
      }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome).toMatchObject({ applied: true, model: 'stub/smol', thinking: 'low', source: 'marker' });
    expect(applied).toHaveLength(1);
    expect(thinking).toEqual(['low']);
  });

  test('the supervised default when the parent forgot — never the premium default', async () => {
    const { deps: d, applied } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({
        'worker-list': liveWorker,
        'task-list': taskList([{ id: 't1', spec: 'Do it, no marker.' }]),
      }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome).toMatchObject({ applied: true, source: 'supervised-default' });
    expect(applied).toEqual([{ provider: 'stub', id: 'task' }]);
  });

  test('a task missing from its run still lands on the supervised default, with the reason kept', async () => {
    const { deps: d } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({ 'worker-list': liveWorker, 'task-list': taskList([{ id: 'other', spec: 'x' }]) }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome).toMatchObject({ applied: true, source: 'supervised-default' });
    if (outcome.applied) expect(outcome.detail).toContain('absent');
  });

  test('an alias that does not resolve refuses loudly and changes nothing', async () => {
    const { deps: d, applied } = fakeDeps({ resolve: () => undefined });
    const outcome = await applyDispatchedModel({
      run: fakeRunner({
        'worker-list': liveWorker,
        'task-list': taskList([{ id: 't1', spec: '[omp model=@nope]' }]),
      }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.why).toBe('unresolved');
      expect(outcome.detail).toContain('@nope');
    }
    expect(applied).toEqual([]);
  });

  test('no thinking suffix leaves the level alone rather than inventing one', async () => {
    const { deps: d, thinking } = fakeDeps();
    await applyDispatchedModel({
      run: fakeRunner({
        'worker-list': liveWorker,
        'task-list': taskList([{ id: 't1', spec: '[omp model=@task]' }]),
      }),
      handle: HANDLE,
      ...(d as any),
    });
    expect(thinking).toEqual([]);
  });

  test('the lookup costs two Orca calls, not a scan over every run', async () => {
    const calls: string[] = [];
    const { deps: d } = fakeDeps();
    await applyDispatchedModel({
      run: fakeRunner(
        { 'worker-list': liveWorker, 'task-list': taskList([{ id: 't1', spec: '[omp model=@task]' }]) },
        calls,
      ),
      handle: HANDLE,
      ...(d as any),
    });
    expect(calls).toEqual([
      'orchestration worker-list --json',
      'orchestration task-list --run r1 --json',
    ]);
  });
});

/**
 * A worker on another execution host. Measured 2026-08-13: `worker-start --on
 * gapicore` left the Run and Task authoritative on the Mac, so the child's own
 * `worker-list` answered WITHOUT its handle — `absent`, not an error — and the
 * `[omp model=@smol]` its parent wrote was discarded in silence while it served
 * claude-opus-5.
 *
 * The tests below pin the discriminant, because it is the whole design: a marker
 * in the session's own first message means a dispatch nobody local can see; no
 * marker means an operator's pane, which must stay untouched.
 */
describe('a worker whose Run lives on another host', () => {
  /**
   * `fakeDeps` hands back an untyped bag, so the spread needs one cast. Named
   * once here, with its reason, instead of an `as any` per test: the bag really
   * does carry these three members and the compiler cannot see it through
   * `Record<string, unknown>`.
   */
  const asDeps = (bag: Record<string, unknown>): Pick<ApplyDeps, 'resolve' | 'setModel' | 'setThinkingLevel'> =>
    bag as unknown as Pick<ApplyDeps, 'resolve' | 'setModel' | 'setThinkingLevel'>;

  const noWorkerHere = workerList([
    { agentTerminalHandle: 'term_someone_else', workerState: 'running', dispatchStatus: 'dispatched' },
  ]);

  test('its marker is honoured from its own transcript', async () => {
    const { deps: d, applied, thinking } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({ 'worker-list': noWorkerHere }),
      handle: HANDLE,
      localSpec: () => ({ spec: 'Read the brief.\n[omp model=@smol:low]' }),
      ...asDeps(d),
    });
    expect(outcome).toMatchObject({ applied: true, model: 'stub/smol', source: 'marker', via: 'transcript' });
    expect(applied).toHaveLength(1);
    expect(thinking).toEqual(['low']);
  });

  test('an operator pane with no marker is left alone — absent, silent, unchanged', async () => {
    const { deps: d, applied, thinking } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({ 'worker-list': noWorkerHere }),
      handle: HANDLE,
      localSpec: () => ({ spec: 'fix the login bug please' }),
      ...asDeps(d),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.why).toBe('absent');
    // The guard that matters: a supervised-default intent must NOT be applied
    // here. Doing so would retune a human mid-session, which D-028 forbids.
    expect(applied).toEqual([]);
    expect(thinking).toEqual([]);
  });

  test('with no transcript to read it stays exactly as before', async () => {
    const { deps: d, applied } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner({ 'worker-list': noWorkerHere }),
      handle: HANDLE,
      ...asDeps(d),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.why).toBe('absent');
    expect(applied).toEqual([]);
  });

  test('the Task record wins whenever Orca can see the dispatch', async () => {
    const calls: string[] = [];
    const { deps: d } = fakeDeps();
    const outcome = await applyDispatchedModel({
      run: fakeRunner(
        {
          'worker-list': workerList([
            { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
          ]),
          'task-list': taskList([{ id: 't1', spec: '[omp model=@task]' }]),
        },
        calls,
      ),
      handle: HANDLE,
      // A transcript that disagrees. It must not be consulted at all: the Task
      // record is the decision, the transcript is only a rendering of it.
      localSpec: () => {
        throw new Error('localSpec must not be consulted when the dispatch is visible');
      },
      ...asDeps(d),
    });
    expect(outcome).toMatchObject({ applied: true, source: 'marker', via: 'orca' });
  });
});

describe('reading the spec out of a transcript', () => {
  const row = (o: Record<string, unknown>): string => JSON.stringify(o);

  test('the FIRST user message wins, so a later steer cannot retune the session', () => {
    const file = [
      row({ type: 'session', cwd: '/x' }),
      row({ role: 'user', content: '[omp model=@smol] the brief' }),
      row({ role: 'assistant', content: 'ok' }),
      row({ role: 'user', content: '[omp model=@default] actually use opus' }),
    ].join('\n');
    expect(readSpecFromTranscript('/t.jsonl', () => file).spec).toContain('@smol');
  });

  test('a block-array content is read, not skipped', () => {
    const file = row({ role: 'user', content: [{ type: 'text', text: '[omp model=@task] go' }] });
    expect(readSpecFromTranscript('/t.jsonl', () => file).spec).toContain('@task');
  });

  test('one truncated line does not discard the entries around it', () => {
    const file = ['{"role":"user"', row({ role: 'user', content: '[omp model=@smol]' })].join('\n');
    expect(readSpecFromTranscript('/t.jsonl', () => file).spec).toContain('@smol');
  });

  test('an absence is NAMED, never an empty string that reads like a spec', () => {
    expect(readSpecFromTranscript(null).reason).toContain('no session file');
    expect(readSpecFromTranscript('/t.jsonl', () => row({ role: 'assistant', content: 'hi' })).reason).toContain(
      'no user message',
    );
    expect(
      readSpecFromTranscript('/t.jsonl', () => {
        throw new Error('ENOENT');
      }).reason,
    ).toContain('unreadable');
  });

  test('the real OMP envelope is nested — {type:"message", message:{role, content}}', () => {
    // Measured 2026-08-13 on a dispatched worker: rows carry NO top-level `role`,
    // and the first version of this reader tested exactly that. It found nothing,
    // stayed silent by design, and the child served its boot model anyway.
    const file = [
      row({ type: 'session', cwd: '/x' }),
      row({ type: 'model_change', model: 'anthropic/claude-opus-5' }),
      row({
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'You are a dispatched worker.\nYour task ID is: task_1f4c' },
            { type: 'text', text: '[omp model=@smol] do the thing' },
          ],
        },
      }),
    ].join('\n');
    expect(readSpecFromTranscript('/t.jsonl', () => file).spec).toContain('@smol');
  });

  test('an assistant message in the same envelope is not mistaken for the spec', () => {
    const file = [
      row({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '[omp model=@default]' }] } }),
      row({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '[omp model=@smol]' }] } }),
    ].join('\n');
    expect(readSpecFromTranscript('/t.jsonl', () => file).spec).toContain('@smol');
  });
});

describe('finding the binary', () => {
  test('an explicit ORCA_BIN wins', () => {
    expect(resolveOrcaBin({ ORCA_BIN: '/custom/orca' }, () => false)).toEqual({
      bin: '/custom/orca',
      how: 'env',
    });
  });

  test('an absolute candidate beats the bare name — a minimal PATH cost 246 blind runs', () => {
    expect(resolveOrcaBin({}, (path) => path === '/usr/bin/orca-ide')).toEqual({
      bin: '/usr/bin/orca-ide',
      how: 'candidate',
    });
  });

  test('with nothing executable it still names a binary, so the failure is reported not hidden', () => {
    expect(resolveOrcaBin({}, () => false)).toEqual({ bin: 'orca', how: 'path' });
  });
});

describe('findSelf reports its own faults', () => {
  test('ok=false is a reason, not an empty list', async () => {
    const result = await findSelf(async () => ({ value: { ok: false } }), HANDLE);
    expect(result.entry).toBeNull();
    expect(result.reason).toContain('ok=false');
  });

  test('a missing workers array is named rather than read as "no workers"', async () => {
    const result = await findSelf(async () => ({ value: { ok: true, result: {} } }), HANDLE);
    expect(result.entry).toBeNull();
    expect(result.reason).toContain('workers array');
  });
});

describe('a fumbled marker is named, never guessed', () => {
  test('a token that is not key=value -> refuse to guess, and name it', () => {
    const intent = readModelIntent('[omp model=@task extra]');
    expect(intent.spec).toBe(SUPERVISED_DEFAULT);
    expect(intent.reason).toContain('extra');
  });

  test('a second key does not change the model, in EITHER order', () => {
    // The old grammar required model= to follow `[omp` immediately. One order
    // captured both keys as a single value; the other did not match at all and
    // fell through to the supervised default with no reason — a parent that
    // named the premium model would silently get the bulk one.
    for (const marker of ['[omp role=supervisor model=@default]', '[omp model=@default role=supervisor]']) {
      const intent = readModelIntent(marker);
      expect(intent.spec).toBe('@default');
      expect(intent.source).toBe('marker');
    }
  });

  test('an unknown key is ignored BY NAME, not swallowed into its neighbour', () => {
    const intent = readModelIntent('[omp model=@smol role=supervisor]');
    expect(intent.spec).toBe('@smol');
    expect(intent.reason).toContain('role');
  });

  test('a marker that names no model is never silent', () => {
    // This is the case that made the whole grammar change necessary: absent
    // must not look identical to never-written.
    const intent = readModelIntent('[omp role=supervisor]');
    expect(intent.spec).toBe(SUPERVISED_DEFAULT);
    expect(intent.source).toBe('supervised-default');
    expect(intent.reason).toContain('role');
  });

  test('the marker is case-insensitive and tolerates padding', () => {
    expect(readModelIntent('[OMP   model=@plan]').spec).toBe('@plan');
  });
});

/**
 * THE TEST THAT WAS MISSING.
 *
 * The first version of this extension had a full green suite and was a total
 * no-op in the host: it read the models facade off the factory object (`pi.models`)
 * where it does not exist, instead of off the handler context, and every run
 * refused with `unresolved`. The suite could not see it because it injected the
 * facade directly into `applyDispatchedModel` — it tested the decision table and
 * never the wiring.
 *
 * So this exercises the default export the way the host calls it: handlers receive
 * `(event, ctx)`, and the facade lives on `ctx`.
 */
describe('the factory wiring, as the host actually calls it', () => {
  /**
   * `settings` is the host's real shape, not a convenience: `getModelRole` hangs
   * off `pi.pi.settings`, one level deeper than everything else this factory
   * touches, so the wire to it is exactly the kind that a decision-table test
   * cannot reach.
   */
  function fakePi(settings?: { getModelRole?(role: string): string | undefined }) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const applied: unknown[] = [];
    const thinking: string[] = [];
    const warnings: string[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: (level: string) => {
        thinking.push(level);
      },
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
      ...(settings === undefined ? {} : { pi: { settings } }),
    };
    return { pi, handlers, applied, thinking, warnings };
  }

  /** A live dispatch on this handle, serving `spec`. */
  function dispatched(spec: string) {
    return fakeRunner({
      'worker-list': workerList([
        {
          agentTerminalHandle: HANDLE,
          workerState: 'running',
          dispatchStatus: 'dispatched',
          taskId: 't1',
          runId: 'r1',
          dispatchId: 'd1',
        },
      ]),
      'task-list': taskList([{ id: 't1', spec }]),
    });
  }

  test('it takes the models facade from ctx (arg 2), not from the factory object', async () => {
    // Drives the FULL path: a supervised handle, a stubbed Orca, a spec with a
    // marker. If the facade is read off `pi` instead of `ctx`, resolve is never
    // called and setModel never fires — which is exactly the original bug.
    const { pi, handlers, applied } = fakePi();
    const resolved = { provider: 'stub', id: 'from-ctx' };
    const asked: string[] = [];
    orcaModel(pi as never, {
      handle: HANDLE,
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
        ]),
        'task-list': taskList([{ id: 't1', spec: '[omp model=@task]' }]),
      }),
    });
    const ctx = {
      models: {
        resolve: (spec: string) => {
          asked.push(spec);
          return resolved;
        },
      },
    };
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    expect(asked).toEqual(['@task']);
    expect(applied).toEqual([resolved]);
  });

  test('it reads the role effort off pi.pi.settings, the way the host nests it', async () => {
    // The effort path was only ever driven through an injected `configuredRole`
    // stub, so the ONE line that reaches the host for it — `pi.pi?.settings?.
    // getModelRole` — was never executed by a test. Two optional chains deep, a
    // wrong level yields `undefined` and silently means "this role declares no
    // effort", which is the adapter's legitimate quiet path. That is the exact
    // shape of the original no-op (0d17010): a broken wire reading as a
    // deliberate decision, under a green suite.
    const asked: string[] = [];
    const { pi, handlers, applied, thinking } = fakePi({
      getModelRole: (role: string) => {
        asked.push(role);
        return 'anthropic/claude-sonnet-5:medium';
      },
    });
    orcaModel(pi as never, { handle: HANDLE, run: dispatched('[omp model=@smol]') });
    await handlers.get('session_start')?.(
      { type: 'session_start' },
      { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } },
    );
    expect(asked).toEqual(['smol']);
    expect(thinking).toEqual(['medium']);
    expect(applied).toHaveLength(1);
  });

  test('a cross-host worker is served from the prompt it was handed, not from Orca', async () => {
    // THE TEST THAT WAS MISSING, TWICE. Both earlier attempts at this fix had a
    // green suite and did nothing in the host. The first read `row.role`, which
    // the real JSONL does not have. The second read the transcript FILE at
    // `before_agent_start`, before that row is flushed — so it found a header and
    // gave up, silently, and the child served its boot model. Neither could be
    // caught by a decision-table test: only driving `input` then the hook, in the
    // host's order, reaches the wire that matters.
    const { pi, handlers, applied, thinking } = fakePi({
      getModelRole: () => 'anthropic/claude-sonnet-5:medium',
    });
    orcaModel(pi as never, {
      handle: HANDLE,
      // Orca answers, and this handle is not in its list: the cross-host shape.
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: 'term_elsewhere', workerState: 'running', dispatchStatus: 'dispatched' },
        ]),
      }),
    });
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec.replace(/^@/, '') }) } };

    // Nothing to read yet: the session exists, the prompt has not arrived.
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    expect(applied).toEqual([]);

    // The host submits the dispatch input, then starts the agent.
    handlers.get('input')?.({ type: 'input', text: 'preamble…\n[omp model=@smol] do it' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: ['base'] }, ctx);

    expect(applied).toEqual([{ provider: 'stub', id: 'smol' }]);
    expect(thinking).toEqual(['medium']);
  });

  test('a later steer cannot retune the session', async () => {
    const { pi, handlers, applied } = fakePi();
    orcaModel(pi as never, {
      handle: HANDLE,
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: 'term_elsewhere', workerState: 'running', dispatchStatus: 'dispatched' },
        ]),
      }),
    });
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec.replace(/^@/, '') }) } };
    handlers.get('input')?.({ type: 'input', text: '[omp model=@smol] first' }, ctx);
    handlers.get('input')?.({ type: 'input', text: '[omp model=@default] second' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: ['base'] }, ctx);
    expect(applied).toEqual([{ provider: 'stub', id: 'smol' }]);
  });

  test('an operator typing an ordinary prompt in an Orca pane is left alone', async () => {
    const { pi, handlers, applied, warnings } = fakePi();
    orcaModel(pi as never, {
      handle: HANDLE,
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: 'term_elsewhere', workerState: 'running', dispatchStatus: 'dispatched' },
        ]),
      }),
    });
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };
    handlers.get('input')?.({ type: 'input', text: 'fix the login bug' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: ['base'] }, ctx);
    expect(applied).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('a host with no settings at all still serves the model, at no effort', async () => {
    // Not every host carries `pi.settings`. Reaching through it must degrade to
    // "no declared effort" rather than throwing inside the handler, because a
    // throw here loses the model too.
    const { pi, handlers, applied, thinking } = fakePi();
    orcaModel(pi as never, { handle: HANDLE, run: dispatched('[omp model=@smol]') });
    await handlers.get('session_start')?.(
      { type: 'session_start' },
      { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } },
    );
    expect(applied).toHaveLength(1);
    expect(thinking).toEqual([]);
  });

  test('a ctx with no models facade is REPORTED, never silently skipped', async () => {
    const { pi, handlers, warnings } = fakePi();
    orcaModel(pi as never);
    await handlers.get('session_start')?.({ type: 'session_start' }, {});
    expect(warnings.join(' ')).toContain('no models facade');
  });

  test('four registrations — two occasions, prompt capture, and the refusal fence', () => {
    // `input` is not a third occasion: it mutates nothing and applies no model. It
    // captures the submitted text, which is the only copy of the spec a worker on
    // another execution host can reach. `tool_call` is the independent hard fence:
    // even when the runtime refuses to hide tools, a rejected role cannot execute one.
    const { pi, handlers } = fakePi();
    orcaModel(pi as never);
    expect([...handlers.keys()].sort()).toEqual(['before_agent_start', 'input', 'session_start', 'tool_call']);
  });
});

describe('the two occasions do not both mutate', () => {
  test('setModel fires ONCE even when both handlers race', async () => {
    // Measured on a real dispatch: the child's transcript carried two identical
    // `model_change` entries because `settled` is read before the await and written
    // after it, so both occasions passed the check.
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const applied: unknown[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    orcaModel(pi as never, {
      handle: HANDLE,
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
        ]),
        'task-list': taskList([{ id: 't1', spec: '[omp model=@task]' }]),
      }),
    });
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };

    await Promise.all([
      handlers.get('session_start')?.({ type: 'session_start' }, ctx),
      handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx),
    ]);
    expect(applied).toHaveLength(1);
  });
});

/**
 * U6 — a refusal is said once, not once per turn.
 *
 * `before_agent_start` fires on EVERY user prompt ("Fired after user submits
 * prompt"), not only the first one. So a verdict left unsettled is not a retry
 * that eventually stops — it is a per-turn Orca subprocess and a per-turn log
 * line for the whole life of the terminal. The common case is a reused
 * terminal: once its dispatch reads `completed`, `findSelf` answers
 * `lookup-failed` and will answer it identically forever. Measured before the
 * fix: 11 `worker-list` invocations and 11 warn lines for one session plus ten
 * prompts.
 *
 * The two occasions still differ, and that difference is the whole point of the
 * `absent` verdict: at `session_start` a refusal may only mean Orca has not
 * recorded the Dispatch yet, so the retry must survive. At
 * `before_agent_start` there is no next occasion to retry into.
 */
describe('a refusal is said once, not once per turn', () => {
  function host() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const warnings: string[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: () => {},
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    };
    return { pi, handlers, warnings };
  }

  const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };

  /** Drives one session_start followed by ten user prompts. */
  async function tenTurns(run: OrcaRunner) {
    const { pi, handlers, warnings } = host();
    orcaModel(pi as never, { handle: HANDLE, run });
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    for (let turn = 0; turn < 10; turn += 1) {
      await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
    }
    return warnings;
  }

  test('a completed dispatch is looked up twice, not once per prompt', async () => {
    const calls: string[] = [];
    const warnings = await tenTurns(
      fakeRunner(
        {
          'worker-list': workerList([
            {
              agentTerminalHandle: HANDLE,
              workerState: 'running',
              dispatchStatus: 'completed',
              taskId: 't1',
              runId: 'r1',
              dispatchId: 'd1',
            },
          ]),
        },
        calls,
      ),
    );
    // One per occasion: the provisional look, then the final one. Never a third.
    expect(calls.filter((call) => call.includes('worker-list'))).toHaveLength(2);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('lookup-failed');
  });

  test('an alias that does not resolve is refused once, not per prompt', async () => {
    const { pi, handlers, warnings } = host();
    orcaModel(pi as never, {
      handle: HANDLE,
      run: fakeRunner({
        'worker-list': workerList([
          {
            agentTerminalHandle: HANDLE,
            workerState: 'running',
            dispatchStatus: 'dispatched',
            taskId: 't1',
            runId: 'r1',
            dispatchId: 'd1',
          },
        ]),
        'task-list': taskList([{ id: 't1', spec: '[omp model=@nosuchrole]' }]),
      }),
    });
    const blind = { models: { resolve: () => undefined } };
    await handlers.get('session_start')?.({ type: 'session_start' }, blind);
    for (let turn = 0; turn < 10; turn += 1) {
      await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, blind);
    }
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('unresolved');
  });

  test('the provisional occasion still retries — session_start never settles a refusal', async () => {
    // The guard above must not be bought by settling early: a dispatch Orca has
    // not recorded yet answers `lookup-failed` at session_start and resolves by
    // `before_agent_start`. Collapsing both would strand it on the boot model.
    const applied: unknown[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    let look = 0;
    const run: OrcaRunner = async (args) => {
      if (args.includes('worker-list')) {
        look += 1;
        return look === 1
          ? { reason: 'orca exited 1' }
          : {
              value: workerList([
                {
                  agentTerminalHandle: HANDLE,
                  workerState: 'running',
                  dispatchStatus: 'dispatched',
                  taskId: 't1',
                  runId: 'r1',
                  dispatchId: 'd1',
                },
              ]),
            };
      }
      return { value: taskList([{ id: 't1', spec: '[omp model=@task]' }]) };
    };
    orcaModel(pi as never, { handle: HANDLE, run });
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    expect(applied).toEqual([]);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
    expect(applied).toHaveLength(1);
  });
});

/**
 * Typed deps for the units below. The older helper above spreads through
 * `as any`; new tests state the contract instead, so a change to `ApplyDeps`
 * breaks the test that depends on it rather than passing silently.
 */
type ProbeDeps = Omit<ApplyDeps, 'run' | 'handle'>;

function probeDeps(overrides: Partial<ProbeDeps> = {}): {
  deps: ProbeDeps;
  applied: unknown[];
  thinking: string[];
} {
  const applied: unknown[] = [];
  const thinking: string[] = [];
  const deps: ProbeDeps = {
    resolve: (spec: string) => ({ provider: 'stub', id: spec.replace(/^@/, '') }),
    setModel: (model: unknown) => {
      applied.push(model);
    },
    setThinkingLevel: (level: string) => {
      thinking.push(level);
    },
    ...overrides,
  };
  return { deps, applied, thinking };
}

/**
 * U1 — the race the two occasions exist for.
 *
 * When Orca has not recorded the Dispatch yet, `worker-list` SUCCEEDS and simply
 * lacks the handle. That is indistinguishable from "not a supervised worker"
 * except by WHEN it is observed, so only the occasion can decide: absent at
 * `session_start` is provisional, absent at `before_agent_start` is final.
 */
describe('a dispatch recorded late is still honoured', () => {
  function lateRunner(state: { recorded: boolean }): OrcaRunner {
    return async (args) => {
      const verb = args[1] ?? '';
      if (verb === 'worker-list') {
        return {
          value: workerList(
            state.recorded
              ? [
                  {
                    agentTerminalHandle: HANDLE,
                    workerState: 'running',
                    dispatchStatus: 'dispatched',
                    taskId: 't1',
                    runId: 'r1',
                    dispatchId: 'd1',
                  },
                ]
              : [],
          ),
        };
      }
      if (verb === 'task-list') return { value: taskList([{ id: 't1', spec: '[omp model=@smol]' }]) };
      return { reason: `no stub for ${verb}` };
    };
  }

  function host() {
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const applied: unknown[] = [];
    const warnings: string[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    };
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };
    return { pi, handlers, applied, warnings, ctx };
  }

  test('session_start ran too early -> before_agent_start still applies the model', async () => {
    const state = { recorded: false };
    const { pi, handlers, applied, ctx } = host();
    orcaModel(pi as never, { handle: HANDLE, run: lateRunner(state) });

    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    expect(applied).toEqual([]); // nothing to find yet — correct, and must not settle

    state.recorded = true;
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
    expect(applied).toEqual([{ provider: 'stub', id: '@smol' }]);
  });

  test('an operator session in an Orca pane is left alone, and silently', async () => {
    // Absent on BOTH occasions is the ordinary interactive case. It must never
    // retune, and it must never warn — this fires on every session Flo opens.
    const state = { recorded: false };
    const { pi, handlers, applied, warnings, ctx } = host();
    orcaModel(pi as never, { handle: HANDLE, run: lateRunner(state) });

    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
    expect(applied).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

/**
 * U2 — the alias's own configured effort.
 *
 * `ctx.models.resolve()` documents that it drops thinking suffixes ("pass effort
 * separately"), so a bare `@smol` moved the model and left the effort at whatever
 * the boot model used. Measured on a live dispatch: config says
 * `smol: anthropic/claude-sonnet-5:medium`, the child ran at `high`.
 */
describe('the effort an alias declares', () => {
  const liveWorker = workerList([
    {
      agentTerminalHandle: HANDLE,
      workerState: 'running',
      dispatchStatus: 'dispatched',
      taskId: 't1',
      runId: 'r1',
      dispatchId: 'd1',
    },
  ]);

  function run(spec: string) {
    return fakeRunner({ 'worker-list': liveWorker, 'task-list': taskList([{ id: 't1', spec }]) });
  }

  test('a bare alias applies the effort its role declares', async () => {
    const asked: string[] = [];
    const { deps, thinking } = probeDeps({
      configuredRole: (role: string) => {
        asked.push(role);
        return 'anthropic/claude-sonnet-5:medium';
      },
    });
    await applyDispatchedModel({ run: run('[omp model=@smol]'), handle: HANDLE, ...deps, });
    expect(asked).toEqual(['smol']);
    expect(thinking).toEqual(['medium']);
  });

  test('an explicit marker suffix beats the role default', async () => {
    const { deps, thinking } = probeDeps({
      configuredRole: () => 'anthropic/claude-sonnet-5:medium',
    });
    await applyDispatchedModel({ run: run('[omp model=@smol:low]'), handle: HANDLE, ...deps, });
    expect(thinking).toEqual(['low']);
  });

  test('a role that declares no effort leaves the level alone', async () => {
    // `task: xai-oauth/grok-4.5` has no suffix. Inventing one here would be the
    // very "nobody decided" failure this extension exists to remove.
    const { deps, thinking } = probeDeps({ configuredRole: () => 'xai-oauth/grok-4.5' });
    await applyDispatchedModel({ run: run('[omp model=@task]'), handle: HANDLE, ...deps, });
    expect(thinking).toEqual([]);
  });

  test('a concrete id has no role, so settings are never consulted', async () => {
    let asked = 0;
    const { deps, thinking } = probeDeps({
      configuredRole: () => {
        asked += 1;
        return 'anthropic/claude-sonnet-5:medium';
      },
    });
    await applyDispatchedModel({
      run: run('[omp model=xai-oauth/grok-4.5]'),
      handle: HANDLE,
      ...deps,
    });
    expect(asked).toBe(0);
    expect(thinking).toEqual([]);
  });
});

/**
 * U3 — liveness must fail closed.
 *
 * Three overlapping vocabularies are in play (workerState, dispatchStatus, Task
 * status). A deny-list over one of them retunes on any word it has not been told
 * about; an allow-list refuses and names what it saw.
 */
describe('only a dispatched dispatch is live', () => {
  function withStatus(dispatchStatus: string): OrcaRunner {
    return fakeRunner({
      'worker-list': workerList([
        {
          agentTerminalHandle: HANDLE,
          workerState: 'running',
          dispatchStatus,
          taskId: 't1',
          runId: 'r1',
          dispatchId: 'd1',
        },
      ]),
      'task-list': taskList([{ id: 't1', spec: '[omp model=@smol]' }]),
    });
  }

  test('an unknown status is refused, and the reason names it', async () => {
    const { deps, applied } = probeDeps();
    const outcome = await applyDispatchedModel({
      run: withStatus('quiesced'),
      handle: HANDLE,
      ...deps,
    });
    expect(applied).toEqual([]);
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.detail).toContain('quiesced');
  });

  test('a completed dispatch is settled, whatever workerState says', async () => {
    // `completed` is the Task vocabulary's word for done and was absent from the
    // deny-list, so this terminal would have been retuned after its work ended.
    const { deps, applied } = probeDeps();
    await applyDispatchedModel({ run: withStatus('completed'), handle: HANDLE, ...deps, });
    expect(applied).toEqual([]);
  });

  test('a dispatched dispatch is still served', async () => {
    const { deps, applied } = probeDeps();
    await applyDispatchedModel({ run: withStatus('dispatched'), handle: HANDLE, ...deps, });
    expect(applied).toHaveLength(1);
  });
});

/**
 * U5 — the binary name, guarded as a property of every call site.
 *
 * A normal unit test cannot defend this: the defect is not a wrong value, it is
 * the bare name reappearing at a NEW call site. `orca-model` learned to resolve
 * the binary (`orca-ide` on the VPS, absolute paths under a minimal PATH) and
 * `orca-peer` did not, so on that host its receiver returned silently and no
 * child report could land. What must stay true is textual, so the test is
 * textual.
 *
 * The first version of this guard denied two spellings — `'orca',` and
 * `'orca']` — and therefore passed on `"orca",` and on `[ 'orca' ,`. A
 * verification mechanism that passes while the defect is present is the exact
 * class this file exists to close, so it now reads every spawned argv instead
 * and states what each argv[0] must BE. Unknown fails closed and the failure
 * names what it saw, the same shape U3 gave liveness.
 *
 * EXTENDED 2026-08-08 to `orca-peer/registry.ts`. Deleting
 * `scripts/orca-peer.sh` moved most of the Orca calls in this system into that
 * new file, and a guard whose stated purpose is "a new call site must not
 * reintroduce the bare name" would have been silent about the largest batch of
 * new call sites it has ever seen. Any future file that spawns Orca belongs in
 * SPAWNERS on the day it is written.
 */
describe('the peer extension spawns the resolved binary, never the bare name', () => {
  /**
   * The resolvers an argv[0] may legitimately be. Each answers with a path this
   * host proved, never a bare name — which is the whole proposition here.
   *
   * `axBin()` joined on 2026-08-22, and its absence was a RED nobody had run:
   * PORT step 2 (2026-08-21) moved both extension checkpoint writers onto
   * `ax board`, so `registry.ts` grew a spawn this guard had no opinion about,
   * and the guard had been failing since.
   *
   * It became `...axArgv()` when the extensions moved INTO `@flosrn/ax`. The
   * resolution it replaced — `$HOME/.local/bin/ax`, then PATH — was still a
   * lookup that could land on a DIFFERENT version of this very package, and a
   * project install with no global bin link resolved to nothing at all. The
   * spread form is accepted because the prefix is addressed from
   * `import.meta.url` and cannot resolve elsewhere, not because a spread is
   * harder to pattern-match.
   */
  const RESOLVERS: Record<string, true> = { ORCA: true, 'orcaBin()': true, '...axArgv()': true, '...AX': true };

  /** Executables these files legitimately run that are not a resolved binary. */
  const PLAIN_TOOLS: Record<string, true> = {
    "'bash'": true,
    "'cat'": true,
    "'git'": true,
    "'which'": true,
  };

  /**
   * Every file that spawns Orca or ax, with the exact resolver import it must
   * carry. The specifier is stated per file rather than matched loosely — a
   * loose match is how a second resolver grows unnoticed. The peer registry
   * split (2026-08-26) left exactly one Orca spawner in that package,
   * `orca.ts`; `report.ts` spawns this package's own CLI for the board write.
   */
  const SPAWNERS: { path: string; imports: string }[] = [
    {
      path: '../peer/index.ts',
      imports: "import { resolveOrcaBin } from '../model/self.ts'",
    },
    {
      path: '../peer/orca.ts',
      imports: "import { resolveOrcaBin } from '../model/self.ts'",
    },
    {
      path: '../peer/report.ts',
      imports: "import { axArgv } from '../shared/ax.ts'",
    },
  ];

  /** Source with comments stripped, so prose naming the binary cannot fail a test. */
  async function codeOf(path: string): Promise<string> {
    const source = await Bun.file(new URL(path, import.meta.url)).text();
    return source
      .split('\n')
      .filter((line) => {
        const start = line.trimStart();
        return !start.startsWith('*') && !start.startsWith('//') && !start.startsWith('/*');
      })
      .join('\n');
  }

  /** Every literal argv array handed to `sh`, `Bun.spawn` or `Bun.spawnSync`. */
  async function argvs(path: string): Promise<string[][]> {
    const calls = (await codeOf(path)).matchAll(
      /(?:Bun\.spawnSync|Bun\.spawn|sh)\(\s*\[([\s\S]*?)\]/g,
    );
    return [...calls].map((call) =>
      (call[1] ?? '')
        .split(',')
        .map((arg) => arg.trim())
        .filter((arg) => arg !== ''),
    );
  }

  for (const spawner of SPAWNERS) {
    describe(spawner.path, () => {
      test('every spawned argv[0] is the resolved binary or a plain system tool', async () => {
        const found = await argvs(spawner.path);
        expect(found.length).toBeGreaterThan(0);
        const strangers = found
          .map((argv) => argv[0] ?? '<empty argv>')
          .filter((argv0) => RESOLVERS[argv0] !== true && PLAIN_TOOLS[argv0] !== true);
        // Names what it saw rather than asserting a bare false: a new call site
        // should read as "you spawned X" and not as "something is wrong somewhere".
        expect(strangers).toEqual([]);
      });

      test('the binary name appears nowhere as a literal', async () => {
        // argv[0] is not the only way in — a name can reach a shell through
        // `bash -c`, a template, or an argument. No spelling of it belongs in
        // these files; the resolver is the only source.
        const literals = [
          ...(await codeOf(spawner.path)).matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g),
        ].map((match) => match[1] ?? match[2] ?? '');
        expect(
          literals.filter((literal) => /^orca(-[a-z]+)?$/.test(literal.trim())),
        ).toEqual([]);
      });

      test('it imports the one resolver instead of growing a second', async () => {
        const source = await Bun.file(new URL(spawner.path, import.meta.url)).text();
        expect(source).toContain(spawner.imports);
      });
    });
  }

  test('the `which` guard probes the resolved binary, not a name', async () => {
    // This is the site the VPS actually died on: `which orca` succeeds there
    // (it is the GNOME screen reader) while the Orca CLI is `orca-ide`, so the
    // receiver registered against the wrong thing and then returned silently.
    const probes = (await argvs('../peer/index.ts')).filter(
      (argv) => argv[0] === "'which'",
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe[1]).toBe('ORCA');
  });
});

/**
 * The absent verdict settles at the final occasion too.
 *
 * `absent` was added so `session_start` could refuse provisionally and
 * `before_agent_start` could retry — but the branch that stops looking once the
 * retry has run was never pinned. An operator's session in an Orca pane takes
 * that path on every prompt, so an unsettled `absent` is the same per-turn
 * subprocess storm the refusal branch was just fixed for, minus the warn line
 * that would have made it visible.
 */
describe('an absent handle stops being looked up', () => {
  test('an operator session is looked up twice, not once per prompt', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const applied: unknown[] = [];
    const warnings: string[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    };
    // Orca answers, and this handle is simply not one of its workers.
    orcaModel(pi as never, {
      handle: HANDLE,
      run: fakeRunner({ 'worker-list': workerList([{ agentTerminalHandle: 'term_someone_else' }]) }, calls),
    });
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };

    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    for (let turn = 0; turn < 10; turn += 1) {
      await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
    }

    expect(calls.filter((call) => call.includes('worker-list'))).toHaveLength(2);
    expect(applied).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

/**
 * A subagent must not be retuned to its parent's model.
 *
 * Every in-process `task` subagent re-initialises the extensions — measured
 * 2026-08-07: one session dispatching two subagents produced three factories in
 * one pid, each a fresh module evaluation. So `settled` and `running` cannot see
 * a sibling: they are closure state and the closure is new.
 *
 * The subagent also inherits `ORCA_TERMINAL_HANDLE`, so `findSelf` succeeds and
 * reads the PARENT's Dispatch. Left alone, a supervisor carrying
 * `[omp model=@default]` would re-apply opus over the grok subagent it just
 * dispatched to do the work — silently, and the log would read as a success.
 *
 * The discriminant is the session file's shape, which is structural: the
 * dispatched session writes `<cwd-slug>/<ts>_<uuid>.jsonl`, a subagent writes
 * `<ts>_<uuid>/<Name>.jsonl` — one level deeper, inside a directory named after
 * its parent's session. Verified against eight real subagent files.
 */
describe('a subagent is not the session the marker was written for', () => {
  const PARENT_DIR = '/Users/flo/.omp/agent/sessions/-.omp-.worktrees-audit-adapter';
  const PARENT_FILE = `${PARENT_DIR}/2026-08-07T05-14-59-242Z_019fdaa5-612a-7000-9c69-f47f70799bb4.jsonl`;
  const CHILD_FILE = `${PARENT_DIR}/2026-08-07T05-14-59-242Z_019fdaa5-612a-7000-9c69-f47f70799bb4/CorrectnessLens.jsonl`;

  function host(sessionFile: string) {
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const applied: unknown[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const ctx = {
      models: { resolve: (s: string) => ({ provider: 'stub', id: s }) },
      sessionManager: { getSessionFile: () => sessionFile },
    };
    return { pi, handlers, applied, ctx };
  }

  const liveDispatch = fakeRunner({
    'worker-list': workerList([
      {
        agentTerminalHandle: HANDLE,
        workerState: 'running',
        dispatchStatus: 'dispatched',
        taskId: 't1',
        runId: 'r1',
        dispatchId: 'd1',
      },
    ]),
    'task-list': taskList([{ id: 't1', spec: '[omp model=@default]' }]),
  });

  test('the dispatched session IS retuned', async () => {
    const { pi, handlers, applied, ctx } = host(PARENT_FILE);
    orcaModel(pi as never, { handle: HANDLE, run: liveDispatch });
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    expect(applied).toHaveLength(1);
  });

  test('a subagent of that session is NOT retuned to the parent marker', async () => {
    const { pi, handlers, applied, ctx } = host(CHILD_FILE);
    orcaModel(pi as never, { handle: HANDLE, run: liveDispatch });
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
    expect(applied).toEqual([]);
  });
});

/**
 * The role applier, driven the way the host actually calls it.
 *
 * Helper-level tests are not enough here and this file already paid for that
 * lesson: the first version of this extension had a green suite and was a total
 * no-op because nothing exercised the wiring. So these drive the default export,
 * return a real `before_agent_start` event carrying a base prompt, and assert on
 * what the handler hands back to the host.
 */
describe('the role reaches the session, appended', () => {
  const BASE = ['OMP BASE PROMPT', 'TOOL POLICY'];
  const SUPERVISOR_BODY = '# Personality\nYou own a slice end to end and never touch it.';

  /**
   * The role table is handed to the factory through its `loadRole` seam, NOT
   * through `pi.pi.discoverAgents`.
   *
   * That is the migration these tests had to follow rather than merely survive.
   * Injecting a fake `discoverAgents` was injecting the host coupling itself, so
   * a suite built that way stays green after the coupling is removed and proves
   * nothing about what replaced it. `roles.test.ts` drives the real loader
   * against real files on disk; everything here drives the APPLIER, which is
   * what these tests were always about.
   */
  function host(
    spec: string,
    sessionFile: string,
    agents: { name: string; systemPrompt: string; autoloadSkills?: string[] }[],
    options: {
      /** Playbook names this package is pretending to ship. */
      playbooks?: string[];
      failRoleLoad?: boolean;
      failToolLock?: boolean;
    } = {},
  ) {
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const commands = new Map<string, { handler(a: unknown, c: unknown): unknown }>();
    const activeTools: string[][] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: () => {},
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: () => {} },
      registerCommand: (name: string, spec2: { handler(a: unknown, c: unknown): unknown }) => {
        commands.set(name, spec2);
      },
      getAllTools: () => [{ name: 'read' }, { name: 'bash' }],
      setActiveTools(names: string[]) {
        activeTools.push(names);
        if (options.failToolLock) throw new Error('runtime refused the lock');
      },
      // Only the fleet's configured model roles remain on this surface. No agent
      // loader, no skill loader — the package resolves both itself.
      pi: {},
    };
    const known = options.playbooks ?? ['orca-sessions'];
    orcaModel(pi as never, {
      handle: HANDLE,
      loadRole: async (name: string) => {
        if (options.failRoleLoad) throw new Error('role file unreadable');
        const found = agents.find((agent) => agent.name === name);
        return found === undefined
          ? { role: null as never, reason: 'role-not-found' as const, detail: `no role \`${name}\`` }
          : { role: found, reason: 'ok' as const, detail: '' as const };
      },
      loadPlaybook: async (name: string) =>
        known.includes(name)
          ? {
              content: `<playbook name="${name}">A PEER CANNOT WAKE ITSELF</playbook>`,
              reason: 'ok' as const,
              detail: '' as const,
            }
          : {
              content: null as never,
              reason: 'playbook-not-found' as const,
              detail: `this package ships no playbook \`${name}\``,
            },
      run: fakeRunner({
        'worker-list': workerList([
          {
            agentTerminalHandle: HANDLE,
            workerState: 'running',
            dispatchStatus: 'dispatched',
            taskId: 't1',
            runId: 'r1',
            dispatchId: 'd1',
          },
        ]),
        'task-list': taskList([{ id: 't1', spec }]),
      }),
    });
    const ctx = {
      models: { resolve: (s: string) => ({ provider: 'stub', id: s }) },
      sessionManager: { getSessionFile: () => sessionFile },
      cwd: '/Users/flo/.omp',
    };
    return { handlers, commands, ctx, activeTools };
  }

  const PARENT = '/Users/flo/.omp/agent/sessions/-.omp/2026-08-07T09-00-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e99.jsonl';
  const CHILD = '/Users/flo/.omp/agent/sessions/-.omp/2026-08-07T09-00-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e99/Worker.jsonl';
  const AGENTS = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY }];

  test('the marker names a role and the body is APPENDED to the base', async () => {
    const { handlers, ctx } = host('[omp role=supervisor model=@default]', PARENT, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { systemPrompt?: string[] } | undefined;

    expect(out?.systemPrompt?.slice(0, 2)).toEqual(BASE);
    expect(out?.systemPrompt).toHaveLength(3);
    expect(out?.systemPrompt?.[2]).toContain('never touch it');
  });

  test('a role never substitutes for an unavailable OMP base prompt', async () => {
    const { handlers, ctx, activeTools } = host('[omp role=supervisor model=@default]', PARENT, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start' },
      ctx,
    )) as {
      systemPrompt?: string[];
      message?: { customType?: string; details?: { reason?: string } };
    } | undefined;

    expect(activeTools).toEqual([[]]);
    expect(out?.systemPrompt).toHaveLength(1);
    expect(out?.systemPrompt?.[0]).not.toContain(SUPERVISOR_BODY);
    expect(out?.message).toMatchObject({
      customType: 'role-refused',
      details: { reason: 'role-prompt-unavailable' },
    });
  });

  test('re-asserting every turn does not accumulate copies', async () => {
    const { handlers, ctx } = host('[omp role=supervisor model=@default]', PARENT, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    let prompt = BASE;
    for (let turn = 0; turn < 5; turn += 1) {
      const out = (await handlers.get('before_agent_start')?.(
        { type: 'before_agent_start', systemPrompt: prompt },
        ctx,
      )) as { systemPrompt?: string[] } | undefined;
      prompt = out?.systemPrompt ?? prompt;
    }
    expect(prompt).toHaveLength(3);
  });

  test('a subagent of that session gets NO role', async () => {
    const { handlers, ctx } = host('[omp role=supervisor model=@default]', CHILD, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    );
    expect(out).toBeUndefined();
  });

  test('a subagent gets no role even when one was activated by /role', async () => {
    // Isolates the ROLE guard. The subagent test above passes even without it,
    // because the MODEL guard leaves taskSpec null — so it proves the wrong
    // thing. Going through /role sets the role without touching taskSpec, which
    // is the only way to exercise the role path's own boundary (R4a / KD11).
    const { handlers, commands, ctx } = host('[omp model=@default]', CHILD, AGENTS);
    await commands.get('role')?.handler('supervisor', ctx);
    const out = await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    );
    expect(out).toBeUndefined();
  });

  test('no role= in the marker leaves the prompt alone', async () => {
    const { handlers, ctx } = host('[omp model=@default]', PARENT, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    );
    expect(out).toBeUndefined();
  });

  test('a named role that does not exist locks every tool before the first turn', async () => {
    const { handlers, ctx, activeTools } = host('[omp role=ghost model=@default]', PARENT, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as {
      systemPrompt?: string[];
      message?: { customType?: string; details?: { role?: string; reason?: string } };
    } | undefined;

    expect(activeTools).toEqual([[]]);
    expect(out?.systemPrompt?.at(-1)).toContain('DO NOT execute the assignment');
    expect(out?.message).toMatchObject({
      customType: 'role-refused',
      details: { role: 'ghost', reason: 'role-not-found' },
    });
    expect(await handlers.get('tool_call')?.({ toolName: 'bash' }, ctx)).toMatchObject({ block: true });
  });

  test('a rejected role-loader promise locks the session instead of escaping the handler', async () => {
    const { handlers, ctx, activeTools } = host(
      '[omp role=supervisor model=@default]',
      PARENT,
      AGENTS,
      { failRoleLoad: true },
    );
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { message?: { customType?: string; details?: { reason?: string } } } | undefined;

    expect(activeTools).toEqual([[]]);
    expect(out?.message).toMatchObject({
      customType: 'role-refused',
      details: { reason: 'role-load-failed' },
    });
    expect(await handlers.get('tool_call')?.({ toolName: 'bash' }, ctx)).toMatchObject({ block: true });
  });

  test('/role applies to the operator session, and /role off clears it', async () => {
    const { handlers, commands, ctx } = host('[omp model=@default]', PARENT, AGENTS);
    const role = commands.get('role');
    expect(role).toBeDefined();

    await role?.handler('supervisor', ctx);
    const applied = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { systemPrompt?: string[] } | undefined;
    expect(applied?.systemPrompt).toHaveLength(3);

    await role?.handler('off', ctx);
    const cleared = await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    );
    expect(cleared).toBeUndefined();
  });

  /**
   * A role that DECLARES `autoloadSkills` must actually receive them.
   *
   * This gap shipped once: both role files declared `autoloadSkills:
   * orca-sessions`, the plan named preload as the mechanism that hands a role
   * its hidden skills, and the applier returned only `systemPrompt`. The field
   * parsed, so nothing looked wrong. `orca-sessions` carries
   * `disable-model-invocation: true`, so it is absent from the prompt's skill
   * list — meaning the role silently lacked the one body it asked for.
   */
  const WITH_SKILLS = [
    { name: 'supervisor', systemPrompt: SUPERVISOR_BODY, autoloadSkills: ['orca-sessions'] },
  ];

  test('a role that declares autoloadSkills receives their bodies', async () => {
    const { handlers, ctx } = host('[omp role=supervisor model=@default]', PARENT, WITH_SKILLS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { systemPrompt?: string[]; message?: { content?: string } } | undefined;

    expect(out?.systemPrompt).toHaveLength(3);
    expect(out?.message?.content).toContain('A PEER CANNOT WAKE ITSELF');
  });

  test('the skill bodies arrive once, not once per turn', async () => {
    // The role block is rebuilt from a fresh base every turn, so appending it is
    // free. A MESSAGE is not: it persists in the conversation, so re-sending it
    // each turn would grow the history by a skill body per turn.
    const { handlers, ctx } = host('[omp role=supervisor model=@default]', PARENT, WITH_SKILLS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const seen: unknown[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      const out = (await handlers.get('before_agent_start')?.(
        { type: 'before_agent_start', systemPrompt: BASE },
        ctx,
      )) as { message?: unknown } | undefined;
      if (out?.message !== undefined) seen.push(out.message);
    }
    expect(seen).toHaveLength(1);
  });

  test('a role that declares no skills sends no message', async () => {
    const { handlers, ctx } = host('[omp role=supervisor model=@default]', PARENT, AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { message?: unknown } | undefined;
    expect(out?.message).toBeUndefined();
  });

  test('a missing autoload skill locks every tool before the first turn', async () => {
    const ghost = [
      { name: 'supervisor', systemPrompt: SUPERVISOR_BODY, autoloadSkills: ['no-such-skill'] },
    ];
    const { handlers, ctx, activeTools } = host(
      '[omp role=supervisor model=@default]',
      PARENT,
      ghost,
      { playbooks: [] },
    );
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as {
      systemPrompt?: string[];
      message?: { customType?: string; details?: { reason?: string; missingSkills?: string[] } };
    } | undefined;

    expect(activeTools).toEqual([[]]);
    expect(out?.systemPrompt?.at(-1)).toContain('DO NOT execute the assignment');
    expect(out?.message).toMatchObject({
      customType: 'role-refused',
      details: { reason: 'skill-not-found', missingSkills: ['no-such-skill'] },
    });
    expect(await handlers.get('tool_call')?.({ toolName: 'write' }, ctx)).toMatchObject({ block: true });
  });

  test('the tool-call fence survives a runtime that refuses to hide its tools', async () => {
    const { handlers, ctx } = host(
      '[omp role=ghost model=@default]',
      PARENT,
      AGENTS,
      { failToolLock: true },
    );
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    );
    expect(await handlers.get('tool_call')?.({ toolName: 'bash' }, ctx)).toMatchObject({ block: true });
  });

  /**
   * A role that declares `tools:` narrows the session — under one hard guard.
   *
   * KD10 removed tool application because a `tools:` list REPLACES the whole
   * active surface and drops what it does not name: measured, seven names
   * requested against 51 left four, `bash` among the casualties, and the
   * narrowed session answered "I have no bash/shell execution tool available".
   * That severs the report channel, which R7 says is never behind a role
   * restriction, in any role, ever.
   *
   * So the field comes back only with the guard the measurement demanded: a
   * list that does not carry the report channel is REFUSED whole, and every
   * requested name the registry does not know is named in the log rather than
   * dropped in silence.
   */
  const REPORT_CHANNEL = 'bash';

  function toolHost(
    spec: string,
    agents: { name: string; systemPrompt: string; tools?: string[] }[],
    failInitially = false,
  ) {
    // Mutable so a test can make the SAME session fail once and then succeed —
    // the only way to prove the latch is set on success rather than on attempt.
    const fail = { value: failInitially };
    const applied: string[][] = [];
    const warned: string[] = [];
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const pi = {
      on: (e: string, h: (a: unknown, b: unknown) => unknown) => { handlers.set(e, h); },
      setModel: () => {},
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: (m: string) => { warned.push(m); } },
      registerCommand: () => {},
      getAllTools: () => [{ name: 'read' }, { name: 'grep' }, { name: 'bash' }, { name: 'task' }, { name: 'edit' }],
      // A METHOD, not an arrow: it reads `this`, exactly like the real
      // `ExtensionAPIImpl.setActiveTools` reads `this.runtime`. An arrow-shaped
      // fake accepts a detached call and would have passed while production
      // threw — which is precisely what happened before this line existed.
      setActiveTools(this: { readonly receiver: symbol }, names: string[]) {
        if (this?.receiver === undefined) throw new TypeError('setActiveTools called without its receiver');
        if (fail.value) throw new Error('runtime refused the surface');
        applied.push(names);
        return Promise.resolve();
      },
      receiver: Symbol('pi'),
      pi: {},
    };
    orcaModel(pi as never, {
      handle: HANDLE,
      loadRole: async (name: string) => {
        const found = agents.find((agent) => agent.name === name);
        return found === undefined
          ? { role: null as never, reason: 'role-not-found' as const, detail: `no role \`${name}\`` }
          : { role: found, reason: 'ok' as const, detail: '' as const };
      },
      run: fakeRunner({
        'worker-list': workerList([
          { agentTerminalHandle: HANDLE, workerState: 'running', dispatchStatus: 'dispatched', taskId: 't1', runId: 'r1', dispatchId: 'd1' },
        ]),
        'task-list': taskList([{ id: 't1', spec }]),
      }),
    });
    const ctx = {
      models: { resolve: (s: string) => ({ provider: 'stub', id: s }) },
      sessionManager: { getSessionFile: () => PARENT },
      cwd: '/Users/flo/.omp',
    };
    return { handlers, ctx, applied, warned, fail };
  }

  test('a role that declares tools narrows the session to exactly that list', async () => {
    const strict = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY, tools: ['read', 'grep', REPORT_CHANNEL, 'task'] }];
    const { handlers, ctx, applied } = toolHost('[omp role=supervisor model=@default]', strict);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: BASE }, ctx);

    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual(['read', 'grep', 'bash', 'task']);
    expect(applied[0]).not.toContain('edit');
  });

  test('a tools list without the report channel is refused whole, and says so', async () => {
    // The exact shape that muzzled a worker in D-027, arriving from the equip
    // side. Applying it partially would be worse than refusing: the session
    // would look narrowed and be unable to report.
    const muzzled = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY, tools: ['read', 'grep', 'task'] }];
    const { handlers, ctx, applied, warned } = toolHost('[omp role=supervisor model=@default]', muzzled);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { systemPrompt?: string[] } | undefined;

    expect(applied).toHaveLength(0);
    expect(warned.join(' ')).toContain('report channel');
    // The role itself still applies: a bad tool list never stops a session (R5).
    expect(out?.systemPrompt).toHaveLength(3);
  });

  test('a requested tool the registry does not know is named, not dropped in silence', async () => {
    const typo = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY, tools: ['read', REPORT_CHANNEL, 'task', 'nosuchtool'] }];
    const { handlers, ctx, applied, warned } = toolHost('[omp role=supervisor model=@default]', typo);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: BASE }, ctx);

    expect(applied[0]).toEqual(['read', 'bash', 'task', 'nosuchtool']);
    expect(warned.join(' ')).toContain('nosuchtool');
  });

  test('a role with no tools list leaves the surface alone', async () => {
    const { handlers, ctx, applied } = toolHost('[omp role=supervisor model=@default]', AGENTS);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: BASE }, ctx);
    expect(applied).toHaveLength(0);
  });

  test('the narrowing happens once, not once per turn', async () => {
    const strict = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY, tools: ['read', REPORT_CHANNEL, 'task'] }];
    const { handlers, ctx, applied } = toolHost('[omp role=supervisor model=@default]', strict);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    for (let turn = 0; turn < 3; turn += 1) {
      await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: BASE }, ctx);
    }
    expect(applied).toHaveLength(1);
  });

  test('an apply that throws is named, and the role body still reaches the session', async () => {
    // The failure that cost a whole experiment arm: the narrowing threw, the
    // handler died before its return, and the session ran with neither the tool
    // surface nor the role body — with one missing log line as the only tell.
    const strict = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY, tools: ['read', REPORT_CHANNEL, 'task'] }];
    const { handlers, ctx, applied, warned } = toolHost('[omp role=supervisor model=@default]', strict, true);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    const out = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', systemPrompt: BASE },
      ctx,
    )) as { systemPrompt?: string[] } | undefined;

    expect(applied).toHaveLength(0);
    expect(warned.join(' ')).toContain('apply failed');
    expect(out?.systemPrompt).toHaveLength(3);
  });

  test('a failed narrowing is retried on the next turn, not latched as done', async () => {
    // Latching on the attempt rather than on success is the `settled = true`
    // defect audited in this very file on 2026-08-07: one transient failure
    // would leave the session permanently unconstrained.
    //
    // One session, one host, the failure flipped between turns. An earlier
    // version of this test built a SECOND host for the second turn, which
    // exercises a fresh latch and therefore proves nothing — the mutation
    // `toolsSetFor = name` before the apply left it green.
    const strict = [{ name: 'supervisor', systemPrompt: SUPERVISOR_BODY, tools: ['read', REPORT_CHANNEL, 'task'] }];
    const { handlers, ctx, applied, fail } = toolHost('[omp role=supervisor model=@default]', strict, true);
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);

    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: BASE }, ctx);
    expect(applied).toHaveLength(0);

    fail.value = false;
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: BASE }, ctx);
    expect(applied).toEqual([['read', 'bash', 'task']]);
  });
});
