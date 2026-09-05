// `ax worker gate` — every proposition of orca-dispatch-gate.test.ts, ported.
//
// The gate had no test until 2026-08-09, and that is why its most ordinary case
// — a task that exists and was never dispatched — answered 3 for a day. The
// live/dead distinction turns on whether a Dispatch's `agentTerminalHandle` is
// still in `terminal list`, and that pairing is exactly what a fixture can hold
// and a real runtime cannot be made to produce on demand. So the runner is
// injected in every test: no Orca, no network, no clock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { gate } from '../src/worker/gate.mjs';
import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';

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
  hostIds = ['local'],
  hosts = {},
  worktrees = null,
  ready = true,
} = {}) {
  const calls = [];
  const receipt = result => ({ status: 0, stdout: '', stderr: '', receipt: { ok: true, result } });
  const broken = (stderr, stdout = '') => ({ status: 1, stdout, stderr, receipt: { unparseable: stdout || stderr, error: 'x' } });
  const inventory = ({ rows = [], omitted = [], ids = ['local'], truncated = false }) =>
    receipt({
      terminals: rows.map(t => (typeof t === 'string' ? { handle: t } : t)),
      hostScope: { ...(ids === null ? {} : { hostIds: ids }), omittedHostIds: omitted },
      truncated,
    });

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
    if (args[0] === 'terminal' && args[1] === 'list') {
      // The host's OWN inventory, served by that host's runtime: `local` in its
      // reply is the REMOTE's local (measured 2026-09-02, see pane.mjs).
      const at = args.indexOf('--environment');
      if (at !== -1) {
        const host = hosts[args[at + 1]];
        if (host === undefined || host.fail !== undefined) return broken(host?.fail ?? `no environment ${args[at + 1]}`);
        return inventory({ rows: host.terminals ?? [], omitted: host.omittedHostIds ?? [], ids: host.hostIds === undefined ? ['local'] : host.hostIds });
      }
      if (terminalListFails) return broken('boom');
      return inventory({ rows: terminals, omitted: omittedHostIds, ids: hostIds, truncated: terminalListTruncated });
    }
    // The federation read a REMOTE record's branch is asked through — the call
    // `placeRemote` already makes (../src/worker/placement.mjs).
    if (args[0] === 'worktree' && args[1] === 'list') {
      if (worktrees === null) return broken('Unknown command: worktree list');
      return receipt({ worktrees });
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

/**
 * The verdict plus everything the operator is told — stdout and stderr, colours
 * stripped.
 *
 * `cwd` is the checkout whose `ax.config.json` declares the hosts a remote
 * record may be asked about, and `exec` the `gh`/`git` a proven-dead row's
 * continuation is read through. Both are injected and both refuse by default,
 * so no test can reach a real shell or a real forge.
 */
function verdict(fixture, argv = [TASK], env = {}, { cwd = process.cwd(), exec = noExec } = {}) {
  const run = fakeRunner(fixture);
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = gate(argv, { runner: run, env, cwd, exec });
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

/** A dispatch store of its own, so no test reads another's records. */
const store = () => realpathSync(mkdtempSync(join(tmpdir(), 'ax-gate-records-')));

/**
 * A checkout declaring the hosts passed here — the only thing that says how ax
 * reaches a host, and therefore whether a remote pane can be asked about at all
 * (`hostFor`, ../src/worker/hosts.mjs). `repo()` declares none.
 */
function repo(hosts = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-gate-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const dispatch = Object.keys(hosts).length === 0 ? {} : { dispatch: { entry: '/entry', hosts } };
  writeFileSync(
    join(dir, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, ...dispatch }),
  );
  return dir;
}

/** The measured `worker-start` receipt shape, agent pane included (2026-08-22). */
const started = ({ dispatchId, handle }) => ({
  ok: true,
  result: {
    runId: 'run_1',
    taskId: TASK,
    dispatchId,
    state: 'ready',
    stage: 'input_accepted',
    effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: handle, surface: 'visible' }],
    residualResources: [],
    mutation: { requestId: 'r', replayed: false },
  },
});

