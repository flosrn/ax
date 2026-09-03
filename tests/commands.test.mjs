// The AGENTS.md block ax writes into a project is operational instruction: an
// agent reads it and runs what it says. A line naming a command the CLI does
// not implement is a false instruction committed to someone's repo, which is
// how the first version of this package shipped `pnpm ax worktree setup` and
// `pnpm ax debug-as` before either existed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  COMMANDS,
  RETIRED_COMMANDS,
  SECTIONS,
  WIDTH,
  commandHelpBody,
  commandNames,
  helpAsked,
  plumbingSubcommand,
  plumbingSubcommands,
  renderUsage,
  retiredCommand,
  retiredSubcommand,
  subcommandNames,
  visibleCommands,
} from '../src/commands.mjs';
import { agentsBody } from '../src/init.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ax.mjs');
const run = (args, env = {}, cwd) => {
  try {
    return { status: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } }) };
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

/**
 * The two machine states the Orca gate answers, forced rather than inherited.
 *
 * `resolveOrca` reads `ORCA_BIN` first and checks it is executable, so an
 * absolute path that is not one resolves to null — a machine with no Orca. This
 * suite has to answer the same on a developer's laptop and on a CI runner, and
 * the assertion below was written the other way once: it inherited the ambient
 * state, passed locally, and failed on the runner where nothing resolves.
 */
const NO_ORCA = { ORCA_BIN: '/nonexistent/orca', ORCA_CLI_COMMAND: '', ORCA_DEV_REPO_ROOT: '' };
const HAS_ORCA = { ORCA_BIN: '/bin/sh', ORCA_CLI_COMMAND: '', ORCA_DEV_REPO_ROOT: '' };

