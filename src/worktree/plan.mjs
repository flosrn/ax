// What a worktree SHOULD be — computed once, with no access to the machine.
//
// This module is the answer to the most expensive bug class in the Bash version
// it replaces. There, setup decided a worktree's port, URL mode and Supabase
// block while provisioning it, and the doctor decided the same things again,
// separately, to check them. Two derivations of one rule drift, and they did:
// once on dotenv precedence, once on the recorded-flag asymmetry. Each time the
// doctor reported a healthy worktree as broken, or worse, the reverse.
//
// So the rule lives here exactly once, as a pure function. `setup` calls it and
// WRITES the result. `doctor` calls it with the same inputs and COMPARES. A
// disagreement between them is now impossible to express: there is only one
// derivation left, and the sole remaining question is whether the files match
// it.
//
// Purity is what buys that, with one honest limit. Everything that has to look
// at the machine — a proxy's routing table, the tailnet, Docker, git — is probed
// by the caller and arrives as data, so this function is callable with plain
// objects and testable without a container. The exception is the port scan: an
// allocation asks about up to nine hundred dev ports and forty-five database
// blocks, and collecting all of that up front would cost more than it buys, so
// `isBound` arrives as an injected probe and is called from in here.
//
// That makes the plan a function of its arguments AND of the machine at one
// moment. Two guarantees follow, and they are the ones the comparison needs:
// the probe answers each port once per run (`probes.portProbe`), so a single
// plan is internally consistent; and a value a checkout has already RECORDED is
// never re-decided, so setup and doctor minutes apart still agree about every
// provisioned worktree. An unprovisioned one is the only case where two runs can
// legitimately differ, and the doctor reports it as unrecorded rather than as a
// mismatch.

import { SUPABASE_LABEL, blockPorts, envKeys, recordedClaim, resolveOffset, resolveProjectId } from './supabase.mjs';
import { planUrls } from './addressing.mjs';
import { resolvePort } from './ports.mjs';

/** The one prefix tooling-private keys carry, in every project. */
import { join } from 'node:path';

export const PREFIX = 'AX_';

/**
 * Block labels are declared once because the plan that emits a block and the
 * apply steps that write or ERASE it must agree. The Supabase label lives in
 * supabase.mjs beside the key set it labels (`envKeys`); the runtime label has
 * no writer outside this plan, so it stays here.
 */
export const RUNTIME_LABEL = 'Worktree runtime';

/**
 * Tooling-private env keys carry one prefix, `AX_`, in every project.
 *
 * The Bash used the project's own name (`OFMCHAT_*`), which is why this tooling
 * could not be lifted out of it without a rename in fifteen places. Keys the
 * app or a framework owns — PORT, BASE_URL, SUPABASE_URL — keep their names:
 * they are not ours to choose.
 */
export const KEYS = {
  directUrl: `${PREFIX}DIRECT_URL`,
  tailnetUrl: `${PREFIX}TAILNET_URL`,
  useProxy: `${PREFIX}USE_PROXY`,
  supabaseOffset: `${PREFIX}SUPABASE_OFFSET`,
  supabaseMode: `${PREFIX}SUPABASE_MODE`,
  supabaseProject: `${PREFIX}SUPABASE_PROJECT`,
};

/**
 * Keys a worktree provisioned by the Bash version still carries.
 *
 * Read-only, and read for ONE reason: a live worktree records its Supabase
 * offset, and a tool that cannot see that record scans for a "free" block,
 * finds one, and abandons seven running containers under the old project id.
 * Ignoring these keys is not a clean cutover, it is a leak.
 *
 * `setup` writes only `KEYS`, so a worktree stops carrying the old names the
 * first time it is re-provisioned. Delete this map once no checkout does.
 */
export const LEGACY_KEYS = {
  [KEYS.supabaseOffset]: 'OFMCHAT_SUPABASE_OFFSET',
  [KEYS.directUrl]: 'OFMCHAT_DIRECT_URL',
  [KEYS.useProxy]: 'OFMCHAT_USE_PORTLESS',
};

/** The env keys a plan needs to read before it can be computed. */
export const RECORDED_KEYS = ['PORT', KEYS.supabaseOffset, KEYS.supabaseProject, KEYS.useProxy, 'PORTLESS_NAME', 'PORTLESS_PORT'];

