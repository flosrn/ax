---
title: Report-backed merges - Plan
type: feat
date: 2026-10-04
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---
# Report-backed merges - Plan

## Goal Capsule

- Objective: An operator cannot merge through AX while the ticket's acceptance evidence is missing, unmet or approved for another revision.
- Means: Add an adopted Report approval ground to the existing merge gate (KTD1).
- Authority: The user-approved requirements below govern implementation; project doctrine governs existing seams.
- Execution: Native implementation, behavior-first tests, authoritative verification by the parent.
- Delivery: Implement and verify AX, then adopt its released contract in `flosrn/harnessos`. Publish only owned repositories. CI failures remain blockers to merge, never permission for a local-tests fallback. HarnessOS adoption is delivered as an open PR when CI or its declaration checkpoint blocks landing.
- Stop conditions: A material failure of the approved contract, unavailable release prerequisites, or production mutation outside the request.

---
## Product Contract

### Summary

AX will require a complete Report and an explicit acceptance judgment before an adopted repository can merge a ticket.
HarnessOS will declare its mandatory CI checks and use the same approval, merge and cleanup sequence.

### Problem Frame

HarnessOS changes were squash-merged with unavailable GitHub CI and without AX's merge gate.
One change broke typechecking; another changed the scope of an acceptance measurement to claim success.
The existing gate checks CI and revision currency but does not inspect acceptance evidence.

### Key Decisions

- Add a Report gate, not only HarnessOS instructions (session-settled: user-directed — chosen over adoption alone: acceptance evidence must block the AX merge path). Governs R1–R5.
- Continue without server branch protection (session-settled: user-directed — chosen over upgrading GitHub first: configure accessible AX protections and disclose direct-merge bypass). Governs R6.

### Requirements

**Acceptance evidence**
- R1. Adoption is explicit in `prGate`; when adopted, a ticket merge requires an approval for the same repository, PR, ticket and current head.
- R2. The Report reproduces every authoritative acceptance criterion verbatim and in order; missing, duplicated, added or reformulated criteria refuse approval and merge.
- R3. Every criterion records its status, the command or artifact inspected, and the observed result; missing evidence and `NOT MET` refuse approval and merge.
- R4. Approval is an explicit orchestrator judgment, bound to the Report bytes and current assignment; a pushed head, edited assignment, changed Report or changed base invalidates it.
- R5. AX validates the evidence contract, not the truth of arbitrary prose; amendment requires an explicit change to the ticket's criteria or its authorized Agent Brief, followed by fresh judgment.

**Merge and lifecycle**
- R6. Existing CI, review and git grounds still execute; missing CI is never replaced by local tests, and this change does not claim to block direct GitHub merges.
- R7. HarnessOS declares both unconditional adapter jobs and documents approval → gate merge → worker release → exact worktree reclaim; optional installed-target qualification is not an unconditional CI requirement.
- R8. Cleanup retains existing dirty, occupied, unlanded and claimed worktrees; no branch sweep or retrospective fabricated Gate record is allowed.

### Acceptance Examples

- AE1. A green CI with one omitted or unmet criterion does not authorize a merge. Covers R2, R3, R6.
- AE2. An approved Report stops authorizing when its bytes, ticket criteria, head or observed base change. Covers R4.
- AE3. A runtime criterion has a concrete observation; a test-only statement is judged insufficient by the orchestrator, not magically certified by AX. Covers R3, R5.
- AE4. An unavailable GitHub check refuses even with an approved Report. Covers R6.
- AE5. A squash-merged worktree with no Gate merge record is retained rather than declared safe to remove. Covers R8.

### Scope Boundaries

No semantic AI judge, automatic waiver, fabricated runtime proof, GitHub billing change, repository visibility change, production host apply, or global branch cleanup.
Existing release-bot PR classification remains ticketless and exempt from the ticket Report, but not from CI.
Other consumers retain their existing merge contract until they explicitly adopt Report approval.

---
## Planning Contract

### Key Technical Decisions

- KTD1. **One Report module behind the merge ground.** `src/pr/report.mjs` owns source comparison, Report parsing and the read-only ground; `src/pr-gate.mjs` composes it without a second interpretation.
- KTD2. **Markdown Report with versioned machine evidence.** Keep `## CRITERIA` as the receiver's visible section and place one fenced JSON block inside it containing repository, ticket and ordered criterion/evidence rows. The Report carries no commit id: parent delivery can precede the commit. Free prose and `## LEARNINGS` remain outside the machine block.
- KTD3. **Invocation-local judgment.** A detector prints an acceptance digest after validating the current assignment and Report. `ax pr gate --merge --accept-report <digest> --reason <judgment>` explicitly approves exactly that read; the existing merge journal records the judgment. There is no persisted reusable approval and no new approval command.
- KTD4. **Current assignment from the tracker.** The latest attributed authorized Agent Brief supersedes the body; the body supplies criteria only when no such Brief exists. Comment pagination must be proved. Rulings and `--task` that amend criteria must first land on that source. Only a nonempty unambiguous Acceptance criteria section supplies the criterion list.
  Accept a case-insensitive ATX heading or bold label named `Acceptance criteria`; its section ends at the next peer heading or bold label. Each criterion is one top-level bullet or numbered item, with its marker and optional checkbox removed. Preserve its text and newline-separated continuation/nested content after common indentation removal; normalize CRLF only. Ignore headings inside fenced code. No duplicate sections, empty list, pre-list prose or duplicate criterion text is accepted. This canonical source text is what R2 compares verbatim.
