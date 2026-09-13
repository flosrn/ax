// Exclusive ownership of one debug-as transition — worktree or machine.
//
// A receipt is the AUTHORIZATION; this file is the SERIALIZER. Two concurrent
// launches that both see "no owner" and both publish mint two Chromiums for
// one worktree, which R6 forbids. The lock is an O_EXCL claim whose owner
// record carries host, pid and process-start identity, so a crashed holder is
// distinguishable from a live one and from a pid the kernel reused.
//
// Stale claims are broken ONLY when the host matches and the owner is proven
// dead. Another host, a live pid whose start identity cannot be read, and a
// lock nobody can parse are AMBIGUOUS: they are never unlinked and never
// signalled. Automatic takeover of an unverifiable owner is how a sibling
// session used to steal a lock from a working one.
//
// Nothing here prints. Callers emit through ./emit.mjs.

import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export const WORKTREE_LOCK = '.agent/debug-as.lock';

export const worktreeLockPath = root => join(root, WORKTREE_LOCK);

/** Phone owns the directory; we only name the lock file inside it. */
export const machineLockPath = dir => join(dir, 'debug-as-relay.lock');

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Same lstart token receipt.mjs uses; duplicated so this file cannot import it. */
const lstartOf = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const token = (result.stdout ?? '').trim().split('\n')[0]?.trim();
  return token || null;
};

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = ms => Atomics.wait(waitCell, 0, 0, ms);

const ownerOf = path => {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { state: 'ambiguous', owner: null, why: 'symlink' };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'ambiguous', owner: null, why: 'malformed' };
    if (typeof parsed.host !== 'string' || !Number.isInteger(parsed.pid) || typeof parsed.processStart !== 'string') {
      return { state: 'ambiguous', owner: parsed, why: 'malformed' };
    }
    return { state: 'ok', owner: parsed, why: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', owner: null, why: 'absent' };
    return { state: 'ambiguous', owner: null, why: 'unreadable' };
  }
};

const liveness = (owner, { host, alive, start }) => {
  if (owner.host !== host) return 'ambiguous';
  if (!alive(owner.pid)) return 'dead';
  const token = start(owner.pid);
  if (token === null) return 'ambiguous';
  return token === owner.processStart ? 'live' : 'dead';
};

const heldRefusal = (path, owner) => ({
  at: path,
  problem: owner
    ? `is held by ${owner.host} pid ${owner.pid}${owner.generation ? ` generation ${owner.generation}` : ''}`
    : 'exists and cannot be proven ours to break',
  fix: `wait for that owner to exit, or remove ${path} only after proving no Role browser still holds it`,
});

const ambiguousRefusal = (path, why) => ({
  at: path,
  problem:
    why === 'symlink'
      ? 'is a symlink, which this lock will not follow'
      : 'exists and cannot be parsed as an owner record',
  fix: `remove ${path} only after proving no Role browser still holds it`,
});

/**
 * Who holds `path`, without touching it: absent | dead | live | ambiguous.
 *
 * Maintenance reaps only `dead`. `ambiguous` covers another host, an owner
 * whose start identity cannot be read, and a record nobody can parse — the
 * three cases a sweep must leave exactly as it found them.
 */
export function lockOwnerState(path, { host = hostname(), alive = pidAlive, start = lstartOf } = {}) {
  const existing = ownerOf(path);
  if (existing.state === 'absent') return 'absent';
  if (existing.state !== 'ok') return 'ambiguous';
  return liveness(existing.owner, { host, alive, start });
}

/**
 * Claim `path` exclusively. Returns `{ ok:true, release() }` or
 * `{ ok:false, state:'held'|'ambiguous', owner, refusal }`.
 *
 * `waitMs` waits out a LIVE same-host holder; it never takes over. A proven-dead
 * same-host holder is unlinked and the claim retried. Ambiguous never waits.
 */
export function acquireLock(
  path,
  {
    pid = process.pid,
    host = hostname(),
    start = lstartOf,
    alive = pidAlive,
    generation = null,
    waitMs = 0,
    pollMs = 50,
    sleep = sleepSync,
    clock = Date.now,
    now = () => new Date().toISOString(),
  } = {},
) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${pid}-${clock()}-${Math.random().toString(16).slice(2)}`;
  // Armed ONCE. Re-arming on every observation of a live holder is how a bounded
  // wait becomes an unbounded one: a holder that stays alive would keep pushing
  // the deadline out, and the caller that asked for `waitMs` would never be told
  // who holds the lock.
  const armedAt = clock();

  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ host, pid, processStart: start(pid), generation, token, at: now() }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const existing = ownerOf(path);
      if (existing.state === 'ambiguous' || existing.state === 'absent') {
        return { ok: false, state: 'ambiguous', owner: existing.owner, refusal: ambiguousRefusal(path, existing.why) };
      }

      const life = liveness(existing.owner, { host, alive, start });
      if (life === 'dead') {
        try {
          unlinkSync(path);
          continue;
        } catch {
          return { ok: false, state: 'ambiguous', owner: existing.owner, refusal: heldRefusal(path, existing.owner) };
        }
      }
      if (life === 'ambiguous') {
        return { ok: false, state: 'ambiguous', owner: existing.owner, refusal: heldRefusal(path, existing.owner) };
      }

      if (waitMs <= 0 || clock() >= armedAt + waitMs) {
        return { ok: false, state: 'held', owner: existing.owner, refusal: heldRefusal(path, existing.owner) };
      }
      sleep(pollMs);
    }
  }

  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      try {
        const holder = JSON.parse(readFileSync(path, 'utf8'));
        if (holder.token === token) unlinkSync(path);
      } catch {
        // Already gone, or no longer ours: never delete a successor.
      }
    },
  };
}

/** Serialize `fn` under the lock; release on return and on throw. */
export async function withLock(path, fn, deps = {}) {
  const held = acquireLock(path, deps);
  if (!held.ok) {
    const error = new Error(held.refusal.problem);
    error.fix = held.refusal.fix;
    error.refusal = held.refusal;
    error.state = held.state;
    throw error;
  }
  try {
    return await fn();
  } finally {
    held.release();
  }
}
