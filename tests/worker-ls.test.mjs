// `ax worker ls` — the F-048 counter-measure, proven on the incident's own
// proposition (F-027): a child whose PANE is alive must be counted and named
// even when Orca's `worker-list` accounting has no entry for it, because that is
// exactly what a `--inject` repair produces. Real records on a real store
// (claimRecord/initRecord/phaseBegin/phaseEnd — no mocked filesystem: the store
// is where the defects live), injected runner, fully offline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ls as lsVerb } from '../src/worker/ls.mjs';
import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';

const store = () => mkdtempSync(join(tmpdir(), 'ax-worker-ls-'));

/** A `gh` that names this checkout — the read that scopes the per-repository count. */
const ghSlug = (slug = 'acme/widgets') => (bin, args) =>
  bin === 'gh' && args[0] === 'repo' ? { status: 0, stdout: `${slug}\n`, stderr: '' } : { status: 0, stdout: '', stderr: '' };

/**
 * The verb, with the machine's two answers injected: `gh` (which repository is
 * this checkout) and the checkout whose `ax.config.json` declares the caps. A
 * suite reaching a real `gh` would be neither offline nor deterministic, and a
 * suite reading THIS repository's own config would grade itself.
 */
const ls = (argv, options = {}) => lsVerb(argv, { exec: ghSlug(), cwd: repo(), ...options });

/**
 * A real checkout whose `ax.config.json` declares the hosts passed here — the
 * only thing that tells this verb how to reach a host, and therefore whether a
 * remote pane can be asked about at all. `repo()` with nothing declared is the
 * machine every pre-#76 test ran on.
 */
function repo(hosts = {}, caps = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-worker-ls-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const declaredHosts = Object.keys(hosts).length === 0 ? {} : { entry: '/entry', hosts };
  const block = { ...declaredHosts, ...caps };
  const dispatch = Object.keys(block).length === 0 ? {} : { dispatch: block };
  writeFileSync(join(dir, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, ...dispatch }));
  return dir;
}

/**
 * A record written exactly the way a dispatch writes one: write-ahead, then the
 * receipt. `on` is the placement the phase recorded — `''` is a local dispatch,
 * which is what decides whether an omitted REMOTE host can explain its pane's
 * absence.
 *
 * `worktree` is the rest of that placement, recorded the way `ax worker
 * dispatch` composes it (`--worktree path:<abs> --agent <name>`): the only
 * thing that lets a reader name the branch a dead row's continuation is asked
 * about (#165). A record without it names no placement at all, which is the
 * shape every test written before #165 uses.
 */
