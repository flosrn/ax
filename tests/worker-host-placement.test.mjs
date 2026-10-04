// Host placement by Slots (`src/worker/host-placement.mjs`): which compute host
// a remote dispatch lands on — the one with the most Slots when no `--on` names
// it, the named host alone when one does — and why every other host was passed
// over. The capacity report is HarnessOS's (`bun scripts/capacity.ts --json`);
// this suite builds against a fixture of that contract, with the host grounds,
// the repository lookup, the host lock and the live-pane count injected — no
// host, no ssh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { capacityOf, harnessosSource, hostDeclarations, hostSlots, hosts, placeHost, slotsOf } from '../src/worker/host-placement.mjs';

/** One capacity entry, eligible and roomy unless a test says otherwise. */
function host(name, { freeMb = 8000, maxMb = 12288, freePercent = 600, maxWorkers = 8, footprint = { memoryMb: 1000, cpuPercent: 100 }, ...rest } = {}) {
  return {
    host: name,
    state: 'ok',
    eligible: true,
    reasons: [],
    cordoned: false,
    declaration: { ssh: name, cgroup: '/sys/fs/cgroup/user.slice/user-1001.slice', diskPath: '/home/harness', diskFloorGb: 20, memFreeFloorMb: 1500 },
    maxWorkers,
    footprint,
    memory: { maxMb, workMb: maxMb - freeMb, freeMb, hostAvailableMb: 20000, peakMb: null },
    oom: { killCount: 0, acknowledged: null, acknowledgedAt: null, baseline: 0 },
    cpu: { quotaPercent: 600, usedPercent: 600 - freePercent, freePercent, pressureSomeAvg10: 0.5, stallThreshold: 40 },
    disk: { path: '/home/harness', availGb: 120 },
    orcaServeRssMb: 300,
    gateway: { surface: `omp-${name}`, healthy: true, observedAt: '2026-09-26T08:00:00Z', detail: 'ok' },
    ...rest,
  };
}

const capacity = (...hosts) => ({ observedAt: '2026-09-26T08:00:00Z', hosts });

/** A placement where every ground passes unless a test injects otherwise. */
function place(report, { live = {}, repos = {}, proofs = {}, overrides = {}, only = '', lock = null } = {}) {
  const proved = [];
  const result = placeHost({
    capacity: report,
    declarations: hostDeclarations(report, overrides),
    liveOn: name => live[name] ?? { live: 0, unmeasured: 0 },
    repoFor: name => repos[name] ?? { ok: true, id: `id:repo-${name}` },
    prove: (name, declaration) => {
      proved.push(name);
      return proofs[name] ?? { ok: true, notes: [`proved ${declaration.ssh}`], unproven: 0 };
    },
    only,
    lock,
  });
  return { ...result, proved };
}

const reasonOf = (result, name) => result.skipped.find(row => row.host === name)?.reason ?? '';

// ── AE4 ──────────────────────────────────────────────────────────────────────

test('AE4: gapicore at 2 free slots and netcup-vie at 5 — the worker goes to netcup-vie', () => {
  const r = place(capacity(host('gapicore', { freeMb: 2000 }), host('netcup-vie', { freePercent: 500 })));

  assert.equal(r.ok, true);
  assert.equal(r.host, 'netcup-vie');
  assert.equal(r.repoId, 'id:repo-netcup-vie');
  assert.deepEqual(r.proved, ['netcup-vie'], 'the freest host is proven first, and the runner-up is not asked');
  assert.ok(r.lines.some(line => /gapicore.*2 free slot/.test(line)), r.lines.join('\n'));
  assert.ok(r.lines.some(line => /netcup-vie.*5 free slot/.test(line)), r.lines.join('\n'));
});

test('AE4: both hosts cordoned — refused with each host named, nothing proven', () => {
  const r = place(capacity(host('gapicore', { cordoned: true, eligible: false, reasons: ['cordoned'] }), host('netcup-vie', { cordoned: true, eligible: false, reasons: ['cordoned'] })));

  assert.equal(r.ok, false);
  assert.deepEqual(r.proved, []);
  assert.match(reasonOf(r, 'gapicore'), /cordoned/);
  assert.match(reasonOf(r, 'netcup-vie'), /cordoned/);
});

