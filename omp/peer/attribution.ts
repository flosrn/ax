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
 *             itself, and PUBLISHED that verdict as `sender_attribution: 'pane'`.
 *             The private `sender_pane_key` behind it is stripped from every
 *             receipt, so the verdict — not the key — is what a message read off
 *             the wire carries. This is the original contract and the only one
 *             that grants authority (a reply address, a relayed re-post).
 *
 *   dispatch  A worker this session started. It has NO pane by contract, so Orca
 *             says `'unattributed'` about it and says so correctly; the address
 *             it arrives under was minted by the receiving runtime, and the name
 *             comes from our own write-ahead record. It earns a NAME. It earns
 *             no authority.
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
 * Every `{file, record}` the store holds. One walk, and every consumer below is
 * a reading of THIS list: a second walk of these files would be a second way to
 * disagree about whether a dispatch is ours. A half-written record is one
 * unreadable file, not a verdict, and a missing store means nothing was ever
 * dispatched from this machine — not a fault.
 */
function storeRecords(): { file: string; record: unknown }[] {
  const store = dispatchStore();
  let files: string[];
  try {
    files = readdirSync(store).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: { file: string; record: unknown }[] = [];
  for (const file of files) {
    try {
      out.push({ file, record: JSON.parse(readFileSync(join(store, file), 'utf8')) });
    } catch {
      continue;
    }
  }
  return out;
}

/** The dispatch ids one record's phases RECORDED, in file order. */
function dispatchIdsOf(record: unknown): string[] {
  const bag = record as { attempts?: unknown } | null;
  const attempts = Array.isArray(bag?.attempts) ? bag.attempts : [];
  const ids: string[] = [];
  for (const attempt of attempts) {
    const phases = (attempt as { phases?: unknown } | null)?.phases;
    if (!Array.isArray(phases)) continue;
    for (const phase of phases) {
      const result = (phase as { receipt?: { result?: { dispatchId?: unknown } } } | null)
        ?.receipt?.result;
      const id = String(result?.dispatchId ?? '');
      if (id !== '' && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The whole record, for a caller that needs more than the name — the reply-route resolver
 * reads the recorded argv out of it to learn which environment the dispatch went to.
 */
export function dispatchRecord(
  dispatchId: string,
): { request: string; json: unknown } | null {
  if (dispatchId === '') return null;
  const cached = dispatchNames.get(dispatchId);
  if (cached !== undefined) return cached;

  for (const { file, record } of storeRecords()) {
    if (!dispatchIdsOf(record).includes(dispatchId)) continue;
    const named = String((record as { request?: unknown } | null)?.request ?? '').trim();
    const found = { request: named || file.replace(/\.json$/, ''), json: record };
    dispatchNames.set(dispatchId, found);
    return found;
  }
  return null;
}

/**
 * EVERY dispatch this machine recorded, one entry per dispatch id.
 *
 * The lookup above answers "is this id ours"; this answers the question a
 * cross-host relay asks, which has no id in hand: "did I ever dispatch anything
 * to that host, and does it resolve to that Run" (`./route.ts`,
 * `attestsRelayEnvironment`). Deliberately UNCACHED — a dispatch issued a second
 * ago must be visible, or the parent refuses to relay to a child it just started.
 */
export function dispatchRecords(): { id: string; request: string; json: unknown }[] {
  const out: { id: string; request: string; json: unknown }[] = [];
  for (const { file, record } of storeRecords()) {
    const named = String((record as { request?: unknown } | null)?.request ?? '').trim();
    const request = named || file.replace(/\.json$/, '');
    for (const id of dispatchIdsOf(record)) out.push({ id, request, json: record });
  }
  return out;
}

/**
 * Did the runtime attest this message as coming from a pane?
 *
 * A present `sender_attribution` is authoritative and only the literal `'pane'`
 * is a yes. Any other value — `'unattributed'`, an unknown string, `null` — is
 * a no, and the private `sender_pane_key` is not consulted after that. The key
 * is read only when the verdict is absent entirely (older runtime).
 *
 * This is the one reading of the two witness shapes. `senderIdentity` and the
 * local-worker Report derivation (`./completion.ts`) both consume it, so a
 * receipt that carries the public verdict and no key cannot be a pane here and
 * an unwitnessed claim there.
 */
export function paneWitnessed(msg: Record<string, unknown>): boolean {
  const verdict = msg.sender_attribution;
  if (verdict !== undefined) return verdict === 'pane';
  const paneKey = msg.sender_pane_key;
  return paneKey !== null && paneKey !== undefined && paneKey !== '';
}

/**
 * Identity comes from Orca's own statement about the sender, never from a field
 * the sender wrote. That statement reaches a receipt in two shapes, and reading
 * only the older one was a live defect.
 *
 *   sender_attribution   The PUBLIC verdict, `'pane' | 'unattributed'`. Orca
 *                        derives it from the pane witness it has STORED for the
 *                        message and exposes none of that witness
 *                        (`exposeMessages`, `mailbox-message-receipt.ts`). This
 *                        is what a receipt actually carries.
 *
 *   sender_pane_key      The witness itself. It lives in the mailbox row, and
 *                        the same serializer deletes it from every receipt it
 *                        serves, alongside `read`, `sequence` and the
 *                        `pointer_*` columns — delivery plumbing the runtime
 *                        owns. Only an older runtime, which published no
 *                        verdict, leaks it this far.
 *
 * So the verdict wins whenever it is present, and only the literal `'pane'`
 * opens the pane path: any other value means the runtime answered and its
 * answer was not `'pane'`. Falling back to the key after that would make a
 * stripped internal column an override of Orca's public answer — the one way
 * this reading could weaken the refusal. The key is consulted ONLY when no
 * verdict is present at all.
 *
 * WHAT THE VERDICT IS, AND IS NOT. It reports PROVENANCE: the runtime held a
 * stored pane witness for this message. It is not a lifecycle authority check,
 * and this module makes no claim about what a determined sender on the same
 * machine can arrange. A non-pane verdict cannot open the pane path; a known
 * dispatch still has its separate, record-derived identity below. Nothing in
 * the message body can raise either provenance.
 */
export function senderIdentity(
  msg: Record<string, unknown>,
  paneLookup: PaneLookup,
): SenderIdentity {
  const handle = String(msg.from_handle ?? '').trim();
  const witnessed = paneWitnessed(msg);

  if (!witnessed) {
    // A worker reporting through its dispatch has no pane BY CONTRACT — so its
    // honest verdict is `'unattributed'` — and the address it arrives under was
    // minted by the runtime rather than claimed by the sender. `dispatchIStarted`
    // is the gate: our own write-ahead record, never the shape of the string.
    // This names the child; `kind: 'dispatch'` is what still denies it the relay
    // and any address read out of its payload.
    const dispatched = /^dispatch:(.+)$/.exec(handle);
    const known = dispatched === null ? null : dispatchIStarted(dispatched[1] ?? '');
    if (known !== null)
      return { name: `child:${known}`, model: '', attributed: true, kind: 'dispatch' };

    // No witness and no dispatch of ours: the source cannot be established.
    // Never render a peer name or model.
    return {
      name: handle ? `unattributed:${handle.slice(0, 14)}` : 'unattributed',
      model: '',
      attributed: false,
    };
  }
  if (!handle) return { name: 'unattributed', model: '', attributed: false };

  // Attribution is the WITNESS, not the name lookup. When Orca is briefly
  // unreachable the worktree name is unknown, but Orca's verdict remains —
  // so the message stays attributed and, more
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
