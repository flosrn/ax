// `ax worker release` — the most destructive verb in the surface.
//
// Every proposition here is one an incident proved (F-027). The first four are
// the port of orca-close-sessions.test.ts, whose subject was the REPORT, because
// the report is what an operator acts on: measured during a live run on
// 2026-08-10 it read `0 closeable · 1 kept · 80 with no pane to close`, and
// those eighty mixed three unrelated causes needing three different answers.
//
// The rest are the propositions the port added, each measured on this machine
// (2026-08-22, Orca 1.4.185): the handle key that hid 86 workers, the four
// `terminalState` values bash never looked at, the remote pane `worker-release`
// refuses, the movement rule, and the write-ahead protocol every close follows.
//
// Offline by construction: the Orca runner is injected and `gh`/`git` are a
// stubbed exec, so no runtime is touched and nothing is ever released for real.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { defaultExec } from '../src/exec.mjs';
import { release } from '../src/worker/release.mjs';

/**
 * A REAL directory, canonicalised: the verb compares physical paths (a raw
 * `/scope/../elsewhere` starts with the scope as a string while naming a tree
 * outside it), and it asks the filesystem whether a worktree still exists.
 */
const SCOPE = realpathSync(mkdtempSync(join(tmpdir(), 'ax-scope-')));

/** Everything the verb told the human, on either stream, and its exit code. */
function capture(fn) {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/**
 * A worker row in the shape the runtime actually returns: the handle at
 * `agentTerminalHandle`, `resource` frequently null (86 of 218 rows on this
 * machine), the worktree only inside it when it is not.
 */
const worker = (dispatchId, extra = {}) => ({
  dispatchId,
  workerState: 'succeeded',
  terminalState: 'retained',
  agentTerminalHandle: `term_${dispatchId}`,
  resource: null,
  ...extra,
});

const terminal = (handle, extra = {}) => ({ handle, orphaned: false, worktreePath: `${SCOPE}/wt`, executionHostId: 'local', ...extra });

/**
 * A stub Orca. `cursors` is the per-handle series the two liveness samples read
 * from, so a pane can be made to move or to sit still; every argv is recorded,
 * which is how "nothing was released" is asserted rather than assumed.
 */
function fakeOrca({ workers = [], terminals = [], cursors = {}, hostScope = { hostIds: ['local'], omittedHostIds: [] }, releaseReceipts = {}, onRelease } = {}) {
  const calls = [];
  const reads = {};
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      const line = args.join(' ');
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }), stderr: '' };
      if (line.includes('worker-list')) return { status: 0, stdout: JSON.stringify({ ok: true, result: { workers } }), stderr: '' };
      if (line.startsWith('terminal list')) return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminals, hostScope, truncated: false } }), stderr: '' };
      if (line.startsWith('terminal read')) {
        const handle = args[args.indexOf('--terminal') + 1];
        reads[handle] = (reads[handle] ?? 0) + 1;
        const series = cursors[handle] ?? [1, 1];
        const cursor = series[Math.min(reads[handle] - 1, series.length - 1)];
        return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle, status: 'running', latestCursor: cursor, tail: [] } } }), stderr: '' };
      }
      if (line.includes('worker-release')) {
        const id = args[args.indexOf('--dispatch') + 1];
        // Observed AT CALL TIME, which is the only moment that can tell a
        // write-ahead record from a write-behind one.
        if (onRelease) onRelease(args);
        const canned = releaseReceipts[id];
        if (canned) return canned;
        // The shape measured 2026-08-22, Orca 1.4.185: `state` names what
        // happened, `processAction` what was done to the process, and `mutation`
        // carries the retry identity back.
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              dispatchId: id,
              state: 'released',
              processAction: 'closed_agent_terminal',
              archive: { source: 'terminal', status: 'captured' },
              mutation: { requestId: args[args.indexOf('--retry-request') + 1], replayed: false },
            },
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'unexpected' } }), stderr: '' };
    },
  });
  return { runner, calls };
}

/** A stub `gh` and `git`. Answers are keyed by the first two argv words. */
function fakeExec({ repo = 'owner/repo', answers = {} } = {}) {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    // Keyed on the subcommand, which for git sits after `-C <path>`: the flags
    // ax passes (`-c safe.directory=*`) are the fixed part, never the question.
    const sub = bin === 'git' ? args[args.indexOf('-C') + 2] ?? args[0] : `${args[0]} ${args[1]}`;
    const key = `${bin} ${sub}`;
    if (bin === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: `${SCOPE}\n`, stderr: '' };
    if (bin === 'gh' && args[0] === 'repo') return { status: 0, stdout: `${repo}\n`, stderr: '' };
    return answers[key] ?? { status: 1, stdout: '', stderr: `stub has no answer for ${key}\n` };
  };
  return { exec, calls };
}

const store = () => mkdtempSync(join(tmpdir(), 'ax-release-'));

/**
 * A dispatch store record: the provenance a bulk proof needs.
 *
 * `repo` is what PLACES the row (#83): the sweep is scoped to the repository a
 * record NAMES, never to the path its worktree sits at, so the default here is
 * the slug `fakeExec` answers with. `repo: ''` writes no key at all — the
 * pre-0.17.0 shape, which is unknown and never ours.
 */
function record(dir, request, dispatchId, { createdAt = '2026-08-20T10:00:00.000Z', beganAt = null, handle = `term_${dispatchId}`, state = 'ready', repo = 'owner/repo' } = {}) {
  writeFileSync(
    join(dir, `${request}.json`),
    JSON.stringify({
      request,
      host: 'test',
      orca: 'stub-orca',
      createdAt,
      ...(repo === '' ? {} : { repo }),
      attempts: [
        {
          n: 1,
          settled: false,
          phases: [
            {
              name: 'worker-start',
              identity: 'id-1',
              argv: ['stub-orca', 'orchestration', 'worker-start'],
              beganAt,
              exit: 0,
              receipt: { ok: true, result: { dispatchId, state, effects: [{ kind: 'terminal', role: 'agent', id: handle }] } },
            },
          ],
        },
      ],
    }),
  );
}

const run = (argv, { orca = {}, execOptions = {}, env = {}, dir } = {}) => {
  const { runner, calls } = fakeOrca(orca);
  const { exec, calls: shell } = fakeExec(execOptions);
  const at = dir ?? store();
  const result = capture(() => release([...argv, '--store', at, '--gap', '0'], { runner, exec, env: { HOME: at, ...env }, cwd: SCOPE, sleep: () => {} }));
  return { ...result, calls, shell, dir: at };
};

// ── the three causes, ported verbatim from orca-close-sessions.test.ts ────────

/** One worker each, for the three causes the single catch-all used to merge. */
const THREE_CAUSES = [
  // Released by the operator already: nothing to do, and pure noise in a report.
  worker('ctx_released', { terminalState: 'released' }),
  // A worker whose terminal is gone — the corpse of a failed attempt.
  worker('ctx_corpse', { workerState: 'failed', agentTerminalHandle: 'term_gone' }),
  // Never had a terminal recorded at all.
  worker('ctx_nohandle', { agentTerminalHandle: '' }),
];

test('the three causes are counted separately, not merged into one line', () => {
  const r = run(['--all'], { orca: { workers: THREE_CAUSES } });

  assert.match(r.out, /1 already released/);
  assert.match(r.out, /1 terminal gone/);
  assert.match(r.out, /1 no terminal recorded/);
});

test('no single catch-all category may dominate the report', () => {
  const r = run(['--all'], { orca: { workers: THREE_CAUSES } });

  // The exact phrasing that hid eighty workers behind one number.
  assert.doesNotMatch(r.out, /with no pane to close/);
  // And no row hides anywhere else either: three inputs, three named causes of
  // one, nothing kept, nothing closeable. A new residual bucket — or a silently
  // dropped row — breaks this arithmetic.
  assert.match(r.out, /0 closeable · 0 kept/);
  const counted = [...r.out.matchAll(/(\d+) (?:already released|terminal gone|no terminal recorded|release in flight|pane not establishable)/g)];
  assert.equal(
    counted.reduce((sum, hit) => sum + Number(hit[1]), 0),
    THREE_CAUSES.length,
    'every row is in exactly one named category',
  );
});

test('a live worker whose ownership this row does not prove carries the fallback with it', () => {
  // Measured 2026-08-28 on goodluckagency/ofmchat#100, and it is the SAME defect
  // as the `user_owned` row below, fixed for one ownership value out of five.
  // `worker-list` carried no ownership for this dispatch, so release named
  // `orca orchestration worker-stop`, which answered
  // `dispatch_inactive: Dispatch ctx_… is not stopping.` — a closed loop: two
  // verbs, neither able to close the record, and a pane still counted in the cap.
  //
  // Orca closes a terminal on a stop ONLY when its own resource row reads
  // `ownership_state === 'owned'` (rpc/methods/orchestration-worker-stop.ts:141);
  // every other value answers `processAction: 'none'` and closes nothing. An
  // absent ownership here is "unknown to this row", never proven owned — so the
  // stop stays named, and the command that follows a `none` is named WITH it.
  const r = run(['--all'], {
    orca: {
      workers: [...THREE_CAUSES, worker('ctx_live', { workerState: 'ready' })],
      terminals: [terminal('term_ctx_live')],
    },
  });

  assert.match(r.out, /ctx_live/);
  assert.match(r.out, /1 kept/);
  assert.match(r.out, /ownership unproven on this row/);
  assert.match(r.out, /worker-stop --dispatch ctx_live/, 'cancelling a live session is a different decision, and it is named');
  assert.match(r.out, /orca terminal close --terminal term_ctx_live/, 'and the route a processAction: none leaves is named on the same line');
});

