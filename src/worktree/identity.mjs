// Who a worktree is: its name, and the ticket number that seeds every
// deterministic choice made for it (dev port, Supabase port block).
//
// A stable seed is what makes a worktree's URL derivable from the ticket you
// are already reading instead of something to look up. The catch is that agent
// tooling names the branch and the directory after the issue TITLE, so the
// NUMBER survives nowhere on disk by default: `#412 fix(chat): threads` becomes
// `fix-chat-threads`. Whoever creates the worktree can recover the number from
// its own metadata and record it in a marker file, which is why the marker is
// consulted first here. Nothing in this module touches the network.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { stableSeed } from '../hash.mjs';

// Ordered from the most explicit marker to the loosest. Each pattern reads the
// number out of the SEGMENT that carries it, never out of the first digits
// found anywhere in the string — `feat/v2-migration-412` must yield 412, and
// `feat/agency-roles-and-near-flat-permissions` must yield nothing rather than
// a number that happens to sit inside a word.
const LABELLED = /(?:issue|issues|ticket|task|gh|github)[/_#.-]*([1-9][0-9]{0,4})/;
// A whole path/slug segment that is only a number: feat/412-chat, fix-613-ctx.
const OWN_SEGMENT = /(?:^|[/_-])([1-9][0-9]{1,4})(?:[/_-]|$)/;
// Human-created names that trail the number: publish-legal-modal-472.
const TRAILING = /(?:^|[^0-9])([1-9][0-9]{1,4})$/;

/** The issue number carried by a branch or directory name, or undefined. */
function issueFromSource(source) {
  if (!source) return undefined;
  const labelled = LABELLED.exec(source);
  if (labelled) return Number(labelled[1]);
  const segment = OWN_SEGMENT.exec(source);
  if (segment) return Number(segment[1]);
  // Only the last segment can trail a number: `472-old/new-work` trails nothing.
  const trailing = TRAILING.exec(source.slice(source.lastIndexOf('/') + 1));
  if (trailing) return Number(trailing[1]);
  return undefined;
}

/** The number recorded in the marker file, or undefined when there is none. */
function issueFromMarker(marker) {
  if (!marker) return undefined;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(marker, 'utf8')).issue;
  } catch {
    // No marker, an unreadable one, or a half-written one: fall through to
    // parsing, which is always available.
    return undefined;
  }
  const issue = typeof recorded === 'string' ? Number(recorded) : recorded;
  return Number.isInteger(issue) && issue > 0 ? issue : undefined;
}

/**
 * Identify a worktree.
 *
 * `issueSource` says which input the number came from, so a caller can report
 * WHY a port was chosen instead of presenting it as a magic constant.
 */
export function identify({ worktreePath, branch, marker } = {}) {
  const name = worktreePath ? basename(worktreePath) : undefined;

  let issue = issueFromMarker(marker);
  let issueSource = issue === undefined ? undefined : 'marker';

  if (issue === undefined) {
    issue = issueFromSource(branch);
    if (issue !== undefined) issueSource = 'branch';
  }
  if (issue === undefined) {
    issue = issueFromSource(name);
    if (issue !== undefined) issueSource = 'name';
  }

  return {
    name,
    branch,
    issue,
    issueSource,
    // The fallback for worktrees that carry no number at all: arbitrary, but
    // stable, so re-running setup keeps the URL already published.
    seed: stableSeed(branch || worktreePath || ''),
  };
}
