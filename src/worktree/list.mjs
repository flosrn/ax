// `ax worktree ls` — which checkouts exist, and what each one is holding.
//
// The question this answers cannot be answered by `git worktree list`, and that
// gap is why it exists: git knows the paths and the branches, and nothing about
// the two resources that actually collide. Two worktrees on one port fight over
// a socket; two on one database block fight over data. Both failures present as
// "the app is behaving like another branch", which is the most expensive kind of
// confusion to debug from inside one of them.
//
// So this reads each worktree's own record rather than probing the machine: the
// recorded value is what the dev server and Playwright will use, and a port that
// is merely free tells you nothing about who claimed it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { listWorktrees } from '../git.mjs';
import { bad, dim, note, section } from '../log.mjs';
import { KEYS } from './plan.mjs';
import { configProjectId } from './supabase.mjs';
import { envFiles, readWorktreeRecord } from './probes.mjs';

export function list() {
  const { root, main } = repoPaths();
  if (!root) {
    bad('not inside a git repository');
    return 1;
  }

  const { config, exists } = loadCheckoutConfig({ root, main });
  if (!exists || !config) {
    bad('no ax.config.json — run `ax init` in the primary checkout first');
    return 1;
  }

  const rows = listWorktrees(root).map(tree => describe(tree, { config, main, here: root }));
  section(`${rows.length} checkout(s)`);
  for (const line of render(rows)) process.stdout.write(`${line}\n`);

  const collisions = collisionsIn(rows);
  for (const clash of collisions) bad(clash);
  if (collisions.length > 0) note('two checkouts claiming one resource — run `ax worktree setup` in the newer one');

  return collisions.length > 0 ? 1 : 0;
}

/**
 * One worktree's claim on this machine.
 *
 * A missing env file is reported as unprovisioned rather than as a default,
 * because "no recorded port" and "port 3000" are different situations: the
 * second is a claim, the first is a worktree that will take whatever it finds.
 */
function describe(tree, { config, main, here }) {
  const provisioned = envFiles(config).some(file => existsSync(join(tree.path, file)));
  const { values } = provisioned ? readWorktreeRecord(tree.path, config, {}) : { values: {} };
  const configToml = join(tree.path, config.apps.web, 'supabase', 'config.toml');

  return {
    name: tree.path.split('/').pop(),
    path: tree.path,
    branch: tree.branch ?? '(detached)',
    port: values.PORT,
    offset: values[KEYS.supabaseOffset],
    projectId: existsSync(configToml) ? configProjectId(configToml) : undefined,
    primary: tree.path === main,
    current: tree.path === here,
    provisioned,
  };
}

function render(rows) {
  const width = key => Math.max(...rows.map(row => String(row[key] ?? '').length));
  const columns = { name: width('name'), branch: width('branch') };

  return rows.map(row => {
    const marker = row.current ? '*' : ' ';
    const port = row.port ? `:${row.port}` : dim(':----');
    const database = row.primary
      ? dim('shared (owner)')
      : row.offset && row.offset !== '0'
        ? `stack +${row.offset}`
        : dim('shared');
    // The primary checkout is never "unprovisioned": it serves the port its
    // committed env pins, owns the shared database, and has nothing for setup
    // to allocate. Telling a human to run setup there is an invitation to
    // rewrite the one checkout everybody's bookmarks point at.
    const state = row.primary || row.provisioned ? '' : dim('  — run `ax worktree setup` there');

    return `${marker} ${row.name.padEnd(columns.name)}  ${row.branch.padEnd(columns.branch)}  ${port}  ${database}${state}`;
  });
}

/**
 * Report two checkouts claiming one port or one database block.
 *
 * The primary checkout is included: it owns its port by convention, and a
 * worktree that recorded the same one is exactly the collision worth naming.
 */
function collisionsIn(rows) {
  const clashes = [];

  for (const [key, label] of [
    ['port', 'port'],
    ['offset', 'database block'],
  ]) {
    const seen = new Map();
    for (const row of rows) {
      const value = row[key];
      if (!value || value === '0') continue;
      const holder = seen.get(value);
      if (holder) clashes.push(`${label} ${value} claimed by both ${holder} and ${row.name}`);
      else seen.set(value, row.name);
    }
  }

  return clashes;
}
