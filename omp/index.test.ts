/**
 * The public factory, driven the way a project actually loads it.
 *
 * WHY AN INTEGRATION TEST AND NOT FOUR UNIT SUITES
 * Each sub-extension already has one. What none of them can see is the seam this
 * file replaced: four factories that used to be installed independently by the
 * harness are now installed by one function, in one order, from one entry point.
 * Every failure mode of that arrangement is invisible to a unit test — a factory
 * silently left out of the composition, a factory installed twice, a role that
 * resolves in a seam-driven test and not from the shipped files.
 *
 * THE DISCOVERY PROPOSITION IS THE POINT
 * The host facade below has NO `discoverAgents`, NO `loadSkills`, NO
 * `buildSkillPromptMessage`. Both activation paths are exercised against it with
 * the DEFAULT resolvers — no role seam, no playbook seam — so the only way they
 * can pass is by reading the files this package ships. A version of this test
 * that injected either seam would keep passing if the package lost its roles
 * directory entirely, which is the one thing it exists to catch.
 *
 * `session_start` is never fired. The model extension retries at
 * `before_agent_start` by design (`final: true`), which is all the role paths
 * need, and the peer/report extensions reach for Orca at `session_start` — a
 * subprocess this test has no business spawning to answer a question about
 * registration.
 */

import { expect, test } from 'bun:test';

import ax from './index.ts';
import type { OrcaRunner } from './model/self.ts';

const HANDLE = 'term_integration';
/** A top-level session file: `<slug>/<ts>_<uuid>.jsonl`, never one level deeper. */
const TOP_LEVEL =
  '/tmp/sessions/-repo/2026-08-23T09-00-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e99.jsonl';

function runnerFor(spec: string): OrcaRunner {
  return async (args) => {
    const verb = args[1] ?? '';
    if (verb === 'worker-list')
      return {
        value: {
          ok: true,
          result: {
            workers: [
              {
                agentTerminalHandle: HANDLE,
                workerState: 'running',
                dispatchStatus: 'dispatched',
                taskId: 't1',
                runId: 'r1',
                dispatchId: 'd1',
              },
            ],
            counts: {},
          },
        },
      };
    if (verb === 'task-list')
      return { value: { ok: true, result: { tasks: [{ id: 't1', spec }] } } };
    return { reason: `unexpected ${args.join(' ')}` };
  };
}

/**
 * The smallest `zod` the peer extension's tool declarations type-check against.
 *
 * Chainable and inert: this test asserts that the tools were REGISTERED and under
 * what names, never what their schemas validate. `reply-args.test.ts` borrows a
 * real zod for the argument-name contract, which is the question that needs one.
 */
function zodStub() {
  const leaf = (): unknown => {
    const node: Record<string, unknown> = {};
    node.optional = () => node;
    node.describe = () => node;
    return node;
  };
  return {
    object: (shape: unknown) => ({ shape, optional: leaf, describe: leaf }),
    string: leaf,
    number: leaf,
    enum: leaf,
  };
}

interface Installed {
  /** Every `pi.on` in order, so a duplicate registration is countable. */
  events: string[];
  handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
  commands: Map<string, { handler(args: unknown, ctx: unknown): unknown }>;
  tools: string[];
  activeTools: string[][];
  notices: string[];
  ctx: unknown;
  /** The host facade itself, so a test can install a second time onto it. */
  pi: unknown;
}

function install(spec: string): Installed {
  const events: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, { handler(args: unknown, ctx: unknown): unknown }>();
  const tools: string[] = [];
  const activeTools: string[][] = [];
  const notices: string[] = [];

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      events.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, spec2: { handler(args: unknown, ctx: unknown): unknown }) {
      commands.set(name, spec2);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    setModel: () => {},
    setThinkingLevel: () => {},
    setActiveTools(names: string[]) {
      activeTools.push(names);
    },
    getAllTools: () => [{ name: 'read' }, { name: 'bash' }],
    sendMessage: () => {},
    logger: { info: () => {}, warn: () => {} },
    zod: zodStub(),
    // NO agent loader and NO skill loader. Everything below resolves anyway,
    // because it resolves from this package.
    pi: {},
  };

  ax(pi as never, { handle: HANDLE, run: runnerFor(spec) });

  return {
    events,
    handlers,
    commands,
    tools,
    activeTools,
    notices,
    pi,
    ctx: {
      models: { resolve: (id: string) => ({ provider: 'stub', id }) },
      sessionManager: { getSessionFile: () => TOP_LEVEL, getSessionId: () => 'session-integration' },
      cwd: '/tmp/repo',
      ui: {
        output: notices,
        notify(this: { output: string[] }, line: string) {
          this.output.push(line);
        },
      },
    },
  };
}

