// The shared pane reader — the receipt four verbs read and used to read three
// different ways. Each proposition here is one an incident proved (F-027):
// `--lines` annihilates a read (F-041), an absent cursor is not zero, and a
// refusal must be NAMED rather than returned as an empty terminal.
//
// Offline by construction: the runner is injected, so no runtime is touched.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { hostScopes, liveInventory, paneReadable, readPane, terminalCursor, terminalInventory } from '../src/worker/pane.mjs';

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

// ── the inventory a CAP is counted against (#88 review) ──────────────────────

/** A runner answering the local list and, per environment, that host's own. */
function listing({ local = [], hosts = {}, omittedHostIds = [] } = {}) {
  const calls = [];
  const run = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      const at = args.indexOf('--environment');
      const terminals = at === -1 ? local : hosts[args[at + 1]];
      if (terminals === undefined) return { status: 1, stdout: '', stderr: 'no such environment' };
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, result: { terminals, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: at === -1 ? omittedHostIds : [] } } }),
        stderr: '',
      };
    },
  });
  return { run, calls };
}

const declared = () => ({ ok: true, config: { dispatch: { hosts: { gapicore: { ssh: 'orca@vps' } } } } });

/**
 * The recorded panes of a store, as `livePanes` reads them (../src/worker/slots.mjs):
 * keyed by handle, each row naming the repository its record names and the
 * hosts it may be asked about. A record that recorded NO pane has no row here at
 * all, which is why the "spends nothing" propositions below name no such entry —
 * that absence is the reader's, and it is pinned in worker-slots.test.mjs.
 */
const panes = (...rows) => ({ byHandle: new Map(rows.map(row => [row.handle, { repo: '', hosts: [], ...row }])) });

test('#88: a pane the local scope omits and its declared host confirms IS in the count', () => {
  // `ax worker ls` has judged a remote pane by asking its host since #76, while
  // both dispatch gates counted the local list alone — so a repository with
  // working remote children read as UNKNOWN and its cap did not bind. The
  // listing and the fence read the same liveness now, through this.
  const { run, calls } = listing({
    local: [{ handle: 'term_here' }],
    hosts: { gapicore: [{ handle: 'term_far' }] },
    omittedHostIds: ['runtime:7930a317'],
  });
  const local = terminalInventory(run);

  const inventory = liveInventory({
    local,
    panes: panes({ handle: 'term_here' }, { handle: 'term_far', hosts: ['gapicore'] }),
    scopes: hostScopes(run, declared),
  });
  assert.deepEqual([...inventory.byHandle.keys()].sort(), ['term_far', 'term_here']);
  assert.equal(inventory.omitted, true, 'the local scope’s own omission is carried, not laundered');
  assert.equal(calls.filter(line => line.includes('--environment')).length, 1, 'one ask per host, and only where the first list cannot answer');
});

test('#88: the union never upgrades an absence, and spends nothing where it cannot change the count', () => {
  const { run, calls } = listing({ local: [{ handle: 'term_here' }], hosts: { gapicore: [] } });
  const local = terminalInventory(run);

  const inventory = liveInventory({
    local,
    panes: panes(
      // Already proven alive locally: no ask, and no host may take it back (#91).
      { handle: 'term_here', hosts: ['gapicore'] },
      // The host answered, and does not know this handle: it stays absent.
      { handle: 'term_gone', hosts: ['gapicore'] },
    ),
    scopes: hostScopes(run, declared),
  });
  assert.deepEqual([...inventory.byHandle.keys()], ['term_here']);
  assert.equal(calls.filter(line => line.includes('--environment')).length, 1, 'asked once, for the one row it could decide');
});

