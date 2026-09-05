---
title: A view that hides a row because it names no repair — and the per-row forge read that makes it name one
date: 2026-09-05
category: bugs
module: src/worker/continuation.mjs, src/worker/ls.mjs, src/worker/tail.mjs
problem_type: gotcha
component: orchestration
severity: medium
symptoms:
  - "`ax worker ls` prints `N MORT record(s) not shown — a pane the runtime cannot see names no repair`, and one of those records owns an OPEN pull request"
  - "`ax worker tail <request>` answers `EXITED` and names only the child's transcript, never the verb that continues the work"
  - "An operator holding a dead row with unfinished work has to already know `ax worker start --replace` exists"
  - "A per-row `gh` read added to a hot reader multiplies its wall time (measured 3.7s → 10.3s on 255 records)"
root_cause: a_visibility_rule_kept_after_its_ground_stopped_being_true
resolution_type: code_change
related_components:
  - liveness
  - measurement
tags:
  - f-028
  - continuation
  - hot-reader-cost
  - default-view
---
# A hidden row's ground has to be rechecked when the row starts naming a verb

## Problem

`ax worker ls` shortened its default view (#70) to the dispositions that carry a
decision, and the sentence that justified dropping MORT rows was a property of
those rows at that moment: *a pane the runtime cannot see names no repair*. One
ticket later that property was false for a whole class of them — a pane that
died while its pull request was still OPEN is continued by
`ax worker start --replace --request <id>`, which #164 had just made safe to
type. The row an operator most has to act on was the one behind a flag, and the
disclosure line asserted, in words, that it had nothing to offer.

`ax worker tail` had the mirror gap: `EXITED` named the child's history
(`ax worker transcript`) and nothing about the work the child owed.

## Two things this cost, and what fixed each

**The visibility rule.** "It names no repair" is a MEASUREMENT of a row, not a
class of row. When a new route makes some of those rows actionable, the filter
has to be re-derived from the route rather than from the disposition: a MORT row
is now shown when it names a verb (or when the read that would have named one
FAILED — an inability is not an absence, F-028), and the archaeology that names
nothing keeps the disclosed count it had.

**The cost of asking.** The route is decided by that branch's pull request, so
each candidate row costs a `gh pr list --repo <slug> --head <branch>`. Measured
on this machine, 2026-09-05: 255 records, 222 MORT, and **10 naming a worktree
that still exists** — because a branch can only be named from a recorded
worktree, and a landed worktree is removed. That bound is what makes the read
affordable at all; without it the same feature is 222 forge calls on the verb an
orchestrator runs before every dispatch. Even bounded it is not free:
`ax worker ls` went from **3.7s to 10.3s** on that store, all of it in ~7 `gh`
calls. A repository-wide `gh pr list --limit 200` would collapse them into one
call and was rejected: a PR older than the window reads as *no pull request*,
which routes an unfinished slice to `settle`.

## Two traps in the routing itself

- **Placement may not be derived twice.** The continuation printed here is
  `ax worker start --replace --request <id>` with NO placement flags, and the
  decision of whether a replace can be trusted at all is `inheritPlacement`
  (src/worker/start.mjs) asked with the empty typed argv — the exact shape the
  printed line runs. A reader that read `--worktree` itself to compose the line
  would be a second placement authority, which is what #11 cost.
- **A superseded pane does not own its record.** A `--replace` records a second
  `worker-start`, so one record holds an old corpse beside the live child that
  replaced it, and `ax worker tail ctx_old` reads that corpse by name. The
  continuation speaks about the record's CURRENT attempt (`workerStartArgv` is
  its newest placement), so printed under the old pane it offers to replace the
  child that is working. The pane a continuation rides on must be the record's
  newest pane; anything else gets none.

## The rule

A row hidden for naming no action inherits a claim, and the claim expires. When
a verb starts answering for that row, the filter is re-derived from what the row
NAMES — never left on the disposition it had when the view was shortened.

And a per-row artifact read belongs in a hot reader only with a bound that comes
from the record itself. Here it is "a branch nobody can name is a branch nothing
can be asked about": state the bound, measure it, and print the cost's own count
so the next reader can check it is still true.
