---
title: One argv slot is not an ownership boundary — the arity of a declared flag is
date: 2026-09-03
category: bugs
module: src/cli.mjs
problem_type: bug
component: command-surface
severity: high
symptoms:
  - "`ax init --vendor makerkit/next-supabase-saas-kit --help` exited 0 having written six paths of the repository it was asked about — the #69 incident, one argv slot to the right (#89)"
  - "`ax worktree clean --help` printed `reclaiming …` and exited 0: it signalled dev processes, tore down a Supabase stack and removed build output, none of it visible to `git status --porcelain` (#93)"
  - "`ax worktree setup --help` provisioned; `ax worktree rm <name> --help` took the name as its target"
  - "`ax worker tail --help` answered `CANNOT ESTABLISH — no dispatch record names a pane for '--help'` (exit 3): a diagnosis of the wrong question entirely"
  - "Twenty declared subverbs answered one question five different ways — three by running, two by consuming it as a positional, three by refusing it as unknown, ten out of their own argv loop"
root_cause: a_positional_boundary_stood_in_for_a_data_boundary
resolution_type: code_fix
related_components:
  - command-registry
  - help
tags:
  - help-is-a-read
  - registry-composed
  - structural-guarantee
  - side-effect-on-a-question
  - arity-is-registry-data
---

# One argv slot is not an ownership boundary

## Problem

The fix for #69 claimed `--help` in ONE position, the command's first, and stated the reason as
doctrine: past `argv[1]` the argv belongs to whoever owns it, so claiming more would swallow a flag
that was never ax's to answer (`docs/solutions/bugs/a-flag-that-reaches-a-runner-is-answered-by-running-it.md`).

That boundary is not where ownership sits. Anything at all occupying slot 1 hands the rest of the
argv to a runner that may not read the flag: a value-taking flag (`init --vendor <x> --help`), a
positional, or a noun's verb (`worktree clean --help`). Slot 1 was never the line between owners —
it was the one place the question was already safe to ask, which is a different fact and does not
generalise.

The reporter's own diagnosis was narrower than the defect, and worth keeping as a warning: it named
*flags that take a value* as the surviving shape, because a scan for a help flag before the first
positional would otherwise have caught it. That would have fixed the measured instance and left
`worktree clean --help` reclaiming.

## Resolution

The claim became the command's WHOLE argv, and two pieces of REGISTRY DATA make it safe:

- **Arity.** A flag declared `--comment <text>` takes the next slot; one declared `--verbose` does
  not. So `ax board --comment --help` is a comment whose text is `--help`, and it is the declaration
  that says so rather than the shape of the string. One convention — the `<placeholder>` — held by a
  test, because a `--flag value` declared without it would read as boolean and silently turn its
  value into a help page.
- **Ownership.** `passthrough: true` marks a command whose arguments are a foreign CLI's in full.
  ax claims the first slot of `ax supabase …` and not one argument past it, so `supabase db push
  --help` reaches the CLI that owns the question.

Both live beside the declarations they read (`helpAsked`, `src/commands.mjs`), and `runCli` asks the
registry one question before any runner is reached.

The same change deleted ten per-verb help paths (`pin`, six `triage` verbs, three `worker` verbs)
and reversed the two headers that recorded a help flag being consumed as a positional as
deliberate (`src/worker/gate.mjs`, `src/worker/tail.mjs`). A second code path answering one question
is what produced five answers across twenty subverbs; leaving them as unreachable code would have
kept the drift alive with nothing dispatching to it.

## Lesson

When a guarantee is scoped by POSITION, ask what the position is standing in for. Here it stood in
for two facts the registry could state directly — which flags take a value, and which command owns
its argv — and a positional rule that approximates a data rule holds only for the inputs someone
happened to measure.

The cost of the wrong scope is asymmetric and that decides the safe direction: a help read that
runs a verb mutates the repository it was asked about, while a value slot misread as a question
prints a page. Where arity is genuinely undeclared (a verb's own flags), the code reads the flag as
the question on purpose.
