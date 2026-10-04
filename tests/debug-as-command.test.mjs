// The shipped executable must answer debug-as, and own help only before the
// child delimiter. A schema alone is not an executable command surface.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { helpAsked, agentLines } from '../src/commands.mjs';
import { debugAs } from '../src/debug-as/index.mjs';

const bin = fileURLToPath(new URL('../bin/ax.mjs', import.meta.url));
test('debug-as launch and every agent verb answer real registry help', () => {
  for (const argv of [[], ['doctor'], ['status'], ['drive']]) {
    const result = spawnSync(process.execPath, [bin, 'debug-as', ...argv, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /debug-as/);
    assert.match(result.stdout, /WORKTREE/);
  }
});
test('debug-as help does not swallow agent-browser arguments', () => {
  assert.equal(helpAsked('debug-as', ['drive', '--', 'snapshot', '--help']), false);
  assert.equal(helpAsked('debug-as', ['drive', '--help', '--', 'snapshot']), true);
  assert.equal(helpAsked('debug-as', ['--as', '--help']), false);
});
test('debug instructions appear only with adopted contract', () => {
  assert.equal(agentLines().some(line => line.includes('debug-as')), false);
  assert.equal(agentLines({ debug: true }).some(line => line.includes('debug-as status')), true);
});

test('retired declaration refuses before debug adoption or browser work', async () => {
  const lines = [];
  const retired = { problem: 'dispatch.cap retired', fix: 'delete dispatch.cap from ax.config.json' };
  const code = await debugAs(['status'], {
    paths: () => ({ root: '/fixture', main: '/fixture' }),
    load: () => ({ config: null, errors: ['invalid'], retired }),
    output: { refuse: (problem, fix) => lines.push(`${problem}: ${fix}`) },
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /dispatch\.cap.*delete dispatch\.cap/);
});

// The gated verbs exist only where an Orca resolves (src/cli.mjs), so the test
// names one, as tests/commands.test.mjs does: on a CI runner with none,
// `worker` would be an unknown command and help would never be asked.
const HAS_ORCA = { ORCA_BIN: '/bin/sh', ORCA_CLI_COMMAND: '', ORCA_DEV_REPO_ROOT: '' };

test('AE14 help answers without reading any project configuration', () => {
  for (const argv of [['worker', 'dispatch'], ['triage', 'dispatch'], ['worker', 'hosts'], ['frontier'], ['pr', 'gate'], ['doctor']]) {
    const result = spawnSync(process.execPath, [bin, ...argv, '--help'], { cwd: '/tmp', encoding: 'utf8', env: { ...process.env, ...HAS_ORCA } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /dispatch\.cap retired|ax\.config\.json.*invalid/);
  }
});