function writeRecord(dir, request, phases, { on = '', repo: named = 'acme/widgets', worktree = '' } = {}) {
  const { path } = claimRecord(dir, request);
  initRecord(path, { request, orca: 'orca', repo: named });
  for (const phase of phases) {
    phaseBegin(path, {
      name: phase.name,
      identity: `id-${phase.name}`,
      argv: [
        'orca',
        'orchestration',
        phase.name,
        ...(on === '' ? [] : ['--on', on]),
        ...(worktree === '' ? [] : ['--worktree', `path:${worktree}`, '--agent', 'omp']),
        '--json',
      ],
    });
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
 *
 * `hosts` is the fourth read (#76): the inventory a DECLARED host gives of
 * itself, keyed by the environment name a record dispatched with. Its shape is
 * the MEASURED one — `terminal list --environment gapicore --json` is served by
 * that environment's own runtime (`_meta.runtimeId` 1468aeea-…, gapicore's, next
 * to 682e09fd-… for the unscoped call on this Mac, 2026-09-02) and answers
 * `hostScope {"hostIds":["local"],"omittedHostIds":[]}`: `local` there is the
 * REMOTE's local. `hostIds` is overridable so the conservative direction — a
 * reply that never claims to have read its own scope — can be pinned too. An
 * environment absent from `hosts`, or one carrying `fail`, could not answer.
 */
function fakeRunner({ terminals = [], omittedHostIds = [], hostIds = ['local'], workers = [], ready = true, terminalFail = false, workerFail = false, hosts = {} } = {}) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'status') {
      return ready
        ? { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: true } } } }
        : { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: false } } } };
    }
    if (args[0] === 'terminal' && args[1] === 'list') {
      const at = args.indexOf('--environment');
      if (at !== -1) {
        const name = args[at + 1];
        const host = hosts[name];
        if (host === undefined || host.fail !== undefined) {
          const detail = host?.fail ?? 'unknown_environment';
          return { status: 1, stdout: '', stderr: detail, receipt: { unparseable: detail, error: 'x' } };
        }
        return {
          status: 0,
          stdout: '',
          stderr: '',
          receipt: {
            ok: true,
            result: {
              terminals: host.terminals ?? [],
              hostScope: { hostIds: host.hostIds ?? ['local'], omittedHostIds: host.omittedHostIds ?? [] },
              totalCount: (host.terminals ?? []).length,
            },
          },
        };
      }
      return terminalFail
        ? { status: 1, stdout: '', stderr: 'runtime_unavailable', receipt: { unparseable: 'runtime_unavailable', error: 'x' } }
        : {
            status: 0,
            stdout: '',
            stderr: '',
            receipt: {
              ok: true,
              result: {
                terminals,
                // `hostIds: null` is the MEASURED absent container: a list that
                // never says which hosts it read, so it covers no pane's absence
                // (F-028). It is what leaves a record with no placement UNKNOWN.
                hostScope: hostIds === null ? { omittedHostIds } : { hostIds, omittedHostIds },
                totalCount: terminals.length,
              },
            },
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
  assert.match(out, /1 live pane\(s\) in acme\/widgets/, 'the count comes from panes, never from worker-list');
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

test('a live terminal left by an unsettled worker-start is capacity, still inspected, still never released', () => {
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
  // #152, measured 2026-09-04: an unproven ASSOCIATION is still no release, but
  // a terminal the runtime reports as up is a slot in use whatever proved it.
  assert.match(out, /1 live pane\(s\) in acme\/widgets/, 'the terminal is up, so the slot is taken');
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

  // This is a DEAD ATTEMPT (#70, ruled 2026-09-02): unsettled, and the pane it
  // recorded is a corpse on the local runtime this list read. It answers
  // neither capacity nor overlap, so it leaves the default listing for a
  // disclosed count — and everything it has ever named, verdict and both
  // routes, is one flag away and unchanged.
  const { code, out, lineWith } = capture(() => ls(['--all'], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  const line = lineWith('55-work');
  assert.match(line, /pane INCONNU .*no usable receipt yet/, 'nothing is established, and that is still the verdict');
  assert.match(line, /term_8c22e160, MORT/, 'the recorded handle is named whatever became of it');
  assert.match(out, /ax worker tail 55-work/);
  assert.match(out, /ax worker transcript 55-work/, 'a session outlives its pane, and one verb reads it');
  assert.match(out, /ax worker settle 55-work/, 'and the settlement debt names the verb that writes it (#102)');
  assert.match(out, /0 live pane\(s\)/, 'naming a dead pane is not counting it');

  const def = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.doesNotMatch(def.out, /55-work/, 'and the default view carries the count instead of the row');
  assert.match(def.out, /1 unsettled record\(s\) whose pane is MORT — ax worker settle <request>/);
  assert.match(def.out, /0 live pane\(s\)/, 'the cap count is the same count in both views');
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

  // Read under `--all`: since #70 the MORT verdict is archaeology, and this is
  // the view that keeps it. The count below is the same in both views.
  const { code, out, lineWith } = capture(() => ls(['--all'], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(lineWith('orphan-1'), /pane MORT/);
  assert.match(lineWith('gone-1'), /pane MORT/);
  assert.match(out, /0 live pane\(s\)/, 'a retained worker on an orphaned pane is not a working child');
  assert.doesNotMatch(out, /worker-release/, 'a dead pane is not the F-048 drift, and must not be reported as one');
});

// ── the default view (#70): the two answers first, the archaeology on demand ──

/** Row lines only: the summary never carries the ` · pane ` column. */
const paneRows = out => out.split('\n').filter(line => line.includes(' · pane '));

test('#70: the default receipt lists the panes that carry a decision, --all keeps every record', () => {
  const dir = store();
  // The measured shape of #70 scaled down: three finished dispatches whose
  // panes the runtime no longer knows, one child still working. A remote host
  // is omitted from the terminal list exactly as it is on this Mac — which is
  // why the three absent LOCAL handles are still MORT (omission is per host).
  writeRecord(dir, 'dead-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_d1', handle: 'term_d1' }) }]);
  writeRecord(dir, 'dead-2', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_d2', handle: 'term_d2' }) }]);
  writeRecord(dir, 'dead-3', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_d3', handle: 'term_d3' }) }]);
  writeRecord(dir, 'live-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_l1', handle: 'term_l1' }) }]);

  const orca = () => fakeRunner({
    terminals: [pane('term_l1')],
    omittedHostIds: ['runtime:7930a317'],
    workers: [{ dispatchId: 'ctx_l1', taskId: 'task_aaa', agentTerminalHandle: 'term_l1', workerState: 'running', terminalState: 'active' }],
  });

  const shown = capture(() => ls([], { runner: orca(), env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(shown.code, 0);
  assert.deepEqual(paneRows(shown.out).length, 1, `one row for the one pane an orchestrator can act on:\n${shown.out}`);
  assert.match(paneRows(shown.out)[0], /live-1 .*pane VIVANT/);
  for (const dead of ['dead-1', 'dead-2', 'dead-3']) {
    assert.doesNotMatch(shown.out, new RegExp(dead), 'a MORT record names no repair, so withholding it withholds nothing');
  }
  assert.match(shown.out, /3 MORT record\(s\)/, 'the omission is disclosed, never silent (F-028)');
  assert.match(shown.out, /ax worker ls --all/, 'and it names the view that has them');

  // The three lines the orchestrator reads before every dispatch.
  assert.match(shown.out, /1 live pane\(s\) in acme\/widgets/);
  // NOT the blanket omission line: every record here is local, this list read
  // `local`, so the omitted remote runtime explains no row on this machine
  // (#76 — the line is now per host, and only for a host that bears on a pane).
  assert.doesNotMatch(shown.out, /omitted from the terminal-list scope/);
  assert.match(shown.out, /worker-list reports 1 entry\(ies\), 0 of them with no local record/, 'the join covers every record, shown or not');

  const all = capture(() => ls(['--all'], { runner: orca(), env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(all.code, 0);
  assert.equal(paneRows(all.out).length, 4, 'the archaeology stays reachable, unchanged');
  for (const dead of ['dead-1', 'dead-2', 'dead-3']) assert.match(all.out, new RegExp(`${dead}.*pane MORT`));
  assert.match(all.out, /1 live pane\(s\) in acme\/widgets/, 'the capacity line is the same line in both views');
  assert.doesNotMatch(all.out, /omitted from the terminal-list scope/, 'and it stays absent in both views');
  assert.doesNotMatch(all.out, /MORT record\(s\) not shown/, 'nothing is hidden under --all, so nothing is disclosed');
});

test('#70: a dead attempt leaves the default as a count; an unasked host keeps its row', () => {
  const dir = store();
  // The RULING of 2026-09-02, round 1 on this PR. The two answers this verb
  // owes are capacity and overlap, and the two INCONNU shapes differ on both:
  //
  //  - `unasked-1` dispatched onto a host this terminal list never read, so its
  //    pane may be alive and working. It carries overlap. It stays.
  //  - `dead-attempt-1` is a worker-start that never settled, and the pane it
  //    did record is MORT on the LOCAL runtime this list DID read. It is a dead
  //    attempt with a settlement debt (#78) — no capacity, no overlap — so it
  //    leaves the default as one disclosed line, hints and all.
  //
  // Its DISPOSITION is untouched: still INCONNU, because nothing about that
  // record was ever established. Only the listing changes.
  //
  // `unasked-1`'s host is a host THIS PROJECT DOES NOT DECLARE (#76), which is
  // the only remaining way a host cannot be asked: nothing in the config says
  // how to reach it, so its panes stay unknowable.
  writeRecord(dir, 'unasked-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_u1', handle: 'term_elsewhere' }) }], { on: 'gapicore' });
  writeRecord(dir, 'dead-attempt-1', [
    { name: 'task-create', receipt: taskCreated('task_55') },
    {
      name: 'worker-start',
      receipt: { ok: true, result: { taskId: 'task_55', dispatchId: 'ctx_55', state: 'failed', stage: 'dispatch_input', effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_gone' }] } },
    },
  ]);
  writeRecord(dir, 'live-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_l1', handle: 'term_l1' }) }]);

  const orca = () => fakeRunner({ terminals: [pane('term_l1')], omittedHostIds: ['runtime:7930a317'], workers: [] });
  const undeclared = repo();

  const shown = capture(() => ls([], { runner: orca(), env: { ORCA_DISPATCH_STORE: dir }, cwd: undeclared }));
  assert.equal(shown.code, 0);
  assert.equal(paneRows(shown.out).length, 2, `the live pane and the unasked host, nothing else:\n${shown.out}`);
  assert.match(shown.out, /live-1 .*pane VIVANT/);
  assert.match(shown.out, /unasked-1 .*pane INCONNU/, 'a host this call could not ask cannot answer for its panes');
  assert.match(shown.out, /host 'gapicore' could not be asked.*not a host this project declared/, 'and the omission names that host, with what it answered');
  assert.doesNotMatch(shown.out, /dead-attempt-1/, 'a dead attempt carries neither answer');
  assert.doesNotMatch(shown.out, /ax worker (?:tail|transcript|settle) dead-attempt-1/, 'and its repairs go with it');
  // #102: the count that discloses the debt names the verb that pays it. A
  // count with no repair is the finding src/log.mjs exists to forbid, and until
  // `ax worker settle` existed this line was exactly that — it offered the flag
  // that lengthens the list and no gesture that settles anything.
  assert.match(shown.out, /1 unsettled record\(s\) whose pane is MORT — ax worker settle <request>/, 'the count names the verb that owns the answer');
  assert.match(shown.out, /ax worker ls --all/, 'and still names the view that lists them');
  assert.match(shown.out, /1 live pane\(s\) in acme\/widgets/);

  const all = capture(() => ls(['--all'], { runner: orca(), env: { ORCA_DISPATCH_STORE: dir }, cwd: undeclared }));
  assert.equal(paneRows(all.out).length, 3, 'every record is still one row here');
  const line = all.out.split('\n').find(l => l.includes('dead-attempt-1')) ?? '';
  assert.match(line, /pane INCONNU/, 'the disposition is NOT relabelled by the listing');
  assert.match(line, /term_gone, MORT/, 'the recorded pane is named, as it always was');
  assert.match(all.out, /ax worker tail dead-attempt-1/, 'the two routes that need no pane live here now');
  assert.match(all.out, /ax worker transcript dead-attempt-1/);
  // #102 again, per row: the verb is named unconditionally, because `ls`
  // resolves no repository slug and grades no row by settleability — settle's
  // own refusal is the applicable repair for a row that cannot be settled here.
  assert.match(all.out, /ax worker settle dead-attempt-1/, 'the row that carries the debt names the verb that writes it');
  assert.match(all.out, /1 live pane\(s\) in acme\/widgets/, 'the cap count is the same count in both views');
  assert.doesNotMatch(all.out, /unsettled record\(s\) whose pane is MORT — ax/, 'nothing is withheld here, so nothing is disclosed');
});

