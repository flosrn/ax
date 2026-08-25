// `ax worker ls` — the F-048 counter-measure, proven on the incident's own
// proposition (F-027): a child whose PANE is alive must be counted and named
// even when Orca's `worker-list` accounting has no entry for it, because that is
// exactly what a `--inject` repair produces. Real records on a real store
// (claimRecord/initRecord/phaseBegin/phaseEnd — no mocked filesystem: the store
// is where the defects live), injected runner, fully offline.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ls } from '../src/worker/ls.mjs';
import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';

const store = () => mkdtempSync(join(tmpdir(), 'ax-worker-ls-'));

/** A record written exactly the way a dispatch writes one: write-ahead, then the receipt. */
function writeRecord(dir, request, phases) {
  const { path } = claimRecord(dir, request);
  initRecord(path, { request, orca: 'orca' });
  for (const phase of phases) {
    phaseBegin(path, { name: phase.name, identity: `id-${phase.name}`, argv: ['orca', 'orchestration', phase.name, '--json'] });
    if ('receipt' in phase) phaseEnd(path, 'last', { exit: phase.exit ?? 0, receiptText: JSON.stringify(phase.receipt) });
  }
  return path;
}

/** The measured `worker-start` receipt shape, agent pane included (2026-08-22). */
const started = ({ taskId = 'task_aaa', dispatchId = 'ctx_aaa', handle, action = 'created' }) => ({
  ok: true,
  result: {
    runId: 'run_1',
    taskId,
    dispatchId,
    state: 'ready',
    stage: 'input_accepted',
    effects: [
      { kind: 'worktree', action: 'reused', id: 'wt::/x' },
      { kind: 'terminal', role: 'setup', action: 'created', id: 'term_setup_ignored' },
      { kind: 'terminal', role: 'agent', action, id: handle, surface: 'visible' },
      { kind: 'dispatch_input', role: 'agent', id: handle, state: 'accepted' },
    ],
    residualResources: [],
    mutation: { requestId: 'r', replayed: false },
  },
});

/** The measured `task-create` receipt: `{task, mutation}`, and no state at all (2026-08-22). */
const taskCreated = (taskId = 'task_aaa') => ({ ok: true, result: { task: { id: taskId }, mutation: { requestId: 'r', replayed: false } } });

/**
 * An Orca answering the three reads this verb joins. `terminalFail` and
 * `workerFail` are the two very different unreadabilities: one is the witness,
 * the other is only the suspect.
 */
function fakeRunner({ terminals = [], omittedHostIds = [], workers = [], ready = true, terminalFail = false, workerFail = false } = {}) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'status') {
      return ready
        ? { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: true } } } }
        : { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: false } } } };
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      return terminalFail
        ? { status: 1, stdout: '', stderr: 'runtime_unavailable', receipt: { unparseable: 'runtime_unavailable', error: 'x' } }
        : {
            status: 0,
            stdout: '',
            stderr: '',
            receipt: { ok: true, result: { terminals, hostScope: { hostIds: ['local'], omittedHostIds }, totalCount: terminals.length } },
          };
    }
    if (args[0] === 'orchestration' && args[1] === 'worker-list') {
      return workerFail
        ? { status: 1, stdout: '', stderr: 'boom', receipt: { unparseable: 'boom', error: 'x' } }
        : { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { workers } } };
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  run.calls = calls;
  return run;
}

const pane = (handle, orphaned = false) => ({ handle, orphaned, worktreePath: '/x', title: 'agent' });

/** Run the verb and keep every line it printed. */
function capture(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  let code;
  try {
    code = fn();
  } finally {
    process.stdout.write = original;
  }
  const out = chunks.join('');
  return { code, out, lineWith: needle => out.split('\n').find(line => line.includes(needle)) ?? '' };
}

test('F-048: a live pane with no worker-list entry is counted, flagged, and given its release', () => {
  const dir = store();
  writeRecord(dir, 'gap-353-u3', [
    { name: 'task-create', receipt: taskCreated('task_live') },
    // The failed worker-start that `--inject` later repaired: the repair opened
    // a Dispatch on a pane and touched no worker accounting at all.
    { name: 'worker-start', exit: 1, receipt: { ok: false, error: { code: 'agent_readiness', message: 'timeout' } } },
    { name: 'worker-start-inject', receipt: started({ taskId: 'task_live', dispatchId: 'ctx_live', handle: 'term_live', action: 'reused_agent_terminal' }) },
  ]);

  const run = fakeRunner({
    terminals: [pane('term_live')],
    // Orca's accounting knows another dispatch entirely — the injected one is
    // simply not in it. This is the zero the cap counter used to believe.
    workers: [{ dispatchId: 'ctx_other', taskId: 'task_other', agentTerminalHandle: 'term_other', workerState: 'succeeded', terminalState: 'released' }],
  });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0, 'the list was rendered');

  const line = lineWith('gap-353-u3');
  assert.match(line, /pane VIVANT/, 'the pane is the truth');
  assert.match(line, /worker-list ABSENT/, 'and Orca does not know it');
  assert.match(line, /task_live/, 'the id comes from the same receipt as the pane');
  assert.match(line, /^ {2}✗ /, 'a disagreement is a failure line, never a note');
  assert.match(out, /worker-release --dispatch ctx_live/, 'the repair is named by the dispatch that owns that pane');
  assert.match(out, /1 live pane\(s\) — this is the cap count/, 'the count comes from panes, never from worker-list');
});

