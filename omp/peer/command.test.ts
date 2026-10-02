/**
 * `/peers`: the operator's own way to read and empty the peers widget. A
 * dismissal is returned as data for a session entry, never applied here, so
 * the replay (`ledger.ts` `DISMISS`) is the only reader of what was cleared.
 */
import { expect, test } from 'bun:test';
import { peersCommand } from './command.ts';
import { freshLedger, type Ledger } from './ledger.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-01T22:52:38Z');

function ledger(): Ledger {
  const l = freshLedger();
  const row = (id: string, peer: string, line: string, hoursAgo: number) => ({ id, peer, subject: peer, kind: '', line, at: NOW - hoursAgo * HOUR });
  l.owed.set('msg_3e8c05c60f02', row('msg_3e8c05c60f02', 'hos-u1-series', 'DECISION: git --version', 27));
  l.owed.set('msg_3e8d11aa0000', row('msg_3e8d11aa0000', 'hos-u16·557c', 'may I update?', 1));
  l.awaiting.set('msg_77aa00000000', row('msg_77aa00000000', 'gapila', 'Are you keeping 0042?', 2));
  l.alerts.push(row('msg_g1', 'hos-u8', 'worker gone', 3));
  return l;
}

test('with no argument it lists every row, old ones included and marked, with a short id to clear by', () => {
  const out = peersCommand('', ledger(), NOW);
  expect(out.dismiss).toBeUndefined();
  const text = out.say.join('\n');
  expect(text).toContain('msg_3e8c05');
  expect(text).toContain('hos-u1-series');
  expect(text).toContain('27h · old');
  expect(text).toContain('Are you keeping 0042?');
  expect(text).toContain('hos-u8: worker gone');
});

test('clear old takes exactly the rows older than a day', () => {
  expect(peersCommand('clear old', ledger(), NOW).dismiss).toEqual({ ids: ['msg_3e8c05c60f02'], alerts: false });
});

test('clear alerts and clear all', () => {
  expect(peersCommand('clear alerts', ledger(), NOW).dismiss).toEqual({ ids: [], alerts: true });
  expect(peersCommand('clear all', ledger(), NOW).dismiss).toEqual({
    ids: ['msg_3e8c05c60f02', 'msg_3e8d11aa0000', 'msg_77aa00000000'],
    alerts: true,
  });
});

test('clear by id prefix takes one row; an ambiguous or unknown prefix clears nothing and says why', () => {
  expect(peersCommand('clear msg_77aa', ledger(), NOW).dismiss).toEqual({ ids: ['msg_77aa00000000'], alerts: false });
  const ambiguous = peersCommand('clear msg_3e8', ledger(), NOW);
  expect(ambiguous.dismiss).toBeUndefined();
  expect(ambiguous.say.join('\n')).toContain('matches 2 rows');
  const unknown = peersCommand('clear nope', ledger(), NOW);
  expect(unknown.dismiss).toBeUndefined();
  expect(unknown.say.join('\n')).toContain('no row matches nope');
});

test('an empty ledger says so, and a clear with nothing to take records nothing', () => {
  expect(peersCommand('', freshLedger(), NOW).say).toEqual(['peers: nothing waiting']);
  expect(peersCommand('clear old', freshLedger(), NOW).dismiss).toBeUndefined();
});
