// `ax supabase <args…>` — the guard that stands in front of the Supabase CLI.
//
// One local Supabase stack serves the whole machine by default, so a `db reset`,
// a migration or a typegen run from one checkout rewrites the database every
// other concurrent session is reading. There is no error and no warning; the
// damage only shows up later, as tests failing in a branch that changed nothing.
//
// A worktree could be given its own stack at creation time, but that guesses:
// predicting "will this branch touch the database?" from a ticket's prose spins
// seven containers and a gigabyte for every ticket that merely says the word
// Supabase. So a worktree starts on the SHARED stack and earns its own here, the
// first time it actually runs a command that would write.
//
// This module owns none of that policy. Which commands count is
// `classifyCommand`; whether a checkout is already promoted is
// `isIsolatedConfig`; what an isolated checkout should look like is
// `planWorktree`; and the promotion itself is `promote`. What is left here, and
// only here, is the sequencing: resolve a binary, promote BEFORE running,
// REFUSE rather than run when promotion did not take, and hand the caller the
// child's own exit status.

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import { loadCheckoutConfig, repoPaths } from './config.mjs';
import { removeBlock, writeBlock } from './dotenv.mjs';
import { currentBranch, isMainCheckout } from './git.mjs';
import { fatal, note, warn } from './log.mjs';
import { identify } from './worktree/identity.mjs';
import { physical } from './worktree/locate.mjs';
import { PREFIX, planWorktree } from './worktree/plan.mjs';
import { probeAll, readWorktreeRecord } from './worktree/probes.mjs';
import { classifyCommand, configProjectId, isIsolatedConfig, promoteFromPlan } from './worktree/supabase.mjs';


/** Names the CLI to run when neither the workspace nor PATH has an acceptable one. */
export const CLI_ENV = 'AX_SUPABASE_CLI';

/**
 * Set to anything but `1` and the guard steps aside.
 *
 * It exists because a human who knows a command is harmless must not be blocked
 * by a heuristic, and because a guard with no way out is a guard people delete.
 * Anything other than `1` disables it — matching the shell wrapper this
 * replaced, so a habitual `=0` and a stray `=false` behave the same.
 */
export const GUARD_ENV = 'AX_SUPABASE_GUARD';

const CLI_NAME = 'supabase';

/**
 * How a project's own scripts must spell this command to reach the guard.
 *
 * Exported because `worktree/doctor` checks that a project's package.json still
 * routes its `supabase:*` scripts through here. That check has to compare
 * against this string rather than re-derive it, or the day the command is
 * renamed the doctor starts reporting a healthy project as broken.
 */
export const GUARDED_INVOCATION = `ax ${CLI_NAME}`;

/** Does this script line reach the guard? */
export const reachesGuard = script => new RegExp(`(?:^|[\\s;&|(])${GUARDED_INVOCATION}(?:\\s|$)`).test(String(script));

/** Runners that stand in front of the real command word without being it. */
const WRAPPERS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'run', 'exec', 'env', 'cross-env', 'dotenv']);

/** Wrapper flags whose VALUE is the next token, not the command. */
const TAKES_VALUE = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace', '-u']);

