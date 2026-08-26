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
 * The preamble is turn ONE, so a bounded scan finds it or it is not there. An
 * unbounded read would page a session that reaches thousands of lines to prove
 * a negative the first few lines already settle.
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