test('F-048, second shape: a live pane whose worker-list terminal is `retained` is the same drift', () => {
  const dir = store();
  writeRecord(dir, 'ws-1874', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_ret', handle: 'term_ret' }) }]);
  const run = fakeRunner({
    terminals: [pane('term_ret')],
    workers: [{ dispatchId: 'ctx_ret', taskId: 'task_aaa', agentTerminalHandle: 'term_ret', workerState: 'unsupervised', terminalState: 'retained' }],
  });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(lineWith('ws-1874'), /pane VIVANT · worker-list unsupervised\/retained/);
  assert.match(lineWith('ws-1874'), /^ {2}✗ /, 'alive + retained is a child hidden from the release sweep');
  assert.match(out, /worker-release --dispatch ctx_ret/);
});

test('a stranded receipt never supersedes the ready dispatch it followed (record.mjs `usable`)', () => {
  const dir = store();
  // Exit 0, ok:true, and `state` anything but ready: a partial mutation is
  // STRANDED however cleanly the process ended, so the ready dispatch before it
  // is still the one that owns the pane and the ids.
  writeRecord(dir, 'stranded-1', [
    { name: 'worker-start', receipt: started({ taskId: 'task_ready', dispatchId: 'ctx_ready', handle: 'term_ready' }) },
    { name: 'worker-show', receipt: { ok: true, result: { taskId: 'task_late', dispatchId: 'ctx_late', state: 'settling', stage: 'agent_readiness', effects: [] } } },
  ]);
  const run = fakeRunner({
    terminals: [pane('term_ready')],
    workers: [{ dispatchId: 'ctx_ready', taskId: 'task_ready', agentTerminalHandle: 'term_ready', workerState: 'running', terminalState: 'active' }],
  });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(lineWith('stranded-1'), /task_ready .*pane VIVANT · worker-list running\/active/);
  assert.doesNotMatch(out, /task_late|ctx_late/, 'a stranded receipt contributes no id to the line');
  assert.match(out, /1 live pane\(s\)/);
});

test('a live terminal left by an unsettled worker-start is shown and inspected, never counted, never released', () => {
  const dir = store();
  // Measured on ws-1874, 2026-08-22: worker-start timed out at agent_readiness
  // having already recorded a reused agent terminal. The effect is not proof
  // that the dispatch/handle association took — but the terminal is alive.
  writeRecord(dir, 'leak-1', [
    { name: 'task-create', receipt: taskCreated('task_leak') },
    {
      name: 'worker-start',
      exit: 1,
      receipt: { ok: true, result: { taskId: 'task_leak', dispatchId: 'ctx_leak', state: 'failed', stage: 'agent_readiness', lastError: 'timeout', effects: [{ kind: 'terminal', role: 'agent', action: 'reused_agent_terminal', id: 'term_leak' }] } },
    },
  ]);
  const run = fakeRunner({ terminals: [pane('term_leak')], workers: [] });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  const line = lineWith('leak-1');
  assert.match(line, /pane INCONNU/, 'an effect on an incomplete worker-start establishes nothing');
  assert.match(line, /term_leak, ALIVE right now/, 'and it is not hidden either (F-028)');
  assert.match(line, /^ {2}✗ /);
  assert.match(out, /worker-show --dispatch ctx_leak/, 'inspect, never release on an unproven association');
  assert.doesNotMatch(out, /worker-release/);
  assert.match(out, /0 live pane\(s\)/, 'unproven is never counted as capacity in use either');
});

test('an unsettled pane that is GONE is still named, with the two routes that do not need it', () => {
  const dir = store();
  // The 2026-08-25 shape: `worker-start` settled `failed` at `dispatch_input`
  // (Orca's 5 s readiness window against a cold session), the pane it recorded
  // has since closed, and this verb printed `pane INCONNU · worker-list ABSENT ·
  // no usable receipt yet` — naming neither the handle that is in the receipt
  // nor anything an operator could type. The child's own session had the work in
  // it the whole time.
  writeRecord(dir, '55-work', [
    { name: 'task-create', receipt: taskCreated('task_55') },
    {
      name: 'worker-start',
      receipt: { ok: true, result: { taskId: 'task_55', dispatchId: 'ctx_047889f5daa4', state: 'failed', stage: 'dispatch_input', lastError: 'agent_prompt_stalled', effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_8c22e160' }] } },
    },
  ]);
  const run = fakeRunner({ terminals: [], workers: [] });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  const line = lineWith('55-work');
  assert.match(line, /pane INCONNU .*no usable receipt yet/, 'nothing is established, and that is still the verdict');
  assert.match(line, /term_8c22e160, MORT/, 'the recorded handle is named whatever became of it');
  assert.match(out, /ax worker tail 55-work/);
  assert.match(out, /ax worker transcript 55-work/, 'a session outlives its pane, and one verb reads it');
  assert.match(out, /0 live pane\(s\)/, 'naming a dead pane is not counting it');
});

test('a truncated terminal list is cannot-establish: a partial list cannot prove a pane is dead', () => {
  const dir = store();
  writeRecord(dir, 'req-1', [{ name: 'worker-start', receipt: started({ handle: 'term_x' }) }]);
  const run = args => {
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: true } } } };
    return { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { terminals: [], totalCount: 400, truncated: true } } };
  };

  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 3);
  assert.match(out, /TRUNCATED/);
});

