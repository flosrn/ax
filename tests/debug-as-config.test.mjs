// The debug-session contract a project declares, and every refusal that names
// its repair.
//
// The section this replaces validated two fields no command read, so nothing
// here is a regression test for old behavior: what is pinned is the shape the
// schema admits, the rules the schema CANNOT express (identity names and
// capability closure, because a keyed map cannot pattern its keys without a
// keyword the validator refuses), and the migration finding the historical
// `{ route, optInEnv }` shape earns instead of an automatic conversion.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { schema } from '../src/config.mjs';
import { planProject } from '../src/plan.mjs';
import { validate } from '../src/schema.mjs';
import { DEBUG_DECLARATION, historicalShape, loadDebugContract } from '../src/debug-as/config.mjs';

const base = () => ({
  project: { name: 'ofmchat' },
  apps: { web: 'apps/web' },
  vendor: { repo: 'makerkit/next-supabase-saas-kit-turbo' },
});

/** A browser-only adoption: the capability OFMChat takes without phone authority. */
const browserOnly = () => ({
  browser: {
    playwrightDir: 'apps/e2e',
    start: ['pnpm', '--filter', 'web', 'dev'],
    prepare: { command: ['node', 'scripts/debug-auth-adapter.mjs'], timeoutSeconds: 300 },
  },
  identities: {
    guest: { defaultPath: '/' },
    owner: { defaultPath: '/home', browser: { storageState: 'apps/e2e/.auth/owner@makerkit.dev.json' } },
  },
});

/** Browser plus the phone half Gapila adopts. */
const withPhone = () => ({
  ...browserOnly(),
  phone: {
    optInEnv: 'AX_DEBUG_AS_PHONE',
    provider: {
      type: 'supabase',
      urlEnv: 'NEXT_PUBLIC_SUPABASE_URL',
      serviceRoleKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY',
      confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' },
    },
  },
  identities: {
    guest: { defaultPath: '/' },
    pro: {
      defaultPath: '/home/gapila-pro',
      browser: { storageState: 'apps/e2e/.auth/pro@makerkit.dev.json' },
      phone: { email: 'pro@makerkit.dev' },
    },
  },
});

/** The contract as a whole config sees it, schema errors included. */
const load = debugAs => {
  const raw = debugAs === undefined ? base() : { ...base(), debugAs };
  return { schema: validate(raw, schema), ...loadDebugContract({ raw }) };
};

test('an absent root key adopts nothing and materializes no contract', () => {
  const loaded = load(undefined);
  assert.deepEqual(loaded.schema, []);
  assert.equal(loaded.adopted, false);
  assert.equal(loaded.contract, null);
  assert.deepEqual(loaded.refusals, []);
});

test('a browser-only declaration is a complete adoption', () => {
  const loaded = load(browserOnly());
  assert.deepEqual(loaded.schema, []);
  assert.deepEqual(loaded.refusals, []);
  assert.equal(loaded.adopted, true);
  assert.equal(loaded.contract.phone, null, 'phone stays unadopted rather than defaulted');
  assert.deepEqual(Object.keys(loaded.contract.identities), ['guest', 'owner']);
  assert.equal(loaded.contract.identities.guest.authenticated, false);
  assert.equal(loaded.contract.identities.owner.authenticated, true);
  assert.equal(loaded.contract.identities.owner.phone, false);
});

test('a browser-plus-phone declaration carries both capabilities per identity', () => {
  const loaded = load(withPhone());
  assert.deepEqual(loaded.schema, []);
  assert.deepEqual(loaded.refusals, []);
  assert.equal(loaded.contract.phone.optInEnv, 'AX_DEBUG_AS_PHONE');
  assert.equal(loaded.contract.phone.provider.type, 'supabase');
  assert.equal(loaded.contract.identities.pro.phone, true);
  assert.equal(loaded.contract.identities.guest.phone, false);
});

test('a command provider is the declared escape hatch, and an unknown provider type is not', () => {
  const command = withPhone();
  command.phone.provider = { type: 'command', command: ['node', 'scripts/phone-provider.mjs'] };
  assert.deepEqual(validate({ ...base(), debugAs: command }, schema), []);

  const invented = withPhone();
  invented.phone.provider = { type: 'twilio', urlEnv: 'X' };
  assert.equal(validate({ ...base(), debugAs: invented }, schema).length, 1);
});

test('a typo inside the contract is a schema error, never a silently ignored key', () => {
  const typo = browserOnly();
  typo.browser.playwrightDirectory = 'apps/e2e';
  const errors = validate({ ...base(), debugAs: typo }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown key "playwrightDirectory"/);
});

test('a missing half of the browser contract is refused by the schema', () => {
  const noStart = browserOnly();
  delete noStart.browser.start;
  assert.match(validate({ ...base(), debugAs: noStart }, schema).join('\n'), /missing required key "start"/);

  const noIdentities = browserOnly();
  delete noIdentities.identities;
  assert.match(validate({ ...base(), debugAs: noIdentities }, schema).join('\n'), /missing required key "identities"/);
});

// The rules a keyed map cannot express: `patternProperties` is refused by the
// validator by name (tests/schema.test.mjs), so the identity NAME is checked
// here — and it is not cosmetic. The name reaches a receipt path, a session
// name and an argv slot.
test('an identity name that cannot be used safely is refused with its repair', () => {
  for (const name of ['Owner', 'owner user', 'owner/pro', '../escape', '', '-lead']) {
    const contract = browserOnly();
    contract.identities[name] = { defaultPath: '/' };
    const [refusal, ...rest] = load(contract).refusals;
    assert.deepEqual(rest, [], `${JSON.stringify(name)} produced more than one refusal`);
    assert.match(refusal.at, /^debugAs\.identities/, `${JSON.stringify(name)} is refused somewhere else`);
    assert.match(refusal.problem, /name/i);
    assert.ok(refusal.fix.length > 0, `${JSON.stringify(name)} is refused with no repair`);
  }
});