- KTD5. **Derived raw Report, not copied injection.** Resolve the exact dispatch record for the PR's branch and ticket, derive its Report path, and read bytes on the owning host. Move the existing remote transport into `src/worker/remote-report.mjs` and migrate all consumers. Hash before redaction; never execute Report commands or put text in shell arguments. A missing or ambiguous dispatch is a named inability, never a guessed Report.
- KTD6. **One digest binds all observed evidence.** The acceptance digest includes repository, PR, ticket, head, observed base, assignment identity and Report bytes. Changed evidence refuses the supplied digest, including repair pushes and `--update-branch`; the orchestrator must inspect and judge the fresh read.
- KTD7. **No automatic historical cleanup.** Adopt the existing release/reclaim workflow in agent instructions and help; existing manually merged worktrees require operator-established evidence because no Gate record exists.

### High-Level Technical Design

The protocol is `tracker criteria + derived raw Report + PR head/base → detector digest → explicit merge-time judgment → all merge grounds → recorded merge → release → reclaim`.
The acceptance states are unestablished, complete but unaccepted, and accepted for this invocation; only the last can authorize a merge.
The tracker owns criteria, the worker authors evidence, the orchestrator judges it, GitHub owns check conclusions, and AX owns revision binding and the durable merge record.
The invocation-local judgment follows the existing `--ack-body` convention while binding the exact evidence rather than persisting stale approval state.
No judgment grants GitHub permissions or constrains a process holding the same credentials outside AX.

### Risks and Dependencies

- HarnessOS Actions currently returns failed jobs; account billing was reported unavailable. No merge is authorized while those mandatory jobs fail.
- GitHub protection APIs return 403 for the private repository's account tier. Direct merge bypass stays possible by user choice.
- Report adoption changes the worker evidence format. The receiver must ignore headings inside fenced code when finding the CRITERIA section's end and retain its existing bounded-injection refusal.
- Approval and merge read the raw derived Report directly, including after a repair; redacted or truncated completion injection is not approval input.
- GitHub comments and source updates are not an atomic snapshot. Fresh reads immediately before merge bound the observed assignment but do not promise to freeze GitHub edits.

### Sources

`src/pr-gate.mjs` and `src/pr-grounds.mjs` own merge authorization and head binding.
`src/worker/record.mjs` owns locked durable writes.
`src/worker/report.mjs` and `omp/peer/completion.ts` own Report derivation and bounded injection.
`src/triage/publication.mjs` owns attributed Agent Brief identity.
`src/worktree/reclaim.mjs` owns squash-safe cleanup and preserves targets without Gate records.
HarnessOS `.github/workflows/qualification.yml` defines the two mandatory adapter check names, observed through GitHub on PR 87.

---
## Implementation Units

### U1. Validate acceptance evidence

**Goal:** Provide one executable evidence contract for the current ticket and revision.
**Requirements:** R1–R5; AE1–AE3.
**Dependencies:** None.
**Files:** `src/pr/report.mjs`, `src/worker/remote-report.mjs`, `omp/peer/remote.ts`, its consumers and tests, `tests/pr-report.test.mjs`, `ax.schema.json`, `docs/ownership.md`.
**Approach:** Implement KTD1–KTD6, explicit adoption and injected gh/git/ssh readers; migrate the existing remote transport cleanly rather than duplicate it.
**Execution note:** Begin with consumer-visible refusal and invalidation tests before production changes.
**Patterns to follow:** `src/pr-gate.mjs`, `src/triage/publication.mjs`, `src/worker/report.mjs`, `omp/peer/remote.ts`.
**Test scenarios:**
- Complete current criteria and observed evidence produce a stable acceptance digest.
- Omitted, extra, reordered, duplicated or paraphrased criteria refuse.
- Empty evidence or `NOT MET` refuses.
- Absent, truncated or ambiguous assignment and malformed/oversized Report fail closed.
- Both heading and bold-label criteria, checkbox lists and wrapped/nested content yield the same preserved source text; duplicate sections and code-fenced impostors do not grant criteria.
- An unreadable author permission or non-authoritative Brief cannot supply criteria; an attributed authorized Brief supersedes the body.
- A moved head, base, edited assignment or changed Report changes the acceptance digest.
- Remote reads retrieve the owning host's bytes; an escaped path, unavailable host or incomplete read never falls back locally.
**Verification:** Real temp repositories and the existing POSIX transport tests establish complete evidence and all refusals without network mutation.

