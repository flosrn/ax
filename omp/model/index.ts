/**
 * Teaches an OMP session which model it was dispatched to serve.
 *
 * WHY THIS EXISTS
 * Orca owns session lifecycle and OMP owns the model, and the two barely meet.
 * `worker-start` carries `--model` and `--effort`, but they apply to Claude, Codex
 * and Cursor only: `omp` is not among the agents they accept. So a worker Orca
 * launches for us serves the harness default — an unmarked `worker-start --agent
 * omp` gets the premium interactive default, for a task nobody assigned a model to.
 *
 * The obvious workaround costs the worker lifecycle: composing
 * `terminal create --command "omp --model=…"` does apply the model, but Orca then
 * answers `external_terminal` to `worker-release`, because it will not manage a
 * terminal it did not create.
 *
 * This extension removes that trade. Orca creates the terminal (`--agent omp`, so
 * release/retain/read keep working) and the session corrects its own model from
 * inside, reading the intent its parent wrote into the Task spec.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never touches a session that is not a supervised worker. An operator's
 * interactive session keeps whatever model the operator chose — a tool that
 * silently overrides a human's deliberate choice teaches the human to distrust
 * the harness, and that lesson was already paid for once.
 *
 * HOW TO TELL ITS EFFECT FROM A COINCIDENCE
 * A `model_change` this extension causes is journaled `role: "default"`. OMP's own
 * quota fallback journals `role: "fallback"`. That distinction matters: an early
 * version of this file was believed to work because a child happened to be moved
 * onto the intended model by a quota fallback, and the `role` field was the only
 * thing that said otherwise. Read it before claiming this applied.
 */

import { readModelIntent, modelRoleOf, splitThinking, type ModelIntent } from './alias.ts';
import type { PlaybookLookup, RoleLookup } from './roles.ts';
import { roleActivation } from './activation.ts';
import {
  createRunner,
  findSelf,
  readSpec,
  readSpecFromTranscript,
  resolveOrcaBin,
  type OrcaRunner,
} from './self.ts';
import { isSubagentSession } from '../shared/session.ts';
import {
  candidateFor,
  mergeFallbackChains,
  modelIdentity,
  readRouting,
  resolveRouting,
  sanitizeChains,
  type ResolvedCandidate,
  type RoutingCandidate,
  type RoutingPlan,
} from './routing.ts';

/**
 * The pieces of the host this needs, injected so the decision table is testable
 * without an Orca runtime — a guard nobody can exercise is a guard nobody trusts.
 *
 * `resolve` comes from the handler context (`ctx.models.resolve`), NOT from the
 * factory's `pi`: handlers are called `(event, ctx)`, and `pi` has no models
 * facade at all. Getting that wrong is what made the first version a silent
 * no-op — it read `pi.models?.resolve?.()`, got `undefined` every time, and
 * refused with a warning nobody was reading.
 */
export interface ApplyDeps {
  run: OrcaRunner;
  handle: string | null;
  resolve(spec: string): unknown;
  setModel(model: unknown): Promise<unknown> | unknown;
  setThinkingLevel?(level: string): Promise<unknown> | unknown;
  /**
   * The RAW configured spec for a model role, e.g. `smol` → `anthropic/claude-sonnet-5:medium`.
   *
   * Needed because `resolve()` documents itself as dropping the thinking suffix
   * ("pass effort separately"), so resolving `@smol` yields the model and loses
   * the `:medium` its role declares. Without this the child kept the BOOT
   * model's effort — measured live: config said `:medium`, the child ran `high`,
   * inherited from `default: claude-opus-5:high`.
   */
  configuredRole?(role: string): string | undefined;
  /**
   * The spec as this session received it, read from its own transcript.
   *
   * Consulted ONLY when Orca answers `absent` — a worker whose Run lives on
   * another execution host. Omitted by a caller that has no transcript to offer.
   */
  localSpec?(): { spec: string | null; reason?: string };
}

export type ApplyOutcome =
  | {
      applied: false;
      /**
       * `absent` is deliberately not `not-supervised`: Orca answered and this
       * handle was not in the list, which at `session_start` may only mean the
       * Dispatch is not recorded YET. The caller decides whether that is final.
       */
      why: 'not-supervised' | 'absent' | 'unresolved' | 'lookup-failed' | 'routing-refused';
      detail?: string;
    }
  | {
      applied: true;
      model: string;
      requested: string;
      thinking: string | null;
      source: ModelIntent['source'];
      /**
       * Which copy of the spec the intent was read from. `orca` is the Task
       * record; `transcript` is the session's own first user message, the only
       * copy a cross-host worker can reach.
       */
      via: 'orca' | 'transcript';
      detail?: string;
      /** The Task spec this outcome was read from, so the role reuses one lookup. */
      taskSpec: string | null;
      /**
       * The approved route this session is now bound to, when its marker carried
       * one. `undefined` is a legacy dispatch: no candidate set, no enforcement,
       * exactly the behaviour that shipped before routing existed.
       */
      routing?: RoutingPlan;
    };

function describe(model: unknown): string {
  if (typeof model === 'string') return model;
  const record = model as { provider?: unknown; id?: unknown } | null;
  const provider = typeof record?.provider === 'string' ? record.provider : null;
  const id = typeof record?.id === 'string' ? record.id : null;
  if (provider !== null && id !== null) return `${provider}/${id}`;
  return id ?? '<unnamed>';
}

