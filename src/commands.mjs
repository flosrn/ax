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

import { description } from './config.mjs';
import { bold, dim } from './log.mjs';
import { orcaAvailable } from './orca-bin.mjs';

/**
 * `agentLine` is what the AGENTS.md block says about the command — set it only
 * when an agent should reach for it. Commands without one still work; they just
 * do not belong in a repo's onboarding surface.
 * `runnerless` marks a command the CLI's own router answers (help), so the
 * startup check does not demand a runner for it.
 *
 * `subcommands` are verbs of one noun, and they exist for the same reason the
 * registry does: `worktree` alone does nothing, so every verb it accepts has to
 * be declared where the help and the AGENTS.md block are built from. A test
 * asserts this list equals the runner's own dispatch table, which is what stops
 * the help from advertising a verb that answers "unknown".
 *
 * `retired` names where a verb WENT, and is read by that noun's unknown-verb
 * path. See `retiredSubcommand`.
 *
 * `plumbing` names the verbs of one noun that are DECLARED and dispatchable but
 * deliberately absent from every surface an agent reads. See
 * `plumbingSubcommands`.
 *
 * `section` is the help heading the command is printed under, and every entry
 * declares one. See `SECTIONS`.
 */

/**
 * The help's domain sections, in the order they are printed — the `gh` shape,
 * where a reader finds a verb by the job it serves rather than by reading the
 * whole list (`docs/adr/0001`).
 *
 * ax stays FLAT at the CLI, and this is what pays for that: the room a future
 * domain needs — automated checks, architecture rules, context rules — is a
 * section it gets listed in, never an `ax checks <verb>` prefix nested under a
 * noun. A new domain is one registry entry plus the section it belongs to.
 *
 * `help` sits in PROJECT next to `init`, `pin` and `doctor`: what you type
 * about the checkout itself, as opposed to about one worktree or one wave.
 */
export const SECTIONS = ['PROJECT', 'WORKTREE', 'ORCHESTRATION'];

