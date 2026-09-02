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
- An unreadable record BLOCKS the binding even when another record does claim the branch: its own
  repository, branch and ticket are unread, so it may be the second claim, and "one candidate
  found" is not "one claim exists".
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

## The trap on the way out: prose about closing keywords closes tickets

The PR delivering this fix explained the defect by quoting it — a literal closing keyword naming
issue 11 — in its own description AND in a commit message. Both are gate input, and both are
GitHub input:

- The body: the gate's own run printed `it also closes #11, #999` on the very PR that added the
  set-of-closures read. The illustration had become a delivery claim.
- The commit message, which is worse, because it is invisible to a reader of the PR. This
  repository's `squash_merge_commit_message` is `COMMIT_MESSAGES`, so a squash body is the
  concatenated commit messages: `gh api repos/<slug> --jq .squash_merge_commit_message` is the read
  that settles it. Issue 11 is OPEN and unrelated; the merge would have closed it, and the ticket's
  own dependents would then have derived from a closure nobody delivered.

Repaired by rewriting the messages through a `--msg-filter` — verified inert with the same regex
the gate uses, and verified message-only with `git diff --stat <backup> HEAD` returning empty —
then force-pushing with a lease and re-deciding CI on the new head.

**Prose that quotes a control construct arms it.** Documentation, commit messages, review replies
and test fixtures are all read by the machine that acts on them, so an example has to be written
inert: name the issue in words (`a closing keyword for issue 11`), never in the syntax. Check the
two places a keyword survives a PR — the description and every commit message on the branch — and
read the repository's squash policy rather than assuming the body is the only channel.
