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
  - "167 of 195 rows answered neither question that reader has: 133 recorded panes the runtime cannot see, 34 unsettled attempts whose recorded pane is a corpse on a host the receipt read"
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

The default view carries the rows that answer one of those two questions, and nothing else:

|Row|Answers|
|---|---|
|`VIVANT`|capacity in use, and the pane to arbitrate overlap against|
|`INCONNU`, host not asked|may be alive and working on a host this terminal list never read|
|`INCONNU`, recorded pane alive|an unsettled worker-start whose terminal is up right now|
|`INCONNU`, no pane named|a write-ahead record; nothing proves it dead either|

Two classes answer neither and leave, each disclosed as its own count: a `MORT` row (a recorded
handle the runtime cannot see) and a **dead attempt** — unsettled, its recorded pane a corpse on a
host the receipt DID read. `--all` prints every record, unchanged.

Measured on the same store: **263 lines / ≈40 KB → 35 lines / 6.1 KB** (28 of 195 records shown:
4 live, 24 unknown), against 268 lines / 53 KB under `--all`.

Three properties make the omission safe, and they are the reusable part:

1. **A withheld row answers neither question the reader came with.** Not "is it old" — a `MORT`
   row additionally names no repair at all (checked on the real store: no `MORT` row is followed by
   a `→` line), and a dead attempt's two settlement routes (`tail`, `transcript`) ride with it into
   `--all` rather than being dropped.
2. **The listing never relabels a disposition.** A dead attempt stays `INCONNU` — nothing about
   that record was ever established, and `paneVerdict` is shared with `gate`, `repair` and
   `release`. Only the listing changes; a view that renamed a verdict to justify hiding it would
   corrupt four other verbs.
3. **Every row is still joined**, before the split. The cap count, the F-048 drift and the
   `worker-list` comparison are computed over the whole store, so the flag changes what is SHOWN
   and never what was established. Two views that disagreed about the machine would be worse than
   one long view.

Each withheld class is disclosed with the flag that reverses it (`133 MORT record(s) not shown …`,
`34 unsettled record(s) whose pane is MORT — ax worker ls --all`), because a silently shortened
list is the same defect as a count that cannot be established (F-028): the reader cannot tell
absence from ignorance. The dead-attempt line is also the only surface that counts a settlement
debt, which is why it is a count and not silence.

## The rule for this bug

**A receipt read by an agent is sized by what its reader decides with, not by what the store holds.**
When the reader is named (a role file, a playbook step), the default view is the subset that answers
that reader's question; everything else is reachable behind a flag, and every withheld class is
printed as a count beside that flag.

The two tests a row must fail before it may be withheld: **does it answer the reader's question**,
and **does it name a repair**. A row that routes the reader somewhere is never archaeology — and
hiding it is a listing decision, never a licence to restate its verdict.

The cost of getting this wrong scales with the loop, not with the store: an output an agent reads
once per turn is multiplied by every turn, which is why 40 KB of true, correct, well-formed lines
was a defect.
