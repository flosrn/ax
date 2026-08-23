/**
 * The rule that decides what a session is CALLED, and who a typed name reaches.
 *
 * This is the load-bearing half of the peer registry and it had no tests. An
 * address built wrong does not fail loudly: it delivers a worktree-specific
 * instruction, or a child's completion report, to a stranger. D-030 collapsed
 * two copies of this rule into one implementation precisely because the two
 * could disagree — which leaves the surviving copy as the thing worth pinning.
 *
 * Orca is faked through `ORCA_BIN`, read by `resolveOrcaBin` at module load, so
 * each case imports the module under a fresh specifier for its own instance.
 * The registry is a temp directory via `ORCA_PEER_REGISTRY_DIR`; nothing here
 * touches the live one.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WT_A = '/tmp/fake/t6-les-lots';
const WT_B = '/tmp/fake/t7-canal-de-scene';

let dir = '';
let peersDir = '';
let saved: Record<string, string | undefined> = {};
let caseId = 0;

type Term = { handle: string; worktreePath: string };

/** A fake `orca` that answers `terminal list` from a file written per case. */
function installFakeOrca(): string {
  const bin = join(dir, 'orca');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$*" in
  *"terminal list"*) cat "${dir}/terminals.json" ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function setTerminals(terms: Term[]): void {
  writeFileSync(
    join(dir, 'terminals.json'),
    JSON.stringify({ ok: true, result: { terminals: terms } }),
  );
}

/** Orca answering nothing at all — the case that must NOT fall back. */
function orcaSaysNothing(): void {
  writeFileSync(join(dir, 'terminals.json'), JSON.stringify({ ok: false }));
}

/** A published registry entry: the Run is what makes a pane reachable. */
function publishEntry(handle: string, run: string, model = ''): void {
  writeFileSync(
    join(peersDir, `${handle}.json`),
    JSON.stringify({ handle, run, model, sessionId: 's', ownerPid: process.pid }),
  );
}

