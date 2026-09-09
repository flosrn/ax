/**
 * Lineage memoisation, and the one case where caching would be a defect.
 *
 * `report()` runs at a turn boundary, where the operator is waiting on the
 * answer. `parentWorktreeId` is written when a worktree is created and cannot
 * change while a session runs inside it, so the answer is resolved once and
 * cached rather than rediscovered per report.
 *
 * The danger is the negative. "Orca listed no worktrees" and "this worktree has
 * no parent" are different facts that look identical at the call site, and
 * caching the first as the second permanently orphans a dispatched child: its
 * completion report would resolve no address for the rest of its life, which is
 * the exact silent-finish failure this channel exists to prevent. So a failure
 * must NOT be cached, and that is what these tests pin.
 *
 * Orca is faked through `ORCA_BIN`, which `resolveOrcaBin` reads at module load.
 * Each case therefore imports the module under a fresh specifier to get its own
 * module instance — and its own cache.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../../src/worker/record.mjs';

const HANDLE = 'term_child';
const CHILD_WT = '/tmp/fake/child';
const PARENT_WT = '/tmp/fake/parent';
/** The two panes a wave night legitimately runs beside the orchestrator. */
const ORCH = 'term_orch';
const READY = 'term_ready';

let dir = '';
let log = '';
let saved: Record<string, string | undefined> = {};

/**
 * A fake `orca` whose answers are switched by a file on disk, so a single module
 * instance can be shown a failing runtime and then a healthy one.
 */
function installFakeOrca(): string {
  const bin = join(dir, 'orca');
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
mode="$(cat "${dir}/mode")"
terms="$(cat "${dir}/terms" 2>/dev/null || echo ok)"
case "$*" in
  *"terminal list"*)
    if [[ "$terms" == "fail" ]]; then
      echo 'temporary inventory failure' >&2
      exit 1
    elif [[ "$terms" == "self-only" ]]; then
      echo '{"ok":true,"result":{"terminals":[{"handle":"${HANDLE}","worktreePath":"${CHILD_WT}"}]}}'
    else
      echo '{"ok":true,"result":{"terminals":[{"handle":"${HANDLE}","worktreePath":"${CHILD_WT}"},{"handle":"${ORCH}","worktreePath":"${PARENT_WT}"},{"handle":"${READY}","worktreePath":"${PARENT_WT}"}]}}'
    fi
    ;;
  *"worktree ps"*)
    if [[ "$mode" == "down" ]]; then
      echo '{"ok":true,"result":{"worktrees":[]}}'
    elif [[ "$mode" == "orphan" ]]; then
      echo '{"ok":true,"result":{"worktrees":[{"path":"${CHILD_WT}","parentWorktreeId":null}]}}'
    else
      echo '{"ok":true,"result":{"worktrees":[{"path":"${CHILD_WT}","parentWorktreeId":"repo123::${PARENT_WT}"}]}}'
    fi
    ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

function setMode(mode: 'down' | 'orphan' | 'parented'): void {
  writeFileSync(join(dir, 'mode'), mode);
}

/**
 * How Orca answers `terminal list`.
 *
 * `fail` is the #220 shape: a runtime that could not be read at all. It is set
 * AFTER lineage has been warmed, never before — a session witnesses its own
 * worktree from this same inventory, so breaking it first would only prove that
 * an unplaceable session cannot resolve a parent, which is a different fact and
 * the one the first draft of these cases accidentally measured.
 *
 * `self-only` is the true empty: the inventory reads fine and the parent
 * worktree genuinely runs no pane.
 */
function setTerms(mode: 'ok' | 'fail' | 'self-only'): void {
  writeFileSync(join(dir, 'terms'), mode);
}


function calls(pattern: string): number {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.includes(pattern)).length;
}

/**
 * A live, reachable session in the registry: `peers()` filters on a published
 * Run, so an unregistered pane is invisible to it — which is why the cases
 * above see an empty parent worktree despite `terminal list` naming two panes.
 */
function publishPeer(handle: string, run: string): void {
  mkdirSync(join(dir, 'peers'), { recursive: true });
  writeFileSync(
    join(dir, 'peers', `${handle}.json`),
    JSON.stringify({ handle, run, sessionId: `sess_${run}`, model: 'anthropic/claude-opus-5', level: 'high', ownerPid: process.pid }),
  );
}