/**
 * The effort the fleet's config attaches to a role alias, or `null`.
 *
 * Only an `@alias` has a role to look up; a concrete id (`xai-oauth/grok-4.5`)
 * names no role, so settings are never consulted for one.
 */
function configuredThinking(deps: ApplyDeps, spec: string): string | null {
  const role = modelRoleOf(spec);
  if (role === null || deps.configuredRole === undefined) return null;
  const configured = deps.configuredRole(role);
  if (configured === undefined || configured === '') return null;
  return splitThinking(configured).thinking;
}


/**
 * Resolve one intent and apply it. Shared by both spec sources on purpose: the
 * effort precedence below is the kind of rule that rots the moment there are two
 * copies of it, and a cross-host worker must serve exactly what a local one does.
 */
async function applyIntent(
  deps: ApplyDeps,
  intent: ModelIntent,
  spec: string | null,
  via: 'orca' | 'transcript',
  readReason: string | undefined,
): Promise<ApplyOutcome> {
  const routing = readRouting(spec);
  if (routing.kind === 'refused') {
    // A route we cannot read is not a route we may ignore: the parent decided
    // something specific and this session cannot tell an encoding bug from a
    // tampered payload. Refuse before touching the model.
    return { applied: false, why: 'routing-refused', detail: routing.detail };
  }

  if (routing.kind === 'plan') return applyRoute(deps, intent, routing.plan, spec, via, readReason);

  const resolved = deps.resolve(intent.spec);
  if (resolved === undefined || resolved === null) {
    // Refusing loudly beats serving a model nobody asked for: an alias that does
    // not resolve is a config error the operator must see, and the session still
    // works on whatever it booted with.
    return {
      applied: false,
      why: 'unresolved',
      detail: `${intent.spec} did not resolve (${intent.source} via ${via}${readReason === undefined ? '' : `; ${readReason}`})`,
    };
  }

  if (await deps.setModel(resolved) === false) {
    return { applied: false, why: 'unresolved', detail: `${intent.spec} resolved but the target host refused the model change` };
  }

  // Effort precedence, most specific first: the marker's own suffix, then the
  // suffix the role declares in config, then nothing. "Nothing" is load-bearing —
  // `task: xai-oauth/grok-4.5` declares no effort, and forcing one there would
  // invent a decision nobody made, which is this extension's whole grievance.
  const thinking = intent.thinking ?? configuredThinking(deps, intent.spec);
  if (thinking !== null && deps.setThinkingLevel !== undefined) {
    await deps.setThinkingLevel(thinking);
  }
  return {
    applied: true,
    model: describe(resolved),
    requested: `${intent.spec}${intent.thinking === null ? '' : `:${intent.thinking}`}`,
    thinking,
    source: intent.source,
    via,
    detail: readReason ?? intent.reason,
    taskSpec: spec,
  };
}

/**
 * Apply a v2 route: validate the WHOLE approved set, then serve the SELECTED
 * candidate at the effort approved with it.
 *
 * Order is the contract. Every candidate is resolved and effort-checked BEFORE
 * the first `setModel`, because the fallback chain armed from this plan can move
 * the session onto any of them with nobody left to ask — so a candidate that
 * cannot serve its approved effort must cost a refusal now, not a silent clamp
 * three hours into a run.
 */
async function applyRoute(
  deps: ApplyDeps,
  intent: ModelIntent,
  plan: RoutingPlan,
  spec: string | null,
  via: 'orca' | 'transcript',
  readReason: string | undefined,
): Promise<ApplyOutcome> {
  const refuse = (detail: string): ApplyOutcome => ({ applied: false, why: 'routing-refused', detail });

  // Effort is half of an approved candidate. A host that cannot set a thinking
  // level cannot honour the route, and serving the model alone would satisfy the
  // half of the contract that is cheap to check and drop the half that costs.
  if (deps.setThinkingLevel === undefined)
    return refuse('host exposes no setThinkingLevel — the approved effort cannot be applied');

  const resolution = resolveRouting(plan, (candidate) => deps.resolve(candidate));
  if (!resolution.ok) return refuse(resolution.detail);

  // The two copies of the parent's choice must agree. `model=` is what a human
  // reads in the marker and `routing=` is what this runtime enforces; a
  // disagreement means one of them was edited, and guessing which is authoritative
  // is how an unapproved model gets served under an approved name.
  const requested = modelRoleOf(intent.spec) === null ? intent.spec : null;
  if (requested !== null && requested !== plan.selected.model)
    return refuse(`marker model ${requested} disagrees with routing selector ${plan.selector}`);
  if (intent.thinking !== null && intent.thinking !== plan.effort)
    return refuse(`marker effort ${intent.thinking} disagrees with routing effort ${plan.effort}`);

  // The CHOSEN candidate, which is not necessarily the first: a confirmed route
  // carries the operator's pick, and a tier may approve several.
  const chosen = resolution.resolved.find(
    (entry: ResolvedCandidate) => entry.candidate.selector === plan.selector,
  ) as ResolvedCandidate;
  if (await deps.setModel(chosen.model) === false)
    return refuse(`${chosen.candidate.model} resolved but the target host refused the model change`);
  // A refused or throwing effort apply is a refused ROUTE: the model half of an
  // approved candidate without its effort is not the candidate.
  try {
    if (await deps.setThinkingLevel(plan.effort) === false)
      return refuse(`the target host refused effort ${plan.effort} for ${chosen.candidate.model}`);
  } catch (error) {
    return refuse(`effort ${plan.effort} could not be applied: ${String(error)}`);
  }

  return {
    applied: true,
    model: describe(chosen.model),
    requested: plan.selector,
    thinking: plan.effort,
    source: intent.source,
    via,
    detail: readReason ?? intent.reason,
    taskSpec: spec,
    routing: plan,
  };
}

