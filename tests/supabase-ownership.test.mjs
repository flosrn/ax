/**
 * Who owns which Supabase stack, and what survives losing the untracked record.
 *
 * These are the four defects the 164-test suite did not cover: "the working-tree
 * project_id differs from HEAD" standing in for "this worktree owns that stack"
 * (which lies in BOTH directions, and gates `supabase stop`), the promotion
 * guard's command list disagreeing with the real CLI, and the block plus the
 * project id living only in an untracked `.env.local`.
 *
 * No Docker and no live port probe: the git repositories are real (that is the
 * only way to exercise the HEAD comparison honestly), every port answer is
 * injected, and an injected prober that is CALLED fails the test — the whole
 * point of a recovered claim is that nothing scans.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  blockPorts,
  configProjectId,
  envKeys,
  isIsolatedConfig,
  ownsStack,
  promote,
  recordedClaim,
  resolveOffset,
  resolveProjectId,
  teardown,
} from '../src/worktree/supabase.mjs';

// The shape ax.config.json supplies. Nothing here is a module constant.
const BASE = 54320;
const STEP = 100;
const MAX_SLOT = 45;
const PREFIX = 'demo-';
const RELATIVE = 'supabase/config.toml';

const identity = (over = {}) => ({ name: 'feat-412-chat', branch: 'feat/412-chat', issue: 412, issueSource: 'branch', seed: 7, ...over });

/** A config.toml as it exists on disk: one project id, one block of ports. */
const configToml = ({ id, offset }) => {
  const ports = blockPorts(BASE, offset);
  return `# A comment mentioning port 54321 that must not move.
project_id = "${id}"

[api]
port = ${ports.api}

[db]
port = ${ports.db}
shadow_port = ${ports.shadow}

[db.migrations]
schema_paths = ["./schemas/*.sql"]

[studio]
port = ${ports.studio}

[local_smtp]
port = ${ports.inbucket}
smtp_port = ${ports.smtp}
pop3_port = ${ports.pop3}

[analytics]
port = ${ports.analytics}
`;
};

const dirs = [];

/**
 * A real git repository with `supabase/config.toml` committed at `committed`
 * and, optionally, a different file in the working tree. Real git because the
 * predicate under test asks git what HEAD says.
 */
const repo = ({ committed, working }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ax-owns-'));
  dirs.push(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

  git('init', '--quiet');
  git('config', 'user.email', 'ax@example.test');
  git('config', 'user.name', 'ax');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(cwd, 'supabase'), { recursive: true });
  writeFileSync(join(cwd, RELATIVE), committed);
  git('add', '--all');
  git('commit', '--quiet', '-m', 'kit baseline');

  if (working !== undefined) writeFileSync(join(cwd, RELATIVE), working);
  return cwd;
};

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('a config.toml carrying a FOREIGN project id does not make this worktree the owner', () => {
  // The copied-config case: a sibling worktree's config.toml (or a hand edit)
  // landed here. It differs from HEAD, so the old predicate calls it isolated —
  // and a teardown driven by that answer runs `supabase stop --project-id` on
  // someone else's stack, or on the shared one.
  const cwd = repo({
    committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }),
    working: configToml({ id: 'demo-someone-elses-branch', offset: 900 }),
  });

  assert.equal(isIsolatedConfig({ cwd, relativePath: RELATIVE }), true, 'the old signal is satisfied by mere difference');

  const owned = ownsStack({ cwd, relativePath: RELATIVE, expectedProjectId: 'demo-412-chat' });
  assert.equal(owned.owned, false);
  assert.equal(owned.projectId, 'demo-someone-elses-branch');
  assert.match(owned.reason, /demo-someone-elses-branch/);
  assert.match(owned.reason, /demo-412-chat/);

  // The shared id is the same refusal, and it is the expensive one: stopping it
  // takes the database out from under every other session on the machine.
  const shared = ownsStack({ cwd, relativePath: RELATIVE, expectedProjectId: 'demo-412-chat', run: () => ({ status: 1, stdout: '', stderr: '' }) });
  assert.equal(shared.owned, false);
});

