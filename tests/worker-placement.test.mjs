// The placement rules, exercised through placeLocal's own interface — above
// all the reuse rule, which used to be reachable only through the whole dispatch
// pipeline and its seven-subcommand Orca stub: another ticket's tree is never
// lent (GAP-35 vs gap-357), an earlier slug of the SAME ticket is exactly the
// tree to reuse, and a --name dispatch matches whole names only.
//
// The reuse question is grounded in the worktrees git has REGISTERED, filtered
// to the roots ax places into, so every case below injects both — the tree list
// and the runtime's answer about its own workspaces root. #84 is the case that
// forced that: Orca places outside `<root>/.worktrees`, the old scan read only
// that one directory, and a retry after a failed `ax worktree setup` therefore
// asked for a second tree and got `<request>-2`.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  // realpath first: os.tmpdir() is a symlink on macOS, and every path here is
  // compared against one git or the runtime answered — both physical.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-place-')));
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

/** What git answers for the trees it has registered, in the shape locate.mjs reads. */
const registered = (...paths) => paths.map(path => ({ path }));

/**
 * A host: the runtime answering for its own workspaces root, and `worktree
 * create` placing into it — suffixing a name it has already used, which is what
 * Orca does with a taken name and where `-2` comes from.
 *
 * `placed` doubles as git's registry: Orca runs `git worktree add` and only THEN
 * runs the setup hook, so a tree whose provisioning failed is registered.
 */
function host(workspaces, { main = '' } = {}) {
  const placed = [];
  const state = { creates: 0, listed: 0 };
  const receipt = result => ({ status: 0, stderr: '', receipt: { ok: true, result } });
  const run = args => {
    const line = args.join(' ');
    if (line.startsWith('worktree list')) {
      state.listed += 1;
      const rows = placed.map(path => ({ path, isMainWorktree: false }));
      if (main !== '') rows.unshift({ path: main, isMainWorktree: true });
      return receipt({ worktrees: rows });
    }
    if (line.startsWith('worktree create')) {
      state.creates += 1;
      const name = args[args.indexOf('--name') + 1];
      let leaf = name;
      for (let n = 2; placed.includes(join(workspaces, leaf)); n += 1) leaf = `${name}-${n}`;
      const path = join(workspaces, leaf);
      mkdirSync(path, { recursive: true });
      placed.push(path);
      return receipt({ worktree: { path } });
    }
    return { status: 1, stderr: '', receipt: { ok: false, error: { code: 'unexpected' } } };
  };
  return { run, state, placed, trees: () => registered(...placed) };
}

/** A runtime that reports the given trees for this repo and refuses everything else. */
const reports = (rows, calls = []) => args => {
  calls.push(args);
  if (args.join(' ').startsWith('worktree list')) {
    return { status: 0, stderr: '', receipt: { ok: true, result: { worktrees: rows } } };
  }
  return assert.fail(`this case must not reach Orca for ${args.join(' ')}`);
};

/** `ax worktree setup`, doing the one thing placement proves afterwards. */
const setupWrites = (seen = []) => (argv, { cwd }) => {
  seen.push(cwd);
  provisioned(cwd);
  return 0;
};

const options = (root, over = {}) => ({
  request: 'gap-35-work',
  issue: 'gap-35',
  slug: '',
  named: false,
  paths: { root, main: root },
  dispatchConfig: {},
  ticket: null,
  exec: () => assert.fail('no worktree tool is declared, so none may run'),
  run: reports([]),
  trees: [],
  cwd: root,
  dry: false,
  probe: false,
  setupFn: () => 0,
  ...over,
});

test('an earlier slug of the same ticket is reused; another ticket never lends its tree', () => {
  const root = fixture(['gap-35-auth', 'gap-357-payments']);
  const mine = join(root, '.worktrees', 'gap-35-auth');
  const placed = placeLocal(options(root, { trees: registered(mine, join(root, '.worktrees', 'gap-357-payments')) }));

  assert.equal(placed.worktree, mine);
  assert.equal(placed.refused, undefined);
  assert.equal(placed.cannot, undefined);
  assert.ok(placed.notes.some(line => line.includes('reusing')), 'the reuse is announced, not silent');
});

test('gap-357 alone matches nothing for gap-35, so Orca places a fresh tree', () => {
  const root = fixture(['gap-357-payments']);
  const machine = host(join(root, 'workspaces'));
  const placed = placeLocal(
    options(root, {
      run: machine.run,
      trees: registered(join(root, '.worktrees', 'gap-357-payments')),
      setupFn: setupWrites(),
    }),
  );

  assert.equal(placed.worktree, join(root, 'workspaces', 'gap-35-work'));
  assert.equal(machine.state.creates, 1, 'exactly one create, for this request');
});

