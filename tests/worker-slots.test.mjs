// `livePanes` — the ONE count a cap gates, read from a real store.
//
// #161 (ruled shape 2 by the maintainer, 2026-09-04): the fence counted rows of
// the DISPATCH INDEX, which by its authority rule carries a handle only for a
// `worker-start` phase, while `ax worker ls` counted the pane whichever phase
// recorded it. A pane recorded by the bash-era `--inject` repair therefore read
// VIVANT in the listing and occupied no slot in the fence — two numbers for one
// question (#88's class), and the exposure is a dispatch admitted past a full
// cap.
//
// The scoping propositions here were `liveCount`'s in worker-capacity.test.mjs
// and moved with the count: they are graded against a real store now, because
// the store is where the shapes that broke the number live (a repair phase, a
// reused terminal, a record naming no repository). Offline: real temp
// directories, injected inventory, injected host reader.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { livePanes } from '../src/worker/slots.mjs';

const store = () => mkdtempSync(join(tmpdir(), 'ax-slots-'));

/** This runtime's own terminal list, as `terminalInventory` answers it. */
const localOf = (entries = []) => ({ ok: true, byHandle: new Map(entries), omitted: false, omittedHosts: [], hosts: ['local'] });

/** A live pane, and a dead one Orca still lists. */
const up = { orphaned: false };
const orphaned = { orphaned: true };

/**
 * The host reader, with each host's answer declared: an array is that host's own
 * inventory, a string is the refusal it answered with, and an undeclared host
 * could not be asked either.
 */
function scopesOf(hosts = {}) {
  const asked = new Map();
  return {
    scopeFor(host) {
      if (!asked.has(host)) {
        const own = hosts[host];
        asked.set(
          host,
          Array.isArray(own)
            ? { ok: true, byHandle: new Map(own.map(handle => [handle, up])) }
            : { ok: false, reason: typeof own === 'string' ? own : `'${host}' is not a host this project declared` },
        );
      }
      return asked.get(host);
    },
    unaskable: () => [...asked].filter(([, scope]) => scope.ok !== true),
  };
}

