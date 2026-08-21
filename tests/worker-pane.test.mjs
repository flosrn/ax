// The shared pane reader — the receipt four verbs read and used to read three
// different ways. Each proposition here is one an incident proved (F-027):
// `--lines` annihilates a read (F-041), an absent cursor is not zero, and a
// refusal must be NAMED rather than returned as an empty terminal.
//
// Offline by construction: the runner is injected, so no runtime is touched.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { paneReadable, readPane, terminalCursor, terminalInventory } from '../src/worker/pane.mjs';

const HANDLE = 'term_a51ccbf8-23e1-4aa7-8735-9d0cbf09a521';

/** A runner that records every argv and answers one canned receipt text. */
function stub(receipt, status = 0) {
  const calls = [];
  const run = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args);
      return { status, stdout: receipt, stderr: '' };
    },
  });
  return { run, calls };
}

const alive = (extra = {}) =>
  JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, status: 'running', latestCursor: 30074, tail: ['a line'], ...extra } } });

test('the read never composes --lines, and --limit is passed only when asked for', () => {
  const bare = stub(alive());
  readPane(bare.run, HANDLE);
  assert.deepEqual(bare.calls, [['terminal', 'read', '--terminal', HANDLE, '--json']]);

  const cheap = stub(alive());
  readPane(cheap.run, HANDLE, { limit: 1, environment: 'gapicore' });
  assert.deepEqual(cheap.calls, [['terminal', 'read', '--terminal', HANDLE, '--environment', 'gapicore', '--limit', '1', '--json']]);

  // F-041: the flag that returns an EMPTY read rather than a shorter one.
  assert.ok(
    [...bare.calls, ...cheap.calls].every(argv => !argv.includes('--lines')),
    '--lines may never be composed here — it is what made a live pane, a dead one and a misread one all answer zero',
  );
});

test('a cursor of zero is a cursor; anything outside the measured domain is an absence', () => {
  // Measured 2026-08-22, Orca 1.4.185: the runtime answers a decimal STRING, in
  // both the full read and the `--limit 1` one. A rule that demanded a number
  // made every pane unreadable — the shape has to be read, not assumed.
  assert.equal(terminalCursor({ ok: true, result: { terminal: { latestCursor: '1325952' } } }), 1325952);
  assert.equal(terminalCursor({ ok: true, result: { terminal: { latestCursor: 0 } } }), 0);
  assert.equal(terminalCursor({ ok: true, result: { terminal: { latestCursor: '0' } } }), 0);
  assert.equal(terminalCursor(JSON.stringify({ ok: true, result: { terminal: { latestCursor: 42 } } })), 42);
  assert.equal(terminalCursor({ ok: true, result: { terminal: {} } }), null);
  assert.equal(terminalCursor('not json'), null);
  // Everything else is not a measurement: two equal malformed values would read
  // as "this pane did not move", and that reading closes a working session.
  for (const junk of ['seven', '', '1.5', '-3', ' 7', true, null, {}, [], 1.5, NaN, Infinity, -1]) {
    assert.equal(terminalCursor({ ok: true, result: { terminal: { latestCursor: junk } } }), null, `${JSON.stringify(junk)} is not a cursor`);
  }
});

test('the terminal inventory refuses rather than reporting an empty machine', () => {
  const list = (result, status = 0) => terminalInventory(stub(JSON.stringify({ ok: true, result }), status).run);

  const good = list({ terminals: [{ handle: 'term_a', orphaned: false }], hostScope: { omittedHostIds: [] }, truncated: false });
  assert.equal(good.ok, true);
  assert.equal(good.byHandle.get('term_a').orphaned, false);
  assert.equal(good.omitted, false);

  // F-028: an absent container is not an empty one.
  assert.equal(list({}).ok, false);
  assert.match(list({}).reason, /absent container is not an empty one/);
  // A partial list cannot prove that a pane is gone.
  assert.equal(list({ terminals: [], truncated: true }).ok, false);
  assert.match(list({ terminals: [], truncated: true }).reason, /TRUNCATED/);
  // Nor can a list that never asked every host — measured non-empty on this Mac.
  const omitted = list({ terminals: [], hostScope: { omittedHostIds: ['runtime:7930a317'] } });
  assert.deepEqual([omitted.ok, omitted.omitted, omitted.omittedHosts], [true, true, ['runtime:7930a317']]);
  // And a call that did not answer is never an inventory.
  assert.equal(list({ terminals: [] }, 1).ok, false);

  const scoped = stub(JSON.stringify({ ok: true, result: { terminals: [] } }));
  terminalInventory(scoped.run, { environment: 'gapicore' });
  assert.deepEqual(scoped.calls, [['terminal', 'list', '--environment', 'gapicore', '--json']]);
});

test('every inability is named, and none of them is an empty terminal', () => {
  const kind = (receipt, status = 0) => readPane(stub(receipt, status).run, HANDLE).refusal;

  assert.equal(kind('Unknown command: terminal read').kind, 'unparseable');
  assert.equal(kind(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no such terminal' } })).kind, 'error');
  assert.equal(kind(JSON.stringify({ ok: true, result: { output: '' } })).kind, 'no-terminal');
  // The exact receipt `--lines 60` produced against a running terminal.
  assert.equal(kind(JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, status: null } } })).kind, 'null-status');
  assert.equal(kind(JSON.stringify({ ok: true, result: { terminal: { status: 'running', tail: 'one string' } } })).kind, 'tail-not-list');
  assert.equal(kind(alive()), null, 'a complete receipt refuses nothing');
});

test('readability is the cursor watchers\u2019 predicate, and it needs the exit code too', () => {
  assert.equal(paneReadable(readPane(stub(alive()).run, HANDLE)), true);
  // A cursor watcher accepts what `tail` refuses: no tail, no status, still a pane.
  assert.equal(paneReadable(readPane(stub(JSON.stringify({ ok: true, result: { terminal: { latestCursor: 7 } } })).run, HANDLE)), true);
  // A non-zero exit is a verdict (ADR 0003): the pane was not read, whatever the text said.
  assert.equal(paneReadable(readPane(stub(alive(), 1).run, HANDLE)), false);
  assert.equal(paneReadable(readPane(stub(JSON.stringify({ ok: false, error: {} })).run, HANDLE)), false);
});
