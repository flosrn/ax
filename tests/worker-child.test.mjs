// What is prepared INSIDE a dispatched child's worktree.
//
// On a REAL temp repo with REAL linked worktrees (repo law): both defects these
// functions exist for are invisible to a mocked filesystem. `--git-path` without
// `--path-format=absolute` answers relative to the repository it resolved, so a
// mock that records the write it was handed would report success on the exact
// bug; and `git config --worktree` only behaves per worktree when the worktree is
// linked for real.
//
// Nothing here touches the machine's own git config: every invocation runs with
// an isolated GIT_CONFIG_GLOBAL and no system config.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { equipment, pinIdentity, untilEquipped, writeMandate } from '../src/worker/child.mjs';

const MANDATE_REL = '.omp/WATCHDOG.yml';

/** An `exec` in the module's shape, with git's config lookup pinned to a file. */
const gitExec = globalConfig => (bin, args, at) => {
  const out = spawnSync(bin, args, {
    cwd: at,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error };
};

/**
 * A repo with one commit and one LINKED worktree — the shape a launch places a
 * child into. The commit exists because `git worktree add` needs a HEAD, and its
 * author is passed with `-c` so it leaves no identity behind for the pin tests to
 * read by accident.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ax-child-'));
  const repo = join(root, 'repo');
  const globalConfig = join(root, 'gitconfig.global');
  writeFileSync(globalConfig, '');
  const exec = gitExec(globalConfig);

  exec('git', ['init', '-q', '-b', 'main', repo], root);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  exec('git', ['-C', repo, 'add', '.'], root);
  exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'init'], root);

  const worktree = join(root, 'wt');
  const added = exec('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'child', worktree], root);
  assert.equal(added.status, 0, added.stderr);

  return { root, repo, worktree, globalConfig, exec };
}

/** The exclude file git itself resolves for that worktree — never composed here. */
function excludeFile(worktree, exec) {
  const out = exec('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], worktree);
  return out.stdout.split('\n')[0].trim();
}

test('the mandate lands in the CHILD worktree and never at the repository root', () => {
  // Advisor discovery walks from cwd up to the repo root, so a repo-root mandate
  // would also advise the OPERATOR's own sessions in that repo.
  const s = fixture();
  const result = writeMandate(s.worktree, { exec: s.exec });
  assert.equal(result.written, true);

  const mandate = readFileSync(join(s.worktree, MANDATE_REL), 'utf8');
  // The visible OMP tag attributes this worktree-scoped advisor to ax. A functional
  // name would mislabel its ordinary review notes, which are not limited to todo state.
  assert.match(mandate, /\n  - name: ax\n/);
  assert.ok(!mandate.includes('name: pilot'));
  assert.ok(!existsSync(join(s.repo, MANDATE_REL)));
  // `blocker` is the load-bearing word: the one severity documented to steer a
  // turn after a terminal answer, which is exactly when a child with a stale
  // list would otherwise finish and go silent.
  assert.ok(mandate.includes('blocker'));
  assert.ok(mandate.includes('concern'));
  assert.ok(mandate.includes('todo'));
  // Read-only tools: an advisor cannot tick the boxes and must not try.
  assert.ok(mandate.includes('tools: [read, grep, glob]'));
  // Measured 2026-08-15: 299 turns, 28 merge conflicts, exactly one todo call.
  assert.ok(mandate.includes('299 turns'));
  // And the one instruction that saves turns rather than spending them.
  assert.ok(mandate.includes('Say nothing about heartbeats'));
});

test('the mandate is appended to the exclude file git resolves, read back from disk', () => {
  // The defect this pins: the bare `--git-path info/exclude` answers RELATIVE to
  // the resolved repository, so appending from another cwd wrote nothing and said
  // nothing. Only a real repo can tell the two forms apart, and an exclude that
  // fails open leaks the mandate into the child's pull request.
  const s = fixture();
  const result = writeMandate(s.worktree, { exec: s.exec });
  assert.equal(result.hidden, true);

  const exclude = excludeFile(s.worktree, s.exec);
  assert.ok(exclude.startsWith('/'), exclude);
  assert.ok(readFileSync(exclude, 'utf8').split('\n').includes(MANDATE_REL));
  // Nothing was written to a relative path beside the worktree instead.
  assert.ok(!existsSync(join(s.worktree, 'info', 'exclude')));
});

test('a second launch in the same repo does not duplicate the exclude line', () => {
  // Five children of one repo is the measured population, and an exclude file
  // that grows one line per dispatch is how a human stops reading it.
  const s = fixture();
  writeMandate(s.worktree, { exec: s.exec });
  writeMandate(s.worktree, { exec: s.exec });
  const lines = readFileSync(excludeFile(s.worktree, s.exec), 'utf8').split('\n').filter(line => line === MANDATE_REL);
  assert.equal(lines.length, 1);
});

test('an unresolvable exclude file is ANNOUNCED, and the mandate is still written', () => {
  // A guard that skips silently reads exactly like a guard that passed. The
  // operator has to know the file will otherwise be committed.
  const s = fixture();
  const result = writeMandate(s.worktree, { exec: () => ({ status: 128, stdout: '', stderr: 'not a git repository' }) });
  assert.equal(result.written, true);
  assert.equal(result.hidden, false);
  assert.match(result.notes.join('\n'), /NOT hidden from git/);
  // Every finding names its repair.
  assert.match(result.notes.join('\n'), /remove it before committing/);
  assert.ok(existsSync(join(s.worktree, MANDATE_REL)));
  // The note described the file as "this worktree's git exclude file" while the
  // repair it prints in the same sentence resolves the REPOSITORY's shared
  // `info/exclude` — there is no worktree-scoped exclude. The announcement now
  // describes the file its own repair names.
  assert.doesNotMatch(result.notes.join('\n'), /this worktree's git exclude/);
  assert.match(result.notes.join('\n'), /repository/);
});

test('a relative exclude answer is treated as unresolved, not appended to blindly', () => {
  // This IS the bare `--git-path` output. Accepting it is the original bug.
  const s = fixture();
  const result = writeMandate(s.worktree, { exec: () => ({ status: 0, stdout: 'info/exclude\n', stderr: '' }) });
  assert.equal(result.hidden, false);
  assert.ok(!existsSync(join(s.worktree, 'info', 'exclude')));
});

test('a contaminated local user.name is pinned DE-TAGGED to this worktree', () => {
  // Measured 2026-08-16 with five children of one repo in flight: `.git/config`
  // is shared by every linked worktree, so each pull request's babysitter renamed
  // `user.name` there and signed its NEIGHBOUR's commits. A fifth child launches
  // into exactly this state, and pinning the value verbatim would carry the
  // neighbour's tag in while reporting success.
  const s = fixture();
  writeFileSync(s.globalConfig, '[user]\n\tname = flosrn\n\temail = flo@example.test\n');
  s.exec('git', ['-C', s.repo, 'config', 'user.name', 'Florian Seran (babysit PR#1957)'], s.repo);
  s.exec('git', ['-C', s.repo, 'config', 'user.email', 'flo@example.test'], s.repo);

  const result = pinIdentity(s.worktree, { exec: s.exec });
  assert.equal(result.pinned, true);
  assert.equal(result.name, 'Florian Seran');

  const pinned = s.exec('git', ['-C', s.worktree, 'config', '--worktree', '--get', 'user.name'], s.worktree);
  assert.equal(pinned.stdout.trim(), 'Florian Seran');
  // Two assertions with teeth, one per failure this replaces: the neighbour's
  // tag, and the global name that differs from every commit's author in the repo.
  assert.ok(!pinned.stdout.includes('babysit'));
  assert.ok(!pinned.stdout.includes('flosrn'));
  // The scope is the one a neighbour cannot reach.
  const enabled = s.exec('git', ['-C', s.worktree, 'config', '--get', 'extensions.worktreeConfig'], s.worktree);
  assert.equal(enabled.stdout.trim(), 'true');
});

test('the pin does not reach a SIBLING worktree of the same repo', () => {
  // The whole point: this is the failure, not a nicety. One babysitter renaming
  // the shared value signed every sibling's commits, each unable to see it.
  const s = fixture();
  s.exec('git', ['-C', s.repo, 'config', 'user.name', 'Repo Author'], s.repo);
  s.exec('git', ['-C', s.repo, 'config', 'user.email', 'repo@example.test'], s.repo);
  const sibling = join(s.root, 'wt2');
  assert.equal(s.exec('git', ['-C', s.repo, 'worktree', 'add', '-q', '-b', 'sibling', sibling], s.root).status, 0);

  pinIdentity(s.worktree, { exec: s.exec });
  s.exec('git', ['-C', s.worktree, 'config', '--worktree', 'user.name', 'Repo Author (babysit PR#1958)'], s.worktree);

  const neighbour = s.exec('git', ['-C', sibling, 'config', '--get', 'user.name'], sibling);
  assert.equal(neighbour.stdout.trim(), 'Repo Author');
});

test('the global identity is used only when the repo carries none', () => {
  // Reading the global FIRST was measured wrong on 2026-08-16: this machine's
  // global name differs from every commit's author in that repository, so a
  // global-first pin would have re-authored a whole fleet of children under the
  // wrong name — and a cosmetic defect in history is permanent.
  const s = fixture();
  writeFileSync(s.globalConfig, '[user]\n\tname = flosrn\n\temail = flo@example.test\n');

  const result = pinIdentity(s.worktree, { exec: s.exec });
  assert.equal(result.pinned, true);
  assert.equal(result.name, 'flosrn');
  assert.equal(s.exec('git', ['-C', s.worktree, 'config', '--worktree', '--get', 'user.name'], s.worktree).stdout.trim(), 'flosrn');
});

test('no identity anywhere is ANNOUNCED, never a refusal', () => {
  // The child then inherits the shared name and a babysitter can sign its
  // commits, which is exactly what the caller needs to know before it happens —
  // and not a reason to keep the child from starting.
  const s = fixture();
  const result = pinIdentity(s.worktree, { exec: s.exec });
  assert.equal(result.pinned, false);
  assert.match(result.notes.join('\n'), /inherits the SHARED user\.name/);
  assert.match(result.notes.join('\n'), /config --worktree user\.name/);
});

test('a refused per-worktree write is ANNOUNCED with the scope to enable', () => {
  // The scope needs `extensions.worktreeConfig`, and a git that will not take it
  // leaves the child on the shared value. Silence here reads as a pin that held.
  const s = fixture();
  // An identity exists to pin: this test is about the WRITE being refused, not
  // about there being nothing to write.
  s.exec('git', ['-C', s.repo, 'config', 'user.name', 'Repo Author'], s.repo);
  s.exec('git', ['-C', s.repo, 'config', 'user.email', 'repo@example.test'], s.repo);
  const result = pinIdentity(s.worktree, {
    exec: (bin, args, at) => (args.includes('--worktree') && !args.includes('--get') ? { status: 1, stdout: '', stderr: 'refused' } : s.exec(bin, args, at)),
  });
  assert.equal(result.pinned, false);
  assert.match(result.notes.join('\n'), /could NOT pin a per-worktree git identity/);
  assert.match(result.notes.join('\n'), /extensions\.worktreeConfig true/);
});

// ── the OMP bundle the child boots with ──────────────────────────────────────

/** `.omp/settings.json` as `ax init` leaves it, tracked and therefore in every worktree. */
function registers(worktree, ...extensions) {
  mkdirSync(join(worktree, '.omp'), { recursive: true });
  writeFileSync(join(worktree, '.omp', 'settings.json'), `${JSON.stringify({ extensions }, null, 2)}\n`);
}

/** The installed package, as pnpm links it: a root with an `omp.extensions` manifest. */
function installs(worktree, rel, { manifest = true, entry = true } = {}) {
  const root = join(worktree, rel);
  mkdirSync(join(root, 'omp'), { recursive: true });
  if (manifest) writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@flosrn/ax', omp: { extensions: ['./omp/index.ts'] } }));
  if (entry) writeFileSync(join(root, 'omp', 'index.ts'), 'export default {};\n');
  return root;
}

/** A complete, valid extension that is NOT ax — nothing in it consumes a role marker. */
function foreign(worktree, rel) {
  const root = join(worktree, rel);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@vendor/omp-thing', omp: { extensions: ['./src/index.ts'] } }));
  writeFileSync(join(root, 'src', 'index.ts'), 'export default {};\n');
  return root;
}

test('a settings file registering NO ax bundle is a wiring fault, never equipment', () => {
  // The proof is not "every declared extension resolves" — a project can load a
  // perfectly healthy foreign extension and still consume no role marker, which
  // is the same unequipped child by a different route. Waiting cannot fix it, so
  // it must not be reported as an install in flight either.
  const s = fixture();
  registers(s.worktree, './node_modules/@vendor/omp-thing');
  foreign(s.worktree, 'node_modules/@vendor/omp-thing');

  const probe = equipment(s.worktree);
  assert.equal(probe.measured, true);
  assert.equal(probe.ready, false);
  assert.equal(probe.wiring, true);
  assert.match(probe.reason, /@flosrn\/ax/);
  assert.deepEqual(probe.missing, [], 'nothing is missing from disk — the registration is');
});

test('a LOOKALIKE package path is not the ax bundle, however healthy it is', () => {
  // `./node_modules/@flosrn/ax-fork` carries the substring, ships a valid
  // `omp.extensions` of its own, and consumes no AX role marker. Identifying the
  // registration by path shape would answer READY for a worktree that registers
  // no ax at all — the same unequipped child, now with a green ground in front
  // of it. Identity is the NAME the package declares, or the exact root init
  // writes when no manifest is readable yet.
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax-fork');
  const root = join(s.worktree, 'node_modules', '@flosrn', 'ax-fork');
  mkdirSync(join(root, 'omp'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@flosrn/ax-fork', omp: { extensions: ['./omp/index.ts'] } }));
  writeFileSync(join(root, 'omp', 'index.ts'), 'export default {};\n');

  const probe = equipment(s.worktree);
  assert.equal(probe.ready, false);
  assert.equal(probe.wiring, true);
  assert.match(probe.reason, /none of them is @flosrn\/ax/);
});

test('bytes at the ax path that declare ANOTHER name are not the ax bundle', () => {
  // The expected root is only a fallback for a manifest that cannot be read yet.
  // Once it is readable it decides: a package sitting at `node_modules/@flosrn/ax`
  // and calling itself something else consumes no role marker, and a probe that
  // trusted the path would hand a launch a green ground over an unequipped child.
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');
  const root = join(s.worktree, 'node_modules', '@flosrn', 'ax');
  mkdirSync(join(root, 'omp'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@vendor/impostor', omp: { extensions: ['./omp/index.ts'] } }));
  writeFileSync(join(root, 'omp', 'index.ts'), 'export default {};\n');

  const probe = equipment(s.worktree);
  assert.equal(probe.ready, false);
  assert.equal(probe.wiring, true);
  assert.match(probe.reason, /none of them is @flosrn\/ax/);
});

test('a settings file that EXISTS and cannot be read is a wiring fault, never unmeasured', () => {
  // An absent file is a project that declared nothing. A present, broken one is a
  // declared loader that loads nothing — same unequipped child, and no wait
  // repairs it, so it must not pass as "not measured here".
  const s = fixture();
  mkdirSync(join(s.worktree, '.omp'), { recursive: true });
  writeFileSync(join(s.worktree, '.omp', 'settings.json'), '{ not json');

  const probe = equipment(s.worktree);
  assert.equal(probe.measured, true);
  assert.equal(probe.wiring, true);
  assert.match(probe.reason, /\.omp\/settings\.json exists and could not be read/);
});

test('a settings file carrying no extensions array is a wiring fault', () => {
  const s = fixture();
  mkdirSync(join(s.worktree, '.omp'), { recursive: true });
  writeFileSync(join(s.worktree, '.omp', 'settings.json'), JSON.stringify({ extensions: 'ax' }));

  const probe = equipment(s.worktree);
  assert.equal(probe.wiring, true);
  assert.match(probe.reason, /package-root strings/);
});

test('an empty extensions array is a wiring fault, not an equipped worktree', () => {
  const s = fixture();
  registers(s.worktree);

  const probe = equipment(s.worktree);
  assert.equal(probe.measured, true);
  assert.equal(probe.ready, false);
  assert.equal(probe.wiring, true);
});

test('a foreign extension beside an installed ax bundle is equipped, and never blocks on the neighbour', () => {
  // Foreign wiring is not ax's ground. A missing neighbour is the project's
  // business; refusing a launch over it would be a floor nobody declared.
  const s = fixture();
  registers(s.worktree, './node_modules/@vendor/omp-thing', './node_modules/@flosrn/ax');
  installs(s.worktree, 'node_modules/@flosrn/ax');

  const probe = equipment(s.worktree);
  assert.equal(probe.ready, true);
  assert.equal(probe.wiring, false);
});

test('the ax bundle registered TWICE is a wiring fault: OMP would load every handler twice', () => {
  // `ax doctor` grades exactly one registration, and duplicate peer receive loops
  // consume each other's messages (AGENTS.md). A launch must not call that ready.
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax', './node_modules/@flosrn/ax');
  installs(s.worktree, 'node_modules/@flosrn/ax');

  const probe = equipment(s.worktree);
  assert.equal(probe.ready, false);
  assert.equal(probe.wiring, true);
  assert.match(probe.reason, /twice|2 time/);
});

test('a wiring fault ends the poll immediately — no wait can install a registration', () => {
  const s = fixture();
  registers(s.worktree);

  let slept = 0;
  const result = untilEquipped({ worktree: s.worktree, deadline: 1e9, now: () => 0, sleep: () => (slept += 1), tickMs: 1 });
  assert.equal(result.wiring, true);
  assert.equal(slept, 0);
});

test('an ax package that declares NO omp.extensions is not equipment either', () => {
  // The registration is right and the bytes are there, and OMP still loads no
  // bundle: it reads what to load from this manifest. Treating a present package
  // as sufficient is the same false green the whole probe exists to remove.
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');
  const root = join(s.worktree, 'node_modules', '@flosrn', 'ax');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@flosrn/ax', version: '0.9.0' }));

  const probe = equipment(s.worktree);
  assert.equal(probe.ready, false);
  assert.match(probe.missing.join(' '), /omp\.extensions/);
});

test('a settings file naming an uninstalled bundle is NOT equipped, and names the path', () => {
  // Measured 2026-08-28 on ofmchat #101: the dispatch went out at 07:17:06 and
  // `node_modules/@flosrn/ax` did not exist until 07:17:11. The child booted with
  // no AX bundle, so nothing consumed its `[omp role=worker model=@default]`
  // marker — one model_change on the boot model, no role receipt, ever. It
  // implemented the ticket unequipped and looked healthy in `gate` and `tail`.
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');

  const probe = equipment(s.worktree);
  assert.equal(probe.measured, true);
  assert.equal(probe.ready, false);
  assert.deepEqual(probe.missing, ['./node_modules/@flosrn/ax']);
});

test('an installed bundle whose own omp manifest resolves IS equipped', () => {
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');
  installs(s.worktree, 'node_modules/@flosrn/ax');

  const probe = equipment(s.worktree);
  assert.equal(probe.measured, true);
  assert.equal(probe.ready, true);
  assert.deepEqual(probe.missing, []);
});

test('an install still in flight is NOT equipped: the directory exists and the manifest does not', () => {
  // The window this closes is small and real — pnpm created the directory five
  // seconds before the boot that could not load it.
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');
  installs(s.worktree, 'node_modules/@flosrn/ax', { manifest: false });

  assert.equal(equipment(s.worktree).ready, false);
});

test('a manifest whose declared entry is absent is NOT equipped', () => {
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');
  installs(s.worktree, 'node_modules/@flosrn/ax', { entry: false });

  const probe = equipment(s.worktree);
  assert.equal(probe.ready, false);
  assert.match(probe.missing.join(' '), /omp\/index\.ts/);
});

test('a worktree carrying no settings file is NOT MEASURED, never reported equipped', () => {
  // A ground a project does not declare is not measured and says so. `ax doctor`
  // owns the wiring; a launch must not invent a floor this repo never set.
  const s = fixture();
  const probe = equipment(s.worktree);
  assert.equal(probe.measured, false);
  assert.equal(probe.ready, false);
  assert.match(probe.reason, /\.omp\/settings\.json/);
});

test('the poll answers ready as soon as the install lands, and spends no further tick', () => {
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');

  let clock = 0;
  let slept = 0;
  const result = untilEquipped({
    worktree: s.worktree,
    deadline: 10_000,
    now: () => (clock += 1000),
    sleep: () => {
      slept += 1;
      if (slept === 2) installs(s.worktree, 'node_modules/@flosrn/ax');
    },
    tickMs: 1,
  });

  assert.equal(result.ready, true);
  assert.equal(slept, 2, 'the loop stops on the tick the bundle appeared');
});

test('an install that never lands times out UNREADY, and still names the path', () => {
  const s = fixture();
  registers(s.worktree, './node_modules/@flosrn/ax');

  let clock = 0;
  const result = untilEquipped({
    worktree: s.worktree,
    deadline: 3000,
    now: () => (clock += 1000),
    sleep: () => {},
    tickMs: 1,
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['./node_modules/@flosrn/ax']);
});
