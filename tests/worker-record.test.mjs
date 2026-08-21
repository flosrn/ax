// The record store is the F-001 countermeasure: every proposition here is the
// one an incident proved, ported from coordinator/record.test.ts — not a
// neighbour of it (F-027). Real filesystem, real O_EXCL, no mocks: the defects
// that reached users were all invisible to mocked filesystems.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  attemptNew,
  claimRecord,
  initRecord,
  newIdentity,
  phaseArgv,
  phaseBegin,
  phaseCount,
  phaseEnd,
  phaseVerdict,
  report,
  requestIdOk,
  staleClaim,
  taskId,
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
  phaseEnd(path, 'last', { exit: 1, receiptText: 'runtime_unavailable: not json {' });
  const ph = JSON.parse(readFileSync(path, 'utf8')).attempts[0].phases[0];
  assert.equal(ph.exit, 1);
  assert.match(ph.receipt.unparseable, /runtime_unavailable/);
  assert.ok(ph.receipt.error.length > 0, 'the parse error itself is part of the diagnostic');
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

test('usable is a conjunction: exit 0 alone is a receipt, not a working worker', () => {
  const ready = JSON.stringify({ ok: true, result: { state: 'ready' } });
  const booting = JSON.stringify({ ok: true, result: { state: 'booting' } });

  const a = begun();
  phaseEnd(a, 'last', { exit: 0, receiptText: ready });
  assert.equal(report(a).usable, true);

  const b = begun();
  phaseEnd(b, 'last', { exit: 0, receiptText: booting });
  assert.equal(report(b).usable, false, 'a clean exit over a partial mutation is STRANDED');

  const c = begun();
  phaseEnd(c, 'last', { exit: 1, receiptText: ready });
  assert.equal(report(c).usable, false, 'a ready state behind a failed exit is STRANDED');
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

test('a stale claim needs BOTH proofs: no task id anywhere AND a foreign Run', () => {
  // A task id anywhere → the record may name a real mutation: precious.
  const withTask = begun();
  phaseEnd(withTask, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_x' } } }) });
  assert.match(staleClaim(withTask, 'run_mine').reason, /task id/);

  // No --run recorded → foreignness cannot be proven.
  assert.match(staleClaim(begun(['orca', 'x', '--json']), 'run_mine').reason, /names no Run/);

  // Same Run → the caller can and must replay it.
  assert.match(staleClaim(begun(['orca', 'x', '--run', 'run_mine']), 'run_mine').reason, /own Run run_mine/);

  // Both conditions hold → provably useless here, and the foreign Run is named.
  assert.deepEqual(staleClaim(begun(['orca', 'x', '--run', 'run_theirs']), 'run_mine'), {
    stale: true,
    foreignRun: 'run_theirs',
  });
});

test('attemptNew settles the current attempt and opens the next', () => {
  const path = begun();
  attemptNew(path);
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(rec.attempts[0].settled, true);
  assert.deepEqual(rec.attempts[1], { n: 2, settled: false, phases: [] });
});

test('reads are named-key strict: a mangled record raises the missing key, never a default (F-028)', () => {
  const { path } = claimRecord(store(), 'req-1');
  writeFileSync(path, JSON.stringify({ request: 'req-1' }));
  assert.throws(() => phaseCount(path), /missing "attempts"/);
});

test('newIdentity is a lowercase uuid — the shape Orca fingerprints', () => {
  assert.match(newIdentity(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
