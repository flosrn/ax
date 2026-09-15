/**
 * "WHICH RECORDED BRIEF IS MINE?" — the tests for the join in
 * `./own-record.ts`.
 *
 * The child's pane selects exactly one readable dispatch record through
 * `dispatchIndex`; `workerSpec` then returns that record's exact
 * `task-create --spec` text. This source is complete before a cold child's
 * first user turn reaches its session file, so it cannot lose the equipment
 * marker to a transcript flush race.
 *
 * The refusal boundaries are the contract: two records naming one pane, an
 * unreadable store, or a record with no task spec are inabilities. A pane named
 * by no record is an operator session and stays quiet. Nothing picks the newest
 * record or session.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../../src/worker/record.mjs';
import { readModelIntent } from './alias.ts';
import orcaModel from './index.ts';
import { ownDispatchSpec } from './own-record.ts';
import { readRoleIntent } from './role.ts';

const HANDLE = 'term_c505906c-b9a9-40da-a3bb-e4bfbaec72e4';
const DISPATCH = 'ctx_4bddf5adb746';
const REQUEST = '254-fix-254-abandoned-import-batches';
const ISSUED = '2026-09-15T07:19:30.000Z';
const MARKER = '[omp role=worker model=@default]';

let home = '';
let store = '';
let worktree = '';
let env: Record<string, string> = {};

/** The dispatch as `worker start` writes it: a worker-start phase naming the pane and the tree. */
function record({
  handle = HANDLE,
  dispatchId = DISPATCH,
  request = REQUEST,
  tree = worktree,
  spec = `${MARKER} Ship this ticket.`,
}: {
  handle?: string;
  dispatchId?: string;
  request?: string;
  tree?: string;
  spec?: string | null;
} = {}): string {
  const { path } = claimRecord(store, request);
  initRecord(path, { request, orca: 'orca', host: 'mac', now: () => ISSUED });
  if (spec !== null) {
    phaseBegin(path, {
      name: 'task-create',
      identity: 'id-0',
      argv: ['task-create', '--spec', spec],
      now: () => ISSUED,
    });
    phaseEnd(path, 'last', {
      exit: 0,
      receiptText: JSON.stringify({ ok: true, result: { task: { id: 'task_1' } } }),
    });
  }
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


beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ax-own-record-'));
  store = join(home, 'store');
  worktree = join(home, 'Code', 'ofm', 'ofmchat', '.worktrees', REQUEST);
  mkdirSync(worktree, { recursive: true });
  env = { HOME: home, ORCA_DISPATCH_STORE: store };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the marker in the write-ahead record is the one a parent wrote', () => {
  // The record is the source the model/role machinery can read before the
  // child's first user turn is flushed. Drive the real marker readers over its
  // exact task-create --spec value rather than asserting the string by hand.
  record();
  const own = ownDispatchSpec(HANDLE, env);

  expect(own.owned).toBeTrue();
  expect(own.reason).toBeUndefined();
  expect(readModelIntent(own.spec).spec).toBe('@default');
  expect(readModelIntent(own.spec).source).toBe('marker');
  expect(readRoleIntent(own.spec)).toBe('worker');
});

test('an operator pane owns no record, and that is an absence rather than a fault', () => {
  record();

  const out = ownDispatchSpec('term_an-operators-own-pane', env);

  expect(out.spec).toBeNull();
  expect(out.request).toBeNull();
  expect(out.owned).toBeFalse();
  expect(out.reason).toContain('no dispatch record');
});

test('two records naming one pane is an inability, never a pick', () => {
  // A repair reuses the agent terminal, so two records CAN name one handle.
  // Choosing between them would apply another child's role to this session.
  record();
  record({ request: 'a-second-pass', dispatchId: 'ctx_second000000' });

  const out = ownDispatchSpec(HANDLE, env);

  expect(out.spec).toBeNull();
  expect(out.request).toBeNull();
  expect(out.owned).toBeTrue();
  expect(out.reason).toContain('2 dispatch records name');
  expect(out.reason).toContain('a-second-pass');
});

test('a record whose task spec cannot be read yields no spec and says which half failed', () => {
  record({ spec: null });

  const out = ownDispatchSpec(HANDLE, env);

  expect(out.spec).toBeNull();
  expect(out.owned).toBeTrue();
  expect(out.request).toBe(REQUEST);
  expect(out.reason).toContain('no readable task spec');
});

test('no handle at all is refused before the store is read', () => {
  record();
  for (const nothing of ['', null, undefined]) {
    const out = ownDispatchSpec(nothing as never, env);
    expect(out.spec).toBeNull();
    expect(out.reason).toContain('no pane handle');
  }
});

