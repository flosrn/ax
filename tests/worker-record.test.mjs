// The record store is the F-001 countermeasure: every proposition here is the
// one an incident proved, ported from coordinator/record.test.ts — not a
// neighbour of it (F-027). Real filesystem, real O_EXCL, no mocks: the defects
// that reached users were all invisible to mocked filesystems.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  acquireLock,
  attemptNew,
  claimRecord,
  dispatchFields,
  initRecord,
  newIdentity,
  phaseArgv,
  phaseBegin,
  phaseCount,
  phaseEnd,
  phaseVerdict,
  recordedBin,
  recordedRun,
  report,
  requestIdOk,
  staleClaim,
  taskId,
  taskUpdateOk,
  workerPane,
  taskIdScan,
} from '../src/worker/record.mjs';

const store = () => mkdtempSync(join(tmpdir(), 'ax-record-'));

/** A claimed, initialised record with one begun phase — the common fixture. */
function begun(argv = ['orca', 'orchestration', 'task-create', '--run', 'run_me', '--json']) {
  const { path } = claimRecord(store(), 'req-1');
  initRecord(path, { request: 'req-1', orca: 'orca' });
  phaseBegin(path, { name: 'task-create', identity: 'id-1', argv });
  return path;
}

test('request-id grammar is closed and refused before any disk access', () => {
  for (const good of ['probe-msgflow-20260821', 'GAP-353.cache', 'a_b-c.1']) assert.equal(requestIdOk(good), true, good);
  for (const bad of ['.hidden', '..', 'a b', 'a/b', 'é', '', 'a\n']) assert.equal(requestIdOk(bad), false, JSON.stringify(bad));
  assert.throws(() => claimRecord(store(), '.hidden'), /violates/);
});

test('the claim is atomic: one winner, the loser learns it lost', () => {
  const dir = store();
  assert.equal(claimRecord(dir, 'req-1').claimed, true);
  assert.equal(claimRecord(dir, 'req-1').claimed, false, 'second claim of one logical request must lose');
});

test('a dangling symlink at the record path refuses the claim (set -C parity)', () => {
  const dir = store();
  symlinkSync(join(dir, 'nowhere.json'), join(dir, 'req-1.json'));
  assert.equal(claimRecord(dir, 'req-1').claimed, false);
});

test('write-ahead: argv and identity are on disk before any mutation result exists', () => {
  const path = begun(['orca', 'x', '--flag', 'v']);
  const ph = JSON.parse(readFileSync(path, 'utf8')).attempts[0].phases[0];
  assert.deepEqual(ph.argv, ['orca', 'x', '--flag', 'v']);
  assert.equal(ph.identity, 'id-1');
  assert.equal(ph.receipt, null, 'no receipt yet — the mutation has not been issued');
  assert.equal(ph.exit, null);
});

test('an unparseable receipt is stored raw with its error, never dropped (F-004)', () => {
  const path = begun();
  phaseEnd(path, 'last', {
    exit: 1,
    receiptText: 'runtime_unavailable: not json {',
    stderr: 'runtime continued after timeout',
  });
  const ph = JSON.parse(readFileSync(path, 'utf8')).attempts[0].phases[0];
  assert.equal(ph.exit, 1);
  assert.match(ph.receipt.unparseable, /runtime_unavailable/);
  assert.match(ph.receipt.stderr, /continued after timeout/);
  assert.ok(ph.receipt.error.length > 0, 'the parse error itself is part of the diagnostic');
});

test('an interrupted record rewrite preserves the last complete replay identity', () => {
  const path = begun();
  const before = readFileSync(path, 'utf8');
  chmodSync(dirname(path), 0o500);
  try {
    assert.throws(
      () => phaseEnd(path, 'last', { exit: 0, receiptText: readyReceipt() }),
      /EACCES|EPERM|read-only|permission/i,
    );
  } finally {
    chmodSync(dirname(path), 0o700);
  }
  assert.equal(readFileSync(path, 'utf8'), before, 'the authoritative write-ahead record was never truncated');
});

test('phaseEnd at a numeric index closes that phase, not the last one (replay path)', () => {
  const path = begun();
  phaseBegin(path, { name: 'worker-start', identity: 'id-2', argv: ['orca', 'y'] });
  phaseEnd(path, 0, { exit: 0, receiptText: '{"ok":true,"result":{"state":"ready"}}' });
  const phases = JSON.parse(readFileSync(path, 'utf8')).attempts[0].phases;
  assert.equal(phases[0].exit, 0);
  assert.equal(phases[1].exit, null, 'the later phase stays open');
});

