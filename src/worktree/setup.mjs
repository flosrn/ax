// `ax worktree setup` — make this checkout actually runnable.
//
// `git worktree add` hands you a directory with no node_modules, no local env,
// a dev server that will fight the primary checkout for its port, and a
// database connection pointing at data another branch is mutating. Setup is
// what closes that gap, and it must be idempotent: re-running it on a live
// worktree is the normal case, not a repair.
//
// The shape is deliberate and shared with `doctor`:
//
//   probe (machine) -> plan (pure) -> apply (writes)
//
// Only the third step is allowed to change anything, so a plan can be printed,
// diffed or re-derived without provisioning a thing.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { removeBlock, writeBlock } from '../dotenv.mjs';
import { excludePaths, installHooks, isMainCheckout } from '../git.mjs';
import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { identify } from './identity.mjs';
import { PREFIX, planWorktree } from './plan.mjs';
import { probeAll, readWorktreeRecord } from './probes.mjs';
import { promote } from './supabase.mjs';

/** Runtime paths that exist in every worktree and belong in none of its diffs. */
const RUNTIME_PATHS = ['.agent/', '.turbo/', 'node_modules/'];

export function setup(argv = []) {
  const dryRun = argv.includes('--dry-run');
  const force = forcedDatabase(argv);
  const { root, main } = repoPaths();

  if (!root) {
    bad('not inside a git repository');
    return 1;
  }

  const { config, exists, errors } = loadCheckoutConfig({ root, main });
  if (!exists || errors.length > 0) {
    bad(exists ? `${errors.length} problem(s) in ax.config.json` : 'no ax.config.json — run `ax init` in the primary checkout first');
    for (const error of errors) note(error);
    return 1;
  }

  const identity = identify({ worktreePath: root, branch: currentBranch(root), marker: join(root, '.orca-worktree.json') });
  const { values: recorded, legacy } = readWorktreeRecord(root, config);
  const plan = planWorktree({
    identity,
    worktreePath: root,
    config,
    recorded,
    probes: probeAll({ worktreePath: root, config, recorded, force }),
  });

  section(`worktree ${identity.name}${identity.issue ? ` (issue #${identity.issue})` : ''}`);
  for (const line of plan.log) note(line);
  for (const { key, from } of legacy) note(`${key} read from the older ${from} — setup rewrites it under the current name`);

  if (dryRun) {
    ok('dry run — nothing written');
    return 0;
  }

  return apply({ plan, config, root, main });
}

/**
 * Write the plan down, in an order that survives being interrupted.
 *
 * The env files come first and the container last. A worktree whose env
 * records a stack that was never started is repaired by re-running setup; a
 * running stack no env file names is seven orphaned containers nobody will
 * connect back to this directory.
 */
function apply({ plan, config, root, main }) {
  if (!existsSync(join(root, 'node_modules'))) {
    note('node_modules missing — run your package manager’s install in this worktree');
  }

  const added = excludePaths(root, RUNTIME_PATHS);
  if (added.length > 0) ok(`git ignores ${added.join(', ')} in this worktree only`);
  if (installHooks(root, '.githooks')) ok('hooks point at the tracked .githooks');

  let changed = 0;
  for (const write of plan.env) {
    const path = join(root, write.file);
    // A plan entry either records state or erases it. Erasing matters when a
    // checkout stops being isolated: left in place, the old endpoints outlive
    // the stack they describe.
    const applied = write.remove ? removeBlock(path, write.label) : writeBlock(path, write);
    if (applied) changed += 1;
  }
  ok(changed === 0 ? 'env files already match the plan' : `updated ${changed} env block(s)`);

  if (plan.supabase.mode === 'isolated') {
    const started = promote({
      cwd: root,
      identity: plan.identity,
      base: config.ports.supabaseBase,
      step: config.ports.step,
      maxSlot: config.ports.maxSlot,
      recorded: String(plan.supabase.offset),
      relativePath: join(config.apps.web, 'supabase', 'config.toml'),
      envFiles: [join(config.apps.web, '.env.local')],
      envLabel: 'Supabase endpoints',
      envPrefix: PREFIX,
      apiUrl: plan.urls.publishedUrl,
      prefix: `${config.project.name}-`,
      start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'], cwd: root },
      write: writeBlock,
    });
    ok(`isolated stack ${started.projectId} on block +${started.offset}`);

    // A promotion moves the database endpoint, and a dev server already running
    // here has the old one baked into its loaded environment. It keeps serving
    // happily against the SHARED database while every check reports isolation —
    // the most confusing state this tooling can leave behind. Nothing can
    // reload that process from the outside, so the instruction has to be given.
    if (started.offsetSource !== 'recorded') fix('restart the dev server — the database endpoint just changed');
  } else {
    note('sharing the primary checkout’s database — promoted automatically the first time a command would write');
  }

  section('this worktree');
  ok(`serves ${plan.urls.publishedUrl}`);
  if (plan.urls.publishedUrl !== plan.urls.directUrl) note(`direct: ${plan.urls.directUrl}`);
  if (isMainCheckout(root) && root === main) note('this IS the primary checkout');
  fix('ax worktree ls   # every worktree, with the port and stack it holds');
  return 0;
}

/** `--database` / `--no-database` force the decision the probe would make. */
function forcedDatabase(argv) {
  if (argv.includes('--database')) return true;
  if (argv.includes('--no-database')) return false;
  return undefined;
}

/** A detached HEAD has no branch name; the plan falls back to the directory. */
function currentBranch(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch === 'HEAD' ? undefined : branch;
  } catch {
    return undefined;
  }
}
