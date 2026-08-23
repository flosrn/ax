/**
 * THE ADDRESS OF A WORKER ON ANOTHER HOST.
 *
 * A wrong answer here delivers this session's reply to a stranger, so every case below is
 * written to check that the resolver refuses rather than guesses. The shapes are Orca
 * 1.4.180's own, copied from live output on 2026-08-13:
 *
 *   worker-show --dispatch ctx_73e5a2dec161  → agent_terminal_handle term_d5683080-…,
 *                                              worktree_id <repo>::/…/workspaces/probe-mail
 *   run-list --environment gapicore          → a row with coordinator_handle term_d5683080-…
 *                                              and objective "peer session: probe-mail"
 *
 * `worker-show` exposes NO pane key (its `pane_key`, `tab_id` and `leaf_id` are absent), so
 * the join cannot use one. It matches the handle AND the objective, and treats one-of-two as
 * a refusal — that pair is the substitute for a unique pane key, not an equivalent of it.
 */

import { expect, test } from 'bun:test';

import { environmentOfDispatch, resolveChildRoute, worktreeName } from './route.ts';

const HANDLE = 'term_d5683080-71b6-4660-8adb-b2e7beabc991';
const WT = '1a71daea-5ad3-4792-b007-527718ad3df0::/home/orca/orca/workspaces/probe-mail';

function orca(replies: Record<string, unknown>, calls: string[] = []) {
  return (args: string[]) => {
    calls.push(args.join(' '));
    const verb = args[1] ?? '';
    const reply = replies[verb];
    if (reply === undefined) return { reason: `no stub for ${verb}` };
    return { value: reply };
  };
}

const shown = (over: Record<string, unknown> = {}) => ({
  ok: true,
  result: { worker: { agent_terminal_handle: HANDLE, worktree_id: WT, ...over } },
});

const runRow = (over: Record<string, unknown> = {}) => ({
  id: 'run_2aa06e94548e',
  objective: 'peer session: probe-mail',
  coordinator_handle: HANDLE,
  legacy: 0,
  ...over,
});

const listed = (runs: Record<string, unknown>[]) => ({ ok: true, result: { runs } });

test('the run whose coordinator and objective BOTH match is the address', () => {
  const calls: string[] = [];
  const route = resolveChildRoute(
    orca({ 'worker-show': shown(), 'run-list': listed([runRow()]) }, calls),
    'ctx_73e5a2dec161',
    'gapicore',
    'child:probe-mail',
  );
  expect(route).toEqual({
    run: 'run:run_2aa06e94548e',
    environment: 'gapicore',
    peer: 'child:probe-mail',
  });
  // The environment is passed to Orca, not guessed from the row.
  expect(calls[1]).toBe('orchestration run-list --environment gapicore --json');
});

test('a handle that matches while the objective does not is REFUSED, not answered', () => {
  // The stale-row case. `coordinator_handle` is a snapshot taken when the Run was created,
  // and terminal handles churn (stablyai/orca#9163) — so one signal is not enough.
  const route = resolveChildRoute(
    orca({
      'worker-show': shown(),
      'run-list': listed([runRow({ objective: 'peer session: someone-else' })]),
    }),
    'ctx_1',
    'gapicore',
    'child:x',
  );
  expect(route).toBeNull();
});

test('an objective that matches while the handle does not is REFUSED too', () => {
  const route = resolveChildRoute(
    orca({
      'worker-show': shown(),
      'run-list': listed([runRow({ coordinator_handle: 'term_other' })]),
    }),
    'ctx_1',
    'gapicore',
    'child:x',
  );
  expect(route).toBeNull();
});

test('two matching rows are ambiguity, and ambiguity is a refusal', () => {
  const route = resolveChildRoute(
    orca({ 'worker-show': shown(), 'run-list': listed([runRow(), runRow({ id: 'run_other' })]) }),
    'ctx_1',
    'gapicore',
    'child:x',
  );
  expect(route).toBeNull();
});

test('a legacy row never becomes an address', () => {
  const route = resolveChildRoute(
    orca({ 'worker-show': shown(), 'run-list': listed([runRow({ legacy: 1 })]) }),
    'ctx_1',
    'gapicore',
    'child:x',
  );
  expect(route).toBeNull();
});

test('an Orca that refuses either call yields no address', () => {
  for (const replies of [
    { 'run-list': listed([runRow()]) }, // worker-show unstubbed → reason
    { 'worker-show': shown() }, // run-list unstubbed → reason
  ]) {
    expect(resolveChildRoute(orca(replies), 'ctx_1', 'gapicore', 'child:x')).toBeNull();
  }
});

