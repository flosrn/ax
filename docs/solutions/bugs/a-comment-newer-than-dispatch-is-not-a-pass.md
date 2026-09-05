---
title: A comment newer than the dispatch is not a Pass
date: 2026-09-05
category: bugs
module: src/triage
problem_type: bug
component: worker-release
severity: high
symptoms:
  - "`ax triage release --pass 2` refused as 'the request names no issue' because the reader took `p2` off the end of a hyphenated identity"
  - "An unrelated later comment, another job's Agent Brief or a previous Pass's verdict closed a triage pane whose own publication never landed"
  - "A custom pass inherited a merged pull request from the parent checkout and closed a report nobody had read"
  - "A record written before `--kind` whose `--name` is byte-identical to a triage mint closed on that job's publication, and a malformed old job name fell through to the parent checkout's merged PR"
root_cause: two_verbs_spelled_one_identity_two_ways
resolution_type: code_fix
related_components:
  - triage-publish
  - worker-release
  - request-grammar
tags:
  - f-028
  - publication-identity
  - proof-by-job-and-pass
---
# A comment newer than the dispatch is not a Pass

## Problem

`ax triage publish` posted a comment carrying a per-job disclaimer, and
`ax worker release` proved a triage pane with "a comment on that issue, created
AFTER the dispatch". Those are two different questions. The second one is
answered by artifacts that have nothing to do with the pass: a reporter's reply,
another job's Agent Brief, the previous pass's verdict. And the request grammar
was taken apart by hand — `request.split('-').pop()` — so every suffixed pass 2
was refused as naming no issue, while `custom` matched no kind and fell through
to the implementation rule.

## What changed

The mint (`requestFor`) and the reader (`parseRequest`) live beside each other
in `src/triage/draft.mjs`, and the recorded repository is an argument, never a
guess from the hyphens. The publication carries its own identity — repository,
issue, job, pass — stamped by the publisher and read by Release through
`src/triage/publication.mjs`. A custom pass publishes nothing and never consults
the parent checkout's pull request. Duplicate protection compares the draft
bytes with the attribution stripped, so a leftover draft still matches a
stamped comment.

Which proof a pane owes is the `kind` its dispatch RECORDED (`--kind`, written
by the minting verb): `--name custom-one-two-2025` and a custom pass of issue
2025 on `one/two` are the same bytes, so the name cannot answer it. A record
written before that field whose request carries a job word is untypeable and
closes nothing — both readings were measured closing the wrong pane. One
carrying no job word is still an implementation, because the mint grammar is
complete: every job request opens with its job word.

## Reusable rule

A proof that consumes a minted identity must take that identity apart with the
same function that minted it, against the recorded repository, not against the
text. And two verbs that agree on "this comment is that pass" share one
recognition rule; a disclaimer, a timestamp, or a neighbouring artifact is a
different question.

A missing recorded fact is not recoverable by choosing the more plausible
history. When two histories write the same bytes, the row names the fact it
lacks and stops; the fallback that looks harmless ("assume the commoner case")
is a guess that authorizes a mutation.
