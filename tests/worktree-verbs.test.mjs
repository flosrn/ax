// What the two DESTRUCTIVE verbs are allowed to touch.
//
// Every case here was a real defect that the rest of the suite passed straight
// through, and each one of them destroyed something without telling the user:
// tracked source deleted as a "build cache", the whole checkout reclaimed from a
// subdirectory argument, the WRONG worktree of two sharing a basename removed at
// exit 0, an unrelated migration script killed, a tree stripped by a command
// that then reported failure. So these run the real `bin/ax.mjs` against real
// repositories with real `git worktree add`, and they assert on the survivors —
// what is still there afterwards is the only evidence that matters.
//
// The reaping cases spawn DETACHED victims on purpose: a child sharing this
// process's group is spared by the reaper's own-group guard, so an attached
// victim would survive for the wrong reason and prove nothing.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { reapable } from '../src/worktree/clean.mjs';
import { locateWorktree, withinPath } from '../src/worktree/locate.mjs';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

const CONFIG = {
  project: { name: 'demo' },
  // Configured exactly as the schema documents `caches`: "extra workspace roots
  // whose .next/.turbo/test output a worktree cleanup reclaims".
  apps: { web: 'apps/web', caches: ['packages/ui'] },
  vendor: { repo: 'makerkit/kit' },
};

const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'ignore' });
const file = (path, contents = 'x\n') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Run the real CLI. `NO_COLOR` keeps the assertions readable. */
function ax(cwd, ...args) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.AX_MAIN_CHECKOUT; // an ambient override would point every test at another checkout
  const result = spawnSync(process.execPath, [join(PACKAGE, 'bin', 'ax.mjs'), 'worktree', ...args], { cwd, encoding: 'utf8', env });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const fixtures = [];
const victims = [];

