---
title: A comparison built on a first-match reader accepts the value it never read
date: 2026-09-05
category: bugs
module: src/worker/start.mjs
problem_type: bug
component: worker-start
severity: high
symptoms:
  - "`ax worker start --replace --request <id> -- --worktree <recorded> --worktree current` was ACCEPTED and issued the recorded placement, silently dropping the `current` the operator typed second"
  - "The same reading, transposed: a record whose newest `worker-start` argv named `--worktree` twice inherited the first of the two, resolving an ambiguity by position"
  - "The refusal that exists to stop a child being re-placed passed on exactly the input that re-places it"
root_cause: a_first_match_reader_used_as_a_whole_argv_predicate
resolution_type: code_fix
related_components:
  - dispatch-record
  - placement
tags:
  - argv-reading
  - every-occurrence
  - ambiguity-is-not-position
  - comparison-vs-lookup
---

# A comparison built on a first-match reader accepts the value it never read

## Problem

`record.mjs`'s `argvValue(argv, name)` answers the FIRST occurrence of an option and stops. That is
the right reading for a LOOKUP — "which host did this dispatch name?" has one answer, and the
record's own argv carries each flag once.

`--replace`'s placement inheritance (#11, trap 1) is not a lookup. It is a COMPARISON against
everything the caller typed, and it drops what it compared: the typed placement is stripped and the
record's own bytes are issued in its place. Built on `argvValue`, the two halves disagreed. Typed
`--worktree path:<recorded> --worktree current` compared equal on the pair the reader reached,
then had BOTH occurrences stripped — so the refusal that exists to stop a child being moved into
another checkout passed, and the value the operator actually meant vanished with no diagnostic. The
narrow shape (`--agent omp --agent claude`) does the same to the agent.

The mirror case was live too. A record naming one placement flag twice has no answer readable off an
index, and a first-match reader supplies one anyway — the failure `placement.mjs` already pays for
in #84, where more than one candidate worktree is a cannot-establish naming all of them rather than
a pick by position.

## Resolution

`placementPairs` reads a placement slice as every (flag, value) pair it names, in order, both option
forms, with a bare trailing flag pairing to `null`. `inheritPlacement` then:

- folds the RECORD's pairs into a map and refuses when one flag is named twice with differing
  values, naming both — ambiguity is never resolved by position;
- walks EVERY typed pair against that map, so a second occurrence is compared rather than shadowed.

`argvValue` was not changed. It is correct where it is used, and widening a lookup into a
multi-value reader would have pushed the same ambiguity into `dispatchHost`, `recordedRun` and the
pane index, each of which wants exactly one answer.

## Lesson

A first-match reader and a whole-argv predicate are different questions, and the difference only
shows up on the input a caller repeats. Ask which one a call site is: if the code DROPS what it
compared — normalizing, stripping, substituting — then anything it did not read is honoured in
silence, and the check is strongest exactly where it is weakest.

The tell is asymmetry between the read and the write. Here one pair was read and both were dropped;
one pair fewer read than written is where the escape lives.
