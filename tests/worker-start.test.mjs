// `ax worker start` — the F-001 write-ahead countermeasure, ported from
// orca-dispatch.test.ts. Real files and O_EXCL; only Orca itself is injected.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { armStallWatcher, start } from '../src/worker/start.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-worker-start-'));
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ax.mjs');

function stubOrca(dir, { taskCreateDelay = '0.15' } = {}) {
  const log = join(dir, 'orca-identities.log');
  const bin = join(dir, 'orca-stub');
  writeFileSync(bin, `#!/usr/bin/env bash
retry=""
prev=""
for arg in "$@"; do
  [ "$prev" = --retry-request ] && retry="$arg"
  prev="$arg"
done
[ -n "$retry" ] && printf '%s\\n' "$retry" >> ${JSON.stringify(log)}
case "$1 $2" in
  "orchestration task-create")
    sleep ${taskCreateDelay}
    echo '{"ok":true,"result":{"task":{"id":"task_race"},"mutation":{"replayed":false}}}' ;;
  "orchestration worker-start")
    echo '{"ok":true,"result":{"taskId":"task_race","dispatchId":"ctx_race","state":"ready","mutation":{"replayed":false},"effects":[{"kind":"terminal","id":"term_race"}]}}' ;;
  "orchestration worker-show")
    echo '{"ok":true,"result":{"dispatch":{"status":"completed"},"worker":{"state":"succeeded"}}}' ;;
  "terminal read")
    echo '{"ok":true,"result":{"terminal":{"latestCursor":7}}}' ;;
  "terminal list")
    echo '{"ok":true,"result":{"terminals":[]}}' ;;
  *)
    echo '{"ok":false,"error":{"code":"unexpected","message":"unexpected stub call"}}'; exit 1 ;;
esac
`, { mode: 0o755 });
  return { bin, log };
}

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawnProcess(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ code, out }));
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('condition did not become true before timeout');
}
const receipt = (result, ok = true, status = 0) => {
  const body = { ok, result };
  return { status, stdout: JSON.stringify(body), stderr: '', receipt: body };
};

function fakeRunner({
  task = 'task_abc123',
  workerState = 'ready',
  workerStage = '',
  workerLastError = '',
  workerExit = 0,
  workerError = '',
  workerTimeout = false,
  terminal = true,
  worktree = '',
  mismatch = false,
  cursor = [],
  gate = 0,
  updateStatus = 'ready',
} = {}) {
  const calls = [];
  let cursorIndex = 0;
  const run = args => {
    calls.push([...args]);
    const line = args.join(' ');
    if (line.includes('task-create')) {
      return receipt({ task: { id: task }, mutation: { replayed: calls.filter(call => call.includes('task-create')).length > 1 } });
    }
    if (line.includes('worker-start')) {
      if (mismatch) {
        const body = { ok: false, error: { code: 'request_mismatch', message: 'argv differs' } };
        return { status: 1, stdout: JSON.stringify(body), stderr: '', receipt: body };
      }
      if (workerTimeout) {
        // What a killed call looks like: no status, no receipt, and a transport
        // error — the mutation may have reached the server all the same.
        return {
          status: null,
          stdout: '',
          stderr: 'killed after 30s',
          error: new Error('spawnSync /usr/bin/orca ETIMEDOUT'),
          receipt: { unparseable: '', error: 'SyntaxError: Unexpected end of JSON input' },
        };
      }
      if (workerError) {
        const body = { ok: false, error: { code: 'runtime_unavailable', message: workerError } };
        return { status: 1, stdout: JSON.stringify(body), stderr: workerError, receipt: body };
      }
      return receipt({
        taskId: task,
        dispatchId: 'ctx_abc123',
        state: workerState,
        stage: workerStage || undefined,
        lastError: workerLastError || undefined,
        mutation: { replayed: calls.filter(call => call.includes('worker-start')).length > 1 },
        effects: [
          ...(worktree ? [{ kind: 'worktree', id: `repo_1::${worktree}` }] : []),
          ...(terminal ? [{ kind: 'terminal', id: 'term_abc123' }] : [{ kind: 'worktree', id: 'wt_1' }]),
        ],
      }, true, workerExit);
    }
    if (line.includes('task-update')) return receipt({ task: { id: task, status: updateStatus } });
    if (line.includes('terminal read')) {
      const value = cursor[Math.min(cursorIndex, Math.max(0, cursor.length - 1))];
      cursorIndex += 1;
      return receipt({ terminal: value === undefined ? {} : { latestCursor: value } });
    }
    if (line.includes('terminal send')) return receipt({ terminal: { handle: 'term_abc123' } });
    if (line.includes('worker-list')) {
      const workers = gate === 0 ? [] : gate === 1
        ? [{ taskId: task, dispatchId: 'ctx_live', agentTerminalHandle: 'term_live', workerState: 'failed', terminalState: 'retained' }]
        : [
            { taskId: task, dispatchId: 'ctx_a', agentTerminalHandle: 'term_a', workerState: 'failed', terminalState: 'retained' },
            { taskId: task, dispatchId: 'ctx_b', agentTerminalHandle: 'term_b', workerState: 'failed', terminalState: 'retained' },
          ];
      return receipt({ workers });
    }
    if (line.includes('terminal list')) {
      const terminals = gate === 0 ? [] : gate === 1 ? [{ handle: 'term_live' }] : [{ handle: 'term_a' }, { handle: 'term_b' }];
      return receipt({ terminals });
    }
    if (line.includes('task-list')) return receipt({ tasks: [{ id: task }] });
    return receipt({});
  };
  run.calls = calls;
  return run;
}