test('the offered stop carries its dispatch_inactive aftermath, so a failure is not read as a no-op', () => {
  // REPORT-ONLY: this verb runs no stop and observes no receipt, so the assertion
  // is about the caveat travelling with the command it offers — never about a stop
  // having happened here.
  //
  // Why the caveat exists: `dispatch_inactive` from a stop is thrown by
  // `settleWorkerStop` (orchestration/db/worker-dispatch/worker-dispatch-stop.ts:96),
  // which runs only after `closeTerminal` reported `ptyKilled` — so that failure
  // receipt can arrive over a pane that is already gone. Confirmed on
  // ctx_5ffd0641bcf5 (ofmchat #100, 2026-08-28): the stop answered
  // `dispatch_inactive`, and the next `ax triage release` counted the row
  // `1 terminal gone`. Without this clause the operator reads the error as "the
  // command did nothing" and stops re-running the one verb that would have closed
  // the record.
  const r = run(['--all'], {
    orca: {
      workers: [worker('ctx_live', { workerState: 'ready' })],
      terminals: [terminal('term_ctx_live')],
    },
  });

  assert.match(r.out, /re-run this verb/);
  assert.match(r.out, /dispatch_inactive/);
});

test('a live pane Orca owns as the USER names the one command that can close it', () => {
  // Measured 2026-08-26 on ofmchat #79, three commands to free one pane this
  // tool created: release named `worker-stop`, `worker-stop` answered
  // `processAction: "none"` / "The worker terminal is user_owned; no terminal
  // was closed", and only the SECOND release — now reading `stop_unknown` —
  // named `orca terminal close`. The ownership was readable at the first turn,
  // on the same `worker-list` row this verb already parses.
  const r = run(['--all'], {
    orca: {
      workers: [worker('ctx_owned', {
        workerState: 'ready',
        resource: { ownershipState: 'user_owned', terminalHandle: 'term_ctx_owned', worktreeId: `id::${SCOPE}/wt` },
      })],
      terminals: [terminal('term_ctx_owned')],
    },
  });

  assert.match(r.out, /user_owned/, 'the reason is named, not just the repair');
  assert.match(r.out, /orca terminal close --terminal term_ctx_owned/);
  // The prose is free to SAY worker-stop cannot settle this; what must not appear
  // is worker-stop offered as the repair.
  assert.doesNotMatch(r.out, /→ orca orchestration worker-stop/);
});

test('nothing is released on the report path', () => {
  // The fixture MUST contain a row that would otherwise close: a report whose
  // input has nothing closeable cannot prove that a report closes nothing.
  const dir = store();
  record(dir, 'triage-4', 'ctx_ready');
  const r = run(['--all'], {
    dir,
    orca: {
      workers: [...THREE_CAUSES, worker('ctx_ready')],
      terminals: [terminal('term_ctx_ready')],
      cursors: { term_ctx_ready: [4, 4] },
    },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T09:00:00.000Z' }] }), stderr: '' } } },
  });

  assert.equal(r.code, 0);
  assert.match(r.out, /1 closeable/, 'the fixture has to offer something for this test to mean anything');
  assert.match(r.out, /report only — nothing was closed/);
  assert.ok(
    r.calls.every(argv => !argv.includes('worker-release')),
    'the report path may never issue a mutation',
  );
});

// ── the handle key that hid the eighty ───────────────────────────────────────

test('the agent handle is read from the key the runtime fills, not only from resource', () => {
  // 217 of 218 rows carry `agentTerminalHandle`; 132 also carry
  // `resource.terminalHandle`. Reading the resource key alone reported 86
  // workers as "no terminal recorded" — that is where the eighty came from.
  //
  // Both rows carry a record naming this repository, because that key is what
  // places a row now (#83): an unplaced row is declined before its handle is
  // ever read, which would make this proposition unobservable.
  const dir = store();
  record(dir, 'ws-top', 'ctx_top');
  record(dir, 'ws-res', 'ctx_res', { handle: 'term_ctx_res' });
  const r = run(['--all'], {
    dir,
    orca: {
      workers: [worker('ctx_top'), worker('ctx_res', { agentTerminalHandle: undefined, resource: { terminalHandle: 'term_ctx_res', worktreeId: `id::${SCOPE}/wt` } })],
      terminals: [terminal('term_ctx_top'), terminal('term_ctx_res')],
    },
  });

  assert.match(r.out, /0 no terminal recorded/);
  assert.match(r.out, /ctx_top/);
  assert.match(r.out, /ctx_res/);
});

// ── the terminal states bash never looked at ─────────────────────────────────

test('a release in flight and a release Orca cannot account for are not "already released"', () => {
  const r = run(['--all'], {
    orca: {
      workers: [
        worker('ctx_pending', { terminalState: 'release_pending' }),
        worker('ctx_unknown', { terminalState: 'release_unknown' }),
      ],
    },
  });

  assert.match(r.out, /0 already released/);
  assert.match(r.out, /1 release in flight/);
  // The unknown one is the only row of the two an operator must chase, so it is
  // a printed KEPT row with a repair — never a number in a residual, and never
  // in both places at once.
  assert.match(r.out, /1 kept/);
  assert.match(r.out, /ctx_unknown.*cannot account for an earlier release/);
  assert.match(r.out, /--retry-request/, 'the repair is an action, not a look');
  assert.doesNotMatch(r.out, /release state unknown/);
});

// ── what the receipt said, and what ax printed of it ─────────────────────────
//
// #100: a `release_unknown` receipt carries `lastError` (what Orca did and did
// not confirm) and `recovery` (what Orca prescribes). ax printed neither, so the
// operator got `exit 1: Orca cannot account for this release` — no reason — and
// a repair line that only INSPECTED. A `worker-show` is a look, not an action.

const LAST_ERROR =
  'The agent terminal was closed but its process could not be confirmed stopped: a follow-up stop was issued but its outcome could not be verified.';
const RECOVERY = 'Inspect the worker with worker-show, then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.';

const unknownReceipt = (result = {}) => ({
  status: 1,
  stdout: JSON.stringify({
    ok: true,
    result: { dispatchId: 'ctx_ru', state: 'release_unknown', processAction: 'closed_agent_terminal', archive: { status: 'captured' }, ...result },
  }),
  stderr: '',
});

/** A release record on disk, in the namespace this verb writes: `<store>/release/<ctx>.json`. */
function releaseRecord(dir, dispatchId, result) {
  mkdirSync(join(dir, 'release'), { recursive: true });
  writeFileSync(
    join(dir, 'release', `${dispatchId}.json`),
    JSON.stringify({
      request: `release-${dispatchId}`,
      host: 'test',
      orca: 'stub-orca',
      createdAt: '2026-08-20T10:00:00.000Z',
      attempts: [
        {
          n: 1,
          settled: false,
          phases: [
            {
              name: 'worker-release',
              identity: 'id-1',
              argv: ['stub-orca', 'orchestration', 'worker-release', '--dispatch', dispatchId, '--retry-request', 'id-1', '--json'],
              exit: 1,
              receipt: { ok: true, result: { dispatchId, state: 'release_unknown', processAction: 'closed_agent_terminal', ...result } },
            },
          ],
        },
      ],
    }),
  );
}

test('a release_unknown prints the reason and the recovery its own receipt carried', () => {
  const r = run(['--close', '--dispatch', 'ctx_ru', '--no-proof'], {
    orca: {
      workers: [worker('ctx_ru')],
      terminals: [terminal('term_ctx_ru')],
      releaseReceipts: { ctx_ru: unknownReceipt({ lastError: LAST_ERROR, recovery: RECOVERY }) },
    },
  });

  assert.equal(r.code, 1);
  assert.ok(r.out.includes(LAST_ERROR), 'the sentence Orca wrote, verbatim');
  assert.ok(r.out.includes(RECOVERY), 'and the recovery it prescribes, verbatim');
  // Every finding names its repair, and the recorded recovery defeats itself:
  // the request is already completed in Orca's ledger, so repeating the same
  // `--retry-request` is served from it. Only a FRESH identity re-enters the
  // release, and ax may not mint one (F-001) — so the repair is the operator's
  // command, named rather than implied.
  assert.match(r.out, /--retry-request/);
  assert.ok(!/^\s*→ orca orchestration worker-show --dispatch ctx_ru --json\s*$/m.test(r.out), 'a worker-show alone is a look, not a repair');
  // The identity is minted by the runtime ax already requires, never by a
  // utility the host may lack: review of the first draft (Codex, P2) measured
  // `uuidgen` absent on a minimal Linux, where the repair would have printed
  // `command not found`, substituted an empty value and invoked Orca with an
  // invalid --retry-request.
  assert.match(r.out, /node -p "require\('crypto'\)\.randomUUID\(\)"/, 'the fresh identity comes from node');
  assert.doesNotMatch(r.out, /uuidgen/);
});

