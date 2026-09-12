// The debug-session contract a project declares — and every rule the schema
// cannot state.
//
// `ax.schema.json` owns the SHAPE: which keys exist, which are required, which
// are closed. Three rules live here instead, and each is here for a reason the
// validator's own header gives:
//
// IDENTITY NAMES. `identities` is a keyed map, and a keyed map cannot pattern
// its keys without `patternProperties` — a keyword `src/schema.mjs` refuses by
// name, loudly, at validation time (tests/schema.test.mjs pins both of its
// silent-failure modes). So the name is checked here, and it is not cosmetic:
// it reaches a receipt path, a `--session` argv slot and a relay page.
//
// CAPABILITY CLOSURE. "An authenticated identity needs an adapter" and "a phone
// identity needs the project's phone half" are relationships BETWEEN two
// branches of the tree. JSON Schema expresses that with `dependentRequired` or
// an `allOf` of conditionals; both are keywords the validator does not
// implement, and teaching it a conditional vocabulary to encode two rules would
// be a second validator.
//
// PATHS. R2 binds one rule to every path AX consumes — the `--path` flag, a
// declared `defaultPath`, and the value serialized into a phone callback. The
// schema gates the coarse shape (`^/`) and this file owns the whole rule, so
// the three callers share one truth instead of three regexes that drift.
//
// EVERY REFUSAL NAMES ITS REPAIR (`src/log.mjs`): a `{ at, problem, fix }`
// triple, never a bare boolean, because a finding an operator cannot act on is
// the F-014 state this repository has already paid for once.
//
// THE RETIRED SHAPE IS READ FROM RAW BYTES, before ordinary validation, and it
// earns a migration finding rather than a conversion (R30). For eight releases
// `debugAs` was `{ route, optInEnv }`: two defaulted fields no command ever
// consumed. Those fields cannot express an identity, an adapter or a safe
// provider, so there is nothing to convert them INTO — and a consumer must be
// able to pin the release that carries this contract before its own cutover, so
// recognizing them is a finding, never a load failure.

// THE ROOT KEY IS THE PLAN'S. `src/plan.mjs` `CONTRACTS` decides which
// declaration adopts which contract, so the string lives there and this module
// imports it; it is re-exported because every refusal below names it, and a
// caller reading one contract should not need two imports to do it.
import { DEBUG_DECLARATION } from '../plan.mjs';

export { DEBUG_DECLARATION };

/** The fields the retired shape carried, and nothing else. */
const HISTORICAL_KEYS = ['route', 'optInEnv'];

/**
 * An identity name usable everywhere it travels: a receipt filename, a session
 * name, an argv slot, an escaped HTML page. Lowercase because the same name is
 * typed by an operator and matched by AX, and a case-insensitive filesystem
 * would make `Owner` and `owner` two names for one receipt.
 */
const NAME = /^[a-z][a-z0-9-]*$/;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Why this string is not a same-origin application path, or `''` when it is.
 *
 * Shared by the declared path checked here and the `--path` flag checked at
 * invocation: one rule, one message, one place to patch when a new escape turns
 * up. A URL is rejected before its scheme is inspected — the value is a path
 * component of an origin AX already decided, so carrying an origin at all is
 * the error.
 */
