---
title: A check that reads its own subject out of the thing under check verifies nothing, and reports success while doing it
date: 2026-09-02
category: bugs
module: src/pr-gate.mjs, src/pr-grounds.mjs
problem_type: bug
component: verification
severity: high
symptoms:
  - "`ax pr gate --merge` printed `closure: issue #N reads closed — merged and delivered` for a ticket nobody had dispatched"
  - "The dispatched ticket stayed OPEN with a merged PR behind it, and `ax frontier` kept excluding every dependent as `blocked-by`"
  - "No ground refused and no verdict was unread: the closure verification itself reported the delivery"
root_cause: subject_read_from_subject
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-001
  - f-028
  - proof-vs-absence
  - merge-gate
  - closure-verification
  - false-pass
---
# A check whose subject comes from the subject

## Problem

`ax pr gate` verifies, after merging, that the ticket the PR closes actually closed — the
subgraph-halt property the frontier depends on. It took the ticket number from one place: the first
closing keyword in the PR body (`closedIssueOf`, now `closedIssuesOf`).

The body is written by the worker being checked. A worker dispatched for #10 whose PR says
`Closes #11` passed every ground, and the gate then verified #11 — a real, unrelated, possibly
already-closed ticket — and printed `merged and delivered`. #10 stayed open, every ticket blocked by
#10 kept deriving from a stale blocker, and nothing escalated, because the verification had
succeeded. The closing-keyword ground cannot see it either: `Closes #11` is a keyword GitHub acts
on, which is all that ground asks.

## Why the shape hides

Every ground above it is a predicate over live state with an independently known subject — the head
SHA the gate resolved once, the check-run names the repository declared, the base ancestry git
answers. Closure was the one ground whose subject travelled *inside* the artifact it judged. The
tests could not catch it: a fixture writes one issue number into the body and asserts the poll used
that number, which is exactly the defect stated as an expectation.

## Fix

Bind the subject to an independent record before any ground runs, and refuse the disagreement:

- `--issue <n>` from the caller — the orchestrator naming the ticket it is merging — outranks
  everything else.
- Otherwise the dispatch record of the PR's branch, read with `record.mjs` strictness: the record
  must name its own request, a record naming another repository is another checkout's dispatch, one
  branch claimed by two tickets is ambiguity and never last-file-wins, and an unreadable record is
  named in the answer so "no record" cannot be confused with "a record this run could not parse".
- Neither source is **exit 3** while the body closes an issue here — F-001's rule applied to a read:
  an absent record is unknown, and unknown is never permission.
- Closure then polls the BOUND number. A body edited between validation and merge is named as an
  edit; the ticket the merge was for is what has to read closed.

## The rule for this bug

**A check must take its subject from a source the subject cannot write.** Verifying a proposition
the artifact nominated is not verification — it is the artifact grading itself, and it fails in the
agreeable direction: a pass nobody questions, over a state nobody observed.

The tell is a sentence of the form "verify that the *named* X did Y", where the naming and the
doing come from the same author. Ask where the name came from before asking whether the check is
correct; a correct check on a nominated subject still proves nothing.
