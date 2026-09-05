---
title: A finding whose repair an approved Spec needed had no lane, because every finding was refused
date: 2026-09-06
category: process
module: src/triage/necessity.mjs, src/triage/dispatch.mjs
problem_type: process
component: triage-admission
severity: medium
symptoms:
  - "A finding that named an approved Spec obligation still refused the triage and brief lanes"
  - "The maintainer channel answers instrument frictions; to-tickets needs a human to amend a spec — necessary mid-wave work waited on a person who was not in the room"
  - "An unreadable issue body would have been treated as 'no justification' if the gate judged labels alone"
root_cause: blanket_refuse_had_no_admission
resolution_type: code_fix
related_components:
  - triage-lane
  - provenance
  - frontier
tags:
  - necessity-justification
  - finder-is-the-verifier
  - f-028
  - admission-is-not-readiness
---
# A finding without a named obligation had no lane

## Problem

`provenanceVerdict` refused every finding in the triage and brief lanes. That
was the right default — a finding arrives with its measurement, so a pass
re-measures what is measured — and it had its own cost: a finding whose repair
an approved Spec cannot be satisfied without had nowhere to go.

## Fix

One line, defined in `src/triage/necessity.mjs` and graded by
`src/triage/dispatch.mjs`: `Necessary for: #<spec> — <obligation>`. The tool
grades the shape (an identified spec, a written obligation, read from the
issue itself) and never the merit. An unanswered body or comment is unknown,
not absent (F-028). Admission to a pass is not authorization to implement:
`ax frontier` remains that authority. A project that declares no `findings`
class is untouched.

## The rules this paid for

**THE TOOL GRADES THE SHAPE.** Whether the work is genuinely necessary is the
pass's analysis. A number without an obligation is not a justification, and an
agent recommending the work is not necessity.

**ADMISSION IS NOT READINESS.** A Pass decides nothing about implementation.
The frontier still reads the ready label.
