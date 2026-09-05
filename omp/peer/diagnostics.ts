// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * WHAT THE CHANNEL COULD NOT DELIVER, OR WITHHELD ON PURPOSE — kept where the
 * next session can read it.
 *
 * WHY THIS EXISTS. Every outcome in this layer was already observed at the
 * point that knew it, and every one of them went to `note()` — an append-only
 * prose log next to the registry entry. Measured 2026-08-28
 * (`docs/solutions/bugs/one-symptom-two-causes-fenced-as-one.md`): the
 * discriminator between two opposite repairs "was already on disk in
 * `~/.omp/run/orca-peers/<term>.log`; nothing surfaced it, so it had to be
 * re-derived from eleven log files". A restarted session was worse off still —
 * the loop's own memory (the last sequence per sender, which delivery is
 * unacked, which message could not be injected) died with the process, and
 * the prose that outlived it had to be read by eye.
 *
 * So the same observations are ALSO written here, one JSON line each, keyed by
 * the pane handle the way the replay window (`.seen`) already is: a session
 * restarting into the same pane reads back what the previous process saw.
 * The prose log stays — it is the human's transcript of the loop, and this is
 * the machine-readable subset a fresh session can act on.
 *
 * SIX NAMED REASONS, AND THE POINT IS THAT THEY ARE NOT ONE. Two of them were
 * conflated in the incident above, and each conflation aims recovery at the
 * wrong half:
 *
 *   `sequence-gap`       messages from a sender never arrived; content is gone
 *   `filtered`           this side withheld it ON PURPOSE (`filter` says which rule)
 *   `injection-refused`  it could not be handed to the model; the ack is withheld
 *   `no-reply-route`     it arrived with no verified way back; `peer_reply` refuses
 *   `report-unreadable`  a completion's Report was not established (`disposition` says why)
 *   `ack-pending`        a delivery is still unacked, so Orca will replay it
 *
 * A withheld heartbeat is not a failed injection. A Report that would not open
 * is not a missing Summary — the Summary arrived, in full, and the injection
 * happened. Reading either as the other is how a repair gets aimed at a worker
 * with no fault in it.
 *
 * RESOLUTION IS AN OBSERVATION, NOT AN EDIT. `ack-settled` is appended when
 * Orca confirms a delivery, and the READER folds it onto the earlier records
 * for that delivery. Nothing is rewritten, so the account of what happened
 * stays intact — and because the ack is withheld until every message in a
 * delivery was injected (`receive.ts`), an ack is proof that the refusals
 * recorded against that delivery landed on the retry. A `sequence-gap` is
 * never resolved by anything: the content is unrecoverable whatever follows.
 *
 * COVERAGE, HONESTLY — and this is not a caveat, it is the reason the readout
 * prints it. Only the seams in THIS layer write here:
 *
 *   - Only messages sent through `sendToPeer` carry a sequence, so only their
 *     losses can be seen. A worker that hand-rolls `orca orchestration send`
 *     — which is exactly what Orca's supervised preamble teaches — carries no
 *     sequence at all, and its losses are invisible here (`store.ts`,
 *     `docs/upstream/orca-ordinary-send-receipt.md`).
 *   - Heartbeats are consumed and logged as liveness, not recorded here: one
 *     row every five minutes per dispatch would evict the observations this
 *     store exists for. `orca orchestration inbox --limit 100 --json` reads
 *     them back.
 *   - A send this session never made, and a message Orca dropped before the
 *     loop saw it, are unknown to every seam here.
 *
 * Which is why there is NO total, NO percentage and NO "delivery healthy"
 * verdict anywhere in this module. A rate computed over instrumented seams
 * alone reads as a rate over all traffic, and a reader would act on it.
 *
 * REDACTED ON THE WAY IN. Details quote child-authored text — a filesystem
 * error naming a path, a relay refusal naming a target — and the preamble puts
 * a `dcap_…` in reach of both. One boundary, on the writer, so nothing on disk
 * carries an authority token (`src/redact.mjs`, the rule `block()` states in
 * `./completion.ts`).
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { redactSecrets } from '../../src/redact.mjs';
import { registryDir, selfHandle } from './store.ts';

