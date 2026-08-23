// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * WHO SENT THIS, and on what evidence.
 *
 * Extracted from `orca-peer.ts` on 2026-08-13 for the reason ADR 0017 extracted
 * the receive loop: the rule that decides identity is the load-bearing half, and
 * it could not be tested where it lived — importing the extension entry point
 * evaluates the extension. Nothing here touches Orca, the registry, or a live
 * pane; the pane lookup arrives as an argument.
 *
 * Two provenances, and the distinction between them is the point:
 *
 *   pane      Orca witnessed a live pane on THIS runtime and resolved the handle
 *             itself. This is the original contract and the only one that grants
 *             authority (a reply address, a relayed re-post).
 *
 *   dispatch  A worker this session started. It has NO pane key by contract, and
 *             the address it arrives under was minted by the receiving runtime.
 *             It earns a NAME. It earns no authority.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SenderIdentity {
  name: string;
  model: string;
  attributed: boolean;
  /** How the sender was established. Absent means the pane-witness path. */
  kind?: 'pane' | 'dispatch';
}

/** The pane lookup, injected so this module needs no registry and no Orca. */
export type PaneLookup = (handle: string) => { peer: string; model: string };

/**
 * Where `ax worker start` writes a dispatch record before issuing its mutation.
 * Read at CALL time, not module load, so a test can point it at a fixture
 * without racing the import.
 */
function dispatchStore(): string {
  const declared = process.env.ORCA_DISPATCH_STORE_DIR;
  if (declared !== undefined && declared !== '') return declared;
  return join(homedir(), '.omp', 'run', 'dispatch');
}

const dispatchNames = new Map<string, { request: string; json: unknown }>();

/** Tests only: the cache is process-lifetime and would leak between fixtures. */
export function resetDispatchNames(): void {
  dispatchNames.clear();
}

/**
 * "Is this dispatch one I started myself?" — the name, or `null`.
 *
 * WHY THIS EXISTS. A worker's report arrives with `from_handle: "dispatch:<id>"`
 * and NO `sender_pane_key`, and until 2026-08-13 this session called that an
 * UNIDENTIFIED sender. That reading is wrong, and Orca's own source says why: on
 * the federated path the home runtime DISCARDS the `from` that came over the wire
 * and mints `dispatch:${dispatchId}` from the dispatch row it looked up locally
 * (`syncFederatedDispatch`, out/main/index.js:91260-91275, orca 1.4.180). The
 * address is the receiver's statement of which mailbox it pulled, not the
 * sender's claim, and four checks stand behind it — peer-fingerprint equality,
 * the remote side authorising the pull by `home_peer_fingerprint`, strict
 * sequence contiguity, and a `task_dispatch_mismatch` rejection unless the
 * payload's dispatchId AND taskId equal the pulled dispatch's own. Upstream the
 * worker could only enqueue after `verifyRemoteAttachmentAuthority`
 * (:89280-89285): `timingSafeEqual` on the capability hash, an equivalent pane
 * key, and an exact process incarnation.
 *
 * So a pane key is neither weaker nor stronger here. It is simply not the
 * mechanism: `FederatedControlMessage` has no field for one, and
 * `db.insertMessage` therefore stores NULL (federation-control-message.ts:7-18,
 * db.ts:2851-2879).
 *
 * WHY NOT TRUST THE STRING ITSELF. One path is not minted. A LOCAL lifecycle
 * claim whose dispatch has no `assignee_pane_key` — a legacy dispatch, no
 * capability ever minted — degrades in `hasLifecycleAuthority` (:90486-90488) to
 * comparing `assignee_handle` with `from_handle`, a plain string. So the gate
 * here is not the shape of the address. It is whether the id appears in THIS
 * machine's dispatch store. A sender is named because we started it, evidenced by
 * our own disk, and never because it told us what it is.
 *
 * Positive answers are cached; negative ones never are — a dispatch recorded a
 * second after this call would otherwise stay a stranger for the session's life.
 */
export function dispatchIStarted(dispatchId: string): string | null {
  return dispatchRecord(dispatchId)?.request ?? null;
}

/**
 * The whole record, for a caller that needs more than the name — the reply-route resolver
 * reads the recorded argv out of it to learn which environment the dispatch went to.
 *
 * One reader over the store, two consumers. A second walk of these files would be a second
 * way to disagree about whether a dispatch is ours.
 */
