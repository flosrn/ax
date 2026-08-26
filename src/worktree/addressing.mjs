// Which ADDRESS a worktree answers on — and which one everything else is told.
//
// `http://localhost:3412` works, and it is still the wrong primary URL for a
// worktree, for a reason that has nothing to do with looks: BROWSER COOKIES
// IGNORE THE PORT. `localhost:3000` and `localhost:3412` are one cookie jar and
// one localStorage, so two worktrees signed in as different users fight over the
// same auth cookie — sign in on one and the other is silently reauthenticated as
// that user, or logged out. Distinct hostnames are distinct origins, which is
// the actual fix.
//
// A local reverse proxy supplies those hostnames: it maps
// `<worktree>.<project>.localhost` onto the app's port. The tailnet URL is the
// second half of the same problem — a phone cannot reach `localhost` at all.
//
// Both layers are OPTIONAL and neither may fail worktree creation: a machine
// with no proxy installed, or with a sleeping tailnet daemon, still gets a
// working worktree addressed by port.
//
// The layering here is deliberate. Everything above `planUrls` touches the
// machine and is therefore injectable; `planUrls` itself touches nothing. Setup
// probes, plans, and WRITES the result; the doctor re-derives the same plan from
// the same probe data and COMPARES it against the files. That only works while
// the derivation exists exactly once — the two derivations this replaces, one in
// the setup script and one in the dev-server launcher, disagreed twice: once on
// dotenv precedence and once on the recorded-flag asymmetry below. Each
// disagreement was a green verdict on a worktree serving a different origin than
// it advertised.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { capture } from '../exec.mjs';

import { baseUrlForPort } from './ports.mjs';

/**
 * Run a probe command and return its trimmed stdout, or `undefined`.
 *
 * The default for every injected `run`. Never throws and never inherits stdio: a
 * missing binary, a daemon that is logged out and a non-zero exit are all just
 * "no answer", because none of them may interrupt the caller.
 *
 * `cwd` matters to any probe that answers PER DIRECTORY. The proxy is one: it
 * infers the branch from the caller's directory, so a probe run in the ax
 * process's own cwd answers for whatever tree that process happens to sit in.
 * Measured 2026-08-25: `ax worker launch` provisions a worktree it does not
 * chdir into, so every worktree placed by one launch would be told the primary
 * checkout's route — the same class of incident this module's header records,
 * "one worktree announcing a dev host nothing served".
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {string | undefined}
 */
export function runProbe(bin, args, { cwd } = {}) {
  return capture(bin, args, { cwd });
}

/**
 * Is this an EXECUTABLE FILE on PATH?
 *
 * PATH is walked rather than delegated to `which`: a machine without `which`
 * reported every binary as absent, which silently turned a proxied worktree into
 * a localhost one. `isFile` comes before the execute test because a directory
 * carries the execute bit too, so `X_OK` alone accepts `…/bin/proxy/`.
 *
 * The precise shape matters beyond correctness. The dev-server launcher asks the
 * same question, and the doctor cross-checks the two answers; a predicate that
 * also reported shell functions and aliases — as `command -v` does — modelled a
 * proxy the launcher would never use, and the doctor reported its own
 * cross-check as a tooling bug. Neither side models `execvp`'s handling of empty
 * or relative PATH entries: a PATH like that is broken for every tool here.
 *
 * @param {string} bin
 * @returns {boolean}
 */
