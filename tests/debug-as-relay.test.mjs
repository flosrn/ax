// The machine Phone relay: one loopback listener that mints authority only
// after a confirmed, user-bound, single-use POST.
//
// Everything here is a security rule with a failure mode attached. The relay is
// reachable from the tailnet, so an unauthenticated GET that created a magic
// link would hand a session to a link preview. Serve mappings outlive the
// process that made them, so ownership is generational and withdrawal happens
// BEFORE the listener is released. And every refusal — no identity header, a
// duplicate one, a foreign `Host`, a cross-site submission, a wrong path — is
// the same `404`, because distinguishable refusals are a probe oracle.

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRelayServer, phoneHandoff, startRelay } from '../src/debug-as/relay.mjs';
import { resetNotifications } from '../src/debug-as/notifier.mjs';
import { clearRelayReceipt, publishRelayReceipt, readRelayReceipt, relayOwnedBy, relayReceiptPath, relayUrl, sweepDeadRelay } from '../src/debug-as/relay-receipt.mjs';

const GENERATION = 'a'.repeat(32);
const OTHER_GENERATION = 'b'.repeat(32);
const LOGIN = 'operator@example.com';

const home = () => mkdtempSync(join(tmpdir(), 'ax-relay-'));

const machine = () => ({
  relayPort: 1300,
  allowedLogins: [LOGIN],
  allowedSupabaseHosts: [],
  notifier: null,
});

const machineContractPath = configHome => join(configHome, '.config', 'ax', 'debug-as.json');

const writeMachineContract = configHome => {
  mkdirSync(join(configHome, '.config', 'ax'), { recursive: true, mode: 0o700 });
  writeFileSync(
    machineContractPath(configHome),
    JSON.stringify({
      relayPort: 1300,
      allowedTailscaleLogins: [LOGIN],
      allowedSupabaseHosts: [],
      notifier: { command: ['private-notifier'] },
    }),
    { mode: 0o600 },
  );
};

const worktree = () => {
  const root = mkdtempSync(join(tmpdir(), 'ax-wt-'));
  mkdirSync(join(root, '.agent'), { recursive: true });
  return root;
};

/** A live Browser receipt for `generation`, the way `readReceipt` answers one. */
const liveReceipt = (root, generation = GENERATION) => ({
  state: 'live',
  receipt: {
    version: 1,
    generation,
    host: 'mac',
    pid: 4242,
    processStart: 'Mon Sep 13 10:00:00 2026',
    project: 'gapila',
    worktree: root,
    identity: 'pro',
    origin: 'http://localhost:3010',
    path: '/home/gapila-pro',
    cdpPort: 51234,
    sessionName: 'ax-debug-pro',
    publishedAt: '2026-09-13T10:00:00.000Z',
  },
  owner: null,
  refusal: null,
});

