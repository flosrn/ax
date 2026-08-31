// init and doctor are tested against a real git repository in a temp dir,
// because both of them derive everything from `git rev-parse` — a mocked
// filesystem would prove nothing about the case that actually breaks (a
// worktree, whose root and primary checkout differ).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { readBlock } from '../src/blocks.mjs';
import { loadConfig, version } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { LEGACY_OMP_LOADER_SOURCE, init } from '../src/init.mjs';

let dir = '';
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ax-fixture-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'e2e'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'billing'), { recursive: true });
  // An installed checkout, because `doctor` now grades the worktree too and a
  // fixture with no node_modules is legitimately broken: nothing in it could
  // run. Without this the fixture measures that, not what these tests assert.
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'client-saas', scripts: { dev: 'turbo dev' } }, null, 2));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS.md\n\nMonorepo notes.\n');
  // A project that already uses OMP: its own extension and settings must be
  // there afterwards, because `ax init` writes ONE file under `.omp/`.
  mkdirSync(join(dir, '.omp', 'extensions'), { recursive: true });
  writeFileSync(join(dir, '.omp', 'extensions', 'theirs.ts'), 'export default () => {};\n');
  writeFileSync(join(dir, '.omp', 'settings.json'), '{ "theirs": true }\n');
  git('init', '-q');
  git('remote', 'add', 'kit', 'git@github.com:makerkit/next-supabase-saas-kit-turbo.git');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('a dry run reports the plan and writes nothing', () => {
  assert.equal(init(dir, { dryRun: true }), 0);
  assert.equal(existsSync(join(dir, 'ax.config.json')), false);
  assert.equal(existsSync(join(dir, 'bin', 'ax')), false);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.equal(existsSync(join(dir, '.omp', 'extensions', 'ax.ts')), false);
});

test('init infers the project from the repo it runs in', () => {
  assert.equal(init(dir), 0);

  const { config, errors } = loadConfig(dir);
  assert.deepEqual(errors, []);
  assert.equal(config.project.name, 'client-saas');
  assert.equal(config.project.display, 'client-saas');
  assert.equal(config.apps.web, 'apps/web');
  assert.equal(config.apps.e2e, 'apps/e2e');
  assert.deepEqual(config.apps.caches, []);
  assert.equal(config.vendor.repo, 'makerkit/next-supabase-saas-kit-turbo');
});