test('#88: a host that cannot be asked leaves its pane OUT of the count, and NAMES it as unresolved', () => {
  const { run } = listing({ local: [], hosts: {} });
  const local = terminalInventory(run);
  const scopes = hostScopes(run, declared);

  const inventory = liveInventory({ local, panes: panes({ handle: 'term_far', repo: 'flosrn/ax', hosts: ['gapicore'] }), scopes });
  assert.equal(inventory.byHandle.size, 0, 'an absence of information is not a live pane');
  // …and it is not silence either: the row is carried out with the repository it
  // names, so a cap counted against it can refuse as an INABILITY rather than
  // spend an understated number (F-028, review of PR #129).
  assert.deepEqual(
    inventory.unresolved.map(({ handle, repo, host }) => ({ handle, repo, host })),
    [{ handle: 'term_far', repo: 'flosrn/ax', host: 'gapicore' }],
  );
  assert.match(inventory.unresolved[0].reason, /gapicore|terminal list|environment/i, 'carrying why it could not answer');
  assert.deepEqual(
    scopes.unaskable().map(([host]) => host),
    ['gapicore'],
    'and the caller can disclose which host could not answer',
  );
});

test('#88: a row the local list or its host DID decide is never unresolved', () => {
  const { run } = listing({ local: [{ handle: 'term_here' }], hosts: { gapicore: [{ handle: 'term_far' }] } });
  const local = terminalInventory(run);

  const inventory = liveInventory({
    local,
    panes: panes(
      { handle: 'term_here', repo: 'flosrn/ax' },
      { handle: 'term_far', repo: 'flosrn/ax', hosts: ['gapicore'] },
      // The host answered and does not know it: decided, and decided DEAD.
      { handle: 'term_gone', repo: 'flosrn/ax', hosts: ['gapicore'] },
    ),
    scopes: hostScopes(run, declared),
  });
  assert.deepEqual([...inventory.byHandle.keys()].sort(), ['term_far', 'term_here']);
  assert.deepEqual(inventory.unresolved, [], 'a decided row is not an unmeasurable one');
});

test('#88: an undeclared host is never asked — the declaration is the only transport', () => {
  const { run, calls } = listing({ local: [], hosts: { gapicore: [{ handle: 'term_far' }] } });
  const local = terminalInventory(run);
  const scopes = hostScopes(run, declared);

  assert.equal(liveInventory({ local, panes: panes({ handle: 'term_far', hosts: ['someone-elses-host'] }), scopes }).byHandle.size, 0);
  assert.deepEqual(calls.filter(line => line.includes('--environment')), [], 'hostFor refuses a name no project declared');
  assert.equal(scopes.unaskable().length, 1, 'and the undercount is disclosed rather than silent');
});

test('#161: a pane two records place on two hosts is unresolved only when NEITHER could answer', () => {
  // Two records naming one pane is the ordinary shape of a repair, and they can
  // disagree about where it lives. An absence on one host settles nothing while
  // another named host may still carry it, so every host that could decide the
  // pane is asked — and the row is an inability only once all of them failed.
  const answered = listing({ local: [], hosts: { gapicore: [{ handle: 'term_far' }] } });
  const found = liveInventory({
    local: terminalInventory(answered.run),
    panes: panes({ handle: 'term_far', repo: 'flosrn/ax', hosts: ['someone-elses-host', 'gapicore'] }),
    scopes: hostScopes(answered.run, declared),
  });
  assert.deepEqual([...found.byHandle.keys()], ['term_far'], 'the host that answered decided it');
  assert.deepEqual(found.unresolved, [], 'and a decided pane is not an inability');

  const silent = listing({ local: [], hosts: {} });
  const scopes = hostScopes(silent.run, declared);
  const unknown = liveInventory({
    local: terminalInventory(silent.run),
    panes: panes({ handle: 'term_far', repo: 'flosrn/ax', hosts: ['someone-elses-host', 'gapicore'] }),
    scopes,
  });
  assert.equal(unknown.byHandle.size, 0);
  assert.deepEqual(unknown.unresolved.map(row => row.handle), ['term_far'], 'named once, however many hosts failed');
});
