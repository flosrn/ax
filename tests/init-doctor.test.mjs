// init and doctor are tested against a real git repository in a temp dir,
// because both of them derive everything from `git rev-parse` — a mocked
// filesystem would prove nothing about the case that actually breaks (a
// worktree, whose root and primary checkout differ).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { readBlock } from '../src/blocks.mjs';
import { loadConfig } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { init } from '../src/init.mjs';

let dir = '';
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ax-fixture-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'e2e'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'billing'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'client-saas', scripts: { dev: 'turbo dev' } }, null, 2));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS.md\n\nMonorepo notes.\n');
  git('init', '-q');
  git('remote', 'add', 'kit', 'git@github.com:makerkit/next-supabase-saas-kit-turbo.git');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('a dry run reports the plan and writes nothing', () => {
  assert.equal(init(dir, { dryRun: true }), 0);
  assert.equal(existsSync(join(dir, 'ax.config.json')), false);
  assert.equal(existsSync(join(dir, 'bin', 'ax')), false);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n');
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

test('init leaves the vendor-owned files intact around its block', () => {
  const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.match(gitignore, /^node_modules\/$/m);
  assert.equal(readBlock(gitignore, { id: 'ax', style: 'hash' }).split('\n')[0], '.worktrees/');

  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Monorepo notes\./);
  assert.match(readBlock(agents, { id: 'ax', style: 'markdown' }), /pnpm ax doctor/);

  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.dev, 'turbo dev');
  assert.equal(manifest.scripts.ax, './bin/ax');
  assert.match(manifest.devDependencies['makerkit-ax'], /^github:flosrn\/ax#v/);

  assert.ok(statSync(join(dir, 'bin', 'ax')).mode & 0o111, 'bin/ax must be executable');
});

test('doctor passes on the repo init just prepared', () => {
  assert.equal(doctor(dir), 0);
});

test('a second init changes nothing', () => {
  const before = ['ax.config.json', '.gitignore', 'AGENTS.md', 'package.json', 'bin/ax'].map(file => readFileSync(join(dir, file), 'utf8'));
  assert.equal(init(dir), 0);
  const after = ['ax.config.json', '.gitignore', 'AGENTS.md', 'package.json', 'bin/ax'].map(file => readFileSync(join(dir, file), 'utf8'));
  assert.deepEqual(after, before);
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

test('doctor names the repair when the bootstrap is edited or removed', () => {
  writeFileSync(join(dir, 'bin', 'ax'), '#!/bin/sh\necho tampered\n');
  assert.equal(doctor(dir), 1);
  assert.equal(init(dir), 0);
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

test('outside a git repository, doctor says so instead of scanning upwards', () => {
  const orphan = mkdtempSync(join(tmpdir(), 'ax-orphan-'));
  assert.equal(doctor(orphan), 1);
  rmSync(orphan, { recursive: true, force: true });
});
