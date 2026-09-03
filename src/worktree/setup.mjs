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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { removeBlock, writeBlock } from '../dotenv.mjs';
import { currentBranch, excludePaths, installHooks, isMainCheckout } from '../git.mjs';
import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { checkoutSkew } from '../delegation.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { CONTEXT_PATH, renderContext } from './context.mjs';
import { identify } from './identity.mjs';
import { PREFIX, planWorktree } from './plan.mjs';
import { probeAll, readWorktreeRecord } from './probes.mjs';
import { promoteFromPlan } from './supabase.mjs';

/** Runtime paths that exist in every worktree and belong in none of its diffs. */
export const RUNTIME_PATHS = ['.agent/', '.turbo/', 'node_modules/'];

/**
 * The receipt for paths this run newly excluded, and it names the scope git
 * implements rather than the one an operator would assume.
 *
 * `excludePaths` writes the file `git rev-parse --git-path info/exclude`
 * resolves, which from a linked worktree is the MAIN checkout's
 * `.git/info/exclude` — common state, shared by every checkout of the
 * repository. `../git.mjs` chooses that file on purpose (these paths are local
 * state, identical in every worktree) and there is no worktree-scoped exclude
 * to write instead. This line said `in this worktree only` until #99, so an
 * operator reading it believed a worktree-local ignore had landed, and then
 * watched dirt appear or vanish on a checkout they never touched.
 */
export const excludeReceipt = added =>
  `git ignores ${added.join(', ')} for this repository — every checkout of it, via the main checkout's .git/info/exclude`;

/**
 * `cwd` is injected for one caller: `ax worker dispatch` places a worktree and
 * then provisions it, and it may not chdir — a process that changed directory
 * mid-dispatch would leave every later step resolving against the child's tree.
 */
export function setup(argv = [], { cwd } = {}) {
  const dryRun = argv.includes('--dry-run');
  const force = forcedDatabase(argv);
  const { root, main } = repoPaths(cwd);

  if (!root) {
    bad('not inside a git repository');
    return 1;
  }

  const { config, exists, errors } = loadCheckoutConfig({ root, main });
  if (!exists || errors.length > 0) {
    bad(exists ? `${errors.length} problem(s) in ax.config.json` : 'no ax.config.json — run `ax init` in the primary checkout first');
    for (const error of errors) note(error);
    // #84: the sentence above sends an operator to edit a file that may be
    // right. When this checkout publishes another ax than the one running, the
    // repair is the other copy, and only this site knows the refusal happened.
    const skew = exists ? checkoutSkew({ root }) : null;
    if (skew !== null) {
      note(skew.finding);
      fix(skew.repair);
    }
    return 1;
  }

  // The primary checkout is not a worktree, and provisioning it would be
  // actively harmful: it serves the port its TRACKED env pins, which is what
  // every bookmark, OAuth callback and teammate's clone already points at.
  // Writing a dev-band port and a proxy hostname into its `.env.local` would
  // move the one address nobody expects to move. Hooks are the exception —
  // they are per-checkout state that belongs everywhere.
  if (isMainCheckout(root)) {
    section('primary checkout');
    if (installHooks(root, '.githooks')) ok('hooks point at the tracked .githooks');
    note('nothing to provision here — this checkout owns its port and the shared database');
    fix('ax worktree ls   # the checkouts that DO get their own port and stack');
    return 0;
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
  if (added.length > 0) ok(excludeReceipt(added));
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
    const started = promoteFromPlan({
      plan,
      config,
      root,
      envPrefix: PREFIX,
      start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'], cwd: root },
      write: writeBlock,
    });
    // `promote` reports whether the stack actually came up, and announcing
    // success without reading that is how a worktree ends up with endpoints
    // recorded for ports nothing answers on — while the doctor confirms the
    // block, because it does not ask either. The database guard already refuses
    // on this; the two callers of one function have to agree.
    if (started.started === false) {
      bad(`the database stack for ${started.projectId} did not start — its endpoints are recorded but nothing is listening there`);
      fix('start the container runtime, then re-run ax worktree setup');
      return 1;
    }

    ok(`isolated stack ${started.projectId} on block +${started.offset}`);

    // A promotion moves the database endpoint, and a dev server already running
    // here has the old one baked into its loaded environment. It keeps serving
    // happily against the SHARED database while every check reports isolation —
    // the most confusing state this tooling can leave behind. Nothing can
    // reload that process from the outside, so the instruction has to be given.
    // The plan is the resolver of whether this block is new (`scan`) or already
    // this worktree's (`recorded` / `config`); `promote` only reports start.
    if (plan.supabase.source !== 'recorded' && plan.supabase.source !== 'config') {
      fix('restart the dev server — the database endpoint just changed');
    }
  } else {
    note('sharing the primary checkout’s database — promoted automatically the first time a command would write');
  }

  // The prose an agent reads before it touches anything here. Written last, so
  // it describes the state that actually landed rather than the state that was
  // planned.
  mkdirSync(join(root, dirname(CONTEXT_PATH)), { recursive: true });
  writeFileSync(join(root, CONTEXT_PATH), renderContext({ plan, config, main }));
  ok(`${CONTEXT_PATH} written — the file an agent reads first`);

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

