# AGENTS.md

`ax` adapts a repository for agent work: it makes worktrees runnable, equips the sessions that
enter them, and orchestrates work between those sessions. Zero runtime dependencies, no build step.

```bash
pnpm run test:node       # CLI and repository behavior, Node, offline
pnpm run test:omp        # project-scoped OMP bundle, Bun, offline
pnpm test                # both — the release gate
node bin/ax.mjs          # the command surface this machine can answer
```

## The architecture — three jobs, two invariants

1. **Prepare the worktree** — `src/worktree/`. Probe the checkout, derive one plan, then write it.
2. **Equip the session** — `omp/model/`, `omp/roles/`, `omp/playbooks/`. Apply the pinned role,
   model and procedure before the first turn.
3. **Orchestrate the work** — `src/worker/`, `src/triage/`, `src/pr-gate.mjs`, plus the peer/report/
   checkpoint extensions under `omp/`. Record mutations, route messages, verify artifacts, recover.

**The plan** — `src/worktree/plan.mjs`. `planWorktree()` decides a worktree's target state once, as
a pure function. `setup` writes that plan; `doctor` derives the same plan and compares. A new rule
goes in the plan, not in either verb. A doctor finding that cannot be phrased as “recorded value vs
plan value” means the plan is missing a field.

**The record** — `src/worker/record.mjs`. Every live orchestration mutation is written before it is
issued. Recovery replays that recorded call byte for byte. Missing, unreadable or ambiguous state is
an inability to establish, never permission to mint another identity.

## Read the owning header before changing the rule

The incident and caveats live beside the implementation. This table routes; it does not duplicate
them.

| Path | Owns |
|---|---|
| `src/dispatch.mjs`, `bin/ax.mjs`, `src/cli.mjs` | global command → exact project version → CLI dispatch |
| `src/init.mjs`, `src/doctor.mjs` | project inference, managed wiring, recorded state vs reality |
| `src/worktree/plan.mjs`, `src/worktree/probes.mjs` | every worktree decision and every machine fact it consumes |
| `src/worktree/identity.mjs`, `src/worktree/ports.mjs`, `src/worktree/supabase.mjs`, `src/worktree/addressing.mjs` | the rules composed by the plan |
| `src/worktree/setup.mjs`, `src/worktree/list.mjs`, `src/worktree/clean.mjs`, `src/worktree/remove.mjs`, `src/worktree/doctor.mjs` | the worktree verbs; render and write, never decide |
| `src/worktree/context.mjs` | `.agent/worktree-context.local.md`, read by a cold agent |
| `src/worktree/locate.mjs` | proof that a destructive worktree target belongs to ax |
| `src/worker/record.mjs` | write-ahead dispatch/release identity and exact replay |
| `src/worker/start.mjs`, `src/worker/launch.mjs`, `src/worker/repair.mjs`, `src/worker/release.mjs` | dispatch, prove, repair and close |
| `src/worker/placement.mjs`, `src/worker/verify.mjs` | where a ticket's worktree lands; the four proofs a LAUNCHED receipt carries |
| `src/worker/pane.mjs`, `src/worker/ls.mjs`, `src/worker/tail.mjs`, `src/worker/gate.mjs`, `src/worker/stall.mjs`, `src/worker/transcript.mjs` | liveness and capacity, counted from panes |
| `src/worker/delivered.mjs` | did the child's own session record the brief — the witness that outranks a receipt |
| `src/worker/brief.mjs`, `src/worker/child.mjs`, `src/worker/ticket.mjs`, `src/worker/hosts.mjs`, `src/worker/peers.mjs` | assignment, child setup, tracker, placement and parent route |
| `src/triage/dispatch.mjs`, `src/triage/ask.mjs`, `src/triage/answer.mjs`, `src/triage/publish.mjs` | one analysis session per issue, questions, corrected publication |
| `src/triage/spec.mjs`, `src/triage/capacity.mjs` | the one-line instruction a child receives; the cap and the anti-rival pass gates |
| `src/pr-gate.mjs`, `src/pr-grounds.mjs` | every merge ground, executed against the exact head SHA — one function per ground, the verdict in gate() |
| `src/board.mjs` | the one monotonic writer of a worktree checkpoint |
| `src/pin.mjs` | exact npm release migration, install proof and doctor; never git |
| `src/orca-bin.mjs` | Orca binary resolution and JSON receipt parsing for CLI verbs |
| `src/exec.mjs`, `src/git.mjs`, `src/gh.mjs` | process spawning (status-as-data, one default adapter), root/main derivation, the repository as `gh` names it |
| `omp/index.ts` | public OMP factory; model → peer → report → checkpoint order |
| `omp/model/index.ts`, `omp/model/activation.ts`, `omp/model/roles.ts`, `omp/model/role.ts` | marker and `/role` activation, bundled role/playbook loading, proof |
| `omp/roles/`, `omp/playbooks/` | coordinator, orchestrator, worker, triage-worker and refine-worker contracts |
| `omp/peer/` | independent-session addressing, messaging, attribution and receive loop |
| `omp/report/`, `omp/checkpoint/` | completion/questions and board updates |
| `omp/shared/ax.ts`, `omp/shared/board.ts`, `omp/ax-run.mjs` | package-local ax invocation and the one board-write spawn; never PATH or a global version |
| `src/config.mjs`, `src/schema.mjs`, `ax.schema.json` | the per-repository contract and defaults |
| `src/commands.mjs` | command registry: help, visibility and generated AGENTS.md lines |
| `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/publish.yml` | version, changelog, tag, GitHub Release and OIDC npm publish |

