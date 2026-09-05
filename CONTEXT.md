# ax

Vocabulary for ax, the repository-scoped agent experience: it prepares worktrees, equips the
sessions that enter them, and orchestrates work between those sessions. Terms are added as
waves of work fix them; an absent term is still free.

## The work

**Spec**:
The handoff artifact that decides a multi-session piece of work; made of tickets, published
through the spec flow (`to-spec → to-tickets`).
_Avoid_: PRD.

**Issue**:
The tracker's container, as GitHub names it. Being an issue says nothing about whether an
agent may grab it.

**Ticket**:
An issue carrying a complete assignment. Spec-born tickets are tickets by construction; an
inbound issue becomes one only through triage.
_Avoid_: task, item.

**Assignment**:
What to build, independently observable acceptance criteria, and blocking edges — complete
or absent, never partial. It lives in the ticket body (spec-born) or in the Brief (inbound).

**Inbound**:
Work that arrived instead of being planned: reported, agent-found, or born as a follow-up.
The only work triage may touch.

**Finding**:
A ticket the wave's own agents filed while working, carrying its measurement (argv, raw
output, expected state, cost). Inbound by provenance; a triage or brief pass runs over one
only when the issue names the approved Spec obligation it serves. Admission to a pass is
not authorization to implement.
_Avoid_: fourth provenance class, relabelling a finding as inbound.

**Triage**:
The on-ramp analysis deciding what one inbound issue is, landing exactly one of five states
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). It never
runs over spec-born work — that categorization was decided by its spec. A finding without
a written necessity justification against an identified approved Spec is refused.
_Avoid_: readiness, refinement, Definition-of-Ready.

**Brief**:
The Agent Brief — the comment that lands an inbound issue's assignment, the on-ramp's
counterpart of a spec-born ticket's body. The word has this one meaning.
_Avoid_: brief for wave notes, condensed output, or any file passed on dispatch.

**Draft**:
The one file a triage worker writes: a recommendation the orchestrator reads, corrects and
publishes. A draft never mutates the tracker.

**Report**:
The one file an implementation worker writes when its slice ends: every acceptance criterion
of its ticket with the evidence observed for it first, its learnings last. It travels by
reference in the worker's completion, at a location its dispatch decides — never one the
worker names.
_Avoid_: summary, last message, report for the completion's body.

**Summary**:
The three sentences a worker's completion carries in its body — what it did, what it found,
what is left. It points at the Report; it never stands in for it.
_Avoid_: report, executive summary.

**Ruling**:
The orchestrator's recorded answer to one `Q<n>:` question a blocked child sent.
_Avoid_: escalation (the exception, not the mechanism).

## Orchestration

**Orchestrator**:
The one operator session accountable for a Spec's Completion, including necessary work
discovered during execution. It owns dispatch, technical rulings and the validated merge,
while investigations and verification may be delegated.
_Avoid_: coordinator, readiness (retired role).

**Completion**:
The state in which a Spec's approved result is deployed and verified under its Deployment
mandate, including necessary work discovered during execution. Finishing the initial tickets
alone does not establish it. `ax frontier --spec <ref>` derives the read from the Spec's
members, admitted work and mandate; an empty takeable list does not.
_Avoid_: done, shipped (unqualified), closing the Wave.

**Deployment mandate**:
The authorization agreed before execution that identifies the deployment target, permitted
operations and observations required to establish the deployed result. It lives on the Spec
as prose a human writes (`Deployment target:`, `Permitted operations:`, `Observation:`);
missing or unreadable mandate information is a named blocker, not an implicit authorization.

**Dispatch**:
The recorded act of creating one child session for one assignment, written before it is
issued and recovered by replaying that record, never by a second creation.
_Avoid_: launch, start (plumbing), spawn.

**Worker**:
A child owning one implementation slice — one ticket, one worktree, one branch, one pull
request. It never merges.

**Advisor**:
An OMP reviewer attached to a Session. In its notes, `[name]` identifies which named
Advisor spoke; `[ax]` identifies the worktree-scoped Advisor added by ax. `nit`,
`concern` and `blocker` are severities.

**Triage worker**:
A child analyzing one inbound issue. It writes exactly one draft and mutates nothing.

**Wave**:
One fan-out of children of one kind, implementation or triage. Its closure requires every PR
merged or abandoned, or every verdict published; it does not by itself establish the Spec's
Completion.

**Frontier**:
The set of tickets whose blockers are all closed — the boundary between landed and waiting,
in the graph's own sense. `ax frontier` reads it from the tracker and the dispatch store as
three lists: `takeable` (the frontier minus what a record already claims or a rule refuses),
`excluded` (one named reason per ticket), `cannot establish` (a read that failed — never an
empty frontier). A wave advances it; it never schedules it.
_Avoid_: ready set, ready list, queue, backlog.

**Pass**:
One child's analysis of one issue. A triage wave is made of passes.
_Avoid_: pass for the whole fan-out (that is a wave).

**Gate**:
A fail-closed authorization: every ground executes, and nothing stops at the first refusal.
What a refusal blocks belongs to the verb.

**Release**:
Freeing a finished child's pane, proven by its landed artifact, never by its word.

## Liveness

**Pane**:
The terminal a dispatched session runs in, owned by the Orca runtime and read through its
receipts. The only liveness signal a repair path cannot forge.
_Avoid_: terminal (ambiguous with the CLI noun), session (the agent inside, not the surface).

**Inventory**:
The runtime's own list of the panes it still owns, indexed by handle. A truncated or absent
list is a refusal to answer, never an empty machine.

**Verdict**:
MORT, VIVANT or INCONNU for one recorded pane handle. The measurement never rounds
INCONNU down to MORT — what a verb answers on INCONNU is its own disposition.
_Avoid_: alive/dead booleans.

**Omission**:
The set of hosts a receipt did not ask, disclosed per host. An absent pane is a corpse only
when the receipt provably covered its host.

**Disposition**:
What a verb decides on top of a shared measurement — fail-open or fail-closed, per verb,
never inherited from the measurement itself.

## Database isolation

**Stack**:
The set of containers one worktree's database runs in, addressed only by its project id —
the id is the single handle the container runtime gives on it.

**Claim**:
A worktree's recorded ownership of a stack: the port block it took and the project id its
containers run under. A claim is resolved, never re-derived — re-deriving is how a rename
mints a second stack.

**Promotion**:
Moving a checkout from the shared database to its own stack, config and env first, start
strictly last, so an interrupted promotion leaves the app and the config naming the same
project.
