/**
 * The routing half of the marker contract: which models this worker may be
 * served by, and at which effort — enforced, not merely requested.
 *
 * `model=` says what the parent asked for; it cannot say what the parent
 * ALLOWED. A dispatched worker may be moved off its primary by OMP's own
 * quota/error fallback at any moment, so the parent ships its whole decision —
 * ordered, explicit, with per-candidate effort — as one base64url value on the
 * same bracket, and this module is the only thing that reads it.
 *
 * WHAT IS ENFORCEABLE (measured against the installed runtime)
 * `before_provider_request` is the only pre-provider hook, its result type is
 * the replacement payload, and a THROW from it is SWALLOWED:
 * `ExtensionRunner.emitBeforeProviderRequest` calls `#runHandlerWithTimeout`
 * with no `onFailure`, so a rejected handler resolves to `undefined`, the
 * payload is kept and the request goes out anyway (runner.ts:1650-1677,
 * 1299-1331). Refusal therefore cannot be a throw. The one lever that reaches
 * the wire is `ctx.abort()`: it runs `AgentSession.abort()` synchronously up to
 * `agent.abort(reason)` (agent-session.ts:6824-6849), aborting the loop
 * `AbortController` whose signal is composed into the request signal the
 * provider hands its SDK right after the payload hook returns (pi-ai
 * anthropic.ts:2007, then `createSdkStreamRequestOptions(requestSignal)`), and
 * an aborted signal at request creation means no send. `index.ts` applies the
 * decision with that lever and the `tool_call` fence — the only hook that is
 * fail-closed on a throw — so a refused worker cannot act.
 *
 * Nothing here touches a host: a decision table over a string plus an injected
 * `resolve`.
 */

import { parseMarker, splitThinking } from './alias.ts';

/** The marker key carrying the encoded route. */
export const ROUTING_KEY = 'routing';

/** The only payload version this runtime knows how to enforce. */
export const ROUTING_VERSION = 2;

export type RoutingMode = 'auto' | 'pinned' | 'confirm';

const MODES: Record<string, true> = { auto: true, pinned: true, confirm: true };

/** One approved choice: an exact model identity plus the effort approved WITH it. */
export interface RoutingCandidate {
  /** `provider/id:effort`, exactly as the parent wrote it. */
  selector: string;
  /** `provider/id` — the identity a resolved model must match exactly. */
  model: string;
  /** The thinking level approved for this candidate. Never inferred. */
  effort: string;
}

/** The parent's decision, after decode and shape validation. */
export interface RoutingPlan {
  version: typeof ROUTING_VERSION;
  mode: RoutingMode;
  /**
   * The chosen candidate's selector — the model this session serves.
   *
   * NOT required to be the first candidate. `confirm` lets the operator pick any
   * proposed candidate, and a `pinned` TIER may legitimately carry several. What
   * is required is that it NAMES one of them, at that candidate's own effort:
   * a selector outside its own candidate list is a decision that contradicts
   * itself, and choosing for it would be a guess.
   */
  selector: string;
  /** The chosen candidate, resolved out of `candidates` by `selector`. */
  selected: RoutingCandidate;
  /**
   * The approved set, in the order the parent approved it — which is the order
   * the fallback chain walks, so a parent that wants the chosen candidate to
   * fall back through the others places it first.
   */
  candidates: readonly RoutingCandidate[];
  /** The chosen candidate's effort, restated by the payload and cross-checked. */
  effort: string;
}

/**
 * Three outcomes, kept apart because the caller's move differs for each.
 *
 * `absent` is the ONLY one that preserves pre-routing behaviour: a marker with
 * no `routing=` key is a legacy dispatch and must keep working untouched.
 * Anything else present-but-unusable is a refusal — a route we cannot enforce
 * is indistinguishable, from inside, from a route that was tampered with.
 */
export type RoutingRead =
  | { kind: 'absent' }
  | { kind: 'refused'; detail: string }
  | { kind: 'plan'; plan: RoutingPlan };

