// Who owns the Role browser of this worktree.
//
// A receipt is an authorization, not a cache: every mutation in this feature
// is issued against it. Host, process-start identity and a random generation
// together prove the recorded pid is still the process that published, so a
// recycled pid cannot authorize a sibling to close, reuse or drive a window
// it does not own. Chromium identity is recorded separately so ordinary
// maintenance can spare the live root without signalling the Node owner.
//
// Writes are exclusive-temp + fsync + atomic rename, mode 0600, in the
// destination directory. Reads never follow a symlink. Nothing here prints.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { pathProblem } from './config.mjs';
import { lockOwnerState, worktreeLockPath } from './lock.mjs';

export const BROWSER_RECEIPT = '.agent/debug-as.local.json';

export const browserReceiptPath = root => join(root, BROWSER_RECEIPT);

export const newGeneration = () => randomBytes(16).toString('hex');

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Stable start-identity token for `pid`. `ps -o lstart=` only — elapsed
 * columns change every second and would make every receipt look recycled.
 */
export function processStart(pid, { ps } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const run =
    ps ??
    (args => {
      const result = spawnSync('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return result.stdout ?? '';
    });
  const token = String(run(['-o', 'lstart=', '-p', String(pid)]) ?? '')
    .trim()
    .split('\n')[0]
    ?.trim();
  return token || null;
}

const defaultIgnored = (root, relative) => {
  const result = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', relative], { stdio: 'ignore' });
  return result.status === 0;
};

export function ignoredReceipt(root, { ignored = defaultIgnored } = {}) {
  return ignored(root, BROWSER_RECEIPT);
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseReceipt = value => {
  if (!isObject(value) || value.version !== 1) return null;
  if (typeof value.generation !== 'string' || !/^[0-9a-f]{32}$/.test(value.generation)) return null;
  if (typeof value.host !== 'string' || value.host === '') return null;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.processStart !== 'string' || value.processStart === '') return null;
  if (!Number.isInteger(value.chromiumPid) || value.chromiumPid <= 0) return null;
  if (typeof value.chromiumStart !== 'string' || value.chromiumStart === '') return null;
  if (typeof value.identity !== 'string' || typeof value.origin !== 'string') return null;
  if (typeof value.path !== 'string' || !Number.isInteger(value.cdpPort) || value.cdpPort <= 0) return null;
  if (typeof value.sessionName !== 'string') return null;
  if (value.device !== null && typeof value.device !== 'string') return null;
  if (value.viewport !== null && !(isObject(value.viewport) && Number.isInteger(value.viewport.width) && Number.isInteger(value.viewport.height))) {
    return null;
  }
  return value;
};

const symlinkKind = root => {
  const dir = join(root, '.agent');
  const file = browserReceiptPath(root);
  try {
    if (lstatSync(dir).isSymbolicLink()) return 'directory';
  } catch (error) {
    if (error.code !== 'ENOENT') return 'directory';
  }
  try {
    if (lstatSync(file).isSymbolicLink()) return 'file';
  } catch (error) {
    if (error.code !== 'ENOENT') return 'file';
  }
  return null;
};

const atomicWrite = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
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
};

const ownerState = (receipt, { host, alive, start }) => {
  if (receipt.host !== host) return 'ambiguous';
  if (!alive(receipt.pid)) return 'dead';
  const token = start(receipt.pid);
  if (token === null) return 'ambiguous';
  return token === receipt.processStart ? 'live' : 'dead';
};

const repairFor = (at, problem, fix) => ({ at, problem, fix });

/**
 * `{ state, receipt, refusal }` where state is
 * absent | malformed | unsafe | live | dead | ambiguous.
 */
