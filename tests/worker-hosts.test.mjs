// The grounds a remote dispatch stands on. Every proposition here is one an
// incident or a measurement paid for (F-027), and the two that matter most are
// arithmetic: the reading that falsified a guard on `memory.current`
// (2026-08-14 16:05) and the incident reading that must still refuse.
//
// Offline by construction: `ssh` and the Orca `run` are injected in every test,
// so no host is reached, no credential is reused and no dispatch is possible.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostFor, proveHost, repoIdFor, unreclaimableMb } from '../src/worker/hosts.mjs';

const MB = 1048576;
const ok = stdout => ({ status: 0, stdout, stderr: '' });
const dead = { status: 255, stdout: '', stderr: 'ssh: connect to host port 22: Operation timed out' };

/**
 * A `memory.stat` in the shape the kernel writes it. `anon` is present because
 * it is the witness that this really was a stat file; the reclaimable file LRUs
 * are what the arithmetic deducts.
 */
const stat = ({ inactiveFileMb, activeFileMb, slabMb = 0, shmemMb = 0, anon = true }) =>
  [
    anon ? `anon ${1 * MB}` : null,
    `file ${(inactiveFileMb + activeFileMb) * MB}`,
    `inactive_file ${inactiveFileMb * MB}`,
    `active_file ${activeFileMb * MB}`,
    `slab_reclaimable ${slabMb * MB}`,
    `shmem ${shmemMb * MB}`,
  ]
    .filter(Boolean)
    .join('\n');

/** The 2026-08-14 16:05 reading: current 10 909 MB (88 %), unreclaimable 1 814 MB (14 %). */
const HEALTHY = {
  current: 10909 * MB,
  max: 12288 * MB,
  stat: stat({ inactiveFileMb: 7000, activeFileMb: 2000, slabMb: 100, shmemMb: 5 }),
};

/** The incident itself: 7.3 GB of 12 GB unreclaimable, 4.7 GB left. */
const INCIDENT = {
  current: 11000 * MB,
  max: 12288 * MB,
  stat: stat({ inactiveFileMb: 3400, activeFileMb: 100, slabMb: 0, shmemMb: 0 }),
};

/** A host with both pairs declared and a sweep, i.e. every ground measured. */
const fullHost = (extra = {}) => ({
  ssh: 'ground',
  diskPath: '/data',
  diskFloorGb: 10,
  cgroup: '/sys/fs/cgroup/agents.service',
  memFreeFloorMb: 6144,
  sweep: ['reap', '--apply'],
  ...extra,
});

/**
 * An ssh that answers per ground and records the order it was asked, which is
 * how the sweep-before-measure rule is asserted rather than assumed.
 *
 * The argv is the hardened one: `-o BatchMode=yes -- <target> <command>`. The
 * command is the LAST element, and the assertions below read the whole argv, so
 * a value that stopped being quoted would show up here rather than on a host.
 */
function fakeSsh({ df = ok('42G\n'), sweep = ok('reap 3\n'), mem = HEALTHY, tracker = ok('') } = {}) {
  const asked = [];
  const calls = [];
  const ssh = args => {
    calls.push(args);
    const command = args[args.length - 1];
    if (command.startsWith('df')) return (asked.push('df'), df);
    if (command.includes('memory.current'))
      return (asked.push('mem'), mem.unreadable ? dead : ok(`${mem.current}\n${mem.max}\n${mem.stat}\n`));
    if (command.includes('linear issue')) return (asked.push('tracker'), tracker);
    return (asked.push('sweep'), sweep);
  };
  return { ssh, asked, calls };
}

// ── the arithmetic ───────────────────────────────────────────────────────────

// Measured 2026-08-14 16:05: `memory.current` read 88 % of the ceiling while the
// unreclaimable set was 14 %. A guard on `memory.current` refuses this host; the
// fleet formula passes it, which is the whole reason this function exists.
test('the 2026-08-14 16:05 reading is 1 814 MB held, not the 10 909 MB memory.current read', () => {
  const verdict = unreclaimableMb(HEALTHY.stat, { current: HEALTHY.current, max: HEALTHY.max });
  assert.deepEqual(verdict, { maxMb: 12288, workMb: 1814, freeMb: 10474 });
});

// Both directions of the same measurement: at the incident 7.3 GB of 12 GB were
// unreclaimable, leaving 4.7 GB — under a 6 144 MB floor, so a second child was
// correctly refusable.
test('the incident reading leaves 4.7 GB, under the floor a session is budgeted from', () => {
  const verdict = unreclaimableMb(INCIDENT.stat, { current: INCIDENT.current, max: INCIDENT.max });
  assert.equal(verdict.workMb, 7500);
  assert.ok(verdict.freeMb < 6144, `expected a shortage, got ${verdict.freeMb} MB free`);
});

