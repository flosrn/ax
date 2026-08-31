// The dispatch capability a supervised child was handed — read from the child's
// OWN session, because that is the only place on this machine that holds it.
//
// WHY THIS EXISTS (measured 2026-08-26, ofmchat #78 and #79, two independent
// triage dispatches). `ax triage ask` composed `orca orchestration ask` with
// neither `--from` nor `--dispatch-capability` and was refused
// `dispatch_capability_invalid: The Dispatch capability is missing` (exit 3,
// through the generic branch, so the child got no repair and improvised). The
// wrapper was stripping the very authorization Orca had handed the child.
//
// The two halves resolve DIFFERENTLY, and only one of them needed fixing:
//   - `--from` self-resolves. `orca`'s own handler reads `ORCA_TERMINAL_HANDLE`,
//     then `ORCA_PANE_KEY`, and a command run inside a live pane inherits both
//     (src/cli/handlers/orchestration/terminal-identity.ts in the Orca fork).
//   - the capability has NO env fallback. The handler takes it from the
//     `--dispatch-capability` flag and from nowhere else
//     (orchestration/question-handler.ts), and no `ORCA_*CAPABILITY` variable
//     exists anywhere in that source. A child's env cannot carry it, which is
//     why the child that reported this found none.
//
// So the token must be re-typed by whoever has it, and the child does: Orca's
// injected preamble embeds `--dispatch-capability <token>` in every command it
// teaches (orchestration/preamble.ts, capabilityFlag). That preamble is the
// child's first user message, so it is on disk in the child's own session file
// — the same file ../worker/delivered.mjs and ../worker/transcript.mjs already
// read, and the token ../redact.mjs already knows the shape of.
//
// READING IT IS NOT A LEAK. The exposure is Orca's design: the preamble puts
// this token in the child's context precisely so the child can put it on an
// argv. What is refused, here as everywhere, is DISPLAYING it — every caller
// still emits through redactSecrets(), and this module never prints.

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

import { sessionFilesForCwd, sessionFilesForNeedle } from './transcript.mjs';

/** The token shape, single-match — ../redact.mjs owns the global-replace copy. */
const CAPABILITY = /\bdcap_[A-Za-z0-9_-]+/;

/**
 * THE BOUND IS THE DISCRIMINANT, not a performance trick — measured over the 859
 * session files on this machine, of which 227 carry a raw token:
 *
 *   first token at line   min 5 · median 7 · p90 8 · max 1651
 *   beyond line 10:  12 files      beyond line 40:  11 files
 *
 * So the preamble cluster ends at line ~8, exactly one file falls between 11 and
 * 40, and everything past that is a DIFFERENT phenomenon: a session that was
 * never handed a capability but mentions one later — a coordinator quoting a
 * child's command, or a session reasoning about this very code. Taking that
 * token would hand one dispatch's grant to another caller.
 *
 * BOTH DIRECTIONS, because a reader arrives with a symptom and not with a
 * theory. Raise it (or drop the bound) and this answers "here is your
 * capability" to a session that has none, handing one dispatch's grant to
 * another caller. Lower it below the cluster and a real dispatched child reads
 * as undispatched, so its ask goes out unauthorized and is refused.
 *
 * The asymmetry is the part worth reading if only one line is read: too LOW
 * costs a refusal the caller can act on — the flag, named in that refusal, is
 * the way through. Too HIGH costs a wrong grant, which nothing downstream can
 * detect. When in doubt, err low.
 */
const PREAMBLE_LINES = 40;

/**
 * The capability this session was dispatched with, or a named inability.
 *
 * Never a bare `''`: an absent token and an unreadable session are different
 * facts, and a caller that cannot tell them apart reports the wrong one (F-028).
 * `reason` is what the refusal prints; `token` is never printed.
 */
