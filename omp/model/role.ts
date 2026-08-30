/**
 * Applies a ROLE to the session Orca dispatched — the second thing that has to
 * survive the Orca/OMP seam, after the model.
 *
 * WHY THIS EXISTS
 * OMP already has a complete role model — `tools`, `spawns`, `model`,
 * `thinkingLevel`, `systemPrompt`, `autoloadSkills` — and it applies only to
 * in-process `task` subagents. A session Orca launches is a top-level session
 * and inherits none of it: there is no `--agent` flag, only `--tools`, and using
 * that forces `terminal create --command`, which costs `worker-release`.
 *
 * So a dispatched supervisor arrived as a generic agent that had been told its
 * job in prose. This reads the role its parent named and gives the session the
 * body its role file declares, on the channel that already carries the model.
 */

import { parseMarker } from './alias.ts';

/**
 * Where a role body is fenced in the system prompt.
 *
 * NOT because an unguarded append accumulates across turns — it does not, and an
 * earlier version of this comment said it did, citing a measurement that says the
 * opposite. `buildSystemPromptForAgentStart` returns the session's `#baseSystemPrompt`,
 * rebuilt from templates; `setSystemPrompt` sets the agent's prompt for one request and
 * never feeds back into that base. Measured 2026-08-07, one process, two real user turns
 * in an interactive session: `incoming_sentinels=0` on BOTH, outgoing 1 on both.
 *
 * The sentinel earns its place on the cases that are real. `before_agent_start` chains
 * across extensions — each handler receives the previous handler's array — so a second
 * extension appending after this one, or this one running twice inside a single turn,
 * would otherwise leave two copies. It also makes a role SWITCH correct: replacing in
 * place is what stops a session from carrying its old body and its new one at once.
 */
const ROLE_OPEN = '<!-- omp:role -->';

/** Read the role a parent named, or `null` when it named none. */
export function readRoleIntent(spec: string | null): string | null {
  if (spec === null) return null;
  const parsed = parseMarker(spec);
  if (parsed.kind !== 'keys') return null;
  const role = parsed.keys.get('role');
  return role === undefined || role === '' ? null : role;
}

/**
 * Append the role body to the system prompt, idempotently.
 *
 * APPENDED, NEVER SUBSTITUTED, and this is an invariant rather than a taste.
 * `setSystemPrompt(result.systemPrompt)` replaces the WHOLE prompt, so returning
 * only the role block drops OMP's tool policy, the internal-URL catalog, the
 * exploration and delegation rules and the `xd://` guidance. Measured
 * 2026-08-07: replacing took the prompt from 62 239 to 143 characters and the
 * payload from 107 794 to 44 059 — AND THE SESSION STILL ANSWERED CORRECTLY.
 * No error, no warning, a plausible reply. That is why the rule is absolute:
 * the violation fails beautifully, so nothing but a rule catches it.
 */
export function applyRoleBody(current: readonly string[], body: string): string[] {
  const block = `${ROLE_OPEN}\n${body.trim()}`;
  const existing = current.findIndex((entry) => entry.startsWith(ROLE_OPEN));
  if (existing >= 0) {
    // Same role re-asserted: replace in place rather than grow. A DIFFERENT
    // body replacing an old one is also correct — a session that switched roles
    // must not carry both.
    if (current[existing] === block) return [...current];
    const next = [...current];
    next[existing] = block;
    return next;
  }
  return [...current, block];
}

/**
 * A role as its file declares it, narrowed to what a session can apply.
 *
 * Loaded by `./roles.ts` from this package's own `roles/` directory. It used to
 * be extracted from whatever OMP's `discoverAgents` had found, on the argument
 * that the host owns precedence and merge and re-implementing that would drift.
 * The argument was sound and the conclusion was wrong: it made these roles
 * task-agent files, so they appeared in subagent discovery where a `readiness`
 * is actively harmful, they could not ship inside a package, and a role on a
 * branch did not exist for any session until it landed in the main checkout
 * (measured 2026-08-07). Owning the files is what makes a role a session
 * identity rather than a subagent template.
 */
export interface RoleDefinition {
  name: string;
  systemPrompt: string;
  autoloadSkills?: string[];
  tools?: string[];
}
