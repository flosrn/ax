// Which recorded agent panes does a covering inventory report as UP — the
// liveness facts `ax worker ls` prints, and per host the live workers a remote
// dispatch's Slots are computed against (./host-placement.mjs). No count here
// gates a repository or a machine: admission is by Slots only (ADR 0005).
//
// TWO QUESTIONS, TWO READERS (#161, ruled shape 2 by the maintainer 2026-09-04).
// The dispatch store answers two things about a record, and only one of them is
// about liveness:
//
//   "MAY THIS PANE BE CLOSED?"  needs the record↔dispatch association PROVEN,
//   because a release is a mutation on it. That is `dispatchIndex`
//   (./record.mjs), and its authority rule is deliberate and unmoved: only a
//   `worker-start` phase may name a dispatch, every other phase carrying a
//   `dispatchId` is display metadata.
//
//   "IS THIS PANE A LIVE WORKER?"  needs no association at all — a terminal
//   that is up occupies its host whatever recorded it. That is this module,
//   keyed on the RECORDED PANE and never on the dispatch.
//
// Before #161 the count read the first index for the second question, and the
// row's handle rode on the authority rule: a pane recorded by the bash-era
// `--inject` repair lives in a `worker-start-inject` phase, so it had no handle
// there and no place in the count — while `ax worker ls`, which counts the pane
// whichever phase recorded it (#152, a77e40b), printed it VIVANT. Two numbers
// for one question is the #88 class.
//
// So `livePanes` is the ONE reader of that number: `ax worker ls`, remote
// admission in `ax worker dispatch`, `ax worker hosts` and the anti-rival
// gates of `ax triage dispatch` read through it and nothing else. It is one
// function on purpose: the pane rows, the host asking and the scoping cannot be
// composed differently by one caller, because none of them holds the pieces.
//
// A STARTING WORKER IS LIVE ON ITS HOST (KTD3). A `worker-start` written ahead
// with `--on <host>` and not yet concluded has no handle to count, and its pane
// may be booting right now: it counts as one live worker on that host, so a
// second dispatch cannot read the Slot it is about to fill as free. It is never
// a pane, so it joins no machine or repository total.
//
// THE WIDENING IS ONE-DIRECTIONAL, and that is what makes it safe: a phase that
// recorded an agent terminal contributes its handle, so the count can only grow
// — and an over-count denies a Slot an operator can re-read, while an
// under-count admits a worker the host cannot hold (./pane.mjs, ./ls.mjs).
//
// KEYED BY HANDLE, never by record. A repair reuses the agent terminal, and a
// `--replace` leaves the old request naming the pane the new one runs in, so two
// records can name ONE terminal: counting rows there reports two live workers
// for one and denies a Slot the host had.
//
// A RETIRED HOST'S COUNT CARRIES ITS RETIREMENT (KTD8). `liveCount` reads the
// operator's policy (./retired-hosts.mjs) and marks each retired host's count,
// so every Slot reader skips that host by name; a malformed policy is the same
// inability as an unreadable record.

import { hostScopes, liveInventory, worktreeOccupancy } from './pane.mjs';
import { agentTerminal, argvValue, defaultStore, scanStore } from './record.mjs';
import { readRetired } from './retired-hosts.mjs';

/** A fresh per-host count, before anything is counted on that host. */
const emptyCount = () => ({ live: 0, starting: 0, unmeasured: 0, occupancy: [] });

