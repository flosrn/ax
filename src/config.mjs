import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyDefaults, validate } from './schema.mjs';

export const CONFIG_FILE = 'ax.config.json';
export const PACKAGE_NAME = '@flosrn/ax';

const HERE = dirname(fileURLToPath(import.meta.url));

export const schema = JSON.parse(readFileSync(join(HERE, '..', 'ax.schema.json'), 'utf8'));
export const version = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;

/** Asset shipped with the package, resolved from this file so a moved install follows. */
export const assetPath = (...parts) => join(HERE, '..', 'assets', ...parts);

/**
 * The checkout the command applies to, and the primary checkout behind it.
 *
 * A worktree is the normal case here, not the exception: `--show-toplevel` is
 * the worktree, `--git-common-dir` points into the primary checkout, and the
 * difference is exactly what worktree tooling has to reason about. Both are
 * resolved once, here, so no subcommand re-derives it a sixth way.
 */
export function repoPaths(from = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']);
  } catch {
    return { root: null, main: null };
  }
  let main = root;
  try {
    const commonDir = resolve(root, git(['rev-parse', '--git-common-dir']));
    main = dirname(commonDir);
  } catch {
    // A repository without a resolvable common dir is its own primary checkout.
  }
  return { root, main, isWorktree: main !== root };
}

/**
 * Read and validate `ax.config.json`.
 *
 * Returns `{ path, exists, config, errors }` rather than throwing: `ax doctor`
 * has to report an invalid config as a finding with a fix, not die on it.
 */
export function loadConfig(repoRoot) {
  const path = join(repoRoot, CONFIG_FILE);
  if (!existsSync(path)) return { path, exists: false, config: null, errors: [] };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { path, exists: true, config: null, errors: [`${CONFIG_FILE}: not valid JSON (${error.message})`] };
  }

  const errors = validate(raw, schema);
  if (errors.length > 0) return { path, exists: true, config: null, errors };

  const config = applyDefaults(raw, schema);
  config.project.display ??= config.project.name;
  return { path, exists: true, config, errors: [] };
}

/**
 * The remote that points at the vendor kit, found by URL.
 *
 * Never by name: ofmchat calls it `makerkit` (naming it `upstream` breaks Orca's
 * primary-remote detection), gapila may call it something else, and a project
 * cloned by a client will call it whatever the clone did. The URL is the only
 * stable identity.
 */
export function vendorRemote(repoRoot, vendorRepo) {
  let output;
  try {
    output = execFileSync('git', ['remote', '-v'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const needle = vendorRepo.toLowerCase();
  for (const line of output.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (!name || !url) continue;
    const normalized = url.toLowerCase().replace(/\.git$/, '');
    if (normalized.endsWith(`/${needle}`) || normalized.endsWith(`:${needle}`)) return name;
  }
  return null;
}
