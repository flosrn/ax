// The address a Role browser opens on — READ, never discovered.
//
// This module is deliberately the opposite of `src/worktree/plan.mjs`. That one
// PROBES: it asks the machine which ports are free, which proxy answers, what
// Tailscale is serving, and derives a plan from the answers. Deriving anything
// here would be a second opinion about the same question, and the two would
// disagree exactly when it is most expensive: a debug session carries an
// authenticated identity, so an origin AX guessed one port off is an
// authenticated browser pointed at ANOTHER worktree's application.
//
// So R5 makes it a read. `AX_DIRECT_URL` is what `ax worktree setup` already
// recorded for this worktree; the primary checkout has no such key and uses the
// project's own `PORT`/`BASE_URL`. No port scan, no proxy request, and
// `planWorktree` is never invoked — the tests inject no prober because there is
// nothing to inject.
//
// LOOPBACK ONLY, and that is a decision with a receipt (KTD11): the artifact
// every consumer's Playwright setup mints records `http://localhost:<port>`, so
// a proxy or Tailscale origin would re-mint authentication on every alternation
// with the E2E suite. The Tailscale address is read here too, and used by
// exactly one caller — the phone callback — never by the browser.
//
// THE ONE REQUEST is `checkLive`, and it is separate on purpose: reading an
// address must not touch the network, while launching a browser at an address
// nothing answers wastes a project's whole authentication budget before
// failing. It names the declared start command and never runs it.
//
// AN ASSIGNED EMPTY VALUE IS AN ANSWER. `readConfigured` treats empty as absent
// — correct for a URL, wrong for an opt-in, because `AX_DEBUG_AS_PHONE=` in an
// app env file is how an operator spells "not here" and falling through to a
// `true` in the root file would publish a phone handoff they disabled. Hence
// `readFlag`, built on the layer-preserving `readKey` primitive, changing no
// public `src/dotenv.mjs` behavior.

import { resolve } from 'node:path';

import { readKey } from '../dotenv.mjs';
import { isMainCheckout } from '../git.mjs';
import { pathProblem } from './config.mjs';
import { scrub } from './emit.mjs';

/** The recorded keys. Names, not values: the value is the machine's, the name is the contract's. */
export const DIRECT_KEY = 'AX_DIRECT_URL';
export const TAILNET_KEY = 'AX_TAILNET_URL';

/**
 * The hosts a debug session may treat as this checkout's own.
 *
 * One set, exported, because three rules consume it — the browser origin, the
 * `storageState` envelope and the provider host — and three spellings of
 * "loopback" is how one of them ends up admitting a production cookie.
 */
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `127.0.0.0/8` in full, not just the literal every example uses. */
const isLoopbackHost = host => LOCAL_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** The env files this project's values live in, nearest first. */
const envFiles = config => {
  const web = config?.apps?.web;
  const files = [];
  if (typeof web === 'string' && web !== '' && web !== '.') files.push(`${web}/.env.local`);
  files.push('.env.local');
  return files;
};

/**
 * Every layer that ASSIGNS `name`, in precedence order, empty values kept.
 *
 * The distinction `readConfigured` collapses is the one an opt-in needs, so
 * both readers below are built from this generator rather than from each other.
 */
function* layers(name, { root, config, env }) {
  if (Object.hasOwn(env, name)) yield { at: `${name} in the environment`, value: env[name] };
  for (const file of envFiles(config)) {
    const value = readKey(resolve(root, file), name);
    if (value !== undefined) yield { at: `${name} in ${file}`, value };
  }
}

/**
 * The effective value of a project variable: process environment, then the app
 * env file, then the root one, first non-empty winning.
 *
 * The value STAYS IN AX (R27). No caller may add it to an adapter, notifier or
 * browser environment — `src/debug-as/adapter.mjs` passes the ambient
 * environment through untouched, and a project script that needs a credential
 * reads its own configuration.
 */
export function readVariable(name, { root, config, env = process.env }) {
  for (const layer of layers(name, { root, config, env })) {
    if (layer.value !== '') return layer.value;
  }
  return undefined;
}

const TRUE = new Set(['1', 'true', 'yes']);
const FALSE = new Set(['0', 'false', 'no']);

/**
 * A declared opt-in, resolved at the layer that assigns it (R15).
 *
 * Answers `{ value, at, problem, fix }`: `undefined` when no layer assigns it,
 * `false` for an assigned empty value at its own layer, and a problem naming
 * the offending spelling for anything the vocabulary does not recognize —
 * because guessing at `maybe` is how a handoff happens that nobody asked for.
 */
export function readFlag(name, { root, config, env = process.env }) {
  for (const layer of layers(name, { root, config, env })) {
    const value = layer.value.trim();
    if (value === '') return { value: false, at: layer.at, problem: '', fix: '' };
    const lower = value.toLowerCase();
    if (TRUE.has(lower)) return { value: true, at: layer.at, problem: '', fix: '' };
    if (FALSE.has(lower)) return { value: false, at: layer.at, problem: '', fix: '' };
    return {
      value: undefined,
      at: layer.at,
      problem: `is ${JSON.stringify(value)}, which is neither true nor false`,
      fix: `assign ${name}=1, true or yes to enable it, or ${name}=0, false or no to disable it`,
    };
  }
  return { value: undefined, at: name, problem: '', fix: '' };
}

