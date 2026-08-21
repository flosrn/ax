import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  planUrls,
  proxyAvailable,
  proxyEnabled,
  proxyName,
  proxyPort,
  proxyServedUrl,
  tailnetName,
} from '../src/worktree/addressing.mjs';

// Every probe below is injected, so nothing here asks this machine for a binary,
// a proxy route or a tailnet. A test that consulted the real PATH would pass or
// fail depending on what the operator happens to have installed.

test("only the literal '0' disables the proxy — an absent key and 'false' both enable it", () => {
  assert.equal(proxyEnabled({ recorded: '0' }), false);
  // The asymmetry the dev-server launcher enforces, asserted so nobody "fixes" it
  // into a truthiness test: a doctor that disagreed here graded a proxied
  // worktree as direct-mode and called the mismatched origin healthy.
  assert.equal(proxyEnabled({}), true);
  assert.equal(proxyEnabled({ recorded: undefined }), true);
  assert.equal(proxyEnabled({ recorded: '' }), true);
  assert.equal(proxyEnabled({ recorded: 'false' }), true);
  assert.equal(proxyEnabled({ recorded: '1' }), true);
  assert.equal(proxyEnabled({ recorded: 0 }), false);
});

test('proxy availability is answered through the injected lookup, never the real PATH', () => {
  const asked = [];
  const which = bin => {
    asked.push(bin);
    return bin === 'present';
  };
  assert.equal(proxyAvailable({ bin: 'present', which }), true);
  assert.equal(proxyAvailable({ bin: 'absent', which }), false);
  assert.deepEqual(asked, ['present', 'absent']);
  // No binary configured is not "installed", and is not a lookup either.
  assert.equal(proxyAvailable({ bin: '', which }), false);
  assert.deepEqual(asked, ['present', 'absent']);
});

test('the proxy port falls back only when unrecorded, and refuses a malformed value', () => {
  assert.equal(proxyPort({ recorded: '8443', fallback: 1355 }), 8443);
  assert.equal(proxyPort({ recorded: '', fallback: 1355 }), 1355);
  assert.equal(proxyPort({ fallback: 1355 }), 1355);
  // A typo must not be papered over by the fallback: an unreachable proxy is
  // cheap to diagnose only while the bad value still reaches a comparison.
  assert.equal(proxyPort({ recorded: '80a', fallback: 1355 }), undefined);
  assert.equal(proxyPort({ recorded: '-1', fallback: 1355 }), undefined);
  assert.equal(proxyPort({}), undefined);
});

test('the proxy name is the recorded value, else the configured fallback', () => {
  assert.equal(proxyName({ recorded: 'recorded-name', fallback: 'configured' }), 'recorded-name');
  assert.equal(proxyName({ recorded: '', fallback: 'configured' }), 'configured');
  assert.equal(proxyName({ fallback: 'configured' }), 'configured');
  assert.equal(proxyName({}), undefined);
});

test('the served URL is asked of the proxy, never composed', () => {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    return 'http://feat-x.demo.localhost:1355\n';
  };
  assert.equal(
    proxyServedUrl({ name: 'demo', bin: 'proxy-bin', run }),
    'http://feat-x.demo.localhost:1355',
  );
  assert.deepEqual(calls, [['proxy-bin', 'get', 'demo']]);
});

test('a proxy that answers nothing usable yields no URL rather than a guess', () => {
  // Absent binary, or a lookup that failed.
  assert.equal(proxyServedUrl({ name: 'demo', run: () => undefined }), undefined);
  // Answered, but not an absolute HTTP URL. An announced address nothing serves
  // is worse than no address: every consumer downstream inherits it.
  assert.equal(proxyServedUrl({ name: 'demo', run: () => 'no route for demo' }), undefined);
  assert.equal(proxyServedUrl({ name: 'demo', run: () => 'http://' }), undefined);

  // Nothing to ask about, so the proxy is not asked at all.
  let asked = false;
  assert.equal(
    proxyServedUrl({
      name: undefined,
      run: () => {
        asked = true;
        return 'http://x';
      },
    }),
    undefined,
  );
  assert.equal(asked, false);
});

