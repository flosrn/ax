// The registry and the runner cannot drift because this compares them — the
// same contract worktree.test.mjs pins for the other noun. The FULL tables are
// compared (gating is applied downstream by visibleCommands), so this test
// proves something on a machine with or without Orca.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { subcommandNames } from '../src/commands.mjs';
import { SUBCOMMANDS, worker } from '../src/worker/index.mjs';

test('every declared worker verb has a runner, and every runner is declared', () => {
  assert.deepEqual(subcommandNames('worker').sort(), Object.keys(SUBCOMMANDS).sort());
  for (const [verb, run] of Object.entries(SUBCOMMANDS)) assert.equal(typeof run, 'function', `${verb} is not callable`);
});

test('an unknown or missing verb is a usage error, never a default action', () => {
  assert.equal(worker(['bogus']), 2);
  assert.equal(worker([]), 2);
});
