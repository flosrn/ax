// What a diagnosis is allowed to do, and what it must never do.
//
// `ax debug-as doctor` is the ONE agent-safe surface that touches every layer
// this feature has: a GUI, a resolved Playwright, a live application, an
// adapter, an authentication artifact, a receipt and a machine-global Serve
// mapping. Two rules make it safe to run at any time, and both are pinned here
// rather than described:
//
// IT STARTS NOTHING. No browser, no project server, no adapter, no provider
// request. Every fact it reports is read, so the tests inject readers and
// assert the ones that would spawn or authenticate are never called.
//
// IT DISTINGUISHES "OFF" FROM "BROKEN". Phone handoff is independently optional
// (R14): a project that never adopted it must pass with NO machine
// configuration on the machine at all, and a machine that has not enabled it
// must not fail either (R29). Only a contract that is declared AND malformed,
// or a mapping nobody owns, is a failure — and the unowned mapping names the
// exact withdrawal, because a surviving mapping forwards the tailnet to
// whatever binds that port next (R17).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { doctor as debugDoctor } from '../src/debug-as/doctor.mjs';
import { loadMachineConfig } from '../src/debug-as/machine-config.mjs';
import { providerHost } from '../src/debug-as/provider.mjs';
import { doctor } from '../src/doctor.mjs';
import { run } from '../src/exec.mjs';

/** Both streams, because a repair on stderr is still a repair an operator reads. */
function captured(fn) {
  const out = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (out.push(String(chunk)), true);
  process.stderr.write = chunk => (out.push(String(chunk)), true);
  return Promise.resolve()
    .then(fn)
    .then(
      code => ({ code, out: out.join('') }),
      error => {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
        throw error;
      },
    )
    .finally(() => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    });
}

const SERVICE_KEY = 'sb_secret_c0ffee1234567890abcd';

/** A browser-only contract: the whole feature for a project that wants no phone. */
const browserOnly = (overrides = {}) => ({
  browser: {
    playwrightDir: 'apps/e2e',
    start: ['pnpm', '--filter', 'web', 'dev'],
    navigationTimeoutSeconds: 120,
    prepare: { command: ['node', 'scripts/debug-auth-adapter.mjs'], timeoutSeconds: 300 },
  },
  phone: null,
  identities: {
    owner: { name: 'owner', defaultPath: '/home', authenticated: true, storageState: 'apps/e2e/.auth/owner.json', phone: false, email: null },
  },
  ...overrides,
});

/** The same contract with the optional half adopted by the PROJECT. */
const withPhone = () =>
  browserOnly({
    phone: {
      optInEnv: 'AX_DEBUG_AS_PHONE',
      provider: { type: 'supabase', urlEnv: 'SUPABASE_URL', serviceRoleKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY', confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' } },
    },
    identities: {
      owner: { name: 'owner', defaultPath: '/home', authenticated: true, storageState: 'apps/e2e/.auth/owner.json', phone: true, email: 'owner@example.com' },
    },
  });

const context = (overrides = {}) => ({
  root: '/repo',
  config: { project: { name: 'ofmchat', display: 'OFMChat' }, apps: { web: 'apps/web' } },
  contract: browserOnly(),
  env: {},
  addresses: { isWorktree: true, browserOrigin: 'http://localhost:3110', directOrigin: 'http://localhost:3110', tailnetOrigin: 'https://ofm-x.tail.ts.net', refusals: [] },
  ...overrides,
});

/**
 * Every reader answering "healthy", so each test changes exactly one fact. A
 * dep this factory does NOT provide is a dep the module must not need: the
 * spawning ones (adapter, provider request, browser launch) are absent by
 * design.
 */
