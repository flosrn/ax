// The context file is the one an agent reads before touching anything in a
// worktree (`src/worktree/context.mjs`). This suite holds its load-bearing
// prose: the escape hatches that exist precisely because a cold child cannot
// discover them — each one was a round-trip to the orchestrator before it was
// written here.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Measured 2026-08-31 (spec #39's wave, PR #61): a worker whose slice touched
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

// The prose above PROMISES a behavior matrix: rewrite on an HTTPS GitHub
// origin, "harmless when origin is already SSH", and by the same no-match
// rule, untouched on a non-GitHub host. A grep proves the string is present,
// not that it works — so this test extracts the exact command the child will
// copy and executes its `-c` argument against real repos, offline
// (`ls-remote --get-url` expands `url.<base>.insteadOf` without contacting
// the remote). Rewriting the prose line re-proves the matrix or fails here.
test('the escape command the prose hands out rewrites exactly the HTTPS GitHub origin', () => {
  const line = render().match(/^git -c '([^']+)' push origin HEAD$/m);
  assert.ok(line, 'the Pushing section carries the command in its copyable form');

  const dir = mkdtempSync(join(tmpdir(), 'ax-context-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const expanded = origin => {
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
      const out = execFileSync('git', ['-C', dir, '-c', line[1], 'ls-remote', '--get-url', 'origin']);
      execFileSync('git', ['-C', dir, 'remote', 'remove', 'origin']);
      return String(out).trim();
    };

    assert.equal(expanded('https://github.com/o/r.git'), 'git@github.com:o/r.git', 'the wall case is rewritten to SSH');
    assert.equal(expanded('git@github.com:o/r.git'), 'git@github.com:o/r.git', 'an SSH origin is untouched — the promise "harmless when origin is already SSH"');
    assert.equal(expanded('https://gitlab.com/o/r.git'), 'https://gitlab.com/o/r.git', 'a non-GitHub origin is untouched — no rewrite to a host that never refused the push');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
