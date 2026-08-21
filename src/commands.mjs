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

import { bold, dim } from './log.mjs';

/**
 * `agentLine` is what the AGENTS.md block says about the command — set it only
 * when an agent should reach for it. Commands without one still work; they just
 * do not belong in a repo's onboarding surface.
 *
 * `runnerless` marks a command the dispatcher answers itself (help), so the
 * startup check does not demand a runner for it.
 */

export const COMMANDS = [
  {
    name: 'doctor',
    summary: 'is this checkout coherent? exit 0 when it is',
    agentLine:
      "`pnpm -w ax doctor` — check this checkout's ax config and wiring (`-w`: a workspace package has no `ax` script of its own).",
  },
  {
    name: 'init',
    summary: 'write ax.config.json, bin/ax and the managed blocks',
    options: [
      ['--vendor <owner>/<repo>', 'upstream kit, when no remote names it'],
      ['--dry-run', 'report what would change, write nothing'],
    ],
  },
  { name: 'help', summary: 'this text', runnerless: true },
];

export const commandNames = COMMANDS.map(command => command.name);

/** The lines an agent sees in a project's AGENTS.md, in registry order. */
export const agentLines = () => COMMANDS.filter(command => command.agentLine).map(command => command.agentLine);

/**
 * Help composed on the command NAME, never on a usage string.
 *
 * `init [--vendor <owner>/<repo>] [--dry-run]` as a left column is 42
 * characters wide, which pushes every description of every other command out
 * to the right and leaves the flags hanging in whitespace. Names are short and
 * stay short; flags belong indented under the command they modify.
 */
export function renderUsage(version) {
  const width = Math.max(...COMMANDS.map(command => command.name.length));
  const flagWidth = Math.max(...COMMANDS.flatMap(command => (command.options ?? []).map(([flag]) => flag.length)), 0);

  const lines = [
    `${bold('ax')} ${version} — agent-experience tooling for MakerKit turbo projects`,
    '',
    bold('Usage'),
    '  ax <command> [options]',
    '',
    bold('Commands'),
  ];

  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
    for (const [flag, description] of command.options ?? []) {
      lines.push(`  ${' '.repeat(width)}  ${dim(`${flag.padEnd(flagWidth)}  ${description}`)}`);
    }
  }

  lines.push('', bold('Config'), `  ${dim('ax.config.json at the repository root — every key is documented in ax.schema.json')}`, '');
  return lines.join('\n');
}
