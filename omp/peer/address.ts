// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Peer addressing on native Orca.
 *
 * WHY THIS EXISTS. Two facts Orca does not expose have to be built here:
 *
 *   1. ADDRESSING. Orca addresses `run:run_e85ac41eabf2`; humans and agents
 *      address "the 1657 spike". `terminal list --json` answers
 *      `name: null, agent: null, model: null` for every pane, so the readable
 *      name has to be derived and the model has to be published.
 *   2. ATTRIBUTION. Orca injects a pending message into a running OMP session
 *      as `attribution: "user"` — byte-identical to something the operator
 *      typed. `../orca-peer.ts` wraps every delivery for exactly that reason.
 *
 * The naming rule that decides an address lives HERE alone; every reader joins
 * against it rather than restating it, so no second copy can disagree about
 * which session a handle belongs to. Publishing (`register`, `setModel`) is in
 * this module too: publishing an entry is an act of addressing, and the
 * readable name a register answers is derived by the same rule that will
 * later resolve it.
 */

import { existsSync } from 'node:fs';

import { orca, prop, rows, str, worktrees } from './orca.ts';
import {
  type Entry,
  acquireRegisterLock,
  alive,
  allEntries,
  publish,
  readEntry,
  releaseRegisterLock,
  selfHandle,
} from './store.ts';

// ------------------------------------------------------------------ peers --

export interface Peer {
  handle: string;
  worktree: string;
  peer: string;
  run: string;
  model: string;
  /** Thinking level, empty when the session never published one. */
  level: string;
  self: boolean;
  /** What the peer published about itself; `peer_read` selects its transcript by it. */
  sessionId: string;
}

/**
 * The peer list is a JOIN: Orca supplies identity, the registry supplies only
 * what Orca cannot know.
 *
 * Names are DERIVED from Orca's terminal→worktree mapping, never claimed. The
 * registry is a plain same-UID directory any local process can write, so a name
 * claimed there is forgeable and racy; the Orca mapping is not. Two panes in one
 * worktree disambiguate with a stable handle fragment, not an ordinal that
 * depends on who wrote first.
 *
 * `pending` optionally names a handle to treat as registered even though it has
 * no Run yet. A session must know its own name BEFORE it creates its Run — the
 * Run is tagged with that name and adopted by prefix on restart, so an empty
 * name there makes the tag `peer session: `, which prefixes every peer Run and
 * lets a session adopt somebody else's.
 */
function derive(reachableOnly: boolean, pending: string): Peer[] {
  const terms = rows(orca(['terminal', 'list', '--json']), 'terminals');
  // No Orca, no identities. Returning a registry-only list here would
  // resurrect exactly the forgeable naming this join exists to remove.
  if (terms.length === 0) return [];

  const registered = new Map<string, Partial<Entry>>();
  for (const e of allEntries()) {
    const h = str(e.handle);
    if (h) registered.set(h, e);
  }

  const self = selfHandle();
  const byWorktree = new Map<string, Peer[]>();

  for (const t of terms) {
    const handle = str(prop(t, 'handle'));
    if (!handle) continue;
    const worktree = str(prop(t, 'worktreePath') ?? prop(t, 'worktree'));
    const entry = registered.get(handle);
    const run = str(entry?.run);
    // Filter FIRST, then disambiguate: an ordinary shell open beside the agent
    // must not push the agent onto a suffixed name.
    if (reachableOnly && !run && !(pending && handle === pending)) continue;
    const group = byWorktree.get(worktree);
    const row: Peer = {
      handle,
      worktree,
      peer: '',
      run,
      model: str(entry?.model),
      level: str(entry?.level),
      self: handle === self,
      sessionId: str(entry?.sessionId),
    };
    if (group) group.push(row);
    else byWorktree.set(worktree, [row]);
  }

  const out: Peer[] = [];
  for (const [worktree, group] of byWorktree) {
    const base = worktree.split('/').pop() || 'session';
    const shared = group.length > 1;
    for (const row of group) {
      row.peer = shared
        ? `${base}\u00b7${row.handle.replace(/^term_/, '').slice(0, 4)}`
        : base;
      out.push(row);
    }
  }
  return out.sort((a, b) => a.peer.localeCompare(b.peer));
}

