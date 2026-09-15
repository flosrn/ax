// One bounded JSON answer about this worktree's Role browser.
//
// `status` observes; it does not mutate. An absent, stale or CDP-dead receipt
// is a Verdict, not a refusal — that is the question an agent asked. Only a
// request that cannot even name a worktree refuses. The Phone relay is present
// only when its generation and worktree both match this one; a superseded or
// foreign publication is reported as absence, never as this session's URL.
//
// Matching generation and worktree are not enough to advertise a handoff: the
// relay is a SEPARATE process, so a publisher that crashed under a still-live
// Role browser would otherwise hand an agent a URL whose listener is gone. So
// `relay` is true only for an owner this machine PROVES live, and `relayState`
// names every other case in `relayOwnership`'s own vocabulary — a proven-dead
// owner (`dead-owner`) and an owner this machine cannot disprove (`ambiguous`,
// `other-host`) stay distinguishable there, and neither carries a URL.
//
// The Serve mapping is the other half of that proof, and it is NOT read here:
// `status` answers from receipts and one CDP probe, and reading a mapping would
// make every `ax debug-as status` shell out to `tailscale`. `doctor` owns that
// read, and every launch sweeps a dead owner's mapping (R17).
//
// Every emission goes through ./emit.mjs.

import { hostname } from 'node:os';

import { emit as defaultEmit } from './emit.mjs';
import { probeCdp, processStart, readReceipt } from './receipt.mjs';

/** Proof of life, not permission: EPERM is another user's live process. */
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const emptyPayload = verdict => ({
  identity: null,
  origin: null,
  path: null,
  device: null,
  viewport: null,
  generation: null,
  cdpPort: null,
  relay: false,
  relayUrl: null,
  relayState: null,
  verdict,
});

const RELAY_KEYS = ['readRelay', 'relayOwnedBy', 'relayUrl', 'relayOwnership'];

const defaultRelay = async () => {
  try {
    const mod = await import('./relay-receipt.mjs');
    return {
      readRelay: home => mod.readRelayReceipt(home ?? {}),
      relayOwnedBy: mod.relayOwnedBy,
      relayUrl: mod.relayUrl,
      relayOwnership: mod.relayOwnership,
    };
  } catch {
    return {
      readRelay: () => null,
      relayOwnedBy: () => false,
      relayUrl: () => null,
      relayOwnership: () => 'absent',
    };
  }
};

/**
 * Pure observation. ASYNC because VIVANT requires a live CDP probe.
 * Verdict is VIVANT | MORT | INCONNU.
 */
export async function statusPayload(context, deps = {}) {
  const root = context?.root;
  const current = readReceipt(root, deps);
  const probe = deps.probe ?? (port => probeCdp(port, { open: deps.open }));
  const relayFns = {};
  for (const key of RELAY_KEYS) if (typeof deps[key] === 'function') relayFns[key] = deps[key];
  if (RELAY_KEYS.some(key => !relayFns[key])) {
    const fallback = await defaultRelay();
    for (const key of RELAY_KEYS) relayFns[key] ??= fallback[key];
  }

  let verdict;
  if (current.state === 'absent' || current.state === 'dead') verdict = 'MORT';
  else if (current.state === 'live') {
    const cdp = await probe(current.receipt.cdpPort);
    verdict = cdp.alive ? 'VIVANT' : 'MORT';
  } else verdict = 'INCONNU';

  const receipt = current.receipt;
  const payload = emptyPayload(verdict);
  if (receipt) {
    payload.identity = receipt.identity;
    payload.origin = receipt.origin;
    payload.path = receipt.path;
    payload.device = receipt.device;
    payload.viewport = receipt.viewport;
    payload.generation = receipt.generation;
    payload.cdpPort = receipt.cdpPort;
  }

  if (verdict === 'VIVANT' && receipt) {
    const record = relayFns.readRelay();
    if (record === null || record === undefined) payload.relayState = 'absent';
    else if (!relayFns.relayOwnedBy(record, { root, generation: receipt.generation })) payload.relayState = 'superseded';
    else {
      // The same host/pid/start notions the browser receipt is read with.
      const owner = relayFns.relayOwnership(record, {
        host: deps.host ?? hostname(),
        alive: deps.alive ?? pidAlive,
        start: deps.start ?? processStart,
      });
      payload.relayState = owner;
      if (owner === 'live') {
        payload.relay = true;
        payload.relayUrl = relayFns.relayUrl(record);
      }
    }
  }

  return { payload, verdict };
}

export async function status(context, deps = {}) {
  const output = deps.emit ?? defaultEmit;
  if (!context?.root) {
    output.refuse('debug-as status needs a worktree', 'run ax debug-as status from the checkout whose Role browser you want to inspect');
    return 1;
  }
  const { payload } = await statusPayload(context, deps);
  output.raw(JSON.stringify(payload));
  return 0;
}
