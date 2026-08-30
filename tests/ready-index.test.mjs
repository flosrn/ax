// The triage verb table, held equal to the registry — the same parity `worker`,
// `pr` and `worktree` already pin. Without it, `ask` and `answer` could exist
// in one table and not the other, and the help would advertise a verb that
// answers "unknown verb" (or hide one that works).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { subcommandNames } from '../src/commands.mjs';
import { SUBCOMMANDS, ready } from '../src/ready/index.mjs';

test('every declared triage verb has a runner, and every runner is declared', () => {
  assert.deepEqual(subcommandNames('ready').sort(), Object.keys(SUBCOMMANDS).sort());
  for (const [verb, run] of Object.entries(SUBCOMMANDS)) assert.equal(typeof run, 'function', `${verb} is not callable`);
});

test('an unknown or missing verb is a usage error, never a default action', () => {
  const written = [];
  const stderr = process.stderr.write;
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    assert.equal(ready(['deploy']), 2);
    assert.equal(ready([]), 2);
  } finally {
    process.stderr.write = stderr;
  }
  assert.match(written.join(''), /unknown verb "deploy"/);
  assert.match(written.join(''), /which one\?/);
});

test('every ready surface that carries --job advertises the three passes, and none advertises a fourth', () => {
  const written = [];
  const stdout = process.stdout.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  try {
    for (const verb of ['dispatch', 'ask', 'status', 'answer', 'release']) {
      written.length = 0;
      assert.equal(SUBCOMMANDS[verb](['--help']), 0, verb);
      assert.match(written.join(''), /triage\|brief\|custom/, verb);
      assert.doesNotMatch(written.join(''), /refine/, `${verb} still advertises the retired lane`);
    }
    written.length = 0;
    assert.equal(SUBCOMMANDS.publish(['--help']), 0);
    assert.match(written.join(''), /triage\|brief/, 'custom is deliberately not publishable');
    assert.doesNotMatch(written.join(''), /refine/);
  } finally {
    process.stdout.write = stdout;
  }
});

// ── the retired lane, refused by name ────────────────────────────────────────
// `--job refine` is not an unknown job. Six verbs read `--job`, and an operator
// re-running a command out of their shell history is owed the reason the lane
// went and what to do instead — a bare "expects triage|brief|custom" tells them
// only that their word is gone. The sentence is ONE exported constant, so what
// is pinned here is that every verb reaches it.

test('--job refine is refused BY NAME on every verb that reads --job, never as an unknown job', () => {
  const written = [];
  const stderr = process.stderr.write;
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  const argv = {
    dispatch: ['--issue', '7', '--job', 'refine'],
    ask: ['--issue', '7', '--job', 'refine'],
    status: ['--issue', '7', '--job', 'refine'],
    answer: ['--issue', '7', '--id', 'msg_1', '--file', '/tmp/r.md', '--job', 'refine'],
    release: ['--issue', '7', '--job', 'refine'],
    publish: ['--issue', '7', '--job', 'refine'],
  };
  try {
    for (const [verb, args] of Object.entries(argv)) {
      written.length = 0;
      assert.equal(SUBCOMMANDS[verb](args), 2, `${verb} exits 2`);
      const out = written.join('');
      assert.match(out, /--job refine no longer exists/, `${verb} names the removal`);
      assert.match(out, /to-tickets` publishes ready-for-agent itself/, `${verb} gives the reason`);
      assert.match(out, /fix it on the ticket/, `${verb} gives the repair`);
      assert.doesNotMatch(out, /--job expects/, `${verb} fell through to the generic usage error`);
    }
  } finally {
    process.stderr.write = stderr;
  }
});