export function executableOnPath(bin) {
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];

  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = resolve(entry, `${bin}${suffix}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Next candidate.
      }
    }
  }
  return false;
}

/** Is the local reverse proxy installed? */
export function proxyAvailable({ bin = 'portless', which = executableOnPath } = {}) {
  return Boolean(bin) && which(bin);
}

/**
 * Is this checkout SUPPOSED to be addressed through the proxy?
 *
 * One predicate, because three places used to answer it and two of them
 * disagreed: `'0'` disables, and ANYTHING ELSE ENABLES — including an absent
 * key, and including `'false'`. That asymmetry is not an oversight and must not
 * be "fixed" into a general truthiness test. It is the rule the dev-server
 * launcher enforces when it starts the server, so it is the rule everything else
 * has to grade against; a doctor that accepted only the literal `'1'` called a
 * worktree direct-mode while the launcher put it behind the proxy, which is a
 * green verdict on a mismatched origin. The cost of the asymmetry is that a
 * hand-written `false` reads as enabled; the cost of the alternative is a
 * silently wrong origin. So the asymmetry wins, and the writer only ever records
 * `0` or `1`.
 *
 * Takes the RECORDED value — process environment, then the worktree's env files
 * — never a per-invocation override, which has to stay overridable per run.
 *
 * @param {{ recorded?: string | number }} [options]
 * @returns {boolean}
 */
export function proxyEnabled({ recorded } = {}) {
  if (recorded === undefined || recorded === null || recorded === '') return true;
  return String(recorded) !== '0';
}

/**
 * The proxy's own listening port.
 *
 * A recorded value that is not a plain number yields `undefined` rather than the
 * fallback: the fallback would hide the typo behind a working-looking plan, and
 * an unreachable proxy is far cheaper to diagnose when the malformed value
 * reaches the comparison that reports it. The range is deliberately not narrowed
 * here for the same reason — rejecting is this function's only vocabulary, and
 * `0` is better reported by the caller that knows what it wanted the port for.
 *
 * @param {{ recorded?: string | number, fallback?: string | number }} [options]
 * @returns {number | undefined}
 */
export function proxyPort({ recorded, fallback } = {}) {
  const raw = recorded === undefined || recorded === null || recorded === '' ? fallback : recorded;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw);
  return /^[0-9]+$/.test(text) ? Number(text) : undefined;
}

/**
 * The name the proxy registers this project under.
 *
 * The PROJECT half only: the proxy prepends the branch as a subdomain itself.
 *
 * @param {{ recorded?: string, fallback?: string }} [options]
 * @returns {string | undefined}
 */
export function proxyName({ recorded, fallback } = {}) {
  const name = recorded === undefined || recorded === null || recorded === '' ? fallback : recorded;
  return name === undefined || name === null || name === '' ? undefined : String(name);
}

/**
 * ASK the proxy for the URL it serves, rather than composing one.
 *
 * A composed hostname is a guess, and a guess that is wrong is worse than no
 * hostname at all: setup would announce an address nothing answers, and every
 * consumer downstream — the context file, Playwright, the browser tooling — would
 * inherit it. The proxy is the only authority on what it actually serves, and a
 * recorded name is only a claim about what it was asked to serve.
 *
 * `undefined` when the proxy is absent, when it cannot name a route, or when it
 * answers something that is not an absolute HTTP URL.
 *
 * `cwd` is the worktree being planned, and it is REQUIRED for a correct answer:
 * the name alone does not identify a route, because the proxy resolves the
 * branch from the directory it is asked in. Omitting it answers for the caller's
 * own tree.
 *
 * @param {{ name?: string, bin?: string, cwd?: string, run?: typeof runProbe }} [options]
 * @returns {string | undefined}
 */
export function proxyServedUrl({ name, bin = 'portless', cwd, run = runProbe } = {}) {
  if (!name) return undefined;
  const answer = run(bin, ['get', name], { cwd });
  if (!answer) return undefined;
  // All whitespace stripped, not just the ends: the answer is a single URL, so
  // interior whitespace is corruption, and a URL is never repaired by keeping it.
  const url = answer.replace(/\s+/g, '');
  return /^https?:\/\/./.test(url) ? url : undefined;
}

/**
 * This node's MagicDNS name, for the phone-reachable URL.
 *
 * A recorded override wins outright, so a machine whose daemon is slow to answer
 * — or a test with no tailnet at all — still plans the same URL. The trailing dot
 * MagicDNS reports is stripped: it is correct DNS and it is not what belongs in a
 * URL a human is asked to type.
 *
 * @param {{ recorded?: string, bin?: string, run?: typeof runProbe }} [options]
 * @returns {string | undefined}
 */
export function tailnetName({ recorded, bin = 'tailscale', run = runProbe } = {}) {
  if (recorded) return stripTrailingDot(String(recorded));

  const output = run(bin, ['status', '--json']);
  if (!output) return undefined;

  let status;
  try {
    status = JSON.parse(output);
  } catch {
    return undefined;
  }

  const self = status?.Self;
  if (typeof self?.DNSName === 'string' && self.DNSName) return stripTrailingDot(self.DNSName);

  // Older daemons report the halves separately. Composing them is safe in a way
  // composing a proxy hostname is not: both halves come from the daemon itself.
  const host = self?.HostName;
  const suffix = status?.CurrentTailnet?.MagicDNSSuffix;
  if (!host || !suffix) return undefined;
  return `${host}.${stripTrailingDot(String(suffix))}`;
}

const stripTrailingDot = name => name.replace(/\.$/, '');

/**
 * Plan this worktree's addresses. PURE — no machine access whatsoever.
 *
 * Every question about the live machine has already been answered by the caller
 * and arrives as data. That is what lets the doctor re-derive this plan to grade
 * the env files, and what lets it be tested with plain objects and no proxy, no
 * tailnet and no PATH.
 *
 * Both probe objects are ABSENT-MEANS-ENABLED, matching `proxyEnabled` above and
 * the launcher: `enabled: false` opts out, anything else is in. An enabled layer
 * that could not be reached is not silently dropped — it leaves a `WARN:` line,
 * because "your phone cannot open this worktree" has to be told to the operator,
 * not inferred by them from a URL that is missing.
 *
 * @param {object} options
 * @param {string} [options.worktreePath]
 * @param {string} [options.branch]
 * @param {number|string} options.port  the dev port this worktree binds
 * @param {{ enabled?: boolean, available?: boolean, name?: string, servedUrl?: string, installHint?: string }} [options.proxy]
 * @param {{ enabled?: boolean, name?: string }} [options.tailnet]
 * @returns {{ directUrl: string, baseUrl: string, publishedUrl: string, mode: 'direct'|'proxy', log: string[] }}
 */
export function planUrls({ worktreePath, branch, port, proxy = {}, tailnet = {} } = {}) {
  const log = [];
  const directUrl = baseUrlForPort(port);

  const where = [branch && `branch ${branch}`, worktreePath && `at ${worktreePath}`].filter(Boolean).join(', ');
  log.push(`dev port ${port} → ${directUrl}${where ? ` (${where})` : ''}`);

  // --- Proxy ---
  //
  // `baseUrl` prefers the proxy host because it is a distinct ORIGIN — see the
  // cookie-jar note at the top of this file. The direct localhost URL is kept
  // alongside it unconditionally: it is always true, and it is the fallback every
  // tool needs when the proxy is not running.
  //
  // The main checkout, which owns the project's plain port, opts out through
  // `enabled: false`. That decision needs git, so it belongs to the caller.
  let mode = 'direct';
  let baseUrl = directUrl;
  let name;

  if (proxy.enabled === false) {
    log.push(`proxy disabled for this worktree — addressing it by port (${directUrl})`);
  } else if (!branch) {
    // A detached HEAD has no branch, and the proxy builds a worktree's hostname
    // from one: asked without it, it answers with the PROJECT route — the very
    // address the primary checkout serves. Publishing that here would put two
    // checkouts on one origin and therefore one cookie jar, which is the exact
    // confusion this whole layer exists to prevent. Measured on a detached tree:
    // `portless get <project>` returned the primary's URL verbatim.
    log.push(`detached HEAD — no branch to build a proxy hostname from, so addressing this worktree by port (${directUrl})`);
  } else {
    name = proxy.name;
    if (proxy.servedUrl) {
      mode = 'proxy';
      baseUrl = proxy.servedUrl;
      log.push(`proxy serves this worktree at ${baseUrl} (asked the proxy, not composed) — its own cookie jar, unlike a localhost port`);
    } else if (proxy.available) {
      // Installed, yet unable to name a route for this project. That is a removed
      // or broken project registration rather than a route that has not started
      // yet: the lookup composes its answer from the project name and the branch
      // and never consults the route table, so no name means no registration.
      log.push(
        `WARN:proxy cannot name a route for '${name ?? '(no name configured)'}' — addressing this worktree by port (${directUrl}). Check the proxy's project registration.`,
      );
    } else {
      log.push(
        `no local reverse proxy on PATH — addressing this worktree by port (${directUrl}).${proxy.installHint ? ` ${proxy.installHint}` : ''}`,
      );
    }
  }

  // --- Tailnet ---
  //
  // On by default: testing on a real phone is a daily need, not an opt-in
  // ceremony. Never fatal — a sleeping daemon must not stop a worktree from
  // being created.
  let tailnetUrl;
  if (tailnet.enabled === false) {
    log.push('tailnet publishing disabled — this worktree is local-only');
  } else if (tailnet.name) {
    tailnetUrl = `https://${stripTrailingDot(String(tailnet.name))}:${port}`;
    log.push(`tailnet URL ${tailnetUrl} (published while the dev server runs — open it on your phone)`);
  } else {
    log.push('WARN:the tailnet is not ready, so this worktree is local-only. Bring the daemon up, then restart the dev server for a phone-reachable URL.');
  }

  // The ONE address handed to agents, Playwright and the app's own site config.
  //
  // The PROXY host wins when there is one, and the tailnet URL never does. That
  // ordering is not aesthetic: the site URL is an auth ORIGIN. Cookies, OAuth
  // redirect URIs and Supabase's allow-list are all keyed on it, so promoting a
  // tailnet hostname to that role silently invalidates the session the developer
  // already has and sends redirects somewhere the allow-list does not name — and
  // it does so only on the machines where the daemon happens to be up, which is
  // the worst possible way to learn it.
  //
  // The tailnet URL is a SECOND address for the same app, recorded beside this
  // one for the phone. Additional, never primary.
  const publishedUrl = baseUrl;

  // `tailnetUrl` is the sixth key rather than something a consumer re-composes
  // from `tailnet.name` and the port: the doctor compares whole plan objects,
  // and a value recorded in an env file has to be comparable against the plan
  // that produced it.
  return { directUrl, baseUrl, publishedUrl, tailnetUrl, mode, log };
}
