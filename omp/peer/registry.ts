// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Peer addressing and lineage, on native Orca.
 *
 * WHY THIS MODULE EXISTS. Two facts Orca does not expose have to be built here:
 *
 *   1. ADDRESSING. Orca addresses `run:run_e85ac41eabf2`; humans and agents
 *      address "the 1657 spike". `terminal list --json` answers
 *      `name: null, agent: null, model: null` for every pane, so the readable
 *      name has to be derived and the model has to be published.
 *   2. ATTRIBUTION. Orca injects a pending message into a running OMP session
 *      as `attribution: "user"` — byte-identical to something the operator
 *      typed. `../orca-peer.ts` wraps every delivery for exactly that reason.
 *
 * No message text ever reaches a shell line: an argv array has no shell to
 * escape from, so peer-influenced text cannot be reinterpreted as a command.
 *
 * WHY SYNCHRONOUS
 * Every caller is an OMP event handler, and one of them is `session_shutdown`.
 * An async report there races the process exit it is reporting — the very
 * "silent finish" this channel exists to make impossible. `spawnSync` costs a
 * few hundred ms once per finished session and cannot be cut off.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// One resolver for the Orca binary, shared with `orca-model` rather than
// duplicated: the VPS names it `orca-ide`, and a bare `orca` there resolves to
// nothing under a minimal PATH.
import { resolveOrcaBin } from '../model/self.ts';
import { axArgv } from '../shared/ax.ts';

const ORCA = resolveOrcaBin().bin;

/** Overridable so the tests never touch the live registry. */
function registryDir(): string {
  return (
    process.env.ORCA_PEER_REGISTRY_DIR ||
    `${process.env.HOME}/.omp/run/orca-peers`
  );
}
const HANDLE = /^term_[A-Za-z0-9_-]{1,128}$/;

export function selfHandle(): string {
  const handle = process.env.ORCA_TERMINAL_HANDLE ?? '';
  return HANDLE.test(handle) ? handle : '';
}

// ---------------------------------------------------------------- orca I/O --

/**
 * One `orca … --json`, parsed, or `null`.
 *
 * Never throws: a busy or absent runtime must degrade a peer feature, never
 * break the session hosting it.
 */
function orca(args: string[], timeoutMs = 15_000): unknown {
  try {
    const p = Bun.spawnSync([ORCA, ...args], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    return JSON.parse(new TextDecoder().decode(p.stdout));
  } catch {
    return null;
  }
}

/** `orca … --json` but the raw text too, because some failures are only in stderr. */
function orcaRaw(
  args: string[],
  timeoutMs = 20_000,
): { parsed: unknown; text: string } {
  try {
    const p = Bun.spawnSync([ORCA, ...args], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    const text =
      new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(p.stdout));
    } catch {}
    return { parsed, text };
  } catch {
    return { parsed: null, text: '' };
  }
}

