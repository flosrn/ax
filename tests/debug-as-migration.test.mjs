// The retired `debugAs` shape, from the file to the operator's terminal.
//
// `historicalShape` recognized it from the first commit of this contract, and
// nothing called it: `loadConfig` returns `config: null` the moment `validate`
// reports an error, so a consumer still carrying `{ route, optInEnv }` got
// `debugAs: unknown key "route"` from every verb and never the sentence saying
// where the section went. Four reviewers and an independent cross-model pass
// converged on that gap; R30 is the requirement it broke — a migration finding,
// and one that does not prevent a consumer from pinning the release before its
// own cutover.
//
// So these tests are the public path, not the recognizer: a real config file
// read through `loadConfig`, and the same file graded by `doctor`.
//
// THE LAST TEST IS STRUCTURAL and it is the reason `historicalShape` lives in
// `src/debug-as/declaration.mjs` rather than beside the rules it belongs with.
// `src/plan.mjs` interpolates `CONFIG_FILE` while its own module body runs, so
// the obvious wiring — `config.mjs` importing the rules module, which imports
// the plan — is a cycle that throws `Cannot access 'CONFIG_FILE' before
// initialization` at import time, killing every `ax` command rather than one
// verb. A leaf with no imports of its own is what makes the migration reachable
// from `loadConfig` at all.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { init } from '../src/init.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A real git checkout carrying one `ax.config.json`, because both verbs derive from `git rev-parse`. */
function checkout(config) {
  const dir = mkdtempSync(join(tmpdir(), 'ax-migration-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'client-saas' }, null, 2));
  writeFileSync(join(dir, 'ax.config.json'), JSON.stringify(config, null, 2));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

const base = extra => ({
  project: { name: 'client-saas' },
  apps: { web: 'apps/web' },
  vendor: { repo: 'makerkit/next-supabase-saas-kit-turbo' },
  ...extra,
});

/** What a verb printed, and its exit code. */
function capture(run) {
  const written = [];
  const real = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: run(), out: written.join('') };
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }
}

test('the retired shape loads the rest of the config and names its migration', () => {
  const dir = checkout(base({ debugAs: { route: '/debug-as', optInEnv: 'AX_DEBUG_AS_PHONE' } }));
  try {
    const loaded = loadConfig(dir);

    // Not a load failure: R30's promise is that pinning this release does not
    // require the rewrite, and every verb needs a config to do anything at all.
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.config, 'the retired section must not take the whole config down');
    assert.equal(loaded.config.project.name, 'client-saas');

    // And no compatibility path: the section is not carried into the config,
    // and a shape that cannot express an identity does not adopt the contract.
    assert.equal(loaded.config.debugAs, undefined);
    assert.ok(!loaded.declared.includes('debugAs'), 'a retired shape is not an adoption');

    assert.ok(loaded.migration, 'the retired shape must be recognized');
    assert.match(loaded.migration.problem, /retired/);
    assert.match(loaded.migration.fix, /"browser"/);
    assert.deepEqual(loaded.migration.keys.sort(), ['optInEnv', 'route']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real error beside the retired shape stays fatal, and still names the migration', () => {
  const dir = checkout(base({ debugAs: { route: '/debug-as' }, port: { dev: [3100, 3999] } }));
  try {
    const loaded = loadConfig(dir);
    assert.equal(loaded.config, null, 'an unknown root key is still invalid');
    assert.match(loaded.errors.join('\n'), /unknown key "port"/);
    assert.ok(loaded.migration, 'the operator is owed both sentences, not the shorter one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the adopted contract is not a migration', () => {
  const adopted = {
    browser: { playwrightDir: 'apps/e2e', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 120 },
    identities: { guest: { defaultPath: '/' } },
  };
  const dir = checkout(base({ debugAs: adopted }));
  try {
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.migration, null);
    assert.ok(loaded.declared.includes('debugAs'), 'the adopted contract IS an adoption');
    assert.deepEqual(loaded.config.debugAs, adopted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stripping branch only runs when a retired shape was recognized, which
// already proves `raw` is a non-null object — but nothing pinned that, and a
// future edit that hoists `Object.entries(raw)` out of the ternary would throw
// a TypeError where this function's whole contract is to RETURN the finding.
// Degenerate files are the cheapest place to hold that line.
test('a config that is not an object still reports errors instead of throwing', () => {
  for (const [body, expected] of [
    ['null', /expected object, got null/],
    ['[]', /expected object, got array/],
    ['"text"', /expected object, got string/],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'ax-migration-'));
    try {
      writeFileSync(join(dir, 'ax.config.json'), body);
      const loaded = loadConfig(dir);
      assert.equal(loaded.config, null, body);
      assert.match(loaded.errors.join('\n'), expected, body);
      assert.equal(loaded.migration, null, body);
      assert.deepEqual(loaded.declared, [], body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // And a `debugAs` that is not an object is not a migration either: the
  // retired shape is two named fields, not "anything under that key".
  for (const body of ['{"debugAs":null}', '{"debugAs":[]}']) {
    const dir = mkdtempSync(join(tmpdir(), 'ax-migration-'));
    try {
      writeFileSync(join(dir, 'ax.config.json'), body);
      assert.equal(loadConfig(dir).migration, null, body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('doctor prints the migration repair without failing the checkout', () => {
  const dir = checkout(base({ debugAs: { route: '/debug-as', optInEnv: 'AX_DEBUG_AS_PHONE' } }));
  try {
    const graded = capture(() => doctor(dir));

    // Non-fatal by decision: `ax pin` grades with this verb, and a finding that
    // blocked the pin would be the compatibility path R30 refuses to promise.
    assert.doesNotMatch(graded.out, /ax\.config\.json is invalid/);
    assert.match(graded.out, /retired/, 'the finding names the shape');
    assert.match(graded.out, /"browser"/, 'and the repair names what replaces it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same repair, from the other verb. `doctor` and `init` share one rule —
// neither may name a repair the other does not (src/init.mjs
// `retiredConfigKeyFixes`) — and `init` is the likelier first contact: a
// consumer pins the release, runs it, and provisions. It must not refuse
// either: the section is already dropped from what `loadConfig` returns, so
// there is nothing here for this verb to leave half-written.
test('init names the same migration repair and still provisions', () => {
  const dir = checkout(base({ debugAs: { route: '/debug-as', optInEnv: 'AX_DEBUG_AS_PHONE' } }));
  try {
    const provisioned = capture(() => init(dir));

    assert.equal(provisioned.code, 0, 'a retired section is not a refusal');
    assert.match(provisioned.out, /retired/, 'the finding names the shape');
    assert.match(provisioned.out, /"browser"/, 'and the repair names what replaces it');
    assert.doesNotMatch(provisioned.out, /invalid, leaving it untouched/);

    // The file is the user's: the verb reports where the section went and
    // rewrites nothing under that key.
    const after = JSON.parse(readFileSync(join(dir, 'ax.config.json'), 'utf8'));
    assert.deepEqual(after.debugAs, { route: '/debug-as', optInEnv: 'AX_DEBUG_AS_PHONE' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the config module loads first without an import cycle', () => {
  // The regression this guards is not a wrong value, it is an unloadable CLI:
  // entering `src/config.mjs` first must not reach `src/plan.mjs` while
  // `CONFIG_FILE` is still in its temporal dead zone. A fresh process is the
  // only honest check — inside this suite another module has already been
  // imported, which hides the cycle by warming the graph in a different order.
  const probe = `import('file://${join(ROOT, 'src', 'config.mjs')}').then(m => { if (typeof m.loadConfig !== 'function') process.exit(3); }, e => { console.error(e.message); process.exit(4); })`;
  execFileSync('node', ['--input-type=module', '-e', probe], { stdio: 'pipe' });
});