const bare = token => token.replace(/^[("']+/, '').split('/').pop();

/**
 * The command word of every `;`/`&&`/`|`-separated segment of a script line.
 *
 * Anchoring on the command word, rather than matching the name anywhere, is
 * what keeps `rm -rf supabase` and `prettier --write supabase` out of a doctor
 * finding that fails a project's exit code. The name appears as an ARGUMENT far
 * more often than as a binary — it is also a directory in every one of these
 * repositories.
 */
function commandWords(line) {
  return String(line)
    .split(/\s*(?:\|\||&&|[;|&])\s*/)
    .map(segment => {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      let index = 0;

      while (index < tokens.length) {
        const token = tokens[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) index += 1; // FOO=bar prefix
        else if (TAKES_VALUE.has(token)) index += 2;
        else if (token.startsWith('-')) index += 1;
        else if (WRAPPERS.has(bare(token))) index += 1;
        else break;
      }

      return index < tokens.length ? bare(tokens[index]) : '';
    });
}

/** Does this script line invoke the Supabase CLI as a command? */
export const invokesSupabaseCli = script => commandWords(script).includes(CLI_NAME);

/**
 * The CLI reads `SUPABASE_DB_PASSWORD` for EVERY database connection, local ones
 * included. Developers export it so a deploy can link and push to the remote
 * project; with it set, `db reset`, `db test` and `gen types --local` try to
 * authenticate against the local Postgres with the REMOTE password and die on
 * "password authentication failed for user postgres". The local container only
 * ever accepts `postgres`. Deploy paths keep the variable and do not come
 * through this wrapper.
 */
const REMOTE_ONLY_KEYS = ['SUPABASE_DB_PASSWORD'];

const executable = path => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Which binary runs.
 *
 * The workspace binary wins over PATH deliberately: it is the version the repo
 * pins, and only the package manager puts an app's `node_modules/.bin` on PATH
 * — so a bare `supabase` here exits 127 for anyone invoking `ax` directly rather
 * than through a package script.
 */
export function resolveCli({ appDir, root, env = process.env, isExecutable = executable }) {
  const override = env[CLI_ENV];
  if (override) {
    // A host supplying its own shim gets the last word, but a typo in that path
    // must not fall through to a different binary than the one asked for.
    return isExecutable(override) ? { path: override } : { error: `${CLI_ENV}=${override} is not executable` };
  }

  for (const dir of [appDir, root]) {
    const candidate = join(dir, 'node_modules', '.bin', CLI_NAME);
    if (isExecutable(candidate)) return { path: candidate };
  }

  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, CLI_NAME);
    if (isExecutable(candidate)) return { path: candidate };
  }

  return { error: `no ${CLI_NAME} CLI found — install this workspace's dependencies, or set ${CLI_ENV} to one` };
}

/** Resolve explicit workdir against the caller, never against the rebased CLI cwd. */
function appArguments(argv, cwd, appDir, canonicalize = physical) {
  const args = [];
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      args.push(...argv.slice(i));
      break;
    }
    if (arg !== '--workdir' && !arg.startsWith('--workdir=')) {
      args.push(arg);
      continue;
    }
    if (seen) return { error: '--workdir must be specified only once' };
    seen = true;
    const value = arg === '--workdir' ? argv[++i] : arg.slice('--workdir='.length);
    if (!value || value.startsWith('-')) return { error: '--workdir requires a project directory' };
    if (canonicalize(resolve(cwd, value)) !== canonicalize(appDir)) {
      return { error: '--workdir must name the configured app; ax cannot isolate a different Supabase project' };
    }
  }
  return { args };
}

/**
 * Run the Supabase CLI, promoting this checkout first when the command would
 * otherwise write to a database other checkouts are reading.
 *
 * CLI arguments are forwarded, except that an explicit `--workdir` is resolved
 * from the caller and must name the configured app. It is consumed before both
 * isolation and execution: protecting one app while the CLI targets another
 * would allow a destructive command to bypass isolation (#222).
 * The comparison is `deps.canonicalize`, defaulting to `physical`, so a test
 * can exercise the production equality without a host filesystem.
 * `--help` (or `-h`) in the FIRST slot is answered by `runCli`; the Supabase
 * CLI's own help remains available as `ax supabase help`.
 * SUPABASE_WORKDIR is refused: promotion invokes a package script that would
 * inherit that override independently of the explicit target checked here.
 *
 * The help exception is DECLARED rather than incidental. #89 widened the help
 * read to a command's whole argv, which would have swallowed `supabase db push
 * --help` — a question for the Supabase CLI, whose answer ax has no business
 * composing. The registry entry carries `passthrough: true` for exactly this
 * boundary (./commands.mjs), so help ownership stays separate from the guard's
 * workdir validation.
 *
 * Everything that touches the machine arrives through `deps`, so the sequencing
 * can be tested without a container, a port or a real CLI.
 */
