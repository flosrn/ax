// Which compute host a remote dispatch lands on, and how many Slots each host
// offers — the ONLY admission there is (ADR 0005). No repository cap and no
// machine cap: a host is admitted by its own Slots, and a pane anywhere else
// gates nothing. Worktree placement ON a host is ./placement.mjs; this module
// only chooses and admits the host.
//
// ONE CONTRACT, TWO CALLERS (KTD10). A dispatch with no `--on` takes the
// eligible host with the most Slots; a dispatch naming `--on <host>` passes
// that host, and only that host, through the same Slot and skip contract
// (`placeHost` with `only`). A named host with no Slot, or one that cannot be
// measured, is refused — it never falls back to another host or to the Mac.
// `--on here` and a local `--worktree` read nothing here: the Mac has no Slots
// and no ceiling (R4).
//
// HARNESSOS MEASURES HEADROOM, AX COMPUTES SLOTS. `bun scripts/capacity.ts
// --json` in the HarnessOS checkout reports, per compute host, the harness
// slice's maximum, held and free memory, the host's available memory, its
// free CPU, the measured per-worker footprint, `maxWorkers`, the slice's OOM
// counter against its acknowledgement, the cordon, the eligibility verdict
// with its reasons (an unacknowledged OOM arrives THERE, KTD5), and the
// host's latest gateway probe. The live-worker count is not in that report:
// AX's only reader of it is `livePanes` (./slots.mjs), live panes plus open
// worker-start phases on that host (KTD3). For live count `live` and
// footprint `fp`, Slots are (KTD2)
//
//   max(0, min(floor(min(memory.freeMb, memory.hostAvailableMb) / fp),
//              floor(memory.maxMb / fp) - live,
//              floor((memory.workMb + memory.hostAvailableMb) / fp) - live,
//              floor(cpu.freePercent / footprint.cpuPercent),
//              maxWorkers - live))
//
// and the most Slots wins, ties to the report's order.
//
// A LIVE WORKER RESERVES ITS FOOTPRINT (#271), AND THE HOST BOUNDS THE SLICE.
// Free memory is read NOW, and a worker in a quiet phase holds almost none of
// it: free memory alone read gapicore as room for a second 12500 MB worker
// beside a live one in a 16384 MB slice. So the slice maximum is divided among
// the live workers first — and so is what the host can still give the slice,
// its held memory plus the host's available memory, because a slice cap larger
// than the host's own free memory would otherwise admit a worker the host
// cannot hold (AE6).
//
// EVERY ENTRY IS VALIDATED BEFORE IT IS USED (KTD4). Unique host names; finite
// non-negative free, held and available memory and CPU; a positive slice
// maximum and footprints; an integer `maxWorkers`; an `oom` object with integer
// `killCount` and `baseline`, and `acknowledged` / `acknowledgedAt` each
// well-formed or null. Any failure skips that host as UNVERIFIED with the
// field named — a missing OOM counter is never read as zero kills (R8).
// `memory.peakMb` is display-only and gates nothing.
//
// THE HOST LOCK (KTD3). Two dispatches reading one last Slot would both spend
// it. So a non-dry remote admission takes that host's lock under the dispatch
// store (`acquireHostLock`, ./record.mjs), re-reads its Slots under it, and
// keeps it through the write-ahead of the start; the caller releases it.
//
// `ax worker hosts [<host>]` prints the same per-host lines without choosing a
// host: `hostSlots` is the one computation, and dispatch and that read both
// call it, over the same live count (`liveCount`, ./slots.mjs). Under each line
// the read adds the host's memory, its OOM counter against its acknowledgement
// and why it offers no Slot (R9). It stops before the costly grounds, so it
// never spends an Orca repository lookup or an ssh proof.
//
// A RETIRED HOST OFFERS NO SLOT (KTD8). The operator's retirement rides on the
// host's live count (`retired`, ./slots.mjs `liveCount`), and it is judged
// before the report: an eligible entry for a written-off host is still a named
// skip, and `ax worker hosts <retired>` is a known name showing 0 Slots, the
// retirement, and its memory as unavailable when the report did not measure it.
//
// THE MAC IS NEVER A FALLBACK (R2). Automatic placement runs only on the
// operator Mac — detected as HarnessOS's own `localHost` detects it
// (`scripts/infra.ts`): the darwin machine is the operator — and when no host
// can take the worker the dispatch is refused with every host's reason.
//
// EVERY HOST PASSED OVER SAYS WHY. A duplicate or malformed entry, a cordon, an
// ineligibility, an unprobed or unhealthy gateway, a host whose panes could not
// be asked about, a recorded worktree still occupied, a full host, a lock that
// could not be taken, a missing repository and a failed host ground are each a
// named skip. The cheap grounds (the report and the live count) are read for
// every candidate; the costly ones (the lock, an Orca repository lookup and
// `proveHost`'s ssh round trips) are spent in Slot order and stop at the first
// host that passes, so a runner-up is never proven for nothing.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { run as execRun } from '../exec.mjs';
import { bad, fix, note, section } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { declarationOf } from './hosts.mjs';
import { terminalInventory } from './pane.mjs';
import { liveCount } from './slots.mjs';
import { readRetired, retiredLine } from './retired-hosts.mjs';
import { defaultStore, readHostLock, requestIdOk } from './record.mjs';