test('phaseArgv reconstructs the exact recorded argv — never a recomposition', () => {
  const argv = ['orca', 'orchestration', 'task-create', '--spec', 'two words $(danger)', '--json'];
  const path = begun(argv);
  assert.deepEqual(phaseArgv(path, 0), argv);
  assert.equal(phaseCount(path), 1);
});

test('mismatch is distinguished from failed by name — it must never mint a new identity', () => {
  const path = begun();
  phaseEnd(path, 'last', {
    exit: 1,
    receiptText: JSON.stringify({ ok: false, error: { code: 'request_mismatch', message: 'fingerprint differs' } }),
  });
  assert.deepEqual(phaseVerdict(path, 'last'), { verdict: 'mismatch', evidence: 'fingerprint differs' });

  const other = begun();
  phaseEnd(other, 'last', { exit: 1, receiptText: JSON.stringify({ ok: false, error: { code: 'boom' } }) });
  assert.equal(phaseVerdict(other, 'last').verdict, 'failed');
});

test('a replayed mutation is named replayed, a fresh one ran', () => {
  const path = begun();
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({ ok: true, result: { state: 'ready', mutation: { replayed: true }, taskId: 't1' } }),
  });
  const { verdict, evidence } = phaseVerdict(path, 'last');
  assert.equal(verdict, 'replayed');
  assert.equal(evidence.taskId, 't1', 'both receipt shapes for the task id are read by the verdict');
});

/** A closed phase over one receipt — the shape every reader below is asked about. */
function closed(receiptText, { exit = 0, argv, ...rest } = {}) {
  const path = begun(argv);
  phaseEnd(path, 'last', { exit, receiptText, ...rest });
  return path;
}

const readyReceipt = (extra = {}) => JSON.stringify({
  ok: true,
  result: {
    state: 'ready',
    dispatchId: 'ctx_1',
    effects: [{ kind: 'terminal', id: 'term_1', role: 'agent' }],
    ...extra,
  },
});

test('usable is a conjunction: exit 0, ready, a dispatch to address AND a pane to read', () => {
  assert.equal(report(closed(readyReceipt())).usable, true);
  assert.equal(report(closed(readyReceipt(), { exit: 1 })).usable, false, 'a ready state behind a failed exit is STRANDED');
  assert.equal(report(closed(readyReceipt({ state: 'booting' }))).usable, false, 'a clean exit over a partial mutation is STRANDED');

  // `ready` with nothing to address later, and `ready` with no agent pane: both
  // are receipts describing a worker no caller can reach.
  assert.equal(report(closed(readyReceipt({ dispatchId: undefined }))).usable, false, 'ready without a dispatchId names nothing');
  assert.equal(report(closed(readyReceipt({ effects: [] }))).usable, false, 'ready with no agent pane is unreadable');
  assert.equal(report(closed(readyReceipt({ effects: [{ kind: 'worktree', id: 'wt_1' }] }))).usable, false);

  // A malformed `ready`: the container is not even a list. F-028 — never read
  // as an empty one, and certainly never as a working worker.
  assert.equal(report(closed(readyReceipt({ effects: 'term_1' }))).usable, false, 'effects as a string is not one terminal');
  assert.equal(report(closed(JSON.stringify({ ok: true, result: 'ready' }))).usable, false, 'a result that is not an object is not ready');
  assert.equal(
    report(closed(JSON.stringify({ ok: 'false', result: JSON.parse(readyReceipt()).result }))).usable,
    false,
    'only the boolean true can make a receipt usable',
  );

  const legacy = closed(readyReceipt({ effects: [] }));
  const legacyRecord = JSON.parse(readFileSync(legacy, 'utf8'));
  legacyRecord.attempts[0].phases[0].receiptPath = '/tmp/bash-era-receipt.json';
  writeFileSync(legacy, JSON.stringify(legacyRecord));
  assert.equal(report(legacy).usable, true, 'record.py ready/exit-0 records remain replay-compatible without effects');
});

