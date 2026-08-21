// `ax worktree clean` — give back everything this checkout is holding.
//
// Every resource reclaimed here is invisible until it hurts: a dev server still
// bound to a port whose worktree was deleted, seven containers under a project
// id nobody recognises, a `skip-worktree` bit that makes a later checkout in
// another worktree behave inexplicably. None of it shows up in `git status`.
//
// Safe to run on a worktree someone is still using — that is a design
// constraint, not a side effect. It reclaims build output, never node_modules:
// cleanup doubles as a maintenance step, and a reinstall costs minutes.

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { isMainCheckout } from '../git.mjs';
import { bad, note, ok, section } from '../log.mjs';
import { reapByCwd } from '../proc.mjs';
import { KEYS } from './plan.mjs';
import { readWorktreeRecord } from './probes.mjs';
import { configProjectId, isIsolatedConfig, restoreConfig, teardown } from './supabase.mjs';

/**
 * What may be signalled, as an ALLOW-list on the command name.
 *
 * An allow-list rather than a list of shells to spare, because the two mistakes
 * are not symmetric: sparing too little kills the terminal the cleanup was
 * launched from, or an editor holding unsaved work. Everything named here is a
 * process a dev server owns and can lose without a human noticing.
 *
 * Matched on the command NAME, never the command line, because a `next dev`
 * worker retitles itself to `next-server (vX.Y.Z)` — `process.title` overwrites
 * argv — so the worktree path is gone from its command line by the time it
 * matters. Its cwd stays truthful, which is what the scan keys on.
 */
const REAPABLE = /^(node|next|next-server|esbuild|tsserver|turbo|vitest|playwright|chrome|chromium|supabase)/i;

/** Build output only. Never node_modules, never anything a human wrote. */
const CACHES = ['.next', '.turbo', 'node-compile-cache'];

export function clean(argv = []) {
  const target = argv.find(arg => !arg.startsWith('-'));
  const { root, main } = repoPaths(target ?? process.cwd());
  if (!root) {
    bad('not inside a git repository');
    return 1;
  }

  const { config } = loadCheckoutConfig({ root, main });
  section(`reclaiming ${root}`);

  reclaimProcesses(root);
  if (!config) {
    note('no ax.config.json — reclaimed processes only');
    return 0;
  }

  reclaimDatabase({ root, config, primary: isMainCheckout(root) });
  reclaimCaches(root, config);
  return 0;
}

/**
 * TERM, then KILL for whatever ignored it.
 *
 * The reaper never signals its own process group, so running this from inside
 * the worktree being cleaned cannot kill the cleanup itself.
 */
function reclaimProcesses(root) {
  const termed = reapByCwd(root, { signal: 'TERM', pattern: REAPABLE });
  if (termed.length === 0) {
    note('no dev processes running here');
    return;
  }

  ok(`asked ${termed.length} process(es) to stop: ${termed.map(process => process.comm).join(', ')}`);
  const killed = reapByCwd(root, { signal: 'KILL', pattern: REAPABLE });
  if (killed.length > 0) note(`${killed.length} ignored TERM and was killed`);
}

/**
 * Stop the isolated stack, and only ever the isolated one.
 *
 * Two guards, both load-bearing. The primary checkout OWNS the shared stack, so
 * stopping it takes the database out from under every other session — the exact
 * opposite of cleanup. And an env file recording an offset while `config.toml`
 * is still the committed shared one means the promotion never completed: acting
 * on that record would stop the shared stack while believing it was isolated.
 */
function reclaimDatabase({ root, config, primary }) {
  if (primary) {
    note('primary checkout — leaving the shared database running');
    return;
  }

  const { values } = readWorktreeRecord(root, config, {});
  const offset = values[KEYS.supabaseOffset];
  if (!offset || offset === '0') {
    note('no isolated database recorded here — nothing to stop');
    return;
  }

  const relativePath = join(config.apps.web, 'supabase', 'config.toml');
  if (!isIsolatedConfig({ cwd: root, relativePath })) {
    bad(`env records block +${offset} but ${relativePath} still carries the committed project id`);
    note('that promotion never completed — stopping now would stop the SHARED stack, so nothing was stopped');
    return;
  }

  const projectId = configProjectId(join(root, relativePath));

  const { stopped } = teardown({ cwd: root, projectId });
  ok(stopped ? `stopped isolated stack ${projectId} (block +${offset})` : `stack ${projectId} was not running`);

  // Clearing skip-worktree before the directory can disappear keeps the index
  // honest. Left set, it makes later checkouts elsewhere behave in ways nobody
  // connects back to a worktree that no longer exists.
  restoreConfig({ cwd: root, relativePath });
  ok(`${relativePath} restored to the committed version`);
}

function reclaimCaches(root, config) {
  const apps = Object.values(config.apps ?? {}).filter(app => typeof app === 'string');
  const targets = new Set([...CACHES, ...apps.flatMap(app => CACHES.map(cache => join(app, cache))), ...(config.apps.caches ?? [])]);

  let removed = 0;
  for (const target of targets) {
    try {
      rmSync(join(root, target), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A cache that cannot be removed is not a failure worth stopping for.
    }
  }
  ok(`removed ${removed} build cache path(s)`);
}
