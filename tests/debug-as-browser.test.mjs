// One visible Chromium per worktree, and every way that ownership can go wrong.
//
// Driven through injected fakes rather than a real browser, deliberately: the
// facts under test are ORDER and OWNERSHIP — a GUI refusal that must land
// before an adapter is allowed to mint an authentication artifact, a deadline
// that must leave no receipt, a rival launch that must not replace a live
// operator's window. A real Chromium proves none of those; it proves that
// Playwright works, which is the throwaway smoke run the plan asks for
// separately (U3 verification), not a unit test.
//
// The fakes are the real shapes: `chromium.launch`/`connectOverCDP`,
// `browser.newContext`/`contexts`/`close`/`on('disconnected')`, `page.goto`.
// What is asserted about them is what AX hands over — the exact argv, the
// launch options that decide the security posture, the parsed storage state,
// the navigation deadline — never Playwright's own behavior.
//
// Three assertions here encode facts MEASURED against Playwright 1.62.1 on
// 2026-09-13, not read off a doc page (the module header records the run):
// Playwright's own default argv carries `--no-sandbox`, its `launch` accepts
// no `cwd`, and its signal handlers would kill Chromium outside this module's
// teardown. So the launch OPTIONS are part of the contract, and the working
// directory is moved on AX's own process around the launch and restored.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CDP_HOST,
  FORBIDDEN_ARGUMENTS,
  guiRefusal,
  launchArguments,
  openRoleBrowser,
  preflightBrowser,
  resolvePlaywright,
  reuseRefusal,
  sessionNameFor,
  superviseRoleBrowser,
  surfaceFor,
} from '../src/debug-as/browser.mjs';

/** Two entries of a real Playwright catalog, copied from `devices` at 1.62.1. */
const DEVICES = {
  'iPhone 15': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
    viewport: { width: 393, height: 659 },
    screen: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: 'webkit',
  },
  'Desktop Chrome': {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: 'chromium',
  },
};

const ORIGIN = 'http://127.0.0.1:3210';
const ROOT = '/tmp/ax-worktree/ofmchat-debug';
const ELSEWHERE = '/tmp/ax-worktree/ofmchat-debug/apps/web';
const START = ['pnpm', '--filter', 'web', 'dev'];
const STATE = { cookies: [{ name: 'sb', domain: '127.0.0.1' }], origins: [] };

/**
 * A Playwright double that records exactly what AX handed it.
 *
 * `trace` is a shared array both this and the state double append to, because
 * two of the requirements here are about ORDER between the two — a receipt
 * whose path is written only once the browser is actually on it.
 */
function playwrightFake(faults = {}) {
  const trace = faults.trace ?? [];
  const calls = { launch: [], context: [], pages: 0, goto: [], closed: 0, detached: 0, connect: [], trace };
  let disconnected = null;
  let detachedFrom = null;

  const page = {
    async goto(url, options) {
      calls.goto.push({ url, options });
      trace.push('goto');
      if (faults.goto) throw faults.goto;
      return { status: () => 200 };
    },
  };
  const context = {
    async newPage() {
      calls.pages += 1;
      return page;
    },
    pages: () => [page],
    async close() {},
  };
  const browser = {
    async newContext(options) {
      calls.context.push(options);
      if (faults.newContext) throw faults.newContext;
      return context;
    },
    contexts: () => [context],
    async close() {
      calls.closed += 1;
      trace.push('close');
      if (faults.close) throw faults.close;
      disconnected?.();
    },
    on(event, handler) {
      if (event === 'disconnected') disconnected = handler;
    },
  };
  const connected = {
    contexts: () => [context],
    async close() {
      calls.detached += 1;
      trace.push('detach');
      detachedFrom?.();
    },
    on(event, handler) {
      if (event === 'disconnected') detachedFrom = handler;
    },
  };
  const chromium = {
    async launch(options) {
      calls.launch.push(options);
      trace.push('launch');
      if (faults.launch) throw faults.launch;
      return browser;
    },
    async connectOverCDP(endpoint) {
      calls.connect.push(endpoint);
      trace.push('connect');
      if (faults.connect) throw faults.connect;
      return connected;
    },
  };

  return {
    playwright: { chromium, devices: DEVICES, version: '1.62.1', from: '@playwright/test' },
    calls,
    page,
    disconnect: () => disconnected?.(),
    remoteClosed: () => detachedFrom?.(),
  };
}

/** A live receipt of the session a compatible request would reuse. */
const liveReceipt = (overrides = {}) => ({
  version: 1,
  generation: 'aaaabbbbccccdddd',
  host: 'mac',
  pid: 4100,
  processStart: 'Fri Sep 12 10:00:00 2026',
  chromiumPid: 4242,
  chromiumStart: 'Fri Sep 12 10:00:01 2026',
  project: 'ofmchat',
  worktree: ROOT,
  identity: 'owner',
  origin: ORIGIN,
  path: '/home',
  device: null,
  viewport: { width: 1280, height: 800 },
  cdpPort: 51_234,
  sessionName: 'ax-debug-ofmchat-debug-owner',
  publishedAt: '2026-09-12T10:00:02.000Z',
  ...overrides,
});