export function pathProblem(value) {
  if (typeof value !== 'string' || value === '') return 'is empty';
  if (!value.startsWith('/')) return 'is not absolute — an application path starts with "/"';
  if (value.startsWith('//')) return 'starts with "//", which a browser reads as another host';
  if (/^\/\\/.test(value)) return 'starts with a backslash escape';
  if (value.includes('\\')) return 'contains a backslash';
  if (/[?#]/.test(value)) return 'carries a query or fragment, which the path itself must not';
  if (/\s/.test(value)) return 'contains whitespace';
  if (/:\/\//.test(value)) return 'is a URL, not a path — the origin is AX\'s to decide';
  return '';
}

/**
 * The retired `{ route, optInEnv }` shape, read from RAW configuration, or
 * `null`.
 *
 * Raw, and before validation, because validation of the current schema is what
 * turns those two fields into `unknown key` errors — accurate, and useless to
 * whoever wrote them. Recognizing the shape is what lets the finding say where
 * the section went instead of that it is misspelled.
 */
export function historicalShape(raw) {
  const declared = isObject(raw) ? raw[DEBUG_DECLARATION] : undefined;
  if (!isObject(declared)) return null;

  const keys = Object.keys(declared);
  if (keys.length === 0 || !keys.every(key => HISTORICAL_KEYS.includes(key))) return null;

  return {
    at: DEBUG_DECLARATION,
    keys,
    problem: `declares the retired ${keys.map(key => `"${key}"`).join(" and ")} shape, which no command has ever consumed and which cannot express an identity, an adapter or a provider`,
    fix: `rewrite "${DEBUG_DECLARATION}" as the adopted contract — "browser", "identities" and optional "phone" — or remove it; there is no automatic conversion, and pinning this release does not require the rewrite`,
  };
}

/**
 * The contract this project declared, plus every refusal that names its repair.
 *
 * Takes RAW configuration rather than the validated config: adoption is the
 * presence of the root key in the file (`src/config.mjs` `declared`), and the
 * retired shape has to be recognizable before the schema calls its fields
 * unknown. A caller holding a validated config passes it as `raw` — the reads
 * here are the same either way, because this section carries no defaults.
 *
 * Returns `{ adopted, contract, refusals }`. `contract` is `null` whenever the
 * key is absent or its shape is refused; `adopted` still reports what the file
 * asked for, so a caller can tell "did not ask" from "asked and got it wrong".
 */
export function loadDebugContract({ raw } = {}) {
  const declared = isObject(raw) ? raw[DEBUG_DECLARATION] : undefined;
  if (declared === undefined) return { adopted: false, contract: null, refusals: [] };

  const historical = historicalShape(raw);
  if (historical) return { adopted: true, contract: null, refusals: [historical] };

  if (!isObject(declared)) {
    return {
      adopted: true,
      contract: null,
      refusals: [{ at: DEBUG_DECLARATION, problem: `is ${Array.isArray(declared) ? 'an array' : typeof declared}, not an object`, fix: `declare "${DEBUG_DECLARATION}" as an object with "browser" and "identities"` }],
    };
  }

  const refusals = [];
  const browser = isObject(declared.browser) ? declared.browser : {};
  const phone = isObject(declared.phone) ? declared.phone : null;
  const identities = isObject(declared.identities) ? declared.identities : {};
  const adapter = isObject(browser.prepare) ? browser.prepare : null;

  const resolved = {};
  for (const [name, entry] of Object.entries(identities)) {
    const at = `${DEBUG_DECLARATION}.identities.${name || '""'}`;

    if (!NAME.test(name)) {
      refusals.push({
        at,
        problem: `is not a usable identity name — lowercase letters, digits and hyphens only, starting with a letter`,
        fix: `rename it (for example ${JSON.stringify(String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'owner')}); the name travels into a receipt path, a session name and an argv slot`,
      });
      continue;
    }
    if (!isObject(entry)) {
      refusals.push({ at, problem: `is ${Array.isArray(entry) ? 'an array' : typeof entry}, not an object`, fix: `declare it as an object with a "defaultPath"` });
      continue;
    }

    const problem = pathProblem(entry.defaultPath);
    if (problem !== '') {
      refusals.push({ at: `${at}.defaultPath`, problem: `declares a default path that ${problem}`, fix: `use an absolute path of this application, such as "/home"` });
      continue;
    }

    const authenticated = isObject(entry.browser) && typeof entry.browser.storageState === 'string';
    const wantsPhone = isObject(entry.phone);

    if (authenticated && adapter === null) {
      refusals.push({
        at,
        problem: 'is authenticated — it declares a "storageState" — but this project declares no Debug adapter to keep that artifact fresh',
        fix: `declare "${DEBUG_DECLARATION}.browser.prepare.command" with the argv that refreshes it, or drop this identity's "browser" block to declare it unauthenticated`,
      });
      continue;
    }
    if (wantsPhone && phone === null) {
      refusals.push({
        at,
        problem: 'supports Phone handoff, which this project has not adopted',
        fix: `declare "${DEBUG_DECLARATION}.phone" with an "optInEnv" and a "provider", or remove this identity's "phone" block`,
      });
      continue;
    }
    if (wantsPhone && !authenticated) {
      refusals.push({
        at,
        problem: 'supports Phone handoff without being authenticated — a handoff transfers an authenticated session, so there would be nothing to transfer',
        fix: `declare this identity's "browser.storageState", or remove its "phone" block`,
      });
      continue;
    }

    resolved[name] = { name, defaultPath: entry.defaultPath, authenticated, storageState: authenticated ? entry.browser.storageState : null, phone: wantsPhone, email: wantsPhone ? entry.phone.email : null };
  }

  // The mirror of the closure above, from the project's side: an adapter is
  // declared for authentication that nothing authenticates. Reported rather
  // than ignored, because an adapter nobody invokes is a command an operator
  // believes is being run.
  if (adapter !== null && Object.values(resolved).every(identity => !identity.authenticated)) {
    refusals.push({
      at: `${DEBUG_DECLARATION}.browser.prepare`,
      problem: 'declares a Debug adapter while no identity is authenticated, so nothing would ever invoke it',
      fix: `declare a "browser.storageState" on the identity it refreshes, or remove "${DEBUG_DECLARATION}.browser.prepare"`,
    });
  }

  if (refusals.length > 0) return { adopted: true, contract: null, refusals };

  return {
    adopted: true,
    refusals: [],
    contract: {
      browser: {
        playwrightDir: browser.playwrightDir,
        start: browser.start,
        // Declared, never defaulted (`ax.schema.json` requires both): a
        // deadline AX invented would be a behavior this contract says it has
        // no default for, and the one it would have invented is the number
        // that kills a consumer's adapter mid-login.
        navigationTimeoutSeconds: browser.navigationTimeoutSeconds,
        prepare: adapter === null ? null : { command: adapter.command, timeoutSeconds: adapter.timeoutSeconds },
      },
      phone: phone === null ? null : { optInEnv: phone.optInEnv, provider: phone.provider },
      identities: resolved,
    },
  };
}
