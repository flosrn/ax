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
- a dispatch is admitted by Slots on the host it lands on, counted from panes the runtime still
  owns rather than an accounting table that may omit repaired workers;
- a worker is released only after its pull request or other governing artifact has landed;
- the merge gate runs every declared ground against the exact head SHA and performs the merge it
  validated.

A repository that declares `"report": true` in `prGate` also gates each ticket merge on the
worker's Report. Its `## CRITERIA` section holds one fenced `ax-report-v1` JSON block reproducing
the ticket's current acceptance criteria verbatim, each `MET` with the command or artifact
inspected and the value observed (`omp/playbooks/implementation.md` defines it). A detector run
prints an acceptance digest binding repository, PR, ticket, head, base, assignment and Report
bytes; the merge needs the orchestrator's explicit judgment of that read:

```bash
ax pr gate --pr 19 --issue 12                      # detector: grounds plus the acceptance digest
ax pr gate --pr 19 --issue 12 --merge --accept-report <digest> --reason "<what was inspected>"
ax worker release && ax worktree reclaim <worktree>
ax worktree panes <worktree>                       # what a live-pane KEEP is holding; --close <handle>… ends them
```

Judge the current canonical criteria and evidence the detector prints on each fresh read, a
remote repair included; that printout is redacted for display, not the raw bytes the digest
binds. When an observation that matters is redacted, inspect the raw file on the owning host the
detector names, at the Report path it names, never an arbitrary worker path.

Any change to the Report, the assignment, the head or the base refuses an old digest. CI still
decides on its own, AX checks the evidence's shape rather than its truth, and the judgment grants
no GitHub permission: a direct merge outside AX is not blocked.

### Where a worker runs

`ax worker dispatch` places the child where the operator names it, or where Slots choose:

```bash
ax worker dispatch --issue 412 --slug fix-guard                # the compute host with the most Slots
ax worker dispatch --issue 412 --slug fix-guard --on gapicore  # a host declared in dispatch.hosts
ax worker dispatch --issue 412 --slug fix-guard --on here      # this machine
```

Slots are the only admission. A remote dispatch, placed or named with `--on <host>`, runs
`bun scripts/capacity.ts --json` in the HarnessOS checkout named by `HARNESSOS_SOURCE`, or by
`dispatch.harnessos` in `ax.config.json` when that variable is unset. Each reported host's ssh
target, slice cgroup and floors come from that report; `dispatch.hosts.<host>` overrides them
field by field for this repository. With `live` the panes recorded on that host plus the starts
still open there, and `fp` the worker footprint, a host's Slots are:

```text
max(0, min(floor(min(freeMb, hostAvailableMb) / fp),
           floor(maxMb / fp) - live,
           floor((workMb + hostAvailableMb) / fp) - live,
           floor(cpu.freePercent / cpuFp),
           maxWorkers - live))
```

Each live worker reserves its footprint even in a quiet phase, against both the slice maximum and
the memory the host can still give the slice (what the slice holds plus what the host has
available). Free memory is point-in-time headroom; the reservation terms are what leave room for
a quiet worker's later peak. Once the host is proven, admission takes a per-host lock, reads the
host's Slots again under it, and releases it when the start is recorded, so two dispatches cannot
spend one last Slot. A lock left by a killed dispatch is shown by `ax worker hosts <host>` with
its removal command.

A host offers no Slot, with its reason printed, when it is cordoned, ineligible, retired, has no
healthy gateway probe, sends a report entry that fails validation, has live panes nobody can
count, has no Orca repository of this name, or fails the host grounds `--on` proves. A rise in the
slice's `oom_kill` counter since the last acknowledgement makes the host ineligible until the
operator runs `hos host ack-oom <host> --apply` in HarnessOS. A host that cannot be measured offers
no Slot and blocks no other host: placement skips it by name and the worker lands on the eligible
host with the most Slots, ties going to the report's order. `--on <host>` passes through the same
contract: a host with no Slot refuses the dispatch, creates nothing and never falls back to
another host or to the Mac.

Placement runs only on the operator Mac, and it never places on it: when no host can take the
worker, the dispatch is refused with each host's reason. A dispatch with no target run anywhere
else is refused. `--on here`, a local `--worktree` and triage passes stay on this machine with no
capacity read and no ceiling: the operator chooses the wave size there.

```bash
ax worker hosts            # every compute host: Slots and their terms, memory, oom_kill
ax worker hosts gapicore   # one host, or why it offers no Slot
```

`ax worker hosts` prints each host's Slots with the terms they are the minimum of, the slice's
maximum, held, free and peak memory, the host's available memory, `oom_kill` against its
acknowledged value, and the reason when the host offers no Slot. It dispatches nothing.

### End a pane, write off a host

```bash
ax worker close <handle|request>   # end one named pane on the operator's word
ax worker retire-host netcup-dev   # write off a host that will never answer
ax worker unretire-host netcup-dev # withdraw that retirement
```

`ax worker close` ends exactly one pane its recorded host still lists, whether or not its agent is
working, and records an operator ending on the attempt that owns it — never a landing; no branch,
worktree or pull request is touched. The host must answer: a pane it no longer lists is refused
with `ax worker settle` as the repair. `ax worker release` remains the ending for a pane whose
pull request landed.

`ax worker retire-host` records that the operator wrote a host off, and only while that host's
terminal list does not answer; a host that answers is refused, and its panes take
`ax worker close`. Only a failed connection or a timeout is silence: any other Orca error, such as
an unpaired environment name, writes nothing. Retirement holds the host's admission lock, so no
dispatch is admitted onto it meanwhile. The retirement is an attestation, never a proof: the
host's panes stay INCONNU, its records leave the frontier while no other claim holds their ticket,
and Slots skip it.
`ax worker unretire-host` withdraws it without asking the host.

**Migration:** `dispatch.cap` and `dispatch.machineCap` are retired. A configuration that still
declares either, whatever its value, is refused by name by every verb that reads it; delete the
key from `ax.config.json`. `ax init` reports it without refusing. `ORCA_TRIAGE_SESSION_CAP` and
`ORCA_READY_SESSION_CAP` stay refused: unset them and read `ax worker hosts`. `--on <host>` now
reads HarnessOS capacity, so it needs `HARNESSOS_SOURCE` or `dispatch.harnessos` and a HarnessOS
build that emits `oom`.

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
unproven, never a verified assignment. Host placement, account rotation and
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
