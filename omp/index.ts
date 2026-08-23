/**
 * The one OMP extension this package publishes.
 *
 * WHY ONE FACTORY AND NOT FOUR FILES
 * These four extensions used to be four loose files in `~/.omp/agent/extensions`,
 * each discovered and installed independently by the harness. That arrangement
 * hid the thing that is actually true about them: they are not four features, they
 * are one adapter across a single seam, and they share state through it. The peer
 * registry is where the report extension delivers; the checkpoint writer and the
 * registry write the same board through the same CLI; three of them latch the same
 * session-versus-subagent discrimination. Four independent installs made that
 * coupling invisible, and it drifted — the shared guard existed in triplicate
 * before it was extracted, and the copy that drifts is always the one whose
 * extension is quiet that week.
 *
 * One factory also makes the unit shippable. A project writes a single
 * `.omp/extensions/ax.ts` that re-exports this, and gets the whole adapter at the
 * version its `package.json` pinned — no user-root files, no per-machine install
 * step, no way to end up with three of the four.
 *
 * WHAT IS AND IS NOT IN HERE
 * This owns the part of the Orca/OMP seam that is coupled to THIS product: which
 * model and role a dispatched session serves and how it proves it, how sessions
 * address each other, when a worker reports it stopped, and what the board says.
 * OMP stays the generic model/tool/skill/task runtime and Orca stays panes,
 * worktrees, runs and tasks. Nothing here reimplements either.
 *
 * REGISTRATION IS ONCE, PER SUB-EXTENSION, IN ORDER
 * Each factory below registers its own handlers on the host, and none of them is
 * idempotent — a second call means a second `session_start` handler, a second
 * receive loop consuming the same Run, and a doubled report. So this function
 * installs each exactly once and is itself called once per session by the loader.
 * The order is the order they must observe events in, and it is not arbitrary:
 * `peer` must have latched its session owner and bound its Run before `report`
 * tries to deliver through the registry it publishes.
 */

import checkpoint from './checkpoint/index.ts';
import model from './model/index.ts';
import peer from './peer/index.ts';
import report from './report/index.ts';
import type { FactorySeams, ModelHost } from './model/index.ts';

export type { FactorySeams, ModelHost } from './model/index.ts';
export { loadPlaybook, loadRole, listRoles, playbooksDir, rolesDir } from './model/roles.ts';
export type { PlaybookLookup, RoleLookup } from './model/roles.ts';

/**
 * The host facade, as loosely as this file needs to know it.
 *
 * Deliberately not a re-declaration of OMP's extension API: the four factories
 * below each state the slice they use, and restating the union here would be a
 * fifth description of a shape the host owns — one more thing to drift.
 */
type Host = ModelHost & Record<string, unknown>;

/**
 * Install the ax adapter into an OMP session.
 *
 * `seams` reaches the model/role extension only, because it is the only one whose
 * collaborators cannot be reached from a test any other way. The rest take theirs
 * from their own module boundaries.
 */
export default function ax(pi: Host, seams: FactorySeams = {}): void {
  // Model and role FIRST. It is the only one that returns a system prompt, and
  // `before_agent_start` chains across handlers in registration order — a later
  // extension appending to the array must see the role block already in it, not
  // race it.
  model(pi, seams);

  // Then the channel, which binds the Run and publishes the registry entry the
  // next one delivers through.
  peer(pi as never);

  // Then the two observers, in the order their silence costs the most: a mother
  // waiting on a report that never comes is worse off than a human reading a
  // stale board column.
  report(pi as never);
  checkpoint(pi as never);
}
