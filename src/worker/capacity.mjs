// How many child panes a dispatch may add — the two counts, the two caps, and
// the one verdict both dispatch verbs print.
//
// WHY THIS EXISTS (#88, measured 2026-09-02 across two checkouts on one Mac)
// The dispatch store is host-global by design (./record.mjs), so every count
// taken from it is machine-wide unless something scopes it. Nothing did, and the
// three verbs that read it disagreed three ways:
//
//   * `ax worker ls` ended with `N live pane(s) — this is the cap count`, where
//     N counted every live pane on the machine. Read from the ofmchat checkout
//     it named three panes that all belonged to flosrn/ax, and an orchestrator
//     that honours "count with `ls`, never from memory" spent a turn deciding
//     whether it was allowed to dispatch at all.
//   * `ax worker dispatch` enforced NOTHING. It admitted a 4th and a 5th pane
//     without a word, minutes after `triage dispatch` had refused.
//   * `ax triage dispatch` enforced `ORCA_TRIAGE_SESSION_CAP` — machine-wide,
//     defaulting to 3 whether or not anybody had armed it. A 13-issue wave here
//     ran at one slot while another repository held two panes.
//
// THE RULING (operator, 2026-09-02 on #88): R3 — per repository by default,
// with a machine ceiling that is OPT-IN and UNSET.
//
//   `dispatch.cap` is the fairness mechanism and the only cap that binds by
//   default. It counts the panes whose record NAMES this repository, so a wave
//   here cannot be parked by a wave there.
//
//   `dispatch.machineCap` is the fuse, not the fairness mechanism: a machine has
//   real shared limits (Orca's long-poll cap is 16), so a ceiling has to be
//   declarable — and it does not exist until an operator declares it. An unset
//   ceiling that still meant 3 was this issue's bug under a new name, because
//   another checkout's panes ate the fuse and this repository never reached its
//   own cap.
//
// AN UNNAMED RECORD IS UNKNOWN, AND COUNTS AGAINST THE CEILING ONLY (F-028).
// That is the opposite convention to `../frontier.mjs` and `../pr-gate.mjs`,
// which keep an unnamed record as possibly ours, and the difference is
// load-bearing: for a frontier, including an unknown is the conservative
// reading; for a per-repository cap, EXCLUDING it is what stops another checkout
// from parking this one, and the ceiling is what keeps the machine safe once an
// operator arms it. So an unnamed pane is never silently dropped either — every
// caller prints how many there were.
//
// PURE, AND DELIBERATELY IMPORT-FREE. Both counts arrive as data (a dispatch
// index and a terminal inventory), both caps arrive as a validated config, and
// the verdict is a value. That is what lets one contract answer for `ax worker
// dispatch`, `ax triage dispatch` and `ax worker ls` without any of them
// reaching into another's module — and what lets the whole thing be graded
// offline, with no store, no runtime and no `gh`.

/** The per-repository cap a project that declares none still gets. */
export const REPO_CAP_DEFAULT = 3;

/**
 * The env knobs the caps retired, refused BY NAME rather than read past.
 *
 * `ORCA_TRIAGE_SESSION_CAP` said `triage` while it gated the only verb that
 * enforced anything, and it defaulted to 3 with nobody arming it — the two
 * halves of #88 in one name. `ORCA_READY_SESSION_CAP` was its own predecessor
 * (`docs/adr/0001`), already refused for the same reason. Both are refused: a
 * fallback chain reading whichever is set is precisely how a rename stops being
 * one, and here it would silently restore a machine-wide cap over a
 * per-repository one.
 *
 * Empty is absence — an exported-but-empty variable is a shell artefact, not an
 * instruction.
 */
export const RETIRED_CAP_KNOBS = ['ORCA_TRIAGE_SESSION_CAP', 'ORCA_READY_SESSION_CAP'];

const asCap = value => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * The per-repository cap: `dispatch.cap`, or `REPO_CAP_DEFAULT` when the project
 * declares none.
 *
 * The `dispatch` block otherwise carries no defaults on purpose — a floor
 * measured for one fleet, inherited by a repo that never declared it, is the
 * same bug in a new place. This key is the exception, and the exception is the
 * ticket: a cap that binds only where somebody declared it is a cap that does
 * not bind, which is the state #88 measured. It is a FAIRNESS number, not a
 * measurement of any machine's appetite, so a default is safe here in a way a
 * memory floor never is.
 *
 * `ax.schema.json` refuses a non-integer and a negative one, which is why the
 * fallback below reads as "absent" and never as "unreadable".
 */
export function repoCapOf(config = {}) {
  const declared = asCap(config?.dispatch?.cap);
  return declared === null ? REPO_CAP_DEFAULT : declared;
}

/**
 * The machine ceiling — `{ ok: true, cap: <n> | null }`, where `null` is NO
 * CEILING, or a refusal naming a retired knob.
 *
 * Zero is legal and means "no new pane on this machine right now". Absence is
 * not zero and not three: it is the absence of a fuse.
 */
