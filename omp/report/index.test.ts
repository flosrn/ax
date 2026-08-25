import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import reportExtension from './index.ts';

type Event = {
  toolName?: string;
  isError?: boolean;
  details?: { phases?: unknown };
};
type Context = {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string;
  };
};
type Handler = (event: Event, context: Context) => unknown;
type Send = (state: string) => { sent: boolean; reason?: string };

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const topFile = (id: string) => `/tmp/sessions/-repo/2026-08-23T09-00-00-000Z_${id}.jsonl`;
const childFile = (id: string) => `${topFile(id).slice(0, -6)}/Reviewer.jsonl`;
const ctx = (id: string, file = topFile(id)): Context => ({
  sessionManager: {
    getSessionId: () => id,
    getSessionFile: () => file,
  },
});

function harness(sendReport: Send, existingDir?: string) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  const reportDir = existingDir ?? mkdtempSync(join(tmpdir(), 'ax-report-'));
  roots.add(reportDir);
  reportExtension(pi, { sendReport, warmLineage: () => {}, reportDir });
  const fire = async (name: string, event: Event, context: Context) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
  };
  return { fire, reportDir };
}

test('a fresh extension factory ignores a structural task-subagent session', async () => {
  const sent: string[] = [];
  const h = harness((state) => (sent.push(state), { sent: true }));
  const child = ctx('child-session', childFile('019fdb81-47a2-7000-8fca-2b66b08f9e99'));

  await h.fire('session_start', {}, child);
  await h.fire('agent_end', {}, child);

  expect(sent).toEqual([]);
});