/** The state layer (`receipt.mjs`, `lock.mjs`) and the emission boundary. */
function stateFake(options = {}) {
  const store = { receipt: options.receipt ?? null, state: options.state ?? 'absent' };
  const trace = options.trace ?? [];
  const calls = { published: [], removed: [], repathed: [], probes: [], roots: [], locks: [], progress: [], chdir: [], trace };
  let held = Promise.resolve();

  return {
    store,
    calls,
    deps: {
      newGeneration: () => options.generation ?? 'ffff0000ffff0000',
      worktreeLockPath: root => `${root}/.agent/debug-as.lock`,
      async withLock(path, run) {
        calls.locks.push(path);
        const mine = held.then(() => run());
        held = mine.then(
          () => {},
          () => {},
        );
        return mine;
      },
      readReceipt: () => ({ state: store.state, receipt: store.receipt, refusal: null }),
      publishReceipt: ({ root, fields }) => {
        calls.published.push({ root, fields });
        trace.push('publish');
        if (options.publishRefusal) return { ok: false, refusal: options.publishRefusal };
        const receipt = { version: 1, host: 'mac', pid: 4100, processStart: 'now', chromiumStart: 'now', publishedAt: '2026-09-13T00:00:00.000Z', ...fields };
        store.receipt = receipt;
        store.state = 'live';
        return { ok: true, receipt, path: `${root}/.agent/debug-as.local.json` };
      },
      removeReceipt: (root, removal) => {
        calls.removed.push(removal);
        store.receipt = null;
        store.state = 'absent';
        return { removed: true, reason: 'receipt of this generation removed' };
      },
      updateReceiptPath: (root, update) => {
        calls.repathed.push(update);
        trace.push('repath');
        if (options.repathRefusal) return { updated: false, receipt: null, refusal: options.repathRefusal };
        store.receipt = { ...store.receipt, path: update.path };
        return { updated: true, receipt: store.receipt, refusal: null };
      },
      probeCdp: async port => {
        calls.probes.push(port);
        return options.cdp ?? { alive: true, why: '' };
      },
      chromiumRoot: async query => {
        calls.roots.push(query);
        return options.chromiumRoot === undefined ? { pid: 4242, start: 'Sun Sep 13 00:00:00 2026' } : options.chromiumRoot;
      },
      freePort: async () => options.port ?? 51_234,
      progress: message => calls.progress.push(message),
      chdir: directory => calls.chdir.push(directory),
      cwd: () => options.cwd ?? ELSEWHERE,
    },
  };
}

const request = (overrides = {}) => ({
  root: ROOT,
  project: 'ofmchat',
  worktree: ROOT,
  identity: 'owner',
  origin: ORIGIN,
  path: '/home',
  start: START,
  navigationTimeoutSeconds: 120,
  storageState: STATE,
  surface: surfaceFor({ devices: DEVICES, viewport: { width: 1280, height: 800 } }),
  ...overrides,
});

const rejects = async (run, fragment) => {
  const error = await run().then(
    () => null,
    caught => caught,
  );
  assert.ok(error, 'expected a refusal');
  assert.match(error.message, fragment);
  assert.ok(typeof error.fix === 'string' && error.fix !== '', `a refusal must name its repair: ${error.message}`);
  return error;
};

/** Has this promise NOT settled? The foreground requirements are about waiting. */
const pending = async promise => {
  const marker = Symbol('pending');
  const raced = await Promise.race([promise.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve(marker), 25))]);
  return raced === marker;
};

/**
 * Wait until the supervisor has installed its signal handlers.
 *
 * Raising a signal the moment after the call would race its own registration —
 * the supervisor resolves its dependencies first — and a test that signals
 * nobody would pass for the wrong reason.
 */