/**
 * Every recorded agent pane of a store, keyed by handle, and every remote
 * `worker-start` still opening: `{ byHandle, starting, unreadable, missing,
 * reason }`, each pane row `{ handle, repo, hosts, trees, files }` and each
 * starting row `{ file, host }`.
 *
 * `repo` places the pane in a repository — the record's own `repo` key, trimmed,
 * exactly as `dispatchIndex` and `recordRepo` read it, and `''` when it names
 * none. The store is host-global, so a pane belongs to the repository its
 * record NAMES and never to the path a worktree happens to sit at (#88). An
 * absent key is UNKNOWN, carried by the machine total alone (F-028), and so is
 * a handle two records place in two DIFFERENT repositories: one pane cannot be
 * two projects' pane, and attributing it to either would place a foreign
 * record in this repository's count.
 *
 * `hosts` is where the pane may be asked about: the `--on` of the phase that
 * recorded it, `''` (local) dropped because the local list already answers for
 * it. Ordinarily one host; two only when two records place one handle, and both
 * are then asked, because a pane one host cannot answer for may still be alive
 * on the other.
 *
 * A PHASE THAT RECORDED A PANE AND NO ARGV MAKES ITS RECORD UNREADABLE, the
 * same refusal `dispatchIndex` makes for a worker-start (#130): `--on` is what
 * says where that pane lives, and reading its absence as "local" turns a
 * placement nobody recorded into an ordinary local pane — absent from the local
 * list it would read MORT and leave every count, the under-count F-028 forbids.
 * Partial provenance is none, so the whole record contributes nothing and is
 * named: remote admission refuses on an unreadable record rather than counting
 * past it. An OPEN `worker-start` with no argv is the same refusal: its host is
 * where it would spend a Slot, and nothing else can say which host that is.
 *
 * A STARTING ROW is a `worker-start` written ahead in an attempt that is not
 * settled, with neither an exit nor a receipt naming a pane — the write-ahead
 * of a start whose answer has not landed, or never will (STRANDED). Its
 * pane may exist; until the start concludes or is settled, the host it named
 * reserves it.
 */
function recordedPanes(store) {
  const byHandle = new Map();
  const scan = scanStore(store);
  const unreadable = scan.unreadable;
  if (scan.reason !== '') return { byHandle, starting: [], unreadable, missing: scan.missing, reason: scan.reason };

  // Accumulated per handle across the WHOLE store before anything is decided:
  // `names` is every repository claimed for that pane, folded to one spelling
  // per repository, and it is what makes a disagreement permanent. Deciding the
  // repository incrementally — clearing it on the second, different claim —
  // let a THIRD record agreeing with the first restore it, so a contested pane
  // read as one project's slot again.
  const claims = new Map();
  const starting = [];
  for (const { file, rec } of scan.records) {
    const recorded = typeof rec.repo === 'string' ? rec.repo.trim() : '';
    const attempts = Array.isArray(rec.attempts) ? rec.attempts : [];
    const found = [];
    const opening = [];
    let unnamed = null;
    try {
      for (const attempt of attempts) {
        for (const ph of Array.isArray(attempt.phases) ? attempt.phases : []) {
          const result = ph?.receipt?.result;
          const handle = result !== null && typeof result === 'object' ? agentTerminal(result) : null;
          if (handle === null) {
            if (attempt.settled === true || ph?.name !== 'worker-start' || !openPhase(ph)) continue;
            if (!Array.isArray(ph.argv)) {
              unnamed = 'an open worker-start phase carries no argv, so the host whose Slot it spends cannot be read';
              break;
            }
            const host = argvValue(ph.argv, '--on') ?? '';
            if (host !== '') opening.push(host);
            continue;
          }
          if (!Array.isArray(ph.argv)) {
            unnamed = `phase ${String(ph.name)} recorded pane ${handle} and no argv, so its placement cannot be read`;
            break;
          }
          found.push({ handle, host: argvValue(ph.argv, '--on') ?? '', tree: argvValue(ph.argv, '--worktree') ?? '' });
        }
        if (unnamed !== null) break;
      }
    } catch (error) {
      // A SHAPE THIS WALK CANNOT READ IS AN UNREADABLE RECORD, never a crash.
      // `argvValue` calls `startsWith` on each entry, so an argv carrying a
      // non-string — hand-edited, foreign-written, half-repaired — throws from
      // inside the count. Remote admission calls this reader for the number
      // that authorises a mutation: a stack trace there replaces a refusal
      // carrying its repair with an exit nobody can act on, and the record
      // would decide nothing either way. So it joins the records the count
      // could not read, which admission already refuses on (F-028).
      unreadable.push({ file, error: `its phases cannot be read: ${String(error?.message ?? error)}` });
      continue;
    }
    if (unnamed !== null) {
      unreadable.push({ file, error: unnamed });
      continue;
    }
    for (const host of opening) starting.push({ file, host });

    for (const { handle, host, tree } of found) {
      let claim = claims.get(handle);
      if (claim === undefined) {
        claim = { names: new Map(), hosts: [], trees: [], files: [] };
        claims.set(handle, claim);
      }
      // A slug differing only in case is the same repository — the comparison
      // `./start.mjs` already makes when it refuses a foreign record — so it is
      // one name here, and the spelling kept is the first one seen.
      if (recorded !== '' && !claim.names.has(recorded.toLowerCase())) claim.names.set(recorded.toLowerCase(), recorded);
      // The hosts are a UNION: no ask that could decide this pane is skipped.
      if (host !== '' && !claim.hosts.includes(host)) claim.hosts.push(host);
      // The worktree the phase PLACED that pane at, for the occupancy question
      // below. A union for the same reason the hosts are one: two records can
      // name one handle.
      if (tree !== '' && !claim.trees.includes(tree)) claim.trees.push(tree);
      if (file !== '' && !claim.files.includes(file)) claim.files.push(file);
    }
  }

  for (const [handle, claim] of claims) {
    // One name is a placement; none and several are both UNKNOWN — a record
    // naming no repository says nothing, and two records naming two of them say
    // nothing this reader may choose between (F-028).
    const named = [...claim.names.values()];
    byHandle.set(handle, { handle, repo: named.length === 1 ? named[0] : '', hosts: claim.hosts, trees: claim.trees, files: claim.files });
  }
  return { byHandle, starting, unreadable, missing: false, reason: '' };
}

