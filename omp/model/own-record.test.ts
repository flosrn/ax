/**
 * "WHICH SESSION FILE IS MINE, when the host will not say?"
 *
 * Measured 2026-09-15 across goodluckagency/ofmchat #253-#257. Three children
 * were dispatched with a correct marker in their own first user message, and
 * all three kept their BOOT model, took no role and wrote no receipt. The log
 * named the branch: twelve `[orca-model]` lines in the child's own process log,
 * every one of them `factory instance …`, and not one outcome line — which is
 * the signature of the two SILENT branches, and `not-supervised` is excluded by
 * the child holding a pane handle. So: `absent`.
 *
 * `absent` sends the machinery to read the marker from the session's own
 * transcript, and that read depends on the HOST naming a file. When nothing
 * names one, the marker is never read: `worker-list` had no row for the handle
 * (F-048's own drift, measured the same day as `worker-list reports 0
 * entry(ies)`), so both halves of the equipment path failed together and the
 * child worked unequipped in silence.
 *
 * THE REPAIR IS A JOIN, NOT A NEW DERIVATION, and that is the whole point. Two
 * readers already answer the two halves, each with its own tests and its own
 * F-028 refusals:
 *
 *   handle -> request        `dispatchIndex` (../../src/worker/record.mjs), the
 *                            same query `src/worker/tail.mjs` makes to name a
 *                            pane's owner
 *   record -> session file   `briefDelivered` (../../src/worker/delivered.mjs),
 *                            which selects by DISPATCH ID rather than
 *                            newest-wins, refuses two worktrees, refuses a
 *                            session older than the dispatch, and refuses zero
 *                            or two candidates
 *
 * So this module composes them and inherits every refusal. Nothing here decides
 * what a session file is, and nothing here guesses: an ambiguity is an inability
 * (F-028), because the wrong answer would apply another child's role to this
 * pane.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../../src/worker/record.mjs';
import { slugOf } from '../../src/worker/transcript.mjs';
import { readModelIntent } from './alias.ts';
import orcaModel from './index.ts';
import { ownSessionFile } from './own-record.ts';
import { readRoleIntent } from './role.ts';
import { readSpecFromTranscript } from './self.ts';

const HANDLE = 'term_c505906c-b9a9-40da-a3bb-e4bfbaec72e4';
const DISPATCH = 'ctx_4bddf5adb746';
const REQUEST = '254-fix-254-abandoned-import-batches';
const ISSUED = '2026-09-15T07:19:30.000Z';
const MARKER = '[omp role=worker model=@default]';

let home = '';
let store = '';
let worktree = '';
let sessions = '';
let env: Record<string, string> = {};

/** The dispatch as `worker start` writes it: a worker-start phase naming the pane and the tree. */
function record({ handle = HANDLE, dispatchId = DISPATCH, request = REQUEST, tree = worktree } = {}): string {
  const { path } = claimRecord(store, request);
  initRecord(path, { request, orca: 'orca', host: 'mac', now: () => ISSUED });
  phaseBegin(path, { name: 'worker-start', identity: 'id-1', argv: ['worker-start'], now: () => ISSUED });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({
      ok: true,
      result: {
        dispatchId,
        state: 'ready',
        effects: [
          { kind: 'terminal', id: handle },
          { kind: 'worktree', id: `repo_1::${tree}` },
        ],
      },
    }),
  });
  return path;
}

