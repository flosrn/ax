// The one visible Chromium a worktree may own, and the rules that keep it one.
//
// WHAT THIS FILE DECIDES. Whether this machine can show a window at all, which
// Playwright answers for the project, what the emulated surface is, the exact
// argv and launch options Chromium gets, and — the part that is not mechanics —
// who owns the session. Everything about WHERE the browser goes (the origin,
// the authentication artifact, the phone handoff) is decided before this file
// runs and handed in, because those are refusals that must land before a
// process exists, not after.
//
// ORDER IS THE REQUIREMENT, not a style. `preflightBrowser` is separate from
// `openRoleBrowser` so a headless machine refuses BEFORE the caller invokes a
// Debug adapter: an adapter mints a fresh authenticated artifact, and minting
// one for a browser that can never open is a login the operator paid for and
// nobody used. For the same reason the live-owner decision happens before the
// caller's `beforeLaunch` hook: a conflicting invocation must not create
// credentials or publish a phone handoff for a window that will not open.
//
// MEASURED, NOT ASSUMED (Playwright 1.62.1, macOS arm64, headful, 2026-09-13 —
// a real launch, its `ps` argv read back, its CDP port curled):
//
//   1. Playwright's OWN default argv carries `--no-sandbox`: `launch`'s
//      `chromiumSandbox` default is off. A window holding a real authenticated
//      session runs sandboxed, so `chromiumSandbox: true` is passed
//      explicitly. It is not in `FORBIDDEN_ARGUMENTS`, because the repair is
//      the documented option, not deleting a flag Playwright believes it sent.
//   2. `ignoreDefaultArgs` does drop a default and the launch still works, so
//      `FORBIDDEN_ARGUMENTS` is passed there as well as never being emitted:
//      R13 is a contract over the whole argv, including defaults a future
//      Playwright might add. What the real default set already does NOT carry:
//      remote-allow-origins, remote-debugging-address, disable-web-security,
//      disable-site-isolation-trials, host-rules.
//   3. `--remote-debugging-pipe` and `--user-data-dir=<temp>` ARE defaults and
//      stay: the first is Playwright's control transport and the second is the
//      non-persistent profile R1 asks for. Dropping either breaks every launch.
//   4. `launch` accepts no `cwd` — the option was ignored and the Chromium root
//      inherited this process's directory. Maintenance discovers a live claim
//      by walking up from that directory to the worktree's receipt, so the
//      directory is moved on AX's own process around the launch and restored
//      immediately: an operator may have invoked this from a subdirectory.
//   5. Chromium itself answers a request carrying a foreign `Host` with
//      `500 Host header is specified and is not an IP address or localhost`.
//      That is R13's loopback guarantee, and it belongs to Chromium; nothing
//      here re-implements it. (Node's `fetch` silently DROPS a `Host` header
//      and returns 200, so no check may be written with it.)
//   6. Playwright installs its own SIGINT/SIGTERM/SIGHUP handlers and kills the
//      browser from them. All three are disabled, because teardown here has to
//      be bounded, generation-safe and reported — a kill that skips
//      `removeReceipt` leaves a receipt describing a window that is gone.
//
// OWNERSHIP IS A GENERATION, NEVER A PID. A reusing invocation navigates the
// live owner's window and, when the path changed, rewrites only `path` under
// the OWNER's generation after the browser is actually there — recording a
// screen a failed navigation never reached is how `status` and the phone start
// lying. It publishes nothing, removes nothing, and closes nothing: it is a
// second foreground on somebody else's session, and it detaches when it stops.
//
// DEPENDENCIES ARE INJECTED AND RESOLVED LATE. Every machine-touching
// collaborator — the receipt store, the worktree lock, the emission boundary —
// is a named dependency whose real implementation is imported on first use
// rather than at module load. That keeps this file's decisions testable without
// a receipt on disk, and it is also why nothing here writes to `src/log.mjs`:
// R35 puts every `src/debug-as/` emission through `./emit.mjs`, and progress is
// the only thing this file emits at all. Refusals are thrown as an `Error`
// carrying `.fix` (the vocabulary its siblings use), so the one caller that
// owns stdout decides how a refusal is printed.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';

import { pathProblem } from './config.mjs';

/** Where AX connects for its own CDP proof. The port is dynamic; the host never is. */
export const CDP_HOST = '127.0.0.1';

