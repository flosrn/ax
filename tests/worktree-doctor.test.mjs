// The doctor is graded against real checkouts, because every defect it exists to
// catch is a disagreement between files on disk, git's index and a re-derived
// plan — none of which a mocked filesystem reproduces. So: a real primary
// checkout with a commit, a real linked worktree, real `.env.local` files
// written through `dotenv.writeBlock`, and a real `config.toml` rewritten by the
// same `applyConfig` promotion uses.
//
// Nothing here touches Docker, a container, or a live port: every machine
// question arrives as an injected probe, exactly as `setup` injects them. That
// is the property the whole plan/doctor split buys, and this file is where it
// pays for itself.
//
// The fixture PROVISIONS by applying the plan (what setup does) and then asks
// the doctor to re-derive it. A coherent worktree must therefore yield nothing
// but `ok` — if that ever needs a special case, the two derivations have drifted
// apart again.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { removeBlock, writeBlock } from '../src/dotenv.mjs';
import { addWorktree } from '../src/git.mjs';
import { worktreeFindings } from '../src/worktree/doctor.mjs';
import { identify } from '../src/worktree/identity.mjs';
import { KEYS, RUNTIME_LABEL, planWorktree } from '../src/worktree/plan.mjs';
import { SUPABASE_LABEL, applyConfig } from '../src/worktree/supabase.mjs';

const config = {
  project: { name: 'demo', display: 'Demo' },
  ports: { dev: [3100, 3999], proxy: 1355, supabaseBase: 54320, step: 100, maxSlot: 45, reserved: ['0-1023', '3000'] },
  apps: { web: 'apps/web', e2e: 'apps/e2e', caches: [] },
};

const BRANCH = 'feat/thing-412';
const CONFIG_TOML = `${config.apps.web}/supabase/config.toml`;
const ENV_FILE = `${config.apps.web}/.env.local`;
const MANIFEST = `${config.apps.web}/package.json`;

// A committed baseline: an id that looks nothing like the project's own name
// (real vendor kits ship exactly that), so `isIsolatedConfig` can only be
// answering by comparing against the commit.
const BASELINE = `project_id = "vendor-kit-baseline"

[api]
port = 54321

[db]
port = 54322

[studio]
port = 54323
`;

const SCRIPTS = { 'supabase:start': 'pnpm -w ax supabase start', 'db:reset': 'pnpm -w ax supabase db reset' };

// Every machine question, answered as data. `isBound: () => false` is what keeps
// the resolved port and port block deterministic without binding a socket.
const probes = database => ({
  isBound: () => false,
  proxy: { enabled: false, reason: 'no proxy in tests' },
  tailnet: { enabled: false },
  database,
});
const ISOLATED = { touches: true, startable: true };
const SHARED = { touches: false };

let parent = '';
let main = '';
let tree = '';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const findings = (root, database) => worktreeFindings({ root, main, config, probes: probes(database), env: {} });
const bad = list => list.filter(finding => finding.level === 'bad');
const about = (list, text) => list.find(finding => finding.message.includes(text));

/**
 * Apply the plan, the way `setup` applies it — the fixture and the thing under
 * test must not compute expectations twice.
 */
function provision(root, database) {
  const identity = identify({ worktreePath: root, branch: BRANCH });
  const plan = planWorktree({ identity, worktreePath: root, config, recorded: {}, probes: probes(database) });

  for (const write of plan.env) {
    const file = join(root, write.file);
    if (write.remove) removeBlock(file, write.label);
    else writeBlock(file, write);
  }

  if (plan.supabase.mode === 'isolated') {
    applyConfig({
      configToml: join(root, CONFIG_TOML),
      projectId: plan.supabase.projectId,
      offset: plan.supabase.offset,
      base: config.ports.supabaseBase,
      apiUrl: plan.urls.publishedUrl,
    });
  }

  return plan;
}

