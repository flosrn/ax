/**
 * Which session an extension belongs to, and how it ignores every other one.
 *
 * A `task` subagent runs IN THE SAME PROCESS as its lead: same pid, same
 * `ORCA_TERMINAL_HANDLE`, same loaded module. So a PID latch cannot tell them
 * apart, and neither can an inherited env var — there is nothing to inherit
 * across, because there is no second process. What differs is the session.
 *
 * Unguarded, the damage is concrete and has been paid for: a subagent
 * republishes the lead's registry entry, pointing every peer's mailbox at a Run
 * that dies with the subagent, and it can fire a completion report AS the lead.
 *
 * Three extensions need exactly this discrimination — `orca-peer`,
 * `orca-report`, `orca-checkpoint` — and each carried its own verbatim copy. A
 * guard reasoned about this carefully and then maintained in triplicate is a
 * guard that will diverge, in the direction nobody notices, because the copy
 * that drifts is the one whose extension is quiet that week.
 *
 * A FACTORY, not shared state. Each extension keeps its own latch, exactly as
 * the three copies did, so this replaces an implementation and changes no
 * behaviour.
 *
 * That distinction is the whole safety argument. Each extension keeps its own
 * latch, and every `session_start` callsite first applies
 * `isSubagentSession(ctx)`. The structural check survives the loader's
 * cache-busted fresh module evaluation; the latch then separates later events
 * inside the accepted top-level module instance.
 *
 * The latch is still not the whole peer guard. What protects the registry
 * across processes is the ownership fence in `omp/peer/address.ts`, where
 * `register` refuses a differing `sessionId` whose recorded `ownerPid` is
 * alive. Keep both.
 */

export interface SessionOwner {
  /**
   * First non-empty `session_start` wins. Never overwrites: a subagent gets a
   * `session_start` too, and it must not steal the lead.
   */
  claim(ctx: unknown): void;
  /**
   * Compare-only. Fails CLOSED while unclaimed: either `session_start` has not
   * fired yet, or the ctx carried no resolvable id.
   *
   * Pi emits `session_start` with reason `"reload"` on `/reload-plugins`, and a
   * reload re-imports the module and resets the latch, so the lead reclaims on
   * the next start. That is preferable to weakly latching the first event of
   * any kind: a child's `tool_result` / `agent_end` can fire before the parent
   * tool returns, so the child would win the latch, report the lead's job as
   * done, and then reject every later lead event.
   */
  isForeign(ctx: unknown): boolean;
}

/** The session id behind a pi `ctx`, or `''` when it cannot be read. */
export function sessionIdOf(ctx: unknown): string {
  try {
    const sm =
      ctx && typeof ctx === 'object' && 'sessionManager' in ctx
        ? (ctx as Record<string, unknown>).sessionManager
        : undefined;
    const get =
      sm && typeof sm === 'object' && 'getSessionId' in sm
        ? (sm as Record<string, unknown>).getSessionId
        : undefined;
    if (typeof get === 'function') return String(get.call(sm) ?? '');
  } catch {}
  return '';
}

const SESSION_ID_DIR = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]{36}$/i;

/**
 * Structural across fresh extension evaluations: a top-level session file is
 * `<slug>/<timestamp>_<uuid>.jsonl`; a task subagent is one directory deeper,
 * under the top-level session id.
 */
export function isSubagentSession(ctx: unknown): boolean {
  const sm =
    ctx && typeof ctx === 'object' && 'sessionManager' in ctx
      ? (ctx as Record<string, unknown>).sessionManager
      : undefined;
  const get =
    sm && typeof sm === 'object' && 'getSessionFile' in sm
      ? (sm as Record<string, unknown>).getSessionFile
      : undefined;
  if (typeof get !== 'function') return false;
  const file = get.call(sm);
  if (typeof file !== 'string' || file === '') return false;
  const slash = file.lastIndexOf('/');
  if (slash <= 0) return false;
  const parent = file.slice(0, slash);
  return SESSION_ID_DIR.test(parent.slice(parent.lastIndexOf('/') + 1));
}

export function createSessionOwner(): SessionOwner {
  let owner: string | null = null;
  return {
    claim(ctx) {
      if (owner !== null) return;
      const sid = sessionIdOf(ctx);
      if (sid) owner = sid;
    },
    isForeign(ctx) {
      if (owner === null) return true;
      return owner !== sessionIdOf(ctx);
    },
  };
}
