---
title: A second technical Gate refusal recalled the operator for a retry the worker could still make useful
date: 2026-09-06
category: process
module: omp/roles/orchestrator.md, omp/roles/worker.md
problem_type: process
component: unattended-repair
severity: medium
symptoms:
  - "A second Gate refusal of the same PR after a repair round interrupted the operator automatically"
  - "The interruption fired even when the observed failure still named a useful repair, diagnosis, second opinion, or explicit blocker"
  - "Independent takeable Tickets waited while the operator was recalled for a product decision only one branch needed"
root_cause: second_refusal_was_an_operator_interrupt
resolution_type: docs_fix
related_components:
  - orchestrator-role
  - worker-role
  - pr-gate
tags:
  - delegated-verification
  - bounded-repair
  - oracle-second-judgment
  - product-decision-blocks-dependents
---
# A second technical refusal recalled the operator

## Problem

The Orchestrator role treated a second technical Gate refusal as an automatic
operator interrupt. That bound stopped an unattended loop, and it also recalled
a human for a retry the owning worker could still make useful from the observed
failure. The same posture repeated every worker's review instead of delegating
only a named gap, and it froze independent takeable Tickets while one branch
waited on a product decision.

## Fix

A second technical refusal stays with the agents: one useful continuation
(repair of a different cause, diagnosis, second opinion, or explicit blocker),
then a blocker if it still refuses. Staleness still self-repairs once. A
refusal or uncertain mutation still cannot mint a fresh Dispatch identity by
itself. Verification is delegated only when the integrated result is unproven
or coverage is absent or contradictory; Oracle is a second judgment only when
it can change a decision. A missing product decision blocks dependent work
only.

## The rules this paid for

**THE OPERATOR IS NOT THE AUTOMATIC NEXT HOP.** A second technical refusal is
evidence for a continuation, not a page. The finite bound is "the same attempt
must not repeat", not "page a human".

**VERIFICATION NAMES THE GAP.** Reuse Reports, Gate receipts, review threads
and CI. Do not re-review every Ticket. Do not invent a shipping pipeline or
infer a consumer's deployment from this package's npm release.