const deps = (overrides = {}) => ({
  platform: 'darwin',
  guiRefusal: () => null,
  resolvePlaywright: () => ({ chromium: { executablePath: () => '/pw/chromium/headless_shell' }, devices: { 'iPhone 15': {} }, version: '1.62.1', from: '@playwright/test' }),
  exists: () => true,
  lookup: name => `/usr/local/bin/${name}`,
  checkLive: async () => ({ live: true, status: 200 }),
  loadStorageState: async () => ({ state: {}, refreshNeeded: false, path: '/repo/apps/e2e/.auth/owner.json' }),
  ignoredReceipt: () => true,
  readReceipt: () => ({ state: 'absent', receipt: null, refusal: null }),
  probeCdp: async () => ({ alive: true, why: '' }),
  readFlag: () => ({ value: true, at: 'AX_DEBUG_AS_PHONE', problem: '', fix: '' }),
  readVariable: name => (name === 'SUPABASE_SERVICE_ROLE_KEY' ? SERVICE_KEY : 'http://127.0.0.1:54321'),
  loadMachineConfig: () => ({ present: true, path: '/home/flo/.config/ax/debug-as.json', config: { relayPort: 1300, allowedLogins: ['operator@example.com'], allowedSupabaseHosts: [], notifier: null } }),
  providerHost: () => ({ host: '127.0.0.1', port: 54321, scheme: 'http', allowed: true, reason: 'loopback' }),
  sweepDeadRelay: () => ({ withdrawn: false, reason: 'absent' }),
  readServe: () => ({ mappings: [] }),
  readRelayReceipt: () => null,
  relayOwnedBy: () => false,
  ...overrides,
});

// ── the browser half ─────────────────────────────────────────────────────────

test('a browser-only project passes, and the machine phone contract is never even read', async () => {
  let machineReads = 0;
  let serveReads = 0;
  const run = await captured(() =>
    debugDoctor(
      context(),
      deps({
        loadMachineConfig: () => (machineReads += 1, { present: false, path: '/home/flo/.config/ax/debug-as.json', config: null }),
        readServe: () => (serveReads += 1, { mappings: [] }),
      }),
    ),
  );

  assert.equal(run.code, 0, run.out);
  assert.equal(machineReads, 0, 'a project that adopted no phone half has no machine contract to grade');
  assert.equal(serveReads, 0);
  assert.match(run.out, /Playwright 1\.62\.1/);
  assert.match(run.out, /@playwright\/test/);
});

test('a missing GUI, Playwright and agent-browser each name their own repair', async () => {
  const gui = await captured(() =>
    debugDoctor(
      context(),
      deps({ guiRefusal: () => ({ at: 'machine.display', problem: 'this machine has no local display — a Role browser is visible by definition', fix: 'run ax debug-as on the machine in front of you' }) }),
    ),
  );
  assert.equal(gui.code > 0, true);
  assert.match(gui.out, /no local display/);
  assert.match(gui.out, /→ run ax debug-as on the machine in front of you/);

  const playwright = await captured(() =>
    debugDoctor(
      context(),
      deps({
        resolvePlaywright: () => {
          throw Object.assign(new Error('neither @playwright/test nor playwright resolves from apps/e2e'), { fix: 'pnpm --filter e2e add -D @playwright/test' });
        },
      }),
    ),
  );
  assert.equal(playwright.code > 0, true);
  assert.match(playwright.out, /neither @playwright\/test nor playwright resolves/);
  assert.match(playwright.out, /→ pnpm --filter e2e add -D @playwright\/test/);

  // Playwright resolves and its browser was never downloaded: a different
  // state with a different repair, and the reason the binary is stat'ed.
  const chromium = await captured(() => debugDoctor(context(), deps({ exists: path => !String(path).includes('chromium') })));
  assert.equal(chromium.code > 0, true);
  assert.match(chromium.out, /→ .*playwright install chromium/);

  const driver = await captured(() => debugDoctor(context(), deps({ lookup: name => (name === 'agent-browser' ? null : `/usr/local/bin/${name}`) })));
  assert.equal(driver.code > 0, true);
  assert.match(driver.out, /agent-browser/);
  // NOT an install command: nothing here establishes how this machine installs
  // it, and AX never installs it (R12). The repair states the condition.
  assert.match(driver.out, /→ install agent-browser and put it on PATH/);
});

