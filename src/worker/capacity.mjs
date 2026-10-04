// Transitional cap arithmetic retained until the Slots-only cutover (U4).
// Valid configurations declare neither cap: config.mjs detects raw presence
// and refuses before these readers run. The undeclared repository default
// remains 3 until U4; the machine default stays unset. Env retirement belongs
// solely to config.mjs, not to this arithmetic.

/** The per-repository cap a project that declares none still gets. */
export const REPO_CAP_DEFAULT = 3;


const asCap = value => (Number.isInteger(value) && value >= 0 ? value : null);

/** Repository cap or default 3 until U4. Schema rejects invalid declared values. */
export function repoCapOf(config = {}) {
  const declared = asCap(config?.dispatch?.cap);
  return declared === null ? REPO_CAP_DEFAULT : declared;
}

/** Machine ceiling or null. Environment retirement belongs to config.mjs. */
export function machineCapOf(config = {}) {
  return { ok: true, cap: asCap(config?.dispatch?.machineCap) };
}


/** Which repository a count belongs to, said the same way in every message. */
const inRepo = repo => (repo === '' ? 'this repository' : repo);

/**
 * WHY a count could not be established, and the read that settles it — the two
 * causes `unmeasured` carries, said apart (#221 review).
 *
 * The caps gate the TOTAL, so the arithmetic never looks at this. The sentence
 * does, because it is consumed as an instruction: a host that could not be
 * asked is settled by asking it or declaring it under `dispatch.hosts`, while a
 * recorded worktree a restored pane still occupies is settled by inspecting
 * that handle. One sentence for both printed "a host that could not be asked"
 * on a machine where every host answered, and sent the reader to `ax worker ls`
 * — a verb that renders RECORDS and therefore cannot show a handle no record
 * names.
 */
const ASKED = 'ax worker ls   # the host and why it could not answer; declare it under dispatch.hosts, or settle the records naming it, then re-run';

const HOST_WHY = 'on a host that could not be asked';
const TREE_WHY = 'at a recorded worktree a live pane no record owns still occupies';

/** Occupancy evidence the count carries; absent is none, never a guess. */
const occupancyOf = unmeasured => (Array.isArray(unmeasured?.occupancy) ? unmeasured.occupancy : []);

const extrasOf = occupancy => [
  ...new Set(occupancy.flatMap(row => (Array.isArray(row.extras) ? row.extras : [])).filter(handle => typeof handle === 'string' && handle !== '')),
];

const occupancyNamed = occupancy =>
  occupancy
    .map(row => {
      const records = Array.isArray(row.records) && row.records.length > 0 ? row.records.join(', ') : 'a record';
      const extras = Array.isArray(row.extras) && row.extras.length > 0 ? row.extras.join(', ') : 'a live pane no record owns';
      const tree = row.tree !== undefined && row.tree !== '' ? row.tree : 'a recorded worktree';
      return `${records} at ${tree} still occupied by live handle(s) ${extras}`;
    })
    .join('; ');

const showCommands = occupancy => {
  const extras = extrasOf(occupancy);
  return extras.length > 0
    ? extras.map(handle => `orca terminal show --terminal ${handle} --json`).join('; ')
    : "orca terminal show --terminal <handle> --json";
};

const occupancyRepair = occupancy =>
  `${showCommands(occupancy)}   # live pane(s) at the recorded worktree, not the orphaned recorded handle; then release or settle that record and re-run`;

const bothRepair = occupancy =>
  `ax worker ls; ${showCommands(occupancy)}   # inspect the unasked hosts and occupied worktrees before re-running`;

/** Evidence for this repository follows the same named-repository rule as its count. */
const occupancyFor = (unmeasured, repo, scope) => {
  const rows = occupancyOf(unmeasured);
  if (scope === 'machine') return rows;
  const ours = String(repo ?? '').trim().toLowerCase();
  if (ours === '') return rows;
  return rows.filter(row => {
    const named = String(row.repo ?? '').trim().toLowerCase();
    return named === ours;
  });
};

function occupancyLines(occupancy) {
  const lines = [];
  for (const row of occupancy) {
    const records = Array.isArray(row.records) && row.records.length > 0 ? row.records.join(', ') : 'a record';
    const extras = Array.isArray(row.extras) && row.extras.length > 0 ? row.extras.join(', ') : 'none';
    const tree = row.tree !== undefined && row.tree !== '' ? row.tree : 'a recorded worktree';
    lines.push(`recorded ${records} at ${tree} still occupied by live handle(s) ${extras} — occupancy, not a worker`);
    for (const handle of Array.isArray(row.extras) ? row.extras : []) {
      if (typeof handle === 'string' && handle !== '') {
        lines.push(`orca terminal show --terminal ${handle} --json   # live pane at that path, not the recorded handle`);
      }
    }
  }
  return lines;
}

