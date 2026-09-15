// The target a Role browser opens on — READ, never discovered.
//
// Every other address rule in this package derives a plan from the machine:
// `src/worktree/plan.mjs` probes ports, proxies and Tailscale. This one must
// not. A debug session opens on the address the worktree already recorded, so
// that a second opinion about which port is free cannot send an authenticated
// browser at another worktree's app (R5). The tests below therefore inject no
// port prober and no fetch into `readAddresses` at all: there is nothing to
// inject, and a future implementation that grows a probe cannot pass them.
//
// The one request AX does make is separate on purpose — `checkLive`, bounded,
// against the address already read, before any adapter runs.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appUrl, checkLive, readAddresses, readFlag, readVariable, LOCAL_HOSTS } from '../src/debug-as/address.mjs';

const config = { apps: { web: 'apps/web' } };

/** A checkout skeleton with the two env files this precedence reads. */
function checkout({ web = '', root = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ax-debug-address-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  if (web !== '') writeFileSync(join(dir, 'apps', 'web', '.env.local'), web);
  if (root !== '') writeFileSync(join(dir, '.env.local'), root);
  return dir;
}

const asWorktree = { isMainCheckout: () => false };
const asPrimary = { isMainCheckout: () => true };

test('a worktree opens on its own recorded direct address', () => {
  const root = checkout({ web: 'AX_DIRECT_URL=http://localhost:3110\nAX_TAILNET_URL=https://ofm-x.tail.ts.net\n' });
  const answer = readAddresses({ root, config, env: {}, repoPaths: asWorktree });

  assert.equal(answer.isWorktree, true);
  assert.equal(answer.browserOrigin, 'http://localhost:3110');
  assert.equal(answer.directOrigin, 'http://localhost:3110');
  assert.equal(answer.tailnetOrigin, 'https://ofm-x.tail.ts.net');
  assert.deepEqual(answer.refusals, []);
});

test('the primary checkout falls back to the project\'s own port, and never to the tailnet address', () => {
  const root = checkout({ root: 'PORT=3000\nAX_TAILNET_URL=https://ofm-main.tail.ts.net\n' });
  const answer = readAddresses({ root, config, env: {}, repoPaths: asPrimary });

  assert.equal(answer.isWorktree, false);
  assert.equal(answer.browserOrigin, 'http://localhost:3000');
  assert.equal(answer.directOrigin, null);
  assert.deepEqual(answer.refusals, []);
});

test('the primary checkout accepts a declared loopback BASE_URL when no port is recorded', () => {
  const root = checkout({ root: 'BASE_URL=http://127.0.0.1:4321/\n' });
  const answer = readAddresses({ root, config, env: {}, repoPaths: asPrimary });
  assert.equal(answer.browserOrigin, 'http://127.0.0.1:4321');
});

test('a recorded address that is not loopback is refused, never opened', () => {
  const root = checkout({ root: 'BASE_URL=https://app.example.com\n' });
  const answer = readAddresses({ root, config, env: {}, repoPaths: asPrimary });

  assert.equal(answer.browserOrigin, null);
  assert.equal(answer.refusals.length, 1);
  assert.match(answer.refusals[0].problem, /loopback/);
  assert.ok(answer.refusals[0].fix);
});

test('a worktree with no recorded address refuses and names the repair', () => {
  const root = checkout();
  const answer = readAddresses({ root, config, env: {}, repoPaths: asWorktree });

  assert.equal(answer.browserOrigin, null);
  assert.equal(answer.refusals.length, 1);
  assert.match(answer.refusals[0].problem, /AX_DIRECT_URL/);
  assert.match(answer.refusals[0].fix, /ax worktree setup/);
});

test('the phone half sees both recorded addresses, or their absence, without a second reader', () => {
  const root = checkout({ web: 'AX_DIRECT_URL=http://localhost:3110\n' });
  const answer = readAddresses({ root, config, env: {}, repoPaths: asWorktree });
  assert.equal(answer.tailnetOrigin, null);
  assert.deepEqual(answer.refusals, []);
});

test('the process environment outranks both env files', () => {
  const root = checkout({ web: 'AX_DIRECT_URL=http://localhost:3110\n', root: 'AX_DIRECT_URL=http://localhost:3999\n' });
  const answer = readAddresses({ root, config, env: { AX_DIRECT_URL: 'http://localhost:3001' }, repoPaths: asWorktree });
  assert.equal(answer.browserOrigin, 'http://localhost:3001');
});

test('the app env file outranks the root env file', () => {
  const root = checkout({ web: 'AX_DIRECT_URL=http://localhost:3110\n', root: 'AX_DIRECT_URL=http://localhost:3999\n' });
  const answer = readAddresses({ root, config, env: {}, repoPaths: asWorktree });
  assert.equal(answer.browserOrigin, 'http://localhost:3110');
});

test('readVariable answers the same precedence for a named project variable', () => {
  const root = checkout({ web: 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n', root: 'NEXT_PUBLIC_SUPABASE_URL=https://stale.supabase.co\n' });
  assert.equal(readVariable('NEXT_PUBLIC_SUPABASE_URL', { root, config, env: {} }), 'http://127.0.0.1:54321');
  assert.equal(readVariable('ABSENT_KEY', { root, config, env: {} }), undefined);
});

test('an assigned empty opt-in is false at its own layer and never falls through to a true one below', () => {
  const root = checkout({ web: 'AX_DEBUG_AS_PHONE=\n', root: 'AX_DEBUG_AS_PHONE=true\n' });
  const flag = readFlag('AX_DEBUG_AS_PHONE', { root, config, env: {} });

  assert.equal(flag.value, false);
  assert.equal(flag.problem, '');
});

test('an exported empty value beats a true value in every file', () => {
  const root = checkout({ web: 'AX_DEBUG_AS_PHONE=yes\n', root: 'AX_DEBUG_AS_PHONE=1\n' });
  assert.equal(readFlag('AX_DEBUG_AS_PHONE', { root, config, env: { AX_DEBUG_AS_PHONE: '' } }).value, false);
});

test('the recognized vocabulary is exactly 1/true/yes and 0/false/no', () => {
  const root = checkout();
  for (const value of ['1', 'true', 'yes', 'TRUE', 'Yes']) {
    assert.equal(readFlag('AX_DEBUG_AS_PHONE', { root, config, env: { AX_DEBUG_AS_PHONE: value } }).value, true, value);
  }
  for (const value of ['0', 'false', 'no', 'NO']) {
    assert.equal(readFlag('AX_DEBUG_AS_PHONE', { root, config, env: { AX_DEBUG_AS_PHONE: value } }).value, false, value);
  }
  assert.equal(readFlag('AX_DEBUG_AS_PHONE', { root, config, env: {} }).value, undefined);
});

test('any other opt-in value refuses with a repair instead of guessing', () => {
  const root = checkout({ root: 'AX_DEBUG_AS_PHONE=maybe\n' });
  const flag = readFlag('AX_DEBUG_AS_PHONE', { root, config, env: {} });

  assert.equal(flag.value, undefined);
  assert.match(flag.problem, /maybe/);
  assert.ok(flag.fix);
  assert.match(flag.at, /AX_DEBUG_AS_PHONE/);
});

test('appUrl joins the read origin with a re-validated path', () => {
  assert.equal(appUrl('http://localhost:3110', '/home/gapila-pro'), 'http://localhost:3110/home/gapila-pro');
});

test('appUrl refuses a path that could leave the origin, with its repair', () => {
  for (const path of ['//evil.example.com', 'home', 'http://evil.example.com/x', '/home?next=/x', '/home\\x']) {
    assert.throws(
      () => appUrl('http://localhost:3110', path),
      error => {
        assert.ok(error.fix, `no repair for ${path}`);
        return true;
      },
      path,
    );
  }
});

test('the liveness check is one bounded request against the address already read', async () => {
  const seen = [];
  const answer = await checkLive({
    origin: 'http://localhost:3110',
    contract: { browser: { start: ['pnpm', '--filter', 'web', 'dev'] } },
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), signal: Boolean(options?.signal), redirect: options?.redirect });
      return { status: 404 };
    },
  });

  assert.equal(answer.live, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://localhost:3110/');
  assert.equal(seen[0].signal, true);
  assert.equal(seen[0].redirect, 'manual');
});

