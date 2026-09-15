// Who owns the Role browser of this worktree — the only question every debug
// verb asks before it acts.
//
// A receipt is not a cache of a browser that was once running: it is an
// AUTHORIZATION, and every mutation in this feature is issued against it. So
// the proof has to be strong enough that a crashed session, a recycled pid and
// a receipt planted by another process are three different answers, none of
// which is "go ahead". That is why the record carries host, the OS process's
// START identity and a random generation rather than a pid alone: pids are
// reused within minutes on a busy dev machine, and a pid-only proof authorizes
// a mutation against whatever process inherited the number.
//
// Nothing here signals a process and nothing here starts a browser. Liveness,
// the clock, the hostname, the git ignore answer and the CDP endpoint are all
// injected, because the cases that matter — a live owner an operator is
// clicking through, a pid that changed hands, a second host — cannot be staged
// with real processes and would be untestable at the exact moment they decide
// whether an authenticated session survives.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  BROWSER_RECEIPT,
  browserReceiptPath,
  chromiumPidFor,
  chromiumRoot,
  claimForProcess,
  liveBrowserClaim,
  newGeneration,
  probeCdp,
  processStart,
  publishReceipt,
  readReceipt,
  removeReceipt,
  sweepDeadBrowserState,
  updateReceiptPath,
} from '../src/debug-as/receipt.mjs';
import { WORKTREE_LOCK, acquireLock, worktreeLockPath, withLock } from '../src/debug-as/lock.mjs';

const fixtures = [];
after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

/** A worktree root whose `.agent/` exists and whose receipt path is ignored. */
function worktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-debug-receipt-')));
  fixtures.push(root);
  mkdirSync(join(root, '.agent'), { recursive: true });
  return root;
}

const HOST = 'mac.local';
const START = 'Fri Sep 12 09:00:00 2026';

/** Every machine answer the receipt layer consumes, injected. */
const deps = (overrides = {}) => ({
  host: HOST,
  pid: 4242,
  alive: () => true,
  start: () => START,
  now: () => '2026-09-12T09:05:00.000Z',
  ignored: () => true,
  ...overrides,
});

const fields = (overrides = {}) => ({
  generation: 'a'.repeat(32),
  project: 'ofmchat',
  worktree: '/w',
  identity: 'owner',
  origin: 'http://localhost:3210',
  path: '/home',
  device: null,
  viewport: { width: 1280, height: 800 },
  cdpPort: 51234,
  sessionName: 'ax-debug-owner',
  chromiumPid: 9001,
  ...overrides,
});

/** Publish a receipt into `root`, with the worktree field pointing at it. */
const publish = (root, overrides = {}, injected = {}) =>
  publishReceipt({ root, fields: fields({ worktree: root, ...overrides }) }, deps(injected));

// ── the record itself ────────────────────────────────────────────────────────

test('a published receipt carries exactly the keys the contract names, and no authentication material', () => {
  const root = worktree();
  const published = publish(root);
  assert.equal(published.ok, true);

  const written = JSON.parse(readFileSync(browserReceiptPath(root), 'utf8'));
  assert.deepEqual(
    Object.keys(written).sort(),
    [
      'cdpPort',
      'chromiumPid',
      'chromiumStart',
      'device',
      'generation',
      'host',
      'identity',
      'origin',
      'path',
      'pid',
      'processStart',
      'project',
      'publishedAt',
      'sessionName',
      'version',
      'viewport',
      'worktree',
    ].sort(),
  );
  assert.equal(written.version, 1);
  assert.equal(written.host, HOST);
  assert.equal(written.pid, 4242);
  assert.equal(written.processStart, START);
  assert.equal(written.chromiumPid, 9001);
  assert.equal(written.chromiumStart, START);
  assert.equal(written.cdpPort, 51234);
  assert.equal(written.publishedAt, '2026-09-12T09:05:00.000Z');
  // The whole serialized form, so a future key carrying a token or a relay
  // secret cannot be added without this test naming it.
  assert.ok(!/storageState|token|cookie|secret|Bearer/i.test(readFileSync(browserReceiptPath(root), 'utf8')));
});

test('the receipt is private to the invoking user and lands whole, never through a partially written path', () => {
  const root = worktree();
  publish(root);
  const path = browserReceiptPath(root);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Nothing but the receipt survives in the directory: the temp file it was
  // written through is renamed, not left behind for the next reader to parse.
  const entries = readdirSync(dirname(path));
  assert.deepEqual(entries, ['debug-as.local.json']);
});

