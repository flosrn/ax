// The port of `orca-coordinator.sh reap` — renamed `sweep`, because that is the
// word `ax.schema.json` already uses for this gesture (`launch.hosts.<h>.sweep`)
// and that key pointed at the Bash. One word for one gesture, on both sides of
// the ssh boundary.
//
// This verb signals a browser that a live session may still be driving, so the
// predicate IS the risk and these tests are about the predicate alone. The
// inventory below is the real one, taken on gapicore 2026-08-14 15:11 after the
// kernel OOM-killed three processes in `gapi-orca-serve.service`. It is
// reproduced rather than simplified because its shape is what fooled the first
// reading: ONE puppeteer root two hours old, with renderers added at +7, +29 and
// +58 minutes — not three orphaned browsers. A predicate that counts trees sees
// one tree and sweeps nothing.
//
// Six propositions are NEW, and each is a fail-open the Bash could not express:
// a non-numeric `--max-age` (`$(( lots * 60 ))` is 0, so the floor collapsed and
// every live root became eligible), an unreadable env floor, a path claiming a
// whole home, a match that is not on a component boundary, the signal ORDER, and
// a pid that changes hands inside the four seconds between the two signals.
//
// `ps`, `kill`, the sleep and the process-group lookup are injected. Nothing here
// reaches a real process: a test that needed a real browser could not assert the
// one case that matters — the root a human is still clicking through.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { elapsedSeconds, readPs, sweep } from '../src/worker/sweep.mjs';

const HOME = '/home/orca';
const PUP = `${HOME}/.omp/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome`;
const PW = `${HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell`;
const UNDER = ['--under', `${HOME}/.omp/puppeteer/chrome`, '--under', `${HOME}/.cache/ms-playwright`];

