// `ax worker gate` — every proposition of orca-dispatch-gate.test.ts, ported.
//
// The gate had no test until 2026-08-09, and that is why its most ordinary case
// — a task that exists and was never dispatched — answered 3 for a day. The
// live/dead distinction turns on whether a Dispatch's `agentTerminalHandle` is
// still in `terminal list`, and that pairing is exactly what a fixture can hold
// and a real runtime cannot be made to produce on demand. So the runner is
// injected in every test: no Orca, no network, no clock.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { gate } from '../src/worker/gate.mjs';

const TASK = 'task_bedfd180d2e6';

/** One Dispatch row, the shape `orchestration worker-list --json` returns. */
const dispatch = (id, handle, state = 'failed') => ({
  taskId: TASK,
  dispatchId: id,
  workerState: state,
  terminalState: 'retained',
  agentTerminalHandle: handle,
});

/**
 * A runner over canned receipts. `terminals` are handle strings (or objects,
 * for the orphaned case); `tasks: null` is an unreadable task-list, and
 * `workerListFails`/`workerListShape` are the two ways read 1 can fail to
 * answer — a missing command, and a receipt with no `workers` container.
 */
function fakeRunner({
  workers = [],
  terminals = [],
  tasks = [TASK],
  workerListFails = false,
  workerListShape = false,
  terminalListFails = false,
  terminalListTruncated = false,
  omittedHostIds = [],
  ready = true,
} = {}) {
  const calls = [];
  const receipt = result => ({ status: 0, stdout: '', stderr: '', receipt: { ok: true, result } });
  const broken = (stderr, stdout = '') => ({ status: 1, stdout, stderr, receipt: { unparseable: stdout || stderr, error: 'x' } });

  const run = args => {
    calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'status') {
      return ready ? receipt({ runtime: { reachable: true } }) : broken('not running');
    }
    if (line.includes('worker-list')) {
      if (workerListFails) return broken('Unknown command: orchestration worker-list');
      if (workerListShape) return receipt({});
      return receipt({ workers });
    }
    if (line.includes('terminal list')) {
      if (terminalListFails) return broken('boom');
      return receipt({
        terminals: terminals.map(t => (typeof t === 'string' ? { handle: t } : t)),
        hostScope: { hostIds: ['local'], omittedHostIds },
        truncated: terminalListTruncated,
      });
    }
    if (line.includes('task-list')) {
      if (tasks === null) return { status: 0, stdout: 'not json at all', stderr: '', receipt: { unparseable: 'not json at all', error: 'x' } };
      return receipt({ tasks: tasks.map(id => ({ id })) });
    }
    return receipt({});
  };
  run.calls = calls;
  return run;
}

/** The verdict plus everything the operator is told — stdout and stderr, colours stripped. */
function verdict(fixture, argv = [TASK], env = {}) {
  const run = fakeRunner(fixture);
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = gate(argv, { runner: run, env });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return { code, out: chunks.join('').replace(/\u001B\[\d+m/g, ''), calls: run.calls };
}

/** A dispatch record whose receipt names `TASK`, as `ax worker start` leaves it. */
function stored(request) {
  const store = realpathSync(mkdtempSync(join(tmpdir(), 'ax-gate-store-')));
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      attempts: [{ n: 1, phases: [{ name: 'task-create', receipt: { ok: true, result: { task: { id: TASK } } } }] }],
    }),
  );
  return store;
}

// ── the two absences the gate confused ───────────────────────────────────────

test('a task that exists and was never dispatched is a safe first launch', () => {
  const r = verdict({ workers: [], terminals: [], tasks: [TASK] });
  assert.equal(r.code, 0);
  assert.match(r.out, /First launch/);
});

test('a task nobody can see cannot be concluded on, and the message names both causes', () => {
  const r = verdict({ workers: [], terminals: [], tasks: ['task_someone_else'] });
  assert.equal(r.code, 3);
  assert.match(r.out, /the id is wrong/);
  assert.match(r.out, /another Run/);
});

test('an unreadable task-list is an ignorance, never an absence', () => {
  const r = verdict({ workers: [], terminals: [], tasks: null });
  assert.equal(r.code, 3);
  assert.match(r.out, /'task-list' did not answer/);
});

test('a REQUEST id is resolved to its task through the dispatch store', () => {
  // Measured 2026-08-26 (ofmchat, a live wave): the coordinator typed the id
  // `worker launch` had just printed as `· request 60-work` — the id every
  // sibling verb accepts — and the one verb whose job is "can this be relaunched
  // without duplicating an agent?" answered CANNOT ESTABLISH with two causes
  // that were both false. The dispatch existed, locally, in the Run consulted.
  const r = verdict(
    { workers: [dispatch('ctx_live', 'term_live', 'ready')], terminals: ['term_live'] },
    ['60-work'],
    { ORCA_DISPATCH_STORE: stored('60-work') },
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /request 60-work/, 'the substitution is stated, never silent');
  assert.match(r.out, /STOP — one live agent/);
});

test('an id with no record in the store names the request-id cause too', () => {
  const r = verdict({ workers: [], terminals: [], tasks: ['task_someone_else'] }, ['60-work']);
  assert.equal(r.code, 3);
  assert.match(r.out, /REQUEST id/);
  assert.match(r.out, /ax worker ls/);
});

