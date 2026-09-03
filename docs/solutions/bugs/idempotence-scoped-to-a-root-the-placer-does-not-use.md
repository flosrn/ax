---
title: An idempotence check scoped to the layout your own code writes is inert wherever another tool chose the location
date: 2026-09-03
category: bugs
module: src/worker/placement.mjs
problem_type: bug
component: orchestration
severity: medium
symptoms:
  - "A dispatch that placed a worktree and then failed `ax worktree setup` exited 3 with nothing recorded and the tree left on disk, and the retry with the same slug placed `<request>-2` beside it"
  - "One ticket owned two worktrees and two branches while the dispatch record kept the unsuffixed request id, so a request id no longer named its own worktree"
  - "The module's header claimed idempotence as `the only countermeasure available`, and every test agreed with it"
root_cause: countermeasure_scoped_to_the_wrong_root
resolution_type: code_fix
related_components:
  - worktrees
  - measurement
tags:
  - f-028
  - idempotence
  - reuse
  - placement-root
  - inert-countermeasure
---
# An idempotence scan rooted in your own layout, on a path another tool places

## Problem

`placeLocal` answers "does this ticket already have a worktree" so a retry reuses the first tree
instead of asking for a second one. It scanned exactly one directory: `<root>/.worktrees`, the
layout this package writes. But placement has three branches, and only the first two land there —
the third hands the job to Orca, which places into its OWN workspaces root. This repository
declares no `dispatch.worktreeTool`, so the third branch is the only one it ever uses.

The countermeasure was therefore inert on the only path in use, and nothing said so. It cost a
retry after a legitimate cannot-establish: the refusal correctly wrote no record and correctly left
the tree, the operator re-ran the same argv, the scan read a directory the tree was not in, and a
second `worktree create` went out. Orca disambiguates a taken name by suffix, so the tree came back
as `<request>-2` — two branches for one ticket, and a record naming neither by that name.

## Why the shape hides

The scan root and the placement root were both written into this module and never compared. Worse,
the tests encoded the gap as an assumption: every Orca fixture placed its tree at
`join(root, 'placed-by-orca', …)` with a comment explaining why — "outside `.worktrees/` — a tree
already sitting there would legitimately be reused by the prefix rule". That sentence is true, and
it is exactly the case the production path always takes. A fixture written to isolate a rule can
end up asserting the rule is never reached.

The reporter's own diagnosis pointed elsewhere — that the refusal should have removed what it
placed, or named a verb that removes it. That was ruled out: a refusal naming a removal still mints
`-3` on the next retry an operator runs without cleaning first. Suffixing is the placer's
disambiguation, so the only fix is upstream of it.

## Fix

Ground the question in a registry neither root owns, and narrow it by where placement is allowed to
lend from:

- **Candidates come from `git worktree list`** — every registered worktree, by absolute path,
  whatever root it lives under. Registration is also a floor worth having: an unregistered
  directory sitting in a placement root is not a worktree, and lending it sends a child into a tree
  the runtime resolves no selector for.
- **Lendability is a PLACEMENT ROOT plus the name rule, never either alone.** The roots are
  `<root>/.worktrees` and the workspaces root the runtime reports for this repo — asked through the
  injected runner, because that root is the runtime's answer and a hardcoded `~/orca/workspaces`
  is wrong on the next host and silently wrong on this one after a settings change. A hand-made
  `~/scratch/71-help-is-a-read` matches the name and is nobody's dispatch. The primary checkout is
  never lent; the checkout the caller is standing in still is, because the refusal tells them to
  `cd` into the stranded tree and re-run.
- **Two candidates are an inability, not a pick.** Reading the whole registry makes duplicate
  basenames across two roots reachable for the first time — the reporting host already carried
  `89-work`, `89-work-2` and `89-help-slot` — and resolving that by position dispatches a child
  onto a branch that is not its own. It refuses with every candidate named and `--worktree <abs>`
  as the repair, the shape `locateWorktree` already uses for the destructive verbs.
- **An unreadable list is unknown, not empty** (F-028). The list gates a `worktree create`, so
  answering an unreadable receipt as "no trees" is precisely what places the second tree.

## The rule for this bug

**A countermeasure has to be rooted in the same place as the operation it guards, and if that place
is another tool's choice, ask the tool.** Scanning the layout your own code writes proves nothing
about a path where someone else decided the location — and it fails silently, in the agreeable
direction: the check runs, finds nothing, and the create it was supposed to prevent goes out
looking authorized.

The tell is a guard whose root is a constant assembled from your own configuration while the
operation it guards learns its location from a receipt. Ask what the guard would read if the
operation had placed the thing somewhere else, and whether any test ever put it there.
