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
// `ensureSpecSubmitted` and `ax worker repair` both decided on the pane's
// cursor: no movement across one gap meant "held composer". A child that
// submitted its brief and is now WAITING ON A MODEL emits nothing either, so it
// read identically — and on that reading ax sent a phantom Enter and reported
// `SPEC WAS HELD unsent in the pane — one Enter submitted it`. On #56 that Enter
// went in at 10:49:48.203Z, eight seconds AFTER the child had recorded the
// brief. The claim was false, the orchestrator relayed it as measurement, and
// `ax worker repair` on the same reading would have delivered the whole spec a
// SECOND time.
//
// The session JSONL settles it. A submitted brief is a `message` entry with
// `role: 'user'` in the child's own session file — written by the child, not by
// the runtime that failed to notice it.
//
// SO THE AUTOMATIC ENTER IS GONE ENTIRELY. Once the witness is the session, a
// held composer cannot be recognised automatically at all: the only token tying
// a session to one dispatch is the `ctx_…` in Orca's preamble, and an
// unsubmitted preamble is exactly what a held composer is holding. The Enter now
// has one owner, `ax worker repair`, invoked against one named request, which
// measures the pane before it decides.
//
// AND RECEIPT IS NOT LIVENESS. A `delivered` answer says the brief arrived, not
// that anyone is still there — a child can record its brief and then crash.
// AGENTS.md is explicit that liveness is cursor movement, so the `heldRepairAt`
// marker (which silences the watcher's death check) is written only where BOTH
// proofs exist: `ax worker repair` on an emitting pane whose session holds the
// brief.
//
// THREE ANSWERS, NEVER TWO. `known:false` is not "no brief": an absent session
// directory, an ambiguous slug and an unreadable file all mean this witness
// cannot testify, and the caller must refuse rather than treat silence as proof
// either way (F-028).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { sessionFileForNeedle, stampOf, worktreesOf } from './transcript.mjs';

/**
 * The newest `worker-start` phase's dispatch id and issue time, or `''`.
 *
 * ONLY a `worker-start` phase may name a dispatch — every other phase that
 * happens to carry a `dispatchId` is display metadata. That rule, and the
 * `beganAt` floor below, are record.mjs's (`dispatchIndex`), and they are
 * restated here rather than re-derived loosely: a witness that picks a different
 * dispatch than the verb deciding whether a pane may be closed is worse than no
 * witness.
 *
 * WHY THE ID AT ALL: it is the one token identifying one dispatch inside a
 * worktree's session history. Measured 2026-08-24 on the live #56 file, every
 * session record carries `cwd`
 * (`{"type":"session",…,"cwd":"…/.worktrees/56-work"}`), so the request id
 * matches EVERY session ever opened in that worktree, a stranger's included.
 * `ctx_…` is minted per Dispatch and injected into the worker's preamble, and it
 * was verified present in that same file.
 *
 * WHY `beganAt`: "a record claimed at 10:00 whose worker-start ran at 11:00
 * would accept a 10:30 comment as after the dispatch" — a `--resume` or
 * `--replace` can issue its mutation hours after the record was claimed, and
 * `createdAt` is only the fallback for records written before the field existed.
 */
function newestDispatch(rec) {
  const attempts = Array.isArray(rec.attempts) ? rec.attempts : [];
  for (let a = attempts.length - 1; a >= 0; a -= 1) {
    const phases = Array.isArray(attempts[a].phases) ? attempts[a].phases : [];
    for (let p = phases.length - 1; p >= 0; p -= 1) {
      const phase = phases[p];
      if (phase.name !== 'worker-start') continue;
      const id = ((phase.receipt ?? {}).result ?? {}).dispatchId;
      if (typeof id === 'string' && id !== '') return { id, issuedAt: String(phase.beganAt ?? '') };
    }
  }
  return { id: '', issuedAt: '' };
}

/**
 * `{ known: false, reason }` | `{ known: true, delivered, at, lastAt, count, file }`.
 *
 * `at` is the child's own timestamp for the BRIEF — the first user message —
 * which is the number that makes an `agent_prompt_stalled` verdict falsifiable:
 * compare it with the moment the dispatch settled.
 *
 * `count` and `lastAt` answer a DIFFERENT question, and the incident that asked
 * it (2026-08-26) is why the scan no longer stops at the first hit: an
 * orchestrator sent three steering messages to a child whose pane was VIVANT and
 * whose transcript was readable, and all three sat at `delivered_at: null` for an
 * hour. The child opened its pull request without them, and the loss became
 * visible only at review. A send receipt cannot distinguish "queued" from
 * "never", and the pane cannot either — but the child's own session can: a
 * delivered injection lands there as another `role: 'user'` entry. So `count ===
 * 1` means the brief arrived and NOTHING since, and `lastAt` is what an
 * orchestrator compares against the moment it sent.
 *
 * Delivery is still not liveness, and neither is a count.
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
  // THE DISPATCH ID SELECTS THE SESSION, and newest-wins never does. A worktree
  // outlives a dispatch: an operator who opens a pane there to look around, or a
  // later `--replace`, leaves a NEWER history whose first user message has
  // nothing to do with this brief. Handing that over as proof would suppress a
  // genuine repair and write the marker that tells the watcher a child runs.
  //
  // The request id cannot draw that line — every session record carries `cwd`,
  // so it names the worktree whoever opened it. `sessionFileForNeedle` takes any
  // content needle, and the one that is unique per dispatch is `ctx_…`. Zero or
  // two matches is an inability to testify, which is the safe direction (F-028).
  const { id: dispatchId, issuedAt } = newestDispatch(rec);
  if (dispatchId === '') {
    return { known: false, reason: `the record at ${recordPath} names no dispatched worker, so no session can be tied to it` };
  }
  const file = sessionFileForNeedle({ needle: basename(worktree), request: dispatchId, env, sessionsRoot });
  if (file === null) return { known: false, reason: `no single session under ${worktree} names ${dispatchId}` };

  // And a session older than the mutation that created the pane cannot be that
  // pane's, whatever it names. The floor is the dispatching phase's own
  // `beganAt` — `createdAt` only for records written before that field existed,
  // because a resume or replace issues its mutation long after the claim.
  const stamp = stampOf(basename(file));
  const floor = Date.parse(issuedAt || String(rec.createdAt ?? ''));
  if (stamp !== null && !Number.isNaN(floor) && stamp < floor) {
    return { known: false, reason: `the session for ${worktree} predates this dispatch, so it is another agent's history` };
  }

  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch (error) {
    return { known: false, reason: `the session at ${file} is unreadable: ${String(error.message ?? error)}` };
  }

  let at = '';
  let lastAt = '';
  let count = 0;
  for (const line of lines) {
    // Cheap pre-filter, then parse: these files reach thousands of lines, and
    // only the `"user"` ones can carry the answer.
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
    const stampedAt = String(entry.timestamp ?? '');
    if (count === 0) at = stampedAt;
    lastAt = stampedAt;
    count += 1;
  }

  if (count === 0) return { known: true, delivered: false, count: 0, file };
  return { known: true, delivered: true, at, lastAt, count, file };
}
