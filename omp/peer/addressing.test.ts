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
import { z } from 'zod';
import peerExtension, { recordReplyRoute } from './index.ts';
import { join } from 'node:path';

const WT_A = '/tmp/fake/t6-les-lots';
const WT_B = '/tmp/fake/t7-canal-de-scene';

let dir = '';
let peersDir = '';
let saved: Record<string, string | undefined> = {};
let caseId = 0;

type Term = { handle: string; worktreePath: string; connected?: boolean };

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

/**
 * Orca answering a list it CAPPED: `ok:true`, rows, and `truncated` beside
 * them. Indistinguishable from a complete answer to any reader that only looks
 * at `ok` — which is the case below.
 */
function truncatedTerminals(terms: Term[]): void {
  writeFileSync(
    join(dir, 'terminals.json'),
    JSON.stringify({ ok: true, result: { terminals: terms, truncated: true } }),
  );
}

/** A published registry entry: the Run is what makes a pane reachable. */
function publishEntry(handle: string, run: string, model = '', sessionId = 's'): void {
  writeFileSync(
    join(peersDir, `${handle}.json`),
    JSON.stringify({ handle, run, model, sessionId, ownerPid: process.pid }),
  );
}

async function load() {
  caseId += 1;
  // The naming rule and the send that consumes it, one fresh pair per case.
  // Both are stateless; the fresh specifier controls WHEN they first load,
  // after this case's env is in place.
  const address = await import(`./address.ts?addressing=${caseId}`);
  const send = await import(`./send.ts?addressing=${caseId}`);
  return { ...address, ...send };
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

test('an ambiguous prefix is an error, never a pick — and it hands back a selector that works', async () => {
  // `1657-spike` and `1657-styles` both up: resolving `1657` by sort order
  // sends worktree-specific detail to the wrong session.
  //
  // AND EVERY CANDIDATE CARRIES ITS SESSION ID, because the refusal is the only
  // thing the caller has left to act on. Reported 2026-09-08: a coordinator was
  // refused `peer 'ax' is ambiguous — matches ax·434a, ax·6c69, ax·988f` while
  // holding the very id the operator had given it. A session-id prefix is
  // already an accepted target (`SHORT_ID` below), so what the refusal owed it
  // was the ids of the three — instead it cost a `peer_list` and a re-send.
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: '/tmp/fake/1657-spike' },
    { handle: 'term_bbbb2222', worktreePath: '/tmp/fake/1657-styles' },
  ]);
  publishEntry('term_aaaa1111', 'run_a', '', '01a036ee-0719-7023-9ad5-f9336c8b96e6');
  publishEntry('term_bbbb2222', 'run_b', '', '01a036eb-12c5-7237-8161-98431d69972c');
  const { resolveTarget } = await load();

  const r = resolveTarget('1657');
  expect(r.address).toBeUndefined();
  expect(r.ambiguous?.sort()).toEqual(['1657-spike (01a036ee)', '1657-styles (01a036eb)']);
});

test('the id Orca shows on a card resolves, because that is what an operator relays', async () => {
  // Measured 2026-08-25: an orchestrator was told to answer "terminal
  // 01a036ee", which is a session-id prefix. `peer_send 01a036ee` answered
  // `unknown peer` while that session sat in `peer_list` under its worktree
  // name, so the operator had to cross-reference `orca terminal list --json` by
  // hand.
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_B },
  ]);
  publishEntry('term_aaaa1111', 'run_a', '', '01a036ee-0719-7023-9ad5-f9336c8b96e6');
  publishEntry('term_bbbb2222', 'run_b', '', '01a036eb-12c5-7237-8161-98431d69972c');
  const { resolveTarget, shortId } = await load();

  expect(shortId('01a036eb-12c5-7237-8161-98431d69972c')).toBe('01a036eb');
  // The two ids share seven characters, which is exactly the case a prefix
  // resolver has to get right rather than round to the first hit.
  expect(resolveTarget('01a036eb').address).toBe('run:run_b');
  expect(resolveTarget('01a036ee').address).toBe('run:run_a');
  // The full id works too — a caller reading it off a session file, not a card.
  expect(resolveTarget('01a036eb-12c5-7237-8161-98431d69972c').address).toBe('run:run_b');
});