/**
 * Panes that can be ADDRESSED: Orca lists every terminal, but only those that
 * published a Run are reachable.
 */
export function peers(pending = ''): Peer[] {
  return derive(true, pending);
}

/**
 * Every live pane, named by the same rule — for ATTRIBUTING an incoming
 * message rather than addressing an outgoing one.
 *
 * The distinction is load-bearing. A sender that never registered has no Run,
 * so it is unreachable and absent from `peers()`; its message still arrives and
 * still has to be labelled.
 *
 * Sharing `derive` is the point: two copies of the rule that decides what a
 * session is called is how the same pane ends up with two names.
 */
export function panes(): Peer[] {
  return derive(false, '');
}

/** This session's own row, or `null` when it has not published one. */
export function selfPeer(pending = ''): Peer | null {
  const h = selfHandle();
  if (!h) return null;
  return peers(pending).find((p) => p.handle === h) ?? null;
}

/**
 * This session's name, as everyone else will see it.
 *
 * Derived, never claimed, so every session agrees on it without a protocol.
 */
export function resolvePeerName(): string {
  const derived = selfPeer(selfHandle())?.peer ?? '';
  if (derived) return derived;
  return (process.cwd().split('/').pop() || 'session').replace(
    /[^A-Za-z0-9._-]+/g,
    '-',
  );
}

export interface Resolved {
  address?: string;
  handle?: string;
  worktree?: string;
  ambiguous?: string[];
}

/** The session-id prefix Orca shows in its UI, and the only id a human reads off a card. */
export const shortId = (sessionId: string): string => sessionId.slice(0, 8);

// Hex, with the hyphens a full UUID carries: the same grammar `ax worker
// transcript` accepts for a session card, so an id read off a card and one read
// off a session filename are the same target. Six characters minimum keeps a
// short worktree name from being read as an id.
const SHORT_ID = /^[0-9a-f][0-9a-f-]{5,}$/i;

/**
 * Resolve a user-typed target to an Orca address.
 *
 * Exact first. A non-exact PREFIX must resolve to exactly one live peer: with
 * `1657-spike` and `1657-styles` both up, resolving `1657` by sort order sends
 * worktree-specific detail to the wrong session. Ambiguity is an error, not a
 * guess.
 *
 * A SESSION ID IS A TARGET TOO, because it is the id the UI shows: an operator
 * relaying "answer terminal 01a036ee" is reading a session-id prefix, and this
 * resolver used to match only derived names and worktree basenames. Measured
 * 2026-08-25: `peer_send 01a036ee` answered `unknown peer` while the session was
 * in `peer_list` under another name, and the coordinator had to cross-reference
 * `orca terminal list --json` by hand to find it. The id is matched by prefix
 * over `sessionId`, which the registry already carries, and it is hex so it can
 * never collide with the worktree-derived names above.
 *
 * Group and raw addresses pass through untouched — a caller that already knows
 * the address is not asking for a lookup.
 */
export function resolveTarget(want: string): Resolved {
  if (/^(@|run:|dispatch:|term_)/.test(want)) return { address: want };

  const list = peers();
  const exact = list.find((p) => p.peer === want);
  if (exact)
    return {
      address: `run:${exact.run}`,
      handle: exact.handle,
      worktree: exact.worktree,
    };

  const lower = want.toLowerCase();
  const byId = SHORT_ID.test(want);
  const seen = new Set<string>();
  const hits: Peer[] = [];
  for (const p of list) {
    const matches =
      p.peer.toLowerCase().startsWith(lower) ||
      (p.worktree.split('/').pop() || '') === want ||
      (byId && p.sessionId !== '' && p.sessionId.toLowerCase().startsWith(lower));
    if (!matches || seen.has(p.handle)) continue;
    seen.add(p.handle);
    hits.push(p);
  }
  if (hits.length === 1)
    return {
      address: `run:${hits[0].run}`,
      handle: hits[0].handle,
      worktree: hits[0].worktree,
    };
  if (hits.length > 1) return { ambiguous: hits.map((p) => p.peer) };
  return {};
}

// ------------------------------------------------------------- publishing --

export type Refusal = 'invalid' | 'foreign';