test('an application that does not answer names the declared start command, and nothing is started', async () => {
  const run = await captured(() =>
    debugDoctor(
      context(),
      deps({
        checkLive: async () => {
          throw Object.assign(new Error('nothing answers at http://localhost:3110'), { fix: 'pnpm --filter web dev' });
        },
      }),
    ),
  );

  assert.equal(run.code > 0, true);
  assert.match(run.out, /nothing answers at http:\/\/localhost:3110/);
  assert.match(run.out, /→ pnpm --filter web dev/);
});

test('an unreadable address is a finding with its own repair, and liveness is then not measured', async () => {
  let liveness = 0;
  const run = await captured(() =>
    debugDoctor(
      context({ addresses: { isWorktree: true, browserOrigin: null, directOrigin: null, tailnetOrigin: null, refusals: [{ at: 'AX_DIRECT_URL', problem: 'is not recorded for this worktree', fix: 'ax worktree setup' }] } }),
      deps({ checkLive: async () => (liveness += 1, { live: true, status: 200 }) }),
    ),
  );

  assert.equal(run.code > 0, true);
  assert.match(run.out, /AX_DIRECT_URL/);
  assert.match(run.out, /→ ax worktree setup/);
  assert.equal(liveness, 0, 'an address AX could not read is not an address to request');
});

test('the adapter is named and located, never executed, and its artifact is graded by path and mode', async () => {
  const healthy = await captured(() => debugDoctor(context(), deps()));
  assert.equal(healthy.code, 0, healthy.out);
  assert.match(healthy.out, /node scripts\/debug-auth-adapter\.mjs/);

  const stale = await captured(() =>
    debugDoctor(context(), deps({ loadStorageState: async () => ({ state: {}, refreshNeeded: true, path: '/repo/apps/e2e/.auth/owner.json' }) })),
  );
  assert.equal(stale.code, 0, 'a refresh the adapter owns is not an incoherent checkout');
  assert.match(stale.out, /node scripts\/debug-auth-adapter\.mjs/);

  const exposed = await captured(() =>
    debugDoctor(
      context(),
      deps({
        loadStorageState: async () => {
          throw Object.assign(new Error('apps/e2e/.auth/owner.json is group-readable'), { fix: 'chmod 600 apps/e2e/.auth/owner.json' });
        },
      }),
    ),
  );
  assert.equal(exposed.code > 0, true);
  assert.match(exposed.out, /→ chmod 600 apps\/e2e\/\.auth\/owner\.json/);
});

test('an unauthenticated project reports no artifact and no adapter instead of a missing one', async () => {
  const contract = browserOnly({
    browser: { playwrightDir: 'apps/e2e', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 60, prepare: null },
    identities: { anon: { name: 'anon', defaultPath: '/', authenticated: false, storageState: null, phone: false, email: null } },
  });
  let artifacts = 0;
  const run = await captured(() => debugDoctor(context({ contract }), deps({ loadStorageState: async () => (artifacts += 1, { state: {}, refreshNeeded: false, path: '' }) })));

  assert.equal(run.code, 0, run.out);
  assert.equal(artifacts, 0);
  assert.match(run.out, /no Debug adapter/);
});

