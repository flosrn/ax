// THE PROCESS BOUNDARY in front of the model probe: ask the TARGET what it can
// serve, and believe nothing else.
//
// `ctx.models.resolve()` and `ctx.models.list()` — the runtime's own resolver
// and its own authenticated list — exist only inside a live OMP session, so
// this module spawns the real thing (omp/model/probe.ts), hands it the request
// and parses one line. It decides nothing about models itself.
//
// The probe answers at `session_start` and exits before the provider is called,
// under `--no-session` with no tools, skills, rules, LSP or extension discovery
// beyond the one explicit `-e`: a read of that host's configuration and auth,
// never a change to either.
//
// The REMOTE side derives its own probe path from the remote `ax` install,
// because a path from this machine names nothing on another one; a host whose
// ax ships no probe is reported, never guessed at.

import { fileURLToPath } from 'node:url';

import { run } from '../exec.mjs';
import { PROBE_PREFIX, SELECTORS_ENV } from './model-policy.mjs';
import { quote, remote } from './hosts.mjs';

// The wire is defined once, beside the selector vocabulary both sides share,
// and re-exported here for this side's callers.
export { PROBE_PREFIX, SELECTORS_ENV };

/**
 * FINITE, and not the 30 s every short gesture in this package budgets: this
 * boots a whole OMP session (extension load, settings, model catalog) before it
 * answers, which is tens of seconds on a cold cache. Finite because a probe
 * that hangs blocks a dispatch that has not happened yet.
 */
export const PROBE_TIMEOUT_MS = 120000;

/** Exit code the remote script uses for "this host's ax ships no model probe". */
const NO_PROBE = 97;
/** Exit code the remote script uses for "this host has no omp on its PATH". */
const NO_OMP = 96;
/** Exit code the remote script uses for "the named checkout is not there". */
const NO_CHECKOUT = 95;

/** Placeholder the remote argv substitutes the host-derived probe path into. */
const PROBE_PATH_TOKEN = '\u0000probe\u0000';

/**
 * The probe that ships in THIS copy of the package, by relative path.
 *
 * Relative rather than resolved through the package name: resolving
 * `@flosrn/ax` from a consumer's cwd can answer a different install, and a
 * candidate list read through another version's rules is a silent version skew.
 */
export const probeExtensionPath = () => fileURLToPath(new URL('../../omp/model/probe.ts', import.meta.url));

/**
 * The default adapter behind the `exec` seam: `run` with a finite deadline and
 * an explicit environment — not `exec.mjs`'s `defaultExec`, which can pass no
 * environment at all, and the environment IS the request here.
 */
export const defaultExec = (bin, args, { cwd, env, timeout = PROBE_TIMEOUT_MS } = {}) => run(bin, args, { cwd, env, timeout });

/**
 * The argv of a probe session, and every flag is load-bearing.
 *
 * `-p` is the non-interactive mode whose `session_start` is awaited before the
 * first prompt. `--no-extensions` stops discovery so the ax bundle — which
 * dispatches, writes boards and registers peers — is NOT loaded into a
 * read-only probe; the explicit `-e` still loads, which is documented
 * behaviour. The rest remove every other side effect of a session start.
 *
 * The advisor needs no flag: it is opt-in and runs on turns, and this session
 * exits during `session_start`. The trailing prompt exists because print mode
 * wants a message; the process is gone before that message is sent.
 */
export const probeArgs = extensionPath => [
  '-p',
  '--no-session',
  '--no-extensions',
  '-e',
  extensionPath,
  '--no-tools',
  '--no-lsp',
  '--no-skills',
  '--no-rules',
  '--no-title',
  'ax model probe',
];

/**
 * ONE ENVELOPE FOR EVERY ANSWER, success or refusal.
 *
 * A refusal that carried only `reason` made the dispatcher read `candidates`
 * off a failed probe as an empty list, so "nothing could be proven here"
 * arrived at the operator as a bare "no candidates". Every answer has the same
 * three keys, and a refusal's `errors` carries the reason it refused.
 */
