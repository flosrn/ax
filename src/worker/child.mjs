// What is prepared INSIDE a dispatched child's worktree, before it is dispatched.
//
// Three things, and all of them are about a failure that is invisible from the
// orchestrator's side until it is expensive: a child whose todo list never
// moves is never reported home, a child that inherits a shared git identity
// gets its commits signed by a sibling's babysitter, and a child that boots
// before its OMP bundle is installed runs with no role, no playbook and its
// boot model.
//
// Only `equipment` refuses anything. The other two ANNOUNCE, because neither
// degrades the work itself. An unequipped child does: it is a different agent
// than the one the brief addressed, editing the repository for real.
//
// Nothing here prints. Each function returns its `notes` or its verdict for the
// caller to emit through ../log.mjs, so the same preparation can be asserted
// offline and the operator still reads one stream.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PACKAGE_NAME } from '../config.mjs';
import { OMP_SETTINGS } from '../init.mjs';
import { ompExtensionRoot } from '../plan.mjs';
import { defaultExec } from '../exec.mjs';

/**
 * Worktree-relative, because it is written into the child's tree and excluded
 * from it by the same string. Never at the repository root: advisor discovery
 * walks from cwd up to the repo root, so `<repo>/.omp/WATCHDOG.yml` would also
 * advise the OPERATOR's own sessions in that repo, which nobody asked for.
 */
const MANDATE_REL = '.omp/WATCHDOG.yml';

/**
 * The mandate itself.
 *
 * An advisor is ALREADY attached to every child — measured 2026-08-15, a 930 KB
 * advisor transcript beside a child's own. What it lacked was a mandate: the
 * user-level roster talks about type errors, so nothing was watching the one
 * signal an orchestrator depends on.
 *
 * WHY A ROSTER FILE AND NOT A PARAGRAPH IN THE BRIEF. The brief is read once at
 * boot and decays over hours; that is a discipline-shaped signal, and those go
 * quiet exactly when they matter. An advisor re-derives its verdict from the
 * transcript delta every turn, so it cannot be forgotten. The lever is severity:
 * a `blocker` is the one severity documented to steer a turn even when the tail
 * is a terminal answer — precisely the moment a child with a stale list would
 * otherwise finish and go silent.
 *
 * WHAT IT CANNOT DO, so nobody proposes it again: tick the boxes. An advisor does
 * not mutate primary session state, and the todo tool writes through the calling
 * session's own state while the advisor holds an isolated tool session. It can
 * only make the primary do it.
 *
 * Written as one literal rather than composed: it is a contract a model reads,
 * so a line of it is only ever changed on purpose, by an incident.
 */
const MANDATE = `# Written by ax worker dispatch. Worktree-scoped: it advises this dispatched
# child only, never the operator's own sessions. Not tracked; see .git/info/exclude.
advisors:
  - name: pilot
    tools: [read, grep, glob]
    instructions: |
      You watch ONE thing beyond your normal review: whether this session's todo list
      still describes reality. It is not housekeeping. The orchestrator's wake-up is
      DERIVED from that list - the harness reports home when every remaining task is
      done or blocked - so a list frozen at its init means the orchestrator is never told
      the work finished. Measured 2026-08-15: a child ran 299 turns, resolved 28 merge
      conflicts and called the todo tool exactly once.

      Raise a concern when the transcript shows a task plainly finished while the list
      still carries it open. NAME THE TASK and what in the transcript closed it. Do not
      repeat yourself: an advisor note that normalizes to one already accepted is dropped
      silently, so a generic reminder fires once and then protects nothing.

      Raise a blocker, and only here, when the session is about to end - a terminal
      answer, a final report, a handoff - with open tasks the transcript shows as done.
      That is the one severity that still triggers a turn after a terminal answer, and
      that moment is exactly when the orchestrator loses the child.

      Say nothing about heartbeats. The spec asks for one every five minutes; nothing
      consumes them here and liveness is covered by a stall watcher that needs no
      cooperation from this session. Turns spent on them are wasted.
`;

