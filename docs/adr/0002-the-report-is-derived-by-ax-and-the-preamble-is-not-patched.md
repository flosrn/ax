---
status: accepted
---

# The Report is an artifact ax derives; Orca's preamble is not patched

Two contracts govern a worker's completion message. Orca's injected preamble — the first user
message of every dispatched pane, built by the fork's `buildDispatchPreamble` — rules that the
`worker_done` body is a three-sentence summary and offers `--report-path` for a long-form artifact.
ax's implementation playbook ruled that "every report opens on `## CRITERIA`" and named no artifact.
Measured on the 2026-09-03 `flosrn/ax` wave: of eight workers dispatched with that playbook, none
delivered the section in the channel the orchestrator reads — seven wrote it as pane text or in a
file they named themselves, one not at all, and no send used `--report-path`. Every worker obeyed
the preamble. Decided with Flo 2026-09-04: the preamble owns the lifecycle message and stays as
upstream ships it; ax owns the work artifact and says so in the last text a worker reads, the
brief Orca appends as the TASK block. The artifact is the **Report** (`CONTEXT.md`), and its
location is derived from the dispatch record — `<worktree>/.scratch/report/<request>.md`, the rule
`draftPath` already applies to triage — never a path the worker names.

## Consequences

- The brief opens its mechanics with the precedence rule once: the preamble speaks for the
  runtime; where this brief says otherwise, this brief wins. That sentence replaces point-by-point
  overrides (the heartbeat override already worked this way).
- The `worker_done` body is the **Summary** — the preamble's three sentences. The Report travels by
  reference in `--report-path`; the reference is for Orca (it lands on the task's result) and for a
  human. Nothing in ax ever opens `payload.reportPath`: the receiver opens the derived path only,
  after `resolve` + `realpath` proves it sits under the worktree the record names. A reference that
  contradicts the derived path is a named finding; an absent reference with the file present is a
  note. A worktree on another host is RETRIEVED from that host: the recorded `--on <env>`, the
  project's `dispatch.hosts.<env>.ssh` declaration and the record's own worktree are the address,
  the owning host resolves its own realpaths and the receiver proves containment on them before
  accepting a byte. Missing declaration, failed transport or unproven evidence keeps the existing
  "Report inaccessible from this host" finding with a repair; no same-named local worktree and no
  neighbouring local Report is ever read in its place.
- The receiver injects the Report after the Summary, byte-capped and redacted, and a missing Report
  as a named finding on the completion it still injects — never a withheld completion, never an
  empty pass. A `failed` outcome writes a Report too, with `NOT MET` lines.
- The Report is one living file per request: a repair round after `worker_done` rewrites it in
  place, and whoever decides reads the file as it is then. A gate refusal reaches the worker as a
  peer message and is supervised work on the same slice — repair, rewrite the Report, report by
  the board card, never a second `worker_done` (Orca settles the first; `96-work` sent six).
- The derivation rule exists once per runtime — `src/worker/` for the brief, `omp/peer/` for the
  receiver — pinned by a parity test that reads one record on both sides and demands one path, the
  way `tests/record-parity.test.mjs` pins the record readers.
- Questions from an implementation worker go through the attributed peer tools, never the
  preamble's `orca orchestration ask`; that verb stays the triage lane's, under `ax triage ask`.
- Validating the Report's content — a `criteriaGround` in `pr-grounds.mjs`, a verb that refuses a
  criterion the ticket never named — is a later decision, taken only if a measured wave shows
  Reports arriving malformed.

## Considered options

- Patch the preamble in the fork to say the ax version — rejected for now: `PreambleParams` has no
  template hook, the text is hard-coded under a snapshot test, so every upstream merge conflicts;
  the preamble serves every dispatch on the machine, including agents and repositories without ax;
  and it would tie ax to one build of one fork. Kept in reserve for the one sentence the brief can
  only override — "ignore stale follow-ups from the settled task" — if repair rounds by peer message
  prove insufficient.
- Repair rounds as fresh recorded dispatches on the same pane — Orca's own model, one identity per
  round — deferred: it needs a verb that delivers a refusal as a TASK block and proof that
  `worker-start` re-engages a settled pane; a sentence in the brief stops the duplicate
  `worker_done` today.
- Storing the derived path on the record at dispatch — rejected: a second place that can disagree
  with the rule; the same reason `draftPath` is derived by every party independently.
- Removing the preamble — impossible: it carries the handle, the dispatch capability and the ids
  Orca requires on every lifecycle message, and ax reads it as the child's witness.