/** Run the one `before_agent_start` handler the composition installs. */
async function turn(installed: Installed, systemPrompt?: string[]): Promise<{
  systemPrompt?: string[];
  message?: { customType?: string; content?: string; details?: Record<string, unknown> };
} | undefined> {
  const chain = installed.handlers.get('before_agent_start') ?? [];
  expect(chain).toHaveLength(1);
  return (await chain[0]?.({ type: 'before_agent_start', systemPrompt }, installed.ctx)) as never;
}

const BASE = ['OMP BASE PROMPT', 'TOOL POLICY'];

// ── composition ──────────────────────────────────────────────────────────────

test('the one factory installs all four extensions, each exactly once', () => {
  const { events, commands, tools } = install('[omp model=@task]');

  // Registration is not idempotent anywhere below: a second install means a
  // second receive loop consuming the same Run and a doubled completion report.
  // Counted by event name because that is the shape a duplicate takes.
  const count = (name: string): number => events.filter((event) => event === name).length;

  // model + peer + report + checkpoint, in that order.
  expect(count('session_start')).toBe(4);
  // report and checkpoint both flush at teardown; peer stops its loop.
  expect(count('session_shutdown')).toBe(3);
  // report and checkpoint both read the todo tool.
  expect(count('tool_result')).toBe(2);
  // Only the model/role extension owns these three.
  expect(count('before_agent_start')).toBe(1);
  expect(count('tool_call')).toBe(1);
  expect(count('input')).toBe(1);
  // peer owns turn_start; peer and report both observe agent_end.
  expect(count('turn_start')).toBe(1);
  expect(count('agent_end')).toBe(2);

  expect([...commands.keys()]).toEqual(['role']);
  expect(tools).toEqual(['peer_reply', 'peer_send', 'peer_list', 'peer_read', 'peer_children', 'peer_diagnostics']);
});

test('nothing here is internally latched, so the single-install contract is load-bearing', () => {
  // Stated as a fact about the factories rather than a wish about the loader. A
  // second install really does mean a second receive loop consuming the same Run
  // and a doubled completion report — so if anyone ever makes `ax()` reachable
  // twice, this is the line that says what it costs.
  const first = install('[omp model=@task]');
  const once = first.events.length;

  ax(first.pi as never, {});

  expect(first.events.length).toBe(once * 2);
  expect(first.tools).toHaveLength(12);
});

// ── the dispatched path: `[omp role=worker …]` ───────────────────────────────

test('a dispatched worker gets the BUNDLED worker role and its BUNDLED playbook', async () => {
  // The acceptance path for `ax worker dispatch`: the parent writes the marker, and
  // the child must arrive as a worker carrying its implementation flow. No seam is
  // injected, so both bodies come off disk, out of this package.
  const installed = install('[omp role=worker model=@task]');
  const out = await turn(installed, BASE);

  expect(out?.systemPrompt?.slice(0, 2)).toEqual(BASE);
  expect(out?.systemPrompt).toHaveLength(3);
  // APPENDED, never substituted: replacing drops OMP's own prompt entirely and
  // the session still answers plausibly, so only an assertion catches it.
  expect(out?.systemPrompt?.[2]).toContain('<!-- omp:role -->');
  expect(out?.systemPrompt?.[2]).toContain('# Implementation worker');
  expect(out?.systemPrompt?.[2]).toContain('Do not merge');

  // The playbook arrives as a MESSAGE, not as prompt — it is content the session
  // was handed, not part of who it is.
  expect(out?.message?.customType).toBe('skill-prompt');
  expect(out?.message?.content).toContain('<playbook name="implementation">');
  expect(out?.message?.content).toContain('Decision gate');
  expect(out?.message?.details).toMatchObject({ role: 'worker', skills: ['implementation'], status: 'applied' });

  // The role survives re-assertion without accumulating, and the playbook is not
  // re-sent: a message persists, so once per turn would grow history by a body a
  // turn.
  const second = await turn(installed, BASE);
  expect(second?.systemPrompt).toHaveLength(3);
  expect(second?.message).toBeUndefined();
});

