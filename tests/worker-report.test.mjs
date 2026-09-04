// The Report's path is one rule: a dispatch record names exactly one worktree
// (the same resolution `ax worker transcript` already uses) and a request id,
// and the file is `<worktree>/.scratch/report/<request>.md`, absolute.
//
// Nothing else feeds it — not an argument the worker passed, not
// `payload.reportPath`, not a default. Zero or two worktrees is an inability
// to establish, named, and never an empty string (F-028). The committed
// fixture is the pin #137's receiver reads for the same answer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { reportPath } from '../src/worker/report.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(dir, 'fixtures', 'report-record.json');
const EXPECTED = join(dir, 'fixtures', 'report-path.txt');

const record = effects => ({
  request: 'req-1',
  attempts: [
    {
      n: 1,
      phases: [{ name: 'worker-start', receipt: { ok: true, result: { effects } } }],
    },
  ],
});

test('a committed record fixture answers the committed absolute path', () => {
  const rec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const expected = readFileSync(EXPECTED, 'utf8').trim();
  const got = reportPath(rec);

  assert.equal(got.path, expected);
  assert.equal(isAbsolute(got.path), true);
  assert.equal('reason' in got, false, 'a resolved record is not an inability');
});

test('a record with no worktree effect is a named inability, never an empty path', () => {
  const got = reportPath(record([]));
  assert.equal('path' in got, false, 'an unresolvable worktree must not carry a path key');
  assert.notEqual(got.path, '');
  assert.match(got.reason, /cannot be established/);
  assert.match(got.reason, /no worktree/);
});

test('a record that names two worktrees is a named inability, never a guess', () => {
  const got = reportPath(
    record([
      { kind: 'worktree', id: 'repo::/wt-a' },
      { kind: 'worktree', id: 'repo::/wt-b' },
    ]),
  );
  assert.equal('path' in got, false);
  assert.notEqual(got.path, '');
  assert.match(got.reason, /cannot be established/);
  assert.match(got.reason, /2 worktrees/);
});
