/**
 * The runner shape `resolveChildRoute` is handed: a parsed value, or a NAMED
 * reason decided by STDOUT ALONE. Stderr chatter beside an empty answer is
 * "produced nothing", never "unparseable" — the two reasons route a reader to
 * different repairs. `orcaRaw.text` still carries stderr, because the reply
 * send's diagnostic wants exactly what the classifier must ignore.
 *
 * And the list shape above it (`inventory`): an answer Orca marked TRUNCATED is
 * an inability, not a list. `orca terminal list` caps its rows, so a partial
 * answer arrives with `ok:true` and looks exactly like a complete one — which
 * is the #220 collapse with a success envelope around it. `src/worker/pane.mjs`
 * already refuses a truncated pane list for the same reason; this adapter is
 * the other reader of that same envelope.
 *
 * Static imports are safe here: the adapter resolves `ORCA_BIN` per call, so
 * the fake installed in beforeEach is the binary every call spawns.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inventory, orcaRaw, runOrca } from './orca.ts';

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
  *trunc-list*) printf '{"ok":true,"result":{"terminals":[{"handle":"term_aaaa"}],"truncated":true}}' ;;
  *full-list*) printf '{"ok":true,"result":{"terminals":[{"handle":"term_aaaa"}]}}' ;;
  *empty-list*) printf '{"ok":true,"result":{"terminals":[]}}' ;;
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

// ── #220 with a success envelope: a truncated list is not a read list ─────────

test('a list Orca marked truncated is unread, and carries no rows', () => {
  // THE DEFECT. `ok:true` plus rows read as an established list, so a caller
  // asked "is this handle there?" answered no from a list that never claimed to
  // be whole. The rows are dropped WITH the reason: a partial list left in
  // place is a list the next caller acts on.
  const inv = inventory(['trunc-list', '--json'], 'terminals');
  expect(inv.rows).toEqual([]);
  expect(inv.unread).toContain('truncated');
});

test('a complete list is rows with no inability attached', () => {
  const inv = inventory(['full-list', '--json'], 'terminals');
  expect(inv.unread).toBeUndefined();
  expect(inv.rows).toEqual([{ handle: 'term_aaaa' }]);
});

test('an empty list Orca did answer stays a fact, not an inability', () => {
  // The positive control, and the reason the refusal above cannot simply widen:
  // Orca stating "no terminals" is a measurement a caller may act on.
  const inv = inventory(['empty-list', '--json'], 'terminals');
  expect(inv.unread).toBeUndefined();
  expect(inv.rows).toEqual([]);
});