/** One raw HTTP/1.1 request, so duplicate headers and oversized bodies stay expressible. */
const rawRequest = (port, { method = 'GET', path = '/go', headers = [], body = null, host } = {}) =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host ?? `127.0.0.1:${port}`}`];
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    if (body !== null) {
      lines.push('Content-Type: application/x-www-form-urlencoded');
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    }
    lines.push('Connection: close', '', body ?? '');
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      answer += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const split = answer.indexOf('\r\n\r\n');
      const head = split === -1 ? answer : answer.slice(0, split);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const map = new Map();
      for (const line of headerLines) {
        const at = line.indexOf(':');
        if (at > 0) map.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
      }
      resolve({
        status: Number(statusLine?.split(' ')[1] ?? 0),
        headers: map,
        body: split === -1 ? '' : answer.slice(split + 4),
      });
    });
    socket.write(lines.join('\r\n'));
  });

/** A relay bound on an ephemeral loopback port, with every machine answer injected. */
const relay = async (overrides = {}) => {
  const root = overrides.root ?? worktree();
  const calls = [];
  const server = await createRelayServer({
    context: { root, name: 'gapila-pro', project: 'gapila' },
    generation: GENERATION,
    identity: 'pro',
    path: '/home/gapila-pro',
    machine: machine(),
    serveHost: 'mac.tail1234.ts.net',
    createHandoff: async request => {
      calls.push(request);
      return { url: 'https://mac.tail1234.ts.net/auth/confirm?token_hash=abc&type=magiclink&next=%2Fhome%2Fgapila-pro' };
    },
    readReceipt: () => liveReceipt(root),
    publishedAt: '2026-09-13T10:00:00.000Z',
    ...overrides,
  });
  return { ...server, root, calls };
};

const allowed = [['Tailscale-User-Login', LOGIN]];

/** A confirmation page's nonce, which is the only thing a POST may carry. */
const nonceFrom = html => {
  const match = /name="nonce" value="([a-f0-9]+)"/.exec(html);
  assert.ok(match, 'the confirmation page carries exactly one nonce field');
  return match[1];
};

/** A Tailscale stand-in that REMEMBERS what it published, so reuse is observable. */
const statefulTailscale = (calls = []) => {
  const mappings = { Web: {} };
  const key = flag => `mac.tail1234.ts.net:${String(flag).replace('--https=', '')}`;
  const run = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tail1234.ts.net.' } }), stderr: '' };
    if (args[1] === 'status') return { status: 0, stdout: JSON.stringify(mappings), stderr: '' };
    if (args[1] === '--bg') mappings.Web[key(args[2])] = { Handlers: { '/': { Proxy: args[3] } } };
    if (args[2] === 'off') delete mappings.Web[key(args[1])];
    return { status: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
};

test('a GET from an allowed user renders the intent, creates no authority and carries the security headers', async () => {
  const server = await relay();
  const answer = await rawRequest(server.port, { headers: allowed });
  assert.equal(answer.status, 200);
  assert.equal(server.calls.length, 0, 'a preview GET makes zero provider calls');
  assert.match(answer.body, /gapila/);
  assert.match(answer.body, /\/home\/gapila-pro/);
  assert.match(answer.body, /<meta name="viewport"/);
  assert.match(answer.body, /<button[^>]*>/);
  assert.equal(answer.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
  assert.match(answer.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(answer.headers.get('access-control-allow-origin'), undefined);
  assert.doesNotMatch(answer.body, /<script|https?:\/\/(?!mac\.tail)/i);
  await server.close();
});

test('project-authored text is escaped, so an identity or path cannot inject markup', async () => {
  const server = await relay({ identity: 'pro', path: '/home/<img src=x onerror=alert(1)>', context: { root: worktree(), name: '"><script>alert(1)</script>', project: 'gapila' } });
  const answer = await rawRequest(server.port, { headers: allowed });
  assert.equal(answer.status, 200);
  assert.doesNotMatch(answer.body, /<script>alert/);
  assert.doesNotMatch(answer.body, /<img src=x/);
  assert.match(answer.body, /&lt;script&gt;|&lt;img/);
  await server.close();
});

test('every unauthorized shape receives one indistinguishable 404 and mutates nothing', async () => {
  const server = await relay();
  const cases = [
    { name: 'no identity header', options: {} },
    { name: 'unauthorized identity', options: { headers: [['Tailscale-User-Login', 'stranger@example.com']] } },
    { name: 'duplicate identity headers', options: { headers: [['Tailscale-User-Login', LOGIN], ['Tailscale-User-Login', LOGIN]] } },
    { name: 'comma-joined identities', options: { headers: [['Tailscale-User-Login', `${LOGIN},stranger@example.com`]] } },
    { name: 'empty identity', options: { headers: [['Tailscale-User-Login', '']] } },
    { name: 'foreign Host', options: { headers: allowed, host: 'evil.example.com' } },
    { name: 'another path', options: { headers: allowed, path: '/' } },
    { name: 'another method', options: { headers: allowed, method: 'DELETE' } },
  ];
  const bodies = new Set();
  for (const { name, options } of cases) {
    const answer = await rawRequest(server.port, options);
    assert.equal(answer.status, 404, name);
    bodies.add(answer.body);
    assert.equal(answer.headers.get('referrer-policy'), 'no-referrer', name);
  }
  assert.equal(bodies.size, 1, 'one body for every refusal: a distinguishable 404 is a probe oracle');
  assert.equal(server.calls.length, 0);
  await server.close();
});

test('the mapped Serve hostname is an accepted Host, because that is what the phone sends', async () => {
  const server = await relay();
  const answer = await rawRequest(server.port, { headers: allowed, host: 'mac.tail1234.ts.net:1300' });
  assert.equal(answer.status, 200);
  await server.close();
});

test('a cross-site submission is refused with the same 404 as an unknown caller', async () => {
  const server = await relay();
  const page = await rawRequest(server.port, { headers: allowed });
  const nonce = nonceFrom(page.body);
  for (const header of [['Origin', 'https://evil.example.com'], ['Sec-Fetch-Site', 'cross-site']]) {
    const answer = await rawRequest(server.port, { method: 'POST', headers: [...allowed, header], body: `nonce=${nonce}` });
    assert.equal(answer.status, 404);
  }
  assert.equal(server.calls.length, 0, 'a cross-site POST never reaches the provider');
  await server.close();
});

test('a cross-site GET is refused too: the confirmation page is not a page another site may drive', async () => {
  const server = await relay();
  for (const header of [['Origin', 'https://evil.example.com'], ['Sec-Fetch-Site', 'cross-site']]) {
    const answer = await rawRequest(server.port, { headers: [...allowed, header] });
    assert.equal(answer.status, 404, `${header[0]} must not reach the confirmation page`);
    assert.doesNotMatch(answer.body, /name="nonce"/, 'and no nonce is minted for it');
  }
  const navigation = await rawRequest(server.port, { headers: [...allowed, ['Sec-Fetch-Site', 'none']] });
  assert.equal(navigation.status, 200, 'a top-level navigation is what the phone actually sends');
  await server.close();
});

test('one confirmation creates exactly one provider request and redirects with 303', async () => {
  const server = await relay();
  const page = await rawRequest(server.port, { headers: allowed });
  const nonce = nonceFrom(page.body);
  const answer = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  assert.equal(answer.status, 303);
  assert.match(answer.headers.get('location'), /^https:\/\/mac\.tail1234\.ts\.net\/auth\/confirm\?/);
  assert.equal(server.calls.length, 1);
  assert.deepEqual(server.calls[0], { identity: 'pro', path: '/home/gapila-pro', login: LOGIN, generation: GENERATION });
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  await server.close();
});

test('a nonce is single-use: the second submission returns to a fresh GET without a provider call', async () => {
  const server = await relay();
  const nonce = nonceFrom((await rawRequest(server.port, { headers: allowed })).body);
  await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  const replay = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  assert.equal(replay.status, 303);
  assert.match(replay.headers.get('location'), /\/go\?/, 'a rejected POST returns to a fresh GET, never a dead end');
  assert.equal(server.calls.length, 1);
  await server.close();
});

// STDOUT IS NOT A LOG. A launch's stdout is a payload an agent parses, and the
// relay keeps serving long after that payload is written: a request-time line
// on stdout lands wherever the reader happens to be. Measured on CI run
// 34940453124 (Linux, Node 22): the first refusal note reached stdout while
// `node --test` was framing its own protocol on the same stream, and this whole
// file died with "Unable to deserialize cloned data due to invalid or
// unsupported version" — 43 tests lost, while `--test-reporter=spec` passed all
// 43 on the same machine. The refusal is an operator line; it belongs on stderr.
test('a request-time refusal is an operator line on stderr, never a byte of the payload stream', async () => {
  const server = await relay();
  const nonce = nonceFrom((await rawRequest(server.port, { headers: allowed })).body);
  await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });

  const out = [];
  const err = [];
  const streams = [
    [process.stdout, process.stdout.write.bind(process.stdout), out],
    [process.stderr, process.stderr.write.bind(process.stderr), err],
  ];
  for (const [stream, , sink] of streams) {
    stream.write = chunk => {
      sink.push(String(chunk));
      return true;
    };
  }
  try {
    const replay = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
    assert.equal(replay.status, 303);
  } finally {
    for (const [stream, original] of streams) stream.write = original;
  }

  assert.equal(out.join(''), '', 'the payload stream carries nothing a live listener said');
  assert.match(err.join(''), /phone confirmation refused \(unknown nonce, [0-9a-f]+\)/);
  await server.close();
});

test('an expired nonce, another user\'s nonce and an unknown nonce all return to a fresh GET', async () => {
  let clock = 1_000_000;
  const machineTwo = { ...machine(), allowedLogins: [LOGIN, 'second@example.com'] };
  const server = await relay({ machine: machineTwo, now: () => clock });
  const mine = nonceFrom((await rawRequest(server.port, { headers: allowed })).body);
  const theirs = nonceFrom((await rawRequest(server.port, { headers: [['Tailscale-User-Login', 'second@example.com']] })).body);

  const stolen = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${theirs}` });
  assert.match(stolen.headers.get('location'), /\/go\?/, 'a nonce is bound to the user it was minted for');

  const unknown = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${'f'.repeat(64)}` });
  assert.match(unknown.headers.get('location'), /\/go\?/);

  clock += 121_000;
  const expired = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${mine}` });
  assert.match(expired.headers.get('location'), /\/go\?/, 'two minutes is the whole life of a nonce');
  assert.equal(server.calls.length, 0);
  await server.close();
});

