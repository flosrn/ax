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
// HOST-SPECIFIC EVIDENCE FOLLOWS THE PLACEMENT ON THE RECORD (#192). A child
// dispatched with `--on <env>` has its worktree on THAT host, so the branch is
// asked of that host — through the federation read `placeRemote` already makes,
// `orca worktree list --repo <id> --environment <env> --json`, never ssh and
// never a path spelled here. A `git -C` over a local path that only exists
// there would answer about whatever local directory happens to share the name,
// which is the one reading this module must never do.
//
// AND WHAT THAT HOST CANNOT ANSWER IS SAID, not skipped. Until #192 a remote
// record produced NO continuation at all — silent by construction — and
// silence is indistinguishable from "nothing to continue" in both readers: an
// operator recovering a wave saw a dead remote row that named no verb, which is
// the finding #165 exists against, reintroduced for exactly the rows a fresh
// session cannot inspect by hand. So an unavailable owning-host read is a NAMED
// inability carrying the exact call to make, like every other unread question
// here. Only the pull request stays a local read: a forge fact is the same fact
// from any machine.

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
 * THE ABSOLUTE PATH A PLACEMENT SELECTOR NAMES, or `''`.
 *
 * Two forms carry one: `path:<abs>`, and the `id:<repoId>::<abs>` a remote
 * placement records because a bare `path:` loses the repo id and the runtime
 * answers `selector_ambiguous` (../worker/placement.mjs). Every other form —
 * `new-top-level`, `name:`, `branch:`, `issue:` — names no path, and a path
 * guessed from a name is the wrong tree on either machine.
 */
function selectorPath(selector) {
  if (selector.startsWith('path:')) return selector.slice('path:'.length);
  const remote = /^id:[^:]+::(\/.+)$/.exec(selector);
  return remote === null ? '' : remote[1];
}

/**
 * The branch of a LOCAL recorded worktree: the tree must still be here, and git
 * must answer for it. A tree already removed is silent — there is nothing to
 * ask and nothing to continue with — and a git that refuses is a named read.
 */
function localBranch(selector, exec) {
  if (!selector.startsWith('path:')) return { branch: '' };
  const worktree = physical(selector.slice('path:'.length));
  if (worktree === '' || !existsSync(worktree)) return { branch: '' };

  const gitArgs = ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'];
  const out = exec('git', gitArgs, worktree);
  const branch = firstLine(out?.stdout);
  if (out?.error) {
    return { failed: failedRead(`the branch of ${worktree} is unread: git could not run — ${String(out.error.message ?? out.error)}`, ['git', ...gitArgs]) };
  }
  if (out?.status !== 0 || branch === '' || /\s/.test(branch)) {
    return {
      failed: failedRead(
        `the branch of ${worktree} is unread: git refused — ${firstLine(out?.stderr) || branch || `exit ${out?.status}`}`,
        ['git', ...gitArgs],
      ),
    };
  }
  return { branch };
}

/**
 * The branch of a worktree on the host this record's placement NAMES, asked of
 * that host (#192).
 *
 * The read is `placeRemote`'s own — `worktree list --repo <id> --environment
 * <env>`, over the Orca federation — and every step of it can fail to answer:
 * a caller holding no runtime, a placement naming no path or no repository, a
 * host that cannot list, a row that carries no branch, two rows on one path.
 * Each is a NAMED inability with the exact call to make, never a fallback to
 * the local machine: `/srv/orca/<name>` there and a same-named directory here
 * are different trees, and the local one would answer for a stranger.
 */
