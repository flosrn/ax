#!/usr/bin/env node
// Detached, fail-open supervision for one recorded worker-start.
//
// This process is deliberately separate from start.mjs (ADR 0025): a broken
// watcher must never turn a successful dispatch into a refusal. It watches
// three independent signals: pane cursor movement for a one-shot silence alert,
// Orca's own `agentWait` verdict for a worker parked on a prompt (see
// `promptWait`), and deliberate worktree-card changes for remote children whose
// completion mail may not cross hosts.
//
// TWO WAYS IN, ONE LOOP. `watch` is the loop, and it runs only as this file's
// own process entry — the detached child `armStallWatcher` spawns. Every caller
// that wants a watcher (`worker start`, `worker repair`, and the `ax worker
// stall` verb an alert prints as its re-arm) goes through `armStallWatcher`, so
// none of them ever holds the loop in its own foreground.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets } from '../redact.mjs';
import { createRunner, resolveOrca } from '../orca-bin.mjs';
import { bad, fix, note, status } from '../log.mjs';
import { defaultStore, dispatchFields, heldRepaired, requestIdOk } from './record.mjs';
import { paneReadable, readPane, terminalInventory } from './pane.mjs';

const self = fileURLToPath(import.meta.url);
const watchDirOf = env => env.ORCA_STALL_DIR || join(env.HOME ?? '', '.omp', 'run', 'stall-watch');

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);
const nowDefault = () => Date.now() / 1000;

// A `failed` receipt is not a settle while the pane still reads: it describes
// the receipt, never the process — the same invariant gate.mjs measures.
const settledDispatch = new Set(['completed', 'canceled']);
const settledWorker = new Set(['succeeded', 'canceled', 'released']);

/** Env numbers must never poison the loop: malformed or Infinity falls back. */
function finiteOr(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parse(argv) {
  let request = '';
  let explicitOrca = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request' || arg === '--orca') {
      i += 1;
      if (argv[i] === undefined) return { error: `${arg} needs a value` };
      if (arg === '--request') request = argv[i];
      else explicitOrca = argv[i];
    } else if (arg.startsWith('--request=')) request = arg.slice('--request='.length);
    else if (arg.startsWith('--orca=')) explicitOrca = arg.slice('--orca='.length);
    else return { error: `unknown option ${arg}` };
  }
  return { request, explicitOrca };
}

function cannot(message) {
  bad(redactSecrets(`CANNOT ESTABLISH — ${message}`));
  fix('ax worker start --resume --request <same_request>   # recover the recorded dispatch first');
  return 3;
}

/**
 * A bug in whoever invoked this watcher — and the repair is the VERB, never a
 * path. `node src/worker/stall.mjs …` resolves in this checkout and in no
 * consumer, and the path an operator reaches for instead
 * (`node_modules/@flosrn/ax/…`) is a pnpm symlink the entry guard at the bottom
 * of this file did not recognise: the module loaded, armed nothing, printed
 * nothing, exited 0.
 */
function callerBug(message) {
  bad(redactSecrets(message));
  fix('ax worker stall --request <id> [--orca <bin>]');
  return 1;
}

/** Exact checkpoint-extension grammar. False means the card must wake the Run. */
export function progressOnly(comment) {
  const text = String(comment);
  if (text.includes('DECISION:')) return false;
  const segments = text.split(' · ');
  if (segments.length > 3 || !/^\d+\/\d+$/.test(segments[0])) return false;
  const [done, total] = segments[0].split('/');
  if (done === total && (segments.length === 1 || segments[1] === 'done')) return false;
  return true;
}

function workerProbe(run, dispatchId) {
  const out = run(['orchestration', 'worker-show', '--dispatch', dispatchId, '--json']);
  // `known: false` is the whole fail-open contract of this probe: an unreachable
  // runtime is not a dispatch that failed to settle, and no caller may read it
  // as one. Without it, `settled: false` makes an unreadable state
  // indistinguishable from a live one — which is how an unread probe becomes a
  // reported death.
  if (out.status !== 0 || out.receipt?.ok !== true) return { known: false, settled: false, failed: false, label: 'unknown', wait: undefined };
  const result = out.receipt.result ?? {};
  const dispatch = result.dispatch?.status;
  const worker = result.worker?.state;
  return {
    // A readable receipt whose state fields are ABSENT is still not knowledge
    // (F-028): an absent container is not an empty one.
    known: typeof dispatch === 'string' || typeof worker === 'string',
    settled: settledDispatch.has(dispatch) || settledWorker.has(worker),
    failed: dispatch === 'failed' || worker === 'failed',
    label: `dispatch=${dispatch ?? 'unknown'} worker=${worker ?? 'unknown'}`,
    wait: promptWait(result.observation),
  };
}

