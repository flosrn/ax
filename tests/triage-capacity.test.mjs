// The pass plan and its anti-rival gates, exercised through their own
// interface, with a real temp store. The deep gate paths (GATE 1 unsettled
// record, GATE 2 live pane) keep their coverage in triage-dispatch.test.mjs
// through the whole verb.
//
// The CAPS and the two live-pane counts are not here: they gate `ax worker
// dispatch` too, so they live in `src/worker/capacity.mjs` and are pinned in
// worker-capacity.test.mjs.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { passPlan } from '../src/triage/capacity.mjs';
import { dispatchIndex } from '../src/worker/record.mjs';

const inventoryOf = entries => ({ ok: true, byHandle: new Map(entries), omitted: false });

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
