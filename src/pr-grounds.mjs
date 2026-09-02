// The grounds `ax pr gate` executes — each one a predicate over live state,
// answering through its own interface with the entries it wants printed:
// `{ notes, unknowns, refusals }`, plus any fact another ground consumes
// (ciGround's `ciDecided`). NOTHING PRINTS HERE: gate() owns the order, the
// verdict and the exit code, so a ground can be proved alone without stubbing
// every sibling — which is what its tests do.
//
// The grounds' incident history — why each exists, what it measured — lives on
// each function below, moved intact from the file that paid for it.

import { CONFIG_FILE } from './config.mjs';

export const firstLine = text => String(text ?? '').split('\n')[0].trim();

export const succeeded = out => !out.error && out.status === 0;

/**
 * One printable, bounded line out of foreign text — a thread id, a login, a
 * path, a url. Same reason as the missing `body` field in the thread query:
 * what comes back from the API is printed as a label, never as prose.
 */
export const clean = value => {
  const text = String(value ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '');
  return text.slice(0, 200) || '-';
};

/**
 * A named key, never an `or` fallback on a container: an absent container must
 * raise, not quietly become an empty one that satisfies every test (F-028).
 */
export const must = (object, key, where) => {
  const value = object === null || typeof object !== 'object' ? undefined : object[key];
  if (value === undefined || value === null) throw new Error(`${where}: '${key}' is absent from the payload`);
  return value;
};

/**
 * A `gh` call that answered with parseable JSON, or THE REASON IT DID NOT.
 *
 * The reason is carried out of here rather than collapsed into a boolean, and
 * the two failures are kept apart: a call that did not run, and a call that ran
 * and answered something else. F-004 records the one time a `jq` failure inside
 * a pipe consumed the only diagnostic that mattered — the gate reported that it
 * could not establish something and could not say why, which is an unknown a
 * caller cannot act on.
 */
export function payload(out) {
  if (!succeeded(out)) return { ok: false, reason: `failed — ${firstLine(out.stderr) || `exit ${out.status}`}` };
  try {
    return { ok: true, value: JSON.parse(String(out.stdout ?? '')) };
  } catch (error) {
    return { ok: false, reason: `answered something that is not JSON (${error.message})` };
  }
}

/** A closing verb GitHub acts on, in the documented variants. */
const KEYWORDS = 'clos(?:e|es|ed)|fix(?:|es|ed)|resolv(?:e|es|ed)';

/** What an issue reference is allowed to look like after one of those verbs. */
const TARGET = '(?:#\\d+|[\\w.-]+/[\\w.-]+#\\d+|https://github\\.com/[\\w.-]+/[\\w.-]+/issues/\\d+)';

/**
 * A closing verb in ANY language, English included. This is what says the author
 * meant to close something; `KEYWORDS` above is what GitHub acts on. The gap
 * between the two sets is the whole of the keyword ground.
 */
const INTENT = `${KEYWORDS}|ferme|fermer|clo[tû]|clôt|r[ée]sout|r[ée]soud|corrige`;

/**
 * Review threads, paginated. The query asks for NO `body` field anywhere: a
 * review body is contributor-authored text, and reproducing it into this
 * decision channel would put untrusted prose where a caller reads instructions
 * (R11, KTD7). A thread is named — id, author, path, url — never quoted.
 *
 * Resolution state comes from GraphQL because the REST review-comments payload
 * does not carry it: 26 keys, none of them a resolution (KTD6).
 */
