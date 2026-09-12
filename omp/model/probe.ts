/**
 * READ-ONLY MODEL PROBE: what this host would actually serve, asked of the host.
 *
 * A routing decision made by the dispatcher is made on the wrong machine. The
 * dispatcher knows what a project CONFIGURED; only the target knows which of
 * those models its own resolver can name, which its authenticated list carries,
 * and which efforts each declares. All three have been wrong on a real host
 * while the config was right: a role naming a provider nobody logged into
 * there, an id that only fuzzy-matched, an effort the model does not implement.
 * So the candidate list is READ from the target, through the target's own OMP
 * resolver and facade, before anything is created anywhere.
 *
 * It is an extension because `ctx.models.resolve()`/`list()` exist only inside
 * a live session — the same code path `--model` selection uses. It resolves,
 * lists and compares; it never writes config, touches auth, selects an account
 * or mirrors quota. An unknown selector, an unconfigured role, a cyclic role
 * and an unsupported effort are REFUSALS carried in the output, never clamped
 * to a neighbouring value.
 *
 * WHY IT EXITS THE PROCESS. The probe must cost no inference. `ctx.shutdown()`
 * is the documented way to ask for that and it IS called — but in print mode
 * the host wires `onShutdown` to a no-op (`modes/runtime-init.ts`: "rpc mode
 * signals its loop; print mode is a no-op"), so the request is silently dropped
 * and the turn would run. `session_start` is awaited before
 * `session.prompt(...)` in that same mode, so exiting from the handler is what
 * makes "no inference" a fact rather than an intention. There is nothing to
 * flush but the one line, which is written synchronously first.
 */

import { writeSync } from 'node:fs';

// The wire vocabulary and the selector split come from the module the
// dispatcher side shares (src/worker/model-policy.mjs, through alias.ts); the
// effort verdict comes from the runtime half that will re-check it. One source
// each, so a probe cannot vouch for what enforcement then refuses.
import { PROBE_PREFIX, SELECTORS_ENV } from '../../src/worker/model-policy.mjs';
import { modelRoleOf, splitThinking } from './alias.ts';
import { effortSupported, modelIdentity } from './routing.ts';

export { PROBE_PREFIX, SELECTORS_ENV };

/**
 * How deep role expansion may nest before it is refused.
 *
 * Roles expand into roles (`@worker-balanced` → `@default,…`), so the expansion
 * is a graph the operator edits by hand. A cycle is caught exactly by its trail;
 * this bound catches the other shape — a long legal chain that is nonetheless a
 * config nobody meant to write. Both are refusals, never a truncated list
 * presented as complete.
 */
export const MAX_EXPANSION_DEPTH = 8;

/** One candidate, exactly as the contract's transport carries it. */
export interface ProbeCandidate {
  /** `provider/id:effort`, or `provider/id` when the candidate declares no effort. */
  selector: string;
  /** `provider/id` as the host's own resolver named it. */
  model: string;
  /** The effort this candidate carries, never one invented for it. */
  effort: string | null;
  available: boolean;
  /** Why it is unavailable, or a note about how a supported effort is served. */
  reason?: string;
}

export interface ProbeResult {
  /** Ordered as configured. Order IS the preference; nothing here reorders it. */
  candidates: ProbeCandidate[];
  /** Selector-level refusals: nothing about them could be probed at all. */
  errors: string[];
}

/** One expanded, exact request: a concrete spec plus the effort it inherited or declared. */
export interface ProbeRequest {
  /** The text this request came from, for a refusal that names what the operator wrote. */
  requested: string;
  /** A concrete model spec — `provider/id` or a bare id. Never an `@alias`. */
  spec: string;
  effort: string | null;
  /** The role trail it was expanded through, outermost first. Empty for a direct spec. */
  via: string[];
}

/** The host slice a probe reads. All three are read-only. */
export interface ProbeDeps {
  /** `ctx.models.list()` — the authenticated set `--model` selection sees. */
  list(): readonly unknown[];
  /** `ctx.models.resolve(spec)` — the runtime's own resolver, fuzziness included. */
  resolve(spec: string): unknown;
  /** `pi.pi.settings.getModelRole(role)` — the RAW configured spec, suffixes intact. */
  configuredRole(role: string): string | undefined;
}