/** The declaration fields a capacity entry carries for `proveHost` (./hosts.mjs). */
const DECLARED = ['ssh', 'cgroup', 'diskPath', 'diskFloorGb', 'memFreeFloorMb'];

/**
 * A capacity read reaches every compute host over ssh from the Mac, where one
 * round trip is budgeted 60 s by HarnessOS itself; the default 30 s of the
 * shared `exec` would cut a healthy read short.
 */
const CAPACITY_TIMEOUT_MS = 180000;

/** The live count of a host nothing is recorded on. */
export const NONE = { live: 0, unmeasured: 0 };

/** Whether this machine is the operator Mac — the only place automatic placement runs. */
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
      reason: 'a dispatch to a compute host is admitted by the Slots HarnessOS capacity measures, and neither HARNESSOS_SOURCE nor dispatch.harnessos names a HarnessOS checkout to read it from',
      repair: 'export HARNESSOS_SOURCE=<harnessos checkout>, or ax.config.json: { "dispatch": { "harnessos": "~/Code/flosrn/harnessos" } }   # or --on here for this Mac',
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
    return { ok: false, reason: `the capacity report could not be read (${read}): ${why}`, repair: `${read}   # read it by hand, or --on here for this Mac` };
  }
  let report;
  try {
    report = JSON.parse(out.stdout);
  } catch {
    return { ok: false, reason: `${read} answered something that is not JSON`, repair: `${read}   # read it by hand, or --on here for this Mac` };
  }
  if (!Array.isArray(report?.hosts)) {
    return { ok: false, reason: `${read} answered no host list, so no compute host can be measured`, repair: `${read}   # read it by hand, or --on here for this Mac` };
  }
  return { ok: true, capacity: report };
}

/** Only a named dispatch may wake a sleeper; automatic placement remains read-only. */
export const sleepingHost = entry => entry?.state === 'asleep' && entry.wakeable === true;

/** Wake through the same Bun/checkout boundary as capacityOf, then let the caller re-read capacity. */
export function wakeHost({ source, host, run = execRun }) {
  const out = run('bun', [join(source, 'scripts', 'capacity.ts'), 'wake', host, '--json'], { cwd: source, timeout: 240000 });
  if (out.error === undefined && out.status === 0) return { ok: true };
  let message = '';
  try {
    const answer = JSON.parse(out.stdout);
    message = typeof answer.message === 'string' ? answer.message : typeof answer.error?.message === 'string' ? answer.error.message : '';
  } catch {
    // A failed command may answer plain text instead of JSON.
  }
  return { ok: false, reason: message || String(out.stderr ?? '').trim() || String(out.stdout ?? '').trim() || String(out.error?.message ?? `exit ${out.status}`) };
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
    if (typeof entry?.host !== 'string' || entry.host === '') continue;
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

const finite = value => typeof value === 'number' && Number.isFinite(value);
const shown = value => (value === undefined ? 'missing' : typeof value === 'number' ? String(value) : JSON.stringify(value));
const isoOrNull = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)));

/**
 * The first field of an entry that cannot be used, said with its value, or ''.
 * Order follows the Slot formula, then the OOM counter (KTD4).
 */
