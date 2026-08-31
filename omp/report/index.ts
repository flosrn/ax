// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
// @orca-managed-pi-extension
//
// A spawned session tells its mother when it stops working.
//
// WHY THIS IS NOT A CONVENTION IN A PROMPT
//
// The obvious version is one line in the brief: "when you are done, report".
// It fails the way every discipline-shaped mechanism fails — silently, and
// exactly when it matters. A session that hits its
// context limit, crashes, or simply forgets the last instruction of a long
// brief leaves the mother waiting on a message that will never come, with no
// way to distinguish "still working" from "died an hour ago". Silence read as
// progress is the failure this repo keeps rediscovering (the detached watcher
// armed by `ax worker start` exists for this exact gap).
//
// WHY THE TODO LIST IS THE SIGNAL
//
// It is the only progress signal every OMP session already emits, it is
// structured (`details.phases`), and the sibling orca-checkpoint.ts extension
// already proves it is reliable enough to drive the Orca sidebar. Deriving the
// end of work from it costs the agent nothing and cannot be forgotten.
//
// Its one real gap used to be: a session that never makes a todo list never
// reports. That was assumed to mean "one-shot answer", and it is not — a session
// can work for hours without ever calling the todo tool, and the mother is never
// told. The rule is now: a session with NO todo list reports `done` at its
// first turn end — for a spawned worker that boundary is either the finished
// one-shot answer or a question already delivered as its own peer message, and
// both are moments the mother wants to know about. The dedup latch keeps it to
// one signal; a todo list appearing later resets it and the richer flow takes
// over. The gap this hook CANNOT cover is a session that hangs mid-work or dies
// to SIGKILL: no in-process hook observes either. `ax worker start` arms a
// separate watcher for that case.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Lineage and delivery live in one place, shared with `orca-peer.ts`.
import { warmLineage } from '../peer/lineage.ts';
import { report as sendReport } from '../peer/report.ts';
import { createSessionOwner, isSubagentSession, sessionIdOf } from '../shared/session.ts';

// No-todo reports are once per SESSION, not once per pane: Orca may reuse a
// terminal for a new worker. The session id keeps reload/compact deduplication
// while allowing the next owner of that pane to report.
const DEFAULT_REPORT_DIR = `${process.env.HOME}/.omp/run/orca-report`;


// The report is about THIS session. `sendReport` resolves the address itself
// from Orca's lineage — this extension must not try to.

type WorkState = 'working' | 'done' | 'blocked' | 'none';


/**
 * Where the work stands, from the todo phases alone.
 *
 * `blocked` is not "some task is blocked" — an agent routinely parks one item
 * and keeps going. It is "nothing is left that this session can act on": every
 * remaining task is blocked. That is the only shape that deserves waking the
 * mother, because it is the only one she can do something about.
 */
function readState(phases: unknown): WorkState {
  if (!Array.isArray(phases) || phases.length === 0) return 'none';

  let total = 0;
  let settled = 0;
  let blocked = 0;

  for (const phase of phases) {
    const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
    for (const task of tasks) {
      total += 1;
      const status = task?.status;
      if (status === 'completed' || status === 'abandoned') settled += 1;
      else if (status === 'blocked') blocked += 1;
    }
  }

  if (total === 0) return 'none';
  if (settled === total) return 'done';
  if (settled + blocked === total) return 'blocked';
  return 'working';
}

type DeliveryState = 'done' | 'blocked' | 'interrupted' | 'turn-ended';
type DeliveryResult = { sent: boolean; reason?: string };

function deliver(state: DeliveryState, send: (state: DeliveryState) => DeliveryResult): DeliveryResult {
  try {
    return send(state);
  } catch (error) {
    // Observability must never break the session that produced the work.
    return { sent: false, reason: String(error) };
  }
}

// A SUBAGENT MUST NOT REPORT ITS PARENT'S WORK AS FINISHED.
//
// A `task` subagent runs its own todo list. Without this guard, the subagent
// finishing its slice fires a completion report addressed to the LEAD's
// mother - telling her the whole job is done while the lead is still working. An
// orchestrator waiting on that report reads it as the work having landed, so a
// false one is not cosmetic: it ends the supervision early.
//
// The discriminator is the session, not the process, and two other extensions
// need the same one. Why a pid latch and an env var both fail here is in
// `shared/session.ts`, once, instead of in three files that can drift apart.
export interface ReportSeams {
  sendReport?: (state: DeliveryState) => DeliveryResult;
  warmLineage?: () => unknown;
  reportDir?: string;
}

