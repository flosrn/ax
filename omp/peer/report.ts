// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Completion reporting: `REPORT_SHAPE` is the contract a coordinator reads,
 * `report()` the send that honors it. Board movement and the artifact note
 * carry their own incident history below.
 */

import { axArgv } from '../shared/ax.ts';
import { type MessageType, sendToPeer } from './send.ts';
import { parentPeer, selfWorktree } from './lineage.ts';

// ---------------------------------------------------------------- report --

export type ReportState = 'done' | 'blocked' | 'interrupted' | 'turn-ended';

/**
 * Exported because it is a CONTRACT with the coordinator, not an implementation
 * detail: the head is the whole message for a reader who acts on the first line,
 * and `type` decides which reflex it invites. `registry.test.ts` pins both.
 *
 * `turn-ended` exists because `done` used to cover two different propositions.
 * A session with no todo list reports at its first turn boundary — otherwise a
 * mother waits forever on a worker that never used the todo tool — but a FRESH
 * child hits that boundary while it is still reading its ticket, so the report
 * fired within minutes of launch wearing the words "finished its work".
 * Measured 2026-08-15: two of three children dispatched that day did exactly
 * that, both with zero commits, one of them showing `0/10 · Plan` on its board
 * seconds later — the list appeared AFTER the report.
 *
 * The fix is the wording and the type, never the suppression: the signal is
 * load-bearing for a genuine one-shot. `status` rather than `handoff` because a
 * handoff invites the mother to take over, and taking over a child that just
 * started is the expensive outcome — an interruption can make it skip its very
 * next tool call, including a file write.
 */
export const REPORT_SHAPE: Record<
  ReportState,
  { type: MessageType; head: string; tail?: string; movesBoard: boolean }
> = {
  done: { type: 'handoff', head: 'finished its work', movesBoard: true },
  blocked: { type: 'question', head: 'is blocked and needs a decision', movesBoard: true },
  interrupted: { type: 'status', head: 'stopped before finishing', movesBoard: true },
  'turn-ended': {
    type: 'status',
    head:
      'ended a turn and has no todo list yet — this is NOT a claim that its work is done',
    tail:
      'A fresh session reaches this while it is still reading its ticket, so prove the artifact — commits, a PR, or a named failure — before treating it as finished. Do not answer on the strength of it: interrupting a child that is still working can make it skip its very next tool call.',
    // The board says "in-review" = "no longer working, needs someone". That is
    // false for this state, which usually means "just started". A card is the one
    // channel a coordinator is told to trust for a remote child, so a wrong card
    // is worse than no card.
    movesBoard: false,
  },
};

/**
 * A git reader bound to one worktree, returning `null` for a command that did not run.
 *
 * The distinction is the whole point: `git` REFUSES a worktree owned by another uid
 * (`detected dubious ownership`) and prints nothing on stdout, which is byte-identical
 * to "there is nothing here". Two audits of 20 worktrees concluded "nothing to save"
 * that way before a third found 116 unpushed commits.
 */