function invalidField(entry) {
  const memory = entry.memory;
  const cpu = entry.cpu;
  const footprint = entry.footprint;
  if (memory === null || typeof memory !== 'object') return `memory is ${shown(memory)}, not an object`;
  for (const key of ['freeMb', 'workMb', 'hostAvailableMb']) {
    if (!(finite(memory[key]) && memory[key] >= 0)) return `memory.${key} is ${shown(memory[key])}, not a finite non-negative number`;
  }
  if (!(finite(memory.maxMb) && memory.maxMb > 0)) return `memory.maxMb is ${shown(memory.maxMb)}, not a positive slice maximum — the footprint its live workers reserve cannot be computed, and free memory alone would read a quiet worker as room (#271)`;
  if (cpu === null || typeof cpu !== 'object') return `cpu is ${shown(cpu)}, not an object`;
  if (!(finite(cpu.freePercent) && cpu.freePercent >= 0)) return `cpu.freePercent is ${shown(cpu.freePercent)}, not a finite non-negative number`;
  if (footprint === null || typeof footprint !== 'object') return `footprint is ${shown(footprint)}, not an object`;
  for (const key of ['memoryMb', 'cpuPercent']) {
    if (!(finite(footprint[key]) && footprint[key] > 0)) return `footprint.${key} is ${shown(footprint[key])}, not a positive number`;
  }
  if (!Number.isInteger(entry.maxWorkers)) return `maxWorkers is ${shown(entry.maxWorkers)}, not an integer`;
  const oom = entry.oom;
  if (oom === null || typeof oom !== 'object' || Array.isArray(oom)) {
    return `oom is ${shown(oom)}: the report carries no slice OOM counter for it, and a missing counter is never zero kills (R8) — update the HarnessOS checkout`;
  }
  for (const key of ['killCount', 'baseline']) {
    if (!(Number.isInteger(oom[key]) && oom[key] >= 0)) return `oom.${key} is ${shown(oom[key])}, not a non-negative integer`;
  }
  if (!(oom.acknowledged === null || (Number.isInteger(oom.acknowledged) && oom.acknowledged >= 0))) return `oom.acknowledged is ${shown(oom.acknowledged)}, neither null nor a non-negative integer`;
  if (!isoOrNull(oom.acknowledgedAt)) return `oom.acknowledgedAt is ${shown(oom.acknowledgedAt)}, neither null nor an ISO timestamp`;
  return '';
}

/** Why the report itself passes over a host, or '' when it does not. */
function reportSkip(entry) {
  if (entry.cordoned === true) return `cordoned — bun scripts/capacity.ts uncordon ${entry.host} when it may take workers again`;
  if (entry.state === 'asleep') return sleepingHost(entry) ? `asleep (dispatch --on ${entry.host} wakes it)` : 'asleep (not wakeable)';
  if (entry.eligible !== true) {
    const reasons = Array.isArray(entry.reasons) && entry.reasons.length > 0 ? entry.reasons.join('; ') : 'no reason given';
    return `ineligible (${entry.state ?? 'unknown state'}): ${reasons}`;
  }
  if (entry.gateway === null || entry.gateway === undefined) return `no gateway probe for its omp-${entry.host} surface, so a worker there may have no model to answer it`;
  if (entry.gateway.healthy !== true) return `gateway ${entry.gateway.surface} unhealthy: ${entry.gateway.detail || 'no detail'}`;
  const invalid = invalidField(entry);
  if (invalid !== '') return `unverified — ${invalid}`;
  return '';
}

/**
 * KTD2's Slot formula over a VALIDATED entry, and every term it took the
 * minimum of — so `ax worker hosts` and a refusal can say which term bound.
 */
export function slotsOf(entry, live) {
  const { freeMb, workMb, hostAvailableMb, maxMb } = entry.memory;
  const fp = entry.footprint.memoryMb;
  const byFree = Math.floor(Math.min(freeMb, hostAvailableMb) / fp);
  const bySlice = Math.floor(maxMb / fp) - live;
  const byReach = Math.floor((workMb + hostAvailableMb) / fp) - live;
  const memory = Math.min(byFree, bySlice, byReach);
  const byCpu = Math.floor(entry.cpu.freePercent / entry.footprint.cpuPercent);
  const byWorkers = entry.maxWorkers - live;
  return {
    slots: Math.max(0, Math.min(memory, byCpu, byWorkers)),
    memory,
    byFree,
    bySlice,
    byReach,
    byCpu,
    byWorkers,
    text:
      `memory ${memory} (${byFree} by min(${freeMb} MB free, ${hostAvailableMb} MB host available), ` +
      `${bySlice} by ${maxMb} MB slice - ${live} live, ` +
      `${byReach} by ${workMb} MB held + ${hostAvailableMb} MB host available - ${live} live), ` +
      `CPU ${byCpu}, workers ${entry.maxWorkers} - ${live} live = ${byWorkers}`,
  };
}

