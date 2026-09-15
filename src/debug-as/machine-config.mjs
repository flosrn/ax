// The machine-private Phone relay contract: absent by default, proven on one
// descriptor, parsed once.
//
// R33 is a security rule, not a convenience. The allowlist, the port and the
// notifier argv decide who may mint an authenticated phone session on this
// machine. A file another user can write, or one that can be swapped after
// validation, would decide that instead — so AX opens the path once, proves on
// that descriptor that the file and its parents are owned by the invoking user,
// are not symlinks and are not group- or other-writable, and uses the parsed
// value for the process lifetime.
//
// Absence is not a refusal: a machine that has not enabled Phone handoff is
// the default, and `ax doctor` must be able to say so. An unsafe or malformed
// file is the opposite — it looks like a contract and must not be treated as
// one.

import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { scrub } from './emit.mjs';

const FILENAME = 'debug-as.json';
const KNOWN = new Set(['relayPort', 'allowedTailscaleLogins', 'allowedSupabaseHosts', 'notifier']);

/** Non-privileged, non-ephemeral: 1024 through 49151. */
const PORT_MIN = 1024;
const PORT_MAX = 49151;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const refuse = (at, problem, fix) => Object.assign(new Error(scrub(`${at} ${problem}`)), { at, problem, fix });

/** Successful loads, keyed by the proven path, so a later swap cannot change the allowlist. */
const memo = new Map();

/**
 * Where the machine contract lives: `$XDG_CONFIG_HOME/ax/debug-as.json`, else
 * `~/.config/ax/debug-as.json`.
 */
export function machineConfigPath({ home = homedir(), env = process.env } = {}) {
  const base = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(base, 'ax', FILENAME);
}

const uidOf = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/** Group- or other-writable: anyone in those classes could replace the file. */
const worldWritable = mode => (mode & 0o022) !== 0;

/** Anything but owner-only bits on the contract itself. */
const notPrivate = mode => (mode & 0o077) !== 0;

const freezeDeep = value => {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
};

/**
 * Prove `path` and every parent up to (not including) `stop` are owned, not
 * symlinks, and not group- or other-writable. The contract file itself must
 * also be a regular file with owner-only mode.
 */
function proveTree(path, stop) {
  let cursor = path;
  const uid = uidOf();
  while (true) {
    let st;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT' && cursor === path) return { present: false };
      throw refuse(cursor, `could not be read (${error?.code ?? error})`, `create ${path} owned by this user with mode 600, in directories of mode 700`);
    }
    if (st.isSymbolicLink()) {
      throw refuse(cursor, 'is a symlink, and the machine contract is never followed through a link', `replace the symlink with a regular file owned by this user`);
    }
    if (cursor === path) {
      if (!st.isFile()) throw refuse(FILENAME, 'is not a regular file', `write ${path} as a regular file with mode 600`);
      if (notPrivate(st.mode)) throw refuse(FILENAME, `is mode ${(st.mode & 0o777).toString(8)}, which is readable or writable by someone other than this user`, `chmod 600 ${path}`);
    } else {
      if (!st.isDirectory()) throw refuse(cursor, 'is not a directory', `restore ${cursor} as a directory owned by this user with mode 700`);
      if (worldWritable(st.mode)) throw refuse(cursor, `is mode ${(st.mode & 0o777).toString(8)}, which is writable by someone other than this user — they could replace the contract`, `chmod 700 ${cursor}`);
    }
    if (uid !== undefined && st.uid !== uid) {
      throw refuse(cursor, 'is not owned by the invoking user', `chown this path to the user that runs ax`);
    }
    const parent = dirname(cursor);
    if (parent === cursor || cursor === stop || parent === stop) break;
    cursor = parent;
  }
  return { present: true };
}

const EMAIL = /^[^\s@,*;]+@[^\s@,*;]+$/;

function parseLogins(value) {
  if (!Array.isArray(value)) throw refuse('allowedTailscaleLogins', 'is not an array of exact Tailscale logins', 'declare "allowedTailscaleLogins" as a non-empty array of exact logins, such as ["operator@example.com"]');
  if (value.length === 0) throw refuse('allowedTailscaleLogins', 'is empty, and an empty allowlist would mint a session for nobody and refuse everybody', 'add at least one exact Tailscale login');
  const seen = new Set();
  const allowedLogins = [];
  for (const [index, raw] of value.entries()) {
    const at = `allowedTailscaleLogins[${index}]`;
    if (typeof raw !== 'string') throw refuse(at, `is ${typeof raw}, not a string`, 'use an exact login such as "operator@example.com"');
    const login = raw.trim().toLowerCase();
    if (login === '') throw refuse(at, 'is empty', 'use an exact login such as "operator@example.com"');
    if (login.includes('*') || login.includes(',')) throw refuse(at, 'contains a wildcard or a comma, and the allowlist is exact-login only — a comma-joined header is refused at the relay, not parsed here', 'list each login as its own array entry');
    if (!EMAIL.test(login)) throw refuse(at, `is ${JSON.stringify(raw.trim())}, which is not an exact login`, 'use an exact Tailscale login such as "operator@example.com"');
    if (seen.has(login)) throw refuse(at, `duplicates ${JSON.stringify(login)} after lowercase normalization`, 'list each login once');
    seen.add(login);
    allowedLogins.push(login);
  }
  return allowedLogins;
}

const HOSTPORT = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\])(?::(\d+))?$/;