test('a release_unknown receipt carrying neither field says so, rather than printing nothing', () => {
  const r = run(['--close', '--dispatch', 'ctx_ru', '--no-proof'], {
    orca: { workers: [worker('ctx_ru')], terminals: [terminal('term_ctx_ru')], releaseReceipts: { ctx_ru: unknownReceipt() } },
  });

  assert.equal(r.code, 1);
  assert.match(r.out, /no reason given by the runtime/);
});

test('a swept release_unknown row names the reason its recorded receipt carried', () => {
  const dir = store();
  releaseRecord(dir, 'ctx_unknown', { lastError: LAST_ERROR, recovery: RECOVERY });
  const r = run(['--all'], { dir, orca: { workers: [worker('ctx_unknown', { terminalState: 'release_unknown' })] } });

  assert.match(r.out, /1 kept/);
  assert.ok(r.out.includes(LAST_ERROR));
  assert.ok(r.out.includes(RECOVERY));
  assert.match(r.out, /--retry-request/);
});

test('a swept release_unknown with no recorded receipt says the reason cannot be read here', () => {
  // F-028: this host having no release record is not the runtime having given no
  // reason, and the two must not print the same sentence.
  const r = run(['--all'], { orca: { workers: [worker('ctx_unknown', { terminalState: 'release_unknown' })] } });

  assert.match(r.out, /1 kept/);
  assert.match(r.out, /no release receipt/);
  assert.doesNotMatch(r.out, /no reason given by the runtime/);
});

test('a context-only dispatch owns no terminal to release, and says so instead of churning', () => {
  // Measured: `orchestration dispatch` rows arrive `unsupervised`, and releasing
  // them returns ok:true with `processAction: none`. 36 such calls were issued
  // in one campaign — churn that reads exactly like work.
  const r = run(['--all'], {
    orca: { workers: [worker('ctx_ctxonly', { workerState: 'unsupervised' })], terminals: [terminal('term_ctx_ctxonly')] },
  });

  assert.match(r.out, /context-only dispatch/);
  assert.match(r.out, /orca terminal close --terminal term_ctx_ctxonly/);
  assert.match(r.out, /0 closeable/);
});

test('a pane on another execution host is never offered to worker-release', () => {
  // Measured 2026-08-14: `worker-release` answers federation_unsupported and
  // retains the pane. The repair is a terminal close on that environment.
  const r = run(['--all'], {
    orca: { workers: [worker('ctx_remote')], terminals: [terminal('term_ctx_remote', { executionHostId: 'gapicore' })] },
  });

  assert.match(r.out, /pane REMOTE on gapicore/);
  assert.match(r.out, /orca terminal close --terminal term_ctx_remote --environment gapicore/);
  assert.match(r.out, /0 closeable/);
});

test('a handle absent from a scope that omits hosts is UNKNOWN, never a corpse', () => {
  const r = run(['--all'], {
    orca: {
      workers: [worker('ctx_elsewhere')],
      terminals: [],
      hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:7930a317'] },
    },
  });

  assert.match(r.out, /0 terminal gone/);
  assert.match(r.out, /1 pane not establishable/);
  assert.match(r.out, /runtime:7930a317/);
});

test('a LOCAL pane absent while only a REMOTE host is omitted is a corpse, not an unknown', () => {
  // Measured 2026-08-25 on ofmchat 56-scores-r2: PR merged, the child's pane
  // long closed, and `ax worker release --dispatch … --close` still answered
  // `1 pane not establishable · nothing to close` — because one paired remote
  // runtime was asleep and its omission was read as global. The record made the
  // dispatch locally, so the list that read `local` had already answered for it.
  const dir = store();
  record(dir, '56-scores-r2', 'ctx_local_gone');
  const r = run(['--all'], {
    dir,
    orca: {
      workers: [worker('ctx_local_gone')],
      terminals: [],
      hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:7930a317'] },
    },
  });

  assert.match(r.out, /1 terminal gone/);
  assert.match(r.out, /0 pane not establishable/);
});

// ── proof of landing ────────────────────────────────────────────────────────

test('a merged PR closes the pane; an open one keeps it', () => {
  const dir = store();
  record(dir, 'ws-merged', 'ctx_merged');
  record(dir, 'ws-open', 'ctx_open');

  const r = run(['--all'], {
    dir,
    orca: {
      workers: [worker('ctx_merged'), worker('ctx_open')],
      terminals: [terminal('term_ctx_merged', { worktreePath: `${SCOPE}/ws-merged` }), terminal('term_ctx_open', { worktreePath: `${SCOPE}/ws-open` })],
    },
    execOptions: {
      answers: {
        // Both worktrees are gone, the normal state after `gh pr merge`.
        'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 41, headRefName: 'ws-merged' }]), stderr: '' },
      },
    },
  });

  assert.match(r.out, /ctx_merged.*CLOSE.*PR #41 merged/);
  assert.match(r.out, /ctx_open.*KEEP.*no merged PR/);
  assert.match(r.out, /1 closeable/);
});

test('a near-miss slug finds nothing rather than the closest thing', () => {
  // `wizard-178` matched `feat/wizard-1788` under a substring rank and was
  // reported as proof. The rank is gone: exact, then `…/slug`, then nothing.
  const dir = store();
  record(dir, 'wizard-178', 'ctx_near');

  const r = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_near')], terminals: [terminal('term_ctx_near', { worktreePath: `${SCOPE}/wizard-178` })] },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 9, headRefName: 'feat/wizard-1788' }]), stderr: '' } } },
  });

  assert.match(r.out, /KEEP/);
  assert.match(r.out, /no merged PR for 'wizard-178'/);
  assert.match(r.out, /0 closeable/);
});

test('the prefix/slug form is proof, and a tie at the winning rank is ambiguity', () => {
  const dir = store();
  record(dir, 'wizard-178', 'ctx_prefix');
  const prefixed = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_prefix')], terminals: [terminal('term_ctx_prefix', { worktreePath: `${SCOPE}/wizard-178` })] },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 4, headRefName: 'feat/wizard-178' }]), stderr: '' } } },
  });
  assert.match(prefixed.out, /CLOSE.*PR #4 merged/);

  // Two head refs ending in the same slug: naming both is the only honest answer.
  const tie = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_prefix')], terminals: [terminal('term_ctx_prefix', { worktreePath: `${SCOPE}/wizard-178` })] },
    execOptions: {
      answers: {
        'gh pr list': {
          status: 0,
          stdout: JSON.stringify([{ number: 4, headRefName: 'feat/wizard-178' }, { number: 5, headRefName: 'fix/wizard-178' }]),
          stderr: '',
        },
      },
    },
  });
  assert.match(tie.out, /KEEP/);
  assert.match(tie.out, /matches #4,#5/);
  assert.match(tie.out, /0 closeable/);
});

test('a dispatch is dated by the record it wrote, never by the file it lives in', () => {
  // A `--resume` rewrites the record, pushing its mtime past the artifact the
  // dispatch produced — which turns a proven session into a permanent KEEP, the
  // gate refusing exactly the case it exists to clear.
  const dir = store();
  record(dir, 'triage-12', 'ctx_dated', { createdAt: '2026-08-20T10:00:00.000Z' });
  const future = new Date('2026-08-24T00:00:00.000Z');
  utimesSync(join(dir, 'triage-12.json'), future, future);

  const r = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_dated')], terminals: [terminal('term_ctx_dated')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T09:00:00.000Z' }] }), stderr: '' } } },
  });
  assert.match(r.out, /CLOSE.*comment on #12 after dispatch/);

  // And a record whose date cannot be read proves nothing rather than everything.
  const junk = store();
  record(junk, 'triage-13', 'ctx_junk', { createdAt: 'not a date' });
  const undated = run(['--all'], {
    dir: junk,
    orca: { workers: [worker('ctx_junk')], terminals: [terminal('term_ctx_junk')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T09:00:00.000Z' }] }), stderr: '' } } },
  });
  assert.match(undated.out, /KEEP.*no readable dispatch date/);
});

test('a triage is proven by a comment newer than its dispatch, and only that', () => {
  const dir = store();
  record(dir, 'triage-7', 'ctx_triage', { createdAt: '2026-08-20T10:00:00.000Z' });

  const after = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_triage')], terminals: [terminal('term_ctx_triage')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-20T11:00:00.000Z' }] }), stderr: '' } } },
  });
  assert.match(after.out, /CLOSE.*comment on #7 after dispatch/);

  const before = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_triage')], terminals: [terminal('term_ctx_triage')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-19T09:00:00.000Z' }] }), stderr: '' } } },
  });
  assert.match(before.out, /KEEP.*predates dispatch/);
});