export function supabase(argv = [], deps = {}) {
  const { env = process.env, cwd = process.cwd(), paths = repoPaths(cwd), runCli = execCli, findCli = resolveCli, canonicalize = physical } = deps;
  const { root, main } = paths;

  if (!root) {
    fatal('ax supabase must run inside a git repository');
    return 1;
  }

  const loaded = deps.config ? { config: deps.config, exists: true, errors: [] } : loadCheckoutConfig({ root, main });
  if (!loaded.exists || loaded.errors.length > 0) {
    fatal(loaded.exists ? `${loaded.errors.length} problem(s) in ax.config.json` : 'no ax.config.json — run `ax init` in the primary checkout first');
    for (const error of loaded.errors) warn(error);
    return 1;
  }

  const config = loaded.config;
  // THE APP IS NAMED, NEVER MOVED INTO (reported 2026-09-08 from a worker in a
  // `.worktrees/` slice). This ran the CLI with `cwd` rebased to the configured
  // app, and that silently re-based every relative path in the caller's argv
  // with it: `ax supabase test db apps/web/supabase/tests/database/x.test.sql`,
  // typed from the worktree root, became `apps/web/apps/web/…` and named no
  // file — so nothing could be pointed at one test, and the whole 73-file suite
  // was the only usable gesture. A passthrough command's argv belongs to the
  // foreign CLI (`passthrough: true`, ./commands.mjs); ax claims the first slot
  // and not one argument past it, and the directory those arguments resolve
  // from is part of their meaning.
  //
  // So the CLI is told which project to read with its own global flag, and left
  // standing where the caller stood. Measured against Supabase CLI 2.109.1:
  // `--workdir <dir>` is honoured for project resolution (`status --workdir
  // apps/web` from a repo root prints `Using workdir apps/web` and that
  // project's endpoints) while path arguments resolve against the PROCESS cwd,
  // which is exactly the split this needs. An explicit caller `--workdir` is
  // still validated and consumed by `appArguments`, so this one is never
  // doubled.
  const appDir = join(root, config.apps.web);
  if (env.SUPABASE_WORKDIR) {
    fatal('SUPABASE_WORKDIR can redirect the CLI away from the configured app');
    warn('unset SUPABASE_WORKDIR; use --workdir to explicitly select the configured app');
    return 1;
  }
  const target = appArguments(argv, cwd, appDir, canonicalize);
  if (target.error) {
    fatal(target.error);
    warn('run ax supabase from the intended checkout without --workdir to use its configured app');
    return 1;
  }

  const cli = findCli({ appDir, root, env });
  if (cli.error) {
    fatal(cli.error);
    return 1;
  }

  const classified = classifyCommand(target.args);
  const refusal = protect(target.args, { env, root, config, deps, classified });
  if (refusal !== 0) return refusal;

  // WHICH STACK THIS RUN TOUCHES, IN AX'S OWN WORDS (reported 2026-09-08). On an
  // isolated worktree, `db reset` ends with the Supabase CLI's own line
  // `Finished supabase db reset on branch main` — the CLI's local database
  // BRANCH LABEL, which has nothing to do with git and nothing to do with the
  // shared stack. It was read as a broken isolation and cost a full verification
  // detour (`ax worktree ls`, endpoint comparison) to disprove. ax cannot
  // relabel another CLI's output, so it says what it routed BEFORE that output
  // arrives, and only for the commands whose target is the question.
  if (classified.isolation === true) {
    const stack = configProjectId(join(root, configTomlPath(config)));
    if (stack !== undefined) note(`stack ${stack} — declared by ${configTomlPath(config)}; whatever branch label the CLI prints below is its own local database label`);
  }

  return runCli(cli.path, ['--workdir', appDir, ...target.args], { cwd, env });
}

/** `0` to proceed, a non-zero exit code to refuse. */
function protect(argv, { env, root, config, deps, classified }) {
  const bypass = env[GUARD_ENV];
  if (bypass !== undefined && bypass !== '1') {
    // Loud, because the cost of opting out lands on other people's sessions
    // rather than on the one that opted out.
    warn(`${GUARD_ENV}=${bypass} — running against the SHARED local database, which every other checkout reads.`);
    return 0;
  }

  const isPrimary = deps.isPrimary ?? (() => isMainCheckout(root));
  const isIsolated = deps.isIsolated ?? (() => isIsolatedConfig({ cwd: root, relativePath: configTomlPath(config) }));
  const promoteCheckout = deps.promoteCheckout ?? (() => promoteCurrent({ root, config }));

  if (classified.error) {
    fatal(classified.error);
    warn('fix the arguments and retry; unknown flags are refused rather than run against any database.');
    return 1;
  }
  if (!classified.isolation) return 0;

  // The primary checkout OWNS the shared stack: its committed config.toml is
  // what every other checkout falls back to. Promoting it would rename the
  // containers everyone else is already using.
  if (isPrimary()) return 0;

  // Already promoted, so this is an ordinary command against its own stack.
  if (isIsolated()) return 0;

  warn(`\`${CLI_NAME} ${argv.join(' ')}\` would write to the SHARED local database.`);
  warn('promoting this checkout to its own isolated Supabase stack first.');

  const result = promoteCheckout();
  // The promotion's warnings are data, printed here where every outcome of the
  // promotion is already narrated: they are the only notice anyone gets of a
  // stack the promotion stopped addressing — a foreign config.toml claim, for
  // instance — and resolveProjectId's contract says silence is the one outcome
  // never acceptable. An absent list is simply "no warnings".
  for (const line of result.warnings ?? []) warn(line);
  if (!result.promoted) {
    // Refusing outright is the whole point. Running anyway — against the shared
    // database, or against an isolated config whose stack never came up — is
    // the loss this command exists to prevent, and it is silent.
    fatal(`cannot isolate this checkout — refusing to run \`${CLI_NAME} ${argv.join(' ')}\`.`);
    for (const line of String(result.reason ?? 'promotion did not complete').split('\n')) warn(line);
    warn(`fix that and retry, or set ${GUARD_ENV}=0 if you are certain this command is harmless.`);
    return 1;
  }

  // Nothing can reload a running dev server's environment from the outside, so
  // a process started before this moment keeps serving happily against the
  // SHARED database while every check reports isolation — the most confusing
  // state this tooling can leave behind. The instruction has to be given.
  warn(`promoted to ${result.projectId} — the Supabase endpoint changed, so RESTART the dev server.`);
  return 0;
}

