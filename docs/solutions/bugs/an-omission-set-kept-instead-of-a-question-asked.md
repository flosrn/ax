---
title: An omission set kept as a verdict, when the declaration said how to ask
date: 2026-09-02
category: bugs
module: src/worker
problem_type: bug
component: worker-ls
severity: medium
symptoms:
  - "Every pane dispatched with `--on <host>` read `pane INCONNU` behind one line: `hosts were omitted from the terminal-list scope`"
  - "That line printed on every run of `ax worker ls` on this Mac, whether or not any record sat on an omitted host — 198 local records, and the disclosure still fired"
  - "A working remote child was indistinguishable from a dead one, so an orchestrator arbitrating overlap had to treat it as unknown"
root_cause: unread_reachable_source
resolution_type: code_fix
related_components:
  - orchestration
  - remote-dispatch
tags:
  - f-028
  - disclosed-omission
  - measurement
  - per-host-scope
---
# An omission set kept instead of a question asked

## Problem

`orca terminal list --json` answers with the scope it read: `hostScope.hostIds` and
`hostScope.omittedHostIds`. On this Mac that omission is permanently non-empty — one paired remote
runtime — so `ax worker ls` classified every recorded pane against a list that could not see a
remote host, and disclosed the gap honestly:

```
· term_elsewhere · pane INCONNU · … hosts are omitted from its scope
· hosts were omitted from the terminal-list scope: a pane absent from it is INCONNU here, never MORT
```

Honest, and avoidable. The record names the host it dispatched onto (`--on gapicore`), and
`dispatch.hosts.gapicore` in `ax.config.json` is the declaration that says how to reach it. The
information needed to turn that unknown into an answer was already in hand and never used — so a
child working on a declared host stayed in the omission set for the life of its dispatch, and the
one reader of this verb (an orchestrator arbitrating overlap and capacity) had to treat it as
possibly-alive forever.

The blanket disclosure had the mirror defect: it fired whenever ANY host was omitted, including on
a store whose every record was local, where it explained nothing.

## Fix

Ask. Each host a record names is asked for its own inventory, once, through
`orca terminal list --environment <host> --json`; the declaration is the transport, so a host the
project never declared is not asked and not guessed at (`hostFor` refuses it, naming the repair).
Only what could NOT be asked is disclosed — one line per host, with the reason that host answered,
never one per row.

The subtle part is what licenses a MORT verdict afterwards, and it came out of measurement rather
than from the flag names. Measured 2026-09-02, back to back, against the declared `gapicore`
(environment `7930a317-…`, runtime `1468aeea-…`):

```
terminal list --json                        _meta.runtimeId 682e09fd-…   (local)
  hostScope {"hostIds":["local"],"omittedHostIds":["runtime:7930a317-…"]}   36 terminals
terminal list --environment gapicore --json _meta.runtimeId 1468aeea-…   (gapicore)
  hostScope {"hostIds":["local"],"omittedHostIds":[]}                        0 terminals
```

The scoped call is served BY the named environment's runtime, and `local` in its reply is that
remote's own local scope — not this machine's. So `paneVerdict` needs no second definition of death
and no name-to-runtime-id mapping: **a list that says it read `local` covers the runtime that
answered it, and the caller says which runtime that was** (`host === ''` for this machine,
`asked: true` for the host it named). A reply that does not name its own scope proves nothing and
keeps the pane INCONNU.

Exercised on the real machine, not only in the suite: a synthetic record on `gapicore` whose handle
that host does not carry now reads `pane MORT · term_… is unknown to 'gapicore', the host that
answered for its own panes`, and a record on an undeclared host reads
`host 'nowhere' could not be asked …` with `hostFor`'s repair — no `--environment` call made for it.

## The rule for this bug

**An omission has to be earned: before rendering "unknown", spend the reachable source you already
hold.** A declaration that names a transport is an instruction to ask, not merely a fact to report,
and a disclosure that names the whole scope instead of the hosts that actually failed is a
disclosure the reader cannot act on.

The generalisation that made it safe is worth reusing: when a receipt's vocabulary is relative to
the answerer (`local`, `here`, `self`), the caller's job is not to translate it into absolute ids —
it is to state WHO answered, so the relative word can be read correctly exactly once. Matching an
environment name against a `runtime:<uuid>` on a coincidence of substrings would have been the
alternative, and it would have proved panes dead by accident on a verdict that authorises closing
them.
