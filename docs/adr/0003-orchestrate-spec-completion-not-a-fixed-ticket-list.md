---
status: accepted
---

# Orchestrate the approved result, not a fixed ticket list

AX's orchestrator is accountable for completing an approved Spec, including necessary work
discovered during execution, rather than merely finishing its initial tickets. Product decisions
remain human-owned; agents make technical decisions within the approved result, constraints and
deployment mandate. This extends execution after Matt Pocock's spec flow; it does not replace
that flow or authorize agents to reopen its decisions.

## The execution contract

1. **Start from approved work.** Keep `grill-with-docs → to-spec → to-tickets` upstream.
   The Spec, assignments, acceptance criteria and blocking edges are the input. There is no new
   planning or triage pass over spec-born tickets simply because execution begins.

2. **Keep the result fixed; allow necessary work to emerge.** The orchestrator examines issues
   workers create and may create an issue itself when observed evidence warrants it. It uses
   triage workers to establish the problem, check existing coverage, assess necessity and propose
   an executable assignment, then decides which issues to dispatch for implementation. Necessary
   work must explain which approved criterion, constraint or deployment obligation would remain
   unsatisfied without it. An adjacent improvement is not necessary merely because an agent
   recommends it. A discovery that changes the approved product result needs a human decision.

3. **Preserve each project's worker procedure.** A worker may run `/lfg` or work directly from
   its issue, according to the consuming project's entry point and contract. It owns that
   procedure's implementation, reviews and repairs; the orchestrator does not repeat them.
   Reuse the evidence already produced. Delegated verification examines the integrated result or
   a concrete gap in coverage, including absent or contradictory evidence, rather than adding a
   mandatory duplicate review to every ticket. Triage likewise reuses a discovery's established
   measurements instead of reproducing them merely to change its classification.

4. **Delegate analysis without splitting responsibility for the whole.** The orchestrator keeps
   overall progress, dispatch and arbitration. It delegates investigations, triage and deeper
   verification instead of reading every transcript or personally repeating each analysis.
   Reuse or adapt Oracle for a second judgment when one can change a decision, not for routine
   approval or voting. This decision creates no permanent role hierarchy and no second
   dispatching orchestrator; the names and lifetimes of any additional roles are not settled here.

5. **Coordinate and recover through the existing evidence.** Keep attributed peer communication,
   Reports, rulings, tracker artifacts and dispatch records as the supports for coordination and
   recovery. Extend them where the required evidence is missing, rather than adding another
   source of tracker truth or depending on one session's memory. A Report is evidence to judge,
   not proof merely because its author declares success.

6. **Keep technical repair with the agents.** A second technical refusal does not automatically
   become a human interruption. Agents choose a useful next action from the observed failure:
   repair, diagnosis, a second opinion, or an explicit blocker. This is not permission to repeat
   the same attempt indefinitely or invent a new dispatch identity after an uncertain mutation.
   A missing product decision remains the human's; only work dependent on that answer stops,
   while independent work continues.

7. **Finish on deployed, verified results.** Before execution, the deployment mandate identifies
   the target, authorized operations and observations that establish success. Completion requires
   the approved result to be deployed and verified under that mandate, including necessary work
   admitted during execution. An impossible verification or an operation outside the mandate is
   a named blocker, not success or implicit authorization. Unrelated issues may remain open;
   finishing the original tickets or closing one Wave does not by itself establish Completion.

## Why not keep the work set fixed?

The initial decomposition cannot guarantee that execution will discover no missing prerequisite
or integration defect. Returning every such discovery to the human preserves a tidy ticket list
but defeats the intended autonomy. Conversely, allowing agents to pursue every improvement makes
completion recede indefinitely. The chosen boundary is the approved result: agents may discover
the work needed to reach it, but may not expand what was promised.

The [measured findings-triage incident](../solutions/process/agent-found-frictions-routed-through-the-triage-lane.md)
remains relevant: repeated investigation of already measured frictions consumed hours and created
duplicates. Its lesson is to reuse evidence and justify the work being admitted, not to forbid
all completion work discovered by agents. The search for an existing issue still precedes creation.

## Existing decisions retained

- [ADR 0001](0001-one-orchestrator-triage-is-a-lane.md) still supplies one dispatching orchestrator
  and triage as a lane. Delegating investigations or judgment does not create competing dispatch
  owners or split one wave's mailbox.
- [ADR 0002](0002-the-report-is-derived-by-ax-and-the-preamble-is-not-patched.md) still supplies the
  derived Report, separate Summary and repair channel. No arbitrary worker-supplied path, second
  `worker_done`, preamble patch or new criteria-validation gate follows from this decision.
- `dispatch.entry` and `dispatch.contract` remain project declarations. Completion does not impose
  one worker pipeline or infer a consumer's deployment procedure from AX's own release process.

## Consequences

Landed with the Spec's tickets, never by citing this ADR mid-Wave:

- Admission of necessary findings (#188): one `Necessary for:` line, graded by
  `src/triage/necessity.mjs`. Spec-born tickets remain refused by the triage lane.
- Delegated verification and a second technical refusal staying with the agents (#189).
- Cycle classification on the frontier (#190): established cycles named in `excluded`, edges
  never rewritten.
- Remote Report retrieval (#193).
- The Spec-scoped Completion read (#191): `ax frontier --spec <ref>` extends the existing
  frontier receipt. It neither chooses a Ticket nor creates a Dispatch identity. Membership is
  one reader (`specMembership` in `src/completion.mjs`): repository-qualified identities,
  pagination proved or unestablished, a Spec with no members distinguishable from a failed read
  and from a proven-absent Spec. The Deployment mandate lives on the Spec as prose
  (`Deployment target:`, `Permitted operations:`, `Observation:`), established by `Observed:` /
  `Blocked:` lines from a login with write access. An absent or unreadable mandate is a named
  blocker, never an implicit authorization. Wave closure remains proof-by-kind and is not
  Completion; an explicit abandonment of a member stays unfinished.

## Implementation boundary

The Spec-scoped read, the admission rule and the second-refusal guidance have landed. Get
bearings (#192), landed notes (#195) and remaining sibling tickets of #174 are still in flight.
Citing this ADR mid-Wave is still not permission to bypass a current refusal. This package's
own Gate and npm release still do not establish a consumer's deployment.