// The kind set is `triage-` and `brief-`: the `refine-` kind went with the
// readiness lane `ax triage` no longer has. What is pinned here is that the
// SECOND surviving kind is proven the same way — by a comment newer than the
// dispatch, never by a merged PR.
test('a brief is proven by a comment newer than its dispatch, like triage', () => {
  const dir = store();
  record(dir, 'brief-7', 'ctx_brief', { createdAt: '2026-08-20T10:00:00.000Z' });

  const after = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_brief')], terminals: [terminal('term_ctx_brief')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-20T11:00:00.000Z' }] }), stderr: '' } } },
  });
  assert.match(after.out, /CLOSE.*comment on #7 after dispatch/);

  const before = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_brief')], terminals: [terminal('term_ctx_brief')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-19T09:00:00.000Z' }] }), stderr: '' } } },
  });
  assert.match(before.out, /KEEP.*predates dispatch/);
});


test('a dispatch this host never recorded cannot be placed, and an unplaceable row is never judged', () => {
  // #83: placement is the repository a RECORD names. A pane with no record at
  // all names none, so it is declined once, counted in the bucket that says why,
  // and never proven — an absence authorizes nothing (F-028).
  const r = run(['--all'], {
    orca: { workers: [worker('ctx_orphan')], terminals: [terminal('term_ctx_orphan')] },
  });

  assert.match(r.out, /1 no repository on record/);
  assert.match(r.out, /0 closeable/);
});

test('a refused git call is a refusal, never good news', () => {
  // Two audits concluded "nothing to save" from a hidden git error before a
  // third found 116 unpushed commits, so no call here hides its stderr.
  const dir = store();
  record(dir, 'ws-here', 'ctx_here');
  // A worktree that still EXISTS, inside the checkout this run can prove things
  // about: that is the branch of the proof that asks git anything at all.
  const here = join(SCOPE, 'ws-here');
  mkdirSync(here, { recursive: true });

  const r = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_here')], terminals: [terminal('term_ctx_here', { worktreePath: here })] },
    execOptions: { answers: { 'git rev-parse': { status: 128, stdout: '', stderr: 'fatal: detected dubious ownership\n' } } },
  });

  assert.match(r.out, /git refused — fatal: detected dubious ownership/);
  assert.match(r.out, /0 closeable/);
});

// ── liveness is movement ────────────────────────────────────────────────────

test('a landed session whose pane is still moving is BUSY, not closeable', () => {
  const dir = store();
  record(dir, 'triage-8', 'ctx_busy');

  const r = run(['--all'], {
    dir,
    orca: {
      workers: [worker('ctx_busy')],
      terminals: [terminal('term_ctx_busy')],
      cursors: { term_ctx_busy: [10, 42] },
    },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T11:00:00.000Z' }] }), stderr: '' } } },
  });

  assert.match(r.out, /BUSY/);
  assert.match(r.out, /still moving/);
  assert.match(r.out, /0 closeable/);
});

test('--no-proof bypasses the artifact, never the movement check', () => {
  const moving = run(['--close', '--dispatch', 'ctx_np', '--no-proof'], {
    orca: { workers: [worker('ctx_np')], terminals: [terminal('term_ctx_np')], cursors: { term_ctx_np: [1, 2] } },
  });
  assert.match(moving.out, /BUSY/);
  assert.ok(moving.calls.every(argv => !argv.includes('worker-release')), 'a moving pane is never closed, proof or no proof');

  const quiet = run(['--close', '--dispatch', 'ctx_np', '--no-proof'], {
    orca: { workers: [worker('ctx_np')], terminals: [terminal('term_ctx_np')], cursors: { term_ctx_np: [7, 7] } },
  });
  assert.equal(quiet.code, 0);
  assert.match(quiet.out, /released · closed_agent_terminal · archive=captured/, 'the receipt names the state, the process action and the archive');
});

test('an idempotent repeat is reported as what it is, not as work done', () => {
  // Measured live 2026-08-22 on an already-released dispatch: exit 0,
  // `state: already_released`, `processAction: none`, `archive.status: captured`.
  // 36 calls of exactly this shape were once issued in one campaign — churn
  // that reads like work unless the line says "nothing was open".
  const repeat = {
    status: 0,
    stdout: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_again', state: 'already_released', processAction: 'none', archive: { status: 'captured' } } }),
    stderr: '',
  };
  const r = run(['--close', '--dispatch', 'ctx_again', '--no-proof'], {
    orca: { workers: [worker('ctx_again')], terminals: [terminal('term_ctx_again')], releaseReceipts: { ctx_again: repeat } },
  });

  assert.equal(r.code, 0);
  assert.match(r.out, /already_released · none · archive=captured/);
  assert.match(r.out, /\(nothing was open\)/);
});

test('--no-proof is refused for a batch: an operator looks at one pane, not eighty', () => {
  const r = run(['--all', '--close', '--no-proof'], { orca: { workers: THREE_CAUSES } });

  assert.equal(r.code, 2);
  assert.match(r.out, /--no-proof only applies to a single --dispatch/);
});

test('a pane that cannot be read is never judged closed', () => {
  const dir = store();
  record(dir, 'triage-9', 'ctx_unread');

  const { runner } = fakeOrca({ workers: [worker('ctx_unread')], terminals: [terminal('term_ctx_unread')] });
  const blind = args => (args[0] === 'terminal' && args[1] === 'read' ? { status: 1, stdout: '', stderr: 'read failed', receipt: {} } : runner(args));
  const { exec } = fakeExec({ answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T11:00:00.000Z' }] }), stderr: '' } } });

  const r = capture(() => release(['--all', '--store', dir, '--gap', '0'], { runner: blind, exec, env: { HOME: dir }, cwd: SCOPE, sleep: () => {} }));

  assert.match(r.out, /KEEP/);
  assert.match(r.out, /cannot be established/);
  assert.match(r.out, /0 closeable/);
});

// ── F-048: the pane worker-list does not account for ────────────────────────

test('a live pane recorded here but absent from worker-list is offered, not ignored', () => {
  // F-048: a `--inject` repair produces a Dispatch without touching worker
  // terminal accounting, so the sweep that would clear it never sees it.
  const dir = store();
  record(dir, 'triage-11', 'ctx_injected');

  const r = run(['--all', '--close'], {
    dir,
    orca: {
      workers: [],
      terminals: [terminal('term_ctx_injected')],
      cursors: { term_ctx_injected: [3, 3] },
    },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T11:00:00.000Z' }] }), stderr: '' } } },
  });

  assert.match(r.out, /absent from worker-list \(F-048\)/);
  assert.match(r.out, /closed_agent_terminal/);
  assert.equal(r.code, 0);
});

// ── scope ───────────────────────────────────────────────────────────────────

// The scope predicate is SAME-REPOSITORY, never same-path (#83). Measured
// 2026-09-02 on the first pane this repository ever had to release: PR #79
// merged, worker `succeeded/reclaimable`, pane alive — and
// `ax worker release --close` answered `0 closeable · 0 kept` over 92 tallied
// rows with the live merged one in none of its buckets. ax places every child
// under Orca's workspace root, outside the checkout by construction, and the
// row was `continue`d before any tally. The `--dispatch` route printed the same
// fact honestly (`outside <checkout>`), which is how it was found.

/** Orca's workspace root: a linked worktree of this repository, outside the checkout. */
const PLACED = realpathSync(mkdtempSync(join(tmpdir(), 'ax-orca-workspaces-')));

test('a worktree Orca placed outside the checkout is offered when its record names this repository', () => {
  const dir = store();
  record(dir, '83-env-sweep', 'ctx_placed');

  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_placed')],
      terminals: [terminal('term_ctx_placed', { worktreePath: `${PLACED}/83-env-sweep` })],
      cursors: { term_ctx_placed: [7, 7] },
    },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 79, headRefName: 'feat/83-env-sweep' }]), stderr: '' } } },
  });

  assert.match(r.out, /ctx_placed.*CLOSE.*PR #79 merged/);
  assert.match(r.out, /1 closeable/);
  assert.ok(r.calls.some(argv => argv.includes('worker-release')), 'the live merged pane is the one this verb exists to close');
});

test('a row whose record names another repository is counted, named, and never judged', () => {
  const dir = store();
  record(dir, 'shared-slug', 'ctx_theirs', { repo: 'goodluckagency/ofmchat' });

  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_theirs')],
      // Inside this checkout's path, and still another repository's row: path
      // containment never substitutes for the key.
      terminals: [terminal('term_ctx_theirs', { worktreePath: `${SCOPE}/shared-slug` })],
      cursors: { term_ctx_theirs: [3, 3] },
    },
    // A merged PR that WOULD prove the slug in this repository. Asking owner/repo
    // about ofmchat's branch is how a same-named merge closes a live session.
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 12, headRefName: 'shared-slug' }]), stderr: '' } } },
  });

  assert.match(r.out, /1 in another repository/);
  assert.doesNotMatch(r.out, /ctx_theirs/, 'a row this run may not judge is counted once, never printed as a verdict');
  assert.match(r.out, /0 closeable/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
});

test('a record that names no repository is unknown — its own bucket, and never ours by containment', () => {
  const dir = store();
  record(dir, 'legacy-slug', 'ctx_legacy', { repo: '' });

  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_legacy')],
      terminals: [terminal('term_ctx_legacy', { worktreePath: `${SCOPE}/legacy-slug` })],
      cursors: { term_ctx_legacy: [3, 3] },
    },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 12, headRefName: 'legacy-slug' }]), stderr: '' } } },
  });

  assert.match(r.out, /1 no repository on record/);
  assert.match(r.out, /0 in another repository/, 'unknown is not foreign, and never counted as one');
  assert.match(r.out, /0 closeable/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
});

