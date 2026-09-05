---
title: Evidence resolved by name authorizes a commit it never read
date: 2026-09-05
category: bugs
module: src/pr-grounds.mjs
problem_type: bug
component: pr-gate
severity: critical
symptoms:
  - "`ax pr gate` printed `staleness: feature carries main — the branch is current` for a pull request whose announced head carried none of the base, because the local `feature` tip had merged it"
  - "The verdict named the announced head SHA — `PASS — …#1845 is mergeable at 7ff933c5…` — while the ground behind it had measured a different commit, and `--merge` landed that head"
  - "The same reading through a remote: `origin/feature` published past the announced head supplied the ancestry for it"
root_cause: git_evidence_resolved_by_branch_name_while_the_verdict_bound_a_sha
resolution_type: code_fix
related_components:
  - pr-grounds
  - merge-gate
tags:
  - resolve-once
  - name-vs-commit
  - evidence-binding
  - fail-closed
---

# Evidence resolved by name authorizes a commit it never read

## Problem

`ax pr gate` resolves the head SHA once, prints it, binds the merge to it with
`--match-head-commit` and says so: "every ground below uses this value". The git-backed grounds did
not. `gitGrounds`, the declaration guard and the post-open commit shapes each resolved
`origin/<branch>` or `<branch>` — a NAME — and measured whatever that ref happened to hold.

A name and a commit are the same thing only until something moves. Measured locally on a checkout
with no `origin`: a pull request announcing its pre-merge head, a base that had advanced, and a
`feature` tip that had merged that base. Ancestry answered against the TIP, the receipt read "the
branch is current", every other ground passed, and the verb merged the announced head — which
carried none of the base it had just been told was current. `--match-head-commit` faithfully bound
the mutation to the commit nobody had measured. The same reading works one ref further along with a
remote, which is F-033/#1939 in the direction that passes instead of the direction that refuses.

## Resolution

The two commits are resolved ONCE, in `gitGrounds`, and travel out of it:

- the base ref is resolved after the refresh and then read to a commit id (`commitOf`), so the
  comparison stands on the commit this run OBSERVED rather than on a ref a later fetch can move;
- the head is the SHA the gate validated, and this checkout must hold it — a well-formed SHA nobody
  here has is an unread with a fetch, never a branch that answers for its name.

`out.baseCommit` / `out.headCommit` then feed the declaration guard and the commit-shape predicate
instead of each resolving the base for itself. `resolveRef` has one caller left.

Without a remote there is nothing that publishes a head, so the local branch tip must BE the
announced head before currency can be established; a divergent tip is a cannot-establish, and the
ancestry against the announced head is still read and still refuses. Remote-tracking refs are not
consulted for that comparison: with no remote they are fossils.

The receipt prints both commits, and the sentences name them (`the validated head 0ba318b9edae
carries 501121a457ec (origin/main)`), so a reader can tell which commit an answer is about.

## Lesson

When a decision is bound to an identifier, every piece of evidence behind it has to be measured on
that identifier — not on a name that resolved to it at some other moment. The tell is a receipt
that prints a SHA and a ground beneath it that prints a branch: two vocabularies in one verdict
means two subjects, and the gap between them is invisible exactly while it is wrong.

Resolve once and pass the value. A consumer that re-resolves "the same" name is not sharing the
measurement — it is taking a second one, and the second one is the one nobody reviewed.
