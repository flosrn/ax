// The invariants that keep `ax worktree` honest.
//
// 1. Nothing is advertised that does not run. The help and the AGENTS.md block
//    are generated from the registry, so a verb declared there and missing from
//    the dispatch table would teach an agent a command that answers "unknown" —
//    the exact failure the registry exists to stop, one level deeper.
//
// 2. The plan is PURE. `setup` writes it and `doctor` re-derives it to compare.
//    If the same inputs could produce two different plans, that comparison is
//    meaningless and the two would drift the way their Bash ancestors did.
//
// 3. A plan CONVERGES. Applying it to a checkout that was isolated and is now
//    shared must erase the old endpoints, not leave them beside the new state.

import assert from 'node:assert/strict';
import test from 'node:test';

import { subcommandNames } from '../src/commands.mjs';
import { SUBCOMMANDS } from '../src/worktree/index.mjs';
import { KEYS, LEGACY_KEYS, SUPABASE_LABEL, planWorktree, readRecorded } from '../src/worktree/plan.mjs';

const config = {
  project: { name: 'demo', display: 'Demo' },
  ports: { dev: [3100, 3999], proxy: 1355, supabaseBase: 54320, step: 100, maxSlot: 45, reserved: ['0-1023', '3000'] },
  apps: { web: 'apps/web', e2e: 'apps/e2e', caches: [] },
};

const identity = { name: 'feat-412', branch: 'feat/thing-412', issue: 412, issueSource: 'branch', seed: 12345 };
const plan = overrides => planWorktree({ identity, worktreePath: '/tmp/wt/feat-412', config, ...overrides });

test('every declared verb has a runner, and every runner is declared', () => {
  assert.deepEqual(subcommandNames('worktree').sort(), Object.keys(SUBCOMMANDS).sort());
  for (const [verb, run] of Object.entries(SUBCOMMANDS)) assert.equal(typeof run, 'function', `${verb} is not callable`);
});

test('the same inputs always produce the same plan', () => {
  const inputs = { probes: { database: { touches: false } } };
  assert.deepEqual(plan(inputs), plan(inputs));
});

test('an issue number becomes a legible port', () => {
  const result = plan({ probes: { database: { touches: false } } });

  assert.equal(result.port.port, 3412);
  assert.equal(result.port.source, 'preferred');
  assert.equal(result.supabase.mode, 'shared');
});

test('a recorded port survives even while bound, so a published URL never moves', () => {
  const result = plan({ recorded: { PORT: '3777' }, probes: { isBound: () => true, database: { touches: false } } });

  assert.equal(result.port.port, 3777);
  assert.equal(result.port.source, 'recorded');
});

test('the primary checkout never isolates — it owns the shared stack', () => {
  const result = plan({ probes: { database: { primary: true, touches: false } } });

  assert.equal(result.supabase.mode, 'shared');
  assert.match(result.log.join('\n'), /primary checkout, which owns that stack/);
});

test('a database-touching worktree gets its own block and endpoints', () => {
  const result = plan({ probes: { isBound: () => false, database: { touches: true, startable: true } } });

  assert.equal(result.supabase.mode, 'isolated');
  assert.equal(result.supabase.projectId, 'demo-thing-412');
  assert.ok(result.supabase.offset > 0);

  const block = result.env.find(write => write.label === SUPABASE_LABEL);
  assert.equal(block.keys[KEYS.supabaseOffset], String(result.supabase.offset));
  assert.equal(block.keys.SUPABASE_URL, `http://127.0.0.1:${result.supabase.ports.api}`);
});

test('no container runtime means shared, with the reason kept for the human', () => {
  const result = plan({ probes: { database: { touches: true, startable: false, reason: 'the daemon is not answering' } } });

  assert.equal(result.supabase.mode, 'shared');
  assert.match(result.log.join('\n'), /the daemon is not answering/);
});

test('a shared plan ERASES the isolated endpoints instead of leaving them behind', () => {
  const result = plan({ probes: { database: { touches: false } } });
  const block = result.env.find(write => write.label === SUPABASE_LABEL);

  assert.equal(block.remove, true);
  assert.equal(block.keys, undefined);
});

test('a proxied worktree records the route the launcher has to reuse', () => {
  // The process that starts the dev server reads these; unrecorded, it falls
  // back to its own defaults, which agree by luck until a project moves its
  // proxy off the default port.
  const result = plan({
    probes: {
      database: { touches: false },
      proxy: { enabled: true, available: true, name: 'demo', servedUrl: 'http://x.demo.localhost:1355', port: 1355 },
    },
  });

  const runtime = result.env.find(write => write.label === 'Worktree runtime').keys;
  assert.equal(result.urls.mode, 'proxy');
  assert.equal(runtime.PORTLESS_NAME, 'demo');
  assert.equal(runtime.PORTLESS_PORT, '1355');
  assert.equal(runtime[KEYS.useProxy], '1');
});

test('a direct worktree records no proxy route at all', () => {
  const result = plan({ probes: { database: { touches: false }, proxy: { enabled: false } } });
  const runtime = result.env.find(write => write.label === 'Worktree runtime').keys;

  assert.equal(runtime[KEYS.useProxy], '0');
  assert.equal(runtime.PORTLESS_NAME, undefined);
  assert.equal(runtime.PORTLESS_PORT, undefined);
});

test('a worktree provisioned by the old tooling keeps its stack instead of orphaning it', () => {
  // Two regressions in one case, both of which orphan seven containers.
  //
  // The offset is recorded under the PREVIOUS key name, so a reader blind to it
  // scans for a "free" block and abandons the one already running. And the diff
  // no longer touches the database — which must NOT downgrade a checkout that
  // already claimed a block, because its containers are up and its env points
  // at them.
  const older = LEGACY_KEYS[KEYS.supabaseOffset];
  const { values, legacy } = readRecorded([KEYS.supabaseOffset], key => (key === older ? '700' : undefined));

  assert.equal(values[KEYS.supabaseOffset], '700');
  assert.deepEqual(legacy, [{ key: KEYS.supabaseOffset, from: older }]);

  const result = plan({
    recorded: { ...values, PORT: '3412' },
    probes: { isBound: () => true, database: { touches: false } },
  });

  assert.equal(result.supabase.mode, 'isolated');
  assert.equal(result.supabase.offset, 700);
  assert.equal(result.env.find(write => write.label === SUPABASE_LABEL).remove, undefined);
});

test('the current key name wins over the legacy one', () => {
  const older = LEGACY_KEYS[KEYS.supabaseOffset];
  const { values, legacy } = readRecorded([KEYS.supabaseOffset], key => (key === older ? '700' : '900'));

  assert.equal(values[KEYS.supabaseOffset], '900');
  assert.deepEqual(legacy, []);
});