test('every row is in exactly one place: two declined buckets beside one printed candidate', () => {
  const dir = store();
  record(dir, 'ours-slug', 'ctx_ours');
  record(dir, 'their-slug', 'ctx_theirs', { repo: 'goodluckagency/ofmchat' });
  record(dir, 'old-slug', 'ctx_legacy', { repo: '' });

  const r = run([], {
    dir,
    orca: {
      workers: [worker('ctx_ours'), worker('ctx_theirs'), worker('ctx_legacy')],
      terminals: [
        terminal('term_ctx_ours', { worktreePath: `${PLACED}/ours-slug` }),
        terminal('term_ctx_theirs', { worktreePath: `${PLACED}/their-slug` }),
        terminal('term_ctx_legacy', { worktreePath: `${PLACED}/old-slug` }),
      ],
    },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([]), stderr: '' } } },
  });

  assert.match(r.out, /ctx_ours.*KEEP.*no merged PR/);
  assert.match(r.out, /1 in another repository/);
  assert.match(r.out, /1 no repository on record/);
  assert.equal(r.out.split('\n').filter(line => /ctx_theirs|ctx_legacy/.test(line)).length, 0);
});

test('--dispatch over a row this run cannot place keeps its KEEP and the cd that can', () => {
  const dir = store();
  record(dir, 'their-slug', 'ctx_theirs', { repo: 'goodluckagency/ofmchat' });
  const foreign = run(['--dispatch', 'ctx_theirs', '--close'], {
    dir,
    orca: {
      workers: [worker('ctx_theirs')],
      terminals: [terminal('term_ctx_theirs', { worktreePath: `${PLACED}/their-slug` })],
    },
  });

  assert.match(foreign.out, /ctx_theirs.*KEEP.*goodluckagency\/ofmchat/);
  assert.match(foreign.out, new RegExp(`cd ${PLACED}/their-slug && ax worker release --close --dispatch ctx_theirs`));
  assert.doesNotMatch(foreign.out, /outside/, 'the reason is a repository mismatch, never a path relation');
  assert.ok(foreign.calls.every(argv => !argv.includes('worker-release')));

  const legacyDir = store();
  record(legacyDir, 'old-slug', 'ctx_legacy', { repo: '' });
  const unknown = run(['--dispatch', 'ctx_legacy', '--close'], {
    dir: legacyDir,
    orca: {
      workers: [worker('ctx_legacy')],
      terminals: [terminal('term_ctx_legacy', { worktreePath: `${PLACED}/old-slug` })],
    },
  });

  assert.match(unknown.out, /ctx_legacy.*KEEP.*names no repository/);
  assert.match(unknown.out, /old-slug\.json/, 'the repair names the record that cannot place it');
  // A repair has to be able to CHANGE the outcome (validated review finding on
  // #118): reading the record again still computes `unknown`, so the row would
  // refuse forever. What closes it is the route that asks no artifact question.
  assert.match(unknown.out, /worker-read --dispatch ctx_legacy/);
  assert.match(unknown.out, /ax worker release --close --dispatch ctx_legacy --no-proof/);
  assert.ok(unknown.calls.every(argv => !argv.includes('worker-release')));
});

test('--all shows this repository\u2019s archaeology and never another repository\u2019s panes', () => {
  const dir = store();
  record(dir, 'ours-gone', 'ctx_ours_gone');
  record(dir, 'their-gone', 'ctx_their_gone', { repo: 'goodluckagency/ofmchat' });
  record(dir, 'old-gone', 'ctx_legacy_gone', { repo: '' });
  const orca = {
    workers: [
      worker('ctx_ours_gone', { terminalState: 'released' }),
      worker('ctx_their_gone', { terminalState: 'released' }),
      worker('ctx_legacy_gone', { terminalState: 'released' }),
    ],
    terminals: [],
  };

  // A row PROVEN to belong elsewhere leaves before any pane-state tally: its
  // release is not this checkout's archaeology, and `--all` never lists it. A
  // record naming NO repository is not proven foreign (F-028), so the cause this
  // run can establish without any repository is still counted — and the receipt
  // says how much of its own tally nothing places.
  const swept = run([], { dir, orca });
  assert.match(swept.out, /2 already released/);
  assert.match(swept.out, /1 in another repository/);
  assert.match(swept.out, /no repository on record: 0 declined at placement · 1 of the buckets above/);
  assert.doesNotMatch(swept.out, /ctx_ours_gone/);

  // The flag changes what is SHOWN, never what was established (#82's reading
  // for `ax worker ls --all`): the counts are the same on both routes.
  const all = run(['--all'], { dir, orca });
  assert.match(all.out, /2 already released/);
  assert.match(all.out, /1 in another repository/);
  assert.match(all.out, /ctx_ours_gone.*already released/);
  assert.doesNotMatch(all.out, /ctx_their_gone/, '--all is this repository\u2019s archaeology, never a machine-wide sweep');
  assert.doesNotMatch(all.out, /ctx_legacy_gone/, 'a row nothing places is disclosed as a count, never listed as ours');
});

test('a run that cannot name its repository refuses rather than sweeping, and --all is no escape', () => {
  const { runner } = fakeOrca({ workers: THREE_CAUSES });
  const exec = (bin, args) => (bin === 'git' && args.includes('--show-toplevel') ? { status: 128, stdout: '', stderr: 'not a git repository' } : { status: 1, stdout: '', stderr: '' });

  for (const argv of [[], ['--all']]) {
    const r = capture(() => release(argv, { runner, exec, env: {}, cwd: '/tmp', sleep: () => {} }));
    assert.equal(r.code, 3, JSON.stringify(argv));
    assert.match(r.out, /no repository/);
    assert.doesNotMatch(r.out, /every repo on this machine/, 'no surface offers a sweep the predicate no longer implements');
  }
});

test('a dispatch nothing knows about cannot be established', () => {
  const r = run(['--dispatch', 'ctx_ghost', '--close'], { orca: { workers: THREE_CAUSES } });

  assert.equal(r.code, 3);
  assert.match(r.out, /no worker and no local record names dispatch ctx_ghost/);
});

// ── the write-ahead protocol of the close itself ────────────────────────────

test('a close is recorded BEFORE it is issued, in its own namespace', () => {
  const dir = store();
  const r = run(['--close', '--dispatch', 'ctx_wa', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_wa')], terminals: [terminal('term_ctx_wa')] },
  });

  assert.equal(r.code, 0);
  const path = join(dir, 'release', 'ctx_wa.json');
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const phase = rec.attempts[0].phases[0];
  assert.equal(phase.name, 'worker-release');
  // The argv on disk IS the request Orca deduplicates on: identity included.
  assert.deepEqual(phase.argv.slice(1, 5), ['orchestration', 'worker-release', '--dispatch', 'ctx_wa']);
  assert.equal(phase.argv[5], '--retry-request');
  assert.equal(phase.argv[6], phase.identity);
  assert.match(phase.identity, /^[0-9a-f-]{36}$/);
  // The reader verbs enumerate `<store>/*.json`; a release must not appear there
  // as a dispatch that never started.
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')), []);
});

test('a settled release settles the dispatch record — the frontier must see the attempt END', () => {
  // Measured in review (validated finding): `settled: true` was written only by
  // attemptNew, so a released-unmerged dispatch stayed `already-dispatched` in
  // the frontier forever and `attempt-ended-unmerged` was unreachable. The
  // release IS the settlement gesture: work proven landed or explicitly closed.
  const dir = store();
  record(dir, '77-work', 'ctx_settle');
  const r = run(['--close', '--dispatch', 'ctx_settle', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_settle')], terminals: [terminal('term_ctx_settle')] },
  });
  assert.equal(r.code, 0);
  const rec = JSON.parse(readFileSync(join(dir, '77-work.json'), 'utf8'));
  assert.equal(rec.attempts[rec.attempts.length - 1].settled, true, 'the released dispatch attempt is settled');
});

test('a second close replays the recorded request and never mints a second identity', () => {
  const dir = store();
  const first = run(['--close', '--dispatch', 'ctx_twice', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_twice')], terminals: [terminal('term_ctx_twice')] },
  });
  assert.equal(first.code, 0);
  const identity = JSON.parse(readFileSync(join(dir, 'release', 'ctx_twice.json'), 'utf8')).attempts[0].phases[0].identity;

  const again = run(['--close', '--dispatch', 'ctx_twice', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_twice')], terminals: [terminal('term_ctx_twice')] },
  });

  assert.equal(again.code, 0);
  assert.match(again.out, /already released — this host recorded it/);
  assert.ok(again.calls.every(argv => !argv.includes('worker-release')), 'a concluded record is the answer, not a second mutation');
  assert.equal(JSON.parse(readFileSync(join(dir, 'release', 'ctx_twice.json'), 'utf8')).attempts[0].phases[0].identity, identity);
});