const THREAD_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:50,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{id isResolved isOutdated comments(first:1){nodes{author{login} path url}}}
      }
    }
  }
}`;

/**
 * WHAT BREAKS IF THIS MOVES, which is the only property of a boundary worth
 * writing down. Crossing it does NOT truncate silently: the loop registers an
 * `unknown` (below), and an unknown fails this gate closed, so a PR with more
 * threads than this becomes unmergeable-until-read rather than passed on a
 * partial read. Lower it and ordinary PRs stop being decidable; raise it and the
 * cost is API calls, never a wrong verdict. It was never an optimisation that
 * happened to be safe.
 */
const MAX_THREAD_PAGES = 50;

/** One ground's account: the entries it wants printed, in the order it found them. */
function account() {
  const notes = [];
  const unknowns = [];
  const refusals = [];
  return {
    notes,
    unknowns,
    refusals,
    note: message => notes.push({ message }),
    unknown: (message, repair) => unknowns.push({ message, repair }),
    refuse: (message, repair) => refusals.push({ message, repair }),
  };
}

/**
 * Ground 1. The declared checks, decided and passing on that exact SHA.
 * Never a count comparison between two PRs (F-014).
 *
 * Returns `ciDecided` beside the entries: threadsGround consumes it, and the
 * dependency is in the signatures rather than in a shared mutable.
 */
export function ciGround({ run, slug, sha, declared, pr }) {
  const out = account();
  let ciDecided = true;
  const checkRuns = payload(run(['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`]));
  if (!checkRuns.ok) {
    ciDecided = false;
    out.unknown(
      `checks: 'gh api repos/${slug}/commits/${sha}/check-runs' ${checkRuns.reason}; CI state unread`,
      `gh api repos/${slug}/commits/${sha}/check-runs`,
    );
  } else {
    let runs = null;
    try {
      runs = must(checkRuns.value, 'check_runs', 'the check-runs payload');
      if (!Array.isArray(runs)) throw new Error('the check-runs payload: check_runs is not a list');
    } catch (error) {
      ciDecided = false;
      out.unknown(`checks: ${error.message}; CI state unread`, `gh api repos/${slug}/commits/${sha}/check-runs`);
      runs = null;
    }
    if (runs !== null) {
      out.note(`checks: ${runs.length} check-run(s) reported on ${sha.slice(0, 12)}`);
      for (const expected of declared.expected) {
        const rows = runs.filter(row => row?.name === expected);
        if (rows.length === 0) {
          // A check that never ran is not a check that passed. This is the trap
          // the gate exists for: when a guard job fails early, everything
          // downstream never executes.
          out.refuse(
            `checks: expected ${declared.mode} check '${clean(expected)}' has NO run on ${sha.slice(0, 12)}`,
            `gh api repos/${slug}/commits/${sha}/check-runs --jq '.check_runs[].name'   # is the name still spelled this way?`,
          );
          continue;
        }
        const pending = rows.find(row => row?.status !== 'completed');
        if (pending) {
          ciDecided = false;
          out.unknown(`checks: '${clean(expected)}' is ${clean(pending.status)} on ${sha.slice(0, 12)} — not decided`, 'gh run watch   # then re-run this gate');
          continue;
        }
        for (const row of rows) {
          // `neutral` is neither a success nor a failure, and the old dashboard
          // did not see it at all (F-031). Here it is a refusal like any other
          // non-success.
          if (row?.conclusion !== 'success') {
            out.refuse(
              `checks: '${clean(expected)}' concluded ${clean(row?.conclusion)} on ${sha.slice(0, 12)}`,
              `gh pr checks ${pr} --repo ${slug}   # then fix the job, or re-run it`,
            );
          }
        }
      }
    }
  }
  return { notes: out.notes, unknowns: out.unknowns, refusals: out.refusals, ciDecided };
}

/**
 * Ground 2. Review threads, and ONLY after CI is decided.
 *
 * The reviewer that posted the P1 arrives asynchronously, unrelated to the end
 * of CI. On #1847, read while the last E2E batch was still running, the thread
 * was empty — and that reading was worth nothing. An empty thread observed
 * before CI is decided is not an observation (F-031). So no GraphQL call is
 * issued at all here: a read whose answer cannot be trusted must not look like
 * one that can.
 */
export function threadsGround({ run, owner, name, pr, sha, ciDecided, invocation }) {
  const out = account();
  if (!ciDecided) {
    out.unknown(`threads: CI is not decided on ${sha} — a thread read now is no observation at all`, `${invocation()}   # once CI has finished`);
    return out;
  }
  let cursor = null;
  for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
    const args = ['api', 'graphql', '-f', `query=${THREAD_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`];
    if (cursor !== null) args.push('-f', `cursor=${cursor}`);
    const answered = payload(run(args));
    if (!answered.ok) {
      out.unknown(`threads: the GraphQL reviewThreads query ${answered.reason}; resolution state unread`, 'gh auth status   # then re-run this gate');
      break;
    }
    let threads;
    try {
      const data = must(answered.value, 'data', 'the reviewThreads payload');
      const repository = must(data, 'repository', 'data');
      const pullRequest = must(repository, 'pullRequest', 'repository');
      threads = must(pullRequest, 'reviewThreads', 'pullRequest');
    } catch (error) {
      out.unknown(`threads: ${error.message}; resolution state unread`, 'gh auth status   # then re-run this gate');
      break;
    }
    const nodes = Array.isArray(threads.nodes) ? threads.nodes : [];
    let unresolved = 0;
    for (const thread of nodes) {
      if (thread?.isResolved === true) continue;
      unresolved += 1;
      const first = thread?.comments?.nodes?.[0] ?? {};
      out.refuse(
        `threads: unresolved thread ${clean(thread?.id)} by ${clean(first.author?.login)} on ${clean(first.path)} — ${clean(first.url)}`,
        `open ${clean(first.url)}   # resolve it there, then re-run this gate`,
      );
    }
    out.note(`threads: page ${page} — ${nodes.length} thread(s), ${unresolved} unresolved`);
    const info = threads.pageInfo ?? {};
    if (info.hasNextPage !== true) break;
    cursor = info.endCursor ?? null;
    if (cursor === null) {
      out.unknown('threads: a page claims a next one and names no cursor, so the remaining threads are unread', 'gh auth status   # then re-run this gate');
      break;
    }
    if (page === MAX_THREAD_PAGES) out.unknown(`threads: pagination exceeded ${MAX_THREAD_PAGES} pages; stopped rather than looping`);
  }
  return out;
}