### U2. Block merges on acceptance state

**Goal:** Make adopted merge authorization consume the approval contract.
**Requirements:** R1, R4, R6; AE1, AE2, AE4.
**Dependencies:** U1.
**Files:** `src/pr-gate.mjs`, `src/commands.mjs`, `tests/pr-gate.test.mjs`, `tests/commands.test.mjs`.
**Approach:** Add one non-short-circuiting ground and invocation-local digest/reason flags; preserve replay and CI semantics and journal the explicit judgment.
**Patterns to follow:** Existing grounds' notes/unknowns/refusals, `--ack-body` locality and exact-head mutation.
**Test scenarios:**
- Green CI without explicit acceptance never issues a merge.
- The current digest and explicit reason with passing grounds issue the existing head-matched merge.
- All changed-evidence variants refuse a stale digest and issue no merge.
- Failed or absent CI still refuses with current acceptance.
- A parent-delivery Report without a commit id is accepted after the parent commits and judges it.
- A branch update invalidates the original digest and requires a fresh judgment.
- Non-adopted and recognized release-bot PRs keep existing behavior.
- Invalid adoption and attempts to weaken adoption fail closed.
**Verification:** The existing gate suite and integrated digest-to-gate tests pass; smoke runs the real CLI against synthetic local gh/git adapters.

### U3. Equip workers and orchestrators

**Goal:** Teach producers and consumers the executable contract without treating prompts as a permission barrier.
**Requirements:** R2, R3, R5, R7, R8.
**Dependencies:** U1, U2.
**Files:** `omp/playbooks/implementation.md`, `omp/playbooks/triage.md`, `omp/roles/orchestrator.md`, `src/worker/brief.mjs`, `omp/peer/completion.ts`, `omp/peer/completion.test.ts`, `README.md`, `CONTEXT.md`, relevant existing OMP integration tests.
**Approach:** Preserve the receiver's CRITERIA section, document the machine evidence format and explicit judgment, and require acceptance amendments to be published before they can govern adopted work.
**Test scenarios:**
- A real Report in the new format reaches the existing receiver without being treated as a partial criteria list.
- Fenced heading-like lines do not terminate CRITERIA.
- Gate help identifies the judgment and its invalidation conditions.
**Verification:** OMP integration suite and copyable CLI help smoke; delete incidental source-text wording assertions instead of repinning them.

### U4. Adopt in HarnessOS

**Goal:** Apply the released AX contract to future HarnessOS merges.
**Requirements:** R6–R8; AE4, AE5.
**Dependencies:** U1–U3 and published AX release.
**Target repository:** `flosrn/harnessos`.
**Files:** `ax.config.json`, `AGENTS.md`, `package.json`, `bun.lock`, existing operational docs if needed.
**Approach:** Declare the two exact unconditional adapter checks and Report adoption; pin the release with Bun; document runtime evidence and post-merge lifecycle. Deliver one adoption PR, never a direct push to main.
**Test expectation:** No new config-text assertions; use real config validation, CLI detector and frozen install smoke.
**Verification:** `ax doctor --project` accepts the adopted config; the installed CLI reaches actual CI/Report refusals rather than Ground 0; frozen Bun install proves pin/lock alignment. The declaration guard's human checkpoint is expected on the adoption PR; leave it open while CI or that checkpoint blocks landing.

---
## Verification Contract

- AX: focused `node --test tests/pr-report.test.mjs tests/pr-gate.test.mjs tests/commands.test.mjs`, then `pnpm test` after integration.
- OMP: existing `pnpm run test:omp`, including Report transport with the new section format.
- Runtime: CLI help plus throwaway real CLI scenario proving detector digest, accepted merge, and stale/absent-CI refusal without real GitHub mutation.
- HarnessOS: frozen Bun installation, `bunx tsc --noEmit -p .`, focused relevant tests, `ax doctor --project`, and real read-only `ax pr gate` invocation.
- Quality: Simplification and code review of the implemented diff; apply only grounded in-scope findings.

---
## Definition of Done

- U1 evidence validation checks full criteria and observations and computes a digest binding the raw derived Report, assignment, head and base.
- U2 adopted gate refuses missing or stale invocation-local acceptance without suppressing other grounds.
- U3 roles, playbook, brief and help describe the same executable contract and its truth/permission limits.
- U4 is delivered as a HarnessOS adoption PR with the released pin, matching lockfile and mandatory checks; CI and the declaration checkpoint are named if it cannot land. An unavailable publication prerequisite is reported with all reachable changes complete.
- No production apply, unapproved billing change, branch sweep, fabricated approval, backward compatibility shim or abandoned scaffold remains.
- Actual test and smoke evidence is reported; unavailable GitHub CI and server protection remain explicit blockers, not successes.