test('a recorded release_unknown is replayed, never reported as already released', () => {
  // Orca's own contract: retained, release_pending and already_released all exit
  // 0, and only `release_unknown` exits 1 — with a perfectly legible receipt. A
  // verdict read without its exit code would call that a success.
  const dir = store();
  const unknown = {
    status: 1,
    stdout: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_ru', state: 'release_unknown', processAction: 'none' } }),
    stderr: '',
  };
  const first = run(['--close', '--dispatch', 'ctx_ru', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_ru')], terminals: [terminal('term_ctx_ru')], releaseReceipts: { ctx_ru: unknown } },
  });

  assert.equal(first.code, 1);
  assert.match(first.out, /cannot account for this release/);
  const recorded = JSON.parse(readFileSync(join(dir, 'release', 'ctx_ru.json'), 'utf8')).attempts[0].phases[0].argv;

  const again = run(['--close', '--dispatch', 'ctx_ru', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_ru')], terminals: [terminal('term_ctx_ru')] },
  });

  assert.equal(again.code, 0);
  // Byte for byte: the replay is the RECORDED argv, never a recomposed one and
  // never a fresh identity — that is the whole of F-001.
  const replayed = again.calls.find(argv => argv.includes('worker-release'));
  assert.equal(replayed, recorded.slice(1).join(' '), 'the replay is the recorded request');
  assert.match(again.out, /closed_agent_terminal/);
});

test('--help is not this verb’s to answer, and asking it mutates nothing', () => {
  // The bash verb carried a long `--help` and the port kept it, which made two
  // code paths answer one question — the shape that had twenty subverbs
  // answering it five different ways, three of them by RUNNING (#93). `runCli`
  // answers it from the registry now, anywhere in the noun's argv, before this
  // verb is reached (#89, ../src/cli.mjs), and the rules that decide a close
  // live in this module's header. Reaching the function with the flag is
  // therefore an unknown argument — and, still, nothing asked and nothing done.
  const { runner, calls } = fakeOrca({ workers: THREE_CAUSES });

  const { exec, calls: shell } = fakeExec();
  const r = capture(() => release(['--help'], { runner, exec, env: {}, cwd: SCOPE, sleep: () => {} }));

  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument "--help"/);
  assert.match(r.out, /--no-proof/, 'the usage line still names the flags it takes');
  assert.deepEqual(calls, [], 'a refused argv asked the runtime something');
  assert.deepEqual(shell, [], 'a refused argv asked git and gh something');
});

test('a claimed release with nothing recorded yet belongs to its owner', () => {
  // The window between `claimRecord` and the write-ahead: another caller may be
  // inside it right now. Fail closed — never a re-mint, never a fresh identity,
  // and never a second mutation on somebody else's request.
  const dir = store();
  mkdirSync(join(dir, 'release'), { recursive: true });
  writeFileSync(join(dir, 'release', 'ctx_claimed.json'), '');

  const r = run(['--close', '--dispatch', 'ctx_claimed', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_claimed')], terminals: [terminal('term_ctx_claimed')] },
  });

  assert.equal(r.code, 1);
  assert.match(r.out, /another caller owns this release/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')), 'a request nobody has written is never issued');
});

test('the record exists, with this exact request, BEFORE Orca is called', () => {
  // Reading the record after the fact cannot tell a write-ahead from a
  // write-behind. So the assertion happens INSIDE the call: at the moment the
  // mutation is issued, the request that authorises it is already on disk.
  const dir = store();
  let recordedAtCallTime = null;
  const { runner } = fakeOrca({
    workers: [worker('ctx_wa2')],
    terminals: [terminal('term_ctx_wa2')],
    onRelease: () => {
      recordedAtCallTime = JSON.parse(readFileSync(join(dir, 'release', 'ctx_wa2.json'), 'utf8')).attempts[0].phases[0];
    },
  });
  const { exec } = fakeExec();
  const r = capture(() =>
    release(['--close', '--dispatch', 'ctx_wa2', '--no-proof', '--store', dir, '--gap', '0'], { runner, exec, env: {}, cwd: SCOPE, sleep: () => {} }),
  );

  assert.equal(r.code, 0);
  assert.equal(recordedAtCallTime.name, 'worker-release');
  assert.equal(recordedAtCallTime.argv[6], recordedAtCallTime.identity, 'the retry identity was on disk before it was used');
  assert.equal(recordedAtCallTime.exit, null, 'the phase was still open when the mutation went out');
});

test('a release record that does not describe this release is never replayed', () => {
  // The record is replayed byte for byte AND its first element is the program
  // that runs. An unbound record is therefore an arbitrary command against an
  // arbitrary dispatch, so the binding is proved before the replay.
  const forge = (name, phase) => {
    const dir = store();
    mkdirSync(join(dir, 'release'), { recursive: true });
    writeFileSync(
      join(dir, 'release', 'ctx_safe.json'),
      JSON.stringify({ request: name, host: 'test', orca: 'stub-orca', createdAt: '2026-08-20T10:00:00.000Z', attempts: [{ n: 1, settled: false, phases: [phase] }] }),
    );
    return run(['--close', '--dispatch', 'ctx_safe', '--no-proof'], {
      dir,
      orca: { workers: [worker('ctx_safe')], terminals: [terminal('term_ctx_safe')] },
    });
  };
  const open = (argv, extra = {}) => ({ name: 'worker-release', identity: 'id-1', argv, receipt: null, exit: null, ...extra });

  // Someone else's dispatch in the argv of a record named for ours.
  const victim = forge('release-ctx_safe', open(['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_victim', '--retry-request', 'id-1', '--json']));
  assert.equal(victim.code, 1);
  assert.match(victim.out, /its argv releases "ctx_victim"/);
  assert.ok(victim.calls.every(argv => !argv.includes('worker-release')), 'an unbound record issues nothing');

  // An arbitrary program as the thing to run.
  const program = forge('release-ctx_safe', open(['/bin/sh', 'orchestration', 'worker-release', '--dispatch', 'ctx_safe', '--retry-request', 'id-1', '--json']));
  assert.equal(program.code, 1);
  assert.match(program.out, /which is not an Orca CLI/);

  // A retry identity that is not the one recorded beside it.
  const identity = forge('release-ctx_safe', open(['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_safe', '--retry-request', 'id-other', '--json']));
  assert.equal(identity.code, 1);
  assert.match(identity.out, /retry identity is not the one recorded beside it/);

  // A record about another release entirely.
  const foreign = forge('release-ctx_other', open(['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_safe', '--retry-request', 'id-1', '--json']));
  assert.equal(foreign.code, 1);
  assert.match(foreign.out, /it is the record of "release-ctx_other"/);
});

test('a receipt that names another dispatch does not settle this one', () => {
  const dir = store();
  const elsewhere = {
    status: 0,
    stdout: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_elsewhere', state: 'released', processAction: 'closed_agent_terminal' } }),
    stderr: '',
  };
  const r = run(['--close', '--dispatch', 'ctx_named', '--no-proof'], {
    dir,
    orca: { workers: [worker('ctx_named')], terminals: [terminal('term_ctx_named')], releaseReceipts: { ctx_named: elsewhere } },
  });

  assert.equal(r.code, 1);
  assert.match(r.out, /the receipt names dispatch "ctx_elsewhere", not this one/);
});

test('two equal malformed cursors are not a quiet pane', () => {
  // A string, a boolean or an object is not a cursor. Two equal ones would read
  // as "this pane did not move", which is how a working session gets closed.
  const dir = store();
  record(dir, 'triage-14', 'ctx_bad');
  const r = run(['--all', '--close'], {
    dir,
    orca: {
      workers: [worker('ctx_bad')],
      terminals: [terminal('term_ctx_bad')],
      cursors: { term_ctx_bad: ['seven', 'seven'] },
    },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T09:00:00.000Z' }] }), stderr: '' } } },
  });

  assert.match(r.out, /KEEP/);
  assert.match(r.out, /cannot be established/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
});

test('one slug, two repositories: the record decides which row is proven, not the path', () => {
  // Two checkouts, one slug: this repository has the merged PR, and a live pane
  // of ANOTHER repository carries the same branch name. Asking owner/repo about
  // ofmchat's branch is how a same-named merge closes a live session — and the
  // discriminator is the record's `repo`, because both worktrees sit outside
  // this checkout (Orca placement) and a path could no longer tell them apart.
  const dir = store();
  record(dir, 'shared-slug', 'ctx_ours');
  record(dir, 'shared-slug-2', 'ctx_far', { repo: 'goodluckagency/ofmchat' });
  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_ours'), worker('ctx_far')],
      terminals: [
        terminal('term_ctx_ours', { worktreePath: `${SCOPE}-other/shared-slug` }),
        terminal('term_ctx_far', { worktreePath: `${SCOPE}-other/shared-slug-2` }),
      ],
      cursors: { term_ctx_ours: [2, 2], term_ctx_far: [2, 2] },
    },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 12, headRefName: 'shared-slug' }]), stderr: '' } } },
  });

  assert.match(r.out, /ctx_ours.*CLOSE.*PR #12 merged/);
  assert.match(r.out, /1 in another repository/);
  assert.match(r.out, /1 closeable/);
  assert.equal(r.calls.filter(argv => argv.includes('worker-release')).length, 1);
  assert.ok(r.calls.every(argv => !argv.includes('ctx_far')));
});

