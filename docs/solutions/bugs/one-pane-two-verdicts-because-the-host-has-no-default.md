---
title: One pane, two verdicts — a corpse to `ls` and an unknown to `gate`, because `paneVerdict`'s host has no default
date: 2026-09-03
category: bugs
module: src/worker/pane.mjs, src/worker/ls.mjs, src/worker/gate.mjs, src/worker/settle.mjs
problem_type: gotcha
component: liveness
severity: medium
symptoms:
  - "`ax worker ls --all` renders a record as `pane MORT · term_… is unknown to the local runtime, which this list did read`"
  - "`ax worker gate <same request>` answers 0 — no live agent — while `ax worker settle <same request>` answers 3, cannot establish, for that same handle"
  - "A verb reading `worker-list` rows appears stricter than the listing for no reason a reader can see"
root_cause: caller_cannot_supply_the_hosts_own_placement
resolution_type: documentation
related_components:
  - orchestration
  - measurement
tags:
  - f-003
  - f-028
  - pane-verdict
  - omitted-hosts
  - fail-closed
---
# One pane, two verdicts, and both are right

## Problem

The same recorded handle answers differently depending on which verb asks:

```
$ ax worker ls --all | grep 100-scripts-typecheck
  · 100-scripts-typecheck · task_b05e7ced1a5a · pane MORT · term_20a9c2b7-… is unknown to
    the local runtime, which this list did read (only remote hosts were omitted)

$ ax worker settle 100-scripts-typecheck        # a copy of the record, repo injected
  ✗ CANNOT ESTABLISH — 1 pane(s) cannot be established, and this terminal list omits
    runtime:7930a317-… — term_20a9c2b7-… is not in this host's terminal list      # exit 3
```

Read as a disagreement, this looks like one of the two verbs having a stale copy of the
liveness rule — the exact drift `src/worker/pane.mjs` was extracted to end.

## Root cause

There is one rule and one implementation. What differs is the fourth argument:
`paneVerdict(handle, why, terminals, { host, asked })`, whose `host` has **no default**
on purpose. `''` is a caller ASSERTING "this record was dispatched locally", and an
absent `host` is a caller that has not established the owner. When hosts are omitted
from the terminal-list scope, an absent handle is `MORT` only for a caller that can
make that assertion.

`ax worker ls` reads the **record's own dispatch phase**, so it knows the placement
(`--on` or nothing) and passes it. `ax worker gate` — and therefore `ax worker settle`,
which stands on the gate's evidence — reads **Orca's `worker-list` rows**, and those
rows carry no per-dispatch host. Nothing there can supply `host`, so the verdict keeps
its conservative branch: `INCONNU`.

## Consequence to expect, not to fix

**Superseded in part by #192.** `ax worker gate` no longer discloses an INCONNU
pane and answers 0. Unknown liveness is cannot-establish (exit 3), never
permission to re-dispatch — see
[unknown-liveness-is-not-permission-to-redispatch.md](./unknown-liveness-is-not-permission-to-redispatch.md).
`paneVerdict` still has no `host` default; the gate now supplies placement from
the dispatch record through the same `hostReader` `ls` uses. What remains true
below is settle's refusal to WRITE a death it cannot prove.

On a Mac whose `terminal list` omits one stale paired runtime (measured 2026-08-22 and
still true 2026-09-03), every locally-dispatched corpse is `MORT` to the listing.
A row `worker-list` cannot attribute stays INCONNU, and both verbs refuse:

- `gate` asks *may I re-dispatch?* — unknown is exit 3, never `Safe to re-dispatch`.
- `settle` asks *may I write death?* — unknown must fail closed toward **not writing**,
  so it answers 3 with the read that would settle the question.

So `ax worker settle` pays no existing debt on such a host, and that is the fail-closed
answer rather than a defect: the repair is the omitted runtime leaving the scope (or the
pane being read from the host it was dispatched to), never a `host` default nobody chose.

## Rule

Before comparing two verbs' liveness answers, compare what each one could pass as
`host`. `paneVerdict` still has no default: `''` is an assertion, an absent `host`
is conservative INCONNU. #192 taught the gate to take placement from the dispatch
*record* through `hostReader`, not from a default and not from `worker-list`.
Defaulting `host` to `''` without that record is still the guess that authorises
a mutation.
