// The verbs of `ax worker`, and nothing else.
//
// Same contract as ../worktree/index.mjs: this dispatch table is asserted equal
// to the `subcommands` declared in src/commands.mjs, so the help — and nothing
// else — can never advertise a verb that answers "unknown". The whole noun is
// gated on Orca resolution at the registry (a client repo without Orca never
// sees `worker` at all), so the verbs themselves assume a machine that HAS an
// Orca CLI and fail closed on a runtime that does not answer.

import { retiredSubcommand } from '../commands.mjs';
import { bad, fix, note } from '../log.mjs';
import { start } from './start.mjs';
import { repair } from './repair.mjs';
import { gate } from './gate.mjs';
import { ls } from './ls.mjs';
import { tail } from './tail.mjs';
import { transcript } from './transcript.mjs';
import { release } from './release.mjs';
import { dispatch } from './dispatch.mjs';
import { sweep } from './sweep.mjs';

export const SUBCOMMANDS = { start, repair, dispatch, ls, tail, gate, transcript, release, sweep };

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
    // A RENAMED verb is not an unknown one, and the difference is what the
    // operator needs: `launch` was this noun's creation verb until 0.16, so a
    // line out of a shell history and a doc written before the rename both land
    // here. The replacement is declared in the registry beside the verbs
    // (../commands.mjs), so the help and this answer name the same set.
    const retired = retiredSubcommand('worker', verb);
    if (retired) {
      bad(`ax worker ${verb} is now ax worker ${retired.to} — ${retired.why}`);
      note('The pipeline is the same: placement, setup, the recorded dispatch, role/model proof, recovery.');
      fix(retired.fix);
      return 2;
    }

    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax worker: unknown verb "${verb}" (${known})\n` : `ax worker: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