/** Read the routing payload out of a Task spec's `[omp …]` marker. */
export function readRouting(spec: string | null): RoutingRead {
  if (spec === null) return { kind: 'absent' };
  const parsed = parseMarker(spec);
  if (parsed.kind === 'malformed') {
    // `parseMarker` gives up on the WHOLE bracket at the first token that is not
    // `key=value`, so a marker that carries a route plus one fumbled token parses
    // as malformed and its `routing=` key is never seen. Reading that as "no
    // route" would fail open on exactly the marker most likely to have been
    // edited by hand. Refuse when the bracket mentions routing at all.
    return /\brouting=/i.test(spec)
      ? { kind: 'refused', detail: `marker carries routing and a token that is not key=value (${parsed.token})` }
      : { kind: 'absent' };
  }
  if (parsed.kind !== 'keys') return { kind: 'absent' };
  const value = parsed.keys.get(ROUTING_KEY);
  if (value === undefined) return { kind: 'absent' };
  if (value === '') return { kind: 'refused', detail: 'routing= is empty' };
  return decodeRouting(value);
}

/** base64url → JSON → validated plan. Exported because it is the whole grammar. */
export function decodeRouting(value: string): RoutingRead {
  let json: string;
  try {
    json = Buffer.from(value, 'base64url').toString('utf8');
  } catch (error) {
    return { kind: 'refused', detail: `routing= is not base64url (${String(error)})` };
  }
  // Buffer.from is lenient: it drops invalid characters instead of failing, so
  // the JSON parse below is the real gate. Re-encoding is not a check worth
  // adding — a payload that round-trips to valid JSON is one we can enforce.
  if (json === '') return { kind: 'refused', detail: 'routing= decoded to nothing' };
  let body: unknown;
  try {
    body = JSON.parse(json) as unknown;
  } catch (error) {
    return { kind: 'refused', detail: `routing= is not JSON (${String(error)})` };
  }
  return validateRouting(body);
}

/** Validate a decoded payload. Every refusal names the field, never "invalid". */
export function validateRouting(body: unknown): RoutingRead {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { kind: 'refused', detail: 'routing payload is not an object' };
  const record = body as Record<string, unknown>;

  // A version we do not know is NOT ignorable. Its candidate semantics are
  // whatever a future parent decided, and enforcing v2 rules against them would
  // be a guess with the authority of a guard.
  if (record.version !== ROUTING_VERSION)
    return { kind: 'refused', detail: `routing version ${String(record.version)} is not ${ROUTING_VERSION}` };

  const mode = record.mode;
  if (typeof mode !== 'string' || MODES[mode] !== true)
    return { kind: 'refused', detail: `routing mode ${String(mode)} is not auto|pinned|confirm` };

  const rawCandidates = record.candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0)
    return { kind: 'refused', detail: 'routing candidates is not a non-empty array' };

  const candidates: RoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of rawCandidates) {
    if (typeof entry !== 'string')
      return { kind: 'refused', detail: `routing candidate ${String(entry)} is not a string` };
    const candidate = parseCandidate(entry);
    if (candidate === null)
      return {
        kind: 'refused',
        detail: `routing candidate ${entry} is not provider/id:effort with a known effort`,
      };
    // One model may appear once. The enforcement map below is keyed by identity,
    // so two efforts for one model would make "which effort is approved here"
    // ambiguous — and an ambiguous approval is not an approval.
    if (seen.has(candidate.model))
      return { kind: 'refused', detail: `routing lists ${candidate.model} twice` };
    seen.add(candidate.model);
    candidates.push(candidate);
  }

  // Membership, not position. `confirm` lets the operator choose any candidate
  // that was proposed, and a tier may approve several — so the selector's only
  // obligation is to name one of them. The payload's `effort` must then be that
  // candidate's own: two fields describing one choice that disagree mean the
  // payload was edited, and picking a winner would be a guess.
  const selected = candidates.find((candidate) => candidate.selector === record.selector);
  if (selected === undefined)
    return {
      kind: 'refused',
      detail: `routing selector ${String(record.selector)} is not one of the candidates [${candidates
        .map((candidate) => candidate.selector)
        .join(', ')}]`,
    };
  if (record.effort !== selected.effort)
    return {
      kind: 'refused',
      detail: `routing effort ${String(record.effort)} is not the selected candidate's effort ${selected.effort}`,
    };

  return {
    kind: 'plan',
    plan: {
      version: ROUTING_VERSION,
      mode: mode as RoutingMode,
      selector: selected.selector,
      selected,
      candidates,
      effort: selected.effort,
    },
  };
}