/**
 * A branch resolved to the ref this checkout can actually read: the fetched
 * `origin/<name>` when it exists, the local branch otherwise, '' when neither
 * answers. Shared by the git-backed grounds and the declaration guard — the
 * two resolved the same question with byte-identical loops once, which is one
 * drift away from resolving it differently.
 */
const resolveRef = (gitRun, branch) => {
  for (const candidate of [`origin/${branch}`, branch]) {
    if (succeeded(gitRun(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]))) return candidate;
  }
  return '';
};

/**
 * Grounds 3, 4 and 5 — git-backed, one function because they stand on ONE
 * shared measurement: the git-dir check, the ref refresh and the base/head
 * resolution. A prelude failure feeds all three accounts at once (a fetch that
 * fails makes staleness unreadable, the residual file unreadable AND
 * landed-by-content undecidable), so splitting them would re-create that
 * cross-accounting in the orchestrator.
 */
export function gitGrounds({ git, root, baseBranch, headBranch, mergeState, residualDir }) {
  const out = account();

  // Declared, never assumed: absent means the residual ground is NOT RUN, and
  // the gate says so instead of passing it silently.
  if (residualDir === '') {
    out.note('residual findings: NOT RUN — this checkout declares no prGate.residualFindings, and an unrun ground is not a passed one');
  }
  const residualUnknown = (message, repair) => {
    if (residualDir !== '') out.unknown(message, repair);
  };

  // Not measured until the prelude below runs: a checkout that is not a git dir
  // refreshed nothing, and every consumer must read that as unread, not as ok.
  out.fetchState = 'unread';
  const gitRun = args => git(args, root);
  if (!succeeded(gitRun(['rev-parse', '--git-dir']))) {
    out.unknown('staleness: not inside a git checkout, so ancestry against the base is unreadable', 'cd into the checkout that holds this branch, then re-run');
    residualUnknown('residual findings: not inside a git checkout', 'cd into the checkout that holds this branch, then re-run');
    out.note('landed-by-content: not decided — not inside a git checkout');
    return out;
  }

  // The refs are REFRESHED before they are compared. Measured 2026-08-14 on
  // #1939: the branch had just been updated with its base, the API head SHA
  // proved it, and this ground refused anyway because the local `origin/<head>`
  // predated the update. The symmetric case is the dangerous one — a stale
  // local `origin/<base>` makes a branch that HAS fallen behind read as
  // current, which is this gate passing the very thing it exists to stop. So a
  // fetch that fails is an inability to establish, never a silent comparison
  // against whatever the disk happens to hold.
  //
  // No `origin` at all is a different situation, not a failure: a repository
  // built with `git init` has only local branches, and comparing those is all
  // anyone can mean there. It is said out loud rather than assumed.
  //
  // The state of that refresh is CARRIED OUT of this function (`out.fetchState`)
  // rather than measured twice: the declaration guard reads the same base ref
  // this prelude fetched, so it must stand on this measurement instead of
  // probing origin again and possibly answering about a different moment.
  out.fetchState = 'local-only';
  if (succeeded(gitRun(['remote', 'get-url', 'origin']))) {
    const fetched = gitRun(['fetch', '--quiet', 'origin', baseBranch, headBranch]);
    out.fetchState = succeeded(fetched) ? 'ok' : 'failed';
    if (out.fetchState === 'failed') {
      out.unknown(
        `staleness: could not fetch '${baseBranch}' and '${headBranch}' from origin (${clean(firstLine(fetched.stderr))}), so ancestry would be read from refs that may predate this head`,
        `git fetch origin ${baseBranch} ${headBranch}`,
      );
      residualUnknown(
        "residual findings: the refs could not be refreshed, so this branch's files cannot be read at their current state",
        `git fetch origin ${baseBranch} ${headBranch}`,
      );
      out.note('landed-by-content: not decided — the refs could not be refreshed');
    }
  }
  const fetchState = out.fetchState;

  const baseRef = fetchState === 'failed' ? '' : resolveRef(gitRun, baseBranch);
  const headRef = fetchState === 'failed' ? '' : resolveRef(gitRun, headBranch);

  if (fetchState === 'failed') {
    // Already reported above; the comparison is deliberately not attempted.
    return out;
  }
  if (baseRef === '' || headRef === '') {
    out.unknown(`staleness: '${baseBranch}' or '${headBranch}' is absent from this checkout`, `git fetch origin ${baseBranch} ${headBranch}`);
    residualUnknown(`residual findings: '${headBranch}' is absent from this checkout`, `git fetch origin ${headBranch}`);
    out.note('landed-by-content: not decided — a ref is missing from this checkout');
    return out;
  }

  if (fetchState === 'local-only') out.note("staleness: no 'origin' remote in this checkout, so ancestry is read from local refs");

  // ── Ground 3. Staleness by ancestry, never by mergeStateStatus ────────────
  // `BEHIND` only appears where branch protection demands an up-to-date
  // branch, so on a repository that does not it never appears and `CLEAN`
  // outlives a base that has advanced (F-033.2).
  if (succeeded(gitRun(['merge-base', '--is-ancestor', baseRef, headRef]))) {
    out.note(`staleness: ${headRef} carries ${baseRef} — the branch is current`);
  } else {
    out.refuse(
      `staleness: ${baseRef} is not an ancestor of ${headRef} — the branch is behind its base (mergeStateStatus reads ${mergeState}, which is not the question)`,
      `git fetch origin ${baseBranch} && git merge origin/${baseBranch}   # then push`,
    );
  }

  // ── Ground 4. Landed by CONTENT, for the post-merge cleanup question ──────
  // A squash creates a new commit, so ancestry answers "not merged" for
  // every branch on a squashing repository, including the one just merged
  // (F-033.1). REPORTED, NEVER A REFUSAL: this ground answers the
  // worktree-may-go question, not the mergeability one.
  const diff = gitRun(['diff', '--name-only', baseRef, headRef]);
  if (succeeded(diff)) {
    const ancestry = succeeded(gitRun(['merge-base', '--is-ancestor', headRef, baseRef])) ? 'yes' : 'no';
    const differing = String(diff.stdout ?? '')
      .split('\n')
      .filter(line => line !== '');
    if (differing.length > 0) {
      out.note(`landed-by-content: NO — ${differing.length} file(s) still differ from ${baseRef} (ancestry says ${ancestry})`);
    } else {
      out.note(
        `landed-by-content: YES — content equal to ${baseRef}, so the work landed and the worktree may go (ancestry says ${ancestry}; after a squash it always says no)`,
      );
    }
  } else {
    out.note("landed-by-content: not decided — 'git diff' failed");
  }

  // ── Ground 5. A residual-findings file THIS BRANCH wrote, then superseded
  // with its own later commits (F-009). Measured against the merge base,
  // never against the branch's whole history: `git log <ref> -- <dir>` walks
  // the base too, so a branch that filed no residuals inherits the base's
  // last write to the directory and every one of its own commits then reads
  // as "landed after it". That false positive was the gate's first real-use
  // finding, on a PR that had filed nothing and had ticketed everything
  // (F-039).
  if (residualDir !== '') {
    const touched = gitRun(['diff', '--name-only', `${baseRef}...${headRef}`, '--', residualDir]);
    if (!succeeded(touched)) {
      out.unknown(`residual findings: 'git diff' could not answer against ${baseRef}`, `git diff --name-only ${baseRef}...${headRef} -- ${residualDir}`);
    } else if (String(touched.stdout ?? '').trim() === '') {
      // F-011: the two readings of an untouched directory are not separable
      // by any git measurement, so this ground names both instead of picking
      // one.
      out.note(
        `residual findings: [DETECTOR] this branch wrote nothing under ${residualDir}. That is either 'every finding was ticketed' or 'nothing was traced', and no git measurement separates them — read the PR's linked issues (F-011)`,
      );
    } else {
      const last = gitRun(['log', '-1', '--format=%H', `${baseRef}..${headRef}`, '--', residualDir]);
      const resCommit = succeeded(last) ? String(last.stdout ?? '').trim() : '';
      if (resCommit === '') {
        out.unknown(
          `residual findings: ${residualDir} differs from ${baseRef} but no commit on this branch touched it`,
          `git log ${baseRef}..${headRef} -- ${residualDir}`,
        );
      } else {
        const later = gitRun(['rev-list', '--count', `${resCommit}..${headRef}`]);
        const count = succeeded(later) ? String(later.stdout ?? '').trim() : '';
        if (!/^[0-9]+$/.test(count)) {
          out.unknown("residual findings: 'git rev-list --count' could not answer", `git rev-list --count ${resCommit}..${headRef}`);
        } else if (Number(count) > 0) {
          out.refuse(
            `residual findings: this branch wrote ${residualDir} at ${resCommit.slice(0, 12)} and ${count} of its own commit(s) landed after it`,
            `git log ${baseRef}..${headRef}   # re-read the file against these commits, then commit it again`,
          );
        } else {
          out.note(`residual findings: written by this branch at ${resCommit.slice(0, 12)}, the newest commit on ${headRef}`);
        }
      }
    }
  }
  return out;
}

