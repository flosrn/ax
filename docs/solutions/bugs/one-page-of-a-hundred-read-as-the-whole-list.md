---
title: One page of a hundred, read as the whole list — a paginated read needs a reconciled total
date: 2026-09-05
category: bugs
module: src/pr-grounds.mjs
problem_type: bug
severity: high
component: pr-gate
symptoms:
  - "`ax pr gate` decided CI from a single `?per_page=100` read, so on a commit whose check-run list announced 101 rows the hundred-and-first was never observed (#176)"
  - "A declared check living only on page 2 read as `has NO run` — a refusal aimed at a job that was green"
  - "A pending or failing later run of a declared name was hidden behind an earlier page's green row of the same name, which is what a re-run or a matrix job produces routinely"
  - "The receipt printed `checks: 100 check-run(s) reported on <sha>` — a count of what was read, indistinguishable from a count of what exists"
root_cause: a_bounded_page_measured_as_the_complete_list
resolution_type: code_fix
related_components:
  - merge-grounds
  - pagination
tags:
  - absence-is-not-zero
  - fail-closed
  - f-028
  - established-read
  - pagination
---

# One page of a hundred, read as the whole list

## Problem

`ciGround` issued one call — `repos/<slug>/commits/<sha>/check-runs?per_page=100` — and treated the
rows it came back with as the check-run list for that SHA. The endpoint caps a page at one hundred
rows and announces `total_count` for the whole list beside them, and `total_count` was never read.

The count that reached the receipt was the count of rows READ, which reads exactly like the count of
rows that exist. Both directions of the gate's judgement broke on a list longer than one page, and
they break opposite ways:

- a declared name whose only run is on a later page is absent from the read, and absence is this
  ground's refusal — a worker sent to fix a check that already passed;
- a declared name with a green row on page 1 and a `queued` or `failure` row on page 2 passes,
  because the failing row was never in hand. Re-runs and matrix jobs produce same-named rows as a
  matter of course, so this is the ordinary case, not the exotic one.

## Resolution

The read paginates on the validated head SHA (`&page=N`), and "complete" became a positive
reconciliation rather than the absence of a reason to stop: a `total_count` that is a non-negative
integer, and that many DISTINCT runs observed. Distinctness is by the row's `id`, read by name —
the failure this exists for is a page that comes back twice, and counting rows would climb to the
announced total over one page read repeatedly.

Every other way out of the loop registers an `unknown`, which fails the gate closed: a failed page
(the repair names that page, quoted, so a pasted `&` cannot background it), a malformed container, a
`total_count` that is absent, a string, negative or fractional, two pages announcing different
totals, more distinct rows than announced, pagination that ends before its own total, a page that
adds no new id, and the page bound. The absence refusal is issued ONLY on a complete read; on an
incomplete one the run may sit on a page this gate never got, and the unknown already holds the gate
closed.

`gh api --paginate` was rejected for the gate's own read: it hides each page's own `total_count` and
which page failed. It is the repair a human runs, and that is where it is printed.

Regression coverage runs through the real `gate()` with injected `gh` pages and a real temporary Git
repository (`tests/pr-gate.test.mjs`), including the measured 101-versus-100 response, a declared
check found only on page 2, a later-page failure behind an earlier green row, a later-page read
failure, and the proof that `--merge` over an incomplete read issues no `gh pr merge` at all.

## Lesson

A page size is an answer boundary, and a read that authorises a mutation has to say which side of it
the answer came from. The reusable shape is the same one the thread read paid for (#175): the end of
a list is a POSITIVE observation. For a cursor list that observation is `hasNextPage === false`; for
a counted list it is `distinct observed === announced total`, and the count of what you read is
never it.

The corollary is what a complete read does NOT claim. Reconciling every page against an announced
total is not an atomic snapshot of GitHub metadata — runs can be created while the loop paginates —
and writing that down keeps the next reader from deriving a guarantee the mechanism cannot give.