/**
 * Orca's own verdict that the worker is PARKED ON A PROMPT only a human can
 * answer: the wait, `null` when Orca looked and found none, `undefined` when
 * nobody knows.
 *
 * F6d (gapila wave, 2026-09-28, worker 2120): the pane sat on an interactive
 * selection window and the silence alert was the first thing to notice, 46
 * minutes in, still offering "hung, quiet or waiting" as indistinguishable.
 * They are not, on the receipt this loop already reads every tick:
 * `orca orchestration worker-show` carries `observation.agentWait`
 * (`src/main/runtime/rpc/methods/orchestration/worker/worker-observation.ts` at
 * Orca 867d38397893, federated workers included), the runtime's own reading of
 * the agent's hook, its prompt text or its title, gated on the exact worker
 * process. Cursor movement stays the only LIVENESS here; this is a named state,
 * read from its owner, never a scrape of the screen.
 *
 * THE ABSENCE RULE IS ORCA'S OWN, and F-028's: an absent field means Orca never
 * looked (older host, unverifiable identity, unreadable pane, slow probe) and
 * "never means the worker is not waiting". So `undefined` alerts nothing AND
 * ends nothing: only an explicit `null` closes a wait already announced, and
 * only an object naming its evidence opens one.
 */
function promptWait(observation) {
  if (!observation || typeof observation !== 'object' || !('agentWait' in observation)) return undefined;
  const wait = observation.agentWait;
  if (wait === null) return null;
  if (typeof wait !== 'object' || typeof wait.source !== 'string') return undefined;
  return {
    source: wait.source,
    reason: typeof wait.reason === 'string' ? wait.reason : '',
    since: Number.isFinite(wait.since) ? wait.since : null,
  };
}

/**
 * The pane, as two independent facts: has it MOVED, and is it still ALIVE.
 *
 * `exited` is not a refinement, it is the signal a dead pane actually sends.
 * Measured 2026-08-22 against a real closed remote pane: `terminal read`
 * answered `ok:true` with `status: "exited"` AND `latestCursor: "0"` — a
 * NUMBER. So a corpse reads exactly like a live pane that has not moved, and an
 * absent cursor is the wrong trigger for a death: it never arrives.
 */
function cursorProbe(run, handle, executionEnv) {
  const pane = readPane(run, handle, { environment: executionEnv, limit: 1 });
  if (!paneReadable(pane)) return { readable: false, cursor: null, exited: false };
  return { readable: true, cursor: pane.cursor, exited: pane.paneStatus === 'exited' };
}

/**
 * The worktree the watched pane sits in, for the card alert. Fail-open like the
 * rest of this file: an inventory that cannot be read is no worktree, never an
 * exception and never a guessed path.
 */
function worktreeFor(run, handle, executionEnv) {
  const inventory = terminalInventory(run, { environment: executionEnv });
  if (!inventory.ok) return '';
  return inventory.byHandle.get(handle)?.worktreePath ?? '';
}

/**
 * Is that pane PROVABLY gone from the runtime that owns it?
 *
 * Absence from the inventory is the only proof available, and it is only proof
 * when the inventory could account for every host. `terminalInventory` already
 * refuses a TRUNCATED list for that reason, and reports `omitted` for the other
 * half of it: a handle missing from a complete-looking list may simply live on a
 * host that call never asked (pane.mjs). Both are refused here.
 *
 * THE COST IS DELIBERATE. On a machine with a paired remote runtime the local
 * list omits it, so this answers `false` and the death below is never claimed —
 * the silence alert stays the only net in that configuration. A watcher that
 * reported a death it had not measured would be worse than a late one: it would
 * send an orchestrator to bury a worker that is still building.
 *
 * The shared verdict (`paneVerdict`, ./pane.mjs) can additionally prove a LOCAL
 * pane dead when the receipt's `hostIds` names `local` — the exception release
 * paid for. Adopting it here would change the paragraph above: that is a
 * contract change needing its own red test, never a by-product of a
 * consolidation.
 */
function paneGone(run, handle, executionEnv) {
  const inventory = terminalInventory(run, { environment: executionEnv });
  if (!inventory.ok || inventory.omitted) return false;
  return !inventory.byHandle.has(handle);
}

