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

test('every triage surface that carries --job names refine in its help', () => {
  const written = [];
  const stdout = process.stdout.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  try {
    for (const verb of ['dispatch', 'ask', 'status', 'answer', 'release']) {
      written.length = 0;
      assert.equal(SUBCOMMANDS[verb](['--help']), 0, verb);
      assert.match(written.join(''), /triage\|brief\|custom\|refine/, verb);
    }
    written.length = 0;
    assert.equal(SUBCOMMANDS.publish(['--help']), 0);
    assert.match(written.join(''), /triage\|brief\|refine/, 'custom is deliberately not publishable');
  } finally {
    process.stdout.write = stdout;
  }
});
