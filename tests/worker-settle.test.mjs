// `ax worker settle` — the mutation that stands on the gate's proof (#102).
//
// The gate can prove an attempt dead and, until this verb existed, nothing wrote
// that verdict down: `attemptSettle` was reachable only from `ax worker release
// --close`, behind landing proof a failed artifact-less attempt can never
// produce. So every proposition here is about the REFUSALS — the write itself is
// one flag, and what makes it safe is everything it declines to do.
//
// THE FIXTURES ARE CONSTRUCTED, ON PURPOSE. Measured by this issue's triage pass
// on this machine: 206 of 233 records are unsettled, 205 of them carry no `repo`
// and the one that does names another repository — so 0 records are settleable
// from this checkout, and a test standing on the host store would assert
// nothing. Records are written the way a dispatch writes them (claimRecord /
// initRecord / phaseBegin / phaseEnd), the runtime is an injected runner and
// `gh` is an injected exec: no Orca, no network, no clock.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { settle } from '../src/worker/settle.mjs';
import { attemptSettle, claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';

const TASK = 'task_05aec27bcdcf';
const REPO = 'flosrn/ax';

const store = () => mkdtempSync(join(tmpdir(), 'ax-worker-settle-'));

/**
 * A record written exactly as a dispatch writes one. `phases` may leave a phase
 * OPEN (no `receipt` key) — that is the in-flight shape the verb must refuse.
 */
function writeRecord(dir, request, phases, { repo = REPO } = {}) {
  const { path } = claimRecord(dir, request);
  initRecord(path, { request, orca: 'orca', repo });
  for (const phase of phases) {
    phaseBegin(path, { name: phase.name, identity: `id-${phase.name}`, argv: ['orca', 'orchestration', phase.name, '--json'] });
    if ('receipt' in phase) phaseEnd(path, 'last', { exit: phase.exit ?? 0, receiptText: JSON.stringify(phase.receipt) });
  }
  return path;
}

/** The `task-create` receipt shape, which is where a request's task id comes from. */
const taskCreated = (taskId = TASK) => ({ ok: true, result: { task: { id: taskId }, mutation: { requestId: 'r', replayed: false } } });

/** A `worker-start` that failed at dispatch_input, recording a pane and no ready state. */
const startFailed = (handle, { taskId = TASK, dispatchId = 'ctx_a8c1c8b9d585' } = {}) => ({
  ok: true,
  result: {
    taskId,
    dispatchId,
    state: 'failed',
    stage: 'dispatch_input',
    effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: handle }],
  },
});

/** The dead attempt this verb exists for: a task id, a failed start, an unsettled attempt. */
const deadAttempt = (dir, request, { handle = 'term_7f0854ba', repo = REPO } = {}) =>
  writeRecord(dir, request, [{ name: 'task-create', receipt: taskCreated() }, { name: 'worker-start', receipt: startFailed(handle) }], { repo });

/** One `orchestration worker-list --json` row. */
const dispatch = (id, handle, { state = 'failed', taskId = TASK } = {}) => ({
  taskId,
  dispatchId: id,
  workerState: state,
  terminalState: 'retained',
  agentTerminalHandle: handle,
});

/** An Orca answering the three reads this verb makes, and nothing else. */
function fakeRunner({ workers = [], terminals = [], omittedHostIds = [], ready = true, workerListFails = false, workerListShape = false, terminalListFails = false } = {}) {
  const calls = [];
  const receipt = result => ({ status: 0, stdout: '', stderr: '', receipt: { ok: true, result } });
  const broken = detail => ({ status: 1, stdout: '', stderr: detail, receipt: { unparseable: detail, error: 'x' } });

  const run = args => {
    calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'status') return ready ? receipt({ runtime: { reachable: true } }) : broken('not running');
    if (line.includes('worker-list')) {
      if (workerListFails) return broken('Unknown command: orchestration worker-list');
      if (workerListShape) return receipt({});
      return receipt({ workers });
    }
    if (line.includes('terminal list')) {
      if (terminalListFails) return broken('runtime_unavailable');
      return receipt({
        terminals: terminals.map(t => (typeof t === 'string' ? { handle: t } : t)),
        hostScope: { hostIds: ['local'], omittedHostIds },
        totalCount: terminals.length,
      });
    }
    throw new Error(`this verb issued a call it must never issue: ${line}`);
  };
  run.calls = calls;
  return run;
}