test('a store that cannot be read is an INABILITY, never the operator-pane absence', () => {
  // `dispatchIndex` answers an empty map beside `missing`/`reason` rather than
  // throwing, so reading the empty map as "no record names me" would render an
  // unreadable store as "this is an operator's pane" — the F-028 shape this
  // module's own header is about, committed inside it once.
  record();

  // A record that does not parse: the store is there, this pane may well be a
  // child, and nothing established that it is not.
  writeFileSync(join(store, 'broken.json'), '{ not json');
  const unreadable = ownDispatchSpec('term_unknown-to-a-broken-store', env);
  expect(unreadable.spec).toBeNull();
  expect(unreadable.reason).toContain('could not be read');
  expect(unreadable.reason).toContain('unestablished');
  expect(unreadable.reason).not.toContain('no dispatch record in');

  // And a store that is not there at all says THAT, which is a different repair.
  const nowhere = ownDispatchSpec(HANDLE, { HOME: home, ORCA_DISPATCH_STORE: join(home, 'no-such-store') });
  expect(nowhere.spec).toBeNull();
  expect(nowhere.reason).toContain('does not exist');
});

/**
 * THE WIRING, which is the only thing that equips anybody.
 *
 * The reader above is inert until the model/role machinery consults it. The
 * first repair found the transcript through the record, but still read the
 * marker FROM that transcript. In a cold child `before_agent_start` precedes
 * the first user-turn flush, so the right file exists with only its BOOT
 * `model_change`: the child again stays unequipped in silence. The parent wrote
 * the same marker into `task-create --spec` before opening the pane; this test
 * leaves the transcript absent and requires that race-free source to apply.
 */
test('the factory equips a child before its host-named transcript flushes a user turn', async () => {
  record();
  const transcript = join(home, 'child.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'model_change', model: 'omniroute/opus-5' })}\n`);

  const savedHome = process.env.HOME;
  const savedStore = process.env.ORCA_DISPATCH_STORE;
  process.env.HOME = home;
  process.env.ORCA_DISPATCH_STORE = store;
  try {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const applied: unknown[] = [];
    const entries: { customType: string; data: unknown }[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
      setModel: (model: unknown) => applied.push(model),
      setThinkingLevel: () => {},
      appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
      logger: { info: () => {}, warn: () => {} },
    };
    const ctx = {
      models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) },
      sessionManager: { getSessionFile: () => transcript },
    };

    orcaModel(pi as never, {
      handle: HANDLE,
      run: async () => ({ value: { ok: true, result: { workers: [], counts: {} } } }),
    });
    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    expect(applied).toEqual([]);

    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: ['base'] }, ctx);

    expect(applied).toEqual([{ provider: 'stub', id: '@default' }]);
    expect(entries).toContainEqual(expect.objectContaining({
      customType: '@flosrn/ax/model-assignment',
      data: expect.objectContaining({ via: 'record' }),
    }));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStore === undefined) delete process.env.ORCA_DISPATCH_STORE;
    else process.env.ORCA_DISPATCH_STORE = savedStore;
  }
});

test('an operator input outranks a historical record that still names the reused pane', async () => {
  record();

  const savedHome = process.env.HOME;
  const savedStore = process.env.ORCA_DISPATCH_STORE;
  process.env.HOME = home;
  process.env.ORCA_DISPATCH_STORE = store;
  try {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const applied: unknown[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
      setModel: (model: unknown) => applied.push(model),
      setThinkingLevel: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const ctx = { models: { resolve: (spec: string) => ({ provider: 'stub', id: spec }) } };
    orcaModel(pi as never, {
      handle: HANDLE,
      run: async () => ({ value: { ok: true, result: { workers: [], counts: {} } } }),
    });

    await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
    await handlers.get('input')?.({ type: 'input', text: 'Operator question with no equipment marker.' }, ctx);
    await handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPrompt: ['base'] }, ctx);

    expect(applied).toEqual([]);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStore === undefined) delete process.env.ORCA_DISPATCH_STORE;
    else process.env.ORCA_DISPATCH_STORE = savedStore;
  }
});

test('a record-owned pane whose task spec cannot be read SAYS so; an operator pane stays silent', async () => {
  // The discriminator is the record, not the handle: an operator pane has a
  // handle too. Build the real failed shape — worker-start names this pane but
  // no task-create phase carries the brief the equipment path requires.
  record({ spec: null });
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

    const operator = await drive('term_an-operators-own-pane');
    expect(operator).toEqual([]);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStore === undefined) delete process.env.ORCA_DISPATCH_STORE;
    else process.env.ORCA_DISPATCH_STORE = savedStore;
  }
});