/**
 * A record written the way a dispatch writes one: `task-create`, then the
 * write-ahead `worker-start` argv, then its receipt.
 *
 * `on` is the host that placement named, `worktree`/`repoId` the rest of it,
 * and `stranded` the phase that never concluded — the shape `--resume` exists
 * for, and the one an outcome-unknown mutation leaves behind.
 */
function record(dir, request, { dispatchId = 'ctx_rec', handle = 'term_rec', on = '', worktree = '', repoId = '', stranded = false } = {}) {
  const { path } = claimRecord(dir, request);
  initRecord(path, { request, orca: 'orca', repo: 'acme/widgets' });
  phaseBegin(path, { name: 'task-create', identity: `id-create-${request}`, argv: ['orca', 'orchestration', 'task-create', '--json'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: TASK }, mutation: { requestId: 'r', replayed: false } } }) });
  phaseBegin(path, {
    name: 'worker-start',
    identity: `id-start-${request}`,
    argv: [
      'orca',
      'orchestration',
      'worker-start',
      ...(on === '' ? [] : ['--on', on]),
      ...(worktree === '' ? [] : ['--worktree', worktree.startsWith('path:') || worktree.startsWith('id:') ? worktree : `path:${worktree}`, '--agent', 'omp']),
      ...(repoId === '' ? [] : ['--repo', repoId]),
      '--json',
    ],
  });
  if (stranded) phaseEnd(path, 'last', { exit: null, receiptText: '', error: new Error('ETIMEDOUT: the call never concluded') });
  else phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify(started({ dispatchId, handle })) });
  return path;
}

/** Nothing on this machine answers a shell here: a test that needs one injects it. */
const noExec = (bin, args) => ({ status: 1, stdout: '', stderr: `no ${bin} ${String(args?.[0] ?? '')} in this test\n` });

const prList = rows => ({ status: 0, stdout: JSON.stringify(rows), stderr: '' });

/**
 * The two machine answers a continuation read needs, stubbed and recorded:
 * `gh` (the pull requests of a branch) and `git` (which branch a LOCAL
 * recorded worktree is on). Keyed by the first two argv words, the convention
 * tests/worker-ls.test.mjs uses.
 */
function fakeExec({ answers = {} } = {}) {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    const sub = bin === 'git' ? args[args.indexOf('-C') + 2] ?? args[0] : `${args[0]} ${args[1]}`;
    return answers[`${bin} ${sub}`] ?? { status: 1, stdout: '', stderr: `stub has no answer for ${bin} ${sub}\n` };
  };
  return { exec, calls };
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
  // Measured 2026-08-26 (ofmchat, a live wave): the orchestrator typed the id
  // `worker launch` had just printed as `· request 60-work` — the id every
  // sibling verb accepts — and the one verb whose job is "can this be
  // re-dispatched without duplicating an agent?" answered CANNOT ESTABLISH with
  // two causes that were both false. The dispatch existed, locally, in the Run
  // consulted.
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

test('#192: an unproven pane is never permission — a pane nothing attributes, behind an omitted host, refuses', () => {
  // WHAT THIS TEST REVERSES. Until #192 the gate answered 0 here — "no live
  // agent. Safe to re-dispatch" — because `terminal list` carries
  // `hostScope.omittedHostIds` (non-empty on this Mac, measured 2026-08-22:
  // one stale runtime, 155 of 218 dispatch panes absent because of it) and
  // INCONNU was mapped to "down, disclosed". The disclosure was printed
  // BESIDE an authorization, and the authorization is what a caller consumes:
  // an absent observation became permission to create a second worker on a
  // pane that may be working.
  //
  // Nothing in this store attributes `ctx_remote`, so no host can be asked for
  // it either — which is exactly the case that must not conclude.
  const r = verdict({
    workers: [dispatch('ctx_remote', 'term_elsewhere')],
    terminals: [],
    omittedHostIds: ['runtime:7930a317'],
  });
  assert.equal(r.code, 3);
  assert.doesNotMatch(r.out, /Safe to re-dispatch/, 'an unproven pane authorises nothing');
  assert.match(r.out, /CANNOT ESTABLISH/);
  assert.match(r.out, /runtime:7930a317/, 'and the omission it could not see past is quoted');
  assert.match(r.out, /ax worker ls/, 'with a read that can still be made');
});

