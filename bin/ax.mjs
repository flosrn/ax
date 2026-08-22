#!/usr/bin/env node
import { COMMANDS, renderUsage } from '../src/commands.mjs';
import { board } from '../src/board.mjs';
import { orcaAvailable } from '../src/orca-bin.mjs';
import { worker } from '../src/worker/index.mjs';
import { repoPaths, version } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { init } from '../src/init.mjs';
import { fatal } from '../src/log.mjs';
import { supabase } from '../src/supabase-guard.mjs';
import { worktree } from '../src/worktree/index.mjs';
import { triage } from '../src/triage/index.mjs';
import { pr } from '../src/pr/index.mjs';

const RUNNERS = {
  doctor: () => (doctor() === 0 ? 0 : 1),
  init: ({ root, flag, value }) => {
    if (!root) {
      fatal('ax init must run inside a git repository');
      return 1;
    }
    return init(root, { dryRun: flag('dry-run'), vendor: value('vendor') });
  },
  // Verbs of one noun get the remaining argv, unparsed: `rm <name> --force`
  // needs its own positional, and the flag helpers above are whole-command.
  worktree: () => worktree(args.slice(1)),
  // Same reason, and stronger: every argument after `supabase` is the Supabase
  // CLI's own, so ax must not parse, reorder or consume a single one of them.
  supabase: () => supabase(args.slice(1)),
  // Fail-open hook writer — its own module owns the always-zero exit contract.
  board: () => board(args.slice(1)),
  // Verbs of one noun get the remaining argv, unparsed — same as worktree.
  worker: () => worker(args.slice(1)),
  // Same, and its verbs each carry their own repeated --issue positionals.
  triage: () => triage(args.slice(1)),
  // Same again: `gate --pr <n>` carries its own flags, and none is whole-command.
  pr: () => pr(args.slice(1)),
};

const args = process.argv.slice(2);
const command = args[0];
const context = {
  root: repoPaths().root,
  flag: name => args.includes(`--${name}`),
  value: name => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  },
};

if (command === undefined || ['help', '--help', '-h'].includes(command)) {
  process.stdout.write(renderUsage(version));
} else if (['--version', '-v'].includes(command)) {
  process.stdout.write(`${version}\n`);
} else if (RUNNERS[command] && !(COMMANDS.find(entry => entry.name === command)?.gated === 'orca' && !orcaAvailable())) {
  process.exitCode = RUNNERS[command](context);
} else {
  // A gated command on a machine without Orca is EXACTLY an unknown command:
  // it does not exist here, and the help printed below does not list it.
  process.stderr.write(`ax: unknown command "${command}"\n\n${renderUsage(version)}`);
  process.exitCode = 2;
}

// A registry entry with no runner would print in the help and fail on use — the
// exact drift this registry exists to prevent, so it fails at startup. `help`
// is answered by the dispatcher itself and says so with `runnerless`.
for (const entry of COMMANDS) {
  if (!entry.runnerless && !RUNNERS[entry.name]) throw new Error(`command "${entry.name}" is declared but has no runner`);
}
