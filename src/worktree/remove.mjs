// `ax worktree rm <name>` — reclaim, THEN remove.
//
// This verb exists because `git worktree remove` is not the whole operation.
// Git deletes the directory and knows nothing about what the checkout was
// holding: the dev server still bound to its port, the containers under its
// project id, the `skip-worktree` bit on a file that no longer has a working
// tree. Reclaiming afterwards is impossible — the record naming those resources
// lived inside the directory git just deleted.
//
// So the order is fixed: clean, then remove.

import { isAbsolute, resolve } from 'node:path';

import { repoPaths } from '../config.mjs';
import { listWorktrees, removeWorktree } from '../git.mjs';
import { bad, fix, ok, section } from '../log.mjs';
import { clean } from './clean.mjs';

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

  const path = locate(target, { root, main });
  if (!path) {
    bad(`no worktree matches "${target}"`);
    fix('ax worktree ls');
    return 1;
  }
  if (path === main) {
    bad('that is the primary checkout — it cannot be removed as a worktree');
    return 1;
  }

  // Reclaim from OUTSIDE the tree being deleted. With the cwd inside it, the
  // shell is left in a directory that stops existing, and the reaper's
  // own-process-group guard spares the very processes holding the tree open.
  if (resolve(process.cwd()).startsWith(path)) {
    bad('run this from outside the worktree you are removing');
    fix(`cd ${main} && ax worktree rm ${target}${force ? ' --force' : ''}`);
    return 1;
  }

  section(`removing ${path}`);
  clean([path]);

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
 * Accept what a human would type: a bare name, an absolute path, or a relative
 * one — but ONLY among the worktrees git actually knows about.
 *
 * A path that merely looks like a worktree is refused on purpose. An
 * unregistered `.worktrees/<name>` is a plain directory INSIDE the primary
 * checkout, so every step that follows would resolve its git root to the
 * primary one: the cleanup would reap the primary checkout's dev server and
 * delete its build caches, and only then would `git worktree remove` correctly
 * fail. A typo must not cost that.
 */
function locate(target, { root }) {
  const trees = listWorktrees(root);
  const byName = trees.find(tree => tree.path.split('/').pop() === target);
  if (byName) return byName.path;

  const candidate = isAbsolute(target) ? target : resolve(process.cwd(), target);
  return trees.find(tree => tree.path === candidate)?.path;
}
