// Which provider mints the handoff, and what its answer is allowed to be.
//
// The provider boundary exists so the relay never knows how authority is
// created: it hands over an identity, a destination path and the confirming
// login, and gets one URL back. Two rules are the whole contract. The final URL
// must live on THIS worktree's Tailscale origin — the path may differ, because
// a Supabase callback lands on `/auth/confirm` and carries the destination as a
// parameter — and no resolved credential ever reaches a child process AX
// spawns: a command provider reads its own project configuration.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createHandoff, providerHost } from '../src/debug-as/provider.mjs';

const captured = JSON.parse(readFileSync(new URL('./fixtures/supabase-generate-link.json', import.meta.url), 'utf8'));
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service-role-payload.signature';
const ORIGIN = 'https://gapila-pro.tail1234.ts.net';

const supabaseProvider = () => ({
  type: 'supabase',
  urlEnv: 'NEXT_PUBLIC_SUPABASE_URL',
  serviceRoleKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY',
  confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' },
});

const commandProvider = (command = ['node', 'scripts/phone-provider.mjs']) => ({ type: 'command', command });

const readVariable = name => ({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: KEY })[name];

const request = (overrides = {}) => ({
  identity: { name: 'pro', email: 'pro@makerkit.dev' },
  destinationPath: '/home/gapila-pro',
  login: 'operator@example.com',
  tailnetOrigin: ORIGIN,
  root: '/Users/flo/Code/gapilabs/gapila-pro',
  readVariable,
  allowedHosts: [],
  ...overrides,
});

const okFetch = async () => new Response(JSON.stringify(captured), { status: 200 });

test('the built-in provider is reached for type "supabase" and answers the app callback', async () => {
  const { url } = await createHandoff({ provider: supabaseProvider(), ...request(), fetchImpl: okFetch });
  const built = new URL(url);
  assert.equal(built.origin, ORIGIN);
  assert.equal(built.pathname, '/auth/confirm');
  assert.equal(built.searchParams.get('next'), '/home/gapila-pro');
});

test('a command provider is invoked through the bounded adapter envelope, on the phone deadline', async () => {
  const calls = [];
  const runAdapter = async options => {
    calls.push(options);
    return { url: `${ORIGIN}/api/handoff?ticket=opaque` };
  };
  const { url } = await createHandoff({ provider: commandProvider(), ...request(), runAdapter });
  assert.equal(url, `${ORIGIN}/api/handoff?ticket=opaque`);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].command, ['node', 'scripts/phone-provider.mjs']);
  assert.equal(calls[0].timeoutSeconds, 15);
  assert.equal(calls[0].cwd, '/Users/flo/Code/gapilabs/gapila-pro');
  assert.deepEqual(calls[0].request, {
    kind: 'phone-handoff',
    identity: 'pro',
    email: 'pro@makerkit.dev',
    path: '/home/gapila-pro',
    origin: ORIGIN,
    login: 'operator@example.com',
  });
});

test('AX adds no resolved variable to a provider adapter\'s environment: the project reads its own configuration', async () => {
  let seen;
  const runAdapter = async options => {
    seen = options;
    return { url: `${ORIGIN}/api/handoff` };
  };
  await createHandoff({ provider: commandProvider(), ...request(), runAdapter });
  const serialized = JSON.stringify({ request: seen.request, env: seen.env ?? null });
  assert.doesNotMatch(serialized, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9|SERVICE_ROLE/);
  assert.ok(seen.env === undefined || !('SUPABASE_SERVICE_ROLE_KEY' in seen.env));
});

test('a command provider\'s answer must live on this worktree\'s Tailscale origin', async () => {
  for (const url of ['https://gapila.com/home', 'http://gapila-pro.tail1234.ts.net/home', 'https://other.tail1234.ts.net/home', 'not a url', '', 42]) {
    const runAdapter = async () => ({ url });
    let error;
    await assert.rejects(createHandoff({ provider: commandProvider(), ...request(), runAdapter }), err => {
      error = err;
      return err instanceof Error;
    });
    assert.ok(error.fix, `${url} must refuse with a repair`);
  }
});

test('a command provider\'s answer may carry any path on that origin, including the destination as a parameter', async () => {
  const runAdapter = async () => ({ url: `${ORIGIN}/auth/confirm?token_hash=x&next=%2Fhome%2Fgapila-pro` });
  const { url } = await createHandoff({ provider: commandProvider(), ...request(), runAdapter });
  assert.equal(new URL(url).pathname, '/auth/confirm');
});

test('an unsupported provider type refuses rather than falling back to a default', async () => {
  let error;
  await assert.rejects(createHandoff({ provider: { type: 'magic-sms' }, ...request() }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
});

test('a provider failure carries a repair and no provider diagnostic', async () => {
  const runAdapter = async () => {
    throw Object.assign(new Error('provider said: apikey=sk_live_abc123 invalid'), { fix: 'x' });
  };
  let error;
  await assert.rejects(createHandoff({ provider: commandProvider(), ...request(), runAdapter }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.doesNotMatch(`${error.message} ${error.problem ?? ''}`, /sk_live_abc123/);
});

test('the resolved provider host is classifiable without making a request or exposing the key', () => {
  const loopback = providerHost({ provider: supabaseProvider(), readVariable, allowedHosts: [] });
  assert.deepEqual(loopback, { host: '127.0.0.1', port: 54321, scheme: 'http', allowed: true, reason: 'loopback' });

  const remote = providerHost({
    provider: supabaseProvider(),
    readVariable: name => (name === 'NEXT_PUBLIC_SUPABASE_URL' ? 'https://supabase.example.ts.net' : KEY),
    allowedHosts: [],
  });
  assert.equal(remote.allowed, false);
  assert.equal(remote.host, 'supabase.example.ts.net');
  assert.equal(remote.reason, 'not-allowlisted');

  const allowed = providerHost({
    provider: supabaseProvider(),
    readVariable: name => (name === 'NEXT_PUBLIC_SUPABASE_URL' ? 'https://supabase.example.ts.net' : KEY),
    allowedHosts: [{ host: 'supabase.example.ts.net', port: 443 }],
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'allowlisted');

  assert.equal(JSON.stringify(providerHost({ provider: supabaseProvider(), readVariable, allowedHosts: [] })).includes(KEY), false);

  const unresolved = providerHost({ provider: supabaseProvider(), readVariable: () => undefined, allowedHosts: [] });
  assert.equal(unresolved.allowed, false);
  assert.equal(unresolved.host, null);
  assert.equal(unresolved.reason, 'unresolved');

  const command = providerHost({ provider: commandProvider(), readVariable, allowedHosts: [] });
  assert.equal(command.reason, 'command');
});

test('no module in this directory reaches src/log.mjs: every emission goes through the module emitter', async () => {
  const { readdirSync, readFileSync: read } = await import('node:fs');
  const directory = new URL('../src/debug-as/', import.meta.url);
  const offenders = readdirSync(directory)
    .filter(name => name.endsWith('.mjs') && name !== 'emit.mjs')
    .filter(name => /from '\.\.\/log\.mjs'/.test(read(new URL(name, directory), 'utf8')));
  assert.deepEqual(offenders, []);
});
