import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { applyBlock, getJsonPath, setJsonPath, styleFor } from './blocks.mjs';
import { agentLines } from './commands.mjs';
import { CONFIG_FILE, PACKAGE_NAME, assetPath, loadConfig, vendorRemote, version } from './config.mjs';
import { EXACT_VERSION } from './delegation.mjs';
import { bad, fix, note, ok, section } from './log.mjs';
import { planProject, readManifest } from './plan.mjs';

// An exact npm version, not a git tag and not a range: ax is published to the
// registry now, so the pin a project carries is the version its lockfile
// resolves and the version the global CLI delegates to. Exact rather than
// `^`, because "the tooling a repo chose" is a decision, and a caret quietly
// changes it on the next unrelated install.
export const PIN = version;
export const BLOCK_ID = 'ax';

/**
 * OMP reads package roots from this project setting and then its
 * `omp.extensions` manifest. ONE ax bundle per session, ever: a second wrapper
 * under `.omp/extensions/` loads the bundle twice, and duplicate peer receive
 * loops consume each other's messages and duplicate reports. The ax repo
 * registers `"."`; consuming repos register the installed package root below.
 */
export const OMP_SETTINGS = '.omp/settings.json';
/** The 0.10 wiring; removed only when its bytes prove ax owns it. */
export const LEGACY_OMP_LOADER = '.omp/extensions/ax.ts';
export const LEGACY_OMP_LOADER_SOURCE = [
  '// Written by `ax init`. Edit ax, not this file — `ax doctor` reports drift here',
  '// and `ax init` rewrites it.',
  '//',
  '// OMP discovers project extensions itself, from `.omp/extensions/*.ts`. This',
  '// file is the whole wiring: it re-exports the extension shipped by the exact',
  '// @flosrn/ax version this project installed, so the extension and the CLI can',
  '// never be two different versions of the same decisions.',
  "export { default } from '@flosrn/ax/omp';",
  '',
].join('\n');

/**
 * Lines ax owns in .gitignore: runtime state of the AX layer, nothing else.
 *
 * `.env.local` is here because `ax worktree setup` WRITES it
 * (`${config.apps.web}/.env.local`, ../worktree/plan.mjs) and release's dirty
 * proof reads `git status --porcelain`, untracked files included. Measured
 * 2026-09-02 (#83): a child worktree whose only dirt was that file answered
 * `KEEP · uncommitted changes on feat/73-…`, and removing it by hand made the
 * same command answer `CLOSE · PR #79 merged`. The predicate is right to refuse
 * a dirty tree — an allowlist inside a proof is how a hand-edited file carrying
 * real work stops blocking a close — so what was missing is this line. It
 * carries NO SLASH on purpose: it matches at any depth, covering both a root
 * write and a consumer's `apps/web/.env.local`. On a MakerKit consumer the
 * vendor `.gitignore` already covers it, which is why the defect only ever
 * showed on a plain package repo.
 *
 * `.orca-worktree.json` is deliberately absent while the Orca adapter still
 * lives in the project — ofmchat already ignores it, with a comment saying
 * which script writes it. Claiming it here too would print the same path twice
 * in a file a human reads. It joins this list when `ax orca` does.
 */
export const GITIGNORE_LINES = ['.worktrees/', '.agent/', '.scratch/', '.env.local'];
export const GITIGNORE_BODY = GITIGNORE_LINES.join('\n');