export function dispatchRecord(
  dispatchId: string,
): { request: string; json: unknown } | null {
  if (dispatchId === '') return null;
  const cached = dispatchNames.get(dispatchId);
  if (cached !== undefined) return cached;

  const store = dispatchStore();
  let files: string[];
  try {
    files = readdirSync(store).filter((name) => name.endsWith('.json'));
  } catch {
    // No store means nothing was ever dispatched from this machine. Not a fault.
    return null;
  }

  for (const file of files) {
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(join(store, file), 'utf8'));
    } catch {
      continue; // A half-written record is one unreadable file, not a verdict.
    }
    const bag = record as { request?: unknown; attempts?: unknown } | null;
    const attempts = Array.isArray(bag?.attempts) ? bag.attempts : [];
    for (const attempt of attempts) {
      const phases = (attempt as { phases?: unknown } | null)?.phases;
      if (!Array.isArray(phases)) continue;
      for (const phase of phases) {
        const result = (phase as { receipt?: { result?: { dispatchId?: unknown } } } | null)
          ?.receipt?.result;
        if (String(result?.dispatchId ?? '') !== dispatchId) continue;
        const found = {
          request: String(bag?.request ?? '').trim() || file.replace(/\.json$/, ''),
          json: record,
        };
        dispatchNames.set(dispatchId, found);
        return found;
      }
    }
  }
  return null;
}

/**
 * Identity is gated on `sender_pane_key`, the one field a sender cannot forge.
 * `from_handle` alone is NOT authenticated — it can be overridden with
 * `orca orchestration send --from <victim>` (Orca documents that flag as being
 * for impersonating another terminal) or by a doctored `ORCA_TERMINAL_HANDLE`.
 * Orca cross-checks the caller's pane against the handle it claims and drops the
 * key to null the moment they disagree:
 *
 *     honest send                     from_handle real     pane_key present
 *     --from <victim>                 from_handle victim   pane_key NULL
 *     ORCA_TERMINAL_HANDLE=<victim>   from_handle victim   pane_key NULL
 *
 * THREAT MODEL, stated because the guarantee is bounded: this defends against the
 * `--from` flag and a stray environment variable, i.e. accidental or casual
 * misattribution between cooperating sessions. It does NOT defend against a
 * hostile process running as the same user, which can read a live pane key out of
 * another process's environment — but such a process can already inject directly
 * into any pane with `orca terminal send`, so peer messaging adds no exposure it
 * does not already have.
 */
export function senderIdentity(
  msg: Record<string, unknown>,
  paneLookup: PaneLookup,
): SenderIdentity {
  const paneKey = msg.sender_pane_key;
  const handle = String(msg.from_handle ?? '').trim();

  if (paneKey === null || paneKey === undefined || paneKey === '') {
    // A worker reporting through its dispatch has no pane key BY CONTRACT, and
    // the address it arrives under was minted by the runtime rather than claimed
    // by the sender. `dispatchIStarted` is the gate: our own write-ahead record,
    // never the shape of the string.
    const dispatched = /^dispatch:(.+)$/.exec(handle);
    const known = dispatched === null ? null : dispatchIStarted(dispatched[1] ?? '');
    if (known !== null)
      return { name: `child:${known}`, model: '', attributed: true, kind: 'dispatch' };

    // No witness and no dispatch of ours: the sender either overrode its identity
    // or is not an Orca pane at all. Never render a peer name or model.
    return {
      name: handle ? `unattributed:${handle.slice(0, 14)}` : 'unattributed',
      model: '',
      attributed: false,
    };
  }
  if (!handle) return { name: 'unattributed', model: '', attributed: false };

  // Attribution is the WITNESS, not the name lookup. When Orca is briefly
  // unreachable the worktree name is unknown, but the pane key still proves this
  // came from the pane it claims — so the message stays attributed and, more
  // importantly, still earns a reply route. Degrading to "unattributed" here
  // would silently strip repliability from an honest peer.
  const info = paneLookup(handle);
  return {
    name: info.peer || `pane:${handle.replace(/^term_/, '').slice(0, 8)}`,
    model: info.model,
    attributed: true,
    kind: 'pane',
  };
}