test('#192: a LOCALLY recorded pane, absent from a list that read `local`, is proven dead and still answers 0', () => {
  // The other half of the same change, and the reason it is not a refusal for
  // every ordinary re-dispatch on this machine: the dispatch store says where
  // each dispatch was placed, so a local pane absent from a list that covered
  // `local` is a corpse (F-003) whatever REMOTE host that list omitted.
  // Omission is per host (pane.mjs), and the provenance is what lets this verb
  // apply that rule instead of rounding every absence to unknown.
  const dir = store();
  record(dir, '192-local', { dispatchId: 'ctx_local', handle: 'term_gone' });
  const r = verdict(
    { workers: [dispatch('ctx_local', 'term_gone')], terminals: [], omittedHostIds: ['runtime:7930a317'] },
    [TASK],
    { ORCA_DISPATCH_STORE: dir },
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no live agent/);
  assert.match(r.out, /term_gone/, 'the corpse is named with the coverage that proves it');
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
  assert.match(r.out, /DO NOT re-dispatch/);
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
  // of 2 — here the same slip would authorise a re-dispatch on top of an agent.
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

// ── #192: unknown liveness, and the safe next action a record already names ──
// A fresh orchestrator asks this verb one question and consumes its answer as
// an authorization. So the four things that all look like "no agent" from the
// outside must stay apart in the ANSWER, not only in the prose beside it:
// proven death, a host nothing could ask, a mutation whose outcome nobody
// knows, and a dispatch this host cannot attribute at all. Only the first is a
// permission — and even then, the verb that continues that record is decided
// by its branch's pull request, never by "start another one".

test('#192: a recorded mutation that never concluded routes to the recorded replay, never to a new identity', () => {
  // The worst shape of the old answer: the mutation may have COMMITTED — Orca
  // never replied — so `worker-list` can be empty while a child is coming up.
  // "First launch, safe to start" there is F-001 by the front door.
  const dir = store();
  record(dir, '192-stranded', { stranded: true });

  const r = verdict({ workers: [], terminals: [], tasks: [TASK] }, [TASK], { ORCA_DISPATCH_STORE: dir });

  assert.equal(r.code, 3, r.out);
  assert.doesNotMatch(r.out, /First launch|Safe to re-dispatch/, 'an unconcluded mutation is not an absent one');
  assert.match(r.out, /ETIMEDOUT/, 'the evidence is quoted, never summarised');
  assert.match(r.out, /→ ax worker start --resume --request 192-stranded/, 'the recorded route, byte for byte');
  assert.doesNotMatch(r.out, /ax worker dispatch/, 'a fresh identity is the one repair this case must never name');
});

test('#192: a pane on a host that could not be asked refuses, and names the ask as the repair', () => {
  const dir = store();
  record(dir, '192-far', { dispatchId: 'ctx_far', handle: 'term_far', on: 'gapicore' });

  const r = verdict(
    {
      workers: [dispatch('ctx_far', 'term_far')],
      terminals: [],
      omittedHostIds: ['runtime:7930a317'],
      hosts: { gapicore: { fail: 'ssh: connect to host gapicore port 22: Operation timed out' } },
    },
    [TASK],
    { ORCA_DISPATCH_STORE: dir },
    { cwd: repo({ gapicore: { ssh: 'gapicore' } }) },
  );

  assert.equal(r.code, 3, r.out);
  assert.doesNotMatch(r.out, /Safe to re-dispatch/);
  assert.match(r.out, /gapicore/);
  assert.match(r.out, /Operation timed out/, 'the reason that host gave, quoted');
  assert.match(r.out, /→ orca terminal list --environment gapicore --json/, 'the read that would settle it');
});

test('#192: a host that answered for its own panes proves the corpse it does not carry', () => {
  // `terminal list --environment <host>` is served by THAT host's runtime, and
  // `local` in its reply is its own local (pane.mjs). An absence there is a
  // corpse on that host — the one remote case that still authorises.
  const dir = store();
  record(dir, '192-asked', { dispatchId: 'ctx_asked', handle: 'term_asked', on: 'gapicore' });

  const r = verdict(
    {
      workers: [dispatch('ctx_asked', 'term_asked')],
      terminals: [],
      omittedHostIds: ['runtime:7930a317'],
      hosts: { gapicore: { terminals: [] } },
    },
    [TASK],
    { ORCA_DISPATCH_STORE: dir },
    { cwd: repo({ gapicore: { ssh: 'gapicore' } }) },
  );

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no live agent/);
  assert.match(r.out, /gapicore/, 'the host that proved the corpse is named');
  // A record that names no worktree has no branch to ask about — the same
  // silence a local archaeology row already had. What must not happen is a
  // guessed route over a tree this machine happens to have under the same name.
  assert.doesNotMatch(r.out, /--replace|ax worker settle|ax worker release/, 'no route without a branch');
});

test('#192: a proven-dead pane is answered with the continuation its branch decides', () => {
  const dir = store();
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'ax-gate-tree-')));
  record(dir, '192-open', { dispatchId: 'ctx_open', handle: 'term_open', worktree });
  const { exec, calls } = fakeExec({
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/192-open\n', stderr: '' },
      'gh pr list': prList([{ number: 200, state: 'OPEN', headRefName: 'feat/192-open' }]),
    },
  });

  const r = verdict(
    { workers: [dispatch('ctx_open', 'term_open')], terminals: [] },
    [TASK],
    { ORCA_DISPATCH_STORE: dir },
    { exec },
  );

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /→ ax worker start --replace --request 192-open/, 'the unfinished slice is continued, not restarted');
  assert.match(r.out, /#200/);
  assert.ok(calls.some(line => line.includes('gh pr list') && line.includes('--head feat/192-open')), calls.join(' | '));
});