/**
 * R13's flags, in R13's own vocabulary: remote-allow-origin, debugging-address,
 * disabled-security, disabled-isolation. Never emitted, and also handed to
 * `ignoreDefaultArgs` so a Playwright default cannot introduce one behind AX's
 * back. Deliberately NOT a catch-all list of flags somebody dislikes: a name
 * here removes a Chromium default, so an over-long list breaks launches.
 */
export const FORBIDDEN_ARGUMENTS = Object.freeze([
  '--remote-allow-origins',
  '--remote-debugging-address',
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--allow-running-insecure-content',
]);

const SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 10_000;

const RECEIPT_DEPENDENCIES = ['readReceipt', 'publishReceipt', 'removeReceipt', 'updateReceiptPath', 'probeCdp', 'chromiumRoot', 'newGeneration'];
const LOCK_DEPENDENCIES = ['withLock', 'worktreeLockPath'];
const EMIT_DEPENDENCIES = ['progress'];

/** A refusal, as the `Error` this directory's modules throw: message plus repair. */
function refusalError({ at, problem, fix }) {
  const error = new Error(at ? `${at} ${problem}` : problem);
  error.fix = fix;
  error.refusal = { at, problem, fix };
  return error;
}

/**
 * Why this machine cannot show a window, or `null`.
 *
 * Returned rather than thrown, because `ax debug-as doctor` reports this as one
 * finding among many and must not abort on it. Only Linux is judged: macOS
 * always has a window server, and a Windows session always has a desktop, while
 * a Linux session with neither `DISPLAY` nor `WAYLAND_DISPLAY` has nowhere to
 * put a Role browser — the failure otherwise arrives from Chromium, after an
 * adapter has already minted an artifact.
 */
export function guiRefusal({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return null;
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return null;
  return {
    at: 'machine.display',
    problem: 'has no display server — neither DISPLAY nor WAYLAND_DISPLAY is set — and a Role browser is a visible window, never a headless one',
    fix: 'run ax debug-as from a desktop session, or export DISPLAY for a display server that exists',
  };
}

/** The version of the package that answered, read without trusting its `exports`. */
function packageVersion(load, specifier) {
  try {
    return load(`${specifier}/package.json`).version ?? '';
  } catch {
    // A package whose `exports` does not publish `./package.json` is normal.
    // Resolve its entry point and walk up to the manifest that owns it.
    try {
      let directory = dirname(load.resolve(specifier));
      for (let depth = 0; depth < 6; depth += 1) {
        try {
          return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version ?? '';
        } catch {
          const parent = dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
    } catch {
      /* fall through to an unknown version */
    }
    return '';
  }
}

/**
 * Playwright and its Chromium, from the project package that declares them.
 *
 * AX carries no browser dependency (R4), so the module is resolved from
 * `<root>/<playwrightDir>/package.json` with `createRequire` — the same route
 * OFMChat's launcher used, and the reason `--device` reads the catalog of the
 * version the PROJECT pins rather than one AX chose. `@playwright/test` first
 * because that is what a project with e2e tests installs; `playwright` is the
 * lighter dependency a project may pin instead.
 */
export function resolvePlaywright({ root, playwrightDir, require: injected } = {}) {
  const load = injected ?? createRequire(join(root, playwrightDir, 'package.json'));
  const failures = [];

  for (const specifier of ['@playwright/test', 'playwright']) {
    let module;
    try {
      module = load(specifier);
    } catch (error) {
      failures.push(`${specifier}: ${error.message}`);
      continue;
    }
    if (!module?.chromium || !module?.devices) {
      failures.push(`${specifier}: resolved without a "chromium" or "devices" export`);
      continue;
    }
    return { chromium: module.chromium, devices: module.devices, version: packageVersion(load, specifier), from: specifier };
  }

  throw refusalError({
    at: 'debugAs.browser.playwrightDir',
    problem: `names "${playwrightDir}", where neither "@playwright/test" nor "playwright" resolves (${failures.join('; ')})`,
    fix: `install Playwright in "${playwrightDir}", then run "npx playwright install chromium" there — AX never installs a browser`,
  });
}

/** Edit distance, bounded by the shorter string; only ever used to suggest a name. */
function distance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous[j];
      previous[j] = next;
    }
  }
  return previous[b.length];
}