/**
 * A phase written ahead whose execution never came back: no exit and no
 * receipt, or a transport that never concluded (STRANDED). An answered
 * phase — success or refusal — has concluded.
 */
function openPhase(ph) {
  if (typeof ph.transport === 'string' && ph.transport !== '') return true;
  return (ph.exit === null || ph.exit === undefined) && (ph.receipt === null || ph.receipt === undefined);
}

/**
 * The two counts, from the recorded panes an inventory reports as up.
 *
 *   `machine`     every live recorded pane on this host
 *   `mine`        those whose record names `repo`, compared case-insensitively
 *                 because that is the comparison `./start.mjs` already makes
 *                 when it refuses a foreign record for the same request id
 *   `unknown`     those whose record names no repository at all — carried in
 *                 `machine`, absent from `mine`, and disclosed by every caller
 *   `unmeasured`  the panes whose LIVENESS could not be established at all,
 *                 scoped the same way. NOT a count of dead panes: a container
 *                 that could not be read, which is why the host such a pane
 *                 names offers no Slot (F-028). `occupied` is the subset of
 *                 each whose cause is a recorded worktree a live pane no record
 *                 owns still occupies, the rest being a host that could not be
 *                 asked — two causes, two repairs. `occupancy` is the
 *                 identifying evidence for that occupied subset: recorded
 *                 handle, path, records that named it, and the live extras at
 *                 the tree. Extras are occupancy, never workers; they do not
 *                 join `machine` or `mine`. An unasked remote is not a row here.
 *   `hosts`       per host their record placed them on (`--on`), split out by
 *                 `livePanes` for Slots (./host-placement.mjs):
 *                 `{ live, starting, unmeasured, occupancy }`, `live` counting
 *                 every live pane there whoever's repository owns it PLUS each
 *                 open worker-start that names the host (`starting`, KTD3), and
 *                 `occupancy` the occupied rows among `unmeasured`. Local panes
 *                 name no host and are not in it.
 *
 * A caller that cannot name its own repository gets `mine: 0`, which is an
 * absence to disclose and never a zero: `liveLines` says NOT MEASURED.
 */