// ── the slot formula ─────────────────────────────────────────────────────────

test('slots are the tightest of memory, CPU and maxWorkers minus the live panes on that host', () => {
  // memory 8, cpu 6, workers 8 - 5 live = 3 → 3; the other host has 4 by CPU.
  const r = place(capacity(host('gapicore', { freeMb: 8000, freePercent: 600, maxWorkers: 8 }), host('netcup-vie', { freeMb: 9000, freePercent: 450, maxWorkers: 8 })), {
    live: { gapicore: { live: 5, unmeasured: 0 } },
  });

  assert.equal(r.host, 'netcup-vie');
  assert.ok(r.lines.some(line => /gapicore.*3 free slot/.test(line)), r.lines.join('\n'));
  assert.ok(r.lines.some(line => /netcup-vie.*4 free slot/.test(line)), r.lines.join('\n'));
});

test('a full host is floored at zero slots and skipped, never chosen', () => {
  const r = place(capacity(host('gapicore', { maxWorkers: 2 })), { live: { gapicore: { live: 3, unmeasured: 0 } } });

  assert.equal(r.ok, false);
  assert.match(reasonOf(r, 'gapicore'), /no free slot/);
});

test('equal slots are broken by capacity order', () => {
  const r = place(capacity(host('netcup-vie'), host('gapicore')));

  assert.equal(r.host, 'netcup-vie');
});

test('a host whose live panes could not be counted is skipped, not counted as empty', () => {
  const r = place(capacity(host('gapicore', { freeMb: 12000 }), host('netcup-vie', { freeMb: 2000 })), {
    live: { gapicore: { live: 0, unmeasured: 1 } },
  });

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /cannot be counted/);
});

// ── #271: a live worker reserves its footprint ───────────────────────────────
// Free memory is read NOW, and a live worker in a quiet phase holds almost none
// of it — so free memory alone reads that worker's host as room for a second
// one, whose peak then lands on top of the first's inside one slice.

/** The issue's gapicore: slice 3459/16384 MB held, 12924 MB free, footprint 12500 MB. */
const quiet = (name, extra = {}) =>
  host(name, { maxMb: 16384, freeMb: 12924, footprint: { memoryMb: 12500, cpuPercent: 100 }, maxWorkers: 4, ...extra });

test('#271: one live worker on a 16384 MB slice with a 12500 MB footprint leaves 0 memory slots, so the worker goes elsewhere', () => {
  const r = place(capacity(quiet('gapicore'), quiet('netcup-vie', { freeMb: 16000, maxWorkers: 3 })), {
    live: { gapicore: { live: 1, unmeasured: 0 } },
  });

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /no free slot \(memory 0 /);
  assert.deepEqual(r.proved, ['netcup-vie'], 'the host whose slice a live worker reserves is never proven');
});

test('#271: with no other host, the reserved slice refuses the dispatch by that reason', () => {
  const r = place(capacity(quiet('gapicore')), { live: { gapicore: { live: 1, unmeasured: 0 } } });

  assert.equal(r.ok, false);
  assert.match(reasonOf(r, 'gapicore'), /memory 0 .*16384 MB slice.*1 live/);
});

test('#271: the same host with no live worker still takes one', () => {
  const r = place(capacity(quiet('gapicore')));

  assert.equal(r.host, 'gapicore');
});

test('#271: a report with no slice maximum cannot reserve a live worker, and says so rather than reading free memory', () => {
  const r = place(capacity(host('gapicore', { memory: { workMb: 3459, freeMb: 12924, hostAvailableMb: 20000 } }), host('netcup-vie', { freeMb: 2000 })));

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /unverified.*memory\.maxMb/);
});

// ── KTD2: the host's reach bounds the slice ─────────────────────────────────
// The memory the host can still give the slice is what the slice holds plus
// what the host has available, and every live worker reserves a footprint of
// it — a slice cap larger than the host's free memory admits nobody it cannot
// hold.

