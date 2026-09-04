---
title: An envelope the runtime accepts can still be dropped by its own reader — a detached process sends under the handle of the pane that spawned it
date: 2026-09-04
category: bugs
module: omp/peer
problem_type: bug
component: delivery
severity: high
symptoms:
  - "Every stall alert refused `sender_not_assignee` — \"No active Dispatch belongs to this message sender\" — from a watcher armed by a top-level orchestrator"
  - "The alert's words reached the orchestrator's pane anyway, as the rejection's own `status` carrying the body under `_orcaLifecycleRejection`"
  - "Switching to the accepted envelope injected NOTHING: `dropped a message this session sent itself` on the receiver log, 0 messages injected"
root_cause: sender_identity_inherited_from_the_spawning_pane
resolution_type: code_fix
related_components:
  - orchestration
  - stall-watcher
tags:
  - envelope
  - sender-identity
  - self-send-fence
  - detached-process
  - accepted-but-undelivered
---
# Accepted is not delivered

Two facts about one message, each true, and together a silence.

**Fact one — the envelope.** `orca orchestration send --type escalation` is a coordinator
mutation: Orca gates the lifecycle codes (`sender_not_assignee`, `task_dispatch_mismatch`,
`dispatch_capability_invalid`) on `worker_done | heartbeat | escalation | decision_gate`, and
nothing else. The stall watcher ax arms at dispatch inherits the environment of the pane that
dispatched. A top-level orchestrator's pane holds no Dispatch by construction, so every alert
was refused (#109). `status` is exempt from that gate — so it is accepted.

**Fact two — the sender.** `--from` self-resolves. Orca's handler reads `ORCA_TERMINAL_HANDLE`
from the environment, and `src/worker/start.mjs` spawns the watcher `detached` with
`{ ...env }`. So the watcher's send is attributed to **the orchestrator's own pane**, and the
receiver in that session (`omp/peer/receive.ts`) drops any message whose `from_handle` equals
its own handle — a fence built for a measured echo, a child re-reading its own report off the
relay (2026-08-15).

Fixing fact one alone makes the delivery worse than the bug. The refused `escalation` at least
woke the pane, because Orca posts the REJECTION itself, from the runtime rather than from that
handle. An accepted `status` has no rejection to ride, so the self-send fence became the whole
outcome: zero injected, no log line about a worker that had stopped.

## The discriminator

The fence's question is "did this session say these words?" — and it was answered with "does
this handle belong to this session?", which is a different proposition for any process that
inherited the environment. A detached watcher writes about a CHILD under the parent's handle.

The exemption is keyed on the two subjects the watcher owns, `stall-watch:` and `card:`
(`WATCHER_ALERT` in `omp/peer/receive.ts`), and nothing wider: an echo of the session's own
report still dies at the fence.

## The rule

**A delivery is proven by what the reader injected, never by what the runtime accepted.** An
envelope change has two ends, and the receiving end is a separate measurement: read back the
receiver's own log line or its injected message, not the send receipt's `ok: true`.

Corollary for any handle comparison: **a handle identifies a pane, not an author.** Every
process that inherits a pane's environment — a detached watcher, a spawned tool, a hook — sends
as that pane. Fencing on identity therefore fences those out too, and the ones worth hearing
have to be named.
