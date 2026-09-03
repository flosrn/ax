---
title: A check whose own self-repair creates the state its next ground refuses
date: 2026-09-03
category: bugs
module: src/pr-gate.mjs, src/pr-grounds.mjs
problem_type: bug
component: verification
severity: medium
symptoms:
  - "`ax pr gate --pr 87 --issue 71 --merge` printed `REFUSE — commits since open [DETECTOR]: 1 commit(s) landed after the PR was opened (43067ab932d1)` for the merge its own `gh pr update-branch` had just created"
  - "The printed repair asked for `--ack-body`, a flag the caller could not have passed: the commit did not exist when they typed the command"
  - "The merge went back to a worker for a base merge and a body edit whose only content was the gate's own commit"
root_cause: a_ground_measuring_the_verbs_own_mutation_as_foreign_state
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - merge-gate
  - self-repair
  - git-shape-predicate
  - false-refusal
---
# An instrument that refuses its own footprint

## Problem

`ax pr gate` self-repairs one refusing ground: when staleness is the only refusal on a merging run,
it runs `gh pr update-branch`, confirms the head moved, and re-runs itself once (KTD6). That update
mints a merge commit. Its committer date is, necessarily, after the pull request opened — so the
re-run's commits-since-open detector listed it, refused it, and printed the one repair that ground
knows: pass `--ack-body` after re-reading the body against the commits.

The caller could not have done that. On the reported run (`--pr 87 --issue 71 --merge`, no
`--ack-body`) the PR had no post-open commit when the command was typed; the only one in the
re-run's list was the commit the verb itself had just created between the caller's command and the
measurement. The cost was one CI cycle and one of the two rounds the doctrine allows, spent on a
commit nobody authored.

## Why the shape hides

Both halves were internally correct. The self-repair had observed the new head and printed it
(`head now: 43067ab`). The detector had read every PR commit and compared committer dates against
the open time. Neither was wrong about its own question — the fact simply did not cross between
them: `--stale-retried` is a bare boolean, so the SHA the verb held one step earlier was discarded
at the recursion boundary, and the ground had no parameter by which a commit the verb itself created
could be exempted.

The tempting repairs are both worse than the defect.

- **Acknowledge its own argv.** Appending `--ack-body` to the recursion suppresses the detector for
  EVERY post-open commit, including the caller-authored ones the body genuinely fails to describe. A
  one-commit exemption becomes a blanket bypass of the ground.
- **Carry the SHA.** An in-process option (`selfRepairHead`) reaches exactly one re-run — the one
  the self-repair issues. The same false refusal then recurs in the owning worker's fresh gate
  process, and in a resumed merge, because neither of those minted the commit. A value on the flag
  is worse still: it makes the detector suppressible for any SHA a caller types.

Both are attempts to remember an act. The act does not need remembering, because it left a shape in
the commit graph that can be re-measured from nothing.

## Resolution

The exemption is a PREDICATE ON THE COMMIT, in `commitsGround`, re-derived on every run and stored
nowhere. A post-open commit is base movement when all three hold, each one read:

1. exactly two parents (from the `parents` list on the PR commits payload the ground already
   fetches),
2. the second parent reachable from the base ref (`git merge-base --is-ancestor`), and
3. `git diff-tree --cc --no-commit-id <sha>` EMPTY — the merge carries nothing that is not already
   in one of its parents.

It is then reported, not refused: `1 base merge — exempt: <sha> (clean merge of main: …)`. Every
post-open commit that is not that shape keeps refusing and keeps printing the `--ack-body` repair.
`--stale-retried` stays a bare boolean, and no CLI surface can name a SHA to exempt.

Because nothing is remembered, the answer is identical in the process that minted the commit, in the
owning worker's fresh run, and in a resumed merge — and a worker's own clean `git merge origin/main`
gets the same answer, which the reported run's diagnosis had not asked for and which fell out for
free.

## The rules this paid for

**A ground must not measure its own verb's mutation as foreign state.** The verb here both repairs
and measures; every act it performs between the caller's command and the measurement is state no
input the caller could have written can describe. Enumerate those acts when adding a self-repair.

**Prefer re-deriving a fact from durable state over carrying it.** A carried fact is scoped to the
process that carried it, and the same false verdict returns in every other process. The commit graph
already held the answer; asking it costs three git reads and holds everywhere, forever, with no
record to keep coherent.

**An exemption by shape must be narrow enough to be unusable as a bypass.** Two parents and
reachability alone would exempt an "evil merge" — work smuggled under a merge commit — which is
exactly what the detector exists to catch. The `--cc` emptiness condition is what keeps the rule at
"what a clean `git merge origin/<base>` would have produced" and no wider.

**Unknown is not exempt (F-028).** A base ref this checkout cannot resolve, or a `--cc` that cannot
answer, leaves the shape undecided, and undecided refuses — with the fetch in the repair, not an
acknowledgement of a commit nobody described.

**`git diff-tree` prints the commit id.** `git diff-tree --cc <sha>` is never empty: its first line
is the SHA. An emptiness test on it needs `--no-commit-id`, or every clean merge reads as carrying
content.