/**
 * Publish the two facts Orca does not expose — this session's Run and the model
 * label it wants shown — keyed by its own terminal handle.
 *
 * It claims NO name: names are derived in `peers`, so there is nothing here to
 * race over and nothing a forged handle can rename.
 *
 * OWNERSHIP. The key is the handle (that is how peers address a pane) but the
 * ENTRY is owned by the OMP session that first wrote it. Several processes can
 * share one `ORCA_TERMINAL_HANDLE` — Orca's start-immediately pane, a sibling
 * shell that exported it, a subagent that re-entered register — so a differing
 * `sessionId` whose recorded `ownerPid` is still alive is refused. Drop that
 * fence and the second process publishes its own Run and model over a live
 * owner, and every peer that session speaks to is told the wrong model.
 */
export function register(o: {
  run: string;
  sessionId: string;
  model?: string;
  level?: string;
  modelSource?: string;
  ownerPid?: number;
}): { published: boolean; peer: string; refused?: Refusal } {
  const handle = selfHandle();
  // A caller that forgot the session id must not believe it published.
  if (!handle || !o.run || !o.sessionId)
    return { published: false, peer: '', refused: 'invalid' };
  const ownerPid = o.ownerPid ?? process.pid;
  const lock = acquireRegisterLock(handle);
  if (lock === null) return { published: false, peer: '', refused: 'foreign' };

  try {
    const existing = readEntry(handle);
    if (existing) {
      const owner = str(existing.sessionId);
      // Foreign session. Only reclaim when the recorded owner is gone.
      if (owner && owner !== o.sessionId && alive(existing.ownerPid))
        return { published: false, peer: '', refused: 'foreign' };
    }

    const ok = publish(handle, {
      handle,
      run: o.run,
      model: o.model ?? '',
      level: o.level ?? '',
      sessionId: o.sessionId,
      ownerPid,
      modelSource: o.modelSource ?? '',
      startedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    });
    if (!ok) return { published: false, peer: '', refused: 'invalid' };

    // `published` and `peer` are separate answers: deriving a readable name may
    // fail after the registry write succeeded.
    return { published: true, peer: selfPeer(handle)?.peer ?? '' };
  } finally {
    releaseRegisterLock(lock);
  }
}

/**
 * Refresh only the model label on an entry this session owns.
 *
 * A legacy entry carrying no `sessionId` may be claimed by the first caller that
 * has one — that is a repair, not a steal. A present foreign `sessionId` is a
 * hard refuse.
 */
export function setModel(o: {
  model: string;
  sessionId: string;
  level?: string;
  modelSource?: string;
  ownerPid?: number;
}): { ok: boolean; refused?: Refusal } {
  const handle = selfHandle();
  if (!handle || !o.model || !o.sessionId) return { ok: false, refused: 'invalid' };
  const existing = readEntry(handle);
  if (!existing) return { ok: false, refused: 'invalid' };

  const owner = str(existing.sessionId);
  if (owner && owner !== o.sessionId) return { ok: false, refused: 'foreign' };

  const ok = publish(handle, {
    handle,
    run: str(existing.run),
    model: o.model,
    // An absent level is "not observed this turn", never "back to default":
    // OMP emits `thinking_level_change` once, not on every turn.
    level: o.level ?? str(existing.level),
    sessionId: o.sessionId,
    ownerPid: o.ownerPid ?? process.pid,
    modelSource: o.modelSource ?? 'transcript',
    startedAt: str(existing.startedAt) || new Date().toISOString(),
  });
  return ok ? { ok: true } : { ok: false, refused: 'invalid' };
}


/** Resolve a peer name, a worktree name, or a path to an absolute worktree. */
export function worktreeOf(target: string): string {
  const resolved = resolveTarget(target);
  if (resolved.worktree) return resolved.worktree;
  const hit = peers().find(
    (p) => p.peer === target || (p.worktree.split('/').pop() || '') === target,
  );
  if (hit) return hit.worktree;
  if (existsSync(target)) return target;
  const row = worktrees().find(
    (w) =>
      str(prop(w, 'path')) === target ||
      str(prop(w, 'displayName')) === target ||
      (str(prop(w, 'path')).split('/').pop() || '') === target,
  );
  return row ? str(prop(row, 'path')) : '';
}
