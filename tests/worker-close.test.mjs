// Close's boundary is the verb, a real dispatch store, and a fake Orca transport.
// No mutating real runtime is ever spawned.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunner } from '../src/orca-bin.mjs';
import { initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';

function capture(fn) {
  const chunks = [];
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = process.stderr.write = text => (chunks.push(String(text)), true);
  try { return { code: fn(), out: chunks.join('') }; }
  finally { process.stdout.write = out; process.stderr.write = err; }
}
function fixture() {
  const store = mkdtempSync(join(tmpdir(), 'ax-close-'));
  const path = join(store, '50-work.json');
  initRecord(path, { request: '50-work', orca: 'stub-orca', repo: 'flosrn/ax' });
  phaseBegin(path, { name: 'worker-start', identity: 'start-one', argv: ['orca', 'orchestration', 'worker-start', '--on', 'gapicore'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_one', effects: [{ kind: 'terminal', role: 'agent', id: 'term_one' }] } }) });
  return { store, path };
}
const declarations = () => ({ ok: true, config: { dispatch: { hosts: { gapicore: { ssh: 'gapicore', root: '/srv' } } } } });
function fake({ store, present = true, receipt, unreachable = false, onClose } = {}) {
  const calls = [];
  let closed = false;
  const runner = createRunner({ bin: 'stub-orca', exec: (_, args) => {
    calls.push(args);
    if (args[0] === 'terminal' && args[1] === 'close') {
      const names = readdirSync(join(store, 'close'));
      assert.equal(names.length, 1);
      assert.equal(JSON.parse(readFileSync(join(store, 'close', names[0]), 'utf8')).state, 'issued');
      onClose?.();
      closed = true;
      return receipt ?? { status: 0, stdout: JSON.stringify({ ok: true, result: { close: { handle: 'term_one', ptyKilled: true } } }), stderr: '' };
    }
    assert.deepEqual(args, ['terminal', 'list', '--environment', 'gapicore', '--json']);
    if (unreachable) return { status: 1, stdout: '', stderr: 'offline' };
    return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminals: present && !closed ? [{ handle: 'term_one' }] : [], hostScope: { hostIds: ['local'], omittedHostIds: [] }, truncated: false } }), stderr: '' };
  } });
  return { runner, calls };
}

test('close a named remote pane write-ahead and record only its operator ending', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const f = fixture();
  const orca = fake(f);
  const result = capture(() => close(['term_one'], { runner: orca.runner, env: { HOME: f.store, ORCA_DISPATCH_STORE: f.store }, declarations }));
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(orca.calls.find(args => args[1] === 'close'), ['terminal', 'close', '--terminal', 'term_one', '--environment', 'gapicore', '--json']);
  const attempt = JSON.parse(readFileSync(f.path, 'utf8')).attempts[0];
  assert.equal(attempt.settled, false, 'Close is additive, never Release or settlement');
  assert.equal(attempt.ending.cause, 'operator-close');
  assert.equal(attempt.ending.handle, 'term_one');
  assert.equal(attempt.ending.host, 'gapicore');
  assert.match(result.out, /operator ending/);
  assert.doesNotMatch(result.out, /landed|merged/);
});
test('false stop receipt never writes an ending even when the pane disappears', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const f = fixture();
  const orca = fake({ ...f, receipt: { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'terminal_stop_live', data: { close: { handle: 'term_one', ptyKilled: false } } } }), stderr: '' } });
  const result = capture(() => close(['term_one'], { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations }));
  assert.equal(result.code, 1);
  assert.match(result.out, /process check/);
  assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
});

test('unreachable host refuses before issuing; already absent names settle', async () => {
  const { close } = await import('../src/worker/close.mjs');
  for (const opts of [{ unreachable: true }, { present: false }]) {
    const f = fixture();
    const orca = fake({ ...f, ...opts });
    const result = capture(() => close(['50-work'], { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations }));
    assert.equal(result.code, opts.unreachable ? 3 : 1);
    assert.equal(orca.calls.filter(args => args[1] === 'close').length, 0);
    if (!opts.unreachable) assert.match(result.out, /ax worker settle/);
    assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
  }
});

test('ending save failure resumes its exact attempt without a second terminal close', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const f = fixture();
  const orca = fake(f);
  const deps = { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations };
  const failed = capture(() => close(['term_one'], { ...deps, endAttempt: () => { throw new Error('ending save failed'); } }));
  assert.equal(failed.code, 3);
  assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
  assert.equal(capture(() => close(['term_one'], deps)).code, 0);
  assert.equal(capture(() => close(['term_one'], deps)).code, 0);
  assert.equal(orca.calls.filter(args => args[1] === 'close').length, 1);
});

