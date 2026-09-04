// The Report's path — one rule, derived from the dispatch record alone.
//
// A worker's completion carries a three-sentence Summary; the Report is the
// file that holds the criteria and the evidence. Its location is not an
// argument the worker passed, not `payload.reportPath`, and not a default.
// Every party derives it independently from the same record, the way
// `draftPath` already derives a triage draft from the request id
// (`docs/adr/0002`).
//
// The worktree is the one `ax worker transcript` already resolves: the unique
// `{kind:'worktree'}` effect on the record (`worktreesOf` in ./transcript.mjs).
// Zero or two worktrees is an inability to establish, named — never `""` and
// never a guessed directory. The request is the record's own key.

import { isAbsolute, join } from 'node:path';

import { worktreesOf } from './transcript.mjs';

/** Where every implementation Report lives, relative to the child's worktree. Gitignored, by design. */
export const REPORT_DIR = join('.scratch', 'report');

/**
 * `{ path }` | `{ reason }`.
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
  const request = rec.request;
  if (typeof request !== 'string' || request === '') {
    return { reason: 'the record names no request, so the Report path cannot be established' };
  }
  const path = join(trees[0], REPORT_DIR, `${request}.md`);
  if (!isAbsolute(path)) {
    return { reason: "the record's worktree is not absolute, so the Report path cannot be established" };
  }
  return { path };
}
