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
case "$*" in
  *"terminal list"*)
    echo '{"ok":true,"result":{"terminals":[{"handle":"${HANDLE}","worktreePath":"${CHILD_WT}"},{"handle":"${ORCH}","worktreePath":"${PARENT_WT}"},{"handle":"${READY}","worktreePath":"${PARENT_WT}"}]}}'
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

test('a record naming a Run that is not live in the parent refuses rather than falling back', async () => {
  // The dispatcher died and something else opened in its worktree. Falling back
  // to "the only other pane" is exactly the guess this channel must not make.
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  publishPeer(READY, 'run_readiness');
  writeRecord({ request: 'impl-117', run: 'run_departed', pane: HANDLE });
  const m = await import('./lineage.ts?case=record-stale');

  const r = m.parentPeer();
  expect(r.peer).toBeUndefined();
  expect(r.reason).toContain('run_departed');
});

test('one live pane still resolves with no record at all — the ordinary case pays nothing', async () => {
  // The store is only consulted to break a tie. A single-pane parent must not
  // start depending on a record being readable.
  setMode('parented');
  publishPeer(ORCH, 'run_orchestrator');
  const m = await import('./lineage.ts?case=single-pane');

  expect(m.parentPeer().peer?.handle).toBe(ORCH);
});