export function machineCapOf(config = {}, env = {}) {
  const retired = RETIRED_CAP_KNOBS.find(name => (env[name] ?? '') !== '');
  if (retired !== undefined) return { ok: false, from: retired, to: 'dispatch.machineCap' };
  return { ok: true, cap: asCap(config?.dispatch?.machineCap) };
}

/**
 * The two counts, from the record↔pane association `ls` reads liveness from: a
 * dispatch record whose recorded handle is still alive. Never `worker-list`
 * (F-048: that counter answered zero while children were working), and never the
 * raw pane count — an editor's pane is not dispatch capacity.
 *
 *   `machine`     every live recorded pane on this host
 *   `mine`        those whose record names `repo`, compared case-insensitively
 *                 because that is the comparison `./start.mjs` already makes
 *                 when it refuses a foreign record for the same request id
 *   `unknown`     those whose record names no repository at all — carried in
 *                 `machine`, absent from `mine`, and disclosed by every caller
 *   `unmeasured`  the panes whose LIVENESS could not be established at all,
 *                 scoped the same way. NOT a count of dead panes: a container
 *                 that could not be read, which is why `capVerdict` treats it
 *                 as an inability rather than as room (F-028)
 *
 * `inventory.unresolved` is where the third number comes from — the rows
 * `liveInventory` could not decide because the host their record names could not
 * be asked (../worker/pane.mjs). An inventory carrying no such list is a caller
 * that asked no host, so every row was decided by the list it passed.
 *
 * A caller that cannot name its own repository gets `mine: 0`, which is an
 * absence to act on and never a zero to spend: `capVerdict` says so.
 */
export function liveCount({ index, inventory, repo = '' }) {
  const ours = String(repo ?? '').trim().toLowerCase();
  const named = row => String(row.repo ?? '').trim().toLowerCase();
  const machine = new Set();
  const mine = new Set();
  const unknown = new Set();

  for (const row of index.byDispatch.values()) {
    if (row.handle === null) continue;
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal === undefined || terminal.orphaned === true) continue;
    machine.add(row.handle);

    if (named(row) === '') unknown.add(row.handle);
    else if (ours !== '' && named(row) === ours) mine.add(row.handle);
  }

  const undecided = Array.isArray(inventory.unresolved) ? inventory.unresolved : [];
  const unmeasuredMachine = new Set();
  const unmeasuredMine = new Set();
  for (const row of undecided) {
    if (row.handle === null || machine.has(row.handle)) continue;
    unmeasuredMachine.add(row.handle);
    if (ours !== '' && named(row) === ours) unmeasuredMine.add(row.handle);
  }

  return {
    machine: machine.size,
    mine: mine.size,
    unknown: unknown.size,
    unmeasured: { machine: unmeasuredMachine.size, mine: unmeasuredMine.size },
  };
}

/** Which repository a count belongs to, said the same way in every message. */
const inRepo = repo => (repo === '' ? 'this repository' : repo);

/**
 * The two counts, each labelled by its scope — the lines `ax worker ls` prints
 * and both dispatch verbs note.
 *
 * ONE label, three readers. `ls` used to name a machine-wide total "the cap
 * count" while nothing gated on it; the fix is not a better sentence in `ls`,
 * it is that the sentence and the fence come from the same place.
 */
export function capLines({ live, repo = '', repoCap, machineCap }) {
  const lines = [];
  lines.push(
    repo === ''
      ? `live pane(s) in this repository: NOT MEASURED — nothing here names this checkout, so dispatch.cap ${repoCap} cannot be counted (F-028)`
      : `${live.mine} live pane(s) in ${repo} — the count dispatch.cap ${repoCap} gates`,
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
    lines.push(
      `${live.unmeasured.machine} pane(s) are on a host that could not be asked — their liveness is unknown, so neither count includes them (F-028)`,
    );
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
 *      host that could not be asked. Its absence understates the very number
 *      `dispatch.cap` gates, so authorizing against it can admit a pane past a
 *      cap that is already full.
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
  const asked = 'ax worker ls   # the host and why it could not answer; declare it under dispatch.hosts, or settle the records naming it, then re-run';

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
      message: `the count dispatch.cap ${repoCap} gates cannot be established: ${unmeasured.mine} pane(s) in ${inRepo(repo)} are on a host that could not be asked, so their liveness is unknown and ${live.mine} understates it (F-028)`,
      repair: asked,
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
      message: `the machine total dispatch.machineCap ${machineCap} gates cannot be established: ${unmeasured.machine} pane(s) are on a host that could not be asked, so their liveness is unknown and ${live.machine} understates it (F-028)`,
      repair: asked,
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
      `${unmeasured.machine} pane(s) are on a host that could not be asked and are in neither count — nothing gates the machine total here, so they stop nothing (F-028)`,
    );
  }

  return { ok: true, notes };
}