export const COMMANDS = [
  {
    name: 'doctor',
    section: 'PROJECT',
    summary: 'is this checkout coherent? exit 0 when it is',
    agentLine: "`ax doctor` — check this checkout's config, project wiring and recorded worktree state.",
  },
  {
    name: 'worktree',
    section: 'WORKTREE',
    summary: 'provision, inspect and reclaim isolated checkouts',
    subcommands: [
      ['setup', 'make this checkout runnable — own port, own env, own database'],
      ['ls', 'every worktree, with the port and stack each one holds'],
      ['clean [path]', 'reclaim processes, containers and caches; keep the tree'],
      ['rm <name> [--force]', 'reclaim, then remove the tree'],
    ],
    agentLine: '`ax worktree setup` — make a fresh worktree runnable, and `ax worktree ls` to see the port and database each one holds.',
  },
  {
    name: 'supabase',
    section: 'WORKTREE',
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
    section: 'ORCHESTRATION',
    summary: 'dispatch agents and inspect them — liveness, gates and transcripts',
    // Gated like board: exists only where the machine resolves an Orca CLI.
    gated: 'orca',
    subcommands: [
      ['start --request <id> …', 'write-ahead dispatch; replay with --resume, never duplicate'],
      ['repair --request <id>', 'deliver the RECORDED brief into a live, idle pane'],
      ['dispatch --issue <ref>', 'a ticket, or a bare --name, becomes a verified session'],
      ['ls [--all]', 'capacity and overlap; --all: the MORT and unsettled rows'],
      ['tail <handle|request>', 'alive / silent / cannot-establish / exited (4)'],
      ['gate <task|request>', 'can this be re-dispatched without a duplicate agent? 0/1/2/3'],
      ['transcript <target>', 'a child’s session, or --last-message: its last word'],
      ['release', 'close a landed pane — proven by artifact, never by a word'],
      ['sweep --under <path>', 'reclaim browsers a session left open — by the AGE of a root'],
    ],
    // `launch` was this verb until 0.16: one gesture creates implementation
    // work, and everything that records it — the store record, the receipt, the
    // `dispatch` config block — already called it a dispatch.
    retired: {
      launch: { to: 'dispatch', why: 'one verb creates implementation work, and the record, the receipt and the config block all call it a dispatch' },
    },
    // `start` is the OTHER half of that decision (`docs/adr/0001`): the agent-
    // facing surface offers exactly one way to create a child, so the verb that
    // `dispatch` itself issues and replays stops competing with it for the
    // gesture. Declared, dispatchable, unadvertised — plumbing, in git's sense.
    plumbing: {
      start: 'the write-ahead half of a dispatch — `worker dispatch` issues it, and replays it byte for byte on recovery',
    },
  },
  {
    name: 'board',
    section: 'ORCHESTRATION',
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
    name: 'triage',
    section: 'ORCHESTRATION',
    summary: 'the on-ramp: turn an issue that ARRIVED into work an agent can execute',
    // Gated on the same predicate as `worker`: the dispatch needs an Orca CLI.
    // `publish` needs only `gh`, but it publishes what a dispatched session
    // wrote, so a machine that cannot dispatch has nothing to publish either.
    gated: 'orca',
    subcommands: [
      ['dispatch --issue N …', 'one session per issue, capped — no tree, no branch'],
      ['ask --issue N', "send the draft's own Q<n> lines, and wait for rulings"],
      ['status [--issue N …]', 'what each dispatch recorded, and its recovery'],
      ['answer --issue N --id <msg>', 'pair rulings from --file to the questions, then reply'],
      ['publish --issue N …', 'apply what a draft names — never closes an issue'],
      ['release --issue N', "free the finished pass's pane, resolving its dispatch"],
    ],
  },
  {
    name: 'pr',
    section: 'ORCHESTRATION',
    summary: 'decide whether a pull request may merge, and merge it',
    // The one verb here reads `gh` and `git` only, so unlike `worker` and
    // `triage` this noun carries no `gated` key: it answers wherever ax is
    // installed, which is the whole point of porting the Bash into the package.
    subcommands: [['gate --pr <n> [--issue <n>]', 'every ground, executed on the head SHA — 0/1/2/3']],
  },
  {
    name: 'frontier',
    section: 'ORCHESTRATION',
    // Ungated like `pr`: pure `gh` reads plus a read-only look at the dispatch
    // store, so it answers wherever ax is installed — no Orca required to ask
    // what is takeable.
    summary: 'the takeable ticket set — blockers, provenance and dispatch state, one receipt',
    agentLine: '`ax frontier` — the takeable ticket set in one receipt: ready label, blocking edges, dispatch records, each exclusion named.',
    options: [['--dry-run', 'name the reads without issuing them — no gh call']],
  },
  {
    name: 'pin',
    section: 'PROJECT',
    summary: 'move this project onto an ax release — edit, install, prove, doctor',
    options: [
      ['<version>', 'the release to pin, e.g. 0.6.6 or v0.6.6 — the git gesture stays yours'],
      ['--dry-run', 'say what would move without touching anything'],
    ],
  },
  {
    name: 'init',
    section: 'PROJECT',
    summary: 'write config, bootstrap, OMP package root and managed blocks',
    options: [
      ['--vendor <owner>/<repo>', 'upstream kit, when no remote names it'],
      ['--dry-run', 'report what would change, write nothing'],
    ],
  },
  { name: 'help', section: 'PROJECT', summary: 'this text', runnerless: true },
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
 * The verbs of one command that are PLUMBING: declared, dispatchable, and
 * deliberately absent from every surface an agent reads.
 *
 * `worker start` is the case this exists for (`docs/adr/0001`). It is not
 * retired and it is not gated — it runs, it is the write-ahead record and the
 * `--resume` replay `worker dispatch` issues, and removing it would take the
 * recovery path with it. What it must not do is offer a SECOND way to create a
 * child: an agent that reads two creation gestures out of one help picks one,
 * and the one that skips placement, setup and the role/model proof looks like
 * it worked.
 *
 * SO THE MARKER HIDES, IT NEVER UNDECLARES. `subcommandNames` above still
 * reports a plumbing verb, which keeps it inside the registry ↔ dispatch-table
 * equality contract every noun's test asserts — a plumbing verb that lost its
 * runner fails there instead of answering "unknown" to the one caller that
 * still needs it. Only the surfaces read the marker: the help skips the line,
 * and the noun's own verb list skips the name.
 *
 * Marker data, never machine state: like retirement, this is a naming fact the
 * registry decides, so a machine that resolves no Orca hides exactly what a
 * machine that resolves one hides.
 */
export const plumbingSubcommands = name => Object.keys(COMMANDS.find(command => command.name === name)?.plumbing ?? {});

/** Why one verb is plumbing, or null when it is not. */
export const plumbingSubcommand = (name, verb) => COMMANDS.find(command => command.name === name)?.plumbing?.[verb] ?? null;

/**
 * Where a retired verb WENT, and the command that replaces it.
 *
 * A renamed verb is not an unknown one. An operator re-running a line out of
 * their shell history, or an agent that learned the old name from a doc written
 * before the rename, is owed the replacement — the same debt `ax triage --job
 * refine` pays by name. The mapping lives beside the `subcommands` it was
 * renamed out of, so one noun's router and the help can never disagree
 * about which names exist, and `tests/commands.test.mjs` refuses a name that is
 * declared and retired at once.
 *
 * The repair is COMPOSED from the declared verb rather than retyped: a second
 * copy of `dispatch --issue <ref>` is a second thing to keep true.
 */
export function retiredSubcommand(name, verb) {
  const command = COMMANDS.find(entry => entry.name === name);
  const retirement = (command?.retired ?? {})[verb];
  if (retirement === undefined) return null;
  const declared = (command.subcommands ?? []).find(([usage]) => usage.split(' ')[0] === retirement.to);
  return { to: retirement.to, why: retirement.why, fix: `ax ${name} ${declared ? declared[0] : retirement.to}` };
}

/**
 * Where a retired NOUN went — the same debt one level up.
 *
 * `retiredSubcommand` covers a verb renamed inside its noun. A whole noun can
 * be renamed too, and then nothing in the registry answers at all: the name is
 * simply absent, so the router falls through to "unknown command" and every
 * line in every shell history, every doc written before the rename and every
 * agent that learned the old name gets a help page instead of the one word it
 * needed. `ready` served the on-ramp from 0.15 to 0.16 (`docs/adr/0001`: the
 * noun follows the activity, and its verbs serve only the on-ramp), so that is
 * exactly the population this table exists for.
 *
 * IT IS A TABLE, NOT A SECOND MECHANISM. The verbs survived the rename
 * one-for-one, so the repair is COMPOSED from the replacement's own declared
 * usage and reads back as the line the operator meant to type — a retyped copy
 * of `status [--issue N …]` would be a second thing to keep true. A verb the
 * replacement does not declare composes down to the bare noun, which names its
 * own verbs rather than inventing one.
 */
export const RETIRED_COMMANDS = {
  ready: {
    to: 'triage',
    why: 'the noun follows the activity — these verbs serve only the on-ramp, and the spec flow never calls them',
  },
};

export function retiredCommand(name, verb = '') {
  const retirement = RETIRED_COMMANDS[name];
  if (retirement === undefined) return null;
  const replacement = COMMANDS.find(entry => entry.name === retirement.to);
  const declared = (replacement?.subcommands ?? []).find(([usage]) => usage.split(' ')[0] === verb);
  return { to: retirement.to, why: retirement.why, fix: `ax ${retirement.to}${declared ? ` ${declared[0]}` : ''}` };
}

/**
 * The column budget every help line is held to, asserted by the test suite: a
 * split pane in an editor is narrower than a terminal, and a help that wraps
 * there is read as noise.
 */
export const WIDTH = 96;

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

  // The banner is a name, a version and the one sentence that says what ax is.
  // That sentence is the package description, so it grows when the product's
  // pitch does — and at 96 columns it wraps in a split pane, which is exactly
  // what the width budget below exists to prevent. So it moves to its own line
  // rather than being shortened to fit a line it does not have to share.
  const banner = `ax ${version} — ${description}`;
  const lines = [
    ...(banner.length <= WIDTH ? [`${bold('ax')} ${version} — ${description}`] : [`${bold('ax')} ${version}`, `  ${dim(description)}`]),
    '',
    bold('Usage'),
    '  ax <command> [options]',
  ];

  for (const section of SECTIONS) {
    const members = visible.filter(command => command.section === section);

    // A heading is printed because commands landed under it, never because it
    // was declared: the Orca gate empties most of ORCHESTRATION on a machine
    // that resolves no runtime, and a heading over blank space reads as a
    // domain that exists and answers nothing.
    if (members.length === 0) continue;
    lines.push('', bold(section));

    // The left column is measured inside the SECTION, for the same reason each
    // command's verbs align among themselves: `worktree` and `supabase` are the
    // two longest names in the registry, and one global column indented every
    // description under `pr`, `pin` and `doctor` to clear names printed in a
    // different section, which is width spent on nothing a reader is comparing.
    const width = Math.max(...members.map(command => command.name.length));

    for (const command of members) {
      lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);

      // Each command's verbs and flags align among THEMSELVES, not against
      // every other command's. One global column let the widest flag in the
      // registry (`--vendor <owner>/<repo>`) push unrelated descriptions past
      // 96 columns, where they wrap in a split pane — the exact laddering this
      // help was rewritten to avoid.
      //
      // A PLUMBING verb is skipped here and nowhere else
      // (`plumbingSubcommands`): it is still declared, still dispatched, and
      // still the only recovery there is — it just stops competing for a
      // gesture the help offers once.
      const hidden = plumbingSubcommands(command.name);
      const declared = (command.subcommands ?? []).filter(([usage]) => !hidden.includes(usage.split(' ')[0]));
      const inner = [...declared, ...(command.options ?? [])];
      const innerWidth = Math.max(...inner.map(([name]) => name.length), 0);

      for (const [name, description] of inner) {
        lines.push(`  ${' '.repeat(width)}  ${dim(`${name.padEnd(innerWidth)}  ${description}`)}`);
      }
    }
  }

  lines.push('', bold('Config'), `  ${dim('ax.config.json at the repository root — every key is documented in ax.schema.json')}`, '');
  return lines.join('\n');
}