test('BROWSER_RECEIPT is the path the ignore check and the publication agree on', () => {
  const root = worktree();
  const seen = [];
  publish(root, {}, { ignored: (at, relative) => (seen.push([at, relative]), true) });
  assert.deepEqual(seen, [[root, BROWSER_RECEIPT]]);
  assert.equal(browserReceiptPath(root), join(root, BROWSER_RECEIPT));
});

test('a generation is 32 hex characters and never repeats', () => {
  const generations = new Set(Array.from({ length: 64 }, () => newGeneration()));
  assert.equal(generations.size, 64);
  for (const generation of generations) assert.match(generation, /^[0-9a-f]{32}$/);
});

// ── publication refusals ─────────────────────────────────────────────────────

test('publication refuses while the receipt path is not ignored, and writes nothing', () => {
  const root = worktree();
  const refused = publish(root, {}, { ignored: () => false });
  assert.equal(refused.ok, false);
  assert.match(refused.refusal.problem, /ignore/i);
  assert.match(refused.refusal.fix, /gitignore|ax init/);
  assert.equal(existsFile(browserReceiptPath(root)), false);
});

test('a planted receipt symlink refuses rather than being followed', () => {
  const root = worktree();
  const target = join(root, 'planted.json');
  writeFileSync(target, '{}');
  symlinkSync(target, browserReceiptPath(root));

  const refused = publish(root);
  assert.equal(refused.ok, false);
  assert.match(refused.refusal.problem, /symlink|link/i);
  assert.ok(refused.refusal.fix);
  assert.equal(readFileSync(target, 'utf8'), '{}');
});

test('a symlinked receipt DIRECTORY refuses too — the escape is the parent, not the file', () => {
  const root = worktree();
  rmSync(join(root, '.agent'), { recursive: true, force: true });
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(root, '.agent'));

  const refused = publish(root);
  assert.equal(refused.ok, false);
  assert.match(refused.refusal.problem, /symlink|link/i);
  assert.equal(existsFile(join(elsewhere, 'debug-as.local.json')), false);
});

test('a live owner of another generation refuses publication, names who holds it, and its receipt is untouched', () => {
  const root = worktree();
  publish(root, { generation: 'b'.repeat(32), identity: 'super-admin' });
  const before = readFileSync(browserReceiptPath(root), 'utf8');

  const refused = publish(root, { generation: 'c'.repeat(32), identity: 'owner' });
  assert.equal(refused.ok, false);
  assert.match(refused.refusal.problem, /super-admin/);
  assert.match(refused.refusal.problem, /4242/);
  assert.ok(refused.refusal.fix);
  assert.equal(readFileSync(browserReceiptPath(root), 'utf8'), before);
});

test('a proven-dead owner is replaced — a SIGKILLed session must not lock the worktree out forever', () => {
  const root = worktree();
  publish(root, { generation: 'b'.repeat(32) }, { pid: 111 });

  const republished = publish(root, { generation: 'c'.repeat(32) }, { pid: 222, alive: pid => pid !== 111 });
  assert.equal(republished.ok, true);
  assert.equal(JSON.parse(readFileSync(browserReceiptPath(root), 'utf8')).generation, 'c'.repeat(32));
});

test('an AMBIGUOUS owner is never displaced: another host, and a live pid whose start identity cannot be read', () => {
  const foreign = worktree();
  publish(foreign, { generation: 'b'.repeat(32) }, { host: 'other-host' });
  const refusedForeign = publish(foreign, { generation: 'c'.repeat(32) });
  assert.equal(refusedForeign.ok, false);
  assert.match(refusedForeign.refusal.problem, /other-host/);

  const unreadable = worktree();
  publish(unreadable, { generation: 'b'.repeat(32) }, { pid: 111 });
  const refusedUnreadable = publish(unreadable, { generation: 'c'.repeat(32) }, { pid: 222, start: pid => (pid === 111 ? null : START) });
  assert.equal(refusedUnreadable.ok, false);
  assert.ok(refusedUnreadable.refusal.fix);
});

