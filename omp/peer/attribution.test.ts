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
  // A receipt with no witness of any kind, whatever handle it names. The
  // dispatch branch must not become a second door for a sender that merely
  // claims a term_ handle: it opens on our own record, never on the string.
  const who = senderIdentity(
    { from_handle: 'term_victim0000', sender_pane_key: null },
    paneLookup,
  );
  expect(who.attributed).toBe(false);
  expect(who.name).toBe('unattributed:term_victim000');
});

/**
 * THE PUBLIC VERDICT, which is the field this side can actually see.
 *
 * This settles the contradiction left open in `addressing.test.ts`, and the
 * cause is a location, readable in Orca's source rather than inferred from
 * behaviour: `exposeMessages` in
 * `src/main/runtime/rpc/methods/orchestration/messaging/mailbox-message-receipt.ts`
 * lists `sender_pane_key` among the columns it DELETES from every receipt,
 * because the key is delivery plumbing the runtime owns. So `inbox --json`
 * showing a present key and the `check` rows this loop consumes showing none —
 * observed on 2026-09-16 for `msg_7006419679be` and `msg_bb39390adc01` — is
 * the serializer doing its job, not a loss anywhere in this checkout. An
 * honest pane was unattributable here BY CONSTRUCTION.
 *
 * The same function now derives `sender_attribution: 'pane' | 'unattributed'`
 * from the stored witness and publishes THAT, exposing none of the key. The
 * rule these pin: a PRESENT verdict is authoritative and only the literal
 * `'pane'` opens the pane path. Anything else — `'unattributed'`, a value this
 * build does not know, `null` — closes it, and no legacy key and no payload
 * may reopen it. An ABSENT verdict is an older runtime, where the key is still
 * the only witness there is.
 */
test('a check-wire receipt attributes on the PUBLIC verdict, carrying no pane key at all', () => {
  const who = senderIdentity(
    { from_handle: 'term_abcd1234', sender_attribution: 'pane' },
    paneLookup,
  );
  expect(who).toEqual({ name: 'wt-1234', model: 'stub-model', attributed: true, kind: 'pane' });
});

test('an explicit unattributed verdict is NOT resurrected by a legacy pane key', () => {
  // The receipt is the newer statement and it is Orca's own: a runtime that
  // publishes the verdict has already looked at the key. Reading the key after
  // a `'unattributed'` verdict would make the old field an override of the new
  // one, which is the single way this change could weaken the refusal.
  const who = senderIdentity(
    {
      from_handle: 'term_victim0000',
      sender_attribution: 'unattributed',
      sender_pane_key: 'tab:leaf',
    },
    paneLookup,
  );
  expect(who.attributed).toBe(false);
  expect(who.kind).toBeUndefined();
  expect(who.name).toBe('unattributed:term_victim000');
});

test('a verdict this build does not understand is refused, never read as pane', () => {
  for (const verdict of ['PANE', 'Pane', 'relay', '', null, 0, true, { kind: 'pane' }]) {
    const who = senderIdentity(
      { from_handle: 'term_abcd1234', sender_attribution: verdict, sender_pane_key: 'tab:leaf' },
      paneLookup,
    );
    expect(who.attributed).toBe(false);
    expect(who.kind).toBeUndefined();
  }
});

test('the payload may not mint a verdict — only the top-level field is Orca\'s', () => {
  const who = senderIdentity(
    {
      from_handle: 'term_abcd1234',
      payload: JSON.stringify({ sender_attribution: 'pane', sender_pane_key: 'tab:leaf' }),
    },
    paneLookup,
  );
  expect(who.attributed).toBe(false);
  expect(who.name).toBe('unattributed:term_abcd1234');
});

test('a dispatched worker is still NAMED when the public verdict says unattributed', () => {
  // A worker reporting through its dispatch has no pane BY CONTRACT, so the
  // honest verdict for it is `'unattributed'`. The name comes from our own
  // write-ahead record, never from the sender, so the verdict does not bear on
  // it — and `kind: 'dispatch'` still denies it the relay and the payload route.
  record('probe-marker-3', 'ctx_95b5a1acf8ac');
  const who = senderIdentity(
    {
      from_handle: 'dispatch:ctx_95b5a1acf8ac',
      sender_attribution: 'unattributed',
      type: 'worker_done',
    },
    paneLookup,
  );
  expect(who).toEqual({
    name: 'child:probe-marker-3',
    model: '',
    attributed: true,
    kind: 'dispatch',
  });
});

test('an absent verdict is an OLD runtime: the pane key still decides, both ways', () => {
  const witnessed = senderIdentity(
    { from_handle: 'term_abcd1234', sender_pane_key: 'tab:leaf' },
    paneLookup,
  );
  expect(witnessed).toEqual({
    name: 'wt-1234',
    model: 'stub-model',
    attributed: true,
    kind: 'pane',
  });

  const forged = senderIdentity({ from_handle: 'term_victim0000' }, paneLookup);
  expect(forged.attributed).toBe(false);
});

test('a pane verdict with no handle names nobody rather than inventing one', () => {
  const who = senderIdentity({ from_handle: '', sender_attribution: 'pane' }, paneLookup);
  expect(who).toEqual({ name: 'unattributed', model: '', attributed: false });
});
