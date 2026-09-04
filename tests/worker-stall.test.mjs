// Detached stall watcher — every proposition is ported from
// orca-stall-watch.test.ts. The loop uses a fake clock and injected Orca; real
// files still prove the record and pidfile lifecycle.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { progressOnly, stall } from '../src/worker/stall.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-worker-stall-'));
const receipt = result => {
  const body = { ok: true, result };
  return { status: 0, stdout: JSON.stringify(body), stderr: '', receipt: body };
};

function writeRecord(store, request, { on = 'envx', terminal = true, repaired = false } = {}) {
  mkdirSync(store, { recursive: true });
  const path = join(store, `${request}.json`);
  writeFileSync(path, JSON.stringify({
    request,
    // The fact `start.mjs` persists after a CONFIRMED submission, and the only
    // thing that tells this watcher a repaired child is alive behind a `failed`
    // dispatch.
    ...(repaired ? { heldRepairAt: '2026-08-22T11:43:00.000Z' } : {}),
    attempts: [{ n: 1, settled: false, phases: [
      {
        name: 'task-create',
        argv: ['orca', 'orchestration', 'task-create', '--run', 'run_test123', '--json'],
        receipt: { ok: true, result: { task: { id: 'task_1' } } },
      },
      {
        name: 'worker-start',
        argv: ['orca', 'orchestration', 'worker-start', ...(on ? ['--on', on] : []), '--json'],
        receipt: {
          ok: true,
          result: {
            dispatchId: 'ctx_t1',
            effects: terminal ? [{ kind: 'terminal', id: 'term_t1' }] : [{ kind: 'worktree', id: 'wt_1' }],
          },
        },
      },
    ] }],
  }));
  return path;
}

function fakeRunner({ settled = false, status = null, cursors = [1, 2, 3, 4, 5, 6], readFails = 0, cards = ['in-progress\t1/4 · Work · task'], worktree = '/tmp/work', worktrees = null, sendFails = false, sendRefused = null, omittedHosts = [], showFails = false, paneStatus = null } = {}) {
  const calls = [];
  let cursorIndex = 0;
  let cardIndex = 0;
  let listIndex = 0;
  let sendCount = 0;
  let readCount = 0;
  // `worktrees` is the per-`terminal list` series, for transient discovery.
  const listSeries = worktrees ?? [worktree];
  const cardPath = [...listSeries].reverse().find(Boolean) ?? '';
  const run = args => {
    calls.push([...args]);
    // Match on argv, never on the joined line: an alert body quotes the repair
    // commands ('orca terminal read', 'orca worktree ps') and a substring match
    // would answer a send with a probe receipt.
    const command = `${args[0]} ${args[1]}`;
    if (command === 'orchestration send') {
      sendCount += 1;
      // Orca's own refusal: the CLI throws on `lifecycle.action === 'rejected'`,
      // so the receipt is `ok: false` with the lifecycle code, exit 1 — and the
      // message is STILL recorded on the Run as a `status`, which is what makes
      // every retry a wake.
      if (sendRefused) {
        const body = { ok: false, error: { code: sendRefused, message: 'No active Dispatch belongs to this message sender.' } };
        return { status: 1, stdout: JSON.stringify(body), stderr: '', receipt: body };
      }
      const fails = typeof sendFails === 'number' ? sendCount <= sendFails : sendFails;
      if (fails) return { status: 1, stdout: '', stderr: 'send failed', receipt: { ok: false, error: { message: 'send failed' } } };
      return receipt({ message: { id: `msg_${calls.length}` } });
    }
    if (command === 'orchestration worker-show') {
      if (showFails) {
        const body = { ok: false, error: { message: 'runtime unreachable' } };
        return { status: 1, stdout: JSON.stringify(body), stderr: 'unreachable', receipt: body };
      }
      if (status) return receipt({ dispatch: { status: status.dispatch }, worker: { state: status.worker } });
      return receipt({ dispatch: { status: settled ? 'completed' : 'running' }, worker: { state: settled ? 'succeeded' : 'working' } });
    }
    if (command === 'terminal read') {
      readCount += 1;
      if (readCount <= readFails) {
        return { status: 1, stdout: '', stderr: 'transient read failure', receipt: { ok: false, error: { message: 'read failed' } } };
      }
      const value = cursors[Math.min(cursorIndex, Math.max(0, cursors.length - 1))];
      cursorIndex += 1;
      // The measured shape of a dead pane: a real status beside a real cursor.
      const terminal = value === null || value === undefined ? {} : { latestCursor: value };
      if (paneStatus !== null) terminal.status = paneStatus;
      return receipt({ terminal });
    }
    if (command === 'terminal list') {
      const value = listSeries[Math.min(listIndex, Math.max(0, listSeries.length - 1))] ?? '';
      listIndex += 1;
      return receipt({
        terminals: value ? [{ handle: 'term_t1', worktreePath: value }] : [],
        // Only when asked for: every other test asserts against a runtime that
        // could account for every host, which is what makes an absence a death.
        ...(omittedHosts.length > 0 ? { hostScope: { omittedHostIds: omittedHosts } } : {}),
      });
    }
    if (command === 'worktree ps') {
      const value = cards[Math.min(cardIndex, Math.max(0, cards.length - 1))] ?? '';
      cardIndex += 1;
      const [workspaceStatus = '', ...comment] = value.split('\t');
      return receipt({ worktrees: value ? [{ path: cardPath, workspaceStatus, comment: comment.join('\t') }] : [] });
    }
    return receipt({});
  };
  run.calls = calls;
  return run;
}

