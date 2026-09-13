// What an agent is allowed to know about the current worktree's Role browser.
//
// `status` answers a question, it does not mutate: an absent, stale or CDP-dead
// receipt is a Verdict, not a refusal. The only refusal is a malformed request
// (no worktree to ask about). Every other state lands as one JSON object on
// stdout, with no authentication material and with the Phone relay reported only
// when its generation and worktree both match this one.
//
// The receipt, the CDP probe and the relay reader are injected: the cases that
// decide the Verdict — a live owner whose CDP is dead, a superseded relay, an
// owner on another host — cannot be staged with a real Chromium and would be
// untestable at the moment they matter.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { publishReceipt } from '../src/debug-as/receipt.mjs';
import { status, statusPayload } from '../src/debug-as/status.mjs';

const fixtures = [];
after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function worktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-debug-status-')));
  fixtures.push(root);
  mkdirSync(join(root, '.agent'), { recursive: true });
  return root;
}

const HOST = 'mac.local';
const START = 'Fri Sep 12 09:00:00 2026';
const GENERATION = 'a'.repeat(32);

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
  generation: GENERATION,
  project: 'ofmchat',
  worktree: root,
  identity: 'owner',
  origin: 'http://localhost:3210',
  path: '/home',
  device: null,
  viewport: { width: 1280, height: 800 },
  cdpPort: 51234,
  sessionName: 'ax-debug-owner',
  chromiumPid: 9001,
  ...overrides,
});

const capture = async fn => {
  const written = { out: '', err: '' };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => ((written.out += String(chunk)), true);
  process.stderr.write = chunk => ((written.err += String(chunk)), true);
  try {
    return { code: await fn(), ...written };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

const payloadOf = captured => JSON.parse(captured.out.trim());

const emitStub = () => {
  const calls = { raw: [], refuse: [] };
  return {
    calls,
    emit: {
      raw: text => calls.raw.push(text),
      refuse: (message, command) => calls.refuse.push({ message, command }),
    },
  };
};

const matchingRelay = root => ({
  version: 1,
  generation: GENERATION,
  worktree: root,
  serveHost: 'mac.tailnet.ts.net',
  port: 1300,
});

test('a live same-generation owner with a live CDP is VIVANT, and the payload names only what an agent may know', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());

  const { payload, verdict } = await statusPayload(
    { root },
    {
      ...receiptDeps(),
      probe: async () => ({ alive: true }),
      readRelay: () => matchingRelay(root),
      relayOwnedBy: (record, { root: at, generation }) => record.worktree === at && record.generation === generation,
      relayUrl: record => `https://${record.serveHost}:${record.port}/go?g=${record.generation}`,
    },
  );

  assert.equal(verdict, 'VIVANT');
  assert.equal(payload.verdict, 'VIVANT');
  assert.equal(payload.identity, 'owner');
  assert.equal(payload.origin, 'http://localhost:3210');
  assert.equal(payload.path, '/home');
  assert.equal(payload.generation, GENERATION);
  assert.equal(payload.cdpPort, 51234);
  assert.equal(payload.device, null);
  assert.deepEqual(payload.viewport, { width: 1280, height: 800 });
  assert.equal(payload.relay, true);
  assert.equal(payload.relayUrl, `https://mac.tailnet.ts.net:1300/go?g=${GENERATION}`);
  assert.ok(!('pid' in payload));
  assert.ok(!('processStart' in payload));
  assert.ok(!('chromiumPid' in payload));
  assert.ok(!('host' in payload));
  assert.ok(!/token|secret|cookie|storageState/i.test(JSON.stringify(payload)));
});