/** The catalog entries an operator most likely meant. */
function nearestDevices(wanted, names) {
  const needle = wanted.toLowerCase();
  const scored = names
    .map(name => {
      const candidate = name.toLowerCase();
      if (candidate === needle) return { name, score: 0 };
      if (candidate.startsWith(needle) || candidate.includes(needle)) return { name, score: 1 };
      return { name, score: 2 + distance(needle, candidate) };
    })
    .filter(entry => entry.score <= 5)
    .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));
  return scored.slice(0, 4).map(entry => entry.name);
}

/**
 * The emulated surface: a project device descriptor, or a desktop viewport.
 *
 * The two are mutually exclusive because a descriptor already carries a
 * viewport, a scale factor and a touch flag — accepting both would mean
 * silently deciding which half wins. `windowSize` is separate from
 * `contextOptions` on purpose: the OS window is sized to match the emulated
 * viewport so a phone check on a desktop screen looks like a phone, and that
 * is a launch argument, not a context option.
 */
export function surfaceFor({ devices = {}, device = null, viewport = null } = {}) {
  if (device !== null && device !== undefined && viewport !== null && viewport !== undefined) {
    throw refusalError({
      at: 'debug-as',
      problem: 'was given both --device and --viewport, and a device descriptor already carries its own viewport, scale factor and touch emulation',
      fix: 'pass one: --device "iPhone 15" for an emulated device, or --viewport 1280x800 for a desktop window',
    });
  }

  if (device !== null && device !== undefined) {
    const descriptor = Object.prototype.hasOwnProperty.call(devices, device) ? devices[device] : undefined;
    if (descriptor === undefined) {
      const nearest = nearestDevices(String(device), Object.keys(devices));
      throw refusalError({
        at: '--device',
        problem: `names "${device}", which the device catalog of this project's own Playwright does not carry`,
        fix: nearest.length > 0 ? `use one of ${nearest.map(name => JSON.stringify(name)).join(', ')}` : 'run "ax debug-as doctor" to see which Playwright answered, then name a device from that version\'s catalog',
      });
    }
    return { device, viewport: null, contextOptions: { ...descriptor }, windowSize: descriptor.viewport ? { ...descriptor.viewport } : null };
  }

  if (viewport !== null && viewport !== undefined) {
    for (const side of ['width', 'height']) {
      const value = viewport[side];
      if (!Number.isInteger(value)) {
        throw refusalError({
          at: '--viewport',
          problem: `gives a ${side} of ${JSON.stringify(value)}, which is not a whole number of pixels`,
          fix: 'use --viewport <width>x<height>, such as --viewport 1280x800',
        });
      }
      if (value < VIEWPORT_MIN || value > VIEWPORT_MAX) {
        throw refusalError({
          at: '--viewport',
          problem: `gives a ${side} of ${value}, outside the ${VIEWPORT_MIN} to ${VIEWPORT_MAX} pixel range a desktop window is created from`,
          fix: 'use --viewport <width>x<height> within those bounds, such as --viewport 1280x800',
        });
      }
    }
    const sized = { width: viewport.width, height: viewport.height };
    return { device: null, viewport: sized, contextOptions: { viewport: { ...sized } }, windowSize: { ...sized } };
  }

  // Neither flag: Playwright's own default viewport, and no window sizing.
  return { device: null, viewport: null, contextOptions: {}, windowSize: null };
}

/** Exactly what Chromium is handed: the loopback CDP port, and the window size. */
export function launchArguments({ cdpPort, windowSize = null } = {}) {
  const argv = [`--remote-debugging-port=${cdpPort}`];
  if (windowSize) argv.push(`--window-size=${windowSize.width},${windowSize.height}`);
  return argv;
}

/**
 * Feature names whose DISABLING is R13's "disabled isolation", spelled out
 * because Chromium expresses that as a value inside `--disable-features=`,
 * never as a flag of its own.
 */
const ISOLATION_FEATURES = Object.freeze(['IsolateOrigins', 'SitePerProcess', 'StrictOriginIsolation', 'ProcessPerSiteUpToMainFrameThreshold']);

/**
 * Which arguments of a REAL Chromium argv R13 forbids.
 *
 * `ignoreDefaultArgs` matches a default by exact string, so it can drop
 * `--disable-web-security` and can NOT drop
 * `--disable-features=Foo,IsolateOrigins,Bar` — the forbidden thing there is a
 * value inside a list whose other entries are ordinary Playwright hygiene.
 * Measured on 1.62.1, the real default list carries none of
 * `ISOLATION_FEATURES`; this function is what makes that a checked fact rather
 * than a version-pinned hope, and the launch runs it against the argv of the
 * process it actually started.
 */
