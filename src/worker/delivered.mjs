// Did the child's own session RECORD the brief? The one witness that outranks
// every receipt and every cursor.
//
// WHY THIS EXISTS (measured 2026-08-24, ofmchat #55/#56/#58 and the 12 triage
// dispatches before them)
// `worker-start` settled `state=failed stage=dispatch_input
// lastError=agent_prompt_stalled` on 15 of 15 dispatches into a cold `omp`
// pane, and every one of those children had the brief and was working. The
// stall is not a lost Enter. Orca 1.4.188 (`app.asar`, `out/main/index.js`)
// pastes the brief, writes `\r`, then `verifyAgentPromptSubmission` polls for
// AGENT_PROMPT_EFFECT_TIMEOUT_MS = 5000 ms and throws `agent_prompt_stalled`
// unless `workingSequence` advances. That counter has exactly one source:
// `recordAgentPromptLifecycleState`, fed by `detectAgentStatusFromTitle`, which
// answers `working` only for an OSC title carrying a braille spinner — and the
// titlebar extension (Orca's own bundled template included) arms that spinner
// at `agent_start`. A cold OMP session cannot reach `agent_start` in 5 s: on
// #56 the brief was recorded by the child at 10:49:40.338Z and its first turn
// activity appeared at 10:49:46.19Z. So Orca revokes the capability of a
// healthy worker, deterministically, and the failure is upstream of this
// package.
//
// WHAT THAT COST HERE, and why the cursor cannot answer it
// `ensureSpecSubmitted` and `ax worker repair` both decide on the pane's
// cursor: no movement across one gap means "held composer". A child that
// submitted its brief and is now WAITING ON A MODEL emits nothing either, so it
// reads identically — and on that reading ax sent a phantom Enter and reported
// `SPEC WAS HELD unsent in the pane — one Enter submitted it`. On #56 that
// Enter went in at 10:49:48.203Z, eight seconds AFTER the child had recorded
// the brief. The claim was false, the coordinator relayed it as measurement,
// and `ax worker repair` on the same reading would have delivered the whole
// spec a SECOND time.
//
// The session JSONL settles it. A submitted brief is a `message` entry with
// `role: 'user'` in the child's own session file — written by the child, not by
// the runtime that failed to notice it.
//
// THREE ANSWERS, NEVER TWO. `known:false` is not "no brief": an absent session
// directory, an ambiguous slug and an unreadable file all mean this witness
// cannot testify, and the caller must fall back to its own evidence rather than
// treat silence as proof either way (F-028).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { sessionFileForNeedle, stampOf, worktreesOf } from './transcript.mjs';

/**
 * `{ known: false, reason }` | `{ known: true, delivered: boolean, at, file }`.
 *
 * `at` is the child's own timestamp for the brief, which is the number that
 * makes an `agent_prompt_stalled` verdict falsifiable: compare it with the
 * moment the dispatch settled.
 */
export function briefDelivered(recordPath, { env = process.env, sessionsRoot } = {}) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    return { known: false, reason: `the record at ${recordPath} is unreadable: ${String(error.message ?? error)}` };
  }

  let trees;
  try {
    trees = worktreesOf(rec);
  } catch {
    trees = [];
  }
  // A worker owns exactly one worktree. Two is a record that cannot say which
  // session belongs to this dispatch, and the wrong session proves the wrong
  // thing — the same refusal `ax worker transcript` makes for the same reason.
  if (trees.length !== 1) {
    return {
      known: false,
      reason: trees.length === 0
        ? 'the record names no worktree, so the child session cannot be located'
        : `the record names ${trees.length} worktrees, so no single child session belongs to it`,
    };
  }

  const worktree = trees[0];
  const file = sessionFileForNeedle({ needle: basename(worktree), env, sessionsRoot });
  if (file === null) return { known: false, reason: `no single session file answers for ${worktree}` };

  // A session that predates the dispatch is a PREVIOUS agent's history in the
  // same worktree, and reading its brief as this one's would prove delivery
  // that never happened. The record's own creation time is the floor.
  const stamp = stampOf(basename(file));
  const floor = Date.parse(String(rec.createdAt ?? ''));
  if (stamp !== null && !Number.isNaN(floor) && stamp < floor) {
    return { known: false, reason: `the newest session for ${worktree} predates this dispatch, so it is another agent's history` };
  }

  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch (error) {
    return { known: false, reason: `the session at ${file} is unreadable: ${String(error.message ?? error)}` };
  }

  for (const line of lines) {
    // Cheap pre-filter, then parse: these files reach thousands of lines and
    // the answer is normally in the first few.
    if (line === '' || !line.includes('"user"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A truncated line is skipped, never fatal: the file is being appended to
      // by the very child being measured.
      continue;
    }
    if (entry?.type !== 'message' || (entry.message ?? {}).role !== 'user') continue;
    return { known: true, delivered: true, at: String(entry.timestamp ?? ''), file };
  }

  return { known: true, delivered: false, file };
}
