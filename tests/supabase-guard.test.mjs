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
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // A CALLER DIRECTORY THAT IS NOT THE APP, so every case below states where
    // the CLI is run FROM as well as which project it is told to read. The two
    // are separate facts since the app is named rather than moved into: a
    // default of `process.cwd()` would have made that difference invisible
    // here and unstable across machines.
    cwd: '/repo',
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
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web db reset', 'cwd /repo']);
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
  assert.deepEqual(calls, ['run --workdir /repo/apps/web status', 'cwd /repo']);
});

test('the CLI runs where the CALLER stood, and the app is NAMED rather than moved into', () => {
  // Reported 2026-09-08 by a worker in `.worktrees/209-…`: `ax supabase test db
  // apps/web/supabase/tests/database/chatting-engine.test.sql` could not be made
  // to name one file. The guard ran the CLI with `cwd` rebased to the configured
  // app, so every relative path past the first slot was re-based with it — the
  // caller's `apps/web/…` became `apps/web/apps/web/…` and vanished. A
  // passthrough command's argv belongs to the foreign CLI (`passthrough: true`,
  // ../src/commands.mjs), and moving the directory those arguments are resolved
  // from is changing their meaning.
  //
  // So the app is named with the CLI's own global flag instead. Measured against
  // Supabase CLI 2.109.1: `--workdir` is honoured for both project resolution
  // (`status --workdir apps/web` from the repo root prints `Using workdir
  // apps/web` and the project's endpoints) and path arguments (which resolve
  // against the PROCESS cwd, never against the workdir).
  const { deps, calls } = harness();
  deps.cwd = '/repo/.worktrees/209-slice';

  assert.equal(capture(() => supabase(['test', 'db', 'apps/web/supabase/tests/database/engine.test.sql'], deps)).code, 0);
  assert.deepEqual(calls, [
    'promote',
    'run --workdir /repo/apps/web test db apps/web/supabase/tests/database/engine.test.sql',
    'cwd /repo/.worktrees/209-slice',
  ]);
});

test('an environment workdir cannot redirect the CLI or the promotion subprocess', () => {
  const { deps, calls } = harness({ env: { SUPABASE_WORKDIR: '../other' } });
  const result = capture(() => supabase(['db', 'reset'], deps));
  assert.equal(result.code, 1);
  assert.deepEqual(calls, []);
  assert.match(result.err, /SUPABASE_WORKDIR/);
});

test('an explicit app workdir is consumed, and reappears as the ONE named app', () => {
  // The caller's own `--workdir` is validated against the configured app and
  // dropped (`appArguments`); the flag the CLI receives is the one ax injects.
  // So a caller who names the app gets exactly the same argv as one who does
  // not, and `apps/web` can never be applied twice.
  const { deps } = harness();
  deps.runCli = (_cli, args, { cwd }) => {
    assert.equal(cwd, '/repo');
    assert.deepEqual(args, ['--workdir', '/repo/apps/web', 'start']);
    return 7;
  };
  assert.equal(capture(() => supabase(['start', '--workdir', 'apps/web'], deps)).code, 7);
});

