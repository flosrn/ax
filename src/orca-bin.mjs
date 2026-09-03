// Which binary is Orca on this machine — answered once, here, and nowhere else.
//
// The answer differs per host, and assuming it has a measured cost: on a Linux
// VPS the bare name `orca` is the GNOME screen reader (running it starts speech
// on the user's machine) while the runtime ships as `orca-ide`; a scheduled job
// that resolved the bare name ran 246 times reading nothing. The 2026-08-09
// duplicate agent (F-001) was born on the host whose command set nobody had
// checked. Before the port this resolution existed three times — in the bash
// orchestrator, orca-stall-watch.sh and orca-model/self.ts — and the copies
// could drift. This is the only one now, and it is also the availability
// predicate that gates every Orca-facing verb out of the help and the dispatch
// of machines that have no Orca.

import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { run as execRun } from './exec.mjs';

/** Can this command be executed? Absolute paths are checked directly, bare names against PATH. */
export function canRunDefault(command, env = process.env) {
  const runnable = path => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(command)) return runnable(command);
  return (env.PATH ?? '').split(delimiter).some(dir => dir !== '' && runnable(join(dir, command)));
}

/**
 * The Orca CLI for this process, or null when this machine has none.
 *
 * Order, most explicit first:
 *   1. ORCA_CLI_COMMAND — Orca itself exports it for managed sessions.
 *   2. ORCA_BIN — operator override, same contract as the extensions honour.
 *   3. `orca-dev` — a dev-checkout session announces itself with ORCA_DEV_REPO_ROOT.
 *   4. Platform order: Linux prefers `orca-ide` (bare `orca` is the screen
 *      reader there); everywhere else `orca` first.
 */
export function resolveOrca({ env = process.env, platform = process.platform, canRun = canRunDefault } = {}) {
  const explicit = env.ORCA_CLI_COMMAND || env.ORCA_BIN;
  if (explicit) return canRun(explicit, env) ? explicit : null;
  const candidates = env.ORCA_DEV_REPO_ROOT
    ? ['orca-dev']
    : platform === 'linux'
      ? ['orca-ide', 'orca']
      : ['orca', 'orca-ide'];
  return candidates.find(name => canRun(name, env)) ?? null;
}

/**
 * The gate has TWO levels, and they answer different questions at different
 * moments (decided with the operator, 2026-08-21):
 *   - `orcaAvailable` — can this MACHINE run Orca at all? Binary resolution
 *     only, zero-cost, safe to call on every `ax` invocation. It gates
 *     VISIBILITY: whether Orca-facing verbs exist in the help and the dispatch.
 *   - `runtimeReady` — is the runtime ANSWERING right now? One `status --json`
 *     round trip (~200 ms measured). It gates EXECUTION: every Orca-facing verb
 *     probes it first and refuses with `orca open` as the named repair.
 * A machine with a shim on PATH but no live runtime therefore SHOWS the verbs
 * and refuses to run them — two different propositions, never collapsed.
 */
export const orcaAvailable = options => resolveOrca(options) !== null;

/** Is the runtime answering? `runner` is a createRunner product, injectable. */
export function runtimeReady(runner) {
  const { status, receipt, stderr } = runner(['status', '--json']);
  const runtime = (receipt.result ?? {}).runtime ?? {};
  if (status === 0 && receipt.ok === true && runtime.reachable === true) return { ready: true };
  return {
    ready: false,
    reason: receipt.unparseable
      ? `orca status did not answer JSON: ${String(receipt.unparseable).slice(0, 200)}`
      : `orca runtime not reachable (status exit ${status}${stderr ? `, ${String(stderr).slice(0, 200)}` : ''})`,
  };
}

/**
 * Parse a receipt without ever losing the diagnostic.
 *
 * F-004, adapted: in bash a failing `jq` inside a pipe once ate the only
 * diagnostic that mattered, so every receipt went to a file and was read back.
 * In-process there is no pipe to lose it in — the port of that rule is that a
 * receipt that does not parse is STORED as `{ unparseable, error }`, raw text
 * first, never dropped and never thrown away.
 */
export function parseReceipt(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    return { unparseable: String(stdout).slice(0, 4000), error: String(error) };
  }
}

/** One Orca call's budget. `ax worker start` derives its lock wait from it. */
export const RUNNER_TIMEOUT_MS = 30000;

/**
 * A runner for one resolved binary. Exit codes are verdicts in this domain
 * (ADR 0003), so a non-zero status is DATA — returned, never thrown. stderr is
 * always carried back to the caller for the same F-004 reason.
 *
 * `exec` is injected so every test runs offline: it must return
 * `{ status, stdout, stderr }` like the spawnSync default.
 */
export function createRunner({ bin, exec, timeoutMs = RUNNER_TIMEOUT_MS } = {}) {
  // The default's knobs live in src/exec.mjs — including the measured
  // maxBuffer fix (2026-08-22: the 1 MiB cap killed a child mid-print and
  // truncated a healthy receipt).
  const run = exec ?? ((command, args) => execRun(command, args, { timeout: timeoutMs }));
  return args => {
    const { status, stdout, stderr, error } = run(bin, args);
    return { status, stdout, stderr, error, receipt: parseReceipt(stdout) };
  };
}