// ── what the gate already got right, now defended ────────────────────────────

test('F-003: dispatch corpses whose terminals are gone are not live agents', () => {
  const r = verdict({
    workers: [dispatch('ctx_dead1', 'term_gone1'), dispatch('ctx_dead2', 'term_gone2')],
    terminals: [],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /no live agent/);
});

test('F-003: an orphaned pane is a dead one, not an agent at work', () => {
  const r = verdict({
    workers: [dispatch('ctx_orphan', 'term_orphan')],
    terminals: [{ handle: 'term_orphan', orphaned: true }],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /no live agent/);
});

test('a pane on a host this list never asked about is disclosed, not silently a corpse', () => {
  // `terminal list` carries `hostScope.omittedHostIds`, non-empty on this Mac
  // (measured 2026-08-22: one stale runtime, 155 of 218 dispatch panes absent
  // because of it). Refusing on that made every ordinary relaunch answer 3 —
  // the same "answered 3 for a day" bug this suite exists for — so the gate
  // still answers for THIS host and says what it could not see.
  const r = verdict({
    workers: [dispatch('ctx_remote', 'term_elsewhere')],
    terminals: [],
    omittedHostIds: ['runtime:7930a317'],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /absent from a terminal list that omits runtime:7930a317/);
  assert.match(r.out, /--on <host>/);
});

test('a truncated terminal list cannot answer the gate at all', () => {
  const r = verdict({
    workers: [dispatch('ctx_any', 'term_any')],
    terminals: [],
    terminalListTruncated: true,
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /TRUNCATED/);
});

test('F-001: a failed dispatch whose terminal is still live is a working agent, not a corpse', () => {
  // The measured heart of F-001: `failed` describes the receipt, never the process.
  const r = verdict({
    workers: [dispatch('ctx_failed', 'term_live')],
    terminals: ['term_live'],
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /DO NOT relaunch/);
  assert.match(r.out, /ctx_failed/, 'the live agent is named — the operator has to go look at it');
});

test('F-001: two live terminals on one task is the duplicate itself', () => {
  const r = verdict({
    workers: [dispatch('ctx_a', 'term_a'), dispatch('ctx_b', 'term_b', 'ready')],
    terminals: ['term_a', 'term_b'],
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /DUPLICATE/);
  // It must name the handles, because the operator's next act is closing one of them.
  assert.match(r.out, /term_a/);
  assert.match(r.out, /term_b/);
});

test('a host without worker-list cannot conclude, and says which command is missing', () => {
  const r = verdict({ workerListFails: true });
  assert.equal(r.code, 3);
  assert.match(r.out, /worker-list/);
});

// ── fail-closed, the ax additions ────────────────────────────────────────────

test('F-028: a worker-list receipt with no workers container is cannot-establish, never an empty list', () => {
  // An `or` on a container is how an empty worker list was once read as a count
  // of 2 — here the same slip would authorise a relaunch on top of an agent.
  const r = verdict({ workerListShape: true, tasks: [TASK] });
  assert.equal(r.code, 3);
  assert.match(r.out, /no "workers"/);
});

test('an unreadable terminal list is cannot-establish: a corpse and a worker are then the same row', () => {
  const r = verdict({ workers: [dispatch('ctx_x', 'term_x')], terminalListFails: true });
  assert.equal(r.code, 3);
  assert.match(r.out, /terminal list/);
});

test('no task id concludes nothing and touches no orchestration state', () => {
  const r = verdict({}, []);
  assert.equal(r.code, 3);
  assert.equal(r.calls.length, 0);
  assert.match(r.out, /ax worker gate <task\|request>/);
});

test('no orca on the machine fails CLOSED — unlike ax board, silence is never permission', () => {
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = gate([TASK], { resolve: () => null, env: {} });
  } finally {
    process.stdout.write = outWrite;
  }
  assert.equal(code, 3);
  assert.match(chunks.join(''), /orca open/);
});

test('an unreachable runtime is probed before any read, and refuses', () => {
  const r = verdict({ ready: false, workers: [], tasks: [TASK] });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls, [['status', '--json']], 'nothing is read once the runtime has not answered');
  assert.match(r.out, /orca open/);
});

test('the three reads happen in order, and --run scopes the task-list', () => {
  const r = verdict({ workers: [], terminals: [], tasks: [TASK] }, [TASK, '--run', 'run_4a38bd284217']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, [
    ['status', '--json'],
    ['orchestration', 'worker-list', '--json'],
    ['terminal', 'list', '--json'],
    ['orchestration', 'task-list', '--run', 'run_4a38bd284217', '--json'],
  ]);
});

test('another task\'s dispatches are not this task\'s: rows are filtered by taskId', () => {
  const r = verdict({
    workers: [{ ...dispatch('ctx_other', 'term_live'), taskId: 'task_elsewhere' }],
    terminals: ['term_live'],
    tasks: [TASK],
  });
  assert.equal(r.code, 0, 'a live agent on a neighbouring task never gates this one');
  assert.match(r.out, /First launch/);
});
