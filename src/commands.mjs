// Every command ax has, declared once.
//
// This file exists because the first version of `ax init` wrote an AGENTS.md
// block advertising `ax worktree setup` and `ax debug-as` — neither of which
// the CLI implemented. An agent reading that block runs the command, gets
// "unknown command", and the repo has taught it something false. Documentation
// that outruns the binary is worse than none.
//
// So the registry is the only source: `bin/ax.mjs` builds its help from it and
// dispatches through it, `init` builds the AGENTS.md block from it, and a test
// asserts the block names nothing absent from here. A command becomes visible
// to agents on the day it becomes runnable, not before.

/**
 * `agentLine` is what the AGENTS.md block says about the command — set it only
 * when an agent should reach for it. Commands without one still work; they just
 * do not belong in a repo's onboarding surface.
 */
export const COMMANDS = [
  {
    name: 'doctor',
    usage: 'doctor',
    summary: 'is this checkout coherent? exit 0 when it is',
    agentLine: '`pnpm ax doctor` — is this checkout coherent? Run it first when something local misbehaves.',
  },
  {
    name: 'init',
    usage: 'init [--vendor <owner>/<repo>] [--dry-run]',
    summary: 'write ax.config.json, bin/ax and the managed blocks',
    options: [
      ['--vendor <o/r>', 'upstream kit repo, when it cannot be inferred'],
      ['--dry-run', 'report what would change, write nothing'],
    ],
  },
];

export const commandNames = COMMANDS.map(command => command.name);

/** The lines an agent sees in a project's AGENTS.md, in registry order. */
export const agentLines = () => COMMANDS.filter(command => command.agentLine).map(command => command.agentLine);

export function renderUsage(version) {
  const lines = [`ax ${version} — agent-experience tooling for MakerKit turbo projects`, '', 'Usage: ax <command> [options]', '', 'Commands'];
  const width = Math.max(...COMMANDS.map(command => command.usage.length), 'help'.length);
  for (const command of COMMANDS) {
    lines.push(`  ${command.usage.padEnd(width)}  ${command.summary}`);
    for (const [flag, description] of command.options ?? []) {
      lines.push(`  ${' '.repeat(width)}    ${flag.padEnd(16)}${description}`);
    }
  }
  lines.push(`  ${'help'.padEnd(width)}  this text`, '', 'ax reads ax.config.json at the repository root. See ax.schema.json for every key.', '');
  return lines.join('\n');
}
