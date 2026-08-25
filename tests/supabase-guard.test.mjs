// The guard's whole value is an ORDER: promote, verify, then run. Every case
// below pins one way that order can be got wrong, because each of them is
// silent in production — a `db reset` that ran before promotion, or ran after a
// promotion that never started a container, destroys another session's data and
// reports success.
//
// Nothing here starts a container, binds a port or invokes the Supabase CLI.
// The two tests that spawn a real process spawn `node` itself, which is how the
// exit-status contract and the SUPABASE_DB_PASSWORD scrub are proved rather
// than asserted.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLI_ENV, GUARD_ENV, invokesSupabaseCli, reachesGuard, resolveCli, supabase } from '../src/supabase-guard.mjs';

/**
 * Run the guard with every machine-touching dependency replaced, recording what
 * it did and in which order.
 *
 * `isolated` is stateful on purpose: promotion is what flips it, so a stub that
 * returned a constant could not tell "promoted, then ran" from "ran twice".
 */
function harness({ primary = false, isolated = false, promotes = true, status = 0, env = {} } = {}) {
  const calls = [];
  let promoted = isolated;

  const deps = {
    env,
    paths: { root: '/repo', main: '/repo' },
    config: { project: { name: 'demo' }, apps: { web: 'apps/web' }, ports: {} },
    findCli: () => ({ path: '/somewhere/supabase' }),
    isPrimary: () => primary,
    isIsolated: () => promoted,
    promoteCheckout: () => {
      calls.push('promote');
      if (!promotes) return { promoted: false, reason: 'the container daemon is not answering' };
      promoted = true;
      return { promoted: true, projectId: 'demo-feature-1a2b3c4d', offset: 100 };
    },
    runCli: (_cli, argv, options) => {
      calls.push(`run ${argv.join(' ')}`);
      calls.push(`cwd ${options.cwd}`);
      return status;
    },
  };

  return { calls, deps };
}

