/**
 * Who is waiting on whom. The ledger is read off the same records the session
 * already persists — a delivered peer-message's `details`, a peer tool's result
 * `details` — so a restart replays the branch and lands in the same state.
 */
import { expect, test } from 'bun:test';
import { DISMISS, freshLedger, observe, rebuild } from './ledger.ts';

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
  expect([...l.owed.values()]).toEqual([{ id: 'm1', peer: 'gapila-main', subject: 'gapila-main', kind: '', line: 'Keep 0042?', at: 1 }]);
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
  expect([...l.awaiting.values()]).toEqual([{ id: 'q9', peer: 'gapila-main', subject: 'gapila-main', kind: '', line: 'Are you keeping 0042?', at: 5 }]);
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

test('a question sent without a reply route waits on nothing: no answer can come back', () => {
  // `unattributed: true` is the send receipt saying this pane published no
  // ORCA_PANE_KEY, so the recipient gets no route to answer it.
  const l = freshLedger();
  observe(l, tool('peer_send', { messageId: 'q4', peer: 'p', type: 'question', text: 't', unattributed: true }));
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

// ─── what kept "needs you" growing until the footer read 26 ─────────────────

test('a message delivered before `at` existed is dated by its session entry, not by 1970', () => {
  // Measured 2026-10-01 in gapila: two questions from 2026-09-29 carried no
  // `at` and no `body`, and the widget aged them 497463h.
  const l = rebuild([
    { ...received({ messageId: 'm1', type: 'question', at: undefined, body: undefined }), timestamp: '2026-09-29T23:39:57.580Z' },
  ]);
  expect(l.owed.get('m1')?.at).toBe(Date.parse('2026-09-29T23:39:57.580Z'));
  expect(l.owed.get('m1')?.line).toBe('(question, no text recorded)');
});

test('a worker the watcher reports gone takes its questions, and the ones sent to it, off the ledger', () => {
  // unobserve-mac, 2026-10-01: `child:hos-u8-cli-approvals` still owed eight
  // questions while `watcher:hos-u8-cli-approvals` had reported it gone.
  const l = freshLedger();
  observe(l, received({ messageId: 'q1', peer: 'child:hos-u8', kind: 'dispatch', type: 'question', body: 'Which pin?' }));
  observe(l, tool('peer_send', { messageId: 's1', peer: 'hos-u8', type: 'question', text: 'Still there?', at: 2 }));
  observe(l, received({ messageId: 'p1', peer: 'other·ab12', type: 'question', body: 'Unrelated' }));
  observe(l, received({ messageId: 'g1', peer: 'watcher:hos-u8', kind: 'watcher', about: 'hos-u8', alert: 'gone', answerable: false, refused: 'watcher', at: 3 }));
  expect([...l.owed.keys()]).toEqual(['p1']);
  expect(l.awaiting.size).toBe(0);
  expect(l.alerts.map((a) => a.line)).toEqual(['worker gone']);
  // A re-dispatch under the same name asks again: that one is live.
  observe(l, received({ messageId: 'q2', peer: 'child:hos-u8', kind: 'dispatch', type: 'question', body: 'Back: which pin?', at: 4 }));
  expect([...l.owed.keys()]).toEqual(['p1', 'q2']);
});

test('a worker blocks on one ask at a time, so its newer question replaces the older; a pane peer keeps both', () => {
  const l = freshLedger();
  observe(l, received({ messageId: 'w1', peer: 'child:hos-u3', kind: 'dispatch', type: 'question', body: 'old ask' }));
  observe(l, received({ messageId: 'w2', peer: 'watcher:hos-u3', kind: 'watcher', about: 'hos-u3', body: 'in-review\tDECISION: new ask' }));
  observe(l, received({ messageId: 'p1', peer: 'hos-u16·557c', kind: 'pane', type: 'question', body: 'may I update?' }));
  observe(l, received({ messageId: 'p2', peer: 'hos-u16·557c', kind: 'pane', type: 'question', body: 'all 33 match, ok?' }));
  expect([...l.owed.keys()]).toEqual(['w2', 'p1', 'p2']);
});

test('a worker gets one alert, in its latest state', () => {
  const l = freshLedger();
  const watch = (id: string, alert: string) =>
    received({ messageId: id, peer: 'watcher:hos-u8', kind: 'watcher', about: 'hos-u8', alert, answerable: false, refused: 'watcher' });
  observe(l, watch('a1', 'silent'));
  observe(l, watch('a2', 'silent'));
  observe(l, watch('a3', 'gone'));
  expect(l.alerts.map((a) => `${a.peer}: ${a.line}`)).toEqual(['hos-u8: worker gone']);
});

test('an operator dismissal is a session entry, so a restart replays it', () => {
  const branch = [
    received({ messageId: 'm1', type: 'question', body: 'Q one' }),
    received({ messageId: 'm2', type: 'question', body: 'Q two' }),
    tool('peer_send', { messageId: 'q3', peer: 'b', type: 'question', text: 'Q three', at: 2 }),
    received({ messageId: 'm5', peer: '2122-work', lostBefore: 2 }),
    { type: 'custom', customType: DISMISS, data: { ids: ['m1', 'q3'], alerts: true } },
    { type: 'custom', customType: DISMISS, data: 'garbage' },
  ];
  const l = rebuild(branch);
  expect([...l.owed.keys()]).toEqual(['m2']);
  expect(l.awaiting.size).toBe(0);
  expect(l.alerts).toEqual([]);
});