const configTomlPath = config => join(config.apps.web, 'supabase', 'config.toml');

/**
 * Give this checkout its own stack, right now.
 *
 * The target state is NOT decided here: `planWorktree` decides it, from the same
 * probes `ax worktree setup` uses, so a checkout promoted reactively is
 * indistinguishable from one provisioned up front — same port block, same
 * project id, same env keys. The database probe is FORCED, because the command
 * about to run is itself the evidence this checkout touches the database, and
 * the diff probe would answer "no database changes" for a `db reset` on a branch
 * that has not written a migration yet.
 *
 * `started` is the answer that matters, and it is why this does not simply call
 * `worktree setup`. `promote` rewrites `config.toml` and the env files BEFORE
 * starting the stack, on purpose, so an interrupted promotion leaves the app and
 * the config naming the same project. The cost of that order is that a failed
 * `supabase start` still leaves an isolated-LOOKING config — so "is the config
 * isolated?" cannot stand in for "did promotion work?", and a caller that took
 * it for one would run the destructive command against a stack that is not
 * there.
 */
function promoteCurrent({ root, config, branch = currentBranch(root) }) {
  const identity = identify({ worktreePath: root, branch, marker: join(root, '.orca-worktree.json') });
  const { values: recorded } = readWorktreeRecord(root, config);
  const plan = planWorktree({
    identity,
    worktreePath: root,
    config,
    recorded,
    probes: probeAll({ worktreePath: root, config, recorded, force: true }),
  });

  // A plan that still says "shared" is a refusal whose reason is already
  // written: no container daemon, or every port block in the band bound.
  if (plan.supabase.mode !== 'isolated') {
    return { promoted: false, reason: plan.log.findLast(line => line.startsWith('supabase ')) ?? 'this checkout cannot hold its own stack' };
  }

  for (const write of plan.env) {
    const path = join(root, write.file);
    if (write.remove) removeBlock(path, write.label);
    else writeBlock(path, write);
  }

  // WARN lines travel back as data for `protect` to print — the collection is
  // measurement, the printing is the guard's own voice.
  const warnings = plan.log.filter(line => line.startsWith('WARN:')).map(line => line.slice('WARN:'.length));

  const result = promoteFromPlan({
    plan,
    config,
    root,
    envPrefix: PREFIX,
    start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'], cwd: root },
    write: writeBlock,
  });

  return result.started
    ? { promoted: true, projectId: result.projectId, offset: result.offset, warnings }
    : { promoted: false, reason: `the stack for ${result.projectId} did not start successfully\n${result.failure}`, warnings };
}

/** Run the real CLI and report its own exit status. */
function execCli(cli, argv, { cwd, env }) {
  const childEnv = { ...env };
  for (const key of REMOTE_ONLY_KEYS) delete childEnv[key];

  const result = spawnSync(cli, argv, { cwd, env: childEnv, stdio: 'inherit' });
  if (result.error) {
    fatal(`${cli}: ${result.error.message}`);
    return 1;
  }

  // A wrapper that swallowed a non-zero status would turn every CI step routed
  // through it green. A child killed by a signal reports no status at all, and
  // that is a failure too.
  return result.status ?? 1;
}