test('outstanding nonces are capped per generation and evicted oldest-first', async () => {
  const server = await relay({ nonceCap: 3 });
  const nonces = [];
  for (let index = 0; index < 4; index += 1) nonces.push(nonceFrom((await rawRequest(server.port, { headers: allowed })).body));

  const evicted = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonces[0]}` });
  assert.match(evicted.headers.get('location'), /\/go\?/, 'the oldest outstanding nonce is the one that goes');

  const newest = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonces[3]}` });
  assert.equal(newest.status, 303);
  assert.match(newest.headers.get('location'), /auth\/confirm/);
  await server.close();
});

test('a superseded generation renders a non-mutating page instead of another target\'s screen', async () => {
  const server = await relay();
  const answer = await rawRequest(server.port, { headers: allowed, path: `/go?g=${OTHER_GENERATION}` });
  assert.equal(answer.status, 200);
  assert.match(answer.body, /superseded/i);
  assert.doesNotMatch(answer.body, /name="nonce"/, 'a superseded page offers nothing to confirm');
  assert.equal(server.calls.length, 0);
  await server.close();
});

test('a body over 4 KiB is refused without being parsed or forwarded', async () => {
  const server = await relay();
  const nonce = nonceFrom((await rawRequest(server.port, { headers: allowed })).body);
  const answer = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}&padding=${'x'.repeat(5000)}` });
  assert.equal(answer.status, 404);
  assert.equal(server.calls.length, 0);
  await server.close();
});

test('a dead or superseded Browser receipt serves nothing: the relay rereads it on every request', async () => {
  const root = worktree();
  const server = await relay({ root, readReceipt: () => ({ state: 'dead', receipt: null, owner: null, refusal: null }) });
  assert.equal((await rawRequest(server.port, { headers: allowed })).status, 404);
  await server.close();

  const other = await relay({ root, readReceipt: () => liveReceipt(root, OTHER_GENERATION) });
  assert.equal((await rawRequest(other.port, { headers: allowed })).status, 404);
  assert.equal(other.calls.length, 0);
  await other.close();
});

// The machine relay receipt, the other half of the same reread. A listener
// whose mapping a newer publication took over keeps its socket — it is still
// bound, still authorized, still holding a Browser receipt that says live —
// and must nevertheless answer nothing, on both methods, because the Serve
// port in front of it now points at another target.
test('a listener that no longer owns the machine mapping answers the same 404 on GET and POST, and mints no authority', async () => {
  let owns = true;
  const server = await relay({ ownsRelay: () => owns });

  const page = await rawRequest(server.port, { headers: allowed });
  assert.equal(page.status, 200, 'while it owns the mapping it serves');
  const nonce = nonceFrom(page.body);

  owns = false;
  const get = await rawRequest(server.port, { headers: allowed });
  assert.equal(get.status, 404);
  assert.doesNotMatch(get.body, /name="nonce"/, 'and no further nonce is minted');

  const post = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  assert.equal(post.status, 404, 'a nonce minted while it was the owner is worthless afterwards');
  assert.equal(post.body, get.body, 'the same indistinguishable refusal as an unknown caller');
  assert.equal(server.calls.length, 0, 'no provider request is ever made by a superseded listener');
  await server.close();
});

test('an ownership check that throws is not ownership: the listener refuses rather than assuming it is live', async () => {
  const server = await relay({
    ownsRelay: () => {
      throw new Error('the machine receipt is unreadable');
    },
  });
  assert.equal((await rawRequest(server.port, { headers: allowed })).status, 404);
  assert.equal(server.calls.length, 0);
  await server.close();
});

test('a provider failure consumes the nonce, returns to a fresh GET and reveals no provider detail', async () => {
  const server = await relay({
    createHandoff: async () => {
      throw Object.assign(new Error('Supabase answered 500: service_role key rejected for project xyz'), { fix: 'check the key' });
    },
  });
  const nonce = nonceFrom((await rawRequest(server.port, { headers: allowed })).body);
  const answer = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  assert.equal(answer.status, 303);
  assert.match(answer.headers.get('location'), /\/go\?/);
  assert.doesNotMatch(answer.body, /service_role|Supabase|500/);

  const replay = await rawRequest(server.port, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  assert.match(replay.headers.get('location'), /\/go\?/, 'the failed attempt still consumed its nonce');
  await server.close();
});

test('the relay binds loopback only', async () => {
  const server = await relay();
  assert.equal(server.address.address, '127.0.0.1');
  await server.close();
});

// ---------------------------------------------------------------------------
// Ownership: the receipt, the sweep and the publication lifecycle.
// ---------------------------------------------------------------------------

const record = (root, overrides = {}) => ({
  version: 1,
  generation: GENERATION,
  host: 'mac',
  pid: 4242,
  processStart: 'Mon Sep 13 10:00:00 2026',
  port: 1300,
  serveHost: 'mac.tail1234.ts.net',
  serveTarget: 'http://127.0.0.1:52341',
  project: 'gapila',
  worktree: root,
  identity: 'pro',
  path: '/home/gapila-pro',
  publishedAt: '2026-09-13T10:00:00.000Z',
  ...overrides,
});

test('the relay receipt round-trips privately and is owned by one generation and one worktree', () => {
  const configHome = home();
  const root = worktree();
  publishRelayReceipt(record(root), { home: configHome, env: {} });
  const path = relayReceiptPath({ home: configHome, env: {} });
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const read = readRelayReceipt({ home: configHome, env: {} });
  assert.equal(read.generation, GENERATION);
  assert.equal(relayOwnedBy(read, { root, generation: GENERATION }), true);
  assert.equal(relayOwnedBy(read, { root, generation: OTHER_GENERATION }), false);
  assert.equal(relayOwnedBy(read, { root: worktree(), generation: GENERATION }), false);
  assert.equal(relayUrl(read), `https://mac.tail1234.ts.net:1300/go?g=${GENERATION}`);
  assert.equal(Object.keys(read).some(key => /token|secret|key|state/i.test(key)), false, 'no authentication material in a relay receipt');
});