test('a COMMITTED isolated project id still belongs to this worktree', () => {
  // The inverse lie: a branch that legitimately commits its project id does not
  // differ from HEAD, so the old signal called it shared — and teardown left
  // seven containers running when the worktree was removed.
  const isolated = configToml({ id: 'demo-412-chat', offset: 60 });
  const cwd = repo({ committed: isolated });

  assert.equal(isIsolatedConfig({ cwd, relativePath: RELATIVE }), false, 'nothing differs from HEAD here');

  const owned = ownsStack({ cwd, relativePath: RELATIVE, expectedProjectId: 'demo-412-chat' });
  assert.equal(owned.owned, true);
  assert.equal(owned.projectId, 'demo-412-chat');
  assert.equal(owned.rewritten, false, 'the rewrite signal is reported, but it does not decide ownership');
});

test('ownership is refused, never guessed, and never thrown', () => {
  const cwd = repo({ committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }) });

  // No expectation to compare against: the caller has no derived id, so nothing
  // can be shown to belong here. Refusing is the only safe answer.
  const blind = ownsStack({ cwd, relativePath: RELATIVE });
  assert.equal(blind.owned, false);
  assert.match(blind.reason, /no project id was derived/);

  // A config with no project_id at all addresses no stack.
  writeFileSync(join(cwd, RELATIVE), '[api]\nport = 54321\n');
  const bare = ownsStack({ cwd, relativePath: RELATIVE, expectedProjectId: 'demo-412-chat' });
  assert.equal(bare.owned, false);
  assert.match(bare.reason, /no project_id/);

  // A missing tree, and a runner that throws, are reasons — not crashes. A
  // throw here would abort a teardown half-way through. The id has to MATCH for
  // this one, because the secondary rewrite signal is the only thing that runs
  // git at all.
  assert.equal(ownsStack({ cwd: join(cwd, 'nope'), relativePath: RELATIVE, expectedProjectId: 'x' }).owned, false);
  assert.equal(ownsStack({ relativePath: RELATIVE, expectedProjectId: 'x' }).owned, false);
  writeFileSync(join(cwd, RELATIVE), configToml({ id: 'demo-412-chat', offset: 60 }));
  const angry = ownsStack({
    cwd,
    relativePath: RELATIVE,
    expectedProjectId: 'demo-412-chat',
    run: () => { throw new Error('git is not installed'); },
  });
  assert.equal(angry.owned, false);
  assert.match(angry.reason, /git is not installed/);
});

test('the block survives losing .env.local, because the config.toml records it', () => {
  // `git clean -xdf` wipes the untracked env file; config.toml is tracked and
  // skip-worktree'd, so it survives. Before this, the next setup read this
  // worktree's OWN running stack as a collision and moved to another block,
  // orphaning seven containers.
  const cwd = repo({
    committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }),
    working: configToml({ id: 'demo-412-chat', offset: 60 }),
  });

  assert.deepEqual(recordedClaim({ cwd, relativePath: RELATIVE, base: BASE }), { offset: 60, projectId: 'demo-412-chat' });

  const resolved = resolveOffset({
    identity: identity(),
    recorded: undefined, // the env record is gone
    base: BASE, step: STEP, maxSlot: MAX_SLOT,
    cwd, relativePath: RELATIVE,
    // Its own stack holds the +60 block. A scan would read that as a collision
    // and walk past it, which is exactly the leak — so a scan is a failure.
    isBound: () => assert.fail('a recovered claim must not probe the machine'),
  });
  assert.deepEqual(resolved, { offset: 60, source: 'config' });
});