test('AE5: the terms are memory min(2, 6, 1), CPU 3, workers 4, and the Slots are 1', () => {
  const entry = host('gapicore', {
    maxMb: 8000,
    freePercent: 300,
    maxWorkers: 6,
    memory: { maxMb: 8000, workMb: 500, freeMb: 5500, hostAvailableMb: 2500, peakMb: null },
  });
  const terms = slotsOf(entry, 2);

  assert.equal(terms.byFree, 2, 'floor(min(5500 free, 2500 host available) / 1000)');
  assert.equal(terms.bySlice, 6, 'floor(8000 / 1000) - 2 live');
  assert.equal(terms.byReach, 1, 'floor((500 held + 2500 host available) / 1000) - 2 live');
  assert.equal(terms.memory, 1, 'memory is the least of the three');
  assert.equal(terms.byCpu, 3, 'floor(300 / 100)');
  assert.equal(terms.byWorkers, 4, '6 - 2 live');
  assert.equal(terms.slots, 1);
});

test('AE6: a 32768 MB slice on a host that can reach 17768 MB holds one 12500 MB worker, so one live worker leaves 0 Slots', () => {
  const entry = host('gapicore', {
    maxWorkers: 8,
    footprint: { memoryMb: 12500, cpuPercent: 100 },
    memory: { maxMb: 32768, workMb: 2768, freeMb: 30000, hostAvailableMb: 15000, peakMb: null },
  });
  const terms = slotsOf(entry, 1);

  assert.equal(terms.byFree, 1, 'floor(min(30000, 15000) / 12500)');
  assert.equal(terms.bySlice, 1, 'floor(32768 / 12500) - 1 live');
  assert.equal(terms.byReach, 0, 'floor((2768 + 15000) / 12500) - 1 live');
  assert.equal(terms.slots, 0);
  const r = place(capacity(entry), { live: { gapicore: { live: 1, unmeasured: 0 } } });
  assert.equal(r.ok, false);
  assert.match(reasonOf(r, 'gapicore'), /no free slot \(memory 0 .*2768 MB held \+ 15000 MB host available/);
});

test('#271 under KTD2: max 16384, fp 12500 and one live worker still give 0', () => {
  assert.equal(slotsOf(quiet('gapicore'), 1).slots, 0);
  assert.equal(slotsOf(quiet('gapicore'), 1).bySlice, 0);
});

// ── KTD4: every entry is validated before it is used ────────────────────────

test('a NaN free memory is a named unverified skip, and another host is still chosen', () => {
  const r = place(capacity(host('gapicore', { memory: { maxMb: 12288, workMb: 1000, freeMb: Number.NaN, hostAvailableMb: 20000 } }), host('netcup-vie', { freeMb: 2000 })));

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /unverified.*memory\.freeMb/);
  assert.deepEqual(r.proved, ['netcup-vie']);
});

test('a host name the report carries twice is unverified, never one of the two entries', () => {
  const r = place(capacity(host('gapicore', { freeMb: 9000 }), host('gapicore', { freeMb: 1000 }), host('netcup-vie', { freeMb: 2000 })));

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /unverified.*gapicore.*2 times/);
  assert.equal(r.skipped.filter(row => row.host === 'gapicore').length, 1, 'named once');
});

test('AE9: an entry without oom is unverified, never eligible with zero kills', () => {
  const missing = host('gapicore', { freeMb: 9000 });
  delete missing.oom;
  const r = place(capacity(missing, host('netcup-vie', { freeMb: 2000 })));

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /unverified.*\boom\b/);
  assert.deepEqual(r.proved, ['netcup-vie']);
});

test('a malformed oom field is unverified with the field named', () => {
  for (const [field, oom] of [
    ['oom.killCount', { killCount: 1.5, acknowledged: null, acknowledgedAt: null, baseline: 0 }],
    ['oom.baseline', { killCount: 0, acknowledged: null, acknowledgedAt: null }],
    ['oom.acknowledged', { killCount: 2, acknowledged: 'two', acknowledgedAt: null, baseline: 0 }],
    ['oom.acknowledgedAt', { killCount: 2, acknowledged: 2, acknowledgedAt: 'yesterday', baseline: 2 }],
  ]) {
    const r = place(capacity(host('gapicore', { oom })));
    assert.equal(r.ok, false, field);
    assert.match(reasonOf(r, 'gapicore'), new RegExp(`unverified.*${field.replace('.', '\\.')}`), field);
  }
  const r = place(capacity(host('gapicore', { oom: null })));
  assert.match(reasonOf(r, 'gapicore'), /unverified.*\boom\b/);
});

