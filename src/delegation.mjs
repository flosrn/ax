// Which ax runs: the global one, or the one this project installed.
//
// ax is now installed globally (`pnpm add -g @flosrn/ax`) so an agent can type
// `ax` anywhere, and pinned per project so a repo's tooling is versioned with
// the repo. Those two facts collide: the global copy is whatever the machine
// last upgraded to, and running it inside a project pinned to another version
// runs code that project never chose. Measured cost of the collision is not
// theoretical — a bump on one machine changed what `ax doctor` graded in every
// checkout on it at once.
//
// So the bin entry resolves the PROJECT's install first and hands the argv to
// its implementation. Three outcomes, and no fourth:
//
//   self    — no project declares ax, or this copy IS the project's install
//   local   — the project installed another version; import ITS `src/cli.mjs`
//   refuse  — the project declares ax and has not installed it; name the repair
//
// Delegation imports the local package's CLI implementation, never its
// `bin/ax.mjs`: that file is the delegating entry, and handing argv back to it
// is how a version loop starts.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PACKAGE_NAME, repoPaths } from './config.mjs';
import { bad, fix, note } from './log.mjs';

/** The package directory of the copy currently executing. */
const SELF_DIR = dirname(dirname(fileURLToPath(import.meta.url)));


const readManifest = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const real = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** An exact npm version — what `ax init` and `ax pin` now write. */
export const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** The ax declaration in a manifest, from wherever a project chose to put it. */
function declaredPin(manifest) {
  for (const field of ['devDependencies', 'dependencies', 'optionalDependencies']) {
    const value = manifest?.[field]?.[PACKAGE_NAME];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * A path pasted into a printed command, quoted the way the committed bootstrap
 * quotes it: single quotes cover every character except their own, so a path
 * carrying one is printed raw rather than handed over as a command that would
 * split at the wrong place.
 */
const quote = at => (at.includes("'") ? at : `'${at}'`);

/** The install command that repairs a missing install. */
export const installCommand = at => (at.includes("'") ? `pnpm install --dir ${at}   # quote this path yourself` : `pnpm install --dir '${at}'`);

/** The version of the copy executing, read from its own manifest. */
const selfVersion = self => readManifest(join(self, 'package.json'))?.version ?? 'latest';

/**
 * Decide whose implementation answers this invocation.
 *
 * The candidate roots are this checkout and the primary checkout behind it, in
 * that order — a worktree seconds old carries no `node_modules` while the
 * primary one behind it does, so a declaration in the worktree is answered by
 * the primary's install rather than refused. Only when NO candidate carries a
 * usable install does the missing-install verdict apply, and it names the last
 * root that declared an EXACT version — the primary — exactly as the committed
 * bootstrap does.
 *
 * That exactness is the whole authority: `0.10.1` names one version, so a
 * missing install is a repairable fact and refusing to stand in for it is the
 * right answer. A `github:` ref, a `^` range or a `link:` checkout names no
 * single version — there is nothing to insist on — so a project carrying one
 * gets whatever it actually installed, and the copy that was typed when it
 * installed nothing. `ax doctor` is where a non-exact pin is graded and named;
 * delegation does not turn it into a wall.
 *
 * `roots` is injectable so the decision can be tested without a git repository;
 * `self` likewise, so a test can pretend to be a different copy than the one
 * running the test.
 */
export function resolveDelegation({ cwd = process.cwd(), self = SELF_DIR, roots } = {}) {
  const candidates = roots ?? (() => {
    const { root, main } = repoPaths(cwd);
    return [root, main].filter(Boolean);
  })();

  const seen = new Set();
  const rows = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const manifest = readManifest(join(candidate, 'package.json'));
    if (!manifest) continue;
    const pin = declaredPin(manifest);
    if (pin === null) continue;

    const installed = join(candidate, 'node_modules', PACKAGE_NAME);
    const installedManifest = readManifest(join(installed, 'package.json'));
    rows.push({
      candidate,
      pin,
      installed,
      installedManifest,
      packageDir: installedManifest ? real(installed) : null,
    });
  }

  // The nearest exact declaration is the project authority. A primary
  // checkout's install may serve a fresh worktree only when its bytes are the
  // release that worktree declared; "some ax is installed" is not authority.
  const authority = rows.find(row => EXACT_VERSION.test(row.pin)) ?? null;
  let legacy = null;
  let mismatch = null;

  for (const row of rows) {
    if (!row.installedManifest) continue;
    if (authority !== null && row.installedManifest.version !== authority.pin) {
      mismatch ??= row;
      continue;
    }

    if (row.packageDir === real(self)) {
      return {
        mode: 'self',
        root: row.candidate,
        pin: row.pin,
        version: row.installedManifest.version,
        why: `this copy is ${row.candidate}'s install`,
      };
    }

    const entry = join(row.packageDir, 'src', 'cli.mjs');
    if (existsSync(entry)) {
      return {
        mode: 'local',
        root: row.candidate,
        pin: row.pin,
        version: row.installedManifest.version,
        packageDir: row.packageDir,
        entry,
      };
    }

    legacy ??= row;
  }

  if (authority === null) {
    return { mode: 'self', why: 'no checkout here declares an exact ax version' };
  }

  if (legacy !== null) {
    return {
      mode: 'refuse',
      root: legacy.candidate,
      pin: authority.pin,
      version: legacy.installedManifest.version,
      message: `${legacy.candidate} installed ${PACKAGE_NAME} ${legacy.installedManifest.version}, which ships no src/cli.mjs — that release predates global-to-local delegation`,
      repair: `pnpm add -D ${PACKAGE_NAME}@${selfVersion(self)} --dir ${quote(legacy.candidate)}`,
    };
  }

  if (mismatch !== null) {
    return {
      mode: 'refuse',
      root: authority.candidate,
      pin: authority.pin,
      message: `${authority.candidate} declares ${PACKAGE_NAME} ${authority.pin}, but the available install at ${mismatch.candidate} is ${mismatch.installedManifest.version} — a different release cannot answer for this worktree`,
      repair: installCommand(authority.candidate),
    };
  }

  return {
    mode: 'refuse',
    root: authority.candidate,
    pin: authority.pin,
    message: `${authority.candidate} declares ${PACKAGE_NAME} ${authority.pin} and has not installed it — the version a project pinned is the version that runs, so this one will not stand in for it`,
    repair: installCommand(authority.candidate),
  };
}

/**
 * Act on a decision. `self` is the caller's business — it owns the local
 * `runCli` import and must not load a second copy of it.
 */
export async function runDelegated(decision, argv, { load = entry => import(pathToFileURL(entry).href), verbose = process.env.AX_DEBUG === '1' } = {}) {
  if (decision.mode === 'refuse') {
    bad(decision.message);
    fix(decision.repair);
    return 1;
  }
  if (verbose) note(`ax ${decision.version} from ${decision.packageDir}`);
  const local = await load(decision.entry);
  if (typeof local.runCli !== 'function') {
    bad(`${decision.entry} exports no runCli — ${PACKAGE_NAME} ${decision.version} cannot answer for this project`);
    fix(installCommand(decision.root));
    return 1;
  }
  return (await local.runCli(argv)) ?? 0;
}