function invoke({ request = 'req-watch', record = true, recordOptions, runner = fakeRunner(), env = {}, before, processAlive, pid = 4242, append, maxTicks = 5000 } = {}) {
  const home = env.HOME ?? scratch();
  const store = env.ORCA_DISPATCH_STORE ?? join(home, 'dispatch');
  const watchDir = env.ORCA_STALL_DIR ?? join(home, 'watch');
  const fullEnv = {
    HOME: home,
    ORCA_DISPATCH_STORE: store,
    ORCA_STALL_DIR: watchDir,
    ORCA_STALL_TICK: '1',
    ORCA_STALL_AFTER: '3',
    ORCA_STALL_LIFETIME: '6',
    ORCA_CARD_WATCH: '1',
    ORCA_CARD_MAX: '20',
    ...env,
  };
  const path = record ? writeRecord(store, request, recordOptions) : join(store, `${request}.json`);
  before?.({ path, watchDir, store });
  let seconds = 0;
  let ticks = 0;
  const now = () => seconds;
  const sleep = ms => {
    ticks += 1;
    if (ticks > maxTicks) throw new Error(`the watcher did not terminate within ${maxTicks} ticks`);
    seconds += ms / 1000;
  };
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => (chunks.push(String(chunk)), true);
  process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  let code;
  try {
    code = stall(['--request', request, '--orca', 'orca'], { runner, env: fullEnv, now, sleep, pid, processAlive, append });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  const logPath = join(watchDir, `${request}.log`);
  return { code, out: chunks.join('').replace(/\u001B\[\d+m/g, ''), calls: runner.calls, path, watchDir, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
}

const sends = calls => calls.filter(args => args[0] === 'orchestration' && args[1] === 'send');

test('a settled local dispatch ends on the first probe and sends nothing', () => {
  const runner = fakeRunner({ settled: true });
  const r = invoke({ runner, recordOptions: { on: '' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0);
  assert.match(r.log, /settled/);
  assert.equal(existsSync(join(r.watchDir, 'req-watch.pid')), false);
});

test('an emitting pane never alarms; lifetime ends the watch', () => {
  const r = invoke({ runner: fakeRunner({ cursors: [1, 2, 3, 4, 5, 6, 7] }), env: { ORCA_STALL_LIFETIME: '4' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0);
  assert.match(r.log, /lifetime/);
});

test('a vanished record ends the running watcher without an alert', () => {
  const runner = fakeRunner({ cursors: [1, 2, 3] });
  const home = scratch();
  const store = join(home, 'dispatch');
  const watchDir = join(home, 'watch');
  const path = writeRecord(store, 'req-gone');
  let seconds = 0;
  const code = stall(['--request', 'req-gone', '--orca', 'orca'], {
    runner,
    env: { HOME: home, ORCA_DISPATCH_STORE: store, ORCA_STALL_DIR: watchDir, ORCA_STALL_TICK: '1', ORCA_STALL_AFTER: '9' },
    now: () => seconds,
    sleep: ms => { seconds += ms / 1000; if (existsSync(path)) rmSync(path); },
    pid: 4243,
  });
  assert.equal(code, 0);
  assert.equal(sends(runner.calls).length, 0);
  assert.match(readFileSync(join(watchDir, 'req-gone.log'), 'utf8'), /record gone/);
});

test('a frozen remote pane emits exactly one local-run alert, then exits', () => {
  const runner = fakeRunner({ cursors: [7, 7, 7, 7] });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  const alert = sends(r.calls);
  assert.equal(alert.length, 1);
  assert.equal(alert[0][alert[0].indexOf('--to') + 1], 'run:run_test123');
  assert.equal(alert[0].includes('--environment'), false, 'the mother is local');
  assert.match(alert[0][alert[0].indexOf('--subject') + 1], /req-watch/);
  assert.match(alert[0][alert[0].indexOf('--body') + 1], /ctx_t1/);
  for (const read of r.calls.filter(args => args[0] === 'terminal' && args[1] === 'read')) {
    assert.equal(read[read.indexOf('--environment') + 1], 'envx');
    assert.equal(read[read.indexOf('--terminal') + 1], 'term_t1');
  }
});

test('a second watcher with a live holder exits without touching its pidfile', () => {
  let pidPath;
  const r = invoke({
    before: ({ watchDir }) => {
      mkdirSync(watchDir, { recursive: true });
      pidPath = join(watchDir, 'req-watch.pid');
      writeFileSync(pidPath, '999');
    },
    processAlive: () => true,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /already armed/);
  assert.equal(readFileSync(pidPath, 'utf8'), '999');
  assert.equal(r.calls.length, 0);
});

test('missing record cannot establish a watch', () => {
  const r = invoke({ record: false });
  assert.equal(r.code, 3);
  assert.match(r.out, /CANNOT ESTABLISH/);
});

test('a record with no terminal effect names that missing field', () => {
  const r = invoke({ recordOptions: { terminal: false } });
  assert.equal(r.code, 3);
  assert.match(r.out, /terminal effect/);
});

test('a path-shaped request id is refused before filesystem access', () => {
  const r = invoke({ request: 'a/../../etc/passwd', record: false });
  assert.equal(r.code, 1);
  assert.match(r.out, /invalid --request/);
  assert.equal(r.calls.length, 0);
});

test('the default silence floor is 45 minutes', () => {
  const r = invoke({ runner: fakeRunner({ cursors: [1] }), env: { ORCA_STALL_AFTER: undefined, ORCA_STALL_LIFETIME: '0' } });
  assert.equal(r.code, 0);
  assert.match(r.log, /after=2700s/);
});

test('a deliberate card change wakes in the child words, redacted, without ending early', () => {
  const token = 'dcap_cardSecret_123456';
  const runner = fakeRunner({
    cursors: [1, 2, 3, 4, 5],
    cards: ['in-progress\t1/4 · Work · task', `in-review\t1/4 · DECISION: portails ${token}`, `in-review\t1/4 · DECISION: portails ${token}`],
  });
  const r = invoke({ runner, env: { ORCA_STALL_LIFETIME: '3' } });
  const alert = sends(r.calls);
  assert.equal(alert.length, 1);
  const body = alert[0][alert[0].indexOf('--body') + 1];
  assert.match(body, /DECISION: portails/);
  assert.doesNotMatch(body, new RegExp(token));
  assert.match(body, /dcap_<redacted>/);
  assert.doesNotMatch(body, /gone silent/);
  assert.match(r.log, /card change #1/);
  assert.match(r.log, /lifetime/);
});

test('the card present at arming is baseline, never replayed as a change', () => {
  const runner = fakeRunner({ cursors: [1, 2, 3, 4], cards: ['in-progress\tDECISION: old news'] });
  const r = invoke({ runner, env: { ORCA_STALL_LIFETIME: '2' } });
  assert.equal(sends(r.calls).length, 0);
});

test('ORCA_CARD_WATCH=0 never reads the board', () => {
  const runner = fakeRunner({ cursors: [1, 2, 3] });
  const r = invoke({ runner, env: { ORCA_CARD_WATCH: '0', ORCA_STALL_LIFETIME: '2' } });
  assert.equal(r.calls.some(args => args[0] === 'worktree' && args[1] === 'ps'), false);
  assert.match(r.log, /disabled by ORCA_CARD_WATCH=0/);
});

test('a settled remote dispatch keeps card watch alive while the pane emits', () => {
  const runner = fakeRunner({ settled: true, cursors: [1, 2, 3, 4], cards: ['in-progress\t1/2 · Work · task', 'in-review\tDECISION: remote done'] });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '1', ORCA_STALL_LIFETIME: '2' } });
  assert.equal(sends(r.calls).length, 1);
  assert.match(r.log, /stall watch off, card watch continues/);
  assert.doesNotMatch(sends(r.calls)[0][sends(r.calls)[0].indexOf('--body') + 1], /gone silent/);
});

test('a settled remote dispatch whose pane is gone exits', () => {
  const runner = fakeRunner({ settled: true, cursors: [null], worktree: '' });
  const r = invoke({ runner });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0);
  assert.match(r.log, /settled/);
});

test('checkpoint progress is suppressed and logged', () => {
  assert.equal(progressOnly('2/11 · Prerender · Fix showcase-context.tsx:43 class A read'), true);
});

test('a deliberate long card with the same counter still wakes', () => {
  assert.equal(progressOnly('14/22 · Prerender · build rouge · PR non ouverte · SHA 901a9c066. Learning fige.'), false);
});

test('DECISION always wakes, including a three-segment card', () => {
  assert.equal(progressOnly('3/11 · DECISION: la frontiere de tenancy a bouge'), false);
});

test('the terminal N/N card wakes even though it matches extension grammar', () => {
  assert.equal(progressOnly('12/12 · done'), false);
  assert.equal(progressOnly('12/12'), false);
});

test('equal counts alone do not wake when the card is not terminal', () => {
  assert.equal(progressOnly('12/12 · Review · Three review axes: Standards, Spec, Correctness'), true);
});

test('checkpoint-shaped changes are skipped but deliberate and terminal changes send', () => {
  const cases = [
    ['2/11 · Prerender · Fix showcase-context.tsx:43 class A read', 0],
    ['14/22 · Prerender · build rouge · PR non ouverte · SHA 901a9c066. Learning fige.', 1],
    ['12/12 · done', 1],
    ['12/12 · Review · Three review axes: Standards, Spec, Correctness', 0],
  ];
  for (const [comment, expected] of cases) {
    const runner = fakeRunner({ cursors: [1, 2, 3, 4], cards: ['in-progress\t1/4 · Work · task', `in-review\t${comment}`, `in-review\t${comment}`] });
    const r = invoke({ request: `req-${Math.random().toString(16).slice(2)}`, runner, env: { ORCA_STALL_LIFETIME: '2' } });
    assert.equal(sends(r.calls).length, expected, comment);
    if (expected === 0) assert.match(r.log, /checkpoint extension's own shape/);
  }
});

test('a failed card send keeps the baseline so the unchanged card wakes next tick', () => {
  const deliberate = 'in-review\tDECISION: portails';
  const runner = fakeRunner({
    cursors: [1, 2, 3, 4, 5, 6],
    cards: ['in-progress\t1/4 · Work · task', deliberate, deliberate, deliberate],
    sendFails: 1,
  });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '99', ORCA_STALL_LIFETIME: '4' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 2, 'the failed send is retried once the card is still unchanged');
  assert.match(r.log, /card alert failed; keeping the previous baseline/);
  assert.match(r.log, /card change #1/);
  assert.doesNotMatch(r.log, /card change #2/);
});

test('a worktree that resolves late still arms card watch and takes a baseline', () => {
  const runner = fakeRunner({
    cursors: [1, 2, 3, 4, 5],
    worktrees: ['', '/tmp/work'],
    cards: ['in-progress\t1/4 · Work · task', 'in-review\tDECISION: late board'],
  });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '99', ORCA_STALL_LIFETIME: '3' } });
  assert.equal(r.code, 0);
  assert.match(r.log, /retrying discovery each tick/);
  assert.match(r.log, /worktree resolved late at \/tmp\/work/);
  assert.equal(sends(r.calls).length, 1);
  assert.match(sends(r.calls)[0][sends(r.calls)[0].indexOf('--body') + 1], /DECISION: late board/);
});

test('an unwritable log never stops the watch after the claim', () => {
  const runner = fakeRunner({ cursors: [7, 7, 7, 7] });
  const r = invoke({
    runner,
    append: () => { throw new Error('no space left on device'); },
    env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.log, '', 'the injected append wrote nothing');
  assert.equal(sends(r.calls).length, 1, 'the alert still went out');
});

test('malformed tick, floor, lifetime and card ceiling fall back to the documented defaults', () => {
  const runner = fakeRunner({ cursors: [7, 7, 7] });
  const r = invoke({
    runner,
    env: {
      ORCA_STALL_TICK: 'abc',
      ORCA_STALL_AFTER: 'Infinity',
      ORCA_STALL_LIFETIME: 'oops',
      ORCA_CARD_MAX: 'NaN',
    },
  });
  assert.equal(r.code, 0);
  assert.match(r.log, /tick=60s after=2700s lifetime=43200s/);
  assert.match(r.log, /ALERT sent/);
});

test('a failed receipt with a readable pane is not settled; a frozen pane still alerts', () => {
  const runner = fakeRunner({ status: { dispatch: 'failed', worker: 'failed' }, cursors: [7, 7, 7, 7] });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  assert.match(r.log, /failed receipt \(dispatch=failed worker=failed\) but the pane still reads/);
  assert.doesNotMatch(r.log, /settled: dispatch=failed/);
  assert.equal(sends(r.calls).length, 1);
  const alert = sends(r.calls)[0];
  assert.match(alert[alert.indexOf('--subject') + 1], /gone silent/);
  assert.match(alert[alert.indexOf('--body') + 1], /dispatch=failed worker=failed/);
});

test('a failed receipt whose pane cannot be read is terminal', () => {
  const runner = fakeRunner({ status: { dispatch: 'failed', worker: 'failed' }, cursors: [null] });
  const r = invoke({ runner, env: { ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0);
  assert.match(r.log, /settled: dispatch=failed worker=failed; exiting/);
});

test('a stale watcher pidfile fails closed instead of racing an automatic takeover', () => {
  let pidPath;
  const r = invoke({
    runner: fakeRunner({ cursors: [1, 2, 3] }),
    before: ({ watchDir }) => {
      mkdirSync(watchDir, { recursive: true });
      pidPath = join(watchDir, 'req-watch.pid');
      writeFileSync(pidPath, '999');
    },
    processAlive: () => false,
    env: { ORCA_STALL_AFTER: '99', ORCA_STALL_LIFETIME: '2' },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /dead pid 999/);
  assert.match(r.out, /automatic takeover is refused/);
  assert.equal(r.calls.length, 0, 'no second watcher probes or alerts');
  assert.equal(readFileSync(pidPath, 'utf8'), '999', 'the existing ownership evidence is untouched');
});

test('a transient terminal-read failure never proves a failed worker dead', () => {
  const runner = fakeRunner({
    status: { dispatch: 'failed', worker: 'failed' },
    readFails: 1,
    cursors: [7, 7, 7, 7],
  });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.log, /settled: dispatch=failed worker=failed; exiting/);
  assert.match(r.log, /failed receipt .* pane still reads/);
  assert.equal(sends(r.calls).length, 1, 'supervision survived the transient probe failure and later alerted');
});

test('a failed silence alert is retried on the next tick, then ends the watch', () => {
  const runner = fakeRunner({ cursors: [7, 7, 7, 7, 7], sendFails: 1 });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 2);
  assert.match(r.log, /stall alert failed; will retry next tick/);
  assert.match(r.log, /ALERT sent to run:run_test123; exiting/);
});

// Measured 2026-09-02 on the package's own checkout: two watchers armed on brief
// dispatches that later settled `failed` (their panes released by the
// orchestrator) alerted after the silence window, Orca refused the alert with
// `sender_not_assignee` — "No active Dispatch belongs to this message sender" —
// and the watcher read that refusal as a transport failure to retry next tick.
// Sixty seconds × ten hours: six hundred rejected escalations, each recorded on
// the orchestrator's Run as a `status` message, each delivered to its pane and
// each pre-empting the tool call it was making.
//
// The refusal is about the ENVELOPE and its sender, not a verdict on the
// watched worker: the watcher sends from the orchestrator pane's own
// environment, and Orca decides each lifecycle code on facts that cannot change
// between two ticks. Orca also records the refused body on the Run as a
// `status`, so the wake already happened. One refusal, one exit, and the log
// says which code and why — never a claim that the worker is dead.
test("Orca's lifecycle refusal of an alert ends the watch once, with the code and reason on record", () => {
  const runner = fakeRunner({
    status: { dispatch: 'failed', worker: 'failed' },
    cursors: [7, 7, 7, 7, 7, 7],
    sendRefused: 'sender_not_assignee',
  });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 1, 'one refusal is final for this sender; there is no second send');
  assert.match(r.log, /Orca refused the stall alert as a lifecycle message: sender_not_assignee — No active Dispatch belongs to this message sender/);
  assert.match(r.log, /recorded on the Run as a rejected status, and a retry can only repeat the refusal; exiting/);
  assert.doesNotMatch(r.log, /will retry next tick/);
  assert.doesNotMatch(r.log, /no active Dispatch is left to supervise|settled/, 'the exit claims nothing about the watched worker');
});

test('a refusal on a worker that still reads live is the same exit — the envelope, not the worker, was judged', () => {
  // Review of the first draft (Codex, P1): `dispatch_capability_invalid` and
  // `task_dispatch_mismatch` do not prove the worker ended. They do not have
  // to: the watcher presents no capability and names no task, so the next
  // attempt is the same attempt, and the refused body already reached the Run.
  const runner = fakeRunner({
    status: { dispatch: 'dispatched', worker: 'ready' },
    cursors: [7, 7, 7, 7, 7, 7],
    sendRefused: 'dispatch_capability_invalid',
  });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 1);
  assert.match(r.log, /Orca refused the stall alert as a lifecycle message: dispatch_capability_invalid/);
  assert.doesNotMatch(r.log, /dead|GONE|settled/, 'no death is reported on a refusal');
});

test('a transport failure of an alert is still retried — only a lifecycle refusal is terminal', () => {
  const runner = fakeRunner({ cursors: [7, 7, 7, 7, 7], sendFails: 1 });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(sends(r.calls).length, 2);
  assert.match(r.log, /stall alert failed; will retry next tick/);
});

test('a card change feeds the silence clock, so one child is never woken twice', () => {
  // Measured 2026-08-22: `comm-ax-card` published `DECISION: …`, its parent was
  // woken, and 58 seconds later the SAME watcher sent a silence alert about the
  // same child. Only cursor movement fed the clock, so the one channel that
  // crosses hosts did not count as being alive — and an orchestrator was woken
  // twice about a worker that had just spoken to it.
  const runner = fakeRunner({
    cursors: [7],
    cards: ['in-progress\tstarted', 'in-progress\tstarted', 'in-progress\tDECISION: answer me'],
  });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '3', ORCA_STALL_LIFETIME: '4' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 1, 'the card woke the parent; the silence alert must not repeat it');
  assert.match(sent[0].join(' '), /published a checkpoint/);
  assert.match(r.log, /lifetime/, 'the watch ended on its lifetime, not on a second alert');
});

test('a pane proven gone on an unsettled dispatch is reported once, and named as gone', () => {
  // The one stop no in-process hook can announce: measured 2026-08-22, closing
  // the pane of a worker holding an unfinished todo produced no report at all,
  // and the silence net would have taken the full stall window to say anything.
  // `worktrees: ['']` and not a series: card watch is off for a local dispatch, so
  // `paneGone` is the only reader of the inventory here.
  const runner = fakeRunner({ cursors: [null], worktrees: [''] });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '30', ORCA_STALL_LIFETIME: '60' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].join(' '), /is GONE without reporting/);
  assert.match(sent[0].join(' '), /no completion report will ever arrive/);
  assert.match(r.log, /GONE alert sent/);
});

test('an inventory that omits a host never claims a death', () => {
  // Absence is only proof on a list that could account for every host, which is
  // `terminalInventory`'s own contract. A paired remote runtime makes the local
  // list partial, and a watcher that read that as a corpse would send an
  // orchestrator to bury a worker that is still building.
  const runner = fakeRunner({ cursors: [null], worktrees: [''], omittedHosts: ['runtime:elsewhere'] });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '6' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].join(' '), /has gone silent/, 'the silence net still fires; the death does not');
  assert.doesNotMatch(r.log, /GONE alert/);
});