export function readReceipt(
  root,
  { host = hostname(), alive = pidAlive, start = processStart, read = readFileSync } = {},
) {
  const path = browserReceiptPath(root);
  const linked = symlinkKind(root);
  if (linked !== null) {
    try {
      lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT' && linked !== 'directory') {
        // No receipt file yet; a linked parent is still unsafe for a write, but
        // a read of nothing is absence. Directory links are unsafe even empty.
      } else {
        return {
          state: 'unsafe',
          receipt: null,
          refusal: repairFor(path, 'is reached through a symlink, which a receipt will not follow', `remove the symlink at ${linked === 'directory' ? join(root, '.agent') : path}`),
        };
      }
    }
    if (linked === 'directory' && existsSync(path)) {
      return {
        state: 'unsafe',
        receipt: null,
        refusal: repairFor(path, 'is reached through a symlink, which a receipt will not follow', `remove the symlink at ${join(root, '.agent')}`),
      };
    }
    if (linked === 'file') {
      return {
        state: 'unsafe',
        receipt: null,
        refusal: repairFor(path, 'is a symlink, which a receipt will not follow', `remove the symlink at ${path}`),
      };
    }
  }

  let raw;
  try {
    raw = read(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', receipt: null, refusal: null };
    return {
      state: 'malformed',
      receipt: null,
      refusal: repairFor(path, 'cannot be read', `remove ${path} after proving no Role browser still holds it`),
    };
  }

  let parsed;
  try {
    parsed = parseReceipt(JSON.parse(raw));
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    return {
      state: 'malformed',
      receipt: null,
      refusal: repairFor(path, 'is not a version-1 Browser receipt', `remove ${path} after proving no Role browser still holds it`),
    };
  }
  return { state: ownerState(parsed, { host, alive, start }), receipt: parsed, refusal: null };
}

const validateFields = fields => {
  if (!Number.isInteger(fields?.chromiumPid) || fields.chromiumPid <= 0) {
    return repairFor('chromiumPid', 'is missing — a Role browser that cannot name its Chromium root cannot be protected from maintenance', 'wait for chromiumRoot({ cdpPort }) after the CDP proof, then publish; a miss closes Chromium instead');
  }
  if (fields.device != null && fields.viewport != null) {
    return repairFor('device', 'and viewport are both set — they are mutually exclusive', 'pass a Playwright device or a desktop viewport, not both');
  }
  if (!Number.isInteger(fields.cdpPort) || fields.cdpPort <= 0) {
    return repairFor('cdpPort', 'is missing', 'publish only after the CDP probe names the loopback port');
  }
  if (typeof fields.generation !== 'string' || !/^[0-9a-f]{32}$/.test(fields.generation)) {
    return repairFor('generation', 'is not a 32-hex generation', 'call newGeneration()');
  }
  const problem = pathProblem(fields.path);
  if (problem !== '') return repairFor('path', `declares a path that ${problem}`, 'use an absolute same-origin path such as "/home"');
  return null;
};

export function publishReceipt(
  { root, fields },
  { host = hostname(), pid = process.pid, start = processStart, now = () => new Date().toISOString(), ignored = defaultIgnored, alive = pidAlive } = {},
) {
  const path = browserReceiptPath(root);
  const invalid = validateFields(fields);
  if (invalid) return { ok: false, refusal: invalid };

  const linked = symlinkKind(root);
  if (linked !== null) {
    return {
      ok: false,
      refusal: repairFor(
        path,
        linked === 'directory' ? 'sits under a symlinked .agent directory, which a receipt will not follow' : 'is a symlink, which a receipt will not follow',
        `remove the symlink at ${linked === 'directory' ? join(root, '.agent') : path}`,
      ),
    };
  }

  if (!ignored(root, BROWSER_RECEIPT)) {
    return {
      ok: false,
      refusal: repairFor(
        path,
        'is not ignored by Git — a receipt is local authorization and must never be committed',
        'ax init   # writes the managed .gitignore block that covers .agent/debug-as.local.json',
      ),
    };
  }

  const existing = readReceipt(root, { host, alive, start });
  if (existing.state === 'live' && existing.receipt.generation !== fields.generation) {
    return {
      ok: false,
      refusal: repairFor(
        path,
        `is held by live identity ${existing.receipt.identity} pid ${existing.receipt.pid} generation ${existing.receipt.generation}`,
        `ax debug-as drive -- snapshot   # use the live window, or close it before opening another`,
      ),
    };
  }
  if (existing.state === 'ambiguous' || existing.state === 'unsafe') {
    const who = existing.receipt ? `${existing.receipt.host} pid ${existing.receipt.pid}` : 'an unverifiable owner';
    return {
      ok: false,
      refusal: existing.refusal ?? repairFor(path, `belongs to ${who} and cannot be proven stale`, `prove that owner is gone, then remove ${path}`),
    };
  }

  const processStartToken = start(pid);
  const chromiumStart = start(fields.chromiumPid);
  if (!processStartToken || !chromiumStart) {
    return {
      ok: false,
      refusal: repairFor(path, 'cannot read a process-start identity for the owner or the Chromium root', 'retry after Chromium is running; a miss closes Chromium instead of publishing'),
    };
  }

  const receipt = {
    version: 1,
    generation: fields.generation,
    host,
    pid,
    processStart: processStartToken,
    chromiumPid: fields.chromiumPid,
    chromiumStart,
    project: fields.project,
    worktree: fields.worktree,
    identity: fields.identity,
    origin: fields.origin,
    path: fields.path,
    device: fields.device ?? null,
    viewport: fields.viewport ?? null,
    cdpPort: fields.cdpPort,
    sessionName: fields.sessionName,
    publishedAt: now(),
  };
  atomicWrite(path, receipt);
  return { ok: true, receipt, path };
}

