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
import { defaultExec, release } from '../src/worker/release.mjs';

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
    if (bin === 'gh' && args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: repo }), stderr: '' };
    return answers[key] ?? { status: 1, stdout: '', stderr: `stub has no answer for ${key}\n` };
  };
  return { exec, calls };
}

const store = () => mkdtempSync(join(tmpdir(), 'ax-release-'));

/** A dispatch store record: the provenance a bulk proof needs. */
function record(dir, request, dispatchId, { createdAt = '2026-08-20T10:00:00.000Z', beganAt = null, handle = `term_${dispatchId}`, state = 'ready' } = {}) {
  writeFileSync(
    join(dir, `${request}.json`),
    JSON.stringify({
      request,
      host: 'test',
      orca: 'stub-orca',
      createdAt,
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

test('a live worker is still kept and reported, not swept into a residual count', () => {
  const r = run(['--all'], {
    orca: {
      workers: [...THREE_CAUSES, worker('ctx_live', { workerState: 'ready' })],
      terminals: [terminal('term_ctx_live')],
    },
  });

  assert.match(r.out, /ctx_live/);
  assert.match(r.out, /1 kept/);
  assert.match(r.out, /worker-stop/, 'cancelling a live session is a different decision, and it is named');
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
  const r = run(['--all'], {
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
  assert.match(r.out, /worker-show --dispatch ctx_unknown/);
  assert.doesNotMatch(r.out, /release state unknown/);
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

test('a dispatch this host never recorded has unknown provenance, and unknown is KEEP', () => {
  const r = run(['--all'], {
    orca: { workers: [worker('ctx_orphan')], terminals: [terminal('term_ctx_orphan')] },
  });

  assert.match(r.out, /unknown provenance/);
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

test('a sibling worktree sharing a path prefix is not in scope', () => {
  const r = run([], {
    orca: {
      workers: [worker('ctx_sibling'), worker('ctx_inside')],
      terminals: [
        terminal('term_ctx_sibling', { worktreePath: `${SCOPE}-2/wt` }),
        terminal('term_ctx_inside'),
      ],
    },
  });

  assert.doesNotMatch(r.out, /ctx_sibling/, '/tmp/scope-repo-2 is not inside /tmp/scope-repo');
  assert.match(r.out, /ctx_inside/);
});

test('outside a repository, a machine-wide sweep must be asked for', () => {
  const { runner } = fakeOrca({ workers: THREE_CAUSES });
  const exec = (bin, args) => (bin === 'git' && args.includes('--show-toplevel') ? { status: 128, stdout: '', stderr: 'not a git repository' } : { status: 1, stdout: '', stderr: '' });
  const r = capture(() => release([], { runner, exec, env: {}, cwd: '/tmp', sleep: () => {} }));

  assert.equal(r.code, 3);
  assert.match(r.out, /refusing to sweep machine-wide by accident/);
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

test('--help prints the rules a caller needs and touches nothing', () => {
  // The bash verb carried this text and agents read it; the port keeps the
  // affordance rather than moving the rules into a file only humans open.
  const { runner, calls } = fakeOrca({ workers: THREE_CAUSES });

  const { exec, calls: shell } = fakeExec();
  const r = capture(() => release(['--help'], { runner, exec, env: {}, cwd: SCOPE, sleep: () => {} }));

  assert.equal(r.code, 0);
  assert.match(r.out, /MERGED pull request/);
  assert.match(r.out, /--no-proof/);
  assert.deepEqual(calls, [], 'help asks the runtime nothing');
  assert.deepEqual(shell, [], 'help asks git and gh nothing');
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

test('a pane in another repository is never proven from this one', () => {
  // Two checkouts, one slug: repo A has the merged PR, the live pane belongs to
  // B. Asking A about B's branch is how a same-named merge closes a live session.
  const dir = store();
  record(dir, 'shared-slug', 'ctx_far');
  const r = run(['--all', '--close'], {
    dir,
    orca: {
      workers: [worker('ctx_far')],
      terminals: [terminal('term_ctx_far', { worktreePath: `${SCOPE}-other/shared-slug` })],
      cursors: { term_ctx_far: [2, 2] },
    },
    execOptions: { answers: { 'gh pr list': { status: 0, stdout: JSON.stringify([{ number: 12, headRefName: 'shared-slug' }]), stderr: '' } } },
  });

  assert.match(r.out, /this run can only prove landing in owner\/repo/);
  assert.match(r.out, /0 closeable/);
  assert.ok(r.calls.every(argv => !argv.includes('worker-release')));
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
