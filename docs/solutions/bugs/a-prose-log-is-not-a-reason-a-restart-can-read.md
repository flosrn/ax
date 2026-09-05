---
title: A prose log is not a reason a restarted session can read
date: 2026-09-06
category: bugs
module: omp/peer/diagnostics.ts
problem_type: bug
component: peer-channel
severity: medium
symptoms:
  - "A restarted Orchestrator could not tell a withheld heartbeat from a failed injection without grepping `~/.omp/run/orca-peers/<term>.log`"
  - "An unreadable Report and a missing Summary were the same silence to a session that did not write the observation"
root_cause: observations_lived_in_process_memory_and_unstructured_prose
resolution_type: code_fix
related_components:
  - omp/peer/receive.ts
  - omp/peer/completion.ts
tags:
  - persistence
  - discriminator
  - coverage-honest
---
# A prose log is not a reason a restarted session can read

Every send/receive outcome was already observed at the point that knew it, and
every one of them went to `note()` — an append-only prose log. The discriminator
between two opposite repairs was on disk; nothing surfaced it, so it had to be
re-derived by eye (`one-symptom-two-causes-fenced-as-one.md`). A process restart
was worse: the loop's memory died with it.

The repair is a JSONL store beside the registry, written at the observation, read
by a session that did not write it. Six named reasons, none of them a rate: a
filter is not an injection failure, an unreadable Report is not a missing
Summary, and a later ack does not leave resolved work presented as pending.
Coverage stays named — only this layer's seams write here; a hand-rolled
`orca orchestration send` is unknown, not absent.