async function load() {
  return import(`./registry.ts?addressing=${++caseId}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-addressing-'));
  peersDir = join(dir, 'peers');
  mkdirSync(peersDir, { recursive: true });
  saved = {
    ORCA_BIN: process.env.ORCA_BIN,
    ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
    ORCA_PEER_REGISTRY_DIR: process.env.ORCA_PEER_REGISTRY_DIR,
  };
  process.env.ORCA_BIN = installFakeOrca();
  process.env.ORCA_TERMINAL_HANDLE = 'term_aaaa1111';
  process.env.ORCA_PEER_REGISTRY_DIR = peersDir;
  setTerminals([]);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ naming --

test('a lone pane is named by its worktree basename', async () => {
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_a');
  const { peers } = await load();
  expect(peers().map((p) => p.peer)).toEqual(['t6-les-lots']);
});

test('two reachable panes in one worktree disambiguate by handle, not by order', async () => {
  // A suffix that depended on who registered first would rename a session
  // whenever a sibling restarted, and every address anyone had written down
  // would silently point elsewhere.
  setTerminals([
    { handle: 'term_bbbb2222', worktreePath: WT_A },
    { handle: 'term_aaaa1111', worktreePath: WT_A },
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  publishEntry('term_bbbb2222', 'run_b');
  const { peers } = await load();
  expect(peers().map((p) => p.peer).sort()).toEqual(['t6-les-lots·aaaa', 't6-les-lots·bbbb']);
});

test('an unregistered shell beside the agent does not push the agent onto a suffix', async () => {
  // Filter FIRST, then disambiguate. Orca's setup pane sits in every worktree
  // on this machine, so getting this backwards would suffix nearly every name
  // and break every address a human had learned.
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_cccc3333', worktreePath: WT_A }, // a plain shell, no Run
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  const { peers } = await load();
  expect(peers().map((p) => p.peer)).toEqual(['t6-les-lots']);
});

test('panes() keeps the unregistered pane, because an incoming message still needs a label', async () => {
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_cccc3333', worktreePath: WT_A },
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  const { panes, peers } = await load();
  expect(panes()).toHaveLength(2);
  expect(peers()).toHaveLength(1);
  // Both are in one worktree here, so both are suffixed — attribution names
  // the pane, it does not promise the pane can be answered.
  expect(panes().every((p) => p.peer.includes('\u00b7'))).toBe(true);
});

test('no Orca means no peers — never a registry-only list', async () => {
  // The registry is a same-UID directory any local process can write, so a
  // name claimed there is forgeable. Falling back to it when Orca is down
  // would reinstate exactly the naming this join exists to remove.
  orcaSaysNothing();
  publishEntry('term_aaaa1111', 'run_a');
  const { peers, panes } = await load();
  expect(peers()).toEqual([]);
  expect(panes()).toEqual([]);
});

test('`pending` lets a session see itself before it owns a Run', async () => {
  // A session must know its name BEFORE creating its Run: the Run is tagged
  // with that name and re-adopted by prefix on restart, so an empty name makes
  // the tag `peer session: ` — a prefix of every peer Run.
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  const { peers } = await load();
  expect(peers()).toEqual([]);
  expect(peers('term_aaaa1111').map((p) => p.peer)).toEqual(['t6-les-lots']);
});

test('this session names itself the same way everyone else names it', async () => {
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_A },
  ]);
  publishEntry('term_bbbb2222', 'run_b');
  const { resolvePeerName, peers } = await load();
  const mine = resolvePeerName();
  expect(mine).toBe('t6-les-lots·aaaa');
  // And a peer looking at the fleet sees that exact string.
  publishEntry('term_aaaa1111', 'run_a');
  expect(peers().map((p) => p.peer)).toContain(mine);
});

test('a session Orca cannot place falls back to its cwd, sanitised', async () => {
  orcaSaysNothing();
  const { resolvePeerName } = await load();
  const name = resolvePeerName();
  expect(name).toBe((process.cwd().split('/').pop() || 'session').replace(/[^A-Za-z0-9._-]+/g, '-'));
  expect(name).not.toContain('/');
});

// --------------------------------------------------------------- targeting --

test('an exact name wins over a prefix that also matches it', async () => {
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: '/tmp/fake/spike' },
    { handle: 'term_bbbb2222', worktreePath: '/tmp/fake/spike-styles' },
  ]);
  publishEntry('term_aaaa1111', 'run_exact');
  publishEntry('term_bbbb2222', 'run_other');
  const { resolveTarget } = await load();
  expect(resolveTarget('spike').address).toBe('run:run_exact');
});

test('a unique prefix resolves', async () => {
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_B },
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  publishEntry('term_bbbb2222', 'run_b');
  const { resolveTarget } = await load();
  expect(resolveTarget('t7').address).toBe('run:run_b');
});

test('an ambiguous prefix is an error, never a pick', async () => {
  // `1657-spike` and `1657-styles` both up: resolving `1657` by sort order
  // sends worktree-specific detail to the wrong session.
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: '/tmp/fake/1657-spike' },
    { handle: 'term_bbbb2222', worktreePath: '/tmp/fake/1657-styles' },
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  publishEntry('term_bbbb2222', 'run_b');
  const { resolveTarget } = await load();
  const r = resolveTarget('1657');
  expect(r.address).toBeUndefined();
  expect(r.ambiguous?.sort()).toEqual(['1657-spike', '1657-styles']);
});

test('an unreachable pane is not a resolution target', async () => {
  setTerminals([{ handle: 'term_cccc3333', worktreePath: WT_A }]);
  const { resolveTarget } = await load();
  expect(resolveTarget('t6-les-lots')).toEqual({});
});

test('a raw address passes through without a lookup', async () => {
  orcaSaysNothing(); // a lookup here would fail; none must happen
  const { resolveTarget } = await load();
  for (const raw of ['run:run_x', 'term_zzzz', '@all', 'dispatch:ctx_1'])
    expect(resolveTarget(raw)).toEqual({ address: raw });
});

test('a resolved target carries the handle and worktree, not just the address', async () => {
  // `sendToPeer` reports which worktree it reached; a bare address would make
  // "sent" indistinguishable from "sent to the wrong pane".
  setTerminals([{ handle: 'term_bbbb2222', worktreePath: WT_B }]);
  publishEntry('term_bbbb2222', 'run_b');
  const { resolveTarget } = await load();
  expect(resolveTarget('t7-canal-de-scene')).toEqual({
    address: 'run:run_b',
    handle: 'term_bbbb2222',
    worktree: WT_B,
  });
});

test('one corrupt registry file costs one peer, not the fleet', async () => {
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_B },
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  writeFileSync(join(peersDir, 'term_bbbb2222.json'), '{"handle": "term_bbbb'); // half-written
  const { peers } = await load();
  expect(peers().map((p) => p.peer)).toEqual(['t6-les-lots']);
});

// --------------------------------------------------------------- self-send --

test('a session refuses to send to itself, even when its own name resolves', async () => {
  // Measured 2026-08-15. On a host that cannot see the coordinator, the only
  // resolvable peer IS the child, so "report home" addressed the child. Orca
  // accepts such a send, so five hours of reports read as delivered from the
  // child's side and did not exist from the coordinator's. The fake `orca` here
  // answers `ok: true` to any send, which is exactly the behaviour that made
  // this invisible — so this test fails without the guard.
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_a');
  const { sendToPeer } = await load();
  const out = sendToPeer({ target: 't6-les-lots', text: 'done' });
  expect(out.ok).toBe(false);
  expect(out.error).toContain('this session itself');
});

test('a raw run address naming this session is refused too', async () => {
  // The by-name lookup is not the only way in: `report()` builds `run:<id>` and
  // a caller may type one, both of which skip `resolveTarget`'s peer list.
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_a');
  const { sendToPeer } = await load();
  expect(sendToPeer({ target: 'run:run_a', text: 'done' }).ok).toBe(false);
});

test('a sibling on the same host is still reachable', async () => {
  // The guard must not become a blanket refusal: lateral sends between panes
  // that CAN see each other are the registry's whole purpose.
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_B },
  ]);
  publishEntry('term_aaaa1111', 'run_a');
  publishEntry('term_bbbb2222', 'run_b');
  const { sendToPeer } = await load();
  expect(sendToPeer({ target: 't7-canal-de-scene', text: 'hi' }).ok).toBe(true);
});