/**
 * Why a host's live count denies it a Slot, or ''. An occupied recorded
 * worktree is NAMED apart from a host that could not be asked (#221): the
 * first is settled by inspecting the live handle at that path, the second by
 * asking the host — one sentence for both sent the reader to the wrong read.
 */
function countSkip(count) {
  const unmeasured = Number.isInteger(count.unmeasured) ? count.unmeasured : 0;
  if (unmeasured <= 0) return '';
  const occupancy = Array.isArray(count.occupancy) ? count.occupancy : [];
  const reasons = occupancy.map(row => {
    const extras = Array.isArray(row.extras) && row.extras.length > 0 ? row.extras : [];
    const records = Array.isArray(row.records) && row.records.length > 0 ? ` (${row.records.join(', ')})` : '';
    const show = extras.length > 0 ? extras.map(handle => `orca terminal show --terminal ${handle} --json`).join('; ') : 'orca terminal show --terminal <handle> --json';
    return `recorded worktree ${row.tree || 'of a record'}${records} is still occupied by live handle(s) ${extras.join(', ') || 'no record owns'}, so the recorded pane's liveness is unknown (F-028) — ${show}`;
  });
  const unasked = unmeasured - occupancy.length;
  if (unasked > 0) reasons.push(`${unasked} recorded pane(s) there could not be asked about, so its live workers cannot be counted (F-028)`);
  return reasons.join('; ');
}

/** Why a retired host offers no Slot, or ''. */
const retiredSkip = count => (count?.retired ? `${retiredLine(count.retired)} — ax worker unretire-host ${count.retired.host} if it may take workers again` : '');

/** One host's verdict from its entry and a live count: `{ reason }` or `{ slots, text }`. */
export function verdictOf(entry, count) {
  const retired = retiredSkip(count);
  if (retired !== '') return { reason: retired };
  const skip = countSkip(count);
  if (skip !== '') return { reason: skip };
  const live = Number.isInteger(count.live) ? count.live : 0;
  const terms = slotsOf(entry, live);
  if (terms.slots === 0) return { reason: `no free slot (${terms.text})` };
  return { slots: terms.slots, text: terms.text };
}

/**
 * Every reported host's Slots — or the named host's alone (`only`) — from the
 * report and the live count only: the per-host lines a placement prints before
 * it spends a lock, a repository lookup or a host proof.
 *
 * `liveOn(host)` answers `{ live, unmeasured, occupancy? }` from `livePanes`.
 * Answers `{ lines, rows, skipped, candidates }`, `candidates` being
 * `[{ host, slots, entry }]` in Slot order (stable: equal Slots keep the
 * report's order), and `rows` one `{ host, line, entry, count, reason? }` per
 * line in line order — `entry` null when the report has no one answer for it —
 * for `ax worker hosts` to print each host's memory under its line.
 */
