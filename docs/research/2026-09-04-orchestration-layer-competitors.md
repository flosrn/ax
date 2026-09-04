# ax against four orchestration systems

What ax does better, what it lacks, what to take, and what to leave — read from the competitors'
code, not their READMEs. Checkouts live under `~/Code/research/ax-competitors/`. Every claim below
names the file that owns it; a claim marked *doc-only* was found in prose and not in shipped code.

| | code (non-blank lines) | shape | runtime | merge |
|---|---|---|---|---|
| **curia** 0.11.0 (`alp82/curia`) | 133k JS; `daemon/src/dispatch.mjs` = 8 570 lines | always-on daemon + Discord bridge + overseer LLM in its own container | tmux + one Docker container per agent + ttyd + Tailscale | human clicks, then the agent runs `gh pr merge` itself |
| **gascity** (`gastownhall/gascity`) | 1.6M Go | orchestration-builder SDK; zero hardcoded roles; 30 s reconciler tick | Dolt/beads store; tmux, subprocess, k8s, ACP providers | none — punted to packs |
| **issue-orchestrator** | 521k Python | Observe → Plan → Apply tick loop, Control API, dashboard, MCP server | tmux/iTerm PTY; optional Docker; optional HTCondor for CI lanes | humans only; agents hold no credentials |
| **implement-spec** (`mattpocock/skills`, in-progress) | 43 lines of prose | one session drives subagents | whatever runs the skill | LLM merger subagent into one spec PR |
| **ax** 0.21.0 | 24.9k src + 27.9k tests | CLI + one orchestrator session; no daemon; Orca wakes it | Orca (fork) + OMP | `ax pr gate --merge`, deterministic |

`pocock-agents` (`mcdays94`) is two O‍penCode prompts over Matt's skills, no code; it is the shape ax
started from and is not compared further.

## Where ax is ahead — confirmed by convergence

Two of these systems reinvented F-028 on their own: gascity's `ErrRuntimeUnavailable` /
`PartialListError` (`internal/runtime/runtime.go:51-67`, `provider_core.go:8-91`) and
issue-orchestrator's `RepositoryScanIncompleteError` (`ports/repository_host.py:41-52`). That makes
"absence is not zero" a primitive, not a house style. ax is the only one where it is structural —
a third list in `ax frontier` that a caller cannot fold into `takeable` — rather than an exception
a call site can catch: issue-orchestrator's own merge-queue coordinator assumes a comment marker is
present on an incomplete scan (`control/merge_queue_coordinator.py:308-321`), and curia reads a
missing dependency summary as unblocked (`daemon/src/github.mjs:276-285`, `?? 0`, pinned by a test).

The merge path. `src/pr-gate.mjs` pins the head SHA once, runs every ground, writes the record
before `gh pr merge --match-head-commit`, reads `MERGED` back (exit 0 is not a merge), verifies the
bound ticket closed, and measures staleness by ancestry after a fetch. Nobody else has this: curia's
merge is a prose step in `daemon/src/lifecycle.mjs:99-107` that the agent's shell executes after a
click, with no SHA re-check; gascity's `githubmonitor` classifies `BEHIND` from
`mergeStateStatus` (the F-033.2 bug) and never merges; issue-orchestrator's coordinator decides
ENQUEUE/WAIT/REWORK and leaves the merge to a human.

The orchestrator ↔ worker loop. Curia's overseer has no verb that addresses a worker
(`daemon/src/overseerverbs.mjs`); issue-orchestrator deleted `orchestrator.session.send` as "a
prompt-injection primitive dressed up as a convenience method" (`docs/user/mcp.md:290-296`,
`test_register_omits_session_send_tool`); gascity's nudge is text typed into tmux, unattributed;
implement-spec is one-shot. ax delivers peer text as `role: custom`, never `user`
(`omp/peer/receive.ts:576-578`), relays sibling mail through the parent with the origin verified
and `forwardTo` stripped (`omp/peer/send.ts:14-24`), and refuses to answer a route it cannot prove
(`[NO REPLY ROUTE]`).