test('a SHARED config.toml records no claim, so the scan still happens', () => {
  // Offset 0 is the committed baseline: the shared stack, whose id belongs to
  // the primary checkout. Reading a claim out of it would let any unpromoted
  // worktree address — and stop — the machine's database.
  const cwd = repo({ committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }) });
  assert.equal(recordedClaim({ cwd, relativePath: RELATIVE, base: BASE }), undefined);

  const probed = [];
  const resolved = resolveOffset({
    identity: identity(),
    recorded: '',
    base: BASE, step: STEP, maxSlot: MAX_SLOT,
    cwd, relativePath: RELATIVE,
    isBound: port => { probed.push(port); return false; },
  });
  assert.equal(resolved.source, 'scan');
  assert.ok(probed.length > 0, 'with no claim to recover, the machine is the only source left');

  // Nor does a file with no ports at all, or one whose ports disagree — a
  // hand-mangled config is not a claim, and guessing which half is right is how
  // you stop the wrong stack.
  writeFileSync(join(cwd, RELATIVE), 'project_id = "demo-412-chat"\n');
  assert.equal(recordedClaim({ cwd, relativePath: RELATIVE, base: BASE }), undefined);
  writeFileSync(join(cwd, RELATIVE), 'project_id = "demo-412-chat"\n\n[api]\nport = 54381\n\n[studio]\nport = 54523\n');
  assert.equal(recordedClaim({ cwd, relativePath: RELATIVE, base: BASE }), undefined);
});

test('renaming the branch keeps the stack the config.toml already names', () => {
  // setup on feat/412-chat minted `demo-412-chat` and recorded it. After
  // `git branch -m feat/412-chat-v2` the branch derivation mints a NEW id, and
  // that is the leak: config.toml gets rewritten, `supabase start` collides with
  // the ports its own old stack holds, and every later teardown addresses an id
  // Docker never used.
  const cwd = repo({
    committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }),
    working: configToml({ id: 'demo-412-chat', offset: 60 }),
  });
  const renamed = identity({ name: 'feat-412-chat-v2', branch: 'feat/412-chat-v2', issue: undefined });

  // What the record says wins over what the branch would mint.
  const kept = resolveProjectId({ identity: renamed, prefix: PREFIX, recorded: 'demo-412-chat', cwd, relativePath: RELATIVE, base: BASE });
  assert.deepEqual(kept, { projectId: 'demo-412-chat', source: 'recorded' });
  assert.equal(kept.projectId, configProjectId(join(cwd, RELATIVE)), 'the resolved id is the one the config records');
  assert.equal(ownsStack({ cwd, relativePath: RELATIVE, expectedProjectId: kept.projectId }).owned, true);

  // Without the record, the branch is all there is — and the mismatch is
  // REPORTED rather than silently rewritten, because those containers are what
  // gets left behind.
  const minted = resolveProjectId({ identity: renamed, prefix: PREFIX, cwd, relativePath: RELATIVE, base: BASE });
  assert.equal(minted.projectId, 'demo-412-chat-v2');
  assert.equal(minted.source, 'branch');
  assert.match(minted.conflict, /demo-412-chat/);
  assert.equal(ownsStack({ cwd, relativePath: RELATIVE, expectedProjectId: minted.projectId }).owned, false);

  // The config's id is evidence, never authority: a copied config cannot make
  // this worktree adopt a sibling's stack, however isolated the file looks.
  const foreign = repo({
    committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }),
    working: configToml({ id: 'demo-someone-elses-branch', offset: 900 }),
  });
  assert.equal(resolveProjectId({ identity: identity(), prefix: PREFIX, cwd: foreign, relativePath: RELATIVE, base: BASE }).projectId, 'demo-412-chat');

  // A junk record is not a name Docker could have used; mint instead.
  for (const junk of ['', '   ', 'Demo Chat', '-leading', 'x'.repeat(41)]) {
    assert.equal(resolveProjectId({ identity: identity(), prefix: PREFIX, recorded: junk }).source, 'branch', `${JSON.stringify(junk)} is not a project id`);
  }
});