test('an absent or malformed receipt reads as absence, never as an owner', () => {
  const configHome = home();
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
  mkdirSync(join(configHome, '.config', 'ax'), { recursive: true });
  writeFileSync(relayReceiptPath({ home: configHome, env: {} }), '{ not json');
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
  assert.equal(relayOwnedBy(null, { root: '/x', generation: GENERATION }), false);
});

test('only the owning generation may clear the receipt, so an old owner cannot unpublish a new one', () => {
  const configHome = home();
  const root = worktree();
  publishRelayReceipt(record(root, { generation: OTHER_GENERATION }), { home: configHome, env: {} });
  assert.equal(clearRelayReceipt({ home: configHome, env: {}, generation: GENERATION }), false);
  assert.equal(readRelayReceipt({ home: configHome, env: {} }).generation, OTHER_GENERATION);
  assert.equal(clearRelayReceipt({ home: configHome, env: {}, generation: OTHER_GENERATION }), true);
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
});

const sweepDeps = ({ configHome, alive = () => false, start = () => null, calls = [] }) => ({
  home: configHome,
  env: {},
  host: 'mac',
  alive,
  start,
  run: (bin, args) => {
    calls.push([bin, ...args]);
    return { status: 0, stdout: '{}', stderr: '' };
  },
});

