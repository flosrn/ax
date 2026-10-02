/**
 * `/peers` — the operator's hand on the peers widget.
 *
 * The widget used to be something only the model could empty: a question left
 * through `peer_reply` and an alert through `peer_diagnostics`, so a coordinator
 * that answered over `orca orchestration send`, or a worker that died, left
 * rows nobody could take down (26 "needs you" and 8 alerts in unobserve-mac,
 * 2026-10-01). This command lists the whole ledger, old rows included, and
 * returns what to dismiss. It never mutates the ledger itself: the caller
 * records the dismissal as a `DISMISS` session entry and the ledger reads it
 * back, so a restart cannot disagree with what the operator cleared.
 *
 * Pure: the ledger and the clock are arguments.
 */
import type { Ledger, Row } from './ledger.ts';
import { ago, STALE_MS } from './view.ts';

export interface Dismissal {
  ids: string[];
  alerts: boolean;
}

export interface PeersOutcome {
  /** Lines for the operator, in order. */
  say: string[];
  /** What to record and apply; absent when nothing changes. */
  dismiss?: Dismissal;
}

export const USAGE = '/peers · /peers clear <id> | old | alerts | all';

const SHORT = 10;

function listed(ledger: Ledger, now: number): string[] {
  const row = (glyph: string, r: Row) => {
    const age = ago(r.at, now);
    const old = r.at > 0 && now - r.at > STALE_MS ? ' · old' : '';
    return `${glyph} ${r.id.slice(0, SHORT).padEnd(SHORT)}  ${r.peer}  ${age}${old}  ${r.line}`;
  };
  return [
    ...[...ledger.owed.values()].map((r) => row('?', r)),
    ...[...ledger.awaiting.values()].map((r) => row('…', r)),
    ...ledger.alerts.map((a) => `! ${a.peer}: ${a.line}  ${ago(a.at, now)}`),
  ];
}

export function peersCommand(args: string, ledger: Ledger, now: number): PeersOutcome {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const rows = [...ledger.owed.values(), ...ledger.awaiting.values()];

  if (words.length === 0) {
    const lines = listed(ledger, now);
    return { say: lines.length ? [...lines, USAGE] : ['peers: nothing waiting'] };
  }
  if (words[0] !== 'clear' || words.length !== 2) return { say: [`usage: ${USAGE}`] };

  const target = words[1];
  let dismiss: Dismissal;
  if (target === 'alerts') dismiss = { ids: [], alerts: ledger.alerts.length > 0 };
  else if (target === 'all') dismiss = { ids: rows.map((r) => r.id), alerts: ledger.alerts.length > 0 };
  else if (target === 'old') dismiss = { ids: rows.filter((r) => r.at > 0 && now - r.at > STALE_MS).map((r) => r.id), alerts: false };
  else {
    const hits = rows.filter((r) => r.id.startsWith(target));
    if (hits.length === 0) return { say: [`peers: no row matches ${target} — /peers lists the ids`] };
    if (hits.length > 1) return { say: [`peers: ${target} matches ${hits.length} rows — give more of the id`] };
    dismiss = { ids: [hits[0].id], alerts: false };
  }

  if (dismiss.ids.length === 0 && !dismiss.alerts) return { say: ['peers: nothing to clear'] };
  const parts = [
    dismiss.ids.length ? `${dismiss.ids.length} row${dismiss.ids.length > 1 ? 's' : ''}` : '',
    dismiss.alerts ? 'the alerts' : '',
  ].filter(Boolean);
  return { say: [`peers: cleared ${parts.join(' and ')}`], dismiss };
}
