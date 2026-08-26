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

import { sessionFileForNeedle } from './transcript.mjs';

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
  const file = sessionFileForNeedle({ needle, request, env, sessionsRoot });
  if (file === null) {
    return {
      token: '',
      reason: `no single session file under a cwd slug ending in "${needle}"${request === '' ? '' : ` that names ${request}`} — this may not be a dispatched child, or its session is not on this host`,
    };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { token: '', reason: `${file} is unreadable: ${String(error.message ?? error)}` };
  }
  const lines = text.split('\n', PREAMBLE_LINES);
  for (const line of lines) {
    const found = CAPABILITY.exec(line);
    if (found !== null) return { token: found[0], reason: '' };
  }
  return {
    token: '',
    reason: `${file} carries no dispatch capability in its first ${PREAMBLE_LINES} lines — a supervised child is handed one in its preamble, so this session was very likely not dispatched as one`,
  };
}