function invoke(argv, { run = fakeRunner(), env = {}, gateFn, arm, startDeps = {} } = {}) {
  const home = env.HOME ?? scratch();
  const fullEnv = {
    HOME: home,
    ORCA_DISPATCH_STORE: join(home, 'dispatch'),
    ORCA_DISPATCH_AUTOSUBMIT: '0',
    ORCA_STALL_WATCH: '0',
    ...env,
  };
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = start(argv, { runner: run, env: fullEnv, sleep: () => {}, gateFn, arm, ...startDeps });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return { code, out: chunks.join('').replace(/\u001B\[\d+m/g, ''), calls: run.calls, env: fullEnv };
}

function freshArgs(dir, request = 'req-1', passthru = ['--worktree', 'current', '--agent', 'omp']) {
  const spec = join(dir, 'brief.md');
  writeFileSync(spec, '[omp model=@smol] Do the exact task.');
  return ['--request', request, '--run', 'run_parent', '--spec-file', spec, '--', ...passthru];
}

/**
 * The child's own session, as `briefDelivered` reads it.
 *
 * `brief: false` is a BOOTED session with no user message, which is exactly
 * what a genuinely held composer looks like on disk (#56: session file at
 * 10:49:25.669Z, first user message only at 10:49:40.338Z) — and it names no
 * dispatch, because the preamble that carries `ctx_…` is the thing that never
 * got submitted. `brief: true` is the child that already has it. Returns the
 * worktree path for `fakeRunner({ worktree })`, so the record's effects name
 * what this file wrote.
 */
function witness(home, name, { brief = false, dispatch = 'ctx_abc123', ahead = 60_000, steerings = 0 } = {}) {
  const dir = join(home, '.omp', 'agent', 'sessions', `-scratch-.worktrees-${name}`);
  mkdirSync(dir, { recursive: true });
  // A child session always postdates the record that dispatched it, and the
  // witness enforces that floor so an earlier agent's history in the same
  // worktree can never be read as this dispatch's proof.
  const at = new Date(Date.now() + ahead).toISOString();
  // The `session` record shape is the live one, `cwd` included: that field is
  // why the request id cannot select a session, and the fixture must carry it
  // or the test proves nothing.
  const entries = [{ type: 'session', version: 3, timestamp: at, cwd: join(home, '.worktrees', name) }];
  if (brief) {
    entries.push({
      type: 'message',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text: `You are a dispatched worker. Your dispatch is ${dispatch}` }] },
    });
  }
  // Post-brief steering, as a delivered injection lands: another `role: 'user'`
  // entry in the child's OWN session, later than the brief. A steering that was
  // never delivered leaves nothing here, which is the whole point of counting.
  for (let n = 1; n <= steerings; n += 1) {
    entries.push({
      type: 'message',
      timestamp: new Date(Date.parse(at) + n * 60_000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `steering ${n}` }] },
    });
  }
  writeFileSync(join(dir, `${at.replace(/[:.]/g, '-')}_w.jsonl`), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  return join(home, '.worktrees', name);
}

/**
 * Another agent's session in the SAME worktree, started LATER and belonging to
 * no dispatch — an operator who opened a pane there to look around. It carries
 * the same `cwd`, so it matches the worktree and the request id exactly as the
 * real child's history does; only the dispatch id tells them apart.
 */