/**
 * The write-ahead record a dispatching session leaves before it issues the
 * dispatch — built by the real writer, so the fixture cannot drift from the
 * shape `dispatcherRunForPane` reads.
 */
function writeRecord({ request, run, pane }: { request: string; run: string; pane: string }): void {
  const store = join(dir, 'dispatch');
  mkdirSync(store, { recursive: true });
  const path = join(store, `${request}.json`);
  claimRecord(store, request);
  initRecord(path, { request, orca: 'orca' });
  phaseBegin(path, { name: 'task-create', identity: `${request}-1`, argv: ['orca', 'orchestration', 'task-create', '--run', run] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_1' } } }) });
  phaseBegin(path, { name: 'worker-start', identity: `${request}-2`, argv: ['orca', 'orchestration', 'worker-start', '--task', 'task_1'] });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({ ok: true, result: { dispatchId: `ctx_${request}`, effects: [{ kind: 'terminal', id: pane }] } }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-lineage-'));
  log = join(dir, 'calls.log');
  writeFileSync(log, '');
  saved = {
    ORCA_BIN: process.env.ORCA_BIN,
    ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
    ORCA_PEER_REGISTRY_DIR: process.env.ORCA_PEER_REGISTRY_DIR,
    ORCA_DISPATCH_STORE: process.env.ORCA_DISPATCH_STORE,
  };
  process.env.ORCA_BIN = installFakeOrca();
  process.env.ORCA_TERMINAL_HANDLE = HANDLE;
  process.env.ORCA_PEER_REGISTRY_DIR = join(dir, 'peers');
  // An EMPTY store by default, never the operator's live one: a case that does
  // not write a record must read "no record names this pane", not whatever this
  // machine happens to have dispatched today.
  process.env.ORCA_DISPATCH_STORE = join(dir, 'dispatch');
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a resolved parent is cached: the second lookup makes no Orca call', async () => {
  setMode('parented');
  const m = await import('./lineage.ts?case=cached');

  const first = m.parentPeer();
  // No live pane in the parent worktree, so there is nobody to report TO — but
  // lineage itself resolved, which is what is under test here.
  expect(first.reason).toContain('parent');
  const afterFirst = calls('worktree ps');
  expect(afterFirst).toBeGreaterThan(0);

  m.parentPeer();
  m.parentPeer();
  expect(calls('worktree ps')).toBe(afterFirst);
});

test('an unavailable runtime is NOT cached, and a later healthy one still resolves', async () => {
  setMode('down');
  const m = await import('./lineage.ts?case=retry');

  const down = m.parentPeer();
  expect(down.reason).toContain('lineage is unknown, not absent');

  // The runtime comes back. A cached failure would keep answering "no parent"
  // forever and the child would never report.
  setMode('parented');
  const up = m.parentPeer();
  expect(up.reason).not.toContain('lineage is unknown');
  expect(calls('worktree ps')).toBeGreaterThan(1);
});

test('a genuinely parentless worktree is cached as parentless', async () => {
  setMode('orphan');
  const m = await import('./lineage.ts?case=orphan');

  const first = m.parentPeer();
  expect(first.reason).toContain('no parent worktree recorded');
  const afterFirst = calls('worktree ps');

  // This one IS a real answer, so it must not be re-asked — those are the Orca
  // round-trips the memo exists to remove for interactive sessions.
  m.parentPeer();
  expect(calls('worktree ps')).toBe(afterFirst);
});

test('warmLineage resolves at startup so the first report pays nothing', async () => {
  setMode('orphan');
  const m = await import('./lineage.ts?case=warm');

  m.warmLineage();
  const afterWarm = calls('worktree ps');
  expect(afterWarm).toBeGreaterThan(0);

  m.parentPeer();
  expect(calls('worktree ps')).toBe(afterWarm);
});

// ── several panes in the parent worktree ──────────────────────────────────────
//
// Measured 2026-08-30 on ofmchat PRD 2, twice in one night: #117 (dispatch
// ctx_0c5dacb47230) and #113 (ctx_812f22b13b19) both finished, both sent
// `worker_done`, and both were told the report could not be delivered because
// the parent worktree ran several panes. It did — the orchestrator beside two
// readiness sessions — and that is the ORDINARY shape of a wave night, not an
// edge case. Orca's lineage stops at the worktree, so this side had no
// discriminator and refused rather than guessing.
//
// The discriminator was on the machine all along: the dispatching session wrote
// the record BEFORE it dispatched, and that record pairs the child's pane with
// its own Run.

test('a parent running several panes resolves through the record that dispatched this child', async () => {
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  publishPeer(READY, 'run_readiness');
  writeRecord({ request: 'impl-117', run: 'run_orchestrator', pane: HANDLE });
  const m = await import('./lineage.ts?case=record-picks');

  const r = m.parentPeer();
  expect(r.reason).toBeUndefined();
  expect(r.peer?.handle).toBe(ORCH);
  expect(r.peer?.run).toBe('run_orchestrator');
});

test('the record decides, not the pane order — the other session is never picked by luck', async () => {
  // Same two panes, the OTHER one dispatched this child. A resolution that
  // happened to return `inParent[0]` would pass the case above and deliver every
  // completion to the wrong session here.
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  publishPeer(READY, 'run_readiness');
  writeRecord({ request: 'triage-126', run: 'run_readiness', pane: HANDLE });
  const m = await import('./lineage.ts?case=record-picks-other');

  expect(m.parentPeer().peer?.handle).toBe(READY);
});

test('several panes and no record still refuses, and the reason names what was missing', async () => {
  // The refusal is not replaced, it is narrowed: with no record naming this pane
  // there is still nothing to pick, and a completion sent to a stranger is worse
  // than one the child is told to re-route. The reason has to say which of the
  // two facts stopped it, because the child reads it and acts on it.
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  publishPeer(READY, 'run_readiness');
  const m = await import('./lineage.ts?case=record-absent');

  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.reason).toContain('several panes');
  expect(r.reason).toContain(HANDLE);
});

test('a record naming a Run no live pane is reading QUEUES on that Run instead of refusing', async () => {
  // The refusal this replaces read "the dispatching session is gone", and on
  // 2026-09-08 that was false: Orca had killed the dispatcher's pty at 14:06:09Z
  // (`session-killed immediate:true`) and respawned the same `@@9320cb55` slot at
  // 14:27:50Z, so the session was ABSENT, not gone. Orca keys messages on the run
  // and holds them — `msg_a5230f12b27a` was created 14:13:32Z inside that window
  // and delivered 14:27:54Z. A recorded Run with no pane on it is therefore an
  // address whose arrival is deferred, and the only thing the resolver may not do
  // is hand it to a stranger: `peer` stays empty so no other pane in the parent
  // can be mistaken for the dispatcher.
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  publishPeer(READY, 'run_readiness');
  writeRecord({ request: 'impl-117', run: 'run_departed', pane: HANDLE });
  const m = await import('./lineage.ts?case=record-stale');

  const r = m.parentPeer();
  expect(r.reason).toBeUndefined();
  expect(r.peer).toBeUndefined();
  expect(r.queued?.run).toBe('run_departed');
  expect(r.queued?.worktree).toBe(PARENT_WT);
});

test('a parent with NO live pane queues on the recorded Run too', async () => {
  // The whole parent worktree is dark — one pane, killed while the child worked.
  // This path never consulted the record at all, so the ordinary single-pane
  // dispatch lost its report to a 21-minute respawn window even though the Run
  // that owns it was written down before the dispatch was issued.
  setMode('parented');
  writeRecord({ request: 'impl-222', run: 'run_orchestrator', pane: HANDLE });
  const m = await import('./lineage.ts?case=parent-dark');

  const r = m.parentPeer();
  expect(r.reason).toBeUndefined();
  expect(r.queued?.run).toBe('run_orchestrator');
});

test('a dark parent with no record still refuses, naming both facts', async () => {
  // No pane and no Run is the one state with no address in it. Naming only the
  // pane would send the child looking for a session that may be fine; naming
  // only the record hides that nobody is home.
  setMode('parented');
  const m = await import('./lineage.ts?case=parent-dark-no-record');

  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.queued).toBeUndefined();
  expect(r.reason).toContain('no live session to report to');
  expect(r.reason).toContain(HANDLE);
});