/**
 * Read the request. A malformed request is an ERROR, never an empty probe: an
 * empty candidate list and "you asked for nothing" are the same output
 * otherwise, and the caller cannot tell a refusal from a host with no models.
 */
export function readSelectors(raw: string | undefined): { selectors: string[]; errors: string[] } {
  const text = (raw ?? '').trim();
  if (text === '') return { selectors: [], errors: [`${SELECTORS_ENV} is empty — the probe is told which selectors to prove, it never guesses a list`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { selectors: [], errors: [`${SELECTORS_ENV} is not JSON: ${String((error as Error)?.message ?? error)}`] };
  }
  if (!Array.isArray(parsed)) return { selectors: [], errors: [`${SELECTORS_ENV} must be a JSON array of selector strings, not ${parsed === null ? 'null' : typeof parsed}`] };
  const selectors: string[] = [];
  const errors: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push(`${SELECTORS_ENV} carries a non-selector entry (${JSON.stringify(entry)}); every entry must be a non-empty string`);
      continue;
    }
    selectors.push(entry.trim());
  }
  if (selectors.length === 0 && errors.length === 0) errors.push(`${SELECTORS_ENV} is an empty array — there is nothing to prove`);
  return { selectors, errors };
}

/**
 * Expand selectors into exact requests, in configured order.
 *
 * THE CONFIGURED EFFORT IS PER CANDIDATE, which is why this loops over members
 * rather than parsing the role's value once: splitting the effort off
 * `anthropic/claude-sonnet-5:low,xai-oauth/grok-4.5:high` yields `high` for
 * both, and a cheap candidate silently becomes an expensive one. Commas first,
 * so each member's suffix is that member's own.
 *
 * AN EFFORT THE REQUEST NAMED OUTRANKS THE ONE CONFIG DECLARES: the outermost
 * explicit effort travels down the whole expansion, and a member's own suffix
 * applies exactly when nothing above it asked for one.
 *
 * No default effort anywhere: a candidate nobody named an effort for is
 * reported `null`, and the runtime's own default applies as it would for a role
 * OMP resolves itself.
 */
export function expandSelectors(
  selectors: readonly string[],
  configuredRole: ProbeDeps['configuredRole'],
): { requests: ProbeRequest[]; errors: string[] } {
  const requests: ProbeRequest[] = [];
  const errors: string[] = [];
  // Ordered de-duplication: a role reachable through two aliases is one
  // candidate, and the FIRST position is the configured preference.
  const seen = new Set<string>();

  const walk = (text: string, requested: string, inherited: string | null, trail: string[]): void => {
    const { spec, thinking } = splitThinking(text);
    const effort = inherited ?? thinking;
    const role = modelRoleOf(spec);

    if (role === null) {
      const key = `${spec}\u0000${effort ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      requests.push({ requested, spec, effort, via: [...trail] });
      return;
    }

    // An alias whose suffix was not split off names an effort OMP does not have.
    // Refused rather than looked up: `@worker-balanced:mdium` would otherwise be
    // reported as an unconfigured role, which sends the operator to the wrong file.
    if (role.includes(':')) {
      const cut = role.lastIndexOf(':');
      errors.push(
        `'${text}' names effort '${role.slice(cut + 1)}', which is not one of OMP's thinking levels (the vocabulary \`--thinking\` accepts), so it is refused rather than clamped to a neighbouring one`,
      );
      return;
    }

    if (trail.includes(role)) {
      errors.push(`role expansion cycles: ${[...trail, role].map(name => `@${name}`).join(' → ')}. A cyclic modelRoles entry has no candidate list, so nothing is reported for it`);
      return;
    }
    if (trail.length >= MAX_EXPANSION_DEPTH) {
      errors.push(`role expansion for '${requested}' is more than ${MAX_EXPANSION_DEPTH} aliases deep (${[...trail, role].map(name => `@${name}`).join(' → ')}) — refused rather than reported as a complete list`);
      return;
    }

    const configured = configuredRole(role);
    if (configured === undefined || configured.trim() === '') {
      errors.push(
        `'@${role}' is not a model role this host configures${trail.length === 0 ? '' : ` (reached through ${trail.map(name => `@${name}`).join(' → ')})`}, so it names no candidates here. Declare it under modelRoles on this host, or route to a role it does declare`,
      );
      return;
    }

    const members = configured
      .split(',')
      .map(member => member.trim())
      .filter(member => member !== '');
    if (members.length === 0) {
      errors.push(`'@${role}' is configured as '${configured}', which lists no candidate`);
      return;
    }
    for (const member of members) walk(member, requested, effort, [...trail, role]);
  };

  for (const selector of selectors) walk(selector, selector, null, []);
  return { requests, errors };
}

