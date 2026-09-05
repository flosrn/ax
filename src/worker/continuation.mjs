// WHICH VERB CONTINUES a record whose pane is gone — the one answer `ax worker
// ls` and `ax worker tail` both print.
//
// WHY IT EXISTS (#165, out of finding #11). A worker's pane dies while its work
// is not finished: the record reads MORT, its pull request is still OPEN, and
// both readers of that row printed the verdict and stopped. The verb that
// continues it — `ax worker start --replace --request <id>` — was reachable only
// by an operator who already knew it exists, which is the same as unreachable.
// A row that names no repair is a finding nobody can act on (../log.mjs).
//
// THREE DEAD-PANE CASES, AND THEY TAKE THREE DIFFERENT VERBS. The pull request
// of the record's own branch is what separates them, and nothing else does:
//
//   OPEN        the work is unfinished and its placement is known → --replace
//   MERGED      the work landed; that row is `release`'s, which reads the
//               landing proof for itself before it closes anything
//   none/CLOSED nothing shipped; what remains is the ending `settle` writes
//
// AN ABSENT ANSWER IS NOT AN OPEN PULL REQUEST (F-028). Every read below can
// fail — no placement recorded, a worktree already removed, a `git` or a `gh`
// that refuses — and a failure prints NO continuation: a route offered on a
// guess sends an operator to replace a child that landed, or to settle one that
// is still open. A read that failed says so and names itself as the repair; a
// question that could not even be asked stays silent, and the caller's own
// withheld count discloses it.
//
// THE PROOF IS THE ONE `release` ALREADY MAKES: `gh pr list --repo <slug>
// --head <branch> --state all`, filtered on an EXACT head. `--head` is a filter
// this package does not trust on its own (see release.mjs), and two PRs
// claiming one head is ambiguity rather than a guess.
//
// PLACEMENT IS NEVER DERIVED HERE (#164). `inheritPlacement` is the only thing
// that decides where a replacement lands, so this module ASKS it — with an
// empty typed argv, the exact shape the continuation it prints will run — and
// stays silent when it refuses. That is also why the printed line carries no
// placement flag: a `--worktree` or `--on` typed onto a `--replace` is refused,
// and one printed from a reader is a placement derived a second time.
//
// The branch comes from the recorded worktree, so a child dispatched onto
// another host (`--on <env>`) is silent by construction: its tree is not on this
// machine, and a `git -C` over a path that only exists there would answer about
// whatever local directory happens to share the name.

import { existsSync } from 'node:fs';

import { defaultExec } from '../exec.mjs';
import { parseReceipt } from '../orca-bin.mjs';
import { physical } from '../worktree/locate.mjs';
import { argvValue, recordRepo, workerStartArgv } from './record.mjs';
import { inheritPlacement } from './start.mjs';

/**
 * Nothing could be asked, so nothing is claimed and nothing is printed — the
 * answer for every row a caller never puts a question about, exported so a
 * reader has one shape to render whatever it decided (F-028).
 */
export const NO_CONTINUATION = { route: null, fix: '', failed: '' };

const firstLine = text => String(text ?? '').split('\n')[0].trim();

/**
 * ONE ARGUMENT, QUOTED FOR A POSIX SHELL. Every repair here is a command an
 * operator pastes, and a branch or a slug is not this module's to vouch for.
 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shq = value => (SHELL_SAFE.test(String(value)) ? String(value) : `'${String(value).replace(/'/g, `'\\''`)}'`);

/**
 * A read this run could not make: the reason, and the exact call to re-run. No
 * route rides with it — that is the whole point of naming it.
 */
const failedRead = (detail, argv) => ({
  route: null,
  failed: detail,
  fix: `${argv.map(shq).join(' ')}   # the read this continuation needs — run it, then re-run this verb`,
});

/**
 * The verb that continues the record at `recordPath`, or nothing.
 *
 * `request` is the id the continuation is typed with, `dispatchId` the one
 * `release` scopes to (absent on a record that never named one). `exec` is the
 * caller's own seam, so every suite stays offline.
 */
