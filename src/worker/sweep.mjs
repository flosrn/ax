// `ax worker sweep` — reclaim the browsers a coding session left open, on THIS host.
//
// WHY IT EXISTS, measured on gapicore 2026-08-14 15:11, when the kernel OOM-killed
// three processes inside `gapi-orca-serve.service` (ceiling `MemoryMax=12G`):
//
//     250706  age 121m  113 MB  puppeteer root, parent alive
//     250726  age 121m   26 MB    zygote
//     276455  age 114m  149 MB      renderer, +7 min after the root
//     381769  age  92m  139 MB      renderer, +29 min
//     509743  age  63m   25 MB      renderer, +58 min
//     321844  age 104m   28 MB  playwright headless shell, a second root
//     250718  age 121m    2 MB  orphan, ppid=1, no owner left at all
//     … 19 processes, 825 MB
//
// The first reading of that inventory called it "three orphaned browser trees".
// It is not: it is ONE browser held open for two hours whose PAGES were never
// closed, each stage adding renderers to the same root. That distinction is the
// whole design — counting trees finds nothing, and the honest signal is THE AGE
// OF THE ROOT.
//
// WHY AGE AND NOT SOMETHING CLEVERER. A renderer count is tempting and wrong: a
// legitimate stage briefly holds several pages. Orphan-only (`ppid=1`) is too
// narrow — it would have swept 2 of 19 here, because the accumulating root still
// had a live owner. Age is the property that was actually wrong, needs no
// bookkeeping the harness lacks, and the cost of a wrong verdict is that an agent
// relaunches a browser. Nothing is lost. The real false positive is a session
// deliberately driving one browser past the floor (a human clicking through a
// live debug), which is why `--apply` is explicit and why `launch` only ever
// sweeps the host it is about to place on.
//
// OWNERSHIP IS DECLARED, NEVER ASSUMED. There is no built-in path list, on the
// precedent `src/proc.mjs` already states beside its own reaper: a hardcoded list
// is project policy living in a library, and it can only ever be wrong for the
// next machine. `--under` is required, must be absolute and unambiguous, and must
// name something inside the caller's own home — `launch.hosts.*.sweep` is argv
// from a config file, so it is PR-editable, and a permissive value would turn a
// host-scoped verb into a sweep of someone else's tabs.
//
// This does not live in `src/proc.mjs`, which answers a different question:
// "which processes have their cwd inside this worktree". That lookup is
// platform-split over /proc and lsof and carries no age. This one reads one
// host-wide `ps` pass, because the age of a root is the decision.
//
// EXIT CODES (ADR 0003 — per verb, never a shared alphabet)
//   0  always: swept, kept, or nothing found. A sweep that cannot run must never
//      be the reason a dispatch stops — `proveHost` reads only `status === 0`
//      and turns anything else into "measuring with whatever is still running".
//   2  usage error: no `--under`, a path that claims too much, an unreadable
//      floor. Bad usage is the one thing that is not a sweep.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { sep } from 'node:path';

import { bad, fix, note, section } from '../log.mjs';
import { pgidOf } from '../proc.mjs';

/** Minutes a root may be alive before it is garbage, absent any declaration. */
const DEFAULT_MAX_AGE_MIN = 30;
const AGE_ENV = 'AX_SWEEP_MAX_AGE_MIN';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

/**
 * Elapsed seconds from the `etime` column: `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`.
 *
 * `etimes` — the same number, already in seconds — is what the Bash asked for,
 * with a comment claiming it was verified on macOS 26. It was not: the system
 * `/bin/ps` there answers `ps: etimes: keyword not found`, exits 1, AND still
 * prints 162 KB of rows. The verification had gone through a harness `ps` on
 * PATH. So the portable column is `etime`, which both hosts format the same way,
 * and this parser is the price of portability. Measured 2026-08-22 on macOS 26
 * and Ubuntu 24.04.
 */
export function elapsedSeconds(text) {
  const parts = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!parts) return null;
  const [, days = 0, hours = 0, minutes_, seconds] = parts;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes_) * 60 + Number(seconds);
}

/**
 * The rows of one `ps` pass, parsed. Exported because the parsing is where a
 * host difference hides, and a test that spawns `ps` can only ever assert the
 * machine it runs on.
 *
 * A row whose five fields do not read as five fields is dropped rather than
 * guessed: the args column contains spaces by nature, so it is the only one
 * allowed to, and everything before it must be a number.
 */