test('a live pane that worker-list calls active agrees — no failure line, still counted', () => {
  const dir = store();
  writeRecord(dir, 'agree-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_ok', handle: 'term_ok' }) }]);
  const run = fakeRunner({
    terminals: [pane('term_ok')],
    workers: [{ dispatchId: 'ctx_ok', taskId: 'task_aaa', agentTerminalHandle: 'term_ok', workerState: 'running', terminalState: 'active' }],
  });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(lineWith('agree-1'), /^ {2}✓ .*pane VIVANT · worker-list running\/active/);
  assert.match(out, /1 live pane\(s\)/);
});

test('a dead pane is MORT — orphaned, or a handle the runtime no longer knows — and never counted', () => {
  const dir = store();
  writeRecord(dir, 'orphan-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_o', handle: 'term_orphan' }) }]);
  writeRecord(dir, 'gone-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_g', handle: 'term_gone' }) }]);

  const run = fakeRunner({
    terminals: [pane('term_orphan', true)],
    workers: [{ dispatchId: 'ctx_o', taskId: 't', agentTerminalHandle: 'term_orphan', workerState: 'unsupervised', terminalState: 'retained' }],
  });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(lineWith('orphan-1'), /pane MORT/);
  assert.match(lineWith('gone-1'), /pane MORT/);
  assert.match(out, /0 live pane\(s\)/, 'a retained worker on an orphaned pane is not a working child');
  assert.doesNotMatch(out, /worker-release/, 'a dead pane is not the F-048 drift, and must not be reported as one');
});

test('a handle absent while hosts are omitted is INCONNU, never MORT (measured hostScope, 2026-08-22)', () => {
  const dir = store();
  writeRecord(dir, 'remote-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_r', handle: 'term_elsewhere' }) }]);
  const run = fakeRunner({ terminals: [], omittedHostIds: ['runtime:7930a317'] });

  const { lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.match(lineWith('remote-1'), /pane INCONNU/);
  assert.match(lineWith('remote-1'), /hosts are omitted/, 'not reading a host is not seeing its pane dead');
});

test('a record with no usable receipt is rendered INCONNU, never skipped (F-028)', () => {
  const dir = store();
  // Write-ahead only: the mutation was issued and never came back.
  writeRecord(dir, 'inflight-1', [{ name: 'worker-start' }]);
  // A task-create and nothing else: it labels the task, and establishes no
  // dispatch — `{task, mutation}` is not a usable receipt.
  writeRecord(dir, 'nopane-1', [{ name: 'task-create', receipt: taskCreated('task_np') }]);
  // A usable, ready receipt that simply opened no agent pane.
  writeRecord(dir, 'noeffect-1', [
    { name: 'worker-start', receipt: { ok: true, result: { taskId: 'task_ne', dispatchId: 'ctx_ne', state: 'ready', effects: [{ kind: 'worktree', action: 'reused', id: 'wt::/x' }] } } },
  ]);
  // Corrupt JSON: the least readable record, and the most suspicious.
  writeFileSync(join(dir, 'corrupt-1.json'), '{ not json');

  const run = fakeRunner({ terminals: [], workers: [] });
  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(out, /4 record\(s\)/, 'every record gets a line');

  assert.match(lineWith('inflight-1'), /pane INCONNU .*no usable receipt yet/);
  assert.match(lineWith('nopane-1'), /task_np .*pane INCONNU .*no usable receipt yet/);
  assert.match(lineWith('noeffect-1'), /pane INCONNU .*no agent pane in the last usable receipt/);
  assert.match(lineWith('corrupt-1'), /pane INCONNU/);
  assert.match(lineWith('corrupt-1'), /record unreadable/, 'an unreadable record is named, not silently dropped');
  assert.match(out, /0 live pane\(s\)/, 'unknown is never counted as free capacity either way');
});