/**
 * Ground 6. The commits made since the PR opened.
 *
 * A DETECTOR: a PR body's staleness is not mechanically decidable, so the gate
 * lists the commits and refuses until the caller acknowledges the list with
 * `--ack-body` (KTD9).
 */
export function commitsGround({ run, slug, pr, openedAt, ackBody, invocation }) {
  const out = account();
  const commits = payload(run(['api', `repos/${slug}/pulls/${pr}/commits?per_page=100`]));
  if (!commits.ok) {
    out.unknown(`commits since open: 'gh api repos/${slug}/pulls/${pr}/commits' ${commits.reason}`, `gh api repos/${slug}/pulls/${pr}/commits`);
    return out;
  }
  try {
    const rows = commits.value;
    if (!Array.isArray(rows)) throw new Error('the PR commits payload is not a list');
    const late = [];
    for (const entry of rows) {
      // Named keys throughout (F-028).
      const when = Date.parse(must(must(must(entry, 'commit', 'a PR commit'), 'committer', 'commit'), 'date', 'committer'));
      if (Number.isNaN(when)) throw new Error('a PR commit carries a committer date that is not a date');
      if (when > openedAt) late.push(String(must(entry, 'sha', 'a PR commit')).slice(0, 12));
    }
    if (late.length === 0) out.note('commits since open: none — the body describes every commit on the branch');
    else if (ackBody) out.note(`commits since open: ${late.length} acknowledged via --ack-body (${late.join(' ')})`);
    else {
      out.refuse(
        `commits since open [DETECTOR]: ${late.length} commit(s) landed after the PR was opened (${late.join(' ')})`,
        `gh pr view ${pr} --repo ${slug} --json body   # re-read the body against them, then: ${invocation('--ack-body')}`,
      );
    }
  } catch (error) {
    out.unknown(`commits since open: ${error.message}`, `gh api repos/${slug}/pulls/${pr}/commits`);
  }
  return out;
}