test('a lowercase, hyphenated identity name is accepted', () => {
  const contract = browserOnly();
  contract.identities['super-admin'] = { defaultPath: '/admin', browser: { storageState: 'apps/e2e/.auth/super.json' } };
  assert.deepEqual(load(contract).refusals, []);
});

// R2: every path AX consumes is validated, and a DECLARED path is validated at
// load — the flag is not the only way one arrives.
test('a declared default path that is not a same-origin path component is refused', () => {
  for (const path of ['https://example.com/home', '//evil.example.com', '/home\\admin', 'home', '/home?next=/x', '/home#top']) {
    const contract = browserOnly();
    contract.identities.owner.defaultPath = path;
    const refusals = [...load(contract).refusals, ...load(contract).schema.map(message => ({ problem: message, fix: '', at: 'schema' }))];
    assert.ok(
      refusals.some(refusal => /path/i.test(refusal.problem)),
      `${JSON.stringify(path)} loaded as a default path`,
    );
  }
});

test('an authenticated identity without an adapter is refused, and so is an adapter nobody needs', () => {
  const noAdapter = browserOnly();
  delete noAdapter.browser.prepare;
  const missing = load(noAdapter).refusals;
  assert.equal(missing.length, 1, 'one authenticated identity, one refusal');
  assert.match(missing[0].at, /identities\.owner$/);
  assert.match(missing[0].problem, /storageState|adapter/i);
  assert.match(missing[0].fix, /prepare/);

  // Every violation in one pass (`src/schema.mjs`): a config with two broken
  // identities should be fixable in one edit, not one refusal per run.
  const both = browserOnly();
  both.identities.guest.browser = { storageState: 'apps/e2e/.auth/guest.json' };
  delete both.browser.prepare;
  const pair = load(both).refusals;
  assert.deepEqual(
    pair.map(refusal => refusal.at).sort(),
    ['debugAs.identities.guest', 'debugAs.identities.owner'],
  );

  // The mirror, from the project's side: an adapter declared where nothing is
  // authenticated is a command an operator believes is being run.
  const unusedAdapter = browserOnly();
  delete unusedAdapter.identities.owner.browser;
  const [unused, ...rest] = load(unusedAdapter).refusals;
  assert.deepEqual(rest, []);
  assert.match(unused.at, /browser\.prepare$/);
  assert.match(unused.problem, /no identity is authenticated/);
});

test('a phone identity requires both the machine-wide half and an authenticated session', () => {
  const noContractPhone = browserOnly();
  noContractPhone.identities.owner.phone = { email: 'owner@makerkit.dev' };
  const [unadopted] = load(noContractPhone).refusals;
  assert.match(unadopted.problem, /phone/i);
  assert.match(unadopted.fix, /"phone"/);

  const guestPhone = withPhone();
  guestPhone.identities.guest.phone = { email: 'guest@makerkit.dev' };
  const [unauthenticated] = load(guestPhone).refusals;
  assert.match(unauthenticated.at, /identities\.guest/);
  assert.match(unauthenticated.problem, /authenticated|storageState/i);
});

// R30: the historical shape is read from RAW configuration, before ordinary
// validation, and earns a migration finding — never an automatic conversion. A
// consumer must be able to pin the release that carries this contract before
// its own cutover, so the finding cannot be a load failure.
test('the historical two-field shape is named, with no automatic conversion', () => {
  for (const historical of [{ route: '/debug-as' }, { optInEnv: 'AX_DEBUG_AS_PHONE' }, { route: '/debug-as', optInEnv: 'AX_DEBUG_AS_PHONE' }]) {
    const found = historicalShape({ ...base(), debugAs: historical });
    assert.ok(found, `${JSON.stringify(historical)} was not recognized as the retired shape`);
    assert.match(found.problem, /retired|historical|no longer/i);
    assert.ok(found.fix.length > 0);
    assert.deepEqual(found.keys.sort(), Object.keys(historical).sort());
  }

  assert.equal(historicalShape(base()), null, 'an absent key is not a migration');
  assert.equal(historicalShape({ ...base(), debugAs: browserOnly() }), null, 'the adopted contract is not a migration');
});

test('the retired shape refuses as a contract, and still names the migration', () => {
  const loaded = load({ route: '/debug-as', optInEnv: 'AX_DEBUG_AS_PHONE' });
  assert.ok(loaded.schema.length > 0, 'the schema no longer admits the retired fields');
  const [refusal] = loaded.refusals;
  assert.match(refusal.problem, /retired|historical|no longer/i);
  assert.match(refusal.fix, /debugAs/);
});

test('the declaration this contract is adopted by is the root key itself', () => {
  assert.equal(DEBUG_DECLARATION, 'debugAs');
});

// Adoption is the DECLARATION, and the project plan is where that question is
// answered for every contract at once (`src/plan.mjs`). A defaulted section
// would have made every project an adopter, which is the defect this contract
// replaced.
test('the project plan reports adoption from the declaration, never from a default', () => {
  assert.equal(planProject({ declared: [] }).adopted.debug, false);
  assert.equal(planProject({ declared: ['apps'] }).adopted.debug, false);
  assert.equal(planProject({ declared: ['apps', DEBUG_DECLARATION] }).adopted.debug, true);
});
