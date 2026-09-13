// The operator parser cannot let a path or child flag change session authority.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDebugArgs } from '../src/debug-as/args.mjs';
test('launch parses bounded desktop sizing and same-origin path', () => {
  const args = parseDebugArgs(['--as', 'owner', '--viewport', '1280x800', '--path', '/home']);
  assert.equal(args.verb, 'launch');
  assert.deepEqual(args.viewport, { width: 1280, height: 800 });
  assert.equal(args.path, '/home');
});
test('conflicting capabilities and unsafe paths refuse with repairs', () => {
  for (const argv of [
    ['--as', 'owner', '--phone', '--no-phone'],
    ['--as', 'owner', '--viewport', '199x800'],
    ['--as', 'owner', '--viewport', '1280x800', '--device', 'iPhone 13'],
    ['--as', 'owner', '--path', '//evil.test'],
    ['--as', 'owner', '--as', 'guest'],
    ['--as'], ['--as', 'Owner'], ['status', '--phone'],
  ]) assert.throws(() => parseDebugArgs(argv), error => typeof error.fix === 'string');
});
test('drive preserves literal child argv after the required delimiter', () => {
  const args = parseDebugArgs(['drive', '--as', 'owner', '--', 'eval', 'a; b', '--help']);
  assert.deepEqual(args.argv, ['eval', 'a; b', '--help']);
  assert.equal(args.name, 'owner');
  assert.throws(() => parseDebugArgs(['drive', 'snapshot']));
});