export function continuationFor(recordPath, { request, dispatchId = null, exec = defaultExec } = {}) {
  let recorded;
  let repo;
  try {
    recorded = workerStartArgv(recordPath);
    repo = recordRepo(recordPath);
  } catch {
    // A record with no readable worker-start names no placement, so `--replace`
    // would refuse it and this reader has no branch to ask about either.
    return NO_CONTINUATION;
  }
  // A record naming no repository is UNKNOWN, never this one: the store is
  // host-global, and asking the wrong forge about a branch name is how a
  // same-named merge answers for a stranger's pane (#83).
  if (repo === '') return NO_CONTINUATION;

  const placement = inheritPlacement(recorded, []);
  if (placement.passthru === undefined) return NO_CONTINUATION;
  if ((argvValue(placement.passthru, '--on') ?? '') !== '') return NO_CONTINUATION;

  const selector = argvValue(placement.passthru, '--worktree') ?? '';
  if (!selector.startsWith('path:')) return NO_CONTINUATION;
  const worktree = physical(selector.slice('path:'.length));
  if (worktree === '' || !existsSync(worktree)) return NO_CONTINUATION;

  const gitArgs = ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'];
  const branchOut = exec('git', gitArgs, worktree);
  const branch = firstLine(branchOut?.stdout);
  if (branchOut?.error) {
    return failedRead(`the branch of ${worktree} is unread: git could not run — ${String(branchOut.error.message ?? branchOut.error)}`, ['git', ...gitArgs]);
  }
  if (branchOut?.status !== 0 || branch === '' || /\s/.test(branch)) {
    return failedRead(
      `the branch of ${worktree} is unread: git refused — ${firstLine(branchOut?.stderr) || branch || `exit ${branchOut?.status}`}`,
      ['git', ...gitArgs],
    );
  }

  const prArgs = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName'];
  const prOut = exec('gh', prArgs);
  if (prOut?.error) return failedRead(`the pull request of ${branch} is unread: gh could not run — ${String(prOut.error.message ?? prOut.error)}`, ['gh', ...prArgs]);
  if (prOut?.status !== 0) {
    return failedRead(`the pull request of ${branch} is unread: gh refused — ${firstLine(prOut?.stderr) || `exit ${prOut?.status}`}`, ['gh', ...prArgs]);
  }
  const list = parseReceipt(prOut.stdout);
  if (!Array.isArray(list)) return failedRead(`the pull request of ${branch} is unread: gh answered an unreadable list`, ['gh', ...prArgs]);

  // `--head` is a filter whose work this package verifies: a row for another
  // branch, or one carrying no head at all, may not decide which verb an
  // operator is sent to.
  const mine = list.filter(pr => String(pr?.headRefName ?? '') === branch);
  if (mine.length > 1) {
    return failedRead(
      `${mine.length} pull requests claim head ${branch} (${mine.slice(0, 4).map(pr => `#${pr.number}`).join(',')}), so nothing here can say which one this pane opened`,
      ['gh', ...prArgs],
    );
  }

  const settle = why => ({ route: 'settle', failed: '', fix: `ax worker settle ${request}   # ${why}, so this attempt's ending is what remains to write` });

  if (mine.length === 0) return settle(`no pull request was ever opened for ${branch}`);

  const pr = mine[0];
  if (pr.state === 'OPEN') {
    return {
      route: 'replace',
      failed: '',
      fix: `ax worker start --replace --request ${request}   # PR #${pr.number} is still open and this pane is gone: --replace reinstates the placement this record names, and nothing may re-place it`,
    };
  }
  if (pr.state === 'MERGED') {
    return {
      route: 'release',
      failed: '',
      fix:
        dispatchId === null
          ? `ax worker release   # PR #${pr.number} merged, so this row is release's — this record names no dispatch to scope that read to`
          : `ax worker release --dispatch ${dispatchId}   # PR #${pr.number} merged, so this row is release's: it reads that landing proof itself, and nothing closes without --close`,
    };
  }
  if (pr.state === 'CLOSED') return settle(`PR #${pr.number} was closed unmerged, so nothing this pane did landed`);
  return failedRead(`PR #${pr.number} is in state ${JSON.stringify(pr.state)}, which names no continuation here`, ['gh', 'pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergedAt,headRefName']);
}
