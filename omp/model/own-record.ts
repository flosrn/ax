// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * "WHICH RECORDED BRIEF IS MINE?", answered from ax's own write-ahead record
 * rather than from the host, Orca, or the child's session file.
 *
 * WHY THIS EXISTS (measured 2026-09-15, goodluckagency/ofmchat #253-#257).
 * Three children were dispatched carrying a correct `[omp role=… model=…]`
 * marker in their own first user message, and all three kept their BOOT model,
 * took no role and wrote no receipt. The first repair joined `worker-list`'s
 * absent row to ax's dispatch record and found the child's own transcript. It
 * fixed WHICH file to read, but still trusted WHEN that file held the brief.
 *
 * That final trust races. On #257 the child's transcript recorded its BOOT
 * `model_change` at 15:08:29.047 and did not flush the marker-bearing first user
 * turn until 15:08:33.337. `before_agent_start` had already spent its final
 * fallback on the partial file, read no marker and stayed silent by design. A
 * second child produced the same model/role absence under the same release.
 *
 * THE RECORD IS THE SOURCE, NOT A POINTER TO A LATER SOURCE. ax writes
 * `task-create --spec` before it opens the pane, byte-for-byte from the parent
 * brief. The same record names the pane. Joining pane -> record -> task spec is
 * therefore complete before the child's first hook can run: no Orca call, no
 * `worker-list`, no host seam and no session flush race.
 *
 * A JOIN, NOT A NEW DERIVATION. `dispatchIndex` owns which readable record a
 * pane belongs to, and `workerSpec` owns which `task-create --spec` value that
 * record dispatched. Every refusal is inherited rather than re-decided.
 * Nothing here guesses. Two records naming one pane is an inability, not a
 * pick: a repair can reuse an agent terminal, and choosing would apply another
 * child's role to this session (F-028).
 *
 * WHAT IT MUST NOT DO. Never fall back to the newest record or session in a
 * directory. An operator who opens a pane in a worktree that has run a child
 * would then inherit that child's role. An absent matching record is an
 * operator pane behaving normally — a distinct, quiet reason.
 */

import { join } from 'node:path';

import { defaultStore, dispatchIndex, workerSpec } from '../../src/worker/record.mjs';

export interface OwnDispatch {
  /** The exact task-create --spec text recorded before the pane was opened. */
  spec: string | null;
  /** The request whose record uniquely names this pane, when one does. */
  request: string | null;
  /** Whether at least one readable record names this pane, even ambiguously. */
  owned: boolean;
  /** Why no spec — absent whenever one was found, never a reassurance. */
  reason?: string;
}

/**
 * The recorded task spec of the dispatch that placed THIS pane, or a named
 * inability. The write-ahead record is the authority here: unlike the child's
 * session file, it already carries `task-create --spec` before the child's
 * first `before_agent_start` can fire.
 *
 * `owned` stays true when matching records are ambiguous: refusing to pick is
 * correct, but that dispatched child still needs a loud equipment warning.
 * `request` is present only when one record can be established. No matching
 * record is an ordinary interactive pane and remains quiet.
 */
export function ownDispatchSpec(handle: string | null | undefined, env: Record<string, string | undefined> = process.env): OwnDispatch {
  const pane = String(handle ?? '').trim();
  if (pane === '') {
    return { spec: null, request: null, owned: false, reason: 'this session has no pane handle, so no dispatch record can be matched to it' };
  }

  const store = defaultStore(env);
  // `dispatchIndex` DOES NOT THROW on a store it cannot read: it answers an
  // EMPTY `byDispatch` beside `missing` and `reason` (../../src/worker/
  // record.mjs). So a try/catch here would be theatre, and reading the empty map
  // as "no record names me" would render an INABILITY as the ordinary absence
  // that means "this is an operator's pane, stay quiet" — F-028, in the module
  // whose whole subject is that distinction. `dispatcherRunForPane` checks both
  // fields before trusting the map, and this mirrors it rather than inventing a
  // second discipline.
  const index = dispatchIndex(store);
  if (index.missing === true) {
    return { spec: null, request: null, owned: false, reason: `the dispatch store ${store} does not exist, so nothing here can name pane ${pane}` };
  }
  if (typeof index.reason === 'string' && index.reason !== '') {
    return { spec: null, request: null, owned: false, reason: `the dispatch store ${store} could not be read, so whether a record names pane ${pane} is UNKNOWN: ${index.reason}` };
  }

  const named = [...index.byDispatch.values()].filter((row) => row.handle === pane);
  const requests = [...new Set(named.map((row) => row.request))].sort();
  if (requests.length === 0) {
    // An unreadable record is not a record that does not name this pane. The
    // count travels so the reason cannot be read as an established absence.
    const unread = Array.isArray(index.unreadable) ? index.unreadable.length : 0;
    return {
      spec: null,
      request: null,
      owned: false,
      reason:
        unread > 0
          ? `no READABLE record in ${store} names ${pane} as its pane, and ${unread} record(s) there could not be read, so this is unestablished rather than absent`
          : `no dispatch record in ${store} names ${pane} as its pane`,
    };
  }
  if (requests.length > 1) {
    return {
      spec: null,
      request: null,
      owned: true,
      reason: `${requests.length} dispatch records name ${pane} as their pane (${requests.join(', ')}), so none of them is established as this session's`,
    };
  }
  const request = requests[0] as string;
  try {
    return { spec: workerSpec(join(store, `${request}.json`)), request, owned: true };
  } catch (error) {
    return { spec: null, request, owned: true, reason: `the record for ${request} carries no readable task spec: ${String(error)}` };
  }
}