function countPanes({ panes, inventory, repo }) {
  const ours = String(repo ?? '').trim().toLowerCase();
  const named = row => String(row.repo ?? '').trim().toLowerCase();
  const machine = new Set();
  const mine = new Set();
  const unknown = new Set();
  const hosts = new Map();
  const hostOf = host => {
    let count = hosts.get(host);
    if (count === undefined) {
      count = emptyCount();
      hosts.set(host, count);
    }
    return count;
  };
  const onHosts = (names, key) => {
    for (const host of names) hostOf(host)[key] += 1;
  };

  for (const row of panes.byHandle.values()) {
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal === undefined || terminal.orphaned === true) continue;
    machine.add(row.handle);
    onHosts(row.hosts, 'live');
    if (named(row) === '') unknown.add(row.handle);
    else if (ours !== '' && named(row) === ours) mine.add(row.handle);
  }
  for (const { host } of Array.isArray(panes.starting) ? panes.starting : []) {
    const count = hostOf(host);
    count.live += 1;
    count.starting += 1;
  }

  // The rows `liveInventory` could not decide, because the host their record
  // names could not be asked (./pane.mjs). An inventory carrying no such list is
  // a caller that asked no host, so every row was decided by the list it passed.
  const undecided = Array.isArray(inventory.unresolved) ? inventory.unresolved : [];
  const unmeasuredMachine = new Set();
  const unmeasuredMine = new Set();
  for (const row of undecided) {
    if (row.handle === null || machine.has(row.handle)) continue;
    unmeasuredMachine.add(row.handle);
    onHosts([row.host], 'unmeasured');
    if (ours !== '' && named(row) === ours) unmeasuredMine.add(row.handle);
  }

  // A RECORDED WORKTREE STILL OCCUPIED IS NOT A PROVEN-EMPTY SLOT (#221). A
  // handle absent from every list reads MORT, and Orca readoption binds a
  // restored session to a NEW handle (#160 matches assignee_handle and
  // process_incarnation, and only on pending/dispatched rows), so a succeeded
  // dispatch restored at the recorded path is invisible to the recorded handle.
  // Its death therefore does not establish that the tree is free, and the Slot
  // it held is UNMEASURED rather than reclaimed — its host offers no Slot until
  // the occupying pane is read (F-028).
  //
  // OCCUPANCY, NEVER OWNERSHIP: the extra pane is not attributed to this
  // repository, to that dispatch, or to any record. It only removes the
  // proof of emptiness, which is why it lands in `unmeasured` and never in
  // `machine` or `mine`. Every recorded handle counts as owned, so a pane one
  // record placed is not an extra for another's tree.
  //
  // AND ITS CAUSE IS CARRIED APART from the unasked host's, because the two have
  // different repairs and the messages are consumed as instructions: an unasked
  // host is settled by asking it (or declaring it under `dispatch.hosts`), an
  // occupied tree by inspecting the live handle sitting in it. One number for
  // both printed "a host that could not be asked" over a machine where every
  // host answered. The two sets are disjoint by construction — a handle already
  // unmeasured through its host never reaches this loop — so the totals stay
  // one number and only the sentence reads the cause.
  const occupiedMachine = new Set();
  const occupiedMine = new Set();
  const occupancy = [];
  const recorded = [...panes.byHandle.keys()];
  for (const row of panes.byHandle.values()) {
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal !== undefined && terminal.orphaned !== true) continue;
    if (unmeasuredMachine.has(row.handle)) continue;
    for (const tree of Array.isArray(row.trees) ? row.trees : []) {
      const occ = worktreeOccupancy({ inventory, recordedWorktree: tree, knownHandles: recorded });
      if (occ.ok) continue;
      unmeasuredMachine.add(row.handle);
      occupiedMachine.add(row.handle);
      onHosts(row.hosts, 'unmeasured');
      const evidence = {
        handle: row.handle,
        repo: String(row.repo ?? ''),
        tree: occ.tree,
        records: Array.isArray(row.files) ? [...row.files] : [],
        extras: [...occ.extras],
      };
      occupancy.push(evidence);
      for (const host of row.hosts) hostOf(host).occupancy.push(evidence);
      if (ours !== '' && named(row) === ours) {
        unmeasuredMine.add(row.handle);
        occupiedMine.add(row.handle);
      }
      break;
    }
  }

  return {
    machine: machine.size,
    mine: mine.size,
    unknown: unknown.size,
    unmeasured: {
      machine: unmeasuredMachine.size,
      mine: unmeasuredMine.size,
      occupied: { machine: occupiedMachine.size, mine: occupiedMine.size },
      occupancy,
    },
    hosts,
  };
}