export function readPs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const etimes = elapsedSeconds(parts[2]);
    const rss = Number(parts[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(rss) || etimes === null) continue;
    rows.push({ pid, ppid, etimes, rss, args: parts.slice(4).join(' ') });
  }
  return rows;
}

/**
 * One `ps` pass, not one per pid: a tree of 19 with a fork per lookup is 19
 * spawns for data a single pass already carries.
 *
 * `null` means `ps` could not answer, which is not the same finding as "nothing
 * of ours is running" and is never reported as one. A nonzero exit counts as
 * cannot-answer even when rows were printed — a `ps` that rejected a column has
 * shifted every field after it.
 */
function psSnapshot() {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid=,etime=,rss=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (out.error || out.status !== 0) return null;
  const rows = readPs(out.stdout ?? '');
  return rows.length === 0 ? null : rows;
}

/**
 * Whole non-negative minutes, or a named refusal.
 *
 * The Bash computed `$(( $2 * 60 ))`, and shell arithmetic reads `lots` as 0: the
 * floor silently collapsed and every live root became eligible, on the one verb
 * that signals processes. Same class as the triage cap, opposite consequence.
 */
function minutes(raw, where) {
  // Lexical before numeric, on purpose. `Number(' ')` is 0 and `Number('0x10')`
  // is 16: on an age floor, either one is the Bash defect in a new language —
  // a value nobody can read becoming "sweep everything".
  const text = String(raw ?? '');
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    return { ok: false, reason: `${where} is ${JSON.stringify(text)}, which is not a whole number of minutes` };
  }
  return { ok: true, value: Number(text) };
}

/**
 * A declared ownership path, or the reason it cannot be one.
 *
 * `home` is injected because it is a machine answer: this runs as `orca` on the
 * VPS and as the operator on the Mac, and the harness browsers live under
 * whichever home that is.
 */
function ownership(path, home) {
  if (!path.startsWith('/')) return `${path} is not an absolute path`;
  if (path.split('/').some(part => part === '.' || part === '..')) return `${path} carries an unresolved segment — declare the path it means`;
  const clean = path.replace(/\/+$/, '');
  if (clean === '' || clean === home) return `${path} is a whole home directory, which is not an ownership claim about browsers`;
  if (!clean.startsWith(home + sep)) {
    return `${path} is outside ${home} — this verb signals processes, so it only considers paths inside its own home`;
  }
  return null;
}

/** `sweep`/`keep`/`skip` for one root, in one shape so the columns line up. */
const verdictLine = (verdict, root, why) =>
  note(
    `${verdict.padEnd(5)} root ${String(root.pid).padEnd(8)} age ${String(Math.round(root.etimes / 60)).padStart(5)}m  rss ${String(
      Math.round(root.rss / 1024),
    ).padStart(5)} MB  ${why}`,
  );

/**
 * Which roots in this snapshot are garbage, by the whole predicate.
 *
 * Run TWICE per apply, and that is the point: the second run re-proves the list
 * against a freshly read host, so a pid that changed hands between the two
 * signals is judged as what it is NOW, not as what it was.
 */
