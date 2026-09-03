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

// The case above is blind in exactly one direction, by construction: it walks
// the shipped schema through the same admission gate, so a keyword LISTED as
// supported and implemented nowhere passes it. `patternProperties` was that
// keyword, and both of its modes were measured on the unfixed validator — with
// nothing beside it, a value violating the pattern subschema produced zero
// errors; beside `additionalProperties: false`, a key the pattern MATCHED was
// refused as `unknown key`, an error that denies the keyword exists. So the
// admission list is pinned from the other side too: what it does not name is
// refused, by name, at the node that declared it.
const refusal = at => ({
  name: 'Error',
  message: `ax.schema.json uses unsupported keyword "patternProperties" at ${at}`,
});

test('a keyword the validator does not implement is refused, never admitted unimplemented', () => {
  const open = { type: 'object', patternProperties: { '^[a-z]+$': { type: 'integer' } } };
  assert.throws(() => validate({ abc: 'not-an-integer' }, open), refusal('root'));

  // The inverted mode: a matching key carrying a valid value, which the key loop
  // used to reach `additionalProperties` with the pattern map never consulted.
  const closed = { type: 'object', additionalProperties: false, patternProperties: { '^[a-z]+$': { type: 'integer' } } };
  assert.throws(() => validate({ abc: 1 }, closed), refusal('root'));
});

test('the refusal names the node that declares the keyword', () => {
  const onAChild = { type: 'object', properties: { apps: { type: 'object', patternProperties: { '^[a-z]+$': { type: 'string' } } } } };
  assert.throws(() => validate({ apps: { web: 'apps/web' } }, onAChild), refusal('apps'));

  const deeper = {
    type: 'object',
    properties: { triage: { type: 'object', properties: { labels: { type: 'object', patternProperties: { '^[a-z]+$': { type: 'string' } } } } } },
  };
  assert.throws(() => validate({ triage: { labels: { bug: 'ready-for-agent' } } }, deeper), refusal('triage.labels'));
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

// `$comment` is a reserved JSON-Schema annotation, and a project annotates the
// SECTION whose reasoning it is explaining. Listing it per object is how it came
// to be admitted under `prGate` and refused under `dispatch` — so the rule is
// structural: reserved annotations are admitted at every object level, including
// inside a keyed map, where the value would otherwise be validated as an entry
// of that map (`dispatch.hosts: expected object, got string`).
test('a reserved annotation is admitted at every object level, not per object', () => {
  const annotated = {
    ...minimal(),
    $comment: 'why this repository is configured this way',
    dispatch: {
      $comment: 'why the entry point is this verb and not another',
      entry: '/work',
      hosts: {
        $comment: 'why this fleet has exactly one remote host',
        vps: { $comment: 'why the floors on this host are these', ssh: 'orca@vps' },
      },
    },
  };
  assert.deepEqual(validate(annotated, schema), []);
});

test('an annotation is a string, and every other unknown key is still refused by name', () => {
  assert.deepEqual(validate({ ...minimal(), $schema: './ax.schema.json' }, schema), []);

  const typo = validate({ ...minimal(), dispatch: { $comments: 'plural' } }, schema);
  assert.equal(typo.length, 1);
  assert.match(typo[0], /dispatch: unknown key "\$comments"/);

  const notText = validate({ ...minimal(), dispatch: { $comment: 42 } }, schema);
  assert.equal(notText.length, 1);
  assert.match(notText[0], /dispatch: "\$comment" is an annotation, expected string, got integer/);
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
