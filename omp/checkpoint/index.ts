// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Keeps this worktree's Orca checkpoint fresh, with no agent discipline.
 *
 * WHY AN EXTENSION AND NOT A CONVENTION
 * Seeding a checkpoint at creation (scripts/orca/worktree-setup.sh) is enough
 * for five minutes and lies after an hour. Convention lines were the obvious
 * alternative — and the measurement on 2026-08-02 says they do not work: 0
 * comments across 37 worktrees, with AGENTS.md already in every agent's
 * context. So the update has to be automatic.
 *
 * WHAT IT MIRRORS
 * The todo list is the only progress signal every OMP session already
 * maintains, at exactly the moments progress happens. `tool_result` on the
 * `todo` tool carries `details.phases` (TodoPhase[] — structured, not the
 * rendered summary), so the checkpoint is derived, never re-implemented.
 *
 *   worktreeMeta.comment  ← "4/11 · Part B — coherence · Fuse the orchestration executables"
 *   worktreeMeta.workspaceStatus
 *       ← in-review  when `gh pr create` succeeds, and when a session reports
 *                    that it stopped working (orca-report.ts)
 *       ← completed  NEVER from here. A merge proves a PR landed, not that the
 *                    worktree is done; see statusFromPrState.
 *
 * Status matters because Orca parks every worktree at `in-progress` on first
 * activity (37/37 on this machine), so the column only says anything once
 * something moves it off the default at a real transition.
 *
 * NON-NEGOTIABLE: this is observability. It must never throw into a tool call,
 * never block one, and never slow one down. Every handler is wrapped, every
 * write is a detached fire-and-forget child, and `ax board` exits 0 on every
 * path (missing orca CLI included).
 */

import { createSessionOwner, isSubagentSession } from '../shared/session.ts';
import { boardWrite } from '../shared/board.ts';

// The writer is `ax board` (flosrn/ax) since PORT step 2, 2026-08-21 — the one
// place that reads the current board value in the process that writes it, so
// monotonicity holds across sessions and concurrent writers, behind a
// per-worktree lock. The spawn mechanics live in `../shared/board.ts`, shared
// with the report extension; the give-up latch below stays HERE, because it
// defends this caller's cadence (a doomed spawn retried on every todo flip)
// and must never suppress report's one-shot write.

// WORKTREE_ROOT is gone, and this is the one place where it was actively
// dangerous: it was interpolated straight into `--worktree path:<root>`, so a
// wrong root produced a selector matching no registered worktree and every
// checkpoint write became a silent no-op — the board writer exits 0 on every
// failure by design, so nothing would have surfaced. `ax board` already
// defaults to `--worktree current`, which Orca resolves from the process cwd,
// so the selector is simply not ours to compute.

// Trailing-edge debounce. A todo `init` of eleven tasks is one event, but an
// agent flipping three tasks in a burst should still cost one `orca` process,
// not three. 2.5 s is below human sidebar-glance latency and well above a
// burst.
export const DEBOUNCE_MS = 2500;

interface Checkpoint {
  comment?: string;
  status?: string;
}

/**
 * The slice of the host `ctx` this file uses. `ctx.setTimeout` runs its
 * callback with the same isolation a handler gets, hands back an already
 * unref'd handle, and the host clears it on session teardown.
 */