/** A `gh` that names this checkout's repository — or one that cannot. */
const ghSaying = (slug, { fails = false } = {}) => (bin, args) => {
  assert.equal(bin, 'gh', `this verb ran ${bin}, and it reads only gh`);
  assert.deepEqual(args, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return fails ? { status: 1, stdout: '', stderr: 'gh: not authenticated' } : { status: 0, stdout: `${slug}\n`, stderr: '' };
};

/** The verdict plus everything the operator was told, colours stripped. */
function run(argv, options = {}) {
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = settle(argv, options);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return { code, out: chunks.join('').replace(/\u001B\[\d+m/g, '') };
}

/** One settle over a live-looking machine, with everything injected. */
const settling = (path, dir, fixture = {}, argv = ['71-rls-refute'], { slug = REPO, ghFails = false } = {}) => {
  const runner = fakeRunner(fixture);
  const before = readFileSync(path, 'utf8');
  const result = run(argv, { runner, exec: ghSaying(slug, { fails: ghFails }), env: { ORCA_DISPATCH_STORE: dir } });
  return { ...result, calls: runner.calls, before, after: readFileSync(path, 'utf8') };
};

const settledFlag = path => JSON.parse(readFileSync(path, 'utf8')).attempts.at(-1).settled;

// ── the verb exists, and asking what it does settles nothing ─────────────────

test('--help is a read: usage, exit 0, and not one byte of the record touched', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const before = readFileSync(path, 'utf8');

  for (const flag of ['--help', '-h']) {
    const r = run([flag, '71-rls-refute'], { env: { ORCA_DISPATCH_STORE: dir } });
    assert.equal(r.code, 0, `${flag} refused instead of answering`);
    assert.match(r.out, /ax worker settle <task\|request>/);
    assert.equal(readFileSync(path, 'utf8'), before, `${flag} settled the record it was asked about`);
  }
});

// ── both subjects, one record, and the resolution said out loud ──────────────

test('the request id and the task id resolve to the same record, and both are printed', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const fixture = { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')], terminals: [] };

  const byRequest = settling(path, dir, fixture, ['71-rls-refute']);
  assert.equal(byRequest.code, 0, byRequest.out);
  assert.match(byRequest.out, /71-rls-refute/, 'the request it resolved is never left implicit');
  assert.match(byRequest.out, new RegExp(TASK), 'nor is the task, which is what the liveness read was filtered by');
  assert.equal(settledFlag(path), true);

  // The same record, named the other way. Settling a settled attempt is a
  // success that changes nothing, so this leaves the store as it found it.
  const byTask = settling(path, dir, fixture, [TASK]);
  assert.equal(byTask.code, 0, byTask.out);
  assert.match(byTask.out, /71-rls-refute/, 'a task id resolves to its request, and says which');
  assert.equal(byTask.after, byTask.before, 'idempotence is a no-op on disk, not a rewrite');
});

test('the resolution is printed BEFORE the refusal, so a substituted subject is visible', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute', { repo: 'goodluckagency/ofmchat' });
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] }, [TASK]);

  assert.equal(r.code, 1);
  assert.ok(r.out.indexOf('71-rls-refute') < r.out.indexOf('goodluckagency/ofmchat'), `the subject is named before the verdict on it:\n${r.out}`);
});

// ── usage: exit 2, and the two modes that are deliberately absent ────────────

