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
//
// The order of this file is load-bearing. Everything that can REFUSE runs
// before anything that destroys: the target is resolved to a registered
// worktree, then the config is validated, and only then are processes signalled.
// A refusal reached halfway through reads to the user as "nothing happened"
// while their dev server is already dead.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CONFIG_FILE, loadCheckoutConfig, repoPaths } from '../config.mjs';
import { isMainCheckout, listWorktrees } from '../git.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { procsByCwd, reapByCwd } from '../proc.mjs';
import { identify } from './identity.mjs';
import { locateWorktree, physical } from './locate.mjs';
import { KEYS, PREFIX } from './plan.mjs';
import { readWorktreeRecord } from './probes.mjs';
import { ownsStack, resolveProjectId, restoreConfig, teardown } from './supabase.mjs';

/**
 * Command names that are a dev process WHATEVER their command line says.
 *
 * Matched on the NAME, never the command line, because a `next dev` worker
 * retitles itself to `next-server (vX.Y.Z)` — `process.title` overwrites argv —
 * so the worktree path is gone from its command line by the time it matters.
 * Its cwd stays truthful, which is what the scan keys on.
 *
 * `bun` and `deno` are here for the inverse gap the old list had: absent from
 * it, a Bun dev server was never reaped at all. By NAME, because that is how
 * one presents — `bun run dev` carries no path into node_modules for a
 * provenance check to find. They are also not the runtime the bystanders below
 * are written in.
 */
const DEV_TOOLS = /^(next|next-server|esbuild|tsserver|turbo|vitest|playwright|chrome|chromium|supabase|bun|deno)/i;

/**
 * The one runtime whose name decides nothing, because everything is written in
 * it.
 *
 * `^node` used to be enough on its own, and that is how cleanup killed
 * bystanders: a second coding-agent session, a `prod-data-migration` script
 * (measured: TERMed then KILLed, reported only as `node`), a REPL, an editor's
 * extension host — any of them is `node` with its cwd in the worktree. Losing a
 * migration halfway is not a cost cleanup gets to impose silently, so `node`
 * has to prove it is running THIS tree's dev tooling.
 */
const RUNTIMES = /^node$/i;

/** argv entries that name a dev binary even when it lives outside node_modules. */
const DEV_BINARIES = /^(next|vite|turbo|vitest|playwright|jest|tsx|nodemon|remix|astro|nuxt|webpack|rollup|supabase)(\.[cm]?js)?$/i;

/** Build output only. Never node_modules, never anything a human wrote. */
const CACHES = ['.next', '.turbo', 'node-compile-cache'];

export function clean(argv = [], { command = commandLine, reap = reapByCwd, scan = procsByCwd } = {}) {
  const target = argv.find(arg => !arg.startsWith('-'));
  const { root: here, main } = repoPaths();
  if (!here) {
    bad('not inside a git repository');
    return 1;
  }

  // Never `repoPaths(target)`: it answers the enclosing checkout's root for any
  // directory inside it, which turns `clean apps/web` into cleaning the whole
  // checkout. With no target at all the current checkout is the target, and
  // that root is registered by construction.
  const located = target === undefined ? { path: here } : locateWorktree(target, { cwd: process.cwd(), root: here, main });
  if (located.error) {
    bad(located.error);
    fix('ax worktree ls   # the worktrees that can be cleaned');
    return 1;
  }
  const root = located.path;

  const { config, exists, errors } = loadCheckoutConfig({ root, main });
  section(`reclaiming ${root}`);

  // An invalid config is not "no config". It names the database stack, the cache
  // roots and the config.toml whose skip-worktree bit has to be cleared, so
  // proceeding reclaims processes and reports success while seven containers
  // keep running. Refuse before signalling anything — and `rm` reads this exit
  // code and leaves the worktree in place.
  if (exists && !config) {
    bad(`${errors.length} problem(s) in ${CONFIG_FILE} — nothing was reclaimed`);
    for (const error of errors) note(error);
    note('the database stack, the build caches and the skip-worktree bit are all still held');
    fix(`${join(root, CONFIG_FILE)}   # fix these, then re-run`);
    return 1;
  }

  // Same rule, one step earlier: a cache target that escapes the worktree is a
  // config this tool refuses to act on AT ALL, not one it acts on partially. A
  // partial clean that exits 0 is how the raw-`caches` defect stayed invisible
  // — `rm -rf packages/ui` was reported as `removed 7 build cache path(s)`.
  const caches = config ? cacheTargets(config) : [];
  const escaping = caches.filter(target => isAbsolute(target) || relative(root, resolve(root, target)).startsWith('..'));
  if (escaping.length > 0) {
    bad(`${escaping.length} cache path(s) in ${CONFIG_FILE} point outside ${root} — nothing was reclaimed`);
    for (const target of escaping) note(`refusing to delete ${target}`);
    fix(`${join(root, CONFIG_FILE)}   # apps.caches entries are workspace roots, relative to the worktree`);
    return 1;
  }

  reclaimProcesses(root, { command, reap, scan });

  if (!config) {
    note(`no ${CONFIG_FILE} — reclaimed processes only`);
    return 0;
  }

  reclaimDatabase({ root, config, primary: isMainCheckout(root) });
  reclaimCaches(root, caches);
  return 0;
}

