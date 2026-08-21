// The write-ahead record of one dispatch — the memory that survives the mutation.
//
// Port of `~/.omp/agent/scripts/coordinator/record.py`, the decision core of the
// bash coordinator. The protocol it encodes is F-001 (2026-08-09, two agents
// created twice in one worktree): a mutation may only ever be issued from a
// record written BEFORE it, and recovered by replaying that record byte for
// byte. A missing, unreadable or ambiguous record is an inability to establish —
// never permission. No live-agent snapshot can change that outcome, because a
// snapshot cannot see a mutation still in flight.
//
// COMPATIBILITY IS A CONTRACT: the JSON vocabulary here (`attempts`, `phases`,
// `receipt`, `identity`, `argv`) is record.py's, unchanged, so a record written
// by the bash era replays through ax and vice versa during the migration. The
// one shape change is additive: new phases may carry `receiptPath: null`
// because receipts now travel in memory (see parseReceipt in orca-bin.mjs).
//
// Reading discipline (F-028): named keys, and a raise on absence — never an
// `||` fallback on a container. An `or` on a container is how an empty worker
// list was once read as a count of 2.

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The request-id grammar, closed: it names a file in the store, so a leading
 * dot (dotfiles, `..`) and separators are refused before any disk access.
 * This grammar existed twice in bash (coordinator + stall-watch), verbatim.
 */
export const REQUEST_ID = /^(?!\.)[A-Za-z0-9_.-]+$/;
export const requestIdOk = request => typeof request === 'string' && REQUEST_ID.test(request);

/** Store compatibility: same default and same override as the bash era. */
export const defaultStore = (env = process.env) => env.ORCA_DISPATCH_STORE || join(env.HOME ?? '', '.omp', 'run', 'dispatch');

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (rec, path) => writeFileSync(path, JSON.stringify(rec, null, 1));

/** Named-key read: absence is a protocol violation, named — never a default. */
function must(container, key, where) {
  if (container === null || typeof container !== 'object' || !(key in container)) {
    throw new Error(`record is missing "${key}" (${where})`);
  }
  return container[key];
}

function lastAttempt(rec) {
  const attempts = must(rec, 'attempts', 'record root');
  if (attempts.length === 0) throw new Error('record has no attempt');
  return attempts[attempts.length - 1];
}

/** Index into the last attempt's phases. `'last'` is the phase just recorded. */
function phaseAt(rec, index) {
  const phases = must(lastAttempt(rec), 'phases', 'last attempt');
  const ph = index === 'last' ? phases[phases.length - 1] : phases[Number(index)];
  if (ph === undefined) throw new Error(`no phase at index ${index}`);
  return ph;
}

/** A task id under either of the two shapes Orca has returned it in. */
const taskIdOf = result => (result.task ?? {}).id ?? result.taskId;

/**
 * The atomic claim. `wx` is O_CREAT|O_EXCL: it fails when the path exists at
 * all, a dangling symlink included — both the claim and the symlink refusal in
 * one open, exactly what `set -C` gave bash. Without it two first callers each
 * see no record, mint different identities, and Orca — correctly — deduplicates
 * neither.
 *
 * Losing the claim is NOT an error: it means another caller owns this logical
 * request, and the safe move is to replay its record, never to mint a second
 * identity. The store and this guarantee are HOST-LOCAL — cross-host callers
 * each claim in their own store, and idempotency across hosts rests on Orca's
 * server-side `--retry-request`.
 */
export function claimRecord(store, request) {
  if (!requestIdOk(request)) throw new Error(`request id "${request}" violates ${REQUEST_ID}`);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const path = join(store, `${request}.json`);
  try {
    closeSync(openSync(path, 'wx', 0o600));
    return { claimed: true, path };
  } catch (error) {
    if (error.code === 'EEXIST') return { claimed: false, path };
    throw error;
  }
}

/** The first write of a claimed record: who asked, on what host, through which binary. */
export function initRecord(path, { request, orca, host = hostname(), now = () => new Date().toISOString() }) {
  save({ request, host, orca, createdAt: now(), attempts: [{ n: 1, settled: false, phases: [] }] }, path);
}

/**
 * Write-ahead: the argv and the identity land on disk BEFORE the mutation is
 * issued. That ordering is the whole recovery property — a mutation that never
 * returns is still replayable byte for byte.
 */
export function phaseBegin(path, { name, identity, argv, receiptPath = null }) {
  const rec = load(path);
  must(lastAttempt(rec), 'phases', 'last attempt').push({ name, identity, argv, receiptPath, receipt: null, exit: null });
  save(rec, path);
}

/**
 * Close a phase with its exit code and its receipt text. An unparseable receipt
 * is STORED as `{ unparseable, error }`, never dropped: F-004 is the one time a
 * formatter ate the only diagnostic that mattered.
 */
export function phaseEnd(path, index, { exit, receiptText }) {
  const rec = load(path);
  const ph = phaseAt(rec, index);
  ph.exit = exit;
  try {
    ph.receipt = JSON.parse(receiptText);
  } catch (error) {
    ph.receipt = { unparseable: String(receiptText).slice(0, 4000), error: String(error) };
  }
  save(rec, path);
}

