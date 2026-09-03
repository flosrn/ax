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
several: it acts on every construct in the text that lands on the default branch, and the body is
only one of the texts that get there.

The others are the branch's own commit messages and — this is the half the first fix missed — the
pull request TITLE. On this repository (`gh api repos/flosrn/ax`) `squash_merge_commit_message` is
`COMMIT_MESSAGES`, so the squash merge message IS the concatenated messages; a `--method merge` or
rebase merge lands every commit verbatim whatever the squash settings say; `squash_merge_commit_title`
is `COMMIT_OR_PR_TITLE`, which takes a single commit's subject when the branch has exactly one and
the PR title otherwise; and `merge_commit_message` is `PR_TITLE`, which puts the title inside the
merge commit. A subject and a message are always written, and they always come from somewhere:
**there is no configuration under which the body is the only channel.**

Measured on #67: a commit whose explanatory prose quoted a closing keyword for an unrelated OPEN
ticket was one squash away from closing it. No ground could refuse. Ground 7 was satisfied — the
body carried a construct naming the bound ticket, which is all that ground asks. Ground 9 compared
the bound ticket against a set derived from that body, and the other ticket was not in it. The
worker caught it by hand.

## Why the shape hides

The hazard is invisible from inside the module. Both grounds' headers stated their rule as a body
read, and both were internally consistent: the body was read completely, every construct in it was
collected, the set was deduplicated and ascending. Nothing about the code looks partial. What was
partial was the CHANNEL SET — a fact that lives in the repository's settings and in the merge
method, neither of which the gate read at all.

IT HID TWICE. The first fix read the two `squash_merge_commit_message` arms and called every other
configuration inert — which left the PR title free to close an unrelated ticket, because a title
does not close as a "title": it closes as the SUBJECT of the commit policy makes it. A reviewer's
P1 caught that on the very PR that fixed the first half. The lesson generalises past this module: a
guard is complete only when it enumerates every text the platform WRITES, not the ones the author
thinks of as prose.

That is the general shape: a guard over a text is only as wide as the set of texts the effect
travels on, and that set is usually a property of the platform, not of the artifact. The
`gh repo view --json` receipt the gate already read cannot answer it (`squashMergeCommitMessage` is
not a field there — it errors with `Unknown JSON field`); it takes a separate `gh api repos/<slug>`.

## Resolution

- One `gh api repos/<slug>` read per run establishes all four message settings —
  `squash_merge_commit_message`, `squash_merge_commit_title`, `merge_commit_title`,
  `merge_commit_message` — plus the allowed method set (`mergePolicy`). A value the predicate cannot
  place is an inability to establish, not an inert arm.
- `closingChannels` turns that into a predicate over TEXTS: the PR title wherever policy makes it
  the landing subject, the branch's commit messages wherever they land verbatim or build the merge
  message, and a single commit's subject under `COMMIT_OR_PR_TITLE` with exactly one commit.
- The methods it evaluates are the ones the run can CAUSE. A merging run mutates with exactly one
  method — `--method`, or the `squash` default — so it stands on that one; widening there refused
  merges over text that cannot reach the commit being written. A detector run causes nothing and
  names nothing, so it fails closed over every allowed method and says which.
- The commit messages cost no extra round trip: `prCommits` reads the payload Ground 6 already
  fetched for its "commits since open" detector, where `commit.message` had always been present and
  never touched. The title rides the `gh pr view` receipt the same way.
- `closedIssuesOf` derives ONE closure set over the channel set, carrying the channel that named
  each ticket, and both Ground 9 (pre-merge) and closure verification (post-merge) consume it.
- Ground 9 refuses a same-repository ticket other than the bound one when THE BODY does not declare
  it, and the repair edits the channel that carries it: `git rebase -i <sha>^` for a message,
  `gh pr edit --title` for a title.

## The rules this paid for

**An unread policy is an unknown, not the convenient default.** F-028 again: defaulting to "the body
is the only channel" over a failed read authorises a merge against a fact the run never established.
It is exit 3 with the command in the repair. A policy value the predicate does not recognise is the
same unknown wearing a string.

**A list read one page deep is not a complete list.** The commits endpoint answers 100 per page and
caps at 250 whatever the page size, so a full page means the channel is unread, never empty.

**A guard evaluates the mutation it will perform, not every mutation the platform permits.** Fail
closed where nothing is decided yet — a detector run — and narrow to the decided method the moment
the run is the thing doing it. Getting that backwards turns a guard into a source of false refusals,
which is how guards get switched off.

**Enumerate what the platform writes, not what the author writes.** The body and the commit messages
are prose someone typed; the subject of the landing commit is a text GitHub ASSEMBLES from policy.
Only the second framing finds the title.
