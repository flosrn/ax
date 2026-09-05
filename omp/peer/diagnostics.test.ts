/**
 * THE STORE IS READ BY A PROCESS THAT DID NOT WRITE IT, which is the only
 * reason it exists. Every test here writes through the recorder and reads back
 * through the reader with nothing carried between them but the file — no
 * module state, no set left over from the loop that observed the outcome.
 *
 * The two things a reader must never be told are pinned here too: a filter is
 * not an injection failure, and delivery work another observation resolved is
 * not still pending.
 *
 * No Orca, no clock, no registry: the directory is an env override and the
 * timestamps are handed in.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DELIVERY_RECORD_CAP,
  type DeliveryDiagnostic,
  diagnosticsPath,
  readDelivery,
  recordDelivery,
  renderDelivery,
} from './diagnostics.ts';

const HANDLE = 'term_diagnostics-test';
let dir = '';
let saved: string | undefined;
let savedHandle: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-diagnostics-'));
  saved = process.env.ORCA_PEER_REGISTRY_DIR;
  savedHandle = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_PEER_REGISTRY_DIR = dir;
  process.env.ORCA_TERMINAL_HANDLE = HANDLE;
});

afterEach(() => {
  if (saved === undefined) delete process.env.ORCA_PEER_REGISTRY_DIR;
  else process.env.ORCA_PEER_REGISTRY_DIR = saved;
  if (savedHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
  else process.env.ORCA_TERMINAL_HANDLE = savedHandle;
  rmSync(dir, { recursive: true, force: true });
});

/** One observation, at a stated time so nothing here reads a clock. */
function put(d: DeliveryDiagnostic, at = '2026-09-06T00:00:00.000Z'): void {
  recordDelivery({ ...d, at });
}

test('the six reasons survive the process that observed them, each with its identities', () => {
  put({ reason: 'sequence-gap', peer: 'alpha', expected: 4, sequence: 6, lost: 2 });
  put({ reason: 'filtered', peer: 'alpha', filter: 'heartbeat', messageId: 'msg_1' });
  put({
    reason: 'injection-refused',
    peer: 'beta',
    messageId: 'msg_2',
    deliveryId: 'del_1',
    detail: 'inject failed: TypeError',
  });
  put({ reason: 'no-reply-route', peer: 'beta', messageId: 'msg_3', detail: 'it stated none' });
  put({
    reason: 'report-unreadable',
    peer: 'child',
    messageId: 'msg_4',
    disposition: 'absent',
    request: '194-delivery-diagnostics',
    path: '/w/.scratch/report/194.md',
  });
  put({ reason: 'ack-pending', deliveryId: 'del_2', detail: 'an injection failed' });

  // The reader is the fresh session: it holds nothing but the path.
  const read = readDelivery();
  expect(read.recorded).toBe(true);
  expect(read.records.map((r) => r.reason)).toEqual([
    'sequence-gap',
    'filtered',
    'injection-refused',
    'no-reply-route',
    'report-unreadable',
    'ack-pending',
  ]);

  const gap = read.records[0];
  expect(gap.peer).toBe('alpha');
  expect(gap.lost).toBe(2);
  expect(gap.expected).toBe(4);
  expect(gap.sequence).toBe(6);

  const report = read.records[4];
  expect(report.disposition).toBe('absent');
  expect(report.request).toBe('194-delivery-diagnostics');
  expect(report.path).toBe('/w/.scratch/report/194.md');
  expect(read.path).toBe(diagnosticsPath(HANDLE));
});

test('an observed filter reads as a filter, never as an injection failure', () => {
  put({ reason: 'filtered', peer: 'alpha', filter: 'self-echo', messageId: 'msg_1' });

  const read = readDelivery();
  expect(read.records).toHaveLength(1);
  expect(read.records[0].reason).toBe('filtered');
  expect(read.records[0].filter).toBe('self-echo');

  const text = renderDelivery(read);
  // The two words the incident conflated. `withheld` is the filter's own
  // section; nothing on this page may call it a refused injection.
  expect(text).toContain('self-echo');
  expect(text).not.toContain('injection-refused');
});

test('an ack that landed resolves the waiting record it landed on, and only that delivery', () => {
  put({ reason: 'ack-pending', deliveryId: 'del_1', detail: 'an injection failed' }, '2026-09-06T00:00:01.000Z');
  put({ reason: 'ack-pending', deliveryId: 'del_2', detail: 'ack failed' }, '2026-09-06T00:00:02.000Z');
  put({ reason: 'ack-settled', deliveryId: 'del_1' }, '2026-09-06T00:00:03.000Z');

  const read = readDelivery();
  const pending = read.records.filter((r) => r.reason === 'ack-pending');
  expect(pending.map((r) => [r.deliveryId, r.resolvedAt ?? null])).toEqual([
    ['del_1', '2026-09-06T00:00:03.000Z'],
    ['del_2', null],
  ]);

  const text = renderDelivery(read);
  // del_2 is the only one still waiting; presenting del_1 as pending is the
  // false claim this fold exists to prevent.
  expect(text).toContain('del_2');
  expect(text).toMatch(/WAITING[\s\S]*del_2/);
  expect(text).not.toMatch(/WAITING[\s\S]*del_1/);
});