export function forbiddenInArgv(argv = []) {
  const offending = new Set();
  for (const argument of argv) {
    if (FORBIDDEN_ARGUMENTS.some(flag => argument === flag || argument.startsWith(`${flag}=`))) {
      offending.add(argument);
      continue;
    }
    if (argument.startsWith('--disable-site-isolation')) {
      offending.add(argument);
      continue;
    }
    if (argument.startsWith('--disable-features=')) {
      const disabled = argument
        .slice('--disable-features='.length)
        .split(',')
        .map(value => value.trim());
      if (disabled.some(value => ISOLATION_FEATURES.includes(value))) offending.add(argument);
    }
  }
  return [...offending];
}

const slug = value =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The name this session is known by to `agent-browser`.
 *
 * Derived, never recorded from a caller: `drive` refuses a caller-supplied
 * `--session`, so the name has to come from the same two facts on both sides —
 * the worktree that owns the window and the identity it carries.
 */
export function sessionNameFor({ worktree, identity }) {
  return `ax-debug-${slug(basename(String(worktree)))}-${slug(identity)}`;
}

const sameViewport = (left, right) => {
  if (!left || !right) return !left && !right;
  return left.width === right.width && left.height === right.height;
};

/**
 * Why this invocation may not reuse the live session, or `null` when it may.
 *
 * A path is the one thing a reuse may change (R6): it is a navigation inside
 * the same authenticated context. Identity, origin, device and viewport are
 * the context itself, and changing any of them means a different browser —
 * which is a refusal, never a silent replacement of the operator's window.
 */
export function reuseRefusal({ receipt, request }) {
  const asked = [];
  if (receipt.identity !== request.identity) asked.push(`the "${request.identity}" identity`);
  if (receipt.origin !== request.origin) asked.push(`the origin ${request.origin}`);
  if ((receipt.device ?? null) !== (request.device ?? null)) asked.push(request.device ? `the "${request.device}" device` : 'no device emulation');
  if (!sameViewport(receipt.viewport ?? null, request.viewport ?? null)) {
    asked.push(request.viewport ? `a ${request.viewport.width}x${request.viewport.height} viewport` : 'the default viewport');
  }
  if (asked.length === 0) return null;

  return {
    at: 'debug-as',
    problem: `cannot reuse this worktree's Role browser: the live window is the "${receipt.identity}" session on ${receipt.origin}${
      receipt.device ? ` (device "${receipt.device}")` : receipt.viewport ? ` (viewport ${receipt.viewport.width}x${receipt.viewport.height})` : ''
    }, owned by process ${receipt.pid}, and this invocation asks for ${asked.join(', ')}`,
    fix: 'close that window and re-run this command, or run "ax debug-as status" to see what owns it — AX never replaces a live session',
  };
}

