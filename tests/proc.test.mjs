// Exercised against real processes, unprivileged: a `sleep` this test spawns in
// a temp directory. A fake would not catch the failure mode that matters —
// comparing an unresolved path against the physical one the kernel reports, which
// matches nothing and reports success.
//
// The pure decisions of the reaper (which pids it refuses to signal) are driven
// through injected probes instead, because provoking them for real would mean
// killing the test runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { pgidOf, procsByCwd, reapByCwd } from '../src/proc.mjs';

let fixture = '';
let nested = '';
const spawned = [];

/**
 * A long-lived process rooted in `cwd`.
 *
 * `detached` puts it in its OWN process group, which is what makes it reapable:
 * a child sharing the runner's group is deliberately spared, so a non-detached
 * child would test nothing but the guard. The handle is deliberately NOT
 * unref'd — an unref'd child keeps nothing alive, so awaiting its `exit` here
 * resolves after the event loop has already drained, which node:test reports as
 * a cancelled test rather than a failure.
 */
function sleeper(cwd) {
  const child = spawn('sleep', ['45'], { cwd, detached: true, stdio: 'ignore' });
  spawned.push(child);
  return child;
}

/** Poll rather than sleep a fixed delay: process startup is not a fixed cost. */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const exited = child => new Promise(resolve => (child.exitCode === null && child.signalCode === null ? child.once('exit', resolve) : resolve()));

before(() => {
  // NOT realpath'd on purpose: on macOS this is /var/… while the kernel and lsof
  // report /private/var/…, so this path is the regression case.
  fixture = mkdtempSync(join(tmpdir(), 'ax-proc-'));
  nested = join(fixture, 'apps', 'web');
  mkdirSync(nested, { recursive: true });
});

after(async () => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await Promise.all(spawned.map(exited));
  rmSync(fixture, { recursive: true, force: true });
});

test('procsByCwd finds processes rooted in the tree, through an unresolved path', async () => {
  const top = sleeper(fixture);
  const deep = sleeper(nested);

  const found = await waitFor(() => {
    const procs = procsByCwd(fixture);
    return procs.some(p => p.pid === top.pid) && procs.some(p => p.pid === deep.pid) ? procs : null;
  }, 'both sleepers to appear');

  assert.equal(
    found.find(p => p.pid === top.pid).comm,
    'sleep',
    'the command name must survive the platform lookup',
  );
  // The caller is normally inside the worktree it is tearing down; it must never
  // find itself.
  assert.equal(
    found.some(p => p.pid === process.pid),
    false,
  );
  // Sorted and deduplicated.
  assert.deepEqual([...found].sort((a, b) => a.pid - b.pid), found);
  assert.equal(new Set(found.map(p => p.pid)).size, found.length);

  // A subdirectory sees only what is under it.
  const under = procsByCwd(nested);
  assert.equal(under.some(p => p.pid === deep.pid), true);
  assert.equal(under.some(p => p.pid === top.pid), false);
});

test('a symlinked path finds the same processes as the physical one', async () => {
  const child = sleeper(nested);
  await waitFor(() => procsByCwd(nested).some(p => p.pid === child.pid), 'the sleeper to appear');

  const link = join(realpathSync(fixture), 'link');
  symlinkSync(nested, link);
  assert.equal(procsByCwd(link).some(p => p.pid === child.pid), true);
});

test('procsByCwd answers empty for a path that is not a directory', () => {
  assert.deepEqual(procsByCwd(join(fixture, 'nothing-here')), []);
  assert.deepEqual(procsByCwd(''), []);
  assert.deepEqual(procsByCwd(undefined), []);
});

test('pgidOf reads a live group and reports an exited pid as unknown', async () => {
  const child = sleeper(fixture);
  // A detached child leads its own group, so its pgid is its own pid.
  assert.equal(await waitFor(() => pgidOf(child.pid), 'a pgid for the sleeper'), child.pid);
  assert.equal(typeof pgidOf(process.pid), 'number');

  child.kill('SIGKILL');
  await exited(child);
  await waitFor(() => pgidOf(child.pid) === undefined, 'the exited pid to report no group');
});

test('reapByCwd signals the worktree processes and leaves the runner alone', async () => {
  const child = sleeper(fixture);
  await waitFor(() => procsByCwd(fixture).some(p => p.pid === child.pid), 'the sleeper to appear');

  const reaped = reapByCwd(fixture);
  assert.equal(reaped.some(entry => entry.pid === child.pid && entry.comm === 'sleep' && entry.signal === 'SIGTERM'), true);
  assert.equal(reaped.some(entry => entry.pid === process.pid), false);
  assert.equal(reaped.some(entry => entry.pid === process.ppid), false);

  await exited(child);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('reapByCwd refuses its own process group, even when the scan reports it', () => {
  // The reason pgidOf exists: cleanup runs from inside the worktree, so it finds
  // itself. Signalling its own group kills the teardown halfway through.
  const killed = [];
  const reaped = reapByCwd('/anywhere', {
    scan: () => [
      { pid: process.pid, comm: 'node' },
      { pid: 4242, comm: 'next-server' },
      { pid: 4243, comm: 'node' },
    ],
    pgid: pid => (pid === 4243 ? 999 : 7),
    kill: pid => killed.push(pid),
  });
  assert.deepEqual(killed, [4243]);
  assert.deepEqual(reaped, [{ pid: 4243, comm: 'node', signal: 'SIGTERM' }]);
});

test('a pid that vanishes between the scan and the signal is not an error', () => {
  const reaped = reapByCwd('/anywhere', {
    scan: () => [
      { pid: 4242, comm: 'node' },
      { pid: 4243, comm: 'esbuild' },
    ],
    // 4242 exited mid-teardown. 7 is the runner's own group, kept distinct from
    // 4243's so the signal is really attempted.
    pgid: pid => (pid === 4242 ? undefined : pid === 4243 ? 500 : 7),
    kill: pid => {
      if (pid === 4243) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  // Neither the missing group nor the failed signal throws, and neither is
  // reported as reaped.
  assert.deepEqual(reaped, []);
});

test('pattern is the only name filter: what it selects is what gets signalled', () => {
  const scan = () => [
    { pid: 11, comm: 'next-server' },
    { pid: 12, comm: 'tsserver' },
    { pid: 13, comm: 'zsh' },
  ];
  const probes = { scan, pgid: pid => pid * 10, kill: () => {} };

  assert.deepEqual(
    reapByCwd('/anywhere', { ...probes, pattern: 'next|tsserver' }).map(entry => entry.pid),
    [11, 12],
  );
  // No hidden allowlist: sparing a human's shell is the caller's pattern to
  // write, and the self-group guard, not a name this library decided on.
  assert.deepEqual(reapByCwd('/anywhere', { ...probes, pattern: '.*' }).map(entry => entry.pid), [11, 12, 13]);
  assert.deepEqual(reapByCwd('/anywhere', probes).map(entry => entry.pid), [11, 12, 13]);
});

test('the signal name is normalised, so callers may pass either form', () => {
  // The runner's own group must differ from the victim's, or the self-guard
  // spares it and this test measures nothing.
  const probes = { scan: () => [{ pid: 21, comm: 'node' }], pgid: pid => (pid === 21 ? 88 : 1) };
  const sent = [];
  const run = signal => reapByCwd('/anywhere', { ...probes, signal, kill: (_pid, name) => sent.push(name) });

  assert.equal(run('KILL')[0].signal, 'SIGKILL');
  assert.equal(run('SIGKILL')[0].signal, 'SIGKILL');
  assert.deepEqual(sent, ['SIGKILL', 'SIGKILL']);
});
