/**
 * What the OPERATOR reads of peer traffic — never what the model reads.
 *
 * WHY A SECOND RENDERING EXISTS
 * A delivered peer-message's `content` is the model's contract: provenance,
 * answerability, the reply instruction, each sentence paid for by an incident
 * (`peerContent`, `unanswerableBanner`). Printed as-is it is also what the
 * operator scrolled through, and it read as one undifferentiated wall: the
 * reply instruction above the peer's words, badges flung to the right edge,
 * a status line weighing the same as a decision someone is blocked on. OMP lets
 * a custom message and a tool result carry structured `details` beside the
 * text, and draws them through a renderer of the extension's choosing. This
 * module is that drawing, from `details` alone; `content` is untouched, and the
 * expanded view prints it verbatim under "what the agent reads".
 *
 * THE FOLD KEEPS THE QUESTION
 * A long message must collapse, and the first draft cut after eight lines.
 * On a realistic DECISION card that cut landed exactly on "Options", and on a
 * long answer it hid the "question back" — the one paragraph the operator had
 * to act on, twice in one run (prototype, 2026-09-29). An ask is written
 * context-first, question-last, so a collapsed ask keeps its opening
 * paragraph AND its closing one and folds the middle. Information keeps its
 * first lines.
 *
 * PRIMITIVES ARE INJECTED. The host's TUI kit (markdown, unicode width,
 * truncation) is resolved by OMP's loader and is not installed in this
 * repository, so this module takes it as `Kit` and stays testable; `tui.ts`
 * supplies the real one. No line leaves here wider than the pane or than
 * `MAX_WIDTH`.
 */

/** A message is read, not scanned: past this, a line is too long to follow. */
export const MAX_WIDTH = 100;
const HEAD = 3;
const ASK_TAIL = 5;
const INFO = 3;

export interface Kit {
  /** Rendered markdown lines, each at most `width` columns. */
  markdown(text: string, width: number): string[];
  /** Terminal columns, ANSI and wide glyphs accounted for. */
  width(text: string): number;
  truncate(text: string, width: number): string;
}

