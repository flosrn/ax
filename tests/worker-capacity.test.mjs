// The two counts and the two caps, exercised through their own interface.
//
// #88: `ax worker ls` labelled ONE machine-wide pane count "the cap count"
// while `worker dispatch` enforced nothing and `triage dispatch` enforced a
// machine-wide 3 nobody had armed — so a 13-issue wave in this repository ran
// at one slot because another checkout's orchestrator held two panes. Every
// proposition here is one of the two numbers, or one of the two caps that gate
// them, and the verbs that print them are pinned in worker-dispatch.test.mjs,
// triage-dispatch.test.mjs and worker-ls.test.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { capLines, capVerdict, liveCount, machineCapOf, repoCapOf } from '../src/worker/capacity.mjs';

const inventoryOf = entries => ({ ok: true, byHandle: new Map(entries), omitted: false });

test('liveCount counts only recorded handles whose pane is alive and owned', () => {
  const index = {
    byDispatch: new Map([
      ['d1', { handle: 'term_a', repo: 'acme/widgets' }],
      ['d2', { handle: 'term_b', repo: 'acme/widgets' }],
      ['d3', { handle: null, repo: 'acme/widgets' }],
      ['d4', { handle: 'term_gone', repo: 'acme/widgets' }],
    ]),
  };
  const inventory = inventoryOf([
    ['term_a', { orphaned: false }],
    ['term_b', { orphaned: true }],
    ['term_editor', { orphaned: false }],
  ]);
  // term_b is orphaned, term_gone has no pane, term_editor has no record:
  // none of them is dispatch capacity.
  assert.deepEqual(liveCount({ index, inventory, repo: 'acme/widgets' }), { machine: 1, mine: 1, unknown: 0 });
});

test('liveCount scopes the per-repository count by the repository each record NAMES', () => {
  // #88, the reported shape: live panes that are not this repository's. The
  // machine total counts them all; MINE counts one — a wave here must not be
  // parked by a wave over there.
  const index = {
    byDispatch: new Map([
      ['d1', { handle: 'term_mine', repo: 'flosrn/ax' }],
      ['d2', { handle: 'term_theirs', repo: 'goodluckagency/ofmchat' }],
      ['d3', { handle: 'term_theirs_2', repo: 'GoodLuckAgency/OfmChat' }],
      // No `repo` key at all: UNKNOWN, never "this repository" (F-028).
      ['d4', { handle: 'term_nameless', repo: '' }],
    ]),
  };
  const inventory = inventoryOf([
    ['term_mine', { orphaned: false }],
    ['term_theirs', { orphaned: false }],
    ['term_theirs_2', { orphaned: false }],
    ['term_nameless', { orphaned: false }],
  ]);
  assert.deepEqual(liveCount({ index, inventory, repo: 'flosrn/ax' }), { machine: 4, mine: 1, unknown: 1 });
  // The same store read from the other checkout: a slug differing only in case
  // is the same repository, which is the comparison `ax worker start` already
  // makes when it refuses a foreign record.
  assert.deepEqual(liveCount({ index, inventory, repo: 'goodluckagency/ofmchat' }), { machine: 4, mine: 2, unknown: 1 });
  // A caller that cannot name itself owns NOTHING it can count, and says so
  // through capVerdict rather than reading zero as room.
  assert.deepEqual(liveCount({ index, inventory, repo: '' }), { machine: 4, mine: 0, unknown: 1 });
});

test('repoCapOf: dispatch.cap is the fairness cap, and an undeclared one is 3', () => {
  assert.equal(repoCapOf({}), 3);
  assert.equal(repoCapOf({ dispatch: {} }), 3);
  assert.equal(repoCapOf({ dispatch: { cap: 5 } }), 5);
  assert.equal(repoCapOf({ dispatch: { cap: 0 } }), 0, 'zero is legal, and means "no new pane for this repository"');
});

test('machineCapOf: an undeclared ceiling DOES NOT EXIST', () => {
  // The behaviour change #88 was ruled on: an unset ceiling that still means 3
  // is this issue's bug under a new name, because another checkout's panes eat
  // the fuse and this repository never reaches its own cap.
  assert.deepEqual(machineCapOf({}, {}), { ok: true, cap: null });
  assert.deepEqual(machineCapOf({ dispatch: {} }, {}), { ok: true, cap: null });
  assert.deepEqual(machineCapOf({ dispatch: { machineCap: 8 } }, {}), { ok: true, cap: 8 });
  assert.deepEqual(machineCapOf({ dispatch: { machineCap: 0 } }, {}), { ok: true, cap: 0 });
});

