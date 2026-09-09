// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * Delivery to a named peer. The relay rule, the self-send refusal and the
 * sequence discipline each carry their own incident history below.
 */

import { orcaRaw, prop, str } from './orca.ts';
import { nextOutboundSequence } from './store.ts';
import { resolveTarget, selfPeer } from './address.ts';
import { parentPeer } from './lineage.ts';

export type MessageType = 'status' | 'question' | 'handoff';

/**
 * Send to a named peer, relaying through the shared parent when Orca refuses a
 * lateral send.
 *
 * SIBLING RELAY. A dispatch-bound worker may only send to the Run that owns its
 * dispatch, so a worker→worker lateral send comes back `dispatch_run_mismatch`.
 * Instead of failing, route through the shared parent: the parent's receiver
 * verifies the sender's attribution, re-posts to the target with the VERIFIED
 * origin stamped, and logs the relay. Children get lateral messaging, the
 * orchestrator gets the audit trail for free.
 */
export interface SendSeams {
  runOrcaRaw?: typeof orcaRaw;
  resolveParent?: typeof parentPeer;
}

export interface Delivery {
  /** A resolved Orca address. A reply gets this exclusively from its received route. */
  address: string;
  text: string;
  type?: MessageType;
  /** The original message id. Kept unchanged through every relay hop. */
  threadId?: string;
  /** Runtime that owns `address`, absent for a same-host destination. */
  environment?: string;
  /** Audit label only; never used to derive `address`. */
  targetName?: string;
}

export interface DeliveryResult {
  ok: boolean;
  via?: 'direct' | 'relay';
  queued?: { run: string };
  error?: string;
}

/**
 * THE ONE MESSAGE TRANSPORT. `peer_send` resolves a typed name and enters here;
 * `peer_reply` takes the address/thread/environment recorded from the received
 * route and enters here. The two are then byte-for-byte the same policy:
 * direct send, `dispatch_run_mismatch` only → verified parent relay, same
 * origin, return address, sequence, thread, and destination environment.
 *
 * This is deliberately exported as a narrow resolved-address API: reply must
 * never run name resolution, because the sender's received route is its only
 * destination authority. Conversely, the relay receiver still requires a
 * pane-witnessed sender before it lends the parent's authority; sharing the
 * outbound transport does not weaken that inbound fence.
 */
export function deliver(o: Delivery, seams: SendSeams = {}): DeliveryResult {
  const run = seams.runOrcaRaw ?? orcaRaw;
  const resolveParent = seams.resolveParent ?? parentPeer;
  const text = o.text ?? '';
  if (!text.trim()) return { ok: false, error: 'refusing to send an empty message' };
  if (!/^(?:@|run:|dispatch:|term_)/.test(o.address))
    return { ok: false, error: `refusing malformed resolved address '${o.address}'` };

  const me = selfPeer();
  const selfAddress = me !== null && (o.address === `run:${me.run}` || o.address === me.handle);
  if (selfAddress)
    return {
      ok: false,
      error: `refusing to send to this session itself — ${o.address} is this session`,
    };

  const from = me?.peer || process.env.ORCA_WORKSPACE_NAME || 'unregistered-session';
  const replyTo = me?.run ? { replyTo: `run:${me.run}` } : {};
  const type = o.type ?? 'status';
  const seq = nextOutboundSequence(from, o.address);
  const thread = o.threadId ? ['--thread-id', o.threadId] : [];
  const environment = o.environment ? ['--environment', o.environment] : [];

  const attempt = run([
    'orchestration',
    'send',
    '--to',
    o.address,
    '--type',
    type,
    '--subject',
    `peer:${from}`,
    '--body',
    text,
    '--payload',
    JSON.stringify({ peer: from, seq: seq.seq, ...replyTo }),
    ...thread,
    ...environment,
    '--json',
  ]);
  if (prop(attempt.parsed, 'ok') === true) {
    seq.commit();
    return { ok: true, via: 'direct' };
  }

  if (!attempt.text.includes('dispatch_run_mismatch'))
    return { ok: false, error: sendError(attempt) };

  const parent = resolveParent();
  const via = parent.peer ? parent.peer.run : parent.queued?.run;
  if (!via)
    return {
      ok: false,
      error: `direct send refused (dispatch_run_mismatch) and no parent Run to relay through — '${o.targetName ?? o.address}' is unreachable from this dispatch-bound session`,
    };

  // THE PARENT IS LOCAL; THE DESTINATION MAY NOT BE. Sending the parent Run
  // with the destination's `--environment` resolves that Run on the wrong
  // runtime and loses the relay. The environment therefore rides INSIDE the
  // witnessed envelope, and the parent applies it only while reposting to
  // `forwardTo` (`receive.ts`).
  const relay = run([
    'orchestration',
    'send',
    '--to',
    `run:${via}`,
    '--type',
    type,
    '--subject',
    `peer:${from} → ${o.targetName ?? o.address}`,
    '--body',
    text,
    '--payload',
    JSON.stringify({
      peer: from,
      seq: seq.seq,
      forwardTo: o.address,
      forwardToName: o.targetName ?? o.address,
      ...(o.threadId ? { forwardThreadId: o.threadId } : {}),
      ...(o.environment ? { forwardEnvironment: o.environment } : {}),
      ...replyTo,
    }),
    ...thread,
    '--json',
  ]);
  if (prop(relay.parsed, 'ok') === true) {
    seq.commit();
    return parent.queued
      ? { ok: true, via: 'relay', queued: { run: parent.queued.run } }
      : { ok: true, via: 'relay' };
  }
  return { ok: false, error: `relay via parent failed: ${sendError(relay)}` };
}

/** Resolve a human target, then use the exact same transport as a reply. */
export function sendToPeer(o: {
  target: string;
  text: string;
  type?: MessageType;
}, seams: SendSeams = {}): DeliveryResult {
  const text = o.text ?? '';
  if (!text.trim()) return { ok: false, error: 'refusing to send an empty message' };

  const resolved = resolveTarget(o.target);
  if (resolved.ambiguous)
    return {
      ok: false,
      error: `peer '${o.target}' is ambiguous — matches ${resolved.ambiguous.join(', ')}`,
    };
  if (!resolved.address) return { ok: false, error: `unknown peer '${o.target}'` };

  const me = selfPeer();
  if (me !== null && resolved.handle !== undefined && resolved.handle === me.handle)
    return {
      ok: false,
      error: `refusing to send to this session itself — '${o.target}' resolves to ${resolved.address}, which is this session. The peer you want is not reachable from this host, so its name matched the only pane here.`,
    };

  return deliver(
    { address: resolved.address, targetName: o.target, text, type: o.type },
    seams,
  );
}

function sendError(r: { parsed: unknown; text: string }): string {
  const message = prop(prop(r.parsed, 'error'), 'message');
  return (str(message) || r.text).slice(0, 200).trim();
}
