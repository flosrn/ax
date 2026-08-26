/**
 * Role activation — the second machine the `orcaModel` factory composes.
 *
 * The model half decides WHAT this session serves; this half decides WHO it is
 * allowed to be: the role block appended to the system prompt, the playbook
 * message, the tool surface, and the non-bypassable refusal fence. The one
 * fact it consumes from the model half is the resolved Task spec, injected as
 * `taskSpecOf` — a role intent rides the same marker the model did — so this
 * machine can be driven without the model-application preamble.
 */

import { applyRoleBody, readRoleIntent } from './role.ts';
import {
  loadPlaybook as loadPackagePlaybook,
  loadRole as loadPackageRole,
  type PlaybookLookup,
  type RoleLookup,
} from './roles.ts';
import { isSubagentSession } from '../shared/session.ts';
import type { FactorySeams, ModelHost } from './index.ts';

export function roleActivation({
  pi,
  instance,
  seams,
  taskSpecOf,
}: {
  pi: ModelHost;
  instance: string;
  seams: FactorySeams;
  taskSpecOf: () => string | null;
}): { beforeAgentStart(event: unknown, ctx: unknown): Promise<{ systemPrompt: string[]; message?: unknown } | undefined> } {
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

  const beforeAgentStart = async (event: unknown, ctx: unknown): Promise<{ systemPrompt: string[]; message?: unknown } | undefined> => {
    // A subagent is not the session any marker addressed, and it must not
    // inherit its parent's role either (R4a / KD11).
    if (isSubagentSession(ctx)) return undefined;

    const name = optInRole ?? readRoleIntent(taskSpecOf());
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
  };

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

  return { beforeAgentStart };
}
