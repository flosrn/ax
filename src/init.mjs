import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { applyBlock, getJsonPath, setJsonPath, styleFor } from './blocks.mjs';
import { agentLines } from './commands.mjs';
import { CONFIG_FILE, PACKAGE_NAME, assetPath, loadConfig, vendorRemote, version } from './config.mjs';
import { EXACT_VERSION } from './delegation.mjs';
import { bad, fix, note, ok, section } from './log.mjs';

// An exact npm version, not a git tag and not a range: ax is published to the
// registry now, so the pin a project carries is the version its lockfile
// resolves and the version the global CLI delegates to. Exact rather than
// `^`, because "the tooling a repo chose" is a decision, and a caret quietly
// changes it on the next unrelated install.
export const PIN = version;
export const BLOCK_ID = 'ax';

/** OMP reads package roots from this project setting and then its `omp.extensions` manifest. */
export const OMP_SETTINGS = '.omp/settings.json';
/** The 0.10 wiring; removed only when its bytes prove ax owns it. */
export const LEGACY_OMP_LOADER = '.omp/extensions/ax.ts';
export const OMP_PACKAGE_ROOT = `./node_modules/${PACKAGE_NAME}`;
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
 * `.orca-worktree.json` is deliberately absent while the Orca adapter still
 * lives in the project — ofmchat already ignores it, with a comment saying
 * which script writes it. Claiming it here too would print the same path twice
 * in a file a human reads. It joins this list when `ax orca` does.
 */
export const GITIGNORE_BODY = ['.worktrees/', '.agent/', '.scratch/'].join('\n');

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

/** Infer what can be inferred; refuse to guess what must be decided. */
function inferConfig(root, explicitVendor) {
  const packagePath = join(root, 'package.json');
  const manifest = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : {};
  const rawName = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name : basename(root);
  const name = rawName
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return { error: `cannot infer project.name from package.json or the repository directory — write ${CONFIG_FILE} by hand` };

  const apps = { web: existsSync(join(root, 'apps', 'web')) ? 'apps/web' : '.' };
  if (existsSync(join(root, 'apps', 'e2e'))) apps.e2e = 'apps/e2e';

  // Vendor ownership is one optional repo shape. Detect MakerKit when present;
  // a plain repository has no upstream tree to guard and needs no empty
  // placeholder pretending otherwise.
  const vendor = explicitVendor ?? (vendorRemote(root, 'makerkit/next-supabase-saas-kit-turbo') ? 'makerkit/next-supabase-saas-kit-turbo' : null);
  const config = {
    $schema: `./node_modules/${PACKAGE_NAME}/ax.schema.json`,
    project: { name },
    apps,
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

/** The package root OMP loads: source for ax itself, installed bytes everywhere else. */
export function ompExtensionRoot(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return manifest.name === PACKAGE_NAME ? '.' : OMP_PACKAGE_ROOT;
  } catch {
    return OMP_PACKAGE_ROOT;
  }
}

function wireOmp(root, { dryRun }) {
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

  const expected = ompExtensionRoot(root);
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
 * The one config violation with a mechanical repair rather than a decision, and
 * the reason it is a function instead of a literal in two files: `triage` was
 * the umbrella name for the readiness surface until it was renamed to `ready`,
 * so a config written for an older ax fails on that key first — and "unknown
 * key" alone does not say where the key WENT. Both `ax init` and `ax doctor`
 * meet that refusal while a consuming repo pins the release; a repair only one
 * of them names is a repair half the operators never see.
 *
 * ROOT LEVEL ONLY, matched as the validator's own whole line rather than as a
 * substring. Two looser readings were both wrong. A substring of the WORD sends
 * a config whose real defect merely QUOTES a value like `needs-triage` — a
 * mistyped `launch.databaseLabels`, say — to rename a key it does not have. And
 * a substring of `unknown key "triage"` matches ANY nesting level, because
 * ./schema.mjs prints the location (`${where}: unknown key "${key}"`): a nested
 * `launch.triage` reports `launch: unknown key "triage"` and would earn advice
 * to rename a root key the config never carried, sending the operator to edit a
 * line that is already correct while the real nested defect stays.
 */
export const namesLegacyReadyKey = errors => errors.some(error => error === 'root: unknown key "triage"');

/** One sentence, printed by both verbs, so the two can never drift apart. */
export const LEGACY_READY_KEY_FIX = `rename the "triage" key to "ready" in ${CONFIG_FILE} — the noun is \`ax ready\` now, because triage is one pass under it and not the whole of it (the jobs are --job triage|brief|custom)`;

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
    if (namesLegacyReadyKey(existing.errors)) fix(LEGACY_READY_KEY_FIX);
    return 1;
  }
  if (!existing.exists) {
    const inferred = inferConfig(root, vendor);
    if (inferred.error) {
      bad(`${CONFIG_FILE} — ${inferred.error}`);
      if (inferred.hint) fix(inferred.hint);
      return 1;
    }
    report(CONFIG_FILE, writeFile(existing.path, `${JSON.stringify(inferred.config, null, 2)}\n`, { dryRun, root }));
  } else {
    note(`${CONFIG_FILE} — already valid`);
  }

  report('bin/ax', writeFile(join(root, 'bin', 'ax'), readFileSync(assetPath('bootstrap', 'ax'), 'utf8'), { dryRun, mode: 0o755, root }));

  // Register the PACKAGE ROOT, not a wrapper file. OMP uses the package's
  // `omp.extensions` manifest, and this same root exposes everything ax ships
  // as one version. Existing project settings and native extensions survive.
  const omp = wireOmp(root, { dryRun });
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
  } else {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    const pinPath = `devDependencies.${PACKAGE_NAME}`;
    const currentPin = getJsonPath(manifest, pinPath);
    const preservePin =
      typeof currentPin === 'string' &&
      (EXACT_VERSION.test(currentPin) || currentPin.startsWith('link:') || currentPin.startsWith('file:'));
    const migratePin = !preservePin;
    const touched = [
      setJsonPath(manifest, 'scripts.ax', './bin/ax'),
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
