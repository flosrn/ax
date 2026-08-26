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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HANDLE = 'term_child';
const CHILD_WT = '/tmp/fake/child';
const PARENT_WT = '/tmp/fake/parent';

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
    echo '{"ok":true,"result":{"terminals":[{"handle":"${HANDLE}","worktreePath":"${CHILD_WT}"}]}}'
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-lineage-'));
  log = join(dir, 'calls.log');
  writeFileSync(log, '');
  saved = {
    ORCA_BIN: process.env.ORCA_BIN,
    ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
    ORCA_PEER_REGISTRY_DIR: process.env.ORCA_PEER_REGISTRY_DIR,
  };
  process.env.ORCA_BIN = installFakeOrca();
  process.env.ORCA_TERMINAL_HANDLE = HANDLE;
  process.env.ORCA_PEER_REGISTRY_DIR = join(dir, 'peers');
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