Write-ahead as the only creation path (`src/worker/record.mjs` `phaseBegin` saves before the
mutation; `start.mjs` exit 4 STRANDED; `dispatch.mjs:723-731` replays `--resume --request`). Curia's
SQLite journal is richer but needs the daemon; implement-spec keeps state in the model's context.

Per-ticket PR on the default branch. implement-spec accumulates every ticket on one spec branch
and closes them at the end, so GitHub keeps every dependent `blocked_by` an open blocker for the
whole run (issue #936); the orchestrating model must hold the real graph in its head.

## Where ax is behind — each verified in ax's own code

1. **`## CRITERIA` is prose, and a second contract overrides it.** `grep CRITERIA src/` finds
   nothing; the contract lives in `omp/playbooks/implementation.md:82-91` and the reading side in
   `omp/roles/orchestrator.md:133-144`. The preamble Orca injects into every worker carries its own
   rule for the same message — `--body must be a 3-sentence executive summary`, long-form artifacts
   go in `--report-path` — and ax names no artifact. Measured on the 2026-09-03 wave (below): 0 of
   8 sections reached the orchestrator's mailbox.
2. **No dependency-cycle class.** `src/frontier.mjs` classifies open `blockedBy` as
   `excluded: blocked-by`; two ready tickets blocking each other look like waiting, and the AFK
   termination condition (`frontier.mjs:22-26`, `docs/plans/2026-09-01-001`) reads as finished.
   gascity walks a three-color DFS at sling time (`internal/sling/cycle.go`);
   issue-orchestrator names the cycle set (`domain/dependency_gates.py:412-428`).
3. **Get-bearings is a four-step prose procedure** (`omp/roles/orchestrator.md:187-205`) — the
   same class of join `ax frontier` was written to take away from the model. And the two detectors
   it composes disagree on INCONNU: `src/worker/gate.mjs` answers exit 0 (safe to re-dispatch),
   `src/worker/settle.mjs` refuses (exit 3). A join that copied gate's disposition would authorize
   a duplicate on `--on <host>`.
4. **One delivery class for peer messages.** Every directed message is injected with
   `{ triggerTurn: true }` and no `deliverAs` (`omp/peer/receive.ts:580-603`); `status` — the
   default type of `peer_send` — wakes or steers exactly like `question`. OMP itself offers
   `deliverAs: 'steer' | 'followUp' | 'nextTurn'` (`oh-my-pi/.../extensions/types.ts:1307-1315`);
   its hook types and CHANGELOG #4923 disagree on what a streaming session does with a bare
   `triggerTurn`. Curia defaults to `queue` and makes interrupt an explicit button
   (`daemon/src/index.mjs:1245-1264`).
5. **Local dispatch is blind to the machine.** `src/worker/hosts.mjs` `proveHost` measures disk
   and cgroup headroom for `--on` remotes only; `placeLocal` runs on the pane cap alone. No
   competitor measures the host before admitting an agent either — issue-orchestrator reads
   `memory_pressure -Q`, `sysctl vm.swapusage` and `top -l 1` idle on macOS, but as warnings that
   never block (`entrypoints/cli_tools/host_load_preflight.py`, exit 0 always).
6. **Delivery skips are logged, never counted.** `PEER MESSAGE LOST` is a note
   (`receive.ts:571`); gascity persists a per-reason skip ledger another process can read
   (`cmd/gc/nudge_dispatcher.go:180-257`, `internal/nudgequeue/state.go`).
7. **Worktree base is proved only at the gate.** No `merge-base` in
   `src/worker/{dispatch,placement,verify,child}.mjs`. implement-spec issue #942: one of three
   implementers went green on a base 77 commits behind.

## Measured: the 2026-09-03 wave, `## CRITERIA`

Twelve implementation dispatches on `flosrn/ax` (records `~/.omp/run/dispatch/{78,80,83,84,86,88,
89,90,94,96,97,102}-*.json`). The playbook that requires `## CRITERIA` landed in `fa5e2d4` at
05:41 UTC (12:41 +0700); the eight session files created from 05:47 UTC on carry the playbook text
with the section (`custom_message` / `skill-prompt`), the four created 05:08–05:19 UTC do not. The
playbook's presence was read from each session file, not inferred from the clock.

| | count |
|---|---|
| workers whose session carries the CRITERIA playbook | 8 |
| wrote a `## CRITERIA` section somewhere | 7 |
| … as pane text after sending `worker_done` (`78`, `84`, `88`, `94`, `96`) | 5 |
| … in a local file (`.agent/report-90.md`, `/tmp/report-97.md`), not referenced by the send | 2 |
| never wrote one (`83`) | 1 |
| `orca orchestration send … --type worker_done` commands carrying the heading | **0** of 17 |
| sends using `--report-path` | **0** of 17 (every send: `--body` only) |
| peer messages carrying `## CRITERIA` across the 34 orchestrator-side sessions of 09-02/03 | **0** |

What the sessions establish: 8 of 8 did not deliver `## CRITERIA` in the channel the orchestrator
reads, and 7 of those 8 had written it. Two contracts govern that message. Orca's injected
preamble (the worker's first user message) rules `--body must be a 3-sentence executive summary
(what you did, what you found, what's left)` and offers `--report-path` for "a long-form
artifact"; ax's playbook rules that the report opens on `## CRITERIA` and names no artifact and no
flag. Every worker obeyed Orca's rule — `94-work` says so in its own words: "worker_done carried
only the contract's 3-sentence body: the full CRITERIA/evidence…" — and none used `--report-path`.
Whether a multi-line body would have travelled was not tested and is not the point: the checklist
has no canonical artifact, so it was rendered twice by two authors and read by neither. This is
curia's incident #49, the one that produced `ENDING` as data (`daemon/src/lifecycle.mjs:1-23`).
Also seen: `96-work` sent `worker_done` six times against a preamble rule of exactly once.

## Take, ranked by evidence over cost

1. **Name the artifact, then read it — on the reference Orca already carries.** What the fork
   does with `--report-path` (`~/Code/flosrn/orca`): the flag becomes `payload.reportPath`, an
   opaque string (`src/cli/handlers/orchestration/message-payload.ts:12-54`); an accepted
   `worker_done` stores it on the task's `result` JSON beside `subject`, `body`, `filesModified`
   (`src/main/runtime/orchestration/lifecycle-reconciliation.ts:276-293`, `settleWorkerReport`);
   federation relays the string cross-host (`federation-sync.ts:285`). Nothing in Orca opens the
   file — its preamble says so: "so the coordinator can find it without a file search". It is a
   durable reference, not a transport. On ax's side `omp/peer/receive.ts` reads `payload` for
   `seq`, `replyTo`, `forwardTo` and heartbeat `phase`, never `reportPath`, and its comment at
   `receive.ts:504-506` ("worker_done … carries no payload at all", measured 2026-08-25) predates
   the preamble that now teaches `--task-id --dispatch-id --report-path`. So there is no transport
   to invent; two steps are missing.
   - **S — ax names the path; nobody reads the worker's.** `payload.reportPath` is free text a
     child wrote and is never opened. The artifact lives at a path ax derives from the dispatch
     record alone — `<recorded worktree>/.agent/report-<request>.md` — the rule `draftPath`
     already enforces for triage (`src/triage/draft.mjs:73-74`: one path, derived independently
     by every party, keyed on the request id). The brief (`src/worker/brief.mjs` `renderBrief`,
     `MECHANICS`) states that path, its shape (first heading `## CRITERIA`, last
     `## LEARNINGS`), and that `worker_done` carries it in `--report-path` while `--body` stays
     the three sentences Orca rules. On the injected completion the receiver opens the derived
     path only, after `resolve` + `realpathSync` proves it sits under the worktree the record
     names (`src/worktree/locate.mjs:47-49,79-85` is the existing proof); a `payload.reportPath`
     that disagrees with the derived path is a named finding, never a second candidate. The read
     is byte-capped and redacted before injection (the `worker transcript` emitters already do
     both). A dispatch whose recorded worktree is on another host (`--on`) is cannot-establish:
     the artifact is on that host, and so is the child's session file, so `ax worker transcript`
     is no repair either — the receipt says "artifact inaccessible from this host" and names the
     path; reading it over the channel `hosts.mjs` already uses for `proveHost` is a later step,
     not assumed. Measure one wave. If the sections arrive, stop here.
   - **M — validate it.** `src/ending.mjs`: a closed array of `{ key, prose(ctx), check(state) →
     {ok} | {refuse, repair} }` rendered twice — into the brief and as `criteriaGround` in
     `src/pr-grounds.mjs` with the sibling grounds' `{notes, unknowns, refusals}` shape, reading
     the path from the dispatch record. `ax worker report --request <id> --file <report.md>`
     wraps the send rather than replacing it: validates the section (first heading; one line per
     criterion the ticket names; a criterion the ticket never named is a refusal; `NOT MET` is a
     refusal; absent section is a refusal, never an empty pass), caps bytes before parsing
     (issue-orchestrator `_MAX_COMPLETION_FILE_BYTES`), records the path write-ahead, then issues
     `orca orchestration send --type worker_done --body <3 sentences> --report-path <file>`.
     Exit 0/1/3. Live predicates (CI, staleness, closing keywords) stay grounds; `ending.mjs` owns
     report shape and criteria coverage only. Build this only if the S step shows sections
     arriving malformed — a missing heading, an invented criterion, `MET` without a command.
2. **Type-aware inject** (S) — a hypothesis, not a finding. One `injectOptions(type,
   { streaming })` at the single seam `omp/peer/receive.ts:580`: `question` / `escalation` /
   `worker_done` keep `triggerTurn: true`; `status` gets `deliverAs: 'nextTurn'`; an unknown type
   wakes (unknown ≠ silence). Drop counters beside `lastSeq`, surfaced on the channel-health
   announcement. Not before probe B: what a streaming session does with a bare `triggerTurn` must
   be read from the OMP build this machine runs, because OMP's hook types, its CHANGELOG (#4923)
   and ax's own comment in `receive.ts` say three different things, and `nextTurn` while idle has
   been measured worse than a visible card (`agent-session-advisor-suppression.test.ts`).
3. **`blocked-by-cycle:#A→#B→#A`** in `ax frontier` (M). Three-color DFS over `blockedBy.nodes`
   restricted to the receipt's candidates; a truncated blocker page stays cannot-establish; the
   AFK termination becomes four empty lists. Repair: break one edge
   (`gh api repos/<slug>/issues/<n>/dependencies/blocked_by`). Not cannot-establish — the cycle
   was established.
4. **`ax worker bearings`** (M), read-only, six structurally distinct lists — `live`, `unknown`,
   `dead-unsettled`, `ended-unmerged`, `takeable` (frontier minus the first three),
   `cannot-establish` — each row carrying the repair its source verb already names. Composes
   `frontier`, `ls.mjs` `describeRecord` (export it), `namedList` from `gate`/`settle` (import it;
   a second parser is the defect `settle.mjs` exists to prevent). Uses settle's disposition on
   INCONNU for "may I create". Exits 0/2/3, never 1. Never mutates, never chooses a ticket.
5. **`proveLocal`** beside `proveHost` (M). Opt-in `dispatch.local.{memFreePercent, swapUsedFloorMb}`
   read from `memory_pressure -Q` and `sysctl vm.swapusage`, once per dispatch after `capVerdict`
   and before `worker start`. Declared floor is a wall; undeclared is silence; unreadable-declared
   is cannot-establish. Never `getloadavg` (counts parked threads on Darwin — issue-orchestrator
   measured it), never a CPU wall, never fail-open to a minimum (gascity `cmd/gc/pool.go`
   `evaluatePool` returns `min` on error).
6. **Landed log** (S). `ax pr gate --merge` appends `landed: #N — <files>` to the wave file.
   implement-spec issue #991: exploration notes written once were wrong by the third landed ticket.
7. **Shared-surface pinning** (S, doctrine + one brief field). When overlap arbitration finds a
   common surface (i18n catalogue, schema, registry), the brief carries the decided names.
   implement-spec issue #988: two implementers minted `blockedSince` and `blockedOn` for one key.
8. **Fingerprint-versioned equipment hash** (S–M). gascity `runtime.ConfigFingerprint` with a
   `vN:` prefix so a binary upgrade rebaselines instead of marking every live pane drifted
   (`engdocs/architecture/session.md`).
9. **Cross-provider cross-check as an opt-in gate ground** (L). Curia ADR-0010 with three
   incident amendments (#223 merge beat verdict by 3 s after a restart; #258; #421 typed verdict):
   findings go to the worker, never the operator; same-provider fallback is stamped weaker.

## Leave

- The daemon and its tick. All three code-backed systems poll because nothing else wakes them;
  ax has Orca for that. Curia's liveness sweep ticks even with `auto_dispatch` off
  (`daemon/src/dispatch.mjs:8451-8464`).
- A store of its own (Dolt, SQLite journal). GitHub already is the store; a second one diverges.
- Docker per agent, Discord as control plane, ttyd/Tailscale, dashboard SPA, VS Code extension,
  HTCondor lanes: each exists because that system has no single orchestrator session.
- The builder merging its own PR after a click (curia) — no SHA re-check at click time.
- `absence = unblocked` (curia `filterTakeable`), `BEHIND` from `mergeStateStatus` (gascity),
  "assume the marker is present" on an incomplete scan (issue-orchestrator).
- Screen-scraping the TUI for provider limits (curia `daemon/src/routing.mjs:427-521`; its own
  header lists the wordings it missed).
- One spec PR closing tickets at the end (implement-spec), unbounded parallel dispatch with no
  overlap pass, a merger subagent for conflict-free merges (issue #1010: bought nothing).
- Zero hardcoded roles as an SDK constraint (gascity's `city-schema.json` is 3 394 lines): ax is
  an opinion, and that is its edge.
- Merge-base at dispatch, for now: placement carries no SHA, one PR per ticket on the default
  branch makes #942 rare, and the gate already self-repairs staleness once.

## Probes that decide the rest

Each remaining item has one observation that settles it; none costs more than an hour on a real
wave.

| probe | decides | state |
|---|---|---|
| A. count reports whose `## CRITERIA` reached the orchestrator | item 1 | done — 0 of 8 |
| B. on a live streaming OMP session, send `peer_send type=status`: steer now, queued-and-ignored, or queued-as-steer? | item 2 | open |
| C. kill the orchestrator pane mid-wave (VIVANT / STRANDED / settled-unmerged / omitted host mixed); trace what the fresh session types before its first dispatch | item 4 | open |
| D. two ready tickets `blockedBy` each other on a test repository; does the orchestrator end the wave on `takeable — 0`? | item 3, or a role patch instead | open |
| E. `memory_pressure -Q` + `sysctl vm.swapusage` under three local children, one week, in `ax worker ls` notes | item 5 | open |

## Sources

Analyses, with file-level citations, were produced against the checkouts on 2026-09-03/04 and
re-verified claim by claim: curia `daemon/src/{dispatch,journal,lifecycle,index,github,routing,
sandbox,githubapp,goodbye,overseerverbs,overseerprompt}.mjs` and `docs/adr/0001-0018`; gascity
`engdocs/architecture/*.md`, `internal/runtime/runtime.go`, `internal/sling/cycle.go`,
`internal/githubmonitor/monitor.go`, `internal/reviewquorum/finalize.go`, `cmd/gc/nudge_*.go`,
`internal/nudgequeue/`; issue-orchestrator `AGENT_PROTOCOL.md`, `docs/architecture/ADR/0002,0004,
0005,0013,0014,0016,0020,0030,0031`, `control/{reconciliation,in_flight_work,worktree_reconciliation,
merge_queue_coordinator,dependency_evaluator,worker_budget,completion_record_validation}.py`,
`docs/user/{mcp,condor_lanes}.md`; `mattpocock/skills` `skills/in-progress/implement-spec/SKILL.md`
(2 commits, both 2026-08-21) and issues #885 #936 #942 #988 #991 #1010 #1014.