function assertManagedPath(root, target) {
  const base = resolve(root);
  const absolute = resolve(target);
  const rel = relative(base, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${target} escapes the repository root`);
  }

  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`${current} is a symbolic link — ax init does not follow managed paths outside the checkout`);
    }
  }
}
/**
 * What an agent opening this repo needs in order to act — built from the

 * command registry, so it can never advertise a command the CLI does not run.
 */
export const agentsBody = () =>
  [
    '## ax tooling',
    '',
    'The `ax` CLI carries this checkout\'s reusable tooling.',
    '',
    ...agentLines().map(line => `- ${line}`),
    '',
    `\`${CONFIG_FILE}\` is where ax reads its ports, app paths and guarded vendor trees. A command`,
    'that needs one of those values reads it from there rather than restating it.',
  ].join('\n');

/** The app roots ax manages here, inferred from the layout on disk. */
function inferApps(root) {
  const apps = { web: existsSync(join(root, 'apps', 'web')) ? 'apps/web' : '.' };
  if (existsSync(join(root, 'apps', 'e2e'))) apps.e2e = 'apps/e2e';
  return apps;
}

/** Infer what can be inferred; refuse to guess what must be decided. */
function inferConfig(root, { vendor: explicitVendor, plan }) {
  const packagePath = join(root, 'package.json');
  const manifest = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : {};
  const rawName = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name : basename(root);
  const name = rawName
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return { error: `cannot infer project.name from package.json or the repository directory — write ${CONFIG_FILE} by hand` };

  // Vendor ownership is one optional repo shape. Detect MakerKit when present;
  // a plain repository has no upstream tree to guard and needs no empty
  // placeholder pretending otherwise.
  const vendor = explicitVendor ?? (vendorRemote(root, 'makerkit/next-supabase-saas-kit-turbo') ? 'makerkit/next-supabase-saas-kit-turbo' : null);
  const config = {
    // The plan's pointer, not a literal: `./node_modules/@flosrn/ax/` cannot
    // exist in the checkout that publishes it, and a $schema nothing resolves
    // silently costs an editor every completion this file is written with.
    $schema: plan.schemaRef,
    project: { name },
    apps: inferApps(root),
  };
  if (vendor !== null) config.vendor = { repo: vendor };
  return { config };
}

function writeFile(path, content, { dryRun, mode, root }) {
  assertManagedPath(root, path);
  const exists = existsSync(path);
  if (exists && readFileSync(path, 'utf8') === content) return 'unchanged';
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    assertManagedPath(root, path);
    writeFileSync(path, content, 'utf8');
    if (mode !== undefined) chmodSync(path, mode);
  }
  return exists ? 'updated' : 'created';
}

function wireOmp(root, { dryRun, plan }) {
  const path = join(root, ...OMP_SETTINGS.split('/'));
  let settings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return { error: `${OMP_SETTINGS} is not valid JSON (${error.message})` };
    }
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { error: `${OMP_SETTINGS} must contain a JSON object` };
  }
  const extensions = settings.extensions ?? [];
  if (!Array.isArray(extensions) || extensions.some(entry => typeof entry !== 'string')) {
    return { error: `${OMP_SETTINGS}.extensions must be an array of package-root strings` };
  }

  const legacyPath = join(root, ...LEGACY_OMP_LOADER.split('/'));
  let legacy = null;
  if (existsSync(legacyPath)) {
    const owned = LEGACY_OMP_LOADER_SOURCE;
    if (readFileSync(legacyPath, 'utf8') !== owned) {
      return { error: `${LEGACY_OMP_LOADER} is the retired ax loader but its bytes were edited — remove or reconcile it before loading the package root too` };
    }
    if (!dryRun) unlinkSync(legacyPath);
    legacy = 'removed';
  }

  const expected = plan.ompExtension;
  let found = false;
  const normalized = [];
  for (const entry of extensions) {
    if (entry !== expected) {
      normalized.push(entry);
    } else if (!found) {
      normalized.push(entry);
      found = true;
    }
  }
  if (!found) normalized.push(expected);
  const changed = normalized.length !== extensions.length || normalized.some((entry, index) => entry !== extensions[index]);
  const next = changed ? { ...settings, extensions: normalized } : settings;
  const state = writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { dryRun, root });
  return { state, legacy };
}

const report = (label, state) => (state === 'unchanged' ? note(`${label} — unchanged`) : ok(`${label} — ${state}`));

