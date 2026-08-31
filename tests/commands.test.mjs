// The AGENTS.md block ax writes into a project is operational instruction: an
// agent reads it and runs what it says. A line naming a command the CLI does
// not implement is a false instruction committed to someone's repo, which is
// how the first version of this package shipped `pnpm ax worktree setup` and
// `pnpm ax debug-as` before either existed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { COMMANDS, RETIRED_COMMANDS, commandNames, renderUsage, retiredCommand, retiredSubcommand, subcommandNames } from '../src/commands.mjs';
import { agentsBody } from '../src/init.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ax.mjs');
const run = args => {
  try {
    return { status: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

/**
 * The commands the AGENTS.md block tells an agent to type, verb and all.
 *
 * One extraction, used by every assertion below, because the block is the
 * contract: what it names must exist, must run, and must be a command we chose
 * to expose.
 */
const advertisedCommands = () => [...agentsBody().matchAll(/`ax ([a-z-]+(?: [a-z-]+)?)/g)].map(match => match[1]);

test('every command the AGENTS block advertises is a real command', () => {
  const advertised = advertisedCommands();
  assert.ok(advertised.length > 0, 'the block must advertise at least one command');

  for (const entry of advertised) {
    const [name, verb] = entry.split(' ');
    assert.ok(commandNames.includes(name), `AGENTS block names "ax ${name}", which the CLI does not implement`);
    if (verb) {
      assert.ok(subcommandNames(name).includes(verb), `AGENTS block names "ax ${name} ${verb}", which is not a declared verb`);
    }
  }
});

test('every advertised command answers for real, verb included', () => {
  // The whole command as written in the block, not just its first word: a
  // registry entry can be a noun (`worktree`) whose verbs are what the block
  // actually tells an agent to type. Checking the first word only would have
  // passed while `ax worktree setup` did not exist.
  for (const advertised of advertisedCommands()) {
    const result = run([...advertised.split(' '), '--dry-run']);
    assert.notEqual(result.status, 2, `${advertised} is advertised but reports an unknown command or verb`);
    assert.doesNotMatch(result.out, /unknown (command|verb)/);
  }
});

test('the help text lists exactly the registry, and no line wraps a narrow terminal', () => {
  // Availability injected: this suite must answer the same on a machine with
  // Orca and on one without, and both states are asserted — the gated entry
  // exists with it, vanishes without it.
  const usage = renderUsage('0.0.0', { orca: true });
  for (const command of COMMANDS) assert.match(usage, new RegExp(`^  ${command.name}\\b`, 'm'));
  assert.doesNotMatch(renderUsage('0.0.0', { orca: false }), /^  board\b/m);
  // Flags hang under their own command, never in the left column.
  for (const [flag] of COMMANDS.flatMap(command => command.options ?? [])) {
    assert.match(usage, new RegExp(`^ {4,}${flag.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'm'));
  }
  const widest = Math.max(...usage.split('\n').map(line => line.length));
  assert.ok(widest <= 96, `help wraps at 96 columns: longest line is ${widest}`);
});

test('only commands meant for agents reach the AGENTS block', () => {
  // An explicit allow-list, not a count: `init` is a human's setup step, and
  // advertising it invites an agent to rewrite the project's managed files
  // mid-task. Adding a command here is a decision, so it belongs in a diff.
  assert.deepEqual(advertisedCommands().sort(), ['doctor', 'worktree ls', 'worktree setup']);
  assert.doesNotMatch(agentsBody(), /`ax init/);
});

// ── retired verbs ────────────────────────────────────────────────────────────
// A renamed verb is owed its replacement, and the help is owed silence about it.
// Both halves are one declaration, so neither can be added without the other.
test('a retired verb names a declared replacement, and is never itself declared', () => {
  const retirements = COMMANDS.flatMap(command => Object.keys(command.retired ?? {}).map(verb => [command.name, verb]));
  assert.ok(retirements.length > 0, 'the table is read by every noun dispatcher; an empty one means it stopped being read');

  for (const [name, verb] of retirements) {
    const retired = retiredSubcommand(name, verb);
    assert.ok(retired, `${name} ${verb} is declared retired and reads back as nothing`);
    assert.ok(subcommandNames(name).includes(retired.to), `${name} ${verb} points at "${retired.to}", which is not a declared verb`);
    assert.ok(!subcommandNames(name).includes(verb), `${name} ${verb} is retired AND declared — the help would advertise both names`);
    assert.doesNotMatch(renderUsage('0.0.0', { orca: true }), new RegExp(`^ +${verb}\\b`, 'm'), `the help still lists the retired ${verb}`);
    assert.match(retired.fix, new RegExp(`^ax ${name} ${retired.to}\\b`), 'the repair is a command an operator can type');
    assert.ok(retired.why.length > 0, `${name} ${verb} retires without saying why`);
  }

  assert.equal(retiredSubcommand('worker', 'dispatch'), null, 'a live verb is not retired');
  assert.equal(retiredSubcommand('worktree', 'launch'), null, 'retirements are per noun');
});

// ── retired nouns ────────────────────────────────────────────────────────────
// A whole noun can be renamed too, and then every line in every shell history
// names a command that no longer exists. `ax triage` served the on-ramp until
// 0.16 (`docs/adr/0001`), so the debt is the same one a retired VERB pays: the
// replacement, by name, composed from the registry rather than retyped.
test('a retired noun names a declared replacement, and is never itself declared', () => {
  const retirements = Object.keys(RETIRED_COMMANDS);
  assert.ok(retirements.length > 0, 'the table is read at the dispatch; an empty one means it stopped being read');

  for (const name of retirements) {
    const retired = retiredCommand(name);
    assert.ok(retired, `${name} is declared retired and reads back as nothing`);
    assert.ok(commandNames.includes(retired.to), `${name} points at "${retired.to}", which is not a declared command`);
    assert.ok(!commandNames.includes(name), `${name} is retired AND declared — the help would advertise both names`);
    assert.doesNotMatch(renderUsage('0.0.0', { orca: true }), new RegExp(`^  ${name}\\b`, 'm'), `the help still lists the retired ${name}`);
    assert.ok(retired.why.length > 0, `${name} retires without saying why`);
  }

  assert.equal(retiredCommand('worker'), null, 'a live noun is not retired');
});

test('the retired noun composes its repair from the verb the operator typed', () => {
  // The verb survived the rename one-for-one, so the repair is the line they
  // meant to type — not a pointer at a help page they then have to read.
  assert.equal(retiredCommand('ready', 'status').fix, 'ax triage status [--issue N …]');
  assert.equal(retiredCommand('ready', 'publish').fix, 'ax triage publish --issue N …');
  // An unknown verb still gets the noun: `ax triage` names its own verbs.
  assert.equal(retiredCommand('ready', 'refine').fix, 'ax triage');
  assert.equal(retiredCommand('ready').fix, 'ax triage');
});

test('ax ready answers unknown, and the error names ax triage', () => {
  const result = run(['ready', 'status', '--issue', '7']);
  assert.equal(result.status, 2, 'a retired noun runs nothing');
  assert.match(result.out, /unknown command "ready"/);
  assert.match(result.out, /ax triage status/, 'the repair is the command an operator can type');

  const bare = run(['ready']);
  assert.equal(bare.status, 2);
  assert.match(bare.out, /ax triage/);
});

test('an unknown command exits 2 and prints the help', () => {
  const result = run(['deploy']);
  assert.equal(result.status, 2);
  assert.match(result.out, /unknown command "deploy"/);
  assert.match(result.out, /^Usage$/m);
});

test('help and version answer without a repository', () => {
  assert.match(run(['--version']).out.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(run([]).out, /^Usage$/m);
});
