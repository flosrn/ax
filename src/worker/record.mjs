// The write-ahead record of one dispatch — the memory that survives the mutation.
//
// Port of the bash orchestrator's `record.py`, its decision core. The protocol
// it encodes is F-001 (2026-08-09, two agents created twice in one worktree): a
// mutation may only ever be issued from a record written BEFORE it, and
// recovered by replaying that record byte for byte. A missing, unreadable or
// ambiguous record is an inability to establish — never permission. No
// live-agent snapshot can change that outcome, because a snapshot cannot see a
// mutation still in flight.
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

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReceipt } from '../orca-bin.mjs';

/**
 * The request-id grammar, closed: it names a file in the store, so a leading
 * dot (dotfiles, `..`) and separators are refused before any disk access.
 * This grammar existed twice in bash (the orchestrator and its stall watcher),
 * verbatim.
 */
export const REQUEST_ID = /^(?!\.)[A-Za-z0-9_.-]+$/;
export const requestIdOk = request => typeof request === 'string' && REQUEST_ID.test(request);

/** Store compatibility: same default and same override as the bash era. */
export const defaultStore = (env = process.env) => env.ORCA_DISPATCH_STORE || join(env.HOME ?? '', '.omp', 'run', 'dispatch');

const load = path => JSON.parse(readFileSync(path, 'utf8'));
function save(rec, path) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(rec, null, 1));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);

    // Persist the rename itself where the platform permits directory fsync.
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed successfully, or never created.
    }
  }
}

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

/** One argv option under either split (`--on value`) or joined (`--on=value`) form. */
export function argvValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

/** Every phase in chronological order, with named-key strictness at each level. */
function allPhases(rec) {
  return must(rec, 'attempts', 'record root').flatMap(attempt => must(attempt, 'phases', 'attempt'));
}

function lastWorkerStart(rec) {
  const phase = allPhases(rec).findLast(candidate => candidate.name === 'worker-start');
  if (!phase) throw new Error('record has no worker-start phase');
  return phase;
}

function workerStartResult(phase) {
  return must(must(phase, 'receipt', 'worker-start phase'), 'result', 'worker-start receipt');
}

/**
 * The pane the AGENT sits in, or null.
 *
 * Orca marks that effect `role: "agent"` since it started returning more than
 * one terminal per dispatch (a setup pane and the agent's own). Bash-era
 * receipts carry no role at all and name exactly one `term_` effect, so that
 * one IS the agent pane — but the fallback is allowed ONLY when no pane
 * declares a role. A receipt that labels its panes and labels none `agent` has
 * told us the agent pane is absent, and calling its setup pane the agent's is
 * how a half-made dispatch gets reported as a working worker.
 */
function agentTerminal(result) {
  const effects = Array.isArray(result?.effects) ? result.effects : [];
  const panes = effects.filter(
    candidate => candidate?.kind === 'terminal' && typeof candidate.id === 'string' && candidate.id.startsWith('term_'),
  );
  const agent = panes.find(candidate => candidate.role === 'agent');
  if (agent) return agent.id;
  if (panes.length > 0 && panes.every(candidate => candidate.role === undefined)) return panes[0].id;
  return null;
}

function terminalEffect(result, message) {
  must(result, 'effects', 'worker-start result');
  const id = agentTerminal(result);
  if (id === null) throw new Error(message);
  return id;
}

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

/**
 * Is that pid running? Signal 0 tests existence without delivering anything,
 * and EPERM is the one failure that means YES: a live process this user does
 * not own. Reading it as dead is how a lock gets stolen from a working sibling.
 */
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** A synchronous pause, for the one caller here that has nothing else to do. */
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The exclusive right to WRITE this record, host-local, held for the whole
 * gesture.
 *
 * `claimRecord` guards the birth of a record; nothing guarded its replacement.
 * Two concurrent `--replace` runs each pass the live-agent gate (neither has
 * started anything yet), each return the task to `ready`, and each start a
 * worker — the F-001 duplicate rebuilt out of two legitimate recoveries. So the
 * lock is taken BEFORE the gate and released only after `worker-start` has been
 * recorded: the gate's answer is worthless the instant a sibling can act on it.
 *
 * `wx` again, with an ownership token. Every pre-existing lock fails closed,
 * even when its pid looks dead: read-then-unlink has an ABA race where two
 * reapers can each delete the other's new lock. Normal release removes only
 * the token it created; a crashed holder needs explicit repair after the
 * operator proves no replacement survives.
 *
 * THE WAIT (#95). The claim winner and the claim loser contend for one lock,
 * and the loser's automatic replay must survive meeting it: a `held: false`
 * answered at once turned every honest overlap into an exit 3 against a live
 * owner. With `waitMs > 0` a lock held by a LIVE process on this host is
 * waited out — the window re-arms on every proof of liveness, so an honestly
 * slow holder (two Orca calls under CI load) is never refused, however long
 * its mint takes. What cannot be proven is bounded: a holder on another host,
 * or a lock file caught between its `wx` and its write, gets the whole window
 * once and then the same named refusal as before. A holder proven DEAD is
 * refused immediately, exactly as before — the wait is never a takeover.
 */
export function acquireLock(path, { pid = process.pid, host = hostname(), suffix = '.lock', waitMs = 0, pollMs = 50, sleep = sleepSync, clock = Date.now } = {}) {
  const lock = `${path}${suffix}`;
  const token = randomUUID();
  let armedAt = clock();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid, host, token, at: new Date().toISOString() }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let refusal;
      try {
        const holder = JSON.parse(readFileSync(lock, 'utf8'));
        const local = holder.host === host;
        if (local && !pidAlive(Number(holder.pid))) {
          return { held: false, reason: `pre-existing stale lock at ${lock} from dead pid ${holder.pid}; automatic takeover is refused` };
        }
        if (local) armedAt = clock();
        refusal = `pre-existing lock at ${lock} belongs to ${holder.host} pid ${holder.pid}`;
      } catch (readError) {
        refusal = `the replace lock at ${lock} is unreadable: ${String(readError.message ?? readError)}`;
      }
      if (waitMs <= 0 || clock() >= armedAt + waitMs) return { held: false, reason: refusal };
      sleep(pollMs);
    }
  }

  return {
    held: true,
    release: () => {
      try {
        const holder = JSON.parse(readFileSync(lock, 'utf8'));
        if (holder.token === token) unlinkSync(lock);
      } catch {
        // Already gone or no longer ours: never delete an unknown successor.
      }
    },
  };
}

