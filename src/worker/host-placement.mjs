// Which compute host a dispatch with no `--on` lands on (plan 2026-09-26-001,
// U10), and how many free slots each host has. Worktree placement ON a host is
// ./placement.mjs; this module only chooses the host.
//
// HARNESSOS MEASURES HEADROOM, AX COMPUTES SLOTS (KTD9). `bun scripts/capacity.ts
// --json` in the HarnessOS checkout reports, per compute host, the harness
// slice's maximum and free memory and its free CPU, the measured per-worker
// footprint, `maxWorkers`, the cordon, the eligibility verdict with its
// reasons, and the host's latest gateway probe. The live-worker count is not in
// that report: AX's only reader of it is `livePanes` (./slots.mjs), so the
// count that fences the repository cap is the count that spends a host's
// worker ceiling. Slots are
//
//   max(0, min(floor(memory.freeMb / footprint.memoryMb),
//              floor(memory.maxMb / footprint.memoryMb) - live,
//              floor(cpu.freePercent / footprint.cpuPercent),
//              maxWorkers - live))
//
// and the most slots wins, ties to the report's order.
//
// A LIVE WORKER RESERVES ITS FOOTPRINT (#271). Free memory is read NOW, and a
// worker in a quiet phase (reading, review, waiting on CI) holds almost none of
// it: free memory alone read gapicore as room for a second 12500 MB worker
// beside a live one in a 16384 MB slice, whose two peaks the slice's OOM killer
// then settles. So the slice maximum is divided among the live workers first,
// and a report that carries no slice maximum is a host whose reservation cannot
// be computed — skipped by name, never answered from free memory (F-028).
//
// `ax worker hosts` prints the same per-host lines without choosing a host:
// `hostSlots` is the one computation, and dispatch and that read both call it,
// over the same live count (`liveCount`, ./slots.mjs). It stops before the
// costly grounds, so it never spends an Orca repository lookup or an ssh proof.
//
// THE MAC IS NEVER A FALLBACK (R10). Placement runs only on the operator Mac —
// detected as HarnessOS's own `localHost` detects it (`scripts/infra.ts`): the
// darwin machine is the operator — and when no host can take the worker the
// dispatch is refused with every host's reason. The Mac receives a worker only
// when the operator names it with `--on here`.
//
// EVERY HOST PASSED OVER SAYS WHY. A cordon, an ineligibility, an unprobed or
// unhealthy gateway, an uncountable host, a full host, a missing repository and
// a failed host ground are each a named skip. The cheap grounds (the report
// itself) are read for every host; the costly ones (an Orca repository lookup
// and `proveHost`'s ssh round trips) are spent in slot order and stop at the
// first host that passes, so a runner-up is never proven for nothing.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { run as execRun } from '../exec.mjs';
import { bad, fix, note, section } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { declarationOf } from './hosts.mjs';
import { terminalInventory } from './pane.mjs';
import { liveCount } from './slots.mjs';

/** The declaration fields a capacity entry carries for `proveHost` (./hosts.mjs). */
const DECLARED = ['ssh', 'cgroup', 'diskPath', 'diskFloorGb', 'memFreeFloorMb'];

/**
 * A capacity read reaches every compute host over ssh from the Mac, where one
 * round trip is budgeted 60 s by HarnessOS itself; the default 30 s of the
 * shared `exec` would cut a healthy read short.
 */
const CAPACITY_TIMEOUT_MS = 180000;

/** Whether this machine is the operator Mac — the only place placement runs. */
export const operatorMac = platform => platform === 'darwin';

/**
 * The HarnessOS checkout to read capacity from: `HARNESSOS_SOURCE` (the
 * machine's answer, set by HarnessOS's own `mise.toml`), else `dispatch.harnessos`
 * in ax.config.json. A leading `~/` is the operator's home.
 */
export function harnessosSource({ env = process.env, config } = {}) {
  const declared = String(env.HARNESSOS_SOURCE ?? '').trim() || String(config?.dispatch?.harnessos ?? '').trim();
  if (declared === '') {
    return {
      ok: false,
      reason: 'a dispatch with no --on is placed by HarnessOS capacity, and neither HARNESSOS_SOURCE nor dispatch.harnessos names a HarnessOS checkout to read it from',
      repair: 'export HARNESSOS_SOURCE=<harnessos checkout>, or ax.config.json: { "dispatch": { "harnessos": "~/Code/flosrn/harnessos" } }   # or name the host with --on',
    };
  }
  const home = env.HOME || homedir();
  return { ok: true, path: declared === '~' ? home : declared.startsWith('~/') ? join(home, declared.slice(2)) : declared };
}

/**
 * The capacity report, or a named inability. A report without a host list is
 * UNKNOWN, never an empty fleet (F-028): an empty list would refuse every
 * dispatch for a reason nobody measured.
 */