// `memory.max` is the literal `max` on an uncapped cgroup: no ceiling to be
// near, so no verdict, so no refusal.
test('an uncapped memory.max yields no verdict rather than a refusal', () => {
  assert.equal(unreclaimableMb(HEALTHY.stat, { current: HEALTHY.current, max: 'max' }), null);
});

// A truncated read must never be mistaken for a measurement of zero: without
// `anon` the counters read as absent and the deduction would report the whole
// ceiling free.
test('a memory.stat with no anon line is not a witness and yields no verdict', () => {
  const truncated = stat({ inactiveFileMb: 7000, activeFileMb: 2000, anon: false });
  assert.equal(unreclaimableMb(truncated, { current: HEALTHY.current, max: HEALTHY.max }), null);
});

// The deduction is from CURRENT, never from max: from max it yields a
// near-constant work whatever the host is doing, so the guard would pass always.
test('the deduction is taken from memory.current, so a busier host reports less headroom', () => {
  const light = unreclaimableMb(HEALTHY.stat, { current: HEALTHY.current, max: HEALTHY.max });
  const heavy = unreclaimableMb(HEALTHY.stat, { current: HEALTHY.current + 2000 * MB, max: HEALTHY.max });
  assert.equal(heavy.freeMb, light.freeMb - 2000);
});

// ── the grounds, in order ────────────────────────────────────────────────────

test('a host whose every ground passes is proven, and each ground says so', () => {
  const { ssh } = fakeSsh();
  const proof = proveHost(fullHost(), { ssh });
  assert.equal(proof.ok, true);
  assert.match(proof.notes.join('\n'), /42G on \/data/);
  assert.match(proof.notes.join('\n'), /10474 MB of unreclaimable headroom/);
});

// A browser an earlier stage left open is not a tenant: refusing over 825 MB of
// dead renderers would be a refusal about garbage, so the sweep runs FIRST.
test('the browser sweep runs before memory is measured', () => {
  const { ssh, asked } = fakeSsh();
  proveHost(fullHost(), { ssh });
  assert.ok(asked.indexOf('sweep') < asked.indexOf('mem'), `order was ${asked.join(' → ')}`);
});

// A sweep that cannot run must never be why a dispatch stops — but it is
// announced as not-swept, because memory was then measured with garbage in it.
test('a sweep that fails is announced as not-swept and refuses nothing', () => {
  const { ssh } = fakeSsh({ sweep: { status: 127, stdout: '', stderr: 'command not found' } });
  const proof = proveHost(fullHost(), { ssh });
  assert.equal(proof.ok, true);
  assert.match(proof.notes.join('\n'), /sweep on 'ground' did not run/);
});

// Measured 2026-08-14: 42G free of 301G is why a remote worktree that installs
// its own dependencies needs a floor at all.
test('free disk under the declared floor refuses, naming the numbers', () => {
  const { ssh } = fakeSsh({ df: ok('4G\n') });
  const proof = proveHost(fullHost(), { ssh });
  assert.equal(proof.ok, false);
  assert.match(proof.reason, /only 4G free on \/data/);
  assert.match(proof.reason, /floor 10G/);
});

