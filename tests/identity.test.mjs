import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { identify } from '../src/worktree/identity.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-identity-'));

test('the name is the worktree directory, whatever the branch is called', () => {
  const identity = identify({ worktreePath: '/repo/.worktrees/fix-chat-threads', branch: 'feat/threads' });
  assert.equal(identity.name, 'fix-chat-threads');
  assert.equal(identity.branch, 'feat/threads');
});

test('an issue number is read from the segment that carries it', () => {
  // The number sits at the end of a slug whose first segment also has digits.
  assert.equal(identify({ branch: 'feat/v2-migration-412' }).issue, 412);
  assert.equal(identify({ branch: 'feat/412-chat-threads' }).issue, 412);
  assert.equal(identify({ branch: 'fix-613-context' }).issue, 613);
  assert.equal(identify({ branch: 'feat/issue-412-chat' }).issue, 412);
  assert.equal(identify({ worktreePath: '/w/publish-legal-modal-472' }).issue, 472);
});

test('digits buried inside a word are not an issue number', () => {
  // The failure this rule prevents: a slug like this one taking a port derived
  // from a number nobody wrote, colliding with the worktree that owns it.
  assert.equal(identify({ branch: 'feat/agency-roles-and-near-flat-permissions' }).issue, undefined);
  assert.equal(identify({ branch: 'feat/v2-migration' }).issue, undefined);
  assert.equal(identify({ worktreePath: '/w/oauth2-callback' }).issue, undefined);
});

test('issueSource names the input, so a caller can explain the port it chose', () => {
  assert.equal(identify({ branch: 'feat/412-chat' }).issueSource, 'branch');
  assert.equal(identify({ worktreePath: '/w/modal-472', branch: 'feat/no-number' }).issueSource, 'name');
  assert.equal(identify({ branch: 'feat/no-number' }).issueSource, undefined);
});

test('a recorded marker beats any parsing', () => {
  const dir = scratch();
  const marker = join(dir, 'worktree.json');
  // The branch says 412; the tooling that created the worktree knows it is 613.
  writeFileSync(marker, JSON.stringify({ issue: 613, branch: 'feat/412-chat' }));
  const identity = identify({ worktreePath: dir, branch: 'feat/412-chat', marker });
  assert.equal(identity.issue, 613);
  assert.equal(identity.issueSource, 'marker');

  // A quoted number is the same fact.
  writeFileSync(marker, '{ "issue": "613" }');
  assert.equal(identify({ marker, branch: 'feat/412-chat' }).issue, 613);
});

test('an absent, unparseable or empty marker falls through instead of failing', () => {
  const dir = scratch();
  const missing = join(dir, 'nope.json');
  assert.equal(identify({ branch: 'feat/412-chat', marker: missing }).issueSource, 'branch');

  const halfWritten = join(dir, 'half.json');
  writeFileSync(halfWritten, '{ "issue": 61');
  assert.equal(identify({ branch: 'feat/412-chat', marker: halfWritten }).issue, 412);

  const noIssue = join(dir, 'empty.json');
  writeFileSync(noIssue, '{ "branch": "feat/no-number" }');
  assert.equal(identify({ branch: 'feat/no-number', marker: noIssue }).issue, undefined);
});

test('the seed is a stable fallback derived from the branch, then the path', () => {
  const first = identify({ worktreePath: '/w/a', branch: 'feat/no-number' });
  const again = identify({ worktreePath: '/w/b', branch: 'feat/no-number' });
  // Same branch, same seed: re-running setup keeps the URL already published.
  assert.equal(first.seed, again.seed);
  assert.ok(Number.isInteger(first.seed));

  const other = identify({ worktreePath: '/w/a', branch: 'feat/other' });
  assert.notEqual(first.seed, other.seed);

  // No branch at all: the path carries the identity.
  const pathOnly = identify({ worktreePath: '/w/a' });
  assert.ok(Number.isInteger(pathOnly.seed));
  assert.notEqual(pathOnly.seed, identify({ worktreePath: '/w/c' }).seed);
});
