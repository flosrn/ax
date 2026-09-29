---
title: A relay is answered at its subject, not its sender — the stall watcher's card told the orchestrator not to reply to a live child asking for a decision
date: 2026-09-29
category: bugs
module: omp/peer
problem_type: bug
component: delivery
severity: medium
symptoms:
  - "A remote worker's `DECISION:` checkpoint, relayed by the stall watcher, arrived as `From peer session \"watcher:2122-work\"`"
  - "Its banner blamed a Dispatch that settled `failed` or a pane with no Run; the Dispatch was live and the pane was the orchestrator's own"
  - "Three lines said not to use `peer_reply`, above the three decisions the worker was waiting on"
root_cause: route_keyed_on_the_relay_instead_of_the_subject
resolution_type: code_fix
related_components:
  - stall-watcher
  - orchestration
tags:
  - reply-route
  - watcher
  - provenance
  - banner
---
# The watcher is the envelope, the child is the addressee

Gapila #2122, 2026-09-29. The worker `2122-work` on `netcup-vie` published a checkpoint that
asked the orchestrator to rule on three points. The stall watcher relayed it, as it does every
cross-host card. The receiver had one rule for anything the watcher sent: never answerable.
The rule had a correct motive. The watcher exits once it has sent, and its alert carries the
orchestrator's own handle, so a pane-fallback route would resolve to the orchestrator's own Run.
The reply would then die on the self-echo fence while `peer_reply` reported success.

The motive covered the sender and nothing else. The message was about a child that was alive
and waiting, and the receiver already knew how to reach it: `route.ts` derives a remote child's
Run from this machine's write-ahead dispatch record, joined against `worker-show` and
`run-list --environment`. That is the same derivation a `child:<slug>` report uses.

Presentation was a second, independent defect. `peerContent` called the watcher a peer session.
`unanswerableBanner` listed its two stock hypotheses, and neither applied here. `peerContent`
then added its own "Do NOT try peer_reply" line under the banner.

## The fix

- `src/worker/stall.mjs` sends every alert through one `wake()` with
  `--payload {"watch":{"alert","request","dispatchId"}}`. The subject stays the readable half.
- `omp/peer/attribution.ts` gives the watcher its own provenance,
  `kind: 'watcher', about: <request>`. The receive loop keys its self-echo exemption on that
  kind instead of re-parsing the subject.
- `replyRouteOf` in `omp/peer/receive.ts` has one branch per provenance. A watcher `card` is
  routed through `deriveRoute(dispatchId)`, a lookup in this session's own store, so a forged
  id can reach at most another of our own children. `silent`, `prompt` and `gone` are never
  routed: a reply to any of them is a dead letter that reports success.
- A refusal returns exactly one `NoRoute` reason. `unanswerableBanner` states that reason and
  nothing else. `peerContent` prints a reply line only when the message can be answered.

## The rule

**Route a relayed message by the party it is about, never by the party that carried it.** The
sender of a relay is usually the one party that cannot be answered. Deriving the addressee
still has to use records this side wrote, never the payload's claim. A payload field may
select which of our records to use; it never supplies the address.
