// `ax worker repair` — the composer-EMPTY sibling of the held-composer repair.
//
// Measured 2026-08-23 on #59 pass 1: the replay created the worktree, the pane
// and the agent, and delivered NO input — pane alive, agent at its banner,
// composer empty. The operator repaired it by hand with `terminal send`, and
// every ax verb kept reporting the pass dead: no marker, no watcher, a record
// that lied. This verb is that hand gesture, with the proofs the hand skipped.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { repair } from '../src/worker/repair.mjs';

const SPEC = '[omp role=triage-worker] Read the issue and write ONLY the draft.';

const store = () => realpathSync(mkdtempSync(join(tmpdir(), 'ax-repair-')));

function record(dir, request, { state = 'failed', terminal = 'term_x', spec = SPEC, taskCreate = true, repaired = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const phases = [];
  if (taskCreate) {
    phases.push({
      name: 'task-create',
      identity: 'id-1',
      argv: ['orca', 'orchestration', 'task-create', '--run', 'run_1', '--spec', spec, '--retry-request', 'id-1', '--json'],
      exit: 0,
      receipt: { ok: true, result: { task: { id: 'task_1' } } },
    });
  }
  phases.push({
    name: 'worker-start',
    identity: 'id-2',
    argv: ['orca', 'orchestration', 'worker-start', '--task', 'task_1', '--run', 'run_1', '--retry-request', 'id-2', '--json'],
    exit: 0,
    receipt: { ok: true, result: { dispatchId: 'ctx_1', state, stage: 'dispatched', effects: [{ kind: 'terminal', role: 'agent', id: terminal }] } },
  });
  writeFileSync(
    join(dir, `${request}.json`),
    JSON.stringify({ request, createdAt: '2026-08-23T10:00:00.000Z', ...(repaired ? { heldRepairAt: '2026-08-23T10:05:00.000Z' } : {}), attempts: [{ n: 1, phases }] }),
  );
}

const receipt = result => ({ status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });

/** An Orca whose pane cursor follows a script; every argv is recorded. */
function fakeOrca({ panes = ['term_x'], omitted = [], cursors = [5, 5, 9], send = null, reachable = true } = {}) {
  const calls = [];
  let at = 0;
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push([...args]);
      const line = args.join(' ');
      if (args[0] === 'status') return receipt({ runtime: { reachable } });
      if (line.startsWith('terminal list')) return receipt({ terminals: panes.map(handle => ({ handle })), hostScope: { omittedHostIds: omitted } });
      if (line.startsWith('terminal read')) {
        const value = cursors[Math.min(at, cursors.length - 1)];
        at += 1;
        return receipt({ terminal: { status: 'running', latestCursor: value } });
      }
      if (line.startsWith('terminal send')) return send ?? receipt({ terminal: { handle: 'term_x' } });
      return { status: 1, stdout: '', stderr: `unexpected: ${line}` };
    },
  });
  return { runner, calls };
}