test('no subject, two subjects, an unknown flag and a path are usage errors that write nothing', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const before = readFileSync(path, 'utf8');

  for (const argv of [[], ['a', 'b'], ['--verbose'], ['../71-rls-refute'], ['--dispatch', 'ctx_a8c1c8b9d585'], ['--all']]) {
    const r = run(argv, { env: { ORCA_DISPATCH_STORE: dir } });
    assert.equal(r.code, 2, `${JSON.stringify(argv)} answered ${r.code} instead of a usage error`);
    assert.match(r.out, /ax worker settle <task\|request>/, `${JSON.stringify(argv)} refused without the usage line`);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('--dispatch and --all are refused BY NAME: a dispatch is one attempt, and there is no batch', () => {
  const dir = store();
  deadAttempt(dir, '71-rls-refute');
  assert.match(run(['--dispatch', 'ctx_a8c1c8b9d585'], { env: { ORCA_DISPATCH_STORE: dir } }).out, /last attempt/);
  assert.match(run(['--all'], { env: { ORCA_DISPATCH_STORE: dir } }).out, /frontier/);
});

// ── repository scope: the flip is made from the checkout it changes ──────────

test("a record naming another repository is refused, with the checkout to run it from", () => {
  const dir = store();
  const path = deadAttempt(dir, '143-work', { repo: 'goodluckagency/ofmchat' });
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] }, ['143-work']);

  assert.equal(r.code, 1);
  assert.match(r.out, /goodluckagency\/ofmchat/, 'the repository it belongs to is named');
  assert.match(r.out, /flosrn\/ax/, 'and so is the one this run can speak for');
  assert.match(r.out, /cd .*ax worker settle 143-work/, 'the repair is the checkout that owns the flip');
  assert.equal(r.after, r.before, 'a refused record is byte-identical afterwards');
});

test('F-028: a record with no repo, or an empty one, is UNKNOWN — never "this repository"', () => {
  const dir = store();
  for (const [request, repo] of [['71-none', ''], ['72-blank', '   ']]) {
    const path = deadAttempt(dir, request, { repo });
    const r = settling(path, dir, { workers: [dispatch('ctx_dead', 'term_7f0854ba')] }, [request]);

    assert.equal(r.code, 1, `${request} was settled on an unknown owner`);
    assert.match(r.out, /names no repository/, `${request}: the reason is the absent name, not a live pane`);
    assert.match(r.out, /F-028|unknown, never/, `${request}: the rule it fails is named`);
    assert.equal(r.after, r.before);
  }
});

test('scope comparison is trimmed and case-insensitive, exactly as the frontier compares it', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute', { repo: ' FlosRN/AX ' });
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] });

  assert.equal(r.code, 0, r.out);
  assert.equal(settledFlag(path), true);
});

// ── a phase still open is a mutation possibly in flight ─────────────────────

test('a last phase with no exit and no receipt is refused in the wording record.mjs owns', () => {
  const dir = store();
  const path = writeRecord(dir, '71-rls-refute', [{ name: 'task-create', receipt: taskCreated() }, { name: 'worker-start' }]);
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] });

  assert.equal(r.code, 1);
  assert.match(r.out, /worker-start/, 'the open phase is named');
  assert.match(r.out, /may be in flight/, 'and the reason is the one this record store already owns for that shape');
  assert.equal(r.after, r.before);
});

// ── liveness: the gate's evidence, and nothing else ─────────────────────────

test('a live pane in the worker-list rows is a refusal, and the repair reads that agent', () => {
  const dir = store();
  // The record's OWN recorded pane is a corpse — and it decides nothing. What
  // forbids the write is the live pane Orca's worker-list carries for this task.
  const path = deadAttempt(dir, '71-rls-refute', { handle: 'term_7f0854ba' });
  const r = settling(path, dir, {
    workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba'), dispatch('ctx_second', 'term_live', { state: 'ready' })],
    terminals: ['term_live'],
  });

  assert.equal(r.code, 1);
  assert.match(r.out, /term_live|ctx_second/, 'the live dispatch is named');
  assert.match(r.out, /ax worker tail term_live/, 'and the repair reads it rather than settling it');
  assert.equal(r.after, r.before);
});