test('#70: an unsettled record whose pane may still be alive is never collapsed', () => {
  const dir = store();
  // The two unsettled shapes that are NOT a dead attempt, and neither may be
  // reduced to a count: `alive-leak` recorded a pane that is up right now
  // (unproven association, so it is inspected and never released — F-028), and
  // `unasked-leak` recorded one on a host that cannot be asked. Both are
  // possible capacity in use, which is the question the reader came with.
  writeRecord(dir, 'alive-leak', [
    { name: 'worker-start', exit: 1, receipt: { ok: true, result: { taskId: 't1', dispatchId: 'ctx_a', state: 'failed', stage: 'agent_readiness', effects: [{ kind: 'terminal', role: 'agent', action: 'reused_agent_terminal', id: 'term_alive' }] } } },
  ]);
  writeRecord(dir, 'unasked-leak', [
    { name: 'worker-start', exit: 1, receipt: { ok: true, result: { taskId: 't2', dispatchId: 'ctx_b', state: 'failed', stage: 'agent_readiness', effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_remote' }] } } },
  ], { on: 'gapicore' });
  // And the record that names no pane at all: a write-ahead entry whose
  // mutation never came back. Nothing proves it dead, so nothing hides it.
  writeRecord(dir, 'inflight-1', [{ name: 'worker-start' }]);

  const run = fakeRunner({ terminals: [pane('term_alive')], omittedHostIds: ['runtime:7930a317'], workers: [] });
  const { out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));
  assert.equal(paneRows(out).length, 3, `all three are unestablished, and none of them is a corpse:\n${out}`);
  assert.match(out, /term_alive, ALIVE right now/);
  assert.match(out, /worker-show --dispatch ctx_a/, 'the suspect is still routed to an inspection');
  assert.doesNotMatch(out, /unsettled record\(s\) whose pane is MORT/, 'no dead attempt here, so no count line');
  // #152: `alive-leak`'s terminal is up, so it is one slot in use; `unasked-leak`
  // named a host nothing here could ask, so its pane is an INABILITY and never
  // room. Keying that branch on the row's own handle dropped it from both counts
  // — an unaskable pane reading as free capacity is the F-028 shape this line
  // exists to refuse, and `capVerdict` turns the number into a cannot-establish.
  assert.match(out, /1 live pane\(s\) in acme\/widgets/, 'the pane that is UP is the pane that counts');
  assert.match(out, /1 pane\(s\) are on a host that could not be asked/, 'and the pane nobody could ask about is disclosed, never counted as room');
  // The counted one is capacity AND unproven: both halves said in one line.
  assert.match(out, /1 of them were recorded by a worker-start that never settled: counted as capacity/);
  assert.doesNotMatch(out, /never counted/, 'no line may contradict the total printed above it');
});

test('#152: a repaired child behind an unsettled start is capacity, and one terminal counts once', () => {
  const dir = store();
  // MEASURED 2026-09-04 on the spec #145 wave, three times. `worker dispatch`
  // settled `failed` at `dispatch_input` (upstream Orca's paste path, #151),
  // `ax worker repair` pressed the one Enter, and the child WORKED — `ax worker
  // tail` read status=running behind every one of those panes. During the three
  // dispatches the preamble counted 0 -> 1 -> 2, because both dispatch verbs
  // count through `liveCount` over `dispatchIndex`, which carries the pane of
  // ANY worker-start phase. `ax worker ls` answered `0 live pane(s)` on the same
  // store, because it counted by hand from the release-grade handle instead.
  //
  // Two numbers for one question, and this verb's own comment claimed its number
  // came "from the one contract both dispatch verbs refuse with". The direction
  // was decided before, in the module the fence reads (../worker/pane.mjs:
  // "their panes may be alive and consuming capacity, so leaving them out makes
  // the count UNDERSTATED, and a fence built on it can admit a pane past a cap
  // that is already full"). So the reporter follows the fence.
  //
  // What does NOT move: the row's verdict stays INCONNU (the association is
  // unproven), the repair stays an inspection, and no release is ever offered.
  writeRecord(dir, '148-work', [
    { name: 'task-create', receipt: taskCreated('task_63b1ef49a017') },
    {
      name: 'worker-start',
      exit: 1,
      receipt: { ok: true, result: { taskId: 'task_63b1ef49a017', dispatchId: 'ctx_e2b5e37542c2', state: 'failed', stage: 'dispatch_input', lastError: 'agent_prompt_stalled', effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_59a30226' }] } },
    },
  ]);
  const run = fakeRunner({ terminals: [pane('term_59a30226')], workers: [] });

  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.equal(code, 0);
  assert.match(out, /1 live pane\(s\) in acme\/widgets/, 'the terminal is up, so the slot is taken');
  assert.match(out, /1 live pane\(s\) on this machine/);
  const line = lineWith('148-work');
  assert.match(line, /pane INCONNU/, 'counting it capacity is not proving the association');
  assert.match(out, /worker-show --dispatch ctx_e2b5e37542c2/, 'still an inspection, never a release');
  assert.doesNotMatch(out, /worker-release/);

  // ONE TERMINAL, ONE SLOT. A repair reuses the agent terminal, so a second
  // request can name the pane a first one already recorded — and a count keyed
  // by record would report two panes for one and refuse a dispatch the machine
  // had room for. `liveCount` keys its sets by handle; so does this verb.
  writeRecord(dir, '150-work', [
    {
      name: 'worker-start',
      exit: 1,
      receipt: { ok: true, result: { taskId: 'task_a3cf18b61480', dispatchId: 'ctx_425f136b3856', state: 'failed', stage: 'dispatch_input', lastError: 'agent_prompt_stalled', effects: [{ kind: 'terminal', role: 'agent', action: 'reused_agent_terminal', id: 'term_59a30226' }] } },
    },
  ]);
  const shared = capture(() => ls([], { runner: fakeRunner({ terminals: [pane('term_59a30226')], workers: [] }), env: { ORCA_DISPATCH_STORE: dir } }));
  assert.match(shared.out, /1 live pane\(s\) in acme\/widgets/, 'two records naming one live terminal are one slot');
  assert.match(shared.out, /2 of them were recorded by a worker-start that never settled/, 'both suspicions are still disclosed');
});

// ── the declared hosts (#76): a host that can be reached can be asked ────────

/** A host declaration is exactly what says how to reach that host. */
const declared = { gapicore: { ssh: 'orca@vps' } };

test('#76: a declared host answers for its own panes, and they are capacity', () => {
  const dir = store();
  // Two children on one declared host. Before this, both read INCONNU with
  // "hosts were omitted" — the local list cannot see a remote pane, and the
  // enquiry stopped there although the declaration says how to reach it.
  writeRecord(dir, 'far-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f1', handle: 'term_far1' }) }], { on: 'gapicore' });
  writeRecord(dir, 'far-2', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f2', handle: 'term_far2' }) }], { on: 'gapicore' });
  writeRecord(dir, 'local-live', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_l1', handle: 'term_l1' }) }]);

  const run = fakeRunner({
    terminals: [pane('term_l1')],
    omittedHostIds: ['runtime:7930a317'],
    hosts: { gapicore: { terminals: [pane('term_far1'), pane('term_far2')] } },
    workers: [],
  });
  const { code, out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));

  assert.equal(code, 0);
  assert.match(lineWith('far-1'), /pane VIVANT/, 'the host said this pane is up, so it is up');
  assert.match(lineWith('far-2'), /pane VIVANT/);
  assert.match(out, /3 live pane\(s\) in acme\/widgets/, 'a live pane on an asked host is capacity in use');
  assert.doesNotMatch(out, /could not be asked/, 'a host that answered is no omission at all');
  assert.doesNotMatch(out, /omitted from the terminal-list scope/, 'and no row is left leaning on the local list’s omission');

  const scoped = run.calls.filter(args => args.includes('--environment'));
  assert.deepEqual(scoped, [['terminal', 'list', '--environment', 'gapicore', '--json']], 'asked once, by the name the record dispatched with');
});

test('#76: a pane the declared host does not know is a corpse on that host', () => {
  const dir = store();
  // The host itself answered, about its OWN scope: `terminal list --environment
  // gapicore` is served by gapicore's runtime, which reported `hostIds:
  // ["local"]` — its local — and omitted nothing (measured 2026-09-02, see
  // fakeRunner). A handle that runtime does not carry is a corpse THERE.
  writeRecord(dir, 'far-gone', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_fg', handle: 'term_far_gone' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], omittedHostIds: ['runtime:7930a317'], hosts: { gapicore: { terminals: [pane('term_other')] } } });

  const { out, lineWith } = capture(() => ls(['--all'], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));
  assert.match(lineWith('far-gone'), /pane MORT/, 'the host that owns that pane says it has no such pane');
  assert.match(lineWith('far-gone'), /gapicore/, 'and the row names which host answered');
  assert.match(out, /0 live pane\(s\)/);
});

test('#76: a host answering about something other than its own scope proves no death', () => {
  const dir = store();
  // The conservative direction, and the reason `asked` is not "trust the
  // caller": if a scoped reply ever stops naming the scope it read, absence in
  // it establishes nothing — and this verdict is what authorises closing panes.
  writeRecord(dir, 'far-maybe', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_fm', handle: 'term_far_maybe' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], hosts: { gapicore: { terminals: [], hostIds: ['runtime:somewhere-else'] } } });

  const { out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));
  assert.match(lineWith('far-maybe'), /pane INCONNU/, 'an answer about another scope is not an answer about this pane');
  assert.match(lineWith('far-maybe'), /did not say it read that host's own scope/);
  assert.doesNotMatch(out, /pane MORT/);
});

test('#76: a declared host that cannot answer keeps its panes INCONNU, reason named once', () => {
  const dir = store();
  // The whole point of the omission set: a host that was asked and could not
  // say leaves its panes unknowable. Two records on it, ONE disclosure line —
  // a reason repeated per row is the receipt #70 shortened.
  writeRecord(dir, 'far-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f1', handle: 'term_far1' }) }], { on: 'gapicore' });
  writeRecord(dir, 'far-2', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f2', handle: 'term_far2' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], omittedHostIds: [], hosts: { gapicore: { fail: 'ssh_unreachable' } } });

  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));
  assert.equal(code, 0, 'a host that will not answer is not a count that cannot be established');
  assert.match(out, /far-1 .*pane INCONNU/);
  assert.match(out, /far-2 .*pane INCONNU/);
  assert.doesNotMatch(out, /pane MORT/, 'a host that did not answer never demotes a pane to a corpse');
  const disclosures = out.split('\n').filter(line => line.includes("host 'gapicore' could not be asked"));
  assert.equal(disclosures.length, 1, `one line per host, never per row:\n${out}`);
  assert.match(disclosures[0], /ssh_unreachable/, 'with the reason that host answered (F-004: the raw diagnostic survives)');
  assert.match(out, /0 live pane\(s\)/);
});

