---
title: A guard that reads one of the two channels its subject travels on refuses nothing on the other
date: 2026-09-03
category: bugs
module: src/pr-gate.mjs, src/pr-grounds.mjs
problem_type: bug
component: verification
severity: high
symptoms:
  - "`ax pr gate` printed no refusal for a branch whose commit message closed an unrelated open ticket"
  - "Ground 7 passed because the PR body carried the bound ticket's construct, which is all it asks"
  - "Ground 9's comparison set was derived from the body alone, so the second ticket was never compared"
root_cause: one_channel_read_of_a_two_channel_effect
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - merge-gate
  - closure-verification
  - squash-merge
  - false-absence
---
# A second channel the check never read

## Problem

`ax pr gate`'s closing-construct read had exactly one input, the pull request body. GitHub's has
two: it acts on every construct in the text that lands on the default branch, and the body is only
one of the texts that get there.

The other is the branch's own commit messages. On this repository
(`squash_merge_commit_message` = `COMMIT_MESSAGES`, read with `gh api repos/flosrn/ax`) the squash
merge message IS the concatenated commit messages, so a construct in any of them fires at merge
time. A `--method merge` or rebase merge lands every commit verbatim and fires them whatever the
squash settings say, and `squash_merge_commit_title` = `COMMIT_OR_PR_TITLE` adds a third arm: with
exactly one commit on the branch, its subject becomes the merge title and reaches `main` however
the message policy is set.

Measured on #67: a commit whose explanatory prose quoted a closing keyword for an unrelated OPEN
ticket was one squash from closing it. No ground could refuse. Ground 7 was satisfied — the body
carried a construct naming the bound ticket, which is all that ground asks. Ground 9 compared the
bound ticket against a set derived from that body, and the other ticket was not in it. The worker
caught it by hand.

## Why the shape hides

The hazard is invisible from inside the module. Both grounds' headers stated their rule as a body
read, and both were internally consistent: the body was read completely, every construct in it was
collected, the set was deduplicated and ascending. Nothing about the code looks partial. What was
partial was the CHANNEL SET — a fact that lives in the repository's settings and in the merge
method, neither of which the gate read at all.

That is the general shape: a guard over a text is only as wide as the set of texts the effect
travels on, and that set is usually a property of the platform, not of the artifact. The
`gh repo view --json` receipt the gate already read cannot answer it (`squashMergeCommitMessage` is
not a field there — it errors with `Unknown JSON field`); it takes a separate `gh api repos/<slug>`.

## Resolution

- One `gh api repos/<slug>` read per run establishes the squash message policy, the squash title
  policy and the allowed method set (`mergePolicy`).
- `closingChannels` turns that into a predicate — will these commit messages reach the default
  branch — evaluated for the caller's `--method`, or, when none is named, for EVERY method the
  repository allows, failing closed.
- The commit messages cost no extra round trip: `prCommits` reads the payload Ground 6 already
  fetched for its "commits since open" detector, where `commit.message` had always been present and
  never touched.
- `closedIssuesOf` derives ONE closure set over the channel set, carrying the channel that named
  each ticket, and both Ground 9 (pre-merge) and closure verification (post-merge) consume it.
- Ground 9 refuses a same-repository ticket other than the bound one when the body does not declare
  it, and its repair is a reword of the message that carries it.

## The rules this paid for

**An unread policy is an unknown, not the convenient default.** F-028 again: defaulting to "the body
is the only channel" over a failed read authorises a merge against a fact the run never established.
It is exit 3 with the command in the repair.

**A list read one page deep is not a complete list.** The commits endpoint answers 100 per page and
caps at 250 whatever the page size, so a full page means the channel is unread, never empty.

**An inert channel must contribute nothing at all** — no refusal, no note, not even its own
unreadability. Where those messages cannot reach the default branch they decide nothing, and the
body-only verdict has to survive byte for byte. The whole pre-existing gate suite runs on the inert
policy for exactly that reason: it is the regression proof.
