/**
 * How deep is this session — parent, child, grandchild?
 *
 * A session could not answer it. `parentWorktreePath()` resolves exactly ONE
 * hop, and `children()` returns direct children only, so nothing walked the
 * chain. The restructuring plan priced this as "one Orca round-trip per hop";
 * measured, it is none: `worktrees()` already returns EVERY row with its
 * `parentWorktreeId`, so the walk is a local loop over a list that has been
 * fetched anyway.
 *
 * The load-bearing case is the last one. When Orca answers nothing, depth is
 * UNKNOWN, and reporting `0` would say "I am a root session" — the same
 * false-negative shape that `parentWorktreePath` refuses to cache, one level up.
 * A parent reading `0` for a grandchild is how a campaign miscounts its own
 * children.
 */

import { expect, test } from 'bun:test';
import { depthOf } from './lineage.ts';

const ROOT = '/tmp/fake/root';
const CHILD = '/tmp/fake/child';
const GRAND = '/tmp/fake/grand';

/** Orca's `worktree ps` shape: a flat list, lineage by `parentWorktreeId`. */
const TREE = [
  { path: ROOT, parentWorktreeId: null },
  { path: CHILD, parentWorktreeId: `repo123::${ROOT}` },
  { path: GRAND, parentWorktreeId: `repo123::${CHILD}` },
];

test('a worktree with no parent is depth 0', () => {
  expect(depthOf(ROOT, TREE)).toBe(0);
});

test('a child is depth 1 and a grandchild is depth 2', () => {
  expect(depthOf(CHILD, TREE)).toBe(1);
  expect(depthOf(GRAND, TREE)).toBe(2);
});

test('an empty worktree list is unknown depth, never 0', () => {
  // Orca being unavailable and a session being a root are different facts.
  // Answering 0 here reports "I am the parent" to a grandchild.
  expect(depthOf(CHILD, [])).toBe(-1);
});

test('a worktree absent from the list is unknown depth', () => {
  expect(depthOf('/tmp/fake/elsewhere', TREE)).toBe(-1);
});

test('a parent pointing at a worktree Orca did not list is unknown, not root', () => {
  // The chain is real but incomplete: claiming 0 would invent a lineage fact.
  expect(depthOf(CHILD, [{ path: CHILD, parentWorktreeId: 'repo123::/tmp/fake/ghost' }])).toBe(-1);
});

test('a cycle terminates instead of hanging the turn boundary', () => {
  // Nothing should be able to produce this, which is exactly why it must not
  // be able to hang a session: this runs where the operator is waiting.
  const cyclic = [
    { path: CHILD, parentWorktreeId: `repo123::${GRAND}` },
    { path: GRAND, parentWorktreeId: `repo123::${CHILD}` },
  ];
  expect(depthOf(CHILD, cyclic)).toBe(-1);
});

test('an empty path is unknown, and asks Orca nothing', () => {
  expect(depthOf('', TREE)).toBe(-1);
});