export function capacityOf({ source, run = execRun }) {
  const script = join(source, 'scripts', 'capacity.ts');
  const read = `bun ${script} --json`;
  const out = run('bun', [script, '--json'], { cwd: source, timeout: CAPACITY_TIMEOUT_MS });
  if (out.error !== undefined || out.status !== 0) {
    const why = out.error !== undefined && !existsSync(script)
      ? `${script} does not exist, so ${source} is not a HarnessOS checkout that carries the capacity report`
      : String(out.stderr ?? '').trim().split('\n').pop() || String(out.error?.message ?? `exit ${out.status}`);
    return { ok: false, reason: `the capacity report could not be read (${read}): ${why}`, repair: `${read}   # read it by hand, or name the host with --on` };
  }
  let report;
  try {
    report = JSON.parse(out.stdout);
  } catch {
    return { ok: false, reason: `${read} answered something that is not JSON`, repair: `${read}   # read it by hand, or name the host with --on` };
  }
  if (!Array.isArray(report?.hosts)) {
    return { ok: false, reason: `${read} answered no host list, so no compute host can be placed on`, repair: `${read}   # read it by hand, or name the host with --on` };
  }
  return { ok: true, capacity: report };
}

/**
 * Each reported host's declaration: the capacity entry's own (ssh, slice
 * cgroup, disk path and floors), with `dispatch.hosts.<host>` in ax.config.json
 * as this repository's per-field override. An override for a host the report
 * does not carry adds no candidate: capacity decides which hosts exist.
 */
export function hostDeclarations(capacity, overrides = {}) {
  const declarations = {};
  for (const entry of capacity.hosts) {
    const base = {};
    for (const key of DECLARED) if (entry?.declaration?.[key] !== undefined) base[key] = entry.declaration[key];
    declarations[entry.host] = { ...base, ...(overrides?.[entry.host] ?? {}) };
  }
  return declarations;
}

/**
 * The config the live panes are counted with: `dispatch.hosts` widened by the
 * capacity report's declarations, so a pane placed earlier on a host this
 * repository never declared is asked of that host instead of left unaskable.
 */
export const countedConfig = (config, declarations) => ({
  ...config,
  dispatch: { ...(config.dispatch ?? {}), hosts: { ...(config.dispatch?.hosts ?? {}), ...declarations } },
});

/** Why the report itself passes over a host, or '' when it does not. */
function reportSkip(entry) {
  if (entry.cordoned === true) return `cordoned — bun scripts/capacity.ts uncordon ${entry.host} when it may take workers again`;
  if (entry.eligible !== true) {
    const reasons = Array.isArray(entry.reasons) && entry.reasons.length > 0 ? entry.reasons.join('; ') : 'no reason given';
    return `ineligible (${entry.state ?? 'unknown state'}): ${reasons}`;
  }
  if (entry.gateway === null || entry.gateway === undefined) return `no gateway probe for its omp-${entry.host} surface, so a worker there may have no model to answer it`;
  if (entry.gateway.healthy !== true) return `gateway ${entry.gateway.surface} unhealthy: ${entry.gateway.detail || 'no detail'}`;
  if (!entry.footprint || !entry.memory || !entry.cpu) return 'no recorded footprint, memory or CPU reading, so its slots cannot be computed';
  if (!(Number.isFinite(entry.memory.maxMb) && entry.memory.maxMb > 0)) {
    return 'the capacity report carries no slice maximum (memory.maxMb) for it, so the footprint its live workers reserve cannot be computed — free memory alone would read a quiet worker as room (#271, F-028)';
  }
  return '';
}

/** The contract's slot formula, and the terms it took the minimum of. */
function slotsOf(entry, live) {
  const footprint = entry.footprint.memoryMb;
  const byFree = Math.floor(entry.memory.freeMb / footprint);
  const bySlice = Math.floor(entry.memory.maxMb / footprint);
  const byMemory = Math.min(byFree, bySlice - live);
  const byCpu = Math.floor(entry.cpu.freePercent / entry.footprint.cpuPercent);
  const byWorkers = entry.maxWorkers - live;
  return {
    slots: Math.max(0, Math.min(byMemory, byCpu, byWorkers)),
    terms:
      `memory ${byMemory} (${byFree} by ${entry.memory.freeMb} MB free, ${bySlice} by ${entry.memory.maxMb} MB slice - ${live} live = ${bySlice - live}), ` +
      `CPU ${byCpu}, workers ${entry.maxWorkers} - ${live} live = ${byWorkers}`,
  };
}

/**
 * Every reported host's slots, from the report and the live count alone — the
 * per-host lines a placement prints before it spends a repository lookup or a
 * host proof.
 *
 * `liveOn(host)` answers `{ live, unmeasured }` from `livePanes`. Answers
 * `{ lines, skipped, candidates }`, `candidates` being `[{ host, slots }]` in
 * slot order (stable: equal slots keep the report's order).
 */