test('the tailnet name comes from a recorded override, DNSName, or the composed halves', () => {
  const status = json => () => JSON.stringify(json);

  assert.equal(tailnetName({ recorded: 'box.tail1234.ts.net.' }), 'box.tail1234.ts.net');
  assert.equal(
    tailnetName({ run: status({ Self: { DNSName: 'box.tail1234.ts.net.' } }) }),
    'box.tail1234.ts.net',
  );
  // Older daemons report the halves separately.
  assert.equal(
    tailnetName({
      run: status({ Self: { HostName: 'box' }, CurrentTailnet: { MagicDNSSuffix: 'tail1234.ts.net.' } }),
    }),
    'box.tail1234.ts.net',
  );

  // A recorded override wins outright, so the daemon is never even asked.
  let asked = false;
  assert.equal(
    tailnetName({
      recorded: 'override.ts.net',
      run: () => {
        asked = true;
        return '{}';
      },
    }),
    'override.ts.net',
  );
  assert.equal(asked, false);

  // A sleeping or logged-out daemon: no name, and no throw.
  assert.equal(tailnetName({ run: () => undefined }), undefined);
  assert.equal(tailnetName({ run: () => 'not json' }), undefined);
  assert.equal(tailnetName({ run: status({ Self: { HostName: 'box' } }) }), undefined);
  assert.equal(tailnetName({ run: status({}) }), undefined);
});

test('planUrls returns exactly the five contracted keys', () => {
  const plan = planUrls({ port: 3412, proxy: { enabled: false }, tailnet: { enabled: false } });
  // Whole plan objects get compared — setup's against the doctor's — so the key
  // set is part of the contract, not an implementation detail.
  assert.deepEqual(Object.keys(plan).sort(), ['baseUrl', 'directUrl', 'log', 'mode', 'publishedUrl']);
});

test('a proxy route makes the proxy host the base URL, and the direct URL survives alongside it', () => {
  const plan = planUrls({
    worktreePath: '/repo/.worktrees/feat-x',
    branch: 'feat/x',
    port: 3412,
    proxy: { available: true, name: 'demo', servedUrl: 'http://feat-x.demo.localhost:1355' },
    tailnet: { enabled: false },
  });

  assert.equal(plan.mode, 'proxy');
  assert.equal(plan.baseUrl, 'http://feat-x.demo.localhost:1355');
  // Always kept: unconditionally true, and the fallback every tool needs when
  // the proxy is not running.
  assert.equal(plan.directUrl, 'http://localhost:3412');
  assert.equal(plan.publishedUrl, 'http://feat-x.demo.localhost:1355');
  assert.ok(plan.log.some(line => line.includes('asked the proxy, not composed')));
  assert.ok(plan.log.some(line => line.includes('branch feat/x')));
});

test('a proxy with no route for the name falls back to direct mode and says so', () => {
  const plan = planUrls({
    port: 3412,
    proxy: { available: true, name: 'demo', servedUrl: undefined },
    tailnet: { enabled: false },
  });

  assert.equal(plan.mode, 'direct');
  assert.equal(plan.baseUrl, 'http://localhost:3412');
  assert.equal(plan.publishedUrl, 'http://localhost:3412');
  const warning = plan.log.find(line => line.startsWith('WARN:'));
  assert.ok(warning, 'a broken project registration is a warning, not a silent downgrade');
  assert.ok(warning.includes("cannot name a route for 'demo'"));
  assert.ok(warning.includes('http://localhost:3412'));
});

