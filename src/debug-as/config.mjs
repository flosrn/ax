// The debug-session contract a project declares — and every rule the schema
// cannot state.
//
// `ax.schema.json` owns the SHAPE: which keys exist, which are required, which
// are closed. Four rules live here instead, and each is here for a reason the
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
// ARGV ENTRIES. `minItems: 1` bounds an argv array and says nothing about its
// items; the keyword that would bound an item (`minLength`) is one the
// validator refuses by name. So a blank entry is refused here, at LOAD, naming
// the entry an operator edits — because the alternative was measured: a
// `prepare.command: [""]` loaded as a valid contract and only failed at the
// next authenticated launch, inside `runAdapter`.
//
// EVERY REFUSAL NAMES ITS REPAIR (`src/log.mjs`): a `{ at, problem, fix }`
// triple, never a bare boolean, because a finding an operator cannot act on is
// the F-014 state this repository has already paid for once.
//
// THE RETIRED SHAPE and the root key itself live one level down, in
// `./declaration.mjs`, which imports nothing. `loadConfig` has to classify that
// shape too, and reaching this module from there would close a cycle through
// `../plan.mjs` that throws at import time — its own header measures it. So
// both facts are re-exported from here, where the refusals that name them are.
import { DEBUG_DECLARATION, historicalShape } from './declaration.mjs';
import { ANNOTATIONS } from '../schema.mjs';

export { DEBUG_DECLARATION, historicalShape };

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
 * Every argv array this contract declares, paired with the declaration path an
 * operator edits. `browser.start` is named as a repair and the other two are
 * spawned, and a blank entry is the same defect in all three.
 */
const argvDeclarations = (browser, phone) => {
  const declared = [[`${DEBUG_DECLARATION}.browser.start`, browser.start]];
  if (isObject(browser.prepare)) declared.push([`${DEBUG_DECLARATION}.browser.prepare.command`, browser.prepare.command]);
  if (isObject(phone?.provider)) declared.push([`${DEBUG_DECLARATION}.phone.provider.command`, phone.provider.command]);
  return declared.filter(([, argv]) => Array.isArray(argv));
};

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
      refusals: [{ at: DEBUG_DECLARATION, problem: `is ${declared === null ? 'null' : Array.isArray(declared) ? 'an array' : typeof declared}, not an object`, fix: `declare "${DEBUG_DECLARATION}" as an object with "browser" and "identities"` }],
    };
  }

  const refusals = [];
  const browser = isObject(declared.browser) ? declared.browser : {};
  const phone = isObject(declared.phone) ? declared.phone : null;
  const identities = isObject(declared.identities) ? declared.identities : {};
  const adapter = isObject(browser.prepare) ? browser.prepare : null;

  // A blank argv entry, refused where it is DECLARED. The schema bounds each
  // of these arrays with `minItems: 1`, which says nothing about their items,
  // and the keyword that would (`minLength`) is one `src/schema.mjs` refuses
  // by name — so `prepare.command: [""]` loaded as a valid project contract,
  // `debug-as doctor` read the empty executable as a PATH directory, and every
  // authenticated launch failed far later inside `runAdapter`, which requires
  // non-empty argv. A launch is the wrong place to learn a declaration is
  // unusable, and the only repair is an edit to this file.
  for (const [at, argv] of argvDeclarations(browser, phone)) {
    argv.forEach((part, index) => {
      if (typeof part !== 'string' || part.trim() !== '') return;
      refusals.push({
        at: `${at}[${index}]`,
        problem: 'is a blank argv entry, and AX spawns project commands without a shell, so it would reach the child as an empty argument',
        fix: `remove the entry, or give it the argument it is missing — "${at}" is argv, never a shell string`,
      });
    });
  }

  const resolved = {};
  for (const [name, entry] of Object.entries(identities)) {
    // A reserved annotation is metadata, and `src/schema.mjs` admits it at
    // every object level INCLUDING inside a keyed map — structurally, because
    // hand-listing admission per object is how `prGate.$comment` loaded while
    // `dispatch.$comment` was refused. This walker validates keys as identity
    // NAMES, so it has to skip exactly what that file admits: a project that
    // annotated its catalog would otherwise have its whole contract refused
    // for a key the validator accepts.
    if (ANNOTATIONS.has(name)) continue;

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

  // The one path rule, on the other path this contract carries (R2). The flag
  // and the declared default were checked and the callback was not: its schema
  // pattern is `^/` alone, so `//evil.example.com` loaded with no refusal and
  // would resolve to another host the moment a URL is built on it. The provider
  // that builds that URL is not written yet, which is exactly why the rule is
  // enforced here rather than trusted to arrive with it.
  const confirm = isObject(phone?.provider?.confirm) ? phone.provider.confirm : null;
  if (confirm !== null) {
    const problem = pathProblem(confirm.path);
    if (problem !== '') {
      refusals.push({
        at: `${DEBUG_DECLARATION}.phone.provider.confirm.path`,
        problem: `declares a callback path that ${problem}`,
        fix: `use an absolute path of this application, such as "/auth/confirm" — the phone callback lands on the same origin as the browser`,
      });
    }
  }

  // The mirror of the closure above, from the project's side: an adapter is
  // declared for authentication that nothing authenticates. Reported rather
  // than ignored, because an adapter nobody invokes is a command an operator
  // believes is being run.
  //
  // JUDGED FROM THE DECLARATIONS, AND ONLY ON A CLEAN PASS. Every refusal
  // branch above `continue`s before writing to `resolved`, so reading
  // authentication off `resolved` made `.every()` true over an empty set: one
  // bad name or path on the only authenticated identity added this refusal too,
  // telling the operator to delete a correct adapter. A second refusal caused
  // by the first is worse than silence — it sends the repair in the wrong
  // direction.
  const declaresAuthentication = Object.entries(identities).some(
    ([name, entry]) => !ANNOTATIONS.has(name) && isObject(entry) && isObject(entry.browser) && typeof entry.browser.storageState === 'string',
  );
  if (adapter !== null && refusals.length === 0 && !declaresAuthentication) {
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
