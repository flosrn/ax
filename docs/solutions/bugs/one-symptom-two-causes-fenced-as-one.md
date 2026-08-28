---
title: A symptom shared by two causes needs a discriminator before a fix, or the fix covers the wrong half — and can become the cause
date: 2026-08-28
category: bugs
module: omp/peer
problem_type: bug
component: diagnosis
severity: high
symptoms:
  - "`Peer messaging has been unable to receive for 5 minutes` in a session that had just spawned a subagent, while every other session on the machine was receiving normally"
  - "The same banner, byte-identical, in eleven sessions at once — ax, ofmchat, net-edge and .omp — losing the connection in the same millisecond"
  - "An unsolicited model turn (`What do you need me to work on?`) in a pane the operator had only just opened"
  - "0.14.1's fix for the first cause introduced a second deaf-channel path that was indistinguishable from the bug it repaired"
root_cause: two_causes_behind_one_condition
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - discriminator
  - waiter-exists
  - runtime-unavailable
  - review-widening
  - overcorrection
  - peer-channel
  - false-diagnosis
---
# One symptom, two causes, fenced as one

Two instances in one day, at opposite ends of the same bug. Both cost a wrong diagnosis, and
the second cost a released regression.

## Instance one: the five-minute banner

`health.ts` announces an outage after 300s of consecutive `check --wait` failures. The banner names
no cause, because at that layer there is none to name — the loop only knows it failed. Two very
different failures reach it:

| Log line | Cause | Repair |
|---|---|---|
| `err=waiter_exists` | A **second** consumer on one Run. Orca allows one actionable waiter; the loser retries forever | ax |
| `err=runtime_unavailable`, `Could not read Orca runtime metadata` | The Orca **desktop** runtime is gone | restart Orca |

The second is real and was measured: at 17:40:14 eleven receivers lost the connection in the same
millisecond and `orca-runtime.json` disappeared, while the daemon kept serving terminals — the
operator was reading a live pane on his phone throughout. `orchestration check` talks to the desktop
app's RPC runtime, not the daemon, so **a session can be perfectly alive with a genuinely dead peer
channel**, and no ax version repairs it.

Without that split, the banner reads as one fact and invites one fix. The discriminator was already
on disk in `~/.omp/run/orca-peers/<term>.log`; nothing surfaced it, so it had to be re-derived from
eleven log files. **Grep the error code, never the banner.**

## Instance two: the refusal that meant two things

The real ax half was a nested task inheriting its parent's pane, escaping the subagent classifier,
reaching `publishSelf`, being refused — and starting the receiver anyway. `waiter_exists` forever.

The fix fenced on `!published.published`. That condition also carries two meanings:

```js
if (!registration.published) { onUnavailable(); return false; }   // 0.14.1 — wrong
```

- `foreign` — a live session owns the handle's entry, or its registration lock is held. Consuming
  that Run races the owner. **This is the fence.**
- `invalid` — `register` took the lock, found no live owner, and **failed to write**. Nobody else
  owns the Run, and the loop consumes the Run from `ensureRun`, never from the registry.

So the fix made a registry **write** failure refuse to receive: an *addressing* failure converted
into a deaf channel — the exact bug being repaired, self-inflicted, and indistinguishable from it.
A second defect rode along: `loadInjected()` was gated on `published.published`, so that path would
have started a loop with no durable replay window and injected a replayed delivery twice.

```js
if (!registration.published && registration.refused === 'foreign') { … }   // 0.14.2
```

## How the widening happened, which is the part worth keeping

A cross-model reviewer filed a **correct, narrow** P1: *`foreign` does not prove another receiver is
healthy — the lock may merely be held.* True, and it earned a fix.

An autonomous fixer applied it to **every** refusal. The review's claim was about one branch; the
patch changed the condition above both. Nothing in the loop caught it: the suite went green, because
the test covering that branch was renamed to assert the new behaviour — `an invalid registry
publication visibly disables instead of receiving deaf` **encoded the defect in its own name**.

That is the mechanism to watch. A finding scoped to one arm of a condition, applied to the condition,
silently widens blast radius — and if the test is updated alongside, the widening ships green.

## The rule

**Before fixing a symptom, name every cause that produces it; before widening a condition, name
every state it already covers.** A condition is a discriminator only if each branch means one thing.
`!published` looked like "the registry said no" and actually meant *either* "someone else owns this"
*or* "the disk failed" — opposite repairs behind one boolean.

Three habits:

- **A shared symptom gets a discriminator, and the discriminator gets documented where the symptom
  appears.** Both causes here were already distinguishable on disk; only the derivation was missing.
- **When a review finding names one branch, patch that branch.** Ask what else the condition covers
  before generalising — the reviewer measured one arm, not the predicate.
- **A test whose name asserts the behaviour under review is evidence, not cover.** If the natural fix
  requires renaming a test to match, confront which of the two is wrong first: here the test was, and
  it was corrected rather than supplemented.

Fail-closed stays fail-closed where ambiguity is real: a **throw** from `publishSelf` still refuses,
deliberately. `invalid` proves there is no live owner; a throw proves nothing, and silently eating
another session's deliveries is worse than being loudly deaf. **The asymmetry is the point — pick the
loud failure only when the quiet one costs more.**