/**
 * Whether a process found in this tree may be signalled, as an ALLOW-list.
 *
 * The two mistakes are not symmetric: sparing too little kills work nobody
 * asked cleanup to touch, while sparing too much leaves a dev server holding a
 * port — recoverable with one more command. So a named dev tool is reaped, a
 * bare runtime is reaped only when its command line points into THIS tree's
 * node_modules (where a package manager's `.bin` shim resolves) or names a dev
 * binary, and everything else survives.
 *
 * Exported because this predicate is the whole safety property; it is tested
 * directly, with the command line injected.
 */
export function reapable(root, command = commandLine) {
  const modules = `${physical(root)}${sep}node_modules${sep}`;
  return ({ pid, comm }) => {
    if (DEV_TOOLS.test(comm)) return true;
    if (!RUNTIMES.test(comm)) return false;

    const line = command(pid) ?? '';
    if (line.includes(modules)) return true;
    // argv[0] is the runtime itself; only what it was asked to RUN can name a
    // dev binary.
    return line.split(/\s+/).slice(1).some(argument => DEV_BINARIES.test(basename(argument)));
  };
}

/**
 * The command line of a pid, as one string. Empty when it cannot be read.
 *
 * Platform-split for the same reason the cwd scan is: Linux exposes argv
 * through /proc, macOS only through `ps`. Never through a shell — a command
 * line is arbitrary text.
 */
function commandLine(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    // Not Linux, or the process is gone; `ps` answers both the same way.
  }
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/**
 * TERM, then KILL for whatever ignored it.
 *
 * The reaper never signals its own process group, so running this from inside
 * the worktree being cleaned cannot kill the cleanup itself. The name filter is
 * applied to the SCAN rather than passed as `pattern`, because the decision
 * needs the process's command line and not just its name.
 */
function reclaimProcesses(root, { command, reap, scan }) {
  const victims = path => scan(path).filter(reapable(root, command));

  const termed = reap(root, { signal: 'TERM', scan: victims });
  if (termed.length === 0) {
    note('no dev processes running here');
    return;
  }

  ok(`asked ${termed.length} process(es) to stop: ${termed.map(process => process.comm).join(', ')}`);
  const killed = reap(root, { signal: 'KILL', scan: victims });
  if (killed.length > 0) note(`${killed.length} ignored TERM and was killed`);
}

