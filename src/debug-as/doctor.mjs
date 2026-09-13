// The read-only half of this feature: every layer a Role browser needs, graded
// without touching one.
//
// WHY IT STARTS NOTHING. `doctor` is one of the three agent-safe surfaces
// (R10): an agent runs it to find out why `drive` refused, and an agent that
// launched Chromium, started the project server, ran the Debug adapter or asked
// the auth provider for a link while "just checking" would mint authority for a
// diagnosis. So every fact here is READ — a resolved package, a bounded GET
// against an address already recorded, a receipt, a Serve mapping — and the
// commands that would create something are named as repairs instead.
//
// WHY "OFF" IS NOT "BROKEN". Phone handoff is independently optional per
// project and per machine (R14, R29). Three states look alike from a distance
// and must never be reported alike:
//
//   NOT ADOPTED   the project declared no `phone` section — the machine
//                 contract is not read AT ALL, because there is nothing on this
//                 machine that could be wrong for a feature nobody asked for.
//   DISABLED      the project adopted it and this machine has no private
//                 contract — a note and the file to create, never a failure.
//   MALFORMED     the file exists and its ownership, mode or fields are wrong —
//                 a failure, because something IS broken, and the phone domain
//                 stops there rather than grading a relay against a contract
//                 AX refused to parse.
//
// WHY THE SWEEP RUNS BEFORE THE READ. A Serve mapping outlives the process that
// published it, and the port it forwards to is ephemeral: once that owner is
// dead, the mapping points the tailnet at whatever binds that port next (R17).
// So a proven-dead owner's mapping is withdrawn HERE, before this verb reads
// the Serve state — reading first would report a mapping that is about to
// vanish, and leaving it would keep a tailnet-reachable hole open. Every
// mapping that survives the sweep and belongs to no live relay is a failure
// whose repair is the exact `tailscale serve --https=<port> off`, because only
// the operator can clear a mapping AX cannot prove it owns.
//
// EVERY EMISSION GOES THROUGH `./emit.mjs` (R35). A refusal here carries an
// adapter's message, a provider host and a resolved variable name; the module
// boundary redacts the secret shapes and the registered values, and importing
// `src/log.mjs` directly would put that redaction one import out of reach.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { checkLive, readFlag, readVariable } from './address.mjs';
import { loadStorageState } from './auth-state.mjs';
import { guiRefusal, resolvePlaywright } from './browser.mjs';
import { emit } from './emit.mjs';
import { loadMachineConfig } from './machine-config.mjs';
import { providerHost } from './provider.mjs';
import { BROWSER_RECEIPT, ignoredReceipt, probeCdp, readReceipt } from './receipt.mjs';
import { readRelayReceipt, relayOwnedBy, sweepDeadRelay } from './relay-receipt.mjs';
import { findMapping, readServe, withdrawCommand } from './tailscale.mjs';

/**
 * The first executable `name` on PATH, or `null`.
 *
 * Deliberately not a spawn: `command -v` on a missing binary costs a process
 * and, on a machine where PATH names a directory that hangs (an unmounted
 * network share), it costs the whole diagnosis. A stat answers the only
 * question this file asks — is there something to delegate to — and `drive`
 * owns actually running it.
 */
export function lookupOnPath(name, env = process.env) {
  if (name.includes('/')) return existsSync(name) ? name : null;
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).mode & 0o111) return candidate;
    } catch {
      // A PATH entry that does not exist is ordinary, not a finding.
    }
  }
  return null;
}

/**
 * Diagnose this worktree's debug capability. Returns the number of findings,
 * which is the exit code: zero means every layer answered.
 *
 * `context` is what `./index.mjs` composed — root, config, contract, env and
 * the addresses already READ (never probed). Every runtime reader is an
 * injected dep so this file can be exercised against a machine it does not
 * have: no GUI, no Playwright, no tailnet.
 */