function gitIn(worktree: string): (args: string[]) => string | null {
  return (args) => {
    try {
      const p = Bun.spawnSync(['git', '-C', worktree, ...args], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      return p.success ? new TextDecoder().decode(p.stdout).trim() : null;
    } catch {
      return null;
    }
  };
}

/**
 * What the `turn-ended` tail asks its reader to do, done by the sender instead.
 *
 * The state's entire message is "prove the artifact rather than answer", and a
 * coordinator holding five children pays that in two round-trips per ping — measured
 * three times inside twenty minutes on 2026-08-16, and every answer was already sitting
 * in the child's own worktree. Local git only: no `gh`, no network, nothing that can
 * hang a turn boundary.
 *
 * It also survives late delivery, which the ping itself does not: a first-turn report
 * reaches a busy coordinator minutes after it was sent, by which time "has no todo list
 * yet" is routinely false. A measurement taken at SEND time is still a true statement
 * about that moment, and it is dated by the message it rides on.
 *
 * Pure, with the reader injected, because the failure worth testing is not a wrong
 * count. It is a refused command rendered as `0 commits` — the flattering reading of an
 * absence, which is the defect class this whole channel exists to stop repeating.
 */
export function artifactNote(read: (args: string[]) => string | null): string {
  const dirty = read(['status', '--porcelain']);
  if (dirty === null) return 'Artifact unmeasured: git refused in this worktree.';
  const files = dirty === '' ? 0 : dirty.split('\n').length;
  const uncommitted = `${files} file${files === 1 ? '' : 's'} uncommitted`;

  // `origin/HEAD` is the repository's own answer and is absent on plenty of clones, so
  // the two conventional names follow it. None of the three resolving is a fact about
  // the clone rather than about the work, and it is said rather than rounded to zero.
  const base = ['origin/HEAD', 'origin/main', 'origin/master'].find(
    (ref) => read(['rev-parse', '--verify', '--quiet', ref]) !== null,
  );
  if (!base) return `Artifact so far: no base ref on origin to count against, ${uncommitted}.`;

  const commits = read(['rev-list', '--count', `${base}..HEAD`]);
  if (commits === null) return `Artifact so far: commit count unmeasured, ${uncommitted}.`;
  const n = Number(commits);
  return `Artifact so far: ${commits} commit${n === 1 ? '' : 's'} ahead of ${base}, ${uncommitted}.`;
}

/**
 * "I am done" — what a dispatched session sends home when its work ends.
 *
 * A signal, deliberately NOT a summary. The mother has a whole model and can
 * read the transcript herself; what she cannot do is notice, unprompted, that a
 * child she started an hour ago has stopped. So this carries the state, the
 * worktree, and how to read the rest — nothing a later turn could turn into a
 * stale description of the work.
 *
 * No parent is the NORMAL case (most worktrees are not dispatched), so it
 * returns quietly. A completion report is observability; it never fails the
 * session that produced the work.
 */
export function report(
  state: ReportState,
  note = '',
): { sent: boolean; reason?: string } {
  const shape = REPORT_SHAPE[state];
  if (!shape) return { sent: false, reason: `unknown state '${state}'` };

  const mine = selfWorktree();

  // A `turn-ended` measures itself, because its own tail is an instruction to measure.
  // An explicit note from the caller still wins: it is the more specific statement.
  const body = note || (state === 'turn-ended' && mine ? artifactNote(gitIn(mine)) : '');

  // The board must stop saying "in-progress" for a session that has stopped —
  // a checkpoint alone does not move it, so nothing else would.
  //
  // `in-review`, not `completed`: what these states share is "no longer working,
  // needs someone". It is also monotonically below `completed`, so a later merge
  // can still promote the worktree, while claiming `completed` here would mark
  // unreviewed work as finished. Monotonicity lives in `ax board` (flosrn/ax),
  // the one place that reads the current value before writing it, under a
  // per-worktree lock.
  //
  // `turn-ended` is EXCLUDED, and that exclusion is the whole point of the state.
  // It does not mean "stopped"; it usually means "just started and has not
  // created a todo list yet". Writing `in-review` for it makes the sidebar claim a
  // child needs someone while it is reading its ticket — and the board is the one
  // channel a coordinator is told to trust for a remote child, because it is the
  // only thing that reports itself. Measured 2026-08-15: GAP-370's card read
  // `in-review · 0/10 · Plan` while the session was actively working, and the
  // coordinator quoted that card as evidence without noticing it was false. Fixing
  // the report's wording while leaving this write is fixing the sentence and
  // keeping the lie.
  if (mine && shape.movesBoard) {
    try {
      // Detached, like `../checkpoint/index.ts` writes its own: nothing reads
      // the result, and waiting on it puts Orca round-trips on the turn boundary
      // of every interactive session for a status nobody is watching right then.
      //
      // `axArgv()` is this package's own CLI, not a resolved binary — see
      // `../shared/ax.ts` for the version skew that cost.
      Bun.spawn(
        [...axArgv(), 'board', '--worktree', `path:${mine}`, '--status', 'in-review'],
        { cwd: process.cwd(), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      ).unref();
    } catch {}
  }

  const parent = parentPeer();
  if (!parent.peer) return { sent: false, reason: parent.reason };

  const name = mine.split('/').pop() || 'this session';
  const lines = [`${name} ${shape.head}.`];
  if (body) lines[0] += ` ${body}`;
  // A state may carry its own guidance, and `turn-ended` is the reason the hook
  // exists: its first line says what the signal is NOT, and this says what to do
  // instead. Placed before the peer_read line so a reader who stops early has
  // already been told to measure rather than answer.
  if (shape.tail) lines.push(shape.tail);
  // Prose an agent reads, so it must not need evaluating to make sense. The
  // mother is in a DIFFERENT worktree, so the name is what she looks it up by.
  lines.push(`Read it with the peer_read tool (peer: ${name}).`);

  const out = sendToPeer({
    target: parent.peer.peer,
    text: lines.join('\n'),
    type: shape.type,
  });
  return out.ok ? { sent: true } : { sent: false, reason: out.error };
}