test('a --name dispatch matches whole names only: `auth` never reuses `auth-refactor`', () => {
  const root = fixture(['auth-refactor']);
  const machine = host(join(root, 'workspaces'));
  const placed = placeLocal(
    options(root, {
      request: 'auth',
      issue: '',
      named: true,
      run: machine.run,
      trees: registered(join(root, '.worktrees', 'auth-refactor')),
      setupFn: setupWrites(),
    }),
  );

  assert.equal(placed.worktree, join(root, 'workspaces', 'auth'), "auth-refactor is a different piece of work, already someone's");
  assert.equal(machine.state.creates, 1);
});

test('#84: a retry after a failed setup reuses the tree Orca placed, instead of minting <request>-2', () => {
  const root = fixture([]);
  const workspaces = join(root, 'workspaces');
  const machine = host(workspaces);

  // The reported dispatch: Orca places, `ax worktree setup` refuses (the 0.17.0
  // validator on a 0.18.0 config), nothing is recorded, the tree stays.
  const failed = placeLocal(options(root, { run: machine.run, trees: machine.trees(), setupFn: () => 1 }));
  assert.match(failed.cannot, /ax worktree setup did not finish/);
  assert.equal(machine.state.creates, 1);
  const orphan = join(workspaces, 'gap-35-work');
  assert.equal(machine.placed[0], orphan);
  assert.ok(existsSync(orphan), 'no cannot-establish path removes what it placed');

  // The retry: same argv, same slug.
  const setups = [];
  const retry = placeLocal(options(root, { run: machine.run, trees: machine.trees(), setupFn: setupWrites(setups) }));

  assert.equal(retry.worktree, orphan, 'the tree of the failed dispatch is this dispatch\u2019s tree');
  assert.equal(machine.state.creates, 1, 'no second create, so Orca never suffixes a name');
  assert.equal(retry.cannot, undefined);
  assert.deepEqual(setups, [orphan], 'a reused tree still goes through provisioning');
  assert.ok(retry.notes.some(line => line.includes('reusing')));
});

test('a differently-slugged dispatch of the same issue reuses the tree, wherever the runtime placed it', () => {
  const root = fixture([]);
  const workspaces = join(root, 'workspaces');
  const earlier = join(workspaces, 'gap-35-auth');
  mkdirSync(earlier, { recursive: true });
  const calls = [];
  const setups = [];
  const placed = placeLocal(
    options(root, {
      request: 'gap-35-loading',
      slug: 'loading',
      run: reports([{ path: earlier, isMainWorktree: false }], calls),
      trees: registered(earlier),
      setupFn: setupWrites(setups),
    }),
  );

  assert.equal(placed.worktree, earlier);
  assert.deepEqual(setups, [earlier], 'a tree that never finished provisioning is lent, and provisioned');
  assert.ok(calls.every(argv => argv[1] !== 'create'), 'nothing was created');
});

test('a registered worktree under no placement root is never lent, however exactly its name matches', () => {
  const root = fixture([]);
  const elsewhere = provisioned(join(root, 'scratch', 'gap-35-work'));
  const machine = host(join(root, 'workspaces'));
  const placed = placeLocal(options(root, { run: machine.run, trees: registered(elsewhere), setupFn: setupWrites() }));

  assert.equal(placed.worktree, join(root, 'workspaces', 'gap-35-work'), 'a hand-made tree is not this dispatch\u2019s tree');
  assert.equal(machine.state.creates, 1);
});

test('a tree the runtime manages does not make its NEIGHBOURS lendable', () => {
  // The first version of this took each reported tree's parent directory as a
  // placement root, so one runtime-managed tree outside the workspaces root —
  // an adopted folder, an import — promoted the whole directory it sat in. Here
  // the runtime manages `/…/loose/other-thing` and a hand-made
  // `/…/loose/gap-35-work` sits beside it: the name matches exactly, and it is
  // still nobody's dispatch.
  const root = fixture([]);
  const loose = join(root, 'loose');
  const adopted = provisioned(join(loose, 'other-thing'));
  const neighbour = provisioned(join(loose, 'gap-35-work'));
  const machine = host(join(root, 'workspaces'));
  const placed = placeLocal(
    options(root, {
      run: args => (args.join(' ').startsWith('worktree list')
        ? { status: 0, stderr: '', receipt: { ok: true, result: { worktrees: [{ path: adopted, isMainWorktree: false }] } } }
        : machine.run(args)),
      trees: registered(adopted, neighbour),
      setupFn: setupWrites(),
    }),
  );

  assert.equal(placed.worktree, join(root, 'workspaces', 'gap-35-work'), 'the row is the evidence, not the directory it sits in');
  assert.equal(machine.state.creates, 1);
});

