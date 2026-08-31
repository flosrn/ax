---
status: accepted
---

# One orchestrator; triage is a lane, not a role

ax served orchestration through two operator roles: `orchestrator` (implementation waves) and
`readiness` (the triage on-ramp). Both dispatched the same children, so their contracts duplicated —
`orchestrator.md` carried readiness's entire ruling section verbatim — and running them side by side
made the parent worktree multi-pane. Measured 2026-08-30 (ofmchat spec 2, #117 and #113 in one
night): every finished child of that shape was told its report could not be delivered, because
Orca's lineage stops at the worktree. Decided with Flo 2026-08-31: one `orchestrator` session
dispatches both lanes — implementation and triage — rules its children's questions, and owns the
validated merge. The `readiness` role is deleted. The ratified vocabulary lives in `CONTEXT.md` at
the repo root.

## Consequences

- The CLI noun follows the activity: `ax ready` returns to `ax triage`. v0.15.0 renamed it the
  other way because "the noun names the artifact both flows converge on" — but the same release
  removed the refine lane, after which the spec flow never enters this surface at all
  (`to-tickets` publishes `ready-for-agent` itself). The convergence rationale expired in the
  release that stated it. What made `triage` dangerous as a name — inviting a pass over spec-born
  work — is enforced, not prose: dispatch refuses by provenance.
- One creation verb: `dispatch`, the recorded act of creating a child session. `worker launch`
  becomes `worker dispatch`; `worker start` is demoted to plumbing (write-ahead record and replay),
  out of the agent-facing surface.
- ax stays flat at the CLI: future domains (automated checks, architecture rules, context rules)
  arrive as their own nouns grouped by help section, never as a nesting prefix — the `gh` shape,
  not the `gcloud` shape.

## Considered options

- Keep two roles with a sharper split — rejected: the split cannot be sharp. Sweeping follow-up
  issues into triage waves is the orchestrator's own wave-end duty, so the ruling contract must
  live in both roles either way; the duplication was structural, not accidental.
- Keep `ax ready` — rejected: its verbs serve only the on-ramp (the spec flow never calls them),
  and it reads wrong as a phrase (`ready dispatch`, `ready answer`).