export function ownCapability({ cwd = process.cwd(), request = '', env = process.env, sessionsRoot } = {}) {
  const needle = basename(cwd);
  // THIS checkout's own directory first. The caller holds the whole cwd, and the
  // slug it produces is unique by construction, so inheriting the basename tail
  // match's ambiguity would be self-inflicted: two checkouts named `ofmchat`
  // made that lookup refuse, and the refusal reached a child as "this may not be
  // a dispatched child" (measured 2026-08-27). The tail match stays as the
  // fallback for a session recorded under a different HOME than this process
  // sees, which is the only case it still answers.
  const own = sessionFilesForCwd({ cwd, env, sessionsRoot });
  const exact = own.found;
  const files = exact ? own.files : sessionFilesForNeedle({ needle, env, sessionsRoot });
  if (files.length === 0) {
    return {
      token: '',
      reason: exact
        ? `${own.dir} holds no readable session for this checkout — this may not be a dispatched child, or its session was pruned`
        : `no session directory for ${cwd} (nor one whose slug ends in "${needle}") — this may not be a dispatched child, or its session is not on this host`,
    };
  }

  // THE PREAMBLE IS THE DISCRIMINANT, and it has to be, because a whole-file
  // match is not one. Measured 2026-08-27 on ofmchat #87 and #88: triage places
  // the child in the CURRENT checkout, so the coordinator's own session file
  // sits in the same slug directory — and the coordinator typed the request id
  // when it dispatched. Selecting on `includes(request)` over the whole file
  // therefore matched BOTH, read as ambiguity, and told a genuine dispatched
  // child it might not be one. Two children hit it on two issues.
  //
  // Only the child is handed a capability, and only in the preamble Orca injects
  // as its first message. So a candidate has to carry a token WITHIN the bound,
  // and — when a request is named — its own request there too. That keeps the
  // "a token mentioned late is not a grant" rule intact, since nothing outside
  // the bound is ever considered.
  const candidates = [];
  const unreadable = [];
  for (const file of files) {
    let head;
    try {
      head = readFileSync(file, 'utf8').split('\n', PREAMBLE_LINES).join('\n');
    } catch (error) {
      unreadable.push(`${file} (${String(error.message ?? error)})`);
      continue;
    }
    const found = CAPABILITY.exec(head);
    if (found === null) continue;
    if (request !== '' && !head.includes(request)) continue;
    candidates.push({ file, token: found[0] });
  }

  if (candidates.length === 1) return { token: candidates[0].token, reason: '' };
  if (candidates.length > 1) {
    // Never newest-wins: handing one dispatch's grant to another caller is the
    // failure nothing downstream can detect. And it says WHICH refusal this is —
    // the shipped message read "no single session file … this may not be a
    // dispatched child", whose vocabulary describes an ABSENCE while the real
    // condition was two matches, and whose offered causes were therefore both
    // false. The child that hit it read "this channel does not exist for me" and
    // slid toward the irrecoverable branch instead of passing the token.
    return {
      token: '',
      reason: `${candidates.length} candidate session files under ${exact ? cwd : `a slug ending in "${needle}"`} carry a dispatch capability${request === '' ? '' : ` naming ${request}`} in their first ${PREAMBLE_LINES} lines — which one is THIS session cannot be established; pass --dispatch-capability to disambiguate`,
    };
  }
  // The THIRD arm, and the third time this vocabulary misrouted the child that
  // reported it. It used to conclude "very likely not dispatched as one", which
  // is only one of the conditions that land here. The others are real: a
  // dispatched child whose session file is recorded under a different checkout
  // slug than the directory it is running in — plausible in any repository that
  // uses worktrees — and a preamble this scan's bound deliberately did not
  // reach. So the reason names what it KNOWS (no token inside the bound, in the
  // sessions it was allowed to look at) and offers the one gesture that settles
  // every branch, rather than asserting a cause it cannot support.
  return {
    token: '',
    reason: `no session under ${exact ? cwd : `a slug ending in "${needle}"`} carries a dispatch capability${request === '' ? '' : ` naming ${request}`} in its first ${PREAMBLE_LINES} lines — so this session was not dispatched as a supervised child, or its session file is recorded under a different checkout slug than the directory it runs in; pass --dispatch-capability if your preamble holds the token${unreadable.length > 0 ? `. Unreadable: ${unreadable.join(', ')}` : ''}`,
  };
}
