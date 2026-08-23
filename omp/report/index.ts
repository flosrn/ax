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
import { report as sendReport, warmLineage } from '../peer/registry.ts';
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
// mother - telling her the whole job is done while the lead is still working. A
// coordinator waiting on that report reads it as the work having landed, so a
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
  const latchFor = (ctx: unknown): string => {
    const session = sessionIdOf(ctx).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
    const handle = String(process.env.ORCA_TERMINAL_HANDLE ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
    return `${reportDir}/${handle}-${session}.done`;
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
      const effective = current === 'none' ? 'done' : current;
      if (effective !== 'done' && effective !== 'blocked') return;
      if (lastReported === effective) return;

      const latch = current === 'none' ? latchFor(ctx) : null;
      if (latch !== null && existsSync(latch)) return;

      const outcome = deliver(current === 'none' ? 'turn-ended' : effective, send);
      const parentless = outcome.reason?.startsWith('no parent worktree recorded') === true;
      if (!outcome.sent && !parentless) return;

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
      if (current === 'none') {
        if (lastReported === null) deliver('turn-ended', send);
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
