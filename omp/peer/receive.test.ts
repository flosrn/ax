/**
 * CAUGHT VERSUS UNHANDLED, which is the whole point of this file.
 *
 * A throw anywhere inside the receive loop must be absorbed into a retry. It
 * must NOT escape the detached promise: OMP's postmortem handler treats an
 * unhandled rejection as fatal, and the measured consequence is the session
 * exiting with code 1 while the operator is mid-turn. `d3e6d1a` fixed exactly
 * that and shipped claiming the existing peer tests covered it — they did not,
 * because `loop` was module-private. Reverting the fix left the suite 58/58
 * green. These tests are the cover that claim needed.
 *
 * No Orca, no credentials, no clock: `createReceiver` takes its spawn, its
 * parser and its timer from the caller, so every branch is reachable with
 * plain objects.
 */

import { expect, test } from 'bun:test';

import {
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  createReceiver,
  startReceiverIfOwned,
  type ReceiveDeps,
} from './receive.ts';

// HOW AN ESCAPE IS DETECTED. Not by a `process.on('unhandledRejection')`
// listener: measured against the pre-fix reconstruction, bun 1.3.14 claims the
// rejection first and such a listener never fires. Bun reports it itself, as a
// test-level `error:` — which is precisely the fatal treatment OMP's postmortem
// handler gives it. So the escape shows up as a failing test on its own, and
// what these tests assert on top of that is the recovery the fix added: the
// `receive loop threw` note, and a retry scheduled.

/**
 * Yield twice to the macrotask queue.
 *
 * EXCEPTION to "no real timers in tests": this is not a tuned delay, it is a
 * zero-millisecond queue turn. An unhandled rejection is only reported once the
 * microtask queue is exhausted, so `await Promise.resolve()` would let the very
 * defect under test pass unnoticed. Fake timers cannot help — they would
 * replace the queue whose real behaviour is the thing being observed.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
}

type Retry = { fn: () => void; ms: number };

/** A child whose streams are plain strings — `new Response` accepts those. */
function fakeChild(stdout: string, stderr = '') {
  return {
    stdout,
    stderr,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill() {},
    unref() {},
  };
}

/**
 * A `check --wait` that failed. Every iteration served this one ends in a
 * scheduled retry rather than the microtask fast path, so a fake spawn cannot
 * spin forever inside a single `settle()`.
 */
const WAIT_FAILED = '{"ok":false,"error":{"code":"unreachable"}}';

function harness(overrides: Partial<ReceiveDeps> = {}) {
  const notes: string[] = [];
  const health: boolean[] = [];
  const spawned: string[][] = [];
  const injected: string[] = [];
  const retries: Retry[] = [];
  const sent: Record<string, unknown>[] = [];
  const timers = {
    setTimeout(fn: () => void, ms: number) {
      retries.push({ fn, ms });
      return { unref() {} };
    },
  };
  const pi = {
    sendMessage(msg: Record<string, unknown>) {
      sent.push(msg);
    },
  };

  const deps: ReceiveDeps = {
    orca: 'orca',
    runId: () => 'run_test',
    spawn: (argv) => {
      spawned.push(argv);
      return fakeChild(WAIT_FAILED);
    },
    sh: () => '{"ok":true}',
    parse: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    note: (line) => notes.push(line),
    reportHealth: (_pi, healthy) => health.push(healthy),
    senderIdentity: () => ({ name: 'peer', model: 'm', attributed: true }),
    peerContent: () => 'body',
    wasInjected: () => false,
    rememberInjected: (id) => injected.push(id),
    compactInjected: () => {},
    recordRoute: () => {},
    ...overrides,
  };

  return { deps, notes, health, spawned, injected, retries, sent, timers, pi };
}

/** A receiver whose lifecycle calls are recorded in order. */
function recordingReceiver(calls: string[]) {
  return {
    useTimers() {
      calls.push('timers');
    },
    start() {
      calls.push('start');
    },
    stop() {},
  };
}

test('a LIVE foreign owner blocks a second receiver and visibly disables this one', () => {
  const calls: string[] = [];

  expect(
    startReceiverIfOwned({ published: false, refused: 'foreign' }, recordingReceiver(calls), {}, {}, {
      onUnavailable: () => calls.push('disabled'),
      beforeStart: () => calls.push('load'),
    }),
  ).toBe(false);
  expect(calls).toEqual(['disabled']);
});

