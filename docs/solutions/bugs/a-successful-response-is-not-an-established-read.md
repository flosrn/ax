---
title: A successful response is not an established read — the end of a list is a positive observation
date: 2026-09-05
category: bugs
module: src/pr-grounds.mjs
problem_type: bug
component: pr-gate
severity: high
symptoms:
  - "`ax pr gate` printed `threads: page 1 — 0 thread(s), 0 unresolved` and PASS on a GraphQL 200 whose `reviewThreads.nodes` key was absent — a read of nothing, reported as an observation of nothing (#175)"
  - "`nodes: null` and `nodes: { edges: [] }` produced the same passing receipt: `Array.isArray(x) ? x : []` turns three malformed shapes into the gate's merge-authorising answer"
  - "An absent or non-boolean `hasNextPage` ended pagination, because `!== true` cannot distinguish `false` from unanswered"
  - "A page naming the cursor it was already read with re-read page 1 up to the 50-page bound, printing fifty pages of progress while every thread past the first stayed unread"
root_cause: a_missing_field_defaulted_to_the_value_that_authorises_the_mutation
resolution_type: code_fix
related_components:
  - merge-grounds
  - pagination
tags:
  - absence-is-not-zero
  - fail-closed
  - f-028
  - established-read
  - named-key-reads
---

# A successful response is not an established read

## Problem

`threadsGround` read every container of its GraphQL payload by name — `data`, `repository`,
`pullRequest`, `reviewThreads` — through `must`, which raises on an absent or null key. F-028's rule
was applied four levels deep and then abandoned on the two fields that actually decide the verdict:

```js
const nodes = Array.isArray(threads.nodes) ? threads.nodes : [];
const info = threads.pageInfo ?? {};
if (info.hasNextPage !== true) break;
```

Both are `or`-into-a-default on a container, and the default they chose is the gate's PASSING answer:
zero threads, final page, nothing unresolved, merge authorised. Three shapes measured in the field
return HTTP 200 with every container present and `nodes` malformed (absent, null, an object), and each
one merged. `hasNextPage` had the same asymmetry in the pagination direction: `!== true` reads
"unanswered" as "there is no next page", so a page whose `pageInfo` was truncated ended the read.

`endCursor` was read with `?? null`, which caught only one of its failure modes. A page claiming a
successor and naming the cursor it was ALREADY read with is a valid string, so the loop advanced onto
its own previous position and re-read the same page — to the 50-page bound, with a receipt showing
fifty pages of progress over one page of threads.

## Resolution

The end of the list became a POSITIVE observation. `established` is set by exactly one thing: a page
whose `hasNextPage` is the boolean `false`. Every other way out of the loop registers an `unknown`
that names the field or the page it could not establish, and an unknown fails this gate closed — so an
unestablished read is unmergeable-until-read and can never arrive at the complete-empty case that
passes. The cursors handed out are remembered in a `Set`, and a repeat is an unknown rather than a
re-read.

The threads a partial read DID observe stay in the same receipt beside the unknown, because a
refusal a caller can act on is worth more than a clean stop, and the receipt now distinguishes
`threads: read established — 0 thread(s) …` from a read that merely stopped.

Regression coverage runs through the real `gate()` entry with injected `gh` answers and a real
temporary Git repository (`tests/pr-gate.test.mjs`), including the proof that `--merge` over an
unestablished read issues no `gh pr merge` at all. A helper-only test could not have shown that.

## Lesson

`must` on the containers and `??` on the leaves is not a named-key read — it is F-028 held exactly as
far as the nesting and dropped where the decision is made. When a field is missing, ask which verdict
the default produces: here every absent field defaulted toward the mutation, so each malformed payload
was a merge.

The reusable shape is that a bounded read needs a positive terminator. "I did not see a next page" and
"the API told me there is no next page" are different facts, and only the second one can end a read
that authorises anything. The same applies to the cursor: a successor claimed with no cursor that
ADVANCES is not progress, and a loop that cannot tell a new page from its own last one will report
whichever answer the caller was hoping for.
