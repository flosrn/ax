// The contract of the ONE default exec adapter. Every assertion here is a knob
// some hand-rolled copy used to get wrong on its own: status-as-data, the
// maxBuffer kill, the trimmed-or-undefined capture.
import assert from 'node:assert/strict';
import test from 'node:test';

import { capture, run } from '../src/exec.mjs';

test('run answers status as data, never a throw', () => {
  const ok = run('node', ['-e', 'console.log("out"); console.error("err")']);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'out\n');
  assert.equal(ok.stderr, 'err\n');
  assert.equal(ok.error, undefined);

  const missing = run('ax-test-no-such-binary', []);
  assert.notEqual(missing.status, 0);
  assert.ok(missing.error, 'a missing binary is an error value, not a throw');
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, '');
});

test('a named timeout kills the child; no site inherits one it did not ask for', () => {
  // No default timeout, deliberately: `supabase start` runs minutes under
  // promote(), and a default deadline would be a contract change dressed as a
  // cleanup. A site that wants one names it — and gets a real kill.
  const killed = run('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 200 });
  assert.notEqual(killed.status, 0);
  assert.ok(killed.error, 'the kill is reported, not hidden');
});

test("an answer bigger than spawnSync's 1 MiB default is not killed mid-print", () => {
  // Measured 2026-08-22: the 1 MiB cap KILLS the child — status null, output
  // truncated — which turned a healthy runtime into "unreadable".
  const big = run('node', ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);
  assert.equal(big.status, 0);
  assert.equal(big.stdout.length, 2 * 1024 * 1024);
});

test('capture answers one trimmed value, or undefined for every kind of nothing', () => {
  assert.equal(capture('node', ['-e', 'console.log("  value  ")']), 'value');
  assert.equal(capture('node', ['-e', 'console.log("")']), undefined, 'an empty answer is an absence');
  assert.equal(capture('node', ['-e', 'console.log("x"); process.exit(3)']), undefined, 'a failure is an absence, whatever it printed');
  assert.equal(capture('ax-test-no-such-binary', []), undefined, 'a missing binary is an absence');
});
