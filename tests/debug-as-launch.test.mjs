// Launch ordering is authority: explicit phone failure must not open Chromium,
// and a fresh auth adapter runs only inside the browser owner's transition.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { debugAs } from '../src/debug-as/index.mjs';

const config = { project: { name: 'fixture' }, apps: { web: '.' }, debugAs: {
  browser: { playwrightDir: '.', start: ['node', 'app.mjs'], navigationTimeoutSeconds: 30 },
  identities: { guest: { defaultPath: '/' } },
} };
const fixture = overrides => ({
  paths: () => ({ root: '/fixture', main: '/fixture', isWorktree: false }),
  load: () => ({ config, errors: [], migration: null }),
  addresses: () => ({ browserOrigin: 'http://127.0.0.1:3000', tailnetOrigin: null, isWorktree: false, refusals: [] }),
  sweep: async () => {},
  preflight: () => ({ playwright: {}, surface: {} }),
  live: async () => {},
  output: { refuse() {}, note() {}, progress() {}, event() {}, raw() {} },
  ...overrides,
});
test('an unsupported required phone capability refuses before browser opens', async () => {
  let opened = false;
  const code = await debugAs(['--as', 'guest', '--phone'], fixture({ open: async () => { opened = true; } }));
  assert.equal(code, 1);
  assert.equal(opened, false);
});
test('launch completes owner supervision and propagates its exit', async () => {
  const events = [];
  const code = await debugAs(['--as', 'guest', '--no-phone'], fixture({
    preflight: () => { events.push('preflight'); return { playwright: {}, surface: {} }; },
    live: async () => { events.push('live'); },
    open: async (request, hooks) => { await hooks.beforeLaunch({ generation: 'generation' }); events.push('opened'); return { receipt: { generation: 'generation' }, mode: 'launched' }; },
    supervise: async () => { events.push('supervised'); return 7; },
  }));
  assert.equal(code, 7);
  assert.deepEqual(events, ['preflight', 'live', 'opened', 'supervised']);
});
test('status delegates without GUI, auth, liveness or browser launch', async () => {
  const code = await debugAs(['status'], fixture({
    preflight: () => { throw new Error('GUI must not be checked'); },
    status: async context => { assert.equal(context.root, '/fixture'); return 0; },
  }));
  assert.equal(code, 0);
});

test('required phone failure prevents launch; automatic failure preserves it; suppression calls nothing', async () => {
  const adopted = structuredClone(config);
  adopted.debugAs.browser.prepare = { command: ['node', 'adapter.mjs'], timeoutSeconds: 5 };
  adopted.debugAs.identities.owner = { defaultPath: '/private', browser: { storageState: '.agent/owner.json' }, phone: { email: 'owner@example.com' } };
  adopted.debugAs.phone = { optInEnv: 'AX_PHONE', provider: { type: 'command', command: ['node', 'phone.mjs'] } };
  for (const [flags, expectedCode, expectedOpened, expectedCalls] of [
    [['--phone'], 1, false, 1], [[], 0, true, 1], [['--no-phone'], 0, true, 0],
  ]) {
    let opened = false;
    let calls = 0;
    const code = await debugAs(['--as', 'owner', ...flags], fixture({
      load: () => ({ config: adopted, errors: [] }),
      addresses: () => ({ isWorktree: true, browserOrigin: 'http://127.0.0.1:3000', directOrigin: 'http://127.0.0.1:3000', tailnetOrigin: 'https://machine.example:3000', refusals: [] }),
      flag: () => ({ value: true, problem: '' }),
      adapter: async () => ({ protocol: 1 }),
      storage: async () => ({ state: { cookies: [], origins: [] }, refreshNeeded: false }),
      phone: async () => { calls += 1; throw Object.assign(new Error('handoff unavailable'), { fix: 'repair phone' }); },
      open: async (request, hooks) => {
        await hooks.beforeLaunch({ generation: 'same-generation' });
        opened = true;
        await hooks.onPublished({ generation: 'same-generation' });
        return { mode: 'launched' };
      },
      supervise: async () => 0,
    }));
    assert.equal(code, expectedCode);
    assert.equal(opened, expectedOpened);
    assert.equal(calls, expectedCalls);
  }
});

test('diagnostic findings use exit one, never the usage exit code', async () => {
  assert.equal(await debugAs(['doctor'], fixture({ doctor: async () => 2 })), 1);
});

test('failed relay cleanup preserves its diagnosis and makes launch fail', async () => {
  const adopted = structuredClone(config);
  adopted.debugAs.browser.prepare = { command: ['node', 'adapter.mjs'], timeoutSeconds: 5 };
  adopted.debugAs.identities.owner = { defaultPath: '/', browser: { storageState: '.agent/owner.json' }, phone: { email: 'owner@example.com' } };
  adopted.debugAs.phone = { optInEnv: 'AX_PHONE', provider: { type: 'command', command: ['node', 'phone.mjs'] } };
  const failures = [];
  const code = await debugAs(['--as', 'owner', '--phone'], fixture({
    load: () => ({ config: adopted, errors: [] }),
    addresses: () => ({ isWorktree: true, browserOrigin: 'http://127.0.0.1:3000', directOrigin: 'http://127.0.0.1:3000', tailnetOrigin: 'https://machine.example:3000', refusals: [] }),
    adapter: async () => ({ protocol: 1 }),
    storage: async () => ({ state: {}, refreshNeeded: false }),
    phone: async () => ({ published: true, url: 'https://machine.example/go', session: { stop: async () => { throw Object.assign(new Error('Serve withdrawal refused'), { fix: 'tailscale serve --https=1401 off' }); } } }),
    open: async (request, hooks) => { await hooks.beforeLaunch({ generation: 'same' }); return {}; },
    supervise: async () => 0,
    output: { progress() {}, refuse: (message, fix) => failures.push({ message, fix }) },
  }));
  assert.equal(code, 1);
  assert.ok(failures.some(finding => finding.message.includes('Serve withdrawal refused') && finding.fix.includes('1401')));
});
