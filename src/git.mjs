// Every git question this package asks, answered in one place.
//
// Two properties are load-bearing here and nowhere obvious from the call sites:
//
//   * git is invoked through an argv ARRAY, never a shell string. Worktree
//     paths come from branch names and from the user, so a path holding a
//     space, a quote or a `$` is ordinary — through a shell it splits or
//     expands, and the command silently operates on something else.
//   * a non-zero git exit is data, not an exception. Teardown calls
//     `removeWorktree` on a tree that may already be gone; a throw there aborts
//     the rest of the cleanup.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { capture as execCapture } from './exec.mjs';

/** Override for the primary checkout. Wins only when it names a real directory. */
export const MAIN_CHECKOUT_ENV = 'AX_MAIN_CHECKOUT';

/** Run git, never through a shell. Returns the exit status instead of throwing. */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) return { ok: false, status: null, out: result.error.message };
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, status: result.status, out };
}

/** Stdout of a successful git command, or `undefined`. Errors are not findings here. */
const capture = (cwd, args) => execCapture('git', args, { cwd });

const physical = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const isDirectory = path => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The working tree `cwd` belongs to, absolute and symlink-resolved.
 *
 * Resolved because every path comparison downstream is physical: on macOS
 * `os.tmpdir()` and `/var` are symlinks, so an unresolved root compares unequal
 * to the same directory reported by git or by the kernel.
 *
 * `undefined` when `cwd` is not inside a repository — callers report that, they
 * do not guess a root.
 */
export function repoRoot(cwd = process.cwd()) {
  const root = capture(cwd, ['rev-parse', '--show-toplevel']);
  return root === undefined ? undefined : physical(root);
}

/**
 * The PRIMARY checkout, correct when called from a linked worktree.
 *
 * Derived from `--git-common-dir`, whose parent is the primary checkout, because
 * that is the only answer git itself vouches for. Both shortcuts that suggest
 * themselves are wrong: `join(here, '..')` is the worktree's parent directory,
 * and a `.worktrees/` layout is a convention this package configures rather than
 * one it can assume — `git worktree add` accepts any path.
 *
 * The trap, and the reason the relative answer is resolved against the SAME cwd
 * it was asked from: `--git-common-dir` answers relative to the caller's
 * directory. Asked from `apps/web` it returns `../../.git`; re-anchoring that at
 * the repository root points two levels ABOVE the repo, and the wrong directory
 * then shows up in a repair command as if it were the checkout. The same bug
 * was measured and fixed in this package's bootstrap script.
 */
export function mainCheckout(cwd = process.cwd(), { env = process.env } = {}) {
  const override = env[MAIN_CHECKOUT_ENV];
  if (override && isDirectory(override)) return physical(override);

  const common =
    capture(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ?? // needs git >= 2.31
    capture(cwd, ['rev-parse', '--git-common-dir']);
  if (common === undefined) return repoRoot(cwd);

  const parent = dirname(resolve(cwd, common));
  // A submodule's common dir is `.git/modules/<name>`, whose parent names no
  // working tree at all. Do not invent one.
  return isDirectory(parent) ? physical(parent) : repoRoot(cwd);
}

/** Whether `cwd` is in the primary checkout rather than a linked worktree. */
export function isMainCheckout(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (root === undefined) return false;
  return root === mainCheckout(cwd);
}

/** The branch `cwd` sits on, or `undefined` for a detached HEAD (or no repository) — callers fall back to the directory. */
export function currentBranch(cwd) {
  const branch = capture(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch === 'HEAD' ? undefined : branch;
}

/**
 * Every registered worktree: `[{ path, head, branch, bare, detached, locked }]`.
 *
 * The porcelain form is not an optimisation, it is the only parseable one: the
 * human-readable output packs path, head and branch onto one space-separated
 * line, so a worktree at `~/Code/my project` cannot be read back from it.
 */
export function listWorktrees(cwd = process.cwd()) {
  // `-z` (git >= 2.36) also survives a path containing a newline; the plain
  // porcelain form is the fallback and handles everything short of that.
  const nul = capture(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (nul !== undefined) return parseWorktrees(nul, '\0');
  const plain = capture(cwd, ['worktree', 'list', '--porcelain']);
  return plain === undefined ? [] : parseWorktrees(plain, '\n');
}

function parseWorktrees(text, separator) {
  const entries = [];
  let current;
  const flush = () => {
    if (current) entries.push(current);
    current = undefined;
  };

  for (const record of text.split(separator)) {
    const line = record.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);

    if (key === 'worktree') {
      flush();
      current = { path: value, head: undefined, branch: undefined, bare: false, detached: false, locked: false };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
  }
  flush();
  return entries;
}

/**
 * Create a worktree. `branch` is created when given, `base` is its start point.
 *
 * Returns `{ ok, status, out }`: the interesting failures (branch already
 * checked out, path not empty) are reported to the user with git's own wording,
 * which a thrown Error would bury.
 */
export function addWorktree({ cwd = process.cwd(), path, branch, base }) {
  const args = ['worktree', 'add'];
  if (branch) args.push('-b', branch);
  args.push(path);
  if (base) args.push(base);
  return git(cwd, args);
}

/** Remove a worktree. `force` also removes one with local modifications. */
export function removeWorktree({ cwd = process.cwd(), path, force = false }) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  return git(cwd, args);
}

/**
 * Add ignore rules for runtime artefacts, and return the ones actually added.
 *
 * `info/exclude` rather than `.gitignore` because these paths are local state:
 * they are produced by running the tooling, they are identical in every
 * worktree, and they are nobody else's business in a shared tracked file.
 */
export function excludePaths(cwd = process.cwd(), paths = []) {
  const relative = capture(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  if (relative === undefined) return [];
  const file = resolve(cwd, relative); // relative to the cwd we asked from — see mainCheckout

  let existing = '';
  if (existsSync(file)) existing = readFileSync(file, 'utf8');
  else mkdirSync(dirname(file), { recursive: true });

  // Exact whole-line matching, like `grep -qxF`: `.agent/` must not be
  // considered present because `!.agent/keep` mentions it.
  const present = new Set(existing.split('\n').map(line => line.replace(/\r$/, '')));
  const missing = paths.filter(entry => entry !== '' && !present.has(entry));
  if (missing.length === 0) return [];

  const lead = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${lead}${missing.join('\n')}\n`);
  return missing;
}

/**
 * Point git at the repo's tracked hooks directory.
 *
 * `.git/hooks/` is per-clone and untracked, so a hook written there exists on
 * one machine and nowhere else — a fresh clone and every worktree run without
 * it. The setting is repo-WIDE even when written from a linked worktree (git
 * keeps `core.hooksPath` in the shared config), so one call covers every
 * checkout, and a relative path is what makes it valid from all of them.
 *
 * The trade, stated because it bites silently: this DISABLES `.git/hooks/`
 * wholesale for every checkout. Anything living there stops running.
 *
 * Returns whether the tracked hooks are in force; `false` means the directory
 * does not exist in this checkout and nothing was changed.
 */
export function installHooks(cwd = process.cwd(), hooksDir) {
  if (!hooksDir) return false;
  const root = repoRoot(cwd) ?? cwd;
  if (!isDirectory(join(root, hooksDir))) return false;

  if (capture(cwd, ['config', '--local', '--get', 'core.hooksPath']) === hooksDir) return true;
  return git(cwd, ['config', '--local', 'core.hooksPath', hooksDir]).ok;
}
