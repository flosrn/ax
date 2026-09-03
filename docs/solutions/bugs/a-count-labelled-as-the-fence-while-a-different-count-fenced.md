---
title: A count labelled as the fence, while a different count fenced
date: 2026-09-03
category: bugs
module: src/worker
problem_type: bug
component: worker-capacity
severity: high
symptoms:
  - "`ax worker ls` ended with `3 live pane(s) — this is the cap count` from a checkout whose own live panes numbered zero: all three belonged to another repository"
  - "`ax worker dispatch` admitted a 4th and a 5th pane without a word, minutes after `ax triage dispatch` refused at the same moment over the same store"
  - "A 13-issue triage wave ran at one slot because another checkout's orchestrator had admitted two panes, and the only lever was an env var whose name said `triage` and whose absence still meant 3"
root_cause: one_number_answered_two_different_questions
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - f-048
  - agent-facing-output
  - disclosed-omission
  - host-global-store
---
# A count labelled as the fence, while a different count fenced

## Problem

The dispatch store is host-global by design (`src/worker/record.mjs`), so every number taken from it
is machine-wide unless something scopes it. Three verbs read it and disagreed three ways: `ls`
printed the machine total under the label `this is the cap count`, `worker dispatch` enforced
nothing at all, and `triage dispatch` enforced a machine-wide cap that defaulted to 3 whether or
not an operator had armed it.

The measurements, 2026-09-02, two checkouts on one Mac (#88):

| | what it printed | what it enforced |
|---|---|---|
| `ax worker ls` | `3 live pane(s) — this is the cap count`, all three another repository's | nothing |
| `ax worker dispatch` | nothing | nothing — a 4th and 5th pane admitted in silence |
| `ax triage dispatch` | `cap: 3 live child pane(s) + 1 > 3` | every live pane on the machine |

The cost was not the refusal; it was the label. An orchestrator that honours "count with `ls`, never
from memory" read a fence where there was none, and spent a full turn deciding whether it was
allowed to dispatch at all. A second orchestrator, on the verb that did refuse, was parked by panes
it did not own.

## Fix

**One question per number, and the label says which.** There are two counts, and neither can answer
for the other: this repository's live panes, which `dispatch.cap` gates (default 3, per repository),
and the machine total, which `dispatch.machineCap` gates and which does not exist until an operator
declares it. Both live in `src/worker/capacity.mjs` — a pure module read by `ax worker ls`,
`ax worker dispatch` and `ax triage dispatch` — so the sentence a reader counts with and the fence
that refuses it come from the same place.

**An unset fuse is not a small fuse.** `ORCA_TRIAGE_SESSION_CAP`'s unset default of 3 was the same
bug under a new name: another checkout's two panes ate the ceiling, and this repository never
reached its own cap. Absence now means NO CEILING, and both retired knob names are refused by name
rather than read past.

**A record naming no repository is UNKNOWN, and counts toward the ceiling only** (F-028) — the
opposite convention to `src/frontier.mjs`, deliberately: for a frontier, including an unknown is the
conservative reading; for a per-repository cap, excluding it is what stops another checkout from
parking this one. It is never dropped in silence — every caller prints how many there were.

**The fence reads the liveness the listing prints.** `ls` had judged a remote pane by asking its
host since #76, while both gates counted the local terminal list alone; on this Mac the local scope
omits a remote runtime, so three working remote children read as UNKNOWN and no cap bound them.
`liveInventory` in `src/worker/pane.mjs` is now the one union both sides count — the local list plus
each host a record names, asked once, and only where the answer can still change the count.

## Reusable rule

**A printed number that claims to be a fence must be the number the fence uses.** When one count
serves two questions — "how much is running" and "may I add one" — the label is where the lie
surfaces first, and it surfaces in someone else's turn: an agent reading the receipt cannot see that
the enforcement path counted something else.

Two cheap checks name it before it costs a turn:

1. Every verb that prints a capacity number and every verb that refuses on one import the same
   function. A second derivation of "how many are live" is the defect, not the different wording.
2. A scope that appears in the label appears in the count. `N live pane(s)` with no scope named is
   either machine-wide or repository-scoped, and the reader cannot tell which — so it will be read
   as whichever one is wrong.