test('the memory refusal names the numbers and why the newcomer is the one killed', () => {
  const { ssh } = fakeSsh({ mem: INCIDENT });
  const proof = proveHost(fullHost(), { ssh });
  assert.equal(proof.ok, false);
  assert.match(proof.reason, /7500 of 12288 MB already held/);
  assert.match(proof.reason, /kills the largest RSS/);
  // No in-word apostrophe anywhere in this text: it crosses shells (a heredoc
  // inside `$(...)` breaks on one under bash 3.2), and a refusal that cannot be
  // printed is a refusal nobody can act on.
  assert.ok(!/\w['\u2019]\w/.test(proof.reason), `apostrophe in: ${proof.reason}`);
});

// A path that moved and a dead transport are not a shortage. Only a number that
// was really read may stop a dispatch.
test('an unreadable ssh fails open on both disk and memory, unproven rather than passed', () => {
  const ssh = () => dead;
  const proof = proveHost(fullHost({ sweep: undefined }), { ssh });
  assert.equal(proof.ok, true);
  assert.match(proof.notes.join('\n'), /free disk on 'ground' could not be read/);
  assert.match(proof.notes.join('\n'), /cgroup memory on 'ground' could not be read/);
  assert.match(proof.notes.join('\n'), /unproven, not passed/);
});

// What a project does not declare is not measured, and the report says so: a
// ground silently skipped reads exactly like a ground that passed.
test('a host that declares no floors reports them not-measured rather than passed', () => {
  const { ssh, asked } = fakeSsh();
  const proof = proveHost({ ssh: 'ground' }, { ssh });
  assert.equal(proof.ok, true);
  assert.match(proof.notes.join('\n'), /free disk on 'ground' was NOT MEASURED/);
  assert.match(proof.notes.join('\n'), /cgroup memory on 'ground' was NOT MEASURED/);
  assert.deepEqual(asked, []);
});

// diskPath without diskFloorGb is half a declaration, and half a floor is no
// floor: nothing is inferred for it.
test('half a declared pair is not a floor', () => {
  const { ssh } = fakeSsh();
  const proof = proveHost({ ssh: 'ground', diskPath: '/data' }, { ssh });
  assert.match(proof.notes.join('\n'), /NOT MEASURED/);
});

// ── the tracker probe: three outcomes, one of them a wall ─────────────────────

// The credential is per host: measured, `linear_not_connected` came back from
// the remote host while the local CLI answered the ticket in full.
test('the tracker probe passes when the ref echoes back, and names which path it proved', () => {
  const { ssh } = fakeSsh({ tracker: ok('{"ok":true,"result":{"issue":{"identifier":"ABC-12","title":"x"}}}') });
  const proof = proveHost(fullHost(), { ssh, kind: 'linear', ref: 'ABC-12' });
  assert.equal(proof.ok, true);
  assert.match(proof.notes.join('\n'), /reads ABC-12 over the orca CLI/);
  // Two paths authenticate separately; a verdict that does not name its own
  // lets the next reader take the MCP 401 banner as this guard being wrong.
  assert.match(proof.notes.join('\n'), /MCP server authenticates separately/);
});

// A dead transport, a host with no runtime and a tracker that answered nothing
// are one output here, and only the last is a wall.
test('a tracker that answers nothing is unproven, never a wall', () => {
  const { ssh } = fakeSsh({ tracker: dead });
  const proof = proveHost(fullHost(), { ssh, kind: 'linear', ref: 'ABC-12' });
  assert.equal(proof.ok, true);
  assert.match(proof.notes.join('\n'), /answered nothing — that ground is unproven/);
});

test('a tracker that answers something else refuses, echoing what came back', () => {
  const { ssh } = fakeSsh({ tracker: ok('{"ok":false,"error":{"code":"linear_not_connected"}}') });
  const proof = proveHost(fullHost(), { ssh, kind: 'linear', ref: 'ABC-12' });
  assert.equal(proof.ok, false);
  assert.match(proof.reason, /linear_not_connected/);
  assert.match(proof.reason, /plan from the brief alone/);
});

// The identifier is read out of the RECEIPT, never matched anywhere in the reply:
// an error object quoting the ticket id is not the ticket answering, and a ref
// carrying a `.` used to make the match a wildcard — probing `ABC.1` accepted an
// answer identifying `ABCX1` as the ticket echoing back. A different ticket read
// as proof that the child can open its own is the one outcome that must refuse.
test('the identifier is read from the receipt, so a near-miss ticket still refuses', () => {
  const { ssh } = fakeSsh({ tracker: ok('{"ok":true,"result":{"issue":{"identifier":"ABCX1"}}}') });
  const proof = proveHost(fullHost(), { ssh, kind: 'linear', ref: 'ABC.1' });
  assert.equal(proof.ok, false);
  assert.match(proof.reason, /ABCX1/);
});

// Linear only: `gh issue view` needs a repository context, and before placement
// there is no checkout on that host to give it one.
test('a github ref is not probed on the host at all', () => {
  const { ssh, asked } = fakeSsh({ tracker: ok('{"ok": false}') });
  const proof = proveHost(fullHost(), { ssh, kind: 'github', ref: '412' });
  assert.equal(proof.ok, true);
  assert.ok(!asked.includes('tracker'));
});

// ── which host, and which repository on it ────────────────────────────────────

// Dispatching to an undeclared host is how a floor goes unmeasured.
test('an environment the project never declared is refused, naming what to declare', () => {
  const config = { dispatch: { hosts: { built: { ssh: 'ground' } } } };
  const refusal = hostFor(config, 'elsewhere');
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /dispatch\.hosts\.elsewhere/);
  assert.match(refusal.reason, /'built'/);
});

test('a declared host comes back exactly as declared, with nothing invented', () => {
  const host = { ssh: 'ground', diskPath: '/data', diskFloorGb: 10 };
  assert.deepEqual(hostFor({ dispatch: { hosts: { built: host } } }, 'built'), { ok: true, host });
});

test('a host declared without an ssh target is refused: every ground is read over ssh', () => {
  const refusal = hostFor({ dispatch: { hosts: { built: { diskPath: '/data' } } } }, 'built');
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /declares no ssh target/);
});

/** An Orca runner in the shape `createRunner` returns. */
const fakeRun = repos => () => ({ status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { repos } } });