/**
 * The config violations with a mechanical repair rather than a decision, and the
 * reason they are a table read by a function instead of literals in two files.
 *
 * A rename here is a clean cutover: the old key stops existing and the schema's
 * `additionalProperties: false` refuses it. But "unknown key" does not say where
 * the key WENT, and both `ax init` and `ax doctor` meet that refusal while a
 * consuming repo pins the release — so a repair only one of them names is a
 * repair half the operators never see. Three renames have been made this way
 * now, which is what turned one predicate into this list: the fourth must not
 * arrive with advice only one verb prints.
 *
 * A ROW IS RETIRED WHEN ITS KEY BECOMES LIVE AGAIN. `triage` had a row here
 * (0.15 renamed the block to `ready`); `triage` is the declared key again, so
 * that row is GONE rather than kept for history. Left in place it would tell an
 * operator whose config is CORRECT to break it, and the schema would then refuse
 * the key the advice named — the only failure mode worse than an unexplained
 * "unknown key".
 *
 * ROOT LEVEL ONLY, matched as the validator's own whole line rather than as a
 * substring. Two looser readings were both wrong. A substring of the WORD sends
 * a config whose real defect merely QUOTES a value like `needs-triage` — a
 * mistyped `dispatch.databaseLabels`, say — to rename a key it does not have.
 * And a substring of `unknown key "ready"` matches ANY nesting level, because
 * ./schema.mjs prints the location (`${where}: unknown key "${key}"`): a nested
 * `dispatch.ready` reports `dispatch: unknown key "ready"` and would earn
 * advice to rename a root key the config never carried, sending the operator to
 * edit a line that is already correct while the real nested defect stays.
 */
const RETIRED_CONFIG_KEYS = [
  {
    key: 'ready',
    fix: `rename the "ready" key to "triage" in ${CONFIG_FILE} — the noun follows the activity again (\`ax triage\`), and every key inside the block (labels, provenance) keeps its own name`,
  },
  {
    key: 'launch',
    fix: `rename the "launch" key to "dispatch" in ${CONFIG_FILE} — the verb is \`ax worker dispatch\` now, and every key inside the block (entry, contract, hosts, databaseLabels, worktreeTool) keeps its own name`,
  },
];

/**
 * The repairs for the retired root keys a config still carries, in table order.
 * Empty when the errors name none — a config with three typos and no retired key
 * gets the validator's own lines and nothing invented on top of them.
 */
export const retiredConfigKeyFixes = errors =>
  RETIRED_CONFIG_KEYS.filter(({ key }) => errors.some(error => error === `root: unknown key "${key}"`)).map(({ fix }) => fix);

/**
 * Make a project ax-ready: the config, the committed bootstrap, and the managed
 * touchpoints in files the vendor also owns. Safe to re-run — that is how a
 * block survives a merge that took "theirs".
 */