test('one live NON-DISPATCHER pane does not receive a no-consumer dispatcher report', async () => {
  // This is the smallest real no-consumer shape: the dispatcher is down, one
  // readiness pane remains in the primary checkout, and the record names the
  // Run Orca is holding. "One pane is unambiguous" would send the report to
  // the wrong session; the record must turn the sole mismatch into a queue too.
  setMode('parented');
  publishPeer(READY, 'run_readiness');
  writeRecord({ request: 'impl-222', run: 'run_orchestrator', pane: HANDLE });
  const m = await import('./lineage.ts?case=sole-wrong-pane');

  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.queued?.run).toBe('run_orchestrator');
});

test('one live pane still resolves with no record at all — the ordinary case pays nothing', async () => {
  // The store is only consulted to break a tie. A single-pane parent must not
  // start depending on a record being readable.
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  const m = await import('./lineage.ts?case=single-pane');

  expect(m.parentPeer().peer?.handle).toBe(ORCH);
});

// ── #220 an unread inventory is not an absence ────────────────────────────────
//
// `terminal list` failing arrived here as an empty pane list, which is what a
// parent worktree running nothing also looks like — so `parentPeer` stated the
// second out of the first: `has no live session to report to`. A recorded Run is
// still a usable address in that state (Orca queues on the Run, not on a pane),
// and what may never be produced is a reader, or a certain absence of one.
//
// EVERY CASE HERE WARMS LINEAGE FIRST, because a session witnesses its own
// worktree from this same inventory. Breaking it before the warm measures an
// unplaceable session instead — a real defect, pinned separately below, but not
// this one.

