// The count a cap gates: which recorded agent panes does a covering inventory
// report as UP, and how many of them are this repository's.
//
// TWO QUESTIONS, TWO READERS (#161, ruled shape 2 by the maintainer 2026-09-04).
// The dispatch store answers two things about a record, and only one of them is
// about capacity:
//
//   "MAY THIS PANE BE CLOSED?"  needs the record↔dispatch association PROVEN,
//   because a release is a mutation on it. That is `dispatchIndex`
//   (./record.mjs), and its authority rule is deliberate and unmoved: only a
//   `worker-start` phase may name a dispatch, every other phase carrying a
//   `dispatchId` is display metadata.
//
//   "IS THIS PANE CONSUMING A SLOT?"  needs no association at all — a terminal
//   that is up occupies a slot whatever recorded it. That is this module, keyed
//   on the RECORDED PANE and never on the dispatch.
//
// Before this, the fence read the first index for the second question, and the
// row's handle rode on the authority rule: a pane recorded by the bash-era
// `--inject` repair lives in a `worker-start-inject` phase, so it had no handle
// there and no slot in the count — while `ax worker ls`, which counts the pane
// whichever phase recorded it (#152, a77e40b), printed it VIVANT. Two numbers
// for one question is the #88 class, and the measured exposure was a dispatch
// admitted past a full cap when one of the live panes was an injected repair.
//
// So `livePanes` is the ONE reader of that number, and `ax worker ls`,
// `ax worker dispatch` and `ax triage dispatch` count through it and nothing
// else. It is one function on purpose: the pane rows, the host asking and the
// scoping cannot be composed differently by one of the three callers, because
// none of them holds the pieces.
//
// THE WIDENING IS ONE-DIRECTIONAL, and that is what makes it safe: a phase that
// recorded an agent terminal contributes its handle, so the count can only grow
// — and over-count refuses a dispatch an operator can re-run, while under-count
// puts a fourth child on a machine that declared three (./pane.mjs, ./ls.mjs).
//
// KEYED BY HANDLE, never by record. A repair reuses the agent terminal, and a
// `--replace` leaves the old request naming the pane the new one runs in, so two
// records can name ONE terminal: counting rows there reports two panes for one
// and refuses a dispatch the machine had room for.

import { liveInventory, worktreeOccupancy } from './pane.mjs';
import { agentTerminal, argvValue, scanStore } from './record.mjs';

/**
 * Every recorded agent pane of a store, keyed by handle:
 * `{ byHandle, unreadable, missing, reason }`, each row
 * `{ handle, repo, hosts }`.
 *
 * `repo` places the pane in a repository — the record's own `repo` key, trimmed,
 * exactly as `dispatchIndex` and `recordRepo` read it, and `''` when it names
 * none. The store is host-global, so a pane belongs to the repository its
 * record NAMES and never to the path a worktree happens to sit at (#88). An
 * absent key is UNKNOWN, carried by the machine total alone (F-028), and so is
 * a handle two records place in two DIFFERENT repositories: one pane cannot be
 * two projects' slot, and attributing it to either would let a foreign record
 * park this repository's cap.
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
 * named: the fences refuse on an unreadable record rather than counting past it.
 */
