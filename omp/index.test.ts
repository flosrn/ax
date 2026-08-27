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
  // peer only.
  expect(count('turn_start')).toBe(1);
  expect(count('agent_end')).toBe(1);

  expect([...commands.keys()]).toEqual(['role']);
  expect(tools).toEqual(['peer_reply', 'peer_send', 'peer_list', 'peer_read', 'peer_children']);
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
  expect(first.tools).toHaveLength(10);
});

// ── the dispatched path: `[omp role=worker …]` ───────────────────────────────

test('a dispatched worker gets the BUNDLED worker role and its BUNDLED playbook', async () => {
  // The acceptance path for `ax worker launch`: the parent writes the marker, and
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

test('a dispatched refine worker gets its own bundled role and playbook', async () => {
  const out = await turn(install('[omp role=refine-worker model=@task]'), BASE);
  expect(out?.systemPrompt?.[2]).toContain('# Refine worker');
  expect(out?.message?.content).toContain('<playbook name="refine">');
  expect(out?.message?.details).toMatchObject({ skills: ['refine'] });
});

// ── the operator path: `/role orchestrator` ──────────────────────────────────

test('/role orchestrator activates the BUNDLED operator role without touching the model', async () => {
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
  expect(out?.systemPrompt?.[2]).toContain('# Implementation orchestrator');
  expect(out?.systemPrompt?.[2]).toContain('ax pr gate');
  // The operator roles declare no playbook, so activating one delivers no body.
  expect(out?.message).toBeUndefined();

  await role?.handler('off', installed.ctx);
  expect(await turn(installed, BASE)).toBeUndefined();
});

test('/role coordinator resolves too, so both operator roles ship live', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('coordinator', installed.ctx);
  const out = await turn(installed, BASE);
  expect(out?.systemPrompt?.[2]).toContain('<!-- omp:role -->');
  expect(installed.notices.at(-1)).toContain('role coordinator applied');
});

// `ax triage status` defaults its lane to `triage` (src/triage/index.mjs), so a
// coordinator running a refine pass who copies an unqualified example polls the
// wrong lane and is offered a recovery for a dispatch that never happened. The
// bundled role must therefore carry the job on every refine status/recovery
// example — this is a contract on the shipped prose, not on the CLI.
test('the bundled coordinator role names the refine lane on every status read', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('coordinator', installed.ctx);
  const role = (await turn(installed, BASE))?.systemPrompt?.[2] ?? '';

  expect(role).toContain('ax triage status --issue <N>-<M> --brief --job refine');
  expect(role).toContain('ax triage status --issue <N> --job refine');
  // A copyable example is one that names an issue; every one of those must say
  // which lane it inspects. A bare mention of the verb carries no lane to get
  // wrong.
  const unqualified = [...role.matchAll(/ax triage status +--issue[^`\n]*/g)]
    .map(match => match[0])
    .filter(example => !example.includes('--job'));
  expect(unqualified).toEqual([]);
});

// A child tags `[technical]` / `[product]` so the coordinator can route. The
// coordinator role used to say "answer when the operator has decided it;
// otherwise surface the question", so every ask landed on the human and the
// child sat PENDING. The tags are advisory; the coordinator rules; only a
// high-stakes product bar goes up. And the role must name `ax triage answer`,
// because the child is taught `ask` and a parent that cannot name the reply
// improvises by asking the operator.
test('the bundled coordinator role rules child questions itself', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('coordinator', installed.ctx);
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
  expect(String(out?.message?.content)).toContain('coordinator');

  // `setActiveTools([])` is cosmetic; the fence is the hard boundary.
  const fence = installed.handlers.get('tool_call')?.[0];
  expect(await fence?.({ toolName: 'bash' }, installed.ctx)).toMatchObject({ block: true });
});

test('/role on an unknown name refuses out loud and leaves the session alone', async () => {
  const installed = install('[omp model=@task]');
  await installed.commands.get('role')?.handler('ghost', installed.ctx);

  expect(installed.notices.at(-1)).toContain('role ghost unavailable');
  expect(installed.notices.at(-1)).toContain('coordinator');
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
