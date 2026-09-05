---
title: Unknown liveness is not permission to re-dispatch
date: 2026-09-06
category: bugs
module: src/worker/gate.mjs, src/worker/continuation.mjs, src/worker/pane.mjs, src/worker/ls.mjs
problem_type: regression
component: liveness
severity: high
symptoms:
  - "`ax worker gate` printed `Safe to re-dispatch` (exit 0) when the pane was INCONNU"
  - "A fresh Orchestrator reading Get bearings dispatched a second worker because no live pane was observed"
  - "A remote record's continuation was silent, so a same-named local worktree looked like the only evidence"
root_cause: unproven_pane_mapped_to_safe_redispatch
resolution_type: code
related_components:
  - orchestration
  - measurement
tags:
  - f-001
  - f-003
  - f-028
  - pane-verdict
  - omitted-hosts
  - fail-closed
---
# Unknown liveness is not permission to re-dispatch

## Problem

`ax worker gate` asked whether a re-dispatch was safe and answered 0 whenever
no live pane was observed. `INCONNU` — a handle missing from a list that omits
hosts, a dispatch this store cannot attribute, a mutation whose call never
concluded — was mapped to "down, disclosed". The disclosure sat under
`Safe to re-dispatch`, and the authorization is the only thing a caller
consumes. Get bearings told a fresh session to dispatch wherever the gate
proved no live child exists.

## Root cause

`worker-list` rows carry no per-dispatch host, so the gate judged every pane
with `paneVerdict(..., {})`. An absent `host` is the conservative branch
(`INCONNU` when anything is omitted). The listing already asked each record's
own host through `hostReader`. Two readers of one question, and the one that
authorises a mutation used the weaker evidence.

A recorded `worker-start` that never concluded is the other half: Orca may hold
a Dispatch whose id this host never learned, so `worker-list` is empty while a
child comes up. "First launch, safe to start" there is F-001 by the front door.

## Rule

An unproven pane is exit 3, never 0. Proven death (a covering inventory that
does not carry the handle) is still 0, and the receipt names the continuation
`continuationFor` already decided: OPEN → `--replace`, MERGED → `release`,
none or closed-unmerged → `settle`, unreadable evidence → none of them. An
unknown mutation is `--resume` of the recorded request, never a fresh identity.
A remote branch is asked of the host the record named, through the federation
read `placeRemote` already makes; a same-named local directory is not evidence.

`hostReader` and `declarationOf` are the shared readers. A second copy in a
verb that authorises a mutation is how this regression returns.
