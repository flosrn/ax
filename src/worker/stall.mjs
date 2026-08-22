#!/usr/bin/env node
// Detached, fail-open supervision for one recorded worker-start.
//
// This process is deliberately separate from start.mjs (ADR 0025): a broken
// watcher must never turn a successful dispatch into a refusal. It watches two
// independent signals: pane cursor movement for a one-shot silence alert, and
// deliberate worktree-card changes for remote children whose completion mail
// may not cross hosts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets } from '../redact.mjs';
import { createRunner, resolveOrca } from '../orca-bin.mjs';
import { bad, fix, note } from '../log.mjs';
import { defaultStore, dispatchFields, heldRepaired, requestIdOk } from './record.mjs';
import { paneReadable, readPane, terminalInventory } from './pane.mjs';

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

function callerBug(message) {
  bad(redactSecrets(message));
  fix('node src/worker/stall.mjs --request <id> [--orca <bin>]');
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
  if (out.status !== 0 || out.receipt?.ok !== true) return { known: false, settled: false, failed: false, label: 'unknown' };
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
 * send a coordinator to bury a worker that is still building.
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
    `Re-arm: node src/worker/stall.mjs --request ${request}`,
  ].join('\n');
  return run([
    'orchestration', 'send', '--to', `run:${fields.run}`, '--type', 'status',
    '--subject', redactSecrets(`stall-watch: dispatched worker '${request}' has gone silent`),
    '--body', redactSecrets(body), '--json',
  ]);
}

/**
 * The one stop a child can never announce itself.
 *
 * A killed pane runs no in-process hook, so nothing inside that session reports
 * that it stopped before finishing. Measured 2026-08-22: `orca terminal close`
 * on a worker holding an unfinished todo settled the Dispatch
 * `termination_reason: operator_close` and produced NOT ONE message on the
 * coordinator's Run. Silence there reads exactly like a worker still thinking,
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
  return run([
    'orchestration', 'send', '--to', `run:${fields.run}`, '--type', 'status',
    '--subject', redactSecrets(`stall-watch: dispatched worker '${request}' is GONE without reporting`),
    '--body', redactSecrets(body), '--json',
  ]);
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
  return run([
    'orchestration', 'send', '--to', `run:${fields.run}`, '--type', 'status',
    '--subject', redactSecrets(`card: '${request}' published a checkpoint`), '--body', redactSecrets(body), '--json',
  ]);
}

function processAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimPid(path, pid, processAlive) {
  try {
    writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
    return { claimed: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let holder = 0;
  try {
    holder = Number(readFileSync(path, 'utf8').trim());
  } catch {
    return { claimed: false, unreadable: true };
  }
  return {
    claimed: false,
    holder,
    stale: holder > 0 && !processAlive(holder),
  };
}

export function stall(
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
  const watchDir = env.ORCA_STALL_DIR || join(env.HOME ?? '', '.omp', 'run', 'stall-watch');
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

  // Read ONCE: `start` has already returned by the time this watcher runs, so the
  // marker cannot appear or vanish mid-watch.
  const repaired = heldRepaired(recordPath);

  let claim;
  try {
    claim = claimPid(pidPath, pid, processAlive);
  } catch (error) {
    return cannot(`pidfile claim failed: ${String(error)}`);
  }
  if (!claim.claimed) {
    const message = claim.stale
      ? `pidfile for ${parsed.request} belongs to dead pid ${claim.holder}; automatic takeover is refused — remove it only after verifying no watcher survives.`
      : claim.holder
        ? `already armed for ${parsed.request} (pid ${claim.holder}); not doubling it.`
        : `pidfile for ${parsed.request} is unreadable; not doubling an unknown watcher.`;
    note(redactSecrets(message));
    log(message);
    return 0;
  }

  try {
    let worktreePath = '';
    if (!cardWatchAsked) log('card watch: disabled by ORCA_CARD_WATCH=0');
    else if (!cardEnabled) log('card watch: off for a same-host dispatch — its own peer report reaches the coordinator directly.');
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
      // `settled` is excluded because a closed pane is then the coordinator's own
      // `worker-release`. A REPAIRED held composer is excluded for a sharper
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
      if ((cursor === null || cursorRead.exited) && state.known && !state.settled && !(state.failed && repaired) && paneGone(run, fields.handle, fields.env)) {
        const sent = alertGone(run, fields, parsed.request, state.label);
        if (sendOk(sent)) {
          log(`GONE alert sent to run:${fields.run}; exiting.`);
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
            // channel that crosses hosts, so refusing it as evidence is how a
            // coordinator is woken about a child that had just spoken to it.
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
              } else log('card alert failed; keeping the previous baseline so the unchanged card retries next tick.');
            }
          }
        }
      }

      const silent = currentTime - lastActivity;
      if (!stallOff && silent >= stallAfter) {
        const sent = alertStall(run, fields, parsed.request, silent, state.label, lastSignal);
        if (sendOk(sent)) {
          log(`ALERT sent to run:${fields.run}; exiting.`);
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

const self = fileURLToPath(import.meta.url);
if (process.argv[1] === self) process.exitCode = stall(process.argv.slice(2));