/**
 * Ground 7. A closing keyword GitHub actually recognises, on a base where it
 * fires.
 *
 * `Ferme #N` and `Clot #N` close nothing, and a view that treats open issues
 * as its queue then re-dispatches delivered work. F-018 exactly: PR #1831
 * opened on `Ferme #1786`, merged, and #1786 stayed OPEN and `ready-for-agent`.
 * Only the matched phrase is echoed, never the surrounding prose.
 *
 * Two halves harden under autonomous frontier derivation (R8), where nobody
 * reads the merge before the next wave derives from the tracker:
 *
 *  - Absent closing intent is a REFUSAL, not the detector note it used to be.
 *    The two readings that note described — "a PR with no ticket behind it" and
 *    "an author who forgot" — are still both undecidable from the body, and
 *    that is exactly why the answer cannot be to merge: the frontier re-derives
 *    from issue state, so a delivered ticket that closes nothing stalls its
 *    whole subgraph. Naming the ticket, or merging by hand, is the operator's
 *    call and the repair says so.
 *  - A base that is not the repository's default branch makes every keyword
 *    inert: GitHub closes linked issues only on a default-branch merge. The
 *    detector would otherwise print "GitHub will close the issue" about a merge
 *    that closes nothing — F-018's failure with a different cause.
 *
 * `baseBranch`/`defaultBranch` are one question, not two fields: with neither,
 * the caller is not asking (the ground answers on the body alone); with one,
 * the ground is unread and says so — an absent default branch is not a match
 * (F-028).
 */
