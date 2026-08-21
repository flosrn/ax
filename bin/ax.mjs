#!/usr/bin/env node
import { COMMANDS, renderUsage } from '../src/commands.mjs';
import { repoPaths, version } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { init } from '../src/init.mjs';
import { fatal } from '../src/log.mjs';

const RUNNERS = {
  doctor: () => (doctor() === 0 ? 0 : 1),
  init: ({ root, flag, value }) => {
    if (!root) {
      fatal('ax init must run inside a git repository');
      return 1;
    }
    return init(root, { dryRun: flag('dry-run'), vendor: value('vendor') });
  },
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
} else if (RUNNERS[command]) {
  process.exitCode = RUNNERS[command](context);
} else {
  process.stderr.write(`ax: unknown command "${command}"\n\n${renderUsage(version)}`);
  process.exitCode = 2;
}

// A registry entry with no runner would print in the help and fail on use —
// the exact drift this registry exists to prevent, so it fails at startup.
for (const entry of COMMANDS) {
  if (!RUNNERS[entry.name]) throw new Error(`command "${entry.name}" is declared but has no runner`);
}