test('an absent or proven-stale receipt is MORT, not a refusal', async () => {
  const absent = worktree();
  const missing = await statusPayload({ root: absent }, { ...receiptDeps(), probe: async () => ({ alive: false }), readRelay: () => null });
  assert.equal(missing.verdict, 'MORT');
  assert.equal(missing.payload.verdict, 'MORT');
  assert.equal(missing.payload.relay, false);
  assert.equal(missing.payload.relayUrl, null);

  const stale = worktree();
  publishReceipt({ root: stale, fields: fields(stale) }, receiptDeps({ pid: 111 }));
  const dead = await statusPayload({ root: stale }, { ...receiptDeps({ alive: () => false }), probe: async () => ({ alive: false }), readRelay: () => null });
  assert.equal(dead.verdict, 'MORT');
});

test('a live owner whose CDP endpoint is dead is MORT — the window is not co-drivable', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { verdict } = await statusPayload({ root }, { ...receiptDeps(), probe: async () => ({ alive: false, why: 'ECONNREFUSED' }), readRelay: () => null });
  assert.equal(verdict, 'MORT');
});

test('an ambiguous or unverifiable owner is INCONNU', async () => {
  const foreign = worktree();
  publishReceipt({ root: foreign, fields: fields(foreign) }, receiptDeps({ host: 'other-host' }));
  const { verdict } = await statusPayload({ root: foreign }, { ...receiptDeps(), probe: async () => ({ alive: true }), readRelay: () => null });
  assert.equal(verdict, 'INCONNU');

  const unreadable = worktree();
  publishReceipt({ root: unreadable, fields: fields(unreadable) }, receiptDeps());
  const again = await statusPayload({ root: unreadable }, { ...receiptDeps({ start: () => null }), probe: async () => ({ alive: true }), readRelay: () => null });
  assert.equal(again.verdict, 'INCONNU');
});

test('relay presence is false for a superseded or other-worktree publication, and true with its URL for this one', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const live = { ...receiptDeps(), probe: async () => ({ alive: true }) };

  const otherTree = await statusPayload(
    { root },
    {
      ...live,
      readRelay: () => ({ generation: GENERATION, worktree: '/somewhere-else', serveHost: 'mac.tailnet.ts.net', port: 1300 }),
      relayOwnedBy: () => false,
      relayUrl: () => 'https://mac.tailnet.ts.net:1300/go?g=nope',
    },
  );
  assert.equal(otherTree.payload.relay, false);
  assert.equal(otherTree.payload.relayUrl, null);

  const superseded = await statusPayload(
    { root },
    {
      ...live,
      readRelay: () => ({ generation: 'b'.repeat(32), worktree: root, serveHost: 'mac.tailnet.ts.net', port: 1300 }),
      relayOwnedBy: (record, { generation }) => record.generation === generation,
      relayUrl: record => `https://${record.serveHost}:${record.port}/go?g=${record.generation}`,
    },
  );
  assert.equal(superseded.payload.relay, false);
  assert.equal(superseded.payload.relayUrl, null);
});

test('status writes one JSON line on stdout and only a missing worktree refuses', async () => {
  const root = worktree();
  publishReceipt({ root, fields: fields(root) }, receiptDeps());
  const { emit, calls } = emitStub();

  const code = await status(
    { root },
    {
      ...receiptDeps(),
      probe: async () => ({ alive: true }),
      readRelay: () => null,
      emit,
    },
  );
  assert.equal(code, 0);
  assert.equal(calls.raw.length, 1);
  const body = JSON.parse(calls.raw[0]);
  assert.equal(body.verdict, 'VIVANT');
  assert.equal(calls.refuse.length, 0);

  const captured = await capture(() =>
    status(
      { root },
      {
        ...receiptDeps(),
        probe: async () => ({ alive: true }),
        readRelay: () => null,
      },
    ),
  );
  assert.equal(captured.code, 0);
  assert.equal(payloadOf(captured).verdict, 'VIVANT');
  assert.equal(captured.err, '');

  const refused = await status({}, { emit });
  assert.notEqual(refused, 0);
  assert.equal(calls.refuse.length, 1);
  assert.ok(calls.refuse[0].command);
});