/** Resolve and apply the parent's model intent. */
export async function applyDispatchedModel(deps: ApplyDeps): Promise<ApplyOutcome> {
  const { run, handle } = deps;

  // No Orca identity means no supervision to honour. This is the common case for
  // an operator's own session and it must stay a no-op.
  if (handle === null || handle === '') return { applied: false, why: 'not-supervised' };

  const self = await findSelf(run, handle);
  if (self.entry === null) {
    // Three different things, kept apart on purpose. `absent` is not a fault and
    // not yet a verdict — the caller weighs it against the occasion.
    if (self.absent === true) return absentFallback(deps);
    return self.reason === undefined
      ? { applied: false, why: 'not-supervised' }
      : { applied: false, why: 'lookup-failed', detail: self.reason };
  }

  const { runId, taskId } = self.entry;
  const read =
    runId !== null && taskId !== null
      ? await readSpec(run, runId, taskId)
      : { spec: null, reason: 'dispatch entry named no run/task' };

  return applyIntent(deps, readModelIntent(read.spec), read.spec, 'orca', read.reason);
}

/**
 * `absent` means Orca answered and no worker row carries this handle. TWO very
 * different sessions land here, and until 2026-08-13 both were treated as the
 * second one and left in silence:
 *
 *   1. An operator's own pane. The common case, and it must stay untouched — a
 *      tool that overrides a human's deliberate model choice teaches the human to
 *      distrust the harness (D-028).
 *   2. A worker dispatched from ANOTHER execution host. Its Run and Task are
 *      authoritative on the dispatching runtime, so its local `worker-list`
 *      cannot see it, and every marker its parent wrote was discarded.
 *
 * The discriminant is evidence, not a new flag: only a dispatched session carries
 * a marker in its first user message. An interactive pane has none, so it falls
 * through to the same silence as before. That is why this reads the transcript
 * instead of asking Orca a second question it cannot answer.
 *
 * A `supervised-default` intent is NOT enough to act on here. Reaching case 1
 * with no marker and applying `@task` would retune an operator mid-session, which
 * is the one thing D-028 forbids outright.
 */
async function absentFallback(deps: ApplyDeps): Promise<ApplyOutcome> {
  if (deps.localSpec === undefined) return { applied: false, why: 'absent' };
  const local = deps.localSpec();
  const intent = readModelIntent(local.spec);
  if (intent.source !== 'marker')
    return {
      applied: false,
      why: 'absent',
      detail: local.reason ?? 'no marker in this session own first message',
    };
  return applyIntent(deps, intent, local.spec, 'transcript', local.reason);
}

/** Minimal shape of the factory object and of the handler context. */
export interface ModelHost {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  setModel(model: unknown): Promise<unknown> | unknown;
  setThinkingLevel?(level: string): Promise<unknown> | unknown;
  getThinkingLevel?(): string | undefined;
  logger?: { info?(message: string): void; warn?(message: string): void };
  appendEntry?(customType: string, data: unknown): void;
  /**
   * The injected pi-coding-agent exports. `settings.getModelRole(role)` returns
   * a role's RAW configured spec, suffix included — the one thing
   * `ctx.models.resolve()` throws away. Verified live inside a dispatched
   * session: `getModelRole('smol')` → `anthropic/claude-sonnet-5:medium`.
   *
   * `get`/`override` are the SAME pair OMP uses on itself to bound a subagent's
   * fallback (`task/executor.ts` installs `retry.fallbackChains` this way).
   * `override` writes the in-memory runtime layer only — never a config file.
   *
   * SCOPE, which decides the whole arming protocol below: the exported
   * `settings` is a proxy over ONE process-global instance, created at CLI boot
   * and never reassigned. A `task` subagent does not use it — it gets an
   * isolated `Settings` built by snapshotting the merged view AT SPAWN TIME — so
   * an override left armed while a child is spawned is inherited by that child,
   * and an override armed after it is invisible to it. Hence: arm for the
   * request, restore before any tool can spawn anything.
   */
  pi?: {
    settings?: {
      getModelRole?(role: string): string | undefined;
      get?(path: string): unknown;
      override?(path: string, value: unknown): void;
    };
  };
  //
  // `discoverAgents`, `loadSkills` and `buildSkillPromptMessage` used to be read
  // off this surface, and they are deliberately gone. Roles and playbooks now
  // come from `./roles.ts`, out of files this package ships — see that module for
  // the three defects host discovery cost. What remains here is the one thing the
  // host genuinely owns: the fleet's configured model roles.
  /** The session's tool registry, for naming what a role asked for and did not get. */
  getAllTools?(): { name?: string }[];
  /** Replaces the active tool surface. Names absent from the registry are ignored. */
  setActiveTools?(names: string[]): Promise<unknown> | unknown;
  registerCommand?(name: string, spec: Record<string, unknown>): void;
}

interface HandlerContext {
  models?: { resolve?(spec: string): unknown };
  sessionManager?: { getSessionFile?(): string | undefined };
}


/**
 * Seams the factory exposes ONLY so a test can drive the whole path.
 *
 * They exist because of a measured failure: the first version built its own
 * runner and read the handle from the environment, which made the wiring between
 * the handler context and `applyDispatchedModel` unreachable from a test. Two
 * successive "wiring tests" passed while the wiring was broken, because neither
 * could get far enough to call `resolve`. A seam that lets the test reach the
 * real call is the difference between a suite and a decoration.
 */
