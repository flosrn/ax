// The CLI body: argv in, exit code out.
//
// This lives in `src/` rather than in `bin/ax.mjs` because the bin entry is no
// longer the CLI — it delegates. A globally installed ax has to run the version
// a PROJECT installed, and the only way to do that without spawning a second
// Node and re-entering the same entry is to import the local package's
// implementation. So the implementation is an exported function, and the bin
// entry is the thing that decides whose implementation runs.

import { COMMANDS, renderUsage, retiredCommand, visibleCommands } from './commands.mjs';
import { board } from './board.mjs';
import { orcaAvailable } from './orca-bin.mjs';
import { worker } from './worker/index.mjs';
import { repoPaths, version } from './config.mjs';
import { doctor } from './doctor.mjs';
import { init } from './init.mjs';
import { fatal } from './log.mjs';
import { supabase } from './supabase-guard.mjs';
import { worktree } from './worktree/index.mjs';
import { triage } from './triage/index.mjs';
import { pr } from './pr/index.mjs';
import { pin } from './pin.mjs';

/**
 * Every command's entry point, keyed by the name declared in the registry. A
 * runner returns the process exit code; the argv slice is passed through
 * unparsed wherever the command owns its own arguments.
 */
const runners = argv => ({
  doctor: () => (doctor() === 0 ? 0 : 1),
  init: ({ root, flag, value }) => {
    if (!root) {
      fatal('ax init must run inside a git repository');
      return 1;
    }
    return init(root, { dryRun: flag('dry-run'), vendor: value('vendor') });
  },
  // Verbs of one noun get the remaining argv, unparsed: `rm <name> --force`
  // needs its own positional, and the flag helpers below are whole-command.
  worktree: () => worktree(argv.slice(1)),
  // Same reason, and stronger: every argument after `supabase` is the Supabase
  // CLI's own, so ax must not parse, reorder or consume a single one of them.
  supabase: () => supabase(argv.slice(1)),
  // Fail-open hook writer — its own module owns the always-zero exit contract.
  board: () => board(argv.slice(1)),
  // Verbs of one noun get the remaining argv, unparsed — same as worktree.
  worker: () => worker(argv.slice(1)),
  // Same, and its verbs each carry their own repeated --issue positionals.
  triage: () => triage(argv.slice(1)),
  // Same again: `gate --pr <n>` carries its own flags, and none is whole-command.
  pr: () => pr(argv.slice(1)),
  // One positional version; --dry-run is whole-command but rides argv for symmetry.
  pin: () => pin(argv.slice(1)),
});

/**
 * A registry entry with no runner would print in the help and fail on use — the
 * exact drift the registry exists to prevent, so it fails at startup. `help` is
 * answered by `runCli` itself and says so with `runnerless`.
 */
function assertRunners(table) {
  for (const entry of COMMANDS) {
    if (!entry.runnerless && !table[entry.name]) throw new Error(`command "${entry.name}" is declared but has no runner`);
  }
}

/** Run one ax invocation. Returns the exit code; never calls process.exit. */
export function runCli(argv = []) {
  const table = runners(argv);
  assertRunners(table);

  const command = argv[0];
  const context = {
    root: repoPaths().root,
    flag: name => argv.includes(`--${name}`),
    value: name => {
      const index = argv.indexOf(`--${name}`);
      return index === -1 ? undefined : argv[index + 1];
    },
  };

  if (command === undefined || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(renderUsage(version));
    return 0;
  }
  if (['--version', '-v'].includes(command)) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (table[command] && !(COMMANDS.find(entry => entry.name === command)?.gated === 'orca' && !orcaAvailable())) {
    return table[command](context) ?? 0;
  }
  // A gated command on a machine without Orca is EXACTLY an unknown command:
  // it does not exist here, and the help printed below does not list it.
  //
  // A RETIRED NOUN IS UNKNOWN TOO — the exit code and the help are the same —
  // but it is unknown for a reason the caller can act on, so it earns one line
  // naming the replacement, composed from that command's own declared verb
  // (../commands.mjs). Only when the replacement is answerable HERE: naming
  // `ax triage status` on a machine whose help does not list `triage` trades
  // one dead end for two.
  const retired = retiredCommand(command, argv[1] ?? '');
  const replaces = retired !== null && visibleCommands({ orca: orcaAvailable() }).some(entry => entry.name === retired.to);
  process.stderr.write(
    `ax: unknown command "${command}"${replaces ? ` — it is \`ax ${retired.to}\` now: ${retired.why}\n\n  ${retired.fix}\n` : ''}\n\n${renderUsage(version)}`,
  );
  return 2;
}