export function init(root, { dryRun = false, vendor } = {}) {
  section(`ax init${dryRun ? ' (dry run — nothing written)' : ''} — ${root}`);
  let failed = false;
  try {
    for (const relativePath of [
      CONFIG_FILE,
      'bin/ax',
      OMP_SETTINGS,
      LEGACY_OMP_LOADER,
      '.gitignore',
      'AGENTS.md',
      'package.json',
    ]) {
      assertManagedPath(root, join(root, ...relativePath.split('/')));
    }
  } catch (error) {
    bad(`managed path refused — ${error.message}`);
    fix('replace the symlink with a regular path inside the checkout, then re-run ax init');
    return 1;
  }

  const existing = loadConfig(root);
  if (existing.exists && existing.errors.length > 0) {
    bad(`${CONFIG_FILE} — invalid, leaving it untouched`);
    for (const error of existing.errors) note(error);
    // Named, never rewritten: the file is the user's, and the refusal above is
    // the rule. Saying where the key went costs nothing and is the whole
    // difference between a closed schema and a dead end.
    for (const repair of retiredConfigKeyFixes(existing.errors)) fix(repair);
    return 1;
  }

  // The plan, once, before anything is written: whether this checkout IS the
  // package, and which contracts the configuration already declares
  // (./plan.mjs). `ax init` is the verb that ADOPTS the provisioning contract,
  // so it never skips work because a contract is unadopted — the adoption field
  // tells it what it still has to DECLARE.
  const plan = planProject({ manifest: readManifest(root), declared: existing.declared });

  if (!existing.exists) {
    const inferred = inferConfig(root, { vendor, plan });
    if (inferred.error) {
      bad(`${CONFIG_FILE} — ${inferred.error}`);
      if (inferred.hint) fix(inferred.hint);
      return 1;
    }
    report(CONFIG_FILE, writeFile(existing.path, `${JSON.stringify(inferred.config, null, 2)}\n`, { dryRun, root }));
  } else {
    // The two values in a DECLARED config that this plan owns, brought back to
    // it. Everything else is the project's and is copied through untouched, in
    // its own key order.
    //
    // `apps`, because THE DECLARATION IS THE ADOPTION: provisioning the files
    // while leaving `apps` undeclared would have `ax doctor` report the
    // contract as unadopted immediately after running the verb it names as the
    // way to adopt it — advice that cannot come true.
    //
    // `$schema`, because it is a plan value too, and one an older release of
    // this verb wrote wrong. Corrected only where the key EXISTS: absent is not
    // drift, and inventing a key the project never declared is not a repair
    // (`ax doctor` grades it on the same rule).
    const raw = JSON.parse(readFileSync(existing.path, 'utf8'));
    const next = {};
    for (const [key, value] of Object.entries(raw)) {
      next[key] = key === '$schema' ? plan.schemaRef : value;
      if (key === 'project' && !plan.adopted.provisioning) next.apps = inferApps(root);
    }
    if (!plan.adopted.provisioning) next.apps ??= inferApps(root);

    const touched = [];
    if (next.$schema !== raw.$schema) touched.push('$schema');
    if (next.apps !== raw.apps) touched.push('apps — provisioning adopted');
    if (touched.length === 0) {
      note(`${CONFIG_FILE} — already valid`);
    } else {
      report(`${CONFIG_FILE} (${touched.join(', ')})`, writeFile(existing.path, `${JSON.stringify(next, null, 2)}\n`, { dryRun, root }));
    }
  }

  // The shim execs the INSTALLED CLI, so the checkout that publishes ax cannot
  // carry one: it would resolve `node_modules/.bin/ax`, an install of itself.
  if (plan.bootstrap) {
    report('bin/ax', writeFile(join(root, 'bin', 'ax'), readFileSync(assetPath('bootstrap', 'ax'), 'utf8'), { dryRun, mode: 0o755, root }));
  }

  // Register the PACKAGE ROOT, not a wrapper file. OMP uses the package's
  // `omp.extensions` manifest, and this same root exposes everything ax ships
  // as one version. Existing project settings and native extensions survive.
  const omp = wireOmp(root, { dryRun, plan });
  if (omp.error) {
    bad(omp.error);
    fix(`repair ${OMP_SETTINGS}, then re-run ax init`);
    failed = true;
  } else {
    report(OMP_SETTINGS, omp.state);
    if (omp.legacy !== null) report(LEGACY_OMP_LOADER, omp.legacy);
  }

  for (const [file, body] of [
    ['.gitignore', GITIGNORE_BODY],
    ['AGENTS.md', agentsBody()],
  ]) {
    const path = join(root, file);
    const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
    try {
      const next = applyBlock(source, { id: BLOCK_ID, body, style: styleFor(file) });
      report(`${file} (BEGIN:${BLOCK_ID})`, next.changed ? writeFile(path, next.text, { dryRun, root }) : 'unchanged');
    } catch (error) {
      bad(`${file} — ${error.message}`);
      failed = true;
    }
  }

  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) {
    bad('package.json — not found, so no project-local ax version can be pinned');
    failed = true;
  } else if (!plan.bootstrap && !plan.pin) {
    note(`package.json — this checkout IS ${PACKAGE_NAME}: no scripts.ax, and no pin pointing back at itself`);
  } else {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    const pinPath = `devDependencies.${PACKAGE_NAME}`;
    const currentPin = getJsonPath(manifest, pinPath);
    const preservePin =
      typeof currentPin === 'string' &&
      (EXACT_VERSION.test(currentPin) || currentPin.startsWith('link:') || currentPin.startsWith('file:'));
    const migratePin = plan.pin && !preservePin;
    const touched = [
      plan.bootstrap ? setJsonPath(manifest, 'scripts.ax', './bin/ax') : false,
      migratePin ? setJsonPath(manifest, pinPath, PIN) : false,
    ].filter(Boolean);
    if (touched.length === 0) {
      note('package.json — scripts.ax and pin already set');
    } else {
      report('package.json (scripts.ax, pin)', writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, { dryRun, root }));
      if (!dryRun) fix('pnpm install');
    }
  }

  return failed ? 1 : 0;
}