/**
 * `provider/id:effort` → candidate. `null` for anything else.
 *
 * The effort suffix is REQUIRED and is split with `splitThinking`, the same
 * function the `model=` key uses, so there is exactly one table of level names
 * in this package. A selector without a recognised level is refused rather than
 * defaulted: the contract says unsupported effort is refused, not clamped, and
 * a missing one is the same class of missing decision.
 */
export function parseCandidate(selector: string): RoutingCandidate | null {
  const trimmed = selector.trim();
  if (trimmed !== selector || trimmed === '') return null;
  const { spec, thinking } = splitThinking(trimmed);
  if (thinking === null) return null;
  // Concrete identities only. An `@alias` here would move candidate membership
  // back into config read at enforcement time, which is the one thing the
  // payload exists to freeze.
  if (spec.startsWith('@')) return null;
  const cut = spec.indexOf('/');
  if (cut <= 0 || cut === spec.length - 1) return null;
  return { selector: trimmed, model: spec, effort: thinking };
}

/**
 * `provider/id` of a resolved model object, or `null` unless it names BOTH
 * halves: half a name cannot be compared to an approved one.
 */
export function modelIdentity(model: unknown): string | null {
  const record = model as { provider?: unknown; id?: unknown } | null;
  const provider = typeof record?.provider === 'string' ? record.provider : '';
  const id = typeof record?.id === 'string' ? record.id : '';
  return provider === '' || id === '' ? null : `${provider}/${id}`;
}

/** Supported, supported through the model's own map (with the note to record), or not. */
export type EffortVerdict = { ok: true; note?: string } | { ok: false; detail: string };

/**
 * Whether a resolved model genuinely supports an effort — read off the model's
 * own metadata, never assumed. ONE verdict for both sides: the probe reports it
 * on the target (omp/model/probe.ts) and this module re-checks it before the
 * first `setModel`, and a second opinion here would refuse at placement what
 * the probe already vouched for.
 *
 * `thinking.efforts` is the declared ladder; `thinking.effortMap` is the
 * model's OWN spelling of a user-facing effort as a wire tier, so honouring it
 * is reading the catalog rather than inventing a level. `setThinkingLevel` does
 * NOT validate — it returns void and applies what it is handed — so this check
 * is the caller's job, and OMP's own clamp is deliberately not reused: an
 * effort the model neither implements nor maps is refused, never served at a
 * neighbouring tier.
 *
 * `detail` is a clause about the model, so a caller reads as
 * `<identity> <detail>`.
 */
export function effortSupported(model: unknown, effort: string): EffortVerdict {
  const thinking =
    (model as { thinking?: { efforts?: unknown; effortMap?: Record<string, unknown>; requiresEffort?: unknown } | null } | null)
      ?.thinking ?? null;
  const efforts = Array.isArray(thinking?.efforts)
    ? thinking.efforts.filter((level): level is string => typeof level === 'string')
    : [];
  const declared = efforts.join(', ') || 'none';

  if (effort === 'off') {
    return thinking?.requiresEffort === true
      ? { ok: false, detail: `requires a thinking effort (it declares ${declared}), so ':off' cannot be served` }
      : { ok: true };
  }
  if (thinking === null) return { ok: false, detail: `declares no thinking configuration, so effort '${effort}' cannot be served` };
  if (efforts.includes(effort)) return { ok: true };

  const mapped = thinking.effortMap?.[effort];
  if (typeof mapped === 'string' && mapped !== '') {
    // THE REQUESTED EFFORT IS WHAT TRAVELS. The mapping is the host's own
    // spelling of it on the wire; reporting `mapped` as the effort would hand
    // the runtime a level nobody asked for and make a pinned dispatch
    // un-replayable. It is a note, never the value.
    return { ok: true, note: `effort '${effort}' is requested as '${effort}' and served through the model's own effort map as wire tier '${mapped}'` };
  }
  return {
    ok: false,
    detail: `does not support effort '${effort}' (it declares ${declared}) and maps no alias for it — refused rather than clamped`,
  };
}

/** A candidate whose model resolved on THIS host, with the object to serve. */
export interface ResolvedCandidate {
  candidate: RoutingCandidate;
  model: unknown;
}