test('a fresh reader reports no unresolved work after the only wait is settled', () => {
  put({ reason: 'ack-pending', deliveryId: 'del_1', detail: 'an injection failed' }, '2026-09-06T00:00:01.000Z');
  put({ reason: 'ack-settled', deliveryId: 'del_1' }, '2026-09-06T00:00:03.000Z');

  const text = renderDelivery(readDelivery());
  expect(text).toContain('0 still open');
  expect(text).not.toContain('WAITING');
  expect(text).not.toContain('REFUSED INJECTION');
});

test('an ack proves every injection in its delivery landed, so a refusal it covers is resolved', () => {
  put(
    { reason: 'injection-refused', peer: 'beta', messageId: 'msg_2', deliveryId: 'del_1', detail: 'inject failed' },
    '2026-09-06T00:00:01.000Z',
  );
  put({ reason: 'ack-settled', deliveryId: 'del_1' }, '2026-09-06T00:00:04.000Z');

  const read = readDelivery();
  const refused = read.records.find((r) => r.reason === 'injection-refused');
  expect(refused?.resolvedAt).toBe('2026-09-06T00:00:04.000Z');
  expect(renderDelivery(read)).not.toMatch(/REFUSED INJECTION[\s\S]*msg_2/);
});

test('a lost message is never resolved by a later ack — the content is gone whatever follows', () => {
  put({ reason: 'sequence-gap', peer: 'alpha', expected: 4, sequence: 6, lost: 2, deliveryId: 'del_1' });
  put({ reason: 'ack-settled', deliveryId: 'del_1' }, '2026-09-06T00:00:05.000Z');

  const read = readDelivery();
  expect(read.records[0].resolvedAt).toBeUndefined();
  expect(renderDelivery(read)).toContain('2 message(s)');
});

test('one unreadable line costs exactly one record, not the whole store', () => {
  put({ reason: 'filtered', peer: 'alpha', filter: 'group' });
  writeFileSync(diagnosticsPath(HANDLE), '{"reason":"ack-pending"\n', { flag: 'a' });
  put({ reason: 'no-reply-route', peer: 'beta', messageId: 'msg_9' });

  const read = readDelivery();
  expect(read.records.map((r) => r.reason)).toEqual(['filtered', 'no-reply-route']);
  expect(read.unreadable).toBe(1);
  expect(renderDelivery(read)).toContain('1 unreadable');
});

test('nothing recorded is not proof nothing happened, and an unreadable store is not an empty one', () => {
  const fresh = readDelivery();
  expect(fresh.recorded).toBe(false);
  expect(fresh.records).toEqual([]);
  expect(renderDelivery(fresh)).toContain('no delivery diagnostic has been recorded');

  // A directory where the file should be: readable is exactly what this cannot
  // establish, and an inability must not read as "nothing went wrong".
  rmSync(diagnosticsPath(HANDLE), { force: true });
  process.env.ORCA_PEER_REGISTRY_DIR = join(dir, 'nested');
  recordDelivery({ reason: 'filtered', filter: 'group' });
  expect(readDelivery().recorded).toBe(true);
});

test('the store is bounded, and the bound keeps the newest observations', () => {
  for (let i = 1; i <= DELIVERY_RECORD_CAP * 2 + 5; i += 1) {
    put({ reason: 'filtered', peer: `p${i}`, filter: 'heartbeat' });
  }
  const read = readDelivery();
  expect(read.records.length).toBeLessThanOrEqual(DELIVERY_RECORD_CAP);
  expect(read.records.at(-1)?.peer).toBe(`p${DELIVERY_RECORD_CAP * 2 + 5}`);
  expect(readFileSync(diagnosticsPath(HANDLE), 'utf8').split('\n').filter(Boolean).length).toBeLessThanOrEqual(
    DELIVERY_RECORD_CAP,
  );
});

test('a child-authored detail is redacted before it reaches the disk', () => {
  put({
    reason: 'injection-refused',
    peer: 'child',
    messageId: 'msg_1',
    detail: 'inject failed with dcap_d-ah07SKJdYVt9eVmYVPXe5ZH_Lsr5zYDCixSeq7ubE in the argv',
  });
  const raw = readFileSync(diagnosticsPath(HANDLE), 'utf8');
  expect(raw).not.toContain('dcap_d-ah07SKJdYVt9eVmYVPXe5ZH_Lsr5zYDCixSeq7ubE');
  expect(readDelivery().records[0].detail).toContain('inject failed');
});

test('the readout states what it does not cover, and claims no delivery rate', () => {
  put({ reason: 'sequence-gap', peer: 'alpha', expected: 4, sequence: 6, lost: 2 });
  const text = renderDelivery(readDelivery());
  // The uncovered majority: a hand-rolled `orca orchestration send` carries no
  // sequence, so its losses are not in here and must not read as absent.
  expect(text).toContain('COVERAGE');
  expect(text).toContain('orca orchestration send');
  expect(text).not.toMatch(/\d+%/);
  // Every reason a reader can act on names its repair.
  expect(text.toLowerCase()).toContain('repair');
});

test('a reason the vocabulary does not name is refused rather than persisted as an unknown shape', () => {
  // @ts-expect-error — the point of the closed vocabulary is that this cannot
  // reach the store, where a reader would have to guess what it means.
  const ok = recordDelivery({ reason: 'something-new', peer: 'alpha' });
  expect(ok).toBe(false);
  expect(readDelivery().records).toEqual([]);
});
