// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * The registry on disk: what a session publishes about itself, keyed by its
 * terminal handle under `registryDir()`. Entries are written atomically; the
 * register lock and the outbound sequence live in the same directory and
 * follow the same tmp+rename discipline. The naming rule is NOT here — a name
 * is derived in `./address.ts`, never claimed by a writer.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { str } from './orca.ts';

/** Overridable so the tests never touch the live registry. */
function registryDir(): string {
  return (
    process.env.ORCA_PEER_REGISTRY_DIR ||
    `${process.env.HOME}/.omp/run/orca-peers`
  );
}
const HANDLE = /^term_[A-Za-z0-9_-]{1,128}$/;

export function selfHandle(): string {
  const handle = process.env.ORCA_TERMINAL_HANDLE ?? '';
  return HANDLE.test(handle) ? handle : '';
}

// --------------------------------------------------------------- registry --

/** What a session publishes about itself. Orca knows none of these. */
export interface Entry {
  handle: string;
  run: string;
  model: string;
  /** The thinking level the session is serving, from its own `thinking_level_change`. */
  level: string;
  sessionId: string;
  ownerPid: number;
  modelSource: string;
  startedAt: string;
}


export function readEntry(handle: string): Partial<Entry> | null {
  try {
    return JSON.parse(readFileSync(`${registryDir()}/${handle}.json`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every entry in the registry, one bad file costing exactly one peer.
 *
 * Entries are written by independent processes, so a half-written file is a
 * normal thing to read. Parsing per file keeps that to one missing peer; a
 * single parse over the whole directory fails whole and empties the fleet.
 */
export function allEntries(): Partial<Entry>[] {
  let names: string[] = [];
  try {
    names = readdirSync(registryDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Partial<Entry>[] = [];
  for (const n of names) {
    try {
      const parsed = JSON.parse(readFileSync(`${registryDir()}/${n}`, 'utf8'));
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // One unreadable file is one missing peer, not an empty fleet.
    }
  }
  return out;
}

/**
 * The Run a WITNESSED pane publishes for itself, as a `run:<id>` address, or `''`.
 *
 * WHY THIS IS NOT THE FORGEABLE LOOKUP THIS MODULE REFUSES ELSEWHERE. Every
 * other "resolve an address" path here starts from a NAME, and a name is exactly
 * what a peer shell can claim by overwriting an entry. This one starts from a
 * handle ORCA witnessed — `sender_pane_key` present, gated in `attribution.ts` —
 * so the sender does not choose the key this reads under.
 *
 * WHAT IT BUYS. A message sent with a hand-rolled `orca orchestration send`,
 * which is what Orca's supervised preamble teaches every worker to do for
 * `worker_done` and therefore the majority of real traffic, carries no
 * `payload.replyTo`. It arrives attributed and unanswerable: measured 2026-08-25
 * on ofmchat, `msg_0c83c5b494db` from `57-policy-offer-engine` invited a reply
 * and then refused it, and the orchestrator answered by typing into the child's
 * pane instead. The pane's own published Run is the return address that child
 * would have written itself, so reading it is a repair, not a guess.
 *
 * THE BOUND, STATED. The registry is a same-uid directory, so a hostile local
 * process could point this at another Run. That process can already
 * `orca terminal send` into any pane — the THREAT MODEL paragraph in
 * `attribution.ts` — so this adds no exposure it does not already have. And a
 * payload `replyTo` still wins wherever the sender supplied one, so this can
 * only ever fill a silence, never redirect an address a peer stated.
 */
export function runAddressOfHandle(handle: string): string {
  if (!HANDLE.test(handle)) return '';
  const run = str(readEntry(handle)?.run);
  return run ? `run:${run}` : '';
}

/** Atomic: a model id containing a quote must never publish unparseable JSON. */
export function publish(handle: string, entry: Entry): boolean {
  const dir = registryDir();
  const tmp = `${dir}/.${handle}.json.${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    renameSync(tmp, `${registryDir()}/${handle}.json`);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

export function alive(pid: unknown): boolean {
  const n = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

type RegisterLock = { path: string; token: string };

export function acquireRegisterLock(handle: string): RegisterLock | null {
  const dir = registryDir();
  const path = `${dir}/.${handle}.register.lock`;
  const token = randomUUID();
  mkdirSync(dir, { recursive: true });

  const create = (): RegisterLock | null => {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ ownerPid: process.pid, token })}\n`);
      return { path, token };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const acquired = create();
  if (acquired !== null) return acquired;

  // Recover only from a lock whose recorded process is proven gone. Malformed
  // state is ambiguity, not permission to remove another writer's lock.
  try {
    const recorded = JSON.parse(readFileSync(path, 'utf8'));
    if (alive(recorded?.ownerPid)) return null;
    if (typeof recorded?.ownerPid !== 'number') return null;
    rmSync(path);
  } catch {
    return null;
  }
  return create();
}

export function releaseRegisterLock(lock: RegisterLock): void {
  try {
    const recorded = JSON.parse(readFileSync(lock.path, 'utf8'));
    if (recorded?.token === lock.token) rmSync(lock.path);
  } catch {}
}

/**
 * A MONOTONIC PER-SENDER SEQUENCE, so a lost message leaves a hole.
 *
 * WHY. Orca's receipt for `orchestration send` is the same string whether the
 * message arrived or vanished. Measured 2026-08-15: on Orca 1.4.182 a
 * dispatched worker on a second host sent 6 reports home, 3 arrived, and all 6
 * receipts read `Queued relay_<id> for Run home` with exit 0; on 1.4.183 the
 * same probe got 10/10 delivered and the SAME receipt string. Delivery got
 * fixed, the receipt did not, so neither end can tell the two cases apart from
 * the wire alone.
 *
 * A number the sender increments is the cheapest thing that can: the receiver
 * sees 4 after 2 and knows one message is gone, even though it can never learn
 * what was in it.
 *
 * SCOPE, HONESTLY. This covers ONLY messages routed through `sendToPeer` in
 * this layer. A worker that hand-rolls `orca orchestration send` directly —
 * which is exactly what Orca's own supervised spec boilerplate teaches it to do
 * for `--type status`/`worker_done` — carries no sequence and is invisible to
 * the gap check in `receive.ts`. That uncovered majority is the argument for
 * fixing the receipt upstream (see `docs/upstream/orca-ordinary-send-receipt.md`).
 *
 * PERSISTED, because the counter has to outlive a turn boundary: each send is a
 * fresh handler invocation and, on a restarted session, a fresh process. Keyed
 * by the sender identity rather than the process, so the same peer name keeps
 * one ascending series.
 */
function seqFile(sender: string): string {
  // The key rides into a filename, so anything that is not plainly a name is
  // flattened. Collisions merely share a counter; they cannot escape the dir.
  const safe = sender.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unnamed';
  return `${registryDir()}/seq/${safe}.json`;
}

/**
 * The number this send should carry, plus the commit that makes it permanent.
 *
 * The counter advances only when the send is ACCEPTED. A send that failed hard
 * is one the sender already knows about, and burning its number would make the
 * receiver cry loss over a message that was never on the wire.
 */
export function nextOutboundSequence(sender: string): {
  seq: number;
  commit: () => void;
} {
  const path = seqFile(sender);
  let last = 0;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const n = Number(raw?.seq);
    if (Number.isSafeInteger(n) && n > 0) last = n;
  } catch {
    // Absent or corrupt: start the series at 1. A receiver with no baseline
    // does not alarm, so a reset costs a missed check, never a false one.
  }
  const seq = last + 1;
  return {
    seq,
    commit(): void {
      try {
        mkdirSync(`${registryDir()}/seq`, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ seq, sender }));
        renameSync(tmp, path);
      } catch (err) {
        // A counter that cannot be persisted must not fail the send. It does
        // mean the next send reuses this number, which the receiver reports as
        // a duplicate — loud, and the right way round.
        console.error(`[orca-peer] sequence not persisted for ${sender}: ${err}`);
      }
    },
  };
}