/** Back to the committed tree, so one test's damage is never another's input. */
const restore = root => {
  git(root, 'checkout', '--', CONFIG_TOML, MANIFEST);
  rmSync(join(root, ENV_FILE), { force: true });
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
};

before(() => {
  parent = mkdtempSync(join(tmpdir(), 'ax-doctor-'));
  main = join(parent, 'primary');
  tree = join(parent, 'feat-thing-412');

  mkdirSync(join(main, config.apps.web, 'supabase'), { recursive: true });
  writeFileSync(join(main, CONFIG_TOML), BASELINE);
  writeFileSync(join(main, MANIFEST), `${JSON.stringify({ name: 'web', scripts: SCRIPTS }, null, 2)}\n`);

  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'ax@example.test');
  git(main, 'config', 'user.name', 'ax');
  git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'baseline');
  mkdirSync(join(main, 'node_modules'));

  const added = addWorktree({ cwd: main, path: tree, branch: BRANCH });
  assert.equal(added.ok, true, `git worktree add failed: ${added.out}`);
  mkdirSync(join(tree, 'node_modules'));
});

after(() => rmSync(parent, { recursive: true, force: true }));

test('a provisioned worktree agrees with its own plan on every point', () => {
  restore(tree);
  const plan = provision(tree, ISOLATED);

  const list = findings(tree, ISOLATED);
  assert.deepEqual(
    list.filter(finding => finding.level !== 'ok'),
    [],
  );

  // The findings are data, and the caller renders them — so the values that
  // matter have to be IN them, not merely implied by their absence.
  assert.ok(about(list, `PORT=${plan.port.port}`), 'the resolved port is reported');
  assert.ok(about(list, `port block +${plan.supabase.offset}`), 'the port block is reported');
  assert.ok(about(list, plan.urls.publishedUrl), 'the published URL is reported');
});

test('the primary checkout is not graded against a worktree plan', () => {
  // It carries no `.env.local` on purpose: it runs on the tracked defaults, and
  // demanding a worktree's overrides here reported the correct configuration as
  // broken for as long as the Bash version lacked this guard.
  const list = findings(main, SHARED);
  assert.deepEqual(bad(list), []);
  assert.ok(about(list, 'primary checkout'), 'it says which checkout this is');
  assert.equal(about(list, ENV_FILE), undefined, 'no per-checkout env file is demanded');
});

test('an uninstalled primary checkout is reported, an uninstalled worktree fails', () => {
  // Two states that look identical on disk and mean different things. A clone
  // nobody has installed yet is one command away from working and is the state
  // `ax init` leaves behind, so failing it would fail a correct checkout. A
  // worktree without dependencies is a provisioning failure: nothing in it runs.
  rmSync(join(main, 'node_modules'), { recursive: true, force: true });
  rmSync(join(tree, 'node_modules'), { recursive: true, force: true });
  try {
    assert.deepEqual(bad(findings(main, SHARED)), []);
    assert.equal(about(findings(main, SHARED), 'node_modules is missing').level, 'note');

    const failed = about(bad(findings(tree, ISOLATED)), 'node_modules is missing');
    assert.ok(failed, 'a worktree without dependencies fails');
    assert.equal(failed.fix, 'ax worktree setup');
  } finally {
    mkdirSync(join(main, 'node_modules'));
    mkdirSync(join(tree, 'node_modules'));
  }
});

test('a recorded port the plan refuses is reported with the reason and the repair', () => {
  restore(tree);
  const plan = provision(tree, ISOLATED);
  // 3000 is in `ports.reserved`: the port the primary checkout owns. The plan
  // therefore throws the recorded value out and allocates, and this worktree is
  // announcing an address it will not serve.
  writeBlock(join(tree, ENV_FILE), { label: RUNTIME_LABEL, keys: { ...plan.env[0].keys, PORT: '3000' } });

  const finding = about(bad(findings(tree, ISOLATED)), 'PORT=3000');
  assert.ok(finding, 'the recorded port is named');
  assert.match(finding.message, /reserved/);
  assert.match(finding.message, new RegExp(`plan says ${plan.port.port}`));
  assert.equal(finding.fix, 'ax worktree setup');
});