test('a dispatched triage worker gets its own bundled role and playbook', async () => {
  const out = await turn(install('[omp role=triage-worker model=@task]'), BASE);
  expect(out?.systemPrompt?.[2]).toContain('# Triage worker');
  expect(out?.message?.content).toContain('<playbook name="triage">');
  expect(out?.message?.details).toMatchObject({ skills: ['triage'] });
});

// ── the operator path: `/role orchestrator` ──────────────────────────────────

test('/role orchestrator activates the BUNDLED operator role for both lanes', async () => {
  // Nothing dispatches an operator, so no marker can reach them. The marker here
  // names no role on purpose: the role must come from the command alone.
  const installed = install('[omp model=@task]');
  const role = installed.commands.get('role');
  expect(role).toBeDefined();

  await role?.handler('orchestrator', installed.ctx);
  expect(installed.notices.at(-1)).toContain('role orchestrator applied');
  expect(installed.notices.at(-1)).toContain('model untouched');

  const out = await turn(installed, BASE);
  expect(out?.systemPrompt).toHaveLength(3);
  expect(out?.systemPrompt?.[2]).toContain('# Orchestrator');
  expect(out?.systemPrompt?.[2]).toContain('ax pr gate');
  // The operator roles declare no playbook, so activating one delivers no body.
  expect(out?.message).toBeUndefined();

  await role?.handler('off', installed.ctx);
  expect(await turn(installed, BASE)).toBeUndefined();
});

test('/role readiness refuses out loud, because triage is a lane and no longer a role', async () => {
  // `docs/adr/0001`: both operator roles dispatched the same children, so the
  // ruling contract lived in `orchestrator.md` verbatim, and running the two side
  // by side made the parent worktree multi-pane — measured 2026-08-30, every
  // finished child of that shape was told its report could not be delivered.
  // An operator who types the retired name must be told, not quietly served a
  // role that half-fits.
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('readiness', installed.ctx);

  expect(installed.notices.at(-1)).toContain('role readiness unavailable');
  expect(installed.notices.at(-1)).toContain('orchestrator');
  // Nothing was activated, so the next turn is an ordinary one.
  expect(await turn(installed, BASE)).toBeUndefined();
});

