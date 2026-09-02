---
title: A receipt whose default view is priced per RECORD, read by an agent that pays per line
date: 2026-09-02
category: bugs
module: src/worker
problem_type: bug
component: worker-ls
severity: medium
symptoms:
  - "`ax worker ls` printed 263 lines (≈40 KB) to deliver the three summary lines the orchestrator role reads before every dispatch"
  - "189 of 189 rows carried no decision for that reader: their recorded pane was gone and the work was over"
  - "The two answers it is run for — the live-pane count and WHICH panes are live — were the last lines of the output"
root_cause: default_view_sized_by_store
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - agent-facing-output
  - context-cost
  - disclosed-omission
---
# A receipt priced per record instead of per reader

## Problem

`ax worker ls` joins three sources and renders one line per dispatch record. That was right when
its reader was an operator inspecting a machine, and wrong once its reader became `omp/roles/orchestrator.md`,
which runs it **before every dispatch** for exactly two answers: how many panes are live (capacity)
and which they are (overlap arbitration).

Measured 2026-09-02 on this machine (flosrn/ax#70): 189 records, 263 lines, ≈40 KB per run, for a
signal of three lines — with those three lines LAST. A session dispatching a wave spent a ticket's
context budget on archaeology, once per child.

## Fix

The default view keeps the dispositions that carry a decision (`VIVANT`, `INCONNU`) and hides
`MORT`; `--all` prints every record, unchanged. Measured on the same store afterwards: 137 lines /
20.7 KB by default, 267 / 53 KB under `--all`, and the same summary block in both.

Two properties make the omission safe, and they are the reusable part:

1. **Only the disposition that carries no repair is hidden.** Every route the verb prints hangs off
   a live pane (the F-048 release), a live unsettled terminal (`worker-show`), or a record that
   established no pane at all (`tail`, `transcript`) — and that last one is `INCONNU`, which stays.
   A `MORT` row is a recorded handle the runtime cannot see, and it names nothing to type. Checked
   on the real store: no `MORT` row is followed by a `→` line.
2. **Every row is still joined.** The cap count, the F-048 drift and the `worker-list` comparison
   are computed over the whole store before the split, so the flag changes what is SHOWN and never
   what was established. Two views that disagreed about the machine would be worse than a long one.

And the omission is disclosed with the flag that reverses it — `131 MORT record(s) not shown —
… ax worker ls --all` — because a silently shortened list is the same defect as a count that cannot
be established (F-028): the reader cannot tell absence from ignorance.

## The rule for this bug

**A receipt read by an agent is sized by what its reader decides with, not by what the store holds.**
When the reader is named (a role file, a playbook step), the default view is the subset that
answers that reader's question; everything else is reachable behind a flag, and the omission is
printed with the flag. The test for "may this row be hidden" is not "is it old" but **does it name
a repair** — a row that routes the reader somewhere is never archaeology.

The cost of getting this wrong scales with the loop, not with the store: an output an agent reads
once per turn is multiplied by every turn, which is why 40 KB of true, correct, well-formed lines
was a defect.
