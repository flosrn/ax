// The registry and the runner cannot drift because this compares them — the
// same contract worktree.test.mjs pins for the other noun. The FULL tables are
// compared (gating is applied downstream by visibleCommands), so this test
// proves something on a machine with or without Orca.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plumbingSubcommands, subcommandNames } from '../src/commands.mjs';
import { SUBCOMMANDS, worker } from '../src/worker/index.mjs';

/** What this noun printed, whichever stream it chose. */
function capture(argv) {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: worker(argv), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test('every declared worker verb has a runner, and every runner is declared', () => {
  assert.deepEqual(subcommandNames('worker').sort(), Object.keys(SUBCOMMANDS).sort());
  for (const [verb, run] of Object.entries(SUBCOMMANDS)) assert.equal(typeof run, 'function', `${verb} is not callable`);
});

test('an unknown or missing verb is a usage error, never a default action', () => {
  assert.equal(worker(['bogus']), 2);
  assert.equal(worker([]), 2);
});

// ── the verbs that are not offered ───────────────────────────────────────────
// `start` is PLUMBING (`docs/adr/0001`): `worker dispatch` issues it and replays
// it, and it is the only recovery there is, so it must keep dispatching. What it
// must stop doing is offering itself as a second way to create a child — and
// this noun's own verb list is as agent-facing as the help.
//
// `stall` joined it from the other direction: the detached watcher `worker
// start` spawns had no verb at all, so its own alert named a path to re-run it
// — unrunnable in a consumer, and silently inert through the pnpm symlink an
// operator reached for instead. Declaring it makes the re-arm a command; the
// marker keeps it out of every surface an agent reads, since arming a watcher
// is `worker start`'s job and never a gesture to pick from a list.
test('the plumbing verbs keep their runners and leave the verb list', () => {
  const plumbing = plumbingSubcommands('worker');
  assert.deepEqual(plumbing, ['start', 'stall']);

  for (const verb of plumbing) {
    // Declared, so the equality contract above still holds it to a runner.
    assert.ok(subcommandNames('worker').includes(verb), `${verb} is plumbing and no longer declared`);
    assert.equal(typeof SUBCOMMANDS[verb], 'function', `${verb} is plumbing and lost its runner`);
  }

  // The list an operator or agent is offered names the gesture to reach for.
  const unknown = capture(['bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /dispatch/, 'the creation verb is still offered');
  for (const verb of plumbing) {
    assert.doesNotMatch(unknown.out, new RegExp(`\\b${verb}\\b`), `the verb list still offers the plumbing ${verb}`);
  }
  assert.doesNotMatch(capture([]).out, /\bstart\b/, 'the bare noun still offers the plumbing verb');
});

// ── the verb that was renamed ────────────────────────────────────────────────
// `launch` was this pipeline's name until 0.16. An operator re-running a line out
// of their shell history, and an agent that learned the name from a doc written
// before the rename, both land here — and a bare list of verbs makes them
// guess which one took over a gesture they already know how to describe. The
// replacement is declared in the registry beside the verbs, so the help and this
// answer cannot disagree.
test('the retired launch verb is refused with the replacement named', () => {
  const { code, out } = capture(['launch', '--issue', '42']);

  assert.equal(code, 2, 'a retired verb runs nothing');
  assert.match(out, /ax worker launch is now ax worker dispatch/);
  assert.match(out, /ax worker dispatch --issue <ref>/, 'the repair is the command that replaced it');
  assert.doesNotMatch(out, /unknown verb/, 'a renamed verb is not an unknown one');
});
