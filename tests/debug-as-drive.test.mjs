// Driving the operator's existing Role browser through agent-browser.
//
// `drive` mutates a session, so every non-live state is a refusal with an
// operator repair — the opposite of `status`, which answers those states as a
// Verdict. The child is spawned with no shell, inherits stdio so its stdout is
// byte-identical, and receives an environment from which every `AGENT_BROWSER_*`
// control has been dropped: an ambient session or provider must not redirect
// the driven window. AX prepends `--session` and `--cdp` from the receipt and
// refuses the caller supplying either.
//
// The receipt, the CDP probe and the spawn are injected. A test that needed a
// real agent-browser could not assert the one case that matters: that an
// ambient `AGENT_BROWSER_SESSION` never reaches the child.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { publishReceipt } from '../src/debug-as/receipt.mjs';
import { drive } from '../src/debug-as/drive.mjs';

const fixtures = [];
after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function worktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-debug-drive-')));
  fixtures.push(root);
  mkdirSync(join(root, '.agent'), { recursive: true });
  return root;
}

const HOST = 'mac.local';
const START = 'Fri Sep 12 09:00:00 2026';

const receiptDeps = (overrides = {}) => ({
  host: HOST,
  pid: 4242,
  alive: () => true,
  start: () => START,
  now: () => '2026-09-12T09:05:00.000Z',
  ignored: () => true,
  ...overrides,
});

const fields = (root, overrides = {}) => ({
  generation: 'a'.repeat(32),
  project: 'ofmchat',
  worktree: root,
  identity: 'owner',
  origin: 'http://localhost:3210',
  path: '/home',
  device: null,
  viewport: { width: 1280, height: 800 },
  cdpPort: 51234,
  sessionName: 'ax-debug-fixture-owner',
  chromiumPid: 9001,
  ...overrides,
});

const emitStub = () => {
  const calls = { refuse: [] };
  return {
    calls,
    emit: { refuse: (message, command) => calls.refuse.push({ message, command }) },
  };
};

const spawnSpy = (exit = 0) => {
  const calls = [];
  const spawn = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return {
      on(event, fn) {
        if (event === 'exit') queueMicrotask(() => fn(exit, null));
        return this;
      },
    };
  };
  return { spawn, calls };
};

const live = (root, extra = {}) => ({
  ...receiptDeps(),
  probe: async () => ({ alive: true }),
  ...extra,
});

test('drive prepends the owned session and CDP port, with no shell and inherited stdio', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { spawn, calls } = spawnSpy(0);
  const { emit } = emitStub();

  const code = await drive({ root }, { childArgv: ['snapshot'] }, { ...live(root), spawn, emit, which: () => '/usr/local/bin/agent-browser' });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/usr/local/bin/agent-browser');
  assert.deepEqual(calls[0].argv, ['--session', 'ax-debug-fixture-owner', '--cdp', '51234', 'snapshot']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.cwd, root);
});

test('the child exit status is the command exit status', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { spawn } = spawnSpy(7);
  const code = await drive({ root }, { childArgv: ['snapshot'] }, { ...live(root), spawn, emit: emitStub().emit, which: () => '/usr/local/bin/agent-browser' });
  assert.equal(code, 7);
});

test('spaces, metacharacters and post `--` help stay literal argv slots', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { spawn, calls } = spawnSpy(0);
  const argv = ['eval', "alert('x')", '--help', 'path with space'];
  await drive({ root }, { childArgv: argv }, { ...live(root), spawn, emit: emitStub().emit, which: () => '/usr/local/bin/agent-browser' });
  assert.deepEqual(calls[0].argv.slice(4), argv);
});

