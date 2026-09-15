// The machine Phone relay: one loopback listener that mints authority only
// after a confirmed, user-bound, single-use POST.
//
// Three facts shape every line here.
//
// The listener is reachable from the tailnet, so a GET may render intent and
// nothing else: a link preview or a crawler that touched a provider would hand
// an authenticated session to whoever fetched the URL first (R19, KTD7).
//
// `tailscale serve --bg` mappings outlive the process that made them, so
// ownership is generational and withdrawal happens BEFORE the listener is
// released (R17). A stable Serve port points at an ephemeral loopback port: if
// the owner released the listener first, the tailnet would forward to whatever
// local process next bound that number.
//
// And every refusal — no identity header, a duplicate one, a foreign `Host`, a
// cross-site submission, another path, an oversized body, a dead Browser
// receipt — is the same `404` with the same body (R18). A distinguishable
// refusal is a probe oracle for a listener whose whole job is to decide who may
// mint a session.
//
// Nothing here persists or notifies a magic link, a token, a credential or
// storage state (R20). Nonces live only in this process's memory, bind the
// generation, the confirming login and the destination the live Browser receipt
// currently claims, and are compared in constant time (R19).

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { basename, dirname } from 'node:path';

import { event, scrub } from './emit.mjs';
import { pathProblem } from './config.mjs';
import { readVariable as readVariableFrom } from './address.mjs';
import { loadMachineConfig } from './machine-config.mjs';
import { processStart as processStartOf, readReceipt as readBrowserReceipt } from './receipt.mjs';
import { runAdapter as defaultRunAdapter } from './adapter.mjs';
import { machineLockPath, withLock } from './lock.mjs';
import { notify } from './notifier.mjs';
import { createHandoff as createProviderHandoff } from './provider.mjs';
import {
  clearRelayReceipt,
  publishRelayReceipt,
  readRelayReceipt,
  relayOwnedBy,
  relayOwnership,
  relayReceiptPath,
  relayUrl,
  sweepDeadRelay,
} from './relay-receipt.mjs';
import { findMapping, publishServe, readServe, tailnetHost, withdrawCommand, withdrawServe } from './tailscale.mjs';

/** The only path this listener answers, on the only two methods it answers. */
const ROUTE = '/go';

/** R19: at most 4 KiB of form-urlencoded data, refused before it is parsed. */
const MAX_BODY = 4096;

/** A header block larger than this is a resource attack, not a phone. */
const MAX_HEADER = 8192;

/** Two minutes is the whole life of a nonce. */
const NONCE_TTL_MS = 120_000;

/** 256 bits, hex, so the page's only mutable field is unguessable. */
const NONCE_BYTES = 32;
const NONCE_HEX = /^[a-f0-9]{64}$/;

/** Outstanding nonces per generation, evicted oldest-first. */
const NONCE_CAP = 16;

// `acquireLock` waits with a SYNCHRONOUS `Atomics.wait`, so a second relay
// transition in this process would block the event loop of the very
// publication it is waiting for. Machine transitions therefore never wait: a
// genuinely concurrent launch refuses and says so.
const LOCK_WAIT_MS = 0;

/** No inline style, no script, no image, no frame, and a form that posts here. */
const CSP =
  "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'none'; script-src 'none'; style-src 'none'";

/** One body for every refusal. */
const NOT_FOUND = 'Not Found\n';

const refuse = (problem, fix, extra = {}) =>
  Object.assign(new Error(scrub(problem)), { problem: scrub(problem), fix, ...extra });

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const nameOf = identity => (typeof identity === 'string' ? identity : (identity?.name ?? ''));

const projectOf = context => context?.project ?? context?.config?.project?.name ?? '';

const escape = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** A short, meaningless correlation id: enough to match a page to a log line. */
const diagnostic = () => randomBytes(4).toString('hex');

/**
 * The confirmation page. Project-authored text — a worktree name, an identity,
 * a destination path — is escaped, and the page carries no URL, no script and
 * no external resource, so a CSP of `default-src 'none'` costs it nothing.
 */
