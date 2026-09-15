// The optional machine-private notifier: a convenience, never an authority.
//
// Two rules carry the weight. A notifier never decides whether a handoff
// succeeded — AX prints the relay URL itself, so delivery failing must leave a
// working session behind (R24, R23). And a successful delivery is deduplicated
// by publication GENERATION as well as by target: a republication supersedes the
// old link, so a key without the generation would keep re-delivering a URL that
// now renders the superseded page.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { notificationKey, notify, resetNotifications } from '../src/debug-as/notifier.mjs';

const GENERATION = 'a'.repeat(32);

const intent = (overrides = {}) => ({
  project: 'gapila',
  worktree: '/Users/flo/Code/gapilabs/gapila-pro',
  identity: 'pro',
  path: '/home/gapila-pro',
  generation: GENERATION,
  ...overrides,
});

const URL_FOR = `https://mac.tail1234.ts.net:1300/go?g=${GENERATION}`;

const machine = (command = ['private-notifier']) => ({
  relayPort: 1300,
  allowedLogins: ['operator@example.com'],
  allowedSupabaseHosts: [],
  notifier: command === null ? null : { command },
});

/** A notifier stand-in with the adapter envelope's signature. */
const adapter = (answer = () => ({})) => {
  const calls = [];
  const runAdapter = async options => {
    calls.push(options);
    return answer(options);
  };
  runAdapter.calls = calls;
  return runAdapter;
};

test('an absent notifier is not a failure: the printed relay URL is the delivery path', async () => {
  resetNotifications();
  const runAdapter = adapter();
  const answer = await notify({ machine: machine(null), intent: intent(), url: URL_FOR, runAdapter });
  assert.equal(answer.delivered, false);
  assert.equal(answer.reason, 'absent');
  assert.equal(answer.finding, null);
  assert.deepEqual(runAdapter.calls, []);
});

test('a delivery carries intent metadata and the generation-addressed URL, and no authentication material', async () => {
  resetNotifications();
  const runAdapter = adapter();
  const answer = await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter });
  assert.equal(answer.delivered, true);
  assert.equal(runAdapter.calls.length, 1);

  const call = runAdapter.calls[0];
  assert.deepEqual(call.command, ['private-notifier']);
  assert.equal(call.timeoutSeconds, 15);
  assert.deepEqual(call.request, {
    kind: 'phone-handoff',
    project: 'gapila',
    worktree: '/Users/flo/Code/gapilabs/gapila-pro',
    identity: 'pro',
    path: '/home/gapila-pro',
    generation: GENERATION,
    url: URL_FOR,
  });
  const serialized = JSON.stringify(call.request);
  assert.doesNotMatch(serialized, /token|hashed|service_role|apikey|storageState/i);
});

test('a successful delivery is not repeated for the same target and generation', async () => {
  resetNotifications();
  const runAdapter = adapter();
  await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter });
  const again = await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter });
  assert.equal(again.delivered, false);
  assert.equal(again.reason, 'deduplicated');
  assert.equal(runAdapter.calls.length, 1);
});

test('a republication is a new generation, so it is delivered again', async () => {
  resetNotifications();
  const runAdapter = adapter();
  await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter });
  const republished = intent({ generation: 'b'.repeat(32) });
  const answer = await notify({ machine: machine(), intent: republished, url: `https://mac.tail1234.ts.net:1300/go?g=${republished.generation}`, runAdapter });
  assert.equal(answer.delivered, true);
  assert.equal(runAdapter.calls.length, 2);
  assert.notEqual(notificationKey(intent()), notificationKey(republished));
});

test('every part of the target belongs to the key', () => {
  const base = notificationKey(intent());
  for (const change of [{ project: 'ofmchat' }, { worktree: '/elsewhere' }, { identity: 'owner' }, { path: '/home' }, { generation: 'c'.repeat(32) }]) {
    assert.notEqual(notificationKey(intent(change)), base, JSON.stringify(change));
  }
});

test('a failed delivery is an actionable finding, not a refusal, and stays retryable', async () => {
  resetNotifications();
  const failing = adapter(() => {
    throw Object.assign(new Error('notifier exited 1'), { fix: 'check the notifier' });
  });
  const answer = await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter: failing });
  assert.equal(answer.delivered, false);
  assert.equal(answer.reason, 'failed');
  assert.ok(answer.finding.at);
  assert.ok(answer.finding.problem);
  assert.ok(answer.finding.fix, 'a finding an operator cannot act on is not a finding');
  assert.match(answer.finding.fix, /private-notifier/);

  const retry = adapter();
  const second = await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter: retry });
  assert.equal(second.delivered, true, 'a later matching invocation retries the failed notification');
  assert.equal(retry.calls.length, 1);
});

test('a notifier that never answers is bounded by the same fifteen seconds AX owns end to end', async () => {
  resetNotifications();
  const slow = adapter(({ timeoutSeconds }) => {
    assert.equal(timeoutSeconds, 15);
    throw Object.assign(new Error('deadline'), { fix: 'raise the notifier\'s own budget' });
  });
  const answer = await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter: slow });
  assert.equal(answer.delivered, false);
  assert.ok(answer.finding.fix);
});

test('a notifier refusal never leaks the notifier\'s own diagnostics verbatim into the finding', async () => {
  resetNotifications();
  const leaky = adapter(() => {
    throw Object.assign(new Error('POST https://push.example.com?apikey=sk_live_9f3b failed'), { fix: 'x' });
  });
  const answer = await notify({ machine: machine(), intent: intent(), url: URL_FOR, runAdapter: leaky });
  assert.doesNotMatch(JSON.stringify(answer.finding), /sk_live_9f3b/);
});