test('ambiguous request names both handles, handle closes only its older attempt', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const { attemptNew } = await import('../src/worker/record.mjs');
  const f = fixture();
  attemptNew(f.path);
  phaseBegin(f.path, { name: 'worker-start', identity: 'start-two', argv: ['orca', 'orchestration', 'worker-start', '--on', 'gapicore'] });
  phaseEnd(f.path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_two', effects: [{ kind: 'terminal', role: 'agent', id: 'term_two' }] } }) });
  const orca = fake(f);
  const deps = { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations };
  const refused = capture(() => close(['50-work'], deps));
  assert.equal(refused.code, 1);
  assert.match(refused.out, /term_one.*term_two/);
  assert.equal(orca.calls.length, 0);
  assert.equal(capture(() => close(['term_one'], deps)).code, 0);
  const attempts = JSON.parse(readFileSync(f.path)).attempts;
  assert.equal(attempts[0].ending.handle, 'term_one');
  assert.equal(attempts[1].ending, undefined);
  assert.equal(attempts[1].settled, false);
});

test('a concurrent replace lock refuses close without writing an ending', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const { acquireLock } = await import('../src/worker/record.mjs');
  const f = fixture();
  const held = acquireLock(f.path);
  const orca = fake(f);
  try {
    assert.equal(capture(() => close(['term_one'], { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations })).code, 3);
    assert.equal(orca.calls.length, 0);
    assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
  } finally { held.release(); }
});

test('lost receipt recovery never reissues, absent becomes stop-unverified and unreachable stays issued', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const { saveCloseOperation } = await import('../src/worker/record.mjs');
  for (const unreachable of [false, true]) {
    const f = fixture();
    const first = fake({ ...f, receipt: { status: null, stdout: '', stderr: 'lost' } });
    const deps = { env: { ORCA_DISPATCH_STORE: f.store }, declarations };
    capture(() => close(['term_one'], { ...deps, runner: first.runner }));
    const operationPath = join(f.store, 'close', readdirSync(join(f.store, 'close'))[0]);
    const operation = JSON.parse(readFileSync(operationPath));
    operation.state = 'issued'; operation.receipt = null;
    saveCloseOperation(operationPath, operation);
    const recovery = fake({ ...f, present: false, unreachable });
    const result = capture(() => close(['term_one'], { ...deps, runner: recovery.runner }));
    assert.equal(result.code, unreachable ? 3 : 1);
    assert.equal(recovery.calls.filter(args => args[1] === 'close').length, 0);
    assert.equal(JSON.parse(readFileSync(operationPath)).state, unreachable ? 'issued' : 'stop-unverified');
    assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
    if (!unreachable) assert.match(result.out, /process check/);
  }
});

test('a closed state without its exact stop receipt cannot authorize an ending', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const { saveCloseOperation } = await import('../src/worker/record.mjs');
  const f = fixture();
  const orca = fake(f);
  const deps = { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations };
  capture(() => close(['term_one'], { ...deps, endAttempt: () => { throw new Error('save failed'); } }));
  const path = join(f.store, 'close', readdirSync(join(f.store, 'close'))[0]);
  const op = JSON.parse(readFileSync(path));
  op.receipt = null;
  saveCloseOperation(path, op);
  assert.equal(capture(() => close(['term_one'], deps)).code, 3);
  assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
  assert.equal(orca.calls.filter(args => args[1] === 'close').length, 1);
});

test('ls --all names the operator ending without calling it a landing', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const { ls } = await import('../src/worker/ls.mjs');
  const f = fixture();
  const deps = { env: { ORCA_DISPATCH_STORE: f.store }, declarations };
  capture(() => close(['term_one'], { ...deps, runner: fake(f).runner }));
  const runner = createRunner({ bin: 'stub-orca', exec: (_, args) => {
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }) };
    if (args[0] === 'terminal') return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [], hostScope: { hostIds: ['local'], omittedHostIds: [] } } }) };
    return { status: 0, stdout: JSON.stringify({ ok: true, result: { workers: [] } }) };
  } });
  const result = capture(() => ls(['--all'], { runner, env: deps.env, exec: () => ({ status: 1, stdout: '', stderr: '' }) }));
  assert.equal(result.code, 0);
  assert.match(result.out, /operator ending/);
  assert.match(result.out, /not a landing/);
});

test('wrong receipt handle and unverifiable stop are never operator endings', async () => {
  const { close } = await import('../src/worker/close.mjs');
  for (const receipt of [
    { ok: true, result: { close: { handle: 'term_other', ptyKilled: true } } },
    { ok: true, result: { close: { handle: 'term_one', ptyKilled: false, ptyStopVerdict: 'unverifiable' } } },
  ]) {
    const f = fixture();
    const orca = fake({ ...f, receipt: { status: 0, stdout: JSON.stringify(receipt), stderr: '' } });
    const deps = { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations };
    assert.equal(capture(() => close(['term_one'], deps)).code, 1);
    assert.equal(capture(() => close(['term_one'], deps)).code, 1);
    assert.equal(JSON.parse(readFileSync(f.path)).attempts[0].ending, undefined);
    assert.equal(orca.calls.filter(args => args[1] === 'close').length, 1);
  }
});

test('no subject and zero candidate refuse without a runtime mutation', async () => {
  const { close } = await import('../src/worker/close.mjs');
  const f = fixture();
  const orca = fake(f);
  const deps = { runner: orca.runner, env: { ORCA_DISPATCH_STORE: f.store }, declarations };
  assert.equal(capture(() => close([], deps)).code, 2);
  assert.equal(capture(() => close(['no-such-pane'], deps)).code, 1);
  assert.equal(orca.calls.length, 0);
});
