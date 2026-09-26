// Host placement by capacity (`src/worker/host-placement.mjs`): which compute
// host a dispatch with no `--on` lands on, and why every other host was passed
// over. The capacity report is HarnessOS's (`bun scripts/capacity.ts --json`);
// this suite builds against a fixture of that contract, with the host grounds,
// the repository lookup and the live-pane count injected — no host, no ssh.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capacityOf, harnessosSource, hostDeclarations, placeHost } from '../src/worker/host-placement.mjs';

/** One capacity entry, eligible and roomy unless a test says otherwise. */
function host(name, { freeMb = 8000, freePercent = 600, maxWorkers = 8, footprint = { memoryMb: 1000, cpuPercent: 100 }, ...rest } = {}) {
  return {
    host: name,
    state: 'ok',
    eligible: true,
    reasons: [],
    cordoned: false,
    declaration: { ssh: name, cgroup: '/sys/fs/cgroup/user.slice/user-1001.slice', diskPath: '/home/harness', diskFloorGb: 20, memFreeFloorMb: 1500 },
    maxWorkers,
    footprint,
    memory: { maxMb: 12288, workMb: 12288 - freeMb, freeMb, hostAvailableMb: 20000 },
    cpu: { quotaPercent: 600, usedPercent: 600 - freePercent, freePercent, pressureSomeAvg10: 0.5, stallThreshold: 40 },
    disk: { path: '/home/harness', availGb: 120 },
    orcaServeRssMb: 300,
    gateway: { surface: `omp-${name}`, healthy: true, observedAt: '2026-09-26T08:00:00Z', detail: 'ok' },
    ...rest,
  };
}

const capacity = (...hosts) => ({ observedAt: '2026-09-26T08:00:00Z', hosts });

/** A placement where every ground passes unless a test injects otherwise. */
function place(report, { live = {}, repos = {}, proofs = {}, overrides = {} } = {}) {
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
  const r = place(capacity(host('gapicore', { freeMb: 20000 }), host('netcup-vie', { freeMb: 2000 })), {
    live: { gapicore: { live: 0, unmeasured: 1 } },
  });

  assert.equal(r.host, 'netcup-vie');
  assert.match(reasonOf(r, 'gapicore'), /cannot be counted/);
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
