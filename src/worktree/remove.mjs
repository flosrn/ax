// `ax worktree rm <name>` — reclaim, THEN remove.
//
// This verb exists because `git worktree remove` is not the whole operation.
// Git deletes the directory and knows nothing about what the checkout was
// holding: the dev server still bound to its port, the containers under its
// project id, the `skip-worktree` bit on a file that no longer has a working
// tree. Reclaiming afterwards is impossible — the record naming those resources
// lived inside the directory git just deleted.
//
// So the order is fixed: clean, then remove. Which makes the PRE-CHECKS the
// other half of the design. Cleanup is irreversible and `git worktree remove`
// can still refuse afterwards; measured, that left a user reading `exit 1` —
// reasonably believing nothing had happened — with their dev server killed,
// their `.next` deleted and their database stack stopped. Anything git will
// refuse for has to be refused HERE, before the first process is signalled.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { repoPaths } from '../config.mjs';
import { listWorktrees, removeWorktree } from '../git.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { clean } from './clean.mjs';
import { locateWorktree, physical, withinPath } from './locate.mjs';

export function remove(argv = []) {
  const force = argv.includes('--force');
  const target = argv.find(arg => !arg.startsWith('-'));
  const { root, main } = repoPaths();

  if (!root) {
    bad('not inside a git repository');
    return 1;
  }
  if (!target) {
    bad('which worktree? `ax worktree rm <name-or-path> [--force]`');
    return 2;
  }

  const located = locateWorktree(target, { cwd: process.cwd(), root, main });
  if (located.error) {
    bad(located.error);
    fix('ax worktree ls');
    return 1;
  }
  const path = located.path;

  if (path === main) {
    bad('that is the primary checkout — it cannot be removed as a worktree');
    return 1;
  }

  // Reclaim from OUTSIDE the tree being deleted. With the cwd inside it, the
  // shell is left in a directory that stops existing, and the reaper's
  // own-process-group guard spares the very processes holding the tree open.
  //
  // Compared with a separator, not as a bare string prefix: `/x/feat-2` is not
  // inside `/x/feat`, and reading it as such refused a correct command.
  if (withinPath(physical(resolve(process.cwd())), physical(path))) {
    bad('run this from outside the worktree you are removing');
    fix(`cd ${main} && ax worktree rm ${target}${force ? ' --force' : ''}`);
    return 1;
  }

  const blocked = notRemovable({ path, main: main ?? root, force });
  if (blocked) {
    bad(blocked.reason);
    for (const line of blocked.detail ?? []) note(line);
    fix(blocked.fix);
    return 1;
  }

  section(`removing ${path}`);

  // Cleanup refuses on state it cannot account for — an invalid ax.config.json
  // names a stack and cache roots it can no longer read. Removing the directory
  // then leaks whatever it was still holding, with no record left of where.
  if (clean([path]) !== 0) {
    bad('cleanup refused — the worktree was left in place');
    return 1;
  }

  const result = removeWorktree({ cwd: main ?? root, path, force });
  if (!result.ok) {
    bad(`git refused to remove the worktree: ${result.out.trim() || `exit ${result.status}`}`);
    if (!force) fix(`ax worktree rm ${target} --force   # discards uncommitted changes in that tree`);
    return 1;
  }

  ok(`removed ${path}`);
  return 0;
}

/**
 * Everything git would refuse to remove for, answered BEFORE cleanup runs.
 *
 * `undefined` means removable. The two conditions mirror git's own: a locked
 * worktree is never removed without unlocking (not even with `--force`), and
 * modified or untracked files need `--force`.
 */
function notRemovable({ path, main, force }) {
  const entry = listWorktrees(main).find(tree => physical(tree.path) === physical(path));
  if (entry?.locked) {
    return { reason: `${path} is locked — git will not remove it, and cleanup would run first`, fix: `git worktree unlock ${path}` };
  }
  if (force) return undefined;

  const changes = uncommitted(path);
  return changes.length === 0
    ? undefined
    : {
        reason: `${changes.length} uncommitted change(s) in ${path} — git would refuse this removal`,
        detail: changes.slice(0, 5),
        fix: `ax worktree rm ${entry ? entry.path : path} --force   # discards uncommitted changes in that tree`,
      };
}

/**
 * Porcelain status lines for a checkout, untracked files included — which is
 * exactly what `git worktree remove` refuses for.
 *
 * An unreadable status answers "clean": git itself has the final say a few
 * lines later, and inventing a refusal from a failed probe would block a
 * legitimate removal. Invoked with an argv array, never a shell string, because
 * a worktree path may hold a space, a quote or a `$`.
 */
function uncommitted(path) {
  const result = spawnSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout.split('\n').filter(line => line.trim() !== '');
}
