// What a PROJECT should carry — decided once, before either verb acts.
//
// `src/worktree/plan.mjs` opens with the rule this file is the project-level
// half of: one derivation, `setup` writes it, `doctor` compares against it, and
// a finding is always "recorded value vs plan value". The project half had no
// plan at all. `ax init` decided the target state while writing it and
// `ax doctor` decided it again while grading, which is the drift that module's
// header measured — and two findings proved it had already happened here.
//
// FINDING ONE: the checkout that IS the package. On the ax repository itself,
// `ax init` wrote `devDependencies["@flosrn/ax"]` — a dependency on itself, that
// no install can resolve — plus `scripts.ax` and a `bin/ax` shim whose only job
// is to exec `node_modules/.bin/ax`, i.e. the package the checkout already is.
// `ax doctor` then graded all three and called the result coherent. Neither verb
// was wrong about its own half; there was no field saying which repository this
// is, so both invented the same wrong answer independently.
//
// FINDING TWO: partial adoption. `prGate` has never gone through the provisioning
// contract — `src/pr-gate.mjs` reads that one key raw, on purpose, so a project
// may declare what its merge must prove without adopting a layout this package
// does not own. gapila does exactly that, by design. `ax doctor` had no way to
// say so: it graded the bootstrap, the OMP bundle and the managed blocks
// unconditionally, so a gate-only project was red on five findings forever, each
// naming `ax init` as a repair for a contract nobody adopted. "Not adopted" is
// not "recorded value missing"; it is a different question, and the plan is
// where a question about target state belongs.
//
// PURITY, same limit and same reason as the worktree plan: `planProject` takes
// the manifest and the declared keys as data, so it is callable with plain
// objects. `readManifest` is the one machine read, kept beside it because both
// verbs need the same bytes and a second reader is a second derivation.
//
// ADOPTION IS DERIVED FROM A DECLARATION, never from the presence of the files a
// contract provisions. Reading it off the files would make `ax init` unable to
// adopt anything — it writes those files — and would make a half-provisioned
// checkout indistinguishable from an unadopted one. So the configuration says
// what this project asks ax for, `ax init` writes that declaration when it
// provisions, and `ax doctor` grades only the contracts the declaration names.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, PACKAGE_NAME } from './config.mjs';

/**
 * The package root OMP loads in a project that installed ax. The ax checkout
 * registers `"."` instead — one release, whether it is read from `node_modules`
 * or from the source it was published from.
 */
export const OMP_PACKAGE_ROOT = `./node_modules/${PACKAGE_NAME}`;

/**
 * The contracts a project may adopt, and the ONE declaration that adopts each.
 *
 * A contract is a domain of this package a repository opted into. `id` keys the
 * plan, `name` is what an operator reads, `declaration` is the root config key
 * whose presence is the opt-in, and `verb` is what adopts it — a finding about
 * an unadopted contract names that verb, because "not adopted" with no way to
 * adopt is the same dead end as a `bad` with no `fix`.
 *
 * The gate row is here so `adopted` answers "which sections does this
 * configuration declare" rather than one boolean about provisioning. It does
 * NOT route the gate: `src/pr-gate.mjs` reads `prGate` raw and stays the only
 * reader of it, for the reason its own header gives.
 */
export const CONTRACTS = [
  {
    id: 'provisioning',
    name: 'provisioning',
    declaration: 'apps',
    verb: 'ax init',
    covers: 'the bootstrap, the OMP bundle, the managed blocks, the pin and the worktree layer',
  },
  {
    id: 'gate',
    name: 'merge gate',
    declaration: 'prGate',
    verb: `declare "prGate" in ${CONFIG_FILE}`,
    covers: 'what `ax pr gate` must be able to decide before a merge',
  },
];

/**
 * The target state of a project, from its own manifest and the contracts its
 * configuration declares.
 *
 * @param manifest  the checkout's parsed `package.json`, `{}` when there is none
 * @param declared  the root keys `ax.config.json` actually carries, before
 *                  schema defaults — a defaulted `apps` is not a declaration
 */
export function planProject({ manifest = {}, declared = [] } = {}) {
  // THE NAME, never a path or a remote. A `link:`ed dev checkout, a fork and a
  // published install all resolve to different paths; the manifest name is what
  // says this tree publishes the package rather than consumes it.
  const selfHosted = manifest?.name === PACKAGE_NAME;
  return {
    selfHosted,
    ompExtension: selfHosted ? '.' : OMP_PACKAGE_ROOT,
    schemaRef: selfHosted ? './ax.schema.json' : `${OMP_PACKAGE_ROOT}/ax.schema.json`,
    // `bin/ax` resolves the installed CLI, and `scripts.ax` exists only to call
    // it: one fact, so one field. The self-hosted checkout reaches its own CLI
    // through the `bin` field in the manifest it publishes.
    bootstrap: !selfHosted,
    pin: !selfHosted,
    adopted: Object.fromEntries(CONTRACTS.map(contract => [contract.id, declared.includes(contract.declaration)])),
  };
}

/**
 * The checkout's own manifest — the one read of it, shared by both verbs.
 *
 * Unreadable and absent are the same answer, `{}`: neither says this tree is
 * the package, and a project with no manifest still gets a plan (`ax init`
 * refuses the missing file itself, with its own words).
 */
export function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The package root OMP loads in `root`, for callers holding a path and no
 * manifest — `src/worker/child.mjs` grades a worktree it never loaded a config
 * for. One derivation, so a self-hosted dispatch registered as `"."` cannot be
 * refused as unwired by a second copy of this string.
 */
export const ompExtensionRoot = root => planProject({ manifest: readManifest(root) }).ompExtension;