/** The count of the pair whose cause is occupancy, read tolerantly. */
const occupiedIn = (unmeasured, scope) => {
  const value = (unmeasured?.occupied ?? {})[scope];
  return Number.isInteger(value) && value > 0 ? value : 0;
};

function causeOf(total, occupied, occupancy = []) {
  const unasked = total - occupied;
  if (occupied <= 0) return { why: `are ${HOST_WHY}, so their liveness is unknown`, repair: ASKED };
  if (unasked <= 0) {
    const named = occupancyNamed(occupancy);
    return {
      why: named === '' ? `are ${TREE_WHY}, so their liveness is unknown` : `are ${TREE_WHY} (${named}), so their liveness is unknown`,
      repair: occupancyRepair(occupancy),
    };
  }
  const named = occupancyNamed(occupancy);
  return { why: `have no established liveness — ${unasked} ${HOST_WHY}, ${occupied} ${TREE_WHY}${named === '' ? '' : ` (${named})`}`, repair: bothRepair(occupancy) };
}

/**
 * The two counts, each labelled by its scope — the lines `ax worker ls` prints
 * and both dispatch verbs note.
 *
 * ONE label, three readers. `ls` used to name a machine-wide total "the cap
 * count" while nothing gated on it; the fix is not a better sentence in `ls`,
 * it is that the sentence and the fence come from the same place.
 *
 * AND THE SCOPE IS PART OF THE LABEL, because the count cannot see every live
 * pane: `./slots.mjs` counts RECORDED panes, so an operator's own session in
 * one of this repository's worktrees holds no slot in this number. Measured
 * 2026-09-15 on goodluckagency/ofmchat #253–#257 — `0 live pane(s) in
 * goodluckagency/ofmchat` beside a working pane in that repository's own
 * worktree. The number was right; read as "this repository is idle" it
 * authorises a second agent onto an occupied slice, and an orchestrator spent
 * a dispatch resolving the ambiguity instead.
 */
export function capLines({ live, repo = '', repoCap, machineCap }) {
  const lines = [];
  lines.push(
    repo === ''
      ? `live pane(s) in this repository: NOT MEASURED — nothing here names this checkout, so dispatch.cap ${repoCap} cannot be counted (F-028)`
      : `${live.mine} live pane(s) in ${repo} — the count dispatch.cap ${repoCap} gates; RECORDED panes only, so a session nobody dispatched holds no slot here`,
  );
  lines.push(
    `${live.machine} live pane(s) on this machine — ${
      machineCap === null ? 'no dispatch.machineCap is declared, so nothing gates on this total' : `the count dispatch.machineCap ${machineCap} gates`
    }`,
  );
  if (live.unknown > 0) {
    lines.push(
      `${live.unknown} of them name no repository — the machine total alone carries those, never ${inRepo(repo)}'s count (F-028)`,
    );
  }
  if (live.unmeasured.machine > 0) {
    const occupancy = occupancyFor(live.unmeasured, repo, 'machine');
    const cause = causeOf(live.unmeasured.machine, occupiedIn(live.unmeasured, 'machine'), occupancy);
    lines.push(`${live.unmeasured.machine} pane(s) ${cause.why} — so neither count includes them (F-028)`);
    lines.push(...occupancyLines(occupancy));
  }
  return lines;
}

/**
 * May `adding` new panes be created? `{ ok: true, notes }`, or a stop carrying
 * `kind` — `'refuse'` when a cap really is full, `'cannot'` when the count that
 * would gate this dispatch could not be established.
 *
 * THE TWO KINDS ARE NOT THE SAME ANSWER (ruled 2026-09-03 on #88, and the review
 * finding on PR #129). A refusal is about the subject: this repository is full,
 * come back when a pane finishes. An inability is about the machine: the
 * container that decides could not be read, and a mutation never proceeds on
 * one (F-028 — absent is not zero). Both stop the dispatch; only the first says
 * anything about the ticket, which is why the verbs map them to different exit
 * codes (1 and 3).
 *
 * Three shapes are unmeasurable, and each has a repair:
 *
 *   1. NOTHING NAMES THIS CHECKOUT. `gh repo view` is what places a pane in a
 *      repository, so without it `dispatch.cap` has no count to gate. A declared
 *      `dispatch.machineCap` BOUNDS the machine instead, and a bounded mutation
 *      may proceed; with neither, nothing gates it at all and it stops.
 *   2. A PANE OF THIS REPOSITORY WHOSE LIVENESS IS UNKNOWN — a record naming a
 *      host that could not be asked, or one whose recorded worktree a live pane
 *      no record owns still occupies (#221). Its absence understates the very
 *      number `dispatch.cap` gates, so authorizing against it can admit a pane
 *      past a cap that is already full. Which of the two causes it is decides
 *      the READ that settles it, never the arithmetic, so the number is one and
 *      the sentence names the cause (`causeOf` above).
 *   3. AN UNKNOWN PANE ELSEWHERE, once a ceiling is armed. Unarmed, nothing
 *      gates the machine total, and treating it as an inability would park this
 *      repository on another checkout's unreachable host — #88 through a new
 *      door. Armed, the ceiling counts every pane, so an unknown one makes the
 *      number it gates unmeasurable.
 *
 * The per-repository question is answered first throughout, because its repair
 * is the one the caller can act on inside its own project. Reaching the ceiling
 * first would print "raise dispatch.machineCap" at a caller whose real problem
 * is its own wave.
 *
 * The boundary is greater-than, unchanged: exactly at the cap the dispatch runs.
 */
