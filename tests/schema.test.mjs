import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { schema } from '../src/config.mjs';
import { applyDefaults, validate } from '../src/schema.mjs';


const minimal = () => ({
  project: { name: 'ofmchat' },
  apps: { web: 'apps/web' },
  vendor: { repo: 'makerkit/next-supabase-saas-kit-turbo' },
});

test('the shipped schema only uses keywords the validator implements', () => {
  // The guarantee this file exists for: a keyword added to ax.schema.json that
  // nobody taught the validator must throw here, not be ignored at runtime.
  assert.deepEqual(validate(minimal(), schema), []);
});

test('a minimal config validates and gains every default', () => {
  const config = applyDefaults(minimal(), schema);
  assert.deepEqual(config.ports.dev, [3100, 3999]);
  assert.equal(config.ports.proxy, 1355);
  assert.equal(config.ports.supabaseBase, 54320);
  assert.equal(config.debugAs.route, '/debug-as');
  assert.equal(config.debugAs.optInEnv, 'AX_DEBUG_AS_PHONE');
});

test('an explicit value survives the defaults pass', () => {
  const config = applyDefaults({ ...minimal(), ports: { dev: [4000, 4100] } }, schema);
  assert.deepEqual(config.ports.dev, [4000, 4100]);
  assert.equal(config.ports.proxy, 1355);
});

test('a typo is an error, never a silently ignored key', () => {
  const errors = validate({ ...minimal(), port: { dev: [3100, 3999] } }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown key "port"/);
});

test('a project name that would break a Docker id is rejected', () => {
  const errors = validate({ ...minimal(), project: { name: 'OFMChat' } }, schema);
  assert.match(errors.join(), /project\.name.*does not match/);
});

test('every violation is reported in one pass', () => {
  const errors = validate({ project: {}, apps: {}, vendor: {} }, schema);
  assert.equal(errors.length, 3);
  assert.match(errors.join(), /project: missing required key "name"/);
  assert.match(errors.join(), /apps: missing required key "web"/);
  assert.match(errors.join(), /vendor: missing required key "repo"/);
});

test('a guarded tree needs both ownership lists, so a new path can be flagged', () => {
  const ours = { ...minimal(), vendor: { repo: 'a/b', guarded: { docs: { ours: ['adr'] } } } };
  assert.match(validate(ours, schema).join(), /docs: does not match any accepted shape/);

  const both = { ...minimal(), vendor: { repo: 'a/b', guarded: { docs: { ours: ['adr'], vendor: ['billing'] }, '.agents': 'vendor' } } };
  assert.deepEqual(validate(both, schema), []);
});

test('a port outside the addressable range is rejected', () => {
  const errors = validate({ ...minimal(), ports: { dev: [80, 3999] } }, schema);
  assert.match(errors.join(), /ports\.dev\[0\]: 80 is below the minimum 1024/);
});

test('this checkout’s ax.config.json validates, so ax worker dispatch can run here', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const raw = JSON.parse(readFileSync(join(root, 'ax.config.json'), 'utf8'));
  assert.deepEqual(validate(raw, schema), []);
});