test('an unknown dispatch state never becomes a death, however absent the pane', () => {
  // Fail-open, the rule this file states at the top: only a value that was really
  // READ may stop a dispatch. An unreachable `worker-show` reports
  // `settled: false`, which is indistinguishable from a live dispatch — so a
  // watcher reading it as "not settled, and the pane is gone" would bury a worker
  // on the strength of a probe that never answered.
  const runner = fakeRunner({ cursors: [null], worktrees: [''], showFails: true });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '6' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].join(' '), /has gone silent/, 'the silence net still fires; the death does not');
  assert.doesNotMatch(r.log, /GONE alert/);
});

test('a silence alert measured from a card says so, instead of claiming a quiet pane', () => {
  // The clock now counts two signs of life, so the alert must name the one it
  // measured from. Wording it "no new terminal line" after a card would be a
  // false sentence in an alert — and it would hide from the reader that they had
  // already been sent that card.
  const runner = fakeRunner({
    cursors: [7],
    cards: ['in-progress\tstarted', 'in-progress\tstarted', 'in-progress\tDECISION: answer me'],
  });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '3', ORCA_STALL_LIFETIME: '20' } });
  const sent = sends(r.calls);
  assert.equal(sent.length, 2, 'the card wake, then a silence claim measured from it');
  const body = sent[1][sent[1].indexOf('--body') + 1];
  assert.match(body, /last sign of life was a WORKTREE CARD/);
  assert.doesNotMatch(body, /pane cursor has not advanced/);
});