// The distinction this file exists to keep. `foreign` proves a live session owns
// the handle's entry, so consuming its Run would race it. `invalid` is the
// registry WRITE failing — nobody else owns this Run, and the loop consumes the
// Run from `ensureRun`, not from the registry. Refusing to receive there would
// turn an addressing failure into the deaf channel this fence exists to prevent.
test('an unwritable registry still receives, rather than becoming deaf', () => {
  const calls: string[] = [];

  expect(
    startReceiverIfOwned({ published: false, refused: 'invalid' }, recordingReceiver(calls), {}, {}, {
      onUnavailable: () => calls.push('disabled'),
      beforeStart: () => calls.push('load'),
    }),
  ).toBe(true);
  expect(calls).toEqual(['load', 'timers', 'start']);
});

test('the registry owner loads its replay window and installs timers BEFORE starting', () => {
  const calls: string[] = [];

  expect(
    startReceiverIfOwned({ published: true }, recordingReceiver(calls), {}, {}, {
      onUnavailable: () => calls.push('disabled'),
      beforeStart: () => calls.push('load'),
    }),
  ).toBe(true);
  // Order is the assertion: a delivery replayed by Orca must be deduplicated
  // against the durable window, so the window is loaded before the loop runs.
  expect(calls).toEqual(['load', 'timers', 'start']);
});