function confirmationPage({ project, worktree, identity, path, publishedAt, nonce }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AX phone handoff</title>
</head>
<body>
<h1>Open this screen as ${escape(identity)}</h1>
<dl>
<dt>Project</dt><dd>${escape(project)}</dd>
<dt>Worktree</dt><dd>${escape(worktree)}</dd>
<dt>Identity</dt><dd>${escape(identity)}</dd>
<dt>Path</dt><dd>${escape(path)}</dd>
<dt>Published</dt><dd>${escape(publishedAt)}</dd>
</dl>
<form method="post" action="${ROUTE}">
<input type="hidden" name="nonce" value="${nonce}">
<button type="submit">Open as ${escape(identity)}</button>
</form>
<p>Nothing is signed in until you tap the button above.</p>
</body>
</html>
`;
}

/** The page a superseded notification link renders: intent, never a control. */
function supersededPage({ project, identity }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AX phone handoff superseded</title>
</head>
<body>
<h1>This link is superseded</h1>
<p>A newer Role browser session owns this machine's Phone relay, so this link opens nothing.</p>
<p>Project: ${escape(project)}. Requested identity: ${escape(identity)}.</p>
<p>Use the relay URL the latest <code>ax debug-as</code> printed.</p>
</body>
</html>
`;
}

/**
 * Bind the loopback confirmation listener.
 *
 * Every machine answer is injected: `machine` is the proven machine contract,
 * `readReceipt` rereads the worktree Browser receipt on EVERY request so a dead
 * or superseded session serves nothing, `ownsRelay` rereads the MACHINE relay
 * receipt so a listener whose mapping a newer publication took over stops
 * answering, and `createHandoff` is the only thing that may create
 * authentication — after a confirmed POST, never before.
 */