test('a report latches only after delivery, per session rather than per reused pane', async () => {
  const saved = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_reused';
  try {
    const sent: string[] = [];
    let attempt = 0;
    const lead = ctx('session-one');
    const h = harness((state) => {
      sent.push(state);
      attempt += 1;
      return attempt === 1 ? { sent: false, reason: 'parent session temporarily unavailable' } : { sent: true };
    });

    await h.fire('session_start', {}, lead);
    await h.fire('agent_end', {}, lead);
    expect(sent).toEqual(['turn-ended']);
    expect(existsSync(join(h.reportDir, 'term_reused-session-one.done'))).toBe(false);

    await h.fire('agent_end', {}, lead);
    expect(sent).toEqual(['turn-ended', 'turn-ended']);
    expect(existsSync(join(h.reportDir, 'term_reused-session-one.done'))).toBe(true);
    await h.fire('agent_end', {}, lead);
    expect(sent).toHaveLength(2);

    const afterReload: string[] = [];
    const same = harness((state) => (afterReload.push(state), { sent: true }), h.reportDir);
    await same.fire('session_start', {}, lead);
    await same.fire('agent_end', {}, lead);
    expect(afterReload).toEqual([]);

    const next: string[] = [];
    const nextSession = harness((state) => (next.push(state), { sent: true }), h.reportDir);
    const second = ctx('session-two');
    await nextSession.fire('session_start', {}, second);
    await nextSession.fire('agent_end', {}, second);
    expect(next).toEqual(['turn-ended']);
  } finally {
    if (saved === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = saved;
  }
});

test('todo completion reports again after work resumes, and shutdown reports interruption', async () => {
  const sent: string[] = [];
  const h = harness((state) => (sent.push(state), { sent: true }));

  const lead = ctx('todo-session');
  const phases = (status: string) => [{ tasks: [{ status }] }];

  await h.fire('session_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('in_progress') } }, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('in_progress') } }, lead);
  await h.fire('session_shutdown', {}, lead);

  expect(sent).toEqual(['done', 'done', 'interrupted']);
});
test('session shutdown retries a completion whose turn-end delivery failed', async () => {
  const sent: string[] = [];
  let attempt = 0;
  const h = harness((state) => {
    sent.push(state);
    attempt += 1;
    return attempt === 1 ? { sent: false, reason: 'runtime unavailable' } : { sent: true };
  });
  const lead = ctx('shutdown-retry');

  await h.fire('session_start', {}, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('session_shutdown', {}, lead);

  expect(sent).toEqual(['turn-ended', 'turn-ended']);
});

/**
 * A SECOND FINISH IS STILL A FINISH.
 *
 * Measured 2026-08-25 on ofmchat. Child `57-policy-offer-engine` (session
 * 01a0387b) marked its 19 todo tasks complete at 11:30, and its completion
 * reached the coordinator at 11:32:41 — `handoff`, sequence 1, in Orca's own
 * ledger. At 11:40:59 the operator relayed a second assignment onto its pane; it
 * ran 19 tool calls, edited two files, committed `b8870ef2` and opened PR #76,
 * and its run ended at 11:47:40. Nothing was sent: `current` was still `done` and
 * `lastReported` was `done`, so `agent_end` returned before the send. Orca's
 * ledger holds no message from that pane after 11:32:28, and the coordinator sat
 * idle from 11:42 onwards waiting for one.
 *
 * THE RE-ARM IS THE WORK CYCLE, NOT THE TODO LIST AND NOT THE ARTIFACT. The todo
 * tool is untouched by most follow-up work, which is how the silence happened.
 * A git measurement fails the same way for a whole class of real follow-ups — an
 * analysis, a decision, a review comment, a merge done remotely, work already
 * committed before the first report — so `agent_start` is the signal: the session
 * was handed something and started on it. One report per cycle, which is what the
 * `lastReported` latch still enforces inside a cycle.
 */
const phases = (status: string) => [{ tasks: [{ status }] }];

test('a finished worker handed more work reports again when that run ends', async () => {
  const sent: string[] = [];
  const lead = ctx('01a0387b');
  const h = harness((state) => (sent.push(state), { sent: true }));

  await h.fire('session_start', {}, lead);
  // 10:35 → 11:30: the assignment, then every task complete.
  await h.fire('agent_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  // 11:32:41 — the report that did arrive.
  await h.fire('agent_end', {}, lead);
  expect(sent).toEqual(['done']);

  // 11:40:59 — a second assignment relayed onto the pane. 11:47:40 — it ends,
  // having committed and opened a PR, without ever calling the todo tool.
  await h.fire('agent_start', {}, lead);
  await h.fire('agent_end', {}, lead);
  expect(sent).toEqual(['done', 'done']);

  // A third cycle that reaches the same state says so again: each is a finish the
  // mother did not know about.
  await h.fire('agent_start', {}, lead);
  await h.fire('agent_end', {}, lead);
  expect(sent).toEqual(['done', 'done', 'done']);
});

test('one report per work cycle, however many times the run ends inside it', async () => {
  // Pi ends an agent run and may still auto-retry, auto-compact and retry, or
  // pick up a queued follow-up message — several `agent_end` events for one thing
  // the operator asked. The mirror error costs as much as the silence: a
  // coordinator that gets "finished its work" three times for one finish learns to
  // ignore the signal.
  const sent: string[] = [];
  const lead = ctx('retry-session');
  const h = harness((state) => (sent.push(state), { sent: true }));

  await h.fire('session_start', {}, lead);
  await h.fire('agent_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('session_shutdown', {}, lead);

  expect(sent).toEqual(['done']);
});

test('a subagent run neither reports nor re-arms the lead', async () => {
  // A `task` subagent runs its own agent loop inside this process. Its
  // `agent_start` must not hand the lead a fresh licence to announce a finish
  // that has not happened.
  const sent: string[] = [];
  const lead = ctx('lead-session');
  const child = ctx('child-session', childFile('lead-session'));
  const h = harness((state) => (sent.push(state), { sent: true }));

  await h.fire('session_start', {}, lead);
  await h.fire('agent_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);
  expect(sent).toEqual(['done']);

  await h.fire('agent_start', {}, child);
  await h.fire('agent_end', {}, child);
  expect(sent).toEqual(['done']);
});

test('a no-todo session still reports its turn once per session, not once per cycle', async () => {
  // The `turn-ended` state exists because a session that never makes a todo list
  // would otherwise never be heard from. It is also the noisiest signal in the
  // set, and its cap is the on-disk latch — the work-cycle re-arm must not lift
  // it: a fresh child reaches this boundary while it is still reading its ticket.
  const saved = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_cycles';
  try {
    const sent: string[] = [];
    const lead = ctx('no-todo-session');
    const h = harness((state) => (sent.push(state), { sent: true }));

    await h.fire('session_start', {}, lead);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await h.fire('agent_start', {}, lead);
      await h.fire('agent_end', {}, lead);
    }

    expect(sent).toEqual(['turn-ended']);
  } finally {
    if (saved === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = saved;
  }
});

/**
 * AN UNFINISHED CYCLE IS AN INTERRUPTION, WHATEVER THE PREVIOUS ONE ACHIEVED.
 *
 * The re-arm above creates this case, and it is the more expensive of the two
 * errors it sits between. `current` still reads `done` from the cycle that
 * finished, so a session killed inside the NEXT one would announce "finished its
 * work" for work that stopped halfway — a false completion a coordinator acts on,
 * where the pre-re-arm behaviour was merely silent. The todo list describes the
 * cycle that wrote it; only the cycle boundary knows whether this one ended.
 */
test('a session killed inside a second cycle says it stopped, not that it finished', async () => {
  const sent: string[] = [];
  const lead = ctx('killed-session');
  const h = harness((state) => (sent.push(state), { sent: true }));

  await h.fire('session_start', {}, lead);
  await h.fire('agent_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);
  expect(sent).toEqual(['done']);

  // A second assignment, then SIGTERM before the run ends. No todo call: the
  // list still reads complete from the first cycle.
  await h.fire('agent_start', {}, lead);
  await h.fire('session_shutdown', {}, lead);

  expect(sent).toEqual(['done', 'interrupted']);
});

test('a cycle that ended cleanly is not re-announced as interrupted at shutdown', async () => {
  // The mirror of the above: a worker that finished and is then torn down must
  // not retract its own completion.
  const sent: string[] = [];
  const lead = ctx('clean-session');
  const h = harness((state) => (sent.push(state), { sent: true }));

  await h.fire('session_start', {}, lead);
  await h.fire('agent_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);
  await h.fire('session_shutdown', {}, lead);

  expect(sent).toEqual(['done']);
});

test('a run that ended without reporting is still a cycle that ended', async () => {
  // `agent_end` returns early on the on-disk latch and on an unchanged state.
  // Clearing the cycle only on the paths that SEND would leave those runs looking
  // unfinished, and a later shutdown would call a finished session interrupted.
  const saved = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_latched';
  try {
    const sent: string[] = [];
    const lead = ctx('latched-session');
    const h = harness((state) => (sent.push(state), { sent: true }));

    await h.fire('session_start', {}, lead);
    // Two no-todo cycles: the first reports, the second is capped by the latch.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await h.fire('agent_start', {}, lead);
      await h.fire('agent_end', {}, lead);
    }
    await h.fire('session_shutdown', {}, lead);

    expect(sent).toEqual(['turn-ended']);
  } finally {
    if (saved === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = saved;
  }
});

/**
 * A COMPLETION THAT COULD NOT BE DELIVERED IS NOT A COMPLETION THAT WAS.
 *
 * `report()` answers `{sent, reason}` and this extension threw the reason away,
 * so every undeliverable finish was indistinguishable from a delivered one — from
 * inside the child, from the coordinator's side, and from the transcript.
 *
 * The reason is rarely exotic. Measured 2026-08-25 while probing this very fix: a
 * child whose parent worktree ran two registered panes got
 * `parent worktree 'ax' runs several panes and none can be identified as the
 * dispatcher` — the deliberate fail-closed refusal in `parentPeer()`, since Orca's
 * lineage is worktree-level and no pane-level discriminator exists there. It is
 * the right refusal and it was completely silent, which is the defect: open a
 * second session in a coordinator's worktree and every child of it goes mute.
 *
 * Said once per distinct reason, in the child's own session, because that is the
 * one place an operator can act on it.
 */
function announcing(sendReport: Send) {
  const handlers = new Map<string, Handler[]>();
  const said: string[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(message: { content?: unknown }) {
      said.push(String(message.content ?? ''));
    },
  };
  const reportDir = mkdtempSync(join(tmpdir(), 'ax-report-'));
  roots.add(reportDir);
  reportExtension(pi, { sendReport, warmLineage: () => {}, reportDir });
  return {
    said,
    fire: async (name: string, event: Event, context: Context) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, context);
    },
  };
}

test('a refused delivery is said in the session that could not deliver it', async () => {
  const lead = ctx('mute-child');
  const h = announcing(() => ({
    sent: false,
    reason: "parent worktree 'ax' runs several panes and none can be identified as the dispatcher",
  }));

  await h.fire('session_start', {}, lead);
  await h.fire('agent_start', {}, lead);
  await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
  await h.fire('agent_end', {}, lead);

  expect(h.said).toHaveLength(1);
  expect(h.said[0]).toContain('runs several panes');
  // What it is, and what it costs: the coordinator is not going to learn this.
  expect(h.said[0]).toMatch(/not delivered|undelivered/i);
});

test('the same refusal is not repeated every cycle', async () => {
  const lead = ctx('mute-child-2');
  const h = announcing(() => ({ sent: false, reason: 'parent worktree has no live session to report to' }));

  await h.fire('session_start', {}, lead);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await h.fire('agent_start', {}, lead);
    await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
    await h.fire('agent_end', {}, lead);
  }

  expect(h.said).toHaveLength(1);
});

test('a delivered report says nothing, and a parentless session says nothing', async () => {
  // Most worktrees are not dispatched: `no parent worktree recorded` is the
  // normal case and announcing it would be noise in every interactive session.
  const delivered = announcing(() => ({ sent: true }));
  const root = announcing(() => ({ sent: false, reason: 'no parent worktree recorded — this session was not dispatched' }));

  for (const h of [delivered, root]) {
    const lead = ctx(`quiet-${h === root ? 'root' : 'ok'}`);
    await h.fire('session_start', {}, lead);
    await h.fire('agent_start', {}, lead);
    await h.fire('tool_result', { toolName: 'todo', details: { phases: phases('completed') } }, lead);
    await h.fire('agent_end', {}, lead);
    expect(h.said).toEqual([]);
  }
});