test('a worktree carrying any uncommitted change is KEPT, and no path is allowlisted inside the proof', () => {
  // #83's second defect was the tool's OWN `.env.local` reading as work. The
  // repair is the ignore `ax init` writes, never an allowlist here: a proof that
  // skips one path is how a hand-edited file with real work in it stops
  // blocking a close.
  const dir = store();
  record(dir, 'ws-dirty', 'ctx_dirty');
  const here = join(SCOPE, 'ws-dirty');
  mkdirSync(here, { recursive: true });

  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_dirty')],
      terminals: [terminal('term_ctx_dirty', { worktreePath: here })],
      cursors: { term_ctx_dirty: [4, 4] },
    },
    execOptions: {
      answers: {
        'git rev-parse': { status: 0, stdout: 'feat/83-env-sweep\n', stderr: '' },
        'git status': { status: 0, stdout: '?? .env.local\n', stderr: '' },
      },
    },
  });

  assert.match(r.out, /ctx_dirty.*KEEP.*uncommitted changes on feat\/83-env-sweep/);
  assert.match(r.out, /0 closeable/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
});

test('a KEEP whose only dirt is what ax provisions names those paths and `ax init`', () => {
  // The row #147 was filed for. The verdict does not move — #83 ruled there is
  // no allowlist inside the landing proof — but the SENTENCE now says which
  // paths made the tree dirty and which verb stops them from making it dirty
  // again: `plan.ignore` names them, and their presence in `git status
  // --porcelain` is the proof this checkout does not ignore them yet.
  const dir = store();
  record(dir, 'ws-provisioned', 'ctx_prov');
  const here = join(SCOPE, 'ws-provisioned');
  mkdirSync(here, { recursive: true });

  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_prov')],
      terminals: [terminal('term_ctx_prov', { worktreePath: here })],
      cursors: { term_ctx_prov: [4, 4] },
    },
    execOptions: {
      answers: {
        'git rev-parse': { status: 0, stdout: 'feat/135-provisioned\n', stderr: '' },
        'git status': { status: 0, stdout: '?? .env.local\n?? .agent/\n', stderr: '' },
      },
    },
  });

  assert.match(r.out, /ctx_prov.*KEEP.*uncommitted changes on feat\/135-provisioned/);
  assert.match(r.out, /\.env\.local/, 'the row lists the paths it is talking about');
  assert.match(r.out, /\.agent\//);
  assert.match(r.out, new RegExp(`→ cd ${SCOPE} && ax init`), 'the repair is `ax init` on this checkout');
  assert.match(r.out, /0 closeable/, 'the verdict does not move: a dirty tree stays KEEP');
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
});

test('a KEEP carrying any other dirt names the status call and the commit-or-stash it implies', () => {
  // A modified tracked file and an untracked path the plan does not name: this
  // is work the merge gate never saw, so the repair is the operator's own read
  // of the tree — never `ax init`, which would name a repair that changes
  // nothing here.
  const dir = store();
  record(dir, 'ws-real-work', 'ctx_work');
  const here = join(SCOPE, 'ws-real-work');
  mkdirSync(here, { recursive: true });

  const r = run(['--close'], {
    dir,
    orca: {
      workers: [worker('ctx_work')],
      terminals: [terminal('term_ctx_work', { worktreePath: here })],
      cursors: { term_ctx_work: [4, 4] },
    },
    execOptions: {
      answers: {
        'git rev-parse': { status: 0, stdout: 'feat/real-work\n', stderr: '' },
        'git status': { status: 0, stdout: ' M src/worker/release.mjs\n?? notes.md\n', stderr: '' },
      },
    },
  });

  assert.match(r.out, /ctx_work.*KEEP.*uncommitted changes on feat\/real-work/);
  assert.match(r.out, new RegExp(`→ git -C ${here} status --porcelain`));
  assert.match(r.out, /commit|stash/, 'the row says what a merged PR with local dirt means');
  assert.doesNotMatch(r.out, /ax init/, 'nothing ax provisions is dirty here');
  assert.match(r.out, /0 closeable/);
});

/**
 * Every KEEP row a report printed, paired with the line under it. `fix()`
 * writes `      → <command>` directly beneath the row it repairs, so the
 * pairing is positional.
 *
 * A row is matched by its SHAPE (`· KEEP ·`, written by `note`), never by the
 * word anywhere on the line: a repair is free to say what the verdict is — "the
 * verdict stays KEEP until this tree is clean" — and matching that made this
 * pin demand a repair for a repair.
 */
const keepRows = out => {
  const lines = out.split('\n');
  return lines.flatMap((line, i) => (/· KEEP ·/.test(line) ? [{ row: line, next: lines[i + 1] ?? '' }] : []));
};

/** A worktree that still exists, under the scope every fixture shares. */
const tree = slug => {
  const here = join(SCOPE, slug);
  mkdirSync(here, { recursive: true });
  return here;
};

/**
 * One implementation row whose worktree is still there, its branch named after
 * the fixture. `answers` overrides the two calls every such proof makes first.
 */
const kept = (slug, answers, { exists = true } = {}) => () => {
  const dir = store();
  record(dir, `ws-${slug}`, `ctx_${slug}`);
  const here = exists ? tree(`ws-${slug}`) : join(SCOPE, `ws-${slug}-gone`);
  return run(['--all'], {
    dir,
    orca: {
      workers: [worker(`ctx_${slug}`)],
      terminals: [terminal(`term_ctx_${slug}`, { worktreePath: here })],
      cursors: { [`term_ctx_${slug}`]: [4, 4] },
    },
    execOptions: {
      answers: {
        'git rev-parse': { status: 0, stdout: `feat/${slug}\n`, stderr: '' },
        'git status': { status: 0, stdout: '', stderr: '' },
        ...answers,
      },
    },
  });
};

/** A triage row, proven by a comment and nothing else. */
const keptTriage = (slug, answers, recordOptions = {}) => () => {
  const dir = store();
  record(dir, `triage-${slug}`, `ctx_t${slug}`, recordOptions);
  return run(['--all'], {
    dir,
    orca: {
      workers: [worker(`ctx_t${slug}`)],
      terminals: [terminal(`term_ctx_t${slug}`)],
      cursors: { [`term_ctx_t${slug}`]: [4, 4] },
    },
    execOptions: { answers },
  });
};

const prList = rows => ({ status: 0, stdout: JSON.stringify(rows), stderr: '' });

/**
 * One fixture per KEEP reason this verb can print, so the pin below is over the
 * REASONS and not over one report. A new `missing()` in the proof arrives with
 * a fixture here and a repair beside it, or this table fails.
 */