test('the agent pane is preferred by role, and a bash-era receipt falls back to its only term_', () => {
  const twoPanes = closed(readyReceipt({
    effects: [
      { kind: 'terminal', id: 'term_setup', role: 'setup' },
      { kind: 'terminal', id: 'term_agent', role: 'agent' },
    ],
  }));
  assert.equal(report(twoPanes).summary.terminal, 'term_agent', 'the setup pane comes first and is NOT the agent');
  assert.equal(report(twoPanes).usable, true);

  // Bash-era: no role anywhere, exactly one terminal — that one IS the agent.
  const bashEra = closed(readyReceipt({ effects: [{ kind: 'terminal', id: 'term_only' }] }));
  assert.equal(report(bashEra).summary.terminal, 'term_only');
  assert.equal(report(bashEra).usable, true, 'a record written before the role field must still be usable');

  // Labelled panes and none of them the agent's: the receipt has SAID the agent
  // pane is absent. Falling back to its setup pane would report a half-made
  // dispatch as a working worker.
  const setupOnly = closed(readyReceipt({ effects: [{ kind: 'terminal', id: 'term_setup', role: 'setup' }] }));
  assert.equal(report(setupOnly).summary.terminal, null);
  assert.equal(report(setupOnly).usable, false, 'the role-less fallback applies only when NO pane declares a role');

  // One labelled pane beside a role-less one is the same ignorance: fail closed.
  const mixed = closed(readyReceipt({
    effects: [{ kind: 'terminal', id: 'term_a' }, { kind: 'terminal', id: 'term_b', role: 'setup' }],
  }));
  assert.equal(report(mixed).usable, false);
});

test('an outcome nobody knows is UNKNOWN, never failed — the mutation may be committed', () => {
  // The committed timeout: the call was killed, so there is no receipt and no
  // exit status — but `worker-start` may well have reached the server.
  const timeout = closed('', {
    exit: null,
    argv: ['orca', 'orchestration', 'worker-start', '--task', 'task_1', '--json'],
    stderr: 'killed after 30s',
    error: new Error('spawnSync /usr/bin/orca ETIMEDOUT'),
  });
  const phase = JSON.parse(readFileSync(timeout, 'utf8')).attempts[0].phases[0];
  assert.match(phase.transport, /ETIMEDOUT/, 'the transport detail is persisted for the recovery to read');
  const verdict = phaseVerdict(timeout, 'last');
  assert.equal(verdict.verdict, 'unknown');
  assert.match(String(verdict.evidence), /ETIMEDOUT/);
  assert.equal(report(timeout).usable, false);

  // An illegible receipt is an ignorance too, not a rejection.
  assert.equal(phaseVerdict(closed('runtime_unavailable: not json {', { exit: 1 }), 'last').verdict, 'unknown');

  // A phase nobody ever closed says nothing about its mutation.
  assert.equal(phaseVerdict(begun(), 'last').verdict, 'unknown');

  // A legible refusal is still a refusal — the distinction is the whole point.
  assert.equal(phaseVerdict(closed(JSON.stringify({ ok: false, error: { code: 'boom' } }), { exit: 1 }), 'last').verdict, 'failed');
  assert.equal(
    phaseVerdict(closed(JSON.stringify({ ok: 'false', result: {} })), 'last').verdict,
    'unknown',
    'a truthy non-boolean ok is malformed, never success',
  );
  assert.equal(phaseVerdict(closed(JSON.stringify({ ok: true })), 'last').verdict, 'unknown', 'a success with no result is unknown');
});

test('taskId is the strict gate: one receipt shape, refusal when absent', () => {
  const path = begun();
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_abc' } } }) });
  assert.equal(taskId(path), 'task_abc');

  // The loose `taskId` shape is DELIBERATELY not accepted by the gate — that is
  // taskIdScan's job; collapsing the two loosens the gate or tightens the search.
  const loose = begun();
  phaseEnd(loose, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { taskId: 'task_abc' } }) });
  assert.throws(() => taskId(loose), /carries no task id/);
});

test('taskIdScan finds the newest id across attempts, both receipt shapes', () => {
  const path = begun();
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_old' } } }) });
  attemptNew(path);
  phaseBegin(path, { name: 'worker-start', identity: 'id-2', argv: ['orca'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { taskId: 'task_new' } }) });
  assert.equal(taskIdScan(path), 'task_new', 'the newest attempt wins');

  assert.throws(() => taskIdScan(begun()), /no task id recorded/);
});

