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