test('#76: with no config to read, a remote pane is unknowable and says why', () => {
  const dir = store();
  // A store read from outside any checkout: nothing declares a host, so no
  // host can be reached, and the rows say that instead of implying a scope.
  writeRecord(dir, 'far-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f1', handle: 'term_far1' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], omittedHostIds: [] });

  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: tmpdir() }));
  assert.equal(code, 0);
  assert.match(out, /far-1 .*pane INCONNU/);
  assert.match(out, /host 'gapicore' could not be asked/);
  assert.doesNotMatch(out, /pane MORT/);
  assert.deepEqual(run.calls.filter(args => args.includes('--environment')), [], 'a host neither source can name is never guessed at');
});

// ── round 1 of review on PR #91 ──────────────────────────────────────────────

test('#91: a pane the first list already carries survives a host that stops answering', () => {
  const dir = store();
  // THE P1 FINDING. Presence and absence are not symmetric (pane.mjs): a handle
  // an inventory CARRIES is proven alive by that inventory, whatever scope it
  // read, while only absence needs a scope that covers the pane. A terminal list
  // can carry a pane whose execution host is not local — Orca's own CLI test
  // shows a row with `executionHostId: 'ssh:box-1'` — so discarding that
  // positive proof because the per-host ask then failed would take back a pane
  // THIS invocation had already observed, and drop the cap count that authorises
  // the next dispatch.
  writeRecord(dir, 'far-live', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_fl', handle: 'term_far_live' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [pane('term_far_live')], omittedHostIds: ['runtime:7930a317'], hosts: { gapicore: { fail: 'ssh_unreachable' } } });

  const { out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));
  assert.match(lineWith('far-live'), /pane VIVANT/, 'a pane this run saw is not un-seen by a host that went quiet');
  assert.match(out, /1 live pane\(s\) in acme\/widgets/);
  assert.deepEqual(run.calls.filter(args => args.includes('--environment')), [], 'and the ask is spent only where the first list cannot answer');
  assert.doesNotMatch(out, /could not be asked/, 'a host whose answer would change nothing is no omission');
});

