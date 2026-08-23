/**
 * The checkpoint extension writes to a human-read board column, and it shipped
 * with no test at all. Two of its decisions are measurements, not preferences,
 * and both are one edited line away from being undone in a green suite:
 *
 *   1. A MERGE IS NOT A FINISHED WORKTREE (`statusFromPrState`, the comment at
 *      the `MERGED` guard). Measured 2026-08-03: a worktree merged two PRs from
 *      its own pane, the board pinned it at `completed`, and `status_rank` is
 *      monotonic so nothing could bring it back down while its agent kept
 *      working for hours.
 *   2. A COORDINATOR IS NOT ITS WORKERS. `.omp/commands/epic.md` §5 merges a
 *      worker's PR from the coordinator's checkout, where an argument-less
 *      probe resolves the COORDINATOR's PR instead and moves the wrong board
 *      entry.
 *
 * `statusFromPrState` is driven against a fake `Bun.spawn`, NOT against a stub
 * `gh` on `PATH` the way `agent/scripts/orca-dispatch.test.ts` stubs `orca`.
 * That technique cannot work here, measured on bun 1.3.14: `Bun.spawn` with no
 * explicit `env` resolves argv[0] against the environment snapshot taken when
 * the process started, so a mutated `process.env.PATH` is ignored and the REAL
 * `gh` runs — answering for whatever branch this checkout happens to be on,
 * over the network, with credentials. A PATH stub here does not fail loudly;
 * it passes while testing GitHub. The seam has to be the spawn itself, and one
 * test pins the argv so the fake keeps standing for the real command.
 *
 * Importing the extension module is safe: its module body only resolves a
 * script path and builds a session latch. Nothing spawns until the default
 * export is installed on a `pi`, which these tests never do.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';

import extension, {
  DEBOUNCE_MS,
  explicitPrRef,
  looksLikePrTransition,
  schedule,
  statusFromPrState,
  summarizePhases,
} from './index.ts';
import { axArgv } from '../shared/ax.ts';

// ── the fake `gh` ────────────────────────────────────────────────────────────

const realSpawn = Bun.spawn;

/** Every argv `statusFromPrState` handed to the spawn, in order. */
let calls: string[][] = [];
/** What the next `gh` answers with. `code` is its own branch of the function. */
let reply = { out: '', code: 0 };

beforeEach(() => {
  calls = [];
  reply = { out: '', code: 0 };
  // Restored in `afterEach`, and every test awaits its probe before returning,
  // so no other test file in a `bun test agent/` run ever sees the fake.
  Bun.spawn = ((argv: string[]) => {
    calls.push([...argv]);
    return {
      // `new Response(string)` reads back as that string, which is exactly what
      // the function does with the real piped stdout.
      stdout: reply.out,
      exited: Promise.resolve(reply.code),
      kill() {},
      // `writeCheckpoint` unrefs its spawn; without this the call throws into
      // its catch and latches `writerMissing` for the rest of the file.
      unref() {},
    };
  }) as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = realSpawn;
});

/** The PR the faked `gh pr view` reports for this checkout. */
function pr(fields: Record<string, unknown>): void {
  reply = { out: JSON.stringify(fields), code: 0 };
}

test('the probe asks `gh` for exactly the fields it branches on - this is what keeps the fake standing for the real command', async () => {
  pr({ state: 'OPEN', isDraft: false, number: 7, url: 'https://x/pull/7' });

  await statusFromPrState('gh pr create');

  expect(calls).toEqual([
    ['gh', 'pr', 'view', '--json', 'state,isDraft,number,url'],
  ]);
});

// ── statusFromPrState · a merge is not a finished worktree ───────────────────