/**
 * Read every recorded key, preferring the current name and falling back to the
 * legacy one. Returns `{ values, legacy }` so a caller can report which keys
 * are still on their old name instead of silently depending on them.
 *
 * `readLegacy` defaults to `read` but exists to be narrower: the legacy names
 * are worth honouring when a WORKTREE recorded them, and pure noise when they
 * merely happen to be exported in the ambient shell. Reading them from the
 * files only means running `ax` in an unrelated repository, from a terminal
 * that once sourced the old tooling, does not report a migration that is not
 * happening.
 */
export function readRecorded(keys, read, readLegacy = read) {
  const values = {};
  const legacy = [];

  for (const key of keys) {
    const current = read(key);
    if (current !== undefined && current !== '') {
      values[key] = current;
      continue;
    }

    const older = LEGACY_KEYS[key];
    if (!older) continue;

    const value = readLegacy(older);
    if (value !== undefined && value !== '') {
      values[key] = value;
      legacy.push({ key, from: older });
    }
  }

  return { values, legacy };
}

/**
 * @param identity  from `worktree/identity.mjs`
 * @param config    the loaded `ax.config.json`
 * @param recorded  values already written in this worktree's env files
 * @param probes    what the machine answered: `{ isBound, proxy, tailnet, database }`
 */
export function planWorktree({ identity, worktreePath, config, recorded = {}, probes = {} }) {
  const log = [];
  const { isBound = () => false, proxy = {}, tailnet = {}, database = {} } = probes;

  const port = resolvePort({
    identity,
    band: config.ports.dev,
    reserved: config.ports.reserved,
    recorded: recorded.PORT,
    isBound,
  });

  log.push(
    port.source === 'recorded'
      ? `port ${port.port} kept — already recorded for this worktree`
      : `port ${port.port} allocated (${port.source})${identity.issue ? ` from issue #${identity.issue}` : ''}`,
  );

  const urls = planUrls({
    worktreePath,
    branch: identity.branch,
    port: port.port,
    proxy,
    tailnet,
  });
  log.push(...urls.log);

  const supabase = planSupabase({ identity, worktreePath, config, recorded, isBound, database, log });

  return {
    identity,
    worktreePath,
    port,
    urls,
    supabase,
    env: envWrites({ config, port, urls, supabase, proxy }),
    log,
  };
}

/**
 * Isolated or shared, and on which port block.
 *
 * Sharing is the default because isolation costs seven containers and about a
 * gigabyte. A worktree that never touches the database has no reason to pay
 * that. The decision is reversible in one direction only, and cheaply: the
 * guard in front of the Supabase CLI promotes a shared worktree the first time
 * it runs a command that would actually write.
 */
function planSupabase({ identity, worktreePath, config, recorded, isBound, database, log }) {
  const shared = { mode: 'shared', offset: 0, projectId: undefined, ports: undefined };

  // The primary checkout OWNS the shared stack: its committed config.toml is
  // what every other checkout falls back to, and the whole team's connection
  // strings point at it. Isolating it would strand every worktree that shares.
  if (database.primary) {
    log.push('supabase shared — this is the primary checkout, which owns that stack');
    return shared;
  }

  // An ALREADY-isolated worktree stays isolated, whatever the diff looks like
  // now. Its containers are running and its env points at them, so downgrading
  // on the strength of a diff that no longer touches the database would erase
  // the endpoints of a live stack and leave it running under a project id
  // nothing references. Sharing is only the default for a checkout that never
  // claimed a block.
  // The claim is durable in TWO places, and the env file is the fragile one: a
  // `git clean -xdf` takes it while the containers keep running. So an isolated
  // `config.toml` — tracked, and rewritten in place — counts as a claim too.
  const relativePath = join(config.apps.web, 'supabase', 'config.toml');
  const onDisk = recordedClaim({ cwd: worktreePath, relativePath, base: config.ports.supabaseBase });
  const claimed = /^[1-9][0-9]*$/.test(String(recorded[KEYS.supabaseOffset] ?? '')) || onDisk !== undefined;

  if (database.touches === false && !claimed) {
    log.push('supabase shared — this worktree does not touch the database');
    return shared;
  }

  if (database.startable === false) {
    log.push(`supabase shared — ${database.reason ?? 'the stack cannot start here'}`);
    return shared;
  }

  const offset = resolveOffset({
    identity,
    recorded: recorded[KEYS.supabaseOffset],
    cwd: worktreePath,
    relativePath,
    base: config.ports.supabaseBase,
    step: config.ports.step,
    maxSlot: config.ports.maxSlot,
    isBound,
  });

  // The project id is the ONLY handle the container runtime gives on this
  // stack, and deriving it from the current branch means a `git branch -m`
  // mints a second one while the first is still running — seven containers
  // nothing can then address. So the id recorded for this worktree, or the one
  // its own config.toml carries, wins over a fresh derivation.
  const project = resolveProjectId({
    identity,
    prefix: `${config.project.name}-`,
    recorded: recorded[KEYS.supabaseProject],
    cwd: worktreePath,
    relativePath,
    base: config.ports.supabaseBase,
  });
  const id = project.projectId;

  if (project.conflict) log.push(`WARN:${project.conflict}`);
  log.push(
    offset.source === 'recorded' || offset.source === 'config'
      ? `supabase isolated — keeping block +${offset.offset} (${id}, from ${offset.source})`
      : `supabase isolated — block +${offset.offset} (${id})`,
  );

  return {
    mode: 'isolated',
    offset: offset.offset,
    source: offset.source,
    projectId: id,
    ports: blockPorts(config.ports.supabaseBase, offset.offset),
  };
}