export function hostSlots({ capacity, liveOn, only = '' }) {
  const lines = [];
  const rows = [];
  const skipped = [];
  const skip = (host, reason, entry = null, count = null) => {
    skipped.push({ host, reason });
    const line = `host '${host}' skipped: ${reason}`;
    lines.push(line);
    rows.push({ host, line, entry, count, reason });
  };

  // Duplicates are judged over the WHOLE report, named or not: two entries for
  // one host are two answers, and neither is the host's (KTD4).
  const times = new Map();
  for (const entry of capacity.hosts) {
    if (typeof entry?.host === 'string' && entry.host !== '') times.set(entry.host, (times.get(entry.host) ?? 0) + 1);
  }

  const candidates = [];
  const judged = new Set();
  capacity.hosts.forEach((entry, index) => {
    const host = typeof entry?.host === 'string' && entry.host !== '' ? entry.host : '';
    if (host === '') {
      if (only === '') skip(`#${index + 1}`, `unverified — host is ${shown(entry?.host)}, not a host name`, entry);
      return;
    }
    if (only !== '' && host !== only) return;
    if (judged.has(host)) return;
    judged.add(host);
    if (times.get(host) > 1) {
      skip(host, `unverified — the capacity report lists host '${host}' ${times.get(host)} times, and two answers for one host are neither its answer`);
      return;
    }
    const count = liveOn(host) ?? NONE;
    const reason = retiredSkip(count) || reportSkip(entry);
    if (reason !== '') {
      skip(host, reason, entry, count);
      return;
    }
    const verdict = verdictOf(entry, count);
    if (verdict.reason !== undefined) {
      skip(host, verdict.reason, entry, count);
      return;
    }
    const line = `host '${host}': ${verdict.slots} free slot(s) (${verdict.text})`;
    lines.push(line);
    rows.push({ host, line, entry, count });
    candidates.push({ host, slots: verdict.slots, entry });
  });
  if (only !== '' && !judged.has(only)) {
    const count = liveOn(only) ?? NONE;
    skip(only, retiredSkip(count) || 'not in the capacity report, so its Slots cannot be measured (F-028)', null, count);
  }
  candidates.sort((a, b) => b.slots - a.slots);
  return { lines, rows, skipped, candidates };
}

/**
 * The host this dispatch goes to, or every judged host's reason for not
 * taking it. Automatic placement passes no `only`; a named `--on <host>`
 * passes that host, which is then the only host judged and the only one that
 * can be chosen (KTD10).
 *
 * `liveOn(host)` answers `{ live, unmeasured, occupancy? }` from `livePanes`;
 * `repoFor(host)` answers `repoIdFor`'s verdict; `prove(host, declaration)`
 * answers `proveHost`'s. All are injected so the order and the arithmetic are
 * provable offline. No lock is taken here: a proof is ssh-bound and spends no
 * Slot, so the caller takes the host lock (KTD3) after this returns and judges
 * the chosen `entry` again under it with `verdictOf`.
 *
 * Answers `{ ok: true, host, declaration, repoId, grounds, entry, lines,
 * skipped }` or `{ ok: false, lines, skipped }`.
 */
export function placeHost({ capacity, declarations, liveOn, repoFor, prove, only = '' }) {
  const { lines, skipped, candidates } = hostSlots({ capacity, liveOn, only });
  const skip = (host, reason) => {
    skipped.push({ host, reason });
    lines.push(`host '${host}' skipped: ${reason}`);
  };

  for (const { host, entry } of candidates) {
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
    lines.push(only === '' ? `placed on '${host}', the eligible host with the most free slots` : `admitted on '${host}', the host --on named`);
    return { ok: true, host, declaration, repoId: repo.id, grounds, entry, lines, skipped };
  }
  return { ok: false, lines, skipped };
}

const mb = value => (finite(value) ? `${value} MB` : value === undefined ? 'unreported' : `${shown(value)} (malformed)`);

/**
 * What `ax worker hosts` prints under one host's line, in R9's order: the Slot
 * terms a host passed over by the report would otherwise give (its line already
 * carries them when it offers Slots, or when its live workers took them), the
 * slice's memory and the host's available memory, `oom_kill` against its
 * baseline and acknowledgement, then why it offers no Slot. Whatever the
 * report carries is shown even for an unverified host; what it lacks is said
 * unreported, never zero. Peak is display-only: absent or malformed, it is
 * "unavailable" and gates nothing (KTD4).
 */
