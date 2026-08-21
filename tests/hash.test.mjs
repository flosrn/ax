import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { crc32, gitBlobSha, stableSeed } from '../src/hash.mjs';

/** The first field of `printf '%s' <text> | cksum`, or null when cksum is absent. */
function cksumOf(text) {
  const result = spawnSync('cksum', { input: text, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return Number(result.stdout.trim().split(/\s+/)[0]);
}

test('crc32 is bit-exact with POSIX cksum', () => {
  // Parity with the real binary, not with a table of numbers this file made up:
  // these values decide which port and which Supabase block an issue-less branch
  // gets, so a "close enough" hash relocates every existing worktree at once.
  const samples = [
    '',
    'foo',
    'worktree',
    'feature/publish-legal-modal',
    'a'.repeat(1000), // more than one length byte fed into the tail
    'accentué-ß-字', // multi-byte: the length in the tail is bytes, not characters
    'trailing\nnewline\n',
  ];

  if (cksumOf('foo') === null) {
    // A machine without cksum still gets the pinned value below, so the port
    // mapping is defended even where the reference binary is missing.
    assert.equal(crc32('foo'), 2470157969);
    return;
  }

  for (const sample of samples) {
    assert.equal(crc32(sample), cksumOf(sample), `cksum parity for ${JSON.stringify(sample.slice(0, 24))}`);
  }
});

test('crc32 returns an unsigned 32-bit number', () => {
  // The seed is divided and compared downstream; a negative int32 from a missing
  // `>>> 0` picks a slot outside every band instead of failing loudly.
  for (const sample of ['', 'x', 'issue-472', 'zzzzzzzzzzzz']) {
    const value = crc32(sample);
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `${sample} -> ${value}`);
  }
});

test('an empty name seeds from the historical fallback word', () => {
  assert.equal(stableSeed(''), crc32('worktree'));
  assert.equal(stableSeed(undefined), crc32('worktree'));
  assert.equal(stableSeed('worktree'), crc32('worktree'));
  assert.notEqual(stableSeed('other'), stableSeed(''));
});

test('gitBlobSha matches git hash-object --stdin', () => {
  // Includes a multi-byte input on purpose: the blob header counts BYTES, and
  // using string length there yields a digest git never produces.
  const samples = ['hello', 'feature/accentué', ''];

  let reference;
  try {
    reference = samples.map(text => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim());
  } catch {
    assert.equal(gitBlobSha('hello'), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
    return;
  }

  samples.forEach((text, index) => {
    assert.equal(gitBlobSha(text), reference[index], `blob sha for ${JSON.stringify(text)}`);
  });
});
