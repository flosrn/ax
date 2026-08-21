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
  assert.equal(commandNeedsIsolation(['db', 'test']), true);
  assert.equal(commandNeedsIsolation(['migration', 'new', 'x']), true);

  // `db push` defaults to the REMOTE project, so it only counts as a local
  // write with an explicit --local — but it must count then, or a shared-stack
  // worktree mutates the shared database without ever being promoted.
  assert.equal(commandNeedsIsolation(['db', 'push', '--local']), true);
  assert.equal(commandNeedsIsolation(['db', 'push']), false);
  assert.equal(commandNeedsIsolation(['db', 'query', '--local', 'select 1']), true);

  // `gen types` alone reads the remote schema; only `--local` touches the stack.
  assert.equal(commandNeedsIsolation(['gen', 'types']), false);
  assert.equal(commandNeedsIsolation(['gen', 'types', '--local']), true);

  // start/stop/status are excluded on purpose: promotion itself runs
  // `supabase start` through the same guard and would recurse forever.
  assert.equal(commandNeedsIsolation(['start']), false);
  assert.equal(commandNeedsIsolation(['stop']), false);
  assert.equal(commandNeedsIsolation(['status']), false);

  // An explicitly remote target is never local, whatever the subcommand.
  assert.equal(commandNeedsIsolation(['db', 'reset', '--linked']), false);
  assert.equal(commandNeedsIsolation(['db', 'reset', '--db-url', 'postgres://x']), false);
  assert.equal(commandNeedsIsolation(['db']), false);
  assert.equal(commandNeedsIsolation([]), false);
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
    identity: identity({ issue: 412 }),
    base: BASE, step: STEP, maxSlot: MAX_SLOT,
    recorded: '1200',
    relativePath: 'config.toml',
    envFiles: ['.env.local', 'apps/web/.env.local'],
    envLabel: 'ax-supabase',
    envPrefix: 'MYAPP_',
    apiUrl: 'http://localhost:3412',
    prefix: 'testapp-',
    start: { command: 'pnpm', args: ['run', 'supabase:start'] },
    isBound: () => assert.fail('a recorded offset must not probe the machine'),
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
  assert.equal(result.offsetSource, 'recorded');
  assert.equal(result.ports.api, 55521);
  assert.equal(result.started, true);
  // The file on disk really moved, before any container was asked for.
  assert.equal(configProjectId(join(dir, 'config.toml')), 'testapp-x');
  assert.equal(written[0][1].label, 'ax-supabase');
  assert.equal(written[0][1].keys.MYAPP_SUPABASE_OFFSET, '1200');
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
