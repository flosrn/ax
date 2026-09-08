---
title: A Run with no pane is a queue, not a dead letter
date: 2026-09-08
category: bugs
module: omp/peer/lineage.ts, omp/peer/report.ts, omp/peer/send.ts, omp/report/index.ts
problem_type: false_negative
component: delivery
severity: high
symptoms:
  - "`[REPORT NOT DELIVERED] … the dispatching session is gone, so its worktree cannot receive this report`"
  - "A finished worker announced its completion undeliverable while Orca delivered it 14 minutes later"
  - "A dispatch-bound sibling send failed with `no live parent to relay through`"
root_cause: pane_liveness_used_as_delivery_precondition
resolution_type: code
related_components:
  - orchestration
  - lineage
tags:
  - f-028
  - fail-closed
  - pane-churn
  - durable-queue
---
# A Run with no pane is a queue, not a dead letter

## Problem

A child that finished inside a window where the dispatcher's pane did not exist
was told its completion could not be delivered, and told to re-route work that
Orca had already accepted. Measured 2026-09-08 on goodluckagency/ofmchat #222:
the child's `worker_done` (`msg_a5230f12b27a`) was created 14:13:32Z, the
`[REPORT NOT DELIVERED]` block printed at 14:14Z, and `orchestration.db` records
`delivered_at` 14:27:54Z for that same message.

## Root cause

Two facts that had never been separated.

Orca has one known reversible path that produces this lifecycle: its manual
**Close terminals** action stops the worktree's ptys with their identifiers
preserved, and revealing a pane later consumes the armed wake in
`pty-exit-hibernate.ts` and cold-restores the agent into the same slot. No
automatic visibility, idle, LRU or memory-pressure reaper calls this path, and
Orca exposes no CLI wake or protection flag.

The incident trace does not establish which caller stopped this particular pty;
it establishes a no-consumer interval. `daemon.log` records `session-killed`
(`immediate: true`) on the ofmchat primary at 14:06:09Z and `session-created`
for the same `@@9320cb55` slot at 14:27:50Z. The Run persisted across the gap
(`run_09c2450956f2`, published by three successive terminal handles). While the
pty is dead and the worktree runs other panes, the slot is dropped from
`orca terminal list` (`runtime-terminal-list.ts`: a leaf with no `ptyId` is
skipped when its worktree has live ones), so ax's registry join saw nothing.

And ax required a pane. `parentPeer()` returned a live `Peer` or a refusal, so
the recorded dispatcher Run — written ahead of the dispatch, the one address
that survives the pane — could only be used to pick between panes that were
already up. Orca needs no pane for it: a `run:` target skips recipient
resolution entirely (`orchestration-send-methods.ts:106`), `insertMessage` gates
on the run's existence alone, no TTL or sweep deletes a pending row, and a pane
that later binds the run consumes everything queued before it existed.

## Rule

Delivery is addressed to a Run; a pane only decides WHEN it is read. So
`parentPeer()` has three outcomes, not two: `peer` (a pane is reading that Run
now), `queued` (the recorded Run, nobody reading it yet), `reason` (no Run could
be established — the only state with no address in it, and no pane that merely
happens to be there may stand in for one).

A queue is not an arrival, and the difference is said out loud: `report()`
returns `queued` with the Run named, the extension announces
`[REPORT QUEUED, NOT YET READ]` instead of the refusal, and the board card
carries `report queued, unread · <run>` for whoever comes back. A Run whose
session never returns keeps its message forever — one such `worker_done` from
2026-09-04 is still `read = 0` — so the card is the escalation that outlives the
child, and the announcement must never read as a handover.
