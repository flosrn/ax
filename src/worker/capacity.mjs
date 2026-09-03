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
 *   `machine`  every live recorded pane on this host
 *   `mine`     those whose record names `repo`, compared case-insensitively
 *              because that is the comparison `./start.mjs` already makes when
 *              it refuses a foreign record for the same request id
 *   `unknown`  those whose record names no repository at all — carried in
 *              `machine`, absent from `mine`, and disclosed by every caller
 *
 * A caller that cannot name its own repository gets `mine: 0`, which is an
 * absence to announce and never a zero to spend: `capVerdict` says so.
 */
export function liveCount({ index, inventory, repo = '' }) {
  const ours = String(repo ?? '').trim().toLowerCase();
  const machine = new Set();
  const mine = new Set();
  const unknown = new Set();

  for (const row of index.byDispatch.values()) {
    if (row.handle === null) continue;
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal === undefined || terminal.orphaned === true) continue;
    machine.add(row.handle);

    const named = String(row.repo ?? '').trim().toLowerCase();
    if (named === '') unknown.add(row.handle);
    else if (ours !== '' && named === ours) mine.add(row.handle);
  }

  return { machine: machine.size, mine: mine.size, unknown: unknown.size };
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
  return lines;
}

/**
 * May `adding` new panes be created? `{ ok: true, notes }`, or a refusal naming
 * WHICH cap stopped it, BOTH numbers, and the repair.
 *
 * The per-repository cap is tested first, because its repair is the one the
 * caller can act on inside its own project: release one of its own panes, or
 * raise its own declaration. Reaching the ceiling first would print "raise
 * dispatch.machineCap" at a caller whose real problem is its own wave.
 *
 * The boundary is greater-than, unchanged: exactly at the cap the dispatch runs.
 *
 * A count that could not be established is a DISCLOSURE, not a refusal. The
 * slug comes from `gh repo view`, and a checkout it cannot name still deserves
 * to dispatch — but silence there would be the very shape #88 is about, so the
 * absence is announced, and when no ceiling is armed either, the fact that
 * NOTHING gates this dispatch is announced too.
 */
export function capVerdict({ live, adding, repo = '', repoCap, machineCap }) {
  const notes = [];
  if (repo === '') {
    notes.push(
      `the per-repository cap is NOT MEASURED: nothing here names this checkout, so dispatch.cap ${repoCap} cannot be counted against ${live.machine} live pane(s) (F-028)`,
    );
    if (machineCap === null) {
      notes.push('no cap gates this dispatch — declare dispatch.machineCap in ax.config.json to arm the machine ceiling');
    }
  }

  if (repo !== '' && live.mine + adding > repoCap) {
    return {
      ok: false,
      scope: 'repository',
      notes,
      message: `cap: ${live.mine} live pane(s) in ${repo} + ${adding} new > dispatch.cap ${repoCap} — ${live.machine} live on this machine, ${live.unknown} of them naming no repository`,
      repair: `let one of ${repo}'s panes finish (ax worker ls), dispatch fewer, or raise dispatch.cap in ax.config.json`,
    };
  }

  if (machineCap !== null && live.machine + adding > machineCap) {
    return {
      ok: false,
      scope: 'machine',
      notes,
      message: `machine cap: ${live.machine} live pane(s) on this machine + ${adding} new > dispatch.machineCap ${machineCap} — ${
        repo === '' ? 'and this checkout names no repository, so none of them is known to be its own' : `${live.mine} of them in ${repo}`
      }`,
      repair: 'let any pane finish (ax worker ls), dispatch fewer, or raise dispatch.machineCap in ax.config.json',
    };
  }

  return { ok: true, notes };
}
