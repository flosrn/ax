# ax

**Agent Experience for a repository.** ax takes the repo as it is, makes an isolated worktree
runnable, equips the agent that enters it, and coordinates the agents working across it.

It currently owns three jobs.

## 1. Make every worktree runnable

A fresh worktree normally has source code and little else. ax gives it its own port, URLs, env,
database mode, dependencies and local context:

```bash
ax worktree setup
ax worktree ls
```

`setup` probes the checkout and writes one plan. `doctor` derives that same plan again and compares
it with the files and processes it finds:

```bash
ax doctor
```

Every failure names the command that repairs it. `clean` and `rm` reclaim only worktrees whose
ownership ax can prove. `ax supabase` promotes the current checkout before a Supabase command may
write shared local data.

## 2. Equip the agent that enters it

`ax init` installs a small project-scoped OMP extension. A session started in the repo receives the
version of ax pinned by that repo — roles, playbooks and runtime hooks included.

The bundle provides four session roles:

| Role | Owns |
|---|---|
| `orchestrator` | the one operator session: both dispatch lanes, decisions, publication, validated merge and release |
| `worker` | one ticket, one worktree, one branch and one pull request through decided CI |
| `triage-worker` | one inbound issue's analysis and one draft; no tracker or repository mutation |
| `maintainer` | the ax checkout itself: frictions reported by live sessions, measured and repaired at the source |

A dispatched child also receives the exact ticket brief, its git identity, a worktree-local
watchdog and `.agent/worktree-context.local.md`. It does not have to infer which URL, database,
role or parent it belongs to.

The implementation and triage playbooks are part of ax. They do not depend on a private
`~/.omp`, a particular model provider or a repo-specific skill name.

## 3. Operate a group of agents

ax is the control layer over OMP sessions and Orca's panes, worktrees, runs and transport.

One operator session dispatches both lanes. The triage lane turns an issue that arrived from
outside into work an agent can execute; the implementation lane turns a ticket into a merged pull
request. It is one session, one root:

```text
/role orchestrator
   │
   ├── triage lane ── an inbound issue becomes a ticket
   │      ├── ax triage dispatch ──► triage-worker ──► .scratch/triage/<draft>.md
   │      │                                 │
   │      │                          questions return here
   │      │                                 ▼
   │      └── review and correct ──► ax triage publish
   │
   └── implementation lane ── a ticket becomes a merged pull request
          ├── order independent tickets
          ├── ax worker dispatch ──► isolated worktree ──► worker ──► PR + decided CI
          │                              ▲                  │
          │                       questions and rulings     │
          ├── ax pr gate --merge ◄──────── proof ───────────┘
          └── ax worker release
```

Both lanes rule their children's questions on the same mailbox, and the merge stays with the
orchestrator: a worker takes its own pull request to decided CI and stops there.

The safety properties live in executable commands rather than operator prose:

- every dispatch and release is written to a record **before** the mutation;
- recovery replays the recorded call instead of composing a second identity;
- peer messages carry a verified route and never put free text on a shell line;
- live capacity is counted from panes the runtime still owns, not an accounting table that may
  omit repaired workers;
- a worker is released only after its pull request or other governing artifact has landed;
- the merge gate runs every declared ground against the exact head SHA and performs the merge it
  validated.

### Choose a worker's class, not its model

A dispatch decides a CLASS of work — `routine`, `standard` or `deep` — and hands the child the
OMP role that class routes to. Which model, account and provider answer that role is decided by
OMP's role configuration and its gateway on the execution host: ax resolves no model, reads no
quota and names no provider.

Configure one role per class in the project's `ax.config.json`:

```json
{
  "dispatch": {
    "models": { "routine": "@worker-routine", "standard": "@worker-standard", "deep": "@worker-deep" },
    "modelFloors": { "domain:security": "deep" },
    "modelMode": "auto"
  }
}
```

The roles and the labels are project choices; the example adds no provider dependency. Each role
must resolve on the host that will serve it — a child dispatched onto a role its host cannot
serve refuses before its first request rather than running on whatever it booted with.

`modelMode` decides who picks the class, and `--model-mode` overrides it per dispatch:

```bash
ax worker dispatch --issue 412 --slug fix-guard --capability deep --because "unresolved lock design"
ax worker dispatch --issue 412 --slug fix-guard --model-mode manual --capability routine --because "operator: decided fix"
ax worker dispatch --issue 412 --slug fix-guard --model-mode ask --dry-run          # prints the question
ax worker dispatch --issue 412 --slug fix-guard --model-mode ask --model-confirmation <session.jsonl#toolCallId>
```