/** The closed vocabulary. A reason outside it is refused, never persisted. */
export type DeliveryReason =
  | 'sequence-gap'
  | 'filtered'
  | 'injection-refused'
  | 'no-reply-route'
  | 'report-unreadable'
  | 'ack-pending'
  | 'ack-settled';

/** Static membership, so the table is a literal and not a runtime insertion. */
const REASONS: Record<string, true> = {
  'sequence-gap': true,
  filtered: true,
  'injection-refused': true,
  'no-reply-route': true,
  'report-unreadable': true,
  'ack-pending': true,
  'ack-settled': true,
};

/** Which records a later `ack-settled` for the same delivery resolves. */
const RESOLVED_BY_ACK: Record<string, true> = { 'ack-pending': true, 'injection-refused': true };

export interface DeliveryDiagnostic {
  reason: DeliveryReason;
  /** ISO, stated by the caller in tests and defaulted to now. */
  at?: string;
  /** The sender, as this side ESTABLISHED it — never as it named itself. */
  peer?: string;
  /** The message this is about, when one message established it. */
  messageId?: string;
  /** The Orca delivery, which is what an ack settles. */
  deliveryId?: string;
  /** `filtered`: which withholding rule ran. */
  filter?: string;
  /** `report-unreadable`: which disposition `completion.ts` reached. */
  disposition?: string;
  /** `sequence-gap`: the number carried, the one expected, how many are gone. */
  sequence?: number;
  expected?: number;
  lost?: number;
  /** The dispatch a completion belongs to, and its request. */
  dispatch?: string;
  request?: string;
  /** The path or host a Report finding is about. */
  path?: string;
  environment?: string;
  /** The observation in one line, redacted. */
  detail?: string;
  /** Written by the reader's fold, never by the writer. */
  resolvedAt?: string;
}

/**
 * The bound. Enough to hold a wave's worth of observations, small enough that a
 * fresh session reads the whole file in one gulp — and it is a COUNT, not a
 * byte size, because the reader's unit is a record.
 */
export const DELIVERY_RECORD_CAP = 200;

const NUMBERS: Record<string, true> = { sequence: true, expected: true, lost: true };

/** One file per pane handle, beside the registry entry and the replay window. */
export function diagnosticsPath(handle: string): string {
  const safe = String(handle || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 140) || 'unknown';
  return `${registryDir()}/${safe}.delivery.jsonl`;
}

/**
 * The code a filesystem error carries, narrowed rather than asserted: what
 * separates "no store yet" from "a store that will not open" is this string,
 * and a fabricated shape would decide that difference on a guess.
 */
function errorCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string')
    return err.code;
  return String(err);
}

/**
 * Persist one observation. `false` when nothing was written, and the caller
 * NEVER acts on that: an unrecordable diagnostic must not change what the loop
 * does with the message it is about.
 */
export function recordDelivery(entry: DeliveryDiagnostic, o: { handle?: string } = {}): boolean {
  try {
    if (entry === null || typeof entry !== 'object') return false;
    if (REASONS[String(entry.reason)] !== true) return false;
    const handle = o.handle ?? selfHandle() ?? '';
    // A successful ack of an ordinary delivery is not a diagnostic. Writing one
    // for every message would evict the observations this store exists for.
    // Settlement is only worth recording when it changes a reader's view.
    if (entry.reason === 'ack-settled') {
      const id = String(entry.deliveryId ?? '');
      if (id === '') return false;
      const prior = readDelivery({ handle: handle || 'unknown' });
      const waiting = prior.records.some(
        (r) =>
          RESOLVED_BY_ACK[r.reason] === true &&
          String(r.deliveryId ?? '') === id &&
          r.resolvedAt === undefined,
      );
      if (!waiting) return false;
    }
    const path = diagnosticsPath(handle || 'unknown');
    const row: Record<string, unknown> = { at: entry.at ?? new Date().toISOString(), reason: entry.reason };
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'reason' || key === 'at' || key === 'resolvedAt') continue;
      if (value === undefined || value === null || value === '') continue;
      if (NUMBERS[key] === true) {
        const n = Number(value);
        if (Number.isFinite(n)) row[key] = n;
        continue;
      }
      // Every other field is text that may quote a child. One boundary, here.
      row[key] = redactSecrets(String(value)).slice(0, 600);
    }
    mkdirSync(registryDir(), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    compact(path);
    return true;
  } catch {
    // Observability rules: never throw into the session, never block a turn.
    return false;
  }
}

