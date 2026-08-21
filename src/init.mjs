import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { applyBlock, setJsonPath, styleFor } from './blocks.mjs';
import { agentLines } from './commands.mjs';
import { CONFIG_FILE, PACKAGE_NAME, assetPath, loadConfig, vendorRemote, version } from './config.mjs';
import { bad, fix, note, ok, section } from './log.mjs';

// A git tag, not an npm range: this package is not on the registry, and the tag
// is a decision a rollback can point back at. pnpm resolves it over the git
// credentials the machine already has, private repo included. Publishing later
// changes this one line.
export const PIN = `github:flosrn/ax#v${version}`;
export const BLOCK_ID = 'ax';

/**
 * Lines ax owns in .gitignore: runtime state of the AX layer, nothing else.
 *
 * `.orca-worktree.json` is deliberately absent while the Orca adapter still
 * lives in the project — ofmchat already ignores it, with a comment saying
 * which script writes it. Claiming it here too would print the same path twice
 * in a file a human reads. It joins this list when `ax orca` does.
 */
export const GITIGNORE_BODY = ['.worktrees/', '.agent/', '.scratch/'].join('\n');

/**
 * What an agent opening this repo needs in order to act — built from the
 * command registry, so it can never advertise a command the CLI does not run.
 */
export const agentsBody = () =>
  [
    '## Local tooling',
    '',
    "This repo's local checkout tooling runs through the `ax` CLI.",
    '',
    ...agentLines().map(line => `- ${line}`),
    '',
    `Ports, app paths and guarded vendor trees come from \`${CONFIG_FILE}\`. Read them from there —`,
    'a port or hostname written into a script is wrong in every other worktree.',
  ].join('\n');

/** Infer what can be inferred; refuse to guess what must be decided. */
function inferConfig(root, explicitVendor) {
  const packagePath = join(root, 'package.json');
  const manifest = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : {};
  const rawName = typeof manifest.name === 'string' ? manifest.name : '';
  const name = rawName
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return { error: `cannot infer project.name from package.json — write ${CONFIG_FILE} by hand` };

  const apps = {};
  if (existsSync(join(root, 'apps', 'web'))) apps.web = 'apps/web';
  if (existsSync(join(root, 'apps', 'e2e'))) apps.e2e = 'apps/e2e';
  if (!apps.web) return { error: `no apps/web here — write ${CONFIG_FILE} by hand with the real path` };

  // Only ever used to seed the config once. After that the config is the truth
  // and remotes are matched against it, by URL.
  const vendor = explicitVendor ?? (vendorRemote(root, 'makerkit/next-supabase-saas-kit-turbo') ? 'makerkit/next-supabase-saas-kit-turbo' : null);
  if (!vendor) return { error: 'no vendor kit remote found', hint: 'ax init --vendor <owner>/<repo>' };

  return {
    config: {
      $schema: `./node_modules/${PACKAGE_NAME}/ax.schema.json`,
      project: { name },
      apps,
      vendor: { repo: vendor },
    },
  };
}

function writeFile(path, content, { dryRun, mode }) {
  const exists = existsSync(path);
  if (exists && readFileSync(path, 'utf8') === content) return 'unchanged';
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    if (mode !== undefined) chmodSync(path, mode);
  }
  return exists ? 'updated' : 'created';
}

const report = (label, state) => (state === 'unchanged' ? note(`${label} — unchanged`) : ok(`${label} — ${state}`));

/**
 * Make a project ax-ready: the config, the committed bootstrap, and the managed
 * touchpoints in files the vendor also owns. Safe to re-run — that is how a
 * block survives a merge that took "theirs".
 */
export function init(root, { dryRun = false, vendor } = {}) {
  section(`ax init${dryRun ? ' (dry run — nothing written)' : ''} — ${root}`);
  let failed = false;

  const existing = loadConfig(root);
  if (existing.exists && existing.errors.length > 0) {
    bad(`${CONFIG_FILE} — invalid, leaving it untouched`);
    for (const error of existing.errors) note(error);
    return 1;
  }
  if (!existing.exists) {
    const inferred = inferConfig(root, vendor);
    if (inferred.error) {
      bad(`${CONFIG_FILE} — ${inferred.error}`);
      if (inferred.hint) fix(inferred.hint);
      return 1;
    }
    report(CONFIG_FILE, writeFile(existing.path, `${JSON.stringify(inferred.config, null, 2)}\n`, { dryRun }));
  } else {
    note(`${CONFIG_FILE} — already valid`);
  }

  report('bin/ax', writeFile(join(root, 'bin', 'ax'), readFileSync(assetPath('bootstrap', 'ax'), 'utf8'), { dryRun, mode: 0o755 }));

  for (const [file, body] of [
    ['.gitignore', GITIGNORE_BODY],
    ['AGENTS.md', agentsBody()],
  ]) {
    const path = join(root, file);
    const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
    try {
      const next = applyBlock(source, { id: BLOCK_ID, body, style: styleFor(file) });
      report(`${file} (BEGIN:${BLOCK_ID})`, next.changed ? writeFile(path, next.text, { dryRun }) : 'unchanged');
    } catch (error) {
      bad(`${file} — ${error.message}`);
      failed = true;
    }
  }

  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) {
    bad('package.json — not found, so no `pnpm ax` and no version pin');
    failed = true;
  } else {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    // Named keys, never a fenced block: JSON has no comment syntax to fence with.
    const touched = [setJsonPath(manifest, 'scripts.ax', './bin/ax'), setJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`, PIN)].filter(Boolean);
    if (touched.length === 0) {
      note('package.json — scripts.ax and pin already set');
    } else {
      report('package.json (scripts.ax, pin)', writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, { dryRun }));
      if (!dryRun) fix('pnpm install');
    }
  }

  return failed ? 1 : 0;
}