test('an OOM ineligibility arrives through the eligibility fields, and an acknowledged count is admitted', () => {
  const blocked = place(capacity(host('gapicore', { eligible: false, state: 'ineligible', reasons: ['oom_kill 2 since no acknowledgement (baseline 0)'], oom: { killCount: 2, acknowledged: null, acknowledgedAt: null, baseline: 0 } })));
  assert.equal(blocked.ok, false);
  assert.match(reasonOf(blocked, 'gapicore'), /oom_kill 2 since no acknowledgement \(baseline 0\)/);

  const acked = place(capacity(host('gapicore', { oom: { killCount: 2, acknowledged: 2, acknowledgedAt: '2026-10-04T09:00:00Z', baseline: 2 } })));
  assert.equal(acked.host, 'gapicore');
});

test('memory.peakMb is display-only: absent or malformed, it gates nothing', () => {
  const absent = host('gapicore');
  delete absent.memory.peakMb;
  assert.equal(place(capacity(absent)).host, 'gapicore');
  assert.equal(place(capacity(host('gapicore', { memory: { maxMb: 12288, workMb: 4288, freeMb: 8000, hostAvailableMb: 20000, peakMb: 'lots' } }))).host, 'gapicore');
});

// ── occupancy is not an unasked host ────────────────────────────────────────

test('an occupied recorded worktree names the occupying handle, not "could not be asked"', () => {
  const r = place(capacity(host('gapicore', { freeMb: 9000 }), host('netcup-vie', { freeMb: 2000 })), {
    live: {
      gapicore: {
        live: 0,
        unmeasured: 1,
        occupancy: [{ handle: 'term_old', tree: '/home/harness/w/7-work', records: ['7-work.json'], extras: ['term_setup'] }],
      },
    },
  });

  assert.equal(r.host, 'netcup-vie');
  const reason = reasonOf(r, 'gapicore');
  assert.match(reason, /\/home\/harness\/w\/7-work/);
  assert.match(reason, /term_setup/);
  assert.match(reason, /orca terminal show --terminal term_setup --json/);
  assert.doesNotMatch(reason, /could not be asked/);
});

// ── a named host is the only host (KTD10) ───────────────────────────────────

test('AE1: a named cordoned host is refused by its cordon, and no other host is tried', () => {
  const r = place(capacity(host('gapicore', { cordoned: true, eligible: false, reasons: ['cordoned'] }), host('netcup-vie', { freeMb: 9000 })), { only: 'gapicore' });

  assert.equal(r.ok, false);
  assert.match(reasonOf(r, 'gapicore'), /cordoned/);
  assert.deepEqual(r.proved, [], 'neither the named host nor any other is proven');
  assert.equal(reasonOf(r, 'netcup-vie'), '', 'the other host is not even judged');
  assert.ok(r.lines.every(line => !line.includes('netcup-vie')), r.lines.join('\n'));
});

test('a named host with a Slot is the host, even beside a freer one', () => {
  const r = place(capacity(host('gapicore', { freeMb: 2000 }), host('netcup-vie', { freeMb: 9000 })), { only: 'gapicore' });

  assert.equal(r.host, 'gapicore');
  assert.deepEqual(r.proved, ['gapicore']);
});

test('a named host the report does not carry cannot be measured, so it is refused', () => {
  const r = place(capacity(host('netcup-vie')), { only: 'far' });

  assert.equal(r.ok, false);
  assert.match(reasonOf(r, 'far'), /not in the capacity report/);
  assert.deepEqual(r.proved, []);
});

// ── KTD3: the host lock, and the Slots re-read under it ─────────────────────

