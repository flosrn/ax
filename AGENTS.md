# AGENTS.md

`ax` is a CLI that provisions and grades worktrees for MakerKit turbo projects. Zero dependencies,
no build step: `bin/ax.mjs` runs the files in `src/` directly.

```bash
node --test "tests/*.test.mjs"    # 845 tests, ~11s, offline
node bin/ax.mjs                   # the command surface
node bin/ax.mjs doctor            # run it against any checkout
```

## The one thing to understand first

A worktree's target state is decided **once**, by `planWorktree()` in `src/worktree/plan.mjs`, which
is a pure function of its arguments. `setup` writes that plan. `doctor` re-derives the same plan and
**compares** — it owns no rule of its own.

The Bash this replaced had setup and doctor deriving the same rules separately. They drifted twice
in production, and each time the doctor graded a healthy worktree as broken. So:

- A new rule goes in `plan.mjs`, never in `setup.mjs` or `doctor.mjs`.
- A check the doctor cannot express as "recorded value vs plan value" means the plan is missing a
  field. Add the field.

```
probes (machine) ──► plan (pure) ──► apply (writes)
                       ▲
                       └── doctor re-derives, compares, never writes
```

## Layout

| Path | Owns |
|---|---|
| `src/worktree/plan.mjs` | every decision: port, URLs, database mode, the env blocks to write |
| `src/worktree/probes.mjs` | everything that looks at the machine, one function per question |
| `src/worktree/{identity,ports,supabase,addressing}.mjs` | the rules the plan composes |
| `src/worktree/{setup,list,clean,remove,doctor}.mjs` | the verbs; they render and write, nothing else |
| `src/worktree/context.mjs` | the file an agent reads first inside a provisioned worktree |
| `src/{dotenv,git,proc,hash}.mjs` | generic helpers, no project knowledge |
| `src/{config,schema,blocks}.mjs` | the `ax.config.json` contract |
| `src/supabase-guard.mjs` | `ax supabase` — promotes a checkout before a command can write shared data |
| `src/commands.mjs` | the registry: help, dispatch and the AGENTS.md block a project gets |

## Rules a patch has to follow

**No project constant, anywhere.** Ports, offsets, app paths, prefixes and vendor lists come from
`ax.config.json` via `loadCheckoutConfig({ root, main })`. A literal `3000` or `'ofmchat'` in `src/`
is a bug — this package runs in other people's repos.

**Probes are injected.** Any function whose answer depends on the machine takes it as a named
option with a real default: `resolvePort({ …, isBound = isPortBound })`. That is what lets the suite
run with no Docker, no port binds and no network. A test that needs a container is a design smell.

**Declare a command before you write it.** `src/commands.mjs` is the only source: `bin/ax.mjs`
builds its help and dispatch from it, `ax init` builds a project's AGENTS.md block from it, and a
test asserts that block advertises nothing the CLI cannot answer. A registry entry with no runner
throws at startup, on purpose. Verbs of one noun (`worktree setup`) live in a `SUBCOMMANDS` table,
asserted equal to the registry's `subcommands`.

**Every finding names its repair.** Output goes through `src/log.mjs` only, and a `bad` without a
`fix` gets ignored by the human reading it.

**Anything destructive proves ownership first.** `clean` and `rm` resolve their target through
`src/worktree/locate.mjs`, which refuses anything but a registered worktree root; `supabase stop`
only ever runs behind `ownsStack()`, which requires the config's project id to equal the id this
worktree resolves. These guards exist because the versions without them deleted tracked source,
removed the wrong worktree and could stop the shared database.

**A fix needs a test that fails without it.** Preferably on a real temp repo (`git init` in
`os.tmpdir()`): the defects that reached users were all invisible to mocked filesystems.

## Adding a command

One entry in `src/commands.mjs`, one runner in `bin/ax.mjs`, one file under `src/`, one test file.
Give it an `agentLine` only if an agent should reach for it — that string lands in every consuming
project's AGENTS.md, and `tests/commands.test.mjs` runs everything it advertises with `--dry-run`.

## Trying a change against a real project

Point that project's pin at this checkout instead of publishing:

```json
"@flosrn/ax": "link:../../flosrn/ax"
```

Then `pnpm install` there, and `pnpm -w ax doctor`. The pin normally reads
`github:flosrn/ax#v<version>`; `src/init.mjs` derives it from `package.json`, so a release is a
version bump plus a matching git tag.