/** Help rendered in-process may carry colour when the runner owns a TTY. */
const plain = text => text.replace(/\u001B\[[0-9;]*m/g, '');

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

// ── help sections ────────────────────────────────────────────────────────────
// ax stays flat at the CLI (`docs/adr/0001`): a future domain — automated
// checks, architecture rules, context rules — arrives as its own NOUN inside a
// section, never as a nesting prefix. That makes the section the thing a new
// command declares, so it is registry data and it is graded as registry data:
// the mapping is asserted on the FULL table, never on `visibleCommands`. A
// machine that resolves no Orca would otherwise pass this by having nothing
// left to check, which is exactly how the previous ticket's CI failed.

test('every command declares one of the declared sections, and no section is empty', () => {
  assert.deepEqual(SECTIONS, ['PROJECT', 'WORKTREE', 'ORCHESTRATION']);

  for (const command of COMMANDS) {
    assert.ok(SECTIONS.includes(command.section), `${command.name} declares no section, so the help has nowhere to print it`);
  }
  // A declared section nothing lands in is a promise of a domain that does not
  // exist yet — the help would print a heading over blank space.
  for (const section of SECTIONS) {
    assert.ok(COMMANDS.some(command => command.section === section), `the section ${section} is declared and empty`);
  }
});

/**
 * The rendered help as `{ SECTION: [command, …] }`, read off the output the way
 * an agent reads it: a heading is a bare capitalised line, a command is the
 * only thing indented by exactly two columns.
 *
 * A BLANK LINE ENDS A SECTION'S COMMAND LIST, because a per-command read may
 * carry a declared help body under the block (`helpBody`, ../src/commands.mjs)
 * and that body is PROSE — its own two-column-indented lines (`  --close  act;
 * …`) are indistinguishable from a command line by indentation alone. Reading
 * them as commands is how this helper first reported `ax worker release --help`
 * as answering for `implementation`, `--close` and `--all`.
 */
const sectionsOf = usage => {
  const rendered = {};
  let current = null;
  for (const line of plain(usage).split('\n')) {
    const heading = line.match(/^([A-Z][A-Z ]*)$/);
    if (heading !== null) {
      current = heading[1];
      rendered[current] = [];
      continue;
    }
    if (line.trim() === '') {
      current = null;
      continue;
    }
    const command = line.match(/^ {2}(\S+) {2,}\S/);
    if (command !== null && current !== null) rendered[current].push(command[1]);
  }
  return rendered;
};

test('ax --help groups every visible command under exactly one section, on ANY machine', () => {
  // Both machine states FORCED. The gate empties most of ORCHESTRATION where no
  // Orca resolves, and the section structure has to survive that: a heading is
  // printed because commands landed under it, never because it was declared.
  for (const [state, env, orca] of [
    ['with Orca', HAS_ORCA, true],
    ['without Orca', NO_ORCA, false],
  ]) {
    const usage = run(['--help'], env).out;
    const rendered = sectionsOf(usage);
    const expected = Object.fromEntries(
      SECTIONS.map(section => [section, visibleCommands({ orca }).filter(command => command.section === section).map(command => command.name)]),
    );

    assert.deepEqual(Object.keys(rendered), SECTIONS, `${state}: the help renders sections out of their declared order`);
    assert.deepEqual(rendered, expected, `${state}: a visible command is missing from its section, or printed under another one`);
    for (const section of SECTIONS) assert.ok(rendered[section].length > 0, `${state}: the section ${section} is printed with nothing under it`);

    const widest = Math.max(...plain(usage).split('\n').map(line => line.length));
    assert.ok(widest <= WIDTH, `${state}: the sectioned help wraps at ${WIDTH} columns: longest line is ${widest}`);
  }
});

test('only commands meant for agents reach the AGENTS block', () => {
  // An explicit allow-list, not a count: `init` is a human's setup step, and
  // advertising it invites an agent to rewrite the project's managed files
  // mid-task. Adding a command here is a decision, so it belongs in a diff.
  // `frontier` is that decision (U1): the orchestrator reads its receipt at
  // every wake, so the block is exactly where the verb must be learned from.
  assert.deepEqual(advertisedCommands().sort(), ['doctor', 'frontier', 'worktree ls', 'worktree setup']);
  assert.doesNotMatch(agentsBody(), /`ax init/);
});

// ── plumbing verbs ───────────────────────────────────────────────────────────
// `worker start` is declared, dispatchable and unadvertised (`docs/adr/0001`):
// the agent-facing surface offers exactly ONE way to create a child, because an
// agent that reads two creation gestures out of one help picks one — and the one
// that skips placement, setup and the role/model proof looks like it worked.
//
// The marker HIDES, it never undeclares. Absence from the help is the point;
// absence from `subcommandNames` would drop the verb out of the registry ↔
// dispatch-table equality contract, and the first thing to notice would be the
// recovery path answering "unknown verb".

test('a plumbing verb is declared and dispatchable, and never advertised', () => {
  const plumbing = COMMANDS.flatMap(command => plumbingSubcommands(command.name).map(verb => [command.name, verb]));
  assert.ok(plumbing.length > 0, 'the marker is read by the help and by the noun router; an empty table means it stopped being read');

  for (const [name, verb] of plumbing) {
    assert.ok(subcommandNames(name).includes(verb), `${name} ${verb} is marked plumbing but is not a declared verb — nothing holds its runner to the dispatch table`);
    // Plumbing and retirement are opposite claims about one name: one hides a
    // verb that still runs, the other explains a verb that no longer exists.
    assert.equal(retiredSubcommand(name, verb), null, `${name} ${verb} is plumbing AND retired — the noun would both dispatch it and call it gone`);
    assert.ok(plumbingSubcommand(name, verb).length > 0, `${name} ${verb} is plumbing without saying why`);
    assert.doesNotMatch(plain(renderUsage('0.0.0', { orca: true })), new RegExp(`^ +${verb}\\b`, 'm'), `the help still lists the plumbing ${verb}`);
  }

  assert.deepEqual(plumbingSubcommands('worker'), ['start']);
  assert.equal(plumbingSubcommand('worker', 'dispatch'), null, 'the one creation verb is not plumbing');
  assert.equal(plumbingSubcommand('worktree', 'setup'), null, 'the marker is per noun');
});

test('ax --help hides the plumbing verb on ANY machine', () => {
  // Both machine states FORCED, never inherited. The marker is registry data,
  // so a verb hidden where Orca resolves must stay hidden where it does not —
  // and the absence has to be the marker's rather than the gate's, which is why
  // the noun and a sibling verb are asserted PRESENT in the same output.
  const withOrca = run(['--help'], HAS_ORCA).out;
  assert.match(withOrca, /^ {2}worker\b/m, 'the noun is gated off this machine, so an absent verb proves nothing');
  assert.match(withOrca, /^ +dispatch --issue <ref>/m, 'the one creation verb is still advertised');
  assert.doesNotMatch(withOrca, /^ +start\b/m, 'ax --help still lists the plumbing verb');

  const without = run(['--help'], NO_ORCA).out;
  assert.doesNotMatch(without, /^ {2}worker\b/m, 'the whole noun is gated where no Orca resolves');
  assert.doesNotMatch(without, /^ +start\b/m);
});

test('the plumbing verb still answers, and says so as itself', () => {
  // Demotion is a visibility change and nothing else: the verb must still reach
  // its own runner. `ax worker start` with no arguments is its own caller-bug
  // refusal (exit 1, its usage line) — an unknown verb would exit 2.
  const result = run(['worker', 'start'], HAS_ORCA);
  assert.equal(result.status, 1, 'the plumbing verb no longer reaches its runner');
  assert.doesNotMatch(result.out, /unknown verb/);
  assert.match(result.out, /ax worker start --request <id> --run <run_id>/, 'the verb answers with its own usage');
});

test('no advertised command is a plumbing verb', () => {
  // The generated AGENTS.md block is operational instruction. A plumbing verb
  // reaching it would tell every consuming repo to type the gesture this
  // decision took out of the surface.
  for (const advertised of advertisedCommands()) {
    const [name, verb] = advertised.split(' ');
    if (verb === undefined) continue;
    assert.ok(!plumbingSubcommands(name).includes(verb), `AGENTS block advertises "ax ${name} ${verb}", which is declared plumbing`);
  }
});

// ── retired verbs ────────────────────────────────────────────────────────────
// A renamed verb is owed its replacement, and the help is owed silence about it.
// Both halves are one declaration, so neither can be added without the other.
test('a retired verb names a declared replacement, and is never itself declared', () => {
  const retirements = COMMANDS.flatMap(command => Object.keys(command.retired ?? {}).map(verb => [command.name, verb]));
  assert.ok(retirements.length > 0, 'the table is read by every noun router; an empty one means it stopped being read');

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

test('ax ready answers unknown, and the error names ax triage on ANY machine', () => {
  // Both states, because the retirement is registry data and not machine state:
  // a naming fact gated on a binary probe explains the same command differently
  // from one host to the next — and on the host where nothing resolves, which
  // is every CI runner, it would not explain it at all.
  for (const [label, env] of [['with Orca', HAS_ORCA], ['without Orca', NO_ORCA]]) {
    const result = run(['ready', 'status', '--issue', '7'], env);
    assert.equal(result.status, 2, `${label}: a retired noun runs nothing`);
    assert.match(result.out, /unknown command "ready"/, label);
    assert.match(result.out, /ax triage status/, `${label}: the repair is the command an operator can type`);

    const bare = run(['ready'], env);
    assert.equal(bare.status, 2, label);
    assert.match(bare.out, /ax triage/, label);
  }

  // The gate is still the help's, and it still answers: `triage` is listed only
  // where Orca resolves. Naming the replacement does not smuggle it back in.
  assert.match(run(['--help'], HAS_ORCA).out, /^ {2}triage\b/m);
  assert.doesNotMatch(run(['--help'], NO_ORCA).out, /^ {2}triage\b/m);
});

test('an unknown command exits 2 and prints the help', () => {
  const result = run(['deploy']);
  assert.equal(result.status, 2);
  assert.match(result.out, /unknown command "deploy"/);
  assert.match(result.out, /^Usage$/m);
});

test('help and version answer without a repository', () => {
  // The version line grew a second half — which copy answered — and the number
  // stays field one, because that is what a hook reads to verify a pin.
  const line = run(['--version']).out.trim();
  assert.match(line, /^\d+\.\d+\.\d+ /);
  assert.match(line, / — (checkout|project install|global install) /, 'the line must say where this copy came from');
  assert.match(run([]).out, /^Usage$/m);
});

// ── --help is a read anywhere in a command's own argv ────────────────────────
// `ax init --help` RAN init: it rewrote four tracked files of the repository it
// was asked from, on a machine whose operator was only asking what the verb
// does (#69). #71 answered the flag in ONE slot — the command's first — and
// that left the same defect alive one argument to the right: `ax init --vendor
// <x> --help` still ran init and wrote six paths, because `--vendor` takes a
// value and the flag was therefore in slot 2 (#89). One level down it was
// worse: `ax worktree clean --help` reclaimed, `ax worktree setup --help`
// provisioned, and `ax worker tail --help` diagnosed a pane named `--help`
// (#93).
//
// So ax claims the flag in the command's WHOLE argv, minus the value slots its
// own declarations name — arity is registry data, which is what keeps `ax
// board --comment --help` a comment whose text is `--help`. The guarantee is
// STRUCTURAL: `runCli` answers from the registry before any runner is reached,
// so a verb registered next month inherits it by being registered, and a
// command whose argv is a foreign CLI's in full says so with one marker.

/** A committed temp repository, so `git status --porcelain` starts empty. */
const cleanRepo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-verb-help-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'help-consumer' }, null, 2)}\n`);
  git('add', '-A');
  git('-c', 'user.email=ax@example.com', '-c', 'user.name=ax', 'commit', '-qm', 'baseline');
  return root;
};

/** Padding is the help's layout, not its text: the words are what is compared. */
const squeeze = line => plain(line).replace(/[ \t]+/g, ' ').trim();

test('every verb answers --help as a read: exit 0, nothing written, its own section', () => {
  const root = cleanRepo();
  const porcelain = () => execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  // The machine state is FORCED to the one where every registry entry is
  // visible: a gated noun absent from this machine would pass by not existing.
  const shown = new Set(plain(run(['help'], HAS_ORCA).out).split('\n').map(squeeze));

  try {
    for (const command of visibleCommands({ orca: true })) {
      for (const flag of ['--help', '-h']) {
        const asked = `ax ${command.name} ${flag}`;
        const result = run([command.name, flag], HAS_ORCA, root);

        assert.equal(result.status, 0, `${asked} exited ${result.status} instead of answering`);
        assert.equal(porcelain(), '', `${asked} wrote to the working tree — asking a verb what it does ran it`);

        // Every line is a line `ax help` already shows: the help is composed
        // once, from the registry, so the two can never drift apart.
        for (const line of plain(result.out).split('\n').filter(text => text.trim() !== '')) {
          assert.ok(shown.has(squeeze(line)), `${asked} prints "${squeeze(line)}", which ax help does not show`);
        }

        // ITS section, not the whole usage. `help` is the exception it declares
        // itself: its summary is "this text", so the whole text is its answer.
        if (command.runnerless) {
          assert.match(result.out, /^Usage$/m, `${asked} must still print the whole help`);
          continue;
        }
        assert.doesNotMatch(result.out, /^Usage$/m, `${asked} printed the whole usage instead of its own section`);
        assert.deepEqual(sectionsOf(result.out), { [command.section]: [command.name] }, `${asked} printed a command other than itself`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a verb’s help carries the verbs and flags it declares, and never its plumbing', () => {
  const help = plain(run(['worker', '--help'], HAS_ORCA).out);
  assert.match(help, /^ {2}worker {2}dispatch agents/m, 'the noun answers with its own summary line');
  assert.match(help, /^ +dispatch --issue <ref> +a ticket/m, 'a declared verb is missing from the noun’s own help');
  assert.doesNotMatch(help, /^ +start\b/m, 'the plumbing verb is advertised where the whole help hides it');

  const init = plain(run(['init', '--help']).out);
  assert.match(init, /^ +--vendor <owner>\/<repo> +upstream kit/m, 'a declared flag is missing from the command’s own help');
});

test('a value-taking flag no longer runs the verb: --help is a read past the first slot', () => {
  const root = cleanRepo();
  const porcelain = () => execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

  try {
    // The #89 reproduction verbatim, and its `-h` twin: measured on `main` at
    // `bb75a2a`, the first of these ran init and left six paths behind.
    for (const argv of [
      ['init', '--vendor', 'makerkit/next-supabase-saas-kit', '--help'],
      ['init', '--vendor', 'makerkit/next-supabase-saas-kit', '-h'],
      ['init', '--dry-run', '--help'],
    ]) {
      const asked = `ax ${argv.join(' ')}`;
      const result = run(argv, HAS_ORCA, root);

      assert.equal(result.status, 0, `${asked} exited ${result.status} instead of answering`);
      assert.equal(porcelain(), '', `${asked} wrote to the working tree — asking a verb what it does ran it`);
      assert.deepEqual(sectionsOf(result.out), { PROJECT: ['init'] }, `${asked} answered with something other than init's own section`);
      assert.match(plain(result.out), /^ +--vendor <owner>\/<repo> +upstream kit/m, `${asked} did not answer with init's declared flags`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every declared verb answers --help as a read, and none of them runs', () => {
  // The #93 table as a contract. Measured on `main` at `bb75a2a`, twenty
  // subverbs answered five different ways: three RAN (`worktree setup|ls|clean`,
  // and `clean` reclaimed processes and containers a `git status` cannot see),
  // two consumed the flag as their positional target (`worker tail|gate`, exit
  // 3 about a pane named `--help`), three refused it as an unknown argument,
  // and ten answered out of their own argv loop. One place decides now, so all
  // of them read the same — and a verb added later cannot answer a sixth way.
  const root = cleanRepo();
  const porcelain = () => execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const shown = new Set(plain(run(['help'], HAS_ORCA).out).split('\n').map(squeeze));

  try {
    for (const command of visibleCommands({ orca: true })) {
      for (const verb of subcommandNames(command.name)) {
        for (const flag of ['--help', '-h']) {
          const asked = `ax ${command.name} ${verb} ${flag}`;
          const result = run([command.name, verb, flag], HAS_ORCA, root);

          assert.equal(result.status, 0, `${asked} exited ${result.status} instead of answering`);
          assert.equal(porcelain(), '', `${asked} wrote to the working tree`);

          // Composed once, from the registry: every line is either a line `ax
          // help` already shows, or a line of the long body this verb DECLARES
          // — so a verb still cannot pin a second description of itself, and
          // the exception is registry data rather than a verb's own help path.
          const body = new Set((commandHelpBody(command.name, verb) ?? '').split('\n').map(squeeze));
          for (const line of plain(result.out).split('\n').filter(text => text.trim() !== '')) {
            assert.ok(
              shown.has(squeeze(line)) || body.has(squeeze(line)),
              `${asked} prints "${squeeze(line)}", which is neither in ax help nor in this verb's declared body`,
            );
          }
          assert.deepEqual(sectionsOf(result.out), { [command.section]: [command.name] }, `${asked} answered for a command other than ${command.name}`);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a verb whose contract is a judgement prints it, and only from the registry', () => {
  // The refused surface loss (#89). `ax worker release --help` is how an
  // operator learns that without `--close` nothing mutates and what counts as
  // landing — read from the terminal, not from the module header, because a
  // header is for whoever patches the verb. `ax triage ask --help` is the same
  // for a blocked child, which routes on the exit codes alone.
  const release = plain(run(['worker', 'release', '--help'], HAS_ORCA).out);
  assert.match(release, /A pane closes because the WORK LANDED/, 'the proof rule is gone from the surface an operator reads');
  assert.match(release, /implementation {4}a MERGED pull request for that branch/);
  assert.match(release, /Never proof: an OPEN PR/);
  assert.match(release, /--close {12}act; without it this is a report and nothing mutates/);
  assert.match(release, /^Exit: 0 report or every release settled/m, 'the exit-code contract is stated where it is typed (ADR 0003)');

  const ask = plain(run(['triage', 'ask', '--help'], HAS_ORCA).out);
  for (const line of [/0 {2}answered/, /1 {2}refused/, /3 {2}cannot establish/, /4 {2}PENDING/]) {
    assert.match(ask, line, 'a blocked child routes on these alone');
  }

  // A verb that declares no body gets the block and nothing else: the field is
  // for a contract that needs more than a summary, not a place to grow prose.
  const tail = plain(run(['worker', 'tail', '--help'], HAS_ORCA).out);
  assert.doesNotMatch(tail, /MERGED pull request/, 'one verb’s body leaked into another’s read');

  // Both are answered by the ONE read, so neither verb may carry a help path of
  // its own: reached directly, they refuse the flag as the unknown argument it
  // is there (../src/worker/release.mjs, ../src/triage/ask.mjs).
  assert.equal(commandHelpBody('worker', 'release').length > 0, true);
  assert.equal(commandHelpBody('worker', 'tail'), null);
  assert.equal(commandHelpBody('init', '--vendor'), null, 'a token that is not a declared verb must carry no body');
});

test('every declared help body fits the column budget it is printed in', () => {
  // Same reason the rest of the help is held to 96: a split pane in an editor
  // is narrower than a terminal, and a page that wraps there reads as noise.
  for (const command of COMMANDS) {
    for (const verb of Object.keys(command.helpBody ?? {})) {
      assert.ok(subcommandNames(command.name).includes(verb), `${command.name} declares a help body for "${verb}", which is not a declared verb`);
      for (const line of commandHelpBody(command.name, verb).split('\n')) {
        assert.ok(line.length <= WIDTH, `${command.name} ${verb}: a body line is ${line.length} columns, past the ${WIDTH} budget: ${line}`);
      }
    }
  }
});

test('a declared value slot is that flag’s value, never a help read', () => {
  // `ax board --comment --help` is a comment whose text is `--help`, and arity
  // is the only thing that tells it from a read: `--comment <text>` is declared
  // with a placeholder and `--verbose` is not (../src/commands.mjs). Observed
  // past the argv loop — board reaches its runtime probe, which is downstream
  // of the parse it would have refused.
  const result = run(['board', '--verbose', '--comment', '--help'], HAS_ORCA);

  assert.equal(result.status, 0);
  assert.match(plain(result.out), /orca runtime not reachable/, 'the value slot was claimed as a help flag: board never reached its runner');
  assert.doesNotMatch(plain(result.out), /nothing to do/, 'the comment arrived empty, so the value slot was consumed by someone else');
  assert.deepEqual(sectionsOf(result.out), {}, 'board answered its own help instead of taking the comment');
});

test('the registry decides who asked for help, by arity and by ownership', () => {
  // The predicate, directly: the CLI-level tests above prove the answer, this
  // one pins the three rules that produce it.
  assert.equal(helpAsked('init', ['--vendor', 'makerkit/next', '--help']), true, 'a free slot past a value is still ax’s to answer');
  assert.equal(helpAsked('init', ['--dry-run', '-h']), true);
  assert.equal(helpAsked('worktree', ['setup', '--help']), true, 'a verb is a positional, not a value slot');
  assert.equal(helpAsked('board', ['--comment', '--help']), false, 'a declared value slot is the flag’s value');
  assert.equal(helpAsked('board', ['--comment', 'done', '--help']), true);
  assert.equal(helpAsked('init', []), false);
  assert.equal(helpAsked('deploy', ['--help']), false, 'an unknown command has no registry entry to answer from');

  // `supabase` owns its whole argv: every argument after the noun belongs to
  // the Supabase CLI, whose own `--help` must reach it (../src/supabase-guard.mjs).
  assert.equal(helpAsked('supabase', ['--help']), true, 'the first slot is the one gesture ax claims there');
  assert.equal(helpAsked('supabase', ['-h']), true);
  assert.equal(helpAsked('supabase', ['db', 'push', '--help']), false, 'ax swallowed a flag that was the Supabase CLI’s');
  assert.equal(helpAsked('supabase', ['help']), false);
});

test('every declared option states its arity in one convention', () => {
  // Arity is derived from the declaration, so the declaration is what has to be
  // uniform: a bare `--flag` takes nothing, `--flag <value>` takes one slot.
  // A future `--flag value` declared without the placeholder would read as
  // boolean and turn its value into a help page, silently — this is the check
  // that makes it a test failure instead.
  for (const command of COMMANDS) {
    for (const [declaration] of command.options ?? []) {
      assert.match(
        declaration,
        /^(--[a-z-]+( <\S+>)?|<\S+>|[A-Z_]+=\S+)$/,
        `${command.name} declares "${declaration}", whose arity cannot be read: use --flag, --flag <value>, <positional> or ENV=<value>`,
      );
    }
  }
});

test('an unknown verb with --help is still the usage-error path', () => {
  for (const flag of ['--help', '-h']) {
    const result = run(['deploy', flag]);
    assert.equal(result.status, 2, `ax deploy ${flag} answered instead of refusing`);
    assert.match(result.out, /unknown command "deploy"/);
    assert.match(result.out, /^Usage$/m);
  }

  // A gated noun on a machine that resolves no Orca does not exist there, and
  // the help read cannot be the one thing that makes it exist.
  const gated = run(['worker', '--help'], NO_ORCA);
  assert.equal(gated.status, 2);
  assert.match(gated.out, /unknown command "worker"/);
});