test('receipt ignore status is graded, and a malformed receipt is a finding rather than an owner', async () => {
  const exposed = await captured(() => debugDoctor(context(), deps({ ignoredReceipt: () => false })));
  assert.equal(exposed.code > 0, true);
  assert.match(exposed.out, /\.agent\/debug-as\.local\.json/);
  assert.match(exposed.out, /→ ax init/);

  const malformed = await captured(() =>
    debugDoctor(
      context(),
      deps({ readReceipt: () => ({ state: 'malformed', receipt: null, refusal: { at: '.agent/debug-as.local.json', problem: 'is not valid JSON', fix: 'rm .agent/debug-as.local.json' } }) }),
    ),
  );
  assert.equal(malformed.code > 0, true);
  assert.match(malformed.out, /→ rm \.agent\/debug-as\.local\.json/);

  // A live record whose CDP endpoint answers nothing is the state `drive`
  // would fail on: reported, with the launch that replaces it.
  const dead = await captured(() =>
    debugDoctor(
      context(),
      deps({
        readReceipt: () => ({ state: 'live', receipt: { identity: 'owner', cdpPort: 51234, generation: 'a'.repeat(32) }, refusal: null }),
        probeCdp: async () => ({ alive: false, why: 'ECONNREFUSED' }),
      }),
    ),
  );
  assert.match(dead.out, /51234/);
  assert.match(dead.out, /→ ax debug-as --as owner/);

  // An owner this machine cannot disprove: another host's record, or a live pid
  // whose start identity is unreadable. It is NAMED, with the host the receipt
  // recorded — and the repair is the one runnable read, never a launch and
  // never a removal, because the ownership proof exists to keep an
  // unverifiable owner from being overwritten by a rival (R6, R34).
  const ambiguous = await captured(() =>
    debugDoctor(
      context(),
      deps({ readReceipt: () => ({ state: 'ambiguous', receipt: { identity: 'owner', host: 'other-mac', cdpPort: 51234, generation: 'b'.repeat(32) }, refusal: null }) }),
    ),
  );
  assert.match(ambiguous.out, /other-mac/);
  assert.match(ambiguous.out, /→ ax debug-as status$/m);
  assert.doesNotMatch(ambiguous.out, /→ ax debug-as --as/, 'an owner nobody can disprove must not be told to launch a rival');
  assert.doesNotMatch(ambiguous.out, /→ rm /);
});

// ── the optional phone half ──────────────────────────────────────────────────

test('a machine that never enabled Phone handoff is disabled, not broken, and nothing tailscale is read', async () => {
  let serveReads = 0;
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({
        loadMachineConfig: () => ({ present: false, path: '/home/flo/.config/ax/debug-as.json', config: null }),
        readServe: () => (serveReads += 1, { mappings: [] }),
      }),
    ),
  );

  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /DISABLED/);
  assert.match(run.out, /\.config\/ax\/debug-as\.json/);
  assert.equal(serveReads, 0, 'with no allowlist there is no relay to own a mapping');
});

test('a declared-but-malformed machine contract is a failure with its repair, and stops the phone domain there', async () => {
  let serveReads = 0;
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({
        loadMachineConfig: () => {
          throw Object.assign(new Error('~/.config/ax/debug-as.json is group-writable'), { at: 'machine.debug-as', problem: 'is group-writable', fix: 'chmod 600 ~/.config/ax/debug-as.json' });
        },
        readServe: () => (serveReads += 1, { mappings: [] }),
      }),
    ),
  );

  assert.equal(run.code > 0, true);
  assert.match(run.out, /→ chmod 600 ~\/\.config\/ax\/debug-as\.json/);
  assert.equal(serveReads, 0);
});

test('an unavailable tailscale is named as unavailable, never as "no mapping"', async () => {
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({
        readServe: () => {
          throw Object.assign(new Error('tailscale is not installed on this machine'), { fix: 'install Tailscale from https://tailscale.com/download' });
        },
      }),
    ),
  );

  assert.equal(run.code > 0, true);
  assert.match(run.out, /tailscale is not installed/);
  assert.match(run.out, /→ install Tailscale/);
});