const armed = async handlers => {
  for (let attempt = 0; attempt < 100 && !handlers.has('SIGINT'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(handlers.has('SIGINT'), 'the supervisor never armed its signal handlers');
};

test('a machine with no display refuses, and refuses before Playwright is even resolved', () => {
  const headless = guiRefusal({ platform: 'linux', env: {} });
  assert.ok(headless, 'a Linux session with no display cannot show a window');
  assert.match(headless.problem, /display/i);
  assert.match(headless.fix, /DISPLAY|desktop/i);

  assert.equal(guiRefusal({ platform: 'linux', env: { DISPLAY: ':0' } }), null);
  assert.equal(guiRefusal({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1' } }), null);
  assert.equal(guiRefusal({ platform: 'darwin', env: {} }), null);

  // The ORDER is the requirement: preflight runs before the caller prepares
  // authentication, so a headless machine never causes an adapter to mint a
  // fresh artifact for a browser that can never open.
  let resolved = 0;
  assert.throws(
    () =>
      preflightBrowser(
        { root: ROOT, playwrightDir: 'apps/e2e', device: 'iPhone 15' },
        {
          platform: 'linux',
          env: {},
          resolve: () => {
            resolved += 1;
            return { chromium: {}, devices: DEVICES };
          },
        },
      ),
    error => error.fix !== undefined,
  );
  assert.equal(resolved, 0, 'Playwright must not be resolved once the GUI refusal is known');

  const ready = preflightBrowser(
    { root: ROOT, playwrightDir: 'apps/e2e', device: 'iPhone 15' },
    { platform: 'darwin', env: {}, resolve: () => ({ chromium: {}, devices: DEVICES, version: '1.62.1', from: '@playwright/test' }) },
  );
  assert.equal(ready.surface.device, 'iPhone 15');
  assert.equal(ready.playwright.version, '1.62.1');
});

test('Playwright comes from the declared project package, and its absence names the repair', () => {
  const seen = [];
  const fromTest = resolvePlaywright({
    root: ROOT,
    playwrightDir: 'apps/e2e',
    require: specifier => {
      seen.push(specifier);
      if (specifier === '@playwright/test') return { chromium: { launch() {} }, devices: DEVICES };
      if (specifier === '@playwright/test/package.json') return { version: '1.62.1' };
      throw new Error('not reached');
    },
  });
  assert.equal(fromTest.from, '@playwright/test');
  assert.equal(fromTest.version, '1.62.1');
  assert.equal(fromTest.devices, DEVICES);
  assert.equal(seen[0], '@playwright/test', 'the test package is tried first');

  const fallback = resolvePlaywright({
    root: ROOT,
    playwrightDir: 'apps/e2e',
    require: specifier => {
      if (specifier.startsWith('@playwright/test')) throw new Error('MODULE_NOT_FOUND');
      if (specifier === 'playwright') return { chromium: { launch() {} }, devices: DEVICES };
      if (specifier === 'playwright/package.json') return { version: '1.61.0' };
      throw new Error('not reached');
    },
  });
  assert.equal(fallback.from, 'playwright');
  assert.equal(fallback.version, '1.61.0');

  assert.throws(
    () =>
      resolvePlaywright({
        root: ROOT,
        playwrightDir: 'apps/e2e',
        require: () => {
          throw new Error('MODULE_NOT_FOUND');
        },
      }),
    error => {
      assert.match(error.message, /apps\/e2e/);
      assert.match(error.fix, /apps\/e2e/);
      return true;
    },
  );
});

test('a device descriptor comes from the project catalog, and an unknown one names its neighbours', () => {
  const phone = surfaceFor({ devices: DEVICES, device: 'iPhone 15' });
  assert.equal(phone.device, 'iPhone 15');
  assert.equal(phone.viewport, null);
  assert.deepEqual(phone.contextOptions, DEVICES['iPhone 15']);
  assert.deepEqual(phone.windowSize, { width: 393, height: 659 });

  const desktop = surfaceFor({ devices: DEVICES, viewport: { width: 1280, height: 800 } });
  assert.equal(desktop.device, null);
  assert.deepEqual(desktop.viewport, { width: 1280, height: 800 });
  assert.deepEqual(desktop.contextOptions, { viewport: { width: 1280, height: 800 } });
  assert.deepEqual(desktop.windowSize, { width: 1280, height: 800 });

  const bare = surfaceFor({ devices: DEVICES });
  assert.equal(bare.device, null);
  assert.equal(bare.viewport, null);
  assert.equal(bare.windowSize, null);

  assert.throws(
    () => surfaceFor({ devices: DEVICES, device: 'iPhone 15', viewport: { width: 800, height: 600 } }),
    error => {
      assert.match(error.message, /--device/);
      assert.match(error.message, /--viewport/);
      return error.fix !== undefined;
    },
  );

  assert.throws(
    () => surfaceFor({ devices: DEVICES, device: 'iphone 15' }),
    error => {
      assert.match(error.fix, /iPhone 15/, 'a near miss names the catalog entry it nearly matched');
      return true;
    },
  );

  for (const viewport of [{ width: 199, height: 800 }, { width: 800, height: 10_001 }, { width: 1280.5, height: 800 }, { width: 0, height: 0 }]) {
    assert.throws(
      () => surfaceFor({ devices: DEVICES, viewport }),
      error => {
        assert.match(error.message, /200|10000|whole/);
        return error.fix !== undefined;
      },
      `viewport ${JSON.stringify(viewport)} is outside the declared bounds`,
    );
  }
});

test('Chromium receives the CDP port and window size, and nothing else', () => {
  const sized = launchArguments({ cdpPort: 51_234, windowSize: { width: 1280, height: 800 } });
  assert.deepEqual(sized, ['--remote-debugging-port=51234', '--window-size=1280,800']);

  const unsized = launchArguments({ cdpPort: 51_234, windowSize: null });
  assert.deepEqual(unsized, ['--remote-debugging-port=51234']);

  assert.equal(CDP_HOST, '127.0.0.1');
  for (const forbidden of FORBIDDEN_ARGUMENTS) {
    for (const argument of [...sized, ...unsized]) {
      assert.ok(!argument.startsWith(forbidden), `${argument} carries the forbidden ${forbidden}`);
    }
  }
  // The listed set is exactly R13's vocabulary — remote-allow-origin,
  // debugging-address, disabled-security, disabled-isolation — spelled out so
  // a later convenience flag cannot be added without deleting a line of this
  // test. It is also the `ignoreDefaultArgs` list, which is what makes it a
  // contract over Playwright's OWN defaults and not only over AX's argv.
  for (const forbidden of ['--remote-allow-origins', '--remote-debugging-address', '--disable-web-security', '--disable-site-isolation-trials', '--allow-running-insecure-content']) {
    assert.ok(FORBIDDEN_ARGUMENTS.includes(forbidden), `${forbidden} must stay refused`);
  }
  // And NOT on it: Playwright's own machinery. `--remote-debugging-pipe` is
  // its control transport and `--user-data-dir` its non-persistent profile —
  // dropping either breaks every launch. `--no-sandbox` is a Playwright launch
  // default too (measured, 1.62.1), but the sandbox is restored through the
  // documented `chromiumSandbox: true` option rather than by deleting a flag
  // Playwright believes it passed.
  for (const required of ['--remote-debugging-pipe', '--user-data-dir', '--no-sandbox']) {
    assert.ok(!FORBIDDEN_ARGUMENTS.includes(required), `${required} is Playwright's own, not one of R13's flags`);
  }
});

test('the session name is derived from the worktree and identity, usable as an argv slot', () => {
  assert.equal(sessionNameFor({ worktree: '/Users/flo/orca/workspaces/Debug_AS', identity: 'owner' }), 'ax-debug-debug-as-owner');
  assert.match(sessionNameFor({ worktree: '/tmp/a b/c!', identity: 'super-admin' }), /^[a-z0-9-]+$/);
});

test('reuse accepts a new path and nothing else', () => {
  const receipt = liveReceipt();
  assert.equal(reuseRefusal({ receipt, request: { identity: 'owner', origin: ORIGIN, path: '/settings', device: null, viewport: { width: 1280, height: 800 } } }), null);

  for (const [label, incompatible] of [
    ['identity', { identity: 'pro', origin: ORIGIN, device: null, viewport: { width: 1280, height: 800 } }],
    ['origin', { identity: 'owner', origin: 'http://127.0.0.1:3999', device: null, viewport: { width: 1280, height: 800 } }],
    ['viewport', { identity: 'owner', origin: ORIGIN, device: null, viewport: { width: 800, height: 600 } }],
    ['device', { identity: 'owner', origin: ORIGIN, device: 'iPhone 15', viewport: null }],
  ]) {
    const refusal = reuseRefusal({ receipt, request: incompatible });
    assert.ok(refusal, `${label} must refuse`);
    assert.match(refusal.problem, /owner/, 'the refusal identifies the live owner');
    assert.match(refusal.problem, new RegExp(String(receipt.pid)), 'and the process that owns it');
    assert.ok(refusal.fix.length > 0, 'and names what the operator does about it');
  }
});

test('a launch publishes only after navigation, a CDP proof and a proven Chromium root', async () => {
  const pw = playwrightFake();
  const state = stateFake();
  const session = await openRoleBrowser(request({ playwright: pw.playwright }), state.deps);

  assert.equal(session.mode, 'launched');
  assert.equal(session.cdpPort, 51_234);
  assert.equal(session.generation, 'ffff0000ffff0000');

  assert.equal(pw.calls.launch.length, 1);
  const [launch] = pw.calls.launch;
  assert.equal(launch.headless, false);
  assert.deepEqual(launch.args, ['--remote-debugging-port=51234', '--window-size=1280,800']);
  // Measured against 1.62.1: without these options Playwright's own defaults
  // hand Chromium `--no-sandbox`, and its signal handlers would kill the
  // browser out from under this module's bounded, receipt-removing teardown.
  assert.equal(launch.chromiumSandbox, true);
  assert.deepEqual(launch.ignoreDefaultArgs, FORBIDDEN_ARGUMENTS);
  assert.equal(launch.handleSIGINT, false);
  assert.equal(launch.handleSIGTERM, false);
  assert.equal(launch.handleSIGHUP, false);

  // `launch` accepts no `cwd` (measured: the Chromium root inherited the Node
  // process's directory and ignored the option), and maintenance discovers a
  // claim by walking up from that directory to the worktree's receipt. So the
  // directory is moved on AX's own process for the launch and restored
  // immediately — an operator may well have invoked this from a subdirectory.
  assert.deepEqual(state.calls.chdir, [ROOT, ELSEWHERE]);

  const [context] = pw.calls.context;
  assert.equal(context.baseURL, ORIGIN);
  assert.deepEqual(context.storageState, STATE, 'Chromium receives the parsed value, never a path it could re-resolve');
  assert.deepEqual(context.viewport, { width: 1280, height: 800 });

  assert.deepEqual(pw.calls.goto, [{ url: `${ORIGIN}/home`, options: { waitUntil: 'domcontentloaded', timeout: 120_000 } }]);
  assert.deepEqual(state.calls.probes, [51_234], 'the CDP proof is its own request, not Playwright reporting on itself');
  assert.equal(state.calls.roots.length, 1);
  assert.equal(state.calls.roots[0].cdpPort, 51_234);

  const [published] = state.calls.published;
  assert.equal(published.root, ROOT);
  assert.equal(published.fields.cdpPort, 51_234);
  assert.equal(published.fields.identity, 'owner');
  assert.equal(published.fields.origin, ORIGIN);
  assert.equal(published.fields.path, '/home');
  assert.equal(published.fields.device, null);
  assert.deepEqual(published.fields.viewport, { width: 1280, height: 800 });
  assert.equal(published.fields.chromiumPid, 4242);
  assert.equal(published.fields.generation, 'ffff0000ffff0000');
  assert.equal(published.fields.sessionName, sessionNameFor({ worktree: ROOT, identity: 'owner' }));

  assert.deepEqual(state.calls.locks, [`${ROOT}/.agent/debug-as.lock`], 'the whole observe-then-publish transition is serialized');
  assert.equal(pw.calls.closed, 0, 'a published session stays open');
  assert.ok(state.calls.progress.length >= 3, 'each step reports, so a legitimate wait is not read as a hang');
});

test('the caller prepares authentication inside the lock, after the conflict decision and before the launch', async () => {
  const pw = playwrightFake();
  const state = stateFake();
  const order = [];
  const fresh = { cookies: [{ name: 'sb', domain: '127.0.0.1', value: 'fresh' }], origins: [] };

  const session = await openRoleBrowser(request({ playwright: pw.playwright, storageState: null }), {
    ...state.deps,
    withLock: async (path, run) => {
      order.push('lock');
      const result = await run();
      order.push('unlock');
      return result;
    },
    readReceipt: () => {
      order.push('read');
      return { state: 'absent', receipt: null, refusal: null };
    },
    beforeLaunch: async ({ generation }) => {
      order.push(`prepare:${generation}`);
      return { storageState: fresh };
    },
  });

  assert.deepEqual(order.slice(0, 3), ['lock', 'read', 'prepare:ffff0000ffff0000']);
  assert.equal(order.at(-1), 'unlock');
  assert.deepEqual(pw.calls.context[0].storageState, fresh, 'the hook wins over any state the caller passed up front');
  assert.equal(session.mode, 'launched');
});

test('an existing live owner is decided before the caller prepares anything', async () => {
  const pw = playwrightFake();
  const state = stateFake({ state: 'live', receipt: liveReceipt() });
  let prepared = 0;

  await rejects(
    () =>
      openRoleBrowser(request({ playwright: pw.playwright, identity: 'pro' }), {
        ...state.deps,
        beforeLaunch: async () => {
          prepared += 1;
          return {};
        },
      }),
    /owner/,
  );
  assert.equal(prepared, 0, 'a conflict must not mint credentials or publish a phone handoff for a browser that will not open');
});

test('a hook that prepared machine state is torn down when the launch then fails', async () => {
  const pw = playwrightFake({ launch: new Error('Executable doesn\u2019t exist at /ms-playwright/chromium') });
  const state = stateFake();
  const closed = [];

  await rejects(
    () =>
      openRoleBrowser(request({ playwright: pw.playwright }), {
        ...state.deps,
        beforeLaunch: async () => ({ storageState: STATE }),
        onClosed: async () => closed.push('withdrawn'),
      }),
    /Executable/,
  );
  assert.deepEqual(closed, ['withdrawn'], 'an explicit phone publication cannot outlive the browser it was published for');
  assert.deepEqual(state.calls.published, []);
  assert.deepEqual(state.calls.chdir, [ROOT, ELSEWHERE], 'and the failed launch still leaves the process where it was found');
});

test('an automatic hook runs against the published receipt, and its failure never closes the browser', async () => {
  const pw = playwrightFake();
  const state = stateFake();
  const seen = [];
  const session = await openRoleBrowser(request({ playwright: pw.playwright }), {
    ...state.deps,
    onPublished: async receipt => {
      seen.push(receipt.cdpPort);
      throw new Error('relay publication failed');
    },
  });
  assert.deepEqual(seen, [51_234]);
  assert.equal(session.mode, 'launched');
  assert.equal(pw.calls.closed, 0, 'a phone failure leaves a usable Role browser');
  assert.equal(state.store.state, 'live');
  assert.ok(
    state.calls.progress.some(line => /relay publication failed/.test(line)),
    'and reports the failure as a finding',
  );
});

test('a navigation deadline closes Chromium, leaves no receipt and names the start repair', async () => {
  const pw = playwrightFake({ goto: Object.assign(new Error('Timeout 120000ms exceeded.'), { name: 'TimeoutError' }) });
  const state = stateFake();

  const error = await rejects(() => openRoleBrowser(request({ playwright: pw.playwright }), state.deps), /120/);
  assert.match(error.fix, /pnpm --filter web dev/, 'the repair is the declared start command, printed and never run');
  assert.equal(pw.calls.closed, 1, 'the window AX opened is the window AX closes');
  assert.deepEqual(state.calls.published, []);
  assert.equal(state.store.receipt, null);
});

test('a launch that never produces a browser publishes nothing', async () => {
  const pw = playwrightFake({ launch: new Error('Executable doesn\u2019t exist at /ms-playwright/chromium') });
  const state = stateFake();

  const error = await rejects(() => openRoleBrowser(request({ playwright: pw.playwright }), state.deps), /Executable/);
  assert.match(error.fix, /playwright install chromium/);
  assert.equal(pw.calls.closed, 0, 'there is nothing to close');
  assert.deepEqual(state.calls.published, []);
});

test('a dead CDP endpoint is a refusal, not a receipt', async () => {
  const pw = playwrightFake();
  const state = stateFake({ cdp: { alive: false, why: 'connection refused' } });

  await rejects(() => openRoleBrowser(request({ playwright: pw.playwright }), state.deps), /connection refused|CDP/);
  assert.equal(pw.calls.closed, 1);
  assert.deepEqual(state.calls.published, []);
});

test('a Chromium root that cannot be identified refuses instead of publishing an unprotectable session', async () => {
  const pw = playwrightFake();
  const state = stateFake({ chromiumRoot: null });

  const error = await rejects(() => openRoleBrowser(request({ playwright: pw.playwright }), state.deps), /Chromium/);
  assert.ok(error.fix.length > 0);
  assert.equal(pw.calls.closed, 1, 'a session maintenance could not learn to spare is not left running');
  assert.deepEqual(state.calls.published, []);
});

// The argv check is against the argv of the process that ACTUALLY started, so
// it is driven here through `chromiumRoot` — the only place a real command line
// enters this module. `ignoreDefaultArgs` cannot express these two shapes: a
// forbidden value hidden inside a `--disable-features=` list whose other
// entries are ordinary hygiene, and a `--disable-site-isolation-*` variant this
// Playwright never declared as a default.
test('a started Chromium whose real command line disables isolation refuses, closes the window and publishes nothing', async () => {
  for (const unsafe of [
    '--disable-web-security',
    '--remote-debugging-address=0.0.0.0',
    '--allow-running-insecure-content',
    '--disable-features=Translate,IsolateOrigins,BackForwardCache',
    '--disable-features=SitePerProcess',
    '--disable-site-isolation-for-policy',
  ]) {
    const pw = playwrightFake();
    const state = stateFake({
      chromiumRoot: { pid: 4242, start: 'Sun Sep 13 00:00:00 2026', args: ['--remote-debugging-port=51234', unsafe, '--window-size=1280,800'] },
    });

    const error = await rejects(() => openRoleBrowser(request({ playwright: pw.playwright }), state.deps), new RegExp(unsafe.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(error.fix, /Playwright/, 'the repair names the version to pin, not a flag the operator could delete');
    assert.equal(pw.calls.closed, 1, `${unsafe}: the window opened under it is closed`);
    assert.deepEqual(state.calls.published, [], `${unsafe}: no receipt describes an unsafe session`);
  }
});

test('a Chromium carrying only Playwright’s own transport and profile defaults is accepted', async () => {
  const pw = playwrightFake();
  const state = stateFake({
    chromiumRoot: {
      pid: 4242,
      start: 'Sun Sep 13 00:00:00 2026',
      // Measured on 1.62.1: the control transport, the non-persistent profile
      // and a feature list that disables nothing R13 names. Refusing any of
      // these would refuse every launch.
      args: ['--remote-debugging-pipe', '--user-data-dir=/tmp/playwright_chromiumdev_profile', '--no-sandbox', '--disable-features=Translate,BackForwardCache,AcceptCHFrame', '--remote-debugging-port=51234', '--window-size=1280,800'],
    },
  });

  const session = await openRoleBrowser(request({ playwright: pw.playwright }), state.deps);
  assert.equal(session.mode, 'launched');
  assert.equal(state.calls.published.length, 1);
  assert.equal(pw.calls.closed, 0);
});

test('a receipt the state layer refuses to publish closes the browser it would have described', async () => {
  const pw = playwrightFake();
  const state = stateFake({
    publishRefusal: { at: '.agent/debug-as.local.json', problem: 'is tracked by Git, so publishing it would commit a session receipt', fix: 'add ".agent/" to .gitignore and re-run' },
  });

  const error = await rejects(() => openRoleBrowser(request({ playwright: pw.playwright }), state.deps), /tracked by Git/);
  assert.match(error.fix, /gitignore/);
  assert.equal(pw.calls.closed, 1, 'a session AX cannot record is a session AX does not leave running');
});

test('a compatible live owner is navigated, never replaced, and its receipt follows once it arrives', async () => {
  const trace = [];
  const pw = playwrightFake({ trace });
  const state = stateFake({ state: 'live', receipt: liveReceipt(), trace });
  const retried = [];

  const session = await openRoleBrowser(request({ playwright: pw.playwright, path: '/settings' }), { ...state.deps, onReuse: async receipt => retried.push(receipt.path) });

  assert.equal(session.mode, 'reused');
  assert.equal(session.cdpPort, 51_234);
  assert.equal(session.generation, 'aaaabbbbccccdddd', 'the owner keeps its generation; the reusing process owns nothing');
  assert.deepEqual(pw.calls.connect, [`http://${CDP_HOST}:51234`]);
  assert.deepEqual(pw.calls.goto, [{ url: `${ORIGIN}/settings`, options: { waitUntil: 'domcontentloaded', timeout: 120_000 } }]);
  assert.equal(pw.calls.launch.length, 0, 'no second Chromium');
  assert.deepEqual(state.calls.published, [], 'and no second receipt');
  assert.deepEqual(state.calls.removed, []);
  assert.deepEqual(state.calls.repathed, [{ generation: 'aaaabbbbccccdddd', path: '/settings' }], 'the path is written under the owner’s own generation, so status and the phone stop describing the previous screen');
  assert.deepEqual(
    trace.filter(step => step === 'goto' || step === 'repath'),
    ['goto', 'repath'],
    'and it is written only once the browser is actually there — a failed navigation must not record a screen nobody is on',
  );
  assert.equal(state.store.receipt.pid, 4100, 'ownership does not migrate through a path edit');
  assert.equal(pw.calls.detached, 0, 'the connection stays attached: this invocation is the operator’s foreground too');
  assert.deepEqual(retried, ['/settings'], 'a matching invocation can retry a failed notification against the live session');
  assert.deepEqual(state.calls.chdir, [], 'a reusing process starts no Chromium, so it moves nothing');
});

test('reuse with the same path rewrites nothing', async () => {
  const pw = playwrightFake();
  const state = stateFake({ state: 'live', receipt: liveReceipt() });

  const session = await openRoleBrowser(request({ playwright: pw.playwright, path: '/home' }), state.deps);

  assert.equal(session.mode, 'reused');
  assert.deepEqual(state.calls.repathed, []);
  assert.equal(pw.calls.goto.length, 1, 'the navigation still happens — a reload is the point of the invocation');
});

test('a navigation that fails on reuse leaves the owner’s receipt untouched', async () => {
  const pw = playwrightFake({ goto: Object.assign(new Error('Timeout 120000ms exceeded.'), { name: 'TimeoutError' }) });
  const state = stateFake({ state: 'live', receipt: liveReceipt() });

  await rejects(() => openRoleBrowser(request({ playwright: pw.playwright, path: '/settings' }), state.deps), /120/);
  assert.deepEqual(state.calls.repathed, [], 'the receipt still describes where the browser actually is');
  assert.equal(state.store.receipt.path, '/home');
  assert.equal(pw.calls.closed, 0, 'and the operator’s window survives a failed reuse');
  assert.equal(pw.calls.detached, 1, 'the failed connection is detached, not closed');
});

test('a path the owner’s receipt will not accept refuses after navigating, without a rival launch', async () => {
  const pw = playwrightFake();
  const state = stateFake({
    state: 'live',
    receipt: liveReceipt(),
    repathRefusal: { at: '.agent/debug-as.local.json', problem: 'is no longer owned by the generation this reuse observed', fix: 'run ax debug-as status, then re-run the launch' },
  });

  await rejects(() => openRoleBrowser(request({ playwright: pw.playwright, path: '/settings' }), state.deps), /no longer owned/);
  assert.equal(pw.calls.launch.length, 0);
  assert.equal(pw.calls.closed, 0);
});

test('an incompatible live owner refuses with its repair and keeps its window', async () => {
  const pw = playwrightFake();
  const state = stateFake({ state: 'live', receipt: liveReceipt() });

  const error = await rejects(() => openRoleBrowser(request({ playwright: pw.playwright, identity: 'pro' }), state.deps), /owner/);
  assert.match(error.fix, /close/i);
  assert.equal(pw.calls.launch.length, 0);
  assert.equal(pw.calls.connect.length, 0);
  assert.equal(pw.calls.closed, 0, 'the live session is never touched');
  assert.deepEqual(state.calls.removed, [], 'and its receipt is never removed by a rival');
  assert.deepEqual(state.calls.repathed, []);
});

test('a proven-dead owner is cleaned up and replaced; an ambiguous one is not', async () => {
  const pw = playwrightFake();
  const dead = stateFake({ state: 'dead', receipt: liveReceipt({ pid: 999_999 }) });
  const session = await openRoleBrowser(request({ playwright: pw.playwright }), dead.deps);
  assert.equal(session.mode, 'launched');
  assert.deepEqual(dead.calls.removed, [{ generation: 'aaaabbbbccccdddd', proven: true }], 'only a proven-dead receipt is removed, and it is removed by proof');
  assert.equal(dead.calls.published.length, 1);

  for (const state of ['ambiguous', 'unsafe', 'malformed']) {
    const blocked = stateFake({ state, receipt: state === 'malformed' ? null : liveReceipt({ host: 'other-mac' }) });
    const other = playwrightFake();
    await rejects(() => openRoleBrowser(request({ playwright: other.playwright }), blocked.deps), /./);
    assert.equal(other.calls.launch.length, 0, `${state} state must not launch a rival browser`);
    assert.deepEqual(blocked.calls.removed, [], `${state} state is never cleaned up on a guess`);
  }
});

test('two concurrent launches of the same request yield one owner', async () => {
  const first = playwrightFake();
  const second = playwrightFake();
  const state = stateFake();

  const [a, b] = await Promise.all([openRoleBrowser(request({ playwright: first.playwright }), state.deps), openRoleBrowser(request({ playwright: second.playwright }), state.deps)]);

  const launched = first.calls.launch.length + second.calls.launch.length;
  assert.equal(launched, 1, 'the lock serializes the transition, so the second call observes the first owner');
  assert.equal(state.calls.published.length, 1);
  assert.deepEqual([a.mode, b.mode].sort(), ['launched', 'reused']);
});

test('the launching command stays in the foreground until Chromium closes, then removes only its own generation', async () => {
  const pw = playwrightFake();
  const state = stateFake();
  const withdrawn = [];
  const session = await openRoleBrowser(request({ playwright: pw.playwright }), state.deps);

  const supervision = superviseRoleBrowser(session, { ...state.deps, onClosed: async () => withdrawn.push('relay') });
  assert.ok(await pending(supervision), 'the command owns the session: it does not return while the window is open');
  assert.deepEqual(state.calls.removed, [], 'and it removes nothing while the browser lives');

  pw.disconnect();
  const code = await supervision;

  assert.equal(code, 0);
  assert.deepEqual(state.calls.removed, [{ generation: 'ffff0000ffff0000' }], 'never a proven:true sweep of somebody else');
  assert.deepEqual(withdrawn, ['relay'], 'and whatever the launch published for this session is withdrawn with it');
  assert.ok(
    state.calls.progress.some(line => /removed/.test(line)),
    'the cleanup outcome is reported, not assumed',
  );
});

test('a signal closes the session, and a Chromium that will not close cannot hang the command', async () => {
  const pw = playwrightFake({ close: new Error('close hangs') });
  const state = stateFake();
  const session = await openRoleBrowser(request({ playwright: pw.playwright }), state.deps);

  const handlers = new Map();
  const signals = { on: (signal, handler) => handlers.set(signal, handler) };
  const supervision = superviseRoleBrowser(session, { ...state.deps, signals, closeTimeoutMs: 20 });

  await armed(handlers);
  handlers.get('SIGINT')();
  const code = await supervision;

  assert.equal(code, 0);
  assert.equal(pw.calls.closed, 1);
  assert.deepEqual(state.calls.removed, [{ generation: 'ffff0000ffff0000' }], 'a stuck close still releases this generation');
  assert.ok(handlers.has('SIGTERM'), 'both ordinary stop signals are handled');
});

test('a reusing command waits with the session but owns none of it', async () => {
  const pw = playwrightFake();
  const state = stateFake({ state: 'live', receipt: liveReceipt() });
  const session = await openRoleBrowser(request({ playwright: pw.playwright, path: '/settings' }), state.deps);

  const closed = [];
  const supervision = superviseRoleBrowser(session, { ...state.deps, onClosed: async () => closed.push('relay') });
  assert.ok(await pending(supervision), 'a reuse is an operator gesture too: it stays up with the window');

  pw.remoteClosed();
  const code = await supervision;

  assert.equal(code, 0);
  assert.equal(pw.calls.closed, 0, 'closing the browser here would kill the operator’s own window');
  assert.equal(pw.calls.detached, 1, 'the co-drive connection is detached instead');
  assert.deepEqual(state.calls.removed, [], 'removing the receipt would strand a live session');
  assert.deepEqual(closed, [], 'the owner withdraws its own publication, not this process');
});

test('a signal during a reuse detaches and touches nothing', async () => {
  const pw = playwrightFake();
  const state = stateFake({ state: 'live', receipt: liveReceipt() });
  const session = await openRoleBrowser(request({ playwright: pw.playwright, path: '/settings' }), state.deps);

  const handlers = new Map();
  const supervision = superviseRoleBrowser(session, { ...state.deps, signals: { on: (signal, handler) => handlers.set(signal, handler) } });
  await armed(handlers);
  handlers.get('SIGINT')();
  const code = await supervision;

  assert.equal(code, 0);
  assert.equal(pw.calls.closed, 0, 'an interrupted co-drive never closes the remote browser');
  assert.equal(pw.calls.detached, 1);
  assert.deepEqual(state.calls.removed, []);
});
