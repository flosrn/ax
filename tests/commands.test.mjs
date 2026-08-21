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

import { COMMANDS, agentLines, commandNames, renderUsage } from '../src/commands.mjs';
import { agentsBody } from '../src/init.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ax.mjs');
const run = args => {
  try {
    return { status: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

test('every command the AGENTS block advertises is a real command', () => {
  const advertised = [...agentsBody().matchAll(/pnpm ax ([a-z-]+)/g)].map(match => match[1]);
  assert.ok(advertised.length > 0, 'the block must advertise at least one command');
  for (const name of advertised) {
    assert.ok(commandNames.includes(name), `AGENTS block names "ax ${name}", which the CLI does not implement`);
  }
});

test('every advertised command answers for real', () => {
  for (const name of [...agentsBody().matchAll(/pnpm ax ([a-z-]+)/g)].map(match => match[1])) {
    const result = run([name, '--dry-run']);
    assert.notEqual(result.status, 2, `ax ${name} is advertised but reports an unknown command`);
    assert.doesNotMatch(result.out, /unknown command/);
  }
});

test('the help text lists exactly the registry', () => {
  const usage = renderUsage('0.0.0');
  for (const command of COMMANDS) assert.match(usage, new RegExp(`\\b${command.name}\\b`));
  assert.match(usage, /\bhelp\b/);
});

test('only commands meant for agents reach the AGENTS block', () => {
  // `init` is a human's setup step; advertising it invites an agent to rewrite
  // the project's managed files mid-task.
  assert.equal(agentLines().length, 1);
  assert.doesNotMatch(agentsBody(), /pnpm ax init/);
});

test('an unknown command exits 2 and prints the help', () => {
  const result = run(['worktree']);
  assert.equal(result.status, 2);
  assert.match(result.out, /unknown command "worktree"/);
  assert.match(result.out, /Usage: ax <command>/);
});

test('help and version answer without a repository', () => {
  assert.match(run(['--version']).out.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(run([]).out, /Usage: ax <command>/);
});