test("the record's own recorded pane never decides death: a live pane there settles when the rows are corpses", () => {
  const dir = store();
  // The mirror of the test above. This record recorded `term_alive`, which IS in
  // the terminal list — and the worker-list row for its task names a pane that
  // is gone. The rows decide, so this settles.
  const path = deadAttempt(dir, '71-rls-refute', { handle: 'term_alive' });
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_gone')], terminals: ['term_alive'] });

  assert.equal(r.code, 0, r.out);
  assert.equal(settledFlag(path), true);
});

test('a pane absent from a list that omits hosts is an inability, never a corpse — the gate\'s opposite disposition', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const r = settling(path, dir, {
    workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')],
    terminals: [],
    omittedHostIds: ['runtime:7930a317'],
  });

  assert.equal(r.code, 3, 'the gate answers 0 here; a verb that WRITES must not');
  assert.match(r.out, /CANNOT ESTABLISH/);
  assert.match(r.out, /runtime:7930a317/, 'the host whose absence is the whole doubt is named');
  assert.equal(r.after, r.before);
});

test('no worker-list row for the resolved task proves nothing ended', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const r = settling(path, dir, { workers: [dispatch('ctx_other', 'term_x', { taskId: 'task_someone_else' })] });

  assert.equal(r.code, 3);
  assert.match(r.out, /CANNOT ESTABLISH/);
  assert.equal(r.after, r.before);
});

test('a dispatch row with no pane recorded is unknown, not dead', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', null)] });

  assert.equal(r.code, 3);
  assert.equal(r.after, r.before);
});

// ── the lock: the proof and the write are one gesture ───────────────────────
// Found by review on PR #112, and it is F-001's own shape: `worker start
// --replace` acquiring between the liveness read and the write returns the task
// to `ready`, opens a NEW attempt and starts an agent — and `attemptSettle`
// reloads the file from disk, so the flag would land on that LIVE attempt. The
// same lock `--replace` takes is what makes the two halves indivisible; its
// header already says why ("the gate's answer is worthless the instant a
// sibling can act on it").

test('a record another caller is mid-gesture on is refused, and nothing is written', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  // A live holder: this pid, on this host, which is what `acquireLock` reads to
  // tell a working sibling from a crashed one.
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'someone-else', at: new Date().toISOString() }));

  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] });
  assert.equal(r.code, 3, 'a lost lock is an inability, never a takeover');
  assert.match(r.out, /pre-existing lock/, 'the holder is named rather than summarised');
  assert.match(r.out, new RegExp(`ax worker settle 71-rls-refute`), 'and the repair is the re-run');
  assert.equal(r.after, r.before);
  assert.equal(existsSync(`${path}.lock`), true, "another caller's lock is never removed by this verb");
});

test('the lock is HELD across the proof and released on the way out, success and refusal alike', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');

  // Diagnostic in BOTH directions, which the first cut of this test was not:
  // asserting only that no lock survives passes trivially against a verb that
  // never takes one. The runner is called from inside the locked gesture, so it
  // is the one place that can witness the lock existing while the proof runs.
  const held = [];
  const witness = fixture => {
    const inner = fakeRunner(fixture);
    const run = args => {
      held.push(existsSync(`${path}.lock`) || existsSync(`${dir}/72-live.json.lock`));
      return inner(args);
    };
    run.calls = inner.calls;
    return run;
  };

  const before = readFileSync(path, 'utf8');
  const ok = run(['71-rls-refute'], {
    runner: witness({ workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] }),
    exec: ghSaying(REPO),
    env: { ORCA_DISPATCH_STORE: dir },
  });
  assert.equal(ok.code, 0, ok.out);
  assert.notEqual(readFileSync(path, 'utf8'), before, 'the write happened, so the reads around it were the locked ones');
  assert.ok(held.every(Boolean) && held.length > 0, `the lock was not held while the machine was read: ${JSON.stringify(held)}`);
  assert.equal(existsSync(`${path}.lock`), false, 'a settled record left its lock behind');

  // And on a REFUSAL path too — the release rides a `finally`, not the happy end.
  const other = deadAttempt(dir, '72-live');
  held.length = 0;
  const refused = run(['72-live'], {
    runner: witness({ workers: [dispatch('ctx_live', 'term_live', { state: 'ready' })], terminals: ['term_live'] }),
    exec: ghSaying(REPO),
    env: { ORCA_DISPATCH_STORE: dir },
  });
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /STOP — 1 live agent/, 'the refusal under test is the live-agent one, not some earlier branch');
  assert.ok(held.every(Boolean) && held.length > 0, 'the lock was not held while the refused proof was taken');
  assert.equal(existsSync(`${other}.lock`), false, 'a refusal left its lock behind, fencing every later settle');
});