test('Slots are re-read under the host lock, and a host whose last Slot went meanwhile is released and skipped', () => {
  const released = [];
  // gapicore reads 2 Slots and is tried first; under its lock the count says
  // both went meanwhile, so it is passed over for netcup-vie's one.
  const r = place(capacity(host('gapicore', { maxWorkers: 2 }), host('netcup-vie', { freeMb: 1000 })), {
    lock: name => ({
      held: true,
      release: () => released.push(name),
      count: name === 'gapicore' ? { live: 2, unmeasured: 0 } : { live: 0, unmeasured: 0 },
    }),
  });

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /no free slot.*host lock/);
  assert.deepEqual(released, ['gapicore'], 'the lock of the host passed over is released; the chosen one stays held');
  assert.deepEqual(r.proved, ['netcup-vie']);
  r.release();
  assert.deepEqual(released, ['gapicore', 'netcup-vie']);
});

test('a host lock that cannot be taken skips that host with the lock named, and a failed proof releases it', () => {
  const released = [];
  const r = place(capacity(host('gapicore', { freeMb: 9000 }), host('netcup-vie', { freeMb: 5000 }), host('extra', { freeMb: 2000 })), {
    lock: name => (name === 'gapicore' ? { held: false, reason: 'pre-existing lock belongs to gapicore pid 7' } : { held: true, release: () => released.push(name), count: { live: 0, unmeasured: 0 } }),
    proofs: { 'netcup-vie': { ok: false, reason: 'only 3G free', notes: [] } },
  });

  assert.equal(r.host, 'extra');
  assert.match(reasonOf(r, 'gapicore'), /lock.*pid 7/);
  assert.deepEqual(released, ['netcup-vie'], 'a proof that failed gives its lock back');
});

test('hostSlots computes one line per reported host, and a named host alone when one is named', () => {
  const report = capacity(host('gapicore'), host('netcup-vie'));
  assert.equal(hostSlots({ capacity: report, liveOn: () => ({ live: 0, unmeasured: 0 }) }).lines.length, 2);
  assert.equal(hostSlots({ capacity: report, liveOn: () => ({ live: 0, unmeasured: 0 }), only: 'netcup-vie' }).lines.length, 1);
});

// ── `ax worker hosts [<host>]` (U5, R9) ─────────────────────────────────────

/** A checkout whose ax.config.json declares `old-box`, a host the report does not carry. */
function checkout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-hosts-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(
    join(dir, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', hosts: { 'old-box': { ssh: 'old-box' } } } }),
  );
  return dir;
}

/** What the verb printed on either stream, its exit code, and every Orca call it made. */
function read(argv, report) {
  const calls = [];
  const runner = args => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return { status: 0, receipt: { ok: true, result: { runtime: { reachable: true } } }, stderr: '' };
    if (args[0] === 'terminal' && args[1] === 'list') return { status: 0, receipt: { ok: true, result: { terminals: [], hostScope: { hostIds: ['local'], omittedHostIds: [] } } }, stderr: '' };
    return { status: 1, receipt: { ok: false }, stderr: `unexpected ${args.join(' ')}` };
  };
  const store = realpathSync(mkdtempSync(join(tmpdir(), 'ax-hosts-store-')));
  const written = [];
  const real = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = process.stderr.write = chunk => (written.push(String(chunk)), true);
  let code;
  try {
    code = hosts(argv, { runner, env: { HOME: store, ORCA_DISPATCH_STORE: store, HARNESSOS_SOURCE: '/src/harnessos' }, cwd: checkout(), capacity: () => ({ ok: true, capacity: report }) });
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }
  return { code, out: written.join(''), calls };
}