test('a symlinked node_modules is reported as another checkout resolving here', () => {
  restore(tree);
  provision(tree, ISOLATED);
  rmSync(join(tree, 'node_modules'), { recursive: true, force: true });
  symlinkSync(join(main, 'node_modules'), join(tree, 'node_modules'));

  const finding = about(bad(findings(tree, ISOLATED)), 'node_modules is a symlink');
  assert.ok(finding, 'the symlink is reported');
  assert.match(finding.message, /another branch's code/);
  // Re-running setup alone would not repair it: the link has to go first.
  assert.match(finding.fix, /^rm node_modules && ax worktree setup$/);

  rmSync(join(tree, 'node_modules'), { force: true });
  mkdirSync(join(tree, 'node_modules'));
});

test('env claiming an isolated database while config.toml is the committed one fails', () => {
  restore(tree);
  provision(tree, ISOLATED);
  // The state a merge or a stray `git checkout` produces: the endpoints stay,
  // the isolation goes. The app then writes into the shared database while every
  // recorded value says it is alone.
  git(tree, 'checkout', '--', CONFIG_TOML);

  const finding = about(bad(findings(tree, ISOLATED)), 'env records an isolated database');
  assert.ok(finding, 'the disagreement is reported');
  assert.match(finding.message, new RegExp(`${CONFIG_TOML} is the committed shared one`));
  assert.match(finding.message, /every other session reads/);
  assert.equal(finding.fix, 'ax worktree setup');
});

test('an endpoint naming a port outside the recorded block fails', () => {
  restore(tree);
  const plan = provision(tree, ISOLATED);
  const supabase = plan.env.find(write => write.label === SUPABASE_LABEL);
  const strayed = `http://127.0.0.1:${plan.supabase.ports.api + 2}`;
  // The offset is kept, so the block is still this worktree's — only the URL the
  // app dials has moved off it. Nothing answers there.
  writeBlock(join(tree, ENV_FILE), { label: SUPABASE_LABEL, keys: { ...supabase.keys, SUPABASE_URL: strayed } });

  const list = bad(findings(tree, ISOLATED));
  const finding = about(list, `SUPABASE_URL=${strayed}`);
  assert.ok(finding, 'the strayed endpoint is named');
  assert.match(finding.message, new RegExp(`port block \\+${plan.supabase.offset}`));
  assert.equal(finding.fix, 'ax worktree setup');
  // The offset itself still agrees, so the block is not also reported as wrong.
  assert.equal(about(list, 'env records port block'), undefined);
});

test('a stale isolated claim on a checkout whose plan shares is reported', () => {
  restore(tree);
  provision(tree, ISOLATED);
  git(tree, 'checkout', '--', CONFIG_TOML);
  // A recorded offset KEEPS a worktree isolated, deliberately — so the only way
  // the plan shares while the claim survives is a machine that cannot start the
  // stack. The recorded endpoints then name containers nothing is running, and
  // the plan says to erase them.
  const list = bad(findings(tree, { touches: true, startable: false, reason: 'no container runtime here' }));
  assert.ok(about(list, `${KEYS.supabaseOffset}=`), 'the stale claim is named');
  assert.ok(
    list.every(finding => finding.fix === 'ax worktree setup'),
    'every repair is the command that writes the plan down',
  );
});

test('a database script that bypasses the guard names the contamination', () => {
  restore(tree);
  provision(tree, ISOLATED);
  const manifest = JSON.parse(readFileSync(join(tree, MANIFEST), 'utf8'));
  manifest.scripts['db:reset'] = 'supabase db reset';
  writeFileSync(join(tree, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  const finding = about(bad(findings(tree, ISOLATED)), 'db:reset');
  assert.ok(finding, 'the script is named');
  assert.match(finding.message, /every other session's database/);
  assert.match(finding.fix, /ax supabase/);

  git(tree, 'checkout', '--', MANIFEST);
});