function hostDetails({ entry, count, reason }) {
  const details = [];
  if (count?.retired) {
    details.push(`0 Slots: ${retiredLine(count.retired)}`);
    if (entry === null || typeof entry !== 'object') details.push('memory and OOM unavailable — the capacity report did not measure this host');
  }
  if (entry !== null && typeof entry === 'object') {
    if (entry.state === 'asleep') {
      details.push('measurements unavailable while asleep');
      if (reason !== undefined) details.push(`no Slot: ${reason}`);
      return details;
    }
    if (!count?.retired && reason !== undefined && reportSkip(entry) !== '' && invalidField(entry) === '' && countSkip(count ?? NONE) === '') {
      const terms = slotsOf(entry, Number.isInteger(count?.live) ? count.live : 0);
      details.push(`Slots 0 offered; by its terms it would hold ${terms.slots} (${terms.text})`);
    }
    const memory = entry.memory;
    if (memory !== null && typeof memory === 'object') {
      const peak = finite(memory.peakMb) && memory.peakMb >= 0 ? `peak ${memory.peakMb} MB` : 'peak unavailable';
      details.push(`slice max ${mb(memory.maxMb)}, held ${mb(memory.workMb)}, free ${mb(memory.freeMb)}, ${peak}`);
      details.push(`host available ${mb(memory.hostAvailableMb)}`);
    } else {
      details.push(`slice and host memory unreported (memory is ${shown(memory)})`);
    }
    const oom = entry.oom;
    if (oom !== null && typeof oom === 'object' && !Array.isArray(oom)) {
      const ack = oom.acknowledged === null || oom.acknowledged === undefined ? 'no acknowledgement' : `acknowledged ${shown(oom.acknowledged)} at ${oom.acknowledgedAt ?? 'an unreported time'}`;
      details.push(`oom_kill ${shown(oom.killCount)} against baseline ${shown(oom.baseline)}, ${ack}`);
    } else {
      details.push('oom_kill unreported — a missing counter is never zero kills (R8)');
    }
  }
  if (reason !== undefined) details.push(`no Slot: ${reason}`);
  return details;
}

/**
 * `ax worker hosts [<host>]` — each compute host's free Slots, as a remote
 * dispatch counts them, with its memory and OOM state, without dispatching; or
 * one named host's. Read-only: it reads the capacity report and the live panes,
 * and asks no host for a proof. Each host's first line is the very line a
 * dispatch prints for it (`hostSlots`); what follows is `hostDetails`.
 *
 * A host is known when the report carries it or this checkout's
 * `dispatch.hosts` declares it; a known host the report does not carry says why
 * it offers no Slot, and any other name is refused with the known ones.
 *
 * Exit 0 once every host is answered for (a host with no Slot is an answer),
 * 2 on an argument or an unknown host, 3 when the report or the live count
 * cannot be read.
 */
export function hosts(argv = [], { resolve = resolveOrca, runner, env = process.env, cwd = process.cwd(), capacity = capacityOf } = {}) {
  const flag = argv.find(arg => arg.startsWith('-'));
  if (flag !== undefined || argv.length > 1) {
    process.stderr.write(`ax worker hosts: unexpected argument "${flag ?? argv[1]}" (it takes at most one host name)\n`);
    return 2;
  }
  const only = argv[0] ?? '';
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

  // The retirement policy, read before any name is judged: a retired host is a
  // known name, and a malformed policy is an inability, never no retirement.
  const store = defaultStore(env);
  const policy = readRetired(store);
  if (!policy.ok) return cannot(policy.reason, policy.repair);
  if (only !== '') {
    const reported = fleet.capacity.hosts.map(entry => entry?.host).filter(name => typeof name === 'string' && name !== '');
    const overrides = config.dispatch?.hosts;
    const known = [...new Set([...reported, ...(overrides !== null && typeof overrides === 'object' ? Object.keys(overrides) : []), ...policy.hosts.keys()])];
    if (!known.includes(only)) {
      bad(`host '${only}' is neither in the capacity report nor in this checkout's dispatch.hosts, and is not retired; known hosts: ${known.join(', ') || 'none'}`);
      fix(`ax worker hosts${known.length > 0 ? ` ${known[0]}` : ''}`);
      return 2;
    }
  }

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

  const observed = fleet.capacity.observedAt ? `, capacity observed ${fleet.capacity.observedAt}` : '';
  section(only === '' ? `${fleet.capacity.hosts.length} compute host(s)${observed}` : `compute host '${only}' of ${fleet.capacity.hosts.length} reported${observed}`);
  const { rows } = hostSlots({ capacity: fleet.capacity, liveOn: host => live.slots.hosts.get(host) ?? NONE, only });
  for (const row of rows) {
    note(row.line);
    for (const detail of hostDetails(row)) note(`  ${detail}`);
    // A lock a dispatch is holding, or one a killed dispatch left: the lock a
    // dispatch refused on is shown here too, or the Slot count above would
    // contradict that refusal.
    const held = requestIdOk(row.host) ? readHostLock(store, row.host) : null;
    if (held !== null) {
      note(`  ${held.text}`);
      note(`  repair: ${held.repair}`);
    }
  }
  if (!declared.ok) note(`read without this checkout's dispatch.hosts overrides: ${declared.reason}`);
  return 0;
}