/** A loopback port the OS just confirmed is free. Chromium binds it moments later. */
export function freeLoopbackPort({ listen = createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = listen();
    server.on('error', reject);
    server.listen(0, CDP_HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The real collaborators, resolved on first use.
 *
 * Imported lazily and only for the names a caller did not inject: a unit test
 * drives every decision here without a receipt store, and production wires
 * nothing. `??=` per name rather than per module, so a caller may override one
 * function and inherit the rest.
 */
async function dependencies(given = {}) {
  const merged = { ...given };

  if (RECEIPT_DEPENDENCIES.some(name => merged[name] === undefined)) {
    const module = await import('./receipt.mjs');
    for (const name of RECEIPT_DEPENDENCIES) merged[name] ??= module[name];
  }
  if (LOCK_DEPENDENCIES.some(name => merged[name] === undefined)) {
    const module = await import('./lock.mjs');
    for (const name of LOCK_DEPENDENCIES) merged[name] ??= module[name];
  }
  if (EMIT_DEPENDENCIES.some(name => merged[name] === undefined)) {
    const module = await import('./emit.mjs');
    for (const name of EMIT_DEPENDENCIES) merged[name] ??= module[name];
  }

  merged.freePort ??= freeLoopbackPort;
  merged.chdir ??= directory => process.chdir(directory);
  merged.cwd ??= () => process.cwd();
  merged.signals ??= process;
  merged.closeTimeoutMs ??= 10_000;
  return merged;
}

/** Run an optional hook whose failure is a finding, never the end of the session. */
async function reported(hook, argument, progress, what) {
  if (!hook) return;
  try {
    await hook(argument);
  } catch (error) {
    progress(`${what} failed: ${error.message}`);
  }
}

/** Await a promise, or give up on it, without ever keeping the event loop alive. */
function bounded(promise, milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    Promise.resolve(promise)
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Everything that must hold before an adapter runs: a machine that can show a
 * window, a Playwright that answers, and a surface the catalog admits.
 *
 * Separate from `openRoleBrowser` because of its position in the sequence, not
 * because it is a different concern — see this file's header.
 */
export function preflightBrowser({ root, playwrightDir, device = null, viewport = null }, deps = {}) {
  const { platform = process.platform, env = process.env, resolve = resolvePlaywright } = deps;

  const refusal = guiRefusal({ platform, env });
  if (refusal) throw refusalError(refusal);

  const playwright = resolve({ root, playwrightDir });
  const surface = surfaceFor({ devices: playwright.devices, device, viewport });
  return { playwright, surface };
}

/** The URL this invocation navigates to, with R2's path rule applied once more. */
function targetUrl(origin, path) {
  const problem = pathProblem(path);
  if (problem !== '') {
    throw refusalError({ at: '--path', problem: `is a path that ${problem}`, fix: 'pass an absolute path of this application, such as --path /home' });
  }
  return `${origin}${path}`;
}

/** Navigate, and turn any failure into the one refusal an operator can act on. */
async function navigate(page, url, { navigationTimeoutSeconds, start }) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutSeconds * 1000 });
  } catch (error) {
    throw refusalError({
      at: 'debug-as',
      problem: `could not finish the first navigation to ${url} within the declared ${navigationTimeoutSeconds}s: ${error.message}`,
      fix: `start the application with "${(start ?? []).join(' ')}" and let it compile that route, then re-run — AX never starts it for you`,
    });
  }
}

/** Reuse: navigate the live owner's window, and correct its receipt afterwards. */
async function reuseSession(request, deps, receipt) {
  const { playwright, root, path, navigationTimeoutSeconds } = request;
  const url = targetUrl(receipt.origin, path);

  // Bounded by the project's OWN declared deadline, not Playwright's 30s
  // default: this contract defaults no deadline anywhere (R26), and the
  // endpoint being attached to is a loopback port on this machine — a wait
  // longer than the navigation budget is a hang, not patience.
  const connected = await playwright.chromium.connectOverCDP(`http://${CDP_HOST}:${receipt.cdpPort}`, { timeout: navigationTimeoutSeconds * 1000 });
  let resolveClosed;
  const closed = new Promise(resolve => {
    resolveClosed = resolve;
  });
  connected.on?.('disconnected', () => resolveClosed());

  let current = receipt;
  try {
    // A REQUIRED handoff is prepared before the screen moves: an explicit
    // `--phone` that cannot be published must not have navigated first.
    if (deps.beforeReuse) await deps.beforeReuse(receipt);

    const context = connected.contexts()[0];
    if (!context) {
      throw refusalError({
        at: 'debug-as',
        problem: `connected to the live session on port ${receipt.cdpPort}, which has no browser context to navigate`,
        fix: 'close that window and re-run this command to launch a fresh Role browser',
      });
    }
    const page = context.pages()[0] ?? (await context.newPage());

    await navigate(page, url, request);

    if (receipt.path !== path) {
      const updated = deps.updateReceiptPath(root, { generation: receipt.generation, path });
      if (!updated.updated) throw refusalError(updated.refusal);
      current = updated.receipt;
    }

    deps.progress(`reusing the live "${receipt.identity}" session on ${url} (generation ${receipt.generation}, CDP ${receipt.cdpPort})`);
    await reported(deps.onReuse, current, deps.progress, 'phone notification');

    return { mode: 'reused', receipt: current, generation: receipt.generation, cdpPort: receipt.cdpPort, browser: connected, page, closed, root };
  } catch (error) {
    // Detach, never close: the window belongs to another process.
    await Promise.resolve(connected.close?.()).catch(() => {});
    throw error;
  }
}