test('a pane that reads back exited is a death, cursor or no cursor', () => {
  // Measured 2026-08-22 against a real closed REMOTE pane: `terminal read`
  // answered ok:true with `status: "exited"` and `latestCursor: "0"`. The cursor
  // on a corpse is a NUMBER, so it reads exactly like a live pane that has not
  // moved — and an absent cursor, which was the first trigger written here,
  // never arrives at all. Orca left that dispatch `dispatched`/`ready` with its
  // pane dead, so nothing but this watcher could say the work had stopped.
  const runner = fakeRunner({ cursors: [0], paneStatus: 'exited', worktrees: ['/tmp/work', ''] });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '600', ORCA_STALL_LIFETIME: '60' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].join(' '), /is GONE without reporting/);
  assert.match(r.log, /GONE alert sent/);
});

test('a REPAIRED held composer is never announced as gone', () => {
  // `repairHeld` in start.mjs arms a watcher on a dispatch that already settled
  // `failed` and will never settle again, so `!settled` stays true for the whole
  // life of the child it repaired. When that child finishes its real work and
  // its pane closes, the death check would fire and say it went "without
  // reporting" — while its peer report, the one channel a revoked capability
  // leaves it, had already arrived. Measured 2026-08-22: `comm-held` was
  // repaired, worked, and reported `finished its work` that way.
  const runner = fakeRunner({
    status: { dispatch: 'failed', worker: 'failed' },
    cursors: [0],
    paneStatus: 'exited',
    worktrees: ['/tmp/work', ''],
  });
  const r = invoke({ runner, recordOptions: { repaired: true }, env: { ORCA_STALL_AFTER: '600', ORCA_STALL_LIFETIME: '8' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0, 'no death claimed over a child that may have reported by peer');
  assert.doesNotMatch(r.log, /GONE alert/);
});

test('a marker written AFTER this watcher armed is still read, and still spares the child', () => {
  // The marker normally arrives LATE. `repairHeld` arms this watcher while the
  // composer is still held, the operator runs `ax worker repair` minutes later,
  // and `claimPid` refuses that second watcher as a double — so the only
  // watcher alive is the one armed BEFORE the marker existed. Read once at
  // startup, the marker was therefore observed by nobody, and the repaired
  // child's ordinary pane close was reported as a death. Measured on
  // 55-turn-analyzer-r2, 56-scores-r2 and 71-rls-refute (2026-08-25): 49 s,
  // 88 s and 88 s between the arming and the marker.
  const base = fakeRunner({
    status: { dispatch: 'failed', worker: 'failed' },
    cursors: [0],
    paneStatus: 'exited',
    worktrees: ['/tmp/work', ''],
  });
  let record = '';
  const runner = args => {
    // Written during the dispatch-state probe: after the loop began, and before
    // the death check of that same tick evaluates the marker.
    if (args[0] === 'orchestration' && args[1] === 'worker-show' && record !== '') {
      const rec = JSON.parse(readFileSync(record, 'utf8'));
      if (rec.heldRepairAt === undefined) {
        writeFileSync(record, JSON.stringify({ ...rec, heldRepairAt: '2026-08-25T03:16:53.081Z' }));
      }
    }
    return base(args);
  };
  runner.calls = base.calls;
  const r = invoke({
    runner,
    before: ({ path }) => {
      record = path;
    },
    env: { ORCA_STALL_AFTER: '600', ORCA_STALL_LIFETIME: '8' },
  });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0, 'the repair recorded mid-watch is what spares this child');
  assert.doesNotMatch(r.log, /GONE alert/);
});

test('an ORDINARY failure whose pane is gone is still announced as a death', () => {
  // The scope the exclusion above must NOT swallow. Orca files every failure
  // under `failed`, so keying the exclusion on that word would silence exactly
  // the case worth reporting: a dispatch that failed, whose pane then died, and
  // whose Run was told nothing about either event. No repair marker, so this one
  // is still a death.
  const runner = fakeRunner({
    status: { dispatch: 'failed', worker: 'failed' },
    cursors: [0],
    paneStatus: 'exited',
    worktrees: ['/tmp/work', ''],
  });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '600', ORCA_STALL_LIFETIME: '8' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].join(' '), /is GONE without reporting/);
});

