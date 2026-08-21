// Which worktree did the human mean? One answer, or a refusal — never a guess.
//
// Both destructive verbs take a target from the command line and then reap
// processes, stop containers and delete directories inside whatever it resolved
// to, so a resolution that is merely PLAUSIBLE is a data-loss bug. Two of them
// were measured on this code:
//
//   * `repoPaths(target)` answers `git rev-parse --show-toplevel`, so ANY
//     directory inside a checkout — `apps/web`, or a stale, unregistered
//     `.worktrees/typo` — resolves to the checkout ROOT. `ax worktree clean
//     apps/web` therefore reclaimed the ENTIRE checkout: it killed a process
//     that had nothing to do with it and deleted every build cache.
//   * a bare name was matched by basename and the FIRST hit won. `git worktree
//     add` accepts any path, so two worktrees of one repository can share a
//     basename; standing in one of them, `ax worktree rm feat` cleaned and
//     deleted the OTHER one and exited 0.
//
// Hence the three rules below: a path must name a REGISTERED worktree root
// exactly, a bare name prefers the worktree the caller is standing in, and an
// ambiguous name is refused WITH the candidates instead of resolved by
// position. Nothing here throws — both callers report the refusal and exit.

import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';

import { listWorktrees } from '../git.mjs';

/**
 * Is `candidate` the directory `root`, or inside it?
 *
 * The separator is the whole point. `candidate.startsWith(root)` reads
 * `/x/feat-2` as inside `/x/feat`, which cost `ax worktree rm feat` a refused
 * correct command — "run this from outside the worktree you are removing", from
 * a directory that was not it. `proc.mjs` spells the same rule for the process
 * scan; both sides compare PHYSICAL paths, which is why `physical` exists.
 */
export const withinPath = (candidate, root) => candidate === root || candidate.startsWith(root + sep);

/**
 * Symlink-resolved path, or the input when it names nothing.
 *
 * Every comparison here is against a path git reported, and git reports
 * physical paths: on macOS `os.tmpdir()` and `/var` are symlinks, so an
 * unresolved candidate compares unequal to the very directory it names.
 */
export const physical = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Did the user type a PATH or a NAME?
 *
 * Anything carrying a separator is a path and is never re-read as a name — that
 * is what stops `apps/web` and `.worktrees/typo` from resolving to a checkout
 * root through the repository that encloses them.
 */
const pathShaped = target => isAbsolute(target) || target.includes('/') || target.includes(sep) || target === '.' || target === '..';

/**
 * Resolve `target` to exactly one registered worktree root.
 *
 * `{ path }` on success, `{ error }` — a sentence a human can act on — on every
 * refusal. `trees` is injectable for tests; by default git is asked.
 */
export function locateWorktree(target, { cwd = process.cwd(), root, main, trees } = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    return { error: 'which worktree? pass its name or its path' };
  }

  // A bare repository has no working tree, so it can be neither cleaned nor
  // removed as one.
  const known = (trees ?? listWorktrees(root ?? main ?? cwd)).filter(tree => !tree.bare && tree.path);
  if (known.length === 0) return { error: 'git reports no worktrees for this repository' };

  const here = physical(resolve(cwd));

  if (pathShaped(target)) {
    const candidate = physical(resolve(cwd, target));
    const match = known.find(tree => physical(tree.path) === candidate);
    if (match) return { path: match.path };
    return { error: `"${target}" resolves to ${candidate}, which is not a registered worktree` };
  }

  // The name a human types means "this one" far more often than it means a
  // same-named tree elsewhere. The DEEPEST containing worktree wins, because a
  // linked worktree kept under the primary checkout is inside it too.
  const containing = known
    .filter(tree => withinPath(here, physical(tree.path)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (containing && basename(containing.path) === target) return { path: containing.path };

  const matches = known.filter(tree => basename(tree.path) === target);
  if (matches.length === 1) return { path: matches[0].path };
  if (matches.length === 0) return { error: `no worktree matches "${target}"` };
  return {
    error: `"${target}" names ${matches.length} worktrees — pass the one you mean as a path: ${matches.map(tree => tree.path).join(', ')}`,
  };
}
