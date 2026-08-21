// Stable, non-cryptographic identity for a worktree.
//
// Every deterministic choice downstream — which dev port a branch prefers, which
// Supabase port block it owns — is seeded from here. So the value must not merely
// be stable within one implementation: it must equal what the shell tooling
// computed before, byte for byte. A different hash silently relocates every
// worktree that has no recorded port, which orphans running containers and moves
// already-published URLs.
//
// That is why `crc32` reproduces POSIX `cksum` exactly rather than picking the
// more common CRC-32 variant: `cksum` is what was reachable from a shell, and the
// numbers it produced are now load-bearing.

import { createHash } from 'node:crypto';

// CRC-32/CKSUM: polynomial 0x04C11DB7, MSB-first, no input or output reflection.
// Built once at module load; 1 KiB, and the alternative is 8 shifts per byte.
const CKSUM_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * The checksum POSIX `cksum` prints as its first field.
 *
 * Note the second loop: `cksum` feeds the message's BYTE LENGTH through the same
 * CRC after the data, low byte first. Skipping it is the classic near-miss — the
 * digest looks plausible and matches nothing.
 *
 * @param {string} text
 * @returns {number} unsigned 32-bit
 */
export function crc32(text) {
  const bytes = Buffer.from(text, 'utf8');
  let crc = 0;

  for (const byte of bytes) {
    crc = (((crc << 8) >>> 0) ^ CKSUM_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  for (let length = bytes.length; length !== 0; length = Math.floor(length / 256)) {
    crc = (((crc << 8) >>> 0) ^ CKSUM_TABLE[((crc >>> 24) ^ (length & 0xff)) & 0xff]) >>> 0;
  }

  return ~crc >>> 0;
}

/**
 * The seed for a worktree that carries no issue number.
 *
 * Empty input still has to produce a usable slot rather than 0, so it falls back
 * to a fixed word — the same one the shell used, so the fallback slot is the
 * historical one.
 *
 * @param {string} text
 * @returns {number}
 */
export function stableSeed(text) {
  return crc32(text || 'worktree');
}

/**
 * `git hash-object --stdin` for a string: sha1 of `blob <byteLength>\0<content>`.
 *
 * Used to keep a distinguishing suffix when a long branch name must be truncated
 * into a container-safe project id. The length in the header is in BYTES, so a
 * name with any non-ASCII character hashes differently than its character count
 * suggests — measuring it with `text.length` produces an id git would never
 * agree with.
 *
 * @param {string} text
 * @returns {string} 40 hex characters
 */
export function gitBlobSha(text) {
  const content = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}
