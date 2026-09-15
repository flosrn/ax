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

### Share a Role browser

Declare `debugAs` in `ax.config.json` to open one visible Chromium session per checkout.
The project supplies Playwright, its Debug identities and an authentication adapter where needed;
ax neither installs a browser nor starts the application.

```bash
ax debug-as doctor
ax debug-as --as owner --no-phone
```

Launch is an interactive operator gesture: keep it running until the window closes. From another
terminal, an agent inspects or co-drives that same window:

```bash
ax debug-as status
ax debug-as drive --as owner -- snapshot
```

`--device` reads the project's Playwright device catalog; `--viewport 1280x800` selects desktop
dimensions instead. A matching launch reuses the window and may navigate with `--path`; changing
identity, origin or emulation refuses until the operator closes it. CDP stays on loopback.

The smallest browser-only declaration is:

```json
{
  "debugAs": {
    "browser": {
      "playwrightDir": "apps/e2e",
      "start": ["pnpm", "dev"],
      "navigationTimeoutSeconds": 120
    },
    "identities": { "guest": { "defaultPath": "/" } }
  }
}
```

For an authenticated Debug identity, declare `browser.storageState` on the identity and
`browser.prepare` on the contract (`command` argv and `timeoutSeconds`). AX runs that adapter
on every fresh authenticated launch, from the checkout root, with one JSON request on stdin:

```json
{"protocol":1,"operation":"prepare","identity":"owner","origin":"http://localhost:3000","storageState":"apps/e2e/.auth/owner.json"}
```

The adapter refreshes that declared file, sets mode `0600`, and prints one JSON object with
`"protocol":1` on stdout; progress belongs on stderr. The artifact must be Git-ignored, inside the
checkout without symlinks, and contain only local cookies and origins. AX passes its parsed value
to Chromium and never writes interactive browser state back. Variable lookup uses process env,
then the web app's `.env.local`, then the checkout's `.env.local`; resolved values stay out of
adapter environments.

Phone handoff is separately optional: declare `debugAs.phone` and the identity's `phone.email`,
then create the private machine contract at `~/.config/ax/debug-as.json` (or under
`XDG_CONFIG_HOME`). It names a stable `relayPort`, an exact `allowedTailscaleLogins` list, optional
`allowedSupabaseHosts`, and an optional notifier argv. Use mode `0600` and owner-controlled
parents. `ax debug-as --help` explains `--phone` and `--no-phone`; the schema documents provider
fields. The relay serves a confirmation page through Tailscale Serve and creates authentication
only after confirmation. Existing unowned Serve mappings are refused, never adopted.

Command providers receive `{"protocol":1,"kind":"phone-handoff","identity":"owner",
"email":"owner@example.com","path":"/home","origin":"https://machine.example:3110",
"login":"operator@example.com"}` on stdin and must return
`{"protocol":1,"url":"https://machine.example:3110/auth/confirm?..."}`. The URL must stay on
the recorded Tailscale origin. This call occurs only after confirmation and has a 15-second
deadline and a 64-KiB response cap.

The optional notifier uses the same bounded process protocol, with `kind: "phone-handoff"`,
`project`, `worktree`, `identity`, `path`, `generation` and `url` fields. Its URL is the relay's
confirmation page, never an authentication link. It answers `{"protocol":1,"ok":true}`;
failure leaves the handoff usable and a later matching launch retries delivery.

**Migration:** the former `debugAs: { route, optInEnv }` shape is retired. Remove it or replace it
with `browser`, `identities` and optional `phone`. `init` and `doctor` print the migration repair
without blocking pinning; no route, identity or provider is inferred. Projects that omit `debugAs`
receive no debug-session instruction in their managed agent block.

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
