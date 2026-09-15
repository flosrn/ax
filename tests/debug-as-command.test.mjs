// The shipped executable must answer debug-as, and own help only before the
// child delimiter. A schema alone is not an executable command surface.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { helpAsked, agentLines } from '../src/commands.mjs';

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