export default function (pi, seams: ReportSeams = {}): void {
  const owner = createSessionOwner();
  const send = seams.sendReport ?? sendReport;
  const warm = seams.warmLineage ?? warmLineage;
  const reportDir = seams.reportDir ?? DEFAULT_REPORT_DIR;
  let lastReported: WorkState | null = null;
  let current: WorkState = 'none';
  /**
   * A run has begun and has not ended.
   *
   * The one fact the todo list cannot supply: it describes the cycle that wrote
   * it, so it cannot say whether THIS one finished. `session_shutdown` needs
   * exactly that to tell a completion from an interruption.
   */
  let cycleActive = false;
  const latchFor = (ctx: unknown): string => {
    const session = sessionIdOf(ctx).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
    const handle = String(process.env.ORCA_TERMINAL_HANDLE ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
    return `${reportDir}/${handle}-${session}.done`;
  };

  // WHAT A REFUSED DELIVERY COSTS, SAID WHERE SOMEBODY CAN ACT ON IT.
  //
  // `report()` answers `{sent, reason}` and this extension used to drop the
  // reason on the floor, which made an undeliverable finish indistinguishable
  // from a delivered one — from inside this session, from the orchestrator's
  // side, and from the transcript afterwards.
  //
  // The reason is rarely exotic. Measured 2026-08-25: a child whose parent
  // worktree ran two registered panes got `parent worktree 'ax' runs several
  // panes and none can be identified as the dispatcher`, and went mute with
  // nothing said anywhere. That announcement is why the same failure was
  // REPORTED rather than guessed at on 2026-08-30 (ofmchat PRD 2, #117 and
  // #113): both children read this line, said so on the peer channel, and
  // nothing was lost.
  //
  // A parent running several panes now resolves through the write-ahead dispatch
  // record instead (`dispatcherRunForPane`, ../peer/lineage.ts), so that
  // particular reason is no longer the ordinary one. What has not changed is the
  // rule this block exists for: every remaining reason — a departed dispatcher,
  // an unreadable store, a pane no record names, another host — is a finish this
  // session must not treat as handed over, and silence is the one outcome that
  // makes it indistinguishable from success.
  //
  // ONE ANNOUNCEMENT PER DISTINCT REASON. A per-cycle repetition of a condition
  // the session cannot change is noise, and noise is how the signal that matters
  // gets skimmed past. `customType`, never a user message: this is the harness
  // talking about its own plumbing.
  const announced = new Set<string>();
  const announce = (reason: string): void => {
    if (!reason || announced.has(reason)) return;
    announced.add(reason);
    try {
      pi.sendMessage?.({
        customType: 'report-undelivered',
        content:
          `[REPORT NOT DELIVERED] This session finished a unit of work and its completion ` +
          `could not be delivered: ${reason}. Nobody upstream will learn it from here — ` +
          `say it on a channel that works, or fix the condition, before treating the work as handed over.`,
        display: true,
      });
    } catch {
      // Observability must never break the session that produced the work.
    }
  };
  // Latch only - no I/O. Owner must be bound before any tool_result can race
  // in from an in-process subagent.
  pi.on('session_start', (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    owner.claim(ctx);
    if (owner.isForeign(ctx)) return;
    // Resolve lineage here, not at the first turn end. It cannot change while
    // this session runs, so it belongs at startup, where Orca round-trips are
    // already being made — not on a turn boundary where the operator is
    // waiting on the answer.
    warm();
  });

  // A NEW WORK CYCLE RE-ARMS THE REPORT. Without this, a worker speaks once and
  // is then mute for the rest of its life.
  //
  // Measured 2026-08-25 on ofmchat: child `57-policy-offer-engine` reported
  // `done` at 11:32:41, was handed a second assignment on its pane at 11:40:59,
  // committed and opened PR #76, and ended that run at 11:47:40 in silence —
  // `current` was still `done`, `lastReported` was `done`, and `agent_end`
  // returned before the send. Orca's ledger holds nothing from that pane after
  // 11:32:28. The orchestrator, idle since 11:42, was never told. Its
  // `worker_done` could not cover the gap either: Orca's preamble allows exactly
  // one.
  //
  // WHY THIS EVENT AND NOT A MEASUREMENT. The todo tool is untouched by most
  // follow-up work, which is precisely how the silence arose. Proving new work
  // from git fails the same way for a whole class of real follow-ups — an
  // analysis, a decision, a review comment, a merge performed remotely, or work
  // already committed before the first report — and would reinstate the silence
  // for exactly those. `agent_start` is the honest signal: this session was handed
  // something and began working on it. The `lastReported` latch still holds
  // WITHIN the cycle, so Pi's auto-retry and auto-compact runs, which end an
  // agent run several times for one thing the operator asked, produce one report.
  pi.on('agent_start', (_event, ctx) => {
    if (owner.isForeign(ctx)) return;
    cycleActive = true;
    lastReported = null;
  });

  pi.on('tool_result', (event, ctx) => {
    if (owner.isForeign(ctx)) return;
    try {
      if (event.toolName !== 'todo' || event.isError) return;
      current = readState(event.details?.phases);
      // Work resumed: whatever was reported no longer describes this session,
      // so the next completion is allowed to speak again.
      if (current === 'working') lastReported = null;
    } catch {
      // Never turn an observability bug into a broken tool call.
    }
  });

  // The turn boundary, not the todo flip, is when a session has actually
  // stopped. An agent marks its last task done and then keeps working —
  // committing, pushing, tidying — so reporting on the flip would announce a
  // finish that is still minutes away from being true.
  //
  // `none` (no todo list at all) also reports here: the alternative is the mother
  // waiting forever on a worker that simply never used the todo tool. But it
  // reports `turn-ended`, NOT `done` — those are two different propositions and
  // sharing one word made the first cost the second its credibility. A fresh
  // child reaches this boundary while it is still reading its ticket, so the
  // report used to arrive minutes after launch saying "finished its work".
  // `turn-ended` says what it is, and asks the reader to measure the artifact
  // rather than answer. For a parentless session the report resolves no address
  // and returns without sending, so this costs interactive sessions nothing.
  pi.on('agent_end', (_event, ctx) => {
    if (owner.isForeign(ctx)) return;
    try {
      // Cleared FIRST, before any of the early returns below. A run that ended
      // without reporting — capped by the latch, or reporting a state already
      // sent — is still a run that ended, and leaving the cycle open would make
      // a later shutdown call a finished session interrupted.
      cycleActive = false;

      const effective = current === 'none' ? 'done' : current;
      if (effective !== 'done' && effective !== 'blocked') return;
      if (lastReported === effective) return;

      const latch = current === 'none' ? latchFor(ctx) : null;
      if (latch !== null && existsSync(latch)) return;

      const outcome = deliver(current === 'none' ? 'turn-ended' : effective, send);
      // `no parent worktree recorded` is the NORMAL case — most worktrees are not
      // dispatched — so it is the one refusal that stays quiet. Every other one is
      // a session that was supposed to be heard from and was not.
      const parentless = outcome.reason?.startsWith('no parent worktree recorded') === true;
      if (!outcome.sent && !parentless) {
        announce(outcome.reason ?? 'the reason was not reported');
        return;
      }

      if (latch !== null) {
        try {
          mkdirSync(reportDir, { recursive: true });
          writeFileSync(latch, new Date().toISOString());
        } catch {
          // Unwritable latch: delivery succeeded; a duplicate after reload is
          // safer than claiming the report failed and sending it immediately.
        }
      }
      lastReported = effective;
    } catch {}
  });

  // A session that exits with work outstanding is the case the mother cannot
  // detect on her own: no completion arrives and no further turn will ever
  // run. Saying "stopped before finishing" is strictly more useful than the
  // silence it replaces.
  pi.on('session_shutdown', (_event, ctx) => {
    if (owner.isForeign(ctx)) return;
    try {
      // A CYCLE THAT BEGAN AND NEVER ENDED IS AN INTERRUPTION, whatever the todo
      // list says. That list describes the cycle that wrote it: after the re-arm
      // above, a session killed inside its SECOND assignment still reads `done`
      // from its first, and would announce "finished its work" for work that
      // stopped halfway. A false completion is acted on; the silence it replaced
      // was merely a silence, so this is the more expensive of the two errors and
      // the cycle boundary is the only thing that can tell them apart.
      // `session_shutdown` fires once per teardown, so no latch is needed here —
      // and `lastReported` holds a todo state, which `interrupted` is not.
      if (cycleActive) {
        deliver('interrupted', send);
        return;
      }
      if (current === 'none') {
        // The latch, not `lastReported`, is the authority for this state: the
        // re-arm clears `lastReported` at every cycle, and `turn-ended` is capped
        // once per SESSION on purpose. Retrying a delivery that failed is the one
        // thing this branch is for.
        if (lastReported === null && !existsSync(latchFor(ctx))) deliver('turn-ended', send);
        return;
      }
      if (current === 'done') {
        if (lastReported !== 'done') deliver('done', send);
        return;
      }
      if (current === 'blocked') {
        if (lastReported !== 'blocked') deliver('blocked', send);
        return;
      }
      deliver('interrupted', send);
    } catch {}
  });
}