test('a proven-dead relay owner has its mapping withdrawn before anything else binds, and that is reported', async () => {
  const order = [];
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({
        sweepDeadRelay: () => (order.push('sweep'), { withdrawn: true, reason: 'dead-owner' }),
        readServe: () => (order.push('serve'), { mappings: [] }),
      }),
    ),
  );

  assert.equal(run.code, 0, run.out);
  assert.deepEqual(order, ['sweep', 'serve'], 'reading the mapping before withdrawing a dead one reports a mapping that is about to vanish');
  assert.match(run.out, /withdr/i);
});

test('a Funnel-mapped or unowned mapping refuses with the exact withdrawal command', async () => {
  const mapping = { hostPort: 'mac.tail1234.ts.net:1300', host: 'mac.tail1234.ts.net', port: 1300, target: 'http://127.0.0.1:52341', funnel: false };

  const funnel = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({ readServe: () => ({ mappings: [{ ...mapping, funnel: true }] }), findMapping: (_state, port) => (port === 1300 ? { ...mapping, funnel: true } : null) }),
    ),
  );
  assert.equal(funnel.code > 0, true);
  assert.match(funnel.out, /[Ff]unnel/);
  assert.match(funnel.out, /→ tailscale serve --https=1300 off/);

  // Nobody owns it: no relay receipt claims this port, and the sweep proved no
  // dead owner either. It forwards the tailnet to whatever binds 52341 next.
  const unowned = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({ readServe: () => ({ mappings: [mapping] }), findMapping: () => mapping, readRelayReceipt: () => null }),
    ),
  );
  assert.equal(unowned.code > 0, true);
  assert.match(unowned.out, /→ tailscale serve --https=1300 off/);

  // Owned by a live relay: reported, never withdrawn.
  const owned = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({
        readServe: () => ({ mappings: [mapping] }),
        findMapping: () => mapping,
        readRelayReceipt: () => ({ version: 1, generation: 'b'.repeat(32), port: 1300, serveHost: 'mac.tail1234.ts.net', serveTarget: 'http://127.0.0.1:52341', worktree: '/repo', identity: 'owner' }),
        relayOwnedBy: () => true,
      }),
    ),
  );
  assert.equal(owned.code, 0, owned.out);
  assert.match(owned.out, /1300/);
  assert.doesNotMatch(owned.out, /tailscale serve --https=1300 off/);
});

test('the resolved provider host is reported, and a host outside the machine allowlist refuses', async () => {
  const local = await captured(() => debugDoctor(context({ contract: withPhone() }), deps()));
  assert.equal(local.code, 0, local.out);
  assert.match(local.out, /127\.0\.0\.1:54321/);

  const foreign = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({ providerHost: () => ({ host: 'db.example.supabase.co', port: 443, scheme: 'https', allowed: false, reason: 'not-allowlisted' }) }),
    ),
  );
  assert.equal(foreign.code > 0, true);
  assert.match(foreign.out, /db\.example\.supabase\.co/);
  assert.match(foreign.out, /allowedSupabaseHosts/);

  // An UNSET variable and a resolver that throws are not allowlist problems:
  // there is no host to allowlist, so the repair names the variable instead.
  // Composing the allowlist entry here would print "add {host: null}".
  for (const unreadable of [
    () => ({ host: null, port: null, scheme: null, allowed: false, reason: 'unresolved' }),
    () => {
      throw new Error('SUPABASE_URL is http://[::bad, which is not a URL');
    },
  ]) {
    const run = await captured(() => debugDoctor(context({ contract: withPhone() }), deps({ providerHost: unreadable })));
    assert.equal(run.code > 0, true);
    assert.match(run.out, /→ set SUPABASE_URL to/);
    assert.doesNotMatch(run.out, /allowedSupabaseHosts/);
    assert.doesNotMatch(run.out, /null/);
    // The thrown message is composed from the value behind the variable, and
    // nothing guarantees that value was registered as a secret — so it is
    // discarded rather than emitted and hoped to be redacted.
    assert.doesNotMatch(run.out, /\[::bad/);
  }
});