export async function doctor(context, deps = {}) {
  const { root, config, contract, env = process.env, addresses = null } = context;
  const {
    platform = process.platform,
    guiRefusal: gui = guiRefusal,
    resolvePlaywright: playwrightOf = resolvePlaywright,
    exists = existsSync,
    lookup = lookupOnPath,
    checkLive: liveness = checkLive,
    loadStorageState: artifactOf = loadStorageState,
    ignoredReceipt: receiptIgnored = target => ignoredReceipt(target, {}),
    readReceipt: receiptOf = target => readReceipt(target, {}),
    probeCdp: cdp = port => probeCdp(port, {}),
    readFlag: flagOf = readFlag,
    readVariable: variableOf = readVariable,
    loadMachineConfig: machineOf = () => loadMachineConfig({ env }),
    providerHost: hostOf = providerHost,
    sweepDeadRelay: sweep = () => sweepDeadRelay({ env }),
    readServe: serveOf = () => readServe({}),
    findMapping: mappingOf = findMapping,
    withdrawCommand: withdrawal = withdrawCommand,
    readRelayReceipt: relayOf = () => readRelayReceipt({ env }),
    relayOwnedBy: ownedBy = relayOwnedBy,
  } = deps;

  emit.section(`ax debug-as doctor — ${root}`);
  let failures = 0;
  const fail = (message, command) => {
    emit.bad(message);
    emit.fix(command);
    failures += 1;
  };

  // The contract itself. `ax doctor` grades what the FILE declares; by the time
  // this verb runs, `./index.mjs` has already loaded it, so a null contract here
  // means the caller reached this function past a refusal — reported rather
  // than assumed away.
  if (!contract) {
    fail('this checkout declares no usable debug-session contract, so there is nothing on this machine to diagnose', 'ax doctor');
    return failures;
  }
  const identities = Object.values(contract.identities);
  emit.ok(`contract: ${identities.length} Debug identit${identities.length === 1 ? 'y' : 'ies'} (${identities.map(identity => identity.name).join(', ')})`);

  // REGISTERED BEFORE ANY EMISSION, and that ordering is the whole point.
  // `src/redact.mjs` recognizes SHAPES, and a shape only catches what it can
  // pattern: measured on this verb's own tests, a reader that failed with
  // `adapter wrote apikey: sb_secret_…` inside prose reached the terminal
  // whole, because the `apikey:` rule anchors at the start of a line and a
  // service-role key has no self-describing form. The values this contract
  // names are therefore resolved once, here, and registered — every later
  // finding, including one composed by a reader that has never heard of this
  // feature, is scrubbed on its way out (R27, R35).
  //
  // The value is resolved and NEVER printed, never compared, never passed to a
  // child: registration is its only use in this file.
  if (contract.phone?.provider?.type === 'supabase') {
    const resolvedKey = variableOf(contract.phone.provider.serviceRoleKeyEnv, { root, config, env });
    if (typeof resolvedKey === 'string' && resolvedKey !== '') emit.addSecrets([resolvedKey]);
  }

  // 1. The machine: a display, a Playwright, a Chromium, a driver.
  const display = gui({ platform, env });
  if (display) fail(display.problem, display.fix);
  else emit.ok('local GUI available — a Role browser is a visible window by definition');

  let playwright = null;
  try {
    playwright = playwrightOf({ root, playwrightDir: contract.browser.playwrightDir });
  } catch (error) {
    fail(error.message, error.fix ?? `declare a package that pins Playwright in "debugAs.browser.playwrightDir"`);
  }
  if (playwright !== null) {
    emit.ok(`Playwright ${playwright.version} from ${playwright.from} in ${contract.browser.playwrightDir} (${Object.keys(playwright.devices).length} devices for --device)`);
    // The version resolving and the browser being downloaded are two different
    // machines' states: a fresh clone has the package and no binary, and the
    // repair for that is not the repair for a missing package.
    const binary = playwright.chromium.executablePath();
    if (exists(binary)) emit.ok(`Chromium ${binary}`);
    else fail(`Playwright ${playwright.version} resolves and its Chromium is not installed at ${binary}`, `npx --prefix ${contract.browser.playwrightDir} playwright install chromium`);
  }

  const driver = lookup('agent-browser', env);
  // NOT AN INSTALL COMMAND. Nothing in this repository or the plan establishes
  // how `agent-browser` is installed on a given machine, and a guessed
  // `npm i -g …` is a repair that can be wrong — which is worse than one that
  // is general. AX never installs it (R12), so the repair states the condition
  // that has to hold, and the reader owns their own package manager.
  if (driver === null) fail('agent-browser is not on PATH — "ax debug-as drive" delegates to it, and AX never installs it', 'install agent-browser and put it on PATH, then re-run this verb');
  else emit.ok(`agent-browser ${driver}`);

  // 2. The application, at the address this worktree RECORDED. A refusal from
  //    that read is reported with its own repair, and liveness is then not
  //    measured: there is no address to request, and inventing one is exactly
  //    the discovery this feature refuses to do (R5).
  for (const refusal of addresses?.refusals ?? []) fail(`${refusal.at} ${refusal.problem}`, refusal.fix);
  const origin = addresses?.browserOrigin ?? context.origin ?? null;
  if (origin === null) {
    emit.note('no local application address was read here, so liveness and authentication artifacts are NOT MEASURED');
  } else {
    try {
      const live = await liveness({ origin, contract });
      emit.ok(`application answers at ${origin} (HTTP ${live.status})`);
    } catch (error) {
      // A DEFAULT REPAIR, because `.fix` is only guaranteed on this reader's
      // own refusals: a DNS or TLS error arrives as an ordinary Error, and a
      // finding with `undefined` under its arrow is the unactionable state
      // `src/log.mjs` exists to prevent.
      fail(error.message, error.fix ?? contract.browser.start.join(' '));
    }
  }

  // 3. The adapter: named and located, never executed. Running it is how a
  //    diagnosis would mint a session; naming its argv is how an operator
  //    learns what would run.
  const prepare = contract.browser.prepare;
  if (prepare === null) {
    emit.note('no Debug adapter declared — every identity here is unauthenticated, so nothing refreshes an artifact');
  } else {
    const command = prepare.command.join(' ');
    const argv0 = prepare.command[0];
    const located = argv0.includes('/') ? (exists(join(root, argv0)) ? join(root, argv0) : null) : lookup(argv0, env);
    if (located === null) fail(`the Debug adapter's command starts with "${argv0}", which is neither a file in this worktree nor on PATH`, `fix "debugAs.browser.prepare.command" in ax.config.json`);
    else emit.ok(`Debug adapter: ${command} (${prepare.timeoutSeconds}s deadline) — located, never run by this verb`);
  }

  // 4. The authentication artifacts, each proved private, ignored, contained
  //    and local by the same reader the launch uses — so a doctor cannot pass a
  //    state the launch would refuse. A MISSING browser origin inside the
  //    artifact is the adapter's job, not a refusal (R9).
  if (origin !== null) {
    for (const identity of identities.filter(identity => identity.authenticated)) {
      try {
        const artifact = await artifactOf({ root, relativePath: identity.storageState, browserOrigin: origin, addresses });
        if (artifact.refreshNeeded) {
          emit.note(`${identity.name}: ${identity.storageState} carries no entry for ${origin} — stale, which the adapter repairs`);
          emit.fix(prepare === null ? `declare "debugAs.browser.prepare.command"` : prepare.command.join(' '));
        } else {
          emit.ok(`${identity.name}: ${identity.storageState} is private, git-ignored and scoped to this checkout's own addresses`);
        }
      } catch (error) {
        fail(error.message, error.fix ?? (prepare === null ? 'declare "debugAs.browser.prepare.command" in ax.config.json' : prepare.command.join(' ')));
      }
    }
  }

  // 5. The receipt. Its IGNORE status is graded before its content, because a
  //    receipt naming a live process and a loopback CDP port is state that must
  //    never reach a commit — and `ax worker release` reads an unignored file
  //    as uncommitted work.
  if (receiptIgnored(root)) emit.ok(`${BROWSER_RECEIPT} is ignored by git`);
  else fail(`${BROWSER_RECEIPT} is not ignored by git — it records a live process, a port and a generation`, 'ax init');

  const receipt = receiptOf(root);
  if (receipt.state === 'absent') {
    emit.note('no Role browser receipt in this worktree — nothing is running here');
  } else if (receipt.state === 'malformed' || receipt.state === 'unsafe') {
    fail(`${receipt.refusal.at} ${receipt.refusal.problem}`, receipt.refusal.fix);
  } else if (receipt.state === 'live') {
    const port = receipt.receipt.cdpPort;
    const probe = await cdp(port);
    if (probe.alive) emit.ok(`live Role browser "${receipt.receipt.identity}" on loopback CDP port ${port}`);
    else {
      emit.note(`the receipt for "${receipt.receipt.identity}" claims loopback CDP port ${port} and nothing answers there (${probe.why}) — "ax debug-as drive" refuses this state`);
      emit.fix(`ax debug-as --as ${receipt.receipt.identity}`);
    }
  } else if (receipt.state === 'dead') {
    emit.note(`a stale receipt from "${receipt.receipt.identity}" — its owner is proven dead, so the next launch replaces it`);
    emit.fix(`ax debug-as --as ${receipt.receipt.identity}`);
  } else {
    // NAMED, and never acted on from here. This host cannot disprove the owner
    // — another machine's record, or a live pid whose start time is unreadable
    // — and an unverifiable owner is precisely the state that must not
    // authorize a rival launch (R6) or a withdrawal. So the recorded host is
    // made visible in the finding, and the repair is the one RUNNABLE command
    // that reports the same unverifiable owner as a Verdict an agent can read.
    const owner = receipt.receipt?.host ?? 'an unrecorded host';
    emit.note(`the receipt for "${receipt.receipt?.identity ?? 'an unknown identity'}" names ${owner}, which this machine cannot disprove — spared, never swept, and "ax debug-as drive" refuses it`);
    emit.fix('ax debug-as status');
  }

  // 6. The optional half. NOT ADOPTED ends the report here, and reads nothing
  //    about this machine: a browser-only project must pass on a machine with
  //    no relay contract, no allowlist and no Tailscale at all.
  if (contract.phone === null) {
    emit.note('Phone handoff — NOT ADOPTED by this project, so no machine contract, relay or Serve mapping is read');
    return failures;
  }

  emit.section('phone handoff');
  const flag = flagOf(contract.phone.optInEnv, { root, config, env });
  if (flag.problem !== '') fail(`${flag.at} ${flag.problem}`, flag.fix);
  else emit.note(`${contract.phone.optInEnv} resolves to ${flag.value === undefined ? 'nothing — automatic handoff stays off until it is set' : String(flag.value)}`);

  let machine;
  try {
    machine = machineOf();
  } catch (error) {
    fail(error.problem ? `${error.at ?? 'the machine Phone contract'} ${error.problem}` : error.message, error.fix);
    return failures;
  }
  if (!machine.present) {
    emit.note(`Phone handoff is DISABLED on this machine — ${machine.path} does not exist, and a project that adopted the capability on a machine that has not enabled it is not broken`);
    emit.fix(`write ${machine.path} with {"relayPort": 1300, "allowedTailscaleLogins": ["you@example.com"]}, mode 600`);
    return failures;
  }
  emit.ok(`machine Phone contract ${machine.path}: relay port ${machine.config.relayPort}, ${machine.config.allowedLogins.length} allowed login(s)`);

  // The resolved provider HOST, never its key: the value behind
  // `serviceRoleKeyEnv` is registered as a secret elsewhere and would be
  // scrubbed here anyway, but the finding never needs it. A host outside the
  // allowlist is the refusal the provider would make at handoff time, reported
  // before anyone waits for it (R21).
  const provider = contract.phone.provider;
  if (provider.type === 'supabase') {
    // A resolver refusal is a DIAGNOSABLE state, not the end of the report:
    // the Serve mapping below can be the very thing that needs withdrawing,
    // and aborting here would hide it behind a provider misconfiguration.
    let resolved;
    try {
      resolved = hostOf({ provider, readVariable: name => variableOf(name, { root, config, env }), allowedHosts: machine.config.allowedSupabaseHosts });
    } catch {
      // The thrown message is discarded on purpose: it is composed from the
      // value behind `urlEnv`, which is the one string in this branch nothing
      // guarantees has been registered as a secret. The classification below
      // says everything an operator needs and cannot carry a value.
      resolved = { host: null, port: null, scheme: null, allowed: false, reason: 'malformed' };
    }
    if (resolved.allowed) {
      emit.ok(`provider host ${resolved.scheme}://${resolved.host}:${resolved.port} (${resolved.reason}, from ${provider.urlEnv})`);
    } else {
      // The classification arrives as a TOKEN, and a token is not a finding an
      // operator can act on. Each one is rendered where the repair is written,
      // so the two cannot disagree: an unresolvable variable is repaired by
      // setting it, and a real host outside the allowlist by the allowlist.
      const named = resolved.host === null || resolved.host === undefined ? `nothing AX can read from ${provider.urlEnv}` : `${resolved.host}:${resolved.port}`;
      const problem =
        resolved.reason === 'unresolved'
          ? `${provider.urlEnv} is set nowhere AX reads — the process environment, ${config.apps.web}/.env.local, then the root .env.local`
          : resolved.reason === 'malformed'
            ? `${provider.urlEnv} does not parse as a URL`
            : `is neither a loopback literal nor an entry of "allowedSupabaseHosts" on this machine, and a suffix match is never a match`;
      const repair =
        resolved.reason === 'unresolved' || resolved.reason === 'malformed'
          ? `set ${provider.urlEnv} to this project's local Supabase URL`
          : `add "${resolved.host}:${resolved.port}" to "allowedSupabaseHosts" in ${machine.path}, or point ${provider.urlEnv} at a loopback address`;
      fail(`provider host ${named} ${problem}`, repair);
    }
  } else {
    emit.note(`command provider: ${provider.command.join(' ')} — located nowhere and run nowhere by this verb`);
  }

  // THE SWEEP IS A WRITE — the only one this verb makes, and the one R17 puts
  // here: a proven-dead owner's mapping is withdrawn before the Serve state is
  // read. It reaches `tailscale`, so it can refuse for exactly the reason the
  // read below can, and an unhandled rejection would turn a diagnosis into a
  // stack trace with no repair in it.
  let swept;
  try {
    swept = sweep();
  } catch (error) {
    fail(error.message, error.fix ?? withdrawal(machine.config.relayPort));
    return failures;
  }
  if (swept.withdrawn) emit.note(`withdrew the Serve mapping of a proven-dead relay owner (${swept.reason}) before anything else could bind that port`);

  let serve;
  try {
    serve = serveOf();
  } catch (error) {
    fail(error.message, error.fix ?? 'install the tailscale CLI and log this machine into your tailnet');
    return failures;
  }
  const port = machine.config.relayPort;
  const mapping = mappingOf(serve, port);
  if (mapping === null) {
    emit.note(`no Serve mapping on ${port} — the relay publishes one only while a live Role browser owns it`);
    return failures;
  }
  if (mapping.funnel) {
    fail(`the Serve mapping on ${port} is Funnel-exposed — the Phone relay is tailnet-only and will not take a publicly reachable port`, withdrawal(port));
    return failures;
  }
  // A malformed relay receipt is already `null` — never an owner. An
  // UNREADABLE one is a different machine state, and it lands on the same
  // answer as "nobody owns this": the mapping stays reachable and only the
  // operator can clear it.
  let record = null;
  try {
    record = relayOf();
  } catch (error) {
    fail(error.message, error.fix ?? withdrawal(port));
    return failures;
  }
  const owned = record !== null && record.port === mapping.port && record.serveTarget === mapping.target;
  if (!owned) {
    fail(`the Serve mapping on ${port} → ${mapping.target} belongs to no live Phone relay — it forwards the tailnet to whatever binds that local port next`, withdrawal(port));
  } else if (ownedBy(record, { root, generation: record.generation })) {
    emit.ok(`the Phone relay on ${port} is this worktree's, for "${record.identity}"`);
  } else {
    emit.note(`the Phone relay on ${port} belongs to ${record.worktree} ("${record.identity}") — live, and not this worktree's to withdraw`);
  }

  return failures;
}