/**
 * The first write of a claimed record: who asked, on what host, through which
 * binary — and, when the caller overrode the ticket's own assignment, why
 * (`--because`, R4/KTD3), and WHICH repository this dispatch belongs to
 * (`repo`, from `--tracker-repo`: the dispatching checkout's own identity, the
 * ticket's URL only as a fallback): the store is host-global, and the frontier
 * needs the name to keep one checkout's records from excluding another's.
 *
 * Both keys are ADDITIVE and omitted when empty (the shape rule in this file's
 * header): every reader here works from named keys, no recovery path branches
 * on them, and a record written by an older ax carries neither.
 */
export function initRecord(path, { request, orca, because = '', repo = '', host = hostname(), now = () => new Date().toISOString() }) {
  const rec = { request, host, orca, createdAt: now(), attempts: [{ n: 1, settled: false, phases: [] }] };
  if (String(because).trim() !== '') rec.because = because;
  if (String(repo).trim() !== '') rec.repo = repo;
  save(rec, path);
}

/**
 * Write-ahead: the argv and the identity land on disk BEFORE the mutation is
 * issued. That ordering is the whole recovery property — a mutation that never
 * returns is still replayable byte for byte.
 *
 * `beganAt` is when THIS mutation was issued, and it is additive on purpose: the
 * record's `createdAt` is when the request was claimed, which a `--resume` or a
 * `--replace` leaves hours behind the dispatch it produced. `release` dates a
 * comment against the dispatch, so it needs the phase's own time; a record
 * written before this field existed falls back to `createdAt`.
 *
 * `grounds` is additive the same way (KTD4): the merge namespace records WHAT
 * its mutation stood on — the per-ground verdict lines of the gate run that
 * authorised it. Omitted when null; no reader branches on it.
 */
export function phaseBegin(path, { name, identity, argv, receiptPath = null, grounds = null, now = () => new Date().toISOString() }) {
  const rec = load(path);
  const phase = { name, identity, argv, receiptPath, receipt: null, exit: null, beganAt: now() };
  if (grounds !== null) phase.grounds = grounds;
  must(lastAttempt(rec), 'phases', 'last attempt').push(phase);
  save(rec, path);
}

/**
 * Close a phase with its exit code and its receipt text. An unparseable receipt
 * is STORED as `{ unparseable, error }`, never dropped: F-004 is the one time a
 * formatter ate the only diagnostic that mattered.
 *
 * `error` is the TRANSPORT failure — a spawn that never ran, a call killed on
 * timeout. It is recorded separately from the receipt because it answers a
 * different question: not "what did Orca refuse?" but "did Orca ever hear the
 * mutation?". A timeout on `worker-start` may well have committed it, so this
 * detail is what keeps the outcome named `unknown` instead of `failed`.
 */