/**
 * A repair is a repair only if what it tells the operator to write is what
 * this machine's contract loader accepts. Both proposals below are therefore
 * TAKEN FROM THE EMITTED TEXT and fed to the real `loadMachineConfig` — a
 * wording assertion would have stayed green through the whole time the doctor
 * proposed a key (`allowedLogins`) and an entry shape (`{"host": …}`) the
 * loader refuses, because the parsed value carries the first name and the file
 * the second.
 */
function materialize(text) {
  const root = mkdtempSync(join(tmpdir(), 'ax-doctor-repair-'));
  const dir = join(root, '.config', 'ax');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'debug-as.json');
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return loadMachineConfig({ home: root, env: {}, reload: true });
}

test('the DISABLED repair proposes a machine contract this machine actually loads', async () => {
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({ loadMachineConfig: () => ({ present: false, path: '/home/flo/.config/ax/debug-as.json', config: null }) }),
    ),
  );

  assert.equal(run.code, 0, run.out);
  const proposed = /\{[^\n]*"relayPort"[^\n]*\}/.exec(run.out);
  assert.notEqual(proposed, null, run.out);

  const answer = materialize(proposed[0]);
  assert.equal(answer.present, true);
  assert.equal(answer.config.relayPort, 1300);
  // The FILE names the allowlist `allowedTailscaleLogins`; the parsed contract
  // exposes it as `allowedLogins`, and the repair must speak the file's name.
  assert.deepEqual(answer.config.allowedLogins, ['you@example.com']);
});

test('the allowlist repair proposes an entry the loader accepts and the provider then allows', async () => {
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({ providerHost: () => ({ host: 'db.example.supabase.co', port: 443, scheme: 'https', allowed: false, reason: 'not-allowlisted' }) }),
    ),
  );

  assert.equal(run.code > 0, true);
  const entry = /add "([^"\n]+)" to "allowedSupabaseHosts"/.exec(run.out);
  assert.notEqual(entry, null, run.out);

  const answer = materialize(JSON.stringify({ relayPort: 1300, allowedTailscaleLogins: ['you@example.com'], allowedSupabaseHosts: [entry[1]] }));
  assert.deepEqual(answer.config.allowedSupabaseHosts, [{ host: 'db.example.supabase.co', port: 443 }]);

  // The same classifier the handoff uses, against the allowlist the repair
  // produced: following the repair is what turns the refusal into a pass.
  const resolved = providerHost({
    provider: withPhone().phone.provider,
    readVariable: () => 'https://db.example.supabase.co',
    allowedHosts: answer.config.allowedSupabaseHosts,
  });
  assert.equal(resolved.allowed, true, resolved.reason);
});

test('an opt-in value AX cannot read refuses, while a false or absent one is simply reported', async () => {
  const off = await captured(() => debugDoctor(context({ contract: withPhone() }), deps({ readFlag: () => ({ value: false, at: 'AX_DEBUG_AS_PHONE', problem: '', fix: '' }) })));
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /AX_DEBUG_AS_PHONE/);

  const nonsense = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({ readFlag: () => ({ value: undefined, at: 'AX_DEBUG_AS_PHONE', problem: 'is "maybe", which is neither true nor false', fix: 'set AX_DEBUG_AS_PHONE to 1 or 0' }) }),
    ),
  );
  assert.equal(nonsense.code > 0, true);
  assert.match(nonsense.out, /→ set AX_DEBUG_AS_PHONE to 1 or 0/);
});

test('no diagnosis prints a resolved secret, whatever a reader hands back', async () => {
  const run = await captured(() =>
    debugDoctor(
      context({ contract: withPhone() }),
      deps({
        providerHost: () => ({ host: '127.0.0.1', port: 54321, scheme: 'http', allowed: true, reason: 'loopback' }),
        loadStorageState: async () => {
          throw Object.assign(new Error(`adapter wrote apikey: ${SERVICE_KEY}`), { fix: `rerun the adapter with ${SERVICE_KEY}` });
        },
      }),
    ),
  );

  assert.ok(!run.out.includes(SERVICE_KEY), run.out);
});