test('an unreadable inventory is not an absent parent', async () => {
  setMode('parented');
  const m = await import('./lineage.ts?case=unread-no-record');
  m.warmLineage();

  setTerms('fail');
  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.queued).toBeUndefined();
  expect(r.reason ?? '').not.toMatch(/no live session/);
  expect(r.reason ?? '').toMatch(/not established/i);
});

test('an unreadable inventory still queues on the recorded Run', async () => {
  setMode('parented');
  writeRecord({ request: 'impl-220', run: 'run_orchestrator', pane: HANDLE });
  const m = await import('./lineage.ts?case=unread-with-record');
  m.warmLineage();

  setTerms('fail');
  const r = m.parentPeer();
  // The Run came from this machine's own write-ahead record, so it survives an
  // unreadable runtime — but no pane may be called its reader.
  expect(r.peer).toBeUndefined();
  expect(r.queued?.run).toBe('run_orchestrator');
  expect(r.queued?.worktree).toBe(PARENT_WT);
  expect(r.reason ?? '').not.toMatch(/no live session/);
  expect(r.reason ?? '').toMatch(/not established/i);
});

test('a truly empty parent worktree with no record is still an absence', async () => {
  // The positive control, and the reason the case above cannot simply widen the
  // refusal: here the inventory READS, and it says the parent runs no pane at
  // all. That is a measurement, and the refusal must keep naming it.
  setMode('parented');
  setTerms('self-only');
  const m = await import('./lineage.ts?case=empty-no-record');

  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.queued).toBeUndefined();
  expect(r.reason).toContain('no live session to report to');
  expect(r.reason).toContain(HANDLE);
});

test('a truly empty parent worktree with a record queues with nothing left unproven', async () => {
  setMode('parented');
  setTerms('self-only');
  writeRecord({ request: 'impl-234', run: 'run_orchestrator', pane: HANDLE });
  const m = await import('./lineage.ts?case=empty-with-record');

  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.queued?.run).toBe('run_orchestrator');
  // #234's queue, unchanged: the absence of a reader was OBSERVED here, so the
  // caller has nothing further to say about it.
  expect(r.reason).toBeUndefined();
});

test('an unreadable inventory that later recovers finds the exact reader', async () => {
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  const m = await import('./lineage.ts?case=unread-recover');
  m.warmLineage();

  setTerms('fail');
  const down = m.parentPeer();
  expect(down.peer).toBeUndefined();
  expect(down.reason ?? '').not.toMatch(/no live session/);

  // A refusal that had been cached — or a pane named on no evidence — both fail
  // here: the same inventory, readable again, names one exact reader.
  setTerms('ok');
  const up = m.parentPeer();
  expect(up.peer?.handle).toBe(ORCH);
  expect(up.peer?.run).toBe('run_orchestrator');
  expect(up.reason).toBeUndefined();
});

