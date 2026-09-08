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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { removeBlock, writeBlock } from '../dotenv.mjs';
import { currentBranch, excludePaths, installHooks, isMainCheckout } from '../git.mjs';
import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { checkoutSkew, installCommand } from '../delegation.mjs';
import { run as execRun } from '../exec.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { CONTEXT_PATH, renderContext } from './context.mjs';
import { identify } from './identity.mjs';
import { PREFIX, planWorktree } from './plan.mjs';
import { probeAll, readWorktreeRecord } from './probes.mjs';
import { promoteFromPlan } from './supabase.mjs';

/** Runtime paths that exist in every worktree and belong in none of its diffs. */
export const RUNTIME_PATHS = ['.agent/', '.turbo/', 'node_modules/'];

/**
 * Installs take minutes, not the 30 seconds every other exec in this package
 * budgets for — the same measurement `../pin.mjs` carries, on the same machine:
 * a pnpm install over a MakerKit workspace ran near a minute warm.
 */
const INSTALL_TIMEOUT_MS = 600_000;

/**
 * The install this package assumes, injected so the suite stays offline.
 *
 * pnpm, and bare: `../delegation.mjs` already names `pnpm install` as the repair
 * for a missing install, and a bare install is FROZEN by default there (pnpm 11,
 * measured in `../pin.mjs`), which is what a worktree wants — the lockfile the
 * branch committed, or a refusal naming the drift, never a silently different
 * tree than the one the primary checkout resolved.
 */
export const setupInstall = at => execRun('pnpm', ['install'], { cwd: at, timeout: INSTALL_TIMEOUT_MS });

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
export function setup(argv = [], { cwd, install = setupInstall } = {}) {
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

  return apply({ plan, config, root, main, install });
}

/**
 * Write the plan down, in an order that survives being interrupted.
 *
 * THE INSTALL COMES FIRST, and it is a write like any other. This step printed
 * `node_modules missing — run your package manager's install in this worktree`
 * and moved on, which left two costs downstream: the isolated-database branch
 * below starts its stack through `pnpm --filter web supabase:start`, a command
 * that cannot run in a tree with no install, and `ax worker dispatch` waited out
 * its whole equipment budget — 180 seconds, reported 2026-09-08 from a consumer
 * on 0.21.1 — for an install nobody had been asked to run, then refused the
 * worktree it had just provisioned, with a repair the operator ran by hand in
 * 1.6 seconds.
 *
 * A FAILED INSTALL ENDS THE RUN. Nothing after this point can succeed in a tree
 * whose dependencies are not there, and starting seven containers for it would
 * be the orphaned-stack state the ordering below exists to avoid. Re-running
 * setup after the repair is the normal case.
 *
 * The env files come next and the container last. A worktree whose env
 * records a stack that was never started is repaired by re-running setup; a
 * running stack no env file names is seven orphaned containers nobody will
 * connect back to this directory.
 */
function apply({ plan, config, root, main, install }) {
  if (plan.install) {
    const installed = install(root);
    if (installed.error || installed.status !== 0) {
      const detail =
        String(installed.error ?? '').trim() ||
        String(installed.stderr ?? '')
          .split('\n')
          .filter(Boolean)
          .slice(-3)
          .join(' | ') ||
        `exit ${installed.status}`;
      bad(`the install failed in this worktree (${detail}) — nothing here can run, and a child dispatched into it would boot with no AX bundle`);
      fix(`${installCommand(root)}   # resolve it there, then re-run ax worktree setup`);
      return 1;
    }
    ok('dependencies installed — this worktree can run, and carries the AX bundle a child loads');
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
    const result = promoteFromPlan({
      plan,
      config,
      root,
      envPrefix: PREFIX,
      start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'], cwd: root },
      write: writeBlock,
    });
    // `promote` reports whether the start command succeeded. Announcing
    // isolation without reading that leaves endpoints recorded for a stack
    // whose start failed — while the doctor confirms the block, because it
    // does not ask either. The database guard already refuses on this; the
    // two callers of one function have to agree. A failed start is not proof
    // that nothing is listening, so the repair is the captured diagnostic.
    if (result.started === false) {
      bad(`the database stack for ${result.projectId} did not start successfully — its endpoints are recorded, but startup is not confirmed`);
      for (const line of String(result.failure).split('\n')) note(line);
      fix('resolve the startup failure above, then re-run ax worktree setup --database');
      return 1;
    }

    ok(`isolated stack ${result.projectId} on block +${result.offset}`);

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