/** One filesystem seam, so a caller can place the mandate anywhere it can write. */
const defaultWrite = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/**
 * Write the child's advisor mandate into ITS worktree, and hide it from git.
 *
 * The exclude path is ASKED FOR, never composed: `--path-format=absolute` is
 * load-bearing, because the bare `--git-path info/exclude` answers RELATIVE to
 * the repository it resolved — so appending to it from another cwd wrote nothing
 * and said nothing. Caught only by a test, which is the only reason it is not
 * still silent.
 *
 * An unresolvable exclude file is ANNOUNCED, never silent: the operator has to
 * know the mandate will otherwise ride along in the child's pull request.
 */
export function writeMandate(worktree, { exec = defaultExec, write = defaultWrite } = {}) {
  const notes = [];
  write(join(worktree, MANDATE_REL), MANDATE);

  const out = exec('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], worktree);
  const exclude = String(out?.stdout ?? '').split('\n')[0].trim();

  if (out?.status !== 0 || !exclude.startsWith('/')) {
    notes.push(
      `advisor mandate written, but this worktree's git exclude file could not be resolved, so ${MANDATE_REL} is NOT hidden from git — remove it before committing, or add it by hand: printf '${MANDATE_REL}\\n' >> "$(git -C ${worktree} rev-parse --path-format=absolute --git-path info/exclude)"`,
    );
    return { written: true, hidden: false, notes };
  }

  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes(MANDATE_REL)) {
    write(exclude, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${MANDATE_REL}\n`);
  }

  notes.push("advisor mandate written to the child's worktree (its todo list gates the report home)");
  return { written: true, hidden: true, notes };
}

/** The tag a babysitter appends to `user.name` while it holds a pull request. */
const BABYSIT_TAG = / \(babysit PR#[0-9]+\)$/;

function configValue(exec, worktree, scope, key) {
  const args = ['-C', worktree, 'config'];
  if (scope) args.push(scope);
  args.push('--get', key);
  const out = exec('git', args, worktree);
  return out?.status === 0 ? String(out.stdout ?? '').split('\n')[0].trim() : '';
}

/**
 * Pin `user.name`/`user.email` to THIS worktree.
 *
 * `.git/config` is SHARED by every linked worktree of a repository, so a
 * babysitter renaming `user.name` there signs the commits of every SIBLING
 * child. Measured 2026-08-16 with five children of one repo in flight: each pull
 * request's babysitter was signing the other's work, and neither could see it.
 * `git config --worktree` (behind `extensions.worktreeConfig`) is the one scope a
 * neighbour cannot reach. A babysitter's own `--worktree` write still overrides
 * this for its commits and its restore puts this value back; what it can no
 * longer do is reach a sibling.
 *
 * WHERE THE VALUE COMES FROM is the second half of the lesson. It is read from
 * the worktree's own effective config with any `(babysit PR#N)` tag stripped, and
 * the global is used ONLY when that is empty. Reading the global first was
 * measured wrong on 2026-08-16: this machine's global name differs from every
 * commit's author in that repository, so a global-first pin would have quietly
 * re-authored a whole fleet of children under the wrong name — and a cosmetic
 * defect in history is permanent. Stripping one tag is what makes the local value
 * safe to read even while a neighbour's babysitter holds it.
 *
 * Both failure paths are ANNOUNCED, never refused: an unpinnable identity is a
 * risk the caller must know about, not a reason to keep a child from starting.
 */
export function pinIdentity(worktree, { exec = defaultExec } = {}) {
  const notes = [];
  const name = configValue(exec, worktree, '', 'user.name').replace(BABYSIT_TAG, '') || configValue(exec, worktree, '--global', 'user.name');
  const email = configValue(exec, worktree, '', 'user.email') || configValue(exec, worktree, '--global', 'user.email');

  if (!name || !email) {
    notes.push(
      'no git identity to pin, so this child inherits the SHARED user.name and a concurrent babysitter\u2019s rename will sign its commits — set one: ' +
        `git -C ${worktree} config --worktree user.name "<name>" && git -C ${worktree} config --worktree user.email "<email>"`,
    );
    return { pinned: false, name, notes };
  }

  exec('git', ['-C', worktree, 'config', 'extensions.worktreeConfig', 'true'], worktree);
  const wroteName = exec('git', ['-C', worktree, 'config', '--worktree', 'user.name', name], worktree);
  const wroteMail = exec('git', ['-C', worktree, 'config', '--worktree', 'user.email', email], worktree);

  if (wroteName?.status !== 0 || wroteMail?.status !== 0) {
    notes.push(
      `could NOT pin a per-worktree git identity here, so a concurrent babysitter\u2019s shared rename will sign this child\u2019s commits — enable the scope and retry: git -C ${worktree} config extensions.worktreeConfig true`,
    );
    return { pinned: false, name, notes };
  }

  notes.push(`git identity pinned to this worktree (${name}) — a sibling\u2019s babysitter can no longer sign this child\u2019s commits`);
  return { pinned: true, name, notes };
}

/**
 * Is the AX bundle this worktree REGISTERS actually loadable in it?
 *
 * MEASURED 2026-08-28, ofmchat #101. `git worktree add` hands you a tree with no
 * node_modules (../worktree/setup.mjs says so and installs nothing), so the
 * install runs concurrently with the dispatch. That dispatch went out at 07:17:06
 * and `node_modules/@flosrn/ax` was not created until 07:17:11: the child booted
 * with no AX bundle at all, so nothing consumed the `[omp role=worker
 * model=@default]` marker its own brief carried. Its transcript holds exactly one
 * `model_change` — the boot model, no mover — and no role receipt in either
 * polarity, forever. It then implemented the ticket for real, on the wrong model,
 * with neither the worker role nor the implementation playbook, and both `gate`
 * and `tail` showed a healthy working agent. The dispatch's own verification said
 * UNPROVEN and was disbelieved, because it named no cause.
 *
 * THE PROPOSITION IS ABOUT THE AX ENTRY, NOT ABOUT EVERY ENTRY. "each declared
 * extension resolves" passes on `extensions: []` and on a project that loads a
 * perfectly healthy foreign extension — both of which produce the same
 * unequipped child. And the mirror error costs a dispatch: a foreign extension
 * this project owns and has not installed is not ax's floor to enforce. So
 * exactly one thing is graded, and it is identified by ../plan.mjs's own rule
 * (`ompExtensionRoot`: `.` for the ax checkout, the installed root everywhere
 * else) rather than by a second copy of that string — a self-hosted dispatch is
 * registered as `"."` and must not be refused as unwired.
 *
 * The two not-ready states are DIFFERENT ANSWERS and are separated by `wiring`:
 *   an install in flight  -> wait for it; the measured window was five seconds
 *   no/duplicate ax entry -> `ax init`; no amount of waiting installs a registration
 *
 * A worktree whose settings file cannot be read at all is NOT MEASURED and says
 * so. `ax doctor` owns the wiring, and a dispatch inventing a floor the project
 * never declared would refuse every repo that loads no ax bundle.
 */
export function equipment(worktree, { exists = existsSync, read = path => readFileSync(path, 'utf8') } = {}) {
  const settings = join(worktree, ...OMP_SETTINGS.split('/'));
  const wiring = reason => ({ measured: true, ready: false, wiring: true, missing: [], reason });
  // ABSENT is the one NOT MEASURED case: a project that never wired OMP here has
  // declared nothing, and a dispatch must not invent a floor for it. A file that
  // EXISTS and cannot be read is the opposite — a declared loader that loads
  // nothing, which no wait repairs and which boots an unequipped child.
  if (!exists(settings)) {
    return {
      measured: false,
      ready: false,
      wiring: false,
      missing: [],
      reason: `${worktree}/${OMP_SETTINGS} does not exist, so nothing registers the AX bundle here and this child's session role is NOT MEASURED`,
    };
  }

  let declared;
  try {
    declared = JSON.parse(read(settings))?.extensions;
  } catch (error) {
    return wiring(`${worktree}/${OMP_SETTINGS} exists and could not be read (${String(error.message ?? error)}), so OMP loads no project extension and this child consumes no role marker`);
  }
  if (!Array.isArray(declared) || declared.some(entry => typeof entry !== 'string')) {
    return wiring(`${worktree}/${OMP_SETTINGS} carries no extensions array of package-root strings, so OMP loads no project extension and this child consumes no role marker`);
  }

  const manifestOf = entry => {
    try {
      return JSON.parse(read(join(worktree, entry, 'package.json')));
    } catch {
      return null;
    }
  };

  // EXACT IDENTITY, never a path that looks like one. The NAME the package
  // declares is the proof, and it covers ax's own checkout (`"."`), a `link:` and
  // a workspace path in one rule. `./node_modules/@flosrn/ax-fork` carries the
  // substring and is a different package, whose own healthy `omp.extensions`
  // would otherwise answer READY for a worktree that registers no ax at all.
  //
  // The expected root is a fallback for ONE state and no wider: a manifest that
  // cannot be read YET, which is the install in flight this whole probe exists
  // for. Once that manifest is readable it decides — bytes at the ax path that
  // declare another name are another package, and nothing in them consumes a role
  // marker. Any other path with no readable manifest is reported as missing
  // WIRING, which is doctor's domain and the honest answer.
  const expected = ompExtensionRoot(worktree);
  const isAx = entry => {
    const manifest = manifestOf(entry);
    return manifest === null ? entry === expected : manifest.name === PACKAGE_NAME;
  };
  const ax = declared.filter(isAx);
  if (ax.length === 0) {
    return wiring(
      `${worktree}/${OMP_SETTINGS} registers ${declared.length} extension(s) and none of them is ${PACKAGE_NAME}, so nothing in this child consumes a role marker`,
    );
  }
  if (ax.length > 1) {
    return wiring(`${worktree}/${OMP_SETTINGS} registers ${PACKAGE_NAME} ${ax.length} times — OMP would load every AX handler twice, and duplicate receive loops consume each other's messages`);
  }

  // What OMP itself loads: the package root, then the `omp.extensions` manifest
  // inside it, then every file that manifest names. A directory pnpm has created
  // but not yet filled is NOT loadable — that is the five-second window above —
  // and neither is a package that declares no bundle at all: the registration is
  // right, the bytes are there, and OMP is told nothing to load.
  const [entry] = ax;
  const root = join(worktree, entry);
  const missing = [];
  if (!exists(root)) missing.push(entry);
  else {
    const entries = manifestOf(entry)?.omp?.extensions;
    if (!Array.isArray(entries) || entries.length === 0) missing.push(`${entry}/package.json omp.extensions`);
    else {
      for (const file of entries) {
        if (typeof file !== 'string') missing.push(`${entry}/package.json omp.extensions`);
        else if (!exists(join(root, file))) missing.push(`${entry}/${file.replace(/^\.\//, '')}`);
      }
    }
  }

  return { measured: true, ready: missing.length === 0, wiring: false, missing, reason: '' };
}

/**
 * The same probe, until the install in flight lands or the deadline passes.
 *
 * Waiting is the right disposition rather than an immediate refusal: the measured
 * window was five seconds of a pnpm install nobody could have run earlier, and
 * the same install completed three minutes later. `../worktree/setup.mjs` does
 * not install, so a concurrent install is the ordinary state of a fresh worktree.
 *
 * A wiring fault ends the loop at once. `.omp/settings.json` is tracked, so no
 * wait can make it register a bundle it does not name.
 */
export function untilEquipped({ worktree, deadline, now = () => Date.now(), sleep = () => {}, tickMs = 2000, exists, read } = {}) {
  for (;;) {
    const probe = equipment(worktree, { exists, read });
    if (!probe.measured || probe.ready || probe.wiring || now() >= deadline) return probe;
    sleep(tickMs);
  }
}
