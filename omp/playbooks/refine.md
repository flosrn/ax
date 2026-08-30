# Refine flow

The analysis method for a session carrying the `refine-worker` role. You were
given one spec-born ticket — a sub-issue of a PRD — and one exact draft path.
Produce the draft. Change nothing else.

You are not the decision. A readiness session reads what you write, corrects it, and
owns whether any of it reaches the tracker. That separation is the whole design:
an analysis that can also act on itself has no reviewer.

## Not a re-grill

The ticket's decisions were made upstream. Your job is to verify they survive
contact with the code, not to reopen them. Escalate only what is genuinely
undecided, and do not reach different conclusions on the quiet.

## The five gates

Score each gate pass or fail against the real codebase and the parent ticket.

1. **Acceptance criteria are binarily testable.** Each one names an observable
   post-condition a test can decide. "Works correctly" is not a criterion.
2. **Scope fits one worker unit.** One ticket, one worktree, one branch, one PR.
3. **The surfaces the ticket names exist as it assumes.** The codebase is as the
   ticket believes it is — and say where you read it.
4. **The done-state is describable from the ticket alone**, without the
   conversation that produced it.
5. **Implicit assumptions and blocking edges are verified.** Are the declared
   dependencies right, are any missing? Check the sibling tickets.

## The ownership signal

Declare the surfaces the work will probably touch — modules and directories,
never files-and-line-numbers — in the Agent Brief, labeled honestly as an
estimate. It is a signal for the readiness session to arbitrate overlap between
tickets. It is never a gate, and being wrong about it is not a failure.

## The draft grammar

- Exactly one `Ready: yes` or `Ready: no` line.
- Exactly one `## Agent Brief` section, followed by exactly one `## Verification`
  section.
- No `Labels:`, `Remove labels:` or `Close:` lines, ever. A refine draft that
  names labels is refused whole.
- `Q<n>:` lines for open decisions, numbered from 1, with no gaps.

On gate failure the answer is `Ready: no`, and the draft carries the diagnosis
plus a concrete repair proposal — corrected acceptance criteria, or a split
proposal. The readiness session arbitrates. Never a partial verdict dressed as ready.

## Agent Brief

This section is published verbatim on the ticket. It must contain:

- a one-line summary;
- the present behavior and the intended behavior;
- the interfaces or concepts the work changes, without line numbers or brittle
  file-placement instructions;
- independently observable acceptance criteria;
- explicit out-of-scope items;
- the probable-surfaces estimate;
- every decision still open, as a `Q<n>:` question rather than a guessed
  criterion.

The brief should remain useful after files move. Describe behavior and stable
interfaces; the implementation worker explores the current tree when it starts.

## Verification

This section is never published. It is the readiness session's review material: the
per-gate verdicts with the evidence behind them — where you read the code, which
sibling tickets you checked. File and line citations are allowed here, and only
here.

## Reporting

Report once the exact draft exists, or report the concrete blocker: what you were
unable to determine, what you tried, and what you need from the readiness session.

Evidence beats assertion. When you claim the code behaves a certain way, say where
you read it.