export function updateReceiptPath(root, { generation, path: next }, deps = {}) {
  const problem = pathProblem(next);
  if (problem !== '') {
    return {
      updated: false,
      receipt: null,
      refusal: repairFor(browserReceiptPath(root), `cannot move to a path that ${problem}`, 'use an absolute same-origin path such as "/settings"'),
    };
  }
  const current = readReceipt(root, deps);
  if (current.state !== 'live' || current.receipt.generation !== generation) {
    return {
      updated: false,
      receipt: current.receipt,
      refusal:
        current.refusal ??
        repairFor(
          browserReceiptPath(root),
          current.state === 'live' ? 'belongs to another generation' : `is ${current.state}, not a live owner of this generation`,
          'only the live owner may change the path; close and reopen if the receipt is gone',
        ),
    };
  }
  const receipt = { ...current.receipt, path: next };
  atomicWrite(browserReceiptPath(root), receipt);
  return { updated: true, receipt, refusal: null };
}

export function removeReceipt(root, { generation, proven = false } = {}, deps = {}) {
  const path = browserReceiptPath(root);
  const current = readReceipt(root, deps);
  if (current.state === 'absent') return { removed: false, reason: 'no receipt' };
  const own = current.receipt?.generation === generation;
  const dead = current.state === 'dead';
  if (!own && !(proven && dead)) {
    return { removed: false, reason: current.state === 'live' ? 'live owner' : current.state };
  }
  try {
    unlinkSync(path);
    return { removed: true, reason: own ? 'own generation' : 'proven dead' };
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, reason: 'no receipt' };
    return { removed: false, reason: String(error.message ?? error) };
  }
}

const defaultOpen = async (url, { timeoutMs = 2000 } = {}) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
};

export async function probeCdp(port, { open = defaultOpen, timeoutMs = 2000 } = {}) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const response = await open(url, { timeoutMs });
    if (response && (response.ok === true || response.status === 200)) return { alive: true, why: 'ok' };
    return { alive: false, why: `status ${response?.status ?? 'unknown'}` };
  } catch (error) {
    return { alive: false, why: String(error.message ?? error) };
  }
}

const PORT_EQUALS = port => new RegExp(`(?:^|\\s)--remote-debugging-port=${port}(?:\\s|$)`);
const PORT_SPLIT = port => new RegExp(`(?:^|\\s)--remote-debugging-port\\s+${port}(?:\\s|$)`);

