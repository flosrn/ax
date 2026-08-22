// Binary resolution, the two-level gate and the runner. Everything injected —
// no PATH, no Orca — except the last test, which MUST spawn a real process:
// the defect it pins lives in the real spawnSync path and no injected exec can
// reach it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunner, orcaAvailable, parseReceipt, resolveOrca, runtimeReady } from '../src/orca-bin.mjs';

const runs = names => (cmd, env) => names.includes(cmd);

test('ORCA_CLI_COMMAND wins over everything, and a broken one resolves to nothing', () => {
  const env = { ORCA_CLI_COMMAND: '/managed/orca', ORCA_BIN: '/override/orca', ORCA_DEV_REPO_ROOT: '/dev' };
  assert.equal(resolveOrca({ env, platform: 'darwin', canRun: runs(['/managed/orca']) }), '/managed/orca');
  // An explicit setting that cannot run is a refusal, never a silent fallback
  // to a different binary than the one the environment named.
  assert.equal(resolveOrca({ env, platform: 'darwin', canRun: runs(['/override/orca', 'orca']) }), null);
});

test('ORCA_BIN is the operator override when Orca exported nothing', () => {
  const env = { ORCA_BIN: '/opt/orca-ide' };
  assert.equal(resolveOrca({ env, platform: 'linux', canRun: runs(['/opt/orca-ide']) }), '/opt/orca-ide');
});

test('a dev-checkout session resolves orca-dev, never a production binary', () => {
  const env = { ORCA_DEV_REPO_ROOT: '/Users/x/orca' };
  assert.equal(resolveOrca({ env, platform: 'darwin', canRun: runs(['orca-dev', 'orca']) }), 'orca-dev');
});

test('linux prefers orca-ide — bare orca is the GNOME screen reader there', () => {
  assert.equal(resolveOrca({ env: {}, platform: 'linux', canRun: runs(['orca-ide', 'orca']) }), 'orca-ide');
  assert.equal(resolveOrca({ env: {}, platform: 'darwin', canRun: runs(['orca-ide', 'orca']) }), 'orca');
});

test('a machine with no Orca answers null, and the visibility gate reads it as absent', () => {
  assert.equal(resolveOrca({ env: {}, platform: 'darwin', canRun: () => false }), null);
  assert.equal(orcaAvailable({ env: {}, platform: 'darwin', canRun: () => false }), false);
  assert.equal(orcaAvailable({ env: {}, platform: 'darwin', canRun: runs(['orca']) }), true);
});

test('the runner returns exit codes as data and never loses stderr (F-004)', () => {
  const run = createRunner({
    bin: 'orca',
    exec: () => ({ status: 3, stdout: '{"ok":false,"error":{"code":"x"}}', stderr: 'a diagnostic' }),
  });
  const out = run(['status', '--json']);
  assert.equal(out.status, 3);
  assert.equal(out.stderr, 'a diagnostic');
  assert.deepEqual(out.receipt, { ok: false, error: { code: 'x' } });
});

test('an unparseable receipt keeps the raw text and the parse error, never thrown away', () => {
  const receipt = parseReceipt('runtime_unavailable while mutating');
  assert.match(receipt.unparseable, /runtime_unavailable/);
  assert.ok(receipt.error.length > 0);
});

test('runtimeReady demands reachable:true — an executable shim with no runtime refuses', () => {
  const answering = createRunner({
    bin: 'orca',
    exec: () => ({ status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }), stderr: '' }),
  });
  assert.deepEqual(runtimeReady(answering), { ready: true });

  const dead = createRunner({ bin: 'orca', exec: () => ({ status: 1, stdout: '', stderr: 'no runtime' }) });
  const verdict = runtimeReady(dead);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /exit 1/);

  // ok:true but runtime.reachable:false — the app is up, the runtime is not.
  const half = createRunner({
    bin: 'orca',
    exec: () => ({ status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: false } } }), stderr: '' }),
  });
  assert.equal(runtimeReady(half).ready, false, 'a half-up Orca must not pass the execution gate');
});

test('a receipt past 1 MiB survives the real spawn path', () => {
  // Measured 2026-08-22: a real `orchestration inbox --limit 500 --json`
  // overflows Node's default maxBuffer, which KILLS the child mid-print —
  // status null, receipt truncated — and made `status` report a healthy
  // runtime's mailbox as unreadable. The spawned binary is this same Node, so
  // the test stays offline and PATH-free.
  const run = createRunner({ bin: process.execPath });
  const out = run(['-e', 'process.stdout.write(JSON.stringify({ ok: true, result: { pad: "x".repeat(2 * 1024 * 1024) } }))']);
  assert.equal(out.status, 0, `the child was cut short: ${String(out.error ?? '')}`);
  assert.equal(out.receipt.ok, true, 'the receipt came back truncated');
});