function parseHosts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw refuse('allowedSupabaseHosts', 'is not an array', 'declare "allowedSupabaseHosts" as an array of "host" or "host:port" entries, or omit it');
  const seen = new Set();
  const allowedSupabaseHosts = [];
  for (const [index, raw] of value.entries()) {
    const at = `allowedSupabaseHosts[${index}]`;
    if (typeof raw !== 'string' || raw.trim() === '') throw refuse(at, 'is empty', 'use an exact host or host:port, such as "supabase.example.ts.net:8443"');
    if (raw.includes('*') || raw.includes('/') || /:\/\//.test(raw) || raw.includes('?')) {
      throw refuse(at, 'is not an exact host:port — a scheme, a path, a wildcard or a suffix is never a match', 'use an exact host or host:port, such as "supabase.example.ts.net:8443"');
    }
    const match = HOSTPORT.exec(raw.trim());
    if (!match) throw refuse(at, `is ${JSON.stringify(raw)}, which is not an exact host or host:port`, 'use an exact host or host:port, such as "supabase.example.ts.net:8443"');
    const host = match[1];
    const port = match[2] === undefined ? 443 : Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw refuse(at, 'does not name a port', 'use an exact host:port');
    const key = `${host.toLowerCase()}:${port}`;
    if (seen.has(key)) throw refuse(at, `duplicates ${host}:${port}`, 'list each host and port once');
    seen.add(key);
    allowedSupabaseHosts.push({ host, port });
  }
  return allowedSupabaseHosts;
}

function parseNotifier(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw refuse('notifier', 'is not an object', 'declare "notifier": { "command": ["private-notifier"] }, or omit it');
  for (const key of Object.keys(value)) {
    if (key !== 'command') throw refuse(`notifier.${key}`, 'is not a known notifier field', 'declare only "command" under "notifier"');
  }
  const command = value.command;
  if (!Array.isArray(command) || command.length === 0) throw refuse('notifier.command', 'is empty, and AX runs the notifier without a shell', 'declare "notifier.command" as a non-empty argv array');
  for (const [index, part] of command.entries()) {
    if (typeof part !== 'string' || part === '') throw refuse(`notifier.command[${index}]`, 'is not a non-empty string', 'declare "notifier.command" as an argv array of strings');
  }
  return { command: [...command] };
}

function parseContract(text, path) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refuse(FILENAME, 'is not JSON', `rewrite ${path} as a JSON object with "relayPort" and "allowedTailscaleLogins"`);
  }
  if (!isObject(raw)) throw refuse(FILENAME, `is ${Array.isArray(raw) ? 'an array' : typeof raw}, not an object`, `rewrite ${path} as a JSON object with "relayPort" and "allowedTailscaleLogins"`);
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) throw refuse(key, 'is not a known machine-contract field — a silently ignored key is a security setting nobody applied', `remove "${key}" from ${path}`);
  }
  const relayPort = raw.relayPort;
  if (!Number.isInteger(relayPort) || relayPort < PORT_MIN || relayPort > PORT_MAX) {
    throw refuse(
      'relayPort',
      relayPort === undefined ? 'is missing' : `is ${JSON.stringify(relayPort)}, which is not a non-privileged, non-ephemeral port`,
      `set "relayPort" to an integer from ${PORT_MIN} through ${PORT_MAX}, such as 1300`,
    );
  }
  return freezeDeep({
    relayPort,
    allowedLogins: parseLogins(raw.allowedTailscaleLogins),
    allowedSupabaseHosts: parseHosts(raw.allowedSupabaseHosts),
    notifier: parseNotifier(raw.notifier),
  });
}

/**
 * Load the machine contract once, prove it, and remember the parsed value.
 *
 * Absent file → `{ present: false, config: null }`. Unsafe or invalid → throws
 * `Error` with `.at`, `.problem`, `.fix`. `reload: true` bypasses the memo
 * (tests); production callers omit it.
 */
export function loadMachineConfig({ home = homedir(), env = process.env, path = machineConfigPath({ home, env }), reload = false } = {}) {
  if (!reload && memo.has(path)) return memo.get(path);

  const stop = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config');
  const proof = proveTree(path, dirname(stop) === stop ? stop : dirname(stop) === home ? stop : home);
  if (!proof.present) {
    const answer = { present: false, path, config: null };
    if (!reload) memo.set(path, answer);
    return answer;
  }

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(path, flags);
    const st = fstatSync(fd);
    if (!st.isFile()) throw refuse(FILENAME, 'is not a regular file', `write ${path} as a regular file with mode 600`);
    if (notPrivate(st.mode)) throw refuse(FILENAME, `is mode ${(st.mode & 0o777).toString(8)}, which is readable or writable by someone other than this user`, `chmod 600 ${path}`);
    const uid = uidOf();
    if (uid !== undefined && st.uid !== uid) throw refuse(FILENAME, 'is not owned by the invoking user', `chown ${path} to the user that runs ax`);
    const text = readFileSync(fd, 'utf8');
    const config = parseContract(text, path);
    const answer = { present: true, path, config };
    memo.set(path, answer);
    return answer;
  } catch (error) {
    if (error?.at) throw error;
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      throw refuse(FILENAME, 'is a symlink, and the machine contract is never followed through a link', `replace the symlink with a regular file owned by this user`);
    }
    throw refuse(FILENAME, `could not be read (${error?.code ?? error.message ?? error})`, `create ${path} owned by this user with mode 600`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