test('a promotion that died between the two writes keeps the stack it configured', () => {
  // `promote` writes config.toml BEFORE the env block, on purpose. So a run
  // that died in between leaves a config NEWER than the record, naming
  // containers that are up — and here the stale record must lose, or those
  // containers are stranded under a name nothing addresses.
  const cwd = repo({
    committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }),
    working: configToml({ id: 'demo-412-chat', offset: 60 }),
  });

  const resolved = resolveProjectId({
    identity: identity(),           // still mints demo-412-chat: no rename here
    prefix: PREFIX,
    recorded: 'demo-411-earlier',   // a stale record from a previous claim
    cwd, relativePath: RELATIVE, base: BASE,
  });
  assert.equal(resolved.projectId, 'demo-412-chat');
  assert.equal(resolved.source, 'config', 'the config agrees with what this worktree derives, so it is not an adoption');
  assert.equal(resolved.conflict, undefined);
});

test('promote keeps a renamed worktree on its own stack instead of minting a second one', () => {
  const cwd = repo({
    committed: configToml({ id: 'vendor-kit-baseline', offset: 0 }),
    working: configToml({ id: 'demo-412-chat', offset: 60 }),
  });
  const written = [];

  const result = promote({
    cwd,
    identity: identity({ name: 'feat-412-chat-v2', branch: 'feat/412-chat-v2', issue: undefined }),
    base: BASE, step: STEP, maxSlot: MAX_SLOT,
    recorded: '',                        // .env.local offset gone
    recordedProjectId: 'demo-412-chat',  // but the id was recorded
    relativePath: RELATIVE,
    envFiles: ['.env.local'],
    envLabel: 'ax-supabase',
    envPrefix: 'AX_',
    prefix: PREFIX,
    start: { command: 'pnpm', args: ['run', 'supabase:start'] },
    isBound: () => assert.fail('neither half of the claim may be re-scanned'),
    run: () => ({ status: 0, stdout: '', stderr: '' }),
    write: (file, block) => written.push([file, block]),
  });

  // Same id, same block, and the config was NOT renamed: no second stack, and
  // the seven containers already running stay addressable.
  assert.equal(result.projectId, 'demo-412-chat');
  assert.equal(result.projectIdSource, 'recorded');
  assert.equal(result.offset, 60);
  assert.equal(result.offsetSource, 'config');
  assert.equal(result.config.changed, false, 'an unchanged claim rewrites no bytes');
  assert.equal(configProjectId(join(cwd, RELATIVE)), 'demo-412-chat');
  assert.equal(result.conflict, undefined);

  // And the record is rebuilt from the recovered claim, so the next run does
  // not depend on the config a second time.
  assert.equal(written[0][1].keys.AX_SUPABASE_OFFSET, '60');
  assert.equal(written[0][1].keys.AX_SUPABASE_PROJECT, 'demo-412-chat');
});

test('the env block records the project id next to the offset', () => {
  // The id is the ONLY handle Docker gives on the containers, and it used to be
  // written down nowhere at all.
  const keys = envKeys({ ports: blockPorts(BASE, 60), offset: 60, projectId: 'demo-412-chat', envPrefix: 'AX_' });
  assert.equal(keys.AX_SUPABASE_OFFSET, '60');
  assert.equal(keys.AX_SUPABASE_PROJECT, 'demo-412-chat');

  // Offset 0 is the shared baseline: recording either key there would claim an
  // isolation that does not exist.
  const shared = envKeys({ ports: blockPorts(BASE, 0), offset: 0, projectId: 'demo-412-chat', envPrefix: 'AX_' });
  assert.equal(shared.AX_SUPABASE_OFFSET, undefined);
  assert.equal(shared.AX_SUPABASE_PROJECT, undefined);
});

test('teardown refuses to stop a project it was given no name for', () => {
  // `supabase stop --project-id ""` is not a no-op: with nothing to match, the
  // CLI falls back to the project the working directory describes, which for an
  // unpromoted worktree is the SHARED stack.
  for (const id of [undefined, '', '   ']) {
    const result = teardown({ cwd: '/x', projectId: id, run: () => assert.fail('nothing may be stopped without an id') });
    assert.equal(result.stopped, false);
    assert.match(result.refused, /no project id/);
  }
});