const KEEP_FIXTURES = [
  ['dirt ax provisions', kept('provisioned-2', { 'git status': { status: 0, stdout: '?? .env.local\n', stderr: '' } })],
  ['dirt that is work', kept('own-work', { 'git status': { status: 0, stdout: ' M src/a.mjs\n', stderr: '' } })],
  ['git refused the branch', kept('no-branch', { 'git rev-parse': { status: 128, stdout: '', stderr: 'fatal: not a git repository\n' } })],
  ['git refused the status', kept('no-status', { 'git status': { status: 128, stdout: '', stderr: 'fatal: bad object\n' } })],
  ['an open PR', kept('open-pr', { 'gh pr list': prList([{ number: 9, state: 'OPEN', headRefName: 'feat/open-pr' }]) })],
  ['a PR closed unmerged', kept('closed-pr', { 'gh pr list': prList([{ number: 4, state: 'CLOSED', headRefName: 'feat/closed-pr' }]) })],
  ['a PR in some other state', kept('odd-pr', { 'gh pr list': prList([{ number: 5, state: 'DRAFT', headRefName: 'feat/odd-pr' }]) })],
  [
    'two PRs claiming one head',
    kept('twin-pr', {
      'gh pr list': prList([
        { number: 6, state: 'MERGED', headRefName: 'feat/twin-pr' },
        { number: 7, state: 'OPEN', headRefName: 'feat/twin-pr' },
      ]),
    }),
  ],
  ['gh refusing the PR query', kept('flaky-gh', { 'gh pr list': { status: 1, stdout: '', stderr: 'API rate limit exceeded\n' } })],
  ['an unreadable PR list', kept('junk-gh', { 'gh pr list': { status: 0, stdout: '{}', stderr: '' } })],
  ['commits and no PR', kept('unshipped', { 'gh pr list': prList([]), 'git rev-list': { status: 0, stdout: '3\n', stderr: '' } })],
  ['a branch carrying nothing', kept('untouched', { 'gh pr list': prList([]), 'git rev-list': { status: 0, stdout: '0\n', stderr: '' } })],
  ['git refusing the commit count', kept('no-count', { 'gh pr list': prList([]), 'git rev-list': { status: 128, stdout: '', stderr: 'fatal: bad revision\n' } })],
  ['a worktree already gone, nothing merged', kept('vanished', { 'gh pr list': prList([]) }, { exists: false })],
  [
    'a worktree already gone, an ambiguous slug',
    kept(
      'vanished-twice',
      {
        'gh pr list': prList([
          { number: 11, headRefName: 'feat/ws-vanished-twice' },
          { number: 12, headRefName: 'topic/ws-vanished-twice' },
        ]),
      },
      { exists: false },
    ),
  ],
  ['a triage with no comment', keptTriage('20', { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: '' } })],
  [
    'a triage whose newest comment predates it',
    keptTriage('21', { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-19T10:00:00.000Z' }] }), stderr: '' } }),
  ],
  ['a triage this host cannot date', keptTriage('22', {}, { createdAt: 'not-a-date' })],
  ['gh refusing the issue query', keptTriage('23', { 'gh issue view': { status: 1, stdout: '', stderr: 'gh: could not resolve to an Issue\n' } })],
  [
    'a pane nobody can read',
    () => {
      const dir = store();
      record(dir, 'triage-24', 'ctx_blind');
      return run(['--all'], {
        dir,
        orca: { workers: [worker('ctx_blind')], terminals: [terminal('term_ctx_blind')], cursors: { term_ctx_blind: ['seven', 'seven'] } },
        execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T09:00:00.000Z' }] }), stderr: '' } } },
      });
    },
  ],
  [
    'a row this run cannot place',
    () => {
      const dir = store();
      record(dir, 'legacy-slug', 'ctx_nowhere', { repo: '' });
      return run(['--dispatch', 'ctx_nowhere'], {
        dir,
        orca: { workers: [worker('ctx_nowhere')], terminals: [terminal('term_ctx_nowhere')] },
      });
    },
  ],
  [
    'a row belonging to another repository',
    () => {
      const dir = store();
      record(dir, 'their-slug-2', 'ctx_elsewhere', { repo: 'goodluckagency/ofmchat' });
      return run(['--dispatch', 'ctx_elsewhere'], {
        dir,
        orca: { workers: [worker('ctx_elsewhere')], terminals: [terminal('term_ctx_elsewhere')] },
      });
    },
  ],
];

test('no KEEP row prints without the repair that acts on it', () => {
  // The verb's own header: "every category below names itself, carries its own
  // count, and names its repair". The KEEP rows are the only rows an operator
  // can act on, and until #147 they printed a verdict and stopped — measured on
  // the dirty row twice (#79, #135), which is the row a finished child hits.
  // A finding without a repair is a finding nobody can act on (src/log.mjs).
  for (const [reason, fixture] of KEEP_FIXTURES) {
    const r = fixture();
    const rows = keepRows(r.out);
    assert.ok(rows.length > 0, `${reason}: the fixture printed no KEEP row at all\n${r.out}`);
    for (const { row, next } of rows) {
      assert.match(next, /^\s+→ \S/, `${reason}: this KEEP names no repair\n  ${row}\n  ${next}`);
    }
  }
});

test('a PR for another branch is not this branch\u2019s proof', () => {
  const dir = store();
  record(dir, 'ws-mine', 'ctx_head');
  const here = join(SCOPE, 'ws-mine');
  mkdirSync(here, { recursive: true });

  const r = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_head')], terminals: [terminal('term_ctx_head', { worktreePath: here })] },
    execOptions: {
      answers: {
        'git rev-parse': { status: 0, stdout: 'feat/mine\n', stderr: '' },
        'git status': { status: 0, stdout: '', stderr: '' },
        'git rev-list': { status: 0, stdout: '3\n', stderr: '' },
        // A merged first row for a DIFFERENT head, exactly what `--head` filtering
        // is trusted to have excluded.
        'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 7, state: 'MERGED', headRefName: 'feat/other' }]), stderr: '' },
      },
    },
  });

  assert.match(r.out, /KEEP/);
  assert.match(r.out, /3 commit\(s\), no PR/);
  assert.match(r.out, /0 closeable/);
});

test('a gh that cannot answer is ignorance, never "there is no PR"', () => {
  const dir = store();
  record(dir, 'ws-flaky', 'ctx_flaky');
  const here = join(SCOPE, 'ws-flaky');
  mkdirSync(here, { recursive: true });

  const r = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_flaky')], terminals: [terminal('term_ctx_flaky', { worktreePath: here })] },
    execOptions: {
      answers: {
        'git rev-parse': { status: 0, stdout: 'feat/flaky\n', stderr: '' },
        'git status': { status: 0, stdout: '', stderr: '' },
        'git rev-list': { status: 0, stdout: '0\n', stderr: '' },
        'gh pr list': { status: 1, stdout: '', stderr: 'API rate limit exceeded\n' },
      },
    },
  });

  assert.match(r.out, /gh refused — API rate limit exceeded/);
  assert.doesNotMatch(r.out, /no PR/, 'a failed query may never be reported as an absent PR');
});

test('a repository this run cannot name refuses instead of reporting a clean sweep', () => {
  const { runner } = fakeOrca({ workers: [worker('ctx_any')], terminals: [terminal('term_ctx_any')] });
  const exec = (bin, args) => {
    if (bin === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: `${SCOPE}\n`, stderr: '' };
    if (bin === 'gh' && args[0] === 'repo') return { status: 1, stdout: '', stderr: 'gh: not authenticated\n' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const r = capture(() => release(['--all'], { runner, exec, env: {}, cwd: SCOPE, sleep: () => {} }));

  assert.equal(r.code, 3);
  assert.match(r.out, /gh cannot name this repository/);
});

test('a store that cannot be read is not an absence of provenance', () => {
  const dir = store();
  const notADirectory = join(dir, 'file.json');
  writeFileSync(notADirectory, '{}');
  const { runner, calls } = fakeOrca({ workers: [worker('ctx_any')], terminals: [terminal('term_ctx_any')] });
  const { exec } = fakeExec();
  const r = capture(() => release(['--all', '--store', notADirectory, '--gap', '0'], { runner, exec, env: {}, cwd: SCOPE, sleep: () => {} }));

  assert.equal(r.code, 3);
  assert.match(r.out, /cannot be read/);
  assert.ok(calls.every(argv => !argv.startsWith('terminal read')), 'nothing is judged before the store is established');
});

test('two records claiming one dispatch prove nothing', () => {
  // F-001: ambiguity is cannot-establish, never last-file-wins. Two provenances
  // mean two different proof rules, and picking by filename order picks one.
  const dir = store();
  record(dir, 'a-implementation', 'ctx_twin');
  record(dir, 'triage-9', 'ctx_twin');

  const r = run(['--all', '--close'], {
    dir,
    orca: { workers: [worker('ctx_twin')], terminals: [terminal('term_ctx_twin')], cursors: { term_ctx_twin: [1, 1] } },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-21T09:00:00.000Z' }] }), stderr: '' } } },
  });

  assert.match(r.out, /provenance is ambiguous/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
});

test('a comment is dated against the dispatch, not against the claim', () => {
  // A record claimed at 10:00 whose worker-start ran at 11:00: a 10:30 comment
  // is NOT after the dispatch, however comfortably it follows `createdAt`.
  const dir = store();
  record(dir, 'triage-15', 'ctx_late', { createdAt: '2026-08-20T10:00:00.000Z', beganAt: '2026-08-20T11:00:00.000Z' });

  const r = run(['--all'], {
    dir,
    orca: { workers: [worker('ctx_late')], terminals: [terminal('term_ctx_late')] },
    execOptions: { answers: { 'gh issue view': { status: 0, stdout: JSON.stringify({ comments: [{ createdAt: '2026-08-20T10:30:00.000Z' }] }), stderr: '' } } },
  });

  assert.match(r.out, /KEEP.*predates dispatch/);
});

test('this session never offers its own pane', () => {
  const r = run(['--all'], {
    orca: { workers: [worker('ctx_self')], terminals: [terminal('term_ctx_self')] },
    env: { ORCA_TERMINAL_HANDLE: 'term_ctx_self' },
  });

  assert.match(r.out, /pane SELF/);
  assert.match(r.out, /0 closeable/);
});

test('an unreadable inventory refuses; it never reads as an empty machine', () => {
  const { runner } = fakeOrca({ workers: [] });
  const blind = args => (args[0] === 'orchestration' ? { status: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', receipt: { ok: true, result: {} } } : runner(args));
  const { exec } = fakeExec();
  const r = capture(() => release(['--all'], { runner: blind, exec, env: {}, cwd: SCOPE, sleep: () => {} }));

  assert.equal(r.code, 3);
  assert.match(r.out, /an absent container is not an empty machine/);
});

test('unknown arguments are a usage error, not a guess', () => {
  const { runner } = fakeOrca();
  const { exec } = fakeExec();
  const bad = capture(() => release(['--force'], { runner, exec, env: {}, cwd: SCOPE, sleep: () => {} }));

  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown argument "--force"/);
});

test('the default process runner is exercised, not only its stub', () => {
  // Every test above injects `exec`, which once left this default unexercised:
  // the module lost its `spawnSync` import in a refactor, the suite stayed
  // green, and the first real invocation was a ReferenceError.
  //
  // `git --version` and nothing else: the verb's own default path would run
  // `gh repo view`, which is a network call, and this suite stays offline.
  const out = defaultExec('git', ['--version'], process.cwd());
  assert.equal(out.status, 0);
  assert.match(out.stdout, /git version/);
  assert.equal(out.error, undefined);
});