interface TimerHost {
  setTimeout?: (fn: () => void, ms?: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

// MANAGED TIMER, NOT A RAW ONE. OMP runs extensions in-process with no
// isolation, so a throw inside a raw `setTimeout` callback escapes as an
// unhandled rejection and the postmortem handler is fatal. Measured 2026-08-11
// in an isolated `omp --mode rpc` sandbox: the raw-timer variant exits with
// code 1 and stdin closes mid-write; the identical throw inside
// `ctx.setTimeout` leaves the session answering `get_state`. This callback was
// self-guarded, so it was safe by accident rather than by construction — and
// it was the one file violating a convention `orca-peer/receive.ts` had
// already written down. `managed-timers.test.ts` now walks the tree for it.
let timer: unknown = null;
/** The host that owns `timer`, so the same host clears it. */
let timerHost: TimerHost | null = null;
let pending: Checkpoint | null = null;
let writerMissing = false;

// THE EXTENSION NO LONGER SETS STATUS ON ROUTINE UPDATES — and that deletes a
// whole bug class rather than patching it.
//
// A todo flip used to also request `in-progress`, which needed a monotonic
// latch so a flip could not undo a PR transition. That latch was a client-side
// approximation of a value that lives in Orca and is written by detached,
// unacknowledged children, so it leaked a new defect at every seam: it reset
// per session, its seeding probe could fail open, it ordered spawns rather
// than persistence, and seeding it synchronously blocked startup.
//
// All of that was defending a promotion Orca performs by itself: measured
// 2026-08-02, 40/40 worktrees sit at `in-progress` with nothing ever having
// written it. So routine updates now carry a comment ONLY, status moves solely
// at the two real transitions, and monotonicity lives in `ax board` — the one
// place that can read the current value before writing it, under a
// per-worktree lock.

function writeCheckpoint(payload: Checkpoint): void {
  if (writerMissing) return;
  if (!boardWrite({ comment: payload.comment, status: payload.status })) {
    // A spawn failure means this package's own CLI entry could not be run at
    // all. Stop trying rather than repeat a doomed spawn on every todo flip.
    writerMissing = true;
  }
}

/** Drop any armed timer without touching what it was going to write. */
function cancelPending(): void {
  if (timer !== null && typeof timerHost?.clearTimer === 'function') {
    try {
      timerHost.clearTimer(timer);
    } catch {}
  }
  timer = null;
  timerHost = null;
}

/** Write whatever the debounce has accumulated, if anything. */
function flush(): void {
  const next = pending;
  pending = null;
  if (next) writeCheckpoint(next);
}

export function schedule(payload: Checkpoint, host: TimerHost | null): void {
  pending = { ...(pending ?? {}), ...payload };
  cancelPending();

  const managed = host?.setTimeout;
  if (typeof managed !== 'function') {
    // A host with no managed timer leaves two options, and a raw timer is not
    // one of them. Writing now costs one extra `orca` process per burst; the
    // debounce is an economy, the checkpoint is the point. Unreached under
    // OMP, which supplies `setTimeout` on every handler ctx.
    flush();
    return;
  }

  timerHost = host;
  timer = managed.call(host, () => {
    timer = null;
    timerHost = null;
    flush();
  }, DEBOUNCE_MS);
}

/**
 * "4/11 · Part B — coherence · Fuse the orchestration executables"
 *
 * Counts every task so the ratio is stable across phases, then names where the
 * work actually is. `nextActionableTask` is not importable from an extension,
 * so the same precedence is reproduced: the in-progress task, else the first
 * task that is neither finished nor abandoned, else nothing left to do.
 */
export function summarizePhases(phases: unknown): string | undefined {
  if (!Array.isArray(phases) || phases.length === 0) return undefined;

  let total = 0;
  let done = 0;
  let current:
    | { phase: string; content: string; blocked?: boolean }
    | undefined;
  let fallback:
    | { phase: string; content: string; blocked?: boolean }
    | undefined;

  for (const phase of phases) {
    const phaseName = typeof phase?.name === 'string' ? phase.name : '';
    const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
    for (const task of tasks) {
      const content = typeof task?.content === 'string' ? task.content : '';
      const status = task?.status;
      total += 1;
      if (status === 'completed' || status === 'abandoned') {
        done += 1;
        continue;
      }
      const entry = {
        phase: phaseName,
        content,
        blocked: status === 'blocked',
      };
      if (status === 'in_progress' && !current) current = entry;
      if (!fallback) fallback = entry;
    }
  }

  if (total === 0) return undefined;

  const head = `${done}/${total}`;
  const active = current ?? fallback;
  if (!active) return `${head} · done`;

  // A task with no content still counts in the ratio, but naming it would
  // render "4/11 · " — a separator pointing at nothing.
  if (!active.content) return active.phase ? `${head} · ${active.phase}` : head;

  const where = active.phase ? `${active.phase} · ` : '';
  const flag = active.blocked ? ' (blocked)' : '';
  return `${head} · ${where}${active.content}${flag}`;
}

/**
 * The command string is only a HINT that a PR transition may have happened.
 *
 * It cannot be the proof. `gh pr merge … || true` exits 0 after a failed
 * merge; `echo "gh pr create"` matches the pattern without invoking gh at all;
 * a compound command's aggregate exit code says nothing about which part
 * succeeded. So a match only triggers a question, and the answer comes from
 * the PR itself.
 */
export function looksLikePrTransition(command: string): boolean {
  if (/--help\b/.test(command)) return false;
  return /\bgh\s+pr\s+(create|merge)\b/.test(command);
}

/**
 * The board status implied by the PR's ACTUAL state, or undefined.
 *
 * ASYNCHRONOUS on purpose. This runs from a `tool_result` handler, and a
 * synchronous `gh` call there blocks OMP's event loop and TUI for as long as
 * GitHub, auth, or the credential helper takes — up to the full timeout. That
 * directly contradicts this file's own rule that checkpoint observability
 * never slows a tool call, so the handler fires the probe and returns.
 */
/**
 * The PR this command names, when it names one explicitly.
 *
 * `.omp/commands/epic.md` §5 runs `gh pr merge <pr>` for a WORKER's PR from
 * the orchestrator's checkout. An argument-less probe there resolves the
 * orchestrator's own branch instead — so it either finds nothing or, worse,
 * moves the orchestrator's checkpoint because a worker merged. Only act when
 * the command is about this worktree's own PR.
 */
export function explicitPrRef(command: string): string | undefined {
  const m = command.match(/\bgh\s+pr\s+(?:create|merge)\s+(?!-)(\S+)/);
  return m?.[1];
}

export async function statusFromPrState(
  command: string,
): Promise<string | undefined> {
  try {
    // THE WATCHDOG IS A SPAWN OPTION, NOT A TIMER — and that is the whole
    // reason this site is no longer in the raw-timer inventory.
    //
    // It was `setTimeout(() => p.kill(), 15_000)`. The two options on the table
    // were to leave it recorded, or to thread an optional timer collaborator
    // the way `orca-peer/receive.ts` does. Both are worse than deleting it.
    // `statusFromPrState` is exported and called by twelve assertions in
    // `orca-checkpoint.test.ts` with no host at all, so a collaborator would be
    // a parameter every real callsite fills and every test leaves empty, to
    // carry a capability the runtime already provides. Measured on bun 1.3.14:
    // `timeout: 300` on a `sleep 5` returned at 304ms with code 137, and a
    // process that exits on its own is unaffected. Default `killSignal` is
    // SIGTERM, which is exactly what `p.kill()` sent.
    const p = Bun.spawn(
      ['gh', 'pr', 'view', '--json', 'state,isDraft,number,url'],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 15_000,
      },
    );
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) return undefined; // no PR for this branch, or gh unavailable
    const pr = JSON.parse(out);

    // The command named a PR explicitly — only ours counts. This is what stops
    // an epic orchestrator's `gh pr merge <worker-pr>` from moving the
    // orchestrator's own checkpoint to `completed`.
    const named = explicitPrRef(command);
    if (named) {
      const matches =
        named === String(pr?.number) ||
        named === `#${pr?.number}` ||
        (typeof pr?.url === 'string' && named === pr.url);
      if (!matches) return undefined;
    }

    // A MERGE IS NOT PROOF THE WORKTREE IS DONE, so it no longer claims
    // `completed`. Measured 2026-08-03: a long-lived worktree merged two PRs
    // from its own pane and the board pinned it at `completed` while its agent
    // kept working for hours - the comment updating underneath a terminal
    // status. `status_rank` is monotonic (correctly: it defends against
    // fire-and-forget children reordering writes), so nothing could bring it
    // back down.
    //
    // `completed` was answering "a PR from here landed" while the board reads
    // it as "this worktree is finished". Where those two coincide, teardown
    // already removes the worktree and its board entry with it, so the signal
    // is redundant when true and wrong when false. The only case it survives
    // to describe is the one it describes incorrectly.
    //
    // The COMMENT is unaffected and needs no merge-specific line: it is driven
    // by the todo list, which already says what the session is doing. Only the
    // archive path knows the work is over, so only it should say `completed`.
    if (pr?.state === 'MERGED') return undefined;
    if (pr?.state === 'OPEN') return pr.isDraft ? undefined : 'in-review';
    return undefined; // CLOSED without merging is not a board transition
  } catch {
    return undefined;
  }
}