test('#91: a record that named no pane spends no ask on its host', () => {
  const dir = store();
  // A write-ahead record has no handle to classify, so the host's answer cannot
  // change its row — and a round trip per such record is a cost with no reader.
  writeRecord(dir, 'inflight-far', [{ name: 'worker-start' }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], hosts: { gapicore: { terminals: [] } } });

  const { lineWith, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));
  assert.match(lineWith('inflight-far'), /pane INCONNU .*no usable receipt yet/);
  assert.deepEqual(run.calls.filter(args => args.includes('--environment')), []);
});

test('#91: the declaration is the ONLY authority for a host name, and its absence is disclosed', () => {
  const dir = store();
  // THE P2 FINDING, and the reason it stays a finding rather than a fix here.
  // The dispatch store is host-global (record.mjs), so a record another project
  // wrote can name a host this checkout does not declare — and it stays INCONNU,
  // which undercounts capacity for that record.
  //
  // Widening the authority is not this ticket's to take: hosts come from
  // ax.config.json (AGENTS.md), and hosts.mjs refuses an undeclared name so a
  // floor is never inherited by a repo that did not declare it. Orca's own
  // environment registry would answer host-globally, and adopting it as a
  // second authority is a doctrine change with an owner — filed as a follow-up,
  // not decided inside this slice.
  //
  // What this pins is that the gap is honest in both directions: the row is
  // INCONNU and never MORT, the reason is disclosed with its repair, and no
  // scoped read is issued for a name this project did not declare.
  writeRecord(dir, 'other-project', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_op', handle: 'term_op' }) }], { on: 'someone-elses-host' });
  const run = fakeRunner({ terminals: [], hosts: { 'someone-elses-host': { terminals: [pane('term_op')] } } });

  const { out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));
  assert.match(lineWith('other-project'), /pane INCONNU/, 'an undeclared host is not asked, so its pane stays unknowable');
  assert.doesNotMatch(out, /pane MORT/, 'and it is never demoted to a corpse on an unread host');
  const line = out.split('\n').find(l => l.includes("host 'someone-elses-host' could not be asked")) ?? '';
  assert.match(line, /not a host this project declared/, 'the refusal carries hostFor’s repair');
  assert.match(line, /dispatch\.hosts\.someone-elses-host/, 'naming the exact key to declare');
  assert.deepEqual(run.calls.filter(args => args.includes('--environment')), [], 'an undeclared name is never passed to a scoped read, whatever Orca may know');
});