/** The child's own transcript, as Orca writes it: the brief carries the dispatch id AND the marker. */
function transcript({ dispatchId = DISPATCH, at = '2026-09-15T07-19-36-299Z', tree = worktree, text = '' } = {}): string {
  const dir = join(sessions, slugOf(tree, env));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${at}_01a0a3ef-7c6b-7716-b89d-1ea809e1c8e7.jsonl`);
  writeFileSync(
    file,
    `${[
      JSON.stringify({ type: 'session', version: 3, timestamp: at.replace(/-/g, ':'), cwd: tree }),
      JSON.stringify({ type: 'model_change', model: 'omniroute/opus-5' }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                text ||
                `You are a dispatched worker.\nYour dispatch is ${dispatchId}.\n${'preamble '.repeat(30)}\n=== TASK ===\n${MARKER} Ship this ticket.`,
            },
          ],
        },
      }),
    ].join('\n')}\n`,
  );
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ax-own-record-'));
  store = join(home, 'store');
  worktree = join(home, 'Code', 'ofm', 'ofmchat', '.worktrees', REQUEST);
  sessions = join(home, '.omp', 'agent', 'sessions');
  mkdirSync(worktree, { recursive: true });
  env = { HOME: home, ORCA_DISPATCH_STORE: store };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('a dispatched child finds its OWN transcript through the record that names its pane', () => {
  record();
  const file = transcript();

  const out = ownSessionFile(HANDLE, env);

  expect(out.file).toBe(file);
  expect(out.request).toBe(REQUEST);
  expect(out.reason).toBeUndefined();
});

test('the marker in that transcript is the one a parent wrote', () => {
  // The join is only worth having if what it hands back APPLIES, so this drives
  // the real readers over the real file rather than asserting a path.
  record();
  transcript();

  const spec = readSpecFromTranscript(ownSessionFile(HANDLE, env).file);
  expect(readModelIntent(spec.spec).spec).toBe('@default');
  expect(readModelIntent(spec.spec).source).toBe('marker');
  expect(readRoleIntent(spec.spec)).toBe('worker');
});

test('an operator pane owns no record, and that is an absence rather than a fault', () => {
  record();
  transcript();

  const out = ownSessionFile('term_an-operators-own-pane', env);

  expect(out.file).toBeNull();
  expect(out.request).toBeNull();
  expect(out.reason).toContain('no dispatch record');
});

test('two records naming one pane is an inability, never a pick', () => {
  // A repair reuses the agent terminal, so two records CAN name one handle.
  // Choosing between them would apply another child's role to this session.
  record();
  record({ request: 'a-second-pass', dispatchId: 'ctx_second000000' });
  transcript();

  const out = ownSessionFile(HANDLE, env);

  expect(out.file).toBeNull();
  expect(out.reason).toContain('2');
});

test('a record whose session cannot be established yields no file and says which half failed', () => {
  // The record is there and names this pane; the transcript is not. The
  // refusal has to separate "no record" from "no session", because the repairs
  // are different and one of them is an operator pane behaving normally.
  record();

  const out = ownSessionFile(HANDLE, env);

  expect(out.file).toBeNull();
  expect(out.request).toBe(REQUEST);
  expect(out.reason).toBeTruthy();
  expect(out.reason).not.toContain('no dispatch record');
});

test('no handle at all is refused before the store is read', () => {
  record();
  for (const nothing of ['', null, undefined]) {
    const out = ownSessionFile(nothing as never, env);
    expect(out.file).toBeNull();
    expect(out.reason).toContain('no pane handle');
  }
});

test('a store that cannot be read is an INABILITY, never the operator-pane absence', () => {
  // `dispatchIndex` answers an empty map beside `missing`/`reason` rather than
  // throwing, so reading the empty map as "no record names me" would render an
  // unreadable store as "this is an operator's pane" — the F-028 shape this
  // module's own header is about, committed inside it once.
  record();
  transcript();

  // A record that does not parse: the store is there, this pane may well be a
  // child, and nothing established that it is not.
  writeFileSync(join(store, 'broken.json'), '{ not json');
  const unreadable = ownSessionFile('term_unknown-to-a-broken-store', env);
  expect(unreadable.file).toBeNull();
  expect(unreadable.reason).toContain('could not be read');
  expect(unreadable.reason).toContain('unestablished');
  expect(unreadable.reason).not.toContain('no dispatch record in');

  // And a store that is not there at all says THAT, which is a different repair.
  const nowhere = ownSessionFile(HANDLE, { HOME: home, ORCA_DISPATCH_STORE: join(home, 'no-such-store') });
  expect(nowhere.file).toBeNull();
  expect(nowhere.reason).toContain('does not exist');
});

/**
 * THE WIRING, which is the only thing that equips anybody.
 *
 * The reader above is inert until the model/role machinery consults it, and the
 * measured failure is exactly the shape below: `worker-list` answers with no
 * row for this handle, the host names no session file, and the marker sits in
 * the child's own transcript. Every ofmchat child kept its boot model in
 * silence there. This asserts the model is APPLIED instead.
 */
test('the factory equips a child with no sessionManager and no worker-list row', async () => {
  record();
  transcript({ text: `You are a dispatched worker.\nYour dispatch is ${DISPATCH}.\n=== TASK ===\n[omp role=supervisor model=@default] Ship it.` });

  const savedHome = process.env.HOME;
  const savedStore = process.env.ORCA_DISPATCH_STORE;
  process.env.HOME = home;
  process.env.ORCA_DISPATCH_STORE = store;
  try {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const applied: unknown[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      setModel: (model: unknown) => {
        applied.push(model);
      },
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    // The host shape that made this silent: a models facade, and NO session file.
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };

    orcaModel(pi as never, {
      handle: HANDLE,
      // Orca answering honestly with a list this child is not in — F-048's drift.
      run: async () => ({ value: { ok: true, result: { workers: [], counts: {} } } }),
    });
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);

    expect(applied).toEqual([{ provider: 'stub', id: '@default' }]);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStore === undefined) delete process.env.ORCA_DISPATCH_STORE;
    else process.env.ORCA_DISPATCH_STORE = savedStore;
  }
});

test('a record-owned pane whose spec cannot be read SAYS so; an operator pane stays silent', async () => {
  // The discriminator the earlier attempt got wrong, now keyed on the record
  // rather than on the handle: an operator pane has a handle too, so a warning
  // keyed on that fired on every session and was reverted. Here the record is
  // present and names this pane, and the transcript is NOT — the one shape the
  // silence must not cover.
  record();

  const savedHome = process.env.HOME;
  const savedStore = process.env.ORCA_DISPATCH_STORE;
  process.env.HOME = home;
  process.env.ORCA_DISPATCH_STORE = store;
  try {
    const drive = async (handle: string) => {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const warned: string[] = [];
      const pi = {
        on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
          handlers.set(event, handler);
        },
        setModel: () => {},
        setThinkingLevel: () => {},
        logger: { info: () => {}, warn: (line: string) => warned.push(line) },
      };
      const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };
      orcaModel(pi as never, { handle, run: async () => ({ value: { ok: true, result: { workers: [], counts: {} } } }) });
      await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
      await handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, ctx);
      return warned;
    };

    const child = await drive(HANDLE);
    expect(child).toHaveLength(1);
    expect(child[0]).toContain(REQUEST);
    expect(child[0]).toContain('BOOT model');
    expect(child[0]).toContain('no tool fence');

    const operator = await drive('term_an-operators-own-pane');
    expect(operator).toEqual([]);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStore === undefined) delete process.env.ORCA_DISPATCH_STORE;
    else process.env.ORCA_DISPATCH_STORE = savedStore;
  }
});