- **auto** (the default, and what a project that states nothing has always had) takes the
  orchestrator's `--capability` assessment; `--because` records it. No assessment routes the
  conservative `standard` role, never the cheapest one. A label floor raises an assessment.
- **manual** routes the class the operator named, and refuses without `--capability`. A label
  floor does not override it: the operator chose.
- **ask** offers the configured classes — classes only, no models and no efforts — in a native
  `ask` dialog. `--dry-run` prints that question; `worker_model_confirmation` returns the
  transcript reference of the answered ask, and `--model-confirmation` passes it back. The answer
  must come from the dispatching session's own transcript, for this request, and a timeout,
  cancellation, custom typed text, deferral, changed menu or missing result dispatches nothing at
  all. A chosen class overrides both the recommendation and any label floor.

`--model` remains the legacy explicit override for consumers that pin a selector, and it is
honoured in `auto` only: in `manual` and `ask` the class is somebody's decision, so a selector
there is refused rather than silently preferred. A project that configures no `dispatch.models`
at all keeps `@default`, and `manual` and `ask` refuse there — there is no class to route.

The dispatch record exposes the frozen decision through `ax worker start --show --request <id>`:
the mode, the class, the role and the ask reference that authorized it. Recovery replays that
record rather than reclassifying a changed ticket or re-reading a changed configuration. A
same-repository claim from an earlier Run can be replaced only when the existing record proves no
task was created; `worker start` rechecks that proof under its lock and preserves the refused
record. Unknown outcomes never authorize a fresh decision. The child records what it was actually
served as `@flosrn/ax/model-assignment`, and the dispatch verifier requires that receipt and
compares it with the requested role and the session's current model: a missing receipt is
unproven, never a verified assignment. Host placement (`--on`), account rotation and
independently pinned subagents are unchanged.

## Install globally, pin locally

Install ax once so the command exists outside any project:

```bash
pnpm add -g @flosrn/ax
```

Then enter a repository:

```bash
ax init
pnpm install
ax doctor
```

The global command delegates. Inside a repo, the exact `@flosrn/ax` version declared in that
repo commands; the global copy never silently substitutes itself. If the dependency is declared
but not installed, ax refuses and names `pnpm install` as the repair. Outside a configured repo,
the global copy remains available to run `ax init`.

`ax init` is safe to repeat. It owns:

- `ax.config.json`;
- the committed `bin/ax` bootstrap;
- the ax package-root entry in `.omp/settings.json`, preserving the project's other settings;
- `BEGIN:ax` blocks in `.gitignore` and `AGENTS.md`, whichever of them this repository's plan
  wants — the checkout that publishes ax keeps the `.gitignore` block and authors its own
  `AGENTS.md`;
- `scripts.ax` and the exact `@flosrn/ax` devDependency in `package.json`.

After a merge takes the vendor's side of one of those surfaces, run it again.

## Adapt it to the repo

Project facts belong in `ax.config.json`, never in ax source. Ports, app paths, database offsets,
tracker labels, host placement, merge grounds and vendor ownership all come from that file.
`ax.schema.json` documents every key; unknown keys are errors so a typo cannot look applied.
`$comment` is admitted on any object in the file, so the reasoning behind a value lives next to it.

A small repository may need only:

```json
{
  "$schema": "./node_modules/@flosrn/ax/ax.schema.json",
  "project": { "name": "my-project", "display": "My Project" },
  "apps": { "web": "." },
  "vendor": { "repo": "owner/my-project" }
}
```

MakerKit turbo is one shape `ax init` knows how to infer, not an architecture ax requires. ax itself
uses `"apps": { "web": "." }`, has no Supabase stack, and is graded by the same planner and doctor
as every consuming repo.

## Runtime contract

Worktree setup, doctor, pinning, guarded Supabase access and the pull-request gate run without OMP
or Orca. Multi-agent orchestration deliberately requires both:

- **OMP** runs the model, tools, role prompt and playbook;
- **Orca** owns panes, worktrees, runs, tasks and transport;
- **ax** owns the product workflow composed over them — setup, records, communication, triage,
  implementation, verification, recovery and release.

The OMP integration is project-scoped and versioned inside the ax package. Nothing is copied into a
global `~/.omp` where the last project installed would win.

## Work on ax

```bash
pnpm test
node bin/ax.mjs doctor
npm pack --dry-run
```

There are no runtime dependencies and no build step. `bin/ax.mjs` runs the modules in `src/`
directly; OMP loads the TypeScript extension bundle from `omp/` with its own Bun runtime.

Architecture and patch invariants: [`AGENTS.md`](./AGENTS.md).