/** Capture what the guard told the human, and keep its `fatal` off the test run. */
function capture(fn) {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const exitCode = process.exitCode;

  process.stdout.write = chunk => (out.push(String(chunk)), true);
  process.stderr.write = chunk => (err.push(String(chunk)), true);
  try {
    return { code: fn(), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    // `fatal` sets process.exitCode as a side effect. Left in place it would
    // fail the whole test run on a case that asserts a refusal.
    process.exitCode = exitCode;
  }
}

test('a writing command on a shared, non-primary checkout promotes BEFORE it runs', () => {
  const { calls, deps } = harness();
  const { code, err } = capture(() => supabase(['db', 'reset'], deps));

  assert.equal(code, 0);
  assert.deepEqual(calls, ['promote', 'run db reset', 'cwd /repo/apps/web']);
  assert.match(err, /would write to the SHARED local database/);
  assert.match(err, /RESTART the dev server/);
});

test('a promotion that stops addressing another stack says so', () => {
  // The plan's WARN lines (a foreign config.toml claim, for instance) travel
  // back as data and the guard prints them: they are the only notice anyone
  // gets of containers left running under a name this checkout stopped using.
  const { deps } = harness();
  deps.promoteCheckout = () => ({
    promoted: true,
    projectId: 'demo-feature-1a2b3c4d',
    offset: 100,
    warnings: ['supabase/config.toml names stack "demo-old" on block +60, but this worktree resolves to "demo-feature-1a2b3c4d" — nothing here addresses the containers of "demo-old"'],
  });
  const { code, err } = capture(() => supabase(['db', 'reset'], deps));

  assert.equal(code, 0);
  assert.match(err, /nothing here addresses the containers of "demo-old"/);
});

test('a read-only command runs with no promotion at all', () => {
  const { calls, deps } = harness();

  assert.equal(capture(() => supabase(['status'], deps)).code, 0);
  assert.deepEqual(calls, ['run status', 'cwd /repo/apps/web']);
});

test('the primary checkout never promotes — it owns the shared stack', () => {
  const { calls, deps } = harness({ primary: true });

  assert.equal(capture(() => supabase(['db', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['run db reset', 'cwd /repo/apps/web']);
});

test('an already-isolated checkout runs without promoting a second time', () => {
  const { calls, deps } = harness({ isolated: true });

  assert.equal(capture(() => supabase(['migration', 'up'], deps)).code, 0);
  assert.deepEqual(calls, ['run migration up', 'cwd /repo/apps/web']);
});

test('a refused promotion exits non-zero and does NOT run the command', () => {
  const { calls, deps } = harness({ promotes: false });
  const { code, err } = capture(() => supabase(['db', 'reset'], deps));

  assert.equal(code, 1);
  assert.deepEqual(calls, ['promote'], 'the destructive command must not reach the shared database');
  assert.match(err, /refusing to run/);
  assert.match(err, /the container daemon is not answering/);
  assert.match(err, new RegExp(`${GUARD_ENV}=0`));
});

test('the escape hatch runs the command with no promotion', () => {
  const { calls, deps } = harness({ env: { [GUARD_ENV]: '0' } });
  const { code, err } = capture(() => supabase(['db', 'reset'], deps));

  assert.equal(code, 0);
  assert.deepEqual(calls, ['run db reset', 'cwd /repo/apps/web']);
  assert.match(err, /SHARED local database/, 'opting out is loud: the cost lands on other sessions');
});

test('GUARD=1 is the guard ON, not another way to spell the escape hatch', () => {
  const { calls, deps } = harness({ env: { [GUARD_ENV]: '1' } });

  assert.equal(capture(() => supabase(['db', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run db reset', 'cwd /repo/apps/web']);
});

test('a missing CLI is a clear refusal, not a crash and not a run', () => {
  const { calls, deps } = harness();
  deps.findCli = () => ({ error: `no supabase CLI found — set ${CLI_ENV} to one` });
  const { code, err } = capture(() => supabase(['status'], deps));

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
  assert.match(err, /no supabase CLI found/);
});

test('outside a git repository the guard refuses rather than guessing a checkout', () => {
  const { calls, deps } = harness();
  deps.paths = { root: null, main: null };

  assert.equal(capture(() => supabase(['status'], deps)).code, 1);
  assert.deepEqual(calls, []);
});

test('the CLI is resolved override, then workspace, then PATH', () => {
  const exists = new Set([
    '/override/supabase',
    '/repo/apps/web/node_modules/.bin/supabase',
    '/repo/node_modules/.bin/supabase',
    '/usr/local/bin/supabase',
  ]);
  const resolve = env => resolveCli({ appDir: '/repo/apps/web', root: '/repo', env, isExecutable: p => exists.has(p) });
  const path = { PATH: '/nowhere:/usr/local/bin' };

  assert.equal(resolve({ ...path, [CLI_ENV]: '/override/supabase' }).path, '/override/supabase');

  // The workspace binary is the version the repo pins, and only the package
  // manager puts apps/web/node_modules/.bin on PATH.
  assert.equal(resolve(path).path, '/repo/apps/web/node_modules/.bin/supabase');

  exists.delete('/repo/apps/web/node_modules/.bin/supabase');
  assert.equal(resolve(path).path, '/repo/node_modules/.bin/supabase');

  exists.delete('/repo/node_modules/.bin/supabase');
  assert.equal(resolve(path).path, '/usr/local/bin/supabase');

  exists.delete('/usr/local/bin/supabase');
  assert.match(resolve(path).error, /no supabase CLI found/);
});

test('an override that is not executable is an error, never a fallback', () => {
  // Falling through would run a DIFFERENT binary than the one asked for, which
  // is how a host's shim gets silently bypassed.
  const result = resolveCli({ appDir: '/repo/apps/web', root: '/repo', env: { [CLI_ENV]: '/typo/supabase' }, isExecutable: () => false });

  assert.match(result.error, new RegExp(`${CLI_ENV}=/typo/supabase is not executable`));
});

test('a package script is recognised as guarded only when it goes through ax', () => {
  assert.ok(reachesGuard('pnpm -w ax supabase db reset'));
  assert.ok(reachesGuard('cd ../.. && ax supabase start'));
  assert.ok(!reachesGuard('supabase db reset'));
  assert.ok(!reachesGuard('node_modules/.bin/supabase status'));

  assert.ok(invokesSupabaseCli('supabase db reset'));
  assert.ok(invokesSupabaseCli('node_modules/.bin/supabase status'));
  assert.ok(invokesSupabaseCli('pnpm --filter web supabase db reset'));
  assert.ok(invokesSupabaseCli('cd apps/web && SUPABASE_DB_PASSWORD= supabase db push --local'));
  assert.ok(!invokesSupabaseCli('next dev'));

  // `supabase` names a DIRECTORY in every one of these repositories, so it
  // appears as an argument far more often than as a binary. Matching the name
  // anywhere would report each of these as a script that contaminates every
  // session — a doctor finding that fails the exit code on a script which never
  // touches the CLI.
  assert.ok(!invokesSupabaseCli('rm -rf supabase'));
  assert.ok(!invokesSupabaseCli('prettier --write supabase'));
  assert.ok(!invokesSupabaseCli('sqlfluff lint supabase/migrations'));
  assert.ok(!invokesSupabaseCli('pnpm run supabase:start'), 'a script NAME is not the binary; the script it names is what gets checked');
});

// --- The real child process ------------------------------------------------
//
// `node` stands in for the CLI. These two are the only way to prove what the
// wrapper does to a real process, and neither one touches Supabase or Docker.

const spawning = extra => ({
  paths: { root: process.cwd(), main: process.cwd() },
  config: { project: { name: 'demo' }, apps: { web: '.' }, ports: {} },
  findCli: () => ({ path: process.execPath }),
  isPrimary: () => true,
  ...extra,
});

test('a non-zero status from the CLI survives the wrapper', () => {
  // A wrapper that swallowed this would turn every CI step routed through it
  // green.
  const code = capture(() => supabase(['-e', 'process.exit(7)'], spawning({ env: process.env }))).code;

  assert.equal(code, 7);
});

test('SUPABASE_DB_PASSWORD never reaches the local CLI', () => {
  // The CLI reads it for EVERY connection, so with it exported `db reset` tries
  // the REMOTE password against the local Postgres and dies on "password
  // authentication failed for user postgres".
  const env = { ...process.env, SUPABASE_DB_PASSWORD: 'remote-secret' };
  const probe = '-e';
  const code = capture(() =>
    supabase([probe, 'process.exit(process.env.SUPABASE_DB_PASSWORD === undefined ? 0 : 3)'], spawning({ env })),
  ).code;

  assert.equal(code, 0);
});