test('an empty store answers "0 record" and exit 0 — without pretending to have read panes', () => {
  const run = fakeRunner();
  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: store() } }));
  assert.equal(code, 0);
  assert.match(out, /^0 record\n/);
  assert.deepEqual(run.calls, [['status', '--json']], 'nothing to join, nothing read');
});

test('a store directory that does not exist is 0 record, said as such', () => {
  const { code, out } = capture(() => ls([], { runner: fakeRunner(), env: { ORCA_DISPATCH_STORE: join(store(), 'never-created') } }));
  assert.equal(code, 0);
  assert.match(out, /nothing was ever claimed on this host/);
});

test('an unreadable terminal list is cannot-establish, named, exit 3 — this verb never guesses a count', () => {
  const dir = store();
  writeRecord(dir, 'req-1', [{ name: 'worker-start', receipt: started({ handle: 'term_x' }) }]);
  const run = fakeRunner({ terminalFail: true });

  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 3);
  assert.match(out, /orca terminal list did not answer/);
  assert.match(out, /runtime_unavailable/, 'the raw diagnostic survives (F-004)');
  assert.match(out, /→ orca terminal list --json/);
  assert.doesNotMatch(out, /pane /, 'no line is rendered from a liveness source that refused');
});

test('a terminal list without a "terminals" container is a refusal, not an empty machine (F-028)', () => {
  const dir = store();
  writeRecord(dir, 'req-1', [{ name: 'worker-start', receipt: started({ handle: 'term_x' }) }]);
  const run = args => {
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: true } } } };
    return { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { hostScope: { hostIds: ['local'] } } } };
  };

  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 3);
  assert.match(out, /an absent container is not an empty one/);
});

test('an unreadable worker-list costs the comparison column, not the count', () => {
  const dir = store();
  writeRecord(dir, 'req-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_w', handle: 'term_live' }) }]);
  const run = fakeRunner({ terminals: [pane('term_live')], workerFail: true });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0, 'the pane truth was established; only the suspect is missing');
  assert.match(lineWith('req-1'), /pane VIVANT · worker-list ILLISIBLE/);
  assert.match(out, /worker-list unreadable/);
  assert.match(out, /1 live pane\(s\)/);
});

test('fail-closed, unlike ax board: no orca and a silent runtime both refuse with `orca open`', () => {
  const noOrca = capture(() => ls([], { resolve: () => null, env: { ORCA_DISPATCH_STORE: store() } }));
  assert.equal(noOrca.code, 3);
  assert.match(noOrca.out, /→ orca open/);

  const run = fakeRunner({ ready: false });
  const silent = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: store() } }));
  assert.equal(silent.code, 3);
  assert.match(silent.out, /runtime not reachable/);
  assert.deepEqual(run.calls, [['status', '--json']], 'probed before any read');
});

test('usage errors exit 2 without touching orca', () => {
  const run = fakeRunner();
  assert.equal(ls(['--bogus'], { runner: run }), 2);
  assert.equal(ls(['--store'], { runner: run }), 2, 'a flag without a value is a usage error');
  assert.equal(run.calls.length, 0);
});

test('--store reads the named store, and worker-list entries with no record are counted for comparison', () => {
  const dir = store();
  writeRecord(dir, 'only-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_1', handle: 'term_1' }) }]);
  const run = fakeRunner({
    terminals: [pane('term_1')],
    workers: [
      { dispatchId: 'ctx_1', taskId: 't', agentTerminalHandle: 'term_1', workerState: 'running', terminalState: 'active' },
      { dispatchId: 'ctx_2', taskId: 't2', agentTerminalHandle: 'term_2', workerState: 'succeeded', terminalState: 'retained' },
    ],
  });

  const { code, out } = capture(() => ls(['--store', dir], { runner: run, env: {} }));
  assert.equal(code, 0);
  assert.match(out, /worker-list reports 2 entry\(ies\), 1 of them with no local record/);
});