/** pid, ppid, elapsed seconds, RSS kB, args — the five fields one `ps` pass carries. */
const GAPICORE = [
  [250706, 4141019, 7302, 115712, `${PUP} --disable-background-networking`],
  [250725, 250706, 7302, 26624, `${PUP} --type=zygote`],
  [250726, 250706, 7302, 26624, `${PUP} --type=zygote`],
  [250788, 250706, 7302, 68608, `${PUP} --type=utility`],
  [276455, 250726, 6884, 152576, `${PUP} --type=renderer`],
  [381769, 250726, 5537, 142336, `${PUP} --type=renderer`],
  [509743, 250726, 3805, 25600, `${PUP} --type=renderer`],
  [321844, 4143712, 6257, 28672, `${PW} --headless`],
  [321846, 321844, 6257, 15360, `${PW} --type=zygote`],
  [250718, 1, 7302, 2048, `${PUP} --type=broker`],
  // Never a candidate: the user's own browser, outside the declared paths. If
  // this is ever swept the anchor has broken, and the cost is a human's tabs.
  [900001, 1, 99999, 800000, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
];

const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

const shape = procs => procs.map(([pid, ppid, etimes, rss, args]) => ({ pid, ppid, etimes, rss, args }));

/**
 * One sweep, fully injected.
 *
 * `procs === null` is a `ps` that could not answer at all; `[]` is a `ps` that
 * answered with nothing of ours in it. The two are different findings. `then` is
 * what the SECOND `ps` sees, which is how a pid that changed hands between the
 * two signals is modelled.
 *
 * `pgid: pid => pid` puts every process in its own group, so nothing collides
 * with the caller's by accident — the own-group case names itself explicitly.
 */
const run = (argv, { procs = GAPICORE, then, env = {}, pgid = pid => pid } = {}) => {
  const signalled = [];
  const slept = [];
  let reads = 0;
  const result = capture(() =>
    sweep([...argv], {
      snapshot: () => {
        reads += 1;
        const source = reads > 1 && then !== undefined ? then : procs;
        return source === null ? null : shape(source);
      },
      kill: (pid, signal) => signalled.push(`${signal} ${pid}`),
      sleep: ms => slept.push(ms),
      pgid,
      env,
      home: HOME,
    }),
  );
  return { ...result, signalled, slept };
};

// ── the column, which is where a host difference hides ───────────────────────

test('elapsed time is read from `etime`, in every shape both hosts print', () => {
  // `etimes` is what the Bash asked for, with a comment claiming macOS 26 was
  // verified. It was not: the system `/bin/ps` there answers `etimes: keyword
  // not found`, exits 1, and still prints 162 KB of rows — the check had gone
  // through a harness `ps` on PATH. These are real columns from both machines.
  assert.equal(elapsedSeconds('56:26'), 56 * 60 + 26);
  assert.equal(elapsedSeconds('16:19:49'), 16 * 3600 + 19 * 60 + 49);
  assert.equal(elapsedSeconds('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(elapsedSeconds('00:00'), 0);
  // Not a duration: a seconds count, which is what the unportable column gave.
  // Reading 7302 as `73:02` would be a two-hour root called one minute old.
  assert.equal(elapsedSeconds('7302'), null);
  assert.equal(elapsedSeconds(''), null);
});

test('a row is dropped rather than guessed, and args may contain spaces', () => {
  const rows = readPs(
    [
      '  296 21924 16:19:49   89536 /Users/flo/.bun/bin/bun cli.js __omp_worker',
      ' 9729  1479    56:14  157136 /Applications/System Events.app/Contents/MacOS/System Events launchd',
      'ps: etimes: keyword not found',
      '  bad row with too few',
      '',
    ].join('\n'),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 296, ppid: 21924, etimes: 58789, rss: 89536, args: '/Users/flo/.bun/bin/bun cli.js __omp_worker' });
  // The args column is the only one allowed to contain spaces, and it keeps them.
  assert.match(rows[1].args, /System Events\.app\/Contents\/MacOS\/System Events launchd$/);
});

// ── the predicate ────────────────────────────────────────────────────────────

test('the two-hour root is one root, and it is what gets swept', () => {
  const r = run([...UNDER]);
  assert.equal(r.code, 0);
  // Three roots: the puppeteer browser, the playwright shell, and the ppid=1
  // orphan. The seven descendants are NOT roots — signalling a root takes its
  // tree, which is why the age test belongs there and nowhere else.
  assert.match(r.out, /sweep\s+root 250706/);
  assert.match(r.out, /sweep\s+root 321844/);
  assert.match(r.out, /sweep\s+root 250718/);
  assert.doesNotMatch(r.out, /root 276455/);
  assert.doesNotMatch(r.out, /root 250726/);
});

test('a browser the user launched is never a candidate', () => {
  const r = run([...UNDER]);
  assert.doesNotMatch(r.out, /900001/);
  // Ten declared-path processes, and the user's Chrome is not among the MB.
  assert.match(r.out, /across 10 processes/);
});

test('a root under the age floor is KEPT — this is the live-session case', () => {
  // Same browser, five minutes old, owner alive. A stage in flight looks exactly
  // like this, and sweeping it kills a browser an agent is driving.
  const r = run([...UNDER], {
    procs: [
      [250706, 4141019, 300, 115712, `${PUP} --disable-background-networking`],
      [276455, 250706, 280, 152576, `${PUP} --type=renderer`],
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /keep\s+root 250706/);
  assert.match(r.out, /1 root\(s\) kept/);
  assert.match(r.out, /nothing to sweep/);
  assert.deepEqual(r.signalled, []);
});

test('an orphan is swept at any age, because no session is left to drive it', () => {
  const r = run([...UNDER], { procs: [[250718, 1, 12, 2048, `${PUP} --type=broker`]] });
  assert.match(r.out, /orphan \(ppid=1\)/);
  // Twelve seconds old — far under the 30 minute floor, and still swept.
  assert.doesNotMatch(r.out, /keep/);
});

// ── the floor ────────────────────────────────────────────────────────────────

test('--max-age moves the floor, and a missing value is refused', () => {
  const procs = [[250706, 4141019, 1200, 115712, `${PUP} --headless`]];
  // Twenty minutes: kept under the 30 minute default, swept at a 10 minute floor.
  assert.match(run([...UNDER], { procs }).out, /keep\s+root 250706/);
  assert.match(run([...UNDER, '--max-age', '10'], { procs }).out, /sweep\s+root 250706/);

  const bad = run([...UNDER, '--max-age'], { procs });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /--max-age expects minutes/);
});

test('a floor that is not a number refuses, rather than collapsing to zero', () => {
  // The Bash computed `$(( $2 * 60 ))`, and shell arithmetic reads `lots` as 0:
  // the floor vanished and every live root became eligible, on the one verb that
  // signals processes. Same class as the triage cap, opposite consequence.
  //
  // `' '` and `'0x10'` are that same defect in a new language: `Number(' ')` is 0,
  // and `Number('0x10')` is a floor nobody typed.
  const procs = [[250706, 4141019, 300, 115712, `${PUP} --headless`]];
  for (const value of ['lots', '-5', '2.5', '', ' ', '\t', '0x10', '1e2', '+30', ' 30 ']) {
    const r = run([...UNDER, '--max-age', value], { procs });
    assert.equal(r.code, 2, `${JSON.stringify(value)} must be refused`);
    assert.deepEqual(r.signalled, []);
  }
});

test('an unreadable env floor is refused too — the default is not a fallback for garbage', () => {
  const r = run([...UNDER], { env: { AX_SWEEP_MAX_AGE_MIN: 'thirty' }, procs: [[1234, 1, 60, 100, `${PUP} --headless`]] });
  assert.equal(r.code, 2);
  assert.match(r.out, /AX_SWEEP_MAX_AGE_MIN/);
  assert.deepEqual(r.signalled, []);
});

// ── ownership: what this verb is allowed to consider ─────────────────────────

test('with no --under nothing is a candidate, and the refusal names the flag', () => {
  // No built-in path list, on the precedent `src/proc.mjs` already states beside
  // its own reaper: a hardcoded list is project policy living in a library, and
  // it can only ever be wrong for the next machine.
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.out, /--under/);
  assert.deepEqual(r.signalled, []);
});

test('a path that claims a whole machine or a whole home is refused', () => {
  // `launch.hosts.*.sweep` is argv from a config file, which is PR-editable: a
  // permissive value turns a host-scoped verb into a sweep of someone's tabs.
  for (const path of ['/', '/home', HOME, `${HOME}/`, 'relative/chrome', `${HOME}/../orca/.cache`, `${HOME}/.cache/../../orca`]) {
    const r = run(['--under', path]);
    assert.equal(r.code, 2, `${path} must be refused`);
    assert.deepEqual(r.signalled, []);
  }
});

test('ownership matches a path COMPONENT, never a prefix of a name', () => {
  // `…/ms-playwright-nightly` is not inside `…/ms-playwright`, and a substring
  // match would sweep it.
  const r = run(['--under', `${HOME}/.cache/ms-playwright`], {
    procs: [[4242, 1, 99999, 4096, `${HOME}/.cache/ms-playwright-nightly/chrome-headless-shell --headless`]],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /no browser found under the declared path\(s\)/);
  assert.deepEqual(r.signalled, []);
});

// ── the mutation ─────────────────────────────────────────────────────────────

test('dry run is the default: it classifies, and signals nothing', () => {
  const r = run([...UNDER]);
  assert.match(r.out, /DRY RUN — pass --apply to sweep: 250706 321844 250718/);
  assert.doesNotMatch(r.out, /swept \d/);
  assert.deepEqual(r.signalled, []);
});

test('--apply signals the roots only, TERM before KILL', () => {
  const r = run([...UNDER, '--apply']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.signalled, [
    'SIGTERM 250706',
    'SIGTERM 321844',
    'SIGTERM 250718',
    'SIGKILL 250706',
    'SIGKILL 321844',
    'SIGKILL 250718',
  ]);
  assert.deepEqual(r.slept, [4000]);
  assert.match(r.out, /swept 3 root\(s\)/);
});

test('a pid handed to something else inside the four seconds is not force-killed', () => {
  // A TERMed root frees its pid, and the kernel may hand it to anything.
  const r = run([...UNDER, '--apply'], {
    procs: [[250706, 4141019, 7302, 115712, `${PUP} --headless`]],
    then: [[250706, 1, 2, 900, '/usr/bin/postgres -D /var/lib/postgresql']],
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.signalled, ['SIGTERM 250706']);
  assert.match(r.out, /1 no longer eligible/);
});

test('a pid reused by a FRESH browser under the same declared path is not force-killed', () => {
  // The sharp case, and the reason the second read is re-judged by the whole
  // predicate rather than by the declared path alone: the next stage's browser
  // can be handed that very number under that very path. Two seconds old, owner
  // alive — a young root, which is a keep.
  const r = run([...UNDER, '--apply'], {
    procs: [[250706, 4141019, 7302, 115712, `${PUP} --headless`]],
    then: [[250706, 4141019, 2, 90000, `${PUP} --headless`]],
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.signalled, ['SIGTERM 250706']);
  assert.match(r.out, /1 no longer eligible/);
});

test('a host that cannot be re-read is not force-killed either', () => {
  const r = run([...UNDER, '--apply'], { procs: [[250706, 4141019, 7302, 115712, `${PUP} --headless`]], then: null });
  assert.equal(r.code, 0);
  assert.deepEqual(r.signalled, ['SIGTERM 250706']);
  assert.match(r.out, /ps could not re-read the host, so nothing was forced/);
});

test('this verb never signals its own process group', () => {
  // A sweep that kills the group it runs in dies halfway through — the defect
  // `reapByCwd` already carries a guard for, on this same machine.
  const r = run([...UNDER, '--apply'], {
    procs: [[250706, 4141019, 7302, 115712, `${PUP} --headless`]],
    pgid: () => 4141019,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /own process group/);
  assert.deepEqual(r.signalled, []);
});

// ── the two silences ─────────────────────────────────────────────────────────

test('the two empty cases are distinct, and neither is a failure', () => {
  // A `ps` that could not answer at all. Reporting this as "no browser found"
  // would claim a measurement that never happened.
  const silent = run([...UNDER], { procs: null });
  assert.equal(silent.code, 0);
  assert.match(silent.out, /ps returned nothing/);

  // A `ps` that answered, with nothing of ours in it. That IS a measurement.
  const clean = run([...UNDER], { procs: [[900001, 1, 99999, 800000, '/usr/lib/firefox/firefox']] });
  assert.equal(clean.code, 0);
  assert.match(clean.out, /no browser found under the declared path\(s\)/);
});

test('a sweep that cannot run is never why a dispatch stops', () => {
  // Exit 0 on every outcome but bad usage. `proveHost` reads only `status === 0`
  // and turns anything else into "not swept, measuring anyway" — so a nonzero
  // here would be a refusal about garbage, which is what this verb prevents.
  assert.equal(run([...UNDER], { procs: null }).code, 0);
  assert.equal(run([...UNDER], { procs: [] }).code, 0);
  assert.equal(run([...UNDER, '--apply']).code, 0);
});
