---
title: A second question read off the first question's authority row inherits its exclusions
date: 2026-09-05
category: bugs
module: src/worker/slots.mjs
problem_type: bug
component: capacity
severity: high
symptoms:
  - "`ax worker ls` printed `1 live pane(s)` while both dispatch verbs counted zero on the SAME store, so a dispatch was admitted past a full `dispatch.cap`"
  - "The pane that vanished was recorded by a bash-era `worker-start-inject` repair phase — alive, working, and carrying no handle in the dispatch index"
  - "Each verb widened its own reading of \"a live pane\" separately, and the two numbers agreed only while somebody maintained both"
root_cause: one_index_row_answering_two_questions_with_one_authority_rule
resolution_type: code_fix
related_components:
  - dispatch-record
  - worker-ls
  - worker-dispatch
  - triage-dispatch
tags:
  - two-questions-two-readers
  - authority-vs-measurement
  - keyed-by-subject
  - one-number-by-construction
---

# A second question read off the first question's authority row inherits its exclusions

## Problem

`dispatchIndex` (`src/worker/record.mjs`) answers "which dispatch owns this record", and its
authority rule is deliberate: only a `worker-start` phase may name a dispatch, because that
provenance decides whether a pane may be CLOSED. The row it builds also carries the pane handle —
and the cap fence read that field for a different question: "is this pane consuming a slot".

The handle therefore rode on an authority rule written for release safety. A record whose agent pane
was recorded by the bash-era `--inject` repair keeps it in a `worker-start-inject` phase, so it had
no handle in that index and no slot in the count, while `ax worker ls` — which counts the pane
whichever phase recorded it — showed the same pane `VIVANT`. Two numbers for one question (the #88
class), and the exposure was measured as a dispatch admitted past a cap that was already full
(finding #161).

Both halves had already widened towards the truth independently: the listing from its rows, the
fence from the index. That is the tell — when two callers maintain two tallies of one machine, they
agree until one of them learns a shape the other does not.

## Resolution

Ruled shape 2 on #161: capacity gets its own reader, keyed on its own subject.

- `src/worker/slots.mjs` exports exactly one function, `livePanes({ store, local, scopes, repo })`.
  It walks every phase of every record, asks the ONE exported pane rule (`agentTerminal`) whether
  that receipt recorded an agent terminal, keys by handle — so a repair reusing the terminal is one
  slot — intersects with the host-aware inventory, and returns the scoped counts. Its internals are
  module-private, so no caller can compose the number differently.
- `ax worker ls`, `ax worker dispatch` and `ax triage dispatch` count through it and nothing else;
  `liveCount` is gone from `capacity.mjs`, which keeps the caps and the refusal.
- `dispatchIndex` keeps its authority rule and its header verbatim. `ax triage dispatch` still reads
  it — for the rival-pass gate, which really is a provenance question.
- What the two readers SHARE is only the per-file discipline: `scanStore` parses the store once per
  reader with the same two refusals (a file that does not parse, a record whose `request` disagrees
  with its filename). A second copy of that discipline is how one reader starts skipping a record
  the other refuses on.
- Because the listing is lenient per record and the fences are not, `ls` discloses the records the
  count could not read: a row it prints can never be silently absent from the number beside it.

## Lesson

An index row is an answer to ONE question. When a second question reads a field off it, the second
question silently inherits the first's authority rule — and the inheritance is invisible, because the
field is right there and usually correct.

Ask what each reader is keyed on. "Which dispatch owns this record" is keyed on the dispatch;
"is this pane consuming a slot" is keyed on the pane. Different key, different reader — then the two
numbers are one measurement by construction instead of by maintenance, and the direction of any
future widening is decided once, in the reader's own header.