/**
 * Prove one request against this host, in the order the answers can be trusted:
 * resolution, exactness, authenticated availability, then effort. Each refusal
 * short-circuits, because a later check on a model that is not the requested one
 * describes the wrong model.
 */
function probeOne(request: ProbeRequest, deps: ProbeDeps, authenticated: Map<string, unknown>): ProbeCandidate {
  const suffix = request.effort === null ? '' : `:${request.effort}`;
  const unavailable = (reason: string): ProbeCandidate => ({
    selector: `${request.spec}${suffix}`,
    model: request.spec,
    effort: request.effort,
    available: false,
    reason,
  });

  let resolved: unknown;
  try {
    resolved = deps.resolve(request.spec);
  } catch (error) {
    return unavailable(`the host's resolver threw on '${request.spec}': ${String((error as Error)?.message ?? error)}`);
  }
  if (resolved === undefined || resolved === null) {
    return unavailable(`'${request.spec}' does not resolve on this host${request.via.length === 0 ? '' : ` (configured by ${request.via.map(name => `@${name}`).join(' → ')})`}`);
  }

  const name = modelIdentity(resolved);
  if (name === null) return unavailable(`'${request.spec}' resolved to a record that names no provider/id, so nothing here can be proven about it`);

  // EXACTNESS. `resolve()` is the same fuzzy matcher `--model opus` uses, so a
  // typo in a configured candidate does not fail — it lands on a NEIGHBOUR. A
  // candidate list is a list of exact models by contract, so a resolution that
  // renamed the request is refused here rather than dispatched to. A request
  // written as a bare id is compared to the record's own id, which is the half
  // it named.
  const bareId = typeof resolved === 'object' && 'id' in resolved && typeof resolved.id === 'string' ? resolved.id : '';
  const asked = request.spec.includes('/') ? name : bareId;
  if (asked !== request.spec) {
    return unavailable(
      `'${request.spec}' only fuzzy-matches '${name}' on this host. A candidate must name the model exactly, or a typo becomes a silent substitution`,
    );
  }

  if (!authenticated.has(name)) {
    return unavailable(`'${name}' is not in this host's authenticated models, so nothing here could serve it`);
  }

  // The AUTHENTICATED record, not the resolved one: availability was decided by
  // the list, and the effort ladder must be read off the same copy that decision
  // was made on.
  const record = authenticated.get(name);
  const candidate: ProbeCandidate = {
    selector: `${name}${suffix}`,
    model: name,
    effort: request.effort,
    available: true,
  };
  if (request.effort === null) return candidate;

  // The effort verdict is the runtime's own (omp/model/routing.ts): the probe
  // must not vouch for a level enforcement would then refuse. A mapped effort
  // travels as a NOTE — the requested level stays the candidate's value, so a
  // pinned dispatch can be replayed from what was requested.
  const verdict = effortSupported(record, request.effort);
  if (!verdict.ok) return { ...candidate, available: false, reason: `'${name}' ${verdict.detail}` };
  if (verdict.note !== undefined) candidate.reason = verdict.note;
  return candidate;
}

