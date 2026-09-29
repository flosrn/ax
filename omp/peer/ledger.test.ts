/**
 * Who is waiting on whom. The ledger is read off the same records the session
 * already persists — a delivered peer-message's `details`, a peer tool's result
 * `details` — so a restart replays the branch and lands in the same state.
 */
import { expect, test } from 'bun:test';
import { freshLedger, observe, rebuild } from './ledger.ts';

const received = (d: Record<string, unknown>) => ({
  type: 'custom_message',
  customType: 'peer-message',
  details: { peer: 'gapila-main', type: 'status', answerable: true, body: 'hello', at: 1, ...d },
});
const tool = (toolName: string, details: Record<string, unknown>, isError = false) => ({
  type: 'message',
  message: { role: 'toolResult', toolName, details, isError },
});

test('a question addressed to you is owed until peer_reply answers that exact message', () => {
  const l = freshLedger();
  observe(l, received({ messageId: 'm1', type: 'question', body: 'Keep **0042**?' }));
  expect([...l.owed.values()]).toEqual([{ id: 'm1', peer: 'gapila-main', line: 'Keep 0042?', at: 1 }]);
  observe(l, tool('peer_reply', { messageId: 'other', peer: 'gapila-main' }));
  expect(l.owed.size).toBe(1);
  observe(l, tool('peer_reply', { messageId: 'm1', peer: 'gapila-main' }));
  expect(l.owed.size).toBe(0);
});

test('a watcher DECISION card is owed; a status, or a question with no reply route, is not', () => {
  const l = freshLedger();
  observe(l, received({ messageId: 'c1', kind: 'watcher', body: 'in-review\tDECISION: rule on the gate' }));
  observe(l, received({ messageId: 's1', body: 'rebased, 412 green' }));
  observe(l, received({ messageId: 'q1', type: 'question', answerable: false }));
  expect([...l.owed.keys()]).toEqual(['c1']);
  expect(l.owed.get('c1')?.line).toBe('DECISION: rule on the gate');
});

test('a sent question waits until a message arrives in its thread, and that reply knows what it answers', () => {
  const l = freshLedger();
  observe(l, tool('peer_send', { messageId: 'q9', peer: 'gapila-main', type: 'question', text: 'Are you keeping 0042?', at: 5 }));
  expect([...l.awaiting.values()]).toEqual([{ id: 'q9', peer: 'gapila-main', line: 'Are you keeping 0042?', at: 5 }]);
  observe(l, received({ messageId: 'r1', threadId: 'unrelated' }));
  expect(l.awaiting.size).toBe(1);
  observe(l, received({ messageId: 'r2', threadId: 'q9', body: 'Yes, renumbered to 0043.' }));
  expect(l.awaiting.size).toBe(0);
  expect(l.asked.get('q9')).toBe('Are you keeping 0042?');
});

test('a failed or status send waits on nothing', () => {
  const l = freshLedger();
  observe(l, tool('peer_send', { messageId: 'q1', peer: 'p', type: 'question', text: 't' }, true));
  observe(l, tool('peer_send', { messageId: 'q2', peer: 'p', type: 'status', text: 't' }));
  observe(l, tool('peer_send', { peer: 'p', type: 'question', text: 'no id: Orca named no message' }));
  expect(l.awaiting.size).toBe(0);
});

test('lost messages and unroutable watcher alerts are alerts until peer_diagnostics is read', () => {
  const l = freshLedger();
  observe(l, received({ messageId: 'm5', peer: '2122-work', lostBefore: 2 }));
  observe(l, received({ messageId: 'g1', peer: 'watcher:2119-fix', kind: 'watcher', about: '2119-fix', alert: 'gone', answerable: false, refused: 'watcher' }));
  expect(l.alerts.map((a) => a.peer)).toEqual(['2122-work', '2119-fix']);
  observe(l, tool('peer_diagnostics', {}));
  expect(l.alerts).toEqual([]);
});

test('replaying the session branch rebuilds the ledger a restart would otherwise forget', () => {
  const branch = [
    received({ messageId: 'm1', type: 'question', body: 'Q one' }),
    received({ messageId: 'm2', type: 'question', body: 'Q two' }),
    tool('peer_reply', { messageId: 'm1', peer: 'gapila-main' }),
    tool('peer_send', { messageId: 'q3', peer: 'b', type: 'question', text: 'Q three', at: 2 }),
    { type: 'model_change', model: 'x' },
    null,
  ];
  const l = rebuild(branch);
  expect([...l.owed.keys()]).toEqual(['m2']);
  expect([...l.awaiting.keys()]).toEqual(['q3']);
  expect(rebuild(undefined).owed.size).toBe(0);
});