test('card watch is off for a same-host dispatch, whose peer report already reaches home', () => {
  // The card is the CROSS-HOST fallback: `brief.mjs` tells a remote child its
  // board is the only thing that reaches home, and `alertCard` says "Remote
  // worker" outright. A same-host child has lineage, so its own peer report
  // arrives — measured 2026-08-22 on the repaired `comm-held3`: one trivial task
  // produced its peer report AND two card wakes, the second calling a child on
  // this machine remote. Three messages for one task, two of them the watcher
  // narrating what the child had already said.
  const runner = fakeRunner({
    cursors: [1, 2, 3, 4, 5],
    cards: ['in-progress\tstarted', 'in-review\tDECISION: answer me'],
  });
  const r = invoke({ runner, recordOptions: { on: '' }, env: { ORCA_STALL_AFTER: '99', ORCA_STALL_LIFETIME: '4' } });
  assert.equal(r.code, 0);
  assert.equal(sends(r.calls).length, 0, 'no card wake for a child that can speak for itself');
  assert.equal(r.calls.some(args => `${args[0]} ${args[1]}` === 'worktree ps'), false, 'the local board is never read');
  assert.match(r.log, /card watch: off for a same-host dispatch/);
});

// THE DELIVERY FORM, not the fact of a message. Every test above proves that an
// alert was SENT; none of them proves it lands on a session that has ended its
// turn.
//
// Measured 2026-09-02 (#109), and that measurement is what decides the type
// below: the watcher inherits the environment of the pane that DISPATCHED, and a
// top-level orchestrator's pane holds no Dispatch by construction — so
// `escalation`, a coordinator mutation whose sender must hold an active one, was
// refused `sender_not_assignee` every time, and the wake arrived as the
// REJECTION's `status` carrying the original body under
// `_orcaLifecycleRejection`. An envelope whose only delivery path is its own
// rejection is not a delivery form.
//
// `status` is the accepted envelope, and the ruling that makes it sufficient is
// this repository's own peer-messaging rule: an orchestrator dispatched through
// ax is an ax session, whose receiver owns the single consuming loop on its Run
// and injects every directed message as a wake — `omp/peer/receive.ts`, pinned
// for these two subjects by `omp/peer/receive.test.ts`. Orca's documented
// `check --wait --types worker_done,escalation,question` loop is never that
// session's, so the type filter that argued for `escalation` never governed this
// channel. The subject prefixes are the readable half of the contract and are
// unchanged: `stall-watch:` and `card:` are the strings that receiver test names.
const typeOf = args => args[args.indexOf('--type') + 1];

