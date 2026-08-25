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