test('init adapts to a plain package repo with no MakerKit layout or vendor remote', () => {
  const generic = mkdtempSync(join(tmpdir(), 'ax-generic-'));
  try {
    mkdirSync(join(generic, 'node_modules'), { recursive: true });
    writeFileSync(join(generic, 'package.json'), JSON.stringify({ name: '@demo/plain-repo' }, null, 2));
    execFileSync('git', ['init', '-q'], { cwd: generic, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:demo/plain-repo.git'], { cwd: generic, stdio: 'ignore' });

    assert.equal(init(generic), 0);
    const { config, errors } = loadConfig(generic);
    assert.deepEqual(errors, []);
    assert.equal(config.project.name, 'plain-repo');
    assert.equal(config.apps.web, '.');
    assert.equal(config.vendor, undefined);
    assert.equal(doctor(generic), 0);
  } finally {
    rmSync(generic, { recursive: true, force: true });
  }
});

test('init replaces the newline-delimited legacy OMP wrapper with package-root wiring', () => {
  const legacy = mkdtempSync(join(tmpdir(), 'ax-legacy-'));
  try {
    mkdirSync(join(legacy, 'node_modules'), { recursive: true });
    mkdirSync(join(legacy, '.omp', 'extensions'), { recursive: true });
    writeFileSync(join(legacy, 'package.json'), JSON.stringify({ name: 'legacy-consumer' }, null, 2));
    writeFileSync(join(legacy, '.omp', 'extensions', 'ax.ts'), LEGACY_OMP_LOADER_SOURCE);
    execFileSync('git', ['init', '-q'], { cwd: legacy, stdio: 'ignore' });

    assert.equal(LEGACY_OMP_LOADER_SOURCE.includes('\\n'), false, 'the migration bytes contain line breaks, not two printed escape characters');
    assert.equal(LEGACY_OMP_LOADER_SOURCE.includes('\n'), true);
    assert.equal(init(legacy), 0);
    assert.equal(existsSync(join(legacy, '.omp', 'extensions', 'ax.ts')), false);
    const settings = JSON.parse(readFileSync(join(legacy, '.omp', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.extensions, ['./node_modules/@flosrn/ax']);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});

test('init refuses a managed symlink before touching its external target', () => {
  const generic = mkdtempSync(join(tmpdir(), 'ax-symlink-'));
  const external = join(mkdtempSync(join(tmpdir(), 'ax-external-')), 'settings.json');
  try {
    mkdirSync(join(generic, '.omp'), { recursive: true });
    writeFileSync(join(generic, 'package.json'), JSON.stringify({ name: 'symlink-consumer' }, null, 2));
    writeFileSync(external, '{ \"sentinel\": true }\\n');
    symlinkSync(external, join(generic, '.omp', 'settings.json'));
    execFileSync('git', ['init', '-q'], { cwd: generic, stdio: 'ignore' });

    assert.equal(init(generic), 1);
    assert.equal(readFileSync(external, 'utf8'), '{ \"sentinel\": true }\\n');
  } finally {
    rmSync(generic, { recursive: true, force: true });
    rmSync(join(external, '..'), { recursive: true, force: true });
  }
});

test('init preserves an exact release or explicit development pin', () => {
  for (const pinned of ['0.9.0', 'link:../../flosrn/ax', 'file:../ax.tgz']) {
    const generic = mkdtempSync(join(tmpdir(), 'ax-local-pin-'));
    try {
      mkdirSync(join(generic, 'node_modules'), { recursive: true });
      writeFileSync(
        join(generic, 'package.json'),
        JSON.stringify({ name: 'local-pin-consumer', devDependencies: { '@flosrn/ax': pinned } }, null, 2),
      );
      execFileSync('git', ['init', '-q'], { cwd: generic, stdio: 'ignore' });

      assert.equal(init(generic), 0);
      const manifest = JSON.parse(readFileSync(join(generic, 'package.json'), 'utf8'));
      assert.equal(manifest.devDependencies['@flosrn/ax'], pinned);
      assert.equal(manifest.scripts.ax, './bin/ax');
    } finally {
      rmSync(generic, { recursive: true, force: true });
    }
  }
});

test('init migrates a range to the exact running release', () => {
  const generic = mkdtempSync(join(tmpdir(), 'ax-range-pin-'));
  try {
    mkdirSync(join(generic, 'node_modules'), { recursive: true });
    writeFileSync(
      join(generic, 'package.json'),
      JSON.stringify({ name: 'range-consumer', devDependencies: { '@flosrn/ax': '^0.10.0' } }, null, 2),
    );
    execFileSync('git', ['init', '-q'], { cwd: generic, stdio: 'ignore' });

    assert.equal(init(generic), 0);
    const manifest = JSON.parse(readFileSync(join(generic, 'package.json'), 'utf8'));
    assert.equal(manifest.devDependencies['@flosrn/ax'], version);
  } finally {
    rmSync(generic, { recursive: true, force: true });
  }
});

test('init leaves the vendor-owned files intact around its block', () => {
  const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.match(gitignore, /^node_modules\/$/m);
  assert.equal(readBlock(gitignore, { id: 'ax', style: 'hash' }).split('\n')[0], '.worktrees/');

  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Monorepo notes\./);
  assert.match(readBlock(agents, { id: 'ax', style: 'markdown' }), /`ax doctor`/);

  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.dev, 'turbo dev');
  assert.equal(manifest.scripts.ax, './bin/ax');
  // An EXACT npm version, and the running one: ax is published, so the pin is
  // what the lockfile resolves and what the global CLI delegates to. A github:
  // ref or a caret would each break one of those two.
  assert.equal(manifest.devDependencies['@flosrn/ax'], version);
  assert.match(manifest.devDependencies['@flosrn/ax'], /^\d+\.\d+\.\d+$/);

  assert.ok(statSync(join(dir, 'bin', 'ax')).mode & 0o111, 'bin/ax must be executable');
});

test('init registers the installed package root with OMP and preserves project settings', () => {
  const settings = JSON.parse(readFileSync(join(dir, '.omp', 'settings.json'), 'utf8'));
  assert.equal(settings.theirs, true);
  assert.deepEqual(settings.extensions, ['./node_modules/@flosrn/ax']);

  // Native project extensions remain beside the package root registration.
  assert.equal(readFileSync(join(dir, '.omp', 'extensions', 'theirs.ts'), 'utf8'), 'export default () => {};\n');
  assert.equal(existsSync(join(dir, '.omp', 'extensions', 'ax.ts')), false);
});

test('doctor passes on the repo init just prepared', () => {
  assert.equal(doctor(dir), 0);
});

const MANAGED = ['ax.config.json', '.gitignore', 'AGENTS.md', 'package.json', 'bin/ax', '.omp/settings.json'];

test('a second init changes nothing', () => {
  const before = MANAGED.map(file => readFileSync(join(dir, file), 'utf8'));
  assert.equal(init(dir), 0);
  assert.deepEqual(
    MANAGED.map(file => readFileSync(join(dir, file), 'utf8')),
    before,
  );
});

test('doctor fails on a guarded tree path claimed by neither side', () => {
  const config = JSON.parse(readFileSync(join(dir, 'ax.config.json'), 'utf8'));
  config.vendor.guarded = { docs: { ours: ['adr'], vendor: ['billing'] } };
  writeFileSync(join(dir, 'ax.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  assert.equal(doctor(dir), 0);

  // The case the check exists for: content appears under a shared tree and
  // nobody said whose it is.
  mkdirSync(join(dir, 'docs', 'surprise'));
  assert.equal(doctor(dir), 1);
  rmSync(join(dir, 'docs', 'surprise'), { recursive: true });
});

test('a checkout with no vendor remote is NOT MEASURED there, never an incoherent checkout', () => {
  // MEASURED 2026-08-28, and it blocked a real deployment. `@flosrn/ax@0.14.4`
  // was announced to goodluckagency/ofmchat; its bump workflow checked out main
  // with `actions/checkout` — which configures `origin` and nothing else — and
  // ran `ax pin`, whose doctor gate then refused the checkout because no remote
  // pointed at the vendored kit. The pin was never committed, so a published fix
  // could not reach the repository that reported the bug.
  //
  // The finding's own words were "vendor checks cannot run": an inability to
  // measure, printed as a failure. The remote's only consumers in this package
  // are `ax init` (which infers the vendor block from it) and this grading, so
  // nothing ax does breaks without it — while the guarded-tree ownership checks
  // read the filesystem and still run. That is what the last assertion pins:
  // demoting this line must not silence the domain it introduces.
  const capture = fn => {
    const written = [];
    const stdout = process.stdout.write;
    process.stdout.write = chunk => (written.push(String(chunk)), true);
    try {
      return { code: fn(), out: written.join('') };
    } finally {
      process.stdout.write = stdout;
    }
  };

  assert.equal(doctor(dir), 0, 'the fixture is coherent with its kit remote');

  git('remote', 'remove', 'kit');
  try {
    const r = capture(() => doctor(dir));
    assert.equal(r.code, 0, 'no remote for the kit is not a failing checkout');
    assert.match(r.out, /vendor checks NOT MEASURED here/);
    assert.match(r.out, /git remote add vendor git@github\.com:makerkit\/next-supabase-saas-kit-turbo\.git/);

    // The domain is not silenced with the remote: an unclaimed path under a
    // guarded tree still fails, remote or no remote.
    mkdirSync(join(dir, 'docs', 'surprise'));
    try {
      assert.equal(doctor(dir), 1, 'ownership grading does not need the remote');
    } finally {
      rmSync(join(dir, 'docs', 'surprise'), { recursive: true });
    }
  } finally {
    git('remote', 'add', 'kit', 'git@github.com:makerkit/next-supabase-saas-kit-turbo.git');
  }
  assert.equal(doctor(dir), 0);
});

test('doctor names the repair when the bootstrap is edited or removed', () => {
  writeFileSync(join(dir, 'bin', 'ax'), '#!/bin/sh\necho tampered\n');
  assert.equal(doctor(dir), 1);
  assert.equal(init(dir), 0);
  assert.equal(doctor(dir), 0);
});

test('doctor grades the OMP package root registration, and names ax init as the repair', () => {
  const settingsPath = join(dir, '.omp', 'settings.json');
  const original = JSON.parse(readFileSync(settingsPath, 'utf8'));

  writeFileSync(settingsPath, `${JSON.stringify({ ...original, extensions: ['./node_modules/@flosrn/ax', './node_modules/@flosrn/ax'] }, null, 2)}\n`);
  assert.equal(doctor(dir), 1);
  assert.equal(init(dir), 0);
  const deduped = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(deduped.theirs, true);
  assert.deepEqual(deduped.extensions, ['./node_modules/@flosrn/ax']);

  writeFileSync(settingsPath, `${JSON.stringify({ ...original, extensions: [] }, null, 2)}\n`);
  assert.equal(doctor(dir), 1);

  rmSync(settingsPath);
  assert.equal(doctor(dir), 1);

  assert.equal(init(dir), 0);
  const repaired = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(repaired.theirs, undefined, 'a deleted settings file has no unrelated value to invent');
  assert.deepEqual(repaired.extensions, ['./node_modules/@flosrn/ax']);
  assert.equal(doctor(dir), 0);
});

test('doctor refuses a git-ref or range pin now that ax is published', () => {
  const manifestPath = join(dir, 'package.json');
  const good = readFileSync(manifestPath, 'utf8');
  const withPin = pinned => {
    const manifest = JSON.parse(good);
    manifest.devDependencies['@flosrn/ax'] = pinned;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };

  withPin(`github:flosrn/ax#v${version}`);
  assert.equal(doctor(dir), 1);
  withPin(`^${version}`);
  assert.equal(doctor(dir), 1);

  writeFileSync(manifestPath, good);
  assert.equal(doctor(dir), 0);
});

test('doctor refuses a config it cannot trust instead of guessing', () => {
  const good = readFileSync(join(dir, 'ax.config.json'), 'utf8');
  writeFileSync(join(dir, 'ax.config.json'), '{ "project": { "name": "Bad Name" } }\n');
  assert.equal(doctor(dir), 1);
  // init must not overwrite a config it failed to parse — that file is the
  // user's, and a rewrite would destroy whatever they were mid-way through.
  assert.equal(init(dir), 1);
  assert.equal(readFileSync(join(dir, 'ax.config.json'), 'utf8'), '{ "project": { "name": "Bad Name" } }\n');
  writeFileSync(join(dir, 'ax.config.json'), good);
});

// A rename is a clean cutover: the old config key simply stops existing, and the
// schema's `additionalProperties: false` refuses it. But "unknown key" does not
// say where the key WENT, and a consuming repo meets this line while pinning the
// release — so the finding names the edit. Two renames have now been made this
// way (`triage` -> `ready`, `launch` -> `dispatch`), and both are read out of one
// table so a third cannot arrive with advice only one verb prints.
test('doctor names the rename when a config still carries the legacy triage key', () => {
  const good = readFileSync(join(dir, 'ax.config.json'), 'utf8');
  const config = JSON.parse(good);
  const capture = fn => {
    const written = [];
    const stdout = process.stdout.write;
    process.stdout.write = chunk => (written.push(String(chunk)), true);
    try {
      return { code: fn(), out: written.join('') };
    } finally {
      process.stdout.write = stdout;
    }
  };
  writeFileSync(join(dir, 'ax.config.json'), `${JSON.stringify({ ...config, triage: { labels: 'docs/labels.md' } }, null, 2)}\n`);
  const legacy = capture(() => doctor(dir));
  assert.equal(legacy.code, 1);
  assert.match(legacy.out, /unknown key "triage"/);
  assert.match(legacy.out, /rename the "triage" key to "ready"/);

  // And ONLY for that key. The advice is keyed on the validator's own phrasing
  // rather than the word, so a config whose real defect merely quotes a label
  // value containing "triage" is not sent to rename a key it does not have.
  writeFileSync(
    join(dir, 'ax.config.json'),
    `${JSON.stringify({ ...config, dispatch: { ...(config.dispatch ?? {}), databaseLabels: 'needs-triage' } }, null, 2)}\n`,
  );
  const unrelated = capture(() => doctor(dir));
  assert.equal(unrelated.code, 1);
  assert.doesNotMatch(unrelated.out, /rename the "triage" key/);

  // And ONLY at the ROOT. `src/schema.mjs` prints the LOCATION of the offending
  // key, so a nested `dispatch.triage` typo reports `dispatch: unknown key "triage"`:
  // advice to rename a root key this config does not have sends the operator to
  // edit a line that is already correct while the nested defect stays.
  writeFileSync(
    join(dir, 'ax.config.json'),
    `${JSON.stringify({ ...config, dispatch: { ...(config.dispatch ?? {}), triage: { labels: 'docs/labels.md' } } }, null, 2)}\n`,
  );
  const nested = capture(() => doctor(dir));
  assert.equal(nested.code, 1);
  assert.match(nested.out, /dispatch: unknown key "triage"/);
  assert.doesNotMatch(nested.out, /rename the "triage" key/);

  // init meets the same closed-schema refusal while a repo pins the release, so
  // it names the same rename — and still leaves the file untouched, which is the
  // rule the test above states.
  const legacyConfig = `${JSON.stringify({ ...config, triage: { labels: 'docs/labels.md' } }, null, 2)}\n`;
  writeFileSync(join(dir, 'ax.config.json'), legacyConfig);
  const initLegacy = capture(() => init(dir));
  assert.equal(initLegacy.code, 1);
  assert.match(initLegacy.out, /rename the "triage" key to "ready"/);
  assert.equal(readFileSync(join(dir, 'ax.config.json'), 'utf8'), legacyConfig);

  writeFileSync(join(dir, 'ax.config.json'), good);
  assert.equal(doctor(dir), 0);
});

// The second rename, and the reason the advice above became a table: `launch` was
// the verb until 0.16, so a config written against any earlier release carries
// the block under that name. Every key inside it keeps its own name, which is
// what makes the repair one line of editing rather than a re-read of the schema.
test('a config still carrying the launch block is told the block is dispatch now', () => {
  const good = readFileSync(join(dir, 'ax.config.json'), 'utf8');
  const config = JSON.parse(good);
  const capture = fn => {
    const written = [];
    const stdout = process.stdout.write;
    process.stdout.write = chunk => (written.push(String(chunk)), true);
    try {
      return { code: fn(), out: written.join('') };
    } finally {
      process.stdout.write = stdout;
    }
  };

  const legacyConfig = `${JSON.stringify({ ...config, launch: { entry: '/work' } }, null, 2)}\n`;
  writeFileSync(join(dir, 'ax.config.json'), legacyConfig);

  const legacy = capture(() => doctor(dir));
  assert.equal(legacy.code, 1);
  assert.match(legacy.out, /unknown key "launch"/);
  assert.match(legacy.out, /rename the "launch" key to "dispatch"/);
  assert.match(legacy.out, /ax worker dispatch/, 'the advice names the verb the block belongs to');

  // Both verbs, one sentence: a repair only `doctor` names is a repair half the
  // operators never see, and `init` is where a consuming repo meets the refusal.
  const initLegacy = capture(() => init(dir));
  assert.equal(initLegacy.code, 1);
  assert.match(initLegacy.out, /rename the "launch" key to "dispatch"/);
  assert.equal(readFileSync(join(dir, 'ax.config.json'), 'utf8'), legacyConfig, 'an invalid config is never rewritten');

  // A nested `launch` is not the root block. `dispatch.hosts.<h>.launch` reports
  // its own location, and advice to rename a root key this config does not carry
  // sends the operator to edit a line that is already correct.
  writeFileSync(
    join(dir, 'ax.config.json'),
    `${JSON.stringify({ ...config, dispatch: { hosts: { built: { ssh: 'x', launch: 'y' } } } }, null, 2)}\n`,
  );
  const nested = capture(() => doctor(dir));
  assert.equal(nested.code, 1);
  assert.doesNotMatch(nested.out, /rename the "launch" key/);

  writeFileSync(join(dir, 'ax.config.json'), good);
  assert.equal(doctor(dir), 0);
});

test('outside a git repository, doctor says so instead of scanning upwards', () => {
  const orphan = mkdtempSync(join(tmpdir(), 'ax-orphan-'));
  assert.equal(doctor(orphan), 1);
  rmSync(orphan, { recursive: true, force: true });
});