/**
 * How many recorded agent panes of `store` are UP — the one answer the listing
 * prints and remote admission spends Slots against.
 *
 * `{ live, hosts, inventory, unreadable, missing, reason }`:
 *
 *   `live`        the counts above, ready for `liveLines`
 *   `hosts`       per host, `Map<host, { live, starting, unmeasured,
 *                 occupancy }>` — what a host's Slots are computed against
 *                 (./host-placement.mjs)
 *   `inventory`   the liveness this count was taken against — the local list
 *                 plus every pane a named host says it still owns, with the
 *                 rows no host could answer for. Returned rather than rebuilt,
 *                 so a caller with a second question about the same panes (the
 *                 anti-rival gates of `ax triage dispatch`) asks it of THIS
 *                 measurement
 *   `missing`     the store does not exist: a machine that has never
 *                 dispatched, so `live` is a real zero — refusing there would
 *                 block the first dispatch ever
 *   `reason`      the store exists and could not be enumerated — the opposite
 *                 case, where zero would be a lie, so `live` is `null` and the
 *                 caller has an inability to report rather than a number
 *   `unreadable`  the records that could not be read, each named. A caller
 *                 about to authorise a mutation refuses on a non-empty list: an
 *                 absence of information is not an absence of a child (F-028)
 *
 * `local` is this runtime's own terminal list and `scopes` the host reader both
 * arrive from the caller (`terminalInventory` and `hostScopes`, ./pane.mjs),
 * because the caller already holds them for its own reads and a second
 * enumeration here would be a second measurement of one machine. `scopes`
 * memoizes per host, so a caller that also renders rows spends no extra ask.
 */
export function livePanes({ store, local, scopes, repo = '' }) {
  const panes = recordedPanes(store);
  if (panes.reason !== '' && !panes.missing) {
    return { live: null, hosts: null, inventory: null, unreadable: panes.unreadable, missing: false, reason: panes.reason };
  }
  const inventory = liveInventory({ local, panes, scopes });
  const { hosts, ...live } = countPanes({ panes, inventory, repo });
  return {
    live,
    hosts,
    inventory,
    unreadable: panes.unreadable,
    missing: panes.missing,
    reason: panes.reason,
  };
}

/**
 * `livePanes` over this machine's own store, asked of every host `config`
 * declares — the FAIL-CLOSED measurement remote admission reads, shared by
 * `ax worker dispatch` (a named or a placed remote host) and `ax worker hosts`,
 * so the host lines that read prints are counted exactly as the dispatch
 * counts them. `--on here` never reads it: the Mac has no Slots.
 *
 * An unreadable store or an unreadable record is `{ cannot, repair }`, never a
 * count of zero (F-028); an ENOENT store is the one real zero (`missing`).
 * Otherwise `{ slots, scopes }`: this count, and the host reader it asked, for
 * a caller that also names the hosts that could not be asked.
 *
 * A RETIRED HOST (KTD8) carries its retirement on its count — `retired: {host,
 * at, by?}`, a host with no recorded pane included — so every Slot reader
 * skips it by name whatever its report entry says. A malformed retirement
 * policy is the same `{ cannot, repair }` as an unreadable record (F-028).
 */