export interface FactorySeams {
  run?: OrcaRunner;
  handle?: string | null;
  /**
   * Resolve a session role by name. Defaults to this package's `roles/`.
   *
   * A seam rather than a constant because the role files are now DATA this
   * package ships, and a test that has to lay real markdown on disk to reach the
   * refusal branches tests the filesystem as much as the applier. `roles.test.ts`
   * drives the real loader against fixtures; the tests here drive the applier
   * against this seam. Both are needed — the previous arrangement injected
   * `pi.pi.discoverAgents`, which is exactly the coupling this migration removed.
   */
  loadRole?(name: string): Promise<RoleLookup>;
  /**
   * Resolve a playbook body by name. Defaults to this package's `playbooks/`.
   *
   * There is no host lookup behind this — see `roles.ts`. A name this package
   * does not ship is a refusal, never a quiet fall-through to whatever skill the
   * machine happens to have installed under that name.
   */
  loadPlaybook?(name: string): Promise<PlaybookLookup>;
}

export default function orcaModel(pi: ModelHost, seams: FactorySeams = {}) {
  /**
   * Identifies THIS factory closure in the log.
   *
   * It was added to explain an unexplained double apply, and it did: on
   * 2026-08-07 a session dispatching two subagents logged THREE factory tags in
   * one pid. Every in-process `task` subagent re-initialises the extensions —
   * the loader cache-busts its import — so the closure state below is new each
   * time and cannot see a sibling. `isSubagentSession` is the guard that came
   * out of it.
   *
   * Kept, because the tag is what makes a repeat self-diagnosing: two distinct
   * tags is a second load, one tag twice is a broken guard.
   */
  const instance = Math.random().toString(36).slice(2, 8);
  pi.logger?.info?.(`[orca-model] factory instance ${instance}`);

  let settled = false;
  /**
   * In-flight guard. `settled` alone is not enough: it is read before the await
   * and written after it, so both occasions can pass the check and each call
   * `setModel`.
   */
  let running: Promise<void> | null = null;
  /**
   * The FIRST prompt this session was handed, captured as it was submitted.
   *
   * Measured twice on 2026-08-13, and this is the source that works. A dispatched
   * worker on another execution host cannot be found in its own `worker-list`, so
   * the spec has to come from the session itself — and reading the transcript FILE
   * loses the race: `before_agent_start` fires before that row is flushed, so the
   * reader found a header and nothing else, stayed silent by design, and the child
   * served its boot model. The submitted text is in memory at that moment.
   *
   * `prompt-suggest.ts:267` already reads `event.text` off this event; this is the
   * same contract, kept to the FIRST one so a later steer cannot retune the
   * session mid-flight.
   */
  let firstInput: string | null = null;
  /**
   * The Task spec, kept from whichever occasion resolved it.
   *
   * The model is usually applied at `session_start`; the ROLE can only be
   * applied at `before_agent_start`, because returning `systemPrompt` is the
   * only surface that reaches the system block. Keeping the spec means the role
   * costs no second pair of Orca subprocess calls.
   */
  let taskSpec: string | null = null;

  /**
   * The route this session is bound to, once one has been applied.
   *
   * Closure state, not settings state, on purpose: it is read by the
   * pre-provider fence on every request, and a settings read would answer with
   * whatever the last override left behind.
   */
  let route: RoutingPlan | null = null;
  /**
   * The retry settings as this PROCESS held them before this session armed
   * anything, captured once at the first arm.
   *
   * Captured rather than cleared because the baseline may itself live in the
   * runtime override layer — OMP arms that layer at startup for `--model`
   * pattern fallback, and `task` arms it per subagent — and `clearOverride`
   * would delete the operator's own routing along with ours. Restoration writes
   * these values back.
   */
  let retryBaseline: { chains: Record<string, string[]>; modelFallback: unknown } | null = null;
  /** Whether the plan's chains are currently armed in the process settings. */
  let chainArmed = false;
  /**
   * Whether the master switch was forced on by THIS session, so restoration
   * writes back only a value it actually replaced.
   */
  let fallbackForced = false;
  /**
   * `provider/id:effort` this session was last observed about to serve.
   *
   * Its only job is to make a MOVE inside the approved set visible: OMP's
   * fallback publishes nothing an extension can hear (`model_changed` maps to no
   * extension hook), so the pre-provider fence is the only place a hop can be
   * noticed, and a receipt per hop is the only durable trace of which approved
   * candidate actually produced the work.
   */
  let served: string | null = null;
  /**
   * Terminal routing refusal. A session that cannot prove it is serving an
   * approved model does not get to act: every tool call is blocked and every
   * provider request is aborted for the rest of its life.
   */
  let refusal: { detail: string; requested: string | null; actual: string | null } | null = null;
  /**
   * How many of this session's tools are running right now.
   *
   * A turn can run several at once, so "a tool finished" is not "no tool is
   * running": re-arming on the first result would put this session's route back
   * into the process settings while a sibling `task` is still live and about to
   * spawn a child that snapshots them.
   *
   * Counts can go UNMATCHED: a blocked or cancelled tool call reports no
   * `tool_result`, and a counter stuck above zero would keep the chains down for
   * the rest of the session. `before_agent_start` clears it, because a new
   * top-level turn cannot begin while a tool from the previous one is still
   * running — that is the only boundary at which a leftover count is provably
   * stale rather than a live batch.
   */
  let toolsInFlight = 0;

  /**
   * Put the plan's fallback policy into the process settings.
   *
   * Keyed by `provider/id` so no ROLE is touched — not `default`, not `task`,
   * and not the role a pinned subagent persona resolves through. An exact model
   * key beats a role key in OMP's own chain resolution, so this narrows the
   * worker's own model and nothing else.
   *
   * `retry.modelFallback` is forced on ONLY for a multi-candidate route: the
   * operator approved the siblings, and leaving the master switch off would turn
   * an approved in-set hop into a dead turn. A pinned singleton arms an EMPTY
   * chain instead, which OMP reads as "no fallbacks" rather than "inherit the
   * default chain" — so the master switch is left exactly as configured.
   *
   * TIMING is the whole safety argument. Armed at points that each precede a
   * model call (`before_agent_start`, `tool_result`, and the pre-provider hook
   * itself), because the usage-aware preflight that can hop models runs BEFORE
   * the payload hook and must see the narrowed chains. Restored at `tool_call`,
   * which is the one moment a tool — `task`, `eval` — can spawn a child that
   * snapshots the process-global settings.
   */
  const armRetry = (): void => {
    if (route === null || chainArmed || toolsInFlight > 0) return;
    const store = pi.pi?.settings;
    if (store?.override === undefined || store.get === undefined) return;
    retryBaseline ??= {
      chains: sanitizeChains(store.get('retry.fallbackChains')),
      modelFallback: store.get('retry.modelFallback'),
    };
    try {
      store.override('retry.fallbackChains', mergeFallbackChains(retryBaseline.chains, route));
      if (route.candidates.length > 1 && retryBaseline.modelFallback !== true) {
        store.override('retry.modelFallback', true);
        fallbackForced = true;
      }
      chainArmed = true;
    } catch (error) {
      pi.logger?.warn?.(`[orca-model] ${instance} fallback policy not armed: ${String(error)}`);
    }
  };

  /**
   * Put the captured baseline back. Idempotent, and a no-op when nothing was armed.
   *
   * The master switch is written back only when THIS session forced it, and then
   * with the captured value even if that value is `undefined`: `Settings.override`
   * writes the runtime layer and its merge skips `undefined` keys, so writing the
   * capture back removes our entry and the effective value returns to the config
   * layers or the schema default. Skipping the write instead would leave a forced
   * `true` behind on exactly the session that never configured one.
   */
  const restoreRetry = (why: string): void => {
    if (!chainArmed || retryBaseline === null) return;
    const store = pi.pi?.settings;
    if (store?.override === undefined) return;
    try {
      store.override('retry.fallbackChains', retryBaseline.chains);
      if (fallbackForced) {
        store.override('retry.modelFallback', retryBaseline.modelFallback);
        fallbackForced = false;
      }
      chainArmed = false;
    } catch (error) {
      pi.logger?.warn?.(`[orca-model] ${instance} fallback policy not restored (${why}): ${String(error)}`);
    }
  };

  /**
   * Refuse the route, terminally.
   *
   * Three levers, because no single one of them is a fence:
   *   - the tool surface is emptied, so a compliant model sees nothing to call;
   *   - `tool_call` returns `{ block: true }` for the rest of the session, which
   *     is the only hook that is fail-closed (its dispatcher passes an
   *     `onFailure` that blocks on a throw or timeout);
   *   - the next provider request is aborted before it is sent.
   * The armed chains are dropped too: a refused session must not leave its
   * routing in the settings a later subagent would snapshot.
   */
  const refuse = async (detail: string, requested: string | null, actual: string | null): Promise<void> => {
    const first = refusal === null;
    refusal = { detail, requested, actual };
    route = null;
    restoreRetry('routing refused');
    if (!first) return;
    pi.logger?.warn?.(`[orca-model] ${instance} routing refused: ${detail}`);
    try {
      pi.appendEntry?.('@flosrn/ax/routing-refused', { detail, requested, actual });
    } catch (error) {
      pi.logger?.warn?.(`[orca-model] ${instance} refusal not recorded: ${String(error)}`);
    }
    try {
      await pi.setActiveTools?.([]);
    } catch (error) {
      // The `tool_call` fence is the hard boundary; this only hides the surface.
      pi.logger?.warn?.(`[orca-model] ${instance} tool lock failed: ${String(error)}`);
    }
  };

  const once = async (occasion: string, ctx: unknown, final: boolean): Promise<void> => {
    if (isSubagentSession(ctx)) {
      // Its parent's marker is not addressed to it, and its own model was
      // already chosen by the task subsystem. Settle so the second occasion
      // does not re-ask, and stay quiet: this fires on every subagent of every
      // supervised session, so a warn here would be noise on the main path.
      settled = true;
      return;
    }
    const facade = (ctx as HandlerContext | null)?.models;
    if (facade?.resolve === undefined) {
      // Say it rather than no-op: this is exactly the failure that made the first
      // version invisible for a full session.
      pi.logger?.warn?.(`[orca-model] ${instance} ${occasion}: no models facade on ctx — cannot resolve`);
      return;
    }

    const handle = seams.handle !== undefined ? seams.handle : (process.env.ORCA_TERMINAL_HANDLE ?? null);
    const run = seams.run ?? createRunner(resolveOrcaBin().bin);
    const outcome = await applyDispatchedModel({
      run,
      handle,
      resolve: (spec) => facade.resolve?.(spec),
      setModel: (model) => pi.setModel(model),
      setThinkingLevel: pi.setThinkingLevel?.bind(pi),
      configuredRole: (role) => pi.pi?.settings?.getModelRole?.(role),
      // Only reached on `absent`, and only acted on when it carries a marker.
      //
      // Two sources, in this order and for one reason each. The submitted prompt
      // is authoritative and race-free, but it exists only in the process that
      // received it. The transcript covers what that misses: a session RESUMED
      // into an existing worktree never sees an `input` event for the spec that
      // started it. `session_start` finds neither, which is why
      // `before_agent_start` is the occasion that makes a cross-host worker work.
      localSpec: () =>
        firstInput !== null
          ? { spec: firstInput }
          : readSpecFromTranscript((ctx as HandlerContext | null)?.sessionManager?.getSessionFile?.()),
    });

    if (outcome.applied) {
      settled = true;
      taskSpec = outcome.taskSpec;
      if (outcome.routing !== undefined) {
        // Effort is enforced per candidate, and the only thing that can say what
        // effort the session is ACTUALLY carrying into a request is
        // `getThinkingLevel`. `setThinkingLevel` returns void and validates
        // nothing, so a successful call is not proof. A host without the reader
        // cannot be held to the contract — refuse rather than pretend.
        if (pi.getThinkingLevel === undefined) {
          await refuse(
            'host exposes no getThinkingLevel — the served effort cannot be verified before a request',
            outcome.requested,
            outcome.model,
          );
          return;
        }
        // `ctx.abort()` is the ONLY lever that stops a request before it is sent
        // (a throw from the payload hook is swallowed by the runner). A runtime
        // without it cannot enforce the candidate set at all, so the route is
        // refused HERE — before the first request — rather than at a fence that
        // would be theatre.
        if (typeof (ctx as { abort?: unknown } | null)?.abort !== 'function') {
          await refuse(
            'runtime exposes no ctx.abort — an out-of-set provider request could not be prevented',
            outcome.requested,
            outcome.model,
          );
          return;
        }
        // The apply must be OBSERVABLY true before it is journaled. A receipt
        // saying "serving at high" while the session carries `medium` is the
        // fiction this whole fence exists to remove, and `setThinkingLevel`
        // reports nothing — so read it back and refuse a disagreement.
        const applied = pi.getThinkingLevel() ?? null;
        if (applied !== outcome.routing.effort) {
          await refuse(
            `effort ${outcome.routing.effort} was requested but the session reports ${applied ?? '<unset>'}`,
            outcome.routing.selector,
            `${outcome.model}:${applied ?? 'unset'}`,
          );
          return;
        }
        route = outcome.routing;
        served = `${outcome.model}:${applied}`;
        // Armed now, before the first model call: the usage-aware preflight that
        // can move the model runs earlier than the payload hook.
        armRetry();
      }
      try {
        pi.appendEntry?.('@flosrn/ax/model-assignment', {
          requested: outcome.requested,
          model: outcome.model,
          thinking: pi.getThinkingLevel === undefined ? outcome.thinking : pi.getThinkingLevel() ?? null,
          via: outcome.via,
          ...(outcome.routing === undefined
            ? {}
            : {
                // Flat, because a consumer checking "is this the enforced
                // contract?" should not have to know the nesting.
                routingVersion: outcome.routing.version,
                routing: {
                  version: outcome.routing.version,
                  mode: outcome.routing.mode,
                  selector: outcome.routing.selector,
                  candidates: outcome.routing.candidates.map((candidate) => candidate.selector),
                  requestedEffort: outcome.routing.effort,
                },
              }),
        });
      } catch (error) {
        pi.logger?.warn?.(`[orca-model] assignment not recorded: ${String(error)}`);
      }
      const suffix = outcome.thinking === null ? '' : ` (thinking ${outcome.thinking})`;
      const note = outcome.detail === undefined ? '' : ` — ${outcome.detail}`;
      const bound =
        outcome.routing === undefined
          ? ''
          : ` bound to ${outcome.routing.mode} route [${outcome.routing.candidates.map((c) => c.selector).join(' > ')}]`;
      pi.logger?.info?.(
        `[orca-model] ${instance} ${occasion}: serving ${outcome.model}${suffix} from ${outcome.source} via ${outcome.via}${bound}${note}`,
      );
      return;
    }

    if (outcome.why === 'routing-refused') {
      // Never provisional. A malformed or unenforceable route is the same answer
      // at every occasion, and a worker that keeps retrying it would keep acting
      // in between.
      settled = true;
      await refuse(outcome.detail ?? 'no detail', null, null);
      return;
    }

    if (outcome.why === 'not-supervised') {
      // No Orca handle at all. Nothing later can change that, so stop looking.
      settled = true;
      return;
    }

    if (outcome.why === 'absent') {
      // Orca answered and we are not in its worker list. At `session_start` that
      // may only mean the Dispatch is not recorded yet — Orca creates the
      // terminal and injects the task in one call, and that ordering is not ours
      // to choose — so the next occasion must be allowed to look again. At the
      // final occasion it means this is an ordinary interactive session in an
      // Orca pane, which is the common case and must stay SILENT: warning here
      // would fire on every session the operator opens.
      if (final) settled = true;
      return;
    }

    // `lookup-failed` and `unresolved` stay unsettled at the PROVISIONAL occasion
    // on purpose: both can be transient at boot, and `before_agent_start` is the
    // retry. At the final occasion there is no next occasion, and leaving them
    // open is not patience — `before_agent_start` fires on every user prompt, so
    // an unsettled refusal spawns an Orca subprocess and reprints itself once per
    // turn for the life of the terminal. That is the ordinary fate of a reused
    // terminal: its dispatch reads `completed`, so the refusal is permanent and
    // identical. Measured: 11 lookups and 11 warn lines for one session and ten
    // prompts. Say it once, then stop.
    if (final) settled = true;
    pi.logger?.warn?.(`[orca-model] ${instance} ${occasion}: ${outcome.why} — ${outcome.detail ?? 'no detail'}`);
  };

  /** Serializes the two occasions so `setModel` fires at most once. */
  const attempt = async (occasion: string, ctx: unknown, final: boolean): Promise<void> => {
    if (settled) return;
    if (running !== null) {
      await running;
      if (settled) return;
    }
    running = once(occasion, ctx, final);
    try {
      await running;
    } finally {
      running = null;
    }
  };

  /**
   * The pre-provider fence — the LAST point at which a request can be stopped.
   *
   * Two facts about this hook decide its shape, both read off the installed
   * runtime rather than assumed:
   *
   *   1. A THROW HERE IS SWALLOWED. `emitBeforeProviderRequest` dispatches
   *      through `#runHandlerWithTimeout` with no `onFailure`, so a rejected
   *      handler resolves to `undefined`, the payload is kept unchanged and the
   *      request is sent anyway. Enforcement by exception would be fiction.
   *   2. `ctx.abort()` REACHES THE WIRE. It runs `AgentSession.abort()`, whose
   *      statements up to `agent.abort(reason)` are synchronous, aborting the
   *      loop `AbortController` whose signal is composed into the request signal
   *      the provider hands its SDK immediately after this hook returns. An
   *      already-aborted signal at request creation means the bytes never leave.
   *      The abort is flavoured as an interrupt, which turn-recovery explicitly
   *      excludes from fallback replay — so a refusal cannot be "recovered" onto
   *      another model.
   *
   * The payload is returned untouched in every branch: this hook decides whether
   * the request happens, never what it says.
   */
  pi.on('before_provider_request', (event, ctx) => {
    const payload = (event as { payload?: unknown } | null)?.payload;
    // A `task` child is its own session with its own pinned model. Its requests
    // are none of this session's business, and its settings are a separate
    // instance anyway.
    if (isSubagentSession(ctx)) return payload;
    // The hot path: an unrouted, unrefused session (a legacy marker, an ordinary
    // interactive pane) has nothing to enforce, so it does not pay for the bind.
    if (refusal === null && route === null) return payload;
    // `typeof`, not `!== undefined`: a truthy non-function would throw inside
    // this handler, and the runner SWALLOWS that — the request would then go out
    // while the log claimed a refusal.
    const raw = (ctx as { abort?: unknown } | null)?.abort;
    const abort = typeof raw === 'function' ? (raw as () => void).bind(ctx) : null;

    if (refusal !== null) {
      abort?.();
      return payload;
    }
    if (abort === null) {
      // Enforcement is impossible on this runtime and saying so is the only
      // honest move: the tool fence still stops the session from acting, but
      // this particular request cannot be stopped, and pretending otherwise is
      // the fail-open fiction this fence exists to replace.
      void refuse(
        'runtime exposes no ctx.abort at before_provider_request — this request could not be prevented',
        route.selector,
        modelIdentity((ctx as { model?: unknown } | null)?.model),
      );
      return payload;
    }

    const identity = modelIdentity((ctx as { model?: unknown } | null)?.model);
    const candidate: RoutingCandidate | null = candidateFor(route, identity);
    if (candidate === null) {
      // Out of the approved set. This is the case the whole payload exists for:
      // a quota or error fallback that escaped the chain, a `/model` switch, a
      // provider-side reroute. Refuse the session, not just the request — the
      // next one would be identical.
      void refuse(
        `request would go to ${identity ?? '<unnamed>'}, which is not in the approved set [${route.candidates
          .map((entry) => entry.selector)
          .join(', ')}]`,
        route.selector,
        identity,
      );
      abort?.();
      return payload;
    }

    const serving = pi.getThinkingLevel?.() ?? null;
    if (serving !== candidate.effort) {
      // The model is approved; the effort it is about to serve at is not. The
      // payload is already built by the provider from the session level, in a
      // provider-native shape, so correcting it here would mean reimplementing
      // pi-ai's effort mapping per API — a second copy of a table that rots.
      // Correct the session level (which the NEXT request will build from) and
      // refuse this one.
      void (async () => {
        try {
          await pi.setThinkingLevel?.(candidate.effort);
        } catch (error) {
          pi.logger?.warn?.(`[orca-model] ${instance} effort not corrected: ${String(error)}`);
        }
      })();
      void refuse(
        `${candidate.model} is approved at effort ${candidate.effort} but the session would serve ${serving ?? '<unset>'}`,
        candidate.selector,
        `${candidate.model}:${serving ?? 'unset'}`,
      );
      abort?.();
      return payload;
    }

    // Approved, at the approved effort.
    const current = `${candidate.model}:${candidate.effort}`;
    if (current !== served) {
      // A move inside the approved set — OMP's own fallback walking the chain
      // this session armed. The receipt keeps the parent's ORIGINAL requested
      // selector so the dispatch it belongs to stays identifiable, and names the
      // candidate now serving, which is the pair an auditor needs.
      served = current;
      try {
        pi.appendEntry?.('@flosrn/ax/model-assignment', {
          requested: route.selector,
          model: candidate.model,
          thinking: candidate.effort,
          via: 'fallback',
          routingVersion: route.version,
          routing: {
            version: route.version,
            mode: route.mode,
            selector: route.selector,
            candidates: route.candidates.map((entry) => entry.selector),
            requestedEffort: route.effort,
          },
        });
      } catch (error) {
        pi.logger?.warn?.(`[orca-model] ${instance} fallback receipt not recorded: ${String(error)}`);
      }
      pi.logger?.info?.(`[orca-model] ${instance} serving approved candidate ${current} for route ${route.selector}`);
    }

    // Arm the chains for THIS request so a fallback chosen during it walks the
    // approved order and carries each candidate's own effort.
    armRetry();
    return payload;
  });

  /**
   * The tool fence, and the one place the settings override is wound back.
   *
   * Both jobs belong on this hook because both are about what a tool is allowed
   * to do next. `task` and `eval` spawn children, and a child snapshots the
   * process-global settings AT SPAWN TIME — so the armed route must be gone
   * before any tool runs, or a subagent inherits it as its own fallback policy.
   * Blocking is fail-closed here: `emitToolCall` passes an `onFailure` that
   * blocks the tool if this handler throws or times out.
   *
   * COUNTED, not toggled. A turn can run several tools at once, and a single
   * flag would re-arm on the FIRST result while a sibling `task` is still
   * running and may spawn a child a moment later. The override stays down until
   * the last in-flight tool has reported.
   */
  pi.on('tool_call', (_event, ctx) => {
    if (isSubagentSession(ctx)) return undefined;
    toolsInFlight += 1;
    restoreRetry('tool call');
    return refusal === null
      ? undefined
      : { block: true, reason: `approved model route refused: ${refusal.detail}` };
  });

  /**
   * Re-arm once no tool is still running.
   *
   * `tool_call` unwinds the override, which leaves the loop unarmed until the
   * next model call — and the usage-aware preflight on that call runs EARLIER
   * than the payload hook, so the window has to be closed before it. Closing it
   * at zero in-flight tools is the earliest moment no spawn can still inherit.
   * A result with no matching call (a runtime that reports one without the
   * other) floors the counter rather than driving it negative.
   */
  pi.on('tool_result', (_event, ctx) => {
    if (isSubagentSession(ctx)) return undefined;
    toolsInFlight = Math.max(0, toolsInFlight - 1);
    if (toolsInFlight === 0) armRetry();
    return undefined;
  });

  // Last resort. The tool hook covers every in-session spawn; this covers the
  // session ending mid-request, so nothing outlives the process holding an
  // override this session installed.
  pi.on('session_shutdown', (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    restoreRetry('shutdown');
  });

  /** The second machine: role activation, fed the spec the model half resolved. */
  const roles = roleActivation({ pi, instance, seams, taskSpecOf: () => taskSpec });

  // TWO OCCASIONS, BECAUSE THE ORDER IS NOT OURS TO CHOOSE.
  // `worker-start --agent omp` creates the terminal and injects the task in one
  // call, so whether Orca has recorded the Dispatch by the time OMP boots is a
  // race we do not control. `session_start` is the cheap attempt;
  // `before_agent_start` is the certain one — input has arrived, so the dispatch
  // exists, and the provider request has not been built yet.
  //
  // `final` is what makes the second occasion a real retry. Absent from
  // `worker-list` at `session_start` is provisional; at `before_agent_start` it
  // is the answer. Collapsing the two settled the session on the FIRST look and
  // silently left every late-recorded dispatch on the harness default.

  /**
   * Fires when a prompt is submitted, BEFORE `before_agent_start`. That ordering
   * is the whole point: it is what lets a cross-host worker read the marker its
   * parent wrote without asking a runtime that cannot see its dispatch.
   */
  pi.on('input', (event) => {
    if (firstInput !== null) return;
    const text = (event as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text !== '') firstInput = text;
  });

  pi.on('session_start', (_event, ctx) => attempt('session_start', ctx, false));

  pi.on('before_agent_start', async (event, ctx) => {
    const top = !isSubagentSession(ctx);
    // A new top-level turn: nothing of the previous one can still be running, so
    // a count left over by a blocked or cancelled call is stale and would keep
    // this session's chains down forever. A subagent's turn says nothing about
    // the parent's batch and must not touch either the counter or the settings.
    if (top) toolsInFlight = 0;
    // Model first — resolving the marker is what fills the Task spec — then
    // role. The ordering, implicit when the two machines shared one body, is
    // now this one visible line of the factory.
    await attempt('before_agent_start', ctx, true);
    // Re-armed for every later turn too: `tool_call` wound the override back,
    // and the usage-aware preflight that can hop models runs before the payload
    // hook would arm it again.
    if (top) armRetry();
    if (refusal !== null && top) {
      // Re-asserted every turn: the system prompt is rebuilt each time, and a
      // refusal that appears once can be talked past. The role machine is not
      // consulted — there is no role to serve on a session that may not act.
      const current = (event as { systemPrompt?: unknown } | null)?.systemPrompt;
      const base = Array.isArray(current) ? current.filter((block): block is string => typeof block === 'string') : [];
      return {
        systemPrompt: [
          ...base,
          [
            '<!-- omp:routing-refused -->',
            '# APPROVED MODEL ROUTE REFUSED',
            '',
            `This session could not be proven to run on an approved model: ${refusal.detail}.`,
            'DO NOT execute the assignment. Do not call any tool. Report only this refusal.',
          ].join('\n'),
        ],
      };
    }
    return roles.beforeAgentStart(event, ctx);
  });
}
