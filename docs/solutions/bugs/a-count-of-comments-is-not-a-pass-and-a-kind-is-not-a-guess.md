---
title: A count of comments is not a pass, and a kind is not a guess
date: 2026-09-06
category: bugs
module: omp/peer
problem_type: bug
component: completion-receiver
severity: high
symptoms:
  - "A `--job custom` child was told 'Issue #N has ALREADY had its triage pass; it is in its comments' for a spec-born issue whose comments were a sibling link and an execution mandate"
  - "A `kind: custom` completion was answered with a derived implementation Report path, a finding calling its prescribed Draft an unauthorized path, and a repair instructing the worker to write an artifact its assignment forbids"
  - "The delivery readout said 'The Summary itself arrived' for rows whose own findings say a completion without a witness is a claim, and told the reader to 'have the worker write THAT path' on rows that carry no path"
root_cause: three_readers_answered_from_a_proxy_instead_of_the_recorded_fact
resolution_type: code_fix
related_components:
  - triage-dispatch
  - completion-receiver
  - delivery-diagnostics
tags:
  - f-028
  - artifact-disposition
  - kind-at-mint
  - evidence-class
---
# A count of comments is not a pass, and a kind is not a guess

## Problem

Three readers asserted something a record does not say, and each had a cheaper
proxy at hand than the fact it needed.

`ax triage dispatch --job custom` gated its prior-pass sentence on the issue's
comment COUNT, and the sentence asserted a PLACE: "it is in its comments". A
count cannot establish a pass, and nothing about a count says where one is.

The completion receiver never read `kind`, which the mint writes, so every
`worker_done` was typed as an implementation. A `custom` Pass — whose contract is
one prescribed Draft and no Report — was told its Report was missing, and the
repair asked the worker to manufacture it.

The delivery readout rendered all of `completion.ts`'s dispositions with one
sentence, so an attribution refusal the receiver itself calls "a claim, not a
completion" was reported as an arrival, and a row carrying no path was given a
repair naming one.

## What changed

Each reader answers from the recorded fact, and the CLASS of the evidence travels
with it.

`triagePassEvidence` already answered `record` | `draft` | `publication` | `null`
for the `brief` lane's precheck; the `custom` prefix and note are now sourced
from it, and the two halves of its union are read apart, so a draft-only pass is
not described as recorded. `renderSpec` takes that evidence as one named option
and stays pure: only a publication stamp puts the pass in the comments, evidence
whose class it cannot name asserts the pass and no place, and no evidence says
nothing at all.

The receiver classifies before it derives, with `prove()`'s vocabulary and
`prove()`'s precedence (`src/worker/release.mjs`, #178): recorded
`implementation` behaves exactly as before; a recorded analysis kind owes a Draft
that is STATED and never located, so no path is derived, named or opened; a kind
missing, unrecognized, or contradicted by the request's job word is a named
inability that grants neither obligation. The witness and pane guards still
decide first — a job-aware exemption is not authentication.

The readout renders per disposition class: attribution refusals as unproven
claims, post-attribution file failures as artifact evidence unavailable, and
anything unclassified conservatively, naming the disposition it carries. The
persisted `reason` is unchanged, so rows an older pane wrote still render.

## Reusable rule

A sentence that asserts WHERE something is needs evidence that can say where. A
count, a length, or a boolean derived from one is a proxy: it can support "at
least one thing exists" and nothing about its identity or location. When the
class of the evidence is load-bearing for the reader, carry the class, not a
boolean collapsed out of it.

And an exemption is never granted on a fact that was not established. A kind that
is absent or contradicted is an inability to name — deriving nothing — because
the two failures a guess produces here are opposite and both expensive: an
artifact demanded that is forbidden, or an obligation waived that was owed.
