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
import { defaultStore, dispatchFields, requestIdOk, terminalCursor } from './record.mjs';

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
  if (out.status !== 0 || out.receipt?.ok !== true) return { settled: false, failed: false, label: 'unknown' };
  const result = out.receipt.result ?? {};
  const dispatch = result.dispatch?.status;
  const worker = result.worker?.state;
  return {
    settled: settledDispatch.has(dispatch) || settledWorker.has(worker),
    failed: dispatch === 'failed' || worker === 'failed',
    label: `dispatch=${dispatch ?? 'unknown'} worker=${worker ?? 'unknown'}`,
  };
}

function cursorProbe(run, handle, executionEnv) {
  const args = ['terminal', 'read', '--terminal', handle];
  if (executionEnv) args.push('--environment', executionEnv);
  args.push('--limit', '1', '--json');
  const out = run(args);
  if (out.status !== 0 || out.receipt?.ok !== true) return { readable: false, cursor: null };
  const terminal = out.receipt?.result?.terminal;
  if (terminal === null || typeof terminal !== 'object') return { readable: false, cursor: null };
  return { readable: true, cursor: terminalCursor(out.receipt) };
}

function worktreeFor(run, handle, executionEnv) {
  const args = ['terminal', 'list'];
  if (executionEnv) args.push('--environment', executionEnv);
  args.push('--json');
  const out = run(args);
  if (out.status !== 0 || !Array.isArray(out.receipt?.result?.terminals)) return '';
  return out.receipt.result.terminals.find(row => row.handle === handle)?.worktreePath ?? '';
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

function alertStall(run, fields, request, silentSeconds, status) {
  const terminalRepair = ['orca terminal read', '--terminal', fields.handle];
  if (fields.env) terminalRepair.push('--environment', fields.env);
  terminalRepair.push('--limit', '60', '--json');
  const minutes = Math.ceil(silentSeconds / 60);
  const body = [
    `Dispatch ${fields.dispatchId} for request ${request} has emitted no new terminal line for ${minutes} minute(s).`,
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
  const cardEnabled = String(env.ORCA_CARD_WATCH ?? '1') !== '0';
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
    if (!cardEnabled) log('card watch: disabled by ORCA_CARD_WATCH=0');
    else {
      worktreePath = worktreeFor(run, fields.handle, fields.env);
      if (!worktreePath) log(`card watch: no worktree resolved for ${fields.handle} yet; retrying discovery each tick.`);
    }

    log(`armed: dispatch=${fields.dispatchId} handle=${fields.handle} run=${fields.run} env=${fields.env || 'local'} tick=${tickSeconds}s after=${stallAfter}s lifetime=${lifetime}s card=${worktreePath || 'off'}`);

    const started = now();
    let lastActivity = started;
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

      if (cursor !== null && cursor !== seen) {
        seen = cursor;
        lastActivity = currentTime;
      }

      if (worktreePath && cardsSent < cardMax) {
        const card = cardProbe(run, worktreePath, fields.env);
        if (card && card !== cardSeen) {
          if (!cardSeen) cardSeen = card;
          else {
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
        const sent = alertStall(run, fields, parsed.request, silent, state.label);
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
