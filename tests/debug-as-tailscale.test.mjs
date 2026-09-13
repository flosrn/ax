// Tailscale Serve as data, never as prose.
//
// `serve --bg` mappings SURVIVE process exit and reboot (Tailscale's own CLI
// reference says so), so an abandoned mapping keeps forwarding the tailnet to
// whatever local process next binds that released ephemeral port. Every rule
// here exists for that: the mapping is read from `serve status --json`, an
// unowned or Funnel-mapped collision refuses while naming the exact withdrawal
// command, and the withdrawal is a command AX issues rather than a state it
// hopes for.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findMapping, publishServe, readServe, tailnetHost, withdrawCommand, withdrawServe } from '../src/debug-as/tailscale.mjs';

/** The shape `tailscale serve status --json` prints: Tailscale's own ServeConfig. */
const serveConfig = ({ hostPort = 'mac.tail1234.ts.net:1300', proxy = 'http://127.0.0.1:52341', funnel = false } = {}) => ({
  TCP: { [hostPort.split(':')[1]]: { HTTPS: true } },
  Web: { [hostPort]: { Handlers: { '/': { Proxy: proxy } } } },
  ...(funnel ? { AllowFunnel: { [hostPort]: true } } : {}),
});

/** A recorder standing in for the real binary: `{ status, stdout, stderr, error }`, calls kept. */
const runner = answers => {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    const answer = answers[args.join(' ')] ?? answers.default;
    if (answer === undefined) return { status: 1, stdout: '', stderr: 'unexpected call', error: undefined };
    return { status: 0, stdout: '', stderr: '', ...answer };
  };
  run.calls = calls;
  return run;
};

test('serve status is read as JSON and mappings are keyed by port, whatever the host spelling', () => {
  const run = runner({ 'serve status --json': { stdout: JSON.stringify(serveConfig()) } });
  const state = readServe({ run });
  assert.deepEqual(run.calls, [['tailscale', 'serve', 'status', '--json']]);
  assert.deepEqual(state.mappings, [
    { hostPort: 'mac.tail1234.ts.net:1300', host: 'mac.tail1234.ts.net', port: 1300, target: 'http://127.0.0.1:52341', funnel: false },
  ]);
  assert.equal(findMapping(state, 1300).target, 'http://127.0.0.1:52341');
  assert.equal(findMapping(state, 1301), null);
});

test('a mapping written as localhost is the same mapping: ownership is decided on port and target, not spelling', () => {
  const run = runner({ 'serve status --json': { stdout: JSON.stringify(serveConfig({ hostPort: 'localhost:1300', proxy: 'http://127.0.0.1:52341' })) } });
  const mapping = findMapping(readServe({ run }), 1300);
  assert.equal(mapping.port, 1300);
  assert.equal(mapping.target, 'http://127.0.0.1:52341');
});

test('a Funnel-mapped port is reported as such, because Funnel is public exposure and never ours', () => {
  const run = runner({ 'serve status --json': { stdout: JSON.stringify(serveConfig({ funnel: true })) } });
  assert.equal(findMapping(readServe({ run }), 1300).funnel, true);
});

test('an empty configuration is no mappings, not a failure', () => {
  const run = runner({ 'serve status --json': { stdout: '{}' } });
  assert.deepEqual(readServe({ run }).mappings, []);
});

test('a missing tailscale binary refuses with an install repair rather than looking like "no mapping"', () => {
  const run = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  let error;
  assert.throws(() => readServe({ run }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.match(error.problem, /tailscale/i);
});

test('unparseable status output refuses instead of being read as an empty configuration', () => {
  const run = runner({ 'serve status --json': { stdout: 'Available within your tailnet:\n|-- https://mac' } });
  let error;
  assert.throws(() => readServe({ run }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
});

test('publication issues the documented background command and withdrawal its exact inverse', () => {
  const run = runner({ default: {} });
  publishServe({ port: 1300, target: 'http://127.0.0.1:52341', run });
  withdrawServe({ port: 1300, run });
  assert.deepEqual(run.calls, [
    ['tailscale', 'serve', '--bg', '--https=1300', 'http://127.0.0.1:52341'],
    ['tailscale', 'serve', '--https=1300', 'off'],
  ]);
  assert.equal(withdrawCommand(1300), 'tailscale serve --https=1300 off');
});

test('a refused publication names the withdrawal command, because the operator has to clear the port by hand', () => {
  const run = runner({ default: { status: 1, stderr: 'port 1300 is already in use' } });
  let error;
  assert.throws(() => publishServe({ port: 1300, target: 'http://127.0.0.1:52341', run }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.match(error.fix, /tailscale serve --https=1300 off/);
  assert.match(error.problem, /1300/);
});

test('a non-loopback Serve target refuses: Serve proxies only to this machine', () => {
  const run = runner({ default: {} });
  let error;
  assert.throws(() => publishServe({ port: 1300, target: 'http://10.0.0.5:52341', run }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.deepEqual(run.calls, [], 'nothing is published on the way to a refusal');
});

test('the tailnet host is read from status JSON with its trailing dot removed', () => {
  const run = runner({ 'status --json': { stdout: JSON.stringify({ Self: { DNSName: 'mac.tail1234.ts.net.' } }) } });
  assert.equal(tailnetHost({ run }), 'mac.tail1234.ts.net');
});

test('a tailnet with no name for this node refuses with a repair instead of composing a bad URL', () => {
  const run = runner({ 'status --json': { stdout: JSON.stringify({ Self: {} }) } });
  let error;
  assert.throws(() => tailnetHost({ run }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
});

test('a withdrawal failure refuses loudly: a mapping believed gone is the dangerous state', () => {
  const run = runner({ default: { status: 1, stderr: 'not found' } });
  let error;
  assert.throws(() => withdrawServe({ port: 1300, run }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.match(error.fix, /tailscale serve --https=1300 off/);
});