export async function createRelayServer({
  context,
  generation,
  identity,
  path: destinationPath,
  machine,
  serveHost = null,
  createHandoff,
  readReceipt = root => readBrowserReceipt(root),
  ownsRelay = () => true,
  publishedAt = new Date().toISOString(),
  now = Date.now,
  nonceCap = NONCE_CAP,
  output = { event },
} = {}) {
  const identityName = nameOf(identity);
  const project = projectOf(context);
  // The label the phone reads is the WORKTREE, and a caller's `context.name`
  // may legitimately be the identity (that is index.mjs's contract), so the
  // worktree's own directory name is the fallback every caller shares.
  const worktreeName =
    context?.worktreeName ?? context?.name ?? (typeof context?.root === 'string' ? basename(context.root) : '');
  const allowed = new Set((machine?.allowedLogins ?? []).map(login => login.toLowerCase()));
  const relayPort = machine?.relayPort;

  /** nonce -> { login, receiptPath, expiresAt }. Insertion-ordered: eviction is oldest-first. */
  const nonces = new Map();

  const mint = ({ login, receiptPath }) => {
    for (const [key, entry] of nonces) if (entry.expiresAt <= now()) nonces.delete(key);
    while (nonces.size >= nonceCap) {
      const oldest = nonces.keys().next();
      if (oldest.done) break;
      nonces.delete(oldest.value);
    }
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    nonces.set(nonce, { login, receiptPath, expiresAt: now() + NONCE_TTL_MS });
    return nonce;
  };

  /** Constant-time lookup: a timing difference over an outstanding nonce is a guess oracle. */
  const take = candidate => {
    if (typeof candidate !== 'string' || !NONCE_HEX.test(candidate)) return null;
    const probe = Buffer.from(candidate, 'utf8');
    let hit = null;
    for (const [key, entry] of nonces) {
      const known = Buffer.from(key, 'utf8');
      if (known.length === probe.length && timingSafeEqual(known, probe)) hit = { key, entry };
    }
    if (hit === null) return null;
    // One use, whatever the outcome of this attempt.
    nonces.delete(hit.key);
    return hit.entry;
  };

  const server = createServer({ maxHeaderSize: MAX_HEADER });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = address.port;
  const target = `http://127.0.0.1:${boundPort}`;

  /** The `Host` values this listener answers: its own authority, or the mapped Serve name. */
  const hosts = new Set([`127.0.0.1:${boundPort}`, `[::1]:${boundPort}`, `localhost:${boundPort}`]);
  if (typeof serveHost === 'string' && serveHost !== '') {
    hosts.add(serveHost.toLowerCase());
    hosts.add(`${serveHost.toLowerCase()}:443`);
    if (Number.isInteger(relayPort)) hosts.add(`${serveHost.toLowerCase()}:${relayPort}`);
  }

  /** The origins a same-site submission may declare. */
  const origins = new Set([target, `http://localhost:${boundPort}`]);
  if (typeof serveHost === 'string' && serveHost !== '') {
    origins.add(`https://${serveHost}`);
    if (Number.isInteger(relayPort)) origins.add(`https://${serveHost}:${relayPort}`);
  }

  const security = (extra = {}) => ({
    'content-security-policy': CSP,
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });

  const notFound = (req, res) => {
    res.writeHead(404, security({ 'content-type': 'text/plain; charset=utf-8', connection: 'close' }));
    res.end(NOT_FOUND, () => {
      // An unread body (a refused oversized POST) is never parsed; the socket goes.
      req.socket?.end();
    });
  };

  const html = (res, status, body) => {
    res.writeHead(status, security({ 'content-type': 'text/html; charset=utf-8' }));
    res.end(body);
  };

  const seeOther = (res, location) => {
    res.writeHead(303, security({ location, 'content-type': 'text/plain; charset=utf-8' }));
    res.end('');
  };

  /** A rejected confirmation never dead-ends: it returns to a fresh GET. */
  const freshGet = (res, why) => {
    const id = diagnostic();
    output.event?.(`phone confirmation refused (${why}, ${id})`);
    seeOther(res, `${ROUTE}?g=${encodeURIComponent(generation)}&retry=${id}`);
  };

  const headerValues = (req, name) => {
    const values = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === name) values.push(req.rawHeaders[index + 1]);
    }
    return values;
  };

  const body = req =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) {
          // Refused, never parsed. The socket is closed with the 404, not here:
          // destroying it now would race the refusal off the wire.
          req.pause();
          reject(new Error('body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  server.on('request', async (req, res) => {
    try {
      // Method and route, before anything is read.
      if (req.method !== 'GET' && req.method !== 'POST') return notFound(req, res);
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://relay.invalid');
      } catch {
        return notFound(req, res);
      }
      if (url.pathname !== ROUTE) return notFound(req, res);

      // Exactly one `Host`, and one AX answers for.
      const hostHeaders = headerValues(req, 'host');
      if (hostHeaders.length !== 1 || !hosts.has(hostHeaders[0].trim().toLowerCase())) return notFound(req, res);

      // Exactly one identity header, present in the machine-private allowlist.
      // A comma-joined value is refused, never split: Serve sends one login.
      const logins = headerValues(req, 'tailscale-user-login');
      if (logins.length !== 1) return notFound(req, res);
      const login = logins[0].trim().toLowerCase();
      if (login === '' || login.includes(',') || !allowed.has(login)) return notFound(req, res);

      // Cross-site requests are refused with the same 404 as an unknown
      // caller, on EVERY method (R18). A GET is not harmless here: it mints a
      // confirmation nonce, and a page on another site must not be able to
      // drive this one. `none` is a top-level navigation — what the phone does.
      const originHeaders = headerValues(req, 'origin');
      if (originHeaders.length > 1) return notFound(req, res);
      if (originHeaders.length === 1 && !origins.has(originHeaders[0].trim())) return notFound(req, res);
      const siteHeaders = headerValues(req, 'sec-fetch-site');
      if (siteHeaders.length > 1) return notFound(req, res);
      if (siteHeaders.length === 1 && !['same-origin', 'none'].includes(siteHeaders[0].trim().toLowerCase())) {
        return notFound(req, res);
      }

      // The Browser receipt, reread on every request: a dead or superseded
      // session serves nothing, and no receipt yet serves nothing either.
      let live = null;
      try {
        const answer = readReceipt?.(context?.root);
        if (answer?.state === 'live' && answer.receipt?.generation === generation) live = answer.receipt;
      } catch {
        live = null;
      }
      if (live === null) return notFound(req, res);

      // And the MACHINE relay receipt, equally on every request: a newer
      // publication rewired the stable Serve port under the machine lock, and
      // the superseded owner must stop answering rather than serve a target
      // the machine no longer points at.
      let current = false;
      try {
        current = ownsRelay() === true;
      } catch {
        current = false;
      }
      if (!current) return notFound(req, res);

      // The destination is the one the LIVE receipt currently claims, so an
      // operator who navigated this generation elsewhere hands off the screen
      // they are looking at — and every nonce minted for the old one dies.
      const destination = typeof live.path === 'string' && live.path !== '' ? live.path : destinationPath;

      const asked = url.searchParams.get('g');
      const superseded = asked !== null && asked !== generation;

      if (req.method === 'GET') {
        if (superseded) return html(res, 200, supersededPage({ project, identity: identityName }));
        const nonce = mint({ login, receiptPath: destination });
        return html(
          res,
          200,
          confirmationPage({
            project,
            worktree: worktreeName,
            identity: identityName,
            path: destination,
            publishedAt,
            nonce,
          }),
        );
      }

      // A POST for another generation is a mutation attempt against a target
      // this listener does not own.
      if (superseded) return notFound(req, res);

      // 4 KiB, decided from the declared length before a byte is parsed.
      const declared = Number(req.headers['content-length'] ?? '0');
      if (!Number.isFinite(declared) || declared > MAX_BODY) return notFound(req, res);
      let text;
      try {
        text = await body(req);
      } catch {
        return notFound(req, res);
      }

      const entry = take(new URLSearchParams(text).get('nonce'));
      if (entry === null) return freshGet(res, 'unknown nonce');
      if (entry.login !== login) return freshGet(res, 'another user\'s nonce');
      if (entry.expiresAt <= now()) return freshGet(res, 'expired nonce');
      if (entry.receiptPath !== destination) return freshGet(res, 'the target changed');

      let answer;
      try {
        answer = await createHandoff({ identity: identityName, path: destination, login, generation });
      } catch (error) {
        // The provider's own words never reach the phone or this page.
        output.event?.(`phone provider refused (${diagnostic()})`);
        void error;
        return freshGet(res, 'provider');
      }
      if (typeof answer?.url !== 'string' || answer.url === '') return freshGet(res, 'provider');
      return seeOther(res, answer.url);
    } catch {
      if (!res.headersSent) return notFound(req, res);
      res.end();
      return undefined;
    }
  });

  const close = () =>
    new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { port: boundPort, address, target, serveHost, close };
}

