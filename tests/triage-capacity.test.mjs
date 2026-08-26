// The capacity rules — the live-pane count and the pass plan with its
// anti-rival gates — exercised through their own interface, with a real temp
// store. The deep gate paths (GATE 1 unsettled record, GATE 2 live pane) keep
// their coverage in triage-dispatch.test.mjs through the whole verb.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { capOf, liveCount, passPlan } from '../src/triage/capacity.mjs';
import { dispatchIndex } from '../src/worker/record.mjs';

const inventoryOf = entries => ({ ok: true, byHandle: new Map(entries), omitted: false });

test('liveCount counts only recorded handles whose pane is alive and owned', () => {
  const index = {
    byDispatch: new Map([
      ['d1', { handle: 'term_a' }],
      ['d2', { handle: 'term_b' }],
      ['d3', { handle: null }],
      ['d4', { handle: 'term_gone' }],
    ]),
  };
  const inventory = inventoryOf([
    ['term_a', { orphaned: false }],
    ['term_b', { orphaned: true }],
    ['term_editor', { orphaned: false }],
  ]);
  // term_b is orphaned, term_gone has no pane, term_editor has no record:
  // none of them is triage capacity.
  assert.equal(liveCount({ index, inventory }), 1);
});

test('a plain dispatch targets the current pass and replays what is there (F-001)', () => {
  const store = mkdtempSync(join(tmpdir(), 'ax-capacity-'));
  const root = mkdtempSync(join(tmpdir(), 'ax-capacity-root-'));
  const out = passPlan({
    store,
    root,
    index: dispatchIndex(store),
    inventory: inventoryOf([]),
    issues: ['5'],
    job: 'triage',
    slug: 'gapilabs/gapila',
    freshPass: false,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.plan, [{ issue: '5', pass: 1, previous: null }]);
});

test('--fresh with no recorded pass is a refusal: there is nothing to redo', () => {
  const store = mkdtempSync(join(tmpdir(), 'ax-capacity-'));
  const root = mkdtempSync(join(tmpdir(), 'ax-capacity-root-'));
  const out = passPlan({
    store,
    root,
    index: dispatchIndex(store),
    inventory: inventoryOf([]),
    issues: ['5'],
    job: 'triage',
    slug: 'gapilabs/gapila',
    freshPass: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'refuse');
  assert.match(out.message, /has no recorded pass/);
  assert.match(out.repair, /a first pass is an ordinary dispatch/);
});

test('capOf refuses an unreadable cap instead of letting NaN erase the fence', () => {
  assert.deepEqual(capOf({}), { ok: true, cap: 3 });
  assert.deepEqual(capOf({ ORCA_TRIAGE_SESSION_CAP: '0' }), { ok: true, cap: 0 });
  assert.equal(capOf({ ORCA_TRIAGE_SESSION_CAP: 'many' }).ok, false);
  assert.equal(capOf({ ORCA_TRIAGE_SESSION_CAP: '-1' }).ok, false);
});
