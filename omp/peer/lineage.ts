// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Lineage on native Orca: which worktree this session lives in, who spawned
 * it, what it dispatched, and how deep it sits. Orca's `parentWorktreeId` is
 * the fence — written at worktree creation, forgeable by no peer shell.
 */

import { idToPath, orca, prop, rows, str, worktrees } from './orca.ts';
import { selfHandle } from './store.ts';
import { type Peer, peers } from './address.ts';

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
 * There is no pane-level refinement: Orca's lineage is worktree-level, and the
 * `<worktree>/.agent/orca-spawn.json` that used to name the spawning pane is no
 * longer written by anything. A parent worktree running several panes is
 * therefore ambiguous and reported as such rather than guessed.
 */
export function parentPeer(): { peer?: Peer; reason?: string } {
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
  if (inParent.length === 0)
    return { reason: `parent worktree '${name}' has no live session to report to` };
  if (inParent.length > 1)
    return {
      reason: `parent worktree '${name}' runs several panes and none can be identified as the dispatcher`,
    };
  return { peer: inParent[0] };
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