test('an unreadable GIT registry refuses too: both reads have to answer before a create', () => {
  // The runtime answering is only half of it. `listWorktrees` reports `[]` for a
  // failed read, so a successful Orca list beside a failed git read used to walk
  // straight into the create this ticket exists to prevent.
  const root = fixture([]);
  const machine = host(join(root, 'workspaces'));
  const placed = placeLocal(
    options(root, {
      // No `trees` at all, and a root that is no repository: the read cannot answer.
      trees: undefined,
      paths: { root: join(root, 'nowhere'), main: join(root, 'nowhere') },
      run: machine.run,
    }),
  );

  assert.match(placed.cannot, /git worktree list cannot say/);
  assert.equal(machine.state.creates, 0, 'nothing is placed while the registry is unknown');
});

test('the primary checkout is never lent, even when --name is the checkout directory\u2019s own basename', () => {
  const root = fixture([]);
  const workspaces = join(root, 'workspaces');
  const machine = host(workspaces, { main: root });
  const name = root.split('/').pop();
  const placed = placeLocal(
    options(root, {
      request: name,
      issue: '',
      named: true,
      run: machine.run,
      trees: registered(root),
      setupFn: setupWrites(),
    }),
  );

  assert.equal(placed.worktree, join(workspaces, name), 'a child dispatched into the primary checkout works on main');
  assert.equal(machine.state.creates, 1);
});

test('two lendable candidates for one subject are a cannot-establish naming both, not a pick', () => {
  const root = fixture(['gap-35-work']);
  const workspaces = join(root, 'workspaces');
  const second = provisioned(join(workspaces, 'gap-35-work-2'));
  const first = join(root, '.worktrees', 'gap-35-work');
  const calls = [];
  const placed = placeLocal(
    options(root, {
      run: reports([{ path: second, isMainWorktree: false }], calls),
      trees: registered(first, second),
      setupFn: () => assert.fail('an ambiguous subject is refused before anything is provisioned'),
    }),
  );

  assert.match(placed.cannot, /gap-35/);
  assert.ok(placed.cannot.includes(first) && placed.cannot.includes(second), 'every candidate is named');
  assert.match(placed.repair, /--worktree /);
  assert.ok(calls.every(argv => argv[1] !== 'create'), 'no create is issued');
  assert.ok(existsSync(first) && existsSync(second), 'and nothing is removed');
});

test('a runtime that cannot list this repository\u2019s worktrees refuses, rather than placing a second tree', () => {
  const root = fixture([]);
  const calls = [];
  const placed = placeLocal(
    options(root, {
      run: args => {
        calls.push(args);
        return { status: 1, stderr: '', receipt: { ok: false, error: { code: 'repo_not_found' } } };
      },
      trees: [],
    }),
  );

  assert.match(placed.cannot, /repo_not_found/);
  assert.ok(calls.every(argv => argv[1] !== 'create'), 'an unknown answer is not an empty one (F-028)');
});

test('the unprovisioned-tree refusal names both retry routes, and removes nothing', () => {
  const root = fixture([]);
  const machine = host(join(root, 'workspaces'));
  const placed = placeLocal(options(root, { run: machine.run, trees: machine.trees(), setupFn: () => 0 }));

  const tree = join(root, 'workspaces', 'gap-35-work');
  assert.match(placed.cannot, new RegExp(`${CONTEXT_PATH}`));
  assert.match(placed.repair, /ax worktree setup/);
  assert.match(placed.repair, new RegExp(`--worktree ${tree}`), 'the second supported route is named too');
  assert.ok(existsSync(tree), 'the tree the retry will reuse is still there');
});

test('databaseArgs answers --database exactly when a declared label is carried', () => {
  const config = { databaseLabels: ['db', 'migration'] };
  assert.deepEqual(databaseArgs(config, { labels: ['ui'] }).argv, []);
  assert.deepEqual(databaseArgs(config, { labels: ['migration'] }).argv, ['--database']);
  assert.deepEqual(databaseArgs(config, null).argv, []);
  assert.deepEqual(databaseArgs({}, { labels: ['db'] }).argv, []);
});
