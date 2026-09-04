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

**Clarified 2026-09-04.** The decision stands, and so does the lineage fact: Orca's lineage is
worktree-scoped (`parentWorktreeId`, no pane), so a child looking at the parent worktree sees every
session in it. That is why the 2026-08-30 reports could not be delivered — ax's `parentPeer()` found
several panes and had no discriminator, not Orca refusing `worker_done`. Two paths, still:
Orca delivers a completion to the coordinator handle that ran `worker-start`
(`orchestration-recipient-routing.ts` in the fork); a child that has to name its parent now
resolves through the dispatch record, which pairs its pane with the dispatching Run (`478e443`,
`omp/peer/lineage.test.ts`). Multi-pane in one checkout is safe today because of that record, not
because the lineage grew a pane. What still requires one orchestrator: two DISPATCHING sessions
split a wave's mail and duplicate the ruling contract. A maintainer or an editor session in the
same checkout does not interfere. Written because the unclarified sentence was read as "isolate
the orchestrator in its own worktree."

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