test('an ambiguous id is an error, and an id nobody has resolves to nothing', async () => {
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_B },
  ]);
  publishEntry('term_aaaa1111', 'run_a', '', '01a036eeaaaa');
  publishEntry('term_bbbb2222', 'run_b', '', '01a036eebbbb');
  const { resolveTarget } = await load();

  expect(resolveTarget('01a036ee').ambiguous?.sort()).toEqual(['t6-les-lots (01a036ee)', 't7-canal-de-scene (01a036ee)']);
  expect(resolveTarget('deadbeef')).toEqual({});
});

test('an unreachable pane is not a resolution target', async () => {
  setTerminals([{ handle: 'term_cccc3333', worktreePath: WT_A }]);
  const { resolveTarget } = await load();
  expect(resolveTarget('t6-les-lots')).toEqual({});
});

test('a retained Orca slot whose registry owner is dead is not a reachable peer', async () => {
  setTerminals([{ handle: 'term_cccc3333', worktreePath: WT_A, connected: false }]);
  writeFileSync(
    join(peersDir, 'term_cccc3333.json'),
    JSON.stringify({
      handle: 'term_cccc3333',
      run: 'run_sleeping',
      model: 'claude-opus-5',
      sessionId: 'sleeping-session',
      ownerPid: 2147483646,
    }),
  );
  const { resolveTarget, peers } = await load();

  expect(peers()).toEqual([]);
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
  // Measured 2026-08-15. On a host that cannot see the orchestrator, the only
  // resolvable peer IS the child, so "report home" addressed the child. Orca
  // accepts such a send, so five hours of reports read as delivered from the
  // child's side and did not exist from the orchestrator's. The fake `orca`
  // here answers `ok: true` to any send, which is exactly the behaviour that
  // made this invisible — so this test fails without the guard.
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

test('a paneless parent Run retains a refused lateral send as an explicit queue', async () => {
  orcaSaysNothing();
  const calls: string[][] = [];
  const raw = (argv: string[]) => {
    calls.push(argv);
    return calls.length === 1
      ? { parsed: { ok: false }, text: 'dispatch_run_mismatch', stdout: '' }
      : { parsed: { ok: true }, text: '', stdout: '' };
  };
  const { sendToPeer } = await load();

  const out = sendToPeer(
    { target: 'run:run_sibling', text: 'handoff', type: 'status' },
    {
      runOrcaRaw: raw,
      resolveParent: () => ({ queued: { run: 'run_parent_unread', worktree: WT_A } }),
    },
  );

  expect(calls).toHaveLength(2);
  expect(calls[1].slice(0, 4)).toEqual(['orchestration', 'send', '--to', 'run:run_parent_unread']);
  expect(out).toEqual({ ok: true, via: 'relay', queued: { run: 'run_parent_unread' } });
});

test('a dispatch_run_mismatch reply keeps the thread, return address, and remote environment on the parent relay', async () => {
  // THE SENDER MUST HAVE A RUN OF ITS OWN, which the first draft of this case
  // did not give it: under `orcaSaysNothing()` there is no self peer, so there is
  // no return address to put in the payload and the case measured its own
  // fixture. A session answering a peer is registered by construction — it
  // received the message on its Run.
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_self');
  const calls: string[][] = [];
  const raw = (argv: string[]) => {
    calls.push(argv);
    return calls.length === 1
      ? { parsed: { ok: false }, text: 'dispatch_run_mismatch', stdout: '' }
      : { parsed: { ok: true }, text: '', stdout: '' };
  };
  const { deliver } = await load();

  const out = deliver(
    {
      address: 'run:run_sibling',
      text: 'pong',
      type: 'status' as const,
      threadId: 'msg_d3385d25590a',
      environment: 'vps',
      targetName: 'sibling',
    },
    {
      runOrcaRaw: raw,
      resolveParent: () => ({ peer: { run: 'run_parent', peer: 'parent' } as never }),
    },
  );

  expect(out).toEqual({ ok: true, via: 'relay' });
  expect(calls).toHaveLength(2);
  // ONE THREAD AND ONE RETURN ADDRESS ON EVERY HOP. A relay that drops either
  // ends the conversation at its second turn: the answer arrives unthreaded and
  // the recipient's own reply has nowhere to go.
  for (const argv of calls) {
    expect(argv).toContain('--thread-id');
    expect(argv[argv.indexOf('--thread-id') + 1]).toBe('msg_d3385d25590a');
    const payload = JSON.parse(argv[argv.indexOf('--payload') + 1] as string) as {
      replyTo?: string;
    };
    expect(payload.replyTo).toBe('run:run_self');
  }
  // The DESTINATION's host, on the hop that addresses the destination. The
  // parent is host-local by construction (`lineage.ts`), so sending its Run with
  // `--environment vps` would resolve that Run on the wrong runtime and lose the
  // relay — the environment rides in the payload for the parent to re-apply.
  expect(calls[0]).toContain('--environment');
  expect(calls[0][calls[0].indexOf('--environment') + 1]).toBe('vps');
  expect(calls[1]).not.toContain('--environment');
  const relayed = JSON.parse(calls[1][calls[1].indexOf('--payload') + 1] as string) as {
    forwardTo?: string;
    forwardThreadId?: string;
    forwardEnvironment?: string;
    replyTo?: string;
  };
  expect(relayed.forwardTo).toBe('run:run_sibling');
  expect(relayed.forwardThreadId).toBe('msg_d3385d25590a');
  expect(relayed.forwardEnvironment).toBe('vps');
  expect(relayed.replyTo).toBe('run:run_self');
});

test('a reply and a send are the SAME transport, not two spellings of one', async () => {
  // #231: `peer_reply` spawned its own `orchestration send` with no relay branch
  // at all, so a dispatch-bound session could send laterally through the parent
  // and not ANSWER through it — the reply failed with `dispatch_run_mismatch`
  // while the tool that had just delivered the question succeeded. Both verbs go
  // through `deliver` now, and this pins that they do: the reply-shaped call and
  // the send-shaped call produce the same two hops.
  setTerminals([
    { handle: 'term_aaaa1111', worktreePath: WT_A },
    { handle: 'term_bbbb2222', worktreePath: WT_B },
  ]);
  publishEntry('term_aaaa1111', 'run_self');
  publishEntry('term_bbbb2222', 'run_b');
  const seen: string[][] = [];
  const raw = (argv: string[]) => {
    seen.push(argv);
    return seen.length % 2 === 1
      ? { parsed: { ok: false }, text: 'dispatch_run_mismatch', stdout: '' }
      : { parsed: { ok: true }, text: '', stdout: '' };
  };
  const seams = {
    runOrcaRaw: raw,
    resolveParent: () => ({ peer: { run: 'run_parent', peer: 'parent' } as never }),
  };
  const { deliver, sendToPeer } = await load();

  expect(sendToPeer({ target: 't7-canal-de-scene', text: 'hi' }, seams)).toEqual({
    ok: true,
    via: 'relay',
  });
  expect(deliver({ address: 'run:run_b', text: 'hi', targetName: 't7-canal-de-scene' }, seams)).toEqual({
    ok: true,
    via: 'relay',
  });

  const shape = (argv: string[]) => [argv[2], argv[3], argv.includes('--payload')];
  expect(shape(seen[0])).toEqual(shape(seen[2]));
  expect(shape(seen[1])).toEqual(shape(seen[3]));
  for (const argv of [seen[1], seen[3]]) {
    const bag = JSON.parse(argv[argv.indexOf('--payload') + 1] as string) as {
      forwardTo?: string;
    };
    expect(bag.forwardTo).toBe('run:run_b');
  }
});

test('the registered peer_reply tool relays an answer and preserves the next answer route', async () => {
  // Drive the tool Orca actually exposes, not a wrapper or argv builder. Install
  // the route through the same receiver-owned operation used in production,
  // parse the params through its real zod schema, then call its registered
  // execute handler.
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_self');
  const calls: string[][] = [];
  const raw = (argv: string[]) => {
    calls.push(argv);
    return calls.length === 1
      ? { parsed: { ok: false }, text: 'dispatch_run_mismatch', stdout: '' }
      : { parsed: { ok: true }, text: '', stdout: '' };
  };
  const { deliver } = await load();
  const tools = new Map<string, {
    parameters: { parse: (value: unknown) => Record<string, unknown> };
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  }>();
  peerExtension(
    {
      zod: z,
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
      on: () => {},
      registerCommand: () => {},
      addTool: () => {},
      sendMessage: () => {},
      appendEntry: () => {},
    } as never,
    {
      deliver: (request) => deliver(request, {
        runOrcaRaw: raw,
        resolveParent: () => ({ peer: { run: 'run_parent', peer: 'parent' } as never }),
      }),
    },
  );
  recordReplyRoute('msg_answer', {
    run: 'run:run_sibling',
    peer: 'sibling',
    environment: 'vps',
    threadId: 'msg_question',
  });

  const tool = tools.get('peer_reply');
  expect(tool).toBeDefined();
  const params = tool!.parameters.parse({ message_id: 'msg_answer', text: 'pong' });
  const result = await tool!.execute('call-1', params);

  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('through the shared parent');
  expect(calls).toHaveLength(2);
  const repost = calls[1];
  expect(repost[repost.indexOf('--thread-id') + 1]).toBe('msg_question');
  const envelope = JSON.parse(repost[repost.indexOf('--payload') + 1] as string) as {
    replyTo?: string;
    forwardThreadId?: string;
    forwardEnvironment?: string;
  };
  expect(envelope.forwardThreadId).toBe('msg_question');
  // The destination can answer THIS answer directly back to the original
  // sender. That is the second half of the two-way contract, not merely "one
  // send returned ok".
  expect(envelope.replyTo).toBe('run:run_self');
});

// ── #220 at the tool surface: an unread inventory is not an empty machine ─────

/** The tools this extension registers, driven as Orca drives them. */
function installTools(): Map<
  string,
  {
    parameters: { parse: (value: unknown) => Record<string, unknown> };
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  }
> {
  const tools = new Map();
  peerExtension(
    {
      zod: z,
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
      on: () => {},
      registerCommand: () => {},
      addTool: () => {},
      sendMessage: () => {},
      appendEntry: () => {},
    } as never,
    { deliver: () => ({ ok: true }) as never },
  );
  return tools as never;
}

test('peer_list on an unreadable inventory names the inability, never nobody', async () => {
  // THE DEFECT, at the surface a model reads. `orca terminal list` refusing
  // printed "No reachable peers. A session registers itself when it starts." —
  // a claim about who is up on this machine, made out of an inability to look.
  // An orchestrator acting on it concludes its children are gone.
  orcaSaysNothing();
  const tool = installTools().get('peer_list');
  const result = await tool!.execute('call-1', {});
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).not.toContain('No reachable peers');
  expect(result.content[0]?.text).toContain('terminal list');
});

test('peer_list on a truncated list refuses too, though Orca answered ok', async () => {
  // A capped list carries rows, so this one would otherwise print a TABLE and
  // pass it off as the machine — the omission that survives the refusal above.
  truncatedTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_a');
  const tool = installTools().get('peer_list');
  const result = await tool!.execute('call-1', {});
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).not.toContain('t6-les-lots');
});

test('peer_list on a list Orca answered as empty still states the absence', async () => {
  // The positive control: a read machine with nobody registered on it is a
  // measurement, and the wording that reports it must not be widened away.
  setTerminals([]);
  const tool = installTools().get('peer_list');
  const result = await tool!.execute('call-1', {});
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('No reachable peers');
});

test('peer_list on a complete list prints the table it always printed', async () => {
  setTerminals([{ handle: 'term_aaaa1111', worktreePath: WT_A }]);
  publishEntry('term_aaaa1111', 'run_a', 'grok-4.5', 'sess_aaaa1111');
  const tool = installTools().get('peer_list');
  const result = await tool!.execute('call-1', {});
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('PEER  MODEL  DEPTH  ID  WORKTREE');
  expect(result.content[0]?.text).toContain('t6-les-lots');
});

