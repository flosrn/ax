// Which port a worktree's dev server answers on.
//
// The band is deliberately narrow and configured (see `ports.dev`): above the
// port the main checkout owns and below the Supabase blocks, so a port read off
// a URL is immediately identifiable as "some worktree". Everything here is a
// pure function of the identity, the band and the reserved list, except the one
// probe that has to ask the machine.

import { execFileSync } from 'node:child_process';

const RANGE = /^([0-9]+)-([0-9]+)$/;
const SINGLE = /^[0-9]+$/;

/**
 * Is `port` claimed by something that is not a worktree?
 *
 * `reserved` is the configured list: inclusive `low-high` ranges and bare
 * values. A malformed entry throws rather than counting as "not reserved" — a
 * typo that quietly un-reserves the Supabase range would hand a worktree a port
 * the database answers on, and the symptom would surface far from the config.
 */
export function isReserved(port, reserved = []) {
  const value = Number(port);
  for (const entry of reserved) {
    const text = String(entry).trim();
    const range = RANGE.exec(text);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      if (low > high) throw new Error(`reserved range "${text}" runs backwards: ${low} > ${high}`);
      if (value >= low && value <= high) return true;
      continue;
    }
    if (!SINGLE.test(text)) throw new Error(`malformed reserved port entry "${entry}": expected a port or "low-high"`);
    if (value === Number(text)) return true;
  }
  return false;
}

/** The live probe. The only function in this file that touches the machine. */
export function isPortBound(port) {
  try {
    execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' });
    return true;
  } catch {
    // A non-zero exit means "nothing is listening", which is also what a
    // missing lsof looks like. Treating that as free is the right default: the
    // dev server itself will refuse the port if it is actually taken.
    return false;
  }
}

/**
 * Map any seed into the inclusive band.
 *
 * Modulo the band width, never clamped: clamping piles every out-of-range seed
 * onto the ceiling, which turns a stable-but-arbitrary port into a guaranteed
 * collision between unrelated worktrees. The modulo is normalized rather than
 * taken on an absolute value, for the same reason: `Math.abs` mirrors the seed
 * space, so -1 and 1 would land on one port.
 */
export function inBand(seed, band) {
  const [min, max] = band;
  const width = max - min + 1;
  const rest = Math.trunc(Number(seed)) % width;
  return min + (rest < 0 ? rest + width : rest);
}

/** This worktree's preferred port, before availability is considered. */
export function preferredPort(identity, band) {
  const [min, max] = band;
  if (identity?.issue) {
    // Issue #412 wants 3412 — legible, derivable from the ticket, identical on
    // every machine. The thousand comes from the band itself rather than a
    // literal, so a band of [4100, 4999] gives 4412.
    const candidate = Math.floor(min / 1000) * 1000 + identity.issue;
    // A number that lands below the band (#1) or above it (#1000+) is folded
    // back in by hash rather than rejected: the point is a stable port, not a
    // pretty one.
    return candidate >= min && candidate <= max ? candidate : inBand(identity.issue, band);
  }
  return inBand(identity?.seed, band);
}

/**
 * Resolve the port this worktree will actually serve on.
 *
 * The order is load-bearing:
 *
 *   1. A port already RECORDED for this worktree wins outright, even when it is
 *      bound — it is bound by this worktree's own dev server, and re-running
 *      setup must not move a URL already published to an agent, a browser tab
 *      or a Playwright auth state. It is still rejected when it is reserved or
 *      not a number, because that value can only have come from a bad edit.
 *   2. The preferred port when it is free.
 *   3. A scan UPWARD from the preferred port, wrapping at the top of the band,
 *      so a collision costs one neighbouring port instead of a jump to the far
 *      end of the band.
 */
export function resolvePort({ identity, band, reserved = [], recorded, isBound = isPortBound } = {}) {
  if (recorded !== undefined && recorded !== null && recorded !== '') {
    const value = Number(recorded);
    if (Number.isInteger(value) && !isReserved(value, reserved)) return { port: value, source: 'recorded' };
  }

  const preferred = preferredPort(identity, band);
  if (!isReserved(preferred, reserved) && !isBound(preferred)) return { port: preferred, source: 'preferred' };

  const [min, max] = band;
  const width = max - min + 1;
  let port = preferred;
  for (let step = 1; step < width; step += 1) {
    port = min + ((port - min + 1) % width);
    if (!isReserved(port, reserved) && !isBound(port)) return { port, source: 'scanned' };
  }

  throw new Error(`no free port in ${min}-${max}: every port in the band is reserved or bound`);
}

export function baseUrlForPort(port) {
  return `http://localhost:${port}`;
}
