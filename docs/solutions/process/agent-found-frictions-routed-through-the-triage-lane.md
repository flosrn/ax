---
title: Frictions the wave's own agents found were routed through the triage lane, which re-verified measured reports and minted tickets
date: 2026-09-02
category: process
module: omp/roles/orchestrator.md, omp/playbooks/triage.md, src/triage/dispatch.mjs
problem_type: process
component: orchestration
severity: medium
symptoms:
  - "26 `source:agent-found` issues (#78–#103) filed during one dogfood wave, every one already carrying argv, raw output, expected state and cost per the friction contract"
  - "13 triage passes and 7 brief passes dispatched over them — about three hours of opus sessions — before a single repair landed"
  - "Three tickets carved out mid-pass (#78→#102, #88→#98, #84→#103) and one duplicate (#50 / #95) that an open-issue search by concept would have caught"
  - "Ten of the 26 were ten-line repairs (`--brief`→`--notes` hint, a wrong log line, an idempotent label reapplied) that a maintainer closes in an hour with a verdict comment"
  - "One triage pass (#95) ran a 2/48 reproduction under 8-way load — root-cause work the brief and the implementation each redo"
root_cause: lane_widened_to_own_findings
resolution_type: doc_fix
related_components:
  - triage-lane
  - maintainer-channel
  - birth-convention
tags:
  - triage-is-an-on-ramp
  - finder-is-the-verifier
  - ceremony-vs-value
  - carve-out
  - dedup-by-concept
---
# Agent-found frictions routed through the triage lane

## Problem

`omp/playbooks/triage.md` and `omp/roles/orchestrator.md` defined the triage lane as serving
"work that was reported, agent-found, or born as a follow-up". Two of those three are work the wave
itself created. The triage on-ramp exists for a claim of unknown quality — a person's report from
outside — whose first job is to be verified before anyone briefs it (the doctrine this package
adapted it from says so in one line: it is only for issues you did not create, and running it over
your own tickets is wasted work). A friction an agent finds in the instrument is the opposite shape:
the birth contract ("When ax itself is the problem", `orchestrator.md`) already requires argv, raw
output, expected state and cost, so the finder is the verifier and a triage pass re-measures what is
measured.

Two rules in the same role then collided. "When ax itself is the problem" sends a friction to the
`maintainer` session for a verdict comment. "Wave end" said: sweep the follow-ups, park them, and
"before the next spec is planned, run one triage wave over the parked pile". No maintainer session
was up during the wave, the pile grew to 26, and the wave-end rule fired the triage wave over it.

## What it cost

Measured 2026-09-02 on the package's own checkout (wave dogfood-1 → triage-1): 13 triage passes,
7 brief passes, 6 `ready-for-human` verdicts each awaiting an operator ruling, ~3 hours of sessions.
Three carve-outs (#78→#102, #88→#98, #84→#103) — a decomposition the operator never approved, which
is `to-tickets`'s job — and one duplicate (#50/#95). One pass did root-cause work (#95, a real lost
update in the dispatch record) that belongs to the session that takes the ticket, not to the one
that classifies it. And the ceremony's own cost surfaced as more frictions: #97 (proof window),
#100 (release leaves the pane alive), #101 (publish reapplies a birth label) were found by the
triage wave while triaging the previous wave's findings.

## Fix

Prose only, in two package-internal files, in the commit that carries this entry. Neither names a
label: which strings mean inbound or spec-born is the consuming project's `triage.provenance`, and
`CONTEXT.md`'s ratified definition of Inbound (reported, agent-found, follow-up) is left intact —
what changed is the ROUTE, not the vocabulary.

- `omp/playbooks/triage.md`: the child analyses whatever assignment reached it — the dispatch verb
  gated provenance before the child existed — and refuses only a spec-born ticket. Review of the
  first draft (Codex, P1) caught the earlier wording, which had the bundled child refusing on
  ax-specific label literals a consumer never declared.
- `omp/roles/orchestrator.md`: inbound is what triage MAY touch, not what it must. A finding your own
  agents filed gets no pass by default; it goes to whoever owns what was found — the maintainer
  channel for the instrument, the spec flow for the product. Wave end sweeps by provenance, not by
  time window; searches open issues by concept before filing; never carves mid-wave — a draft names
  scope beyond its ticket and the operator decides through `to-tickets`.

## The rules this paid for

**THE FINDER IS THE VERIFIER.** A report that arrives with its measurement attached is not a claim
to verify but a verdict to give. Routing it through a verification pass costs the pass and produces
nothing the report did not already carry.

**A PASS NEVER CARVES.** Splitting scope is a decision the operator makes with the granularity in
front of them (`to-tickets`). A worker or orchestrator that files a sibling mid-pass has decided it
alone, and the sibling then needs its own pass — the ticket count grows by the very mechanism meant
to reduce it.

**DEDUP AT BIRTH, BY CONCEPT.** The redundancy check the triage lane runs before briefing is too late
for a finding the wave itself files; the search belongs before `gh issue create`.

## Enforced, not prose — the third class

ADR 0001 says provenance is enforced by `ax triage dispatch`, not by role text. For spec-born work it
was; for findings it was prose until the operator ruled (2026-09-02) for a third, opt-in class.
`triage.provenance.findings` names the labels meaning "your own agents filed this with its
measurement attached"; `provenanceVerdict` (`src/triage/dispatch.mjs`) refuses a triage or brief
pass over one and names the owning channel as the repair — a maintainer verdict comment for the
instrument, `to-tickets` for the product — and refuses two classes on one ticket as a contradiction
without picking a side. `ax frontier` reads the same class only for the contradiction: a finding that
reached the ready label on its own is takeable, because the class routes passes, never
implementation. Removing a label from `inbound` was never the fix — a label in no class returns
null, which would only have blinded the gate. This repository declares `source:agent-found` as a
finding; a consumer that declares nothing keeps the two-class behaviour to the byte, which is the
opt-in the ruling chose over a contract change every config adopts at once.