function cardProbe(run, worktreePath, executionEnv) {
  const args = ['worktree', 'ps'];
  if (executionEnv) args.push('--environment', executionEnv);
  args.push('--json');
  const out = run(args);
  if (out.status !== 0 || !Array.isArray(out.receipt?.result?.worktrees)) return '';
  const row = out.receipt.result.worktrees.find(candidate => candidate.path === worktreePath);
  if (!row) return '';
  const comment = String(row.comment ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return `${row.workspaceStatus ?? ''}\t${comment}`;
}

function sendOk(out) {
  return out.status === 0 && out.receipt?.ok === true;
}

/**
 * Orca refused the alert AS A LIFECYCLE MESSAGE, and that refusal is final for
 * this watcher — not because the watched worker is proven dead, but because
 * nothing about the next attempt can differ. The CLI turns
 * `lifecycle.action === 'rejected'` into a non-zero exit whose error carries
 * the lifecycle code, and each of the three codes is decided by facts this
 * process cannot change between ticks: `sender_not_assignee` (the SENDER —
 * the pane whose environment this watcher inherited, i.e. the orchestrator's
 * own — holds no active Dispatch, or no longer the one it held),
 * `task_dispatch_mismatch` (the payload names another task) and
 * `dispatch_capability_invalid` (the sender presents no valid capability, and
 * this watcher never presents one). Orca ALSO records the refused message on
 * the Run as a `status` carrying the original body, so the wake already
 * happened; a retry only repeats the rejection.
 *
 * Measured 2026-09-02 on the package's own checkout: two watchers on brief
 * dispatches that had settled `failed` alerted after the silence window, were
 * refused `sender_not_assignee`, and retried every tick for ten hours — six
 * hundred rejected escalations, each delivered to the orchestrator's pane and
 * each pre-empting the tool call it was in. Only a transport failure (the
 * runtime unreachable, no receipt at all) is worth the next tick, because only
 * that can change.
 *
 * That measurement condemned the ENVELOPE too, and #149 fixed that half: a
 * top-level orchestrator's pane never holds a Dispatch, so the `escalation` this
 * file used to send was refused by construction and the wake arrived as the
 * rejection rather than as the message (see WAKE_TYPE, now `status`). This
 * refusal set stays regardless of the envelope: Orca decides which sends it
 * lifecycle-validates and this file does not, so a code arriving on an envelope
 * believed exempt must still end the watch once rather than retry for ten hours.
 */
const LIFECYCLE_REFUSALS = new Set(['sender_not_assignee', 'task_dispatch_mismatch', 'dispatch_capability_invalid']);

const sendRefused = out => {
  const code = out.receipt?.ok === false ? String(out.receipt.error?.code ?? '') : '';
  return LIFECYCLE_REFUSALS.has(code) ? code : '';
};

const refusalLine = (alert, out) =>
  `Orca refused the ${alert} as a lifecycle message: ${sendRefused(out)} — ${String(out.receipt?.error?.message ?? '').trim() || 'no reason given'}. The body was recorded on the Run as a rejected status, and a retry can only repeat the refusal; exiting.`;

// THE DELIVERY FORM OF EVERY ALERT IN THIS FILE.
//
// Addressing was never the gap: every alert here already reaches the dispatching
// Run. Being ACCEPTED there was, and this constant is what the measurement
// decided.
//
// Measured 2026-09-02 (#109): this file sent `escalation`, a coordinator
// mutation whose sender must hold an active Dispatch. The watcher inherits the
// environment of the pane that DISPATCHED, and a top-level orchestrator's pane
// holds no Dispatch by construction — so every alert was refused
// `sender_not_assignee`, and the wake arrived as the REJECTION's `status`
// carrying the original body under `_orcaLifecycleRejection`. The rationale that
// stood here argued `escalation` from Orca's documented coordinator wait
// (`check --wait --types worker_done,escalation,question`) and from that filter
// deciding when a waiter wakes. It is measured wrong for this channel, and not
// because the filter does not exist: the waiter does not.
//
// THE RULING. An orchestrator dispatched through ax is an ax session, and this
// package's peer receiver owns the single consuming loop on that session's Run
// (`omp/peer/receive.ts`) — two consumers on one Run would race for the same
// delivery, so Orca's `check --wait --types …` loop is never the one running
// there. That receiver injects every directed message with `triggerTurn: true`,
// which wakes an idle session and steers a streaming one, whatever the type. So
// the type filter never governed this wake, and `status` — the envelope Orca
// accepts from a pane holding no Dispatch — is the one that arrives AS a message
// instead of as the rejection of one. `omp/peer/receive.test.ts` pins that
// injection for the two subject prefixes below, so a future type-aware delivery
// cannot demote the alert silently.
//
// The words of each alert are unchanged, and so are its subjects: `stall-watch:`
// and `card:` are read on the far side by `WATCHER_SUBJECT` in
// `omp/peer/attribution.ts`, which is also what exempts an alert arriving under
// the orchestrator's OWN handle from the receive loop's self-send drop — this
// process inherits the dispatching pane's environment and names no `--from`, so
// Orca resolves its sender to that pane (`./capability.mjs`).
//
// The PAYLOAD is the machine half: `{ watch: { alert, request, dispatchId } }`.
// The receiver looks the dispatch id up in its OWN write-ahead store to route an
// answer to the child a card is about — never to this process, which has exited
// by the time anyone reads the alert, and never to the Run it arrived on.
const WAKE_TYPE = 'status';

function wake(run, fields, request, alert, subject, body) {
  return run([
    'orchestration', 'send', '--to', `run:${fields.run}`, '--type', WAKE_TYPE,
    '--subject', redactSecrets(subject), '--body', redactSecrets(body),
    '--payload', JSON.stringify({ watch: { alert, request, dispatchId: fields.dispatchId } }),
    '--json',
  ]);
}

function alertStall(run, fields, request, silentSeconds, status, signal) {
  const terminalRepair = ['orca terminal read', '--terminal', fields.handle];
  if (fields.env) terminalRepair.push('--environment', fields.env);
  terminalRepair.push('--limit', '60', '--json');
  const minutes = Math.ceil(silentSeconds / 60);
  // WHICH SIGN went quiet, because the clock now counts two of them. Saying "no
  // new terminal line" while the silence was measured from a worktree card would
  // be a false sentence in an alert — the exact shape this file keeps writing
  // incident comments about. And naming the card tells the reader they have
  // already been sent it, so a second look costs nothing.
  const since = signal === 'card'
    ? 'Its last sign of life was a WORKTREE CARD change, which you were already sent — its pane has been quiet at least that long.'
    : 'Its pane cursor has not advanced in that time.';
  const body = [
    `Dispatch ${fields.dispatchId} for request ${request} has shown no sign of life for ${minutes} minute(s).`,
    since,
    `Current Orca view: ${status}.`,
    'Three explanations are indistinguishable here: the worker hung or was killed; it is in a legitimately quiet spinner phase; or it is waiting on the operator.',
    `Inspect: ${terminalRepair.join(' ')}`,
    `State: orca orchestration worker-show --dispatch ${fields.dispatchId} --json`,
    `Re-arm: ax worker stall --request ${request}`,
  ].join('\n');
  return wake(run, fields, request, 'silent', `stall-watch: dispatched worker '${request}' has gone silent`, body);
}

/**
 * The worker is not silent, it is ASKING — and Orca measured it.
 *
 * Not the silence alert: that one offers three explanations because it cannot
 * choose; this one names the third and the evidence for it. And not a failure
 * either — Orca's own contract says a waiting worker is healthy — so the watch
 * goes on after it, and the silence alert keeps its place as the backstop.
 */
function alertPrompt(run, fields, request, wait, status) {
  const inspect = ['orca terminal read', '--terminal', fields.handle];
  if (fields.env) inspect.push('--environment', fields.env);
  inspect.push('--limit', '60', '--json');
  const since = wait.since === null ? '' : ` since ${new Date(wait.since).toISOString()}`;
  const body = [
    `Dispatch ${fields.dispatchId} for request ${request} is parked on a prompt only a human can answer${since}.`,
    `Orca's evidence: ${wait.reason || 'interactive prompt'} (via ${wait.source}).`,
    `Current Orca view: ${status}.`,
    'It is waiting, not hung: nothing moves until that prompt is answered in its pane.',
    `Inspect: ${inspect.join(' ')}`,
    `State: orca orchestration worker-show --dispatch ${fields.dispatchId} --json`,
  ].join('\n');
  return wake(run, fields, request, 'prompt', `stall-watch: dispatched worker '${request}' is waiting on a prompt`, body);
}

/**
 * The one stop a child can never announce itself.
 *
 * A killed pane runs no in-process hook, so nothing inside that session reports
 * that it stopped before finishing. Measured 2026-08-22: `orca terminal close`
 * on a worker holding an unfinished todo settled the Dispatch
 * `termination_reason: operator_close` and produced NOT ONE message on the
 * orchestrator's Run. Silence there reads exactly like a worker still thinking,
 * which is the confusion this whole file exists to end — so the watcher, the
 * only party still alive, says it instead.
 *
 * Deliberately NOT the silence alert: that one offers three explanations because
 * it cannot choose between them. This one has measured the absence.
 */
function alertGone(run, fields, request, status) {
  const body = [
    `Dispatch ${fields.dispatchId} for request ${request} has NO PANE LEFT, and it never settled successfully.`,
    `Current Orca view: ${status}.`,
    'The process is gone, so no completion report will ever arrive: a killed pane runs no in-process hook.',
    'Whatever that worker did is on its branch and in its transcript, and nothing else will announce it.',
    `Transcript: ax worker transcript ${request}`,
    `State: orca orchestration worker-show --dispatch ${fields.dispatchId} --json`,
  ].join('\n');
  return wake(run, fields, request, 'gone', `stall-watch: dispatched worker '${request}' is GONE without reporting`, body);
}

function alertCard(run, fields, request, card, worktreePath) {
  const repair = ['orca worktree ps'];
  if (fields.env) repair.push('--environment', fields.env);
  repair.push('--json');
  const body = [
    card,
    '',
    `Remote worker '${request}' published a deliberate worktree checkpoint at ${worktreePath}.`,
    `Inspect: ${repair.join(' ')}`,
  ].join('\n');
  return wake(run, fields, request, 'card', `card: '${request}' published a checkpoint`, body);
}

/**
 * `kill(pid, 0)` answers two different failures, and only one of them is a
 * death: ESRCH is no such process, EPERM is a LIVE process this user may not
 * signal. Reading EPERM as dead would hand a live holder's claim away.
 */
function processAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Who holds a watcher pidfile, read-only: absent, unreadable, or a pid and whether it lives. */
function readHolder(path, processAlive) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? { absent: true } : { unreadable: true };
  }
  const holder = Number(text.trim());
  if (!(Number.isInteger(holder) && holder > 0)) return { unreadable: true };
  return { holder, stale: !processAlive(holder) };
}

