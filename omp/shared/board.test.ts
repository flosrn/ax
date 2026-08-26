/**
 * The one board writer both extensions spawn through. Mechanics only: the
 * give-up latch stays with the caller whose cadence needs it (checkpoint's
 * todo flips), so a transient failure there can never suppress report's
 * one-shot `in-review`.
 */

import { expect, test } from 'bun:test';

import { boardWrite } from './board.ts';

type Spawned = { argv: string[]; opts: Record<string, unknown> };

function harness(behavior: 'ok' | 'throw' = 'ok') {
  const calls: Spawned[] = [];
  let unrefs = 0;
  const spawn = (argv: string[], opts: Record<string, unknown>) => {
    if (behavior === 'throw') throw new Error('no CLI entry');
    calls.push({ argv, opts });
    return {
      unref() {
        unrefs += 1;
      },
    };
  };
  return { calls, spawn, unrefs: () => unrefs };
}

test('comment then status, after this package own CLI - and NEVER a worktree selector', () => {
  const h = harness();
  expect(boardWrite({ comment: '3/7 · wiring', status: 'in-review' }, h.spawn)).toBe(true);
  expect(h.calls).toHaveLength(1);
  const argv = h.calls[0].argv;
  expect(argv.slice(-5)).toEqual(['board', '--comment', '3/7 · wiring', '--status', 'in-review']);
  expect(argv).not.toContain('--worktree');
  expect(h.unrefs()).toBe(1);
});

test('nothing beyond the verb means nothing to write - and no spawn', () => {
  const h = harness();
  expect(boardWrite({}, h.spawn)).toBe(true);
  expect(h.calls).toHaveLength(0);
});

test('a spawn that throws answers false, so a repeated caller can latch; it never throws out', () => {
  const h = harness('throw');
  expect(boardWrite({ status: 'in-review' }, h.spawn)).toBe(false);
});

test('the child is detached and silent: ignored stdio, cwd of this process', () => {
  const h = harness();
  boardWrite({ comment: 'c' }, h.spawn);
  expect(h.calls[0].opts).toEqual({
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
});