/** Launch: one non-persistent headful Chromium, published only once proven. */
async function launchSession(request, deps, generation) {
  const { playwright, root, project, worktree, identity, origin, path, surface, navigationTimeoutSeconds } = request;
  const url = targetUrl(origin, path);

  let prepared = {};
  let hookRan = false;
  try {
    if (deps.beforeLaunch) {
      // Marked as run BEFORE awaiting: a hook that fails halfway through
      // publishing a relay must still get its teardown call.
      hookRan = true;
      prepared = (await deps.beforeLaunch({ generation, root, identity, origin, path })) ?? {};
    }

    const storageState = prepared.storageState ?? request.storageState ?? null;
    const cdpPort = await deps.freePort();

    deps.progress(`opening the "${identity}" Role browser on ${url} (CDP ${cdpPort})`);

    const previous = deps.cwd();
    let browser;
    try {
      // See header note 4: `launch` has no `cwd`, and the Chromium root's own
      // directory is how maintenance finds the receipt that claims it.
      if (previous !== root) deps.chdir(root);
      browser = await playwright.chromium.launch({
        headless: false,
        chromiumSandbox: true,
        ignoreDefaultArgs: FORBIDDEN_ARGUMENTS,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: launchArguments({ cdpPort, windowSize: surface.windowSize }),
      });
    } catch (error) {
      throw refusalError({
        at: 'debug-as',
        problem: `could not start Chromium from this project's Playwright: ${error.message}`,
        fix: 'run "npx playwright install chromium" in the package that declares Playwright, then re-run',
      });
    } finally {
      if (previous !== root) deps.chdir(previous);
    }

    let resolveClosed;
    const closed = new Promise(resolve => {
      resolveClosed = resolve;
    });
    browser.on('disconnected', () => resolveClosed());

    let publishedGeneration = null;
    try {
      const context = await browser.newContext({
        baseURL: origin,
        ...(storageState ? { storageState } : {}),
        ...surface.contextOptions,
      });
      const page = await context.newPage();

      await navigate(page, url, request);
      deps.progress(`navigation reached ${url}`);

      const proof = await deps.probeCdp(cdpPort, {});
      if (!proof.alive) {
        throw refusalError({
          at: 'debug-as',
          problem: `opened the window but its loopback CDP endpoint on port ${cdpPort} did not answer: ${proof.why}`,
          fix: 'close any leftover Chromium from this worktree and re-run; run "ax debug-as doctor" to see which Playwright answered',
        });
      }
      deps.progress(`CDP endpoint answered on ${CDP_HOST}:${cdpPort}`);

      const chromium = await deps.chromiumRoot({ cdpPort });
      if (!chromium || !Number.isInteger(chromium.pid)) {
        throw refusalError({
          at: 'debug-as',
          problem: `could not identify the Chromium process it just started on port ${cdpPort}, so ordinary maintenance could not be taught to spare this session`,
          fix: 'close the window that just opened and re-run; if it recurs, run "ax debug-as doctor"',
        });
      }

      // The argv of the process that actually started, when the state layer
      // reports it. `ignoreDefaultArgs` cannot drop a forbidden value hidden
      // inside `--disable-features=<list>`, so the flags R13 names are proved
      // absent from the real command line rather than from AX's intent.
      if (Array.isArray(chromium.args)) {
        const offending = forbiddenInArgv(chromium.args);
        if (offending.length > 0) {
          throw refusalError({
            at: 'debug-as',
            problem: `started a Chromium whose command line carries ${offending.join(', ')} — a flag this contract never exposes an authenticated session to`,
            fix: 'pin a Playwright version whose launch defaults do not set it (run "ax debug-as doctor" to see which one answered), then re-run',
          });
        }
      }

      const published = deps.publishReceipt({
        root,
        fields: {
          generation,
          project,
          worktree,
          identity,
          origin,
          path,
          device: surface.device,
          viewport: surface.viewport,
          cdpPort,
          sessionName: sessionNameFor({ worktree, identity }),
          chromiumPid: chromium.pid,
        },
      });
      if (!published.ok) throw refusalError(published.refusal);
      publishedGeneration = generation;

      deps.progress(`browser receipt published for generation ${generation}`);
      await reported(deps.onPublished, published.receipt, deps.progress, 'phone handoff');

      return { mode: 'launched', receipt: published.receipt, generation, cdpPort, browser, page, closed, root };
    } catch (error) {
      // A failure AFTER publication would otherwise leave a receipt describing
      // a window that is being closed — the exact state `status` reports as
      // live and `drive` then fails against.
      if (publishedGeneration !== null) {
        const removal = deps.removeReceipt(root, { generation: publishedGeneration });
        deps.progress(removal.removed ? `rolled back the published receipt: ${removal.reason}` : `published receipt not rolled back: ${removal.reason}`);
      }
      await bounded(Promise.resolve(browser.close()).catch(() => {}), deps.closeTimeoutMs);
      throw error;
    }
  } catch (error) {
    if (hookRan) await reported(deps.onClosed, undefined, deps.progress, 'session cleanup');
    throw error;
  }
}