test('an app that does not answer names the declared start command as its repair, and starts nothing', async () => {
  await assert.rejects(
    checkLive({
      origin: 'http://localhost:3110',
      contract: { browser: { start: ['pnpm', '--filter', 'web', 'dev'] } },
      fetchImpl: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    }),
    error => {
      assert.match(error.message, /http:\/\/localhost:3110/);
      assert.equal(error.fix, 'pnpm --filter web dev');
      return true;
    },
  );
});

test('a hanging app is bounded by the caller\'s deadline rather than waiting forever', async () => {
  await assert.rejects(
    checkLive({
      origin: 'http://localhost:3110',
      contract: { browser: { start: ['pnpm', 'dev'] } },
      timeoutMs: 20,
      fetchImpl: (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    }),
    error => {
      assert.ok(error.fix);
      return true;
    },
  );
});

test('headers are enough: a long body is cancelled so liveness cannot hold the connection', async () => {
  let cancelled = false;
  const payload = Buffer.alloc(64 * 1024, 0x78);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const stop = () => {
      cancelled = true;
      res.destroy();
    };
    req.on('aborted', stop);
    req.on('close', stop);
    res.on('close', stop);
    const pump = () => {
      if (cancelled || res.destroyed) return;
      if (!res.write(payload)) res.once('drain', pump);
      else setImmediate(pump);
    };
    pump();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const started = Date.now();
    const answer = await checkLive({
      origin: `http://127.0.0.1:${port}`,
      contract: { browser: { start: ['pnpm', 'dev'] } },
      timeoutMs: 5000,
    });
    assert.equal(answer.live, true);
    assert.ok(Date.now() - started < 1500, 'the liveness check waited on the body');
    const until = Date.now() + 500;
    while (!cancelled && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cancelled, true, 'the response body was not cancelled');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the local address vocabulary is shared, not re-spelled per module', () => {
  for (const host of ['localhost', '127.0.0.1', '::1']) assert.ok(LOCAL_HOSTS.has(host), host);
  assert.ok(!LOCAL_HOSTS.has('app.example.com'));
});