test('a throw in the synchronous section is caught and retried', async () => {
  const h = harness({
    spawn: () => {
      throw new Error('spawn refused');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  await settle();
  r.stop();

  expect(
    h.notes.some((n) => n.includes('spawn failed: Error: spawn refused')),
  ).toBe(true);
  expect(h.health).toEqual([false]);
  expect(h.retries).toHaveLength(1);
});

test('a throw in the detached async section is caught, not left unhandled', async () => {
  // `parse` runs after the awaits, in the region the pre-fix code left bare:
  // between the guarded read and the guarded per-message loop.
  const h = harness({
    parse: () => {
      throw new Error('parse exploded');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  await settle();
  r.stop();

  // Red on the pre-fix code twice over: bun reports the escaped rejection as an
  // error against this test, and the recovery note below is never written.
  expect(
    h.notes.some((n) => n.includes('receive loop threw: Error: parse exploded')),
  ).toBe(true);
  expect(h.health).toEqual([false]);
  expect(h.retries).toHaveLength(1);
});

test('a throw while announcing health is caught, not left unhandled', async () => {
  // The other half of the same bare region: `reportHealth` is reached after the
  // awaits and outside every inner try block.
  let calls = 0;
  const h = harness({
    reportHealth: () => {
      calls += 1;
      if (calls === 1) throw new Error('announce exploded');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  await settle();
  r.stop();

  expect(
    h.notes.some((n) =>
      n.includes('receive loop threw: Error: announce exploded'),
    ),
  ).toBe(true);
  expect(h.retries).toHaveLength(1);
});

test('stop() short-circuits the loop and a retry already pending', async () => {
  const h = harness({
    spawn: () => {
      throw new Error('down');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  await settle();
  expect(h.retries).toHaveLength(1);

  r.stop();
  // The scheduled callback still fires — shutdown does not reach into a timer
  // already queued — so the guard has to be inside the loop itself.
  h.retries[0].fn();
  await settle();
  expect(h.retries).toHaveLength(1);

  // And a fresh start after shutdown must do nothing at all.
  h.spawned.length = 0;
  r.start(h.pi);
  await settle();
  expect(h.spawned).toEqual([]);
});

test('the retry delay doubles and clamps at RETRY_MAX_MS', async () => {
  const h = harness({
    spawn: () => {
      throw new Error('down');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  for (let i = 0; i < 8; i += 1) {
    await settle();
    h.retries[h.retries.length - 1].fn();
  }
  await settle();
  r.stop();

  const delays = h.retries.map((x) => x.ms);
  expect(delays.slice(0, 3)).toEqual([
    RETRY_MIN_MS,
    RETRY_MIN_MS * 2,
    RETRY_MIN_MS * 4,
  ]);
  // Unbounded doubling passes four minutes between attempts within nine
  // failures, which is indistinguishable from a dead receiver.
  expect(Math.max(...delays)).toBe(RETRY_MAX_MS);
  expect(delays[delays.length - 1]).toBe(RETRY_MAX_MS);
});

test('a completed delivery resets the delay to RETRY_MIN_MS', async () => {
  // Backoff that survived a success would leave a healthy receiver waiting a
  // minute after one blip.
  let attempt = 0;
  const h = harness({
    spawn: () => {
      attempt += 1;
      // The third attempt succeeds with an empty delivery; the fourth — taken
      // immediately over the microtask fast path — fails again.
      if (attempt === 3)
        return fakeChild('{"ok":true,"result":{"messages":[]}}');
      throw new Error('down');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  await settle();
  h.retries[0].fn();
  await settle();
  expect(h.retries.map((x) => x.ms)).toEqual([RETRY_MIN_MS, RETRY_MIN_MS * 2]);

  h.retries[1].fn();
  await settle();
  r.stop();

  expect(h.retries).toHaveLength(3);
  expect(h.retries[2].ms).toBe(RETRY_MIN_MS);
});

test("the host's managed setTimeout is preferred over a raw timer", () => {
  const h = harness({
    spawn: () => {
      throw new Error('down');
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  const rawCalls: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    rawCalls.push(ms);
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  try {
    // The spawn throws synchronously, so the retry is scheduled before this
    // returns and the patched global is never live across an await.
    r.start(h.pi);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  r.stop();

  expect(h.retries.map((x) => x.ms)).toEqual([RETRY_MIN_MS]);
  // A throw inside a RAW timer callback exits the whole session with code 1
  // (measured in an `omp --mode rpc` sandbox), which is why the host's managed
  // timer must win whenever it supplied one.
  expect(rawCalls).toEqual([]);
});

test("without a host ctx the raw fallback timer is unref'd", () => {
  const h = harness({
    spawn: () => {
      throw new Error('down');
    },
  });
  // No `useTimers`: the window between module load and `session_start`.
  const r = createReceiver(h.deps);

  let unrefs = 0;
  const seen: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((_fn: () => void, ms: number) => {
    seen.push(ms);
    // Deliberately never scheduled: the retry it would run is not what this
    // test is about, and a real 2s timer would outlive the test.
    return { unref: () => (unrefs += 1) };
  }) as typeof setTimeout;
  try {
    r.start(h.pi);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  r.stop();

  expect(seen).toEqual([RETRY_MIN_MS]);
  // Left ref'd, a 60s retry timer keeps the process alive after the session
  // that owned it is gone.
  expect(unrefs).toBe(1);
});

test('a directed message is injected once and its delivery acked', async () => {
  const acks: string[][] = [];
  let attempt = 0;
  const h = harness({
    sh: (argv) => {
      acks.push(argv);
      return '{"ok":true}';
    },
    spawn: () => {
      attempt += 1;
      if (attempt > 1) return fakeChild(WAIT_FAILED);
      return fakeChild(
        JSON.stringify({
          ok: true,
          result: {
            deliveryId: 'd1',
            messages: [{ id: 'm1', type: 'status', body: 'hi' }],
          },
        }),
      );
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);

  r.start(h.pi);
  await settle();
  r.stop();

  expect(h.sent).toHaveLength(1);
  // `role: "custom"`, not `role: "user"` — the boundary that keeps a peer from
  // wearing the operator's role.
  expect(h.sent[0].customType).toBe('peer-message');
  expect(h.injected).toEqual(['m1']);
  expect(acks[0]).toContain('--ack');
});

/**
 * Build one relay message asking the receiver to forward to `target`, and
 * report whether the relay was sent or refused.
 *
 * A relay target and a reply route land in the identical
 * `orca orchestration send --to` argv. Until 2026-08-11 they were validated by
 * two different patterns and only the reply route was length-capped, so this
 * pins the accept/reject boundary rather than the happy path.
 */
async function relayTo(target: string) {
  const relayed: string[][] = [];
  let attempt = 0;
  const h = harness({
    sh: (argv) => {
      relayed.push(argv);
      return '{"ok":true}';
    },
    spawn: () => {
      attempt += 1;
      if (attempt > 1) return fakeChild(WAIT_FAILED);
      return fakeChild(
        JSON.stringify({
          ok: true,
          result: {
            deliveryId: 'd1',
            messages: [
              {
                id: 'm1',
                type: 'peer',
                payload: JSON.stringify({ forwardTo: target, text: 'x' }),
              },
            ],
          },
        }),
      );
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);
  r.start(h.pi);
  await settle();
  r.stop();

  return {
    refused: h.notes.some((n) => n.includes('forward REFUSED')),
    sentTo: relayed.some((argv) => argv.includes(target)),
  };
}

test('a relay target is held to the same shape as a reply route', async () => {
  const ok = await relayTo(`run:${'a'.repeat(64)}`);
  expect(ok.refused).toBe(false);

  // 65 characters. Accepted by the uncapped pattern the relay branch used
  // before, refused by RUN_ADDRESS - which is the whole point of one shape.
  const tooLong = await relayTo(`run:${'a'.repeat(65)}`);
  expect(tooLong.refused).toBe(true);
  expect(tooLong.sentTo).toBe(false);

  // Still refused for the reasons both patterns already agreed on.
  for (const bad of ['notrun:abc', 'run:has space', 'run:semi;colon']) {
    expect((await relayTo(bad)).refused).toBe(true);
  }

  // An empty forwardTo is not a malformed relay, it is no relay at all: the
  // branch is never entered, so there is nothing to refuse.
  const absent = await relayTo('');
  expect(absent.refused).toBe(false);
  expect(absent.sentTo).toBe(false);
});

test('a failed relay is neither remembered nor acknowledged, so backoff can retry it', async () => {
  let call = 0;
  const h = harness({
    senderIdentity: () => ({ name: 'witnessed', model: '', attributed: true, kind: 'pane' }),
    spawn: () => {
      call += 1;
      if (call === 1) {
        return fakeChild(JSON.stringify({
          ok: true,
          result: {
            deliveryId: 'delivery-relay',
            messages: [{ id: 'relay-1', type: 'peer', payload: JSON.stringify({ forwardTo: A_RUN }) }],
          },
        }));
      }
      return fakeChild('{\"ok\":false}', 'runtime unavailable');
    },
  });
  const receiver = createReceiver(h.deps);
  receiver.useTimers(h.timers);
  receiver.start(h.pi);
  await settle();
  receiver.stop();

  expect(h.injected).toEqual([]);
  expect(h.notes.join('\\n')).toContain('forward relay failed');
  expect(h.notes.join('\\n')).toContain('ack withheld for delivery-relay');
  expect(h.retries).toHaveLength(1);
});

/**
 * BEING NAMED IS NOT BEING AUTHORISED.
 *
 * A worker we dispatched arrives with no pane key by contract and is named from
 * our own write-ahead record, so it is `attributed` — which is what makes these
 * two fences necessary rather than obvious. Both grant a capability, and neither
 * should follow from a name: the relay lends this session's verified origin to a
 * re-post, and a recorded route is an ADDRESS taken from a payload that travelled
 * over the relay.
 *
 * `relayTo` above cannot pin this: its identity is pane-attributed.
 */
async function deliverAs(
  identity: { name: string; attributed: boolean; kind?: 'pane' | 'dispatch' },
  payload: Record<string, unknown>,
) {
  const relayed: string[][] = [];
  const routes: string[] = [];
  let attempt = 0;
  const h = harness({
    senderIdentity: () => ({ model: '', ...identity }),
    recordRoute: (id) => routes.push(id),
    // The relay goes out through `spawn`, not `sh`, and the branch calls
    // `.unref()` on what it gets back — a stub without one lands in the relay's
    // own catch and looks like a refusal. That is why the older `relayTo` never
    // asserted a successful send.
    spawn: (argv) => {
      attempt += 1;
      relayed.push(argv);
      if (attempt > 1) return Object.assign(fakeChild(WAIT_FAILED), { unref() {} });
      return Object.assign(
        fakeChild(
          JSON.stringify({
            ok: true,
            result: {
              deliveryId: 'd1',
              messages: [{ id: 'm1', type: 'peer', payload: JSON.stringify(payload) }],
            },
          }),
        ),
        { unref() {} },
      );
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);
  r.start(h.pi);
  await settle();
  r.stop();
  return { notes: h.notes, relayed, routes, sent: h.sent };
}

const DISPATCH_SENDER = { name: 'child:probe-marker-3', attributed: true, kind: 'dispatch' as const };
const PANE_SENDER = { name: 'ws-1876', attributed: true, kind: 'pane' as const };
const A_RUN = `run:${'a'.repeat(20)}`;

test('a dispatch sender may not borrow this session authority to relay', async () => {
  const out = await deliverAs(DISPATCH_SENDER, { forwardTo: A_RUN, text: 'x' });
  expect(out.notes.some((n) => n.includes('forward REFUSED: dispatch sender'))).toBe(true);
  expect(out.relayed.some((argv) => argv.includes(A_RUN))).toBe(false);

  // The control: the same relay, from a witnessed pane, still goes through. A
  // fence that refuses everything would pass the assertion above and break the
  // feature it guards.
  const pane = await deliverAs(PANE_SENDER, { forwardTo: A_RUN, text: 'x' });
  expect(pane.notes.some((n) => n.includes('forward REFUSED'))).toBe(false);
  expect(pane.relayed.some((argv) => argv.includes(A_RUN))).toBe(true);
});

test('a dispatch sender may not hand this session a reply address', async () => {
  const out = await deliverAs(DISPATCH_SENDER, { replyTo: A_RUN });
  expect(out.routes).toEqual([]);
  // It is still DELIVERED — refusing the address must not silence the worker.
  expect(out.sent).toHaveLength(1);

  const pane = await deliverAs(PANE_SENDER, { replyTo: A_RUN });
  expect(pane.routes).toEqual(['m1']);
});

test('a dispatch route is DERIVED, and its own payload is not consulted', async () => {
  // The worker's payload names a Run it would like the answer sent to. It travelled the
  // relay, so it is exactly the field a hostile payload would want kept. The route must come
  // from the resolver instead — and the resolver's answer must be what is recorded.
  const routes: Array<{ id: string; route: Record<string, unknown> }> = [];
  let attempt = 0;
  const h = harness({
    senderIdentity: () => ({
      name: 'child:probe-mail',
      model: '',
      attributed: true,
      kind: 'dispatch',
    }),
    deriveRoute: () => ({
      run: `run:${'d'.repeat(20)}`,
      peer: 'child:probe-mail',
      environment: 'gapicore',
    }),
    recordRoute: (id, route) => routes.push({ id, route }),
    spawn: () => {
      attempt += 1;
      if (attempt > 1) return Object.assign(fakeChild(WAIT_FAILED), { unref() {} });
      return Object.assign(
        fakeChild(
          JSON.stringify({
            ok: true,
            result: {
              deliveryId: 'd1',
              messages: [
                {
                  id: 'm1',
                  type: 'worker_done',
                  payload: JSON.stringify({ replyTo: `run:${'a'.repeat(20)}` }),
                },
              ],
            },
          }),
        ),
        { unref() {} },
      );
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);
  r.start(h.pi);
  await settle();
  r.stop();

  expect(routes).toHaveLength(1);
  expect(routes[0]?.route).toEqual({
    run: `run:${'d'.repeat(20)}`,
    peer: 'child:probe-mail',
    environment: 'gapicore',
  });
});

test('a resolver that cannot establish the address records nothing, and says so', async () => {
  const routes: string[] = [];
  let attempt = 0;
  const h = harness({
    senderIdentity: () => ({ name: 'child:x', model: '', attributed: true, kind: 'dispatch' }),
    deriveRoute: () => null,
    recordRoute: (id) => routes.push(id),
    spawn: () => {
      attempt += 1;
      if (attempt > 1) return Object.assign(fakeChild(WAIT_FAILED), { unref() {} });
      return Object.assign(
        fakeChild(
          JSON.stringify({
            ok: true,
            result: {
              deliveryId: 'd1',
              messages: [
                { id: 'm1', type: 'worker_done', payload: JSON.stringify({ replyTo: `run:${'a'.repeat(20)}` }) },
              ],
            },
          }),
        ),
        { unref() {} },
      );
    },
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);
  r.start(h.pi);
  await settle();
  r.stop();

  expect(routes).toEqual([]);
  expect(h.notes.some((n) => n.includes('no reply route derived for child:x'))).toBe(true);
  // Still delivered: refusing an address must not silence the worker.
  expect(h.sent).toHaveLength(1);
  // And the delivery SAYS it cannot be answered. Measured 2026-08-25 on ofmchat
  // #55: an orchestrator answered a load-bearing escalation from a worker whose
  // capability Orca had revoked, was refused by `peer_reply`, and only then went
  // looking for a route by hand. A note on the log is not the reader's channel.
  expect(String(h.sent[0]?.content ?? '')).toContain('[NO REPLY ROUTE]');
});

test('a message this session sent itself is dropped, a peer\'s is not', async () => {
  // Measured 2026-08-15. Orca's supervised spec teaches a worker to report with
  // `orchestration send --from <its own handle>`, and on a remote child part of
  // that traffic came back down the channel this receiver consumes. Injected, it
  // wakes the child with its own words: its transcript reads `my own report
  // echoed back through the relay — nothing to answer there`, twice in four
  // minutes. The second message here is the anti-regression half — the drop must
  // be a self-filter, never a blanket one.
  const saved = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_self';
  try {
    let attempt = 0;
    const h = harness({
      sh: () => '{"ok":true}',
      spawn: () => {
        attempt += 1;
        if (attempt > 1) return fakeChild(WAIT_FAILED);
        return fakeChild(
          JSON.stringify({
            ok: true,
            result: {
              deliveryId: 'd1',
              messages: [
                { id: 'm1', type: 'status', body: 'my own report', from_handle: 'term_self' },
                { id: 'm2', type: 'status', body: 'a real peer', from_handle: 'term_other' },
              ],
            },
          }),
        );
      },
    });
    const r = createReceiver(h.deps);
    r.useTimers(h.timers);

    r.start(h.pi);
    await settle();
    r.stop();

    expect(h.injected).toEqual(['m2']);
    expect(h.notes.join('\n')).toContain('sent itself');
  } finally {
    if (saved === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = saved;
  }
});

/**
 * THE SEQUENCE GAP, which exists because the wire cannot tell loss from success.
 *
 * Measured 2026-08-15: on Orca 1.4.182 a dispatched worker on a second host sent
 * 6 messages home and 3 arrived; on 1.4.183 the same probe delivered 10/10. Both
 * runs produced the identical receipt — `Queued relay_<id> for Run home`, exit 0
 * — on every single send. So the only thing that can distinguish the two cases
 * is the sender's own counter, and these three tests pin what the receiver does
 * with it: alarm on a hole, stay silent when there is none, and refuse to inject
 * the same number twice.
 */
async function deliverSequenced(messages: { id: string; seq?: number }[]) {
  let attempt = 0;
  const h = harness({
    sh: () => '{"ok":true}',
    spawn: () => {
      attempt += 1;
      if (attempt > 1) return fakeChild(WAIT_FAILED);
      return fakeChild(
        JSON.stringify({
          ok: true,
          result: {
            deliveryId: 'd1',
            messages: messages.map((m) => ({
              id: m.id,
              type: 'status',
              body: `body ${m.id}`,
              // A string payload, as Orca actually delivers it, so the parse
              // path is the one under test.
              payload: JSON.stringify(m.seq === undefined ? {} : { peer: 'peer', seq: m.seq }),
            })),
          },
        }),
      );
    },
    peerContent: (msg) => `content of ${String(msg.id)}`,
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);
  r.start(h.pi);
  await settle();
  r.stop();
  return h;
}

test('a gap in the sender sequence raises a named, visible alarm', async () => {
  const h = await deliverSequenced([{ id: 'm1', seq: 1 }, { id: 'm3', seq: 3 }]);

  expect(h.injected).toEqual(['m1', 'm3']);
  // The note: what the operator greps for.
  expect(h.notes.join('\n')).toContain('PEER MESSAGE LOST: 1 message(s) from peer');
  // And the line the MODEL sees, because a note it never reads changes nothing.
  expect(String(h.sent[1].content)).toContain('[PEER MESSAGE LOST]');
  expect(String(h.sent[1].content)).toContain('expected #2, this is #3');
  expect(String(h.sent[1].content)).toContain('content of m3');
  expect(h.sent[1].details.lostBefore).toBe(1);
  // The first message establishes the baseline and must not alarm on its own.
  expect(String(h.sent[0].content)).not.toContain('PEER MESSAGE LOST');
});

test('an in-order run raises no alarm at all', async () => {
  const h = await deliverSequenced([
    { id: 'm1', seq: 1 },
    { id: 'm2', seq: 2 },
    { id: 'm3', seq: 3 },
  ]);

  expect(h.injected).toEqual(['m1', 'm2', 'm3']);
  expect(h.notes.join('\n')).not.toContain('PEER MESSAGE LOST');
  for (const msg of h.sent) expect(String(msg.content)).not.toContain('PEER MESSAGE LOST');
  expect(h.sent[2].details.sequence).toBe(3);
  expect(h.sent[2].details.lostBefore).toBeUndefined();
});

test('a repeated sequence is reported, not injected twice', async () => {
  // Same number, DIFFERENT id — the case the injected-id dedup cannot catch,
  // which is why the sequence check is worth having on top of it.
  const h = await deliverSequenced([{ id: 'm1', seq: 4 }, { id: 'm1-again', seq: 4 }]);

  expect(h.sent).toHaveLength(1);
  expect(String(h.sent[0].content)).toContain('content of m1');
  expect(h.notes.join('\n')).toContain('duplicate sequence 4 from peer');
  // Consumed, so a retained delivery does not re-litigate it.
  expect(h.injected).toEqual(['m1', 'm1-again']);
});

/**
 * ANSWERABILITY IS THE RECORDED ROUTE, NEVER THE ATTRIBUTION.
 *
 * Measured 2026-08-25 on ofmchat. `57-policy-offer-engine` reported with the
 * hand-rolled `orca orchestration send --type worker_done` its Orca preamble
 * teaches ("REQUIRED exactly once"), so the message carried no
 * `payload.replyTo`. It arrived witnessed by its pane key, was labelled with the
 * peer's real name and model, and the delivery invited `Reply with the peer_reply
 * tool (message_id: msg_0c83c5b494db)`. The orchestrator answered a load-bearing
 * decision, `peer_reply` refused with `No reply route`, and the answer went into
 * the child's pane by hand instead. The child then stopped using the channel at
 * all: "your decision arrived on this pane and I acted on it from here."
 *
 * Two things were wrong and both are pinned here: the sender's own published Run
 * was a perfectly good address nobody read, and the invitation was printed for a
 * message this session could not answer.
 */
async function deliverPane(
  msg: Record<string, unknown>,
  overrides: Partial<ReceiveDeps> = {},
) {
  const routes: Array<{ id: string; route: Record<string, unknown> }> = [];
  const answerable: boolean[] = [];
  let attempt = 0;
  const h = harness({
    senderIdentity: () => ({ name: 'worker', model: 'claude-opus-5', attributed: true, kind: 'pane' }),
    recordRoute: (id, route) => routes.push({ id, route }),
    peerContent: (_msg, _who, canAnswer) => {
      answerable.push(canAnswer === true);
      return 'body';
    },
    spawn: () => {
      attempt += 1;
      if (attempt > 1) return fakeChild(WAIT_FAILED);
      return fakeChild(JSON.stringify({ ok: true, result: { deliveryId: 'd1', messages: [msg] } }));
    },
    ...overrides,
  });
  const r = createReceiver(h.deps);
  r.useTimers(h.timers);
  r.start(h.pi);
  await settle();
  r.stop();
  return { ...h, routes, answerable };
}

const CHILD_RUN = `run:${'c'.repeat(12)}`;
const PAYLOAD_RUN = `run:${'p'.repeat(12)}`;

test('a witnessed pane that sent no return address is routed by its published Run', async () => {
  const h = await deliverPane(
    { id: 'm1', type: 'worker_done', body: 'opened PR #75', from_handle: 'term_child' },
    { paneRoute: (handle) => (handle === 'term_child' ? CHILD_RUN : '') },
  );

  expect(h.routes).toEqual([{ id: 'm1', route: { run: CHILD_RUN, peer: 'worker' } }]);
  expect(h.answerable).toEqual([true]);
  expect(String(h.sent[0]?.content ?? '')).not.toContain('[NO REPLY ROUTE]');
  expect(h.notes.join('\n')).toContain("reply route for worker from its own registered Run");
});

test('a return address in the payload still wins over the registry', async () => {
  // The sender's own words are the more specific statement, and the registry is
  // the same-uid file tree this module refuses to resolve names from. Precedence
  // is the whole reason the fallback is safe to have.
  const h = await deliverPane(
    {
      id: 'm1',
      type: 'status',
      body: 'a question',
      from_handle: 'term_child',
      payload: JSON.stringify({ peer: 'worker', replyTo: PAYLOAD_RUN }),
    },
    { paneRoute: () => CHILD_RUN },
  );

  expect(h.routes).toEqual([{ id: 'm1', route: { run: PAYLOAD_RUN, peer: 'worker' } }]);
  expect(h.answerable).toEqual([true]);
});

test('an unroutable pane message says so instead of inviting a reply', async () => {
  const h = await deliverPane(
    { id: 'm1', type: 'status', body: 'anybody there', from_handle: 'term_child' },
    { paneRoute: () => '' },
  );

  expect(h.routes).toEqual([]);
  expect(h.answerable).toEqual([false]);
  // Delivered all the same: refusing an address must never silence a peer.
  expect(h.sent).toHaveLength(1);
  expect(String(h.sent[0]?.content ?? '')).toContain('[NO REPLY ROUTE]');
  expect(h.notes.join('\n')).toContain('no reply route for worker');
});

test('a forged-looking handle is not resolved, and a host with no fallback still works', async () => {
  // `paneRoute` is optional: a host that cannot look one up must degrade to the
  // refusal, never throw inside the loop that owns the whole channel.
  const h = await deliverPane({ id: 'm1', type: 'status', body: 'x', from_handle: 'nonsense' });

  expect(h.routes).toEqual([]);
  expect(h.answerable).toEqual([false]);
  expect(h.sent).toHaveLength(1);
});

/**
 * THE REPORT LANDS AFTER THE SUMMARY, IN THE SAME MESSAGE.
 *
 * Order is the contract, not decoration: the Summary is what a reader acts on
 * first and the Report is the evidence behind it, so a block that arrived above
 * the three sentences would bury the message. One message, because a second
 * `sendMessage` is a second wake for one completion.
 *
 * What the block SAYS is `completion.test.ts`'s subject — the four dispositions,
 * the containment proof and the cap all live with the rule. Here the receiver
 * only has to place it, and never withhold a completion for it.
 */
test("a worker's completion carries its Report after the body", async () => {
  const h = await deliverPane(
    { id: 'm1', type: 'worker_done', body: 'opened PR #99', from_handle: 'dispatch:ctx_1' },
    {
      peerContent: () => 'SUMMARY-BODY',
      completionReport: (msg) => (String(msg.type) === 'worker_done' ? '\n\n--- REPORT\n## CRITERIA' : ''),
    },
  );

  const content = String(h.sent[0]?.content ?? '');
  expect(content).toContain('SUMMARY-BODY');
  expect(content.indexOf('--- REPORT')).toBeGreaterThan(content.indexOf('SUMMARY-BODY'));
  expect(h.sent).toHaveLength(1);
});

test('a status message gets no Report block, and a host without the dep still delivers', async () => {
  const asked: string[] = [];
  const h = await deliverPane(
    { id: 'm1', type: 'status', body: 'a question', from_handle: 'term_child' },
    {
      peerContent: () => 'SUMMARY-BODY',
      completionReport: (msg) => {
        asked.push(String(msg.type));
        return '';
      },
    },
  );

  // Asked, and it answered `''` — the discrimination is the module's, so the
  // receiver must not grow a second rule about which types carry a Report.
  expect(asked).toEqual(['status']);
  // The banner above the body is `unanswerableBanner`'s contract, not this
  // test's: what is pinned here is that nothing was appended after the body.
  const content = String(h.sent[0]?.content ?? '');
  expect(content.endsWith('SUMMARY-BODY')).toBe(true);
  expect(content).not.toContain('REPORT');

  // The dep is optional: the completion still reaches the model without it.
  const bare = await deliverPane({
    id: 'm2',
    type: 'worker_done',
    body: 'done',
    from_handle: 'dispatch:ctx_1',
  });
  expect(bare.sent).toHaveLength(1);
});