/**
 * The exact env blocks that record this plan, as data.
 *
 * Two blocks rather than one, each labelled, because they change on different
 * schedules: the URL layer moves when a port or a proxy route moves, the
 * Supabase layer only on promotion or teardown. Rewriting one must not churn
 * the other — a churned file is a file whose diff nobody reads.
 *
 * The Supabase half is not spelled out here: `supabase.envKeys()` owns that key
 * set, because the promotion path writes the same keys and a second spelling of
 * them is the drift this module exists to prevent. It is also where the reason
 * for `127.0.0.1` over `localhost` lives — on a host that resolves localhost to
 * ::1 first, the container listens on IPv4 only and every request fails with
 * ECONNREFUSED.
 */
function envWrites({ config, port, urls, supabase, proxy = {} }) {
  const runtime = {
    PORT: String(port.port),
    BASE_URL: urls.publishedUrl,
    PLAYWRIGHT_BASE_URL: urls.publishedUrl,
    NEXT_PUBLIC_SITE_URL: urls.publishedUrl,
    [KEYS.directUrl]: urls.directUrl,
    // `'1'` when the proxy IS the route, and the key is left alone otherwise —
    // never written as `'0'` because the layer happened to be unreachable.
    //
    // `'0'` means "this worktree opted out", and the reader treats it as
    // permanent. Writing it for a transient probe failure (binary not yet on
    // PATH, proxy mid-reinstall, route table momentarily empty) latches that
    // one moment forever: the published URL drops to a localhost port, the
    // worktree rejoins the primary's cookie jar, and every later run agrees
    // because the flag now says it was deliberate. Only an explicit opt-out
    // writes that value.
    ...(urls.mode === 'proxy' ? { [KEYS.useProxy]: '1' } : proxy.enabled === false ? { [KEYS.useProxy]: '0' } : {}),
    // A second address for the same app, for a phone on the tailnet. Recorded
    // only when there is one, so a machine with a sleeping daemon does not
    // publish a hostname nothing resolves.
    ...(urls.tailnetUrl ? { [KEYS.tailnetUrl]: urls.tailnetUrl } : {}),
    // The proxy's OWN keys, under its own names, recorded because the process
    // that starts the dev server has to reach the same route this plan chose.
    // Left unrecorded, that process falls back to its own defaults — which
    // agree here by luck and stop agreeing the moment a project moves its
    // proxy off the default port. The values come from the probe that asked the
    // proxy, never from a second composition.
    ...(urls.mode === 'proxy' && proxy.name ? { PORTLESS_NAME: proxy.name } : {}),
    ...(urls.mode === 'proxy' && proxy.port ? { PORTLESS_PORT: String(proxy.port) } : {}),
  };

  const writes = [{ file: `${config.apps.web}/.env.local`, label: RUNTIME_LABEL, keys: runtime }];

  // Shared is not "write nothing": a checkout that WAS isolated still records
  // the endpoints of a stopped stack, and the app would keep dialling ports
  // nothing answers on. The plan says so explicitly, so applying it converges
  // rather than accumulating.
  if (supabase.mode !== 'isolated') {
    writes.push({ file: `${config.apps.web}/.env.local`, label: SUPABASE_LABEL, remove: true });
    return writes;
  }

  writes.push({
    file: `${config.apps.web}/.env.local`,
    label: SUPABASE_LABEL,
    keys: { [KEYS.supabaseMode]: 'isolated', ...envKeys({ ports: supabase.ports, offset: supabase.offset, projectId: supabase.projectId, envPrefix: PREFIX }) },
  });

  return writes;
}