function recordedPanes(store) {
  const byHandle = new Map();
  const scan = scanStore(store);
  const unreadable = scan.unreadable;
  if (scan.reason !== '') return { byHandle, unreadable, missing: scan.missing, reason: scan.reason };

  // Accumulated per handle across the WHOLE store before anything is decided:
  // `names` is every repository claimed for that pane, folded to one spelling
  // per repository, and it is what makes a disagreement permanent. Deciding the
  // repository incrementally — clearing it on the second, different claim —
  // let a THIRD record agreeing with the first restore it, so a contested pane
  // read as one project's slot again.
  const claims = new Map();
  for (const { file, rec } of scan.records) {
    const recorded = typeof rec.repo === 'string' ? rec.repo.trim() : '';
    const attempts = Array.isArray(rec.attempts) ? rec.attempts : [];
    const found = [];
    let unnamed = null;
    try {
      for (const attempt of attempts) {
        for (const ph of Array.isArray(attempt.phases) ? attempt.phases : []) {
          const result = ph?.receipt?.result;
          if (result === null || typeof result !== 'object') continue;
          const handle = agentTerminal(result);
          if (handle === null) continue;
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
      // inside the count. Both fences call this reader for the number that
      // authorises a mutation: a stack trace there replaces a refusal carrying
      // its repair with an exit nobody can act on, and the record would decide
      // nothing either way. So it joins the records the count could not read,
      // which is exactly what the fences already refuse on (F-028).
      unreadable.push({ file, error: `its phases cannot be read: ${String(error?.message ?? error)}` });
      continue;
    }
    if (unnamed !== null) {
      unreadable.push({ file, error: unnamed });
      continue;
    }

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
  return { byHandle, unreadable, missing: false, reason: '' };
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
 *                 that could not be read, which is why `capVerdict` treats it
 *                 as an inability rather than as room (F-028). `occupied` is
 *                 the subset of each whose cause is a recorded worktree a live
 *                 pane no record owns still occupies, the rest being a host
 *                 that could not be asked — two causes, two repairs, and the
 *                 caps read only the totals. `occupancy` is the identifying
 *                 evidence for that occupied subset: recorded handle, path,
 *                 records that named it, and the live extras at the tree.
 *                 Extras are occupancy, never slots; they do not join
 *                 `machine` or `mine`. An unasked remote is not a row here.
 *
 * A caller that cannot name its own repository gets `mine: 0`, which is an
 * absence to act on and never a zero to spend: `capVerdict` says so.
 */
function countPanes({ panes, inventory, repo }) {
  const ours = String(repo ?? '').trim().toLowerCase();
  const named = row => String(row.repo ?? '').trim().toLowerCase();
  const machine = new Set();
  const mine = new Set();
  const unknown = new Set();

  for (const row of panes.byHandle.values()) {
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal === undefined || terminal.orphaned === true) continue;
    machine.add(row.handle);

    if (named(row) === '') unknown.add(row.handle);
    else if (ours !== '' && named(row) === ours) mine.add(row.handle);
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
    if (ours !== '' && named(row) === ours) unmeasuredMine.add(row.handle);
  }

  // A RECORDED WORKTREE STILL OCCUPIED IS NOT A PROVEN-EMPTY SLOT (#221). A
  // handle absent from every list reads MORT, and Orca readoption binds a
  // restored session to a NEW handle (#160 matches assignee_handle and
  // process_incarnation, and only on pending/dispatched rows), so a succeeded
  // dispatch restored at the recorded path is invisible to the recorded handle.
  // Its death therefore does not establish that the tree is free, and the slot
  // it held is UNMEASURED rather than reclaimed — `capVerdict` turns that into
  // an inability instead of room (F-028).
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
  // unmeasured through its host never reaches this loop — so the caps still read
  // the totals and the arithmetic is untouched.
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
      occupancy.push({
        handle: row.handle,
        repo: String(row.repo ?? ''),
        tree: occ.tree,
        records: Array.isArray(row.files) ? [...row.files] : [],
        extras: [...occ.extras],
      });
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
  };
}

/**
 * How many recorded agent panes of `store` are UP — the one answer the listing
 * prints and both dispatch verbs refuse on.
 *
 * `{ live, inventory, unreadable, missing, reason }`:
 *
 *   `live`        the counts above, ready for `capLines` and `capVerdict`
 *                 (./capacity.mjs)
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
    return { live: null, inventory: null, unreadable: panes.unreadable, missing: false, reason: panes.reason };
  }
  const inventory = liveInventory({ local, panes, scopes });
  return {
    live: countPanes({ panes, inventory, repo }),
    inventory,
    unreadable: panes.unreadable,
    missing: panes.missing,
    reason: panes.reason,
  };
}
