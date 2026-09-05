---
title: A vocabulary re-listed per consumer drifts one class at a time, and the gate reading the short list fails open
date: 2026-09-05
category: bugs
module: src/triage/provenance.mjs
problem_type: bug
component: triage-provenance
severity: high
symptoms:
  - "`ax triage publish` composed `[...(provenance.spec ?? []), ...(provenance.inbound ?? [])]` while `provenanceVerdict` and `ax frontier` both read three classes"
  - "A draft naming `source:user-report` over an issue born `source:agent-found` (a declared finding) published: one `gh issue edit`, one comment, and two provenance labels left on the tracker"
  - "`ax frontier` then excluded that same ticket `provenance-refused`, and `ax triage dispatch` refused every pass over it — the publication landed work into a shape the rest of the flow will not touch"
  - "A draft adding TWO classes to an issue carrying none passed: the gate compared adds against a birth label, and there was none"
  - "A contradiction already on the tracker published as valid whenever the draft named no source label"
root_cause: shared_vocabulary_reimplemented_per_caller
resolution_type: code_fix
related_components:
  - src/triage/publish.mjs
  - src/triage/dispatch.mjs
  - src/frontier.mjs
  - tests/triage-publish.test.mjs
tags:
  - provenance
  - label-vocabulary
  - fail-open
  - proposed-result
  - one-rule-three-consumers
---
# One vocabulary copied per consumer drifts per class

## Problem

`triage.provenance` declares which labels mean a ticket was born from a spec, arrived from outside,
or was filed by this project's own agents with its measurement attached. Three verbs judge that
declaration, and each one listed the classes itself: `provenanceVerdict` (`src/triage/dispatch.mjs`)
read `spec`, `inbound` and `findings`; `ax frontier` read the same three; `ax triage publish` read
two.

The third class was added to two consumers out of three. Nothing failed loudly, because the short
list does not error — it grades less. An issue born with a declared finding label matched nothing in
publish's vocabulary, so `bornWith` came back empty, so the add-side gate switched itself off for
exactly the issues the group's doctrine most protects, and a draft naming a second `source:` label
published over it. The result is the state `ax frontier` excludes as `provenance-refused` and
`ax triage dispatch` refuses every pass over: the publication succeeds and strands the ticket.

Two further contradictions were invisible for a different reason — not a missing class, but a
comparison of the wrong two things. The gate asked "does this ADD name a class the issue was BORN
with", which has no answer when the issue carries no provenance (a draft naming two classes at once
passed) and asks nothing at all when the draft names none (a contradiction already on the tracker
published as though it were valid).

## Fix

The classes moved to one rule, `src/triage/provenance.mjs`: `PROVENANCE_CLASSES` (config key plus
the words a refusal uses), `PROVENANCE_KEYS` for a config-shape check, `declaredProvenance` for
"is this name provenance at all", `carriedClasses` for "which classes does this label set carry",
and the `sameLabel` / `declaredCarried` normalization all three verbs already shared in spirit and
kept in duplicate. Each verb keeps its own DECISION over that vocabulary — publish grades a draft,
dispatch refuses a lane, frontier excludes a candidate — and none keeps a private list of which
classes exist. The module is pure and imports nothing, so a read-only verb does not pay for the
dispatch verb's Orca and worker chain to consult it.

`publish` then grades the FULL PROPOSED RESULT — carried, minus the removes, plus the adds —
alongside the birth rule it already had. The birth rule still refuses a redundant re-add first,
because its message names the label the issue was born with; the result check catches the two shapes
that comparison cannot see. Neither reclassifies: the repair is to delete the offending name from
the draft, or to correct the established labels when the tracker is what contradicts itself. A draft
whose `Remove labels:` line resolves the contradiction publishes, because the proposed result is
then consistent.

## The general shape

A vocabulary declared in configuration and re-listed in each consumer drifts one entry at a time,
and the drift is silent in the direction that matters: the consumer with the short list does not
refuse an unknown class, it stops grading. Absences pass tests. Extending such a vocabulary is
therefore never "add it where it is needed" — it is one rule and N decisions over it, or it is N
lists and a fail-open gate waiting for the next class.

The second half is about what a gate compares. Checking a proposed change against one side of the
current state answers a narrower question than checking the state the mutation would leave. Where
the invariant is about the RESULT ("one ticket carries one origin"), the check has to be computed on
the result, or every path that reaches the same forbidden state without touching the compared side
walks through.
