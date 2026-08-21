// Cross-implementation parity, proven — not assumed. The fixture was written by
// the REAL coordinator/record.py (python3, 2026-08-21, this machine: init,
// phase-begin ×2, phase-end ×2 — the exact sequence a bash-era dispatch left on
// disk). The migration replays in-flight bash records through ax at step 4, so
// "the JS port reads them" is load-bearing for F-001 and gets its own fixture
// instead of a claim.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  attemptNew,
  phaseArgv,
  phaseBegin,
  phaseCount,
  phaseEnd,
  phaseVerdict,
  report,
  staleClaim,
  taskId,
  taskIdScan,
} from '../src/worker/record.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'record-bash-era.json');

/** A private mutable copy — the committed fixture itself is never touched. */
const copyOf = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ax-parity-')), 'req-parity.json');
  copyFileSync(FIXTURE, path);
  return path;
};

test('every reader answers on a record record.py wrote', () => {
  assert.equal(phaseCount(FIXTURE), 2);
  assert.equal(taskId(FIXTURE), 'task_parity1', 'the strict gate reads the python-written task-create receipt');
  assert.equal(taskIdScan(FIXTURE), 'task_parity1', 'the loose scan finds the worker-start shape too');

  // The argv survives byte for byte — including the shell-hostile spec text —
  // which is the whole replay property.
  const argv = phaseArgv(FIXTURE, 0);
  assert.equal(argv[6], '[omp model=@smol] probe $(danger) "quoted"');
  assert.equal(argv[argv.length - 1], '--json');

  assert.deepEqual(phaseVerdict(FIXTURE, 0).verdict, 'ran');
  const last = phaseVerdict(FIXTURE, 'last');
  assert.equal(last.verdict, 'replayed', 'mutation.replayed written by python is read by the port');

  const outcome = report(FIXTURE);
  assert.equal(outcome.mode, 'REPLAYED');
  assert.equal(outcome.usable, true, 'exit 0 + state ready, recorded by python, is USABLE here');

  // The record carries a task id: precious for stale-claim, whoever wrote it.
  assert.match(staleClaim(FIXTURE, 'run_other').reason, /task id/);
});

test('the port CONTINUES a bash-era record without disturbing its vocabulary', () => {
  const path = copyOf();
  // The --resume gesture: re-close the python-written phase, addressed by index
  // inside the SAME (still-last) attempt.
  phaseEnd(path, 0, { exit: 0, receiptText: '{"ok":true,"result":{"state":"ready"}}' });
  // The --replace gesture: settle the python attempt, open attempt 2, and run a
  // fresh phase in it.
  attemptNew(path);
  phaseBegin(path, { name: 'worker-start', identity: 'id-ws-2', argv: ['orca', 'orchestration', 'worker-start'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: '{"ok":true,"result":{"state":"ready"}}' });

  const rec = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(rec.attempts[0].settled, true, 'python-written attempt settled by the JS writer');
  assert.equal(rec.attempts[0].phases[0].exit, 0, 'phaseEnd addressed the python-written phase by index');
  assert.equal(rec.attempts[1].n, 2);
  assert.equal(rec.attempts[1].phases[0].name, 'worker-start');
  assert.equal(rec.request, 'req-parity');
  assert.ok(rec.createdAt.includes('T'), 'python ISO timestamp preserved untouched');
});