test('a REMOTE handle on a host that cannot be asked is INCONNU, never MORT (measured hostScope, 2026-08-22)', () => {
  const dir = store();
  // The record says where it dispatched, which is what makes this a statement
  // about a pane on another host rather than about any absent handle. Nothing
  // declares `gapicore` here, so #76's ask cannot happen either.
  writeRecord(dir, 'remote-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_r', handle: 'term_elsewhere' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], omittedHostIds: ['runtime:7930a317'] });

  const { lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));
  assert.match(lineWith('remote-1'), /pane INCONNU/);
  assert.match(lineWith('remote-1'), /could not be asked|hosts are omitted/, 'not reading a host is not seeing its pane dead');
});

test('a LOCAL handle is not made unknowable by an omitted REMOTE host', () => {
  // Measured 2026-08-25: one paired remote runtime was out of scope
  // (`{"hostIds":["local"],"omittedHostIds":["runtime:7930a317-…"]}`) and that
  // alone made a locally dispatched pane unprovable — so `ax worker release`
  // answered `pane not establishable` on a corpse whose PR was already merged,
  // and the record stayed unclosable for as long as that unrelated remote slept.
  // Omission is PER HOST: this list read `local`, so it can answer for a local
  // pane whatever else it skipped.
  const dir = store();
  writeRecord(dir, 'local-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_l', handle: 'term_local_gone' }) }]);
  const run = fakeRunner({ terminals: [], omittedHostIds: ['runtime:7930a317'] });

  // MORT is what this asserts, so `--all` is where it is asserted (#70).
  const { out, lineWith } = capture(() => ls(['--all'], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));
  assert.match(lineWith('local-1'), /pane MORT/);
  assert.match(lineWith('local-1'), /which this list did read/);
  assert.match(out, /0 live pane\(s\)/);
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
  // An empty store is a real answer to "have I room" — it is the first dispatch
  // on this machine, and that reader needs the same two scoped counts as the
  // reader of 250 records (#88). Both are zero, said rather than inferred.
  assert.match(out, /0 live pane\(s\) in acme\/widgets/);
  assert.match(out, /0 live pane\(s\) on this machine/);
});

test('a store directory that does not exist is 0 record, said as such, and still answers both counts', () => {
  const { code, out } = capture(() => ls([], { runner: fakeRunner(), env: { ORCA_DISPATCH_STORE: join(store(), 'never-created') } }));
  assert.equal(code, 0);
  assert.match(out, /nothing was ever claimed on this host/);
  assert.match(out, /0 live pane\(s\) in acme\/widgets/);
  assert.match(out, /0 live pane\(s\) on this machine/);
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

// ── the two counts, each labelled by its scope (#88) ─────────────────────────
// Measured 2026-09-02 from the ofmchat checkout: `ls` ended with `3 live
// pane(s) — this is the cap count`, and all three panes belonged to flosrn/ax.
// An orchestrator that honours "count with ls, never from memory" read that as
// being blocked by another project's workers, and spent a turn deciding whether
// it was allowed to dispatch at all.

test('#88: the per-repository count and the machine total are two labelled lines, never one', () => {
  const dir = store();
  writeRecord(dir, 'mine-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_m', handle: 'term_m' }) }]);
  writeRecord(dir, 'theirs-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_t1', handle: 'term_t1' }) }], {
    repo: 'goodluckagency/ofmchat',
  });
  writeRecord(dir, 'theirs-2', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_t2', handle: 'term_t2' }) }], {
    repo: 'goodluckagency/ofmchat',
  });
  // A record written before `--tracker-repo` existed: UNKNOWN, and the machine
  // total is the only count that may carry it (F-028).
  writeRecord(dir, 'nameless-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_n', handle: 'term_n' }) }], { repo: '' });

  const run = fakeRunner({ terminals: [pane('term_m'), pane('term_t1'), pane('term_t2'), pane('term_n')] });
  const { code, out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir } }));

  assert.equal(code, 0);
  assert.match(out, /1 live pane\(s\) in acme\/widgets/, "this repository's count, and it is the one that gates");
  assert.match(out, /dispatch\.cap 3/, 'named with the cap it is measured against');
  assert.match(out, /4 live pane\(s\) on this machine/, 'the machine total, on its own line');
  assert.match(out, /no dispatch\.machineCap/, 'saying that nothing here gates on it');
  assert.match(out, /1 .*name no repository/, 'and the nameless pane the machine total alone carries');
  assert.doesNotMatch(out, /this is the cap count/, 'the label that cost the reported turn is gone');
});

test('#88: an armed machine ceiling is printed as the ceiling it is', () => {
  const dir = store();
  writeRecord(dir, 'mine-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_m', handle: 'term_m' }) }]);
  const run = fakeRunner({ terminals: [pane('term_m')] });
  const { out } = capture(() =>
    ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo({}, { cap: 5, machineCap: 9 }) }),
  );
  assert.match(out, /1 live pane\(s\) in acme\/widgets/);
  assert.match(out, /dispatch\.cap 5/, 'the declared cap, not the default');
  assert.match(out, /dispatch\.machineCap 9/);
});

