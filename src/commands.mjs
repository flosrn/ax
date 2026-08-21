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
import { orcaAvailable } from './orca-bin.mjs';

/**
 * `agentLine` is what the AGENTS.md block says about the command — set it only
 * when an agent should reach for it. Commands without one still work; they just
 * do not belong in a repo's onboarding surface.
 *
 * `runnerless` marks a command the dispatcher answers itself (help), so the
 * startup check does not demand a runner for it.
 *
 * `subcommands` are verbs of one noun, and they exist for the same reason the
 * registry does: `worktree` alone does nothing, so every verb it accepts has to
 * be declared where the help and the AGENTS.md block are built from. A test
 * asserts this list equals the runner's own dispatch table, which is what stops
 * the help from advertising a verb that answers "unknown".
 */

export const COMMANDS = [
  {
    name: 'doctor',
    summary: 'is this checkout coherent? exit 0 when it is',
    agentLine:
      "`pnpm -w ax doctor` — check this checkout's ax config and wiring (`-w`: a workspace package has no `ax` script of its own).",
  },
  {
    name: 'worktree',
    summary: 'provision, inspect and reclaim isolated checkouts',
    subcommands: [
      ['setup', 'make this checkout runnable — own port, own env, own database'],
      ['ls', 'every worktree, with the port and stack each one holds'],
      ['clean [path]', 'reclaim processes, containers and caches; keep the tree'],
      ['rm <name> [--force]', 'reclaim, then remove the tree'],
    ],
    agentLine:
      '`pnpm -w ax worktree setup` — make a fresh worktree runnable, and `ax worktree ls` to see the port and database each one holds.',
  },
  {
    name: 'supabase',
    summary: 'run the Supabase CLI against THIS checkout’s database',
    // Environment, not flags: every argument after the command name belongs to
    // the Supabase CLI, so `ax` claims none of them. They are listed here all
    // the same, because an escape hatch nobody can find is an escape hatch
    // nobody uses — they delete the guard instead.
    options: [
      ['AX_SUPABASE_CLI=<path>', 'the CLI to run when the workspace and PATH have none'],
      ['AX_SUPABASE_GUARD=0', 'skip the guard and run against the shared database'],
    ],
  },
  {
    name: 'worker',
    summary: 'start dispatched agents and inspect them — liveness, gates and transcripts',
    // Gated like board: exists only where the machine resolves an Orca CLI.
    gated: 'orca',
    subcommands: [
      ['start --request <id> …', 'write-ahead dispatch; replay with --resume, never duplicate'],
      ['launch --issue <ref>', 'a ticket becomes a dispatched, verified session'],
      ['ls', 'every dispatch record, counted by LIVE PANE (F-048)'],
      ['tail <handle>', 'alive-with-content / alive-and-silent / cannot-establish'],
      ['gate <task>', 'can this be relaunched without a duplicate agent? 0/1/2/3'],
      ['transcript <cible>', 'a child’s full session, structured and redacted'],
      ['release', 'close a landed pane — proven by artifact, never by a word'],
    ],
  },
  {
    name: 'board',
    summary: 'write this worktree’s sidebar checkpoint — comment and status, never backwards',
    // Gated: this entry exists only where the machine resolves an Orca CLI. A
    // client repo installing ax never sees it — not in the help, not at the
    // dispatch, not in the generated AGENTS.md block (no agentLine).
    gated: 'orca',
    options: [
      ['--worktree <selector>', 'target worktree (default: current, from cwd)'],
      ['--comment <text>', 'sidebar comment — flattened to one line, capped at 160'],
      ['--status <id>', 'todo|in-progress|in-review|completed — never backwards'],
      ['--if-empty', 'write the comment only when none exists yet'],
      ['--verbose', 'say what was written or skipped'],
    ],
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

/**
 * The registry minus the entries this machine cannot answer. Gating is applied
 * HERE, once, and traversed by the help and the dispatch alike — the full
 * COMMANDS table stays intact so the SUBCOMMANDS-equality test keeps comparing
 * complete tables instead of comparing the gate to itself. `orca` is injectable
 * so both states are testable on any machine.
 */
export const visibleCommands = ({ orca = orcaAvailable() } = {}) => COMMANDS.filter(command => command.gated !== 'orca' || orca);

/** The lines an agent sees in a project's AGENTS.md, in registry order. */
export const agentLines = () => COMMANDS.filter(command => command.agentLine).map(command => command.agentLine);

/**
 * The verbs declared for one command, as bare names (`rm <name> [--force]` is
 * `rm`). The runner's dispatch table is asserted equal to this, so the help can
 * never advertise a verb that answers "unknown".
 */
export const subcommandNames = name =>
  (COMMANDS.find(command => command.name === name)?.subcommands ?? []).map(([verb]) => verb.split(' ')[0]);

/**
 * Help composed on the command NAME, never on a usage string.
 *
 * `init [--vendor <owner>/<repo>] [--dry-run]` as a left column is 42
 * characters wide, which pushes every description of every other command out
 * to the right and leaves the flags hanging in whitespace. Names are short and
 * stay short; flags belong indented under the command they modify.
 */
export function renderUsage(version, availability = {}) {
  // The help renders what THIS machine can answer — the gate is applied here
  // and at the dispatch from the same predicate, injectable for tests.
  const visible = visibleCommands(availability);
  const width = Math.max(...visible.map(command => command.name.length));

  const lines = [
    `${bold('ax')} ${version} — agent-experience tooling for MakerKit turbo projects`,
    '',
    bold('Usage'),
    '  ax <command> [options]',
    '',
    bold('Commands'),
  ];

  for (const command of visible) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);

    // Each command's verbs and flags align among THEMSELVES, not against every
    // other command's. One global column let the widest flag in the registry
    // (`--vendor <owner>/<repo>`) push unrelated descriptions past 96 columns,
    // where they wrap in a split pane — the exact laddering this help was
    // rewritten to avoid.
    const inner = [...(command.subcommands ?? []), ...(command.options ?? [])];
    const innerWidth = Math.max(...inner.map(([name]) => name.length), 0);

    for (const [name, description] of inner) {
      lines.push(`  ${' '.repeat(width)}  ${dim(`${name.padEnd(innerWidth)}  ${description}`)}`);
    }
  }

  lines.push('', bold('Config'), `  ${dim('ax.config.json at the repository root — every key is documented in ax.schema.json')}`, '');
  return lines.join('\n');
}