test('a stale claim is a record proved EMPTY: every phase a conclusive refusal, and foreign', () => {
  const refusal = JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'no runtime here' } });
  const refused = (argv, receiptText = refusal, rest = {}) => closed(receiptText, { exit: 1, argv, ...rest });

  const foreign = ['orca', 'x', '--run', 'run_theirs'];

  // The ONE reclaimable shape: closed, refused, empty-handed, and not ours.
  assert.deepEqual(staleClaim(refused(foreign), 'run_mine'), { stale: true, foreignRun: 'run_theirs' });

  // No phase at all: the first mutation may be in flight right now.
  const bare = (() => {
    const { path } = claimRecord(store(), 'req-1');
    initRecord(path, { request: 'req-1', orca: 'orca' });
    return path;
  })();
  assert.match(staleClaim(bare, 'run_mine').reason, /no phase/);

  // An open phase is the F-001 case itself: a mutation the snapshot cannot see.
  assert.match(staleClaim(begun(foreign), 'run_mine').reason, /still open/);

  // Unknown outcomes — illegible receipt, transport that never concluded.
  assert.match(staleClaim(refused(foreign, 'not json {'), 'run_mine').reason, /unknown outcome/);
  assert.match(staleClaim(refused(foreign, refusal, { error: new Error('ETIMEDOUT') }), 'run_mine').reason, /unknown outcome/);

  // Success, with a task id and without one: both may name a live agent.
  assert.match(staleClaim(refused(foreign, JSON.stringify({ ok: true, result: { task: { id: 'task_x' } } })), 'run_mine').reason, /task id/);
  assert.match(staleClaim(refused(foreign, JSON.stringify({ ok: true, result: { state: 'ready' } })), 'run_mine').reason, /succeeded/);

  // A refusal that nonetheless reports resources created something.
  const withEffects = JSON.stringify({ ok: false, error: { code: 'boom' }, result: { effects: [{ kind: 'worktree', id: 'wt_1' }] } });
  assert.match(staleClaim(refused(foreign, withEffects), 'run_mine').reason, /resources/);
  const withResidual = JSON.stringify({ ok: false, error: { code: 'boom' }, result: { residualResources: ['wt_1'] } });
  assert.match(staleClaim(refused(foreign, withResidual), 'run_mine').reason, /resources/);

  // A later phase still open fences a record whose first phase was refused.
  const mixed = refused(foreign);
  phaseBegin(mixed, { name: 'worker-start', identity: 'id-2', argv: ['orca', 'orchestration', 'worker-start'] });
  assert.match(staleClaim(mixed, 'run_mine').reason, /still open/);

  // And the Run tests, unchanged: unprovable, or the caller's own to replay.
  assert.match(staleClaim(refused(['orca', 'x', '--json']), 'run_mine').reason, /names no Run/);
  assert.match(staleClaim(refused(['orca', 'x', '--run', 'run_mine']), 'run_mine').reason, /own Run run_mine/);
});

test('attemptNew settles the current attempt and opens the next', () => {
  const path = begun();
  attemptNew(path);
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(rec.attempts[0].settled, true);
  assert.deepEqual(rec.attempts[1], { n: 2, settled: false, phases: [] });
});
test('the newest worker-start phase owns the pane and its execution environment', () => {
  const path = begun();
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_1' } } }) });
  phaseBegin(path, {
    name: 'worker-start',
    identity: 'id-old',
    argv: ['orca', 'orchestration', 'worker-start', '--on', 'old'],
  });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({ ok: true, result: { effects: [{ kind: 'terminal', id: 'term_old' }] } }),
  });
  attemptNew(path);
  phaseBegin(path, {
    name: 'worker-start',
    identity: 'id-new',
    argv: ['orca', 'orchestration', 'worker-start', '--on=gapicore'],
  });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({
      ok: true,
      result: { effects: [{ kind: 'worktree', id: 'wt_1' }, { kind: 'terminal', id: 'term_new' }] },
    }),
  });

  assert.deepEqual(workerPane(path), { handle: 'term_new', env: 'gapicore' });
});