test('every documented AGENT_BROWSER_* ambient value is dropped so it cannot redirect the session', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { spawn, calls } = spawnSpy(0);
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/flo',
    AGENT_BROWSER_SESSION: 'stolen',
    AGENT_BROWSER_PROVIDER: 'remote',
    AGENT_BROWSER_ARGS: '--cdp 1',
    AGENT_BROWSER_CDP: '1',
    AGENT_BROWSER_ENGINE: 'webkit',
    KEEP_ME: 'yes',
  };
  await drive({ root, env }, { childArgv: ['snapshot'] }, { ...live(root), spawn, emit: emitStub().emit, which: () => '/usr/local/bin/agent-browser' });
  const childEnv = calls[0].options.env;
  assert.equal(childEnv.KEEP_ME, 'yes');
  assert.equal(childEnv.PATH, '/usr/bin');
  for (const key of Object.keys(childEnv)) assert.equal(key.startsWith('AGENT_BROWSER_'), false, key);
});

test('caller-supplied --session or --cdp refuses before the binary is resolved', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { spawn, calls } = spawnSpy(0);
  const { emit, calls: refused } = emitStub();
  let resolved = 0;

  for (const childArgv of [['--session', 'x'], ['--cdp', '1'], ['snapshot', '--session=x'], ['--cdp=9', 'snapshot']]) {
    const code = await drive({ root }, { childArgv }, { ...live(root), spawn, emit, which: () => (resolved += 1, '/usr/local/bin/agent-browser') });
    assert.notEqual(code, 0, childArgv.join(' '));
  }
  assert.equal(calls.length, 0);
  assert.equal(resolved, 0);
  assert.equal(refused.refuse.length, 4);
  assert.ok(refused.refuse[0].command);
});

test('an asserted identity mismatch refuses before delegation', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root, { identity: 'super-admin' }) }, receiptDeps());
  const { spawn, calls } = spawnSpy(0);
  const { emit, calls: refused } = emitStub();
  const code = await drive({ root }, { identity: 'guest', childArgv: ['snapshot'] }, { ...live(root), spawn, emit, which: () => '/usr/local/bin/agent-browser' });
  assert.notEqual(code, 0);
  assert.equal(calls.length, 0);
  assert.match(refused.refuse[0].message, /guest|super-admin/);
  assert.ok(refused.refuse[0].command);
});

test('every non-live state refuses with an operator repair, and never spawns', async () => {
  const { spawn, calls } = spawnSpy(0);
  const { emit, calls: refused } = emitStub();

  const absent = worktree();
  assert.notEqual(await drive({ root: absent }, { childArgv: ['snapshot'] }, { ...live(absent), spawn, emit, which: () => '/bin/true' }), 0);

  const stale = worktree();
  publishReceipt({ root: stale, fields: fields(stale) }, receiptDeps({ pid: 111 }));
  assert.notEqual(await drive({ root: stale }, { childArgv: ['snapshot'] }, { ...live(stale, { alive: () => false }), spawn, emit, which: () => '/bin/true' }), 0);

  const cdpDead = worktree();
  publishReceipt({ root: cdpDead, fields: fields(cdpDead) }, receiptDeps());
  assert.notEqual(await drive({ root: cdpDead }, { childArgv: ['snapshot'] }, { ...receiptDeps(), probe: async () => ({ alive: false }), spawn, emit, which: () => '/bin/true' }), 0);

  const foreign = worktree();
  publishReceipt({ root: foreign, fields: fields(foreign) }, receiptDeps({ host: 'other-host' }));
  assert.notEqual(await drive({ root: foreign }, { childArgv: ['snapshot'] }, { ...live(foreign), spawn, emit, which: () => '/bin/true' }), 0);

  assert.equal(calls.length, 0);
  assert.equal(refused.refuse.length, 4);
  for (const call of refused.refuse) assert.ok(call.command, call.message);
});

test('a missing agent-browser refuses with a repair and never invents a spawn', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { spawn, calls } = spawnSpy(0);
  const { emit, calls: refused } = emitStub();
  const code = await drive({ root }, { childArgv: ['snapshot'] }, { ...live(root), spawn, emit, which: () => null });
  assert.notEqual(code, 0);
  assert.equal(calls.length, 0);
  assert.match(refused.refuse[0].message, /agent-browser/);
  assert.ok(refused.refuse[0].command);
});
