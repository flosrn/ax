import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseValue, readConfigured, readKey, writeBlock } from '../src/dotenv.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'ax-dotenv-'));
}

test('a trailing comment is stripped before the quotes, not after', () => {
  // Measured disagreement: reversing the two steps yields `0"`, and a flag whose
  // value is `0"` is neither on nor off — it compares unequal to both.
  assert.equal(parseValue('KEY="0" # note\n', 'KEY'), '0');
  assert.equal(parseValue("KEY='3412' # the recorded port\n", 'KEY'), '3412');
  assert.equal(parseValue('KEY=3412 # bare\n', 'KEY'), '3412');
  // A `#` with no whitespace in front is part of the value: URLs carry fragments.
  assert.equal(parseValue('KEY=http://x/#frag\n', 'KEY'), 'http://x/#frag');
});

test('export and whitespace around the = are accepted', () => {
  // The other measured disagreement: one reader saw no assignment here and fell
  // through to its default, so two tools reported different modes for one worktree.
  assert.equal(parseValue('export KEY = 0\n', 'KEY'), '0');
  assert.equal(parseValue('  export   KEY=1\n', 'KEY'), '1');
  assert.equal(parseValue('KEY   =   2\n', 'KEY'), '2');
});

test('the last assignment wins', () => {
  assert.equal(parseValue('KEY=1\nKEY=2\nexport KEY=3\n', 'KEY'), '3');
  // A commented-out later line must not win — it is not an assignment.
  assert.equal(parseValue('KEY=1\n#KEY=2\n', 'KEY'), '1');
});

test('absent is distinct from empty', () => {
  assert.equal(parseValue('OTHER=1\n', 'KEY'), undefined);
  assert.equal(parseValue('KEY=\n', 'KEY'), '');
  assert.equal(parseValue('KEY=""\n', 'KEY'), '');
  // A key is matched whole: a longer name that ends with it is a different key.
  assert.equal(parseValue('MY_KEY=1\n', 'KEY'), undefined);
});

test('inner whitespace survives so the malformed value can be reported', () => {
  assert.equal(parseValue('KEY=3412 3413\n', 'KEY'), '3412 3413');
  assert.equal(parseValue('KEY="a  b"\n', 'KEY'), 'a  b');
});

test('an unbalanced quote is data, not a delimiter', () => {
  assert.equal(parseValue('KEY="0\n', 'KEY'), '"0');
  assert.equal(parseValue('KEY=0"\n', 'KEY'), '0"');
  assert.equal(parseValue('KEY="0\'\n', 'KEY'), '"0\'');
});

test('a key that is not an identifier is refused rather than interpolated', () => {
  // The key goes into a RegExp; `.*` as a key would match any assignment.
  assert.throws(() => parseValue('KEY=1\n', 'K.*'), /non-identifier env key/);
});

test('readKey reports absence for a missing file instead of throwing', () => {
  const dir = scratch();
  assert.equal(readKey(join(dir, 'nope.env'), 'KEY'), undefined);
  writeFileSync(join(dir, '.env.local'), 'PORT=3412\n');
  assert.equal(readKey(join(dir, '.env.local'), 'PORT'), '3412');
});

test('an exported variable outranks the files, then the caller-supplied order decides', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'first.env'), 'PORT=1111\n');
  writeFileSync(join(dir, 'second.env'), 'PORT=2222\nONLY_SECOND=x\n');
  const files = ['first.env', 'second.env'];

  assert.equal(readConfigured('PORT', { cwd: dir, files, env: { PORT: '9999' } }), '9999');
  assert.equal(readConfigured('PORT', { cwd: dir, files, env: {} }), '1111');
  // Empty counts as absent: an exported `PORT=` is how a shell spells "unset".
  assert.equal(readConfigured('PORT', { cwd: dir, files, env: { PORT: '' } }), '1111');
  assert.equal(readConfigured('ONLY_SECOND', { cwd: dir, files, env: {} }), 'x');
  assert.equal(readConfigured('MISSING', { cwd: dir, files, env: {} }), undefined);
  // Files that do not exist are skipped, not fatal.
  assert.equal(readConfigured('PORT', { cwd: dir, files: ['nope.env', 'second.env'], env: {} }), '2222');
});

