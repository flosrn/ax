// `ax ready release` — the issue-keyed resolver in front of worker/release.
//
// The proposition under test is the DELEGATION: this verb resolves issue →
// newest pass → request → record → dispatch id and hands over; every pane,
// proof and landing rule stays in worker/release.mjs. A test that probed panes
// here would be testing a second copy of rules this file must not have.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readyRelease } from '../src/ready/release.mjs';

const REPO = 'acme/widgets';

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-trel-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

const record = (store, request, { dispatchId = 'ctx_abc123' } = {}) => {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      attempts: [{ n: 1, phases: [{ name: 'worker-start', exit: 0, receipt: { ok: true, result: { dispatchId, state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: 'term_child' }] } } }] }],
    }),
  );
};

const draft = (root, name) => {
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', `${name}.md`), 'Labels: x\n\nDone.\n');
};

const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

const run = (argv, { root = repo(), code = 0 } = {}) => {
  const released = [];
  const result = capture(() =>
    readyRelease([...argv, '--repo', REPO], {
      exec: () => ({ status: 1, stdout: '', stderr: 'gh must not be needed with --repo' }),
      env: { ORCA_DISPATCH_STORE: join(root, 'store') },
      cwd: root,
      releaseFn: (args, options) => (released.push({ args, options }), code),
    }),
  );
  return { ...result, root, released };
};

test('issue → newest pass → dispatch id, then delegation with --close', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  record(join(root, 'store'), 'triage-acme-widgets-7-p2', { dispatchId: 'ctx_newer' });
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /pass 2 — request triage-acme-widgets-7-p2 → dispatch ctx_newer/);
  assert.deepEqual(r.released[0].args, ['--close', '--dispatch', 'ctx_newer']);
});

test('--no-proof rides through, because it is worker/release vocabulary', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  const r = run(['--issue', '7', '--no-proof'], { root });
  assert.deepEqual(r.released[0].args, ['--close', '--dispatch', 'ctx_abc123', '--no-proof']);
});

test("the delegate's verdict IS the verdict — its exit code is not softened", () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  assert.equal(run(['--issue', '7'], { root, code: 3 }).code, 3);
});

test('a hand-written draft has no pane: refused by name, nothing delegated', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /no dispatch record — a draft written by hand holds no pane/);
  assert.deepEqual(r.released, []);
});

test('a record without a dispatch id cannot be addressed, and says so', () => {
  const root = repo();
  const store = join(root, 'store');
  mkdirSync(store, { recursive: true });
  // A real attempt whose worker-start receipt names no dispatchId — the
  // Bash-era shape `report()` still reads, and the one this refusal is for.
  writeFileSync(
    join(store, 'triage-acme-widgets-7.json'),
    JSON.stringify({
      request: 'triage-acme-widgets-7',
      attempts: [{ n: 1, phases: [{ name: 'worker-start', exit: 0, receipt: { ok: true, result: { state: 'ready', receiptPath: '/tmp/r' } } }] }],
    }),
  );
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /recorded no dispatch id/);
  assert.deepEqual(r.released, []);
});

test('no pass at all, a named pass that does not exist, and usage errors', () => {
  assert.match(run(['--issue', '7']).out, /no pass of #7 exists here/);
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  const r = run(['--issue', '7', '--pass', '3'], { root });
  assert.match(r.out, /pass 3 of #7 does not exist \(existing: 1\)/);
  assert.equal(run([]).code, 2);
  assert.equal(run(['--issue', 'seven']).code, 2);
});