// `ax triage status` defaults its lane to `triage` (src/triage/index.mjs), so an
// operator who copies an unqualified example polls whatever the default is rather
// than the lane it dispatched, and is offered a recovery for a dispatch that
// never happened. The bundled role must therefore carry the job on every
// status/recovery example — this is a contract on the shipped prose, not on the
// CLI. (The `refine` lane this test was bought by is gone: `to-tickets` publishes
// `ready-for-agent` itself, so triage is the only lane left to name.)
test('the bundled orchestrator role names the lane on every status read', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('orchestrator', installed.ctx);
  const role = (await turn(installed, BASE))?.systemPrompt?.[2] ?? '';

  expect(role).toContain('ax triage status --issue <N>-<M> --oneline --job triage');
  expect(role).toContain('ax triage status --issue <N> --job triage');
  // A copyable example is one that names an issue; every one of those must say
  // which lane it inspects. A bare mention of the verb carries no lane to get
  // wrong.
  const unqualified = [...role.matchAll(/ax triage status +--issue[^`\n]*/g)]
    .map(match => match[0])
    .filter(example => !example.includes('--job'));
  expect(unqualified).toEqual([]);
});

// THE TRIAGE LANE ITSELF, absorbed rather than referenced. The deleted role owned
// the whole on-ramp: where a pass comes from, the five landing states, the
// publication, and the redispatch. A role that keeps only the ruling section
// leaves an operator with a verb list and no lane — which is how a draft gets
// published unread, or a sixth state gets invented.
test('the bundled orchestrator role carries the whole triage on-ramp, not just its rulings', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('orchestrator', installed.ctx);
  const role = (await turn(installed, BASE))?.systemPrompt?.[2] ?? '';

  // Enumeration comes from the tracker, and `.scratch/` is output. Measured on a
  // pass that took its issue range out of a previous pass's replay artifact.
  expect(role).toMatch(/gh issue list/);
  expect(role).toMatch(/triage\.provenance/);
  expect(role).toMatch(/\.scratch\//);
  expect(role).toMatch(/OUTPUT|output, never input/);
  // It is told to run triage waves itself, so it owes the whole lane.
  expect(role).toMatch(/triage wave/);
  // Every issue lands on exactly one of five states, and there is no sixth.
  for (const state of ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']) {
    expect(role).toContain(`\`${state}\``);
  }
  expect(role).toMatch(/no sixth state/);
  // The three verbs a lane needs beyond `answer`: dispatch it, publish the
  // reviewed draft, and redo a pass out loud when the issue moved.
  expect(role).toContain('ax triage dispatch --issue <N>');
  expect(role).toContain('ax triage publish --issue <N> --job triage');
  expect(role).toMatch(/--republish/);
  expect(role).toMatch(/--fresh --because/);
  // The draft is read and corrected before publication — the separation that
  // gives the analysis a reviewer at all.
  expect(role).toMatch(/correct/i);
  const unqualifiedPublish = [...role.matchAll(/ax triage publish +--issue[^`\n]*/g)]
    .map(match => match[0])
    .filter(example => !example.includes('--job'));
  expect(unqualifiedPublish).toEqual([]);
});

// A child tags `[technical]` / `[product]` so the orchestrator can route. The
// retired role used to say "answer when the operator has decided it; otherwise
// surface the question", so every ask landed on the human and the child sat
// PENDING. The tags are advisory; the orchestrator rules; only a high-stakes
// product bar goes up. And the role must name `ax triage answer`, because the
// child is taught `ask` and a parent that cannot name the reply improvises by
// asking the operator.
test('the bundled orchestrator role rules child questions itself', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('orchestrator', installed.ctx);
  const role = (await turn(installed, BASE))?.systemPrompt?.[2] ?? '';

  expect(role).not.toMatch(/Answer a child's question when the operator has decided it/);
  expect(role).not.toMatch(/otherwise surface the question/);
  expect(role).toContain('ax triage answer --issue <N>');
  expect(role).toMatch(/routing tags are advisory/i);
  expect(role).toMatch(/\[technical\]/);
  expect(role).toMatch(/\[product\]/);
  // The bar, not merely the tags: a role that names `[product]` but still
  // forwards every product choice would pass the assertions above and fail
  // the wave the same way.
  expect(role).toMatch(/change what users see/);
  expect(role).toMatch(/money/);
  expect(role).toMatch(/legal/);
  expect(role).toMatch(/personal data/);
  expect(role).toMatch(/intention the\s+operator has already expressed/);
  expect(role).toMatch(/hint, not a\s+handoff/);
  const unqualifiedAnswer = [...role.matchAll(/ax triage answer +--issue[^`\n]*/g)]
    .map(match => match[0])
    .filter(example => !example.includes('--job'));
  expect(unqualifiedAnswer).toEqual([]);
});

// The continuous-frontier rewrite (KTD6/KTD9). The old Authority line — "You
// never open the next dependency wave before the previous one has merged" — was
// a live contradiction an LLM reads literally once blockers alone decide
// takeability, so its ABSENCE is asserted as hard as the new doctrine's
// presence.
test('the bundled orchestrator role drives the continuous frontier, not a wave barrier', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('orchestrator', installed.ctx);
  const role = (await turn(installed, BASE))?.systemPrompt?.[2] ?? '';

  expect(role).not.toContain('never open the next dependency wave');
  expect(role).toContain('ax frontier');
  expect(role).toContain('## Get bearings');
  // The receipt vocabulary, so the session and the verb share one grammar.
  expect(role).toContain('`takeable`');
  // The heading alone is not the contract: the ORDERED procedure is (validated
  // review finding — a rewrite could keep the heading and lose the order).
  expect(role).toMatch(/tracker first/i);
  expect(role).toContain('ax worker gate <task|request>');
  expect(role).toMatch(/Dispatch only where the\s+gate proves no live child exists/);
  expect(role).toMatch(/cannot establish.*read to repair, never\s+an empty frontier/s);
  // Overlap arbitration widened to every live pane, not one wave's members.
  expect(role).toMatch(/EVERY live pane/);
  // Wake-drain, refusal routing, and the two bounds on unattended repair.
  // #189: a second technical refusal stays with the agents; the operator is
  // not the automatic next hop. Staleness still self-repairs once; a dead
  // route still redispatches recorded.
  expect(role).toMatch(/drain the whole inbox/);
  expect(role).toMatch(/gate REFUSAL is the owning worker's work/);
  expect(role).toMatch(/second staleness refusal/);
  expect(role).toMatch(/does not automatically interrupt the operator/);
  expect(role).toMatch(/--because gate-refusal/);
  // Learnings distillation is the orchestrator's half of the wave channel.
  expect(role).toMatch(/distill the `wave:` bullets/);
  // The wave file demoted to cache; records, tracker and gate are authority.
  expect(role).toMatch(/wave-memory file is a CACHE/);
  // The Spec axis (2026-09-03, then #193): the merge decision reads the worker's
  // Report — the block the receiver appends, derived from the dispatch record
  // (`docs/adr/0002`), never the file `--report-path` names. Opening that path
  // would let a worker choose the criteria, and a remote worker's file is not
  // on this host. A missing criterion travels back with every ground the gate
  // refused, as ONE repair round — AGENTS.md: every merge ground runs, nothing
  // stops after the first refusal.
  expect(role).toMatch(/the Report/);
  expect(role).toMatch(/`--report-path`/);
  expect(role).toMatch(/nothing here opens that path/);
  expect(role).toMatch(/NOT MET/);
  expect(role).toMatch(/one repair round/);
  // The Summary is not the Report, and a role that reads the body for criteria
  // is the competition the ADR removed.
  expect(role).not.toMatch(/its `## CRITERIA` section/);
});

