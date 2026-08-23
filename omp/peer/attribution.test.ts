/**
 * WHO A MESSAGE IS FROM, and what that buys the sender.
 *
 * The case these exist for was measured on 2026-08-13: a worker dispatched onto
 * another execution host reported home, its report arrived with
 * `from_handle: "dispatch:ctx_…"` and `sender_pane_key: null`, and this session
 * announced it as "an UNIDENTIFIED local sender". Orca's own source says the
 * address was minted by the receiving runtime from its own dispatch row, so the
 * only thing missing was a reading of it on our side.
 *
 * The store is a temp fixture through `ORCA_DISPATCH_STORE_DIR`; nothing here
 * reads the live one. `resetDispatchNames()` runs between cases because the name
 * cache is process-lifetime by design.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchIStarted, resetDispatchNames, senderIdentity } from './attribution.ts';

let store = '';
let savedStore: string | undefined;

/** A pane lookup that would answer, so a wrong branch cannot pass by silence. */
const paneLookup = (handle: string) => ({ peer: `wt-${handle.slice(-4)}`, model: 'stub-model' });

/** The shape `ax worker start` writes ahead of the mutation it issues. */
function record(request: string, dispatchId: string): void {
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      host: 'test',
      attempts: [
        {
          n: 1,
          phases: [
            { name: 'task-create', receipt: { result: { task: { id: 'task_x' } } } },
            { name: 'worker-start', receipt: { result: { dispatchId, stage: 'input_accepted' } } },
          ],
        },
      ],
    }),
  );
}

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'dispatch-store-'));
  mkdirSync(store, { recursive: true });
  savedStore = process.env.ORCA_DISPATCH_STORE_DIR;
  process.env.ORCA_DISPATCH_STORE_DIR = store;
  resetDispatchNames();
});

afterEach(() => {
  if (savedStore === undefined) delete process.env.ORCA_DISPATCH_STORE_DIR;
  else process.env.ORCA_DISPATCH_STORE_DIR = savedStore;
  rmSync(store, { recursive: true, force: true });
  resetDispatchNames();
});

test('a worker we dispatched is NAMED from our own record, not called unidentified', () => {
  record('probe-marker-3', 'ctx_95b5a1acf8ac');
  const who = senderIdentity(
    { from_handle: 'dispatch:ctx_95b5a1acf8ac', sender_pane_key: null, type: 'worker_done' },
    paneLookup,
  );
  expect(who).toEqual({
    name: 'child:probe-marker-3',
    model: '',
    attributed: true,
    kind: 'dispatch',
  });
});

test('a dispatch id we never issued stays UNIDENTIFIED', () => {
  record('probe-marker-3', 'ctx_95b5a1acf8ac');
  const who = senderIdentity(
    { from_handle: 'dispatch:ctx_somebody_else', sender_pane_key: null },
    paneLookup,
  );
  expect(who.attributed).toBe(false);
  expect(who.kind).toBeUndefined();
  expect(who.name).toContain('unattributed');
});

test('an empty store names nobody rather than throwing into the session', () => {
  expect(dispatchIStarted('ctx_95b5a1acf8ac')).toBeNull();
  process.env.ORCA_DISPATCH_STORE_DIR = join(store, 'does-not-exist');
  resetDispatchNames();
  expect(dispatchIStarted('ctx_95b5a1acf8ac')).toBeNull();
});

test('a negative answer is never cached — a dispatch recorded later must be found', () => {
  expect(dispatchIStarted('ctx_late')).toBeNull();
  record('late-request', 'ctx_late');
  expect(dispatchIStarted('ctx_late')).toBe('late-request');
});

test('a half-written record does not hide the readable ones beside it', () => {
  writeFileSync(join(store, 'broken.json'), '{"request":"broken","attempts":[');
  record('good-request', 'ctx_good');
  expect(dispatchIStarted('ctx_good')).toBe('good-request');
});

test('a witnessed pane is still the pane path, and says so', () => {
  const who = senderIdentity(
    { from_handle: 'term_abcd1234', sender_pane_key: 'tab:leaf' },
    paneLookup,
  );
  expect(who).toEqual({ name: 'wt-1234', model: 'stub-model', attributed: true, kind: 'pane' });
});

test('a forged handle with no pane key is not rescued by the dispatch path', () => {
  // `--from <victim>` nulls the pane key. The dispatch branch must not become a
  // second door for a sender that merely claims a term_ handle.
  const who = senderIdentity(
    { from_handle: 'term_victim0000', sender_pane_key: null },
    paneLookup,
  );
  expect(who.attributed).toBe(false);
  expect(who.name).toBe('unattributed:term_victim000');
});