export interface Paint {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface Card {
  dir: 'in' | 'out';
  /** Incoming: who spoke. Outgoing: who it went to. */
  peer: string;
  /** decision · question · reply · status … */
  label: string;
  /** Provenance, quietly: a model name, "relayed by your watcher". */
  via?: string;
  /** Markdown, the peer's (or the operator's) own words. */
  body: string;
  /** Headline of the question this message answers. */
  inReplyTo?: string;
  /** Somebody is blocked on the operator's answer to this. */
  needsYou?: boolean;
  /** One-line facts shown under the body: a refused route, lost messages. */
  notes?: string[];
  /** Where `peer_reply` would go; expanded only. */
  route?: string;
  at?: number;
}

/**
 * Which rendered lines survive a collapse; a number stands for that many
 * folded lines. Trailing blank lines are dropped first, or the "closing
 * paragraph" would be empty.
 */
export function fold(rendered: string[], ask: boolean, blank: (line: string) => boolean): Array<string | number> {
  let lines = rendered;
  while (lines.length > 0 && blank(lines[lines.length - 1])) lines = lines.slice(0, -1);
  if (!ask) return lines.length > INFO + 1 ? [...lines.slice(0, INFO), lines.length - INFO] : lines;
  const firstBreak = lines.findIndex(blank);
  const head = lines.slice(0, Math.min(HEAD, firstBreak < 0 ? lines.length : firstBreak));
  let start = lines.length;
  while (start > head.length && !blank(lines[start - 1])) start--;
  const tail = lines.slice(Math.max(start, lines.length - ASK_TAIL, head.length));
  const hidden = lines.length - head.length - tail.length;
  return hidden > 1 ? [...head, hidden, ...tail] : lines;
}

/**
 * The first line worth quoting: a card's status column, list and heading
 * markers and emphasis go; identifiers keep their underscores.
 */
export function headline(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw
      .replace(/^[\w-]+\t/, '')
      .replace(/^(?:#+\s+|>\s?|[-*+]\s+|\d+\.\s+)+/, '')
      .replace(/\*\*|`/g, '')
      .trim();
    if (line) return line;
  }
  return '';
}

// One colour per peer, stable across the session, so a conversation reads as
// one colour down the page. Theme keys every OMP theme defines.
const PALETTE = ['accent', 'success', 'mdLink', 'mdHeading', 'customMessageLabel'];
export function colorOf(peer: string): string {
  let h = 7;
  for (let i = 0; i < peer.length; i++) h = (h * 31 + peer.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

/** How long ago, or nothing when the time is unknown: an epoch of 0 once read as 497463h. */
export function ago(at: number, now: number): string {
  if (at <= 0) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fitter(width: number, kit: Kit) {
  return (line: string) => (kit.width(line) <= width ? line : kit.truncate(line, width));
}

function spread(left: string, right: string, width: number, kit: Kit): string {
  const gap = width - kit.width(left) - kit.width(right);
  return gap >= 2 ? left + ' '.repeat(gap) + right : left;
}

/** One message, incoming or outgoing, in the same shape. */
export function bubble(
  card: Card,
  opts: { expanded: boolean; agentText?: string },
  width: number,
  kit: Kit,
  paint: Paint,
): string[] {
  const w = Math.max(20, Math.min(width, MAX_WIDTH));
  const fit = fitter(Math.min(width, MAX_WIDTH), kit);
  const color = card.dir === 'out' ? 'muted' : colorOf(card.peer);
  const bar = paint.fg(color, '│ ');
  const inner = w - 2;

  const who =
    card.dir === 'in'
      ? `${paint.fg(color, '←')} ${paint.bold(paint.fg(color, card.peer))}`
      : `${paint.fg('muted', '→ you →')} ${paint.bold(card.peer)}`;
  const tag = card.needsYou ? paint.bold(paint.fg('warning', card.label.toUpperCase())) : paint.fg('muted', card.label);
  const head = `${who}  ${tag}${card.via ? paint.fg('dim', `  ${card.via}`) : ''}`;
  const out = [card.at ? spread(head, paint.fg('dim', clock(card.at)), w, kit) : head];
  if (card.inReplyTo) out.push(bar + paint.fg('dim', kit.truncate(`╭ re: ${card.inReplyTo}`, inner)));

  const md = kit.markdown(card.body || '(empty)', inner);
  const blank = (l: string) => kit.width(l.trim()) === 0;
  for (const line of opts.expanded ? md : fold(md, card.needsYou === true, blank))
    out.push(
      typeof line === 'number'
        ? bar + paint.fg('dim', `┆ ${line} more line${line > 1 ? 's' : ''} · ctrl+o`)
        : bar + line,
    );
  for (const note of card.notes ?? []) out.push(bar + paint.fg('warning', note));

  if (opts.expanded && card.route) out.push(paint.fg('dim', `  reply route: ${card.route}`));
  if (opts.expanded && opts.agentText) {
    out.push('', paint.fg('dim', '  what the agent reads:'));
    for (const line of kit.markdown(opts.agentText, w - 2)) out.push(`  ${paint.fg('dim', line)}`);
  }
  return out.map(fit);
}

/** Plumbing, not conversation: one quiet line. */
export function notice(glyph: string, color: string, text: string, width: number, kit: Kit, paint: Paint): string {
  return fitter(Math.min(width, MAX_WIDTH), kit)(`${paint.fg(color, glyph)} ${paint.fg('dim', text)}`);
}

interface WidgetRow {
  peer: string;
  /** The worker the row is about; rows sharing it are one line. */
  subject: string;
  line: string;
  at: number;
}

interface Group {
  peer: string;
  line: string;
  at: number;
  count: number;
}

/** The ledger as the operator reads it: recent rows grouped by worker, older ones counted. */
export interface PeerView {
  owed: Group[];
  awaiting: Group[];
  alerts: WidgetRow[];
  /** Recent rows, the numbers the footer shows. */
  counts: { owed: number; awaiting: number; alerts: number };
  /** Rows older than `STALE_MS`, folded into one dim line. */
  old: number;
}

/**
 * A day. Older rows stay on the ledger, reachable from `/peers`, but leave the
 * footer: a question nobody answered for a day is a backlog, not a ping.
 */
export const STALE_MS = 24 * 3600 * 1000;

/** One line per worker, in first-seen order, carrying its latest words and time. */
function grouped(rows: WidgetRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const g = groups.get(r.subject);
    if (!g) groups.set(r.subject, { peer: r.peer, line: r.line, at: r.at, count: 1 });
    else if (r.at >= g.at) Object.assign(g, { peer: r.peer, line: r.line, at: r.at, count: g.count + 1 });
    else g.count++;
  }
  return [...groups.values()];
}

export function partition(rows: { owed: WidgetRow[]; awaiting: WidgetRow[]; alerts: WidgetRow[] }, now: number): PeerView {
  // An unknown time is shown, not hidden: nothing says it is old.
  const recent = (r: WidgetRow) => r.at <= 0 || now - r.at <= STALE_MS;
  const owed = rows.owed.filter(recent);
  const awaiting = rows.awaiting.filter(recent);
  return {
    owed: grouped(owed),
    awaiting: grouped(awaiting),
    alerts: rows.alerts,
    counts: { owed: owed.length, awaiting: awaiting.length, alerts: rows.alerts.length },
    old: rows.owed.length - owed.length + rows.awaiting.length - awaiting.length,
  };
}

/** Above the editor: who is waiting on the operator, and on whom the operator waits. */
export function widget(view: PeerView, width: number, now: number, kit: Kit, paint: Paint): string[] {
  const { owed, awaiting, alerts, old } = view;
  if (owed.length + awaiting.length + alerts.length + old === 0) return [];
  const w = Math.min(width, MAX_WIDTH);
  const fit = fitter(w, kit);
  const line = (glyph: string, color: string, g: Group) => {
    const age = paint.fg('dim', ago(g.at, now));
    const who = `${g.peer}${g.count > 1 ? ` ×${g.count}` : ''}`;
    const text = kit.truncate(g.line, Math.max(10, w - 26));
    return spread(` ${paint.fg(color, glyph)} ${paint.bold(who.padEnd(12))} ${text}`, age, w, kit);
  };
  const listed = [...owed.map((g) => line('?', 'warning', g)), ...awaiting.map((g) => line('…', 'muted', g))];
  const shown = listed.slice(0, 4);
  const out = [paint.fg('borderMuted', `─ peers ${'─'.repeat(Math.max(0, w - 8))}`), ...shown];
  if (listed.length > shown.length) out.push(paint.fg('dim', `   +${listed.length - shown.length} more`));
  if (old) out.push(paint.fg('dim', `   ${old} older than a day · /peers`));
  if (alerts.length)
    out.push(
      ` ${paint.fg('error', '!')} ${paint.fg('error', `${alerts.length} alert${alerts.length > 1 ? 's' : ''}`)}` +
        paint.fg('dim', ` — ${alerts.map((a) => `${a.peer}: ${a.line}`).join('; ')} · /peers clear alerts`),
    );
  return out.map(fit);
}

/** The footer summary of recent rows, or nothing at all when there is nothing recent to say. */
export function status(view: PeerView, paint: Paint): string | undefined {
  const { counts } = view;
  const parts = [
    counts.owed ? paint.fg('warning', `${counts.owed} needs you`) : '',
    counts.awaiting ? paint.fg('muted', `${counts.awaiting} waiting`) : '',
    counts.alerts ? paint.fg('error', `${counts.alerts} alert${counts.alerts > 1 ? 's' : ''}`) : '',
  ].filter(Boolean);
  return parts.length ? `peers: ${parts.join(paint.fg('dim', ' · '))}` : undefined;
}