test('dispatch fields take the newest worker but recover --run from older phases', () => {
  const path = begun(['orca', 'orchestration', 'task-create', '--run=run_parent']);
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_1' } } }) });
  phaseBegin(path, {
    name: 'worker-start',
    identity: 'id-new',
    argv: ['orca', 'orchestration', 'worker-start', '--on', 'vps'],
  });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({
      ok: true,
      result: { dispatchId: 'ctx_new', effects: [{ kind: 'terminal', id: 'term_new' }] },
    }),
  });

  assert.deepEqual(dispatchFields(path), {
    dispatchId: 'ctx_new',
    handle: 'term_new',
    run: 'run_parent',
    env: 'vps',
  });

  const noTerminal = JSON.parse(readFileSync(path, 'utf8'));
  noTerminal.attempts[0].phases[1].receipt.result.effects = [{ kind: 'worktree', id: 'wt_1' }];
  writeFileSync(path, JSON.stringify(noTerminal));
  assert.throws(() => dispatchFields(path), /terminal effect/);
});

test('the Run and the binary are recovered newest-phase-first, and strictly', () => {
  const path = begun(['/opt/homebrew/bin/orca-ide', 'orchestration', 'task-create', '--run=run_parent', '--json']);
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_1' } } }) });
  attemptNew(path);
  // The replacement worker-start carries no --run at all: the Run survives only
  // in the settled attempt, which is exactly why the search spans the record.
  phaseBegin(path, {
    name: 'worker-start',
    identity: 'id-2',
    argv: ['/opt/homebrew/bin/orca-ide', 'orchestration', 'worker-start', '--task', 'task_1', '--json'],
  });
  assert.equal(recordedRun(path), 'run_parent');
  assert.equal(recordedBin(path), '/opt/homebrew/bin/orca-ide');

  // Strict: a record that names no Run cannot be Run-scoped, and says so.
  assert.throws(() => recordedRun(begun(['orca', 'x', '--json'])), /--run/);

  // No phase yet: the binary the record was opened with is still the answer.
  const { path: bare } = claimRecord(store(), 'req-1');
  initRecord(bare, { request: 'req-1', orca: 'orca-dev' });
  assert.equal(recordedBin(bare), 'orca-dev');
  assert.throws(() => recordedRun(bare), /--run/);
});

test('the replace lock is exclusive and every pre-existing lock fails closed', () => {
  const live = begun();
  const held = acquireLock(live);
  assert.equal(held.held, true);

  const denied = acquireLock(live);
  assert.equal(denied.held, false);
  assert.match(denied.reason, new RegExp(`pid ${process.pid}`));
  held.release();
  const again = acquireLock(live);
  assert.equal(again.held, true, 'a normal release frees the record');
  again.release();

  // A dead holder is NOT auto-reaped: read-then-unlink has an ABA race where
  // two contenders can each delete the other's new live lock.
  const dead = begun();
  const deadHolder = acquireLock(dead, { pid: 424242 });
  assert.equal(deadHolder.held, true);
  const refusedDead = acquireLock(dead);
  assert.equal(refusedDead.held, false);
  assert.match(refusedDead.reason, /pre-existing|424242|stale/);
  deadHolder.release();

  const remote = begun();
  const remoteHolder = acquireLock(remote, { host: 'vps-1' });
  assert.equal(remoteHolder.held, true);
  const fromHere = acquireLock(remote);
  assert.equal(fromHere.held, false);
  assert.match(fromHere.reason, /vps-1/);
  remoteHolder.release();

  const torn = begun();
  writeFileSync(`${torn}.lock`, '{');
  const unreadable = acquireLock(torn);
  assert.equal(unreadable.held, false);
  assert.match(unreadable.reason, /unreadable/);
});

test('task-update is accepted only when Orca confirms ready (F-003)', () => {
  assert.equal(taskUpdateOk({ ok: true, result: { task: { status: 'ready' } } }), true);
  assert.equal(taskUpdateOk({ ok: true, result: { task: { status: 'working' } } }), false);
  assert.equal(taskUpdateOk({ ok: false, result: { task: { status: 'ready' } } }), false);
  assert.equal(taskUpdateOk({ ok: true, result: {} }), false);
});


test('reads are named-key strict: a mangled record raises the missing key, never a default (F-028)', () => {
  const { path } = claimRecord(store(), 'req-1');
  writeFileSync(path, JSON.stringify({ request: 'req-1' }));
  assert.throws(() => phaseCount(path), /missing "attempts"/);
});

test('newIdentity is a lowercase uuid — the shape Orca fingerprints', () => {
  assert.match(newIdentity(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
