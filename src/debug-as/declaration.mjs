// The root key that adopts debug sessions, and the retired shape that key used
// to carry. Nothing else — and, deliberately, NO IMPORTS.
//
// THE EMPTINESS IS THE POINT. `loadConfig` (../config.mjs) has to classify the
// retired shape before it treats schema errors as terminal, and the rules that
// consume this key live in ./config.mjs, which needs the plan's vocabulary.
// Wiring it the obvious way — `config.mjs` -> `debug-as/config.mjs` ->
// `plan.mjs` -> `config.mjs` — is a cycle, and ES modules do not forgive this
// one: `src/plan.mjs` interpolates `CONFIG_FILE` while its own module body
// runs, so entering `config.mjs` first throws
//
//   ReferenceError: Cannot access 'CONFIG_FILE' before initialization
//
// at import time. Not one broken verb — every `ax` command, before it parses a
// single argument. Measured on a three-module skeleton of exactly this shape
// while reviewing the first cut of the migration wiring, and pinned by the last
// test in `tests/debug-as-migration.test.mjs`, which imports `src/config.mjs`
// first in a fresh process because a suite that already imported something else
// warms the graph in an order that hides it.
//
// So the two facts every layer needs sit below all of them: the plan names this
// key in its CONTRACTS row, the rules module re-exports it beside its refusals,
// and the loader classifies with `historicalShape` — none of them importing
// each other to get it.

/** The one root key whose presence adopts the debug-session contract. */
export const DEBUG_DECLARATION = 'debugAs';

/**
 * The fields the retired shape carried, and nothing else.
 *
 * `route` and `optInEnv` were defaulted, which is why they had to go: a default
 * at any depth makes `applyDefaults` materialize the section for every project
 * that loads a config, and then nothing can tell an adopter from a bystander.
 */
const HISTORICAL_KEYS = ['route', 'optInEnv'];

/**
 * The retired `{ route, optInEnv }` shape, read from RAW configuration, or
 * `null`.
 *
 * RAW, and before validation, because validation of the current schema is what
 * turns those two fields into `unknown key` errors — accurate, and useless to
 * whoever wrote them. Recognizing the shape is what lets the finding say where
 * the section went instead of that it is misspelled.
 *
 * There is nothing to convert INTO (R30): two fields cannot express an
 * identity, an adapter or a provider. So this returns a finding with its
 * repair, and the caller keeps the rest of the configuration loadable — a
 * consumer must be able to pin the release that carries the new contract before
 * doing its own cutover.
 */
export function historicalShape(raw) {
  const declared = raw === null || typeof raw !== 'object' || Array.isArray(raw) ? undefined : raw[DEBUG_DECLARATION];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return null;

  const keys = Object.keys(declared);
  if (keys.length === 0 || !keys.every(key => HISTORICAL_KEYS.includes(key))) return null;

  return {
    at: DEBUG_DECLARATION,
    keys,
    problem: `declares the retired ${keys.map(key => `"${key}"`).join(' and ')} shape, which no command has ever consumed and which cannot express an identity, an adapter or a provider`,
    fix: `rewrite "${DEBUG_DECLARATION}" as the adopted contract — "browser", "identities" and optional "phone" — or remove it; there is no automatic conversion, and pinning this release does not require the rewrite`,
  };
}
