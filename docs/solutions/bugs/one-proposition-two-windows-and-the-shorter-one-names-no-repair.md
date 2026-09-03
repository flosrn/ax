---
title: One proposition, two windows — a healthy child settled CANNOT-ESTABLISH in 30s, with no repair named and no verb to re-derive it
date: 2026-09-03
category: bugs
module: src/triage/dispatch.mjs, src/worker/transcript.mjs
problem_type: gotcha
component: orchestration
severity: medium
symptoms:
  - "`ax triage dispatch` prints `CANNOT ESTABLISH — <request>: no child-side role receipt appeared within 30s` and exits 3 on a child that is working"
  - "Reads a minute later establish everything the proof wanted: the pane is live, the mover is `role=default`, the playbook is applied"
  - "The verdict is permanent — no later verb re-derives it, and the exit-3 branch names no `fix()` at all"
  - "`ax worker transcript --dispatch-proof <needle>` cannot be pointed at one pass of a wave, because every triage child shares the needle"
root_cause: one_proposition_given_two_windows_by_two_callers
resolution_type: code_change
related_components:
  - measurement
  - liveness
tags:
  - f-001
  - f-028
  - adr-0003
  - dispatch-proof
  - point-in-time-verdict
---
# A window is a measurement, and a point-in-time verdict needs a reader

## Problem

`ax triage dispatch --issue 94 --job triage` settled a healthy child as
`CANNOT-ESTABLISH`, exit 3, at 34.5 s wall. Reads taken ~60 s later, without
re-dispatching, found the pane live, the model mover `role=default` and the
triage playbook applied — everything the proof wanted, arriving after the wait
window closed.

Three separate defects met on that one line:

1. **One proposition, two windows.** `verifyPassRole` and `../worker/verify.mjs`
   share the same proof reader and the same `settled()` predicate, and got
   different deadlines from their callers: `ax worker dispatch` defaulted 120 s
   and exposed `--wait`; `ax triage dispatch` took `AX_TRIAGE_ROLE_WAIT ?? 30`
   and exposed no flag. The only knob that would have prevented the exit
   appeared nowhere on the command surface.
2. **The one exit that fires on a healthy child named no repair.** Its sibling
   `CANNOT-ESTABLISH` carried `ax worker ls`; this branch carried a `bad()` and
   a `note()` and nothing actionable — against the rule AGENTS.md enforces.
3. **The verdict was unre-derivable, and the header said otherwise.** The
   success-path comment named `ax triage status` as a later reader that "sees a
   fallback this line could not have seen". `ax triage status` never calls
   `dispatchProof`: it answers from the dispatch record, the draft, the mailbox
   and the pane cursor. The verb that reads the session file is `ax worker
   transcript --dispatch-proof` — and it accepted a needle only, so it could not
   name ONE pass of a wave whose children all run `--worktree current` and
   therefore all share that needle.

## What the window actually is

The number was folklore in both directions, so it got measured: 20 triage
passes from this host's own dispatch store, each paired with the one child
session whose FIRST task spec names its request id, timed from that dispatch's
`worker-start` `beganAt` to the later of its two receipts.

```
min 7.5s · median 44.7s · 13 of 20 over 30s · 6 of 20 over 120s
7.5 18.7 20.1 20.2 22.0 22.2 22.3 35.7 43.9 44.1 44.7 46.8 63.9 73.6
524.0 529.5 534.5 1411.2 1416.9 1423.1
```

30 s failed the **median** pass on this host. It was never a window; it was a
coin toss, and the reported incident is what losing it looks like.

Two traps in taking that measurement. The first turned out to be a defect in
the fix itself, caught in review on PR #124:

- **Content-matching the request id is not ownership, and this one bites the
  product, not just the script.** The reconciliation read is typed BY the
  orchestrator, IN the checkout its children share, and that session's own
  transcript carries the request id twice over: the dispatch output it read,
  and the command it just ran. A whole-file `.includes(request)` therefore
  counts the caller as a candidate beside the child, finds two, and refuses.
  Measured on this host for four real passes: **9, 14, 15 and 16 whole-file
  candidates each, and exactly one owner every time.** The advertised repair
  would have exited 1 on every invocation. Ownership is the FIRST user turn —
  the task spec a dispatch actually writes — and `sessionFileForNeedle` now
  enforces that, keeping the "exactly one, never newest-wins" rule intact.
- **The long tail is not boot latency.** The six passes past 120 s show ~3 s
  from their own session boot to both receipts. What is long is the gap between
  `worker start` returning and the pane booting at all, and no role-wait
  shortens that. Sizing the window to cover it would pay that gap serially, per
  pass, on every wave.

## Resolution

- The window is the worker family's 120 s, layered: `--wait <s>` per
  invocation, then `AX_TRIAGE_ROLE_WAIT` for the machine, then the built-in.
  `--wait` is validated with the worker family's own words (`--wait expects a
  number of seconds`), never silently defaulted.
- The no-receipt branch names both repairs: the request-scoped read that
  re-derives the proof for that exact pass, and the way to widen the window.
- `ax worker transcript --dispatch-proof <needle> --request <id>` scopes the
  proof to one pass, by first-task-spec ownership. Zero or two owners stays an
  inability to establish — exit 1, nothing on stdout, never newest-wins.
- The exit code stays **3** (ADR 0003). A live child whose effects are unproven
  must not be handed the code that reads as safe to retry (F-001).

## The rule

A bounded wait is a measurement, not a taste. Two callers of one proof reader
that disagree about the deadline have not made a trade-off — they have made the
same proposition true in one family and false in the other.

And a point-in-time verdict needs a named later reader that can be pointed at
the exact subject it judged. Reconciliation is a later READ, never a second
writer; a comment naming a verb that cannot perform that read is worse than no
comment, because it sends the next reader to audit the wrong module.