export function liveCount({ run, env, config, local, repo = '' }) {
  const store = defaultStore(env);
  const scopes = hostScopes(run, () => ({ ok: true, config }));
  const slots = livePanes({ store, local, scopes, repo });
  if (slots.reason !== '' && !slots.missing) {
    return {
      cannot: `the dispatch store ${store} cannot be read, so live panes cannot be counted: ${slots.reason.slice(0, 160)}`,
      repair: `ls -ld ${store}`,
    };
  }
  if (slots.unreadable.length > 0) {
    const first = slots.unreadable[0];
    return {
      cannot: `${slots.unreadable.length} dispatch record(s) in ${store} cannot be read, so the number of live panes cannot be established — an absence of information is not an absence of a child (F-028). First: ${first.file} — ${String(first.error).slice(0, 160)}`,
      repair: `ax worker ls --store ${store}   # see every record, then repair or remove the unreadable one`,
    };
  }
  const policy = readRetired(store);
  if (!policy.ok) return { cannot: policy.reason, repair: policy.repair };
  for (const [host, entry] of policy.hosts) {
    const count = slots.hosts.get(host) ?? emptyCount();
    slots.hosts.set(host, { ...count, retired: entry });
  }
  return { slots, scopes };
}

/**
 * The liveness facts `ax worker ls` prints, each labelled by its scope — and
 * none of them a ceiling: admission is by Slots (ADR 0005), so these lines
 * answer "what is running", never "may I dispatch".
 *
 * AND THE SCOPE IS PART OF THE LABEL, because the count cannot see every live
 * pane: it counts RECORDED panes, so an operator's own session in one of this
 * repository's worktrees is not in this number. Measured 2026-09-15 on
 * goodluckagency/ofmchat #253–#257 — `0 live pane(s) in
 * goodluckagency/ofmchat` beside a working pane in that repository's own
 * worktree. The number was right; read as "this repository is idle" it sends a
 * second agent onto an occupied tree.
 */
export function liveLines({ live, repo = '' }) {
  const lines = [];
  lines.push(
    repo === ''
      ? 'live pane(s) in this repository: NOT MEASURED — nothing here names this checkout, so no record can be placed in it (F-028)'
      : `${live.mine} live pane(s) in ${repo} — RECORDED panes only, so a session nobody dispatched is not in this number`,
  );
  lines.push(`${live.machine} live pane(s) on this machine`);
  if (live.unknown > 0) {
    lines.push(`${live.unknown} of them name no repository — the machine total alone carries those, never ${repo === '' ? 'this repository' : repo}'s count (F-028)`);
  }
  if (live.unmeasured.machine > 0) {
    const occupancy = Array.isArray(live.unmeasured.occupancy) ? live.unmeasured.occupancy : [];
    lines.push(`${live.unmeasured.machine} pane(s) ${unmeasuredWhy(live.unmeasured.machine, occupancy)} — so neither count includes them (F-028)`);
    for (const row of occupancy) {
      const records = row.records.length > 0 ? row.records.join(', ') : 'a record';
      const extras = row.extras.length > 0 ? row.extras.join(', ') : 'none';
      lines.push(`recorded ${records} at ${row.tree || 'a recorded worktree'} still occupied by live handle(s) ${extras} — occupancy, not a worker`);
      for (const handle of row.extras) lines.push(`orca terminal show --terminal ${handle} --json   # live pane at that path, not the recorded handle`);
    }
  }
  return lines;
}

/**
 * WHY a pane's liveness could not be established — the two causes said apart
 * (#221 review), because the sentence is consumed as an instruction: a host
 * that could not be asked is settled by asking it, an occupied recorded
 * worktree by inspecting the live handle sitting in it.
 */
function unmeasuredWhy(total, occupancy) {
  const occupied = occupancy.length;
  const unasked = total - occupied;
  const named = occupancy
    .map(row => `${row.records.length > 0 ? row.records.join(', ') : 'a record'} at ${row.tree || 'a recorded worktree'} still occupied by live handle(s) ${row.extras.length > 0 ? row.extras.join(', ') : 'a live pane no record owns'}`)
    .join('; ');
  if (occupied <= 0) return 'are on a host that could not be asked, so their liveness is unknown';
  if (unasked <= 0) return `are at a recorded worktree a live pane no record owns still occupies (${named}), so their liveness is unknown`;
  return `have no established liveness — ${unasked} on a host that could not be asked, ${occupied} at a recorded worktree a live pane no record owns still occupies (${named})`;
}