/** The lines printed from one host's line up to the next host's. */
function blockOf(out, name) {
  const lines = out.split('\n');
  const start = lines.findIndex(line => line.includes(`host '${name}'`));
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /host '/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

const acknowledged = { killCount: 2, acknowledged: 2, acknowledgedAt: '2026-10-04T09:00:00Z', baseline: 2 };

test('hosts lists every host, a cordoned one with its Slots terms, memory, OOM and reason', () => {
  const cordoned = host('gapicore', { cordoned: true, eligible: false, reasons: ['cordoned'], oom: acknowledged });
  cordoned.memory.peakMb = 16384;
  const r = read([], capacity(cordoned, host('netcup-vie', { freeMb: 3000 })));

  assert.equal(r.code, 0, r.out);
  const gapicore = blockOf(r.out, 'gapicore');
  assert.match(gapicore, /Slots 0 offered; by its terms it would hold 6 \(memory 8 /);
  assert.match(gapicore, /slice max 12288 MB, held 4288 MB, free 8000 MB, peak 16384 MB/);
  assert.match(gapicore, /host available 20000 MB/);
  assert.match(gapicore, /oom_kill 2 against baseline 2, acknowledged 2 at 2026-10-04T09:00:00Z/);
  assert.match(gapicore, /no Slot: cordoned — bun scripts\/capacity\.ts uncordon gapicore/);
  const netcup = blockOf(r.out, 'netcup-vie');
  assert.match(netcup, /host 'netcup-vie': 3 free slot\(s\) \(memory 3 /);
  assert.match(netcup, /slice max 12288 MB, held 9288 MB, free 3000 MB, peak unavailable/);
  assert.match(netcup, /oom_kill 0 against baseline 0, no acknowledgement/);
  assert.doesNotMatch(netcup, /no Slot:/);
});

test('hosts gapicore shows only gapicore', () => {
  const r = read(['gapicore'], capacity(host('gapicore'), host('netcup-vie')));

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /host 'gapicore': 6 free slot\(s\)/);
  assert.doesNotMatch(r.out, /netcup-vie/);
});

test('hosts typo is refused with the known names, before any Orca read', () => {
  const r = read(['typo'], capacity(host('gapicore'), host('netcup-vie')));

  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /'typo' is neither in the capacity report nor in this checkout's dispatch\.hosts/);
  assert.match(r.out, /known hosts: gapicore, netcup-vie, old-box/);
  assert.deepEqual(r.calls, []);
});

test('a declared host the report does not carry says why it offers no Slot', () => {
  const r = read(['old-box'], capacity(host('gapicore')));

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /host 'old-box' skipped: not in the capacity report/);
  assert.match(r.out, /no Slot: not in the capacity report/);
  assert.doesNotMatch(r.out, /gapicore/);
});

test('peak unavailable is shown as such, and the host still offers Slots', () => {
  const malformed = host('gapicore');
  malformed.memory.peakMb = 'lots';
  const r = read(['gapicore'], capacity(malformed));

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /host 'gapicore': 6 free slot\(s\)/);
  assert.match(r.out, /peak unavailable/);
});

test('an unverified host shows the metrics the report has, and its missing OOM counter as unreported', () => {
  const unverified = host('gapicore');
  delete unverified.oom;
  const r = read([], capacity(unverified));

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /slice max 12288 MB, held 4288 MB, free 8000 MB, peak unavailable/);
  assert.match(r.out, /oom_kill unreported/);
  assert.match(r.out, /no Slot: unverified — oom is missing/);
});

test('hosts takes at most one host and no flag', () => {
  assert.equal(read(['gapicore', 'netcup-vie'], capacity(host('gapicore'))).code, 2);
  assert.equal(read(['--on'], capacity(host('gapicore'))).code, 2);
});

// ── scenario 2: grounds past capacity ────────────────────────────────────────

test('a host that fails proveHost is skipped with its reason, and the next host is proven', () => {
  const r = place(capacity(host('gapicore', { freeMb: 5000 }), host('netcup-vie', { freeMb: 3000 })), {
    proofs: { gapicore: { ok: false, reason: 'only 3G free on /home/harness', notes: [] } },
  });

  assert.equal(r.host, 'netcup-vie');
  assert.deepEqual(r.proved, ['gapicore', 'netcup-vie']);
  assert.match(reasonOf(r, 'gapicore'), /only 3G free/);
});

test('an unhealthy or unprobed gateway surface skips the host with its reason', () => {
  const r = place(
    capacity(
      host('gapicore', { freeMb: 7000, gateway: { surface: 'omp-gapicore', healthy: false, observedAt: '2026-09-26T08:00:00Z', detail: 'HTTP 502' } }),
      host('extra', { freeMb: 6000, gateway: null }),
      host('netcup-vie', { freeMb: 2000 }),
    ),
  );

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /omp-gapicore.*HTTP 502/);
  assert.match(reasonOf(r, 'extra'), /no gateway probe/);
  assert.deepEqual(r.proved, ['netcup-vie'], 'a gateway refusal spends no ssh round trip');
});