function refuse(reason, extra = {}) {
  return { ok: false, candidates: [], errors: [reason], reason, ...extra };
}

/** The request, validated before a process is spawned for it. */
function requestOf(selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    return { reason: 'no selectors to prove — a probe is told exactly which candidates to read on the target, it never guesses a list' };
  }
  const bad = selectors.find(selector => typeof selector !== 'string' || selector.trim() === '');
  if (bad !== undefined) {
    return { reason: `selector ${JSON.stringify(bad)} is not a selector string; every entry must be a non-empty string` };
  }
  return { json: JSON.stringify(selectors.map(selector => selector.trim())) };
}

/** One line of context from a failed process, bounded — never a wall of output. */
function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '');
  return line === undefined ? '' : line.slice(0, 300);
}

/**
 * The answer, read out of the probe's own output.
 *
 * The LAST matching line wins: a host that printed a warning and then the
 * result has one result, and taking the first would read a line that is not it.
 * Both streams are read, because a runtime is free to route a diagnostic stream
 * either way.
 */
export function parseProbe({ stdout, stderr } = {}) {
  for (const stream of [stdout, stderr]) {
    const lines = String(stream ?? '').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith(PROBE_PREFIX)) continue;
      const payload = line.slice(PROBE_PREFIX.length);
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (error) {
        return { ok: false, reason: `the probe printed a ${PROBE_PREFIX} line this release cannot read: ${String(error?.message ?? error)}` };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.candidates) || !Array.isArray(parsed.errors)) {
        return { ok: false, reason: `the probe answered with a shape this release cannot read — {candidates,errors} was expected, got ${payload.slice(0, 200)}` };
      }
      return { ok: true, candidates: parsed.candidates, errors: parsed.errors.map(String) };
    }
  }
  return { ok: false, reason: `the probe printed no ${PROBE_PREFIX} line` };
}

/** The local probe: this machine's omp, this package's probe extension. */
function probeLocally(json, { exec, cwd, env }) {
  const out = exec('omp', probeArgs(probeExtensionPath()), {
    cwd,
    // EXACTLY the environment the caller passed, plus the request. Not merged
    // with `process.env`: a caller that hands over an isolated HOME is choosing
    // which settings the probe reads.
    env: { ...env, [SELECTORS_ENV]: json },
    timeout: PROBE_TIMEOUT_MS,
  });
  return { out, where: 'this machine' };
}

/**
 * The remote probe: the host's own ax install, the host's own omp, over the ssh
 * boundary this package already owns.
 *
 * Every interpolated value is `quote`d, because ssh rejoins its arguments into
 * one string and hands it to a remote shell — a path or a JSON payload reaching
 * that shell unquoted is remote program text.
 */
