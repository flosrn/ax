/**
 * Who is waiting on whom, across this session's peer traffic.
 *
 * WHY A LEDGER
 * Peer messages arrive late, batched, and out of order, and each was printed
 * as an isolated block. Two questions had no answer anywhere on screen: what
 * is somebody blocked on ME for, and what am I blocked on somebody else for.
 * Both are answerable from facts this adapter already has — a received
 * message's id and Orca `thread_id`, a sent message's id from Orca's receipt,
 * a `peer_reply` naming the message it answers — so the ledger is derived,
 * never declared.
 *
 * NO STORE OF ITS OWN. Every fact it reads is already persisted in the session
 * branch: a delivered `peer-message` carries its `details`, and a peer tool's
 * result carries its `details`. `observe` takes one record in that persisted
 * shape, whether it is live or replayed, and `rebuild` replays the active
 * branch on `session_start`. One reader for both paths means a restart cannot
 * disagree with the session it restarted. A rewind that abandons a reply
 * re-opens the question, which is what the active branch says.
 *
 * Presentation only. Nothing here authorises a route or gates a send; the
 * reply route is `receive.ts`'s alone.
 */
import { headline } from './view.ts';

export interface Row {
  id: string;
  peer: string;
  line: string;
  at: number;
}

export interface Ledger {
  /** Messages whose sender is blocked on this session's answer, by message id. */
  owed: Map<string, Row>;
  /** Questions this session sent, by the id Orca gave them; a reply carries it as `thread_id`. */
  awaiting: Map<string, Row>;
  /** Channel facts the operator must see once: lost messages, unroutable watcher alerts. */
  alerts: Row[];
  /** Headline of every message seen or asked, by id: what a reply is "re:". */
  asked: Map<string, string>;
}

const ALERT_CAP = 20;

/** Orca message types that ask the receiver for something. */
const ASKING: Record<string, true> = { question: true, escalation: true, decision_gate: true };

const WATCHER_ALERT: Record<string, string> = {
  gone: 'worker gone',
  silent: 'worker silent',
  prompt: 'worker blocked on a prompt',
  card: 'no route to the worker',
};

export function freshLedger(): Ledger {
  return { owed: new Map(), awaiting: new Map(), alerts: [], asked: new Map() };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Somebody is blocked on this session. Only an answerable message can be
 * owed: one with no reply route is shown with its reason, never listed as a
 * debt the operator cannot pay.
 */
export function needsYou(details: Record<string, unknown>): boolean {
  if (details.answerable !== true) return false;
  return ASKING[str(details.type)] === true || /\bDECISION:/.test(str(details.body));
}

/** The name the operator knows: a watcher alert is about its worker. */
export function speakerOf(details: Record<string, unknown>): string {
  return details.kind === 'watcher' && str(details.about) ? str(details.about) : str(details.peer);
}

/** Apply one persisted record; false when it is not peer traffic. */
export function observe(ledger: Ledger, entry: unknown): boolean {
  const e = rec(entry);
  if (e.type === 'custom_message' && e.customType === 'peer-message') {
    const d = rec(e.details);
    const id = str(d.messageId);
    const at = num(d.at);
    const peer = speakerOf(d);
    const body = str(d.body);
    const thread = str(d.threadId);
    if (thread && thread !== id) ledger.awaiting.delete(thread);
    if (id) {
      ledger.asked.set(id, headline(body));
      if (needsYou(d)) ledger.owed.set(id, { id, peer, line: headline(body), at });
    }
    const lost = num(d.lostBefore);
    if (lost > 0) alert(ledger, { id, peer, line: `${lost} earlier message${lost > 1 ? 's' : ''} never arrived`, at });
    if (d.kind === 'watcher' && str(d.refused))
      alert(ledger, { id, peer, line: WATCHER_ALERT[str(d.alert)] ?? 'watcher alert with no reply route', at });
    return true;
  }

  const m = rec(e.message);
  if (e.type !== 'message' || m.role !== 'toolResult') return false;
  const d = rec(m.details);
  switch (m.toolName) {
    case 'peer_reply':
      if (m.isError === true) return false;
      ledger.owed.delete(str(d.messageId));
      return true;
    case 'peer_send': {
      const id = str(d.messageId);
      if (m.isError === true || d.type !== 'question' || !id) return false;
      const line = headline(str(d.text));
      // An unattributed send reached a recipient with no route back, so no
      // answer can ever close it; listing it would wait forever.
      if (d.unattributed !== true) ledger.awaiting.set(id, { id, peer: str(d.peer), line, at: num(d.at) });
      ledger.asked.set(id, line);
      return true;
    }
    case 'peer_diagnostics':
      ledger.alerts = [];
      return true;
    default:
      return false;
  }
}

function alert(ledger: Ledger, row: Row): void {
  ledger.alerts.push(row);
  if (ledger.alerts.length > ALERT_CAP) ledger.alerts = ledger.alerts.slice(-ALERT_CAP);
}

/** Replay the active session branch. Anything unreadable is simply not peer traffic. */
export function rebuild(entries: unknown): Ledger {
  const ledger = freshLedger();
  if (Array.isArray(entries)) for (const entry of entries) observe(ledger, entry);
  return ledger;
}
