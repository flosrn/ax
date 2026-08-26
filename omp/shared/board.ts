/**
 * The one place both extensions spawn `ax board` from.
 *
 * Mechanics only, deliberately stateless: the give-up latch belongs to the
 * caller whose cadence needs it — checkpoint stops retrying a doomed spawn on
 * every todo flip, while report's one-shot `in-review` must always get its
 * attempt, and a shared latch would let the first suppress the second.
 *
 * NEVER a `--worktree` selector: `ax board` defaults to `current`, which Orca
 * resolves from the cwd this child is spawned in. A computed selector is the
 * documented incident (checkpoint's WORKTREE_ROOT): wrong root, selector
 * matching nothing, and every write a silent no-op on a writer that exits 0 on
 * every path by design.
 *
 * `axArgv()` is this package's own CLI, not a resolved binary — see `./ax.ts`
 * for the version skew that cost.
 */

import { axArgv } from './ax.ts';

type SpawnFn = (argv: string[], opts: Record<string, unknown>) => { unref(): void };

const defaultSpawn: SpawnFn = (argv, opts) => Bun.spawn(argv, opts);

/**
 * Detached, ignored stdio: a board write outlives the turn if it has to and
 * nothing it prints can land in the TUI. Returns `false` only when the spawn
 * itself threw — this package's own CLI entry could not be run at all — so a
 * repeated caller can stop; `true` otherwise, including "nothing to write".
 */
export function boardWrite(
  payload: { comment?: string; status?: string },
  spawn: SpawnFn = defaultSpawn,
): boolean {
  const args = ['board'];
  if (payload.comment) args.push('--comment', payload.comment);
  if (payload.status) args.push('--status', payload.status);
  // Nothing beyond the verb means nothing to write.
  if (args.length === 1) return true;

  try {
    spawn([...axArgv(), ...args], {
      cwd: process.cwd(),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref();
    return true;
  } catch {
    return false;
  }
}