test('machineCapOf refuses BOTH retired env knobs by name, and names the declaration', () => {
  // A silent fallback would keep a machine-wide 3 alive under an env var whose
  // name says `triage` while it gated every verb. Both spellings have been the
  // live one, so both are refused BY NAME.
  for (const from of ['ORCA_TRIAGE_SESSION_CAP', 'ORCA_READY_SESSION_CAP']) {
    const out = machineCapOf({}, { [from]: '5' });
    assert.equal(out.ok, false, `${from} is not read past`);
    assert.equal(out.from, from);
    assert.equal(out.to, 'dispatch.machineCap');
  }
  // Empty is absence, exactly as it was: an exported-but-empty variable is a
  // shell artefact, not an instruction.
  assert.deepEqual(machineCapOf({}, { ORCA_TRIAGE_SESSION_CAP: '', ORCA_READY_SESSION_CAP: '' }), { ok: true, cap: null });
  // A declared ceiling does not excuse the retired knob: it would read as the
  // one in force.
  assert.equal(machineCapOf({ dispatch: { machineCap: 8 } }, { ORCA_TRIAGE_SESSION_CAP: '2' }).ok, false);
});

const live = (machine, mine, unknown = 0) => ({ machine, mine, unknown });

test('capVerdict refuses on the per-repository cap, naming both numbers and the repair', () => {
  const out = capVerdict({ live: live(5, 3), adding: 1, repo: 'flosrn/ax', repoCap: 3, machineCap: null });
  assert.equal(out.ok, false);
  assert.equal(out.scope, 'repository');
  assert.match(out.message, /dispatch\.cap 3/, 'the cap that refused is named');
  assert.match(out.message, /3 live pane\(s\) in flosrn\/ax \+ 1 new/, 'this repository’s number');
  assert.match(out.message, /5 live/, 'and the machine number beside it');
  assert.match(out.repair, /dispatch\.cap/, 'the repair names the declared value to raise');
  assert.match(out.repair, /ax worker ls/, 'and the verb that shows which pane to release');
});

test('capVerdict: another repository’s panes never park this one (#88)', () => {
  // The reported measurement: three live panes, all of them ofmchat's, zero
  // here — and no ceiling armed. This repository has its whole cap available.
  const out = capVerdict({ live: live(3, 0), adding: 3, repo: 'flosrn/ax', repoCap: 3, machineCap: null });
  assert.equal(out.ok, true);
});

test('capVerdict refuses on the machine ceiling only when one is declared', () => {
  const armed = capVerdict({ live: live(3, 0), adding: 1, repo: 'flosrn/ax', repoCap: 3, machineCap: 3 });
  assert.equal(armed.ok, false);
  assert.equal(armed.scope, 'machine');
  assert.match(armed.message, /dispatch\.machineCap 3/);
  assert.match(armed.message, /3 live pane\(s\) on this machine \+ 1 new/);
  assert.match(armed.message, /0 of them in flosrn\/ax/, 'and how many of them are this repository’s');
  assert.match(armed.repair, /dispatch\.machineCap/);

  const unarmed = capVerdict({ live: live(30, 0), adding: 1, repo: 'flosrn/ax', repoCap: 3, machineCap: null });
  assert.equal(unarmed.ok, true, 'an opt-in fuse nobody armed refuses nothing');
});

test('capVerdict: the per-repository cap is checked first, so the repair a checkout can act on comes first', () => {
  const out = capVerdict({ live: live(9, 9), adding: 1, repo: 'flosrn/ax', repoCap: 3, machineCap: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.scope, 'repository', 'the cap this checkout can act on names itself first');
});

test('capVerdict discloses a per-repository count it could not establish (F-028)', () => {
  const out = capVerdict({ live: live(4, 0, 4), adding: 1, repo: '', repoCap: 3, machineCap: null });
  assert.equal(out.ok, true, 'an uncountable cap is a disclosed absence, not a refusal');
  assert.ok(
    out.notes.some(line => /NOT MEASURED/.test(line) && /dispatch\.cap/.test(line)),
    `the absence is announced, not read as room: ${JSON.stringify(out.notes)}`,
  );
  // With no ceiling either, NOTHING gates this dispatch, and that is the one
  // state #88 is about: it may not pass in silence.
  assert.ok(out.notes.some(line => /no cap gates/.test(line)), JSON.stringify(out.notes));
});

test('capLines label each count by its scope, and never call a machine total the cap count', () => {
  const lines = capLines({ live: live(5, 2, 1), repo: 'flosrn/ax', repoCap: 3, machineCap: null }).join('\n');
  assert.match(lines, /2 live pane\(s\) in flosrn\/ax/, 'this repository’s count, said as such');
  assert.match(lines, /dispatch\.cap 3/, 'with the cap that gates it');
  assert.match(lines, /5 live pane\(s\) on this machine/, 'the machine total, on its own line');
  assert.match(lines, /no dispatch\.machineCap/, 'saying that nothing gates it');
  assert.match(lines, /1 .*name no repository/, 'and the unknown panes the machine total alone carries (F-028)');
  assert.doesNotMatch(lines, /this is the cap count/, 'the label #88 measured is gone');

  const armed = capLines({ live: live(5, 2, 0), repo: 'flosrn/ax', repoCap: 3, machineCap: 6 }).join('\n');
  assert.match(armed, /dispatch\.machineCap 6/);
  assert.doesNotMatch(armed, /name no repository/, 'a store with no nameless pane says nothing about one');

  const nameless = capLines({ live: live(5, 0, 5), repo: '', repoCap: 3, machineCap: null }).join('\n');
  assert.match(nameless, /NOT MEASURED/, 'a checkout that cannot name itself gets an absence, never a zero');
});