export function hostSlots({ capacity, liveOn }) {
  const lines = [];
  const skipped = [];
  const skip = (host, reason) => {
    skipped.push({ host, reason });
    lines.push(`host '${host}' skipped: ${reason}`);
  };

  const candidates = [];
  for (const entry of capacity.hosts) {
    const reason = reportSkip(entry);
    if (reason !== '') {
      skip(entry.host, reason);
      continue;
    }
    const count = liveOn(entry.host);
    if (count.unmeasured > 0) {
      skip(entry.host, `${count.unmeasured} recorded pane(s) there could not be asked about, so its live workers cannot be counted (F-028)`);
      continue;
    }
    const { slots, terms } = slotsOf(entry, count.live);
    if (slots === 0) {
      skip(entry.host, `no free slot (${terms})`);
      continue;
    }
    lines.push(`host '${entry.host}': ${slots} free slot(s) (${terms})`);
    candidates.push({ host: entry.host, slots });
  }
  candidates.sort((a, b) => b.slots - a.slots);
  return { lines, skipped, candidates };
}

/**
 * The host this dispatch goes to, or every host's reason for not taking it.
 *
 * `liveOn(host)` answers `{ live, unmeasured }` from `livePanes`; `repoFor(host)`
 * answers `repoIdFor`'s verdict; `prove(host, declaration)` answers `proveHost`'s.
 * All three are injected so the order and the arithmetic are provable offline.
 *
 * Answers `{ ok: true, host, declaration, repoId, grounds, lines, skipped }` or
 * `{ ok: false, lines, skipped }`, `skipped` being `[{ host, reason }]`.
 */
export function placeHost({ capacity, declarations, liveOn, repoFor, prove }) {
  const { lines, skipped, candidates } = hostSlots({ capacity, liveOn });
  const skip = (host, reason) => {
    skipped.push({ host, reason });
    lines.push(`host '${host}' skipped: ${reason}`);
  };

  for (const { host } of candidates) {
    const repo = repoFor(host);
    if (!repo.ok) {
      skip(host, repo.reason);
      continue;
    }
    const declaration = declarations[host];
    const grounds = prove(host, declaration);
    if (!grounds.ok) {
      skip(host, grounds.reason);
      continue;
    }
    lines.push(`placed on '${host}', the eligible host with the most free slots`);
    return { ok: true, host, declaration, repoId: repo.id, grounds, lines, skipped };
  }
  return { ok: false, lines, skipped };
}

/**
 * `ax worker hosts` — each compute host's free slots, as a dispatch with no
 * `--on` would count them, without dispatching. Read-only: it reads the
 * capacity report and the live panes, and asks no host for a proof.
 *
 * Exit 0 once every host is answered for (a host with no slot is an answer),
 * 2 on an argument, 3 when the report or the live count cannot be read.
 */
export function hosts(argv = [], { resolve = resolveOrca, runner, env = process.env, cwd = process.cwd(), capacity = capacityOf } = {}) {
  if (argv.length > 0) {
    process.stderr.write(`ax worker hosts: unexpected argument "${argv[0]}" (it takes none)\n`);
    return 2;
  }
  const cannot = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    fix(repair);
    return 3;
  };

  const declared = declarationOf(cwd)();
  if (declared.retired) { bad(declared.retired.problem); fix(declared.retired.fix); return 1; }
  const config = declared.ok ? declared.config : {};
  const source = harnessosSource({ env, config });
  if (!source.ok) return cannot(source.reason, source.repair);
  const fleet = capacity({ source: source.path });
  if (!fleet.ok) return cannot(fleet.reason, fleet.repair);

  const bin = runner ? 'injected' : resolve();
  if (!bin) return cannot('no Orca CLI on this machine, so the live workers on each host cannot be counted', 'orca open   # then re-run: ax worker hosts');
  const run = runner ?? createRunner({ bin });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # then re-run: ax worker hosts');
  const local = terminalInventory(run);
  if (!local.ok) return cannot(local.reason, 'orca open   # the live count is read, never assumed');

  const counted = countedConfig(config, hostDeclarations(fleet.capacity, config.dispatch?.hosts));
  const live = liveCount({ run, env, config: counted, local });
  if (live.cannot) return cannot(live.cannot, live.repair);

  section(`${fleet.capacity.hosts.length} compute host(s)${fleet.capacity.observedAt ? `, capacity observed ${fleet.capacity.observedAt}` : ''}`);
  const { lines } = hostSlots({ capacity: fleet.capacity, liveOn: host => live.slots.hosts.get(host) ?? { live: 0, unmeasured: 0 } });
  for (const line of lines) note(line);
  if (!declared.ok) note(`read without this checkout's dispatch.hosts overrides: ${declared.reason}`);
  return 0;
}
