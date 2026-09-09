import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { stableSeed } from '../src/hash.mjs';
import {
  SERVICES,
  applyConfig,
  basePorts,
  blockFree,
  blockPorts,
  classifyCommand,
  commandNeedsIsolation,

  configProjectId,
  envKeys,
  findOffset,
  preferredSlot,
  projectId,
  promote,
  resolveOffset,
  teardown,
  touchesDatabase,
} from '../src/worktree/supabase.mjs';

// The shape ax.config.json supplies. Nothing here is a module constant.
const BASE = 54320;
const STEP = 100;
const MAX_SLOT = 45;

const identity = (over = {}) => ({ name: 'feat-x', branch: 'feat/x', issue: undefined, issueSource: null, seed: 7, ...over });

const CONFIG_FIXTURE = `# A comment mentioning port 54321 that must not move.
project_id = "kit-baseline"

[api]
port = 54321
schemas = ["public"]

[db]
port = 54322
major_version = 17

[db.migrations]
schema_paths = ["./schemas/*.sql"]

[studio]
port = 54323

[local_smtp]
port = 54324
smtp_port = 54325
pop3_port = 54326

[auth]
site_url = "http://localhost:3000"
additional_redirect_urls = [
  "http://localhost:3000/auth/callback",
  "http://localhost:*",
  "http://*.localhost:*/**",
]
jwt_expiry = 3600

[analytics]
port = 54327
`;

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ax-supabase-'));
  const path = join(dir, 'config.toml');
  writeFileSync(path, CONFIG_FIXTURE);
  return { dir, path };
};

test('the service enumeration is the port layout, so nothing can drift apart', () => {
  assert.deepEqual(SERVICES, ['shadow', 'api', 'db', 'studio', 'inbucket', 'smtp', 'pop3', 'analytics']);
  assert.deepEqual(basePorts(BASE), {
    shadow: 54320, api: 54321, db: 54322, studio: 54323,
    inbucket: 54324, smtp: 54325, pop3: 54326, analytics: 54327,
  });
  assert.deepEqual(blockPorts(BASE, 1200), {
    shadow: 55520, api: 55521, db: 55522, studio: 55523,
    inbucket: 55524, smtp: 55525, pop3: 55526, analytics: 55527,
  });
});

test('the slot is derived from the issue number, and from the seed when there is none', () => {
  // 412 % 45 = 7, so issue #412 always lands on slot 8 — block +800.
  assert.equal(preferredSlot(identity({ issue: 412 }), MAX_SLOT), 8);
  assert.equal(preferredSlot(identity({ issue: '412' }), MAX_SLOT), 8);
  // No issue: the stable seed of the branch, so the same branch lands on the
  // same block on every machine and across re-runs.
  const seed = stableSeed('feat/x');
  assert.equal(preferredSlot(identity({ seed }), MAX_SLOT), (seed % MAX_SLOT) + 1);
});

test('a taken block is skipped, and the scan wraps around the top of the range', () => {
  const who = identity({ issue: 412 }); // preferred slot 8 -> offset 800

  // A single bound port disqualifies the whole block: a stack needs all eight.
  const oneTaken = port => port === blockPorts(BASE, 800).db;
  assert.equal(blockFree(800, { base: BASE, isBound: oneTaken }), false);
  assert.equal(blockFree(900, { base: BASE, isBound: oneTaken }), true);
  assert.equal(findOffset({ identity: who, base: BASE, step: STEP, maxSlot: MAX_SLOT, isBound: oneTaken }), 900);

  // Wraparound: every slot from the preferred one to the last is taken, so the
  // scan must come back to slot 1 rather than give up at the ceiling.
  const highTaken = port => port - BASE >= 800;
  assert.equal(
    findOffset({ identity: who, base: BASE, step: STEP, maxSlot: MAX_SLOT, isBound: highTaken }),
    STEP,
  );
});

test('an exhausted range throws with the range in the message', () => {
  assert.throws(
    () => findOffset({ identity: identity(), base: BASE, step: STEP, maxSlot: MAX_SLOT, isBound: () => true }),
    /\+100 to \+4500/,
  );
});

