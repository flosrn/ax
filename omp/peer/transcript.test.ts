/**
 * Which transcript `peer_read` shows.
 *
 * F-023: two peers of one worktree returned the SAME transcript. The registry
 * already tells them apart — `derive` names them `<base>·<handle4>` precisely
 * because they share a worktree — but the read path threw that away: it resolved
 * a peer to its worktree and then took the newest session recorded under that
 * directory. Whichever peer you asked about, you were shown the same session,
 * and on a young session its prose reads like a plausible status report.
 *
 * A peer publishes its `sessionId`, and OMP names each transcript
 * `<timestamp>_<sessionId>.jsonl`, so the join already exists in the data. These
 * tests pin that the session is what selects the file, and that the worktree
 * remains the fallback for a legacy entry that published no session.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transcriptFor } from './transcript.ts';

let root = '';
let saved: string | undefined;

const WORKTREE = '/tmp/shared-worktree';

/** One OMP transcript: a session record naming its cwd, then assistant prose. */
function session(sessionId: string, startedAt: string, says: string[]): void {
  const slug = '-tmp-shared-worktree';
  mkdirSync(join(root, 'sessions', slug), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', cwd: WORKTREE, timestamp: startedAt }),
    ...says.map((text) =>
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: text } }),
    ),
  ];
  writeFileSync(
    join(root, 'sessions', slug, `${startedAt.replace(/[:.]/g, '-')}_${sessionId}.jsonl`),
    `${lines.join('\n')}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-transcript-'));
  saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  if (root) rmSync(root, { recursive: true, force: true });
});

test('a peer is read by its own session, not by the newest one in its worktree', () => {
  session('1111aaaa-0000-7000-0000-000000000001', '2026-08-10T10:00:00.000Z', ['older peer speaking']);
  session('2222bbbb-0000-7000-0000-000000000002', '2026-08-10T18:00:00.000Z', ['newer peer speaking']);

  const older = transcriptFor(WORKTREE, 1, '1111aaaa-0000-7000-0000-000000000001');
  expect(older.messages).toEqual(['older peer speaking']);
  expect(older.path).toContain('1111aaaa');

  const newer = transcriptFor(WORKTREE, 1, '2222bbbb-0000-7000-0000-000000000002');
  expect(newer.messages).toEqual(['newer peer speaking']);
});

test('with no session named, the newest in the worktree is still the answer', () => {
  // The fallback a legacy entry depends on: it published no session id.
  session('1111aaaa-0000-7000-0000-000000000001', '2026-08-10T10:00:00.000Z', ['older peer speaking']);
  session('2222bbbb-0000-7000-0000-000000000002', '2026-08-10T18:00:00.000Z', ['newer peer speaking']);

  expect(transcriptFor(WORKTREE, 1).messages).toEqual(['newer peer speaking']);
});

test('a session id that matches nothing falls back rather than refusing', () => {
  // Refusing here would make `peer_read` useless the moment a transcript is
  // rotated or pruned, which is a worse failure than showing the worktree tail.
  session('2222bbbb-0000-7000-0000-000000000002', '2026-08-10T18:00:00.000Z', ['newer peer speaking']);
  const found = transcriptFor(WORKTREE, 1, '9999cccc-0000-7000-0000-000000000009');
  expect(found.messages).toEqual(['newer peer speaking']);
});

test('`last` still returns the tail, not the head', () => {
  // F-042 claimed this was broken. Measured against the live runtime on
  // 2026-08-10 it was already correct; this pins it so it cannot regress
  // unnoticed while the selection above changes around it.
  session('2222bbbb-0000-7000-0000-000000000002', '2026-08-10T18:00:00.000Z', [
    'first thing said',
    'second thing said',
    'third thing said',
  ]);
  expect(transcriptFor(WORKTREE, 1).messages).toEqual(['third thing said']);
  expect(transcriptFor(WORKTREE, 2).messages).toEqual(['second thing said', 'third thing said']);
});