function probeRemotely(json, { exec, cwd, host, remotePath }) {
  const at = host?.ssh ?? '';
  if (at === '') {
    return { refusal: refuse('that host declares no ssh target, and a remote probe is read over ssh. Declare it under dispatch.hosts.<env>.ssh in ax.config.json') };
  }
  // THE CHECKOUT, NOT THE LOGIN DIRECTORY. `modelRoles` is project-scoped
  // config: a probe run from wherever ssh lands reads that host's USER-level
  // roles, and reporting those as the target's candidates answers a question
  // nobody asked. Required, so the weaker answer cannot pass for the real one.
  if (typeof remotePath !== 'string' || remotePath.trim() === '') {
    return {
      refusal: refuse(
        `no checkout on '${at}' was named, and a probe run outside the target checkout reads that host's user-level model roles rather than the project's. Resolve the remote worktree first and pass it as remotePath`,
      ),
    };
  }

  const argv = probeArgs(PROBE_PATH_TOKEN)
    .map(arg => (arg === PROBE_PATH_TOKEN ? '"$AX_PROBE"' : quote(arg)))
    .join(' ');

  // `cd` FIRST, and a failure to enter is a refusal rather than a probe of
  // whatever directory ssh landed in. The probe path is derived THERE: the
  // published package puts `bin/ax.mjs` and `omp/` side by side.
  const script =
    `cd ${quote(remotePath)} || exit ${NO_CHECKOUT}; ` +
    `AX_BIN=$(command -v ax) || exit ${NO_PROBE}; ` +
    `AX_ROOT=$(cd "$(dirname "$(readlink -f "$AX_BIN")")/.." 2> /dev/null && pwd) || exit ${NO_PROBE}; ` +
    `AX_PROBE="$AX_ROOT/omp/model/probe.ts"; ` +
    `[ -f "$AX_PROBE" ] || exit ${NO_PROBE}; ` +
    `command -v omp > /dev/null 2>&1 || exit ${NO_OMP}; ` +
    `${SELECTORS_ENV}=${quote(json)} exec omp ${argv}`;

  const out = remote(args => exec('ssh', args, { cwd, timeout: PROBE_TIMEOUT_MS }), at, `bash -lc ${quote(script)}`);
  return { out, where: `${at}:${remotePath}`, at };
}

/**
 * Prove a selector list on the host that would run it.
 *
 * `selectors` are aliases (`@worker-balanced`) or concrete specs
 * (`xai-oauth/grok-4.5:high`), and the ORDER is the preference — expansion,
 * candidate membership and per-candidate effort all come from the target's own
 * `modelRoles`.
 *
 * Answers one envelope either way: `{ ok, candidates, errors }`, plus `where`
 * on an answer and `reason` on a refusal. `unavailable: true` marks the
 * refusals that are about the TARGET rather than the request — a host that
 * cannot be interrogated at all, for which inventing candidates is exactly what
 * this module exists to prevent.
 *
 * `env` defaults to this process's real environment; a caller that passes `env`
 * replaces it WHOLESALE, so a test pointing HOME at a temp tree gets that tree.
 */
export function probeModels(selectors, { exec = defaultExec, cwd, host = null, remotePath = null, env = process.env } = {}) {
  const request = requestOf(selectors);
  if (request.json === undefined) return refuse(request.reason);

  const attempt = host === null ? probeLocally(request.json, { exec, cwd, env }) : probeRemotely(request.json, { exec, cwd, host, remotePath });
  if (attempt.refusal !== undefined) return attempt.refusal;
  const { out, where, at } = attempt;
  const target = at ?? where;

  if (out?.error !== undefined && out.error !== null) {
    return refuse(`the model probe could not be run on ${where}: ${String(out.error.message ?? out.error)}`, { where });
  }
  if (out?.status === NO_CHECKOUT) {
    return refuse(`'${remotePath}' could not be entered on ${target}, so the project whose model roles were to be read is not there`, { where, unavailable: true });
  }
  if (out?.status === NO_PROBE) {
    return refuse(
      `the ax installed on ${target} ships no model probe (omp/model/probe.ts), so its candidates cannot be proven there. Pin that host's project to a release that carries one, then dispatch again`,
      { where, unavailable: true },
    );
  }
  if (out?.status === NO_OMP) {
    return refuse(`${target} has no omp on its PATH, so no session there can answer which models it would serve`, { where, unavailable: true });
  }

  // The OUTPUT comes before the exit code deliberately: the probe exits the
  // process from inside a `session_start` handler, and a host is free to treat
  // that as a failed start. A complete, parseable answer is an answer whatever
  // status accompanied it — and when there is no answer, the status is what the
  // refusal reports.
  const parsed = parseProbe(out ?? {});
  if (parsed.ok) return { ok: true, where, candidates: parsed.candidates, errors: parsed.errors };

  const detail = firstLine(out?.stderr) || firstLine(out?.stdout);
  return refuse(`${parsed.reason} on ${where} (exit ${out?.status ?? 'null'})${detail === '' ? '' : `: ${detail}`}`, { where });
}
