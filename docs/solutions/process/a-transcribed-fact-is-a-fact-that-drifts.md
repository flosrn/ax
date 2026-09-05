---
title: A transcribed fact is a fact that drifts — derive the landing, keep the judgment
date: 2026-09-06
category: process
module: src/worker/landed.mjs
problem_type: process
component: worker-dispatch
severity: medium
symptoms:
  - "The wave-memory file passed through `ax worker dispatch --notes` carried five hand-typed landing lines (`Landed #190 through Gate: PR #196, validated head 43bd48af…, squash 59cecca29fa9`), one per merged sibling, transcribed by the orchestrator out of each worker's Report"
  - "Measured 2026-09-06 while implementing #195: the notes said #194 was still in review repair; the tracker said PR #201 merged at f446f2297a11 closing #194. The transcription was one wave behind the forge it described"
  - "A worker reading those notes has no way to tell a fact the orchestrator read from the tracker from one it remembered, and both look identical beside the operator's real judgment"
root_cause: a_mechanical_fact_was_carried_by_hand_through_a_channel_meant_for_judgment
resolution_type: code_fix
related_components:
  - notes-channel
  - spec-membership
tags:
  - derive-dont-transcribe
  - absence-is-not-zero
  - f-028
  - established-read
  - one-owner-per-question
---

# A transcribed fact is a fact that drifts

## Problem

Three facts decide whether a worker's first edit collides with a seam a sibling just moved: the
pull request that governs a landing, the SHA that reached the default branch, and which surfaces
that SHA changed. All three were carried into the next dispatch by hand — the orchestrator read
each worker's Report and retyped its PR number, squash SHA and file list into the wave-memory
file passed through `--notes`.

Retyping is data entry, and data entry gets skipped or goes stale. It also launders provenance:
a Report is the child's own word, so a landing "confirmed" by transcription is confirmed by
nobody. Measured on the #174 wave: the notes described #194 as unfinished while GitHub had
merged its pull request; the derived read named the PR, the merge commit and the surfaces in the
same second.

## Resolution

`ax worker dispatch` now DERIVES that half of the notes channel, and the derivation is a pair of
reads with a strict pair of answers:

- the tracker must say a MERGED closing pull request and name BOTH its `mergeCommit.oid` and its
  `mergedAt`. A MERGED pull request missing either, two merged pull requests claiming one issue, a
  closing-PR node whose state is not one of GitHub's three, a closing-PR page that cannot prove
  itself complete, or an alias the batched read did not answer are each NOT ESTABLISHED and rendered
  as such — never as "merged". An OPEN, CLOSED or absent closing pull request is not an inability at
  all: it is work in flight, and the channel says nothing.
- surfaces come from `git diff-tree -r --no-commit-id --name-only <sha>^1 <sha>` in this checkout —
  the landed SHA against its own first parent. A commit this checkout does not carry is NOT READ
  with the fetch that would carry it; an empty surface list would claim the commit changed nothing.

Scope is the Spec, read through the ONE membership reader (`specMembership`, `src/completion.mjs`)
after resolving the dispatched ticket's parent. The section renders into the brief ABOVE the
operator's verbatim words, announced as derived, and the operator's own file is opened read-only
and never rewritten — which is what makes a repeated or resumed dispatch idempotent by
construction rather than by a de-duplication rule.

## Lesson

Split a channel by who owns what, not by what is convenient to type. A fact a machine can
establish belongs to the machine: it is cheaper, it carries its provenance, and it cannot be one
wave stale. What stays human is the judgment a diff cannot carry — the arbitration, the ruling,
the warning — and it keeps the last word.

The corollary is the failure direction. When the derivation cannot establish anything, the
inability has to travel INTO the channel: a missing section is indistinguishable from "this Spec
landed nothing", and a worker who believes that rebases onto a base that moved this morning.
Silence is the one rendering a derived channel may never choose.

## Three corrections the first form needed, and what each measures

The first implementation was refused on three counts (review of PR #203), and each refusal is a
reusable shape rather than a typo:

**A per-parent diff is not a first-parent diff.** Surfaces read `diff-tree -m --first-parent <sha>`,
chosen so a merge commit would answer at all. Measured on a real two-parent merge, it printed the
base's own path beside the branch's: `-m` diffs against EACH parent. A landing then advertised a
surface it never touched, which sends the next worker looking in the wrong file. `<sha>^1 <sha>` is
one comparison of two trees and means the same thing for a squash and for a merge.

**An unreadable state is not the negative answer.** The merged set was `filter(state === 'MERGED')`,
which quietly folded a null node, a node with no `state` — what a PARTIAL GraphQL failure leaves
behind, and this read uses partial payloads on purpose — and an unknown state into "has not landed
yet". Validate against the vocabulary the API has; anything outside it is unread, and unread is not
the answer that happens to be safe to render.

**A repository-local identifier cannot order two repositories.** The channel's cap sorted landings by
pull-request number, so a foreign `#900` merged last year outranked a local `#12` merged today. It
was already wrong inside ONE repository, because merge order and numbering diverge whenever two pull
requests are merged out of sequence: PR #202 carried the higher number and PR #201 merged later.
Order by the event's own timestamp, and treat a missing timestamp as an inability rather than a rank.