test('an empty environment is the LOCAL case, and it resolves', () => {
  // Was a refusal until 2026-08-14, and the refusal was a trap: answering a child took
  // `peer_reply` cross-host and `orca terminal send` locally, decided by where the child ran,
  // and the "No reply route" text named neither. The four conditions are unchanged; only the
  // lookup's scope is.
  const calls: string[] = [];
  const route = resolveChildRoute(
    orca({ 'worker-show': shown(), 'run-list': listed([runRow()]) }, calls),
    'ctx_73e5a2dec161',
    '',
    'child:probe-mail',
  );
  expect(route).toEqual({
    run: 'run:run_2aa06e94548e',
    environment: '',
    peer: 'child:probe-mail',
  });
  // No empty `--environment ''` reaches Orca: the flag is absent, not blank.
  expect(calls[1]).toBe('orchestration run-list --json');
});

test('a local lookup is held to the same two-field match', () => {
  // The scope changed, the standard did not: a stale handle must not become an address just
  // because the child happens to be on this machine.
  expect(
    resolveChildRoute(
      orca({
        'worker-show': shown(),
        'run-list': listed([runRow({ objective: 'peer session: someone-else' })]),
      }),
      'ctx_1',
      '',
      'child:x',
    ),
  ).toBeNull();
});

test('a malformed run id is refused rather than prefixed into an address', () => {
  const route = resolveChildRoute(
    orca({ 'worker-show': shown(), 'run-list': listed([runRow({ id: 'run with space' })]) }),
    'ctx_1',
    'gapicore',
    'child:x',
  );
  expect(route).toBeNull();
});

test('the worktree name is the last path segment, with or without the repo prefix', () => {
  expect(worktreeName(WT)).toBe('probe-mail');
  expect(worktreeName('/srv/orca/gapila/.worktrees/ws-1876')).toBe('ws-1876');
  expect(worktreeName('/tmp/x/')).toBe('x');
  expect(worktreeName('')).toBe('');
});

test('the environment comes from the recorded argv, for that dispatch only', () => {
  const record = {
    request: 'probe-mail-1',
    attempts: [
      {
        phases: [
          { name: 'task-create', argv: ['orca', 'orchestration', 'task-create'], receipt: {} },
          {
            name: 'worker-start',
            argv: ['orca', 'orchestration', 'worker-start', '--on', 'gapicore'],
            receipt: { result: { dispatchId: 'ctx_73e5a2dec161' } },
          },
        ],
      },
    ],
  };
  expect(environmentOfDispatch(record, 'ctx_73e5a2dec161')).toBe('gapicore');
  // A dispatch this record does not contain is not ours to route, even though the argv
  // beside it names an environment.
  expect(environmentOfDispatch(record, 'ctx_someone_else')).toBe('');
});

test('the joined --on= form is read too', () => {
  const record = {
    attempts: [
      {
        phases: [
          {
            argv: ['orca', 'orchestration', 'worker-start', '--on=gapicore'],
            receipt: { result: { dispatchId: 'ctx_1' } },
          },
        ],
      },
    ],
  };
  expect(environmentOfDispatch(record, 'ctx_1')).toBe('gapicore');
});

test('a second attempt on another server does not lend its --on to the first dispatch', () => {
  // One record accumulates every attempt for a request, including a `--replace` that may
  // land elsewhere. Answering with the last `--on` seen in the file would address a dispatch
  // that never went there — resolved-looking and wrong.
  const record = {
    attempts: [
      {
        phases: [
          {
            argv: ['orca', 'orchestration', 'worker-start', '--on', 'gapicore'],
            receipt: { result: { dispatchId: 'ctx_first' } },
          },
        ],
      },
      {
        phases: [
          {
            argv: ['orca', 'orchestration', 'worker-start', '--on', 'windows'],
            receipt: { result: { dispatchId: 'ctx_second' } },
          },
        ],
      },
    ],
  };
  expect(environmentOfDispatch(record, 'ctx_first')).toBe('gapicore');
  expect(environmentOfDispatch(record, 'ctx_second')).toBe('windows');
});

test('a local dispatch record yields no environment', () => {
  const record = {
    attempts: [
      {
        phases: [
          {
            argv: ['orca', 'orchestration', 'worker-start', '--worktree', 'current'],
            receipt: { result: { dispatchId: 'ctx_1' } },
          },
        ],
      },
    ],
  };
  expect(environmentOfDispatch(record, 'ctx_1')).toBe('');
});