test('every alert is issued in the WAKE delivery form, with its words unchanged', () => {
  const silence = sends(
    invoke({
      runner: fakeRunner({ cursors: [7, 7, 7, 7] }),
      env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' },
    }).calls,
  );
  assert.equal(silence.length, 1);
  assert.equal(typeOf(silence[0]), 'status');
  assert.match(silence[0][silence[0].indexOf('--subject') + 1], /has gone silent/);

  const gone = sends(
    invoke({
      runner: fakeRunner({ cursors: [null], worktrees: [''] }),
      recordOptions: { on: '' },
      env: { ORCA_STALL_AFTER: '30', ORCA_STALL_LIFETIME: '60' },
    }).calls,
  );
  assert.equal(gone.length, 1);
  assert.equal(typeOf(gone[0]), 'status');
  assert.match(gone[0][gone[0].indexOf('--subject') + 1], /is GONE without reporting/);

  // The card is the one channel that crosses hosts, and `progressOnly` already
  // decides which cards "must wake the Run" — a DECISION that arrives as
  // read-when-you-look mail waits exactly as long as no alert at all.
  const card = sends(
    invoke({
      runner: fakeRunner({
        cursors: [1, 2, 3, 4, 5],
        cards: ['in-progress\t1/4 · Work · task', 'in-review\t1/4 · DECISION: portails'],
      }),
      env: { ORCA_STALL_LIFETIME: '3' },
    }).calls,
  );
  assert.equal(card.length, 1);
  assert.equal(typeOf(card[0]), 'status');
  assert.match(card[0][card[0].indexOf('--subject') + 1], /published a checkpoint/);
});

test('a wake that fails to deliver changes nothing but the log', () => {
  // ADR 0025 fail-open: the watcher mutates nothing and its verdict is not the
  // notification's. The retry must not quietly downgrade to the non-waking form
  // either — a second attempt that informs instead of waking is the same silence.
  const runner = fakeRunner({ cursors: [7, 7, 7, 7, 7], sendFails: 1 });
  const r = invoke({ runner, env: { ORCA_STALL_AFTER: '2', ORCA_STALL_LIFETIME: '20' } });
  assert.equal(r.code, 0);
  const sent = sends(r.calls);
  assert.equal(sent.length, 2);
  for (const attempt of sent) assert.equal(typeOf(attempt), 'status');
  assert.match(r.log, /stall alert failed; will retry next tick/);
  assert.match(r.log, /ALERT sent to run:run_test123; exiting/);
});