/** Prove every request. Ordered exactly as expansion produced them. */
export function probeRequests(requests: readonly ProbeRequest[], deps: ProbeDeps): { candidates: ProbeCandidate[]; errors: string[] } {
  // Nothing requested, nothing to read: the authenticated list is not fetched
  // and no identity map is built for an empty expansion.
  if (requests.length === 0) return { candidates: [], errors: [] };
  const errors: string[] = [];
  let listed: readonly unknown[] = [];
  try {
    listed = deps.list() ?? [];
  } catch (error) {
    return { candidates: [], errors: [`this host's authenticated model list could not be read: ${String((error as Error)?.message ?? error)}`] };
  }
  const authenticated = new Map<string, unknown>();
  for (const record of listed) {
    const name = modelIdentity(record);
    // First wins: the list is ordered by the host's own preference, and a second
    // record for one name is a catalog variant, not a different model.
    if (name !== null && !authenticated.has(name)) authenticated.set(name, record);
  }
  return { candidates: requests.map(request => probeOne(request, deps, authenticated)), errors };
}

/** The whole probe: read the request, expand it, prove it. */
export function runProbe(raw: string | undefined, deps: ProbeDeps): ProbeResult {
  const request = readSelectors(raw);
  const expansion = expandSelectors(request.selectors, deps.configuredRole);
  const proven = probeRequests(expansion.requests, deps);
  return {
    candidates: proven.candidates,
    errors: [...request.errors, ...expansion.errors, ...proven.errors],
  };
}

/** The one line, prefix included. */
export function formatProbe(result: ProbeResult): string {
  return `${PROBE_PREFIX}${JSON.stringify(result)}\n`;
}

/** The factory surface this extension uses, and nothing beyond it. */
export interface ProbeHost {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  logger?: { info?(message: string): void; warn?(message: string): void };
  pi?: { settings?: { getModelRole?(role: string): string | undefined } };
}

interface ProbeContext {
  models?: { list?(): readonly unknown[]; resolve?(spec: string): unknown };
  shutdown?(): void;
}

/**
 * Seams, for a test that must drive the whole handler without an OMP runtime or
 * a process to lose. `emit` and `exit` are the two effects; both are injected
 * because the default of each is unobservable from inside a test.
 */
export interface ProbeSeams {
  env?: Record<string, string | undefined>;
  emit?(line: string): void;
  exit?(code: number): void;
}

/**
 * stdout, synchronously and completely.
 *
 * `console.log` on a pipe can be asynchronous, and the process exits in the next
 * statement — which is exactly how a probe answers with a truncated line. A
 * partial write is looped, because `writeSync` is allowed to write less than it
 * was given.
 */
function writeStdout(line: string): void {
  const buffer = Buffer.from(line, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(1, buffer, written, buffer.length - written);
  }
}

export default function modelProbe(pi: ProbeHost, seams: ProbeSeams = {}): void {
  const env = seams.env ?? process.env;
  const emit = seams.emit ?? writeStdout;
  const exit = seams.exit ?? ((code: number) => process.exit(code));

  pi.on('session_start', (_event, rawCtx) => {
    const ctx = rawCtx as ProbeContext | null;
    const facade = ctx?.models;
    const result: ProbeResult =
      typeof facade?.resolve !== 'function' || typeof facade?.list !== 'function'
        ? {
            candidates: [],
            // Said out loud rather than answered as "no candidates": a missing
            // facade is a host this probe cannot read, and a caller must be able
            // to tell that from a host with nothing authenticated.
            errors: ['this session exposes no models facade (ctx.models.list/resolve), so no candidate could be proven on this host'],
          }
        : runProbe(env[SELECTORS_ENV], {
            list: () => facade.list?.() ?? [],
            resolve: spec => facade.resolve?.(spec),
            configuredRole: role => pi.pi?.settings?.getModelRole?.(role),
          });

    emit(formatProbe(result));

    // Asked properly first — an interactive or RPC host honours it — then
    // enforced, because print mode does not (see the header). Either way no
    // provider request is ever built: `session_start` is awaited before the
    // first prompt is sent.
    try {
      ctx?.shutdown?.();
    } catch {
      // A host that refuses the request still gets the exit below; there is
      // nothing to report and nobody left to report it to.
    }
    exit(0);
  });
}