/**
 * The recorded argv, reconstructed — never recomposed. Orca's fingerprint
 * refuses on any difference, so a recomposed line is a refusal at best and a
 * second identity at worst.
 */
export const phaseArgv = (path, index) => [...must(phaseAt(load(path), index), 'argv', 'phase')];

export const phaseCount = path => must(lastAttempt(load(path)), 'phases', 'last attempt').length;

/**
 * The verdict on one phase. `mismatch` is Orca refusing a divergent reissue —
 * a refusal, never a reason to mint a new identity: minting one is how the
 * duplicate is born. It is therefore distinguished from `failed` by name.
 */
export function phaseVerdict(path, index) {
  const receipt = phaseAt(load(path), index).receipt ?? {};
  const error = receipt.error ?? {};
  if (error.code === 'request_mismatch') return { verdict: 'mismatch', evidence: error.message ?? '' };
  if (!receipt.ok) {
    return { verdict: 'failed', evidence: Object.keys(error).length > 0 ? error : JSON.stringify(receipt).slice(0, 400) };
  }
  const result = must(receipt, 'result', 'phase receipt');
  return {
    verdict: (result.mutation ?? {}).replayed ? 'replayed' : 'ran',
    evidence: {
      taskId: taskIdOf(result),
      dispatchId: result.dispatchId,
      stage: result.stage,
      state: result.state,
      effects: result.effects,
      residualResources: result.residualResources,
    },
  };
}

/**
 * RAN/REPLAYED, usable or stranded, then the resources.
 *
 * `usable` is a conjunction ON PURPOSE: exit 0 alone is a receipt, and a
 * receipt that reports a partial mutation is STRANDED however cleanly the
 * process ended. Reads here are lenient — a stranded receipt has no `result`
 * to demand.
 */
export function report(path) {
  const ph = phaseAt(load(path), 'last');
  const receipt = ph.receipt ?? {};
  const result = receipt.result ?? {};
  return {
    mode: (result.mutation ?? {}).replayed ? 'REPLAYED' : 'RAN',
    usable: ph.exit === 0 && result.state === 'ready',
    summary: {
      dispatchId: result.dispatchId,
      stage: result.stage,
      state: result.state,
      effects: result.effects ?? [],
      residualResources: result.residualResources ?? [],
    },
  };
}

/**
 * The task id `task-create` just produced. Strict — one receipt shape only —
 * because it is the gate before a mutation: a start with no task id must not
 * reach `worker-start`. Deliberately NOT merged with `taskIdScan`: collapsing
 * the two would either loosen this gate or tighten that search.
 */
export function taskId(path) {
  const receipt = must(must(lastAttempt(load(path)), 'phases', 'last attempt')[0], 'receipt', 'first phase');
  const tid = ((must(receipt, 'result', 'task-create receipt').task ?? {}).id) ?? null;
  if (!tid) throw new Error('task-create receipt carries no task id');
  return tid;
}

/** The newest task id anywhere in the record, both receipt shapes — for --replace. */
export function taskIdScan(path) {
  const attempts = must(load(path), 'attempts', 'record root');
  for (const attempt of [...attempts].reverse()) {
    for (const ph of must(attempt, 'phases', 'attempt')) {
      const tid = taskIdOf((ph.receipt ?? {}).result ?? {});
      if (tid) return tid;
    }
  }
  throw new Error('no task id recorded');
}

/**
 * Is a lost claim provably USELESS rather than merely suspicious?
 *
 * Measured 2026-08-14: a record written under ANOTHER session's Run fenced the
 * operator's own legitimate relaunch permanently. Two conditions, BOTH required:
 * no attempt anywhere recorded a task id (nothing exists server-side to
 * protect), and the Run it names is not the caller's (no terminal here can
 * replay it). A record that fails either test is precious: the reason says why,
 * and the caller replays it instead.
 */
export function staleClaim(path, callerRun) {
  const rec = load(path);
  const attempts = must(rec, 'attempts', 'record root');
  for (const attempt of attempts) {
    for (const ph of must(attempt, 'phases', 'attempt')) {
      if (taskIdOf((ph.receipt ?? {}).result ?? {})) {
        return { stale: false, reason: 'record carries a task id — it may name a real mutation' };
      }
    }
  }
  let recorded = '';
  for (const attempt of attempts) {
    for (const ph of must(attempt, 'phases', 'attempt')) {
      const argv = ph.argv ?? [];
      const i = argv.indexOf('--run');
      if (i !== -1 && i + 1 < argv.length) {
        recorded = argv[i + 1];
        break;
      }
    }
    if (recorded) break;
  }
  if (!recorded) return { stale: false, reason: 'record names no Run — being foreign cannot be proven' };
  if (recorded === callerRun) return { stale: false, reason: `record names this caller's own Run ${recorded} — replay it` };
  return { stale: true, foreignRun: recorded };
}

/** A replacement is a NEW logical attempt: settle the current one, open the next. */
export function attemptNew(path) {
  const rec = load(path);
  const attempts = must(rec, 'attempts', 'record root');
  attempts[attempts.length - 1].settled = true;
  attempts.push({ n: attempts.length + 1, settled: false, phases: [] });
  save(rec, path);
}

/** A fresh mutation identity — lowercase UUID, the shape Orca fingerprints. */
export const newIdentity = () => randomUUID();