test('the same generation republishes — reuse changes the path without minting a second owner', () => {
  const root = worktree();
  const generation = 'b'.repeat(32);
  publish(root, { generation, path: '/home' });
  const again = publish(root, { generation, path: '/settings' });
  assert.equal(again.ok, true);
  assert.equal(JSON.parse(readFileSync(browserReceiptPath(root), 'utf8')).path, '/settings');
});

test('updateReceiptPath rewrites only the path of a live matching generation', () => {
  const root = worktree();
  const generation = 'b'.repeat(32);
  publish(root, { generation, path: '/home', identity: 'owner', cdpPort: 51234 });
  const before = JSON.parse(readFileSync(browserReceiptPath(root), 'utf8'));

  const updated = updateReceiptPath(root, { generation, path: '/settings' }, deps());
  assert.equal(updated.updated, true);
  assert.equal(updated.receipt.path, '/settings');

  const after = JSON.parse(readFileSync(browserReceiptPath(root), 'utf8'));
  assert.equal(after.path, '/settings');
  for (const key of Object.keys(before)) {
    if (key === 'path') continue;
    assert.deepEqual(after[key], before[key], key);
  }
});

test('updateReceiptPath refuses a non-owner generation, a dead owner, and an unsafe path', () => {
  const root = worktree();
  const generation = 'b'.repeat(32);
  publish(root, { generation, path: '/home' });

  const foreign = updateReceiptPath(root, { generation: 'c'.repeat(32), path: '/settings' }, deps());
  assert.equal(foreign.updated, false);
  assert.ok(foreign.refusal.fix);

  const dead = worktree();
  publish(dead, { generation, path: '/home' }, { pid: 111 });
  const stale = updateReceiptPath(dead, { generation, path: '/settings' }, deps({ alive: () => false }));
  assert.equal(stale.updated, false);

  const badPath = updateReceiptPath(root, { generation, path: '//evil.example.com' }, deps());
  assert.equal(badPath.updated, false);
  assert.equal(JSON.parse(readFileSync(browserReceiptPath(root), 'utf8')).path, '/home');
});


test('a receipt declaring both a device and a viewport is refused before it reaches disk', () => {
  const root = worktree();
  const refused = publish(root, { device: 'iPhone 15', viewport: { width: 1280, height: 800 } });
  assert.equal(refused.ok, false);
  assert.match(refused.refusal.problem, /device|viewport/i);
  assert.equal(existsFile(browserReceiptPath(root)), false);
});

// ── reading an owner ─────────────────────────────────────────────────────────

test('every ownership state is a distinct answer, and only two of them authorize anything', () => {
  const absent = worktree();
  assert.equal(readReceipt(absent, deps()).state, 'absent');

  const malformed = worktree();
  writeFileSync(browserReceiptPath(malformed), '{not json');
  const bad = readReceipt(malformed, deps());
  assert.equal(bad.state, 'malformed');
  assert.ok(bad.refusal.fix);

  const wrongVersion = worktree();
  writeFileSync(browserReceiptPath(wrongVersion), JSON.stringify({ version: 2, generation: 'a'.repeat(32) }));
  assert.equal(readReceipt(wrongVersion, deps()).state, 'malformed');

  const live = worktree();
  publish(live);
  assert.equal(readReceipt(live, deps()).state, 'live');

  const gone = worktree();
  publish(gone, {}, { pid: 111 });
  assert.equal(readReceipt(gone, deps({ alive: () => false })).state, 'dead');

  // The whole reason the start identity is recorded: this pid IS alive, and it
  // is not the process that published the receipt.
  const recycled = worktree();
  publish(recycled, {}, { pid: 111 });
  assert.equal(readReceipt(recycled, deps({ start: () => 'Fri Sep 12 11:00:00 2026' })).state, 'dead');

  const otherHost = worktree();
  publish(otherHost, {}, { host: 'other-host' });
  assert.equal(readReceipt(otherHost, deps()).state, 'ambiguous');

  const unreadable = worktree();
  publish(unreadable);
  assert.equal(readReceipt(unreadable, deps({ start: () => null })).state, 'ambiguous');
});

test('a receipt reached through a symlink is unsafe, never parsed as an owner', () => {
  const root = worktree();
  const planted = join(root, 'planted.json');
  writeFileSync(planted, JSON.stringify({ version: 1, generation: 'a'.repeat(32), host: HOST, pid: 4242, processStart: START }));
  symlinkSync(planted, browserReceiptPath(root));
  assert.equal(readReceipt(root, deps()).state, 'unsafe');
});

