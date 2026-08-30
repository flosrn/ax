// The verbs of `ax pr`, and nothing else.
//
// Same contract as ../worker/index.mjs: this dispatch table is asserted equal to
// the `subcommands` declared in src/commands.mjs, so the help — and nothing else
// — can never advertise a verb that answers "unknown".
//
// Unlike `worker` and `ready`, this noun is NOT gated on Orca: `gate` reads
// `gh` and `git` only, so it answers on any machine that has a GitHub CLI and a
// checkout. Gating it would hide the one verb a client repo can actually use.

import { gate } from '../pr-gate.mjs';

export const SUBCOMMANDS = { gate };

/**
 * `ax pr <verb> [args]`.
 *
 * An unknown verb, or none, is a usage error rather than a default action: this
 * noun's one verb decides a merge, and guessing which question the caller asked
 * is not a guess worth making.
 */
export function pr(argv = []) {
  const [verb, ...rest] = argv;
  const run = SUBCOMMANDS[verb];

  if (!run) {
    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax pr: unknown verb "${verb}" (${known})\n` : `ax pr: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