test('#192: a merged pull request routes to release, an absent one to settle, and an ambiguous one to neither', () => {
  const tree = () => realpathSync(mkdtempSync(join(tmpdir(), 'ax-gate-tree-')));

  const landedDir = store();
  const landedTree = tree();
  record(landedDir, '192-landed', { dispatchId: 'ctx_landed', handle: 'term_landed', worktree: landedTree });
  const landed = verdict(
    { workers: [dispatch('ctx_landed', 'term_landed')], terminals: [] },
    [TASK],
    { ORCA_DISPATCH_STORE: landedDir },
    {
      exec: fakeExec({
        answers: {
          'git rev-parse': { status: 0, stdout: 'feat/192-landed\n', stderr: '' },
          'gh pr list': prList([{ number: 201, state: 'MERGED', headRefName: 'feat/192-landed' }]),
        },
      }).exec,
    },
  );
  assert.equal(landed.code, 0, landed.out);
  assert.match(landed.out, /→ ax worker release --dispatch ctx_landed/);
  assert.doesNotMatch(landed.out, /--replace/, 'nothing is left to continue on a merged pull request');

  const noneDir = store();
  record(noneDir, '192-unshipped', { dispatchId: 'ctx_unshipped', handle: 'term_unshipped', worktree: tree() });
  const unshipped = verdict(
    { workers: [dispatch('ctx_unshipped', 'term_unshipped')], terminals: [] },
    [TASK],
    { ORCA_DISPATCH_STORE: noneDir },
    {
      exec: fakeExec({
        answers: {
          'git rev-parse': { status: 0, stdout: 'feat/192-unshipped\n', stderr: '' },
          'gh pr list': prList([]),
        },
      }).exec,
    },
  );
  assert.equal(unshipped.code, 0, unshipped.out);
  assert.match(unshipped.out, /→ ax worker settle 192-unshipped/);

  const twoDir = store();
  record(twoDir, '192-two', { dispatchId: 'ctx_two', handle: 'term_two', worktree: tree() });
  const ambiguous = verdict(
    { workers: [dispatch('ctx_two', 'term_two')], terminals: [] },
    [TASK],
    { ORCA_DISPATCH_STORE: twoDir },
    {
      exec: fakeExec({
        answers: {
          'git rev-parse': { status: 0, stdout: 'feat/192-two\n', stderr: '' },
          'gh pr list': prList([
            { number: 202, state: 'OPEN', headRefName: 'feat/192-two' },
            { number: 203, state: 'MERGED', headRefName: 'feat/192-two' },
          ]),
        },
      }).exec,
    },
  );
  assert.equal(ambiguous.code, 0, ambiguous.out);
  assert.match(ambiguous.out, /undecided/);
  assert.doesNotMatch(ambiguous.out, /--replace|ax worker settle|ax worker release/, 'two PRs on one head decide nothing');
});

