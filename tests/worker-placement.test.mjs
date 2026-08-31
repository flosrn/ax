// The placement rules, exercised through placeLocal's own interface — above
// all the reuse rule, which used to be reachable only through the whole dispatch
// pipeline and its seven-subcommand Orca stub: another ticket's tree is never
// lent (GAP-35 vs gap-357), an earlier slug of the SAME ticket is exactly the
// tree to reuse, and a --name dispatch matches whole names only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { CONTEXT_PATH } from '../src/worktree/context.mjs';
import { databaseArgs, placeLocal } from '../src/worker/placement.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repo root whose .worktrees/ already holds the named, provisioned trees. */
function fixture(existing = []) {
  const root = mkdtempSync(join(tmpdir(), 'ax-place-'));
  roots.push(root);
  for (const name of existing) provisioned(join(root, '.worktrees', name));
  return root;
}

/** A directory that would pass the habitability check: it has a context file. */
function provisioned(tree) {
  const context = join(tree, CONTEXT_PATH);
  mkdirSync(dirname(context), { recursive: true });
  writeFileSync(context, '# ctx\n');
  return tree;
}

/** An Orca runner whose `worktree create` answers the given path. */
const orcaCreates = (path, calls = []) => args => {
  calls.push(args);
  return { status: 0, stderr: '', receipt: { ok: true, result: { worktree: { path } } } };
};

const options = (root, over = {}) => ({
  request: 'gap-35-work',
  issue: 'gap-35',
  slug: '',
  named: false,
  paths: { root },
  dispatchConfig: {},
  ticket: null,
  exec: () => assert.fail('no worktree tool is declared, so none may run'),
  run: () => assert.fail('this case must not reach Orca'),
  cwd: root,
  dry: false,
  probe: false,
  setupFn: () => 0,
  ...over,
});

test('an earlier slug of the same ticket is reused; another ticket never lends its tree', () => {
  const root = fixture(['gap-35-auth', 'gap-357-payments']);
  const placed = placeLocal(options(root));

  assert.equal(placed.worktree, join(root, '.worktrees', 'gap-35-auth'));
  assert.equal(placed.refused, undefined);
  assert.equal(placed.cannot, undefined);
  assert.ok(placed.notes.some(line => line.includes('reusing')), 'the reuse is announced, not silent');
});

test('gap-357 alone matches nothing for gap-35, so Orca places a fresh tree', () => {
  const root = fixture(['gap-357-payments']);
  // Outside .worktrees/ — a tree already sitting there would legitimately be
  // reused by the prefix rule, which is the previous test's subject.
  const fresh = provisioned(join(root, 'placed-by-orca', 'gap-35-work'));
  const calls = [];
  const placed = placeLocal(options(root, { run: orcaCreates(fresh, calls) }));

  assert.equal(placed.worktree, fresh);
  assert.equal(calls.length, 1, 'exactly one create, for this request');
  assert.deepEqual(calls[0].slice(0, 4), ['worktree', 'create', '--name', 'gap-35-work']);
});

test('a --name dispatch matches whole names only: `auth` never reuses `auth-refactor`', () => {
  const root = fixture(['auth-refactor']);
  const fresh = provisioned(join(root, 'placed-by-orca', 'auth'));
  const placed = placeLocal(options(root, { request: 'auth', issue: '', named: true, run: orcaCreates(fresh) }));

  assert.equal(placed.worktree, fresh, "auth-refactor is a different piece of work, already someone's");
});

test('databaseArgs answers --database exactly when a declared label is carried', () => {
  const config = { databaseLabels: ['db', 'migration'] };
  assert.deepEqual(databaseArgs(config, { labels: ['ui'] }).argv, []);
  assert.deepEqual(databaseArgs(config, { labels: ['migration'] }).argv, ['--database']);
  assert.deepEqual(databaseArgs(config, null).argv, []);
  assert.deepEqual(databaseArgs({}, { labels: ['db'] }).argv, []);
});
