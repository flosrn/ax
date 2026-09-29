// The Report's path — one rule, and every party derives it from the same two
// values rather than being told one.
//
// A worker's completion carries a three-sentence Summary; the Report is the
// file that holds the criteria and the evidence. Its location is not an
// argument the worker passed, not `payload.reportPath`, and not a default —
// the way `draftPath` already derives a triage draft from the request id
// (`docs/adr/0002`).
//
// TWO CALLERS, ONE FUNCTION. A completion is read from a dispatch RECORD, so
// `reportPath` resolves the worktree the way `ax worker transcript` does: the
// unique `{kind:'worktree'}` effect (`worktreesOf` in ./transcript.mjs). Zero
// or two worktrees is an inability to establish, named — never `""` and never a
// guessed directory. A dispatch composing the brief holds those two values
// already and has no record yet, so it crosses `reportPathFor` instead; the
// brief is handed the ANSWER and never the recipe (./brief.mjs).
//
// A THIRD CALLER HOLDS ONLY THE REQUEST: a dispatch onto another host with
// `--worktree new-top-level`, whose tree the host creates inside the start call
// — after the brief is written, and at a path (a taken name is suffixed) no
// read beforehand can establish. What IS established is where the brief lands:
// Orca pastes it into the agent terminal it created in that very tree, so the
// file under the child's own worktree root is the file the receiver later
// derives from the record's effect. `reportPathWithin` answers that tail, and
// nothing else — it never invents the root (F-028).
//
// The request is checked against `requestIdOk` — the same grammar every other
// worker verb uses — so a `../../outside` cannot join() out of `.scratch/report`.

import { isAbsolute, join } from 'node:path';

import { requestIdOk } from './record.mjs';
import { worktreesOf } from './transcript.mjs';

/** Where every implementation Report lives, relative to the child's worktree. Gitignored, by design. */
export const REPORT_DIR = join('.scratch', 'report');

/**
 * The rule itself, on the two values a record carries: `{ path }` | `{ reason }`.
 *
 * A dispatch composes the brief BEFORE its record exists — it holds the worktree
 * it is about to place a child in and the request id it is about to write, not a
 * receipt it can read. Deriving the path there would be a second copy of this
 * rule, and two copies disagree the day one moves, so that caller crosses this
 * function too (`src/worker/brief.mjs` receives the ANSWER, never the recipe).
 *
 * A worktree nobody named is an absence, not a location, and a relative one
 * would resolve against whatever process read it. Both are named inabilities
 * (F-028), because the receiver opens the derived path and nothing else. A tree
 * on another host is named here whenever its selector carries the path (reuse,
 * or an exact `--worktree`); one the host has yet to create goes through
 * `reportPathWithin` instead.
 */
export function reportPathFor({ worktree = '', request = '' } = {}) {
  if (!isAbsolute(worktree)) {
    return {
      reason:
        worktree === ''
          ? 'no worktree is named on this host, so the Report path cannot be established'
          : `the worktree '${worktree}' is not absolute, so the Report path cannot be established`,
    };
  }
  if (!requestIdOk(request)) {
    return { reason: 'the request violates the request-id grammar, so the Report path cannot be established' };
  }
  return { path: join(worktree, REPORT_DIR, `${request}.md`) };
}

/**
 * `{ within }` | `{ reason }`: the Report's path RELATIVE to the worktree the
 * child was started in, for a dispatch whose tree has no path yet
 * (`--on <host> --worktree new-top-level`). The root is the child's to read from
 * where it stands; the receiver resolves the same tail against the worktree the
 * record's effect names, which is that same tree.
 */
export function reportPathWithin(request = '') {
  if (!requestIdOk(request)) {
    return { reason: 'the request violates the request-id grammar, so the Report path cannot be established' };
  }
  return { within: join(REPORT_DIR, `${request}.md`) };
}

/**
 * `{ path }` | `{ reason }`, for a dispatch RECORD — the shape every party that
 * reads a completion holds.
 *
 * `path` is `<worktree>/.scratch/report/<request>.md`, absolute. Failure
 * carries `reason` and no `path` key, so a caller cannot read an empty string
 * as a location (F-028).
 */
export function reportPath(rec) {
  const trees = worktreesOf(rec);
  if (trees.length !== 1) {
    return {
      reason:
        trees.length === 0
          ? 'the record names no worktree, so the Report path cannot be established'
          : `the record names ${trees.length} worktrees, so which Report path it means cannot be established`,
    };
  }
  // Everything past the record's own resolution is the shared rule's to answer,
  // reason included: a second wording of "this request is malformed" is a second
  // rule to keep in step.
  return reportPathFor({ worktree: trees[0], request: (rec ?? {}).request });
}