// ── an environment that cannot answer never writes ──────────────────────────

test('no Orca CLI, a silent runtime, an unreadable worker-list and an unreadable terminal list all exit 3', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const before = readFileSync(path, 'utf8');
  const env = { ORCA_DISPATCH_STORE: dir };

  const noOrca = run(['71-rls-refute'], { resolve: () => '', exec: ghSaying(REPO), env });
  assert.equal(noOrca.code, 3, 'silence is never permission');
  assert.match(noOrca.out, /Orca/);

  for (const fixture of [{ ready: false }, { workerListFails: true }, { workerListShape: true }, { terminalListFails: true }]) {
    const r = settling(path, dir, fixture);
    assert.equal(r.code, 3, `${JSON.stringify(fixture)} answered ${r.code}`);
    assert.equal(r.after, r.before);
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('no repository slug for this checkout is an inability, not a licence to settle', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] }, ['71-rls-refute'], { ghFails: true });

  assert.equal(r.code, 3);
  assert.match(r.out, /not authenticated/, "gh's own reason is carried, never summarised away");
  assert.equal(r.after, r.before);
});

test('a subject no record names, and an unreadable store, are inabilities with a named read', () => {
  const dir = store();
  deadAttempt(dir, '71-rls-refute');

  const absent = run(['99-nothing'], { runner: fakeRunner(), exec: ghSaying(REPO), env: { ORCA_DISPATCH_STORE: dir } });
  assert.equal(absent.code, 3);
  assert.match(absent.out, /ax worker ls/, 'the repair is the list that carries the request → task columns');

  const missing = run(['71-rls-refute'], { runner: fakeRunner(), exec: ghSaying(REPO), env: { ORCA_DISPATCH_STORE: join(dir, 'nope') } });
  assert.equal(missing.code, 3);
});

// ── the write itself ────────────────────────────────────────────────────────

test('the only difference on disk is settled:true, and no Orca mutation is issued', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  const sibling = deadAttempt(dir, '72-other');
  const siblingBefore = readFileSync(sibling, 'utf8');

  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')] });
  assert.equal(r.code, 0, r.out);

  const expected = JSON.parse(r.before);
  expected.attempts.at(-1).settled = true;
  assert.deepEqual(JSON.parse(r.after), expected, 'the write is one flag on the last attempt, and nothing else');
  assert.equal(readFileSync(sibling, 'utf8'), siblingBefore, 'no other record is read for writing');

  // Three reads, no mutation: the gesture is a record flag, so no pane is
  // released, closed or stopped.
  for (const call of r.calls) {
    assert.doesNotMatch(call.join(' '), /worker-release|worker-stop|terminal close/, `it issued ${call.join(' ')}`);
  }
  assert.deepEqual(r.calls.map(call => call.slice(0, 2).join(' ')).sort(), ['orchestration worker-list', 'status --json', 'terminal list'].sort());
});

test('settling an already-settled attempt is a success that changes nothing', () => {
  const dir = store();
  const path = deadAttempt(dir, '71-rls-refute');
  attemptSettle(path);

  const r = settling(path, dir, { workers: [dispatch('ctx_a8c1c8b9d585', 'term_7f0854ba')], terminals: ['term_7f0854ba'] });
  assert.equal(r.code, 0, 'idempotence, the same one attemptSettle already has');
  assert.equal(r.after, r.before);
  assert.match(r.out, /already settled/);
});
