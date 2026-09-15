// The one emission boundary for `src/debug-as/`.
//
// Every other directory in this package writes through `src/log.mjs` directly,
// and that is correct there: a worktree plan, a dispatch record and a merge
// ground carry no credentials. A debug session does. It resolves a service-role
// key into memory, receives a provider's `hashed_token`, prints a relay URL an
// operator must be able to tap, and tails an adapter's standard error — four
// paths on which a leak is one interpolation away.
//
// So R35 makes the rule structural rather than careful: no module in this
// directory imports `src/log.mjs`, and `tests/debug-as-emit.test.mjs` reads the
// directory to prove it. Redaction cannot be forgotten at a call site, because
// no call site has the unredacted function.
//
// TWO KINDS OF SECRET, one pass. The shapes live in `src/redact.mjs` with the
// dispatch-capability vocabulary they extend. The VALUES — whatever this
// project's `.env.local` happens to say — cannot be patterned at all, so a
// caller that resolves one registers it here, once, and every later emission is
// covered whether or not the value looked like a credential.
//
// The stream choices are `src/log.mjs`'s, unchanged and deliberately so: a
// payload stays a bare payload on stdout (`ax debug-as status` is parsed by an
// agent), and a refusal stays on stderr with its repair.

import * as log from '../log.mjs';
import { redactSecrets } from '../redact.mjs';

/** Values resolved at runtime, unprintable for the rest of the process. */
const registered = new Set();

/**
 * Register resolved secret values. Accepts any iterable so a caller can pass a
 * `Set`, an array, or the values of a lookup it just performed.
 *
 * A value too short to be anything but a word is ignored by `src/redact.mjs`:
 * blacking out `ab` everywhere would destroy findings without protecting a
 * credential.
 */
export function addSecrets(values) {
  for (const value of values ?? []) if (typeof value === 'string') registered.add(value);
}

/** Tests only: the registry is process-wide, so a suite must be able to reset it. */
export function resetSecrets() {
  registered.clear();
}

/** The redaction every function below applies. Exported for callers that build a message before emitting it. */
export const scrub = text => redactSecrets(text, { values: registered });

/** Wrap one `src/log.mjs` emitter so every string argument is scrubbed first. */
const guarded = emitter => (...args) => emitter(...args.map(value => (typeof value === 'string' ? scrub(value) : value)));

export const section = guarded(log.section);
/** The payload, byte for byte on stdout — no glyph, no indent (`src/log.mjs` `raw`). */
export const raw = guarded(log.raw);
export const ok = guarded(log.ok);
export const bad = guarded(log.bad);
export const note = guarded(log.note);
export const fix = guarded(log.fix);
export const refuse = guarded(log.refuse);
export const warn = guarded(log.warn);
export const status = guarded(log.status);
export const fatal = guarded(log.fatal);

/**
 * One step line on stderr while a launch is in progress.
 *
 * Named separately from `status` because the reason it exists is a contract
 * (R10, F1): opening a Role browser resolves Playwright, runs a project adapter
 * that may compile a cold Next.js app, launches Chromium and probes CDP. With
 * no line per step, a legitimate two-minute wait is indistinguishable from a
 * hang, and an operator kills an authenticating session.
 */
export const progress = message => status(message);

/**
 * One line a LIVE LISTENER says about itself, on stderr.
 *
 * Separate from `note` (stdout) because of when it happens: the relay keeps
 * serving after the launch payload was written, so a request-time line on
 * stdout is appended to whatever the reader already parsed — `ax debug-as
 * status` JSON for an agent, or, under `node --test`, the runner's own framed
 * protocol on the same stream (CI run 34940453124: one refusal note killed a
 * 43-test file with a deserialization error on Linux). A refusal an operator
 * reads as it scrolls past is exactly `src/log.mjs`'s `status`.
 */
export const event = message => status(message);

/**
 * The `{ at, problem, fix }` triple every rule in this directory refuses with,
 * printed as a refusal and its repair — and answered as the same message, so a
 * caller that must also `throw` carries identical words.
 */
export function refusal({ at, problem, fix: repair }) {
  const message = `${at} ${problem}`;
  refuse(message, repair);
  return scrub(message);
}

/** The same functions as one object, for a module that prefers a namespace. */
export const emit = { section, raw, ok, bad, note, fix, refuse, refusal, warn, status, progress, event, fatal, scrub, addSecrets, resetSecrets };
