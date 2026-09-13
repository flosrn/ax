// The command orders authority, it does not invent it: validate the declared
// identity and recorded addresses, establish browser ownership, then prepare
// authentication and publish. Explicit phone failure precedes Chromium; automatic
// phone failure never tears down a usable browser. All output crosses emit.mjs.
import { repoPaths, loadCheckoutConfig } from '../config.mjs';
import { loadDebugContract } from './config.mjs';
import { parseDebugArgs } from './args.mjs';
import { emit } from './emit.mjs';
import { readAddresses, readFlag, checkLive } from './address.mjs';
import { runAdapter } from './adapter.mjs';
import { loadStorageState } from './auth-state.mjs';
import { preflightBrowser, openRoleBrowser, superviseRoleBrowser } from './browser.mjs';
import { status } from './status.mjs';
import { drive } from './drive.mjs';
import { doctor } from './doctor.mjs';
import { phoneHandoff } from './relay.mjs';
import { sweepDeadRelay } from './relay-receipt.mjs';

const refuse = (message, fix = 'ax debug-as doctor') => { throw Object.assign(new Error(message), { fix }); };

export async function debugAs(argv = [], deps = {}) {
  const output = deps.output ?? emit;
  let handoff;
  try {
    const options = parseDebugArgs(argv);
    const paths = (deps.paths ?? repoPaths)(deps.cwd ?? process.cwd());
    if (!paths.root) refuse('debug-as requires a Git checkout', 'run ax debug-as from the project checkout');
    const loaded = (deps.load ?? loadCheckoutConfig)(paths);
    if (loaded.migration) refuse(loaded.migration.problem, loaded.migration.fix);
    if (!loaded.config || loaded.errors?.length) refuse('project configuration is missing or invalid', 'ax doctor');
    const { config } = loaded;
    const checked = loadDebugContract({ raw: config });
    if (!checked.adopted) refuse('this project has not adopted debug sessions', 'declare debugAs.browser and debugAs.identities in ax.config.json');
    if (!checked.contract) {
      for (const finding of checked.refusals) output.refuse(`${finding.at}: ${finding.problem}`, finding.fix);
      return 1;
    }
    const contract = checked.contract;
    const context = { root: paths.root, config, contract, env: deps.env ?? process.env };
    const addresses = (deps.addresses ?? readAddresses)(context);
    Object.assign(context, { addresses, origin: addresses.browserOrigin, tailnetOrigin: addresses.tailnetOrigin });
    if (options.verb === 'doctor') return (await (deps.doctor ?? doctor)(context, deps.doctorDeps)) === 0 ? 0 : 1;
    // Status is an observation, even when no app or GUI currently exists.
    if (options.verb === 'status') return await (deps.status ?? status)(context, deps.statusDeps);
    if (options.verb === 'drive') return await (deps.drive ?? drive)(context, { identity: options.name, childArgv: options.argv }, deps.driveDeps);
    if (addresses.refusals.length) {
      for (const finding of addresses.refusals) output.refuse(`${finding.at}: ${finding.problem}`, finding.fix);
      return 1;
    }
    const identity = Object.hasOwn(contract.identities, options.name) ? contract.identities[options.name] : null;
    if (!identity) refuse(`undeclared Debug identity ${options.name}`, `choose --as from: ${Object.keys(contract.identities).join(', ')}`);
    Object.assign(context, { identity, name: options.name, path: options.path ?? identity.defaultPath });
    let wantsPhone = options.phone;
    if (!options.noPhone && !options.phone && contract.phone) {
      const flag = (deps.flag ?? readFlag)(contract.phone.optInEnv, context);
      if (flag.problem) refuse(flag.problem, flag.fix);
      wantsPhone = flag.value === true;
    }
    if (wantsPhone && (!contract.phone || !identity.phone)) {
      if (options.phone) refuse('this identity does not support Phone handoff', 'choose a phone-enabled identity or remove --phone');
      wantsPhone = false;
    }
    if (wantsPhone && (!addresses.isWorktree || !addresses.directOrigin || !addresses.tailnetOrigin)) {
      if (options.phone) refuse('Phone handoff requires a worktree with recorded direct and Tailscale addresses', 'ax worktree setup');
      output.refuse('automatic Phone handoff has no eligible worktree addresses', 'ax worktree setup');
      wantsPhone = false;
    }
    await (deps.sweep ?? sweepDeadRelay)(deps.relayDeps ?? {});
    const preflight = (deps.preflight ?? preflightBrowser)({ ...context, playwrightDir: contract.browser.playwrightDir, device: options.device, viewport: options.viewport }, deps.browserDeps);
    await (deps.live ?? checkLive)({ origin: context.origin, contract });
    const publishPhone = async (generation, explicit) => {
      if (!wantsPhone) return;
      try {
        const next = await (deps.phone ?? phoneHandoff)({ context, identity, path: context.path, generation, explicit, deps: deps.phoneDeps });
        if (next.finding) output.refuse(next.finding.problem ?? next.finding.message, next.finding.fix);
        if (next.published) {
          handoff = next.session;
          output.progress(`Phone handoff: ${next.url}`);
        }
      } catch (error) {
        if (explicit) throw error;
        output.refuse(error.message, error.fix ?? 'ax debug-as doctor');
      }
    };
    const session = await (deps.open ?? openRoleBrowser)({
      ...context, project: config.project.name, worktree: context.root,
      identity: identity.name, playwright: preflight.playwright, surface: preflight.surface,
      start: contract.browser.start,
      navigationTimeoutSeconds: contract.browser.navigationTimeoutSeconds,
    }, {
      ...deps.browserDeps,
      beforeLaunch: async ({ generation }) => {
        let storageState;
        if (identity.authenticated) {
          const prepare = contract.browser.prepare;
          // Only the project adapter can decide token freshness. Always invoke
          // it on a fresh authenticated launch, never decode tokens in AX.
          await (deps.adapter ?? runAdapter)({
            command: prepare.command, timeoutSeconds: prepare.timeoutSeconds,
            request: { operation: 'prepare', identity: identity.name, origin: context.origin, storageState: identity.storageState },
            cwd: context.root, env: context.env,
          });
          const loadedState = await (deps.storage ?? loadStorageState)({ root: context.root, relativePath: identity.storageState, browserOrigin: context.origin, addresses });
          if (loadedState.refreshNeeded) refuse('the Debug adapter did not prepare the browser origin', 'repair the Debug adapter to include the recorded browser origin');
          storageState = loadedState.state;
        }
        if (options.phone) await publishPhone(generation, true);
        return { storageState };
      },
      onPublished: async receipt => { if (!options.phone) await publishPhone(receipt.generation, false); },
      beforeReuse: async receipt => { if (options.phone) await publishPhone(receipt.generation, true); },
      onReuse: async receipt => { if (!options.phone) await publishPhone(receipt.generation, false); },
    });
    return await (deps.supervise ?? superviseRoleBrowser)(session, deps.browserDeps);
  } catch (error) {
    output.refuse(error.message, error.fix ?? 'ax debug-as doctor');
    return error.exitCode ?? 1;
  } finally {
    if (handoff?.stop) {
      try { await handoff.stop(); }
      catch (error) {
        output.refuse(error.message, error.fix ?? 'ax debug-as doctor');
        // The relay retains its listener when withdrawal fails. Do not claim
        // a successful command while that owned cleanup still needs repair.
        return 1;
      }
    }
  }
}