/** One record, written by hand because these are the shapes a writer no longer produces. */
function record(dir, request, phases, { repo = 'acme/widgets' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${request}.json`),
    JSON.stringify({
      request,
      orca: 'orca',
      createdAt: '2026-09-04T10:00:00.000Z',
      ...(repo === '' ? {} : { repo }),
      attempts: [{ n: 1, settled: false, phases }],
    }),
  );
}

/** A phase that recorded an agent pane. `on` is the placement its argv named. */
const recorded = ({ name = 'worker-start', handle, on = '', argv = true, exit = 0, state = 'ready' } = {}) => ({
  name,
  identity: `id-${name}-${handle}`,
  ...(argv ? { argv: ['orca', 'orchestration', name, ...(on === '' ? [] : ['--on', on]), '--json'] } : {}),
  beganAt: '2026-09-04T10:00:00.000Z',
  exit,
  receipt: { ok: true, result: { dispatchId: `ctx-${handle}`, state, effects: [{ kind: 'terminal', role: 'agent', id: handle }] } },
});

/** The `worker-start` that failed with no effects at all — F-048's own shape. */
const failedStart = () => ({
  name: 'worker-start',
  identity: 'id-failed',
  argv: ['orca', 'orchestration', 'worker-start', '--json'],
  exit: 1,
  receipt: { ok: false, error: { code: 'agent_readiness', message: 'timeout' } },
});

const count = (dir, { local = [], hosts = {}, repo = 'acme/widgets' } = {}) =>
  livePanes({ store: dir, local: localOf(local), scopes: scopesOf(hosts), repo });

/**
 * The unmeasured pair with its CAUSE split (#221 review): `occupied` is the
 * subset whose liveness could not be established because a recorded worktree is
 * still occupied by a pane no record owns, and the remainder is a record on a
 * host that could not be asked. A cap's arithmetic reads the TOTALS; only the
 * sentence a caller prints reads the cause, so the two must not be one number.
 */
const unmeasured = ({ machine = 0, mine = 0, occupiedMachine = 0, occupiedMine = 0 } = {}) => ({
  machine,
  mine,
  occupied: { machine: occupiedMachine, mine: occupiedMine },
});

test('#161: a pane ANY phase recorded is a slot, and the dispatch index is not consulted', () => {
  const dir = store();
  // The F-048 record: the `worker-start` receipt carries no effects, so nothing
  // about this pane is a worker-start fact — and the pane is up right now.
  record(dir, 'gap-353-u3', [failedStart(), recorded({ name: 'worker-start-inject', handle: 'term_live' })]);

  const slots = count(dir, { local: [['term_live', up]] });
  assert.deepEqual(slots.live, { machine: 1, mine: 1, unknown: 0, unmeasured: unmeasured() });
  assert.deepEqual(slots.unreadable, []);
});

test('#161: two records naming ONE pane are one slot, and agree on the repository or read UNKNOWN', () => {
  const dir = store();
  // A repair reuses the agent terminal, so two records can name one handle:
  // counting rows would report two panes for one and refuse a dispatch the
  // machine had room for.
  record(dir, 'a-work', [recorded({ handle: 'term_shared' })]);
  record(dir, 'b-work', [recorded({ name: 'worker-start-inject', handle: 'term_shared' })]);

  assert.deepEqual(count(dir, { local: [['term_shared', up]] }).live, {
    machine: 1,
    mine: 1,
    unknown: 0,
    unmeasured: unmeasured(),
  });

  // And when the two records place that one pane in two DIFFERENT repositories,
  // it is UNKNOWN: one pane cannot be two projects' slot, and attributing it to
  // either would let a foreign record park this repository's cap (F-028).
  const contested = store();
  record(contested, 'a-work', [recorded({ handle: 'term_shared' })]);
  record(contested, 'b-work', [recorded({ handle: 'term_shared' })], { repo: 'goodluckagency/ofmchat' });
  assert.deepEqual(count(contested, { local: [['term_shared', up]] }).live, {
    machine: 1,
    mine: 0,
    unknown: 1,
    unmeasured: unmeasured(),
  });

  // AND THE DISAGREEMENT IS PERMANENT. A third record agreeing with the first
  // must not restore the attribution the second one contested: deciding the
  // repository incrementally did exactly that (A → B clears it, A again sets it
  // back), and the pane read as this repository's slot on a store where nothing
  // establishes whose it is. The files are read in sorted order, so `c-work` is
  // the one that would have restored it.
  const restored = store();
  record(restored, 'a-work', [recorded({ handle: 'term_shared' })]);
  record(restored, 'b-work', [recorded({ handle: 'term_shared' })], { repo: 'goodluckagency/ofmchat' });
  record(restored, 'c-work', [recorded({ name: 'worker-start-inject', handle: 'term_shared' })]);
  assert.deepEqual(count(restored, { local: [['term_shared', up]] }).live, {
    machine: 1,
    mine: 0,
    unknown: 1,
    unmeasured: unmeasured(),
  });
});

test('only a recorded handle whose pane is alive and owned is capacity', () => {
  const dir = store();
  record(dir, 'alive', [recorded({ handle: 'term_a' })]);
  record(dir, 'orphaned', [recorded({ handle: 'term_b' })]);
  record(dir, 'gone', [recorded({ handle: 'term_gone' })]);
  // A record whose mutation never came back names no pane at all.
  record(dir, 'inflight', [{ name: 'worker-start', identity: 'id-x', argv: ['orca', 'orchestration', 'worker-start'], exit: null, receipt: null }]);

  // term_b is orphaned, term_gone is in no list, term_editor has no record:
  // none of them is dispatch capacity.
  const slots = count(dir, { local: [['term_a', up], ['term_b', orphaned], ['term_editor', up]] });
  assert.deepEqual(slots.live, { machine: 1, mine: 1, unknown: 0, unmeasured: unmeasured() });
});

test('#88: the per-repository count is scoped by the repository each record NAMES', () => {
  const dir = store();
  // The reported shape: live panes that are not this repository's. The machine
  // total counts them all; MINE counts one — a wave here must not be parked by
  // a wave over there.
  record(dir, 'mine', [recorded({ handle: 'term_mine' })], { repo: 'flosrn/ax' });
  record(dir, 'theirs', [recorded({ handle: 'term_theirs' })], { repo: 'goodluckagency/ofmchat' });
  record(dir, 'theirs-2', [recorded({ handle: 'term_theirs_2' })], { repo: 'GoodLuckAgency/OfmChat' });
  // No `repo` key at all: UNKNOWN, never "this repository" (F-028).
  record(dir, 'nameless', [recorded({ handle: 'term_nameless' })], { repo: '' });

  const local = [['term_mine', up], ['term_theirs', up], ['term_theirs_2', up], ['term_nameless', up]];
  const none = unmeasured();
  assert.deepEqual(count(dir, { local, repo: 'flosrn/ax' }).live, { machine: 4, mine: 1, unknown: 1, unmeasured: none });
  // The same store read from the other checkout: a slug differing only in case
  // is the same repository, which is the comparison `ax worker start` already
  // makes when it refuses a foreign record.
  assert.deepEqual(count(dir, { local, repo: 'goodluckagency/ofmchat' }).live, { machine: 4, mine: 2, unknown: 1, unmeasured: none });
  // A caller that cannot name itself owns NOTHING it can count, and says so
  // through capVerdict rather than reading zero as room.
  assert.deepEqual(count(dir, { local, repo: '' }).live, { machine: 4, mine: 0, unknown: 1, unmeasured: none });
});

test('#88: a pane whose host could not be asked is UNMEASURED, scoped by the repository it names', () => {
  const dir = store();
  // Not "not capacity": a container that could not be read (F-028). The scope
  // matters, because only this repository's own unknowns can make the count
  // `dispatch.cap` gates unmeasurable.
  record(dir, 'mine', [recorded({ handle: 'term_mine' })], { repo: 'flosrn/ax' });
  record(dir, 'mine-far', [recorded({ handle: 'term_mine_far', on: 'gapicore' })], { repo: 'flosrn/ax' });
  record(dir, 'far', [recorded({ handle: 'term_far', on: 'gapicore' })], { repo: 'goodluckagency/ofmchat' });

  const unreachable = { gapicore: 'ssh_unreachable' };
  assert.deepEqual(count(dir, { local: [['term_mine', up]], hosts: unreachable, repo: 'flosrn/ax' }).live, {
    machine: 1,
    mine: 1,
    unknown: 0,
    unmeasured: unmeasured({ machine: 2, mine: 1 }),
  });
  // Read from the other checkout, the same store: its own unknown is the one
  // that could make ITS cap unmeasurable, and mine is only a machine-total fact.
  assert.deepEqual(count(dir, { local: [['term_mine', up]], hosts: unreachable, repo: 'goodluckagency/ofmchat' }).live, {
    machine: 1,
    mine: 0,
    unknown: 0,
    unmeasured: unmeasured({ machine: 2, mine: 1 }),
  });
  // A host that ANSWERS classifies its own panes: present is capacity, absent
  // from the list it gave is a corpse there, and neither is unmeasured.
  const answered = count(dir, { local: [['term_mine', up]], hosts: { gapicore: ['term_mine_far'] }, repo: 'flosrn/ax' });
  assert.deepEqual(answered.live, { machine: 2, mine: 2, unknown: 0, unmeasured: unmeasured() });
});

test('a phase that recorded a pane and NO argv makes its record unreadable, never a local pane (#130)', () => {
  const dir = store();
  // `--on` is what says where that pane lives. Reading its absence as "local"
  // turns a placement nobody recorded into an ordinary local pane: absent from
  // the local list it would read MORT and leave every count, the under-count
  // F-028 forbids. So the record is NAMED and contributes nothing — the fences
  // refuse on an unreadable record rather than counting past it.
  record(dir, 'unnamed', [recorded({ handle: 'term_ghost', argv: false })]);
  record(dir, 'ordinary', [recorded({ handle: 'term_ok' })]);

  const slots = count(dir, { local: [['term_ok', up], ['term_ghost', up]] });
  assert.deepEqual(slots.unreadable.map(entry => entry.file), ['unnamed.json']);
  assert.match(slots.unreadable[0].error, /recorded pane term_ghost and no argv/);
  assert.equal(slots.live.machine, 1, 'the readable record still counts; the named one is the caller’s refusal');
});

test('a record whose phases cannot be walked is NAMED, never a crash inside the count', () => {
  const dir = store();
  // An argv carrying a non-string — hand-edited, foreign-written, half-repaired
  // — makes `argvValue` throw from inside this reader, and BOTH fences call it
  // for the number that authorises a mutation. A stack trace there replaces a
  // refusal carrying its repair with an exit nobody can act on, and that record
  // decides nothing either way: it joins the ones the count could not read.
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'malformed.json'),
    JSON.stringify({
      request: 'malformed',
      repo: 'acme/widgets',
      attempts: [
        {
          n: 1,
          phases: [
            {
              name: 'worker-start-inject',
              argv: ['orca', 'orchestration', 7, null],
              exit: 0,
              receipt: { ok: true, result: { dispatchId: 'ctx_x', state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: 'term_x' }] } },
            },
          ],
        },
      ],
    }),
  );
  record(dir, 'ordinary', [recorded({ handle: 'term_ok' })]);

  const slots = count(dir, { local: [['term_ok', up], ['term_x', up]] });
  assert.deepEqual(slots.unreadable.map(entry => entry.file), ['malformed.json']);
  assert.match(slots.unreadable[0].error, /phases cannot be read/);
  assert.equal(slots.live.machine, 1, 'the record that reads still counts, and the other is the fences’ refusal');
});

test('a record that does not name itself is unreadable, and a broken one does not hide the rest', () => {
  const dir = store();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  writeFileSync(join(dir, 'misnamed.json'), JSON.stringify({ request: 'somebody-else', attempts: [] }));
  record(dir, 'ordinary', [recorded({ handle: 'term_ok' })]);

  const slots = count(dir, { local: [['term_ok', up]] });
  assert.deepEqual(slots.unreadable.map(entry => entry.file).sort(), ['broken.json', 'misnamed.json']);
  assert.equal(slots.live.machine, 1, 'a store this reader cannot fully parse still knows about the other panes');
});

test('a store that never existed is a real zero; one that cannot be enumerated is an inability', () => {
  // An ENOENT store is a machine that has never dispatched, where refusing would
  // block the first dispatch ever. A store that exists and cannot be read is the
  // opposite: zero would be a lie, so there is no number to spend.
  const missing = count(join(store(), 'never-dispatched'));
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.live, { machine: 0, mine: 0, unknown: 0, unmeasured: unmeasured() });

  const file = join(store(), 'store');
  writeFileSync(file, 'this is a file, not a directory');
  const unenumerable = count(file);
  assert.equal(unenumerable.missing, false);
  assert.notEqual(unenumerable.reason, '');
  assert.equal(unenumerable.live, null, 'no number is handed back for a container that could not be read (F-028)');
});

test('the inventory the count was taken against is returned, never rebuilt by the caller', () => {
  const dir = store();
  // `ax triage dispatch` has a SECOND question about these same panes (its
  // anti-rival gates), and asking it of a second measurement is how two answers
  // about one machine appear.
  record(dir, 'far', [recorded({ handle: 'term_far', on: 'gapicore' })]);
  const slots = count(dir, { hosts: { gapicore: ['term_far'] } });
  assert.deepEqual([...slots.inventory.byHandle.keys()], ['term_far']);
  assert.deepEqual(slots.inventory.unresolved, []);
});

test('#221: a live pane at a recorded worktree is not a spendable empty cap', () => {
  const tree = '/tmp/221-slots-tree';
  const dir = store();
  record(dir, 'old', [{
    name: 'worker-start',
    identity: 'id-old',
    argv: ['orca', 'orchestration', 'worker-start', '--worktree', `path:${tree}`, '--json'],
    beganAt: '2026-09-04T10:00:00.000Z',
    exit: 0,
    receipt: { ok: true, result: { dispatchId: 'ctx-old', state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: 'term_old' }] } },
  }]);

  const occupied = count(dir, { local: [['term_restored', { orphaned: false, worktreePath: tree }]] });
  assert.ok(
    occupied.live === null || (occupied.live.unmeasured && occupied.live.unmeasured.machine > 0),
    `recorded worktree occupancy must not read as a proven-empty cap: ${JSON.stringify(occupied.live)}`,
  );
  assert.equal(occupied.live?.mine ?? 0, 0, 'the extra pane is not attributed to this repository by path');
  // The consequence a dispatch consumes: an unmeasured pane of THIS repository
  // is what `capVerdict` refuses on as an inability (F-028), so the freed slot
  // an unproven death would have handed out is never spent.
  assert.equal(occupied.live?.unmeasured.mine, 1, 'the recorded pane of this repository has no established liveness');
  // AND THE CAUSE RIDES WITH IT, never flattened into "a host could not be
  // asked" (review of #221): no host was omitted here — the local list answered
  // in full, and what is unknown is whether the recorded tree is exclusive. A
  // caller that prints the host sentence over this sends its reader to declare a
  // host that has nothing to do with the pane.
  assert.deepEqual(occupied.live?.unmeasured.occupied, { machine: 1, mine: 1 }, 'occupancy is named as occupancy');

  const foreign = count(dir, { local: [['term_stranger', { orphaned: false, worktreePath: '/tmp/other-tree' }]] });
  assert.deepEqual(foreign.live, { machine: 0, mine: 0, unknown: 0, unmeasured: unmeasured() });
});

test('#221: an unaskable host and an occupied worktree are both unmeasured, and are counted APART', () => {
  // Two inabilities, two repairs: one is answered by asking a host, the other by
  // inspecting the live handle at a path. Summing them into one number leaves
  // every caller printing one of the two repairs over both.
  const tree = '/tmp/221-mixed-tree';
  const dir = store();
  record(dir, 'far', [recorded({ handle: 'term_far', on: 'gapicore' })]);
  record(dir, 'here', [{
    name: 'worker-start',
    identity: 'id-here',
    argv: ['orca', 'orchestration', 'worker-start', '--worktree', `path:${tree}`, '--json'],
    beganAt: '2026-09-04T10:00:00.000Z',
    exit: 0,
    receipt: { ok: true, result: { dispatchId: 'ctx-here', state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: 'term_here' }] } },
  }]);

  const mixed = count(dir, {
    local: [['term_restored', { orphaned: false, worktreePath: tree }]],
    hosts: { gapicore: 'ssh_unreachable' },
  });
  assert.deepEqual(mixed.live, {
    machine: 0,
    mine: 0,
    unknown: 0,
    unmeasured: unmeasured({ machine: 2, mine: 2, occupiedMachine: 1, occupiedMine: 1 }),
  });
});