/**
 * Keep the newest `DELIVERY_RECORD_CAP` lines.
 *
 * Read-then-rewrite AFTER the append, not before it: the append is the durable
 * act and a compaction that loses a concurrent one costs a record, while an
 * append that waited on a rewrite could lose the very observation being made.
 */
function compact(path: string): void {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= DELIVERY_RECORD_CAP) return;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${lines.slice(-DELIVERY_RECORD_CAP).join('\n')}\n`);
      renameSync(tmp, path);
    } catch {
      rmSync(tmp, { force: true });
    }
  } catch {}
}

export interface DeliveryRead {
  path: string;
  /** Did this store ever receive a record? Absence is not zero (F-028). */
  recorded: boolean;
  /** Why the file could not be read at all — an inability, not an absence. */
  unavailable?: string;
  records: DeliveryDiagnostic[];
  /** Lines that did not parse. One bad line costs one record, never the store. */
  unreadable: number;
}

/**
 * Every record this pane's store holds, oldest first, with resolution folded
 * in. The reader carries no state from the loop that wrote them, which is the
 * whole contract: this is what a session that just started can know.
 */
export function readDelivery(o: { handle?: string } = {}): DeliveryRead {
  const path = diagnosticsPath(o.handle ?? selfHandle() ?? 'unknown');
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is the only absence. Anything else is a store that exists and
    // will not open, and calling that "nothing happened" is the lie F-028 names.
    const code = errorCode(err);
    if (code === 'ENOENT') return { path, recorded: false, records: [], unreadable: 0 };
    return { path, recorded: false, unavailable: code, records: [], unreadable: 0 };
  }

  const records: DeliveryDiagnostic[] = [];
  let unreadable = 0;
  const settled = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: DeliveryDiagnostic | null = null;
    try {
      const bag = JSON.parse(line);
      if (bag !== null && typeof bag === 'object' && !Array.isArray(bag) && 'reason' in bag && REASONS[String(bag.reason)] === true)
        parsed = bag;
    } catch {
      // Independent processes append here; a half-written line is a normal
      // thing to read, and it costs exactly itself.
    }
    if (parsed === null) {
      unreadable += 1;
      continue;
    }
    if (parsed.reason === 'ack-settled') {
      const id = String(parsed.deliveryId ?? '');
      if (id !== '') settled.set(id, String(parsed.at ?? ''));
    }
    records.push(parsed);
  }

  for (const record of records) {
    if (RESOLVED_BY_ACK[record.reason] !== true) continue;
    const at = settled.get(String(record.deliveryId ?? ''));
    if (at !== undefined && at !== '') record.resolvedAt = at;
  }

  return { path, recorded: records.length > 0 || unreadable > 0, records, unreadable };
}

const COVERAGE = [
  'COVERAGE — what this store cannot see, and how to repair each gap',
  '  · Only messages sent through peer_send/peer_reply carry a sequence, so only THEIR losses',
  '    are visible. A worker that hand-rolls `orca orchestration send` (which Orca\'s own',
  '    supervised preamble teaches) carries none — repair: read its own account with peer_read,',
  '    or `orca orchestration inbox --limit 100 --json` for the Run\'s raw payloads.',
  '  · Heartbeats are consumed as liveness and not recorded here — repair: the same inbox read.',
  '  · A send this session never made, and anything Orca dropped before the receive loop saw',
  '    it, are unknown to every seam that writes here.',
  '  · No total and no rate: these seams are partial instrumentation, and a percentage over',
  '    them would read as one over all traffic.',
].join('\n');

/** The rows a session reads, grouped by what it can do about them. */
export function renderDelivery(read: DeliveryRead): string {
  const head = `DELIVERY DIAGNOSTICS  ${read.path}`;
  if (read.unavailable !== undefined)
    return [
      head,
      `This store could not be read (${read.unavailable}), so what the channel withheld here is`,
      'UNKNOWN — not empty. Repair: read the prose log beside it, the same path with a `.log`',
      'suffix, which the receive loop appends to for every outcome.',
      '',
      COVERAGE,
    ].join('\n');
  if (!read.recorded)
    return [
      head,
      'Since this pane last started, no delivery diagnostic has been recorded. That is not proof',
      'nothing was lost — read the coverage below before treating it as one.',
      '',
      COVERAGE,
    ].join('\n');

  const open = read.records.filter((r) => r.resolvedAt === undefined);
  const resolved = read.records.length - open.length;
  const at = (r: DeliveryDiagnostic): string => String(r.at ?? '?');
  const who = (r: DeliveryDiagnostic): string =>
    `${r.peer ? `${r.peer}` : 'unestablished sender'}${r.messageId ? ` ${r.messageId}` : ''}`;
  const section = (title: string, lines: string[]): string[] =>
    lines.length === 0 ? [] : ['', title, ...lines.map((l) => `  ${l}`)];

  const lost = open
    .filter((r) => r.reason === 'sequence-gap')
    .map(
      (r) =>
        `${at(r)}  ${who(r)}: ${r.lost ?? '?'} message(s) never arrived (expected #${r.expected ?? '?'}, got #${r.sequence ?? '?'}). ` +
        'Repair: their content is unrecoverable here — ask that sender to resend if it mattered.',
    );
  const withheld = open
    .filter((r) => r.reason === 'filtered')
    .map(
      (r) =>
        `${at(r)}  ${who(r)}: withheld on purpose by the \`${r.filter ?? 'unnamed'}\` rule${r.detail ? ` — ${r.detail}` : ''}. ` +
        'Repair: none needed; this side chose it.',
    );
  const refused = open
    .filter((r) => r.reason === 'injection-refused')
    .map(
      (r) =>
        `${at(r)}  ${who(r)}${r.deliveryId ? ` in ${r.deliveryId}` : ''}: could not be handed to the model${r.detail ? ` — ${r.detail}` : ''}. ` +
        'Repair: the ack was withheld, so Orca replays it — if it never reappears, ask that sender again.',
    );
  const routeless = open
    .filter((r) => r.reason === 'no-reply-route')
    .map(
      (r) =>
        `${at(r)}  ${who(r)}: arrived with no verified way back${r.detail ? ` — ${r.detail}` : ''}. ` +
        'Repair: establish the destination yourself (peer_list, or the pane the dispatch record names); peer_reply refuses it.',
    );
  const reports = open
    .filter((r) => r.reason === 'report-unreadable')
    .map(
      (r) =>
        `${at(r)}  ${who(r)}${r.request ? ` (request ${r.request})` : ''}: Report NOT established — ` +
        `${r.disposition ?? 'unnamed disposition'}${r.path ? ` at ${r.path}` : ''}${r.environment ? ` on ${r.environment}` : ''}` +
        `${r.detail ? ` — ${r.detail}` : ''}. The Summary itself arrived; this is the file, not the message. ` +
        'Repair: answer that completion on the channel it arrived on and have the worker write THAT path.',
    );
  const waiting = open
    .filter((r) => r.reason === 'ack-pending')
    .map(
      (r) =>
        `${at(r)}  ${r.deliveryId ?? 'unnamed delivery'}: not acked${r.detail ? ` — ${r.detail}` : ''}. ` +
        'Repair: Orca replays an unacked delivery; already-injected messages are deduped by id, so expect a re-read, not a re-inject.',
    );

  return [
    head,
    `${read.records.length} record(s), ${open.length} still open, ${resolved} resolved by a later observation` +
      (read.unreadable > 0 ? `, ${read.unreadable} unreadable line(s) skipped` : ''),
    ...section('LOST — never arrived', lost),
    ...section('WITHHELD — this side did not inject it, on purpose', withheld),
    ...section('REFUSED INJECTION — could not reach the model', refused),
    ...section('NO REPLY ROUTE — answerable only after you establish one', routeless),
    ...section('REPORT NOT ESTABLISHED — the completion arrived, its Report did not', reports),
    ...section('WAITING ACKNOWLEDGEMENT — Orca still holds it', waiting),
    '',
    COVERAGE,
  ].join('\n');
}
