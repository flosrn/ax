// The verbs of `ax worker`, and nothing else.
//
// Same contract as ../worktree/index.mjs: this dispatch table is asserted equal
// to the `subcommands` declared in src/commands.mjs, so the help — and nothing
// else — can never advertise a verb that answers "unknown". The whole noun is
// gated on Orca resolution at the registry (a client repo without Orca never
// sees `worker` at all), so the verbs themselves assume a machine that HAS an
// Orca CLI and fail closed on a runtime that does not answer.

import { gate } from './gate.mjs';
import { ls } from './ls.mjs';
import { tail } from './tail.mjs';
import { transcript } from './transcript.mjs';

export const SUBCOMMANDS = { ls, tail, gate, transcript };

/**
 * `ax worker <verb> [args]`.
 *
 * An unknown verb, or none, is a usage error rather than a default action:
 * these verbs read live orchestration state, and guessing which question the
 * caller asked is not a guess worth making.
 */
export function worker(argv = []) {
  const [verb, ...rest] = argv;
  const run = SUBCOMMANDS[verb];

  if (!run) {
    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax worker: unknown verb "${verb}" (${known})\n` : `ax worker: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