test('a proven-dead owner\'s mapping is withdrawn and its receipt cleared', () => {
  const configHome = home();
  const calls = [];
  publishRelayReceipt(record(worktree()), { home: configHome, env: {} });
  const answer = sweepDeadRelay(sweepDeps({ configHome, calls }));
  assert.equal(answer.withdrawn, true);
  assert.deepEqual(calls, [['tailscale', 'serve', '--https=1300', 'off']]);
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
});

test('a recycled pid is not the owner: a live pid with another start identity is dead state', () => {
  const configHome = home();
  const calls = [];
  publishRelayReceipt(record(worktree()), { home: configHome, env: {} });
  const answer = sweepDeadRelay(sweepDeps({ configHome, calls, alive: () => true, start: () => 'Tue Sep 14 09:00:00 2026' }));
  assert.equal(answer.withdrawn, true);
  assert.deepEqual(calls, [['tailscale', 'serve', '--https=1300', 'off']]);
});

test('a live owner and an owner on another host are both left alone', () => {
  const configHome = home();
  const calls = [];
  publishRelayReceipt(record(worktree()), { home: configHome, env: {} });
  const live = sweepDeadRelay(sweepDeps({ configHome, calls, alive: () => true, start: () => 'Mon Sep 13 10:00:00 2026' }));
  assert.equal(live.withdrawn, false);
  assert.equal(live.reason, 'live');

  publishRelayReceipt(record(worktree(), { host: 'other' }), { home: configHome, env: {} });
  const foreign = sweepDeadRelay(sweepDeps({ configHome, calls }));
  assert.equal(foreign.withdrawn, false);
  assert.deepEqual(calls, [], 'nothing is withdrawn for a live or unverifiable owner');
  assert.ok(readRelayReceipt({ home: configHome, env: {} }));
});

test('an unverifiable owner — alive, start identity unreadable — is ambiguous and never swept', () => {
  const configHome = home();
  const calls = [];
  publishRelayReceipt(record(worktree()), { home: configHome, env: {} });
  const answer = sweepDeadRelay(sweepDeps({ configHome, calls, alive: () => true, start: () => null }));
  assert.equal(answer.withdrawn, false);
  assert.equal(answer.reason, 'ambiguous');
  assert.deepEqual(calls, []);
});

