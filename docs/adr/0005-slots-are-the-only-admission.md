---
status: accepted
---

# Slots are the only admission; the per-repository cap is retired

A dispatch is admitted by **Slots** alone: room on one compute host, computed from that host's measured headroom minus the footprint its live panes reserve. `dispatch.cap` and `dispatch.machineCap` are removed. This reverses the R3 ruling on #88, which made a per-repository count the fairness mechanism. That count was repository-wide and fail-closed, so one host that could not be asked froze every dispatch in the repository, `--on here` included, with a repair (make the host answer) that a host retired on purpose cannot give (#292).

## What admits what

- A dispatch with no `--on` lands on the eligible compute host with the most Slots. A host that cannot be measured offers none and blocks no other host.
- `--on <host>` is refused when that host has no Slot or cannot be measured.
- `--on here` and triage passes run on the operator Mac without a ceiling. The operator named the Mac, or chose the issues; the Mac has no capacity report to count against.
- `ax worker hosts [<host>]` prints, per host, the Slots and their terms, the harness slice's maximum, held, free and peak memory, the host's available memory and the slice's `oom_kill` count, and names the reason a host is skipped.

## Memory is reserved, and an OOM blocks the host

HarnessOS measures and AX computes, as before (KTD9). Slots are taken over the smaller of the slice's free memory and the host's available memory, because a slice cap is a ceiling and not a reservation: measured 2026-10-04, gapicore had 15043 MB available against a 16384 MB slice, so the host could run dry before the slice reached its cap. A rise of the slice's `oom_kill` counter since the operator's last acknowledgement makes the host ineligible until the operator acknowledges it again. `memory.peak` is shown but gates nothing: on kernel 6.8 it cannot be reset and already equals the slice cap on both hosts.

Nothing here makes an OOM impossible. Workers share one slice, so a worker whose real peak exceeds the room left can still be killed, or kill a neighbour. A cgroup per worker would isolate them and is not part of this decision.

## Ending what admission no longer gates

Pane liveness stays a **Verdict**, and INCONNU is still never rounded to MORT (F-028). What changes is that an INCONNU pane only takes away its own host's Slots. **Close** ends one named pane on the operator's word: it requires that pane's host to answer and records an operator ending, never a landed one. When a host was retired on purpose and can no longer answer, a separate host retirement attestation releases its records from the frontier, without claiming that any pane was closed.
