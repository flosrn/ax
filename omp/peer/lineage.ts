// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Lineage on native Orca: which worktree this session lives in, who spawned
 * it, what it dispatched, and how deep it sits. Orca's `parentWorktreeId` is
 * the fence — written at worktree creation, forgeable by no peer shell.
 */

import { idToPath, orca, prop, rows, str, worktrees } from './orca.ts';
import { selfHandle } from './store.ts';
import { type Peer, peers } from './address.ts';
import { defaultStore, dispatcherRunForPane } from '../../src/worker/record.mjs';

// -------------------------------------------------------------- worktrees --

/**
 * "Which worktree does ORCA say this session lives in?" — empty when it cannot
 * say.
 *
 * This is the one an address is built from, so guessing is worse than
 * declining: a wrong answer delivers a completion report to a stranger.
 */
let witnessedCache = '';

export function witnessedWorktree(): string {
  // A pane does not move between worktrees, so a POSITIVE answer is cached.
  // A negative one never is: an empty answer means Orca could not vouch for this
  // terminal right now, and caching that would permanently downgrade a session
  // to the cwd fallback because the runtime was busy once.
  if (witnessedCache) return witnessedCache;
  const h = selfHandle();
  if (!h) return '';
  for (const t of rows(orca(['terminal', 'list', '--json']), 'terminals')) {
    if (str(prop(t, 'handle')) !== h) continue;
    witnessedCache = str(prop(t, 'worktreePath') ?? prop(t, 'worktree'));
    return witnessedCache;
  }
  return '';
}

/**
 * "Which worktree am I standing in?" — falls back to the checkout under the
 * cwd, which is right for a session asking about ITSELF and wrong for anything
 * addressing someone else.
 */
export function selfWorktree(): string {
  const witnessed = witnessedWorktree();
  if (witnessed) return witnessed;
  try {
    const p = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    return new TextDecoder().decode(p.stdout).trim();
  } catch {
    return '';
  }
}

// ----------------------------------------------------------------- lineage --

/**
 * The parent worktree path, resolved at most once per process.
 *
 * Memoised because `parentWorktreeId` is written when a worktree is CREATED and
 * cannot change while a session runs inside it — so re-resolving it is two
 * synchronous Orca round-trips, at a turn boundary, that can only produce the
 * same answer.
 *
 * `null` = not resolved yet. Failures are NOT cached, because "Orca could not
 * answer" and "this worktree has no parent" are indistinguishable at the call
 * site: caching the first as the second orphans a dispatched child permanently.
 */
let parentPathCache: string | null = null;

function parentWorktreePath(): { path: string; reason?: string } {
  if (parentPathCache !== null) return { path: parentPathCache };

  const me = selfWorktree();
  if (!me) return { path: '', reason: 'cannot determine this worktree' };

  const rows = worktrees();
  // An empty answer is Orca being unavailable, not a worktree without lineage.
  // Caching it would permanently orphan a dispatched child.
  if (rows.length === 0)
    return { path: '', reason: 'Orca listed no worktrees — lineage is unknown, not absent' };

  const row = rows.find((w) => str(prop(w, 'path')) === me);
  parentPathCache = idToPath(prop(row ?? {}, 'parentWorktreeId'));
  return { path: parentPathCache };
}

/**
 * Resolve lineage now, so the first `report()` does not pay for it at a turn
 * boundary. Cheap to call at `session_start`, where Orca round-trips are already
 * being made and nothing is waiting on the TUI.
 */
export function warmLineage(): void {
  try {
    parentWorktreePath();
  } catch {}
}

