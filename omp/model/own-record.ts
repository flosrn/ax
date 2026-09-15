// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * "WHICH SESSION FILE IS MINE?", answered from ax's own write-ahead record
 * rather than from the host or from Orca.
 *
 * WHY THIS EXISTS (measured 2026-09-15, goodluckagency/ofmchat #253-#257).
 * Three children were dispatched carrying a correct `[omp role=… model=…]`
 * marker in their own first user message, and all three kept their BOOT model,
 * took no role and wrote no receipt. Their process log named the branch: twelve
 * `[orca-model]` lines, every one `factory instance …`, and not one outcome
 * line — the signature of the two SILENT branches, with `not-supervised`
 * excluded because the child held a pane handle. So `absent`, which means both
 * halves of the equipment path failed together:
 *
 *   `worker-list` carried no row for the handle — F-048's own drift, measured
 *   the same day as `worker-list reports 0 entry(ies)` on this machine — and
 *   the transcript fallback, reached because of it, could only read the file
 *   the HOST names. Nothing named one, so the marker was never read and the
 *   child implemented its ticket unequipped, in silence, by design.
 *
 * THE FIX IS TO STOP ASKING EITHER OF THEM. ax wrote the dispatch record before
 * it issued the mutation, and that record names the pane, the worktree and the
 * dispatch id. A child therefore holds everything needed to find its own
 * transcript offline: no Orca call, no `worker-list`, no host seam. That is
 * F-048's own lesson — `ax worker ls` was hardened to count by PANE rather than
 * by that index — applied to the one reader still trusting it.
 *
 * A JOIN, NOT A NEW DERIVATION, and that distinction is the whole design. Two
 * readers already answer the two halves, each with its own tests and refusals:
 *
 *   handle -> request       `dispatchIndex`, the same query `../../src/worker/
 *                           tail.mjs` makes to name a pane's owner. Its
 *                           authority rule is unmoved: only a `worker-start`
 *                           phase may name a dispatch.
 *   record -> session file  `briefDelivered`, which selects by DISPATCH ID and
 *                           never newest-wins, refuses two worktrees, refuses a
 *                           session older than the dispatch, and refuses zero
 *                           or two candidates (#204, #126).
 *
 * So every refusal here is inherited rather than re-decided, and NOTHING here
 * guesses. Two records naming one pane is an inability, not a pick: a repair
 * reuses the agent terminal, so that shape is real, and choosing between them
 * would apply another child's role to this session. An ambiguity is not an
 * answer (F-028).
 *
 * WHAT IT MUST NOT DO, stated because the tempting version is wrong: it must
 * never fall back to "the newest session in this directory". An operator who
 * opens a pane in a worktree that has run a child would then inherit that
 * child's role and tool fence. The record is what makes this exact instead of
 * plausible, and an absent record is an operator pane behaving normally — which
 * is why `no dispatch record` is a distinct, quiet reason rather than a fault.
 */

import { join } from 'node:path';

import { briefDelivered } from '../../src/worker/delivered.mjs';
import { defaultStore, dispatchIndex } from '../../src/worker/record.mjs';

export interface OwnSession {
  /** The child's own transcript, or `null` when it could not be established. */
  file: string | null;
  /** The request whose record names this pane, when one does. */
  request: string | null;
  /** Why no file — absent whenever one was found, never a reassurance. */
  reason?: string;
}

/**
 * The session file of the dispatch that placed THIS pane, or a named inability.
 *
 * `request` is reported even when `file` is not, because the two halves fail
 * for different reasons and the repairs differ: no record at all is an ordinary
 * interactive pane, while a record whose session cannot be established is a
 * dispatched child whose transcript is missing, moved or ambiguous.
 */
export function ownSessionFile(handle: string | null | undefined, env: Record<string, string | undefined> = process.env): OwnSession {
  const pane = String(handle ?? '').trim();
  if (pane === '') {
    return { file: null, request: null, reason: 'this session has no pane handle, so no dispatch record can be matched to it' };
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
    return { file: null, request: null, reason: `the dispatch store ${store} does not exist, so nothing here can name pane ${pane}` };
  }
  if (typeof index.reason === 'string' && index.reason !== '') {
    return { file: null, request: null, reason: `the dispatch store ${store} could not be read, so whether a record names pane ${pane} is UNKNOWN: ${index.reason}` };
  }

  const requests = [...new Set([...index.byDispatch.values()].filter((row) => row.handle === pane).map((row) => row.request))].sort();
  if (requests.length === 0) {
    // An unreadable record is not a record that does not name this pane. The
    // count travels so the reason cannot be read as an established absence.
    const unread = Array.isArray(index.unreadable) ? index.unreadable.length : 0;
    return {
      file: null,
      request: null,
      reason:
        unread > 0
          ? `no READABLE record in ${store} names ${pane} as its pane, and ${unread} record(s) there could not be read, so this is unestablished rather than absent`
          : `no dispatch record in ${store} names ${pane} as its pane`,
    };
  }
  if (requests.length > 1) {
    return {
      file: null,
      request: null,
      reason: `${requests.length} dispatch records name ${pane} as their pane (${requests.join(', ')}), so none of them is established as this session's`,
    };
  }
  const request = requests[0] as string;
  const seen = briefDelivered(join(store, `${request}.json`), { env });
  if (seen.known !== true || typeof seen.file !== 'string' || seen.file === '') {
    return { file: null, request, reason: seen.reason ?? `the record for ${request} names no readable session for this pane` };
  }
  return { file: seen.file, request };
}
