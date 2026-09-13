// Machine Phone relay ownership: one generation, one worktree, one mapping.
//
// Distinct from the worktree Browser receipt (`src/debug-as/receipt.mjs`). The
// last completed publication wins, and only its process generation may change
// or withdraw it (R17). A surviving mapping otherwise forwards the tailnet to
// whatever local process next binds that released ephemeral port — so every
// launch and every `doctor` run withdraws a mapping whose owner is proven dead
// before anything else binds.
//
// Reads never throw: absent OR malformed is `null`, never an owner. Writes are
// exclusive temp + fsync + atomic rename, mode 0600. Cleanup never signals a
// process.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { processStart } from './receipt.mjs';
import { withdrawServe } from './tailscale.mjs';

/** Proof of life, not permission: EPERM is another user's live process. */
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const FILENAME = 'debug-as-relay.json';
const VERSION = 1;

const KEYS = [
  'version',
  'generation',
  'host',
  'pid',
  'processStart',
  'port',
  'serveHost',
  'serveTarget',
  'project',
  'worktree',
  'identity',
  'path',
  'publishedAt',
];

const configDir = ({ home = homedir(), env = process.env } = {}) => {
  const base = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(base, 'ax');
};

export function relayReceiptPath({ home = homedir(), env = process.env } = {}) {
  return join(configDir({ home, env }), FILENAME);
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== VERSION) return null;
  for (const key of KEYS) {
    if (!(key in raw)) return null;
  }
  if (typeof raw.generation !== 'string' || raw.generation === '') return null;
  if (typeof raw.host !== 'string' || raw.host === '') return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.processStart !== 'string') return null;
  if (!Number.isInteger(raw.port) || raw.port <= 0) return null;
  if (typeof raw.serveHost !== 'string' || raw.serveHost === '') return null;
  if (typeof raw.serveTarget !== 'string' || raw.serveTarget === '') return null;
  if (typeof raw.worktree !== 'string' || raw.worktree === '') return null;
  return raw;
}

export function readRelayReceipt({ home = homedir(), env = process.env, path = relayReceiptPath({ home, env }) } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
  return parse(text);
}

function atomicWrite(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed, or never created.
    }
  }
}

export function publishRelayReceipt(record, { home = homedir(), env = process.env, path = relayReceiptPath({ home, env }) } = {}) {
  const written = { version: VERSION, ...record, version: VERSION };
  atomicWrite(path, written);
  return written;
}

/**
 * Remove the receipt only when it still carries `generation`. An old owner
 * calling this after a newer publication is a no-op.
 */
export function clearRelayReceipt({ home = homedir(), env = process.env, path = relayReceiptPath({ home, env }), generation } = {}) {
  const current = readRelayReceipt({ home, env, path });
  if (current === null) return false;
  if (generation !== undefined && current.generation !== generation) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

export function relayOwnedBy(record, { root, generation } = {}) {
  if (record === null || record === undefined) return false;
  return record.worktree === root && record.generation === generation;
}

export function relayUrl(record) {
  if (record === null || record === undefined) return null;
  return `https://${record.serveHost}:${record.port}/go?g=${record.generation}`;
}

/**
 * Classify the recorded owner without mutating anything.
 *
 * `live` = same host, pid alive, start identity matches.
 * `dead-owner` = same host and (pid gone OR start identity differs).
 * `ambiguous` = same host, pid alive, start identity unreadable.
 * `other-host` = recorded host is not this one.
 * `absent` = no receipt.
 */
export function relayOwnership(record, { host, alive, start } = {}) {
  if (record === null || record === undefined) return 'absent';
  if (typeof host === 'string' && record.host !== host) return 'other-host';
  const pidAlive = typeof alive === 'function' ? alive(record.pid) : false;
  if (!pidAlive) return 'dead-owner';
  const identity = typeof start === 'function' ? start(record.pid) : null;
  if (identity === null || identity === undefined) return 'ambiguous';
  if (identity !== record.processStart) return 'dead-owner';
  return 'live';
}

/**
 * Withdraw a proven-dead owner's Serve mapping and clear its receipt. Safe to
 * call from launch and doctor before any bind. Never signals a process; never
 * touches a live or ambiguous owner.
 */
export function sweepDeadRelay({
  home = homedir(),
  env = process.env,
  path = relayReceiptPath({ home, env }),
  host = hostname(),
  alive = pidAlive,
  start = processStart,
  run,
} = {}) {
  const record = readRelayReceipt({ home, env, path });
  const reason = relayOwnership(record, { host, alive, start });
  if (reason === 'absent') return { withdrawn: false, reason: 'absent' };
  if (reason !== 'dead-owner') return { withdrawn: false, reason };
  withdrawServe({ port: record.port, run });
  clearRelayReceipt({ home, env, path, generation: record.generation });
  return { withdrawn: true, reason: 'dead-owner' };
}