test('a merge from this worktree own pane leaves the board where it was - 2026-08-03, a pane pinned at `completed` while its agent kept working for hours', async () => {
  pr({ state: 'MERGED', isDraft: false, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr merge 7 --squash')).toBeUndefined();
});

test('an unnamed `gh pr merge` of this worktree own merged PR moves nothing either - the flag-led form reaches the same guard by a different path', async () => {
  pr({ state: 'MERGED', isDraft: false, number: 7, url: 'https://x/pull/7' });

  // No explicit ref, so the coordinator guard does not fire and the MERGED
  // branch is the only thing standing between this and a wrong `completed`.
  expect(explicitPrRef('gh pr merge --squash')).toBeUndefined();
  expect(await statusFromPrState('gh pr merge --squash')).toBeUndefined();
});

// ── statusFromPrState · the rest of the matrix ───────────────────────────────

test('an open non-draft PR is the one transition this function reports', async () => {
  pr({ state: 'OPEN', isDraft: false, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr create --fill')).toBe('in-review');
});

test('an open DRAFT PR is not in review - nobody has been asked to look at it', async () => {
  pr({ state: 'OPEN', isDraft: true, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr create --draft')).toBeUndefined();
});

test('a PR closed without merging is not a board transition', async () => {
  pr({ state: 'CLOSED', isDraft: false, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr merge 7')).toBeUndefined();
});

test('`gh` exiting non-zero reports nothing rather than guessing - no PR for this branch and no `gh` on PATH are the same answer here', async () => {
  reply = { out: '', code: 1 };

  expect(await statusFromPrState('gh pr create')).toBeUndefined();
});

test('unparseable `gh` output is swallowed - this is observability and must never throw into a tool call', async () => {
  reply = { out: 'not json', code: 0 };

  expect(await statusFromPrState('gh pr create')).toBeUndefined();
});

// ── statusFromPrState · the coordinator is not its workers ───────────────────

test('a coordinator merging a WORKER PR does not touch the coordinator own board entry - epic.md §5 runs that merge from the coordinator checkout', async () => {
  // The argument-less probe answers for the coordinator's own branch, which is
  // open and non-draft: without the named-ref guard this would report
  // `in-review` because a worker somewhere else merged.
  pr({ state: 'OPEN', isDraft: false, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr merge 42 --squash')).toBeUndefined();
});

test('a command naming this worktree own PR by number still counts', async () => {
  pr({ state: 'OPEN', isDraft: false, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr merge 7')).toBe('in-review');
});

test('the `#7` and full-URL spellings of our own PR are the same PR', async () => {
  pr({ state: 'OPEN', isDraft: false, number: 7, url: 'https://x/pull/7' });

  expect(await statusFromPrState('gh pr merge #7')).toBe('in-review');
  expect(await statusFromPrState('gh pr merge https://x/pull/7')).toBe(
    'in-review',
  );
});

// ── explicitPrRef ────────────────────────────────────────────────────────────

test('explicitPrRef reads the PR a command names', () => {
  expect(explicitPrRef('gh pr merge 42 --squash --delete-branch')).toBe('42');
  expect(explicitPrRef('gh pr merge https://x/pull/42')).toBe(
    'https://x/pull/42',
  );
});

test('a flag-led invocation names no PR - `--squash` is an option, not a ref, and treating it as one would compare it against a PR number and silently suppress every transition', () => {
  expect(explicitPrRef('gh pr merge --squash')).toBeUndefined();
  expect(explicitPrRef('gh pr create --fill --base main')).toBeUndefined();
});

test('a command that names no PR at all yields undefined', () => {
  expect(explicitPrRef('gh pr view')).toBeUndefined();
  expect(explicitPrRef('git commit -m wip')).toBeUndefined();
});

// ── looksLikePrTransition ────────────────────────────────────────────────────

test('a create or a merge is worth asking the PR about', () => {
  expect(looksLikePrTransition('gh pr create --fill')).toBe(true);
  expect(looksLikePrTransition('gh pr merge 42 --squash')).toBe(true);
  // Documented as a HINT, deliberately: the command string cannot prove
  // anything ran, so this matching is harmless and the PR itself answers.
  expect(looksLikePrTransition('echo "gh pr create"')).toBe(true);
});

test('`--help` never transitioned anything', () => {
  expect(looksLikePrTransition('gh pr create --help')).toBe(false);
  expect(looksLikePrTransition('gh pr merge --help')).toBe(false);
});

test('near misses do not trigger a probe - each one costs a `gh` process from a tool_result handler', () => {
  expect(looksLikePrTransition('gh pr view 42')).toBe(false);
  expect(looksLikePrTransition('gh pr checkout 42')).toBe(false);
  expect(looksLikePrTransition('gh issue create')).toBe(false);
  expect(looksLikePrTransition('ghpr create')).toBe(false);
});

// ── summarizePhases ──────────────────────────────────────────────────────────

test('nothing to summarize yields no comment rather than an empty one', () => {
  expect(summarizePhases([])).toBeUndefined();
  expect(summarizePhases(undefined)).toBeUndefined();
  expect(summarizePhases(null)).toBeUndefined();
  expect(summarizePhases('4/11')).toBeUndefined();
  // Phases exist but carry no task: the ratio would be `0/0`, which says less
  // than leaving the previous comment in place.
  expect(summarizePhases([{ name: 'Part A', tasks: [] }])).toBeUndefined();
});

test('a single phase names its in-progress task behind the ratio', () => {
  expect(
    summarizePhases([
      {
        name: 'Part B - coherence',
        tasks: [
          { content: 'Read the plan', status: 'completed' },
          { content: 'Fuse the orchestration executables', status: 'in_progress' },
          { content: 'Ship', status: 'pending' },
        ],
      },
    ]),
  ).toBe('1/3 · Part B - coherence · Fuse the orchestration executables');
});

test('the ratio counts every phase, so it does not restart at each one', () => {
  expect(
    summarizePhases([
      {
        name: 'Part A',
        tasks: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'abandoned' },
        ],
      },
      {
        name: 'Part B',
        tasks: [
          { content: 'c', status: 'completed' },
          { content: 'd', status: 'pending' },
        ],
      },
    ]),
    // `abandoned` counts as resolved: it is not work left to do, and excluding
    // it would leave a ratio that can never reach its total.
  ).toBe('3/4 · Part B · d');
});

test('an in-progress task in a LATER phase still wins over an earlier pending one - it is where the work actually is', () => {
  expect(
    summarizePhases([
      { name: 'Part A', tasks: [{ content: 'pending one', status: 'pending' }] },
      {
        name: 'Part B',
        tasks: [{ content: 'active one', status: 'in_progress' }],
      },
    ]),
  ).toBe('0/2 · Part B · active one');
});

test('a blocked task says so, because a stalled session reads as a working one on the board', () => {
  expect(
    summarizePhases([
      { name: 'Part A', tasks: [{ content: 'waiting on review', status: 'blocked' }] },
    ]),
  ).toBe('0/1 · Part A · waiting on review (blocked)');
});

test('everything resolved reads as done', () => {
  expect(
    summarizePhases([
      {
        name: 'Part A',
        tasks: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'abandoned' },
        ],
      },
    ]),
  ).toBe('2/2 · done');
});

test('a contentless task counts in the ratio but is never named - the separator would point at nothing', () => {
  expect(
    summarizePhases([{ name: 'Part A', tasks: [{ status: 'in_progress' }] }]),
  ).toBe('0/1 · Part A');
  expect(summarizePhases([{ tasks: [{ status: 'in_progress' }] }])).toBe('0/1');
});

// ── the debounce, on the HOST's timer ────────────────────────────────────────
//
// The debounce used to run on a raw `setTimeout`. OMP runs extensions
// in-process with no isolation, so a throw in a raw timer callback escapes as
// an unhandled rejection and the postmortem handler exits the session with
// code 1 (measured 2026-08-11, isolated `omp --mode rpc` sandbox). What follows
// pins the coalescing across the conversion; `managed-timers.test.ts` is what
// stops the raw form coming back.

/** A host `ctx` whose timers are a list, so the clock never has to advance. */
function fakeHost() {
  const armed: Array<{ id: number; fn: () => void; ms?: number }> = [];
  const cleared: unknown[] = [];
  let nextId = 1;
  return {
    armed,
    cleared,
    sessionManager: { getSessionId: () => 'session-under-test' },
    setTimeout(fn: () => void, ms?: number) {
      const id = nextId;
      nextId += 1;
      armed.push({ id, fn, ms });
      return id;
    },
    clearTimer(id: unknown) {
      cleared.push(id);
      const at = armed.findIndex((a) => a.id === id);
      if (at >= 0) armed.splice(at, 1);
    },
    /** Run the one armed callback, as the host would at expiry. */
    fire() {
      const next = armed.shift();
      next?.fn();
    },
  };
}

/**
 * The argv `writeCheckpoint` handed the spawn, minus the ax prefix.
 *
 * The prefix is TWO words since the extensions moved into `@flosrn/ax`
 * (`[process.execPath, <pkg>/omp/ax-run.mjs]`) and used to be one resolved
 * binary. Computed from `axArgv()` rather than hard-coded to 2, so a prefix that
 * grows a flag does not silently shift every expectation below by one argument.
 */
function checkpointArgs(): string[][] {
  return calls.map((argv) => argv.slice(axArgv().length));
}

test('the writer is this package own CLI, run by this runtime - never a resolved `ax` on PATH', () => {
  const host = fakeHost();
  schedule({ comment: '1/1 · pin' }, host);
  host.fire();

  // The measured failure this pins: a project install with no global bin link
  // fell through to the bare name, the spawn failed to resolve it, and the
  // caller latched `writerMissing` — checkpoints silently off for the session.
  expect(calls[0]?.[0]).toBe(process.execPath);
  expect(calls[0]?.[1]).toMatch(/omp\/ax-run\.mjs$/);
  expect(calls[0]?.slice(2)).toEqual(['board', '--comment', '1/1 · pin']);
});

test('a burst of todo flips arms ONE managed timer and writes once - three `orca` processes for one edit is what the debounce exists to prevent', () => {
  const host = fakeHost();

  schedule({ comment: '1/3 · a' }, host);
  schedule({ comment: '2/3 · b' }, host);
  schedule({ comment: '3/3 · c' }, host);

  expect(host.armed.length).toBe(1);
  expect(host.cleared.length).toBe(2);
  expect(host.armed[0].ms).toBe(DEBOUNCE_MS);
  expect(calls).toEqual([]);

  host.fire();

  expect(checkpointArgs()).toEqual([['board', '--comment', '3/3 · c']]);
});

test('the accumulated payload merges by field, so a pending comment survives a status arriving behind it', () => {
  const host = fakeHost();

  schedule({ comment: '1/2 · a' }, host);
  schedule({ status: 'in-review' }, host);
  host.fire();

  expect(checkpointArgs()).toEqual([
    ['board', '--comment', '1/2 · a', '--status', 'in-review'],
  ]);
});

test('a host with no managed timer writes immediately rather than reaching for a raw one - losing the debounce costs a process, a raw timer can cost the session', () => {
  schedule({ comment: '1/1 · no host' }, null);

  expect(checkpointArgs()).toEqual([['board', '--comment', '1/1 · no host']]);
});

test('session_shutdown flushes mid-debounce and disarms the timer - that last update is the one saying where the work stopped', () => {
  const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
  const pi = {
    on(name: string, fn: (event: unknown, ctx: unknown) => void) {
      handlers[name] = fn;
    },
  };
  extension(pi);

  const host = fakeHost();
  handlers.session_start?.({}, host);
  handlers.tool_result?.(
    { toolName: 'todo', details: { phases: [{ tasks: [{ status: 'in_progress', content: 'ship' }] }] } },
    host,
  );
  expect(host.armed.length).toBe(1);
  expect(calls).toEqual([]);

  handlers.session_shutdown?.({}, host);

  expect(checkpointArgs()).toEqual([['board', '--comment', '0/1 · ship']]);
  expect(host.armed.length).toBe(0);

  // The armed callback must be dead, not merely unreferenced: firing it again
  // would write the same comment a second time.
  host.fire();
  expect(calls.length).toBe(1);
});