// #189: delegated verification and bounded technical repair. The role is an
// instruction; this suite is the seam that loads it (`docs/adr/0003` clause 3–6).
// Prompt-text pins are not a measured Wave — they prove the session would be
// handed the doctrine, not that a Wave obeyed it.
test('the bundled orchestrator role delegates verification and keeps technical repair with agents', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('orchestrator', installed.ctx);
  const role = (await turn(installed, BASE))?.systemPrompt?.[2] ?? '';

  // The consuming project's entry and contract stay in force. AX does not
  // impose a shipping pipeline or infer deployment from its own npm release.
  expect(role).toMatch(/dispatch\.entry/);
  expect(role).toMatch(/dispatch\.contract/);
  expect(role).toMatch(/shipping pipeline/);
  expect(role).toMatch(/npm release/);

  // Verification is opt-in per named gap, reusing evidence already produced.
  expect(role).toMatch(/integrated result is unproven/);
  expect(role).toMatch(/absent or contradictory/);
  expect(role).toMatch(/names that gap/);
  expect(role).toMatch(/does not repeat every worker/);

  // Oracle is a second judgment that can change a decision, not a vote and
  // not a second dispatching session.
  expect(role).toMatch(/Oracle/);
  expect(role).toMatch(/can change (?:a |the next )/);
  expect(role).toMatch(/routine approval/);
  expect(role).toMatch(/not a vote|never a vote/);
  expect(role).toMatch(/second dispatching Orchestrator/);

  // Second technical refusal: agents choose a useful continuation; the same
  // attempt cannot repeat; a refusal cannot mint a fresh Dispatch identity.
  expect(role).toMatch(/SECOND technical refusal/);
  expect(role).not.toMatch(
    /SECOND refusal of the same\s+PR after a repair round escalates to the operator/,
  );
  expect(role).toMatch(/diagnosis/);
  expect(role).toMatch(/second opinion/);
  expect(role).toMatch(/explicit blocker/);
  expect(role).toMatch(/same attempt/);
  expect(role).toMatch(/cannot mint a fresh Dispatch identity/);

  // A missing product decision blocks only the work that needs it.
  expect(role).toMatch(/Independent takeable/);
  expect(role).toMatch(/[Ww]iden an Assignment/);

  // Reports remain evidence to judge, routed with Gate findings in one round.
  expect(role).toMatch(/evidence to judge/);
  expect(role).toMatch(/one repair round/);
});

