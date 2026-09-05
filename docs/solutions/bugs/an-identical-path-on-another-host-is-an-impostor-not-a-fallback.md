---
title: When a path is derived from a record, the host is part of the address — and an identical path on this machine is an impostor, not a fallback
date: 2026-09-06
category: bugs
module: omp/peer
problem_type: design_rule
component: retrieval
severity: medium
symptoms:
  - "A remote worker's completion carried `Report inaccessible from this host` and no criteria, while the file existed on the host the record named"
  - "The same derived path — `<worktree>/.scratch/report/<request>.md` — exists on the orchestrator's machine too, holding another slice's Report"
  - "`ax.config.json` already declared `dispatch.hosts.<env>.ssh`, so the address was complete and unused"
root_cause: address_missing_its_host_component
resolution_type: code_fix
related_components:
  - orchestration
  - ssh-boundary
tags:
  - derived-paths
  - remote-evidence
  - realpath-containment
  - injected-host-boundary
  - fail-closed
---
# An identical path on another host is an impostor, not a fallback

## Problem

The completion receiver derives a Report's path from the dispatch record and opens that path.
A dispatch placed with `--on <env>` runs its worker on another machine, so the file is over
there — and the receiver stopped, naming the inability. The evidence existed, the transport was
already declared (`dispatch.hosts.<env>.ssh`, the channel `proveHost` uses), and the orchestrator
was handed three sentences with no criteria.

The hazard that shaped the original stop is the real one and it does not go away: **every worktree
tree is laid out identically**, so the derived path usually EXISTS on the reading machine, holding
a different slice's Report. A path derived from a record is not a location until the host is part
of it.

## Fix

`omp/peer/remote.ts` retrieves it from the recorded host: recorded `--on <env>` → the project's
own `dispatch.hosts.<env>.ssh` declaration → one ssh round trip carrying a POSIX-quoted command.
The host answers its own two realpaths and at most `cap + 1` bytes, base64-encoded; the receiver
proves containment on those realpaths and spends the SAME window rule (`boundWindow`) it spends on
a local descriptor. No fallback path exists: a missing declaration, a failed transport or an
unparseable answer is the named inability it always was.

## Three rules this paid for

**The host is part of a derived address, and a same-named local file is never the second candidate.**
Falling back to it is not degradation, it is answering a question about machine A with machine B's
data — the same class of defect as reading `payload.reportPath` because the derived one was
missing.

**Only the owning host can resolve its own symlinks, so proof of containment has to be taken from
its answer, not from the path you sent it.** `cd -P` plus a bounded `readlink` loop rather than
`realpath`/`readlink -f`, because neither is on every host and a probe-and-fall-back is a second
code path answering one question. The host also refuses to send an escaping path — a transport
guard that keeps refused bytes off the wire — while the receiver's own check stays the authority.

**A pipeline's exit status is its LAST command's, so a missing tool at the head of it looks like an
empty file.** `head -c … | base64` with no `head` exits 0 and delivers nothing, which reads as an
empty Report — a finding about the worker for a fault on the host. `command -v` before the read
turns it back into the finding it is.

## How it is proven without a network

The ssh seam is injected, and the suite hands it a local `sh -c`: the composed command runs against
a real temp tree, so the resolution, the loop, the bound and the containment guard are exercised on
macOS (bash in POSIX mode) and on CI's Ubuntu (dash). The receiver's own refusal is proven
separately, with a boundary that returns escaped bytes anyway — because a guard that is only ever
asked nicely is a guard nobody has run.