/** A fresh repository per test: worktree basenames must not leak between cases. */
function repo() {
  // realpath up front: os.tmpdir() is a symlink on macOS, git reports physical
  // paths, and both the process scan and the locator compare physically.
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ax-verbs-')));
  fixtures.push(fixture);
  const main = join(fixture, 'main');

  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  file(join(main, 'ax.config.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  file(join(main, 'apps', 'web', 'package.json'), '{"name":"web"}\n');
  file(join(main, 'packages', 'ui', 'src', 'Button.tsx'), 'export const Button = () => null;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'fixture');
  return { fixture, main };
}

const worktree = (main, path, branch) => {
  git(main, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
};

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A long-lived process whose cwd is inside `cwd`, running `script`.
 *
 * Detached so it gets its own process group — see the header.
 */
async function victim(cwd, script) {
  file(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  victims.push(child.pid);
  // The scan reads the kernel's view (/proc, or lsof), which needs the process
  // to actually be up.
  await sleep(400);
  assert.equal(alive(child.pid), true, `victim ${script} did not start`);
  return child.pid;
}

async function died(pid, within = 5000) {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return false;
}

after(() => {
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already reaped, which is what most of these tests assert.
    }
  }
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

test('a configured cache ROOT loses its build output and keeps its source', () => {
  // The defect: `apps.caches` entries were appended to the delete set RAW while
  // every other `apps.*` value got the cache names appended, so a project
  // following the schema got `rm -rf packages/ui` — tracked source included —
  // reported as `removed 7 build cache path(s)`.
  const { main } = repo();
  const tree = worktree(main, join(dirname(main), 'cache'), 'cache');

  file(join(tree, '.next', 'build'));
  file(join(tree, 'apps', 'web', '.next', 'build'));
  file(join(tree, 'packages', 'ui', '.next', 'build'));
  file(join(tree, 'packages', 'ui', '.turbo', 'log'));

  const { status, out } = ax(main, 'clean', tree);

  assert.equal(status, 0, out);
  assert.equal(existsSync(join(tree, 'packages', 'ui', 'src', 'Button.tsx')), true, 'tracked source was deleted as a cache');
  assert.equal(existsSync(join(tree, 'packages', 'ui', '.next')), false);
  assert.equal(existsSync(join(tree, 'packages', 'ui', '.turbo')), false);
  assert.equal(existsSync(join(tree, 'apps', 'web', '.next')), false);
  assert.equal(existsSync(join(tree, '.next')), false);
  // Only paths that existed are counted — the old message claimed seven.
  assert.match(out, /removed 4 build cache path/);
});

test('a cache target that escapes the worktree refuses the whole clean', async () => {
  const { fixture, main } = repo();
  const tree = worktree(main, join(fixture, 'escaper'), 'escaper');
  const outside = join(fixture, 'outside');
  file(join(outside, '.next', 'precious'));
  file(join(tree, '.next', 'build'));
  const server = await victim(tree, join(tree, 'node_modules', '.bin', 'devserver.mjs'));

  // A config is a file anyone can edit, and every path in it reaches rmSync. A
  // clean that skips the bad entries and exits 0 is the same false success the
  // raw-`caches` defect hid behind, so the whole command refuses.
  file(join(tree, 'ax.config.json'), `${JSON.stringify({ ...CONFIG, apps: { web: 'apps/web', caches: ['../outside', outside] } }, null, 2)}\n`);

  const { status, out } = ax(main, 'clean', tree);

  assert.equal(status, 1, out);
  assert.match(out, /refusing to delete/);
  assert.match(out, /nothing was reclaimed/);
  assert.equal(existsSync(join(outside, '.next', 'precious')), true, 'a cache path outside the worktree was deleted');
  assert.equal(existsSync(join(tree, '.next')), true, 'the tree was partially reclaimed by a command that refused');
  assert.equal(alive(server), true, 'processes were reaped for a config this command refuses to act on');
});

test('clean refuses a subdirectory and a stale directory instead of escalating to the checkout', () => {
  // `repoPaths(target)` answers `git rev-parse --show-toplevel`, so `apps/web`
  // resolved to the checkout ROOT: the live reproduction killed an unrelated
  // node process and deleted six cache paths.
  const { main } = repo();
  file(join(main, 'apps', 'web', '.next', 'build'));
  mkdirSync(join(main, '.worktrees', 'typo'), { recursive: true });

  const subdirectory = ax(main, 'clean', 'apps/web');
  assert.equal(subdirectory.status, 1, subdirectory.out);
  assert.match(subdirectory.out, /not a registered worktree/);

  const stale = ax(main, 'clean', '.worktrees/typo');
  assert.equal(stale.status, 1, stale.out);
  assert.match(stale.out, /not a registered worktree/);

  assert.equal(existsSync(join(main, 'apps', 'web', '.next')), true, 'the whole checkout was reclaimed from a subpath');
});

test('two worktrees sharing a basename are refused with both paths, never resolved by position', () => {
  const { fixture, main } = repo();
  const first = worktree(main, join(fixture, 'one', 'feat'), 'feat-a');
  const second = worktree(main, join(fixture, 'two', 'feat'), 'feat-b');

  const { status, out } = ax(main, 'rm', 'feat');

  assert.equal(status, 1, out);
  assert.ok(out.includes(first), `refusal does not name ${first}: ${out}`);
  assert.ok(out.includes(second), `refusal does not name ${second}: ${out}`);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
});

test('a bare name means the worktree the caller is standing in', () => {
  // The measured loss: standing in /axfix/real/feat, `ax worktree rm feat`
  // cleaned and deleted /axfix/feat — exit 0, the other tree gone.
  const { fixture, main } = repo();
  const other = worktree(main, join(fixture, 'one', 'feat'), 'feat-a');
  const here = worktree(main, join(fixture, 'two', 'feat'), 'feat-b');

  assert.deepEqual(locateWorktree('feat', { cwd: here, root: main }), { path: here });
  assert.deepEqual(locateWorktree('feat', { cwd: other, root: main }), { path: other });

  // End to end it resolves to `here` and is then refused for being the cwd —
  // which is the guard that never fired while the wrong tree was being chosen.
  const { status, out } = ax(here, 'rm', 'feat');
  assert.equal(status, 1, out);
  assert.match(out, /outside the worktree you are removing/);
  assert.equal(existsSync(other), true, 'the OTHER worktree of that name was removed');
  assert.equal(existsSync(here), true);
});

test('/x/feat-2 is not inside /x/feat, so a correct removal is not refused', () => {
  const { fixture, main } = repo();
  const target = worktree(main, join(fixture, 'feat'), 'feat');
  const neighbour = worktree(main, join(fixture, 'feat-2'), 'feat-2');

  assert.equal(withinPath(neighbour, target), false);
  assert.equal(withinPath(join(target, 'apps'), target), true);
  assert.equal(withinPath(target, target), true);

  const { status, out } = ax(neighbour, 'rm', 'feat');

  assert.equal(status, 0, out);
  assert.equal(existsSync(target), false, 'the removal was refused from a directory that is not inside it');
  assert.equal(existsSync(neighbour), true);
});

test('rm reaps NOTHING before refusing a dirty worktree', async () => {
  // git refuses this removal without --force. Cleaning first meant the user read
  // `exit 1` — reasonably believing nothing had happened — with their dev server
  // killed, their .next deleted and their database stack stopped.
  const { fixture, main } = repo();
  const tree = worktree(main, join(fixture, 'dirty'), 'dirty');
  file(join(tree, '.next', 'build'));
  file(join(tree, 'uncommitted.txt'));
  const server = await victim(tree, join(tree, 'node_modules', '.bin', 'devserver.mjs'));

  const { status, out } = ax(main, 'rm', 'dirty');

  assert.equal(status, 1, out);
  assert.match(out, /uncommitted change/);
  assert.match(out, /--force/);
  assert.equal(alive(server), true, 'the dev server was killed by a command that then refused');
  assert.equal(existsSync(join(tree, '.next')), true, 'build output was deleted by a command that then refused');
  assert.equal(existsSync(tree), true);
  assert.doesNotMatch(out, /asked \d+ process/);
});

test('a node process that is not this tree\u2019s dev tooling survives a reap', async () => {
  // `^node` matched every node process whose cwd was in the tree: a second agent
  // session, a REPL, or — measured, TERMed then KILLed, reported only as `node` —
  // a migration script.
  const { fixture, main } = repo();
  const tree = worktree(main, join(fixture, 'reap'), 'reap');
  const bystander = await victim(tree, join(tree, 'scripts', 'prod-data-migration.mjs'));
  const server = await victim(tree, join(tree, 'node_modules', '.bin', 'devserver.mjs'));

  const { status, out } = ax(main, 'clean', tree);
  assert.equal(status, 0, out);

  // The dev server dying is what proves the scan ran at all: without it, the
  // bystander surviving would mean nothing.
  assert.equal(await died(server), true, `the tree\u2019s own dev process was not reaped: ${out}`);
  assert.equal(alive(bystander), true, `an unrelated node process was killed: ${out}`);
});

test('reapable narrows node to this tree\u2019s dev tooling, and reaps bun and deno', () => {
  const root = '/x/feat';
  const lines = {
    11: '/usr/bin/node /x/feat/scripts/migrate.mjs',
    12: '/usr/bin/node /x/feat/node_modules/.bin/next dev',
    13: '/usr/bin/node --experimental-repl-await',
    14: '/opt/bun/bin/bun run dev',
    15: 'deno task dev',
    16: '/usr/bin/node /elsewhere/bin/vitest run',
  };
  const may = reapable(root, pid => lines[pid]);

  assert.equal(may({ pid: 11, comm: 'node' }), false, 'a migration script is not dev tooling');
  assert.equal(may({ pid: 12, comm: 'node' }), true);
  assert.equal(may({ pid: 13, comm: 'node' }), false, 'a REPL holds a human\u2019s state');
  // `bun run dev` and `deno task dev` name no path at all, so only the runtime
  // name is left to go on — and a Bun dev server used to survive cleanup
  // entirely, which leaves a port bound under a deleted worktree.
  assert.equal(may({ pid: 14, comm: 'bun' }), true, 'a Bun dev server was never reaped at all');
  assert.equal(may({ pid: 15, comm: 'deno' }), true);
  assert.equal(may({ pid: 16, comm: 'node' }), true, 'a known dev binary counts wherever it lives');
  // A retitled `next dev` worker has no worktree path left in its argv; its
  // name is the only thing that survives, and it is enough.
  assert.equal(may({ pid: 99, comm: 'next-server' }), true);
});

test('an invalid ax.config.json refuses the removal instead of leaking what it names', async () => {
  // `vendor.repo` must be owner/name — the shape of a branch that predates a
  // schema change. The old code read "invalid" as "absent", reported `no
  // ax.config.json`, skipped the database teardown, the cache reclaim and the
  // skip-worktree restore, and returned 0 — so `rm --force` deleted the tree
  // with seven containers still running under it.
  const { fixture, main } = repo();
  const tree = worktree(main, join(fixture, 'stale'), 'stale');
  file(join(tree, 'ax.config.json'), `${JSON.stringify({ ...CONFIG, vendor: { repo: 'kit' } }, null, 2)}\n`);
  git(tree, 'commit', '-qam', 'a config its branch predates');
  file(join(tree, '.next', 'build'));
  const server = await victim(tree, join(tree, 'node_modules', '.bin', 'devserver.mjs'));

  const cleaned = ax(main, 'clean', tree);
  assert.equal(cleaned.status, 1, cleaned.out);
  assert.match(cleaned.out, /problem\(s\) in ax\.config\.json/);
  assert.match(cleaned.out, /vendor\.repo/);
  assert.equal(alive(server), true, 'processes were reaped for a config that could not be read');

  const removed = ax(main, 'rm', 'stale', '--force');
  assert.equal(removed.status, 1, removed.out);
  assert.match(removed.out, /cleanup refused/);
  assert.equal(existsSync(tree), true, 'the worktree was deleted while still holding unreclaimed state');
  assert.equal(existsSync(join(tree, '.next')), true);
});

test('a recorded block whose config names a foreign stack stops nothing', () => {
  // The wiring this file owns: cleanup asks `ownsStack` whether the id in
  // config.toml is the id THIS worktree resolves to, and a foreign one — a
  // config copied between worktrees, or the machine's shared id — is refused.
  // `supabase stop` against it would take the database out from under whoever
  // that stack belongs to, which is the opposite of cleanup.
  const { fixture, main } = repo();
  const tree = worktree(main, join(fixture, 'dbfeat'), 'dbfeat');
  file(join(tree, 'apps', 'web', '.env.local'), 'AX_SUPABASE_OFFSET=60\n');
  file(join(tree, 'apps', 'web', 'supabase', 'config.toml'), 'project_id = "someone-elses-stack"\n');

  const { status, out } = ax(main, 'clean', tree);

  assert.equal(status, 0, out);
  assert.match(out, /does not name a stack this worktree owns/);
  assert.match(out, /nothing was stopped/);
  assert.doesNotMatch(out, /stopped isolated stack/);
  assert.doesNotMatch(out, /restored to the committed version/);
});
