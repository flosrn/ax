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
      why: 'not-supervised' | 'absent' | 'unresolved' | 'lookup-failed';
      detail?: string;
    }
  | {
      applied: true;
      model: string;
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

  await deps.setModel(resolved);

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
    thinking,
    source: intent.source,
    via,
    detail: readReason ?? intent.reason,
    taskSpec: spec,
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
  logger?: { info?(message: string): void; warn?(message: string): void };
  /**
   * The injected pi-coding-agent exports. `settings.getModelRole(role)` returns
   * a role's RAW configured spec, suffix included — the one thing
   * `ctx.models.resolve()` throws away. Verified live inside a dispatched
   * session: `getModelRole('smol')` → `anthropic/claude-sonnet-5:medium`.
   */
  pi?: {
    settings?: { getModelRole?(role: string): string | undefined };
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
      const suffix = outcome.thinking === null ? '' : ` (thinking ${outcome.thinking})`;
      const note = outcome.detail === undefined ? '' : ` — ${outcome.detail}`;
      pi.logger?.info?.(
        `[orca-model] ${instance} ${occasion}: serving ${outcome.model}${suffix} from ${outcome.source} via ${outcome.via}${note}`,
      );
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
    // Model first — resolving the marker is what fills the Task spec — then
    // role. The ordering, implicit when the two machines shared one body, is
    // now this one visible line of the factory.
    await attempt('before_agent_start', ctx, true);
    return roles.beforeAgentStart(event, ctx);
  });
}