// ── the tracked half: `ax doctor` ────────────────────────────────────────────

/** A checkout whose configuration is the only thing under test. */
function checkout(debugAs) {
  const root = mkdtempSync(join(tmpdir(), 'ax-debug-doctor-'));
  run('git', ['init', '-q'], { cwd: root });
  writeFileSync(
    join(root, 'ax.config.json'),
    `${JSON.stringify({ project: { name: 'ofmchat' }, apps: { web: '.' }, debugAs }, null, 2)}\n`,
  );
  return root;
}

test('ax doctor grades the adopted contract and its declared paths, and never the machine', async () => {
  const root = checkout({
    browser: { playwrightDir: 'apps/e2e', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 60 },
    identities: { owner: { defaultPath: '/home' } },
  });

  const graded = await captured(() => doctor(root));
  // The declared package does not exist in this checkout: a tracked path, a
  // tracked finding — and no GUI, Playwright or Tailscale was consulted to say so.
  assert.match(graded.out, /apps\/e2e/);
  assert.match(graded.out, /debugAs\.browser\.playwrightDir/);
  assert.doesNotMatch(graded.out, /Playwright 1\./);
  assert.doesNotMatch(graded.out, /tailscale/i);
});

test('ax doctor reports a contract refusal with the repair its own rules name', async () => {
  const root = checkout({
    browser: { playwrightDir: '.', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 60 },
    identities: { owner: { defaultPath: '/home', browser: { storageState: 'apps/e2e/.auth/owner.json' } } },
  });

  const graded = await captured(() => doctor(root));
  assert.equal(graded.code > 0, true);
  assert.match(graded.out, /debugAs\.identities\.owner/);
  assert.match(graded.out, /→ declare "debugAs\.browser\.prepare\.command"/);
});

test('ax doctor refuses a declared artifact path that leaves the checkout', async () => {
  const root = checkout({
    browser: { playwrightDir: '.', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 60, prepare: { command: ['node', 'adapter.mjs'], timeoutSeconds: 300 } },
    identities: { owner: { defaultPath: '/home', browser: { storageState: '../elsewhere/owner.json' } } },
  });

  const graded = await captured(() => doctor(root));
  assert.equal(graded.code > 0, true);
  assert.match(graded.out, /storageState/);
  assert.match(graded.out, /\.\.\/elsewhere\/owner\.json/);
});

test('ax doctor passes on an adopted phone contract with no machine configuration at all', async () => {
  const root = checkout({
    browser: { playwrightDir: '.', start: ['pnpm', 'dev'], navigationTimeoutSeconds: 60, prepare: { command: ['node', 'adapter.mjs'], timeoutSeconds: 300 } },
    phone: {
      optInEnv: 'AX_DEBUG_AS_PHONE',
      provider: { type: 'supabase', urlEnv: 'SUPABASE_URL', serviceRoleKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY', confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' } },
    },
    identities: { owner: { defaultPath: '/home', browser: { storageState: 'owner.json' }, phone: { email: 'owner@example.com' } } },
  });

  const graded = await captured(() => doctor(root));
  assert.doesNotMatch(graded.out, /debugAs\.phone/, 'the machine half is not this verb’s to grade');
  assert.match(graded.out, /debug sessions/);
});

test('a checkout with no debugAs key is graded as having adopted nothing, silently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ax-debug-doctor-'));
  run('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'ax.config.json'), `${JSON.stringify({ project: { name: 'gapila' }, apps: { web: '.' } }, null, 2)}\n`);

  const graded = await captured(() => doctor(root));
  assert.doesNotMatch(graded.out, /debugAs/);
  assert.doesNotMatch(graded.out, /Debug identit/);
});