/**
 * One watcher per request, and a PROVEN-DEAD holder holds nothing.
 *
 * A watcher removes its pidfile in a `finally`, which a SIGKILL, a reboot or a
 * caller's tool deadline never runs (#270: an agent's 60 s timeout killed the
 * foreground re-arm and left exactly this). Such a file used to refuse every
 * later re-arm "automatic takeover is refused — remove it only after verifying
 * no watcher survives", which asked the operator to measure by hand the one
 * fact this function measures: the holder pid is gone (ESRCH, see
 * `processAliveDefault`), and a watcher only ever runs under the pid it wrote.
 *
 * What that refusal really guarded was the RACE: two re-arms both read the same
 * dead pid, one replaces it, and the other then unlinks the winner's fresh
 * claim — two watchers. The takeover is therefore serialised by an O_EXCL
 * `<pidfile>.takeover` lock, and the pidfile is re-read under it: only a file
 * that still names the dead pid is replaced. A contender that finds the lock
 * stands down. A lock left by a taker that died inside that window is not
 * guessed at either — it is named, for a person to remove.
 */
function claimPid(path, pid, processAlive) {
  try {
    writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
    return { claimed: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const held = readHolder(path, processAlive);
  // Gone between the claim and the read: its holder just exited. Not ours to
  // retry — the next re-arm claims a free file.
  if (held.absent) return { claimed: false, unreadable: true };
  if (!held.stale) return { claimed: false, ...held };

  const lock = `${path}.takeover`;
  try {
    writeFileSync(lock, String(pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const taker = readHolder(lock, processAlive);
    return { claimed: false, contended: true, lock, taker: taker.holder ?? 0, interrupted: taker.stale === true };
  }
  try {
    if (readHolder(path, processAlive).holder === held.holder) rmSync(path, { force: true });
    try {
      writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
      return { claimed: true, tookOver: held.holder };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { claimed: false, ...readHolder(path, processAlive) };
    }
  } finally {
    rmSync(lock, { force: true });
  }
}

/** The one sentence for a claim this watcher does not hold. */
function heldBy(request, claim) {
  if (claim.contended && claim.interrupted) return `a takeover of the pidfile for ${request} was interrupted (dead pid ${claim.taker}); remove ${claim.lock} and re-arm.`;
  if (claim.contended) return `a takeover of the pidfile for ${request} is already in flight (pid ${claim.taker || 'unknown'}); not doubling it.`;
  if (claim.stale) return `pidfile for ${request} belongs to dead pid ${claim.holder} and could not be taken over; not doubling an unknown watcher.`;
  if (claim.holder) return `already armed for ${request} (pid ${claim.holder}); not doubling it.`;
  return `pidfile for ${request} is unreadable; not doubling an unknown watcher.`;
}

/**
 * Spawn the fail-open watcher as a separate process; the caller exits
 * immediately. FAIL-OPEN is the whole contract: a watcher that cannot be armed
 * says so and the dispatch stands — a supervisor must never be able to fail a
 * worker that is already running. There are three ways it can fail, and all
 * three end the same way: the module is absent, `spawn` throws synchronously,
 * or the child fails asynchronously (ENOENT on the interpreter arrives on the
 * 'error' event, after this function has returned — unhandled, it would take
 * the process down at a point where the mutation is already committed).
 *
 * Answers whether a child was spawned, for the one caller whose exit code is
 * the arming itself (`stall`, below); the dispatch callers ignore it.
 */
export function armStallWatcher({ request, bin, env = process.env, spawnProcess = spawn, modulePath = self } = {}) {
  if (String(env.ORCA_STALL_WATCH ?? '1') === '0') return false;
  const notArmed = detail => status(redactSecrets(`stall-watch NOT armed: ${detail}`));
  if (!existsSync(modulePath)) {
    notArmed(`${modulePath} is missing.`);
    return false;
  }

  const dir = watchDirOf(env);
  let fd;
  try {
    const logPath = join(dir, `${request}.log`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(logPath, 'a', 0o600);
    const child = spawnProcess(process.execPath, [modulePath, '--request', request, '--orca', bin], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, ORCA_DISPATCH_STORE: defaultStore(env) },
    });
    child.on('error', error => notArmed(String(error)));
    child.unref();
    status(`STALL-WATCH armed (pid ${child.pid}) — a silent hang will be reported to the dispatching run.`);
    return true;
  } catch (error) {
    notArmed(String(error));
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * `ax worker stall --request <id> [--orca <bin>]` — the Re-arm line every
 * silence alert prints, and so a gesture an AGENT runs, under a tool deadline.
 *
 * It ARMS and returns; it never watches. Reported as #270 (2026-09-28, gapila,
 * worker 2120): this verb used to run the loop itself, in the foreground, so the
 * orchestrator's 60 s Bash timeout killed the watcher it had just armed, and the
 * pidfile the killed loop left behind refused the next re-arm — eight minutes
 * unwatched and six calls to recover. It now detaches through the same
 * `armStallWatcher` a dispatch uses, and everything it can establish without
 * the loop it says HERE, to the caller, instead of in a log nobody reads: a
 * malformed request, a missing record, no Orca, a live watcher already holding
 * the claim. A holder proven dead is announced and left to the child's
 * `claimPid`, which takes it over; that claim stays the one authority for a race
 * between two re-arms.
 */
export function stall(argv = [], { resolve = resolveOrca, env = process.env, processAlive = processAliveDefault, arm = armStallWatcher } = {}) {
  const parsed = parse(argv);
  if (parsed.error) return callerBug(parsed.error);
  if (!requestIdOk(parsed.request)) return callerBug(`invalid --request ${JSON.stringify(parsed.request)}`);

  const recordPath = join(defaultStore(env), `${parsed.request}.json`);
  try {
    dispatchFields(recordPath);
  } catch (error) {
    if (error.code === 'ENOENT') return cannot(`no record at ${recordPath}; nothing to watch`);
    return cannot(`record at ${recordPath} cannot configure a watch: ${String(error.message ?? error)}`);
  }

  const bin = parsed.explicitOrca || resolve({ env });
  if (!bin) return cannot('no Orca CLI on this machine');

  const held = readHolder(join(watchDirOf(env), `${parsed.request}.pid`), processAlive);
  if (held.holder && !held.stale) {
    note(redactSecrets(heldBy(parsed.request, held)));
    return 0;
  }
  if (held.unreadable) {
    bad(redactSecrets(heldBy(parsed.request, held)));
    fix(`rm ${join(watchDirOf(env), `${parsed.request}.pid`)} && ax worker stall --request ${parsed.request}`);
    return 1;
  }
  if (held.stale) note(`the pidfile for ${parsed.request} names dead pid ${held.holder}; the new watcher takes it over.`);

  // The switch that keeps a dispatch from arming anything; here it would make
  // the explicit ask a silent no-op, which is the one failure a watcher verb
  // must never have.
  if (String(env.ORCA_STALL_WATCH ?? '1') === '0') {
    bad('ORCA_STALL_WATCH=0 in this environment disables every stall watcher; nothing was armed.');
    fix(`ORCA_STALL_WATCH=1 ax worker stall --request ${parsed.request}`);
    return 1;
  }
  return arm({ request: parsed.request, bin, env }) ? 0 : 3;
}

/** The loop — entered only as this file's own process, detached by `armStallWatcher`. */
export function watch(
  argv = [],
  {
    resolve = resolveOrca,
    runner,
    env = process.env,
    now = nowDefault,
    sleep = sleepDefault,
    pid = process.pid,
    processAlive = processAliveDefault,
    append = appendFileSync,
  } = {},
) {
  const parsed = parse(argv);
  if (parsed.error) return callerBug(parsed.error);
  if (!requestIdOk(parsed.request)) return callerBug(`invalid --request ${JSON.stringify(parsed.request)}`);

  const store = defaultStore(env);
  const recordPath = join(store, `${parsed.request}.json`);

  let fields;
  try {
    fields = dispatchFields(recordPath);
  } catch (error) {
    if (error.code === 'ENOENT') return cannot(`no record at ${recordPath}; nothing to watch`);
    return cannot(`record at ${recordPath} cannot configure a watch: ${String(error.message ?? error)}`);
  }

  const bin = parsed.explicitOrca || (runner ? 'injected' : resolve({ env }));
  if (!bin) return cannot('no Orca CLI on this machine');
  const run = runner ?? createRunner({ bin });

  const tickSeconds = Math.max(0.01, finiteOr(env.ORCA_STALL_TICK, 60));
  const stallAfter = Math.max(0, finiteOr(env.ORCA_STALL_AFTER, 2700));
  const lifetime = Math.max(0, finiteOr(env.ORCA_STALL_LIFETIME, 43200));
  // The card is the CROSS-HOST fallback, and only that. `brief.mjs` tells every
  // remote child its board is the one channel that reaches home, because Orca
  // refuses lineage across hosts so it has no peer channel at all — and
  // `alertCard` says "Remote worker" in so many words. A SAME-HOST child has
  // lineage, so its own report already arrives, richer: it names the state, the
  // artifact and a reply route. Measured 2026-08-22 on the repaired `comm-held3`:
  // one trivial task produced its peer report AND two card wakes, the second
  // calling a child on this very machine remote. Watching a local board
  // duplicates a working channel and mislabels what it found.
  const cardWatchAsked = String(env.ORCA_CARD_WATCH ?? '1') !== '0';
  const cardEnabled = cardWatchAsked && fields.env !== '';
  const cardMax = Math.max(0, finiteOr(env.ORCA_CARD_MAX, 20));
  const watchDir = watchDirOf(env);
  mkdirSync(watchDir, { recursive: true, mode: 0o700 });
  const pidPath = join(watchDir, `${parsed.request}.pid`);
  const logPath = join(watchDir, `${parsed.request}.log`);
  const log = message => {
    try {
      append(logPath, `${new Date(now() * 1000).toISOString()} ${redactSecrets(message)}\n`);
    } catch {
      // Logging is a courtesy, never a gate: an unwritable log must not turn a
      // live supervision into a silent exit.
    }
  };

  // RE-READ EVERY TICK, because the marker normally appears AFTER this watcher
  // is armed. `repairHeld` (start.mjs) arms it and exits 3 while the composer is
  // still held; the operator then runs `ax worker repair`, which writes the
  // marker minutes later and arms a watcher that `claimPid` refuses as a double.
  // So the only watcher alive is this one, and a marker read once at startup is
  // a marker no watcher ever observes: the repaired child's ordinary pane close
  // is then reported as a death. Measured on 55/56/71 (2026-08-25), all three
  // repaired between 49 s and 88 s after their watcher was armed. One record
  // read per tick, against a 60 s default tick.
  const repaired = () => heldRepaired(recordPath);

  let claim;
  try {
    claim = claimPid(pidPath, pid, processAlive);
  } catch (error) {
    return cannot(`pidfile claim failed: ${String(error)}`);
  }
  if (!claim.claimed) {
    const message = heldBy(parsed.request, claim);
    note(redactSecrets(message));
    log(message);
    return 0;
  }
  if (claim.tookOver) log(`took over the pidfile from dead pid ${claim.tookOver}.`);

  try {
    let worktreePath = '';
    if (!cardWatchAsked) log('card watch: disabled by ORCA_CARD_WATCH=0');
    else if (!cardEnabled) log('card watch: off for a same-host dispatch — its own peer report reaches the orchestrator directly.');
    else {
      worktreePath = worktreeFor(run, fields.handle, fields.env);
      if (!worktreePath) log(`card watch: no worktree resolved for ${fields.handle} yet; retrying discovery each tick.`);
    }

    log(`armed: dispatch=${fields.dispatchId} handle=${fields.handle} run=${fields.run} env=${fields.env || 'local'} tick=${tickSeconds}s after=${stallAfter}s lifetime=${lifetime}s card=${worktreePath || 'off'}`);

    const started = now();
    let lastActivity = started;
    // WHICH sign of life last fed the clock, so the alert can name it.
    let lastSignal = 'pane';
    let seen = null;
    let cardSeen = '';
    let cardsSent = 0;
    let stallOff = false;
    let failedNoted = false;
    // One alert per WAIT, not per tick: set once a prompt alert is delivered,
    // cleared only by Orca's explicit "no wait" (see `promptWait`).
    let promptAnnounced = false;

    for (;;) {
      if (!existsSync(recordPath)) {
        log('record gone; exiting.');
        return 0;
      }

      if (cardEnabled && !worktreePath) {
        worktreePath = worktreeFor(run, fields.handle, fields.env);
        if (worktreePath) log(`card watch: worktree resolved late at ${worktreePath}; the next card is the baseline.`);
      }

      const currentTime = now();
      const cursorRead = cursorProbe(run, fields.handle, fields.env);
      const cursor = cursorRead.cursor;
      const state = workerProbe(run, fields.dispatchId);

      // The pane is GONE, the dispatch state is KNOWN, and the dispatch is
      // neither settled nor failed: the one death no in-process hook can
      // announce. Two triggers, because a dead pane has two shapes — unreadable,
      // or readable and `exited` with a frozen cursor. Costs an extra Orca
      // round-trip only once one of them holds, so a healthy pane pays nothing.
      //
      // Measured 2026-08-22: Orca left the proven case `dispatch=dispatched
      // worker=ready` after its pane was killed, so nothing but this said so.
      //
      // `settled` is excluded because a closed pane is then the orchestrator's
      // own `worker-release`. A REPAIRED held composer is excluded for a sharper
      // reason: its Dispatch settled `failed` and never settles again, so
      // `!settled` stays true for the whole life of the child `start.mjs` left
      // running — and that child's pane closes normally at the end of real work
      // it has already reported by peer. Measured 2026-08-22: `comm-held` was
      // repaired, worked, and reported `finished its work` that way.
      //
      // Keyed on the record's own repair marker, NEVER on `state.failed`: Orca
      // files every failure under that word, and an ORDINARY failure whose pane
      // then died is exactly the death worth reporting — the Run is told nothing
      // about it either. The marker is written only for a CONFIRMED submission,
      // so a brief that may still be unsent keeps this check armed.
      if ((cursor === null || cursorRead.exited) && state.known && !state.settled && !(state.failed && repaired()) && paneGone(run, fields.handle, fields.env)) {
        const sent = alertGone(run, fields, parsed.request, state.label);
        if (sendOk(sent)) {
          log(`GONE alert sent to run:${fields.run}; exiting.`);
          return 0;
        }
        if (sendRefused(sent)) {
          log(refusalLine('gone alert', sent));
          return 0;
        }
        log('gone alert failed; will retry next tick.');
      }

      const settled = state.settled || (state.failed && cursorRead.readable && cursor === null);
      if (state.failed && !state.settled && cursor !== null && !failedNoted) {
        failedNoted = true;
        log(`failed receipt (${state.label}) but the pane still reads — a 'failed' Dispatch describes the receipt, never the process; supervision continues.`);
      }

      if (settled) {
        if (!fields.env || !worktreePath || cursor === null) {
          log(`settled: ${state.label}; exiting.`);
          return 0;
        }
        if (!stallOff) {
          stallOff = true;
          log(`settled: ${state.label}, but the pane still emits — stall watch off, card watch continues.`);
        }
      }

      // A cursor read off an EXITED pane is not a sign of life, so it must not
      // feed the clock: a corpse would otherwise look alive for one tick, and on
      // a host the inventory cannot account for it would look alive for good.
      if (!cursorRead.exited && cursor !== null && cursor !== seen) {
        seen = cursor;
        lastActivity = currentTime;
        lastSignal = 'pane';
      }

      if (worktreePath && cardsSent < cardMax) {
        const card = cardProbe(run, worktreePath, fields.env);
        if (card && card !== cardSeen) {
          if (!cardSeen) cardSeen = card;
          else {
            // A CHANGED card is activity, whatever its shape: the checkpoint
            // extension writes it at a turn boundary, so a card that moved
            // proves that session ran. Without this the same child is reported
            // TWICE — measured 2026-08-22, `comm-ax-card` published
            // `DECISION: …` and its silence alert followed 58 seconds later,
            // because only cursor movement fed the clock. The card is the one
            // channel that crosses hosts, so refusing it as evidence is how an
            // orchestrator is woken about a child that had just spoken to it.
            lastActivity = currentTime;
            lastSignal = 'card';
            const comment = card.includes('\t') ? card.slice(card.indexOf('\t') + 1) : card;
            if (progressOnly(comment)) {
              log(`card changed but it is the checkpoint extension's own shape — not waking: ${comment.slice(0, 70)}`);
              cardSeen = card;
            } else {
              const sent = alertCard(run, fields, parsed.request, card, worktreePath);
              if (sendOk(sent)) {
                cardsSent += 1;
                cardSeen = card;
                log(`card change #${cardsSent} sent to run:${fields.run}`);
              } else if (sendRefused(sent)) {
                log(refusalLine('card alert', sent));
                return 0;
              } else log('card alert failed; keeping the previous baseline so the unchanged card retries next tick.');
            }
          }
        }
      }

      if (state.wait === null) promptAnnounced = false;
      if (state.wait && !promptAnnounced && !settled) {
        const sent = alertPrompt(run, fields, parsed.request, state.wait, state.label);
        if (sendOk(sent)) {
          promptAnnounced = true;
          log(`PROMPT alert sent to run:${fields.run} (${state.wait.reason || 'interactive prompt'} via ${state.wait.source}); watch continues.`);
        } else if (sendRefused(sent)) {
          log(refusalLine('prompt alert', sent));
          return 0;
        } else log('prompt alert failed; will retry next tick.');
      }

      const silent = currentTime - lastActivity;
      if (!stallOff && silent >= stallAfter) {
        const sent = alertStall(run, fields, parsed.request, silent, state.label, lastSignal);
        if (sendOk(sent)) {
          log(`ALERT sent to run:${fields.run}; exiting.`);
          return 0;
        }
        if (sendRefused(sent)) {
          log(refusalLine('stall alert', sent));
          return 0;
        }
        log('stall alert failed; will retry next tick.');
      }

      if (currentTime - started >= lifetime) {
        log(`lifetime ${lifetime}s reached without a settle or a stall; exiting.`);
        return 0;
      }

      sleep(tickSeconds * 1000);
    }
  } finally {
    rmSync(pidPath, { force: true });
  }
}

/**
 * Is this file the process entry?
 *
 * REALPATH ON BOTH SIDES. `import.meta.url` is already resolved — Node
 * realpaths a module's own path — while `process.argv[1]` is the path the
 * caller typed. Under pnpm every install is a symlink into
 * `node_modules/.pnpm/…`, so for a consumer the two never matched: typing this
 * module's installed path loaded it and ran nothing, with no output and exit 0
 * (reported 2026-09-08 from a consumer on 0.24.1, after a stall alert whose own
 * Re-arm line was the command that did it). `ax worker stall` is the way in
 * for a person or an agent; this guard is the way in for the detached child
 * `armStallWatcher` spawns by path, and it is the ONLY place the loop runs — a
 * silent no-op here is the one failure a watcher must never have.
 */
const entered = () => {
  const invoked = process.argv[1];
  if (typeof invoked !== 'string' || invoked === '') return false;
  if (invoked === self) return true;
  try {
    return realpathSync(invoked) === realpathSync(self);
  } catch {
    return false;
  }
};
if (entered()) process.exitCode = watch(process.argv.slice(2));