/**
 * Publish this generation as the machine's Phone relay owner.
 *
 * Order is the contract: withdraw a proven-dead owner's mapping BEFORE
 * anything binds, refuse an unowned or Funnel-mapped collision while naming the
 * exact withdrawal command, then bind, map Serve at the stable port and record
 * ownership. Every transition is serialized on the machine lock, so two
 * launches cannot both see "no owner".
 */
export async function startRelay({
  context,
  generation,
  identity,
  path: destinationPath,
  machine,
  createHandoff,
  readReceipt,
  home = homedir(),
  env = process.env,
  host = hostname(),
  pid = process.pid,
  processStart,
  alive = pidAlive,
  start = processStartOf,
  run,
  output,
  publishedAt = new Date().toISOString(),
  nonceCap,
  now,
} = {}) {
  const port = machine?.relayPort;
  if (!Number.isInteger(port)) {
    throw refuse('the machine Phone relay contract carries no port', 'set "relayPort" in the machine contract');
  }
  const serveHost = tailnetHost({ run });
  const lockPath = machineLockPath(dirname(relayReceiptPath({ home, env })));
  const identityName = nameOf(identity);
  // The owner process identity recorded once: `stop` compares it back, so a
  // same-generation reuse in another process cannot withdraw this mapping.
  const ownerStart = processStart ?? start(pid) ?? '';

  return withLock(
    lockPath,
    async () => {
      // A crashed generation's mapping goes first: while it survives, the
      // tailnet forwards to whatever binds that released ephemeral port.
      const swept = sweepDeadRelay({ home, env, host, alive, start, run });

      const mapping = findMapping(readServe({ run }), port);
      if (mapping !== null) {
        if (mapping.funnel) {
          throw refuse(
            `Tailscale Serve exposes port ${port} through Funnel, and AX never adopts a publicly exposed mapping as its Phone relay`,
            `remove it with \`${withdrawCommand(port)}\`, then retry`,
          );
        }
        // Ownership is an EXACT recorded target on this host's name and port.
        // Anything else is the user's own Serve mapping — the real 1300 one a
        // consumer already runs — and AX refuses rather than adopting it.
        const held = readRelayReceipt({ home, env });
        const ours =
          swept.withdrawn ||
          (held !== null && held.port === port && held.serveHost === serveHost && held.serveTarget === mapping.target);
        if (!ours) {
          throw refuse(
            `Tailscale Serve already maps port ${port} to ${mapping.target ?? 'an unreadable target'}, and no AX generation owns that mapping`,
            `withdraw it with \`${withdrawCommand(port)}\` if it is yours to remove, then retry`,
          );
        }
      }

      let boundTarget = null;
      const server = await createRelayServer({
        context,
        generation,
        identity,
        path: destinationPath,
        machine,
        serveHost,
        createHandoff,
        ...(readReceipt ? { readReceipt } : {}),
        ownsRelay: () => {
          const owner = readRelayReceipt({ home, env });
          return (
            relayOwnedBy(owner, { root: context?.root, generation }) &&
            owner.port === port &&
            owner.serveHost === serveHost &&
            owner.serveTarget === boundTarget
          );
        },
        publishedAt,
        nonceCap,
        now,
        ...(output ? { output } : {}),
      });
      boundTarget = server.target;

      let record;
      let mapped = false;
      try {
        publishServe({ port, target: server.target, run });
        mapped = true;
        record = publishRelayReceipt(
          {
            generation,
            host,
            pid,
            processStart: ownerStart,
            port,
            serveHost,
            serveTarget: server.target,
            project: projectOf(context),
            worktree: context?.root,
            identity: identityName,
            path: destinationPath,
            publishedAt,
          },
          { home, env },
        );
      } catch (error) {
        // Nothing of a refused publication survives: not the mapping we made,
        // not a receipt, not the listener. A mapping left behind here would be
        // the worst outcome of all — a durable tailnet route to an ephemeral
        // port this process is about to release, with no receipt naming an
        // owner who could withdraw it.
        if (mapped) {
          try {
            // Never `serve off` blind: withdraw only while the mapping still
            // IS the one this attempt made. A user who re-pointed that port in
            // between owns it again, and the never-touch rule outranks tidiness.
            const still = findMapping(readServe({ run }), port);
            if (still !== null && still.target === server.target) withdrawServe({ port, run });
          } catch {
            error.fix = `${error.fix ?? ''} — then withdraw the mapping this attempt left behind with \`${withdrawCommand(port)}\``.trim();
          }
        }
        await server.close();
        throw error;
      }

      let stopped = false;
      const stop = async ({ onListenerClose } = {}) => {
        if (stopped) return;
        let failure = null;
        try {
          await withLock(
            lockPath,
            async () => {
              // Ownership is THIS publication, not merely this browser
              // generation: a same-generation reuse publishes a new listener
              // from a different process, and matching on the generation alone
              // would let the old owner withdraw the new mapping. The
              // publication identity is the recorded host spelling, port,
              // target and the owner process that bound it.
              const current = readRelayReceipt({ home, env });
              const mine =
                relayOwnedBy(current, { root: context?.root, generation }) &&
                current.port === port &&
                current.serveHost === serveHost &&
                current.serveTarget === server.target &&
                current.pid === pid &&
                current.processStart === ownerStart;
              if (!mine) return;
              withdrawServe({ port: current.port, run });
              clearRelayReceipt({ home, env, generation });
            },
            { pid, host, start, alive, generation, waitMs: LOCK_WAIT_MS },
          );
        } catch (error) {
          failure = error;
        }
        if (failure !== null) {
          // Withdrawal did not happen, so the stable Serve port may still point
          // here. Releasing the listener would hand the tailnet to whatever
          // binds that number next, so it stays bound and referenced: this
          // command does not complete normally until the mapping is withdrawn.
          // `stop` stays retryable for exactly that reason.
          failure.fix = `${failure.fix ?? ''} — the Phone relay listener is still bound; withdraw its mapping with \`${withdrawCommand(port)}\` and retry`.trim();
          throw failure;
        }
        stopped = true;
        // Withdrawal first, the listener after: the reverse would leave the
        // tailnet pointed at a port anything may bind.
        if (typeof onListenerClose === 'function') onListenerClose();
        await server.close();
      };

      return { url: relayUrl(record), port, serveHost, target: server.target, generation, stop };
    },
    { pid, host, start, alive, generation, waitMs: LOCK_WAIT_MS },
  );
}