test('#192: a REMOTE record\'s branch is read on the host its placement names, never from a local homonym', () => {
  // The defect this closes: `/srv/orca/192-far` on gapicore and a same-named
  // directory here are different trees, and a `git -C` over the local one
  // answers about a stranger. So the branch comes from the host's own
  // federation reply, and the pull request — a forge fact — is read from here.
  const dir = store();
  record(dir, '192-remote', {
    dispatchId: 'ctx_remote_ok',
    handle: 'term_remote_ok',
    on: 'gapicore',
    worktree: 'id:repo-1::/srv/orca/192-far',
    repoId: 'id:repo-1',
  });
  const { exec, calls } = fakeExec({
    answers: { 'gh pr list': prList([{ number: 204, state: 'OPEN', headRefName: 'feat/192-far' }]) },
  });
  const run = fakeRunner({
    workers: [dispatch('ctx_remote_ok', 'term_remote_ok')],
    terminals: [],
    omittedHostIds: ['runtime:7930a317'],
    hosts: { gapicore: { terminals: [] } },
    worktrees: [{ path: '/srv/orca/192-far', repoId: 'repo-1', branch: 'refs/heads/feat/192-far' }],
  });

  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = gate([TASK], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo({ gapicore: { ssh: 'gapicore' } }), exec });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  const out = chunks.join('').replace(/\u001B\[\d+m/g, '');

  assert.equal(code, 0, out);
  assert.match(out, /→ ax worker start --replace --request 192-remote/);
  assert.ok(
    run.calls.some(args => args.join(' ') === 'worktree list --repo id:repo-1 --environment gapicore --json'),
    `the branch is asked of the owning host: ${run.calls.map(args => args.join(' ')).join(' | ')}`,
  );
  assert.ok(!calls.some(line => line.startsWith('git ')), `no local git read for a remote tree: ${calls.join(' | ')}`);
  assert.ok(calls.some(line => line.includes('--head feat/192-far')), calls.join(' | '));
});

test('#192: a host that cannot say which worktrees it carries produces an inability, never a local fallback', () => {
  const dir = store();
  record(dir, '192-unread', {
    dispatchId: 'ctx_unread',
    handle: 'term_unread',
    on: 'gapicore',
    worktree: 'id:repo-1::/srv/orca/192-far',
    repoId: 'id:repo-1',
  });
  const { exec, calls } = fakeExec();
  const r = verdict(
    {
      workers: [dispatch('ctx_unread', 'term_unread')],
      terminals: [],
      hosts: { gapicore: { terminals: [] } },
      worktrees: null,
    },
    [TASK],
    { ORCA_DISPATCH_STORE: dir },
    { cwd: repo({ gapicore: { ssh: 'gapicore' } }), exec },
  );

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /undecided/);
  assert.match(r.out, /→ orca worktree list --repo id:repo-1 --environment gapicore --json/, 'the read that failed is the repair');
  assert.doesNotMatch(r.out, /--replace|ax worker settle|ax worker release/);
  assert.ok(!calls.some(line => line.startsWith('git ')), `nothing local answers for a remote tree: ${calls.join(' | ')}`);
});
