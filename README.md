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
| `coordinator` | issue triage, review of the child's draft, publication after correction |
| `triage-worker` | one issue analysis and one draft; no tracker or repository mutation |
| `orchestrator` | dependency order, worker fan-out, decisions, validated merge and release |
| `worker` | one ticket, one worktree, one branch and one pull request through decided CI |

A dispatched child also receives the exact ticket brief, its git identity, a worktree-local
watchdog and `.agent/worktree-context.local.md`. It does not have to infer which URL, database,
role or parent it belongs to.

The implementation and triage playbooks are part of ax. They do not depend on a private
`~/.omp`, a particular model provider or a repo-specific skill name.

## 3. Operate a group of agents

ax is the control layer over OMP sessions and Orca's panes, worktrees, runs and transport.

A triage flow is:

```text
/role coordinator
        │
        ├── ax triage dispatch ──► triage-worker ──► .scratch/triage/<draft>.md
        │                                  │
        │                           questions return here
        │                                  ▼
        └── review and correct ──► ax triage publish
```

An implementation flow is:

```text
/role orchestrator
        │
        ├── order independent tickets
        ├── ax worker launch ──► isolated worktree ──► worker ──► PR + decided CI
        │                              ▲                  │
        │                         messages and decisions  │
        ├── ax pr gate --merge ◄──────── proof ──────────┘
        └── ax worker release
```

The safety properties live in executable commands rather than coordinator prose:

- every dispatch and release is written to a record **before** the mutation;
- recovery replays the recorded call instead of composing a second identity;
- peer messages carry a verified route and never put free text on a shell line;
- live capacity is counted from panes the runtime still owns, not an accounting table that may
  omit repaired workers;
- a worker is released only after its pull request or other governing artifact has landed;
- the merge gate runs every declared ground against the exact head SHA and performs the merge it
  validated.

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

The global command is a dispatcher. Inside a repo, the exact `@flosrn/ax` version declared in that
repo commands; the global copy never silently substitutes itself. If the dependency is declared
but not installed, ax refuses and names `pnpm install` as the repair. Outside a configured repo,
the global copy remains available to run `ax init`.

`ax init` is safe to repeat. It owns:

- `ax.config.json`;
- the committed `bin/ax` bootstrap;
- the ax package-root entry in `.omp/settings.json`, preserving the project's other settings;
- `BEGIN:ax` blocks in `.gitignore` and `AGENTS.md`;
- `scripts.ax` and the exact `@flosrn/ax` devDependency in `package.json`.

After a merge takes the vendor's side of one of those surfaces, run it again.

## Adapt it to the repo

Project facts belong in `ax.config.json`, never in ax source. Ports, app paths, database offsets,
tracker labels, host placement, merge grounds and vendor ownership all come from that file.
`ax.schema.json` documents every key; unknown keys are errors so a typo cannot look applied.

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
