// The one default adapter behind every module's injected `exec` seam.
//
// The seam itself stays per-module — every verb takes `exec` as a named option
// and every test injects a stub — but the DEFAULT behind that seam existed a
// dozen times over, and the copies drifted on the knobs that matter: only one
// carried the maxBuffer fix below, and a refactor once dropped a module's
// spawnSync import with a full green suite saying nothing, because each copy
// was its own only witness. The mechanics now live once, behind
// tests/exec.test.mjs.
//
// NO DEFAULT TIMEOUT, deliberately: `supabase start` runs minutes under
// promote(), and a default deadline would be a contract change dressed as a
// cleanup. A site that wants one names it.

import { spawnSync } from 'node:child_process';

// NOT the Node default on purpose. Measured 2026-08-22: a real `orchestration
// inbox --limit 500 --json` overflows spawnSync's 1 MiB cap, which KILLS the
// child mid-print — status null, output truncated — and turns a healthy
// runtime into "unreadable". Outputs are bounded by their writers' own row
// caps, so 64 MiB is headroom, not policy.
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a binary; answer `{ status, stdout, stderr, error }` — status as data,
 * never a throw. A missing binary is `error` with `status: null`, and the
 * caller's own predicate decides what that means: exit codes are verdicts in
 * this package, per verb (ADR 0003).
 */
export function run(bin, args, { cwd, timeout, maxBuffer = MAX_BUFFER, env } = {}) {
  const out = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
    ...(cwd ? { cwd } : {}),
    ...(timeout ? { timeout } : {}),
    ...(env ? { env } : {}),
  });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error };
}

/**
 * The environment a `gh` call runs under: the shell's, minus `GH_REPO`.
 *
 * `gh repo view` with no argument answers `GH_REPO` when it is set — gh
 * documents it as the repository for commands that otherwise operate on the
 * local checkout. Every ax verb speaks about the checkout it runs in, and the
 * dispatch record's `repo` key is written by one verb and compared by three
 * others, possibly from other shells: an override reaching one of them makes a
 * record permanently foreign to the rest (review of #123). Stripped HERE, in
 * the one adapter, so writer and readers cannot disagree.
 */
export function ghEnv(env = process.env) {
  const { GH_REPO: _ignored, ...rest } = env;
  return rest;
}

/**
 * One trimmed stdout value, or `undefined` — for probes whose only question is
 * "what did it say". A failure, an empty answer and a missing binary are the
 * same absence: errors are not findings here.
 */
export function capture(bin, args, { cwd } = {}) {
  const out = run(bin, args, { cwd });
  if (out.status !== 0) return undefined;
  const value = out.stdout.trim();
  return value === '' ? undefined : value;
}

/**
 * `gh` and `git`, run for real, on the 30 s deadline every short gesture in
 * this package budgets. Exported from here — never from a verb — because every
 * test injects a stub in its place, which once left a hand-rolled copy
 * entirely unexercised: the module lost its `spawnSync` import in a refactor
 * and a full green suite said nothing — the first real invocation was a
 * ReferenceError.
 */
export const defaultExec = (bin, args, at) => run(bin, args, { cwd: at, timeout: 30000, ...(bin === 'gh' ? { env: ghEnv() } : {}) });