/**
 * "Who spawned this worktree?" — the address a finished session reports to.
 *
 * Orca's lineage is the fence. `parentWorktreeId` is written at creation and no
 * peer shell can forge it, so it alone decides WHICH WORKTREE may receive a
 * report.
 *
 * There is no pane-level refinement IN ORCA: its lineage is worktree-level, and
 * the `<worktree>/.agent/orca-spawn.json` that used to name the spawning pane is
 * no longer written by anything. So a parent worktree running several panes used
 * to be reported as ambiguous outright — correct, and measured intolerable on
 * 2026-08-30 (ofmchat PRD 2, #117 and #113 in one night): the primary checkout
 * hosts readiness sessions beside the orchestrator, so "several panes" is the
 * ordinary shape of a wave night and every child of it finished undeliverable.
 *
 * The discriminator Orca has no field for is on this machine: the dispatching
 * session wrote its write-ahead record BEFORE issuing the dispatch, pairing the
 * child's pane with its own Run. That record is authority here for the reason it
 * is everywhere in ax — written ahead of the mutation by the only party holding
 * both halves. It confirms or corrects even a sole live pane when present —
 * worktree sleep can leave a readiness pane behind — while an absent record
 * preserves the legacy sole-pane fallback. With several or zero panes, an
 * absent, unreadable or ambiguous answer keeps the refusal rather than falling
 * back to a pane that merely happens to be there. Delivering a completion to a
 * session that dispatched different work is worse than telling the child to
 * re-route.
 *
 * A LIVE PANE IS NOT WHAT DELIVERY NEEDS, and requiring one cost a report on
 * 2026-09-08. Orca has one known reversible way to produce this shape: its
 * manual "Close terminals" action stops the worktree's ptys while preserving
 * their identifiers, and revealing the pane later cold-restores the agent into
 * the same slot (`sleep-worktree-flow.ts`, `pty-exit-hibernate.ts`). There is no
 * automatic visibility, idle, LRU or memory-pressure reaper in Orca's source.
 * The measured trace establishes only the shape, not its trigger:
 * `session-killed` (`immediate: true`) on the ofmchat primary at 14:06:09Z,
 * then `session-created` for the same `@@9320cb55` slot at 14:27:50Z. The Run
 * persisted across that no-consumer interval (`run_09c2450956f2`, published by
 * three successive handles). Orca keys messages on the Run and holds them —
 * `msg_a5230f12b27a` (`worker_done`) was created 14:13:32Z inside that window
 * and `delivered_at` 14:27:54Z, and rows a week old still sit pending in
 * `orchestration.db` with no sweep. So a recorded Run with nobody on it is a
 * QUEUE, not a dead letter, and the refusal it used to produce — "the
 * dispatching session is gone" — was false in this case.
 *
 * Hence THREE outcomes. `peer`: a pane is reading that Run now. `queued`: the
 * recorded Run is a real address whose arrival is deferred, which the caller
 * must say out loud instead of treating as handed over — a Run whose session
 * never returns keeps the message forever unread (measured: a `worker_done` from
 * 2026-09-04 is still `read = 0`). `reason`: no address exists at all, and no
 * guess may stand in for one.
 */
export interface Dispatcher {
  /** A pane in the parent worktree that is reading the dispatcher's Run. */
  peer?: Peer;
  /** The dispatcher's Run, recorded before the dispatch, with no pane on it. */
  queued?: { run: string; worktree: string };
  /** No address at all. Every inability is named (F-028). */
  reason?: string;
}