// The worker's half of the learnings channel (KTD7) and the refusal duty the
// routing above depends on: a routed refusal with no worker contract to
// receive it is a message into the void.
test('the bundled worker contract carries the LEARNINGS grammar and the refusal duty', async () => {
  const installed = install('[omp role=worker model=@task]');
  const out = await turn(installed, BASE);
  const role = out?.systemPrompt?.[2] ?? '';
  const playbook = String(out?.message?.content ?? '');

  expect(role).toMatch(/gate-refusal message on your pull request is your work/);
  // #189: a second technical refusal is still this slice — not a new Dispatch
  // and not a second worker_done. Do not widen the Assignment to dodge asking.
  expect(role).toMatch(/second technical refusal is still this slice/);
  expect(role).toMatch(/not a second `worker_done`/);
  expect(role).toMatch(/[Ww]iden the Assignment/);
  // The playbook NAMES the artifact — one file, its shape, written on a failed
  // outcome too — and no longer says "open every report with", which described
  // a message nobody could read (0 of 8 sections reached a mailbox, 2026-09-03).
  expect(playbook).not.toMatch(/[Oo]pen every report with/);
  expect(playbook).toMatch(/\bReport\b/);
  expect(playbook).toMatch(/--outcome failed/);
  expect(playbook).toMatch(/Summary/);
  expect(playbook).toContain('## LEARNINGS');
  for (const scope of ['`durable:`', '`wave:`', '`ticket:`']) expect(playbook).toContain(scope);
  // Durable learnings prefer additive files: the bound on concurrent-slice
  // doc collisions the whole channel rests on.
  expect(playbook).toMatch(/ADDITIVE file/);
  // The Spec axis: nobody else checks the diff against what the ticket asked —
  // the review bot reads the diff, the gate reads grounds. Every acceptance
  // criterion the ticket names, quoted, with the evidence observed for it or
  // `NOT MET`. A criterion the ticket never named is not a line to invent.
  expect(playbook).toContain('## CRITERIA');
  expect(playbook).toMatch(/NOT MET/);
  expect(playbook).toMatch(/never a line to invent/);
  // Where it goes is the DISPATCH's answer, never one the playbook re-derives:
  // two copies of that rule disagree the day one moves.
  expect(playbook).not.toMatch(/\.scratch/);
});

// ── unknown names refuse, visibly ────────────────────────────────────────────

test('an unknown dispatched role locks the session before its first turn', async () => {
  // Continuing as a generic agent is not graceful degradation: the missing role is
  // the authority boundary that says whether this session may merge or publish.
  const installed = install('[omp role=ghost model=@task]');
  const out = await turn(installed, BASE);

  expect(installed.activeTools).toEqual([[]]);
  expect(out?.systemPrompt?.at(-1)).toContain('DO NOT execute the assignment');
  expect(out?.message).toMatchObject({
    customType: 'role-refused',
    details: { role: 'ghost', reason: 'role-not-found' },
  });
  // The refusal names what this package does ship, because the operator cannot
  // see the directory the marker was written against.
  expect(String(out?.message?.content)).toContain('triage-worker');

  // `setActiveTools([])` is cosmetic; the fence is the hard boundary.
  const fence = installed.handlers.get('tool_call')?.[0];
  expect(await fence?.({ toolName: 'bash' }, installed.ctx)).toMatchObject({ block: true });
});

test('/role on an unknown name refuses out loud and leaves the session alone', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('ghost', installed.ctx);

  expect(installed.notices.at(-1)).toContain('role ghost unavailable');
  expect(installed.notices.at(-1)).toContain('triage-worker');
  // An operator's session is not locked by a name they mistyped — nothing was
  // activated, so the next turn is an ordinary one.
  expect(await turn(installed, BASE)).toBeUndefined();
  expect(installed.activeTools).toEqual([]);
});

test('a role name that tries to leave the roles directory is just an unknown role', async () => {
  const out = await turn(install('[omp role=../../package model=@task]'), BASE);
  expect(out?.message).toMatchObject({ customType: 'role-refused', details: { reason: 'role-not-found' } });
});

// ── the guard that made the migration necessary ──────────────────────────────

test('a task subagent of a dispatched worker inherits neither the role nor the playbook', async () => {
  // A subagent writes `<ts>_<uuid>/<Name>.jsonl`, one level deeper, inside a
  // directory named after its parent's session. Every in-process subagent
  // re-initialises the extensions, so the discriminant has to be structural.
  const installed = install('[omp role=worker model=@task]');
  (installed.ctx as { sessionManager: { getSessionFile(): string } }).sessionManager.getSessionFile =
    () => TOP_LEVEL.replace('.jsonl', '/Reviewer.jsonl');

  expect(await turn(installed, BASE)).toBeUndefined();
});