const findingOf = error => ({
  at: error?.at ?? 'debugAs.phone',
  problem: error?.problem ?? error?.message ?? 'the Phone handoff could not be established',
  fix: error?.fix ?? 'ax debug-as doctor',
});

/**
 * The lifecycle `src/debug-as/index.mjs` calls.
 *
 * An explicit `--phone` failure throws, so no Chromium opens behind a handoff
 * the operator asked for and did not get. An automatic handoff never throws: a
 * failure is a finding, and nothing of it survives. A notifier is a
 * convenience either way — AX prints the relay URL itself, so a failed
 * delivery leaves a usable publication and a reported finding (R23-R24).
 */
export async function phoneHandoff({ context, identity, path: destinationPath, generation, explicit = false, deps = {} } = {}) {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const runAdapter = deps.runAdapter ?? defaultRunAdapter;
  const identityName = nameOf(identity);
  const identityRecord = typeof identity === 'string' ? { name: identity } : (identity ?? {});

  try {
    // Nothing touches the machine before the destination is safe.
    const problem = pathProblem(destinationPath);
    if (problem !== '') {
      throw refuse(
        `the Phone handoff path ${JSON.stringify(String(destinationPath))} ${problem}`,
        'pass --path with an absolute application path, or repair this identity\'s defaultPath',
      );
    }

    const tailnetOrigin = context?.tailnetOrigin;
    if (typeof tailnetOrigin !== 'string' || tailnetOrigin === '') {
      throw refuse(
        'this worktree has no recorded Tailscale address, so a phone callback would have nowhere to land',
        'record AX_TAILNET_URL for this worktree with `ax worktree setup`, then retry',
      );
    }

    const loaded = loadMachineConfig({ home, env });
    if (!loaded.present) {
      throw refuse(
        'this machine has no private Phone relay contract, and AX will not mint a phone session without one',
        `create ${loaded.path} with mode 600, carrying "relayPort" and "allowedTailscaleLogins" — see docs/ownership.md`,
      );
    }
    const machine = loaded.config;

    const provider = context?.contract?.phone?.provider;
    if (!provider) {
      throw refuse(
        'this project declares no Phone handoff provider',
        'declare debugAs.phone.provider in ax.config.json, or launch without --phone',
      );
    }

    const readVariable =
      deps.readVariable ??
      (name => readVariableFrom(name, { root: context.root, config: context.config, env: context.env ?? env }));

    // Authority is created here and only here — after a confirmed POST.
    const createHandoff = async ({ path: confirmedPath, login }) =>
      createProviderHandoff({
        provider,
        identity: identityRecord,
        destinationPath: confirmedPath,
        login,
        tailnetOrigin,
        root: context.root,
        readVariable,
        allowedHosts: machine.allowedSupabaseHosts,
        fetchImpl: deps.fetchImpl,
        runAdapter,
      });

    // R24: a later identical invocation retries the notification against the
    // LIVE browser and the LIVE publication. Rewiring Serve here would replace
    // a working mapping and invalidate the URL AX already printed and
    // notified, so an owned, live, same-generation publication is reused as it
    // stands — and this process, which owns nothing of it, withdraws nothing.
    const held = readRelayReceipt({ home, env });
    const liveBrowser = (() => {
      try {
        const answer = (deps.readReceipt ?? (root => readBrowserReceipt(root)))(context.root);
        return answer?.state === 'live' && answer.receipt?.generation === generation;
      } catch {
        return false;
      }
    })();
    /** The mapping must still BE that publication, or its URL leads nowhere. */
    const mappedAsHeld = () => {
      if (held === null) return false;
      try {
        const mapping = findMapping(readServe({ run: deps.run }), held.port);
        return (
          mapping !== null &&
          !mapping.funnel &&
          mapping.host === held.serveHost &&
          mapping.target === held.serveTarget
        );
      } catch {
        return false;
      }
    };
    const reusable =
      liveBrowser &&
      relayOwnedBy(held, { root: context.root, generation }) &&
      relayOwnership(held, {
        host: deps.host ?? hostname(),
        alive: deps.alive ?? pidAlive,
        start: deps.start ?? processStartOf,
      }) === 'live' &&
      mappedAsHeld();
    let session = null;
    let url;
    if (reusable) {
      url = relayUrl(held);
    } else {
      session = await startRelay({
        context: {
          root: context.root,
          // `context.name` is the IDENTITY by contract, so the page's worktree
          // label comes from the worktree itself.
          name: context.worktreeName ?? basename(context.root),
          project: projectOf(context),
        },
        generation,
        identity: identityName,
        path: destinationPath,
        machine,
        createHandoff,
        readReceipt: deps.readReceipt,
        home,
        env,
        host: deps.host,
        pid: deps.pid,
        processStart: deps.processStart,
        alive: deps.alive,
        start: deps.start,
        run: deps.run,
        output: deps.output,
      });
      url = session.url;
    }

    const delivery = await notify({
      machine,
      intent: {
        project: projectOf(context),
        worktree: context.root,
        identity: identityName,
        path: destinationPath,
        generation,
      },
      url,
      runAdapter,
      cwd: context.root,
    });

    return {
      published: true,
      url,
      notified: delivery.delivered,
      finding: delivery.finding,
      session,
    };
  } catch (error) {
    if (explicit) throw error;
    return { published: false, url: null, notified: false, finding: findingOf(error), session: null };
  }
}
