---
title: An inability wider than the rule it defends
date: 2026-09-06
category: bugs
module: src/worker/gate.mjs, src/worker/record.mjs
problem_type: bug
component: liveness
severity: high
symptoms:
  - "`ax worker gate` answered `CANNOT ESTABLISH` (exit 3) on every request examined on the host"
  - "The refusal named one foreign record — `phase2-fork-pipeline-20260825.json` — whatever task was gated"
  - "The printed repair was `ls -ld <store>` while the store was perfectly readable"
root_cause: a_raise_read_as_an_inability_before_the_record_own_verdict
resolution_type: code
related_components:
  - orchestration
  - recovery
tags:
  - f-001
  - f-028
  - fail-closed
  - dispatch-store
  - read-only-repair
---
# An inability wider than the rule it defends

## Problem

Two of 288 records in the host-global dispatch store carried no task id. `ax
worker gate` refused every recovery on the machine over one of them, exit 3,
and the repair it printed addressed the readability of a store that read fine.
Recovery was unavailable for every request in a live wave, behind a command
that could not act on the named cause.

## Root cause

The unconcluded-mutation scan asked `taskIdScan` for the task each record
names and turned any raise into the gate's inability. Two situations reach that
raise and only one is a doubt: a mutation that may have committed without its
id ever being learned, and a record that made no mutation at all. The two
records answered the second — one closed `task-create` phase, exit 1,
`ok: false`, `consumer_fenced`, no result — so their own recorded verdict was
`failed`, an established rejection, not the `unknown` the branch exists to
catch. The raise also fired before the `named !== task` filter, which is why
one record refused every task rather than its own.

The gate's own header stated the narrower rule: a task that "cannot be
established from a **torn file**". These files were not torn. The branch was
broader than the rule it defended, and the repository already owned the proof
it was missing — `staleClaim`'s emptiness terms, which had been written for a
different question and were never available on their own.

## Rule

An inability covers what cannot be ESTABLISHED, and nothing wider. "This record
could not have created a task" is an established fact — but only when the
emptiness is ASSERTED rather than inferred from a silent receipt. The first cut
of this fix read `(result.effects ?? []).length > 0`, which turns an ABSENT
container into an empty list: F-028 in the one place whose consequence is a
re-dispatch, since a failed receipt can still describe a partial mutation
(P1 on PR #209). Two positive grounds, per phase, and nothing else:

- the receipt NAMES both `effects` and `residualResources` and both are empty
  arrays — the mutator itself reporting it created nothing; or
- the refusal is one Orca's own source proves is raised before that phase's
  first write. `PRE_WRITE_REFUSALS` in `record.mjs` holds exactly one row,
  `task-create` / `consumer_fenced`, read from the fork checkout: the
  `taskCreate` handler resolves the Run scope before `db.createTask`, and the
  fence throws in between. Keyed by PHASE, never by code alone — Orca raises
  `consumer_fenced` from the mailbox delivery paths and the decision-gate store
  too, and those are not pre-write. A new row means reading that handler to its
  first write in the same commit.

Null, a scalar or an absent container is UNKNOWN under both. Observed resources
refuse first, so the table can never overrule a receipt that names one.

The proposition lives in `record.mjs` as `heldNoMutation`, layered over the
`noMutation` terms `staleClaim` shares: relatedness is STRICTLY STRONGER than
reclaimability, and the asymmetry is deliberate and pinned by a test. The same
silent receipt is still reclaimable — that reader was ratified at the weaker
strength on 2026-08-14 — while it is not proof of unrelatedness, because the
consequences differ. Foreignness of the recorded Run stays out of it entirely:
that term guards takeover, not relatedness. Whether reclaim deserves the same
tightening is unsettled, and tightening it silently to solve a gate problem
would be the trade this entry exists to refuse.

Everything not positively proven empty still refuses at exit 3, and a refusal
caused by ONE record is repaired at that record with READS: its own path, plus
`ax worker ls --all`, plus the reconciliation condition said out loud — recover
the original recorded receipt or identity first, never edit, backfill or remove
the record. A store-level inability keeps its store-level repair. No mutating
or attestation surface over the identity store was added: an operator
attestation is a permission granted by an absence of observation, which is
F-001's own shape.
