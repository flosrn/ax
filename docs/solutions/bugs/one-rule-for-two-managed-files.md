---
title: A managed-block contract that is per checkout instead of per file names a repair that writes into the package's own doctrine
date: 2026-09-03
category: bugs
module: src/plan.mjs, src/init.mjs, src/doctor.mjs
problem_type: bug
component: measurement
severity: medium
symptoms:
  - "`ax doctor` on the ax checkout itself printed `✗ AGENTS.md carries no BEGIN:ax block → ax init` and `✗ .gitignore carries no BEGIN:ax block → ax init`"
  - "Running the named repair would append a generated `## ax tooling` consumer section into `AGENTS.md`, the package's own authored doctrine graded by `tests/docs.test.mjs`"
  - "`git log -S'BEGIN:ax' -- AGENTS.md .gitignore` returns 0 commits: the checkout never carried either block, so this was never drift from a removal"
  - "Both verbs hardcoded the same pair of filenames independently, with no plan field between them"
  - "The self-hosted contract test was green only because its own `ax init` wrote both blocks into the fixture — the write the real checkout has never taken"
root_cause: missing_plan_field
resolution_type: code_fix
related_components:
  - project-plan
  - managed-blocks
tags:
  - plan-vs-verb
  - self-hosting
  - repair-that-cannot-come-true
  - per-file-not-per-checkout
  - authored-vs-generated
---
# One rule for two managed files

## Problem

`an-unadopted-contract-graded-as-a-defect.md` gave the project a plan and moved the bootstrap, the
pin and the `$schema` pointer onto it. The managed blocks were the one domain it did not move: the
plan carried `selfHosted`, `bootstrap` and `pin` and said nothing about the blocks, so `src/init.mjs`
wrote a literal `['.gitignore', 'AGENTS.md']` pair and `src/doctor.mjs` graded the same literal pair
— the exact two-verbs-one-guess shape `src/plan.mjs`'s header exists to record.

On the checkout that publishes ax the shared guess was wrong for ONE of the two files. `AGENTS.md`
here is the package's own authored doctrine, graded as prose by `tests/docs.test.mjs`, and the block
body is `agentsBody()` — a generated consumer instruction section advertising four commands. So
`ax doctor` named `ax init` as the repair for a write nobody was willing to make, and it read red on
that line for the whole dogfood wave (7 tickets).

`.gitignore` is the opposite case, and that is why one rule for both files was the mistake. Its body
is AX runtime state — `.worktrees/`, `.agent/`, `.scratch/` — which this checkout produces exactly
like a consumer's, since its own workers enter its own worktrees. Two of those three were ignored
only by `~/.config/git/ignore` and `.git/info/exclude`: machine-local configuration that does not
travel with the clone, so a fresh clone on another machine showed both as untracked.

## What it cost

F-014's exact state: a finding nobody may act on trains the reader to ignore the verb. `ax doctor`
is also `ax pin`'s own gate, so a permanently-red line on the publishing checkout is a gate that
cannot be trusted to mean anything on the one repository that cuts releases.

## Fix

The managed-blocks contract became per FILE, in the plan:

```js
export const MANAGED_BLOCKS = [
  { file: '.gitignore', selfHosted: true },
  { file: 'AGENTS.md', selfHosted: false },
];
blocks: Object.fromEntries(MANAGED_BLOCKS.map(({ file, selfHosted: wanted }) => [file, selfHosted ? wanted : true]))
```

`ax init` iterates `plan.blocks` and writes the ones whose value is true; `ax doctor` derives the
same plan and grades presence for those and ABSENCE for the rest. The bodies stayed in
`src/init.mjs` as `BLOCK_BODIES`, keyed by the file the plan names, because a body is what ax
writes while the decision is the plan's — and `plan.mjs` cannot import them without a cycle.

## The rule this paid for

**AN EXEMPTION IS PER FILE WHEN THE FILES HOLD DIFFERENT KINDS OF CONTENT.** `selfHosted` is one
fact about a checkout; it is not one answer for every file that checkout owns. Generated consumer
instruction and generated runtime state read as one domain from the verb's side and as two from the
repository's, and only the second view is the one an operator lives with.

**AN EXEMPT FILE IS STILL MEASURED.** The plan refusing a block makes the block's PRESENCE the
finding, with removal as the repair — the same disposition the refused self-pin and the refused
`bin/ax` shim already had. An exemption that stopped reading the file would have traded one
unrunnable repair for one unmeasured file, which is a quieter version of the same defect.

**MEASURED IS NOT THE SAME AS REPORTED.** The exempt file prints NOTHING while it is right (ruled
on the issue): a `·` line saying a file the plan wants nothing in has nothing in it is one more
line every reader of every run pays for, and the exemption is already legible where it is decided —
`ax init` names the file it skipped and its reason on every run. Loud when wrong, quiet when right.
Reaching for a `note` here was the reflex, and the house style it copied (`src/doctor.mjs`'s
NOT MEASURED lines) exists for a different case: an unrun check, where silence would read as a
pass. A graded check that passes needs no line of its own.

**`ax init` REPAIRS ONLY WHAT IT WRITES.** It never removes a block from a file the plan exempts, so
naming it as the repair for that state would be a second `fix` that cannot come true. The repair is
the removal itself.
