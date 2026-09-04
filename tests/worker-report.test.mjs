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

import { reportPath, reportPathFor } from '../src/worker/report.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(dir, 'fixtures', 'report-record.json');
const EXPECTED = join(dir, 'fixtures', 'report-path.txt');

const record = (effects, request = 'req-1') => ({
  request,
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

test('a traversal request is a named inability, never a path outside .scratch/report', () => {
  const got = reportPath(record([{ kind: 'worktree', id: 'repo::/wt' }], '../../outside'));
  assert.equal('path' in got, false, 'join() must not be allowed to walk out of .scratch/report');
  assert.notEqual(got.path, '');
  assert.match(got.reason, /grammar/);
});

test('the brief and the record reader answer through ONE derivation, not two', () => {
  // A dispatch composes the brief BEFORE its record exists: the worktree it is
  // about to place a child in and the request id are values it holds, not a
  // receipt it can read. Deriving the path from them there would be a second
  // copy of this rule — the one thing #135 exists to prevent — so the record
  // reader resolves its two values and both callers cross the same function.
  const rec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const expected = readFileSync(EXPECTED, 'utf8').trim();

  assert.equal(reportPathFor({ worktree: dirname(dirname(dirname(expected))), request: rec.request }).path, expected);
  assert.deepEqual(reportPathFor({ worktree: '/wt', request: 'req-1' }), reportPath(record([{ kind: 'worktree', id: 'repo::/wt' }])));
});

test('a dispatch that cannot name its worktree yet gets a named inability, never a guess', () => {
  // A child placed on another host has no path this host can know at compose
  // time (`--worktree new-top-level`), and the same absence is what a relative
  // worktree would be: neither may become a default (F-028), because the
  // receiver opens the derived path and nothing else.
  for (const worktree of ['', '.worktrees/136-work']) {
    const got = reportPathFor({ worktree, request: '136-work' });
    assert.equal('path' in got, false, `${JSON.stringify(worktree)} must not answer a path`);
    assert.notEqual(got.path, '');
    assert.match(got.reason, /cannot be established/);
  }
  const bad = reportPathFor({ worktree: '/wt', request: '../../outside' });
  assert.equal('path' in bad, false);
  assert.match(bad.reason, /grammar/);
});