function intruderSession(home, name) {
  const dir = join(home, '.omp', 'agent', 'sessions', `-scratch-.worktrees-${name}`);
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() + 600_000).toISOString();
  const entries = [
    { type: 'session', version: 3, timestamp: at, cwd: join(home, '.worktrees', name) },
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'what does this worktree do?' }] } },
  ];
  writeFileSync(join(dir, `${at.replace(/[:.]/g, '-')}_intruder.jsonl`), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

const recordAt = (env, request = 'req-1') => join(env.ORCA_DISPATCH_STORE, `${request}.json`);
const identities = record => record.attempts.flatMap(attempt => attempt.phases.map(phase => phase.identity));

// ── Refuse before mutation ──────────────────────────────────────────────────

test('request ids with separators or a leading dot are refused before disk access', () => {
  for (const request of ['a/../../etc/passwd', '.hidden']) {
    const home = scratch();
    const r = invoke(['--resume', '--request', request], { env: { HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.out, /invalid --request/);
    assert.equal(lstatSync(home).isDirectory(), true);
  }
});

test('fresh start requires a non-empty spec file before claiming', () => {
  const home = scratch();
  const missing = invoke(['--request', 'req-missing', '--run', 'run_parent', '--spec-file', join(home, 'absent')], { env: { HOME: home } });
  assert.equal(missing.code, 1);
  assert.equal(missing.calls.length, 0);

  const empty = join(home, 'empty.md');
  writeFileSync(empty, '');
  const r = invoke(['--request', 'req-empty', '--run', 'run_parent', '--spec-file', empty], { env: { HOME: home } });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
});

test('new-child placement is refused in split and joined form before any claim', () => {
  for (const placement of [['--worktree', 'new-child'], ['--worktree=new-child']]) {
    const home = scratch();
    const r = invoke(freshArgs(home, 'req-new-child', placement), { env: { HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.out, /new-child/);
    assert.match(r.out, /path:/);
    assert.equal(r.calls.length, 0);
  }
});

test('remote current placement is refused in either joined-form order', () => {
  const variants = [
    ['--on', 'gapicore', '--worktree', 'current'],
    ['--on=gapicore', '--worktree=current'],
    ['--worktree=current', '--on=gapicore'],
  ];
  for (const placement of variants) {
    const home = scratch();
    const r = invoke(freshArgs(home, 'req-remote-current', placement), { env: { HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.out, /current/);
    assert.match(r.out, /gapicore/);
    assert.match(r.out, /new-top-level/);
    assert.equal(r.calls.length, 0);
  }
});

test('existing local and exact remote selectors are not over-refused', () => {
  for (const placement of [
    ['--worktree', 'path:/tmp/existing'],
    ['--worktree', 'current'],
    ['--on', 'gapicore', '--worktree', 'new-top-level', '--repo', 'id:abc'],
  ]) {
    const home = scratch();
    const r = invoke(freshArgs(home, `req-ok-${Math.random().toString(16).slice(2)}`, placement), { env: { HOME: home } });
    assert.equal(r.code, 0, r.out);
  }
});

// ── Write-ahead, replay and stranded receipts ───────────────────────────────

test('a fresh dispatch records one distinct identity per phase before returning USABLE', () => {
  const home = scratch();
  const r = invoke(freshArgs(home), { env: { HOME: home } });
  assert.equal(r.code, 0, r.out);
  const record = JSON.parse(readFileSync(recordAt(r.env), 'utf8'));
  assert.deepEqual(record.attempts[0].phases.map(phase => phase.name), ['task-create', 'worker-start']);
  assert.equal(new Set(identities(record)).size, 2);
  assert.equal(statSync(recordAt(r.env)).mode & 0o777, 0o600);
  assert.equal(r.calls.filter(call => call.includes('task-create')).length, 1);
  assert.equal(r.calls.filter(call => call.includes('worker-start')).length, 1);
});

test('--orca pins the already-resolved binary instead of resolving a different runtime', () => {
  const home = scratch();
  const run = fakeRunner();
  const bins = [];
  const args = freshArgs(home, 'req-explicit');
  args.splice(args.indexOf('--'), 0, '--orca', '/chosen/orca-ide');
  const r = invoke(args, {
    env: { HOME: home },
    run,
    startDeps: {
      runner: undefined,
      resolve: () => { throw new Error('resolver must not run when --orca is explicit'); },
      makeRunner: ({ bin }) => {
        bins.push(bin);
        return run;
      },
    },
  });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(new Set(bins), new Set(['/chosen/orca-ide']));
  assert.equal(JSON.parse(readFileSync(recordAt(r.env, 'req-explicit'), 'utf8')).orca, '/chosen/orca-ide');
});

test('fresh worker-start forwards opaque Orca argv and keeps --run before the retry identity', () => {
  const home = scratch();
  const r = invoke(freshArgs(home, 'req-argv', ['--worktree', 'current', '--agent', 'omp', '--model', 'alias', '--notes', 'x']), { env: { HOME: home } });
  assert.equal(r.code, 0, r.out);
  const call = r.calls.find(args => args.includes('worker-start'));
  assert.deepEqual(call.slice(0, 6), ['orchestration', 'worker-start', '--task', 'task_abc123', '--run', 'run_parent']);
  assert.deepEqual(call.slice(-9), ['--worktree', 'current', '--agent', 'omp', '--model', 'alias', '--notes', 'x', '--json']);
});

test('a second start on the same request replays the recorded argv without minting identities', () => {
  const home = scratch();
  const firstRun = fakeRunner();
  const first = invoke(freshArgs(home), { env: { HOME: home }, run: firstRun });
  assert.equal(first.code, 0);
  const before = JSON.parse(readFileSync(recordAt(first.env), 'utf8'));
  const replayRun = fakeRunner();
  const second = invoke(freshArgs(home), { env: { HOME: home }, run: replayRun });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /CLAIM LOST/);
  const after = JSON.parse(readFileSync(recordAt(second.env), 'utf8'));
  assert.deepEqual(identities(after), identities(before));
  assert.deepEqual(replayRun.calls[0], before.attempts[0].phases[0].argv.slice(1));
  assert.deepEqual(replayRun.calls[1], before.attempts[0].phases[1].argv.slice(1));
});

test('a torn or symlinked owner record cannot establish and issues zero mutations', () => {
  for (const kind of ['torn', 'symlink']) {
    const home = scratch();
    const store = join(home, 'dispatch');
    const env = { HOME: home, ORCA_DISPATCH_STORE: store };
    const target = join(store, 'target.json');
    const path = join(store, 'req-broken.json');
    const seed = invoke(freshArgs(home, 'seed'), { env: { HOME: home } });
    assert.equal(seed.code, 0);
    if (kind === 'torn') writeFileSync(path, '{');
    else symlinkSync(target, path);
    const run = fakeRunner();
    const r = invoke(['--resume', '--request', 'req-broken'], { env, run });
    assert.equal(r.code, 3);
    assert.match(r.out, /CANNOT ESTABLISH/);
    assert.equal(run.calls.length, 0);
  }
});

test('resume with no record says absence is NOT permission to start fresh', () => {
  const r = invoke(['--resume', '--request', 'req-none']);
  assert.equal(r.code, 3);
  assert.match(r.out, /CANNOT ESTABLISH/);
  assert.match(r.out, /NOT permission/);
  assert.equal(r.calls.length, 0);
});

test('a divergent replay is refused without changing the recorded identities', () => {
  const home = scratch();
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  const before = JSON.parse(readFileSync(recordAt(first.env), 'utf8'));
  const r = invoke(['--resume', '--request', 'req-1'], { env: { HOME: home }, run: fakeRunner({ mismatch: true }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSED/);
  assert.match(r.out, /Do not 'fix' this by minting a new/);
  assert.deepEqual(identities(JSON.parse(readFileSync(recordAt(first.env), 'utf8'))), identities(before));
});

test('only a fresh partial mutation exits 4 STRANDED; resume refuses the same result with 1', () => {
  const home = scratch();
  const fresh = invoke(freshArgs(home), { env: { HOME: home }, run: fakeRunner({ workerState: 'starting' }) });
  assert.equal(fresh.code, 4);
  assert.match(fresh.out, /STRANDED/);
  const resumed = invoke(['--resume', '--request', 'req-1'], { env: { HOME: home }, run: fakeRunner({ workerState: 'starting' }) });
  assert.equal(resumed.code, 1);
  assert.match(resumed.out, /partial mutation/);
});

// ── Replacement uses the live gate once, then a new attempt ─────────────────

test('replace maps the gate verdicts without mutating on 1, 2 or 3', () => {
  for (const [gateCode, expected] of [[1, 1], [2, 2], [3, 3]]) {
    const home = scratch();
    const first = invoke(freshArgs(home), { env: { HOME: home } });
    const before = readFileSync(recordAt(first.env), 'utf8');
    const run = fakeRunner();
    const r = invoke(['--replace', '--request', 'req-1'], { env: { HOME: home }, run, gateFn: () => gateCode });
    assert.equal(r.code, expected, r.out);
    assert.equal(readFileSync(recordAt(first.env), 'utf8'), before);
    assert.equal(run.calls.filter(call => call.includes('task-update')).length, 0);
  }
});

test('replace verifies task-update read-back before opening a new attempt (F-003)', () => {
  const home = scratch();
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  const r = invoke(['--replace', '--request', 'req-1'], {
    env: { HOME: home },
    run: fakeRunner({ updateStatus: 'working' }),
    gateFn: () => 0,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /not replacing/);
  const record = JSON.parse(readFileSync(recordAt(first.env), 'utf8'));
  assert.equal(record.attempts.length, 1);
});

test('replace reuses the task, opens one attempt, and omits --run from worker-start argv', () => {
  const home = scratch();
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  const run = fakeRunner();
  const r = invoke(['--replace', '--request', 'req-1', '--', '--worktree', 'current', '--agent', 'omp'], {
    env: { HOME: home }, run, gateFn: () => 0,
  });
  assert.equal(r.code, 0, r.out);
  const call = run.calls.find(args => args.includes('worker-start'));
  assert.equal(call.includes('--run'), false);
  assert.equal(call[call.indexOf('--task') + 1], 'task_abc123');
  const record = JSON.parse(readFileSync(recordAt(first.env), 'utf8'));
  assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[0].settled, true);
});

test('replace with no recorded task cannot establish rather than inventing one', () => {
  const home = scratch();
  const env = { HOME: home, ORCA_DISPATCH_STORE: join(home, 'dispatch') };
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  const record = JSON.parse(readFileSync(recordAt(first.env), 'utf8'));
  delete record.attempts[0].phases[0].receipt.result.task;
  delete record.attempts[0].phases[1].receipt.result.taskId;
  writeFileSync(recordAt(first.env), JSON.stringify(record));
  const r = invoke(['--replace', '--request', 'req-1'], { env });
  assert.equal(r.code, 3);
  assert.match(r.out, /first phase never succeeded|no task id/);
});

// ── The pane is never touched from the automatic path ────────────────────────

test('a USABLE dispatch touches the pane not at all', () => {
  // Orca verified `dispatch_input` itself to answer `ready`, so the brief is
  // submitted by construction. The old code still polled the cursor here and
  // typed an Enter when it had not moved — into a child that was, necessarily,
  // already working.
  const home = scratch();
  const run = fakeRunner({ cursor: [7, 7, 8], worktree: witness(home, 'req-1', { brief: true }) });
  const r = invoke(freshArgs(home), { env: { HOME: home }, run });
  assert.equal(r.code, 0);
  assert.equal(
    run.calls.some(call => call.includes('terminal') && call.includes('send')),
    false,
    'nothing is sent to a worker Orca already proved ready',
  );
});

test('a stalled dispatch whose child session shows no brief sends nothing and records nothing', () => {
  // Measured 2026-08-22: a real held composer, rescued by one Enter typed by
  // hand. It stays unrepaired by the automatic path on purpose. The witness is
  // the child's session, and the only token tying a session to this dispatch is
  // the `ctx_…` in Orca's preamble — which is exactly what an unsubmitted
  // composer is still holding. So a held composer reads as UNPROVEN, and
  // unproven never authorises typing into a live pane (15 false positives out of
  // 15 on 2026-08-24 came from doing so on a cursor reading).
  const home = scratch();
  const run = fakeRunner({
    workerState: 'failed',
    workerStage: 'dispatch_input',
    workerLastError: 'agent_prompt_stalled',
    workerExit: 1,
    worktree: witness(home, 'held-work'),
    cursor: [7, 7, 8],
  });
  const armed = [];
  const r = invoke(freshArgs(home), { env: { HOME: home }, run, arm: options => armed.push(options) });

  assert.equal(r.code, 3, 'the child may run, but a revoked capability is not a supervised worker');
  assert.equal(
    run.calls.some(call => call.includes('terminal') && call.includes('send')),
    false,
    'no unwitnessed Enter',
  );
  assert.match(r.out, /agent_prompt_stalled/);
  assert.match(r.out, /BRIEF NOT PROVEN/);
  assert.match(r.out, /NOT A SUPERVISED WORKER/);
  assert.match(r.out, /ax worker repair/, 'the explicit gesture owns the Enter now');
  assert.doesNotMatch(r.out, /STRANDED/, 'a held composer is not a half-made mutation');
  assert.equal(armed.length, 1, 'the watcher sends from the parent, so it survives the revoked capability');
  const record = JSON.parse(readFileSync(recordAt(r.env), 'utf8'));
  assert.equal(record.heldRepairAt, undefined, 'nothing was proven, so the watcher keeps its right to report a death');
});

test('with no session to witness it, a stalled dispatch is never sent an unwitnessed Enter', () => {
  // The cursor alone is the mechanism that produced 15 false positives out of
  // 15 on 2026-08-24: a child waiting on a model is exactly as silent as a held
  // composer, and movement after the Enter proves nothing either — the model
  // answering looks identical to a brief being submitted. So an unlocatable or
  // unreadable session (a remote child's JSONL lives on the other host) fails
  // CLOSED here: nothing is sent, no repair is recorded, the watcher keeps its
  // right to report the pane's death, and the operator's explicit
  // `ax worker repair` remains the gesture that may act on an unproven state.
  const home = scratch();
  const run = fakeRunner({
    workerState: 'failed',
    workerStage: 'dispatch_input',
    workerLastError: 'agent_prompt_stalled',
    workerExit: 1,
    cursor: [7, 7, 8],
  });
  const armed = [];
  const r = invoke(freshArgs(home), {
    env: { HOME: home, ORCA_DISPATCH_AUTOSUBMIT: '1', ORCA_DISPATCH_AUTOSUBMIT_GAP: '0', ORCA_DISPATCH_AUTOSUBMIT_TRIES: '4' },
    run,
    arm: options => armed.push(options),
  });

  assert.equal(r.code, 3);
  assert.equal(
    run.calls.some(call => call.includes('terminal') && call.includes('send')),
    false,
    'no witness, no send',
  );
  assert.match(r.out, /NOT PROVEN delivered/);
  assert.match(r.out, /ax worker repair/, 'the explicit gesture is named, since the automatic one refused');
  assert.equal(armed.length, 1, 'the net matters most when the brief may still be unsent');
  const record = JSON.parse(readFileSync(recordAt(r.env), 'utf8'));
  assert.equal(record.heldRepairAt, undefined, 'nothing was proven, so nothing is recorded');
});

test('a stalled dispatch whose child ALREADY recorded the brief sends nothing, and still records no repair', () => {
  // Measured 2026-08-24 on ofmchat #55/#56/#58 and the 12 triage dispatches
  // before them: 15 of 15 `agent_prompt_stalled` verdicts covered a child that
  // had the brief and was working. Orca gives the pane 5s to report `working`
  // through its status title and a cold OMP session cannot, so it fails a
  // healthy worker. The cursor cannot see the difference — a child waiting on a
  // model emits exactly as little as a held composer — and on #56 ax sent its
  // "repair" Enter eight seconds AFTER the child had recorded the brief, then
  // reported that Enter as the rescue. The child's own session is the witness.
  const home = scratch();
  const run = fakeRunner({
    workerState: 'failed',
    workerStage: 'dispatch_input',
    workerLastError: 'agent_prompt_stalled',
    workerExit: 1,
    worktree: witness(home, '56-work', { brief: true }),
    // A stable cursor: the reading that used to be called a held composer.
    cursor: [7, 7, 7],
  });
  const armed = [];
  const r = invoke(freshArgs(home), { env: { HOME: home }, run, arm: options => armed.push(options) });

  assert.equal(r.code, 3, 'the capability is still revoked, so this is not a supervised worker');
  assert.equal(
    run.calls.some(call => call.includes('terminal') && call.includes('send')),
    false,
    'a child that already has its brief is never sent a phantom Enter',
  );
  assert.match(r.out, /BRIEF DELIVERED/);
  assert.doesNotMatch(r.out, /never left the composer/, 'the cause line must not claim a lost brief the session disproves');
  assert.match(r.out, /NOT A SUPERVISED WORKER/);
  assert.equal(armed.length, 1);
  const record = JSON.parse(readFileSync(recordAt(r.env), 'utf8'));
  // A recorded brief proves RECEIPT, never liveness — a child can record it and
  // then crash. AGENTS.md is explicit: liveness is cursor movement. The marker
  // silences the watcher's death check, so it may only be written on evidence
  // that the pane is alive, and this path has none: it deliberately reads no
  // cursor. `ax worker repair` is where that evidence exists.
  assert.equal(record.heldRepairAt, undefined, 'receipt is not liveness, so the watcher keeps its death check');
});

test('a stranger\'s newer session in the same worktree is not this dispatch\'s witness', () => {
  // The witness selects ONE session, and newest-wins is not that selection: a
  // worktree outlives a dispatch, so an operator opening a pane there to look
  // around — or a later `--replace` — leaves a newer history whose first user
  // message has nothing to do with this brief. Reading it as proof would
  // suppress a genuine repair AND write the marker that tells the watcher a
  // child is running behind a pane that is merely holding text.
  //
  // The recorded request id is the discriminator: Orca's dispatch preamble names
  // the worktree, so the real child's history contains it and a stranger's does
  // not. No match, or two matches, is an inability to testify (F-028) — never
  // the newest file.
  const home = scratch();
  const worktree = witness(home, 'held-work');
  intruderSession(home, 'held-work');

  const run = fakeRunner({
    workerState: 'failed',
    workerStage: 'dispatch_input',
    workerLastError: 'agent_prompt_stalled',
    workerExit: 1,
    worktree,
    cursor: [7, 7, 8],
  });
  const r = invoke(freshArgs(home), {
    env: { HOME: home, ORCA_DISPATCH_AUTOSUBMIT: '1', ORCA_DISPATCH_AUTOSUBMIT_GAP: '0', ORCA_DISPATCH_AUTOSUBMIT_TRIES: '4' },
    run,
  });

  assert.equal(r.code, 3);
  assert.doesNotMatch(r.out, /BRIEF DELIVERED/, 'a stranger\'s message is not this dispatch\'s brief');
  assert.equal(
    run.calls.some(call => call.includes('terminal') && call.includes('send')),
    false,
    'and an unproven state is never typed into',
  );
});

test('a held composer whose brief cannot be proven submitted records no repair', () => {
  // The marker silences the watcher's death check, so it may only be written for
  // a submission that was CONFIRMED. With autosubmit off nothing is sent at all:
  // the pane may still hold the brief and no child is known to run, so the
  // watcher must keep its right to report that pane's death.
  const home = scratch();
  const run = fakeRunner({
    workerState: 'failed',
    workerStage: 'dispatch_input',
    workerLastError: 'agent_prompt_stalled',
    workerExit: 1,
    cursor: [7, 7, 8],
  });
  const armed = [];
  const r = invoke(freshArgs(home), {
    env: { HOME: home, ORCA_DISPATCH_AUTOSUBMIT: '0' },
    run,
    arm: options => armed.push(options),
  });

  assert.equal(r.code, 3);
  assert.equal(run.calls.some(call => call.includes('terminal') && call.includes('send')), false, 'nothing was sent');
  assert.match(r.out, /NOT PROVEN delivered/);
  assert.equal(armed.length, 1, 'the net matters most when the brief may still be unsent');
  const record = JSON.parse(readFileSync(recordAt(r.env), 'utf8'));
  assert.equal(record.heldRepairAt, undefined, 'no repair recorded, so the death check stays armed');
});

test('no automatic path writes the repair marker at all', () => {
  // The marker's write-ahead rule (written BEFORE the detached watcher, which
  // reads it once at startup) still stands — it moved to `ax worker repair`,
  // which is now its only writer, and worker-repair.test.mjs pins the ordering
  // there. Here the contract is simpler and stricter: this path never writes it,
  // because it never measures the pane it would be speaking for.
  const home = scratch();
  const recordPath = join(home, 'dispatch', 'req-1.json');
  const run = fakeRunner({
    workerState: 'failed',
    workerStage: 'dispatch_input',
    workerLastError: 'agent_prompt_stalled',
    workerExit: 1,
    worktree: witness(home, 'marker-work', { brief: true }),
    cursor: [7, 7, 8],
  });
  let markerAtArm;
  const r = invoke(freshArgs(home), {
    env: { HOME: home },
    run,
    arm: () => {
      markerAtArm = JSON.parse(readFileSync(recordPath, 'utf8')).heldRepairAt;
    },
  });

  assert.equal(r.code, 3);
  assert.equal(markerAtArm, undefined, 'the watcher starts with its death check intact');
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).heldRepairAt, undefined, 'and nothing writes it afterwards either');
});

test('a dispatch with no agent pane is STRANDED, and autosubmit stays inert', () => {
  const home = scratch();
  const run = fakeRunner({ terminal: false, cursor: [1, 1] });
  const r = invoke(freshArgs(home), {
    env: { HOME: home, ORCA_DISPATCH_AUTOSUBMIT: '1', ORCA_DISPATCH_AUTOSUBMIT_GAP: '0' },
    run,
  });
  // `ready` over a receipt naming no pane is a worker nobody can read: the
  // caller must recover it, not be told it is working.
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /STRANDED/);
  assert.equal(run.calls.some(call => call[0] === 'terminal'), false);
});

// ── Show is a read-only record inspection ───────────────────────────────────

test('show reads a record without arming or calling Orca', () => {
  const home = scratch();
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  assert.equal(first.code, 0);
  const run = fakeRunner();
  let armed = 0;
  const r = invoke(['--show', '--request', 'req-1'], { env: { HOME: home }, run, arm: () => { armed += 1; } });
  assert.equal(r.code, 0);
  assert.match(r.out, /"request": "req-1"/);
  assert.equal(run.calls.length, 0);
  assert.equal(armed, 0);
});

test('raw diagnostics stay on disk but every start emission is redacted', () => {
  const home = scratch();
  const token = 'dcap_startSecret_123456';
  const failed = invoke(freshArgs(home), { env: { HOME: home }, run: fakeRunner({ workerError: token }) });
  assert.equal(failed.code, 1);
  assert.doesNotMatch(failed.out, new RegExp(token));
  assert.match(failed.out, /dcap_<redacted>/);
  const path = recordAt(failed.env);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.attempts[0].phases[1].receipt.stderr, token, 'the recovery record keeps the raw diagnostic');

  const shown = invoke(['--show', '--request', 'req-1'], { env: { HOME: home }, run: fakeRunner() });
  assert.equal(shown.code, 0);
  assert.doesNotMatch(shown.out, new RegExp(token));
  assert.match(shown.out, /dcap_<redacted>/);
});

test('two released callers under DIFFERENT Runs converge on two identities, never four (F-001)', async () => {
  const home = scratch();
  const store = join(home, 'dispatch');
  const spec = join(home, 'brief.md');
  writeFileSync(spec, 'Do the one exact task.');
  const stub = stubOrca(home);
  const env = {
    ...process.env,
    HOME: home,
    ORCA_CLI_COMMAND: stub.bin,
    ORCA_DISPATCH_STORE: store,
    ORCA_DISPATCH_AUTOSUBMIT: '0',
    ORCA_STALL_WATCH: '0',
  };
  // Different Runs is the REAL shape of this race — two sessions dispatching
  // the same logical request — and it is the shape a foreign-claim takeover
  // would break: the loser must replay the owner's record, never set it aside
  // because the Run it names is not its own.
  const argv = runId => [
    'worker', 'start', '--request', 'req-race', '--run', runId,
    '--spec-file', spec, '--', '--worktree', 'current', '--agent', 'omp',
  ];

  const results = await Promise.all([runCli(argv('run_a'), env), runCli(argv('run_b'), env)]);
  assert.ok(results.some(result => result.code === 0), results.map(result => result.out).join('\n'));
  const seen = readFileSync(stub.log, 'utf8').trim().split('\n');
  assert.equal(new Set(seen).size, 2, `identities seen by Orca: ${seen.join(', ')}`);
  const record = JSON.parse(readFileSync(join(store, 'req-race.json'), 'utf8'));
  assert.deepEqual(record.attempts[0].phases.map(phase => phase.name), ['task-create', 'worker-start']);
  assert.deepEqual(
    readdirSync(store).filter(name => name.includes('foreign')),
    [],
    'no record was ever set aside as a stale foreign claim',
  );
});

test('two reclaimers of one closed foreign refusal serialize before minting', async () => {
  const home = scratch();
  const store = join(home, 'dispatch');
  const spec = join(home, 'brief.md');
  const request = 'req-stale-race';
  writeFileSync(spec, 'Do the one exact task.');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${request}.json`), JSON.stringify({
    request,
    host: 'old-host',
    orca: 'orca',
    createdAt: '2026-08-01T00:00:00Z',
    attempts: [{
      n: 1,
      settled: false,
      phases: [{
        name: 'task-create',
        identity: 'old-id',
        argv: ['orca', 'orchestration', 'task-create', '--run', 'run_old', '--retry-request', 'old-id', '--json'],
        receiptPath: null,
        receipt: { ok: false, error: { code: 'runtime_unavailable' } },
        exit: 1,
      }],
    }],
  }), { mode: 0o600 });
  const stub = stubOrca(home);
  const env = {
    ...process.env,
    HOME: home,
    ORCA_CLI_COMMAND: stub.bin,
    ORCA_DISPATCH_STORE: store,
    ORCA_DISPATCH_AUTOSUBMIT: '0',
    ORCA_STALL_WATCH: '0',
  };
  const argv = runId => [
    'worker', 'start', '--request', request, '--run', runId,
    '--spec-file', spec, '--', '--worktree', 'current', '--agent', 'omp',
  ];

  const results = await Promise.all([runCli(argv('run_a'), env), runCli(argv('run_b'), env)]);
  assert.ok(results.some(result => result.code === 0), results.map(result => result.out).join('\n'));
  const seen = readFileSync(stub.log, 'utf8').trim().split('\n');
  assert.equal(new Set(seen).size, 2, `only one fresh task/worker identity pair: ${seen.join(', ')}`);
  assert.equal(readdirSync(store).filter(name => name.includes('.foreign-')).length, 1);
  const record = JSON.parse(readFileSync(join(store, `${request}.json`), 'utf8'));
  assert.deepEqual(record.attempts[0].phases.map(phase => phase.name), ['task-create', 'worker-start']);
});

// The same invariant, pinned WITHOUT a race. The test above depends on two CLIs
// interleaving badly, which passed 20/20 locally and failed in CI: the mint used
// to happen AFTER `ownership.release()`, so a sibling could take the recovery
// lock, read a record holding one open phase, and replay it — and since
// `phaseBegin`/`phaseEnd` are load-mutate-save, that write clobbered the phase
// the first process was adding. CI ended with `['task-create']` alone while the
// stub log proved a full pair had been issued: a recorded `worker-start`, and
// therefore a real pane, gone from the file every recovery reads.
//
// Here the window is ENGINEERED rather than hoped for. The winner is held inside
// task-create long enough to prove it is in the locked region — the lock file's
// existence is the proof — and the second starter runs while it is.
test('a sibling arriving DURING the mint is refused, and no recorded phase is lost', async () => {
  const home = scratch();
  const store = join(home, 'dispatch');
  const spec = join(home, 'brief.md');
  const request = 'req-mint-window';
  writeFileSync(spec, 'Do the one exact task.');
  mkdirSync(store, { recursive: true });
  // A closed foreign refusal: reclaimable, so the winner reaches the mint.
  writeFileSync(join(store, `${request}.json`), JSON.stringify({
    request,
    host: 'old-host',
    orca: 'orca',
    createdAt: '2026-08-01T00:00:00Z',
    attempts: [{
      n: 1,
      settled: false,
      phases: [{
        name: 'task-create',
        identity: 'old-id',
        argv: ['orca', 'orchestration', 'task-create', '--run', 'run_old', '--retry-request', 'old-id', '--json'],
        receiptPath: null,
        receipt: { ok: false, error: { code: 'runtime_unavailable' } },
        exit: 1,
      }],
    }],
  }), { mode: 0o600 });

  const stub = stubOrca(home, { taskCreateDelay: '1.5' });
  const env = {
    ...process.env,
    HOME: home,
    ORCA_CLI_COMMAND: stub.bin,
    ORCA_DISPATCH_STORE: store,
    ORCA_DISPATCH_AUTOSUBMIT: '0',
    ORCA_STALL_WATCH: '0',
  };
  const argv = runId => [
    'worker', 'start', '--request', request, '--run', runId,
    '--spec-file', spec, '--', '--worktree', 'current', '--agent', 'omp',
  ];

  const winner = runCli(argv('run_a'), env);
  // The lock file existing IS the proof that the winner is inside the region
  // whose whole purpose is to exclude a sibling. No sleep guesses at it.
  const lock = join(store, `${request}.json.claim.lock`);
  await waitFor(() => existsSync(lock));

  const sibling = await runCli(argv('run_b'), env);
  assert.notEqual(sibling.code, 0, `the sibling must not proceed while the mint holds the lock: ${sibling.out}`);
  assert.match(sibling.out, /pre-existing lock/);
  assert.match(sibling.out, /--resume --request req-mint-window/, 'and it is handed the sanctioned recovery');

  const first = await winner;
  assert.equal(first.code, 0, first.out);
  const record = JSON.parse(readFileSync(join(store, `${request}.json`), 'utf8'));
  assert.deepEqual(
    record.attempts[0].phases.map(phase => phase.name),
    ['task-create', 'worker-start'],
    'both recorded phases survive a sibling that arrived mid-mint',
  );
});

test('a USABLE CLI start arms a detached watcher that settles and cleans its pidfile', async () => {
  const home = scratch();
  const store = join(home, 'dispatch');
  const watch = join(home, 'watch');
  const spec = join(home, 'brief.md');
  writeFileSync(spec, 'Do the one exact task.');
  const stub = stubOrca(home);
  const env = {
    ...process.env,
    HOME: home,
    ORCA_CLI_COMMAND: stub.bin,
    ORCA_DISPATCH_STORE: store,
    ORCA_DISPATCH_AUTOSUBMIT: '0',
    ORCA_STALL_WATCH: '1',
    ORCA_STALL_DIR: watch,
    ORCA_STALL_TICK: '0.01',
    ORCA_CARD_WATCH: '0',
  };

  const result = await runCli([
    'worker', 'start', '--request', 'req-arm', '--run', 'run_arm',
    '--spec-file', spec, '--', '--worktree', 'current', '--agent', 'omp',
  ], env);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /STALL-WATCH armed/);

  const log = join(watch, 'req-arm.log');
  await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('settled'));
  // The watcher logs `settled` inside its loop and unlinks the pidfile in the
  // `finally` that follows (`stall.mjs`), so the absence has to be WAITED for.
  // Asserting it at the first sight of the log line passed on a quiet Mac for
  // months and failed the release gate on a loaded GitHub runner — run
  // 32852604478 held v0.12.0 off npm with nothing wrong in the tree.
  await waitFor(() => !existsSync(join(watch, 'req-arm.pid')));
});

// ── ax owns four options; the rest is opaque ────────────────────────────────

test('passthrough carrying an ax-owned option is refused before the claim, split or joined', () => {
  const duplicates = [
    ['--task', 'task_other'],
    ['--task=task_other'],
    ['--run', 'run_other'],
    ['--run=run_other'],
    ['--retry-request', 'deadbeef'],
    ['--retry-request=deadbeef'],
    ['--json'],
  ];
  for (const extra of duplicates) {
    const home = scratch();
    const r = invoke(freshArgs(home, 'req-reserved', ['--worktree', 'current', '--agent', 'omp', ...extra]), { env: { HOME: home } });
    assert.equal(r.code, 1, `${extra.join(' ')} → ${r.out}`);
    assert.match(r.out, /REFUSED/);
    assert.match(r.out, new RegExp(extra[0].split('=')[0]));
    assert.equal(r.calls.length, 0, 'refused before any mutation');
    assert.equal(existsSync(recordAt(r.env, 'req-reserved')), false, 'and before the claim');
  }
});

test('the flags a caller legitimately owns are forwarded untouched', () => {
  const home = scratch();
  const passthru = [
    '--worktree', 'new-top-level', '--repo', 'id:abc', '--on', 'gapicore',
    '--agent', 'omp', '--from', 'main', '--model', 'alias', '--effort', 'high',
  ];
  const r = invoke(freshArgs(home, 'req-allowed', passthru), { env: { HOME: home } });
  assert.equal(r.code, 0, r.out);
  const call = r.calls.find(args => args.includes('worker-start'));
  assert.deepEqual(call.slice(-(passthru.length + 1)), [...passthru, '--json']);
});

// ── One replace at a time, and the gate is Run-scoped ───────────────────────

test('replace gates the RECORDED Run, never an unscoped task id', () => {
  const home = scratch();
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  assert.equal(first.code, 0);
  let seen = null;
  const r = invoke(['--replace', '--request', 'req-1'], {
    env: { HOME: home },
    gateFn: argv => {
      seen = [...argv];
      return 0;
    },
  });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(seen, ['task_abc123', '--run', 'run_parent']);
});

test('a second --replace inside the first cannot establish, and only one worker-start is issued', () => {
  const home = scratch();
  const first = invoke(freshArgs(home), { env: { HOME: home } });
  assert.equal(first.code, 0);

  // The sibling runs at the ONE moment a lockless replace is wrong: after the
  // gate answered "no live agent" and before the replacement exists.
  const run = fakeRunner();
  let nested = null;
  const r = invoke(['--replace', '--request', 'req-1'], {
    env: { HOME: home },
    run,
    gateFn: () => {
      nested ??= invoke(['--replace', '--request', 'req-1'], { env: { HOME: home }, gateFn: () => 0 });
      return 0;
    },
  });

  assert.equal(r.code, 0, r.out);
  assert.equal(nested.code, 3, nested.out);
  assert.match(nested.out, /CANNOT ESTABLISH/);
  assert.match(nested.out, new RegExp(`pid ${process.pid}`));
  assert.match(nested.out, /--resume --request req-1/);
  assert.equal(nested.calls.filter(call => call.includes('task-update')).length, 0, 'the sibling never re-readies the task');
  assert.equal(nested.calls.filter(call => call.includes('worker-start')).length, 0, 'and mints nothing');
  assert.equal(run.calls.filter(call => call.includes('worker-start')).length, 1);
  const record = JSON.parse(readFileSync(recordAt(first.env), 'utf8'));
  assert.equal(record.attempts.length, 2, 'exactly one new attempt was opened');
  // The lock is released with the gesture, so the next replace is free to run.
  const after = invoke(['--replace', '--request', 'req-1'], { env: { HOME: home }, gateFn: () => 0 });
  assert.equal(after.code, 0, after.out);
});

// ── A recovery speaks to the runtime it mutated ─────────────────────────────

/** A runner factory that tags every call with the binary it was built for. */
function binRunner(calls, options = {}) {
  return ({ bin }) => {
    const inner = fakeRunner(options);
    return args => {
      calls.push([bin, ...args]);
      return inner(args);
    };
  };
}

test('a resume replays, probes and arms through the RECORDED binary, not the one named today', () => {
  const home = scratch();
  const worktree = witness(home, 'runtime-work');
  const recorded = [];
  const seedArgs = freshArgs(home, 'req-runtime');
  seedArgs.splice(seedArgs.indexOf('--'), 0, '--orca', '/old/orca-ide');
  const seed = invoke(seedArgs, {
    env: { HOME: home },
    startDeps: { runner: undefined, resolve: () => '/new/orca', makeRunner: binRunner(recorded, { worktree }) },
  });
  assert.equal(seed.code, 0, seed.out);
  assert.deepEqual([...new Set(recorded.map(call => call[0]))], ['/old/orca-ide']);

  // The operator resumes naming today's binary. The pane, the dispatch and the
  // task all live in the recorded one — on a host carrying both `orca` and
  // `orca-ide` those are two different runtimes.
  const calls = [];
  let armedBin = null;
  const r = invoke(['--resume', '--request', 'req-runtime', '--orca', '/new/orca'], {
    env: {
      HOME: home,
      ORCA_DISPATCH_AUTOSUBMIT: '1',
      ORCA_DISPATCH_AUTOSUBMIT_GAP: '0',
      ORCA_DISPATCH_AUTOSUBMIT_TRIES: '2',
    },
    arm: ({ bin }) => { armedBin = bin; },
    startDeps: {
      runner: undefined,
      makeRunner: binRunner(calls, { cursor: [7, 7, 8], worktree }),
    },
  });

  assert.equal(r.code, 0, r.out);
  assert.ok(calls.some(call => call.includes('worker-start')), 'the replay happened');
  assert.equal(
    calls.some(call => call.includes('terminal') && call.includes('send')),
    false,
    'the automatic path sends nothing at all now — the binary that matters is the one the watcher gets',
  );
  assert.deepEqual([...new Set(calls.map(call => call[0]))], ['/old/orca-ide'], 'every call went to the recorded runtime');
  assert.equal(armedBin, '/old/orca-ide', 'the watcher watches the runtime that holds the pane');
});

test('a replace gates, updates, starts and watches through the RECORDED binary', () => {
  const home = scratch();
  const seedArgs = freshArgs(home, 'req-replace-runtime');
  seedArgs.splice(seedArgs.indexOf('--'), 0, '--orca', '/old/orca-ide');
  const seeded = invoke(seedArgs, {
    env: { HOME: home },
    startDeps: { runner: undefined, makeRunner: binRunner([]) },
  });
  assert.equal(seeded.code, 0, seeded.out);

  const calls = [];
  let gateArgs = null;
  let armedBin = null;
  const r = invoke([
    '--replace', '--request', 'req-replace-runtime', '--orca', '/new/orca',
    '--', '--worktree', 'current', '--agent', 'omp',
  ], {
    env: { HOME: home },
    gateFn: args => { gateArgs = args; return 0; },
    arm: ({ bin }) => { armedBin = bin; },
    startDeps: { runner: undefined, makeRunner: binRunner(calls) },
  });

  assert.equal(r.code, 0, r.out);
  assert.deepEqual(gateArgs, ['task_abc123', '--run', 'run_parent']);
  assert.ok(calls.some(call => call.includes('task-update')));
  assert.ok(calls.some(call => call.includes('worker-start')));
  assert.deepEqual([...new Set(calls.map(call => call[0]))], ['/old/orca-ide']);
  assert.equal(armedBin, '/old/orca-ide');
});

// ── An unknown outcome is not a rejection ───────────────────────────────────

test('a call that never concluded strands a fresh start and is refused — never "rejected" — on resume', () => {
  const home = scratch();
  const timedOut = invoke(freshArgs(home, 'req-timeout'), { env: { HOME: home }, run: fakeRunner({ workerTimeout: true }) });
  assert.equal(timedOut.code, 4, timedOut.out);
  assert.match(timedOut.out, /STRANDED/);
  assert.match(timedOut.out, /--resume --request req-timeout/);
  const record = JSON.parse(readFileSync(recordAt(timedOut.env, 'req-timeout'), 'utf8'));
  assert.match(record.attempts[0].phases[1].transport, /ETIMEDOUT/, 'the transport detail survives for the recovery');

  // The replay times out too. The mutation may be running, so the answer names
  // the ignorance and points at the same exact replay.
  const resumed = invoke(['--resume', '--request', 'req-timeout'], { env: { HOME: home }, run: fakeRunner({ workerTimeout: true }) });
  assert.equal(resumed.code, 1, resumed.out);
  assert.match(resumed.out, /UNKNOWN/);
  assert.match(resumed.out, /ETIMEDOUT/);
  assert.doesNotMatch(resumed.out, /rejected|refused the exact/);
  assert.match(resumed.out, /--resume --request req-timeout/);
});

test('a resume whose replay CONCLUDES settles — the timeout corpse never freezes the verdict', () => {
  // Measured 2026-08-23 on #59, class "circular repair": the fresh call timed
  // out, the resume replayed the exact argv, Orca answered in 196ms — and the
  // verdict still said UNKNOWN, because the stale `transport` marker survived
  // the successful phaseEnd and phaseVerdict reads it before the fresh receipt.
  // The refusal printed the same resume as its own repair, forever.
  const home = scratch();
  const timedOut = invoke(freshArgs(home, 'req-thaw'), { env: { HOME: home }, run: fakeRunner({ workerTimeout: true }) });
  assert.equal(timedOut.code, 4, timedOut.out);

  const resumed = invoke(['--resume', '--request', 'req-thaw'], { env: { HOME: home }, run: fakeRunner() });
  assert.equal(resumed.code, 0, resumed.out);
  assert.doesNotMatch(resumed.out, /UNKNOWN/, 'the fresh receipt speaks, not the corpse');
  const record = JSON.parse(readFileSync(recordAt(resumed.env, 'req-thaw'), 'utf8'));
  for (const phase of record.attempts[0].phases) {
    assert.equal(phase.transport, undefined, 'no stale transport survives a concluded replay');
  }
});

// ── The watcher is fail-open in all three ways it can fail to arm ───────────

function captureErr(fn) {
  const chunks = [];
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  try {
    fn();
  } finally {
    process.stderr.write = errWrite;
  }
  return chunks.join('');
}

test('an unarmable stall watcher never fails the dispatch: absent module, throwing spawn, failing child', () => {
  const home = scratch();
  const env = { HOME: home, ORCA_STALL_DIR: join(home, 'watch') };

  const absent = join(home, 'absent-stall.mjs');
  const missing = captureErr(() => armStallWatcher({
    request: 'req-1',
    bin: 'orca',
    env,
    modulePath: absent,
    spawnProcess: () => assert.fail('a missing module must not be spawned'),
  }));
  assert.match(missing, /NOT armed/);
  assert.match(missing, /absent-stall\.mjs is missing/);

  const modulePath = join(home, 'stall.mjs');
  writeFileSync(modulePath, '');
  const threw = captureErr(() => armStallWatcher({
    request: 'req-1',
    bin: 'orca',
    env,
    modulePath,
    spawnProcess: () => { throw new Error('EAGAIN: dcap_spawnSecret_1234 could not fork'); },
  }));
  assert.match(threw, /NOT armed/);
  assert.match(threw, /EAGAIN/);
  assert.match(threw, /dcap_<redacted>/, 'even a spawn failure is redacted');

  // The asynchronous failure: ENOENT on the interpreter arrives on the child's
  // 'error' event, after arm() returned. Unhandled, it takes down a process
  // whose mutation is already committed.
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  const armed = captureErr(() => armStallWatcher({ request: 'req-1', bin: 'orca', env, modulePath, spawnProcess: () => child }));
  assert.match(armed, /STALL-WATCH armed \(pid 4242\)/);
  assert.equal(child.listenerCount('error'), 1, 'the child error is handled, not left to crash the process');
  const late = captureErr(() => child.emit('error', new Error('spawn ENOENT')));
  assert.match(late, /NOT armed/);
  assert.match(late, /ENOENT/);
});