// A SUBAGENT MUST NOT NARRATE THE LEAD'S WORKTREE.
//
// A `task` subagent runs its own todo list, so without this guard its progress
// overwrites the sidebar checkpoint of the worktree the LEAD is working in -
// "3/4 · resolve review" from a helper while the lead is somewhere else. The
// board is read by a human to know where a session is; a helper's progress is
// not that answer.
//
// The discriminator is the session, not the process (measured 2026-08-03), and
// two other extensions need the same one. Why a pid latch and an env var both
// fail here is in `shared/session.ts`, once, instead of in three files that can
// drift apart.
const owner = createSessionOwner();

export default function (pi): void {
  // Latch only - not an Orca probe. Binding a session id must never block
  // startup; there is still no session_start WORK beyond the latch itself.
  pi.on('session_start', (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    owner.claim(ctx);
  });

  pi.on('tool_result', (event, ctx) => {
    if (owner.isForeign(ctx)) return;
    try {
      if (event.toolName === 'todo') {
        if (event.isError) return;
        const comment = summarizePhases(event.details?.phases);
        if (comment) schedule({ comment }, ctx as TimerHost);
        return;
      }

      if (event.toolName === 'bash') {
        const command = String(event.input?.command ?? '');
        if (!command || !looksLikePrTransition(command)) return;
        // Fire and forget: the handler must not await GitHub. A status
        // transition is rare and load-bearing, so the write is immediate once
        // the probe answers rather than going through the debounce.
        void statusFromPrState(command)
          .then((status) => {
            if (status) writeCheckpoint({ status });
          })
          .catch(() => {});
      }
    } catch {
      // Never turn an observability bug into a broken tool call.
    }
  });

  // A session that ends mid-debounce would otherwise drop its last update —
  // exactly the one that says where the work stopped.
  pi.on('session_shutdown', (_event, ctx) => {
    if (owner.isForeign(ctx)) return;
    try {
      // The host clears its own managed timers at teardown, but the ordering
      // between that and this handler is not ours to assume, and an armed
      // timer here would write the same payload twice.
      cancelPending();
      flush();
    } catch {}
  });
}