/**
 * Stop the isolated stack, and only ever the one THIS worktree owns.
 *
 * Two guards, both load-bearing. The primary checkout OWNS the shared stack, so
 * stopping it takes the database out from under every other session — the exact
 * opposite of cleanup. And ownership is decided by IDENTITY: the id in
 * `config.toml` must be the id this worktree resolves to. "Differs from HEAD" is
 * not that — a config.toml carrying another checkout's or the machine's shared
 * id differs from HEAD too, and stopping it is the loss these guards exist to
 * prevent.
 *
 * The expected id is RESOLVED rather than minted from the current branch, so a
 * `git branch -m` does not turn a stack this worktree started into a foreign
 * one it then refuses to stop. Teardown addresses the id the config actually
 * carries, which is the only name Docker knows the containers by.
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
  const expected = resolveProjectId({
    identity: worktreeIdentity(root),
    prefix: `${config.project.name}-`,
    recorded: values[`${PREFIX}SUPABASE_PROJECT`],
    cwd: root,
    relativePath,
    base: config.ports.supabaseBase,
  });
  // Containers under an id nothing here addresses are the one outcome that must
  // never be silent: unstopped and unnamed, they outlive the directory.
  if (expected.conflict) note(expected.conflict);

  const owned = ownsStack({ cwd: root, relativePath, expectedProjectId: expected.projectId });
  if (!owned.owned) {
    bad(`env records block +${offset}, but ${relativePath} does not name a stack this worktree owns`);
    note(owned.reason ?? `it does not carry ${expected.projectId}`);
    note('stopping it could take the database out from under another checkout, so nothing was stopped');
    return;
  }

  const projectId = owned.projectId ?? expected.projectId;
  const { stopped, refused } = teardown({ cwd: root, projectId });
  if (refused) bad(`stack ${projectId} was not stopped: ${refused}`);
  else ok(stopped ? `stopped isolated stack ${projectId} (block +${offset})` : `stack ${projectId} was not running`);

  // Clearing skip-worktree before the directory can disappear keeps the index
  // honest. Left set, it makes later checkouts elsewhere behave in ways nobody
  // connects back to a worktree that no longer exists.
  restoreConfig({ cwd: root, relativePath });
  ok(`${relativePath} restored to the committed version`);
}

/**
 * Who this worktree is, derived exactly as `setup` derives it.
 *
 * The branch comes from `git worktree list` rather than a second `rev-parse`,
 * so there is one answer per checkout and no separate way for this file to be
 * wrong about it.
 */
function worktreeIdentity(root) {
  const entry = listWorktrees(root).find(tree => physical(tree.path) === physical(root));
  return identify({ worktreePath: root, branch: entry?.branch, marker: join(root, '.orca-worktree.json') });
}

/**
 * Every path this cleanup would delete, relative to the worktree.
 *
 * `apps.caches` entries are ROOTS, which the schema states outright ("extra
 * workspace roots whose .next/.turbo/test output a worktree cleanup reclaims").
 * They used to be appended to the delete set RAW while every other `apps.*`
 * value got the cache names appended, so a project configuring
 * `caches: ["packages/ui"]` as documented got `rm -rf packages/ui` — tracked
 * source and all — reported as `removed N build cache path(s)`.
 *
 * Separated from the deletion so the caller can VALIDATE the whole set before
 * anything is reclaimed: a config is a file anyone can edit, and every path
 * here is about to be handed to a recursive delete.
 */
function cacheTargets(config) {
  const named = Object.entries(config.apps ?? {})
    .filter(([key, value]) => key !== 'caches' && typeof value === 'string')
    .map(([, value]) => value);
  const roots = ['.', ...named, ...(config.apps?.caches ?? []).filter(entry => typeof entry === 'string')];
  return [...new Set(roots.flatMap(base => CACHES.map(cache => join(base, cache))))];
}

/** Delete this worktree's build output. Every target is already inside it. */
function reclaimCaches(root, targets) {
  let removed = 0;
  for (const target of targets) {
    const full = resolve(root, target);
    try {
      if (!existsSync(full)) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A cache that cannot be removed is not a failure worth stopping for.
    }
  }
  ok(`removed ${removed} build cache path(s)`);
}