test('a recorded offset survives a machine where every port is bound', () => {
  // The reason this precedence exists: the ports are bound BY this worktree's
  // own stack. A scan would read that as a collision and move it, orphaning
  // seven containers.
  const resolved = resolveOffset({
    identity: identity(), recorded: '1300', base: BASE, step: STEP, maxSlot: MAX_SLOT,
    isBound: () => assert.fail('a recorded offset must not probe the machine'),
  });
  assert.deepEqual(resolved, { offset: 1300, source: 'recorded' });

  // Zero and junk are not records: offset 0 is the shared baseline.
  for (const recorded of ['0', '', 'yes', undefined, '-100']) {
    assert.equal(
      resolveOffset({ identity: identity(), recorded, base: BASE, step: STEP, maxSlot: MAX_SLOT, isBound: () => false }).source,
      'scan',
    );
  }
});

test('a long branch yields a project id inside Supabase\'s 40-character limit', () => {
  const prefix = 'testapp-';
  const long = 'feat/a-really-quite-long-branch-name-that-keeps-going-and-going';
  const id = projectId(identity({ branch: long }), prefix);

  assert.ok(id.length <= 40, `${id} is ${id.length} characters`);
  assert.ok(id.length > 40 - 3, 'the budget should be used, not wasted');
  assert.ok(id.startsWith(prefix));
  // A hash suffix, so two long branches sharing a prefix stay distinct...
  assert.match(id, /-[0-9a-f]{8}$/);
  // ...and never a trailing '-', which Docker/Supabase reject.
  assert.ok(!id.endsWith('-'));

  const other = projectId(identity({ branch: `${long}-two` }), prefix);
  assert.notEqual(id, other);

  // Short names are left alone; only the last path segment counts.
  assert.equal(projectId(identity({ branch: 'feat/PR-42_Fix' }), prefix), 'testapp-pr-42-fix');
  assert.equal(projectId(identity({ branch: '', name: '---' }), prefix), 'testapp-worktree');
});