test('a leading workdir cannot hide db reset from isolation', () => {
  const { deps, calls } = harness();
  deps.cwd = '/repo/apps/web';
  assert.equal(capture(() => supabase(['--workdir=.', 'db', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web db reset', 'cwd /repo/apps/web']);
});

test('an absolute workdir keeps promotion and execution on the configured app', () => {
  const { deps, calls } = harness();
  deps.cwd = '/elsewhere';
  assert.equal(capture(() => supabase(['db', '--workdir', '/repo/apps/web', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web db reset', 'cwd /elsewhere']);
});

test('an outside workdir is refused before promotion or CLI execution', () => {
  const { deps, calls } = harness();
  deps.cwd = '/repo';
  const result = capture(() => supabase(['db', 'reset', '--workdir', '../other'], deps));
  assert.equal(result.code, 1);
  assert.deepEqual(calls, []);
  assert.match(result.err, /configured app/);
});

test('missing or repeated workdir values never run the CLI', () => {
  for (const args of [['start', '--workdir'], ['start', '--workdir='], ['start', '--workdir', '--debug'], ['start', '--workdir=apps/web', '--workdir=apps/web']]) {
    const { deps, calls } = harness();
    deps.cwd = '/repo';
    assert.equal(capture(() => supabase(args, deps)).code, 1);
    assert.deepEqual(calls, []);
  }
});

test('workdir comparison uses the injected canonicalizer, not a host realpath', () => {
  const { deps } = harness();
  deps.cwd = '/repo';
  const seen = [];
  deps.canonicalize = path => {
    seen.push(path);
    return path;
  };
  assert.equal(capture(() => supabase(['start', '--workdir', 'apps/web'], deps)).code, 0);
  assert.deepEqual(seen, ['/repo/apps/web', '/repo/apps/web']);
});

test('the Supabase CLI’s own help flag is forwarded, wherever it sits in the argv', () => {
  // ax widened its help read to a command's whole argv (#89), and this argv is
  // not ax's: `db push --help` is a question for the CLI, whose answer ax has
  // no business composing. The registry entry declares that ownership with
  // `passthrough: true` (../src/commands.mjs); what is asserted here is the
  // other end of it — the flag arrives, in place, unconsumed and unreordered.
  const { calls, deps } = harness({ isolated: true });

  assert.equal(capture(() => supabase(['db', 'push', '--help'], deps)).code, 0);
  assert.deepEqual(calls, ['run --workdir /repo/apps/web db push --help', 'cwd /repo']);
});


test('a leading --debug cannot hide db reset from isolation', () => {
  const { calls, deps } = harness();
  assert.equal(capture(() => supabase(['--debug', 'db', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web --debug db reset', 'cwd /repo']);
});

test('an unknown flag is refused, not promoted then executed', () => {
  const { calls, deps } = harness();
  const result = capture(() => supabase(['--not-a-supabase-flag', 'db', 'reset'], deps));
  assert.equal(result.code, 1);
  assert.deepEqual(calls, []);
  assert.match(result.err, /not-a-supabase-flag|unknown|cannot classify|refusing/i);
});

test('an unknown flag after the verb is refused, not promoted then executed', () => {
  for (const argv of [['db', '--unknown', 'reset'], ['db', '--unknown=reset'], ['db', 'reset', '--not-a-flag']]) {
    const { calls, deps } = harness();
    const result = capture(() => supabase(argv, deps));
    assert.equal(result.code, 1);
    assert.deepEqual(calls, []);
    assert.match(result.err, /unknown flag/);
  }
});


test('a value-taking global missing its value is refused before the CLI runs', () => {
  const { calls, deps } = harness();
  const result = capture(() => supabase(['db', 'reset', '--profile'], deps));
  assert.equal(result.code, 1);
  assert.deepEqual(calls, []);
});


test('help on a writing command does not promote', () => {
  const { calls, deps } = harness();
  assert.equal(capture(() => supabase(['db', 'reset', '--help'], deps)).code, 0);
  assert.deepEqual(calls, ['run --workdir /repo/apps/web db reset --help', 'cwd /repo']);
});

test('linked=false cannot bypass isolation of db reset', () => {
  const { calls, deps } = harness();
  assert.equal(capture(() => supabase(['db', 'reset', '--linked=false'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web db reset --linked=false', 'cwd /repo']);
});

test('help=false cannot hide a local write from isolation', () => {
  const { calls, deps } = harness();
  assert.equal(capture(() => supabase(['db', 'reset', '--help=false'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web db reset --help=false', 'cwd /repo']);
});

test('a malformed boolean value is refused before the CLI runs', () => {
  const { calls, deps } = harness();
  const result = capture(() => supabase(['db', 'reset', '--linked=maybe'], deps));
  assert.equal(result.code, 1);
  assert.deepEqual(calls, []);
});


test('the primary checkout never promotes — it owns the shared stack', () => {
  const { calls, deps } = harness({ primary: true });

  assert.equal(capture(() => supabase(['db', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['run --workdir /repo/apps/web db reset', 'cwd /repo']);
});

test('an already-isolated checkout runs without promoting a second time', () => {
  const { calls, deps } = harness({ isolated: true });

  assert.equal(capture(() => supabase(['migration', 'up'], deps)).code, 0);
  assert.deepEqual(calls, ['run --workdir /repo/apps/web migration up', 'cwd /repo']);
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
  assert.deepEqual(calls, ['run --workdir /repo/apps/web db reset', 'cwd /repo']);
  assert.match(err, /SHARED local database/, 'opting out is loud: the cost lands on other sessions');
});

test('GUARD=1 is the guard ON, not another way to spell the escape hatch', () => {
  const { calls, deps } = harness({ env: { [GUARD_ENV]: '1' } });

  assert.equal(capture(() => supabase(['db', 'reset'], deps)).code, 0);
  assert.deepEqual(calls, ['promote', 'run --workdir /repo/apps/web db reset', 'cwd /repo']);
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
// A stand-in executable stands for the CLI. These are the only way to prove
// what the wrapper does to a REAL process, and none of them touches Supabase or
// Docker.
//
// The stand-in refuses anything but `--workdir <absolute dir>` in its first two
// slots, which is what makes these three tests a proof of POSITION and not just
// of exit status: `node -e` was the stand-in until the app became a named flag,
// and it could not be — node rejects an argument it does not know, so the
// injected flag had nowhere to land in a test that spawns node itself.
const STAND_IN = `#!/usr/bin/env node
const [flag, dir, mode, value] = process.argv.slice(2);
if (flag !== '--workdir' || typeof dir !== 'string' || !dir.startsWith('/')) process.exit(9);
if (mode === 'exit') process.exit(Number(value));
if (mode === 'scrub') process.exit(process.env.SUPABASE_DB_PASSWORD === undefined ? 0 : 3);
process.exit(8);
`;

function standIn() {
  const dir = mkdtempSync(join(tmpdir(), 'ax-supabase-cli-'));
  const path = join(dir, 'supabase');
  writeFileSync(path, STAND_IN);
  chmodSync(path, 0o755);
  return path;
}

const spawning = extra => ({
  paths: { root: process.cwd(), main: process.cwd() },
  config: { project: { name: 'demo' }, apps: { web: '.' }, ports: {} },
  findCli: () => ({ path: standIn() }),
  isPrimary: () => true,
  ...extra,
});

test('a non-zero status from the CLI survives the wrapper', () => {
  // A wrapper that swallowed this would turn every CI step routed through it
  // green.
  const code = capture(() => supabase(['exit', '7'], spawning({ env: process.env }))).code;

  assert.equal(code, 7);
});

test('SUPABASE_DB_PASSWORD never reaches the local CLI', () => {
  // The CLI reads it for EVERY connection, so with it exported `db reset` tries
  // the REMOTE password against the local Postgres and dies on "password
  // authentication failed for user postgres".
  const env = { ...process.env, SUPABASE_DB_PASSWORD: 'remote-secret' };
  const code = capture(() => supabase(['scrub'], spawning({ env }))).code;

  assert.equal(code, 0);
});

test('the named app reaches a real CLI in the first two slots', () => {
  // Exit 9 is the stand-in's refusal: it saw something other than
  // `--workdir <absolute dir>` where ax promises to put it. This is the whole
  // repair of the reported friction, proved through a spawn rather than through
  // an injected recorder — a stub can agree with a mistake, a process cannot.
  const code = capture(() => supabase(['exit', '0'], spawning({ env: process.env }))).code;

  assert.equal(code, 0, 'the stand-in exits 9 when the first two slots are not the named app');
});
