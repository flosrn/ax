// What is prepared INSIDE a dispatched child's worktree, before it is dispatched.
//
// Two writes, and both are about a failure that is invisible from the
// coordinator's side until it is expensive: a child whose todo list never moves
// is never reported home, and a child that inherits a shared git identity gets
// its commits signed by a sibling's babysitter.
//
// Neither function prints. Each returns its `notes` for the caller to emit
// through ../log.mjs, so the same preparation can be asserted offline and the
// operator still reads one stream.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultExec } from './release.mjs';

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
 * signal a coordinator depends on.
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
const MANDATE = `# Written by ax worker launch. Worktree-scoped: it advises this dispatched
# child only, never the operator's own sessions. Not tracked; see .git/info/exclude.
advisors:
  - name: pilot
    tools: [read, grep, glob]
    instructions: |
      You watch ONE thing beyond your normal review: whether this session's todo list
      still describes reality. It is not housekeeping. The coordinator's wake-up is
      DERIVED from that list - the harness reports home when every remaining task is
      done or blocked - so a list frozen at its init means the coordinator is never told
      the work finished. Measured 2026-08-15: a child ran 299 turns, resolved 28 merge
      conflicts and called the todo tool exactly once.

      Raise a concern when the transcript shows a task plainly finished while the list
      still carries it open. NAME THE TASK and what in the transcript closed it. Do not
      repeat yourself: an advisor note that normalizes to one already accepted is dropped
      silently, so a generic reminder fires once and then protects nothing.

      Raise a blocker, and only here, when the session is about to end - a terminal
      answer, a final report, a handoff - with open tasks the transcript shows as done.
      That is the one severity that still triggers a turn after a terminal answer, and
      that moment is exactly when the coordinator loses the child.

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