export function keywordGround({ body, tracker, pr, slug, baseBranch = '', defaultBranch = '' }) {
  const out = account();
  const base = String(baseBranch ?? '').trim();
  const head = String(defaultBranch ?? '').trim();
  let inert = false;
  if (base !== '' && head !== '') {
    if (base !== head) {
      inert = true;
      out.refuse(
        `closing keyword: base '${clean(base)}' is not the default branch '${clean(head)}' — every closing keyword is inert there, because GitHub closes a linked issue only when the PR merges into the default branch`,
        `gh pr edit ${pr} --repo ${slug} --base ${clean(head)}   # or merge here and move the ticket by hand`,
      );
    }
  } else if (base !== '' || head !== '') {
    out.unknown(
      `closing keyword: base '${clean(base) || 'unread'}' against default branch '${clean(head) || 'unread'}' — half the pair decides nothing, and an unread default branch is not a match (F-028)`,
      `gh repo view ${slug} --json defaultBranchRef   # read the default branch, then re-run`,
    );
  }
  const matched = new RegExp(`\\b(?:${KEYWORDS})\\b\\s*:?\\s+${TARGET}`, 'i').exec(body);
  const intended = new RegExp(`\\b(?:${INTENT})\\b\\s*:?\\s+${TARGET}`, 'i').exec(body);
  if (matched) {
    out.note(
      inert
        ? `closing keyword: '${clean(matched[0].trim())}' — recognised, but inert on this base (see the refusal below)`
        : `closing keyword: '${clean(matched[0].trim())}' — GitHub will close the issue`,
    );
    return out;
  }
  if (intended) {
    out.refuse(
      `closing keyword: '${clean(intended[0].trim())}' closes nothing — GitHub acts only on Closes / Fixes / Resolves and their documented variants (F-018)`,
      `gh pr edit ${pr} --repo ${slug}   # rewrite it as "Closes #N"`,
    );
    return out;
  }
  // No GitHub closing construct. Before calling that "no ticket", ask whether
  // this repository even tracks on GitHub: measured 2026-08-16, a project with
  // GitHub issues DISABLED that tracks in Linear had this line printed on
  // three PRs that each carried `Fixes GAP-3xx`. Saying "expresses no intent
  // to" there is not a detector being careful, it is a false statement — and
  // the actionable fact is the opposite one: the ref is real, and GitHub will
  // still close nothing.
  const declaredTracker =
    tracker && typeof tracker.name === 'string' && typeof tracker.pattern === 'string' && tracker.name.trim() !== '' && tracker.pattern.trim() !== ''
      ? tracker
      : null;
  let ref = null;
  if (declaredTracker) {
    try {
      // The ref that FOLLOWS a closing verb, before any other mention. A body
      // legitimately cites sibling tickets for context — measured on gapila
      // #1959, whose first tracker match was `GAP-377` (background) while the
      // body's actual subject, ten paragraphs down, was `Fixes GAP-379`.
      // Naming the wrong ticket in a merge verdict is the same species this
      // key was added to remove, one field over.
      const afterVerb = new RegExp(`\\b(?:${INTENT})\\b\\s*:?\\s+(${declaredTracker.pattern})`, 'i').exec(body);
      ref = afterVerb ? new RegExp(declaredTracker.pattern).exec(afterVerb[0]) : new RegExp(declaredTracker.pattern).exec(body);
    } catch {
      // A `pattern` that does not compile leaves this half unanswered, and
      // that is all it does: the tracker exists to keep the detector line
      // below from being FALSE, never to decide a merge, so it falls back to
      // that line instead of adding a ground of its own. The schema types
      // `pattern` as a string and cannot know it is a valid regex, so the
      // place that should name the typo is `ax doctor`, which validates the
      // config — not the gate, which is answering about a merge.
      ref = null;
    }
  }
  if (ref) {
    out.note(
      `closing keyword: no GitHub keyword, but the body names ${clean(declaredTracker.name)} '${clean(ref[0])}' — GitHub closes nothing there, so that ticket moves by hand`,
    );
  } else {
    // Genuinely nothing — and under R8 that is where the loop breaks, not a
    // detector line. "Absent by mistake" and "absent by design" are still
    // undecidable from the body (the reading that made this a note), so the
    // refusal names both readings and hands the choice to a human: name the
    // ticket, or merge by hand. Same family as the residual ground (F-039).
    out.refuse(
      'closing keyword: the body closes no issue and expresses no intent to. That is a PR with no ticket behind it, or an author who forgot — no reading of the body separates them, and the frontier re-derives from issue state, so an unclosed delivered ticket stalls its subgraph',
      `gh pr edit ${pr} --repo ${slug} --body-file -   # add "Closes #N", or merge this one by hand if no ticket is behind it`,
    );
  }
  return out;
}