test('#88: a checkout gh cannot name gets NOT MEASURED, never a zero it would read as room', () => {
  const dir = store();
  writeRecord(dir, 'theirs-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_t', handle: 'term_t' }) }], {
    repo: 'goodluckagency/ofmchat',
  });
  const run = fakeRunner({ terminals: [pane('term_t')] });

  const { code, out } = capture(() =>
    ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, exec: () => ({ status: 1, stdout: '', stderr: 'gh: no auth token\n' }) }),
  );
  assert.equal(code, 0, 'the list still renders: a slug is not a pane count');
  assert.match(out, /NOT MEASURED/);
  assert.match(out, /1 live pane\(s\) on this machine/, 'the count it CAN establish is still answered');
});

// ── ONE definition of "unmeasured", shared with the fence ────────────────────
// The count this verb prints under "could not be asked" must be the count both
// dispatch verbs turn into cannot-establish (../src/worker/capacity.mjs, driven
// by `liveInventory.unresolved`): a record NAMING a host that could not be
// asked. A broader count here would print a cause that did not happen, which is
// #88's own species — a number whose label the reader cannot verify.

test('#88: a NAMED host that could not be asked is the unmeasured count, and it says which', () => {
  const dir = store();
  writeRecord(dir, 'mine-far', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f', handle: 'term_far' }) }], { on: 'gapicore' });
  const run = fakeRunner({ terminals: [], omittedHostIds: ['runtime:7930a317'], hosts: { gapicore: { fail: 'ssh_unreachable' } } });
  const { out } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));

  assert.match(out, /1 pane\(s\) are on a host that could not be asked/, 'exactly the shape the fence refuses on');
  assert.match(out, /host 'gapicore' could not be asked/, 'and the host is named once, with its reason');
});

test('#88: (b) a host that answered without covering its own scope is NOT "could not be asked"', () => {
  // It ANSWERED. The row stays INCONNU — that answer proves nothing about this
  // pane — but naming an ask that happened as an ask that could not happen is
  // the mislabel this test exists to prevent. The row's own line carries why.
  const dir = store();
  writeRecord(dir, 'mine-far', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_f', handle: 'term_far' }) }], { on: 'gapicore' });
  const run = fakeRunner({
    terminals: [],
    omittedHostIds: ['runtime:7930a317'],
    hosts: { gapicore: { terminals: [], hostIds: ['someone-elses-scope'] } },
  });
  const { out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));

  assert.match(lineWith('mine-far'), /pane INCONNU/, 'still unknown, and still shown');
  assert.match(lineWith('mine-far'), /did not say it read that host's own scope/);
  assert.doesNotMatch(out, /could not be asked/, 'a host that answered is not a host that could not be asked');
});

test('#88: (c) a record whose placement no phase named is NOT "could not be asked" either', () => {
  // Nothing named a host, so no ask was possible and none failed. The scope
  // itself is the disclosure, and it already has its own line.
  const dir = store();
  writeRecord(dir, 'unplaced-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_u', handle: 'term_ghost' }) }]);
  const run = fakeRunner({ terminals: [], omittedHostIds: ['runtime:7930a317'], hostIds: null });
  const { out, lineWith } = capture(() => ls([], { runner: run, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.match(lineWith('unplaced-1'), /pane INCONNU/);
  assert.doesNotMatch(out, /could not be asked/, 'no host was named, so none could fail to answer');
  assert.match(out, /name no placement, and this list omits/, 'the residue keeps the disclosure it always had');
});

// ── #165: the continuation a dead row still names ────────────────────────────
// A worker's pane is gone and its work is NOT finished: the record reads MORT
// and its pull request is still open. Until now neither reader printed the verb
// that continues it, so an operator holding a dead row with an open PR had to
// know `--replace` exists. The line is advertised only now that it is safe to
// type: `inheritPlacement` (../src/worker/start.mjs, #164) reinstates the
// recorded placement or refuses, so the continuation carries NO placement flag
// and nothing here derives one.
//
// The proof of "open PR" is the read `release` already makes — `gh pr list
// --head <branch>` — and an answer it cannot get is never an open PR (F-028).

const prList = rows => ({ status: 0, stdout: JSON.stringify(rows), stderr: '' });

/**
 * The two machine answers this verb's continuation read needs, stubbed: `gh`
 * (the checkout's slug, and the pull requests of a branch) and `git` (which
 * branch the recorded worktree is on). Answers are keyed by the first two argv
 * words — the same convention as tests/worker-release.test.mjs, where for git
 * the subcommand sits after `-C <path>`.
 */
function fakeExec({ slug = 'acme/widgets', answers = {} } = {}) {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin === 'gh' && args[0] === 'repo') {
      return slug === '' ? { status: 1, stdout: '', stderr: 'gh: no auth token\n' } : { status: 0, stdout: `${slug}\n`, stderr: '' };
    }
    const sub = bin === 'git' ? args[args.indexOf('-C') + 2] ?? args[0] : `${args[0]} ${args[1]}`;
    const key = `${bin} ${sub}`;
    return answers[key] ?? { status: 1, stdout: '', stderr: `stub has no answer for ${key}\n` };
  };
  return { exec, calls };
}

/**
 * A store holding ONE record whose pane the runtime cannot see — the MORT row
 * every case below reads — with a worktree that exists on disk, because a
 * branch nobody can name is a branch nothing can be asked about.
 */