const defaultPsRows = () => {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (out.error || out.status !== 0) return [];
  const rows = [];
  for (const line of String(out.stdout ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({ pid, ppid, args: parts.slice(2).join(' ') });
  }
  return rows;
};

/**
 * The single-pass Chromium ROOT row for this CDP port, or null. Matches both
 * `--remote-debugging-port=<n>` and `--remote-debugging-port <n>`.
 * A renderer whose parent is also a match is not a root.
 */
const chromiumRowFor = ({ cdpPort, ps }) => {
  if (!Number.isInteger(cdpPort) || cdpPort <= 0) return null;
  const rows = typeof ps === 'function' ? ps() : defaultPsRows();
  const matches = (rows ?? []).filter(row => PORT_EQUALS(cdpPort).test(row.args) || PORT_SPLIT(cdpPort).test(row.args));
  if (matches.length === 0) return null;
  const pids = new Set(matches.map(row => row.pid));
  return matches.find(row => !pids.has(row.ppid)) ?? null;
};

/** The pid of that root, which is what the receipt records. */
export function chromiumPidFor({ cdpPort, ps } = {}) {
  return chromiumRowFor({ cdpPort, ps })?.pid ?? null;
}

/**
 * `{ pid, start, args }` for the Chromium this launch started, or null within
 * the deadline.
 *
 * `args` is the REAL command line of the process, tokenized — the launcher
 * proves R13's forbidden flags against it, and a flag hidden inside a default
 * argument list Playwright chose is only visible here. `ps` collapses runs of
 * whitespace, so an argument containing a space is split; every forbidden flag
 * is a single token, and the check errs towards seeing more tokens, never fewer.
 */
export async function chromiumRoot({
  cdpPort,
  deadlineMs = 5000,
  now = Date.now,
  sleep = sleepSync,
  ps,
  start = processStart,
} = {}) {
  const begun = now();
  for (;;) {
    const row = chromiumRowFor({ cdpPort, ps });
    if (row && Number.isInteger(row.pid)) {
      const token = start(row.pid);
      if (token) return { pid: row.pid, start: token, args: String(row.args ?? '').split(/\s+/).filter(Boolean) };
    }
    if (now() - begun >= deadlineMs) return null;
    sleep(20);
  }
}

const findReceiptRoot = cwd => {
  if (!cwd) return null;
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, BROWSER_RECEIPT))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/**
 * Does this worktree hold a Browser receipt maintenance must spare? `claimed`
 * covers live AND unverifiable owners: only a receipt this host can DISPROVE
 * authorizes touching anything. Signalling a process still needs the pid+start
 * proof `claimForProcess` makes — a recorded pid alone can have changed hands.
 */
export function liveBrowserClaim(root, deps = {}) {
  const current = readReceipt(root, deps);
  const claimed = current.state === 'live' || current.state === 'ambiguous';
  return {
    claimed,
    pid: current.receipt?.pid ?? null,
    chromiumPid: current.receipt?.chromiumPid ?? null,
    cdpPort: current.receipt?.cdpPort ?? null,
    receipt: current.receipt,
    root,
    state: current.state,
  };
}

/**
 * Is this OS process the Chromium root of a live Browser receipt found by
 * walking up from its cwd? Matching is pid + start identity, never the CDP
 * port alone.
 */
export function claimForProcess({ pid, cwd } = {}, deps = {}) {
  const root = findReceiptRoot(cwd);
  if (root === null) return { claimed: false, root: null, receipt: null, why: 'no receipt above cwd' };
  const current = readReceipt(root, deps);
  if (!current.receipt) return { claimed: false, root, receipt: null, why: current.state };
  if (current.state !== 'live' && current.state !== 'ambiguous') return { claimed: false, root, receipt: current.receipt, why: current.state };
  if (current.receipt.chromiumPid !== pid) return { claimed: false, root, receipt: current.receipt, why: 'another pid holds this receipt' };
  const token = (deps.start ?? processStart)(pid);
  if (token !== current.receipt.chromiumStart) return { claimed: false, root, receipt: current.receipt, why: 'this pid was recycled since the receipt' };
  return { claimed: true, root, receipt: current.receipt, why: 'chromium root of a live receipt' };
}

/**
 * Reap the debug state of a session this host can PROVE is gone: the receipt
 * and the transition lock beside it. Every other answer is spared.
 *
 * The two files are proven separately, because they exist separately. A launch
 * in flight holds the lock BEFORE it publishes a receipt, so "no receipt" says
 * nothing about the lock — deleting it there is how two Chromiums get minted
 * for one worktree. A malformed receipt is left for the operator: nobody can
 * say whose window it describes, and `ax debug-as doctor` names the repair.
 */
export function sweepDeadBrowserState(root, deps = {}) {
  const current = readReceipt(root, deps);
  if (current.state === 'live' || current.state === 'ambiguous' || current.state === 'unsafe') {
    return { removed: [], spared: true };
  }

  const removed = [];
  if (current.state === 'dead') {
    const gone = removeReceipt(root, { generation: current.receipt.generation, proven: true }, deps);
    if (gone.removed) removed.push(browserReceiptPath(root));
  }

  const lock = worktreeLockPath(root);
  const holder = lockOwnerState(lock, {
    host: deps.host ?? hostname(),
    alive: deps.alive ?? pidAlive,
    start: deps.start ?? processStart,
  });
  if (holder === 'dead') {
    try {
      unlinkSync(lock);
      removed.push(lock);
    } catch {
      // Released between the proof and the unlink.
    }
  }
  return { removed, spared: false };
}
