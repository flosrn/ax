// Tailscale Serve as data, never as prose.
//
// `serve --bg` mappings SURVIVE process exit and reboot (Tailscale's own CLI
// reference says so). An abandoned mapping keeps forwarding the tailnet to
// whatever local process next binds that released ephemeral port. So the
// mapping is read from `serve status --json`, an unowned or Funnel-mapped
// collision refuses while naming the exact withdrawal command, and withdrawal
// is a command AX issues rather than a state it hopes for.
//
// The documented background publish is `tailscale serve --bg --https=<port>
// <target>`; its inverse is `tailscale serve --https=<port> off`. Human prose
// from `serve status` without `--json` is never parsed.

import { run as defaultRun } from '../exec.mjs';
import { scrub } from './emit.mjs';

const DEADLINE = 15000;

const refuse = (problem, fix, extra = {}) => Object.assign(new Error(scrub(problem)), { problem, fix, ...extra });

const invoke = (run, args) => run('tailscale', args, { timeout: DEADLINE });

const missing = error => error?.code === 'ENOENT' || /enoent/i.test(String(error?.message ?? ''));

const asJson = (stdout, what) => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw refuse(
      `tailscale ${what} did not print JSON, so AX cannot treat Serve as data`,
      'upgrade Tailscale, or run `tailscale serve status --json` by hand and fix whatever is printing prose',
    );
  }
};

/**
 * The repair every unowned-collision refusal names, and the command the owner
 * issues on ordinary exit.
 */
export function withdrawCommand(port) {
  return `tailscale serve --https=${port} off`;
}

/** Loopback HTTP targets only: Serve on this machine, never a neighbour. */
const LOOPBACK_TARGET = /^https?:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d+)?(?:\/.*)?$/i;

/**
 * Parse `tailscale serve status --json` into one mapping per HTTPS port.
 *
 * Tailscale's ServeConfig keys Web handlers as `<host>:<port>` (or `localhost`
 * when no MagicDNS name is known). Ownership is decided on port and target, so
 * the host spelling is recorded rather than compared.
 */
export function readServe({ run = (bin, args) => defaultRun(bin, args, { timeout: DEADLINE }) } = {}) {
  const out = invoke(run, ['serve', 'status', '--json']);
  if (missing(out.error) || (out.status === null && missing(out.error))) {
    throw refuse('tailscale is not installed, so AX cannot publish or inspect a Phone relay mapping', 'install Tailscale and sign in to this machine\'s tailnet');
  }
  if (out.status !== 0) {
    throw refuse(
      `tailscale serve status --json exited ${out.status ?? 'without a status'}${out.stderr ? `: ${scrub(out.stderr.trim())}` : ''}`,
      'install Tailscale, sign in, and retry',
    );
  }
  const parsed = asJson(out.stdout || '{}', 'serve status --json');
  const web = isObject(parsed.Web) ? parsed.Web : {};
  const funnel = isObject(parsed.AllowFunnel) ? parsed.AllowFunnel : {};
  const mappings = [];
  for (const [hostPort, entry] of Object.entries(web)) {
    const colon = hostPort.lastIndexOf(':');
    const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
    const port = colon === -1 ? NaN : Number(hostPort.slice(colon + 1));
    if (!Number.isInteger(port)) continue;
    const handlers = isObject(entry?.Handlers) ? entry.Handlers : {};
    const root = isObject(handlers['/']) ? handlers['/'] : {};
    const target = typeof root.Proxy === 'string' ? root.Proxy : null;
    mappings.push({ hostPort, host, port, target, funnel: funnel[hostPort] === true });
  }
  return { mappings };
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The mapping on `port`, or `null`. */
export function findMapping(state, port) {
  return state?.mappings?.find(mapping => mapping.port === port) ?? null;
}

export function publishServe({ port, target, run = (bin, args) => defaultRun(bin, args, { timeout: DEADLINE }) }) {
  if (typeof target !== 'string' || !LOOPBACK_TARGET.test(target)) {
    throw refuse(
      `Serve target ${JSON.stringify(target)} is not a loopback HTTP URL, and Serve proxies only to this machine`,
      'point Tailscale Serve at http://127.0.0.1:<the relay port>',
    );
  }
  const out = invoke(run, ['serve', '--bg', `--https=${port}`, target]);
  if (out.status !== 0) {
    throw refuse(
      `could not publish Tailscale Serve on port ${port}${out.stderr ? `: ${scrub(out.stderr.trim())}` : ''}`,
      withdrawCommand(port),
    );
  }
}

export function withdrawServe({ port, run = (bin, args) => defaultRun(bin, args, { timeout: DEADLINE }) }) {
  const out = invoke(run, ['serve', `--https=${port}`, 'off']);
  if (out.status !== 0) {
    throw refuse(
      `could not withdraw Tailscale Serve on port ${port}${out.stderr ? `: ${scrub(out.stderr.trim())}` : ''}`,
      withdrawCommand(port),
    );
  }
}

/**
 * This node's MagicDNS name, trailing dot stripped. Used as the Serve hostname
 * the phone types and the `Host` the relay accepts.
 */
export function tailnetHost({ run = (bin, args) => defaultRun(bin, args, { timeout: DEADLINE }) } = {}) {
  const out = invoke(run, ['status', '--json']);
  if (missing(out.error) || (out.status === null && missing(out.error))) {
    throw refuse('tailscale is not installed, so AX cannot name this node on the tailnet', 'install Tailscale and sign in to this machine\'s tailnet');
  }
  if (out.status !== 0) {
    throw refuse(
      `tailscale status --json exited ${out.status ?? 'without a status'}`,
      'sign in with `tailscale up` and retry',
    );
  }
  const parsed = asJson(out.stdout || '{}', 'status --json');
  const name = parsed?.Self?.DNSName;
  if (typeof name !== 'string' || name.trim() === '') {
    throw refuse('this node has no MagicDNS name, so AX cannot compose a Phone relay URL', 'enable MagicDNS on the tailnet and retry `tailscale status`');
  }
  return name.replace(/\.$/, '');
}
