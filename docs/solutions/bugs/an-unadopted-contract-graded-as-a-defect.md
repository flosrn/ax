---
title: Grading a contract the project never adopted turns every check into a repair that changes the project against its own decision
date: 2026-09-02
category: bugs
module: src/plan.mjs, src/init.mjs, src/doctor.mjs
problem_type: bug
component: measurement
severity: medium
symptoms:
  - "`ax doctor` exited 5 on a project declaring `{project, prGate}` and nothing else: bin/ax, .omp/settings.json, scripts.ax, .gitignore, AGENTS.md — five findings, all naming `ax init`"
  - "Every one of those repairs, if followed, would provision a layout the project had deliberately not asked ax for"
  - "No output distinguished 'this contract is broken' from 'this project never adopted this contract'"
  - "`ax init` on the ax repository itself wrote `devDependencies[\"@flosrn/ax\"]` — a dependency on itself, which no install resolves — plus `scripts.ax` and a `bin/ax` shim whose only job is to exec `node_modules/.bin/ax`"
  - "`ax doctor` then graded all three of those and reported the checkout as coherent"
root_cause: missing_plan_field
resolution_type: code_fix
related_components:
  - project-plan
  - adoption
tags:
  - plan-vs-verb
  - not-measured
  - proof-vs-absence
  - self-hosting
  - repair-that-cannot-come-true
---
# A contract nobody adopted, graded as a defect

## Problem

Two `ax doctor` findings could not be phrased as "recorded value vs plan value", which by this
repository's own rule (AGENTS.md, `src/worktree/plan.mjs`'s header) means a plan is missing fields.
Both were in the PROJECT half — and the project half had no plan module at all. `ax init` decided
the target state while writing it, `ax doctor` decided it again while grading, and the two agreed
only because nobody had yet found a repository where the shared guess was wrong. Two existed.

**The checkout that IS the package.** On the ax repository, `ax init` wrote a self-pin, a
`scripts.ax` and a `bin/ax` shim. The shim execs `node_modules/.bin/ax`; no package can be an
install of itself. Neither verb was wrong about its own half — there was no field saying which
repository this is, so both invented the same wrong answer independently, and `doctor` graded the
result green.

**Partial adoption.** `prGate` has never gone through the provisioning contract: `src/pr-gate.mjs`
reads that one key raw, on purpose, so a project may declare what its merge must prove without
adopting a layout this package does not own (its header names the two repositories that measured
that). gapila does exactly that, by design. `ax doctor` graded the bootstrap, the OMP bundle and the
managed blocks unconditionally, so gapila was red on five findings forever.

## What it cost

Nothing shipped wrong, and that is the interesting part: both states were STABLE incoherence. The
gate-only project is permanently exit-5, so `ax doctor` cannot be used as a gate there at all — and
`ax pin` runs `doctor` as its own gate, which is the mechanism that already cost a deployment once
(`docs/solutions/` has no entry for it; `src/doctor.mjs`'s vendor-remote comment does, measured
2026-08-28). The self-hosted checkout is the mirror: it reported COHERENT while carrying a manifest
no install could resolve.

## Fix

`src/plan.mjs` — the project-level counterpart of `src/worktree/plan.mjs`. `planProject({ manifest,
declared })` is pure; `init` writes that plan, `doctor` derives the same plan and compares.

```js
const selfHosted = manifest?.name === PACKAGE_NAME;   // the NAME, never a path or a remote
adopted: Object.fromEntries(CONTRACTS.map(c => [c.id, declared.includes(c.declaration)]))
```

`declared` is the root keys the FILE carries, surfaced by `loadConfig` alongside `config`. It has to
be the raw keys: `apps` has a schema default, so `config.apps` is set for every project that loads,
and reading adoption off `config` would make every repository look like it asked for everything.

## The two rules this paid for

**ADOPTION IS DERIVED FROM A DECLARATION, NEVER FROM THE PRESENCE OF THE FILES A CONTRACT
PROVISIONS.** Reading it off the files looks equivalent and is not: it makes the adopting verb
unable to adopt anything, because that verb WRITES those files, and it makes a half-provisioned
checkout indistinguishable from an unadopted one.

**THE VERB NAMED AS THE ADOPTER MUST WRITE THE DECLARATION.** `ax init` provisions and now declares
`apps` when the configuration does not. Without that line, `ax doctor` would report the contract as
unadopted immediately after the operator ran the verb it named as the way to adopt it — the same
class as the self-referential repair in
`a-join-on-the-wrong-key-renders-as-an-absence.md`: a `fix` whose command cannot produce the state it
promises is not a repair, and a reader who follows it twice concludes the tool has no answer.

## Why the reverse direction is still graded

Demoting a check is not deleting it. On a self-hosted checkout the plan says no shim and no pin, so
a `bin/ax` that EXISTS there is a finding with its own repair (`rm bin/ax`), and so is a self-pin.
The unadopted contract is different in kind: it is NOT MEASURED, reported with the verb that adopts
it, and an unrun check is never a passed one — the same disposition `src/pr-gate.mjs` takes on an
absent `prGate` and `src/doctor.mjs` takes on a missing vendor remote.