test('an absent receipt sweeps nothing and runs no command', () => {
  const calls = [];
  const answer = sweepDeadRelay(sweepDeps({ configHome: home(), calls }));
  assert.deepEqual(answer, { withdrawn: false, reason: 'absent' });
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Publication: bind, sweep, publish, and withdraw before releasing the listener.
// ---------------------------------------------------------------------------

/** A Tailscale stand-in whose calls are the observable order of the lifecycle. */
const tailscale = ({ mappings = {}, calls = [] } = {}) => {
  const run = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tail1234.ts.net.' } }), stderr: '' };
    if (args[1] === 'status') return { status: 0, stdout: JSON.stringify(mappings), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
};

const publication = (overrides = {}) => {
  const root = overrides.root ?? worktree();
  const configHome = overrides.configHome ?? home();
  return {
    root,
    configHome,
    options: {
      context: { root, name: 'gapila-pro', project: 'gapila' },
      generation: GENERATION,
      identity: 'pro',
      path: '/home/gapila-pro',
      machine: machine(),
      createHandoff: async () => ({ url: 'https://mac.tail1234.ts.net/auth/confirm' }),
      readReceipt: () => liveReceipt(root),
      home: configHome,
      env: {},
      host: 'mac',
      alive: () => false,
      start: () => null,
      pid: process.pid,
      processStart: 'Mon Sep 13 10:00:00 2026',
      ...overrides,
    },
  };
};

test('publication binds loopback, maps Serve at the stable port and records the generation-addressed URL', async () => {
  const calls = [];
  const { options, configHome } = publication({ run: tailscale({ calls }) });
  const session = await startRelay(options);

  assert.equal(session.url, `https://mac.tail1234.ts.net:1300/go?g=${GENERATION}`);
  const published = calls.find(call => call.includes('--bg'));
  assert.match(published, /^tailscale serve --bg --https=1300 http:\/\/127\.0\.0\.1:\d+$/);

  const stored = readRelayReceipt({ home: configHome, env: {} });
  assert.equal(stored.generation, GENERATION);
  assert.equal(stored.worktree, options.context.root);
  assert.equal(stored.path, '/home/gapila-pro');
  assert.match(stored.serveTarget, /^http:\/\/127\.0\.0\.1:\d+$/);

  await session.stop();
});

test('the owner withdraws its mapping strictly before it releases the listener', async () => {
  const calls = [];
  const { options } = publication({ run: tailscale({ calls }) });
  const session = await startRelay(options);
  const target = new URL(readRelayReceipt({ home: options.home, env: {} }).serveTarget);

  let closedAt = -1;
  const order = [];
  const onClose = () => {
    closedAt = order.length;
    order.push('listener-closed');
  };
  await session.stop({ onListenerClose: onClose });

  const withdrawnAt = calls.findIndex(call => call === 'tailscale serve --https=1300 off');
  assert.notEqual(withdrawnAt, -1, 'the owner withdraws its own mapping on ordinary exit');
  assert.equal(closedAt, 0, 'withdrawal happens first; the listener is released after');
  assert.equal(readRelayReceipt({ home: options.home, env: {} }), null);

  await assert.rejects(fetch(`http://127.0.0.1:${target.port}/go`), 'the listener is really gone');
});

test('a crashed generation\'s mapping is withdrawn before anything else binds', async () => {
  const calls = [];
  const configHome = home();
  publishRelayReceipt(record(worktree(), { generation: OTHER_GENERATION, pid: 999_999 }), { home: configHome, env: {} });
  const { options } = publication({ configHome, run: tailscale({ calls, mappings: { Web: { 'mac.tail1234.ts.net:1300': { Handlers: { '/': { Proxy: 'http://127.0.0.1:40000' } } } } } }) });
  const session = await startRelay(options);

  const withdrawn = calls.findIndex(call => call === 'tailscale serve --https=1300 off');
  const published = calls.findIndex(call => call.includes('--bg'));
  assert.notEqual(withdrawn, -1);
  assert.ok(withdrawn < published, 'the dead mapping goes before the new one is bound');
  await session.stop();
});

test('an unowned mapping refuses with the exact withdrawal command and publishes nothing', async () => {
  const calls = [];
  const { options } = publication({ run: tailscale({ calls, mappings: { Web: { 'mac.tail1234.ts.net:1300': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } }) });
  await assert.rejects(startRelay(options), error => {
    assert.match(error.fix, /tailscale serve --https=1300 off/);
    return true;
  });
  assert.equal(calls.some(call => call.includes('--bg')), false);
  assert.equal(readRelayReceipt({ home: options.home, env: {} }), null);
});

test('a Funnel-mapped port refuses: public exposure is never adopted as ours', async () => {
  const mappings = {
    Web: { 'mac.tail1234.ts.net:1300': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
    AllowFunnel: { 'mac.tail1234.ts.net:1300': true },
  };
  const { options } = publication({ run: tailscale({ mappings }) });
  await assert.rejects(startRelay(options), error => {
    assert.match(error.problem, /funnel/i);
    assert.match(error.fix, /tailscale serve --https=1300 off/);
    return true;
  });
});

test('the last publication wins and a superseded owner cannot withdraw the live mapping', async () => {
  const calls = [];
  const configHome = home();
  const first = publication({ configHome, run: tailscale({ calls }) });
  const firstSession = await startRelay(first.options);

  const second = publication({ configHome, generation: OTHER_GENERATION, run: tailscale({ calls }), alive: () => true, start: () => 'Mon Sep 13 10:00:00 2026' });
  const secondSession = await startRelay(second.options);
  assert.equal(readRelayReceipt({ home: configHome, env: {} }).generation, OTHER_GENERATION);

  const before = calls.length;
  await firstSession.stop();
  assert.equal(readRelayReceipt({ home: configHome, env: {} }).generation, OTHER_GENERATION, 'the old owner cleared nothing');
  assert.equal(calls.slice(before).some(call => call === 'tailscale serve --https=1300 off'), false, 'and withdrew nothing');

  await secondSession.stop();
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
});

// And the mapping rewire is observable from OUTSIDE: the superseded listener
// is still bound — `stop()` has not run on it — so the only thing that can
// stop it serving is its own reread of the machine receipt. This asks its real
// socket, before and after the rewire, rather than asserting the receipt file.
test('a superseded listener is still bound and still answers 404: the rewire really closes the old authority', async () => {
  const configHome = home();
  const first = publication({ configHome, run: tailscale({ calls: [] }) });
  const firstSession = await startRelay(first.options);
  const firstPort = Number(new URL(readRelayReceipt({ home: configHome, env: {} }).serveTarget).port);

  const live = await rawRequest(firstPort, { headers: allowed });
  assert.equal(live.status, 200, 'the sole owner serves its confirmation page');
  const nonce = nonceFrom(live.body);

  const second = publication({ configHome, generation: OTHER_GENERATION, run: tailscale({ calls: [] }), alive: () => true, start: () => 'Mon Sep 13 10:00:00 2026' });
  const secondSession = await startRelay(second.options);

  const stale = await rawRequest(firstPort, { headers: allowed });
  assert.equal(stale.status, 404, 'the superseded listener is reachable and refuses');
  const staleSubmission = await rawRequest(firstPort, { method: 'POST', headers: allowed, body: `nonce=${nonce}` });
  assert.equal(staleSubmission.status, 404, 'and the nonce it minted as owner mints nothing now');

  await firstSession.stop();
  await secondSession.stop();
});

// ---------------------------------------------------------------------------
// The lifecycle `src/debug-as/index.mjs` calls: explicit refuses, automatic
// reports, and a failure rolls back only what this generation owns.
// ---------------------------------------------------------------------------

const contract = () => ({
  browser: { playwrightDir: 'apps/e2e', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 120, prepare: { command: ['node', 'a.mjs'], timeoutSeconds: 300 } },
  phone: {
    optInEnv: 'AX_DEBUG_AS_PHONE',
    provider: {
      type: 'supabase',
      urlEnv: 'NEXT_PUBLIC_SUPABASE_URL',
      serviceRoleKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY',
      confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' },
    },
  },
  identities: {},
});

const handoffOptions = (overrides = {}) => {
  const root = overrides.root ?? worktree();
  const configHome = overrides.configHome ?? home();
  writeMachineContract(configHome);
  return {
    root,
    configHome,
    options: {
      context: {
        root,
        name: 'gapila-pro',
        config: { project: { name: 'gapila' }, apps: { web: 'apps/web' } },
        contract: contract(),
        origin: 'http://localhost:3010',
        tailnetOrigin: 'https://gapila-pro.tail1234.ts.net',
        path: '/home/gapila-pro',
        env: {},
      },
      identity: { name: 'pro', defaultPath: '/home/gapila-pro', authenticated: true, storageState: 'apps/e2e/.auth/pro.json', phone: true, email: 'pro@makerkit.dev' },
      path: '/home/gapila-pro',
      generation: GENERATION,
      deps: {
        home: configHome,
        env: {},
        host: 'mac',
        pid: process.pid,
        processStart: 'Mon Sep 13 10:00:00 2026',
        alive: () => false,
        start: () => null,
        readReceipt: () => liveReceipt(root),
        readVariable: name => ({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.k.s' })[name],
        run: tailscale(),
        runAdapter: async () => ({}),
        ...(overrides.deps ?? {}),
      },
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['root', 'configHome', 'deps'].includes(key))),
    },
  };
};

test('a published handoff answers the generation-addressed URL and notifies once', async () => {
  resetNotifications();
  const notifications = [];
  const { options } = handoffOptions({ deps: { runAdapter: async request => { notifications.push(request); return {}; } } });
  const answer = await phoneHandoff(options);

  assert.equal(answer.published, true);
  assert.equal(answer.url, `https://mac.tail1234.ts.net:1300/go?g=${GENERATION}`);
  assert.equal(answer.finding, null);
  assert.equal(answer.notified, true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].request.url, answer.url);
  await answer.session.stop();
});

test('a failed notification leaves the publication usable and is reported, not fatal', async () => {
  resetNotifications();
  const { options } = handoffOptions({
    explicit: true,
    deps: {
      runAdapter: async () => {
        throw Object.assign(new Error('notifier exited 1'), { fix: 'check it' });
      },
    },
  });
  const answer = await phoneHandoff(options);
  assert.equal(answer.published, true, 'even an explicit handoff survives a notifier that is only a convenience');
  assert.equal(answer.notified, false);
  assert.ok(answer.finding.fix);
  assert.ok(answer.url);
  await answer.session.stop();
});

test('an explicit handoff throws on failure, and rolls back the state this generation owns', async () => {
  resetNotifications();
  const calls = [];
  const { options, configHome } = handoffOptions({
    explicit: true,
    deps: {
      run: tailscale({ calls, mappings: { Web: { 'mac.tail1234.ts.net:1300': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } }),
    },
  });
  await assert.rejects(phoneHandoff(options), error => {
    assert.match(error.fix, /tailscale serve --https=1300 off/);
    return true;
  });
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null, 'a refused publication leaves no ownership behind');
  assert.equal(calls.some(call => call.includes('--bg')), false);
});

test('an automatic handoff never throws: a failure is a finding, and nothing of it survives', async () => {
  resetNotifications();
  const { options, configHome } = handoffOptions({
    explicit: false,
    deps: { run: tailscale({ mappings: { Web: { 'mac.tail1234.ts.net:1300': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } }) },
  });
  const answer = await phoneHandoff(options);
  assert.equal(answer.published, false);
  assert.equal(answer.session, null);
  assert.ok(answer.finding.fix);
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
});

test('an absent machine contract refuses an explicit handoff and only reports an automatic one', async () => {
  resetNotifications();
  const explicit = handoffOptions({ explicit: true, configHome: home() });
  rmSync(machineContractPath(explicit.configHome));
  await assert.rejects(phoneHandoff(explicit.options), error => {
    assert.match(error.fix, /debug-as\.json/);
    return true;
  });

  const automatic = handoffOptions({ explicit: false, configHome: home() });
  rmSync(machineContractPath(automatic.configHome));
  const answer = await phoneHandoff(automatic.options);
  assert.equal(answer.published, false);
  assert.match(answer.finding.fix, /debug-as\.json/);
});

test('a handoff without a recorded Tailscale origin refuses: the phone callback has nowhere to land', async () => {
  resetNotifications();
  const { options } = handoffOptions({ explicit: true });
  await assert.rejects(phoneHandoff({ ...options, context: { ...options.context, tailnetOrigin: null } }), error => {
    assert.ok(error.fix);
    return true;
  });
});

test('an unsafe destination path refuses before any mapping is published', async () => {
  resetNotifications();
  const calls = [];
  const { options } = handoffOptions({ explicit: true, path: '//evil.example.com', deps: { run: tailscale({ calls }) } });
  await assert.rejects(phoneHandoff(options), error => {
    assert.ok(error.fix);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('a withdrawal that fails keeps the listener bound, keeps the mapping, and stop stays retryable', async () => {
  // Releasing the listener while Serve still points at it would hand the
  // tailnet to whatever binds that ephemeral port next. So a failed withdrawal
  // is not a cleanup detail: the command does not complete normally, the port
  // stays held, and the owner can try again.
  const calls = [];
  let refusing = true;
  const serve = statefulTailscale(calls);
  const run = (bin, args) => {
    if (args[2] === 'off' && refusing) {
      calls.push([bin, ...args].join(' '));
      return { status: 1, stdout: '', stderr: 'serve: could not withdraw' };
    }
    return serve(bin, args);
  };
  const { options, configHome } = publication({ run });
  const session = await startRelay(options);
  const target = new URL(readRelayReceipt({ home: configHome, env: {} }).serveTarget);

  await assert.rejects(session.stop(), error => {
    assert.match(error.fix, /tailscale serve --https=1300 off/);
    return true;
  });
  assert.ok(readRelayReceipt({ home: configHome, env: {} }), 'the owner keeps a mapping it could not withdraw');
  const stillBound = await fetch(`http://127.0.0.1:${target.port}/go`);
  assert.equal(stillBound.status, 404, 'the listener still holds the port, so nothing else can take it');

  refusing = false;
  await session.stop();
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null, 'the retry withdraws and clears');
  await assert.rejects(fetch(`http://127.0.0.1:${target.port}/go`), 'and only then is the listener released');
});

test('a same-generation reuse publishes a new owner, and the superseded one withdraws nothing', async () => {
  // The browser generation is NOT the publication identity: a reuse launch
  // keeps the generation and binds a new listener from another process. If
  // teardown matched on the generation alone, the old owner's exit would
  // withdraw the live mapping and point the tailnet at a freed port.
  const calls = [];
  const configHome = home();
  const root = worktree();
  // ONE Serve state for both publications: the second must see, and replace,
  // the mapping the first made.
  const serve = statefulTailscale(calls);
  const first = publication({ configHome, root, run: serve });
  const firstSession = await startRelay(first.options);

  const second = publication({
    configHome,
    root,
    run: serve,
    pid: process.pid + 1,
    processStart: 'Tue Sep 14 09:00:00 2026',
    alive: () => true,
    start: () => 'Mon Sep 13 10:00:00 2026',
  });
  const secondSession = await startRelay(second.options);

  const held = readRelayReceipt({ home: configHome, env: {} });
  assert.equal(held.serveTarget, secondSession.target);
  assert.equal(held.pid, process.pid + 1);

  const before = calls.length;
  await firstSession.stop();
  assert.equal(readRelayReceipt({ home: configHome, env: {} })?.serveTarget, secondSession.target, 'the superseded owner cleared nothing');
  assert.equal(calls.slice(before).some(call => call === 'tailscale serve --https=1300 off'), false, 'and withdrew nothing');

  await secondSession.stop();
  assert.equal(readRelayReceipt({ home: configHome, env: {} }), null);
});

test('a later invocation retries the notification against the live publication and rewires nothing', async () => {
  resetNotifications();
  const calls = [];
  let failing = true;
  const { options } = handoffOptions({
    deps: {
      alive: () => true,
      start: () => 'Mon Sep 13 10:00:00 2026',
      run: statefulTailscale(calls),
      runAdapter: async () => {
        if (failing) throw Object.assign(new Error('notifier exited 1'), { fix: 'check it' });
        return {};
      },
    },
  });

  const first = await phoneHandoff(options);
  assert.equal(first.published, true);
  assert.equal(first.notified, false);
  const published = calls.filter(call => call.includes('--bg')).length;
  assert.equal(published, 1);

  const heldBefore = readRelayReceipt({ home: options.deps.home, env: {} });
  const withdrawalsBefore = calls.filter(call => call.includes(' off')).length;

  failing = false;
  const retry = await phoneHandoff(options);
  assert.equal(retry.published, true);
  assert.equal(retry.notified, true, 'the retry delivers against the live browser and relay');
  assert.equal(retry.url, first.url, 'and the URL AX already printed still works');
  assert.equal(retry.session, null, 'a retry owns no publication, so it can withdraw nothing');
  assert.equal(calls.filter(call => call.includes('--bg')).length, published, 'no Serve mapping is rewired');
  assert.equal(calls.filter(call => call.includes(' off')).length, withdrawalsBefore, 'and nothing is withdrawn');
  assert.deepEqual(readRelayReceipt({ home: options.deps.home, env: {} }), heldBefore, 'the first owner still owns the publication, byte for byte');

  await first.session.stop();
  assert.equal(readRelayReceipt({ home: options.deps.home, env: {} }), null);
});

test('the published relay serves this generation only, and its provider is the project\'s own', async () => {
  resetNotifications();
  const { options } = handoffOptions();
  const answer = await phoneHandoff(options);
  const target = new URL(readRelayReceipt({ home: options.deps.home, env: {} }).serveTarget);

  const page = await rawRequest(Number(target.port), { headers: allowed });
  assert.equal(page.status, 200);
  assert.match(page.body, /name="nonce"/);

  const superseded = await rawRequest(Number(target.port), { headers: allowed, path: `/go?g=${OTHER_GENERATION}` });
  assert.match(superseded.body, /superseded/i);

  await answer.session.stop();
});