// Matched on the path, never on `displayName`, which an operator renames in the
// UI without anything noticing.
test('the repo id is matched on the last path segment, not on displayName', () => {
  const run = fakeRun([
    { id: 'wrong-uuid', displayName: 'acme', path: '/srv/orca/other' },
    { id: 'right-uuid', displayName: 'renamed in the UI', path: '/srv/orca/acme/' },
  ]);
  assert.deepEqual(repoIdFor('/Users/me/code/acme', { run, env: 'built' }), { ok: true, id: 'id:right-uuid' });
});

// An id guessed here creates a worktree in the wrong repository on another
// machine, which is the one mistake no local check catches afterwards.
test('no repository of that name is a refusal, not a guess', () => {
  const run = fakeRun([{ id: 'u1', path: '/srv/orca/other' }]);
  const refusal = repoIdFor('acme', { run, env: 'built' });
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /no repository named 'acme' on 'built'/);
  assert.match(refusal.reason, /--repo-id/);
});

test('two repositories of that name is a refusal, not a first hit', () => {
  const run = fakeRun([
    { id: 'u1', path: '/srv/orca/acme' },
    { id: 'u2', path: '/home/agents/acme' },
  ]);
  const refusal = repoIdFor('acme', { run, env: 'built' });
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /2 repositories named 'acme'/);
});

test('an unlistable environment refuses with the command that lists it', () => {
  const run = () => ({ status: 1, stdout: '', stderr: 'unknown environment\n', receipt: { unparseable: '' } });
  const refusal = repoIdFor('acme', { run, env: 'built' });
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /orca repo list --environment built --json/);
});

// ── the ssh boundary ─────────────────────────────────────────────────────────

// An argv array stops NEITHER injection that lives here, and both are reachable
// from `ax.config.json` — which in a client repository is a file a pull request
// can change. That is the threat: not a hostile operator, a hostile diff.
test('a target that would be read as a local ssh option is refused, not passed', () => {
  // `ssh -oProxyCommand=… host` executes that command on THIS machine, before
  // any connection exists. So the target grammar is closed.
  const calls = [];
  const ssh = args => (calls.push(args), ok(''));
  const proof = proveHost({ ssh: '-oProxyCommand=touch /tmp/pwned', diskPath: '/data', diskFloorGb: 10 }, { ssh });

  assert.deepEqual(calls, [], 'nothing is handed to ssh at all');
  assert.match(proof.notes.join('\n'), /could not be read over ssh/);
  assert.match(proof.notes.join('\n'), /LOCAL ssh option/);
});

test('every value that crosses into the remote shell is quoted', () => {
  // ssh REJOINS its arguments into one string and hands it to a remote shell, so
  // a path interpolated into that command is program text, not data.
  const { ssh, calls } = fakeSsh();
  proveHost(
    fullHost({
      diskPath: '/data; touch /tmp/pwned',
      cgroup: '/sys/fs/cgroup/x; touch /tmp/pwned',
      sweep: ['reap', ';', 'touch', '/tmp/pwned'],
    }),
    { ssh, kind: 'linear', ref: 'ABC-12' },
  );

  const sent = calls.map(argv => argv.join(' ')).join('\n');
  assert.ok(sent.includes("'/data; touch /tmp/pwned'"), 'the mount is one quoted word');
  assert.ok(sent.includes("'/sys/fs/cgroup/x; touch /tmp/pwned/memory.current'"), 'each cgroup file is one quoted word');
  assert.ok(sent.includes("';'"), 'a sweep argument that looks like a separator is quoted as data');
  for (const argv of calls) {
    assert.equal(argv[0], '-o');
    assert.equal(argv[2], '--', 'option parsing is ended before the target');
    assert.equal(argv[3], 'ground');
  }
});

test('a ground whose transport failed is unproven, however plausible its output looks', () => {
  // A non-zero ssh with numeric text on stdout is not a measurement: reading it
  // as one lets a broken transport manufacture headroom.
  const { ssh } = fakeSsh({ df: { status: 255, stdout: '999G\n', stderr: 'connection closed' } });
  const proof = proveHost(fullHost(), { ssh });

  assert.equal(proof.ok, true, 'a transport change never blocks remote work');
  assert.match(proof.notes.join('\n'), /could not be read over ssh/);
  assert.ok(proof.unproven >= 1, 'and it is counted as unproven rather than passed');
});

test('the dry-run mode says it would sweep, and sweeps nothing', () => {
  const { ssh, asked } = fakeSsh();
  const proof = proveHost(fullHost(), { ssh, sweep: false });

  assert.ok(!asked.includes('sweep'), 'a preview that reclaims processes on another machine is not a preview');
  assert.match(proof.notes.join('\n'), /would sweep stale browsers/);
});
