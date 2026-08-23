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
import { applyRoleBody, readRoleIntent } from './role.ts';
import {
  loadPlaybook as loadPackagePlaybook,
  loadRole as loadPackageRole,
  type PlaybookLookup,
  type RoleLookup,
} from './roles.ts';
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
   * Resolve a role body by name, from the files THIS PACKAGE ships.
   *
   * It used to ask OMP's `discoverAgents`, and that reuse cost three defects at
   * once — a role on a branch that no session could see, four session roles
   * polluting task-agent discovery, and a package that could not ship its own
   * roles at all. `./roles.ts` carries the full account.
   *
   * A named-but-absent role is returned as `null`; the caller locks the session
   * before its first provider turn. Letting a supervised worker continue as a
   * generic agent is not graceful degradation: the missing role is the authority
   * boundary that says whether this session may merge, publish, or mutate at all.
   *
   * `cwd` is gone from the signature, and its absence is the point: the roles
   * this session may take are a property of the installed package, not of the
   * directory the session happens to be sitting in.
   */
  const resolveRole = async (name: string): Promise<RoleLookup> => {
    const load = seams.loadRole ?? ((wanted: string) => loadPackageRole(wanted));
    let found: RoleLookup;
    try {
      found = await load(name);
    } catch (error) {
      // A rejected loader must not escape the handler: `before_agent_start`
      // returning nothing at all leaves the session with no role AND no refusal,
      // which is the one outcome worse than either.
      const detail = `role loader threw: ${String(error)}`;
      pi.logger?.warn?.(`[orca-model] ${instance} role ${name}: ${detail}`);
      return { role: null, reason: 'role-load-failed', detail };
    }
    if (found.role === null) {
      pi.logger?.warn?.(`[orca-model] ${instance} role ${name}: ${found.detail}`);
    }
    return found;
  };

  interface SkillLoad {
    content: string | null;
    loaded: string[];
    missing: string[];
    reason: 'ok' | 'skill-load-failed' | 'skill-not-found';
  }

  /**
   * Hand the role the playbook bodies its file declares, before its first turn.
   *
   * Delivered as a MESSAGE rather than appended to the system prompt, because a
   * playbook is content the session was handed, not part of who it is — and
   * because that is exactly what OMP's own `runSubprocess` does for an
   * autoloading subagent. Messages persist, so this fires once per session; the
   * role block can be re-asserted every turn only because the prompt is rebuilt
   * each time.
   *
   * Missing is data, never a quiet skip. Native task-agent autoload ignores an
   * unknown name; a top-level session role cannot. The playbook is the procedure
   * that makes the role executable, so the caller locks the session when any
   * declared body cannot be delivered.
   *
   * The `autoloadSkills` FIELD NAME is kept from the role files it reads, and the
   * bodies no longer come from OMP skill discovery. Renaming the field would have
   * been tidier and would also have silently un-declared the playbooks of any role
   * file not edited in the same commit — a rename whose failure mode is "the role
   * quietly asks for nothing" is not worth a better word.
   */
  const skillMessage = async (names: readonly string[]): Promise<SkillLoad> => {
    const load = seams.loadPlaybook ?? ((wanted: string) => loadPackagePlaybook(wanted));

    const bodies: string[] = [];
    const loaded: string[] = [];
    const missing: string[] = [];
    let threw = false;
    for (const wanted of names) {
      let found: PlaybookLookup;
      try {
        found = await load(wanted);
      } catch (error) {
        pi.logger?.warn?.(`[orca-model] ${instance} autoload: playbook ${wanted} threw: ${String(error)}`);
        threw = true;
        missing.push(wanted);
        continue;
      }
      if (found.content === null) {
        pi.logger?.warn?.(`[orca-model] ${instance} autoload: ${found.detail}`);
        if (found.reason === 'playbook-load-failed') threw = true;
        missing.push(wanted);
        continue;
      }
      bodies.push(found.content);
      loaded.push(wanted);
    }
    return {
      content: bodies.length === 0 ? null : bodies.join('\n\n'),
      loaded,
      missing,
      // Two words for two different faults, kept apart because the operator's
      // next move differs: `skill-not-found` is a name this package does not
      // ship, `skill-load-failed` is a body it ships and could not read.
      reason: missing.length === 0 ? 'ok' : threw ? 'skill-load-failed' : 'skill-not-found',
    };
  };

  /** The role the operator activated in their own session, if any (KD2/KD13). */
  let optInRole: string | null = null;

  /** The role whose skill/receipt message was already delivered. */
  let roleMessageSentFor: string | null = null;

  /** A supervised session whose requested role could not be established never regains tools. */
  let roleRefusal: {
    role: string;
    reason: string;
    missingSkills: string[];
    detail: string;
  } | null = null;

  /** The role whose tool surface was already applied, so it narrows once. */
  let toolsSetFor: string | null = null;

  const refusalBlock = (refusal: NonNullable<typeof roleRefusal>): string =>
    [
      '<!-- omp:role-refused -->',
      '# SESSION ROLE REFUSED',
      '',
      `The requested role \`${refusal.role}\` could not be established: ${refusal.detail}.`,
      'DO NOT execute the assignment. Do not call any tool. Report only this refusal.',
    ].join('\n');

  const refuseRole = async (
    base: string[],
    refusal: NonNullable<typeof roleRefusal>,
  ): Promise<{ systemPrompt: string[]; message?: unknown }> => {
    const first = roleRefusal === null;
    roleRefusal = refusal;
    if (first) {
      try {
        await pi.setActiveTools?.([]);
      } catch (error) {
        // The tool_call fence below is the hard boundary. Hiding the surface is
        // still attempted so a compliant model never sees tools it cannot use.
        pi.logger?.warn?.(`[orca-model] ${instance} role ${refusal.role}: tool lock failed: ${String(error)}`);
      }
    }
    return {
      systemPrompt: [...base, refusalBlock(refusal)],
      message: first
        ? {
            customType: 'role-refused',
            content: `Role ${refusal.role} refused: ${refusal.detail}`,
            display: false,
            details: {
              role: refusal.role,
              reason: refusal.reason,
              missingSkills: refusal.missingSkills,
            },
          }
        : undefined,
    };
  };

  // `setActiveTools([])` removes the visible surface, but this hook is the
  // non-bypassable boundary when the runtime refuses that cosmetic narrowing.
  // It is armed before any role lookup and reads closure state set by
  // `before_agent_start`, which runs before the provider can issue a tool call.
  pi.on('tool_call', () =>
    roleRefusal === null
      ? undefined
      : {
          block: true,
          reason: `session role ${roleRefusal.role} was refused: ${roleRefusal.detail}`,
        },
  );

  /**
   * Apply the tool surface a role declares — under the one guard the measurement
   * demanded.
   *
   * `setActiveTools` REPLACES the active surface and silently ignores names the
   * registry does not know. Measured 2026-08-07: seven names requested against a
   * surface of 51 left four, `bash` among the casualties, and the narrowed
   * session answered "I have no bash/shell execution tool available in this
   * session." That is D-027 reproduced from the equip side — a muzzled report
   * channel — and R7 says the report channel is never behind a role
   * restriction, in any role, ever.
   *
   * So a list that does not carry the report channel is refused WHOLE rather
   * than applied partially: a session that looks narrowed and cannot report is
   * worse than one that was never narrowed. And every requested name the
   * registry does not know is named in the log, because a silent drop is
   * indistinguishable from a deliberate omission.
   *
   * This does not make the field safe in general — removing `edit` and `write`
   * while keeping `bash` still leaves `sed -i`, `python -c`, `tee` and
   * `git apply`. A tool list bounds capability; it does not sandbox it.
   */
  const REPORT_CHANNEL = 'bash';

  /**
   * @returns true only when the surface was actually applied. The caller latches
   * on that, never on the attempt — an unsuccessful narrowing that marks itself
   * done is the `settled = true` defect this very file was audited for on
   * 2026-08-07, and it silently disables every later retry.
   *
   * Nothing here throws out of the handler. A narrowing that fails must not take
   * the role body down with it: the body is the more important of the two, and
   * a handler that throws returns nothing at all.
   */
  const narrowTools = async (name: string, wanted: readonly string[]): Promise<boolean> => {
    // Called ON `pi`, never detached. `setActiveTools` is a method that reads
    // `this.runtime`; hoisting it into a local drops the receiver and throws a
    // TypeError at call time. This file already knew — `setModel` is wrapped in
    // an arrow and `setThinkingLevel` is `.bind(pi)` — and the lesson cost a
    // whole experiment arm: the narrowing silently never happened, the session
    // kept `edit`, and the only tell was one missing log line.
    if (pi.setActiveTools === undefined) {
      pi.logger?.warn?.(`[orca-model] ${instance} tools ${name}: host exposes no setActiveTools`);
      return false;
    }
    if (!wanted.includes(REPORT_CHANNEL)) {
      pi.logger?.warn?.(
        `[orca-model] ${instance} tools ${name}: refused whole — list omits the report channel (${REPORT_CHANNEL})`,
      );
      return false;
    }
    const known = new Set((pi.getAllTools?.() ?? []).map((t) => t?.name).filter((n): n is string => typeof n === 'string'));
    const missing = known.size === 0 ? [] : wanted.filter((n) => !known.has(n));
    if (missing.length > 0) {
      pi.logger?.warn?.(`[orca-model] ${instance} tools ${name}: registry does not know ${missing.join(', ')}`);
    }
    try {
      await pi.setActiveTools([...wanted]);
    } catch (error) {
      // Measured 2026-08-07: an apply that rejected produced NO log line at all,
      // and the only tell was a missing success message. A narrowing that fails
      // in silence is a session that believes it is constrained and is not.
      pi.logger?.warn?.(
        `[orca-model] ${instance} tools ${name}: apply failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    pi.logger?.info?.(`[orca-model] ${instance} tools ${name}: surface set to ${wanted.join(', ')}`);
    return true;
  };

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
    await attempt('before_agent_start', ctx, true);

    // A subagent is not the session any marker addressed, and it must not
    // inherit its parent's role either (R4a / KD11).
    if (isSubagentSession(ctx)) return undefined;

    const name = optInRole ?? readRoleIntent(taskSpec);
    if (name === null) return undefined;

    const current = (event as { systemPrompt?: unknown } | null)?.systemPrompt;
    const base = Array.isArray(current) ? current.filter((b): b is string => typeof b === 'string') : [];

    // A refusal is terminal for this session. Re-assert the system boundary on
    // every turn, but emit the durable refusal message and hide tools only once.
    if (roleRefusal !== null) return refuseRole(base, roleRefusal);

    const resolvedRole = await resolveRole(name);
    if (resolvedRole.role === null) {
      return refuseRole(base, {
        role: name,
        reason: resolvedRole.reason,
        missingSkills: [],
        detail: resolvedRole.detail,
      });
    }
    const role = resolvedRole.role;

    if (base.length === 0) {
      return refuseRole(base, {
        role: name,
        reason: 'role-prompt-unavailable',
        missingSkills: [],
        detail: 'OMP supplied no base system prompt to append the role to',
      });
    }

    const wanted = role.autoloadSkills ?? [];
    let skills: SkillLoad | null = null;
    if (wanted.length > 0 && roleMessageSentFor !== name) {
      skills = await skillMessage(wanted);
      if (skills.missing.length > 0 || skills.content === null) {
        return refuseRole(base, {
          role: name,
          reason: skills.reason,
          missingSkills: skills.missing.length > 0 ? skills.missing : [...wanted],
          detail: `required playbook(s) could not be loaded: ${(skills.missing.length > 0 ? skills.missing : wanted).join(', ')}`,
        });
      }
    }

    // APPENDED, never substituted. `setSystemPrompt` replaces the WHOLE prompt,
    // so returning the role block alone drops OMP's tool policy, the internal
    // URL catalog and the exploration rules — measured at 62 239 -> 143
    // characters, with the session still answering correctly. The violation
    // fails beautifully, so only the rule catches it.
    pi.logger?.info?.(`[orca-model] ${instance} before_agent_start: serving role ${name}`);
    const applied: { systemPrompt: string[]; message?: unknown } = {
      systemPrompt: applyRoleBody(base, role.systemPrompt),
    };

    if (skills !== null && skills.content !== null) {
      roleMessageSentFor = name;
      pi.logger?.info?.(`[orca-model] ${instance} autoload: ${skills.loaded.join(', ')} for role ${name}`);
      applied.message = {
        customType: 'skill-prompt',
        content: skills.content,
        display: false,
        details: { role: name, skills: skills.loaded, status: 'applied' },
      };
    }

    const surface = role.tools ?? [];
    if (surface.length > 0 && toolsSetFor !== name) {
      // Latch AFTER the apply, and only on success. Latching on the attempt
      // turns one transient failure into a permanently unconstrained session.
      if (await narrowTools(name, surface)) toolsSetFor = name;
    }
    return applied;
  });

  /**
   * `/role <name>` — the operator's own opt-in (KD2, KD13).
   *
   * Nothing dispatches the operator, so no marker can reach them; and this
   * adapter's standing invariant is that an operator's deliberate choice is
   * never overwritten. Activation is therefore explicit, idempotent, and
   * announces what it did — in the one session where a silently applied role
   * would be indistinguishable from no role at all. It never touches the model.
   */
  pi.registerCommand?.('role', {
    description: 'Apply a session role to THIS session; /role off clears it.',
    handler: async (args: unknown, cmdCtx: unknown) => {
      const wanted = String(args ?? '').trim();
      const say = (line: string): void => {
        const ui = (cmdCtx as { ui?: { notify?(m: string): void } } | null)?.ui;
        if (ui?.notify !== undefined) ui.notify.call(ui, line);
        pi.logger?.info?.(`[orca-model] ${instance} /role: ${line}`);
      };
      if (wanted === '' || wanted === 'off') {
        optInRole = null;
        // A cleared role must be able to come back with its skills: the
        // once-guard is per role, and clearing forgets which one was served.
        roleMessageSentFor = null;
        say('role cleared — takes effect on your next message');
        return;
      }
      const resolvedRole = await resolveRole(wanted);
      if (resolvedRole.role === null) {
        say(`role ${wanted} unavailable: ${resolvedRole.detail}`);
        return;
      }
      const role = resolvedRole.role;
      optInRole = wanted;
      const skills = role.autoloadSkills ?? [];
      const carrying = skills.length === 0 ? '' : `; preloading ${skills.join(', ')}`;
      say(`role ${wanted} applied — model untouched${carrying}; takes effect on your next message`);
    },
  });
}
