---
title: A scope predicate that tests a PATH for a fact about a REPOSITORY
date: 2026-09-03
category: bugs
module: src/worker
problem_type: bug
component: worker-release
severity: high
symptoms:
  - "`ax worker release --close` answered `0 closeable · 0 kept` over 92 tallied rows while a merged, settled, live-paned child of this very repository sat in none of its five buckets"
  - "The `--dispatch <id>` route printed the same fact honestly (`outside <checkout> — this run can only prove landing in flosrn/ax`), so one predicate had two honesties"
  - "Every ax-dispatched pane held its cap slot forever, and the cap the orchestrator reads from live panes drifted up with each merged ticket"
root_cause: predicate_proxies_a_path_for_the_property_it_means
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - f-001
  - silent-continue
  - agent-facing-output
  - disclosed-omission
---
# A scope predicate that tests a path for a repository fact

## Problem

Landing proof is a question asked of ONE repository (`gh repo view` in the working directory), so
`ax worker release` may only judge a row belonging to that repository. The predicate that expressed
this was path containment against the checkout's toplevel — and ax places every child under Orca's
workspace root (`~/orca/workspaces/<slug>`), **outside the checkout by construction**.

So no ax-dispatched pane was ever a candidate of the sweep. Measured 2026-09-02 on the first pane
this repository had to release (PR #79 merged, worker `succeeded/reclaimable`, pane alive): 92 rows
tallied, the live merged one absent from all five `not offered` buckets, because the row was
`continue`d before any tally increment and before any printed KEEP.

Same host, same inventory, 2026-09-03 — the pre-fix binary against the repaired one:

|                     | path scope | repository scope |
|---------------------|-----------:|-----------------:|
| rows accounted for  |         91 |              367 |
| printed with a repair |        1 |               10 |
| declined, named     |          0 | 9 another repository · 346 no repository on record |
| dropped in silence  |        357 |                0 |

## Fix

Two properties, and the second is the one that generalises.

**The predicate names the property it means.** A row is placed by the repository its dispatch
record NAMES (`repo`, written from `--tracker-repo`), compared with the slug the verb already
computes — never by where its worktree sits. Orca placement is a linked git worktree of the same
repository, so the `git -C <worktree>` proof calls are correct over it wherever it was placed.
`git worktree list` cannot be that predicate either: the case this verb exists for is the
post-merge row whose worktree is already GONE.

**Proof strength decides where a decline lands.** A row PROVEN foreign leaves before any
pane-state tally: this run says nothing about another repository's pane, not even that it is
already released. A record naming NO repository is not proven foreign (F-028), so the causes
establishable without any repository — released, gone, no pane recorded — are still counted under
their own cause, and only the JUDGEMENT is declined. Reading absence as foreignness would have
folded 346 of this machine's rows into one residual and destroyed the three causes the receipt
exists to separate; reading it as ownership would let any checkout close every legacy pane on a
host-global store.

Nothing is declined silently: both placement declines are counted in a named bucket, printed with
`cd <worktree> && ax worker release --close --dispatch <id>` when the caller named the row, and the
unknown population is disclosed as a share OF the cause buckets rather than a bucket beside them.

## Reusable rule

A scope predicate that tests a **proxy** for the property it means is a bug waiting for the day the
proxy diverges — and it fails SILENTLY, because a row that never reaches a tally is reported as a
clean sweep. Two symptoms name it before it costs anything:

1. Two routes through one verb are honest about the same fact in two different ways.
2. A count that should be exhaustive does not add up to the rows considered.

The second is a cheap invariant to hold on any classifier: every row printed with a repair, or
counted in exactly one bucket, and the buckets summing to what was read.
