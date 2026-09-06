// The verbs of `ax worktree`, and nothing else.
//
// This dispatch table is asserted equal to the `subcommands` declared in
// src/commands.mjs, which is what stops the help — and the AGENTS.md block
// generated from it — from advertising a verb that answers "unknown command".
// The registry and the runner cannot drift because one test compares them.

import { setup } from './setup.mjs';
import { list } from './list.mjs';
import { clean } from './clean.mjs';
import { reclaim } from './reclaim.mjs';
import { remove } from './remove.mjs';

export const SUBCOMMANDS = { setup, ls: list, clean, rm: remove, reclaim };

/**
 * `ax worktree <verb> [args]`.
 *
 * An unknown verb, or none, is a usage error rather than a default action:
 * guessing between "provision this checkout" and "delete that one" is not a
 * guess worth making.
 */
export function worktree(argv = []) {
  const [verb, ...rest] = argv;
  const run = SUBCOMMANDS[verb];

  if (!run) {
    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax worktree: unknown verb "${verb}" (${known})\n` : `ax worktree: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