test('a host whose Orca environment lacks the repository is skipped with its reason', () => {
  const r = place(capacity(host('gapicore', { freeMb: 5000 }), host('netcup-vie', { freeMb: 3000 })), {
    repos: { gapicore: { ok: false, reason: "no repository named 'widgets' on 'gapicore'" } },
  });

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /no repository named 'widgets'/);
  assert.deepEqual(r.proved, ['netcup-vie'], 'a host without the repository is never proven');
});

test('an ineligible or unverified host is skipped with the reasons capacity gave', () => {
  const r = place(
    capacity(
      host('gapicore', { eligible: false, reasons: ['cpu pressure 55 above stall threshold 40'] }),
      host('netcup-vie', { state: 'unverified', eligible: false, reasons: ['no recorded worker footprint'], footprint: null }),
    ),
  );

  assert.equal(r.ok, false);
  assert.match(reasonOf(r, 'gapicore'), /cpu pressure 55/);
  assert.match(reasonOf(r, 'netcup-vie'), /no recorded worker footprint/);
});

// ── declarations ─────────────────────────────────────────────────────────────

test('a declaration comes from capacity, and dispatch.hosts overrides it per field', () => {
  const report = capacity(host('netcup-vie'), host('gapicore'));
  const decl = hostDeclarations(report, { 'netcup-vie': { ssh: 'netcup-vie', memFreeFloorMb: 3000, sweep: ['ax', 'worker', 'sweep'] } });

  assert.deepEqual(decl['netcup-vie'], {
    ssh: 'netcup-vie',
    cgroup: '/sys/fs/cgroup/user.slice/user-1001.slice',
    diskPath: '/home/harness',
    diskFloorGb: 20,
    memFreeFloorMb: 3000,
    sweep: ['ax', 'worker', 'sweep'],
  });
  assert.equal(decl.gapicore.memFreeFloorMb, 1500);
  assert.equal(Object.hasOwn(decl, 'far'), false, 'an override for a host capacity does not report adds no candidate');
});

// ── the capacity report ──────────────────────────────────────────────────────

test('HARNESSOS_SOURCE names the checkout before dispatch.harnessos, and neither is a named inability', () => {
  assert.deepEqual(harnessosSource({ env: { HARNESSOS_SOURCE: '/a' }, config: { dispatch: { harnessos: '/b' } } }), { ok: true, path: '/a' });
  assert.deepEqual(harnessosSource({ env: { HOME: '/home/flo' }, config: { dispatch: { harnessos: '~/Code/harnessos' } } }), { ok: true, path: '/home/flo/Code/harnessos' });
  const none = harnessosSource({ env: {}, config: {} });
  assert.equal(none.ok, false);
  assert.match(none.reason, /HARNESSOS_SOURCE/);
  assert.match(none.repair, /dispatch.*harnessos/);
});

test('the capacity report is read with bun from that checkout, and a failed or malformed read is an inability', () => {
  const calls = [];
  const good = capacityOf({
    source: '/src/harnessos',
    run: (bin, args, options) => {
      calls.push([bin, ...args, options.cwd].join(' '));
      return { status: 0, stdout: JSON.stringify(capacity(host('gapicore'))), stderr: '' };
    },
  });
  assert.equal(good.ok, true);
  assert.equal(good.capacity.hosts[0].host, 'gapicore');
  assert.deepEqual(calls, ['bun /src/harnessos/scripts/capacity.ts --json /src/harnessos']);

  const failed = capacityOf({ source: '/src/harnessos', run: () => ({ status: 1, stdout: '', stderr: 'ssh: gapicore unreachable\n' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /gapicore unreachable/);

  const garbled = capacityOf({ source: '/src/harnessos', run: () => ({ status: 0, stdout: '{"hosts":', stderr: '' }) });
  assert.equal(garbled.ok, false);
  assert.match(garbled.reason, /not JSON/);

  const shapeless = capacityOf({ source: '/src/harnessos', run: () => ({ status: 0, stdout: '{"observedAt":"x"}', stderr: '' }) });
  assert.equal(shapeless.ok, false, 'an absent host list is unknown, never an empty fleet (F-028)');
});