function remoteBranch(host, selector, repoArg, run) {
  const listing = ['orca', 'worktree', 'list', '--repo', repoArg === '' ? 'id:<repo-id>' : repoArg, '--environment', host, '--json'];
  const unread = detail => ({ failed: failedRead(`the branch of this record's worktree on '${host}' is unread: ${detail}`, listing) });

  if (run === null) return unread('this reader was given no runtime to ask that host with');
  const path = selectorPath(selector);
  if (path === '') {
    return unread(
      selector === ''
        ? 'its placement names no worktree at all'
        : `its placement names ${JSON.stringify(selector)}, which carries no path that host could be asked about`,
    );
  }
  if (repoArg === '') return unread(`nothing scopes the listing to a repository, and an unscoped one answers about every repository '${host}' carries`);

  const out = run(['worktree', 'list', '--repo', repoArg, '--environment', host, '--json']);
  const receipt = out?.receipt ?? {};
  const rows = receipt.result?.worktrees;
  if (out?.status !== 0 || receipt.ok !== true || !Array.isArray(rows)) {
    const detail = String(receipt.unparseable ?? receipt.error?.code ?? out?.stderr ?? '').replace(/\s+/g, ' ').trim();
    return unread(`'${host}' could not say which worktrees it carries (${detail === '' ? 'no receipt' : detail})`);
  }

  // Compared as strings on `/`: nothing here resolves a symlink or stats a
  // directory on another machine (../worker/placement.mjs).
  const mine = rows.filter(row => String(row?.path ?? '').replace(/\/+$/, '') === path.replace(/\/+$/, ''));
  if (mine.length === 0) return unread(`'${host}' lists no worktree at ${path}`);
  if (mine.length > 1) return unread(`'${host}' lists ${mine.length} worktrees at ${path}, so nothing here can say which branch this pane worked on`);
  const branch = String(mine[0].branch ?? '').replace(/^refs\/heads\//, '').trim();
  if (branch === '' || /\s/.test(branch)) return unread(`the row '${host}' gave for ${path} carries no branch`);
  return { branch };
}

/**
 * The verb that continues the record at `recordPath`, or nothing.
 *
 * `request` is the id the continuation is typed with, `dispatchId` the one
 * `release` scopes to (absent on a record that never named one). `exec` is the
 * caller's own `git`/`gh` seam and `run` its Orca runner — the one a record
 * naming a host is asked through — so every suite stays offline. A caller that
 * passes no `run` can still read a local record; a remote one then answers
 * with the inability rather than with this machine's directories (#192).
 *
 * `memo` is ONE invocation's answers, keyed by repository and branch. Two
 * records naming one worktree is an ordinary shape — a re-dispatch under a
 * fresh request id reuses the tree — and measured on this machine 2026-09-05 it
 * made `ax worker ls` ask `feat/157-xapikey` twice out of 8 pull-request reads.
 * A caller listing many rows passes a map and pays each branch once; a caller
 * with one row passes none. Scoped to the call, like every other read here: a
 * listing is a point-in-time answer, and two different answers inside one
 * receipt would be worse than a stale one.
 */
export function continuationFor(recordPath, { request, dispatchId = null, exec = defaultExec, memo = null, run = null } = {}) {
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

  // WHERE THE BRANCH IS READ FROM IS THE PLACEMENT'S DECISION, never this
  // machine's: a record naming a host is answered by that host, and one naming
  // none is answered by the tree it recorded here.
  const host = argvValue(placement.passthru, '--on') ?? '';
  const selector = argvValue(placement.passthru, '--worktree') ?? '';
  const read =
    host === ''
      ? localBranch(selector, exec)
      : remoteBranch(host, selector, argvValue(placement.passthru, '--repo') ?? '', run);
  if (read.failed !== undefined) return read.failed;
  if (read.branch === '') return NO_CONTINUATION;
  const branch = read.branch;

  const prArgs = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName'];
  const key = `${repo}\t${branch}`;
  const prOut = memo !== null && memo.has(key) ? memo.get(key) : exec('gh', prArgs);
  if (memo !== null) memo.set(key, prOut);
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
    // WHAT THE OPEN LINE SAYS, and why it names the merge beside the replace
    // (review of PR #169, P1). An OPEN pull request does not distinguish a
    // slice that stalled from one that FINISHED and whose pane exited while it
    // waited for a merge, and this reader cannot: it would have to judge review
    // threads, CI and a body. So the line stays an OFFER — every route here is
    // a command an operator reads and types, never an action a verb takes — and
    // it names the other exit in the same breath, so the reader holding a
    // finished slice is not walked into replacing it. Which of the two applies
    // is the merge gate's question, and `ax pr gate` answers it with grounds
    // (../pr-gate.mjs). Widening the route itself to that judgement is a
    // decision for the ticket, not for a reader (#165 defines this case as
    // MORT + OPEN).
    return {
      route: 'replace',
      failed: '',
      fix: `ax worker start --replace --request ${request}   # PR #${pr.number} is OPEN and this pane is gone: --replace reinstates the placement this record names, and nothing may re-place it — a slice that FINISHED merges through ax pr gate --pr ${pr.number} instead`,
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