test('removal is generation-owned: an owner removes its own state, and never another owner\u2019s', () => {
  const root = worktree();
  const generation = 'b'.repeat(32);
  publish(root, { generation });

  const foreign = removeReceipt(root, { generation: 'c'.repeat(32) }, deps());
  assert.equal(foreign.removed, false);
  assert.ok(foreign.reason);
  assert.equal(existsFile(browserReceiptPath(root)), true);

  const own = removeReceipt(root, { generation }, deps());
  assert.equal(own.removed, true);
  assert.equal(existsFile(browserReceiptPath(root)), false);

  assert.equal(removeReceipt(root, { generation }, deps()).removed, false);
});

test('a proven-dead receipt is reapable by maintenance, and a live one is not, whatever maintenance asks', () => {
  const live = worktree();
  publish(live);
  assert.equal(removeReceipt(live, { generation: 'c'.repeat(32), proven: true }, deps()).removed, false);
  assert.equal(existsFile(browserReceiptPath(live)), true);

  const dead = worktree();
  publish(dead, {}, { pid: 111 });
  assert.equal(removeReceipt(dead, { generation: 'c'.repeat(32), proven: true }, deps({ alive: () => false })).removed, true);
  assert.equal(existsFile(browserReceiptPath(dead)), false);
});

// ── the CDP proof ────────────────────────────────────────────────────────────

