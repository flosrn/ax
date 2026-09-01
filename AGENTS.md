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

## Before changing a rule

Every module's doctrine — its incidents, caveats and the rule it enforces — lives in its own
header, and the header is the authority. Look the file up in `docs/ownership.md`, read its
header, then patch.

## Rules a patch has to hold

**The repository is input.** Ports, paths, labels, hosts, merge grounds and vendor ownership come
from `ax.config.json`. MakerKit is an inferred shape, never an assumption in `src/`. A plain package
repo initializes with `apps.web: "."` and no vendor block.

**Machine answers are injected.** A function that depends on the host takes that dependency as a
named option with a real default. That is why both suites run without Docker, bound ports, network,
Orca or OMP sessions.

**Playbooks are package-internal.** `omp/playbooks/implementation.md` and `triage.md` are generic AX
procedures: no Compound Engineering, no Matt Pocock skills, no provider IDs, no private repo paths.
Their proof names describe the work: `implementation` and `triage`.

**Every finding names its repair.** Output goes through `src/log.mjs`. A `bad` without a `fix` is a
finding neither an agent nor a human can act on.

**A behavior fix starts red.** Update or add the smallest test that proves the contract, observe its
expected failure, then change production. Prefer real temp git repos over mocked filesystems.

**Absence is not zero** (F-028). Read receipts by named key; an absent list is unknown, not empty.
Never `||` a missing container into a value that authorizes a mutation.

**Proof, not self-report.** Liveness is cursor movement. Completion is a merged PR or the governing
artifact. Every merge ground runs; nothing stops after the first refusal.

**Orca is readable source, not a black box.** This machine runs a patched Orca fork (ADR 0026);
the source lives at `~/Code/flosrn/orca` (`upstream` = stablyai/orca). Answer an Orca behavior
question by reading that checkout — never by unpacking the installed app's `.asar`. A fix that
belongs in Orca goes to the fork branch, not to a workaround in ax.

## Adding a surface

A new **command** needs one registry entry in `src/commands.mjs` — its name, its help section and
its summary — one runner, one implementation, and a test that exercises what the generated help or
AGENTS.md tells an agent to type. A future domain (automated checks, architecture rules, context
rules) arrives as its own noun plus a help section — the `gh` shape, never a nesting prefix
(`docs/adr/0001`).

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

## Try this checkout in another project

Released projects carry an exact npm version and move with `ax pin <version>`. To test this
checkout, declare `"@flosrn/ax": "link:../../flosrn/ax"` in the consumer, then `pnpm install`,
`ax init`, `ax doctor`. A link is a development exception.

## Domain docs

`docs/ownership.md` (the module → owner map — look a file up before changing its rule) ·
`CONTEXT.md` (the ratified glossary — read it before writing prose that names a session, a verb or
an artifact; its `_Avoid_` lines are enforced over this file and README.md by `tests/docs.test.mjs`)
· `docs/adr/` (this repo's decisions, cited by path; a bare `ADR NNNN` is the harness-wide set under
`~/.omp/docs/adr/`) · `docs/solutions/` (past fixes, one file each, YAML frontmatter keyed by
`module`/`tags`/`problem_type`). `F-0xx` is a measured finding filed in `gapilabs/omp`; the module
header states the rule it paid for. None of it is required reading before a patch unless the owning
header's explanation is insufficient.