function classify(rows, { prefixes, maxAgeS, floorMin, pgid, report = false }) {
  const candidates = rows.filter(row => prefixes.some(prefix => row.args.includes(prefix)));
  // A ROOT is a candidate whose parent is NOT itself a candidate: the browser
  // process proper, whose descendants are its zygotes, renderers and utilities.
  // Signalling a root takes the tree, which is why the age test belongs here and
  // nowhere else.
  const owned = new Set(candidates.map(row => row.pid));
  const roots = candidates.filter(row => !owned.has(row.ppid));

  // A sweep that kills the group it runs in dies halfway through — the defect
  // `reapByCwd` already carries a guard for, on this same machine.
  const ownGroup = pgid(process.pid);
  const targets = [];
  let kept = 0;

  for (const root of roots) {
    if (ownGroup !== undefined && pgid(root.pid) === ownGroup) {
      if (report) verdictLine('skip', root, 'in this sweep\u2019s own process group');
      continue;
    }
    // An orphan is swept at any age: `ppid=1` means the session that owned it is
    // gone, so nobody is left who could still be driving it.
    if (root.ppid === 1) {
      targets.push(root.pid);
      if (report) verdictLine('sweep', root, 'orphan (ppid=1)');
    } else if (root.etimes >= maxAgeS) {
      targets.push(root.pid);
      if (report) verdictLine('sweep', root, `older than ${floorMin}m`);
    } else {
      kept += 1;
      if (report) verdictLine('keep', root, 'under the age floor');
    }
  }
  return { candidates, targets, kept, mb: Math.round(candidates.reduce((sum, row) => sum + row.rss, 0) / 1024) };
}
export function sweep(
  argv = [],
  { snapshot = psSnapshot, kill = process.kill.bind(process), sleep = sleepDefault, pgid = pgidOf, env = process.env, home = homedir() } = {},
) {
  const refuse = (message, repair) => (bad(message), repair && fix(repair), 2);

  let apply = false;
  let ageArg;
  const under = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--max-age') {
      ageArg = argv[i + 1];
      i += 1;
      if (ageArg === undefined) return refuse('--max-age expects minutes', `ax worker sweep --under <path> --max-age ${DEFAULT_MAX_AGE_MIN}`);
    } else if (arg === '--under') {
      const path = argv[i + 1];
      i += 1;
      if (path === undefined) return refuse('--under expects a path', `ax worker sweep --under ${home}/.cache/ms-playwright`);
      under.push(path);
    } else return refuse(`unknown argument "${arg}"`, 'ax worker sweep --under <path> [--under <path>] [--apply] [--max-age <minutes>]');
  }

  const declared = env[AGE_ENV];
  const floor =
    ageArg !== undefined
      ? minutes(ageArg, '--max-age')
      : declared === undefined || declared === ''
        ? { ok: true, value: DEFAULT_MAX_AGE_MIN }
        : minutes(declared, AGE_ENV);
  if (!floor.ok) return refuse(floor.reason, `ax worker sweep --under <path> --max-age ${DEFAULT_MAX_AGE_MIN}`);
  const maxAgeS = floor.value * 60;

  if (under.length === 0) {
    return refuse(
      'no --under given, so nothing is a candidate: this verb never guesses which browsers belong to the harness',
      `ax worker sweep --under ${home}/.omp/puppeteer/chrome --under ${home}/.cache/ms-playwright`,
    );
  }
  for (const path of under) {
    const wrong = ownership(path, home);
    if (wrong) return refuse(wrong, `ax worker sweep --under ${home}/.cache/ms-playwright`);
  }

  section(`sweep — ${under.join(', ')} (floor ${floor.value}m)`);
  const rows = snapshot();
  if (rows === null) {
    note('ps returned nothing; nothing swept — this host is not measured, and no dispatch stops for it');
    return 0;
  }

  const prefixes = under.map(path => path.replace(/\/+$/, '') + sep);
  const rules = { prefixes, maxAgeS, floorMin: floor.value, pgid };

  const before = classify(rows, { ...rules, report: true });
  if (before.candidates.length === 0) {
    note('no browser found under the declared path(s)');
    return 0;
  }

  note(`${before.mb} MB across ${before.candidates.length} processes; ${before.kept} root(s) kept`);
  if (before.targets.length === 0) {
    note('nothing to sweep');
    return 0;
  }
  if (!apply) {
    note(`DRY RUN \u2014 pass --apply to sweep: ${before.targets.join(' ')}`);
    return 0;
  }

  // SIGTERM first: Chrome tears its own children down, so the tree usually goes
  // with one signal and the renderers release their shared memory in order. A pid
  // that vanished is the normal case, never an error.
  for (const pid of before.targets) {
    try {
      kill(pid, 'SIGTERM');
    } catch {
      /* exited on its own, or not ours to signal */
    }
  }
  sleep(4000);

  // Then SIGKILL what is left — which on a browser already under memory pressure
  // is not rare. Re-proved by the WHOLE predicate first, not just by the declared
  // path: a root that exits inside those four seconds frees its pid, and the next
  // stage's fresh browser can be handed that very number under that very path.
  // Intersecting with "still eligible" is what makes it judged as what it is now
  // — a young root, kept — instead of inheriting a verdict about a dead process.
  const after = snapshot();
  if (after === null) {
    note(`sent SIGTERM to ${before.targets.length} root(s); ps could not re-read the host, so nothing was forced — re-run to finish`);
    return 0;
  }
  const eligible = new Set(classify(after, rules).targets);
  const forced = before.targets.filter(pid => eligible.has(pid));
  for (const pid of forced) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* exited between the re-read and the signal */
    }
  }

  const gone = before.targets.length - forced.length;
  note(
    `swept ${before.targets.length} root(s): SIGTERM, then SIGKILL to the ${forced.length} still eligible${
      gone > 0 ? ` — ${gone} no longer eligible after the first signal` : ''
    }`,
  );
  return 0;
}