## Rules a patch has to hold

**The repository is input.** Ports, paths, labels, hosts, merge grounds and vendor ownership come
from `ax.config.json`. MakerKit is an inferred shape, never an assumption in `src/`. A plain package
repo initializes with `apps.web: "."` and no vendor block.

**Machine answers are injected.** A function that depends on the host takes that dependency as a
named option with a real default. That is why both suites run without Docker, bound ports, network,
Orca or OMP sessions.

**Declare before implementing.** Commands start in `src/commands.mjs`; noun verbs also have one
`SUBCOMMANDS` table asserted equal to the registry. `src/cli.mjs` throws at startup when a declared
command has no runner. Give a command an `agentLine` only when every consuming repo should teach it.

**Project version is authority.** The global bin only finds the local package. An exact declaration
with no matching install is a refusal, including for `init`; otherwise the global copy could rewrite
a project from a version it chose to the version the machine happened to have.

**One OMP bundle per session.** `ax init` registers the installed package root in
`.omp/settings.json`. Never add a second wrapper under `.omp/extensions/`: duplicate peer receive
loops consume each other's messages and duplicate reports. The ax repo registers `"."`; consuming
repos register `"./node_modules/@flosrn/ax"`.

**Session roles are not task agents.** They live under `omp/roles/`, loaded by the AX role
extension; both `[omp role=worker …]` and `/role orchestrator` resolve without OMP agent or skill
discovery — never through an OMP `agents/` directory hidden by `disabledAgents`.

**Playbooks are package-internal.** `omp/playbooks/implementation.md`, `triage.md` and `refine.md`
are generic AX procedures. They do not vendor Compound Engineering, Matt Pocock skills, provider IDs
or private repo paths. Their proof names describe the work: `implementation`, `triage` and `refine`.

**Every finding names its repair.** Output goes through `src/log.mjs`. A `bad` without a `fix` is a
finding neither an agent nor a human can act on.

**A behavior fix starts red.** Update or add the smallest test that proves the contract, observe its
expected failure, then change production. Prefer real temp git repos over mocked filesystems.

**Absence is not zero** (F-028). Read receipts by named key; an absent list is unknown, not empty.
Never `||` a missing container into a value that authorizes a mutation.

**Proof, not self-report.** Liveness is cursor movement. Completion is a merged PR or the governing
artifact. Every merge ground runs; nothing stops after the first refusal.

**Destruction proves ownership.** Worktree removal resolves through `src/worktree/locate.mjs`;
Supabase stop runs behind `ownsStack()`. Guessing a path is never an escape hatch.

**Exit codes belong to the verb** (ADR 0003). `worker gate` fails closed because it authorizes a
second agent. `board` fails open because a checkpoint hook must not take down the work it observes.

## Adding a surface

A new **command** needs one registry entry, one runner, one implementation, and a test that exercises
what the generated help or AGENTS.md tells an agent to type.

A new **session role** needs a file under `omp/roles/`, an internal playbook when the role has a
procedure, a role-proof name, and integration coverage for its real activation path. Operator roles
activate through `/role`; child roles activate from the marker ax writes into their assignment.

A new **project setting** belongs in `ax.schema.json`; the validator refuses schema keywords it does
not implement. Add it to the pure plan when it changes target state.

A new **release** is never a hand-edited number: conventional commits feed the Release Please PR,
and merging it owns `package.json.version`, `CHANGELOG.md`, the `vX.Y.Z` tag and the GitHub
Release; npm publishes only when that release was created and trusted publishing is enabled.
`tests/docs.test.mjs` grades this file and README.md: copyable commands, module pointers and
version pins must match the code.

## Vocabulary

`F-0xx` is a measured finding filed in `gapilabs/omp`; the module header states the rule it paid for.
`ADR NNNN` lives under `~/.omp/docs/adr/`. Neither is required reading before a patch unless the
header's explanation is insufficient.

Documented solutions live under `docs/solutions/` — problems this repo has already solved
(bugs, practices), one file each, with YAML frontmatter (`module`, `tags`, `problem_type`);
relevant when implementing or debugging in an area a past learning covers.

**Orca is readable source, not a black box.** This machine runs a patched Orca fork (ADR 0026);
the source lives at `~/Code/flosrn/orca` (`upstream` = stablyai/orca). Answer an Orca behavior
question by reading that checkout — never by unpacking the installed app's `.asar`. A fix that
belongs in Orca goes to the fork branch, not to a workaround in ax.

## Try this checkout in another project

Released projects carry an exact npm version and move with `ax pin <version>`. To test this
checkout, declare `"@flosrn/ax": "link:../../flosrn/ax"` in the consumer, then `pnpm install`,
`ax init`, `ax doctor`. A link is a development exception.
