// The two caps and the one refusal, exercised through their own interface.
//
// #88: `ax worker ls` labelled ONE machine-wide pane count "the cap count"
// while `worker dispatch` enforced nothing and `triage dispatch` enforced a
// machine-wide 3 nobody had armed — so a 13-issue wave in this repository ran
// at one slot because another checkout's orchestrator held two panes. Every
// proposition here is one of the two caps, or the verdict that gates on them,
// and the verbs that print them are pinned in worker-dispatch.test.mjs,
// triage-dispatch.test.mjs and worker-ls.test.mjs.
//
// THE COUNTS THEMSELVES MOVED to worker-slots.test.mjs (#161): they are read
// from a store now, by the one reader all three verbs count through, and a
// suite that could still fabricate them here would grade a shape no verb
// passes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { capLines, capVerdict, machineCapOf, repoCapOf } from '../src/worker/capacity.mjs';


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

/**
 * `unmeasured` is the panes whose LIVENESS could not be established — a record
 * on a host that could not be asked. They are not "not capacity": they are a
 * container that could not be read, scoped by the repository each names.
 */
const live = (machine, mine, unknown = 0, unmeasured = { mine: 0, machine: 0 }) => ({ machine, mine, unknown, unmeasured });

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

test('capVerdict: a per-repository cap that cannot be COUNTED authorizes no dispatch (F-028)', () => {
  // Ruled 2026-09-03 on #88: an unmeasurable cap is an inability, not room. A
  // mutation never proceeds on a container that could not be read, so this is
  // cannot-establish — about the machine, not about the subject.
  const out = capVerdict({ live: live(4, 0, 4), adding: 1, repo: '', repoCap: 3, machineCap: null });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'cannot', 'an inability, never a refusal about the ticket');
  assert.equal(out.scope, 'repository');
  assert.match(out.message, /NOT MEASURED|cannot be counted/);
  assert.match(out.repair, /origin/, 'route one: make gh able to name this checkout');
  assert.match(out.repair, /dispatch\.machineCap/, 'route two: declare the ceiling that then bounds it');
});

test('capVerdict: a declared ceiling BOUNDS a checkout that cannot be named, so the dispatch proceeds', () => {
  const bounded = capVerdict({ live: live(4, 0, 4), adding: 1, repo: '', repoCap: 3, machineCap: 6 });
  assert.equal(bounded.ok, true, 'the ceiling is the bound the ruling names');
  assert.ok(bounded.notes.some(line => /NOT MEASURED/.test(line)), 'and the absent per-repository count is still disclosed');

  const over = capVerdict({ live: live(6, 0, 6), adding: 1, repo: '', repoCap: 3, machineCap: 6 });
  assert.equal(over.ok, false, 'and it really bounds: the ceiling still refuses');
  assert.equal(over.kind, 'refuse');
  assert.equal(over.scope, 'machine');
});

test('capVerdict: a pane of THIS repository whose liveness is unestablished stops the dispatch', () => {
  // The review finding on PR #129, and the same rule: a record on a host that
  // could not be asked understates the count the fence uses, so authorizing
  // against it would admit a pane past a cap that is already full.
  const out = capVerdict({
    live: live(1, 1, 0, { mine: 1, machine: 1 }),
    adding: 1,
    repo: 'flosrn/ax',
    repoCap: 3,
    machineCap: null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'cannot');
  assert.equal(out.scope, 'repository');
  assert.match(out.message, /1 pane\(s\) in flosrn\/ax/);
  assert.match(out.message, /could not be asked|liveness/);
  assert.match(out.repair, /ax worker ls/);
});

test('capVerdict: an unestablished pane of ANOTHER repository stops nothing until a ceiling is armed (#88)', () => {
  // The other edge of the same rule. An unknown pane elsewhere understates the
  // MACHINE total alone, and nothing gates on that total until an operator arms
  // the fuse — reading it as a hard inability would park this repository on
  // another checkout's unreachable host, which is #88 through a new door.
  const unarmed = capVerdict({
    live: live(1, 0, 0, { mine: 0, machine: 1 }),
    adding: 1,
    repo: 'flosrn/ax',
    repoCap: 3,
    machineCap: null,
  });
  assert.equal(unarmed.ok, true);
  assert.ok(unarmed.notes.some(line => /could not be asked|not in either count/.test(line)), JSON.stringify(unarmed.notes));

  const armed = capVerdict({
    live: live(1, 0, 0, { mine: 0, machine: 1 }),
    adding: 1,
    repo: 'flosrn/ax',
    repoCap: 3,
    machineCap: 3,
  });
  assert.equal(armed.ok, false, 'an armed ceiling counts every pane, so an unknown one makes the total unmeasurable');
  assert.equal(armed.kind, 'cannot');
  assert.equal(armed.scope, 'machine');
  assert.match(armed.repair, /ax worker ls/);
});

test('capLines label each count by its scope, and never call a machine total the cap count', () => {
  const lines = capLines({ live: live(5, 2, 1, { mine: 0, machine: 2 }), repo: 'flosrn/ax', repoCap: 3, machineCap: null }).join('\n');
  assert.match(lines, /2 pane\(s\).*could not be asked/, 'a pane whose liveness is unknown is in neither count, and the line says so');
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
