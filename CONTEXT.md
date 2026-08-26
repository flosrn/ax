# ax

Vocabulary for ax, the repository-scoped agent experience: it prepares worktrees, equips the
sessions that enter them, and orchestrates work between those sessions. Terms are added as
waves of work fix them; an absent term is still free.

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
