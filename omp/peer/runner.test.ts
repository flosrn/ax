/**
 * The runner shape `resolveChildRoute` is handed: a parsed value, or a NAMED
 * reason decided by STDOUT ALONE. Stderr chatter beside an empty answer is
 * "produced nothing", never "unparseable" — the two reasons route a reader to
 * different repairs. `orcaRaw.text` still carries stderr, because the reply
 * send's diagnostic wants exactly what the classifier must ignore.
 *
 * Static imports are safe here: the adapter resolves `ORCA_BIN` per call, so
 * the fake installed in beforeEach is the binary every call spawns.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { orcaRaw, runOrca } from './orca.ts';

let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-runner-'));
  const bin = join(dir, 'orca');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$*" in
  *good*) printf '{"ok":true,"result":{"n":1}}' ;;
  *stderr-only*) echo 'usage: nope' >&2; exit 1 ;;
  *garbage*) printf 'not json at all' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  saved = process.env.ORCA_BIN;
  process.env.ORCA_BIN = bin;
});

afterEach(() => {
  if (saved === undefined) delete process.env.ORCA_BIN;
  else process.env.ORCA_BIN = saved;
  rmSync(dir, { recursive: true, force: true });
});

test('a parseable answer is a value', () => {
  expect(runOrca(['good', '--json'])).toEqual({ value: { ok: true, result: { n: 1 } } });
});

test('stderr beside an empty stdout is "produced nothing", never "unparseable"', () => {
  expect(runOrca(['stderr-only', '--json'])).toEqual({
    reason: 'stderr-only --json produced nothing',
  });
});

test('a non-JSON stdout is "was unparseable"', () => {
  expect(runOrca(['garbage', '--json'])).toEqual({
    reason: 'garbage --json was unparseable',
  });
});

test('orcaRaw keeps the stderr the classifier ignores, for the human diagnostic', () => {
  const out = orcaRaw(['stderr-only', '--json']);
  expect(out.stdout).toBe('');
  expect(out.text).toContain('usage: nope');
});