/**
 * EVERY issue a merged PR will close in THIS repository, ascending.
 *
 * GitHub acts on every recognised construct in a body, not on the first one:
 * `Closes #999` followed by `Closes #1786` closes both. Reading only the first
 * made Ground 9 refuse a body that does close the dispatched ticket — a
 * round-trip charged for a merge that was correct (PR #77 review, P2). A
 * comma-separated tail is NOT a second construct: GitHub wants the keyword
 * before each reference, so `Closes #1, #2` closes #1 alone, and this regex
 * says the same.
 *
 * Only bare `#N` is collected. A qualified `owner/repo#N` or a full URL is a
 * real closing target too, but it closes in ANOTHER repository — the caller
 * verifying closure has nothing to poll here, so leaving it out is what sends
 * that caller to the "moves by hand" note instead of polling the wrong tracker.
 */
export function closedIssuesOf(body) {
  const found = new Set();
  for (const matched of String(body ?? '').matchAll(new RegExp(`\\b(?:${KEYWORDS})\\b\\s*:?\\s+(${TARGET})`, 'gi'))) {
    const bare = /^#(\d+)$/.exec(matched[1]);
    if (bare) found.add(Number(bare[1]));
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * Ground 9. The closure this merge is verified against is the ticket that was
 * DISPATCHED, not the one the body happens to name.
 *
 * Deferred by decision at PR #65 review (Codex thread, Known Residuals 1), and
 * the hazard is one keystroke wide: a worker whose PR says `Closes #11` while
 * #10 was dispatched passes every ground above, #11 gets the closure check the
 * gate performs after merging, and #10 — plus every ticket blocked by it —
 * stays OPEN forever. Nothing escalates, because the closure verification
 * itself reported success: the frontier keeps deriving those dependents as
 * `blocked-by` and never re-derives them as takeable, so the subgraph stalls
 * silently. Ground 7 cannot see it either: `Closes #11` is a keyword GitHub
 * acts on, which is all that ground asks.
 *
 * The binding arrives from the CALLER (`--issue`, the orchestrator naming the
 * ticket it is merging) or from the dispatch record of the PR's branch, and
 * `boundTicket` in pr-gate.mjs owns that read. Here it is only compared:
 *  - the set CONTAINS it: a note, and closure verification then polls that
 *    number. Sibling closures are named, never refused — a body may deliver
 *    more than one ticket, and GitHub closes every construct it recognises
 *    (PR #77 review, P2).
 *  - the set is non-empty and does NOT contain it: a REFUSAL, so it lands
 *    before the mutation rather than after it, where a merged PR cannot be
 *    un-merged.
 *  - bound with nothing closing in this repository: also a refusal — the
 *    dispatched ticket would stay open, which is the same stall by omission.
 *  - unbound while the body DOES close a ticket here: an inability to
 *    establish, never a pass. That is F-001's rule applied to a read: an
 *    absent record is unknown, and unknown must not become "the body must be
 *    right". A caller who knows better says so with `--issue`.
 *
 * A body that closes nothing here AND no binding is not this ground's
 * business: nothing closes, nothing was claimed, and Ground 7 already owns
 * whether that body may merge at all.
 */
export function ticketGround({ binding, closes, pr, slug }) {
  const out = account();
  const named = closes.map(issue => `#${issue}`).join(', ');
  if (!binding.ok) {
    if (closes.length === 0) return out;
    out.unknown(`ticket binding: this PR's body closes ${named}, and ${binding.reason}`, binding.repair);
    return out;
  }
  const bound = binding.issue;
  if (closes.length === 0) {
    out.refuse(
      `ticket binding: this merge is for #${bound} (${binding.source}), and the body closes no same-repository issue, so #${bound} would stay open after it — every ticket blocked by #${bound} then derives from a stale blocker`,
      `gh pr edit ${pr} --repo ${slug} --body-file -   # add "Closes #${bound}", or merge by hand if this PR is not that ticket's delivery`,
    );
    return out;
  }
  if (!closes.includes(bound)) {
    out.refuse(
      `ticket binding: this merge is for #${bound} (${binding.source}), but the body closes ${named} — merging would close ${named} and leave #${bound} open, and every ticket blocked by #${bound} keeps deriving from a stale blocker`,
      `gh pr edit ${pr} --repo ${slug} --body-file -   # make the body close #${bound}, or re-run naming the ticket this PR really delivers`,
    );
    return out;
  }
  const siblings = closes.filter(issue => issue !== bound);
  out.note(
    `ticket binding: the body closes #${bound}, the ticket this merge is for (${binding.source})` +
      (siblings.length === 0 ? '' : `; it also closes ${siblings.map(issue => `#${issue}`).join(', ')}, which GitHub closes too`),
  );
  return out;
}

/**
 * Ground 8. The declaration guard: a PR must not weaken the gate that
 * measures it.
 *
 * `declarationOf` reads `prGate` from the working tree with no notion of who
 * last changed it, so the first PR that edits the block silently redefines
 * what every LATER autonomous merge must prove — and this PR is still measured
 * by the OLD grounds, so nothing else refuses it. Under gate-sovereign merging
 * (KD2) that is the one change that can disarm the gate from inside the loop;
 * refusing it here is what returns the human for exactly that change and no
 * other.
 *
 * The comparison is SEMANTIC, merge-base against head: the two committed
 * `prGate` values, canonically serialised — never a grep over patch lines,
 * which misses a value edited without its key appearing in the hunk. An
 * absent file is a confirmed-absent declaration (`undefined`), which compares
 * clean against itself; an unreadable side is an unknown, not a match (F-028).
 *
 * THE AFTER SIDE IS THE VALIDATED SHA, not the head BRANCH. Resolving a name
 * here reintroduced everything the gate's single head resolution exists to
 * prevent: `origin/<head>` is preferred over the local branch and answers
 * whatever the last fetch left behind, so a stale — or foreign — ref made the
 * guard compare a tree nobody is merging, and a PR that weakens `prGate`
 * reads clean. The gate resolves the head SHA once; this ground takes THAT.
 *
 * The base side has no SHA to stand on, so it stands on the refresh instead:
 * `refsRefreshed` is the gate's reading of gitGrounds' own fetch. An
 * unrefreshed base ref is exactly the F-033/#1939 hazard applied to the
 * declaration — the before side would be read from whatever the disk holds —
 * so it is an unknown here, never a clean note.
 */
export const canonical = value =>
  JSON.stringify(value, (key, inner) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().map(name => [name, inner[name]]))
      : inner,
  );

export function declarationGround({ git, root, baseBranch, sha, refsRefreshed, pr, slug }) {
  const out = account();
  const gitRun = args => git(args, root);
  if (!refsRefreshed) {
    out.unknown(
      `declaration guard: the refs could not be refreshed, so '${baseBranch}' may predate this head and the before side of the prGate comparison is unreadable`,
      `git fetch origin ${baseBranch}`,
    );
    return out;
  }
  const baseRef = resolveRef(gitRun, baseBranch);
  const headRef = sha;
  if (baseRef === '' || !/^[0-9a-f]{40}$/.test(String(headRef))) {
    out.unknown(
      `declaration guard: '${baseBranch}' is absent from this checkout, or the validated head SHA is not one, so whether this PR edits prGate is unreadable`,
      `git fetch origin ${baseBranch}`,
    );
    return out;
  }
  const mergeBase = gitRun(['merge-base', baseRef, headRef]);
  if (!succeeded(mergeBase)) {
    out.unknown(
      `declaration guard: no merge base between ${baseRef} and ${headRef}, so the prGate diff has no before side`,
      `git merge-base ${baseRef} ${headRef}`,
    );
    return out;
  }
  const declarationAt = ref => {
    const shown = gitRun(['show', `${ref}:${CONFIG_FILE}`]);
    if (succeeded(shown)) {
      try {
        return { ok: true, gate: JSON.parse(String(shown.stdout ?? '')).prGate };
      } catch {
        return { ok: false, reason: `${CONFIG_FILE} at ${clean(ref)} is not readable JSON`, repair: `git show ${ref}:${CONFIG_FILE}` };
      }
    }
    const stderr = String(shown.stderr ?? '');
    // git's two "confirmed absent" answers; anything else is a failed read.
    if (/does not exist|exists on disk, but not in|invalid object name/i.test(stderr)) return { ok: true, gate: undefined };
    return { ok: false, reason: `git show ${clean(ref)}:${CONFIG_FILE} failed (${clean(firstLine(stderr))})`, repair: `git show ${ref}:${CONFIG_FILE}` };
  };
  const before = declarationAt(String(mergeBase.stdout ?? '').trim());
  const after = declarationAt(headRef);
  for (const side of [before, after]) {
    if (!side.ok) {
      out.unknown(`declaration guard: ${side.reason}`, side.repair);
      return out;
    }
  }
  if (canonical(before.gate) === canonical(after.gate)) {
    out.note('declaration guard: the PR leaves the prGate declaration untouched');
  } else {
    out.refuse(
      'declaration guard: this PR edits the prGate declaration it is measured by — measured by the OLD grounds, it would silently redefine what every later autonomous merge must prove',
      `review the prGate diff, then merge by hand: gh pr merge ${pr} --repo ${slug} --squash   # the human checkpoint this refusal restores`,
    );
  }
  return out;
}