const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('').replace(/\u001B\[\d+m/g, '') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

const run = (argv, { dir = store(), orca = fakeOrca() } = {}) => {
  const armed = [];
  const result = capture(() =>
    repair([...argv], {
      runner: orca.runner,
      env: { ORCA_DISPATCH_STORE: dir, ORCA_DISPATCH_AUTOSUBMIT_GAP: '0' },
      sleep: () => {},
      arm: options => armed.push(options),
    }),
  );
  return { ...result, dir, calls: orca.calls, armed };
};

const sends = calls => calls.filter(args => args.join(' ').startsWith('terminal send'));
const marked = (dir, request) => typeof JSON.parse(readFileSync(join(dir, `${request}.json`), 'utf8')).heldRepairAt === 'string';

test('an EMPTY composer is proven by the Enter no-op, then gets the RECORDED brief — never the task id', () => {
  // Cursor script: idle (5,5), Enter probe moves nothing (5) — emptiness
  // proven — then the text lands and the pane advances (9).
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59'], { dir, orca: fakeOrca({ cursors: [5, 5, 5, 9] }) });

  assert.equal(r.code, 3, r.out);
  const all = sends(r.calls);
  assert.equal(all.length, 2, 'the Enter probe first, the text only after the no-op');
  assert.equal(all[0].includes('--text'), false, 'the probe carries no text — on a held composer it would append a second brief');
  const text = all[1][all[1].indexOf('--text') + 1];
  assert.equal(text, SPEC, 'the brief travels byte for byte from the task-create phase');
  assert.notEqual(text, 'task_1', 'worker-start --task is an ID; injecting it was the pre-ship defect');
  assert.match(r.out, /composer was EMPTY/);
  assert.match(r.out, /NOT A SUPERVISED WORKER/);
  assert.equal(marked(r.dir, 'req-59'), true, 'status now tells the truth');
  assert.equal(r.armed.length, 1, 'the watcher supervises the repaired child');
});

test('a HELD composer is submitted by the Enter probe alone — the spec is never appended on top', () => {
  // The sibling start.mjs repairs automatically, met here when an operator
  // aims repair at it: the brief is already typed, so the Enter probe SUBMITS
  // it (cursor moves) and no text may follow — a second copy above the typed
  // one is the injection this ordering exists to prevent.
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59'], { dir, orca: fakeOrca({ cursors: [5, 5, 9] }) });

  assert.equal(r.code, 3, r.out);
  const all = sends(r.calls);
  assert.equal(all.length, 1, 'one Enter, nothing else');
  assert.equal(all[0].includes('--text'), false);
  assert.match(r.out, /composer was HELD/);
  assert.equal(marked(r.dir, 'req-59'), true);
  assert.equal(r.armed.length, 1);
});

test('--delivered records an operator-performed repair and sends NOTHING', () => {
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59', '--delivered'], { dir });

  assert.equal(r.code, 3);
  assert.deepEqual(sends(r.calls), [], 'nothing was sent — the operator already did');
  assert.equal(marked(r.dir, 'req-59'), true);
  assert.equal(r.armed.length, 1);
});

test('an EMITTING pane refuses — a brief into a working session is a second prompt', () => {
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59'], { dir, orca: fakeOrca({ cursors: [5, 9] }) });

  assert.equal(r.code, 1);
  assert.match(r.out, /EMITTING/);
  assert.deepEqual(sends(r.calls), []);
  assert.equal(marked(r.dir, 'req-59'), false);
});

test('a dead pane refuses toward a fresh pass or a replace — there is nothing to repair into', () => {
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59'], { dir, orca: fakeOrca({ panes: [] }) });

  assert.equal(r.code, 1);
  assert.match(r.out, /gone/);
  assert.match(r.out, /--fresh --because|--replace/);
  assert.deepEqual(sends(r.calls), []);
});

test('a pane on an omitted host is INCONNU — never repaired into, never marked (F-028)', () => {
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59'], { dir, orca: fakeOrca({ panes: [], omitted: ['host_b'] }) });

  assert.equal(r.code, 3);
  assert.match(r.out, /F-028/);
  assert.deepEqual(sends(r.calls), []);
  assert.equal(marked(r.dir, 'req-59'), false);
});

test('a send that is accepted while the pane never advances records NO repair', () => {
  // The one state that must never be marked: an unproven submission with a
  // marker on it tells the watcher to trust a brief nobody saw land.
  const dir = store();
  record(dir, 'req-59');
  const r = run(['--request', 'req-59'], { dir, orca: fakeOrca({ cursors: [5, 5, 5, 5] }) });

  assert.equal(r.code, 3);
  assert.match(r.out, /NOT proven delivered/);
  assert.match(r.out, /--delivered if you see it running/);
  assert.equal(marked(r.dir, 'req-59'), false);
  assert.equal(r.armed.length, 0);
});

test('a record with no task-create phase refuses — the id is not the brief, and nothing is recomposed', () => {
  const dir = store();
  record(dir, 'req-59', { taskCreate: false });
  const r = run(['--request', 'req-59'], { dir });

  assert.equal(r.code, 1);
  assert.match(r.out, /no task-create phase carries a --spec/);
  assert.deepEqual(sends(r.calls), []);
});

test('a usable record has nothing to repair, and an already-repaired one is a quiet yes', () => {
  const dir = store();
  record(dir, 'req-ok', { state: 'ready' });
  const usable = run(['--request', 'req-ok'], { dir });
  assert.equal(usable.code, 1);
  assert.match(usable.out, /nothing to repair/);

  record(dir, 'req-done', { repaired: true });
  const done = run(['--request', 'req-done'], { dir });
  assert.equal(done.code, 0);
  assert.match(done.out, /already repaired/);
  assert.deepEqual(sends(done.calls), []);
});

test('no record is CANNOT ESTABLISH — absence is not permission to invent a dispatch', () => {
  const r = run(['--request', 'req-none']);
  assert.equal(r.code, 3);
  assert.match(r.out, /absence is not permission/);
});

test('usage: --request is required and validated', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['--request', '../evil']).code, 2);
  assert.equal(run(['--request', 'req-1', '--force']).code, 2);
});