test('a config.toml is rewritten once, then rewritten again byte-identically', () => {
  const { path } = fixture();
  const apiUrl = 'http://localhost:3412';

  const first = applyConfig({ configToml: path, projectId: 'testapp-feat-x', offset: 1200, base: BASE, apiUrl });
  assert.equal(first.changed, true);
  assert.equal(first.previous.projectId, 'kit-baseline');
  assert.deepEqual(first.previous.ports, {
    api: 54321, db: 54322, studio: 54323, inbucket: 54324, smtp: 54325, pop3: 54326, analytics: 54327,
  });
  assert.equal(first.previous.ports.shadow, undefined); // not pinned by the baseline

  const rewritten = readFileSync(path, 'utf8');
  assert.match(rewritten, /^project_id = "testapp-feat-x"$/m);
  assert.match(rewritten, /^\[db\]\nshadow_port = 55520\nport = 55522$/m);
  assert.match(rewritten, /^\[analytics\]\nport = 55527$/m);
  assert.match(rewritten, /^site_url = "http:\/\/localhost:3412"$/m);
  assert.match(rewritten, /"http:\/\/localhost:3412\/auth\/callback"/);
  // `[db.migrations]` is a sibling of `[db]`, not part of it: no port hunting there.
  assert.match(rewritten, /^schema_paths = \["\.\/schemas\/\*\.sql"\]$/m);
  // Prose and unrelated integers stay put.
  assert.match(rewritten, /^# A comment mentioning port 54321 that must not move\.$/m);
  assert.match(rewritten, /^major_version = 17$/m);
  assert.match(rewritten, /^jwt_expiry = 3600$/m);
  // Wildcard allow-list entries have no numeric port and must survive.
  assert.match(rewritten, /"http:\/\/\*\.localhost:\*\/\*\*"/);

  // Idempotence is the whole promise. The shell version needed `git checkout`
  // first to get it; absolute assignments give it for free.
  const second = applyConfig({ configToml: path, projectId: 'testapp-feat-x', offset: 1200, base: BASE, apiUrl });
  assert.equal(second.changed, false);
  assert.equal(readFileSync(path, 'utf8'), rewritten);
  assert.equal(second.previous.ports.shadow, 55520);
  assert.equal(configProjectId(path), 'testapp-feat-x');
});

test('configProjectId reports absence rather than guessing', () => {
  const { dir, path } = fixture();
  assert.equal(configProjectId(path), 'kit-baseline');
  assert.equal(configProjectId(join(dir, 'missing.toml')), undefined);
  writeFileSync(join(dir, 'bare.toml'), '[api]\nport = 54321\n');
  assert.equal(configProjectId(join(dir, 'bare.toml')), undefined);
});

test('only commands that would write to the shared database trigger promotion', () => {
  assert.equal(commandNeedsIsolation(['db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['db', 'diff']), true);
  assert.equal(commandNeedsIsolation(['db', 'lint']), true);
  assert.equal(commandNeedsIsolation(['migration', 'new', 'x']), true);

  // `test` and `seed` are TOP-LEVEL commands, and this is the whole of finding
  // 5: they were listed as `db` subcommands, which the CLI has never had, so
  // pgTAP fixtures and storage seeds ran against the SHARED database from an
  // unpromoted worktree. Verbatim from `supabase --help` (CLI 2.109.1):
  //   seed                Seed a Supabase project
  //   test                Run tests on local Supabase containers
  assert.equal(commandNeedsIsolation(['test', 'db']), true);
  assert.equal(commandNeedsIsolation(['test', 'new', 'orders']), true);
  assert.equal(commandNeedsIsolation(['seed', 'buckets']), true);

  // `db seed` is not a command: `supabase db seed --help` prints the `db`
  // subcommand list. `db test` is — see the hidden-alias test below, measured
  // on the same CLI, which is why it is no longer pinned as harmless here.
  assert.equal(commandNeedsIsolation(['db', 'seed']), false);

  // `db push` defaults to the REMOTE project, so it only counts as a local
  // write with an explicit --local — but it must count then, or a shared-stack
  // worktree mutates the shared database without ever being promoted.
  assert.equal(commandNeedsIsolation(['db', 'push', '--local']), true);
  assert.equal(commandNeedsIsolation(['db', 'push']), false);
  assert.equal(commandNeedsIsolation(['db', 'query', '--local', 'select 1']), true);

  // `db pull` reads the schema from a REMOTE database but computes the
  // migration through the LOCAL shadow database, which lives in this project's
  // own port block — so it needs isolation whatever names the source, including
  // the flags that exempt every other subcommand.
  assert.equal(commandNeedsIsolation(['db', 'pull']), true);
  assert.equal(commandNeedsIsolation(['db', 'pull', '--linked']), true);
  assert.equal(commandNeedsIsolation(['db', 'pull', '--db-url', 'postgres://x']), true);

  // `gen types` alone reads the remote schema; only `--local` touches the stack.
  assert.equal(commandNeedsIsolation(['gen', 'types']), false);
  assert.equal(commandNeedsIsolation(['gen', 'types', '--local']), true);

  // start/stop/status are excluded on purpose: promotion itself runs
  // `supabase start` through the same guard and would recurse forever. `db
  // start` ("Starts local Postgres database") is the same case.
  assert.equal(commandNeedsIsolation(['start']), false);
  assert.equal(commandNeedsIsolation(['stop']), false);
  assert.equal(commandNeedsIsolation(['status']), false);
  assert.equal(commandNeedsIsolation(['db', 'start']), false);

  // An explicitly remote target is never local, whatever the subcommand.
  assert.equal(commandNeedsIsolation(['db', 'reset', '--linked']), false);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--db-url', 'postgres://x']), false);
  assert.equal(commandNeedsIsolation(['db']), false);
  assert.equal(commandNeedsIsolation([]), false);
});

test('documented global flags before the verb cannot hide a local write', () => {
  // #223: commandNeedsIsolation read args[0]/args[1] positionally, so
  // `--debug db reset` classified as unknown and skipped isolation.
  // Globals and arity are from supabase CLI docs (global flags), CLI 2.109.1.
  assert.equal(commandNeedsIsolation(['--debug', 'db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['--yes', 'db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['--experimental', 'test', 'db']), true);
  assert.equal(commandNeedsIsolation(['--create-ticket', 'seed', 'buckets']), true);
  assert.equal(commandNeedsIsolation(['--profile', 'ci', 'db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['--output', 'json', 'db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['-o', 'json', 'migration', 'up']), true);
  assert.equal(commandNeedsIsolation(['--dns-resolver', 'https', 'db', 'lint']), true);
  assert.equal(commandNeedsIsolation(['--agent', 'yes', 'db', 'diff']), true);
  assert.equal(commandNeedsIsolation(['--network-id', 'net_1', 'db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['--profile=ci', 'db', 'reset']), true);
});

test('interspersed globals and a -- terminator still classify the verb', () => {
  assert.equal(commandNeedsIsolation(['db', '--debug', 'reset']), true);
  assert.equal(commandNeedsIsolation(['db', '--yes', 'reset']), true);
  assert.equal(commandNeedsIsolation(['--', 'db', 'reset']), true);
  assert.equal(commandNeedsIsolation(['db', '--', 'reset']), true);
  // After `--`, later tokens are operands even when they look like flags.
  assert.equal(commandNeedsIsolation(['db', 'reset', '--', '--help']), true);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--', '--linked']), true);
});


test('a value-taking global is not mistaken for the command', () => {
  // `--output <env|pretty|json|toml|yaml>` consumes the next token; json is
  // not a verb. The positional parser treated args[0] as the command.
  assert.equal(commandNeedsIsolation(['--output', 'json', 'status']), false);
  assert.equal(commandNeedsIsolation(['--output', 'json', 'db', 'reset']), true);
});

test('remote targets are parsed as flags, not guessed by substring', () => {
  assert.equal(commandNeedsIsolation(['db', 'reset', '--db-url=postgres://x']), false);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--linked=true']), false);
  // `--db-url` as a profile *value* is not the remote-target flag.
  assert.equal(commandNeedsIsolation(['--profile', 'db-url', 'db', 'reset']), true);
});

test('db pull stays local when globals or remote source flags precede the verb', () => {
  assert.equal(commandNeedsIsolation(['--debug', 'db', 'pull']), true);
  assert.equal(commandNeedsIsolation(['--debug', 'db', 'pull', '--linked']), true);
  assert.equal(commandNeedsIsolation(['db', '--debug', 'pull', '--db-url', 'postgres://x']), true);
});

test('help is not a local write', () => {
  assert.equal(commandNeedsIsolation(['--help']), false);
  assert.equal(commandNeedsIsolation(['-h']), false);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--help']), false);
  assert.equal(commandNeedsIsolation(['-h', 'db', 'reset']), false);
  assert.equal(commandNeedsIsolation(['db', 'reset', '-h']), false);
});

test('start remains excluded when globals precede it', () => {
  assert.equal(commandNeedsIsolation(['--debug', 'start']), false);
  assert.equal(commandNeedsIsolation(['--yes', 'db', 'start']), false);
});

test('documented command-specific flags keep a known local write classifiable', () => {
  assert.equal(commandNeedsIsolation(['db', 'reset', '--no-seed']), true);
  assert.equal(commandNeedsIsolation(['db', 'pull', '--diff-engine', 'migra']), true);
  assert.equal(commandNeedsIsolation(['db', 'diff', '-f', 'my_table']), true);
  assert.equal(commandNeedsIsolation(['db', 'push', '--local', '--dry-run']), true);
});

test('an unknown flag after the verb is unclassifiable, not a local write', () => {
  assert.equal(classifyCommand(['db', '--unknown', 'reset']).error, 'unknown flag --unknown');
  assert.equal(commandNeedsIsolation(['db', '--unknown', 'reset']), false);
  assert.equal(classifyCommand(['db', '--unknown=reset']).error, 'unknown flag --unknown');
  assert.equal(commandNeedsIsolation(['db', '--unknown=reset']), false);
  assert.equal(classifyCommand(['db', 'reset', '--not-a-flag']).error, 'unknown flag --not-a-flag');
  assert.equal(commandNeedsIsolation(['db', 'reset', '--not-a-flag']), false);
});

test('explicit boolean false does not pretend a remote or help flag is set', () => {
  assert.equal(commandNeedsIsolation(['db', 'reset', '--linked=false']), true);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--help=false']), true);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--local=false']), true);
  assert.equal(commandNeedsIsolation(['db', 'push', '--local=false']), false);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--linked=true']), false);
  assert.equal(classifyCommand(['db', 'reset', '--linked=maybe']).error !== undefined, true);
});

test('a command-specific value flag is refused on a verb that does not take it', () => {
  assert.equal(classifyCommand(['db', 'push', '--version', '20240101']).error !== undefined, true);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--version', '20240101']), true);
});

// The command lines these are taken from are the ones two real checkouts run
// through this wrapper, read from their manifests on 2026-09-09:
//
//   gapila   apps/web/package.json  supabase:deploy   supabase link --project-ref $SUPABASE_PROJECT_REF && supabase db push
//                                  supabase:db:dump:local  ... db dump --local --data-only
//   ofmchat  apps/web/package.json  supabase:start:ci supabase status || supabase start -x studio,imgproxy,logflare,vector
//                                  supabase:typegen:packages  ax supabase gen types typescript --local
//   gapila   .github/workflows/ci-pgtap.yml            supabase start -x studio,mailpit,imgproxy,edge-runtime
//
// Every flag below is quoted from `supabase <cmd> --help` on CLI 2.109.1, the
// version this table was measured against, so the arity is the CLI's and not a
// guess: `--exclude, -x string` on `start` and on `db dump`, `--project-ref
// string` on `link` and on `functions deploy`, `--data-only` boolean on
// `db dump`.
test('the flags real consumer scripts pass are classifiable, not refused as unknown', () => {
  for (const argv of [
    ['start', '-x', 'studio,imgproxy,logflare,vector'],
    ['start', '--exclude', 'analytics,vector,studio,inbucket'],
    ['start', '-x=studio,mailpit', '--ignore-health-check'],
    ['link', '--project-ref', 'ojzwhmdzptjsksogvdzu'],
    ['functions', 'deploy', '--project-ref', 'ojzwhmdzptjsksogvdzu', '--no-verify-jwt'],
    ['db', 'dump', '--local', '--data-only'],
    ['db', 'dump', '--local', '-x', 'public.audit', '-f', 'seed.sql'],
    ['gen', 'types', 'typescript', '--local'],
    ['stop', '--project-id', 'ax_widgets_7'],
    ['status', '-o', 'json'],
  ]) {
    assert.equal(classifyCommand(argv).error, undefined, `${argv.join(' ')} must classify`);
  }
});

test('supporting those flags does not move a start into promotion, nor a deploy into a local write', () => {
  // Promotion itself runs `supabase start` through this guard: an excluded
  // service list must not turn that into a recursion.
  assert.equal(commandNeedsIsolation(['start', '-x', 'studio,imgproxy,logflare,vector']), false);
  assert.equal(commandNeedsIsolation(['start', '--exclude=analytics,vector']), false);
  assert.equal(commandNeedsIsolation(['stop', '--project-id', 'ax_widgets_7']), false);
  // `link` and `functions deploy` are remote: no local stack is involved, so
  // neither may promote a shared checkout.
  assert.equal(commandNeedsIsolation(['link', '--project-ref', 'ref']), false);
  assert.equal(commandNeedsIsolation(['functions', 'deploy', '--project-ref', 'ref']), false);
  assert.equal(commandNeedsIsolation(['functions', 'deploy', '--prune']), false);
  // A local dump reads THIS checkout's database, so it still earns a stack.
  assert.equal(commandNeedsIsolation(['db', 'dump', '--local', '--data-only']), true);
  assert.equal(commandNeedsIsolation(['db', 'dump', '--data-only']), false);
});

test('a documented flag on one verb stays unknown on another, and still needs its value', () => {
  // `-x` belongs to `start` and `db dump` only; `--project-ref` to `link`,
  // `functions deploy` and no `db` subcommand. Blanket acceptance of either
  // would be the hole this table exists to close.
  assert.equal(classifyCommand(['db', 'reset', '-x', 'studio']).error, 'unknown flag -x');
  assert.equal(classifyCommand(['db', 'push', '--project-ref', 'ref']).error, 'unknown flag --project-ref');
  assert.equal(classifyCommand(['start', '--not-a-flag']).error, 'unknown flag --not-a-flag');
  assert.equal(classifyCommand(['functions', 'deploy', '--project-id', 'ref']).error, 'unknown flag --project-id');
  // Arity is enforced: a value flag with nothing to take must not swallow a verb.
  assert.equal(classifyCommand(['start', '-x']).error, '-x requires a value');
  assert.equal(classifyCommand(['link', '--project-ref']).error, '--project-ref requires a value');
  assert.equal(classifyCommand(['db', 'dump', '--local', '-x', '--data-only']).error, '-x requires a value');
  // And an explicit boolean false is still read as false, not as presence.
  assert.equal(classifyCommand(['db', 'dump', '--local=false', '--data-only']).isolation, false);
  assert.equal(classifyCommand(['db', 'dump', '--data-only=maybe']).error, '--data-only has a malformed boolean value');
});

// `supabase db test` is NOT in the `supabase db --help` subcommand list, which
// is why it was recorded as a non-command. It is a live hidden alias, measured
// on CLI 2.109.1:
//
//   $ supabase db test --help
//   DESCRIPTION
//     Tests local database with pgTAP.
//   USAGE
//     supabase db test [flags] <path...>
//
// and it is the form both real checkouts use (`supabase:test` in gapila's and
// ofmchat's apps/web manifests). Classified as "no isolation needed", pgTAP
// runs its fixtures against the SHARED database from an unpromoted worktree —
// the exact contamination this predicate exists to prevent.
test('db test is the hidden pgTAP alias, and runs against the local database', () => {
  assert.equal(commandNeedsIsolation(['db', 'test']), true);
  assert.equal(commandNeedsIsolation(['db', 'test', 'supabase/tests/rls.sql']), true);
  assert.equal(commandNeedsIsolation(['db', 'test', '--linked']), false);
  assert.equal(commandNeedsIsolation(['db', 'test', '--db-url', 'postgres://x']), false);
  // `db seed` is not an alias — `supabase db seed --help` prints the `db`
  // subcommand list, so the CLI never ran a seed there.
  assert.equal(commandNeedsIsolation(['db', 'seed']), false);
});





test('the force override short-circuits the tree probe both ways', () => {
  const refuse = () => assert.fail('force must not run git');
  assert.equal(touchesDatabase({ cwd: '/x', supabaseDir: 'supabase', force: true, run: refuse }), true);
  assert.equal(touchesDatabase({ cwd: '/x', supabaseDir: 'supabase', force: false, run: refuse }), false);
});

test('database evidence is dirt in the tree or a diff against the merge base', () => {
  const fake = script => (_command, args) => script(args.join(' '));

  // A clean tree that also has no committed change: shared stack, no containers.
  assert.equal(
    touchesDatabase({
      cwd: '/x', supabaseDir: 'supabase',
      run: fake(line => (line.includes('rev-parse') ? { status: 0, stdout: 'ok\n' } : { status: 0, stdout: line.includes('merge-base') ? 'abc123\n' : '' })),
    }),
    false,
  );

  // Untracked/dirty file under the database directory.
  assert.equal(
    touchesDatabase({
      cwd: '/x', supabaseDir: 'supabase',
      run: fake(line => ({ status: 0, stdout: line.includes('status') ? '?? supabase/schemas/10-x.sql\n' : '' })),
    }),
    true,
  );

  // Committed change, found against the merge base and not the base tip.
  const seen = [];
  assert.equal(
    touchesDatabase({
      cwd: '/x', supabaseDir: 'supabase',
      run: (_command, args) => {
        const line = args.join(' ');
        seen.push(line);
        if (line.includes('status')) return { status: 0, stdout: '' };
        if (line.includes('rev-parse')) return { status: line.includes('origin/main') ? 0 : 1, stdout: 'ref\n' };
        if (line.includes('merge-base')) return { status: 0, stdout: 'abc123\n' };
        return { status: 0, stdout: 'supabase/schemas/10-x.sql\n' };
      },
    }),
    true,
  );
  assert.ok(seen.some(line => line.includes('diff --name-only abc123')), 'the diff is against the merge base');
});

test('env keys carry the offset under the caller\'s prefix, and never hardcode a project', () => {
  const keys = envKeys({ ports: blockPorts(BASE, 1200), offset: 1200, envPrefix: 'MYAPP_' });
  assert.equal(keys.NEXT_PUBLIC_SUPABASE_URL, 'http://127.0.0.1:55521');
  assert.equal(keys.SUPABASE_DATABASE_URL, 'postgresql://postgres:postgres@127.0.0.1:55522/postgres');
  assert.equal(keys.EMAIL_PORT, '55525');
  assert.equal(keys.MYAPP_SUPABASE_INBUCKET_PORT, '55524');
  assert.equal(keys.MYAPP_SUPABASE_OFFSET, '1200');
  // Offset 0 is the shared baseline; recording it would claim isolation.
  assert.equal(envKeys({ ports: basePorts(BASE), offset: 0 }).SUPABASE_OFFSET, undefined);
});

test('promote rewrites config and env BEFORE starting the stack', () => {
  const { dir } = fixture();
  const calls = [];
  const run = (command, args, options) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: '', stderr: '', options };
  };
  const written = [];
  const write = (file, block) => {
    calls.push(['write', file]);
    written.push([file, block]);
    return true;
  };

  const result = promote({
    cwd: dir,
    projectId: 'testapp-x',
    offset: 1200,
    base: BASE,
    relativePath: 'config.toml',
    envFiles: ['.env.local', 'apps/web/.env.local'],
    envLabel: 'ax-supabase',
    envPrefix: 'MYAPP_',
    apiUrl: 'http://localhost:3412',
    start: { command: 'pnpm', args: ['run', 'supabase:start'] },
    run,
    write,
  });

  // A start that dies half-way must still leave the app and config.toml naming
  // the same project, so the writes come first and `start` is strictly last.
  assert.deepEqual(result.steps, ['config', 'skip-worktree', 'env:.env.local', 'env:apps/web/.env.local', 'start']);
  assert.deepEqual(calls, [
    ['git', '-C', dir, 'update-index', '--skip-worktree', 'config.toml'],
    ['write', join(dir, '.env.local')],
    ['write', join(dir, 'apps/web/.env.local')],
    ['pnpm', 'run', 'supabase:start'],
  ]);

  assert.equal(result.projectId, 'testapp-x');
  assert.equal(result.offset, 1200);
  assert.equal(result.ports.api, 55521);
  assert.equal(result.started, true);
  // The file on disk really moved, before any container was asked for.
  assert.equal(configProjectId(join(dir, 'config.toml')), 'testapp-x');
  assert.equal(written[0][1].label, 'ax-supabase');
  assert.equal(written[0][1].keys.MYAPP_SUPABASE_OFFSET, '1200');
});

test('a failed start keeps the captured diagnostic rather than inventing a daemon failure', () => {
  const { dir } = fixture();
  const result = promote({
    cwd: dir,
    projectId: 'testapp-x',
    offset: 1200,
    base: BASE,
    relativePath: 'config.toml',
    envFiles: ['.env.local'],
    envLabel: 'ax-supabase',
    start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'] },
    run: (_command, args) => args.includes('supabase:start')
      ? { status: 1, stdout: 'analytics: unhealthy\n', stderr: 'LegacyHealthCheckTimeoutError: vector failed\n', error: undefined }
      : { status: 0, stdout: '', stderr: '', error: undefined },
    write: () => true,
  });

  assert.equal(result.started, false);
  assert.match(result.failure, /pnpm --filter web supabase:start failed \(exit 1\)/);
  assert.match(result.failure, /LegacyHealthCheckTimeoutError: vector failed/);
  assert.match(result.failure, /analytics: unhealthy/);
  assert.doesNotMatch(result.failure, /container runtime|nothing is listening/);
});

test('an exhausted Docker address pool names the stacks THIS tooling owns, never a global prune', () => {
  // Reported 2026-09-08 from slice #215 of one wave: `ax worktree setup
  // --database` failed `LegacyNetworkCreateError: all predefined address pools
  // have been fully subnetted`, the worker counted 32 Docker networks, ran
  // `docker network prune -f`, removed 27, and the setup then worked. The
  // diagnostic was preserved (#224) and named no cause, so the repair was
  // improvised — and a global prune deletes networks belonging to every other
  // project on the machine, which is a far worse outcome than a refused setup.
  //
  // Each promoted worktree's stack holds one network, so the exhaustion is a
  // count of stacks nobody stopped. That is a fact this tooling knows how to
  // enumerate and how to free, one worktree at a time.
  const { dir } = fixture();
  const result = promote({
    cwd: dir,
    projectId: 'testapp-x',
    offset: 1200,
    base: BASE,
    relativePath: 'config.toml',
    envFiles: ['.env.local'],
    envLabel: 'ax-supabase',
    start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'] },
    run: (_command, args) => args.includes('supabase:start')
      ? { status: 1, stdout: '', stderr: 'failed to create network: LegacyNetworkCreateError: all predefined address pools have been fully subnetted\n', error: undefined }
      : { status: 0, stdout: '', stderr: '', error: undefined },
    write: () => true,
  });

  assert.equal(result.started, false);
  // The captured diagnostic still travels whole.
  assert.match(result.failure, /all predefined address pools have been fully subnetted/);
  // And the cause is named, with the two verbs that free a stack this tooling
  // placed — plus the refusal of the sweep a worker will otherwise reach for.
  assert.match(result.failure, /one Docker network per promoted worktree/);
  assert.match(result.failure, /ax worktree ls/);
  assert.match(result.failure, /ax worktree clean/);
  assert.match(result.failure, /never `docker network prune`/);
});

test('a failed start keeps the tail of a large diagnostic, not the whole buffer', () => {
  const { dir } = fixture();
  const noise = Array.from({ length: 40 }, (_, i) => `pulling image ${i}`).join('\n');
  const result = promote({
    cwd: dir,
    projectId: 'testapp-x',
    offset: 1200,
    base: BASE,
    relativePath: 'config.toml',
    envFiles: ['.env.local'],
    envLabel: 'ax-supabase',
    start: { command: 'pnpm', args: ['--filter', 'web', 'supabase:start'] },
    run: (_command, args) => args.includes('supabase:start')
      ? { status: 1, stdout: `${noise}\nLegacyHealthCheckTimeoutError: vector failed\n`, stderr: '', error: undefined }
      : { status: 0, stdout: '', stderr: '', error: undefined },
    write: () => true,
  });

  assert.equal(result.started, false);
  assert.match(result.failure, /LegacyHealthCheckTimeoutError: vector failed/);
  assert.doesNotMatch(result.failure, /pulling image 0/);
  assert.match(result.failure, /pulling image 39/);
});

test('teardown addresses the stack by project id, not by directory', () => {
  const calls = [];
  const result = teardown({
    cwd: '/x',
    projectId: 'testapp-feat-x',
    run: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(calls, [['supabase', 'stop', '--project-id', 'testapp-feat-x']]);
  assert.equal(result.stopped, true);
});