function prop(o: unknown, k: string): unknown {
  return o && typeof o === 'object' && k in o
    ? (o as Record<string, unknown>)[k]
    : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Orca has answered `{result: {things: []}}` and `{result: []}` across versions. */
function rows(envelope: unknown, key: string): Record<string, unknown>[] {
  const result = prop(envelope, 'result');
  const listed = prop(result, key) ?? result;
  return Array.isArray(listed) ? (listed as Record<string, unknown>[]) : [];
}

// `worktree ps` and not `worktree list`: one row already carries lineage, board
// status, checkpoint comment AND live pane count, so no join is needed.
export function lineageRows(): Record<string, unknown>[] {
  return worktrees();
}

function worktrees(): Record<string, unknown>[] {
  return rows(orca(['worktree', 'ps', '--json']), 'worktrees');
}


/** `<repoId>::<path>` is Orca's worktree id; a report is addressed by the path. */
function idToPath(id: unknown): string {
  return str(id).replace(/^[^:]*::/, '');
}

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

// --------------------------------------------------------------- registry --

/** What a session publishes about itself. Orca knows none of these. */
export interface Entry {
  handle: string;
  run: string;
  model: string;
  /** The thinking level the session is serving, from its own `thinking_level_change`. */
  level: string;
  sessionId: string;
  ownerPid: number;
  modelSource: string;
  startedAt: string;
}


function readEntry(handle: string): Partial<Entry> | null {
  try {
    return JSON.parse(readFileSync(`${registryDir()}/${handle}.json`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every entry in the registry, one bad file costing exactly one peer.
 *
 * Entries are written by independent processes, so a half-written file is a
 * normal thing to read. Parsing per file keeps that to one missing peer; a
 * single parse over the whole directory fails whole and empties the fleet.
 */
function allEntries(): Partial<Entry>[] {
  let names: string[] = [];
  try {
    names = readdirSync(registryDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Partial<Entry>[] = [];
  for (const n of names) {
    try {
      const parsed = JSON.parse(readFileSync(`${registryDir()}/${n}`, 'utf8'));
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // One unreadable file is one missing peer, not an empty fleet.
    }
  }
  return out;
}

/** Atomic: a model id containing a quote must never publish unparseable JSON. */
function publish(handle: string, entry: Entry): boolean {
  const dir = registryDir();
  const tmp = `${dir}/.${handle}.json.${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    renameSync(tmp, `${registryDir()}/${handle}.json`);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

function alive(pid: unknown): boolean {
  const n = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

type RegisterLock = { path: string; token: string };

function acquireRegisterLock(handle: string): RegisterLock | null {
  const dir = registryDir();
  const path = `${dir}/.${handle}.register.lock`;
  const token = randomUUID();
  mkdirSync(dir, { recursive: true });

  const create = (): RegisterLock | null => {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ ownerPid: process.pid, token })}\n`);
      return { path, token };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const acquired = create();
  if (acquired !== null) return acquired;

  // Recover only from a lock whose recorded process is proven gone. Malformed
  // state is ambiguity, not permission to remove another writer's lock.
  try {
    const recorded = JSON.parse(readFileSync(path, 'utf8'));
    if (alive(recorded?.ownerPid)) return null;
    if (typeof recorded?.ownerPid !== 'number') return null;
    rmSync(path);
  } catch {
    return null;
  }
  return create();
}

function releaseRegisterLock(lock: RegisterLock): void {
  try {
    const recorded = JSON.parse(readFileSync(lock.path, 'utf8'));
    if (recorded?.token === lock.token) rmSync(lock.path);
  } catch {}
}

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

/**
 * Resolve a user-typed target to an Orca address.
 *
 * Exact first. A non-exact PREFIX must resolve to exactly one live peer: with
 * `1657-spike` and `1657-styles` both up, resolving `1657` by sort order sends
 * worktree-specific detail to the wrong session. Ambiguity is an error, not a
 * guess.
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
  const seen = new Set<string>();
  const hits: Peer[] = [];
  for (const p of list) {
    const matches =
      p.peer.toLowerCase().startsWith(lower) ||
      (p.worktree.split('/').pop() || '') === want;
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

// ------------------------------------------------------------------ send --

export type MessageType = 'status' | 'question' | 'handoff';

/**
 * A MONOTONIC PER-SENDER SEQUENCE, so a lost message leaves a hole.
 *
 * WHY. Orca's receipt for `orchestration send` is the same string whether the
 * message arrived or vanished. Measured 2026-08-15: on Orca 1.4.182 a
 * dispatched worker on a second host sent 6 reports home, 3 arrived, and all 6
 * receipts read `Queued relay_<id> for Run home` with exit 0; on 1.4.183 the
 * same probe got 10/10 delivered and the SAME receipt string. Delivery got
 * fixed, the receipt did not, so neither end can tell the two cases apart from
 * the wire alone.
 *
 * A number the sender increments is the cheapest thing that can: the receiver
 * sees 4 after 2 and knows one message is gone, even though it can never learn
 * what was in it.
 *
 * SCOPE, HONESTLY. This covers ONLY messages routed through `sendToPeer` in
 * this layer. A worker that hand-rolls `orca orchestration send` directly —
 * which is exactly what Orca's own supervised spec boilerplate teaches it to do
 * for `--type status`/`worker_done` — carries no sequence and is invisible to
 * the gap check in `receive.ts`. That uncovered majority is the argument for
 * fixing the receipt upstream (see `docs/upstream/orca-ordinary-send-receipt.md`).
 *
 * PERSISTED, because the counter has to outlive a turn boundary: each send is a
 * fresh handler invocation and, on a restarted session, a fresh process. Keyed
 * by the sender identity rather than the process, so the same peer name keeps
 * one ascending series.
 */
function seqFile(sender: string): string {
  // The key rides into a filename, so anything that is not plainly a name is
  // flattened. Collisions merely share a counter; they cannot escape the dir.
  const safe = sender.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unnamed';
  return `${registryDir()}/seq/${safe}.json`;
}

/**
 * The number this send should carry, plus the commit that makes it permanent.
 *
 * The counter advances only when the send is ACCEPTED. A send that failed hard
 * is one the sender already knows about, and burning its number would make the
 * receiver cry loss over a message that was never on the wire.
 */
export function nextOutboundSequence(sender: string): {
  seq: number;
  commit: () => void;
} {
  const path = seqFile(sender);
  let last = 0;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const n = Number(raw?.seq);
    if (Number.isSafeInteger(n) && n > 0) last = n;
  } catch {
    // Absent or corrupt: start the series at 1. A receiver with no baseline
    // does not alarm, so a reset costs a missed check, never a false one.
  }
  const seq = last + 1;
  return {
    seq,
    commit(): void {
      try {
        mkdirSync(`${registryDir()}/seq`, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ seq, sender }));
        renameSync(tmp, path);
      } catch (err) {
        // A counter that cannot be persisted must not fail the send. It does
        // mean the next send reuses this number, which the receiver reports as
        // a duplicate — loud, and the right way round.
        console.error(`[orca-peer] sequence not persisted for ${sender}: ${err}`);
      }
    },
  };
}

/**
 * Send to a named peer, relaying through the shared parent when Orca refuses a
 * lateral send.
 *
 * SIBLING RELAY. A dispatch-bound worker may only send to the Run that owns its
 * dispatch, so a worker→worker lateral send comes back `dispatch_run_mismatch`.
 * Instead of failing, route through the shared parent: the parent's receiver
 * verifies the sender's attribution, re-posts to the target with the VERIFIED
 * origin stamped, and logs the relay. Children get lateral messaging, the
 * coordinator gets the audit trail for free.
 */
export function sendToPeer(o: {
  target: string;
  text: string;
  type?: MessageType;
}): { ok: boolean; via?: 'direct' | 'relay'; error?: string } {
  const text = o.text ?? '';
  if (!text.trim()) return { ok: false, error: 'refusing to send an empty message' };

  const resolved = resolveTarget(o.target);
  if (resolved.ambiguous)
    return {
      ok: false,
      error: `peer '${o.target}' is ambiguous — matches ${resolved.ambiguous.join(', ')}`,
    };
  if (!resolved.address)
    return { ok: false, error: `unknown peer '${o.target}'` };

  const me = selfPeer();
  // A SELF-ADDRESSED SEND IS NEVER THE INTENT, and it is the one failure that
  // cannot be seen from either end: Orca accepts it and delivers the message to
  // this very session, so a report that never reached its coordinator reads
  // exactly like one that arrived. Measured 2026-08-15: a dispatched child on
  // another host answered its coordinator for five hours and every answer came
  // home to itself — on that host the registry can only see local panes, so the
  // coordinator's name resolved to the only peer there was, the child. Its own
  // transcript said `my own report echoed back through the relay`; nothing on
  // the coordinator's side said anything at all.
  const selfAddress =
    me !== null && (resolved.address === `run:${me.run}` || resolved.address === me.handle);
  if (selfAddress || (me !== null && resolved.handle !== undefined && resolved.handle === me.handle))
    return {
      ok: false,
      error: `refusing to send to this session itself — '${o.target}' resolves to ${resolved.address}, which is this session. The peer you want is not reachable from this host, so its name matched the only pane here.`,
    };

  // The sender states BOTH a readable name and its own return address. The
  // receiver builds its "reply with …" line from the name, so a name the
  // recipient cannot resolve yields an instruction that fails on first use. A
  // return address must never be a free-text label — `replyTo` is the sender's
  // own Run.
  const from = me?.peer || process.env.ORCA_WORKSPACE_NAME || 'unregistered-session';
  const replyTo = me?.run ? { replyTo: `run:${me.run}` } : {};
  const type = o.type ?? 'status';
  // Allocated before the attempt, committed only once Orca accepts one of the
  // two routes: the number identifies THIS message on whichever route carries
  // it, and a message that never left must not consume one.
  const seq = nextOutboundSequence(from);

  const attempt = orcaRaw([
    'orchestration',
    'send',
    '--to',
    resolved.address,
    '--type',
    type,
    // The subject carries the readable name because Orca's own formatter shows
    // the raw handle, and a handle tells a reader nothing.
    '--subject',
    `peer:${from}`,
    '--body',
    text,
    '--payload',
    JSON.stringify({ peer: from, seq: seq.seq, ...replyTo }),
    '--json',
  ]);
  if (prop(attempt.parsed, 'ok') === true) {
    seq.commit();
    return { ok: true, via: 'direct' };
  }

  if (!attempt.text.includes('dispatch_run_mismatch'))
    return { ok: false, error: sendError(attempt) };

  const parent = parentPeer();
  if (!parent.peer)
    return {
      ok: false,
      error: `direct send refused (dispatch_run_mismatch) and no live parent to relay through — '${o.target}' is unreachable from this dispatch-bound session`,
    };

  const relay = orcaRaw([
    'orchestration',
    'send',
    '--to',
    `run:${parent.peer.run}`,
    '--type',
    type,
    '--subject',
    `peer:${from} \u2192 ${o.target}`,
    '--body',
    text,
    '--payload',
    JSON.stringify({
      peer: from,
      seq: seq.seq,
      forwardTo: resolved.address,
      forwardToName: o.target,
      ...replyTo,
    }),
    '--json',
  ]);
  if (prop(relay.parsed, 'ok') === true) {
    seq.commit();
    return { ok: true, via: 'relay' };
  }
  return { ok: false, error: `relay via parent failed: ${sendError(relay)}` };
}

function sendError(r: { parsed: unknown; text: string }): string {
  const message = prop(prop(r.parsed, 'error'), 'message');
  return (str(message) || r.text).slice(0, 200).trim();
}

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

// ------------------------------------------------------------ transcripts --

/**
 * The tail of a peer's own OMP transcript.
 *
 * A dispatched session is useless if the caller cannot see its conclusions, and
 * a session that produced no file has its answer only in its last message. OMP
 * persists every session as JSONL under `<agent dir>/sessions/<slug>/`, and the
 * `{"type":"session"}` record carries the exact cwd — so a worktree maps to a
 * transcript with no guessing.
 *
 * The slug is a lossy encoding of the cwd, so it narrows the search and never
 * decides it: the recorded cwd is what a match is made on.
 *
 * There is no spawn-time cutoff, because nothing writes `.agent/orca-spawn.json`
 * any more. The newest cwd match is the honest answer, and its path is returned
 * so a caller who suspects a stale session can look.
 */
export function transcriptFor(
  worktree: string,
  last = 1,
  sessionId = '',
): { path?: string; messages?: string[]; reason?: string } {
  const root = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.omp/agent`;
  const sessions = `${root}/sessions`;
  let slugs: string[] = [];
  try {
    slugs = readdirSync(sessions);
  } catch {
    return { reason: `no session store at ${sessions}` };
  }

  // Two peers can share a worktree — `derive` names them `<base>·<handle4>` for
  // exactly that reason — so "newest session in this directory" answers the same
  // thing for both (F-023). OMP names a transcript `<timestamp>_<sessionId>`, and a
  // peer publishes its session, so the session picks the file when it is known.
  // Newest-in-worktree stays the fallback: a legacy entry published no session, and
  // refusing when a transcript has been rotated away is worse than a worktree tail.
  let owned = '';
  let newest = '';
  let newestAt = 0;
  for (const slug of slugs) {
    let files: string[] = [];
    try {
      files = readdirSync(`${sessions}/${slug}`).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = `${sessions}/${slug}/${f}`;
      const head = readLines(path).slice(0, 20);
      let cwd = '';
      let at = 0;
      for (const line of head) {
        let rec: unknown = null;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (prop(rec, 'type') !== 'session') continue;
        cwd = str(prop(rec, 'cwd'));
        at = Date.parse(str(prop(rec, 'timestamp'))) || 0;
        break;
      }
      if (cwd !== worktree) continue;
      if (sessionId && f.includes(sessionId)) owned = path;
      if (at >= newestAt) {
        newestAt = at;
        newest = path;
      }
    }
  }
  const chosen = owned || newest;

  if (!chosen) return { reason: `no OMP transcript recorded for ${worktree}` };

  // The record wraps the message: `{type:"message", message:{role, content}}`.
  // Only assistant `text` parts are prose — `thinking` is not addressed to the
  // reader and `toolCall` is machinery, so both are dropped. A turn that only
  // called tools contributes nothing, which is why this collects the last N
  // messages that HAVE text rather than the last N records.
  const messages: string[] = [];
  for (const line of readLines(chosen)) {
    let rec: unknown = null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (prop(rec, 'type') !== 'message') continue;
    const message = prop(rec, 'message');
    if (str(prop(message, 'role')) !== 'assistant') continue;
    const text = textOf(prop(message, 'content'));
    if (text) messages.push(text);
  }
  return { path: chosen, messages: messages.slice(-Math.max(1, last)) };
}

/** OMP writes content as a string or as an array of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (prop(part, 'type') === 'text' ? str(prop(part, 'text')) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
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
