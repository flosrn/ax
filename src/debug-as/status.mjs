// One bounded JSON answer about this worktree's Role browser.
//
// `status` observes; it does not mutate. An absent, stale or CDP-dead receipt
// is a Verdict, not a refusal — that is the question an agent asked. Only a
// request that cannot even name a worktree refuses. The Phone relay is present
// only when its generation and worktree both match this one; a superseded or
// foreign publication is reported as absence, never as this session's URL.
//
// Every emission goes through ./emit.mjs.

import { emit as defaultEmit } from './emit.mjs';
import { probeCdp, readReceipt } from './receipt.mjs';

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
  verdict,
});

const defaultRelay = async () => {
  try {
    const mod = await import('./relay-receipt.mjs');
    return {
      readRelay: home => mod.readRelayReceipt(home ?? {}),
      relayOwnedBy: mod.relayOwnedBy,
      relayUrl: mod.relayUrl,
    };
  } catch {
    return { readRelay: () => null, relayOwnedBy: () => false, relayUrl: () => null };
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
  const relayFns = {
    readRelay: deps.readRelay,
    relayOwnedBy: deps.relayOwnedBy,
    relayUrl: deps.relayUrl,
  };
  if (!relayFns.readRelay) Object.assign(relayFns, await defaultRelay());

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
    const owned = record ? relayFns.relayOwnedBy(record, { root, generation: receipt.generation }) : false;
    payload.relay = Boolean(owned);
    payload.relayUrl = owned ? relayFns.relayUrl(record) : null;
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