export function capVerdict({ live, adding, repo = '', repoCap, machineCap }) {
  const notes = [];
  const unmeasured = live.unmeasured;
  const mineOccupancy = occupancyFor(unmeasured, repo, 'mine');
  const machineOccupancy = occupancyFor(unmeasured, repo, 'machine');
  const mineCause = causeOf(unmeasured.mine, occupiedIn(unmeasured, 'mine'), mineOccupancy);
  const machineCause = causeOf(unmeasured.machine, occupiedIn(unmeasured, 'machine'), machineOccupancy);

  if (repo === '') {
    if (machineCap === null) {
      return {
        ok: false,
        kind: 'cannot',
        scope: 'repository',
        notes,
        message: `the per-repository cap is NOT MEASURED: nothing here names this checkout, so dispatch.cap ${repoCap} has no count to gate — and no dispatch.machineCap is declared to bound this machine instead, so nothing at all would gate this dispatch (F-028: absent is not zero)`,
        repair: "fix this checkout's origin so gh can name it (git remote -v; gh repo view), or declare dispatch.machineCap in ax.config.json as the ceiling that bounds it",
      };
    }
    notes.push(
      `the per-repository cap is NOT MEASURED: nothing here names this checkout, so dispatch.cap ${repoCap} cannot be counted — the declared dispatch.machineCap ${machineCap} is what bounds this dispatch (F-028)`,
    );
  }

  if (unmeasured.mine > 0) {
    return {
      ok: false,
      kind: 'cannot',
      scope: 'repository',
      notes,
      message: `the count dispatch.cap ${repoCap} gates cannot be established: ${unmeasured.mine} pane(s) in ${inRepo(repo)} ${mineCause.why}, and ${live.mine} understates it (F-028)`,
      repair: mineCause.repair,
    };
  }

  if (repo !== '' && live.mine + adding > repoCap) {
    return {
      ok: false,
      kind: 'refuse',
      scope: 'repository',
      notes,
      message: `cap: ${live.mine} live pane(s) in ${repo} + ${adding} new > dispatch.cap ${repoCap} — ${live.machine} live on this machine, ${live.unknown} of them naming no repository`,
      repair: `let one of ${repo}'s panes finish (ax worker ls), dispatch fewer, or raise dispatch.cap in ax.config.json`,
    };
  }

  if (machineCap !== null && unmeasured.machine > 0) {
    return {
      ok: false,
      kind: 'cannot',
      scope: 'machine',
      notes,
      message: `the machine total dispatch.machineCap ${machineCap} gates cannot be established: ${unmeasured.machine} pane(s) ${machineCause.why}, and ${live.machine} understates it (F-028)`,
      repair: machineCause.repair,
    };
  }

  if (machineCap !== null && live.machine + adding > machineCap) {
    return {
      ok: false,
      kind: 'refuse',
      scope: 'machine',
      notes,
      message: `machine cap: ${live.machine} live pane(s) on this machine + ${adding} new > dispatch.machineCap ${machineCap} — ${
        repo === '' ? 'and this checkout names no repository, so none of them is known to be its own' : `${live.mine} of them in ${repo}`
      }`,
      repair: 'let any pane finish (ax worker ls), dispatch fewer, or raise dispatch.machineCap in ax.config.json',
    };
  }

  if (unmeasured.machine > 0) {
    // Unarmed ceiling: the understated total gates nothing, so this is a
    // disclosure. It is still printed, because the reader's NEXT decision may be
    // to arm the ceiling, and then these panes decide.
    notes.push(
      `${unmeasured.machine} pane(s) ${machineCause.why}, and are in neither count — nothing gates the machine total here, so they stop nothing (F-028)`,
    );
  }

  return { ok: true, notes };
}
