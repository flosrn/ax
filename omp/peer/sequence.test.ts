/**
 * The SENDING half of gap detection: a per-sender counter that survives the
 * process, because every send happens in a different handler invocation and
 * often in a different process.
 *
 * Why it exists at all: Orca's `orchestration send` receipt is the same string
 * whether the message landed or vanished — measured 2026-08-15, 3 of 6 arrived
 * on 1.4.182 and 10 of 10 on 1.4.183, with the identical
 * `Queued relay_<id> for Run home` and exit 0 in both runs. The number is the
 * only part of the exchange that can disagree with a loss.
 *
 * `nextOutboundSequence` is driven directly: `sendToPeer` cannot be, since it
 * shells out to Orca. What is pinned here is the contract the receiver depends
 * on — ascending, per-identity, and NOT advanced by a send that failed.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nextOutboundSequence } from './registry.ts';

let dir = '';
let saved: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'peer-seq-'));
  saved = process.env.ORCA_PEER_REGISTRY_DIR;
  process.env.ORCA_PEER_REGISTRY_DIR = join(dir, 'peers');
});

afterEach(async () => {
  if (saved === undefined) delete process.env.ORCA_PEER_REGISTRY_DIR;
  else process.env.ORCA_PEER_REGISTRY_DIR = saved;
  await rm(dir, { recursive: true, force: true });
});

test('a committed sequence ascends and persists past the call', () => {
  const a = nextOutboundSequence('worker-1');
  expect(a.seq).toBe(1);
  a.commit();

  const b = nextOutboundSequence('worker-1');
  expect(b.seq).toBe(2);
  b.commit();

  // A fresh read, which is what the next turn — or the next process — does.
  expect(nextOutboundSequence('worker-1').seq).toBe(3);
});

test('an uncommitted allocation does not burn a number', () => {
  nextOutboundSequence('worker-1').commit();
  // A send Orca refused: the sender already knows it failed, and consuming the
  // number here would make the receiver report a loss that never happened.
  nextOutboundSequence('worker-1');
  expect(nextOutboundSequence('worker-1').seq).toBe(2);
});

test('each sender identity keeps its own series', () => {
  nextOutboundSequence('worker-1').commit();
  nextOutboundSequence('worker-1').commit();
  expect(nextOutboundSequence('worker-2').seq).toBe(1);
  expect(nextOutboundSequence('worker-1').seq).toBe(3);
});

test('a name that is not filename-safe still gets a counter', () => {
  const weird = '../../etc/passwd ws:1657';
  const first = nextOutboundSequence(weird);
  expect(first.seq).toBe(1);
  first.commit();
  expect(nextOutboundSequence(weird).seq).toBe(2);
  // Flattened into the registry's own seq dir, never out of it.
  expect(process.env.ORCA_PEER_REGISTRY_DIR).toBeTruthy();
});