/**
 * Open, or reuse, this worktree's one Role browser.
 *
 * The whole observe-then-act transition runs inside the worktree lock, because
 * the alternative is two invocations both reading "absent" and both launching:
 * one window is the requirement, and the lock is the only thing that makes the
 * receipt's own rival check sufficient.
 */
export async function openRoleBrowser(request, given = {}) {
  const deps = await dependencies(given);
  const { root } = request;
  const generation = request.generation ?? deps.newGeneration();

  return deps.withLock(deps.worktreeLockPath(root), async () => {
    const observed = deps.readReceipt(root, {});

    if (observed.state === 'live') {
      // The surface is what the context IS, so the compatibility decision
      // reads it from `surface` rather than from a flat field the launch
      // request does not carry.
      const refusal = reuseRefusal({
        receipt: observed.receipt,
        request: { identity: request.identity, origin: request.origin, path: request.path, device: request.surface.device, viewport: request.surface.viewport },
      });
      if (refusal) throw refusalError(refusal);
      return reuseSession(request, deps, observed.receipt);
    }

    if (observed.state === 'dead') {
      const removal = deps.removeReceipt(root, { generation: observed.receipt.generation, proven: true });
      deps.progress(`previous session proven dead: ${removal.reason}`);
    } else if (observed.state !== 'absent') {
      throw refusalError(
        observed.refusal ?? {
          at: 'debug-as',
          problem: `found a browser receipt in this worktree it could not act on (${observed.state}), and AX never replaces or signals a session it cannot prove dead`,
          fix: 'run "ax debug-as status" to see what it describes, close any Chromium it names, then remove .agent/debug-as.local.json by hand',
        },
      );
    }

    return launchSession(request, deps, generation);
  });
}

/**
 * Stay in the foreground with the session, and clean up exactly what is owned.
 *
 * A LAUNCH owns its generation: it waits for Chromium to disconnect or for an
 * ordinary stop signal, closes the browser within a bound, removes the receipt
 * of its OWN generation, and reports that outcome. A REUSE owns nothing: it
 * waits with the window because the invocation is an operator gesture too, and
 * when it stops it detaches — closing the browser or removing the receipt there
 * would take down a session this process never created.
 */
export async function superviseRoleBrowser(session, given = {}) {
  const deps = await dependencies(given);

  // Registered by name and removed on the way out. An anonymous listener left
  // on `process` survives the command: a long-lived caller that launches, then
  // reuses, would accumulate one handler per session and the FIRST one would
  // still answer the operator's Ctrl-C.
  const installed = [];
  const stopped = new Promise(resolve => {
    for (const signal of SIGNALS) {
      const handler = () => resolve(signal);
      installed.push([signal, handler]);
      deps.signals.on(signal, handler);
    }
  });

  try {
    const reason = await Promise.race([session.closed.then(() => 'closed'), stopped]);

    if (session.mode === 'reused') {
      deps.progress(
        reason === 'closed'
          ? `the live "${session.receipt.identity}" session closed; this process owned none of it`
          : `${reason}: detaching from the live "${session.receipt.identity}" session, which its owner keeps open`,
      );
      await bounded(Promise.resolve(session.browser?.close?.()).catch(() => {}), deps.closeTimeoutMs);
      return 0;
    }

    if (reason !== 'closed') {
      deps.progress(`${reason}: closing the "${session.receipt.identity}" Role browser`);
      await bounded(Promise.resolve(session.browser.close()).catch(() => {}), deps.closeTimeoutMs);
    }

    const removal = deps.removeReceipt(session.root, { generation: session.generation });
    deps.progress(removal.removed ? `browser receipt ${removal.reason}` : `browser receipt not removed: ${removal.reason}`);
    await reported(deps.onClosed, undefined, deps.progress, 'session cleanup');
    return 0;
  } finally {
    for (const [signal, handler] of installed) {
      (deps.signals.off ?? deps.signals.removeListener)?.call(deps.signals, signal, handler);
    }
  }
}
