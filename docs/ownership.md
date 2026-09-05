# Ownership map

Every module's doctrine — its incidents, caveats and the rule it enforces — lives in its own
header, and that header is the authority. This map only routes: look your file up, read its
header, then patch. `tests/docs.test.mjs` keeps the map complete in both directions — every
`src/` module has a row or a named exemption, and no row points at a module that is gone.

| Path | Owns |
|---|---|
| `src/delegation.mjs`, `bin/ax.mjs`, `src/cli.mjs` | global command → exact project version → CLI delegation |
| `src/plan.mjs` | what a project SHOULD carry: the checkout that publishes ax, and which contracts its configuration adopted |
| `src/init.mjs`, `src/doctor.mjs` | project inference, managed wiring, recorded state vs reality |
| `src/worktree/plan.mjs`, `src/worktree/probes.mjs` | every worktree decision and every machine fact it consumes |
| `src/worktree/identity.mjs`, `src/worktree/ports.mjs`, `src/worktree/supabase.mjs`, `src/worktree/addressing.mjs` | the rules composed by the plan |
| `src/worktree/setup.mjs`, `src/worktree/list.mjs`, `src/worktree/clean.mjs`, `src/worktree/remove.mjs`, `src/worktree/doctor.mjs` | the worktree verbs; render and write, never decide |
| `src/worktree/context.mjs` | `.agent/worktree-context.local.md`, read by a cold agent |
| `src/worktree/locate.mjs` | proof that a destructive worktree target belongs to ax |
| `src/worker/record.mjs` | write-ahead dispatch/release identity and exact replay |
| `src/worker/report.mjs` | the Report's path — one rule crossed by both the brief a dispatch composes and the reader of the completion that arrives, never a path the worker named |
| `src/worker/start.mjs`, `src/worker/dispatch.mjs`, `src/worker/repair.mjs`, `src/worker/release.mjs`, `src/worker/settle.mjs` | write-ahead plumbing, the one creation verb, repair, close, and the ending written for an attempt the gate proved dead |
| `src/worker/placement.mjs`, `src/worker/verify.mjs` | where a ticket's worktree lands; the four proofs a DISPATCHED receipt carries |
| `src/worker/pane.mjs`, `src/worker/ls.mjs`, `src/worker/tail.mjs`, `src/worker/gate.mjs`, `src/worker/stall.mjs`, `src/worker/transcript.mjs` | liveness and capacity, counted from panes — including the host-aware inventory a cap is counted against |
| `src/worker/continuation.mjs` | which verb continues a record whose pane is gone — decided once from that branch's pull request, printed by both `ls` and `tail` |
| `src/worker/capacity.mjs` | the two caps this count is gated by: this repository's `dispatch.cap`, the opt-in `dispatch.machineCap`, and the one refusal both dispatch verbs print |
| `src/worker/slots.mjs` | the one reader of the count a cap gates: which recorded agent pane is up, keyed on the pane and never on the dispatch that owns it |
| `src/worker/delivered.mjs` | did the child's own session record the brief — the witness that outranks a receipt |
| `src/worker/capability.mjs` | the dispatch capability a child was handed, read from its own preamble — and the bound that keeps a mention from passing as a grant |
| `src/worker/sweep.mjs` | reclaiming processes a dead worktree left behind, by pgid and never by name |
| `src/worker/brief.mjs`, `src/worker/child.mjs`, `src/worker/ticket.mjs`, `src/worker/hosts.mjs`, `src/worker/peers.mjs` | assignment, child setup — including the AX bundle a child must load before it is dispatched — tracker, placement and parent route |
| `src/triage/dispatch.mjs`, `src/triage/ask.mjs`, `src/triage/answer.mjs`, `src/triage/publish.mjs` | one analysis session per issue, questions, corrected publication — and the provenance refusal that keeps triage an on-ramp for inbound work only |
| `src/triage/provenance.mjs` | which classes a ticket's origin can be, and when a declared name matches a carried label — one vocabulary for the three verbs that judge it (`triage dispatch`, `triage publish`, `frontier`) |
| `src/triage/necessity.mjs` | the one line that admits a finding to a pass — an identified approved Spec and a written obligation, read from the issue itself; unknown is not absent |
| `src/triage/publication.mjs` | the attribution a triage job and Pass stamp on their comment, and the rule that recognizes it — one vocabulary for the two verbs that publish and close on it (`triage publish`, `worker release`) |
| `src/triage/spec.mjs`, `src/triage/capacity.mjs` | the one-line instruction a child receives; the anti-rival pass gates (the caps left for `src/worker/capacity.mjs`, which both dispatch verbs read) |
| `src/triage/index.mjs`, `src/triage/release.mjs` | `status` — what each pass recorded, waits on and drafted, and whose pane still owns its draft; issue → pass → dispatch, then delegate |
| `src/triage/draft.mjs`, `src/triage/rulings.mjs` | pass identity, draft sha and `Q<n>:` lines; the ask/answer bodies and their header |
| `src/pr-gate.mjs`, `src/pr-grounds.mjs` | every merge ground, executed against the exact head SHA and the base commit this run observed — one function per ground, the verdict in gate() |
| `src/frontier.mjs` | the takeable ticket set, classified from tracker truth and the dispatch store — read-only, one named reason per exclusion |
| `src/board.mjs` | the one monotonic writer of a worktree checkpoint |
| `src/pin.mjs` | exact npm release migration, install proof and doctor; never git |
| `src/orca-bin.mjs` | Orca binary resolution and JSON receipt parsing for CLI verbs |
| `src/log.mjs` | the one shape of a check result — a `bad` without a `fix` is a finding nobody can act on |
| `src/exec.mjs`, `src/git.mjs`, `src/gh.mjs` | process spawning (status-as-data, one default adapter), root/main derivation, the repository as `gh` names it |
| `src/redact.mjs` | every authority-token shape, replaced before any verb displays child-authored text |
| `src/blocks.mjs`, `src/dotenv.mjs`, `src/hash.mjs`, `src/proc.mjs`, `src/supabase-guard.mjs` | managed block edits, env files, deterministic naming, pgid lookup, the shared-database guard |
| `omp/index.ts` | public OMP factory; model → peer → report → checkpoint order |
| `omp/model/index.ts`, `omp/model/activation.ts`, `omp/model/roles.ts`, `omp/model/role.ts` | marker and `/role` activation, bundled role/playbook loading, proof — and why session roles are never OMP task agents |
| `omp/roles/`, `omp/playbooks/` | orchestrator, worker, triage-worker and maintainer contracts |
| `omp/peer/` | independent-session addressing, messaging, attribution and receive loop |
| `omp/peer/completion.ts` | the Report a worker's completion carries: the receiver's twin of the path rule, the containment proof, the cap — and the dispositions it is named under |
| `omp/peer/remote.ts` | retrieving that Report from the host the record names: the ssh boundary, the answer's shape, and what a host may refuse to send |
| `omp/peer/diagnostics.ts` | persisted send/receive diagnostic reasons a restarted session can read, and the coverage they do not claim |
| `omp/report/`, `omp/checkpoint/` | completion/questions and board updates |
| `omp/shared/ax.ts`, `omp/shared/board.ts`, `omp/ax-run.mjs` | package-local ax invocation and the one board-write spawn; never PATH or a global version |
| `src/config.mjs`, `src/schema.mjs`, `ax.schema.json` | the per-repository contract and defaults |
| `src/commands.mjs` | command registry: help sections, who asked for help (flag arity, passthrough), visibility, plumbing and generated AGENTS.md lines |
| `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/publish.yml` | version, changelog, tag, GitHub Release and OIDC npm publish |
