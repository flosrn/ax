/**
 * The operator's view of peer traffic: what a collapsed message keeps, and the
 * width it may never exceed. Rendering primitives are injected — the host's
 * TUI kit is not installed in this repository — so a column here is a UTF-16
 * code unit and markdown is one source line per rendered line.
 */
import { expect, test } from 'bun:test';
import { ago, bubble, fold, headline, type Kit, MAX_WIDTH, type Paint, partition, status, widget } from './view.ts';

const kit: Kit = {
  markdown: (text, width) => text.split('\n').flatMap((l) => (l.length <= width ? [l] : l.match(new RegExp(`.{1,${width}}`, 'g')) ?? [''])),
  width: (s) => s.length,
  truncate: (s, w) => s.slice(0, w),
};
const plain: Paint = { fg: (_c, s) => s, bold: (s) => s };

const DECISION = [
  '#2138 is green on unit tests but e2e is pending.',
  '',
  'Context. The PR moves the billing webhook to ledger_entries.',
  'Migration 0042 locks invoices for ~9 min.',
  '',
  'Options',
  '1. Merge on green.',
  '2. Wait for e2e.',
  '3. Split the migration out.',
  '',
  'Which one do you want?',
].join('\n');

test('a collapsed question keeps its opening context AND its closing question — the fold hid the ask on the first draft', () => {
  const out = fold(kit.markdown(DECISION, 80), true, (l) => l.trim() === '');
  expect(out[0]).toBe('#2138 is green on unit tests but e2e is pending.');
  expect(out.at(-1)).toBe('Which one do you want?');
  expect(out.filter((l) => typeof l === 'number')).toEqual([9]);
});

test('an ask without paragraph breaks keeps its first and last lines, never the middle', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const out = fold(lines, true, (l) => l.trim() === '');
  expect(out).toEqual(['line 0', 'line 1', 'line 2', 12, 'line 15', 'line 16', 'line 17', 'line 18', 'line 19']);
});

test('information folds after three lines; a body that would fold a single line is shown whole', () => {
  const six = Array.from({ length: 6 }, (_, i) => `s${i}`);
  expect(fold(six, false, () => false)).toEqual(['s0', 's1', 's2', 3]);
  expect(fold(six.slice(0, 4), false, () => false)).toEqual(['s0', 's1', 's2', 's3']);
});

test('expanded shows the whole body and the exact text the agent reads', () => {
  const card = { dir: 'in' as const, peer: '2122-work', label: 'decision', needsYou: true, body: DECISION, at: 0 };
  const out = bubble(card, { expanded: true, agentText: 'AGENT-TEXT-MARKER' }, 90, kit, plain).join('\n');
  expect(out).toContain('2. Wait for e2e.');
  expect(out).toContain('AGENT-TEXT-MARKER');
  expect(bubble(card, { expanded: false, agentText: 'AGENT-TEXT-MARKER' }, 90, kit, plain).join('\n')).not.toContain('AGENT-TEXT-MARKER');
});

test('no rendered line is wider than the pane, nor than the reading measure on a wide one', () => {
  const card = {
    dir: 'in' as const, peer: 'a-very-long-worktree-name-for-a-peer', label: 'question', via: 'relayed by your watcher',
    needsYou: true, inReplyTo: 'x'.repeat(300), body: `${'word '.repeat(80)}\n\n${'y'.repeat(250)}`, notes: ['n'.repeat(200)], at: 0,
  };
  for (const width of [30, 72, 100, 240])
    for (const expanded of [false, true])
      for (const line of bubble(card, { expanded, agentText: 'z'.repeat(400) }, width, kit, plain))
        expect(line.length).toBeLessThanOrEqual(Math.min(width, MAX_WIDTH));
});

test('a headline drops markdown emphasis and a card status column but keeps identifiers intact', () => {
  expect(headline('**Do you keep `0042_ledger_backfill`?**\nmore')).toBe('Do you keep 0042_ledger_backfill?');
  expect(headline('in-review\tDECISION: rule on the merge gate')).toBe('DECISION: rule on the merge gate');
  expect(headline('\n\n- first item')).toBe('first item');
});

// ─── the peers widget the operator could not empty ──────────────────────────

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-01T22:52:38Z');
const row = (id: string, peer: string, subject: string, line: string, hoursAgo: number) => ({ id, peer, subject, kind: '', line, at: NOW - hoursAgo * HOUR });

test('an unknown time shows no age, and days read as days', () => {
  expect(ago(0, NOW)).toBe('');
  expect(ago(NOW - 27 * HOUR, NOW)).toBe('27h');
  expect(ago(NOW - 72 * HOUR, NOW)).toBe('3d');
});

test('one line per peer with its count, and rows older than a day fold into one dim count', () => {
  const owed = [
    row('a', 'hos-u16·557c', 'hos-u16', 'may I update?', 1),
    row('b', 'hos-u16·557c', 'hos-u16', 'all 33 match, ok?', 0.5),
    row('c', 'hos-u1-series', 'hos-u1-series', 'DECISION: git --version', 27),
    row('d', 'ax', 'ax', '(question, no text recorded)', 0),
  ];
  const view = partition({ owed, awaiting: [], alerts: [] }, NOW);
  const out = widget(view, 100, NOW, kit, plain);
  expect(out.filter((l) => l.includes('hos-u16'))).toHaveLength(1);
  expect(out.find((l) => l.includes('hos-u16'))).toContain('×2');
  expect(out.find((l) => l.includes('hos-u16'))).toContain('all 33 match, ok?');
  expect(out.some((l) => l.includes('hos-u1-series'))).toBe(false);
  expect(out.at(-1)).toContain('1 older than a day · /peers');
  expect(status(view, plain)).toBe('peers: 3 needs you');
});

test('a ledger holding only old rows says nothing in the footer, and the widget only counts them', () => {
  const view = partition({ owed: [row('c', 'hos-u1', 'hos-u1', 'old', 30)], awaiting: [], alerts: [] }, NOW);
  expect(status(view, plain)).toBeUndefined();
  expect(widget(view, 100, NOW, kit, plain).join('\n')).toContain('1 older than a day · /peers');
});

test('the alert line names the operator\'s way to clear it', () => {
  const view = partition({ owed: [], awaiting: [], alerts: [row('g', 'hos-u8', 'hos-u8', 'worker gone', 2)] }, NOW);
  expect(widget(view, 100, NOW, kit, plain).join('\n')).toContain('hos-u8: worker gone · /peers clear alerts');
});