export function phaseEnd(path, index, { exit, receiptText, stderr = '', error = null }) {
  const rec = load(path);
  const ph = phaseAt(rec, index);
  ph.exit = exit;
  ph.receipt = parseReceipt(receiptText);
  if (stderr && ph.receipt !== null && typeof ph.receipt === 'object') {
    ph.receipt.stderr = String(stderr).slice(0, 4000);
  }
  // Set on a transport that never concluded — and CLEARED on one that did.
  // Measured 2026-08-23 (#59): a worker-start timed out (ETIMEDOUT recorded),
  // the resume replayed the argv and Orca answered in 196ms — but this field
  // survived the successful replay, `phaseVerdict` reads it FIRST, and the
  // verdict answered `unknown` forever: a refusal whose printed repair was the
  // same resume, circularly. The field answers "did Orca hear the LAST
  // execution", so a concluded call must erase the corpse of the one before.
  if (error) ph.transport = String(error.message ?? error).slice(0, 1000);
  else delete ph.transport;
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
 * The recorded exit status of one phase, or null when the call never reported
 * one. It is a SEPARATE question from `phaseVerdict`: a receipt can read `ok`
 * while the exit carries the outcome, and `worker-release` is exactly that shape
 * — retained, release_pending and already_released all exit 0, and only
 * `release_unknown` exits 1 (Orca 1.4.185). A verb whose domain puts a verdict
 * in the exit code must be able to read it back off the record.
 */
export const phaseExit = (path, index) => phaseAt(load(path), index).exit ?? null;

/**
 * The verdict on one phase. Four outcomes, and the two that must never be
 * confused with each other are named apart:
 *   - `mismatch` — Orca refusing a divergent reissue. A refusal, never a reason
 *     to mint a new identity: minting one is how the duplicate is born.
 *   - `unknown` — nobody knows. A transport that never concluded, an illegible
 *     receipt or a missing exit status leaves the mutation possibly COMMITTED,
 *     so it is not a rejection and must never be reported as one.
 */
export function phaseVerdict(path, index) {
  const ph = phaseAt(load(path), index);
  const receipt = ph.receipt ?? {};
  if (ph.transport) return { verdict: 'unknown', evidence: `the Orca call never concluded: ${ph.transport}` };
  if (ph.receipt === null || ph.receipt === undefined) return { verdict: 'unknown', evidence: 'this phase recorded no receipt at all' };
  if (receipt.unparseable !== undefined) {
    return { verdict: 'unknown', evidence: `Orca answered no legible receipt: ${String(receipt.unparseable).slice(0, 300)}` };
  }
  if (ph.exit === null || ph.exit === undefined) return { verdict: 'unknown', evidence: 'this phase recorded no exit status' };
  if (receipt.ok !== true && receipt.ok !== false) {
    return { verdict: 'unknown', evidence: `Orca answered a receipt with malformed "ok": ${JSON.stringify(receipt.ok)}` };
  }
  const error = receipt.error ?? {};
  if (error.code === 'request_mismatch') return { verdict: 'mismatch', evidence: error.message ?? '' };
  if (receipt.ok === false) {
    return { verdict: 'failed', evidence: Object.keys(error).length > 0 ? error : JSON.stringify(receipt).slice(0, 400) };
  }
  const result = receipt.result;
  if (result === null || typeof result !== 'object') {
    return { verdict: 'unknown', evidence: 'Orca answered ok:true without an object result' };
  }
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
 * `usable` is a conjunction ON PURPOSE, and every term is one way a dispatch
 * has actually come back half-made: exit 0 alone is only a receipt; `ready`
 * without a `dispatchId` names nothing the caller can address later; and a
 * dispatch with no agent pane is a worker no operator and no tail can read.
 * Reads here are lenient — a stranded receipt has no `result` to demand.
 */
export function report(path) {
  const rec = load(path);
  const ph = phaseAt(rec, 'last');
  const receipt = ph.receipt ?? {};
  const result = receipt.result !== null && typeof receipt.result === 'object' ? receipt.result : {};
  const terminal = agentTerminal(result);
  // Bash-era `record.py` called exit-0 + ready USABLE before Orca returned
  // terminal roles/effects. Its non-null receiptPath is the persisted version
  // marker; new in-memory phases use null and must name the agent pane.
  const legacyUsable = typeof ph.receiptPath === 'string' && ph.receiptPath !== '';
  return {
    mode: (result.mutation ?? {}).replayed ? 'REPLAYED' : 'RAN',
    usable: receipt.ok === true
      && ph.exit === 0
      && result.state === 'ready'
      && Boolean(result.dispatchId)
      && (terminal !== null || legacyUsable),
    summary: {
      dispatchId: result.dispatchId,
      stage: result.stage,
      state: result.state,
      // Named, because ONE failure is not a half-made dispatch: a held composer
      // (`agent_prompt_stalled`) leaves the worktree, the pane and the agent all
      // in place, and its caller owns a repair for exactly that. A summary that
      // cannot tell it from a stranded mutation forces the generic recovery,
      // which replays the same held pane and refuses it again.
      lastError: result.lastError,
      terminal,
      effects: result.effects ?? [],
      residualResources: result.residualResources ?? [],
    },
    // The question lifecycle, or null when this pass never asked. NAMED, because
    // an absent ask and an ask whose outcome was never written are different
    // facts and route differently — see askBegin below.
    ask: rec.ask ?? null,
  };
}

/**
 * The write-ahead intent for one question, and then its outcome.
 *
 * WHY THIS IS ON THE RECORD (ofmchat #87, 2026-08-27). `ax triage ask` minted a
 * real question, printed its id only on the timeout branch, and persisted
 * nothing. `ax triage status`, reading the pane mailbox alone, then answered
 * "this pane has no pending question — it never asked through `ax triage ask`"
 * about a question `--resume` proved was pending. The child believed status,
 * reported, and settled a pass it had been told not to settle. Whatever mints a
 * live identity has to leave it where every other surface already looks.
 *
 * WHY BEFORE THE MUTATION, not after it. Same rule as every other phase here
 * (F-001): a mutation is issued from a record written first, so a process that
 * dies mid-flight leaves a state a reader can act on. `asking` is exactly that
 * state — ISSUED, OUTCOME UNKNOWN — and it must never be read as "no question
 * exists", which is the failure this whole lifecycle was added to end.
 *
 * States: `asking` → `pending` (outlived the wait, id known) | `answered` |
 * `refused`; then `replying` → `answered` once an orchestrator rules it, written
 * by ../triage/answer.mjs so a successful reply cannot leave a durable `pending`
 * lying to the next reader.
 */
export function askBegin(path, { request, sha, argv, now = () => new Date().toISOString() }) {
  const rec = load(path);
  // A rerun after a crash, or beside a live question, must NOT mint a second
  // one: `asking` means issued-outcome-unknown and `pending`/`replying` mean a
  // question is open on the parent's mailbox. Overwriting any of them would put
  // two questions on one draft, and a ruling keyed by number could then reach
  // either. Only an absent lifecycle or a proven terminal one may begin again.
  const prior = rec.ask ?? null;
  if (prior !== null && (prior.state === 'asking' || prior.state === 'pending' || prior.state === 'replying')) {
    return { ok: false, state: prior.state, messageId: prior.messageId ?? null, at: prior.at ?? null };
  }
  rec.ask = { state: 'asking', request, sha, argv, at: now() };
  save(rec, path);
  return { ok: true, state: 'asking', messageId: null, at: null };
}

/**
 * Every record in `store` whose ask lifecycle carries this `messageId`.
 *
 * `ax triage ask --resume <id>` is the PRESCRIBED recovery after a timeout, and
 * it carries no issue, job or pass — so the pass it belongs to can only be
 * recovered from the id itself. Without this the ordinary post-timeout path
 * settled nothing and the record stayed `pending` forever (PR #19): status kept
 * advertising an answered question, and the pass's next question was refused as
 * a duplicate. The lifecycle only advanced on the path nobody takes.
 *
 * Returns EVERY match, never a pick. Two records claiming one id is an anomaly a
 * caller must surface rather than resolve by guessing (F-028), and an unreadable
 * record is counted rather than skipped silently.
 */
export function recordsForAsk(store, messageId) {
  if (typeof messageId !== 'string' || messageId === '') return { paths: [], unreadable: [] };
  let names;
  try {
    names = readdirSync(store).filter(name => name.endsWith('.json'));
  } catch {
    return { paths: [], unreadable: [] };
  }
  const paths = [];
  const unreadable = [];
  for (const name of names) {
    const path = join(store, name);
    try {
      if (load(path).ask?.messageId === messageId) paths.push(path);
    } catch (error) {
      unreadable.push(`${name} (${String(error.message ?? error)})`);
    }
  }
  return { paths, unreadable };
}

/**
 * The write-ahead intent for a RULING, recorded before the reply is issued.
 *
 * Create-or-transition, and the difference from `askSettle` is deliberate: a
 * record whose `ask` field is simply absent is the ordinary shape of a question
 * minted by a version that predates this lifecycle, and refusing to answer it
 * would strand a live child over a bookkeeping gap. What is NOT tolerated is a
 * record this process cannot read or write at all — `load`/`save` raise, and the
 * caller must refuse before issuing anything (F-001).
 *
 * `at` is preserved when it exists, because when the question was asked and when
 * it was ruled are two different facts and a reader needs both.
 */
export function replyBegin(path, { messageId, now = () => new Date().toISOString() }) {
  const rec = load(path);
  const prior = rec.ask ?? null;
  rec.ask = {
    ...(prior ?? {}),
    state: 'replying',
    messageId,
    at: prior?.at ?? now(),
    repliedAt: now(),
    settledAt: null,
  };
  save(rec, path);
}

/**
 * Move an EXISTING lifecycle to its next state. Strict on absence: settling
 * something that was never begun would mint the very half-state this exists to
 * remove, so it raises instead of creating one (F-028).
 */
export function askSettle(path, { state, messageId = null, code = null, now = () => new Date().toISOString() }) {
  const rec = load(path);
  const prior = must(rec, 'ask', `${path} has no ask to settle`);
  rec.ask = { ...prior, state, messageId, code, settledAt: now() };
  save(rec, path);
}

/**
 * Record that a held composer was REPAIRED: the brief was submitted and a
 * watcher armed, so a child is running behind a Dispatch that already settled
 * `failed` and will never settle again.
 *
 * PERSISTED, never inferred from the receipt. The receipt shape only says the
 * dispatch was repairABLE — with `ORCA_DISPATCH_AUTOSUBMIT=0`, an unreachable
 * pane, or an older ax, the same receipt describes a brief still sitting unsent
 * and no child at all. Whether the Enter was actually sent is a fact about what
 * a process DID, and `stall.mjs` decides on it whether to narrate that child's
 * death: guessing would either bury a live child or silence a real corpse.
 */
export function markHeldRepair(path, { now = () => new Date().toISOString() } = {}) {
  const rec = load(path);
  rec.heldRepairAt = now();
  save(rec, path);
}

/**
 * Did a held composer get repaired for this record? Lenient: an unreadable
 * record has no marker, and the caller reading this is a fail-open watcher.
 */
export function heldRepaired(path) {
  try {
    return typeof load(path).heldRepairAt === 'string';
  } catch {
    return false;
  }
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

/**
 * The pane created by the newest worker-start phase. Autosubmit must address
 * that exact pane, including its execution environment when the child is remote.
 */
export function workerPane(path) {
  const phase = lastWorkerStart(load(path));
  return {
    handle: terminalEffect(workerStartResult(phase), 'worker-start receipt names no terminal'),
    env: argvValue(must(phase, 'argv', 'worker-start phase'), '--on') ?? '',
  };
}

/**
 * The newest `worker-start` phase's argv, whole and unmodified. The one read a
 * `--replace` derives its placement from (#11, trap 1): the record wrote where
 * the child went BEFORE the dispatch, so it is the authority, and a
 * replacement that re-derives placement from anything else can move a
 * PR-owning child into another checkout. Strict — a record with no
 * `worker-start`, or one whose phase names no argv, THROWS rather than
 * answering an empty placement that would read as "place it anywhere".
 */
export const workerStartArgv = path => [...must(lastWorkerStart(load(path)), 'argv', 'worker-start phase')];

/**
 * WHERE the newest worker-start sent the child: the host named by `--on`, or
 * `''` for this machine. Read from the phase's argv alone, so it answers for a
 * start whose receipt failed or names no terminal — the shape `settle` judges.
 *
 * This is the fact `worker-list` never carries (#160): a settle that judged a
 * pane without it read every absence as "maybe on a host I did not ask", and
 * on a Mac that always omits one paired remote that refused every local corpse
 * forever. The record wrote the host before the dispatch; it is the authority.
 */
export function dispatchHost(path) {
  return argvValue(workerStartArgv(path), '--on') ?? '';
}

/**
 * The brief this record dispatched — the `task-create --spec` text, byte for
 * byte, found NEWEST-PHASE-FIRST across the whole record.
 *
 * NOT worker-start's `--task`: that flag carries the task ID (`task_…`), and a
 * repair that confused the two would inject an id into a child's composer. The
 * whole-record scan matters for the same reason `recordedRun`'s does: a
 * replacement worker-start reuses the task, so its `task-create` — and the only
 * copy of the spec — lives in an older attempt.
 *
 * This exists for the composer-empty repair: a replay can create the terminal
 * and the agent and still deliver NO input at all (measured 2026-08-23 on #59
 * pass 1 — pane alive, agent at its banner, composer empty). The record is the
 * only source that can re-deliver the exact brief without recomposing it, and
 * recomposition is the F-001 hazard this whole file exists to prevent.
 */
export function workerSpec(path) {
  for (const candidate of allPhases(load(path)).reverse()) {
    if (candidate.name !== 'task-create') continue;
    const spec = argvValue(must(candidate, 'argv', 'task-create phase'), '--spec');
    if (typeof spec === 'string' && spec !== '') return spec;
  }
  throw new Error('no task-create phase carries a --spec text');
}

/**
 * The Run this record belongs to, recovered NEWEST-PHASE-FIRST across the
 * complete record.
 *
 * A replacement `worker-start` deliberately carries no `--run` (the task
 * already binds it), so the only place the Run survives is an older phase's
 * argv. Strict on purpose: every reader of this — the watcher, and the live
 * gate, whose `task-list` read is Run-scoped — answers "cannot establish" when
 * the Run is unknown, and must never quietly ask an unscoped question instead.
 */
export function recordedRun(path) {
  for (const candidate of allPhases(load(path)).reverse()) {
    const run = argvValue(must(candidate, 'argv', 'phase'), '--run');
    if (run) return run;
  }
  throw new Error('no phase argv carries --run');
}

/**
 * The binary this record was written through — argv[0] of the newest phase,
 * else the `orca` field written at init.
 *
 * A recovery must re-probe and re-watch through the SAME runtime it mutated:
 * on a host with both `orca` and `orca-ide` (see orca-bin.mjs) a freshly
 * resolved binary can be a different runtime, and the pane recorded here does
 * not exist in it.
 */
export function recordedBin(path) {
  const rec = load(path);
  for (const candidate of allPhases(rec).reverse()) {
    const argv = must(candidate, 'argv', 'phase');
    if (argv.length > 0) return argv[0];
  }
  return must(rec, 'orca', 'record root');
}

/**
 * Everything the detached watcher needs, extracted once from the write-ahead
 * record.
 */
export function dispatchFields(path) {
  const rec = load(path);
  const phase = lastWorkerStart(rec);
  const result = workerStartResult(phase);
  const dispatchId = result.dispatchId;
  if (!dispatchId) throw new Error('worker-start receipt has no dispatchId');
  const handle = terminalEffect(result, 'worker-start receipt has no terminal effect');

  return {
    dispatchId,
    handle,
    run: recordedRun(path),
    env: argvValue(must(phase, 'argv', 'worker-start phase'), '--on') ?? '',
  };
}

/**
 * The whole store, indexed by the dispatch id each record produced.
 *
 * The store is the ONE place that knows what a dispatch was FOR: Orca's own
 * inventory carries ids, states and handles, and no notion of the request that
 * asked for them. `release` needs that provenance twice over — to decide which
 * proof applies to a pane (a triage owes a comment, an implementation owes a
 * merged PR), and to date that proof against the moment the dispatch was issued.
 *
 * Because that provenance decides whether a pane may be CLOSED, it is read
 * strictly (F-028) and never inferred:
 *   - the record must NAME its request, and the name must agree with the file it
 *     lives in. A stem substituted for an absent `request` would let any
 *     filename decide which proof rule applies to a live pane.
 *   - only a `worker-start` phase may name a dispatch. Every other phase that
 *     happens to carry a `dispatchId` is display metadata.
 *   - one dispatch produced by two DIFFERENT requests is ambiguous, and
 *     ambiguity is cannot-establish, never last-file-wins (F-001).
 *   - a `worker-start` must carry the argv it issued, because `env` is the host
 *     that argv NAMED (`''` for local). A phase naming no argv is unreadable —
 *     named, indexed nowhere — never a local pane (#130).
 *
 * `issuedAt` is when the mutation was ISSUED — the newest `worker-start` phase's
 * own `beganAt`, falling back to the record's `createdAt` for records written
 * before that field existed. Never the file's mtime: a `--resume` rewrites the
 * file, which would push its mtime past the artifact the dispatch produced and
 * turn a proven session into a permanent KEEP. And never `createdAt` alone when
 * a phase timestamp exists: a record claimed at 10:00 whose worker-start ran at
 * 11:00 would accept a 10:30 comment as "after the dispatch".
 *
 * `repo` is the repository the record NAMES, trimmed, or `''` when it names
 * none — the same reading `recordRepo` gives by path, on the entry a bulk
 * reader already holds. `ax worker release` scopes its sweep by it (#83): the
 * store is host-global, so a row is placed by the repository its record names
 * and never by the path its worktree happens to sit at. An absent key is
 * UNKNOWN, not ours and not foreign (F-028), which is why it is surfaced as the
 * empty name rather than defaulted.
 *
 * Reading is lenient PER FILE and never silent: one unreadable record is named
 * in `unreadable` and the scan continues, because a store this verb cannot fully
 * parse still knows about the other dispatches — but a caller that concludes "no
 * provenance" must be able to say whether it looked.
 */
export function dispatchIndex(store) {
  const byDispatch = new Map();
  const unreadable = [];
  const ambiguous = new Set();
  let files;
  try {
    files = readdirSync(store, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    return { byDispatch, unreadable, ambiguous, missing: error.code === 'ENOENT', reason: String(error) };
  }

  for (const file of files) {
    let rec;
    try {
      rec = load(join(store, file));
    } catch (error) {
      unreadable.push({ file, error: String(error) });
      continue;
    }
    const stem = file.slice(0, -'.json'.length);
    if (rec.request !== stem) {
      unreadable.push({ file, error: `record names request ${JSON.stringify(rec.request)}, which is not ${stem}` });
      continue;
    }
    const recorded = typeof rec.repo === 'string' ? rec.repo.trim() : '';
    const created = Date.parse(rec.createdAt ?? '');
    const attempts = Array.isArray(rec.attempts) ? rec.attempts : [];
    const starts = attempts.flatMap(attempt => (Array.isArray(attempt.phases) ? attempt.phases : []).filter(ph => {
      if (ph?.name !== 'worker-start') return false;
      const result = ph.receipt?.result;
      return result !== null && typeof result === 'object' && typeof result.dispatchId === 'string' && result.dispatchId !== '';
    }));

    // `env` is the host the phase NAMED, `''` for local — and a phase that
    // recorded no argv named nothing. Read as `''` it was a local pane that
    // the local list does not know, i.e. MORT, and it left every count: the
    // under-count F-028 forbids (#130). Every phase is written ahead with the
    // argv it issues (0 of 252 lacked one on this host, 2026-09-03), so the
    // shape only arrives hand-edited or foreign-written, and it joins the
    // record that does not name itself: unreadable, named, indexed nowhere —
    // so every reader treats the handle as a missing record.
    //
    // THE WHOLE RECORD, not the phase (review of #131): a record whose older
    // worker-start reads and whose newer one does not would keep only the
    // stale row, and a reader finding that pane MORT would publish over the
    // replacement child the unindexed phase opened. Partial provenance is none.
    const unnamed = starts.find(ph => !Array.isArray(ph.argv));
    if (unnamed !== undefined) {
      unreadable.push({ file, error: `worker-start ${unnamed.receipt.result.dispatchId} recorded no argv, so its placement cannot be read` });
      continue;
    }

    for (const attempt of attempts) {
      for (const ph of Array.isArray(attempt.phases) ? attempt.phases : []) {
        if (ph?.name !== 'worker-start') continue;
        const result = ph.receipt?.result;
        if (result === null || typeof result !== 'object') continue;
        if (typeof result.dispatchId !== 'string' || result.dispatchId === '') continue;

        const known = byDispatch.get(result.dispatchId);
        if (known !== undefined && known.request !== stem) {
          ambiguous.add(result.dispatchId);
          byDispatch.delete(result.dispatchId);
          continue;
        }
        if (ambiguous.has(result.dispatchId)) continue;

        const began = Date.parse(ph.beganAt ?? '');
        // Newest phase wins: a `--replace` records a second worker-start for the
        // same request, and the pane that matters is the one it opened.
        //
        // `env` is PHASE-PAIRED with the handle, from this call's own `--on`,
        // because only the phase that named a handle can say where that handle
        // lives. Taking the handle from one dispatch and the runtime from the
        // record's newest worker-start would read one child's pane against
        // another's runtime. (A `--replace` no longer moves a child between
        // hosts — it inherits the recorded placement, #11 — but a record can
        // still hold phases dispatched onto different hosts.)
        byDispatch.set(result.dispatchId, {
          request: stem,
          issuedAt: Number.isFinite(began) ? began : Number.isFinite(created) ? created : null,
          file,
          repo: recorded,
          handle: agentTerminal(result),
          env: argvValue(ph.argv, '--on') ?? '',
          ready: ph.exit === 0 && ph.receipt.ok === true && result.state === 'ready',
        });
      }
    }
  }

  return { byDispatch, unreadable, ambiguous, missing: false, reason: '' };
}

/**
 * "Which Run dispatched the session sitting in THIS pane?" — or the named
 * inability.
 *
 * WHY IT EXISTS. A finished child reports UPWARD, and `omp/peer/lineage.ts`
 * resolves that direction through Orca's lineage, which is worktree-level:
 * `parentWorktreeId` names the parent WORKTREE and nothing inside it. A parent
 * running one pane is unambiguous; a parent running three is not, so the report
 * refused. Measured 2026-08-30 on ofmchat PRD 2, twice in one night (#117
 * ctx_0c5dacb47230, #113 ctx_812f22b13b19): the primary checkout hosted the
 * orchestrator beside two readiness sessions, which is the ORDINARY shape of a
 * wave night, and both children had to re-deliver by hand.
 *
 * The discriminator Orca has no field for is already on this machine, written by
 * the dispatching session BEFORE it issued the dispatch: the record pairs the
 * child's pane with its own `--run`. So the child needs to hold nothing but its
 * own pane handle — no capability, no dispatch id, no cooperation from a
 * runtime whose lineage stops at the worktree.
 *
 * The record is authority here for the same reason it is everywhere else: it was
 * written ahead of the mutation, by the only party that knew both halves. It is
 * read strictly — an absence, an unreadable store and a reused pane are three
 * different inabilities and each is named (F-028), because the caller's fallback
 * is a sentence a woken human reads. Never last-file-wins: a guess here delivers
 * a completion to a session that dispatched different work.
 *
 * HOST-LOCAL BY CONSTRUCTION. The store lives under this machine's HOME, so a
 * child on another host resolves nothing and must not: that case has its own
 * channel (the board card, see ../worker/brief.mjs).
 */
export function dispatcherRunForPane(store, handle) {
  if (typeof handle !== 'string' || handle === '') {
    return { reason: 'this session has no pane handle, so no dispatch record can be matched to it' };
  }
  const index = dispatchIndex(store);
  // EVERY refusal names the pane. The caller's fallback is a sentence the child
  // says out loud on another channel, and "I am term_x and my dispatcher is
  // unknown" is answerable by a human; "no dispatcher could be looked up" is not.
  if (index.missing) return { reason: `the dispatch store ${store} does not exist, so the dispatcher of pane ${handle} could not be looked up` };
  if (index.reason !== '') return { reason: `the dispatch store ${store} could not be read, so the dispatcher of pane ${handle} is unknown: ${index.reason}` };

  const named = [...index.byDispatch.values()].filter(entry => entry.handle === handle);
  const requests = [...new Set(named.map(entry => entry.request))];
  if (requests.length === 0) {
    const looked = index.unreadable.length > 0 ? ` (${index.unreadable.length} record(s) there are unreadable)` : '';
    return { reason: `no dispatch record names pane ${handle}${looked}` };
  }
  if (requests.length > 1) {
    return { reason: `two dispatch records name pane ${handle} (${requests.join(', ')}), so which session dispatched it cannot be established` };
  }

  const request = requests[0];
  try {
    return { run: recordedRun(join(store, `${request}.json`)) };
  } catch (error) {
    return { reason: `the dispatch record ${request} names pane ${handle} but carries no Run: ${String(error.message ?? error)}` };
  }
}

/**
 * Every pane handle recorded against each request, from a `dispatchIndex`.
 *
 * A request can hold more than one: a `--replace` records a second worker-start,
 * and both panes are worth probing before anything concludes the request is
 * finished. Two callers need this — `dispatch --fresh` before it opens a rival
 * pass, and `publish --pass` before it lands a verdict under a newer one — and a
 * second copy of the traversal is how the two would come to disagree.
 *
 * An EMPTY set is not proof of no pane. Rows here exist only where a parseable
 * `worker-start` receipt named a dispatch id, so a stranded record maps nothing
 * at all. Callers must route that absence through `paneVerdict`'s third value
 * rather than reading it as a death (F-028).
 */
export function handlesByRequest(index) {
  const byRequest = new Map();
  for (const row of index.byDispatch.values()) {
    if (row.handle === null) continue;
    if (!byRequest.has(row.request)) byRequest.set(row.request, new Set());
    byRequest.get(row.request).add(row.handle);
  }
  return byRequest;
}

/** F-003: a clean exit is not enough; Orca must read back the ready state. */
export const taskUpdateOk = receipt => receipt?.ok === true && receipt?.result?.task?.status === 'ready';

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
 * operator's own legitimate relaunch permanently. So a foreign record CAN be
 * set aside — but only when it is proved to hold nothing, and the proof is
 * deliberately harsh, because the cost of being wrong is F-001 itself: a
 * second identity minted over a mutation that is still in flight.
 *
 * Reclaimable requires ALL of:
 *   - at least one phase, and every phase CLOSED (an exit and a receipt);
 *   - every phase a conclusive `ok: false` refusal — an illegible receipt or a
 *     transport that never concluded is an UNKNOWN outcome, not a refusal, and
 *     a success (with or without a task id) may name a live agent;
 *   - no refused phase reporting effects or residual resources — a refusal that
 *     still created something is a mutation, whatever it calls itself;
 *   - a recorded Run, and one that is not the caller's (a caller's own Run is
 *     replayable from here, which is always better than a takeover).
 *
 * Anything else is precious: the reason says why, and the caller replays it.
 */
export function staleClaim(path, callerRun) {
  const rec = load(path);
  const attempts = must(rec, 'attempts', 'record root');
  const phases = attempts.flatMap(attempt => must(attempt, 'phases', 'attempt'));
  if (phases.length === 0) return { stale: false, reason: 'record has no phase yet — its first mutation may be in flight' };

  for (const ph of phases) {
    const receipt = ph.receipt;
    if (ph.exit === null || ph.exit === undefined || receipt === null || receipt === undefined) {
      return { stale: false, reason: `phase "${ph.name}" is still open — its mutation may be in flight` };
    }
    if (typeof receipt !== 'object' || receipt.unparseable !== undefined || ph.transport) {
      return { stale: false, reason: `phase "${ph.name}" ended with an unknown outcome — it may have committed` };
    }
    if (receipt.ok !== false) {
      const tid = taskIdOf(receipt.result ?? {});
      return {
        stale: false,
        reason: tid
          ? `record carries a task id (${tid}) — it may name a real mutation`
          : `phase "${ph.name}" succeeded — it may name a real mutation`,
      };
    }
    const result = receipt.result ?? {};
    if ((result.effects ?? []).length > 0 || (result.residualResources ?? []).length > 0) {
      return { stale: false, reason: `refused phase "${ph.name}" still reports resources — they may exist` };
    }
  }

  let recorded = '';
  for (const ph of phases) {
    recorded = argvValue(ph.argv ?? [], '--run') ?? '';
    if (recorded) break;
  }
  if (!recorded) return { stale: false, reason: 'record names no Run — being foreign cannot be proven' };
  if (recorded === callerRun) return { stale: false, reason: `record names this caller's own Run ${recorded} — replay it` };
  return { stale: true, foreignRun: recorded };
}

/**
 * The repository a record NAMES, trimmed — `''` when it names none.
 *
 * F-028, and the whole scope rule of `ax worker settle`: this store is
 * HOST-GLOBAL, so a record naming another repository is another checkout's
 * business, and one naming NOTHING is unknown rather than local. `repo` is
 * additive (see initRecord), so every record written before `--tracker-repo`
 * existed carries none — reading that absence as "this repository" would let
 * any checkout flip a frontier classification for all of them at once.
 */
export function recordRepo(path) {
  const repo = load(path).repo;
  return typeof repo === 'string' ? repo.trim() : '';
}

/**
 * The same field, read by the caller that WRITES it — and that caller needs a
 * third answer `recordRepo` cannot give.
 *
 *   named      a non-empty string: this record's owner is not in doubt
 *   none       the key absent, `null`, or blank — the pre-0.20 shape (#146)
 *   malformed  present and not a name: an object, a list, a number
 *
 * `recordRepo` collapses `malformed` into `''`, which is correct for a reader
 * asking only "which repository" — the answer is "none it can name". A writer
 * inheriting that collapse would overwrite corrupted metadata while reporting
 * success, so the distinction is made here rather than by widening the reader
 * every other caller depends on (review of PR #155, P1). `null` is NOT in that
 * class: it is how a record written before `--tracker-repo` spells the absence
 * `ax worker settle --repo` exists to fill.
 */
export function recordRepoNaming(path) {
  const repo = load(path).repo;
  if (repo === undefined || repo === null) return { state: 'none', repo: '' };
  if (typeof repo !== 'string') {
    return { state: 'malformed', repo: '', detail: `\`repo\` is ${Array.isArray(repo) ? 'a list' : typeof repo}, not a repository name` };
  }
  return repo.trim() === '' ? { state: 'none', repo: '' } : { state: 'named', repo: repo.trim() };
}

/**
 * The last attempt's settlement state, and whether anything in it is still open.
 *
 * `openPhase` is `staleClaim`'s first test isolated for the caller that must
 * REFUSE rather than reclaim: a phase with no exit and no receipt is a mutation
 * that may have committed, and writing `settled: true` over one is F-001 by
 * another road. `phases` carries the same doubt with nothing to name — a record
 * with no phase at all has its first mutation possibly in flight.
 */
export function lastAttemptState(path) {
  const attempt = lastAttempt(load(path));
  const phases = must(attempt, 'phases', 'last attempt');
  const settled = must(attempt, 'settled', 'last attempt');
  if (typeof settled !== 'boolean') throw new Error("last attempt: 'settled' is not a boolean");
  const open = phases.find(ph => ph === null || typeof ph !== 'object' || ph.exit === null || ph.exit === undefined || ph.receipt === null || ph.receipt === undefined);
  return { settled, phases: phases.length, openPhase: open === undefined ? null : String(open.name ?? 'unnamed') };
}

/**
 * Close the last attempt WITHOUT opening another — the release verb's
 * settlement gesture. Until this existed, `settled: true` was written only by
 * `attemptNew`, so a released-but-unmerged dispatch read as a live attempt
 * forever and the frontier's `attempt-ended-unmerged` state was unreachable
 * (validated review finding, 2026-09-01). Idempotent: settling a settled
 * attempt changes nothing.
 *
 * `repo` BACKFILLS the repository name on a record that carries none (#146,
 * finding #133) — every record written before `--tracker-repo` existed. It
 * rides this one function rather than a writer of its own because the two
 * writes must be ONE: a `repo` landing without the flag would scope a record
 * that is still unsettled, and a flag landing without the `repo` would settle a
 * record the frontier still reads in every repository on the host. The caller
 * (./settle.mjs) is what establishes that the name is true — this is the
 * invariant guard behind it, and a record whose `repo` is anything but an
 * absence (a name, or a value that is not a name at all) throws rather than
 * being overwritten: the guard reads through `recordRepoNaming`, so the writer
 * and the verb that authorises it cannot disagree about what "carries none"
 * means.
 */
export function attemptSettle(path, { repo = '' } = {}) {
  const rec = load(path);
  const attempts = must(rec, 'attempts', 'record root');
  const backfill = String(repo).trim();
  if (backfill !== '') {
    const naming = recordRepoNaming(path);
    if (naming.state === 'named') throw new Error(`record already names ${naming.repo}: a backfill writes a repository, it never re-attributes one`);
    if (naming.state === 'malformed') throw new Error(`${naming.detail}: a backfill fills an absence, it never overwrites a value it cannot read`);
    rec.repo = backfill;
  }
  attempts[attempts.length - 1].settled = true;
  save(rec, path);
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