test('an absent proxy is direct mode with the install hint the caller supplied', () => {
  const plan = planUrls({
    port: 3412,
    proxy: { available: false, name: 'demo', installHint: 'Install it: npm i -g the-proxy' },
    tailnet: { enabled: false },
  });

  assert.equal(plan.mode, 'direct');
  // Not a warning: a machine that never installed the proxy is a supported
  // machine, and warning on every plan would train the operator to skip them.
  const line = plan.log.find(l => l.includes('no local reverse proxy on PATH'));
  assert.ok(line);
  assert.ok(line.includes('Install it: npm i -g the-proxy'));
  assert.ok(plan.log.every(l => !l.startsWith('WARN:')));
});

test('an explicitly disabled proxy is never reported as broken', () => {
  // How the primary checkout, which owns the project's plain port, opts out.
  const plan = planUrls({
    port: 3000,
    proxy: { enabled: false, available: true, name: 'demo' },
    tailnet: { enabled: false },
  });
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.baseUrl, 'http://localhost:3000');
  assert.ok(plan.log.every(line => !line.startsWith('WARN:')));
});

test('the tailnet URL is the published address when there is one', () => {
  const plan = planUrls({
    port: 3412,
    proxy: { available: true, name: 'demo', servedUrl: 'http://feat-x.demo.localhost:1355' },
    tailnet: { name: 'box.tail1234.ts.net.' },
  });

  // The only address that holds from this machine, another machine and a phone.
  assert.equal(plan.publishedUrl, 'https://box.tail1234.ts.net:3412');
  // It replaces neither of the local addresses.
  assert.equal(plan.baseUrl, 'http://feat-x.demo.localhost:1355');
  assert.equal(plan.directUrl, 'http://localhost:3412');
  assert.equal(plan.mode, 'proxy');
  assert.ok(plan.log.some(line => line.includes('https://box.tail1234.ts.net:3412')));
});

test('an enabled tailnet with no name warns instead of quietly going local-only', () => {
  const plan = planUrls({ port: 3412, proxy: { enabled: false }, tailnet: {} });
  assert.equal(plan.publishedUrl, 'http://localhost:3412');
  assert.ok(plan.log.some(line => line.startsWith('WARN:') && line.includes('tailnet is not ready')));
});

test('planUrls is pure: same inputs, same plan, no machine dependency', () => {
  const input = {
    worktreePath: '/repo/.worktrees/feat-x',
    branch: 'feat/x',
    port: 3412,
    proxy: { available: true, name: 'demo', servedUrl: 'http://feat-x.demo.localhost:1355' },
    tailnet: { name: 'box.tail1234.ts.net' },
  };

  // This is the property the doctor depends on: it re-derives the plan setup
  // wrote and compares the two. If the derivation could vary with the machine,
  // that comparison would be a coin toss.
  assert.deepEqual(planUrls(input), planUrls(input));
  assert.deepEqual(planUrls(structuredClone(input)), planUrls(input));

  // And nothing is mutated on the way through.
  const snapshot = structuredClone(input);
  planUrls(input);
  assert.deepEqual(input, snapshot);
});

test('planUrls is callable with no probe data at all', () => {
  // The doctor grades worktrees on machines with neither layer installed; that
  // must be a plan, not a crash.
  const plan = planUrls({ port: 3412 });
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.directUrl, 'http://localhost:3412');
  assert.equal(plan.publishedUrl, 'http://localhost:3412');
  assert.ok(plan.log.length > 0);
});

test('the tool names live only in default arguments, and those defaults are wired', () => {
  // A project on a different proxy overrides the default rather than patching
  // this module, so the defaults have to actually reach the injected lookups.
  const seen = [];
  proxyAvailable({
    which: bin => {
      seen.push(bin);
      return false;
    },
  });
  proxyServedUrl({
    name: 'demo',
    run: bin => {
      seen.push(bin);
      return undefined;
    },
  });
  tailnetName({
    run: bin => {
      seen.push(bin);
      return undefined;
    },
  });
  assert.equal(seen.length, 3);
  assert.ok(seen.every(bin => typeof bin === 'string' && bin.length > 0));
});
