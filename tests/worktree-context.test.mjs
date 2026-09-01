// The context file is the one an agent reads before touching anything in a
// worktree (`src/worktree/context.mjs`). This suite holds its load-bearing
// prose: the escape hatches that exist precisely because a cold child cannot
// discover them — each one was a round-trip to the orchestrator before it was
// written here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderContext } from '../src/worktree/context.mjs';

const plan = {
  identity: { name: '41-prefactor-dispatch', branch: 'feat/41-prefactor-dispatch', issue: '41', issueSource: 'github' },
  port: { port: 3141 },
  urls: { publishedUrl: 'http://41.ax.localhost:1355', directUrl: 'http://localhost:3141', tailnetUrl: null },
  supabase: { mode: 'shared' },
  worktreePath: '/tmp/worktrees/41',
};

const render = () => renderContext({ plan, config: { apps: { web: '.' } }, main: '/tmp/main' });

// FRICTIONS.md 2026-08-31: a worker whose slice touched
// `.github/workflows/publish.yml` had its push rejected — the provisioned
// worktree inherits the HTTPS remote riding the gh OAuth token, which carries
// no `workflow` scope — and the repair cost a dropped change plus an
// orchestrator↔child round-trip. The escape must be findable where the child
// already reads, as a copyable command that mutates no config and is inert on
// a remote that is already SSH.
test('the context file teaches the workflow-scope push escape', () => {
  const text = render();

  assert.match(text, /\.github\/workflows/, 'name the wall: workflow files are what the OAuth push refuses');
  assert.match(text, /`workflow` scope/, "name the cause: the token's missing scope, so the child recognizes the rejection text");
  assert.ok(
    text.includes("git -c 'url.git@github.com:.insteadOf=https://github.com/' push origin HEAD"),
    'one copyable command: ephemeral URL rewrite, no config mutation, no-op on an SSH remote',
  );
});
