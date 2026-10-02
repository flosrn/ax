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
 * WHAT TAKES A ROW OFF
 * A question used to leave only through `peer_reply` on that exact id, so the
 * ledger only grew: measured 2026-10-01 in unobserve-mac, 26 rows "needs you",
 * eight of them from a worker its watcher had already reported gone, none ever
 * closable because that coordinator answered through `orca orchestration send`.
 * Three facts on the branch now close a row as well. The watcher reports the
 * worker `gone` (`about` names it). A dispatched worker or its watcher asks
 * again: one blocked on `ask` holds one question at a time, so the newer
 * replaces the older. A pane peer does not, and keeps every question. Last,
 * the operator dismisses rows with `/peers`, recorded as a `DISMISS` session
 * entry so the replay agrees. A shell command line is never read for any of this.
 *
 * Presentation only. Nothing here authorises a route or gates a send; the
 * reply route is `receive.ts`'s alone.
 */
import { headline } from './view.ts';

export interface Row {
  id: string;
  /** The name shown: who spoke, or who was asked. */
  peer: string;
  /** The worker the row is about, the same for its pane, its dispatch and its watcher. */
  subject: string;
  /** `details.kind` of the message: dispatch · watcher · pane, '' when unrecorded. */
  kind: string;
  line: string;
  /** Epoch ms; 0 when neither the message nor its session entry carries a time. */
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

/** The custom session entry `/peers` writes: `{ ids: string[], alerts: boolean }`. */
export const DISMISS = '@flosrn/ax/peer-dismiss';

/** Kinds whose sender is a worker that holds one blocking question at a time. */
const ONE_ASK: Record<string, true> = { dispatch: true, watcher: true };

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

/**
 * One name for one worker: `child:hos-u8`, `watcher:hos-u8` and the pane
 * `hos-u8·557c` all speak about `hos-u8`.
 */
export function subjectOf(name: string): string {
  return name.replace(/^(?:child|watcher):/, '').replace(/·[0-9a-f]+$/, '');
}

/** The message's own time, else its session entry's: a record from before `at` existed. */
function timeOf(d: Record<string, unknown>, e: Record<string, unknown>): number {
  const own = num(d.at);
  if (own > 0) return own;
  const stamped = Date.parse(str(e.timestamp));
  return Number.isFinite(stamped) ? stamped : 0;
}

function close(ledger: Ledger, keep: (row: Row) => boolean): void {
  for (const [id, row] of ledger.owed) if (!keep(row)) ledger.owed.delete(id);
  for (const [id, row] of ledger.awaiting) if (!keep(row)) ledger.awaiting.delete(id);
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
    const at = timeOf(d, e);
    const peer = speakerOf(d);
    const subject = subjectOf(peer);
    const kind = str(d.kind);
    const body = str(d.body);
    const thread = str(d.threadId);
    if (thread && thread !== id) ledger.awaiting.delete(thread);
    // Gone first: a worker that is gone can neither answer nor be answered.
    if (kind === 'watcher' && d.alert === 'gone') close(ledger, (row) => row.subject !== subject);
    if (id) {
      const line = headline(body) || (str(d.type) ? `(${str(d.type)}, no text recorded)` : '');
      ledger.asked.set(id, line);
      if (needsYou(d)) {
        if (ONE_ASK[kind]) for (const [old, row] of ledger.owed) if (row.subject === subject && ONE_ASK[row.kind]) ledger.owed.delete(old);
        ledger.owed.set(id, { id, peer, subject, kind, line, at });
      }
    }
    const lost = num(d.lostBefore);
    if (lost > 0) alert(ledger, { id, peer, subject, kind: 'lost', line: `${lost} earlier message${lost > 1 ? 's' : ''} never arrived`, at });
    if (kind === 'watcher' && str(d.refused))
      alert(ledger, { id, peer, subject, kind: 'watcher', line: WATCHER_ALERT[str(d.alert)] ?? 'watcher alert with no reply route', at });
    return true;
  }

  if (e.type === 'custom' && e.customType === DISMISS) {
    const data = rec(e.data);
    const ids = Array.isArray(data.ids) ? data.ids.filter((i): i is string => typeof i === 'string') : [];
    for (const i of ids) {
      ledger.owed.delete(i);
      ledger.awaiting.delete(i);
    }
    if (data.alerts === true) ledger.alerts = [];
    return ids.length > 0 || data.alerts === true;
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
      if (d.unattributed !== true) {
        const peer = str(d.peer);
        ledger.awaiting.set(id, { id, peer, subject: subjectOf(peer), kind: '', line, at: timeOf(d, e) });
      }
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

/** One alert per worker and cause, in its latest state: `silent` then `gone` reads `gone`. */
function alert(ledger: Ledger, row: Row): void {
  ledger.alerts = ledger.alerts.filter((a) => !(a.subject === row.subject && a.kind === row.kind));
  ledger.alerts.push(row);
  if (ledger.alerts.length > ALERT_CAP) ledger.alerts = ledger.alerts.slice(-ALERT_CAP);
}

/** Replay the active session branch. Anything unreadable is simply not peer traffic. */
export function rebuild(entries: unknown): Ledger {
  const ledger = freshLedger();
  if (Array.isArray(entries)) for (const entry of entries) observe(ledger, entry);
  return ledger;
}