function deadRow(request = 'dead-1', { answers = {}, terminals = [], on = '' } = {}) {
  const dir = store();
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), `ax-ls-${request}-`)));
  writeRecord(dir, request, [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_dead', handle: 'term_dead' }) }], { worktree, on });
  const run = fakeRunner({ terminals, workers: [], ...(on === '' ? {} : { omittedHostIds: ['runtime:7930a317'], hosts: { [on]: { fail: 'ssh_unreachable' } } }) });
  const { exec, calls } = fakeExec({ answers });
  return { dir, worktree, run, exec, calls };
}

test('#165: a MORT pane whose branch has an OPEN pull request carries the replace continuation', () => {
  const { dir, run, exec, calls } = deadRow('dead-1', {
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/dead-1\n', stderr: '' },
      'gh pr list': prList([{ number: 71, state: 'OPEN', headRefName: 'feat/dead-1' }]),
    },
  });

  // The DEFAULT view: a MORT row that names a repair carries a decision, which
  // is the whole predicate #70 hid the others behind.
  const { code, out, lineWith } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.equal(code, 0);
  assert.match(lineWith('dead-1'), /pane MORT/, 'the disposition is unchanged: this verb relabels no verdict');
  assert.match(out, /→ ax worker start --replace --request dead-1/, 'the continuation, exactly as it is typed');
  assert.doesNotMatch(out, /--replace.*--worktree|--replace.*--on /, 'placement is inherited from the record, never printed here');
  assert.match(out, /#71/, 'and the open PR that makes it the right verb is named');
  assert.ok(
    calls.some(line => line.includes('gh pr list') && line.includes('--head feat/dead-1')),
    `the open-PR proof is the --head read release already makes: ${calls.join(' | ')}`,
  );
});

test('#165: a MORT pane whose PR is MERGED gets the release route, never the replace one', () => {
  const { dir, run, exec } = deadRow('landed-1', {
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/landed-1\n', stderr: '' },
      'gh pr list': prList([{ number: 66, state: 'MERGED', headRefName: 'feat/landed-1' }]),
    },
  });

  const { out } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.match(out, /→ ax worker release --dispatch ctx_dead/, "a landed row is release's, and release reads that proof for itself");
  assert.doesNotMatch(out, /--replace/, 'nothing is left to continue on a merged pull request');
});

test('#165: a MORT pane with no pull request at all gets the settle route', () => {
  const { dir, run, exec } = deadRow('unshipped-1', {
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/unshipped-1\n', stderr: '' },
      'gh pr list': prList([]),
    },
  });

  const { out } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.match(out, /→ ax worker settle unshipped-1/, "an attempt that shipped nothing owes an ending, which is settle's write");
  assert.doesNotMatch(out, /--replace/);
});

test('#165: a gh that cannot answer prints NEITHER continuation and says the read failed', () => {
  // An absent answer is not an absent pull request (F-028). The row keeps its
  // verdict, the failure is named, and the repair is the exact call that failed.
  const { dir, run, exec } = deadRow('flaky-1', {
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/flaky-1\n', stderr: '' },
      'gh pr list': { status: 1, stdout: '', stderr: 'API rate limit exceeded\n' },
    },
  });

  const { out } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.match(out, /API rate limit exceeded/, 'the refusal is quoted, never summarised');
  assert.doesNotMatch(out, /--replace|ax worker settle|ax worker release/, 'no route is offered on a read that failed');
  assert.match(out, /→ gh pr list .*--head feat\/flaky-1/, 'and the failed read is the repair');
});

test('#165: a VIVANT pane never carries the replace line, and is never asked about', () => {
  // The continuation is for a pane that is GONE. A live child's branch has an
  // open PR by construction, so a predicate on the PR alone would advertise a
  // replace over a working session — and pay a gh call per row to do it.
  const { dir, run, exec, calls } = deadRow('alive-1', {
    terminals: [pane('term_dead')],
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/alive-1\n', stderr: '' },
      'gh pr list': prList([{ number: 72, state: 'OPEN', headRefName: 'feat/alive-1' }]),
    },
  });

  const { out, lineWith } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.match(lineWith('alive-1'), /pane VIVANT/);
  assert.doesNotMatch(out, /--replace/);
  assert.ok(!calls.some(line => line.includes('gh pr list')), `a live row asks nothing: ${calls.join(' | ')}`);
});

test('#165: an INCONNU pane never carries the replace line either', () => {
  // Its host could not be asked, so the pane may be alive right now: replacing
  // a child that is working is the mutation this verdict exists to prevent.
  const { dir, run, exec, calls } = deadRow('far-1', {
    on: 'gapicore',
    answers: {
      'git rev-parse': { status: 0, stdout: 'feat/far-1\n', stderr: '' },
      'gh pr list': prList([{ number: 73, state: 'OPEN', headRefName: 'feat/far-1' }]),
    },
  });

  const { out, lineWith } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo(declared) }));

  assert.match(lineWith('far-1'), /pane INCONNU/);
  assert.doesNotMatch(out, /--replace/);
  assert.ok(!calls.some(line => line.includes('gh pr list')), `an unknown pane asks nothing: ${calls.join(' | ')}`);
});

test('#165: a MORT row that names no continuation stays out of the default view, and is counted', () => {
  // The 222 rows measured on this machine 2026-09-05: no worktree left to name
  // a branch with, so nothing can be asked and nothing can be typed. They keep
  // the disclosed count they had — and cost no gh call.
  const dir = store();
  writeRecord(dir, 'archaeology-1', [{ name: 'worker-start', receipt: started({ dispatchId: 'ctx_old', handle: 'term_old' }) }]);
  const run = fakeRunner({ terminals: [], workers: [] });
  const { exec, calls } = fakeExec();

  const { out } = capture(() => ls([], { runner: run, exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));

  assert.doesNotMatch(out, /archaeology-1/, 'still withheld: it answers neither capacity nor overlap');
  assert.match(out, /1 MORT record\(s\) not shown/);
  assert.ok(!calls.some(line => line.includes('gh pr list')), `no branch to ask about, so no ask: ${calls.join(' | ')}`);

  const every = capture(() => ls(['--all'], { runner: run, exec: fakeExec().exec, env: { ORCA_DISPATCH_STORE: dir }, cwd: repo() }));
  assert.match(every.out, /archaeology-1/, '--all still shows every record');
});