export type RoutingResolution =
  | { ok: true; resolved: readonly ResolvedCandidate[] }
  | { ok: false; detail: string };

/**
 * Resolve and check EVERY candidate before anything is applied.
 *
 * All of them, not just the first: the fallback chain armed from this plan can
 * move the session onto any of them without asking again, so a candidate that
 * does not resolve here, resolves to a DIFFERENT identity, or cannot serve its
 * approved effort is a hole in the authorization — and the only moment it can
 * be refused cheaply is before the first `setModel`.
 *
 * `resolve()` accepts bare ids and aliases and answers with its own best match,
 * so identity equality is checked explicitly. A payload naming
 * `anthropic/claude-opus-5` that resolves to something else is refused, never
 * served under the name that was approved.
 */
export function resolveRouting(plan: RoutingPlan, resolve: (spec: string) => unknown): RoutingResolution {
  const resolved: ResolvedCandidate[] = [];
  for (const candidate of plan.candidates) {
    let model: unknown;
    try {
      model = resolve(candidate.model);
    } catch (error) {
      return { ok: false, detail: `${candidate.model} did not resolve (${String(error)})` };
    }
    if (model === undefined || model === null)
      return { ok: false, detail: `${candidate.model} did not resolve on this host` };
    const identity = modelIdentity(model);
    if (identity !== candidate.model)
      return {
        ok: false,
        detail: `${candidate.model} resolved to ${identity ?? '<unnamed>'}, not the approved identity`,
      };
    const effort = effortSupported(model, candidate.effort);
    if (!effort.ok) return { ok: false, detail: `${candidate.model} ${effort.detail}` };
    resolved.push({ candidate, model });
  }
  return { ok: true, resolved };
}

/** The candidate a model identity is approved as, or `null` when it is not approved at all. */
export function candidateFor(plan: RoutingPlan, identity: string | null): RoutingCandidate | null {
  if (identity === null) return null;
  return plan.candidates.find((candidate) => candidate.model === identity) ?? null;
}

/**
 * The `retry.fallbackChains` entries that keep OMP's OWN fallback inside the
 * approved set — and make it carry each candidate's approved effort.
 *
 * Keyed by `provider/id` rather than by a role, deliberately:
 *   - `retry.fallbackChains` treats a role name, `provider/model-id` and
 *     `provider/*` as keys uniformly, and an exact model key wins over a role
 *     key in `resolveRetryFallbackChainKey`. Keying by model leaves every role
 *     (including `default`, `task`, and any pinned subagent role) untouched.
 *   - Chain ENTRIES carry a thinking level (`parseRetryFallbackSelector` →
 *     `thinkingLevel`, applied by turn-recovery as
 *     `lastAppliedFallbackThinkingLevel`), which is what makes "the fallback
 *     candidate gets its own effort" a native guarantee rather than a wish.
 *
 * One entry per candidate, each chaining only to the candidates AFTER it, so a
 * fallback from any position walks forward through the approved order and off
 * the end — never sideways into whatever the fleet's default chain holds.
 */
export function fallbackChainsFor(plan: RoutingPlan): Record<string, string[]> {
  const chains: Record<string, string[]> = {};
  plan.candidates.forEach((candidate, index) => {
    chains[candidate.model] = plan.candidates.slice(index + 1).map((next) => next.selector);
  });
  return chains;
}

/**
 * Merge the plan's chains over a captured baseline.
 *
 * The baseline is whatever the process settings held BEFORE this worker armed
 * anything — including runtime overrides OMP itself installed at startup (sdk
 * arms `retry.fallbackChains` for `--model` pattern fallback). Restoration
 * writes the baseline back rather than clearing the key, because clearing would
 * delete those.
 */
export function mergeFallbackChains(
  baseline: Record<string, string[]>,
  plan: RoutingPlan,
): Record<string, string[]> {
  return { ...baseline, ...fallbackChainsFor(plan) };
}

/** Defensive copy of a settings-read chain record, dropping malformed entries. */
export function sanitizeChains(value: unknown): Record<string, string[]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const chains: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    chains[key] = entry.filter((item): item is string => typeof item === 'string');
  }
  return chains;
}
