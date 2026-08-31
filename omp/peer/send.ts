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
export function sendToPeer(o: {
  target: string;
  text: string;
  type?: MessageType;
}): { ok: boolean; via?: 'direct' | 'relay'; error?: string } {
  const text = o.text ?? '';
  if (!text.trim()) return { ok: false, error: 'refusing to send an empty message' };

  const resolved = resolveTarget(o.target);
  if (resolved.ambiguous)
    return {
      ok: false,
      error: `peer '${o.target}' is ambiguous — matches ${resolved.ambiguous.join(', ')}`,
    };
  if (!resolved.address)
    return { ok: false, error: `unknown peer '${o.target}'` };

  const me = selfPeer();
  // A SELF-ADDRESSED SEND IS NEVER THE INTENT, and it is the one failure that
  // cannot be seen from either end: Orca accepts it and delivers the message to
  // this very session, so a report that never reached its orchestrator reads
  // exactly like one that arrived. Measured 2026-08-15: a dispatched child on
  // another host answered its orchestrator for five hours and every answer came
  // home to itself — on that host the registry can only see local panes, so the
  // orchestrator's name resolved to the only peer there was, the child. Its own
  // transcript said `my own report echoed back through the relay`; nothing on
  // the orchestrator's side said anything at all.
  const selfAddress =
    me !== null && (resolved.address === `run:${me.run}` || resolved.address === me.handle);
  if (selfAddress || (me !== null && resolved.handle !== undefined && resolved.handle === me.handle))
    return {
      ok: false,
      error: `refusing to send to this session itself — '${o.target}' resolves to ${resolved.address}, which is this session. The peer you want is not reachable from this host, so its name matched the only pane here.`,
    };

  // The sender states BOTH a readable name and its own return address. The
  // receiver builds its "reply with …" line from the name, so a name the
  // recipient cannot resolve yields an instruction that fails on first use. A
  // return address must never be a free-text label — `replyTo` is the sender's
  // own Run.
  const from = me?.peer || process.env.ORCA_WORKSPACE_NAME || 'unregistered-session';
  const replyTo = me?.run ? { replyTo: `run:${me.run}` } : {};
  const type = o.type ?? 'status';
  // Allocated before the attempt, committed only once Orca accepts one of the
  // two routes: the number identifies THIS message on whichever route carries
  // it, and a message that never left must not consume one.
  const seq = nextOutboundSequence(from);

  const attempt = orcaRaw([
    'orchestration',
    'send',
    '--to',
    resolved.address,
    '--type',
    type,
    // The subject carries the readable name because Orca's own formatter shows
    // the raw handle, and a handle tells a reader nothing.
    '--subject',
    `peer:${from}`,
    '--body',
    text,
    '--payload',
    JSON.stringify({ peer: from, seq: seq.seq, ...replyTo }),
    '--json',
  ]);
  if (prop(attempt.parsed, 'ok') === true) {
    seq.commit();
    return { ok: true, via: 'direct' };
  }

  if (!attempt.text.includes('dispatch_run_mismatch'))
    return { ok: false, error: sendError(attempt) };

  const parent = parentPeer();
  if (!parent.peer)
    return {
      ok: false,
      error: `direct send refused (dispatch_run_mismatch) and no live parent to relay through — '${o.target}' is unreachable from this dispatch-bound session`,
    };

  const relay = orcaRaw([
    'orchestration',
    'send',
    '--to',
    `run:${parent.peer.run}`,
    '--type',
    type,
    '--subject',
    `peer:${from} \u2192 ${o.target}`,
    '--body',
    text,
    '--payload',
    JSON.stringify({
      peer: from,
      seq: seq.seq,
      forwardTo: resolved.address,
      forwardToName: o.target,
      ...replyTo,
    }),
    '--json',
  ]);
  if (prop(relay.parsed, 'ok') === true) {
    seq.commit();
    return { ok: true, via: 'relay' };
  }
  return { ok: false, error: `relay via parent failed: ${sendError(relay)}` };
}

function sendError(r: { parsed: unknown; text: string }): string {
  const message = prop(prop(r.parsed, 'error'), 'message');
  return (str(message) || r.text).slice(0, 200).trim();
}