test('the CDP probe asks the loopback endpoint only, and a failure is an answer rather than a throw', async () => {
  const asked = [];
  const alive = await probeCdp(51234, { open: url => (asked.push(url), { ok: true, status: 200 }) });
  assert.equal(alive.alive, true);
  assert.deepEqual(asked, ['http://127.0.0.1:51234/json/version']);

  const refused = await probeCdp(51234, {
    open: () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(refused.alive, false);
  assert.match(refused.why, /ECONNREFUSED|refus/i);

  const wrongStatus = await probeCdp(51234, { open: () => ({ ok: false, status: 500 }) });
  assert.equal(wrongStatus.alive, false);
});

// ── the maintenance predicate ────────────────────────────────────────────────

test('a claim exists exactly while an owner is not proven dead, and it carries the Chromium root to spare', () => {
  const live = worktree();
  publish(live, { chromiumPid: 9001 });
  const claim = liveBrowserClaim(live, deps());
  assert.equal(claim.claimed, true);
  assert.equal(claim.chromiumPid, 9001);
  assert.equal(claim.cdpPort, 51234);

  const ambiguous = worktree();
  publish(ambiguous, {}, { host: 'other-host' });
  assert.equal(liveBrowserClaim(ambiguous, deps()).claimed, true, 'an owner we cannot disprove is spared, never swept');

  const dead = worktree();
  publish(dead, {}, { pid: 111 });
  assert.equal(liveBrowserClaim(dead, deps({ alive: () => false })).claimed, false);

  assert.equal(liveBrowserClaim(worktree(), deps()).claimed, false);
});

test('the Chromium root is identified by the CDP port it was launched with, in either argv spelling', () => {
  const rows = [
    { pid: 500, ppid: 1, args: '/Applications/Chromium.app/Contents/MacOS/Chromium --remote-debugging-port=51234 --no-first-run' },
    { pid: 501, ppid: 500, args: 'Chromium --type=renderer --remote-debugging-port=51234' },
    { pid: 600, ppid: 1, args: 'Chromium --remote-debugging-port=40000' },
    { pid: 700, ppid: 1, args: 'Chromium --remote-debugging-port 48000 --no-first-run' },
  ];
  assert.equal(chromiumPidFor({ cdpPort: 51234, ps: () => rows }), 500, 'the root, never one of its renderers');
  assert.equal(chromiumPidFor({ cdpPort: 48000, ps: () => rows }), 700, 'split `--remote-debugging-port <n>` is the same flag');
  assert.equal(chromiumPidFor({ cdpPort: 44444, ps: () => rows }), null);
  // A port number that merely appears inside another flag is not a match.
  assert.equal(chromiumPidFor({ cdpPort: 1234, ps: () => rows }), null);
});

test('a missing Chromium pid is a publication refusal, never a degraded success', () => {
  const root = worktree();
  for (const chromiumPid of [null, undefined, '9001', 0, -1, 1.5]) {
    const refused = publish(root, { chromiumPid });
    assert.equal(refused.ok, false, `${JSON.stringify(chromiumPid)} must not publish`);
  }
  assert.equal(existsFile(browserReceiptPath(root)), false);
});

test('chromiumRoot waits for the CDP-port process, carries its REAL command line, and refuses when it never appears', async () => {
  // The launcher proves R13's forbidden flags against `args`, so this is the
  // argv of the process that actually started — not the argv AX intended. A
  // flag a future Playwright adds to its own defaults is visible ONLY here.
  const found = await chromiumRoot({
    cdpPort: 51234,
    deadlineMs: 50,
    now: (() => {
      let t = 0;
      return () => (t += 20);
    })(),
    sleep: () => {},
    ps: () => [{ pid: 500, ppid: 1, args: 'Chromium --remote-debugging-port=51234 --disable-web-security' }],
    start: () => START,
  });
  assert.equal(found.pid, 500);
  assert.equal(found.start, START);
  assert.deepEqual(found.args, ['Chromium', '--remote-debugging-port=51234', '--disable-web-security'], 'the forbidden flag reaches the launcher as its own token, never buried in one string');

  const missed = await chromiumRoot({
    cdpPort: 51234,
    deadlineMs: 30,
    now: (() => {
      let t = 0;
      return () => (t += 20);
    })(),
    sleep: () => {},
    ps: () => [],
    start: () => START,
  });
  assert.equal(missed, null);
});

test('a candidate root is claimed only when its pid and start identity match the receipt, never by the CDP port alone', () => {
  const root = worktree();
  publish(root, { chromiumPid: 9001, cdpPort: 51234 });

  const owned = claimForProcess({ pid: 9001, args: 'Chromium --remote-debugging-port=51234', cwd: join(root, 'apps', 'web') }, deps());
  assert.equal(owned.claimed, true);
  assert.equal(owned.root, root);

  // Same port, different process: an unrelated Chromium handed that number after a restart.
  const foreign = claimForProcess({ pid: 7777, args: 'Chromium --remote-debugging-port=51234', cwd: join(root, 'apps', 'web') }, deps());
  assert.equal(foreign.claimed, false);

  // Same pid, recycled: the start identity no longer matches.
  const recycled = claimForProcess({ pid: 9001, args: 'Chromium --remote-debugging-port=51234', cwd: root }, deps({ start: pid => (pid === 9001 ? 'Sat Sep 13 00:00:00 2026' : START) }));
  assert.equal(recycled.claimed, false);

  // A Chromium whose cwd is outside any worktree cannot invent a claim.
  const elsewhere = claimForProcess({ pid: 9001, args: 'Chromium --remote-debugging-port=51234', cwd: '/tmp/playwright-cache' }, deps());
  assert.equal(elsewhere.claimed, false);
});

test('maintenance reaps proven-dead debug state and leaves a live owner every file it holds', () => {
  const dead = worktree();
  publish(dead, {}, { pid: 111 });
  writeFileSync(worktreeLockPath(dead), JSON.stringify({ host: HOST, pid: 111, processStart: START }));
  const reaped = sweepDeadBrowserState(dead, deps({ alive: () => false }));
  assert.equal(reaped.removed.length > 0, true);
  assert.equal(existsFile(browserReceiptPath(dead)), false);
  assert.equal(existsFile(worktreeLockPath(dead)), false);

  const live = worktree();
  publish(live);
  writeFileSync(worktreeLockPath(live), JSON.stringify({ host: HOST, pid: 4242, processStart: START }));
  const spared = sweepDeadBrowserState(live, deps());
  assert.deepEqual(spared.removed, []);
  assert.ok(spared.spared);
  assert.equal(existsFile(browserReceiptPath(live)), true);
  assert.equal(existsFile(worktreeLockPath(live)), true);
});

// ── the lock ─────────────────────────────────────────────────────────────────

test('two concurrent launches yield one owner: the second is held, told who holds it, and publishes nothing', () => {
  const root = worktree();
  const path = worktreeLockPath(root);
  const first = acquireLock(path, deps({ generation: 'b'.repeat(32) }));
  assert.equal(first.ok, true);

  const second = acquireLock(path, deps({ pid: 5555 }));
  assert.equal(second.ok, false);
  assert.equal(second.state, 'held');
  assert.equal(second.owner.pid, 4242);
  assert.ok(second.refusal.fix);

  first.release();
  const third = acquireLock(path, deps({ pid: 5555 }));
  assert.equal(third.ok, true);
  third.release();
});

test('waiting out a live holder is BOUNDED: the wait expires and names the holder, instead of blocking forever', () => {
  // A `waitMs` that re-arms on every observation of a live holder is not a
  // wait, it is a hang: the caller asked to be told who holds the lock after
  // that many milliseconds, and a holder that stays alive would push the
  // deadline out for as long as it lives. This is the exact shape of the
  // launch this feature serializes — an operator clicking through a Role
  // browser holds the lock for as long as the window is open.
  const root = worktree();
  const path = worktreeLockPath(root);
  const first = acquireLock(path, deps());
  assert.equal(first.ok, true);

  const naps = [];
  let ticks = 0;
  const second = acquireLock(path, {
    ...deps({ pid: 5555 }),
    waitMs: 500,
    pollMs: 50,
    sleep: ms => naps.push(ms),
    // The holder stays alive throughout; time only ever moves forward.
    clock: () => (ticks += 100),
  });

  assert.equal(second.ok, false, 'the wait returned rather than spinning until the test timed out');
  assert.equal(second.state, 'held');
  assert.equal(second.owner.pid, 4242);
  assert.ok(naps.length < 20, `the wait polled ${naps.length} times, which is not a bounded wait`);
  first.release();
});

test('WORKTREE_LOCK sits beside the receipt, and release is idempotent', () => {
  const root = worktree();
  assert.equal(worktreeLockPath(root), join(root, WORKTREE_LOCK));
  const held = acquireLock(worktreeLockPath(root), deps());
  held.release();
  held.release();
  assert.equal(existsFile(worktreeLockPath(root)), false);
});

test('a lock whose owner is proven dead is broken, and one that is merely unverifiable is not', () => {
  const dead = worktree();
  acquireLock(worktreeLockPath(dead), deps({ pid: 111 }));
  const broken = acquireLock(worktreeLockPath(dead), deps({ pid: 222, alive: pid => pid !== 111 }));
  assert.equal(broken.ok, true);

  const recycled = worktree();
  acquireLock(worktreeLockPath(recycled), deps({ pid: 111 }));
  const reclaimed = acquireLock(worktreeLockPath(recycled), deps({ pid: 222, start: pid => (pid === 111 ? 'Fri Sep 12 12:00:00 2026' : START) }));
  assert.equal(reclaimed.ok, true, 'a recycled pid is not the owner, so the lock is stale');

  const foreign = worktree();
  acquireLock(worktreeLockPath(foreign), deps({ host: 'other-host' }));
  const refused = acquireLock(worktreeLockPath(foreign), deps());
  assert.equal(refused.ok, false);
  assert.equal(refused.state, 'ambiguous');
  assert.ok(refused.refusal.fix);
});

test('a lock nobody can parse is ambiguous with a repair, never silently stolen and never a deadlock without a way out', () => {
  const root = worktree();
  writeFileSync(worktreeLockPath(root), 'half-written');
  const refused = acquireLock(worktreeLockPath(root), deps());
  assert.equal(refused.ok, false);
  assert.equal(refused.state, 'ambiguous');
  assert.match(refused.refusal.fix, /debug-as\.lock/);
});

test('withLock serializes a whole transition and releases even when it throws', async () => {
  const root = worktree();
  const path = worktreeLockPath(root);
  await assert.rejects(
    withLock(path, async () => {
      assert.equal(existsFile(path), true);
      throw new Error('launch failed');
    }, deps()),
    /launch failed/,
  );
  assert.equal(existsFile(path), false);

  const value = await withLock(path, async () => 'published', deps());
  assert.equal(value, 'published');
  assert.equal(existsFile(path), false);
});

test('the process start identity is a STABLE token, never an elapsed time that changes every second', () => {
  const asked = [];
  const token = processStart(4242, {
    ps: args => {
      asked.push(args);
      return 'Fri Sep 12 09:00:00 2026\n';
    },
  });
  assert.equal(token, 'Fri Sep 12 09:00:00 2026');
  assert.ok(
    asked.flat().some(argument => String(argument).includes('lstart')),
    'the start identity is read from lstart; etime/etimes advance every second and would make every receipt look recycled',
  );
  assert.equal(processStart(4242, { ps: () => '' }), null);
});

/** `existsSync` without importing it under a name the fixtures also use. */
function existsFile(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