test('writeBlock appends once and is then byte-identical', () => {
  const dir = scratch();
  const file = join(dir, 'nested', '.env.local');
  const keys = { PORT: 3412, BASE_URL: 'http://localhost:3412' };

  assert.equal(writeBlock(file, { label: 'Worktree runtime', keys }), true);
  const first = readFileSync(file, 'utf8');
  assert.equal(first, '\n# --- Worktree runtime ---\nPORT=3412\nBASE_URL=http://localhost:3412\n');

  // Idempotence is what makes setup safe to re-run: a churning file means every
  // re-run is a diff, and a second appended block means two values per key.
  assert.equal(writeBlock(file, { label: 'Worktree runtime', keys }), false);
  assert.equal(readFileSync(file, 'utf8'), first);
});

test('writeBlock keeps hand-written content above and rewrites its own block', () => {
  const dir = scratch();
  const file = join(dir, '.env.local');
  writeFileSync(file, 'MY_SECRET=hunter2\n');

  assert.equal(writeBlock(file, { label: 'Runtime', keys: { PORT: 3412 } }), true);
  assert.equal(readFileSync(file, 'utf8'), 'MY_SECRET=hunter2\n\n# --- Runtime ---\nPORT=3412\n');

  assert.equal(writeBlock(file, { label: 'Runtime', keys: { PORT: 3500 } }), true);
  assert.equal(readFileSync(file, 'utf8'), 'MY_SECRET=hunter2\n\n# --- Runtime ---\nPORT=3500\n');
  assert.equal(readKey(file, 'MY_SECRET'), 'hunter2');
  assert.equal(readKey(file, 'PORT'), '3500');
});

test('hand content with no final newline still gets exactly one blank line', () => {
  // Verified against the shell writer it replaces: `grep` terminates its output
  // lines, so the missing final newline is normalised before `cat` ever runs and
  // the block's leading `\n` then produces a blank separator. Emitting `abc\n#`
  // here instead would be a divergence, not a fix — an existing worktree's file
  // would stop matching and re-churn on every setup run.
  const dir = scratch();
  const file = join(dir, '.env.local');
  writeFileSync(file, 'MY_SECRET=hunter2');

  assert.equal(writeBlock(file, { label: 'Runtime', keys: { PORT: 3412 } }), true);
  assert.equal(readFileSync(file, 'utf8'), 'MY_SECRET=hunter2\n\n# --- Runtime ---\nPORT=3412\n');
  // And the normalisation settles: the next run is a no-op, not a second newline.
  assert.equal(writeBlock(file, { label: 'Runtime', keys: { PORT: 3412 } }), false);
  assert.equal(readKey(file, 'MY_SECRET'), 'hunter2');
});

test('a block found mid-file is moved, never duplicated', () => {
  const dir = scratch();
  const file = join(dir, '.env.local');
  writeFileSync(file, '\n# --- Runtime ---\nPORT=1111\n\n# --- Other ---\nKEEP=1\n');

  assert.equal(writeBlock(file, { label: 'Runtime', keys: { PORT: 2222 } }), true);
  const text = readFileSync(file, 'utf8');
  assert.equal(text, '\n# --- Other ---\nKEEP=1\n\n# --- Runtime ---\nPORT=2222\n');
  // One assignment for the key, not a stale one a later hand-edit would land in.
  assert.equal(text.match(/^PORT=/gm).length, 1);
  assert.equal(text.match(/# --- Runtime ---/g).length, 1);
  assert.equal(readKey(file, 'KEEP'), '1');
});

test('writeBlock preserves the caller\u2019s key order, from an object or an array', () => {
  const dir = scratch();
  const fromArray = join(dir, 'array.env');
  writeBlock(fromArray, { label: 'L', keys: [['B', 1], ['A', 2]] });
  assert.equal(readFileSync(fromArray, 'utf8'), '\n# --- L ---\nB=1\nA=2\n');

  const fromObject = join(dir, 'object.env');
  writeBlock(fromObject, { label: 'L', keys: { B: 1, A: 2 } });
  assert.equal(readFileSync(fromObject, 'utf8'), '\n# --- L ---\nB=1\nA=2\n');
});
