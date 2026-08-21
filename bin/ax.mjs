#!/usr/bin/env node
import { repoPaths, version } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { init } from '../src/init.mjs';
import { fatal } from '../src/log.mjs';

const USAGE = `ax ${version} — agent-experience tooling for MakerKit turbo projects

Usage: ax <command> [options]

Commands
  doctor              is this checkout coherent? exit 0 when it is
  init                write ax.config.json, bin/ax and the managed blocks
    --vendor <o/r>      upstream kit repo, when it cannot be inferred
    --dry-run           report what would change, write nothing
  help                this text

ax reads ax.config.json at the repository root. See ax.schema.json for every key.
`;

const args = process.argv.slice(2);
const command = args[0];
const flag = name => args.includes(`--${name}`);
const value = name => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const { root } = repoPaths();

switch (command) {
  case 'doctor': {
    process.exitCode = doctor() === 0 ? 0 : 1;
    break;
  }
  case 'init': {
    if (!root) {
      fatal('ax init must run inside a git repository');
      break;
    }
    process.exitCode = init(root, { dryRun: flag('dry-run'), vendor: value('vendor') });
    break;
  }
  case '--version':
  case '-v': {
    process.stdout.write(`${version}\n`);
    break;
  }
  case undefined:
  case 'help':
  case '--help':
  case '-h': {
    process.stdout.write(USAGE);
    break;
  }
  default: {
    process.stderr.write(`ax: unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 2;
  }
}