export function parentPeer(): Dispatcher {
  const resolved = parentWorktreePath();
  if (resolved.reason) return { reason: resolved.reason };
  const parentPath = resolved.path;
  if (!parentPath)
    return {
      reason:
        'no parent worktree recorded — this session was not dispatched (or was created without a parent)',
    };

  const inParent = peers().filter((p) => p.worktree === parentPath);
  const name = parentPath.split('/').pop() || parentPath;
  const found = dispatcherRunForPane(defaultStore(process.env), selfHandle());


  // Even ONE pane can be the wrong one while Orca sleeps the dispatcher and
  // leaves a readiness session alive in the same worktree. Consult the local
  // write-ahead record first: a named Run either confirms that pane or turns the
  // mismatch into a queue. With no record, preserve the pre-record ordinary case
  // — one pane is still the only evidence available, and refusing it would
  // orphan every manually-created/legacy child.
  if (inParent.length === 1) {
    if (found.run === undefined) return { peer: inParent[0] };
    return inParent[0].run === found.run
      ? { peer: inParent[0] }
      : { queued: { run: found.run, worktree: parentPath } };
  }

  // Host-local by construction: the store is under this machine's HOME, so a
  // child on another host resolves nothing here and must not — that case has
  // its own channel (the board card, src/worker/brief.mjs).
  if (found.run === undefined)
    return {
      reason:
        inParent.length === 0
          ? `parent worktree '${name}' has no live session to report to and ${found.reason}`
          : `parent worktree '${name}' runs several panes and ${found.reason}`,
    };

  const dispatcher = inParent.find((p) => p.run === found.run);
  return dispatcher ? { peer: dispatcher } : { queued: { run: found.run, worktree: parentPath } };
}

export interface Child {
  name: string;
  path: string;
  status: string;
  checkpoint: string;
  live: boolean;
}

/**
 * "What did I dispatch, and where is it?"
 *
 * There is no ledger, deliberately. Orca records lineage and every worktree
 * publishes its own progress into `workspaceStatus` + `comment` via
 * `../orca-checkpoint.ts`. A batch file tracking "who did I spawn, who has
 * answered" would be a second source of truth for facts Orca holds, and it
 * would go stale the first time a session was killed outside the loop.
 *
 * `live` is the field that separates "still working" from "gone": a child with
 * no terminal will never send anything again, whatever its checkpoint last said.
 */
export function children(): Child[] {
  const me = selfWorktree();
  if (!me) return [];
  return worktrees()
    .filter((w) => idToPath(prop(w, 'parentWorktreeId')) === me)
    .map((w) => {
      const path = str(prop(w, 'path'));
      return {
        name: str(prop(w, 'displayName')) || path.split('/').pop() || path,
        path,
        status: str(prop(w, 'workspaceStatus')) || 'unknown',
        checkpoint: str(prop(w, 'comment')),
        live: Number(prop(w, 'liveTerminalCount') ?? 0) > 0,
      };
    });
}

/** A cycle cannot exist in Orca's lineage, so this bound is never reached in
 *  practice. It is here because the walk runs at a turn boundary, where a hang
 *  is a stuck session rather than a slow one. */
const MAX_LINEAGE_HOPS = 32;

/**
 * "How deep am I?" — 0 for a root worktree, 1 for a child, 2 for a grandchild.
 * `-1` means UNKNOWN, and the distinction is the whole point.
 *
 * Costs no Orca round-trip: `rows` is the list `worktrees()` already fetched,
 * and lineage is a `parentWorktreeId` on each row, so the chain is walked in
 * memory. The restructuring plan priced this as one round-trip per hop; that
 * was wrong about the data already in hand.
 *
 * Unknown rather than 0 whenever the chain cannot be completed — an absent
 * worktree, a parent Orca did not list, an empty answer. `0` is the claim "I am
 * a root session", which is what a parent counts its own children against, and
 * it must never be produced by an absence of information (F-028's shape).
 */
export function depthOf(worktree: string, rows: unknown[]): number {
  if (!worktree || rows.length === 0) return -1;

  const parentOf = new Map<string, string>();
  for (const row of rows) {
    const path = str(prop(row, 'path'));
    if (path) parentOf.set(path, idToPath(prop(row, 'parentWorktreeId')));
  }

  let at = worktree;
  for (let hops = 0; hops <= MAX_LINEAGE_HOPS; hops++) {
    const parent = parentOf.get(at);
    // Orca never listed this worktree: the chain is broken, not finished.
    if (parent === undefined) return -1;
    if (!parent) return hops;
    at = parent;
  }
  return -1;
}