/** A recorded address as an origin, or why it is not one. */
function asOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { origin: null, problem: `is ${JSON.stringify(value)}, which is not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { origin: null, problem: `declares the "${url.protocol}" scheme, and an application address is http or https` };
  if (url.username !== '' || url.password !== '') return { origin: null, problem: 'carries credentials in its authority' };
  if (url.pathname !== '/' && url.pathname !== '') return { origin: null, problem: `carries the path ${JSON.stringify(url.pathname)}, and an address is an origin alone` };
  if (url.search !== '' || url.hash !== '') return { origin: null, problem: 'carries a query or fragment, and an address is an origin alone' };
  return { origin: url.origin, problem: '', host: url.hostname };
}

/** The host component of an origin, or `null`. Bracketed IPv6 is kept as spelled. */
export function originHost(origin) {
  if (typeof origin !== 'string' || origin === '') return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * Every address a debug session may use, read from what this checkout recorded.
 *
 * `browserOrigin` is the loopback application origin, or `null` with a refusal.
 * `directOrigin` and `tailnetOrigin` are the recorded pair R16 requires before
 * a phone handoff is allowed at all — reported rather than refused here,
 * because a browser-only project adopts neither.
 *
 * `repoPaths` is the injected machine answer (AGENTS.md: a function that
 * depends on the host takes that dependency as a named option with a real
 * default), and it is the only machine question this module asks.
 */
export function readAddresses({ root, config, env = process.env, repoPaths = { isMainCheckout } }) {
  const refusals = [];
  const isWorktree = !repoPaths.isMainCheckout(root);
  const read = name => readVariable(name, { root, config, env });

  /** A recorded value graded as a loopback browser origin. */
  const loopback = (name, value) => {
    const { origin, problem, host } = asOrigin(value);
    if (origin === null) {
      refusals.push({ at: name, problem, fix: `record ${name} as an origin such as "http://localhost:3000"` });
      return null;
    }
    if (!isLoopbackHost(host)) {
      refusals.push({
        at: name,
        problem: `records ${origin}, which is not a loopback address — a Role browser opens on this checkout's own application, never on a proxy, a tailnet or production`,
        fix: `record ${name} as this checkout's own loopback address, such as "http://localhost:3000"`,
      });
      return null;
    }
    return origin;
  };

  let directOrigin = null;
  let browserOrigin = null;

  if (isWorktree) {
    const recorded = read(DIRECT_KEY);
    if (recorded === undefined) {
      refusals.push({
        at: DIRECT_KEY,
        problem: `${DIRECT_KEY} is not recorded for this worktree, and a Role browser opens only on the address this checkout already recorded — AX runs no port scan and no proxy probe`,
        fix: 'run `ax worktree setup` in this worktree so its direct address is recorded',
      });
    } else {
      directOrigin = loopback(DIRECT_KEY, recorded);
      browserOrigin = directOrigin;
    }
  } else {
    const port = read('PORT');
    const base = read('BASE_URL');
    if (port !== undefined) {
      const number = Number(port);
      if (!Number.isInteger(number) || number < 1 || number > 65535) {
        refusals.push({ at: 'PORT', problem: `is ${JSON.stringify(port)}, which is not a port number`, fix: 'record PORT as this application\'s own port, such as PORT=3000' });
      } else {
        browserOrigin = `http://localhost:${number}`;
      }
    } else if (base !== undefined) {
      browserOrigin = loopback('BASE_URL', base);
    } else {
      refusals.push({
        at: 'PORT',
        problem: 'is not recorded in this checkout, and neither is BASE_URL — the primary checkout opens on the port the project itself declares',
        fix: 'record PORT=<the port this application listens on> in .env.local, or run `ax debug-as` from a worktree created by `ax worktree setup`',
      });
    }
  }

  let tailnetOrigin = null;
  const tailnet = read(TAILNET_KEY);
  if (tailnet !== undefined) {
    const { origin, problem } = asOrigin(tailnet);
    if (origin === null) refusals.push({ at: TAILNET_KEY, problem, fix: `record ${TAILNET_KEY} as the origin Tailscale serves for this worktree, or remove it` });
    else tailnetOrigin = origin;
  }

  return { isWorktree, browserOrigin, directOrigin, tailnetOrigin, refusals };
}

/**
 * One absolute application URL, with its path re-validated at construction.
 *
 * R2 binds the rule to every path AX consumes and names this moment explicitly:
 * a declared path was graded at load, and the path serialized into a phone
 * callback is graded AGAIN here, because the value may have travelled through a
 * flag, a form field or a provider response since.
 */
export function appUrl(origin, path) {
  const problem = pathProblem(path);
  if (problem !== '') {
    throw Object.assign(new Error(`the application path ${JSON.stringify(String(path))} ${problem}`), {
      fix: 'pass an absolute path of this application, such as "/home"',
    });
  }
  return `${origin}${path}`;
}

/**
 * One bounded request proving the application answers on the address already
 * read — before a project's authentication adapter spends its whole budget.
 *
 * ANY HTTP answer is alive, including a 404 or a 500: whether the declared
 * landing path exists is the application's business, and a debug session that
 * refused on a redirect or an error page would refuse on half the projects that
 * work. What it refuses on is silence.
 *
 * It names the declared start command and NEVER runs it (R5): starting a
 * project's server is outside this feature, and a command AX ran in the
 * background is a process nobody owns.
 */
export async function checkLive({ origin, contract, fetchImpl = fetch, timeoutMs = 5000 }) {
  const start = contract?.browser?.start;
  const fix = Array.isArray(start) && start.length > 0 ? start.join(' ') : 'start this project\'s application, then run the command again';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/`, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const status = response?.status;
    try {
      await response?.body?.cancel?.();
    } catch {
      /* a mock has no body; a cancelled stream is the success path */
    }
    return { live: true, status };
  } catch (error) {
    throw Object.assign(new Error(`${origin} did not answer within ${timeoutMs} ms (${scrub(String(error?.message ?? error))}), so there is nothing to open a Role browser on`), { fix });
  } finally {
    clearTimeout(timer);
  }
}
