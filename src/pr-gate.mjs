// `ax pr gate` — decides whether a pull request may merge, and merges it.
//
// WHY THIS VERB EXISTS (measured 2026-08-09). The gate a coordinator carried in
// prose read `gh pr checks` and `gh pr view --json`. On `gapila` #1845 that
// dashboard showed 21 green checks on the exact head SHA, a green aggregate
// verdict and `mergeStateStatus: CLEAN` — while a P1 review comment sat unread
// in the thread. Its author posts a REVIEW, not a check: it has no row in
// `check-runs` at all, neither green nor neutral nor visibly absent (F-031).
// Three more grounds are invisible to that same dashboard:
//
//   * `CLEAN` survives a base that has advanced, because this repository does
//     not require an up-to-date branch, so `BEHIND` never appears (F-033.2)
//   * a squash merge makes every ancestry test answer "not merged", including
//     for the branch just merged (F-033.1)
//   * a residual-findings file is routinely left stale by its own later commits
//     (F-009)
//
// Every ground below is EXECUTED against live state and contributes a named
// reason to one verdict. NOTHING SHORT-CIRCUITS: F-033 recorded two grounds
// firing on the same merge, and a gate that stops at the first teaches the
// caller to fix one thing and come back.
//
// Identifiers and flags only: no free text ever reaches this command line. The
// PR body and the review threads are read from the API, never interpolated into
// argv (D-030's carve-out).
//
// EXIT CODES (ADR 0003 — per verb, never a shared alphabet)
//   0  pass
//   1  refusal, with every named reason printed
//   2  usage error. The Bash spent 3 here; in ax, 2 is the usage error on every
//      verb, so it moves. The Bash's "reserved 2" line is dead and does not
//      survive the port.
//   3  cannot establish — including "no prGate declared for this checkout"
// A refusal outranks an inability to establish when both apply: neither merges,
// and a named reason is the more actionable of the two.
//
// WHERE THE DECLARATION LIVES. The Bash kept a machine-wide `merge-gate.json`
// keyed by `owner/repo`, because it was a machine-wide script. `ax` runs inside
// the checkout the PR is about, so the repo name is not part of the key: the
// declaration is `prGate` in this checkout's `ax.config.json`, and `--repo`
// naming a DIFFERENT repository is a refusal — the declaration read would then
// be the wrong project's. `residualFindings` is declared for the same reason:
// the Bash hardcoded `docs/residual-review-findings`, which is one project's
// layout living in a tool, and this package runs in other people's repos.
//
// The git-backed grounds (staleness, landed-by-content, residual findings) run
// against the current checkout, which must hold the PR branch.

import { loadCheckoutConfig, repoPaths } from './config.mjs';
import { bad, fix, note, section } from './log.mjs';
import { defaultExec } from './worker/release.mjs';

const USAGE = 'ax pr gate --pr <n> [--repo <owner/repo>] [--merge] [--ack-body] [--method squash|merge]';

/** A closing verb GitHub acts on, in the documented variants. */
const KEYWORDS = 'clos(?:e|es|ed)|fix(?:|es|ed)|resolv(?:e|es|ed)';

/** What an issue reference is allowed to look like after one of those verbs. */
const TARGET = '(?:#\\d+|[\\w.-]+/[\\w.-]+#\\d+|https://github\\.com/[\\w.-]+/[\\w.-]+/issues/\\d+)';

/**
 * A closing verb in ANY language, English included. This is what says the author
 * meant to close something; `KEYWORDS` above is what GitHub acts on. The gap
 * between the two sets is the whole of ground 7.
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

/** Defensive bound, not a measurement: stop rather than loop forever. */
const MAX_THREAD_PAGES = 50;

const firstLine = text => String(text ?? '').split('\n')[0].trim();

const succeeded = out => !out.error && out.status === 0;

/**
 * One printable, bounded line out of foreign text — a thread id, a login, a
 * path, a url. Same reason as the missing `body` field one door up: what comes
 * back from the API is printed as a label, never as prose.
 */
const clean = value => {
  const text = String(value ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '');
  return text.slice(0, 200) || '-';
};

/**
 * A named key, never an `or` fallback on a container: an absent container must
 * raise, not quietly become an empty one that satisfies every test (F-028).
 */
const must = (object, key, where) => {
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
function payload(out) {
  if (!succeeded(out)) return { ok: false, reason: `failed — ${firstLine(out.stderr) || `exit ${out.status}`}` };
  try {
    return { ok: true, value: JSON.parse(String(out.stdout ?? '')) };
  } catch (error) {
    return { ok: false, reason: `answered something that is not JSON (${error.message})` };
  }
}

/**
 * The check-run names this checkout expects, or the reason it declares none.
 *
 * Ground 0. An absent declaration is an inability to establish, never "nothing
 * expected, therefore nothing missing" — that inference is F-028's shape applied
 * to a merge (KTD8). `aggregate` XOR `checks`: a repository with a single job
 * aggregating the rest declares that one name, because the SET of runs on a SHA
 * depends on the diff, on labels and on bots that decide for themselves whether
 * to run — 21 on one PR and 15 on another an hour apart (F-014), so counting
 * them proves nothing.
 */
export function readDeclaration(prGate) {
  if (prGate === undefined || prGate === null) return { ok: false, reason: 'no prGate key' };
  if (typeof prGate !== 'object' || Array.isArray(prGate)) return { ok: false, reason: 'prGate is not an object' };

  const hasAggregate = 'aggregate' in prGate;
  const hasChecks = 'checks' in prGate;
  if (hasAggregate && hasChecks) {
    return { ok: false, reason: 'prGate declares both aggregate and checks — one repository has one expectation' };
  }
  if (hasAggregate) {
    const aggregate = prGate.aggregate;
    if (typeof aggregate !== 'string' || aggregate.trim() === '') return { ok: false, reason: 'prGate.aggregate is not a check-run name' };
    return { ok: true, mode: 'aggregate', expected: [aggregate] };
  }
  if (hasChecks) {
    const checks = prGate.checks;
    if (!Array.isArray(checks) || checks.length === 0) return { ok: false, reason: 'prGate.checks is not a non-empty list' };
    for (const check of checks) {
      if (typeof check !== 'string' || check.trim() === '') return { ok: false, reason: 'prGate.checks holds a value that is not a name' };
    }
    return { ok: true, mode: 'checks', expected: [...checks] };
  }
  return { ok: false, reason: 'prGate declares neither aggregate nor checks' };
}

export function gate(
  argv = [],
  { gh = (args, at) => defaultExec('gh', args, at), git = (args, at) => defaultExec('git', args, at), cwd = process.cwd() } = {},
) {
  const usageError = message => {
    process.stderr.write(`ax pr gate: ${message}\n${USAGE}\n`);
    return 2;
  };
  /** Fatal before any ground could run: the run stops, and nothing is claimed. */
  const cannot = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    if (repair) fix(repair);
    return 3;
  };

  let pr = '';
  let repoArg = '';
  let doMerge = false;
  let ackBody = false;
  let method = 'squash';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--pr') pr = value();
    else if (arg === '--repo') repoArg = value();
    else if (arg === '--merge') doMerge = true;
    else if (arg === '--ack-body') ackBody = true;
    else if (arg === '--method') method = value();
    // Identifiers and flags only — an extra bare word is not a sentence this
    // command reads, it is an argument it does not have.
    else return usageError(`unknown argument "${arg}"`);
  }

  if (!/^[1-9][0-9]{0,9}$/.test(pr)) return usageError(pr === '' ? 'no --pr given' : `--pr expects a PR number, got "${pr}"`);
  if (repoArg !== '' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoArg)) return usageError(`--repo expects owner/repo, got "${repoArg}"`);
  // `rebase` is deliberately absent: no policy anywhere asks for it. `merge` (a
  // real merge commit) exists for the one class that must keep upstream SHAs as
  // ancestors of main — upgrade PRs, where a squash silently severs kit ancestry
  // and the next upgrade replays every conflict from an old merge-base. Measured
  // 2026-08-14 on #1934: the gate PASSed and its own merge would have been the
  // destructive step.
  if (!['squash', 'merge'].includes(method)) return usageError(`--method expects squash|merge, got "${method}"`);

  const paths = repoPaths(cwd);
  if (!paths.root) {
    return cannot(
      'not inside a git repository, so this checkout declares nothing and the git-backed grounds have nothing to read',
      'cd into the checkout that holds the PR branch, then re-run',
    );
  }

  const loaded = loadCheckoutConfig(paths);
  if (loaded.errors.length > 0) return cannot(`${loaded.path} is not usable: ${loaded.errors[0]}`, 'ax doctor   # then re-run');

  // ── Ground 0. The declaration ──────────────────────────────────────────────
  const declared = readDeclaration(loaded.config?.prGate);
  if (!declared.ok) {
    return cannot(
      `${declared.reason} in ${loaded.path} — an undeclared repository is not a repository with nothing left to check`,
      'add "prGate": { "aggregate": "<check-run name>" } to ax.config.json, or "checks": ["<name>", …] where no aggregate job exists',
    );
  }

  const run = args => gh(args, paths.root);
  const own = resolveRepo(run);
  if (own === '') {
    return cannot("could not resolve this checkout's repository", 'gh auth status   # then re-run from a checkout with a GitHub remote');
  }
  if (repoArg !== '' && repoArg !== own) {
    // The declaration above came from THIS checkout. Gating another repository
    // with it would decide a merge against the wrong project's expectation —
    // which is exactly the failure mode a machine-wide declaration file has.
    bad(`REFUSE — --repo names ${repoArg}, but this checkout is ${own}, so the prGate read above is the wrong project's`);
    fix(`cd into a checkout of ${repoArg}, then: ax pr gate --pr ${pr}`);
    return 1;
  }
  const slug = own;
  const [owner, name] = slug.split('/');

  // ── Setup. The head SHA is resolved ONCE and every ground below uses that one
  // value, so no step can validate one commit and speak about another.
  const receipt = payload(
    run(['pr', 'view', pr, '--repo', slug, '--json', 'number,headRefOid,headRefName,baseRefName,body,createdAt,mergeStateStatus']),
  );
  if (!receipt.ok) {
    return cannot(`'gh pr view ${pr} --repo ${slug}' ${receipt.reason}`, `gh pr view ${pr} --repo ${slug}   # read it by hand`);
  }

  // No value extracted from a command's output is used before it is validated
  // well-formed. The second half of F-028 records a published contract corrupted
  // by an empty capture.
  let sha;
  let headBranch;
  let baseBranch;
  let created;
  try {
    const where = 'the PR receipt';
    sha = String(must(receipt.value, 'headRefOid', where)).trim();
    headBranch = String(must(receipt.value, 'headRefName', where)).trim();
    baseBranch = String(must(receipt.value, 'baseRefName', where)).trim();
    created = String(must(receipt.value, 'createdAt', where)).trim();
    if ([sha, headBranch, baseBranch, created].some(field => field === '')) throw new Error(`${where}: a field this gate needs is empty`);
  } catch (error) {
    return cannot(error.message, `gh pr view ${pr} --repo ${slug} --json headRefOid,headRefName,baseRefName,createdAt`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return cannot('the head SHA is not a 40-hex commit id', `gh pr view ${pr} --repo ${slug} --json headRefOid`);
  }
  const openedAt = Date.parse(created);
  if (Number.isNaN(openedAt)) {
    return cannot(`the PR receipt's createdAt is not a date ("${clean(created)}")`, `gh pr view ${pr} --repo ${slug} --json createdAt`);
  }
  const mergeState = typeof receipt.value.mergeStateStatus === 'string' && receipt.value.mergeStateStatus !== '' ? receipt.value.mergeStateStatus : '-';
  const body = typeof receipt.value.body === 'string' ? receipt.value.body : '';

  const notes = [];
  const unknowns = [];
  const refusals = [];
  const addNote = message => notes.push({ message });
  const unknown = (message, repair) => unknowns.push({ message, repair });
  const refuse = (message, repair) => refusals.push({ message, repair });

  section(`pr gate — ${slug}#${pr}`);
  note(`head SHA         ${sha}  (resolved once; every ground below uses this value)`);
  note(`branch / base    ${headBranch} -> ${baseBranch}`);
  // Printed as context and never read as a ground: `BEHIND` only appears where
  // branch protection demands an up-to-date branch (F-033.2).
  note(`mergeStateStatus ${mergeState}  (context only — never a ground here, F-033.2)`);
  note(`expectation      ${declared.mode}: ${declared.expected.join(', ')}`);

  // ── Ground 1. The declared checks, decided and passing on that exact SHA ────
  // Never a count comparison between two PRs (F-014, above).
  let ciDecided = true;
  const checkRuns = payload(run(['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`]));
  if (!checkRuns.ok) {
    ciDecided = false;
    unknown(
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
      unknown(`checks: ${error.message}; CI state unread`, `gh api repos/${slug}/commits/${sha}/check-runs`);
      runs = null;
    }
    if (runs !== null) {
      addNote(`checks: ${runs.length} check-run(s) reported on ${sha.slice(0, 12)}`);
      for (const expected of declared.expected) {
        const rows = runs.filter(row => row?.name === expected);
        if (rows.length === 0) {
          // A check that never ran is not a check that passed. This is the trap
          // the gate exists for: when a guard job fails early, everything
          // downstream never executes.
          refuse(
            `checks: expected ${declared.mode} check '${clean(expected)}' has NO run on ${sha.slice(0, 12)}`,
            `gh api repos/${slug}/commits/${sha}/check-runs --jq '.check_runs[].name'   # is the name still spelled this way?`,
          );
          continue;
        }
        const pending = rows.find(row => row?.status !== 'completed');
        if (pending) {
          ciDecided = false;
          unknown(`checks: '${clean(expected)}' is ${clean(pending.status)} on ${sha.slice(0, 12)} — not decided`, 'gh run watch   # then re-run this gate');
          continue;
        }
        for (const row of rows) {
          // `neutral` is neither a success nor a failure, and the old dashboard
          // did not see it at all (F-031). Here it is a refusal like any other
          // non-success.
          if (row?.conclusion !== 'success') {
            refuse(
              `checks: '${clean(expected)}' concluded ${clean(row?.conclusion)} on ${sha.slice(0, 12)}`,
              `gh pr checks ${pr} --repo ${slug}   # then fix the job, or re-run it`,
            );
          }
        }
      }
    }
  }

  // ── Ground 2. Review threads, and ONLY after CI is decided ─────────────────
  // The reviewer that posted the P1 arrives asynchronously, unrelated to the end
  // of CI. On #1847, read while the last E2E batch was still running, the thread
  // was empty — and that reading was worth nothing. An empty thread observed
  // before CI is decided is not an observation (F-031). So no GraphQL call is
  // issued at all here: a read whose answer cannot be trusted must not look like
  // one that can.
  if (!ciDecided) {
    unknown(`threads: CI is not decided on ${sha} — a thread read now is no observation at all`, `ax pr gate --pr ${pr}   # once CI has finished`);
  } else {
    let cursor = null;
    for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
      const args = ['api', 'graphql', '-f', `query=${THREAD_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`];
      if (cursor !== null) args.push('-f', `cursor=${cursor}`);
      const answered = payload(run(args));
      if (!answered.ok) {
        unknown(`threads: the GraphQL reviewThreads query ${answered.reason}; resolution state unread`, 'gh auth status   # then re-run this gate');
        break;
      }
      let threads;
      try {
        const data = must(answered.value, 'data', 'the reviewThreads payload');
        const repository = must(data, 'repository', 'data');
        const pullRequest = must(repository, 'pullRequest', 'repository');
        threads = must(pullRequest, 'reviewThreads', 'pullRequest');
      } catch (error) {
        unknown(`threads: ${error.message}; resolution state unread`, 'gh auth status   # then re-run this gate');
        break;
      }
      const nodes = Array.isArray(threads.nodes) ? threads.nodes : [];
      let unresolved = 0;
      for (const thread of nodes) {
        if (thread?.isResolved === true) continue;
        unresolved += 1;
        const first = thread?.comments?.nodes?.[0] ?? {};
        refuse(
          `threads: unresolved thread ${clean(thread?.id)} by ${clean(first.author?.login)} on ${clean(first.path)} — ${clean(first.url)}`,
          `open ${clean(first.url)}   # resolve it there, then re-run this gate`,
        );
      }
      addNote(`threads: page ${page} — ${nodes.length} thread(s), ${unresolved} unresolved`);
      const info = threads.pageInfo ?? {};
      if (info.hasNextPage !== true) break;
      cursor = info.endCursor ?? null;
      if (cursor === null) {
        unknown('threads: a page claims a next one and names no cursor, so the remaining threads are unread', 'gh auth status   # then re-run this gate');
        break;
      }
      if (page === MAX_THREAD_PAGES) unknown(`threads: pagination exceeded ${MAX_THREAD_PAGES} pages; stopped rather than looping`);
    }
  }

  // ── Grounds 3, 4 and 5 are git-backed and read this checkout ───────────────
  const residualDir = typeof loaded.config?.prGate?.residualFindings === 'string' ? loaded.config.prGate.residualFindings : '';
  // Declared, never assumed: absent means this ground is NOT RUN, and the gate
  // says so instead of passing it silently.
  if (residualDir === '') {
    addNote('residual findings: NOT RUN — this checkout declares no prGate.residualFindings, and an unrun ground is not a passed one');
  }
  const residualUnknown = (message, repair) => {
    if (residualDir !== '') unknown(message, repair);
  };

  const gitRun = args => git(args, paths.root);
  if (!succeeded(gitRun(['rev-parse', '--git-dir']))) {
    unknown('staleness: not inside a git checkout, so ancestry against the base is unreadable', 'cd into the checkout that holds this branch, then re-run');
    residualUnknown('residual findings: not inside a git checkout', 'cd into the checkout that holds this branch, then re-run');
    addNote('landed-by-content: not decided — not inside a git checkout');
  } else {
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
    let fetchState = 'local-only';
    if (succeeded(gitRun(['remote', 'get-url', 'origin']))) {
      const fetched = gitRun(['fetch', '--quiet', 'origin', baseBranch, headBranch]);
      fetchState = succeeded(fetched) ? 'ok' : 'failed';
      if (fetchState === 'failed') {
        unknown(
          `staleness: could not fetch '${baseBranch}' and '${headBranch}' from origin (${clean(firstLine(fetched.stderr))}), so ancestry would be read from refs that may predate this head`,
          `git fetch origin ${baseBranch} ${headBranch}`,
        );
        residualUnknown(
          "residual findings: the refs could not be refreshed, so this branch's files cannot be read at their current state",
          `git fetch origin ${baseBranch} ${headBranch}`,
        );
        addNote('landed-by-content: not decided — the refs could not be refreshed');
      }
    }

    const resolveRef = branch => {
      for (const candidate of [`origin/${branch}`, branch]) {
        if (succeeded(gitRun(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]))) return candidate;
      }
      return '';
    };
    const baseRef = fetchState === 'failed' ? '' : resolveRef(baseBranch);
    const headRef = fetchState === 'failed' ? '' : resolveRef(headBranch);

    if (fetchState === 'failed') {
      // Already reported above; the comparison is deliberately not attempted.
    } else if (baseRef === '' || headRef === '') {
      unknown(`staleness: '${baseBranch}' or '${headBranch}' is absent from this checkout`, `git fetch origin ${baseBranch} ${headBranch}`);
      residualUnknown(`residual findings: '${headBranch}' is absent from this checkout`, `git fetch origin ${headBranch}`);
      addNote('landed-by-content: not decided — a ref is missing from this checkout');
    } else {
      if (fetchState === 'local-only') addNote("staleness: no 'origin' remote in this checkout, so ancestry is read from local refs");

      // ── Ground 3. Staleness by ancestry, never by mergeStateStatus ──────────
      // `BEHIND` only appears where branch protection demands an up-to-date
      // branch, so on a repository that does not it never appears and `CLEAN`
      // outlives a base that has advanced (F-033.2).
      if (succeeded(gitRun(['merge-base', '--is-ancestor', baseRef, headRef]))) {
        addNote(`staleness: ${headRef} carries ${baseRef} — the branch is current`);
      } else {
        refuse(
          `staleness: ${baseRef} is not an ancestor of ${headRef} — the branch is behind its base (mergeStateStatus reads ${mergeState}, which is not the question)`,
          `git fetch origin ${baseBranch} && git merge origin/${baseBranch}   # then push`,
        );
      }

      // ── Ground 4. Landed by CONTENT, for the post-merge cleanup question ────
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
          addNote(`landed-by-content: NO — ${differing.length} file(s) still differ from ${baseRef} (ancestry says ${ancestry})`);
        } else {
          addNote(
            `landed-by-content: YES — content equal to ${baseRef}, so the work landed and the worktree may go (ancestry says ${ancestry}; after a squash it always says no)`,
          );
        }
      } else {
        addNote("landed-by-content: not decided — 'git diff' failed");
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
          unknown(`residual findings: 'git diff' could not answer against ${baseRef}`, `git diff --name-only ${baseRef}...${headRef} -- ${residualDir}`);
        } else if (String(touched.stdout ?? '').trim() === '') {
          // F-011: the two readings of an untouched directory are not separable
          // by any git measurement, so this ground names both instead of picking
          // one.
          addNote(
            `residual findings: [DETECTOR] this branch wrote nothing under ${residualDir}. That is either 'every finding was ticketed' or 'nothing was traced', and no git measurement separates them — read the PR's linked issues (F-011)`,
          );
        } else {
          const last = gitRun(['log', '-1', '--format=%H', `${baseRef}..${headRef}`, '--', residualDir]);
          const resCommit = succeeded(last) ? String(last.stdout ?? '').trim() : '';
          if (resCommit === '') {
            unknown(
              `residual findings: ${residualDir} differs from ${baseRef} but no commit on this branch touched it`,
              `git log ${baseRef}..${headRef} -- ${residualDir}`,
            );
          } else {
            const later = gitRun(['rev-list', '--count', `${resCommit}..${headRef}`]);
            const count = succeeded(later) ? String(later.stdout ?? '').trim() : '';
            if (!/^[0-9]+$/.test(count)) {
              unknown("residual findings: 'git rev-list --count' could not answer", `git rev-list --count ${resCommit}..${headRef}`);
            } else if (Number(count) > 0) {
              refuse(
                `residual findings: this branch wrote ${residualDir} at ${resCommit.slice(0, 12)} and ${count} of its own commit(s) landed after it`,
                `git log ${baseRef}..${headRef}   # re-read the file against these commits, then commit it again`,
              );
            } else {
              addNote(`residual findings: written by this branch at ${resCommit.slice(0, 12)}, the newest commit on ${headRef}`);
            }
          }
        }
      }
    }
  }

  // ── Ground 6. The commits made since the PR opened ─────────────────────────
  // A DETECTOR: a PR body's staleness is not mechanically decidable, so the gate
  // lists the commits and refuses until the caller acknowledges the list with
  // `--ack-body` (KTD9).
  const commits = payload(run(['api', `repos/${slug}/pulls/${pr}/commits?per_page=100`]));
  if (!commits.ok) {
    unknown(`commits since open: 'gh api repos/${slug}/pulls/${pr}/commits' ${commits.reason}`, `gh api repos/${slug}/pulls/${pr}/commits`);
  } else {
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
      if (late.length === 0) addNote('commits since open: none — the body describes every commit on the branch');
      else if (ackBody) addNote(`commits since open: ${late.length} acknowledged via --ack-body (${late.join(' ')})`);
      else {
        refuse(
          `commits since open [DETECTOR]: ${late.length} commit(s) landed after the PR was opened (${late.join(' ')})`,
          `gh pr view ${pr} --repo ${slug} --json body   # re-read the body against them, then: ax pr gate --pr ${pr} --ack-body`,
        );
      }
    } catch (error) {
      unknown(`commits since open: ${error.message}`, `gh api repos/${slug}/pulls/${pr}/commits`);
    }
  }

  // ── Ground 7. A closing keyword GitHub actually recognises ─────────────────
  // `Ferme #N` and `Clot #N` close nothing, and a view that treats open issues
  // as its queue then re-dispatches delivered work. F-018 exactly: PR #1831
  // opened on `Ferme #1786`, merged, and #1786 stayed OPEN and `ready-for-agent`.
  // Only the matched phrase is echoed, never the surrounding prose.
  const tracker = loaded.config?.prGate?.tracker;
  const matched = new RegExp(`\\b(?:${KEYWORDS})\\b\\s*:?\\s+${TARGET}`, 'i').exec(body);
  const intended = new RegExp(`\\b(?:${INTENT})\\b\\s*:?\\s+${TARGET}`, 'i').exec(body);
  if (matched) {
    addNote(`closing keyword: '${clean(matched[0].trim())}' — GitHub will close the issue`);
  } else if (intended) {
    refuse(
      `closing keyword: '${clean(intended[0].trim())}' closes nothing — GitHub acts only on Closes / Fixes / Resolves and their documented variants (F-018)`,
      `gh pr edit ${pr} --repo ${slug}   # rewrite it as "Closes #N"`,
    );
  } else {
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
      addNote(
        `closing keyword: no GitHub keyword, but the body names ${clean(declaredTracker.name)} '${clean(ref[0])}' — GitHub closes nothing there, so that ticket moves by hand`,
      );
    } else {
      // Genuinely nothing. That is a tooling fix, a docs pass, a chore — and
      // refusing it would block every such PR forever. The distinction between
      // "absent by mistake" and "absent by design" is not decidable from the
      // body, so this ground says which of the two it found instead of guessing.
      // Same family as the residual ground (F-039), one ground over, found the
      // same day by running this gate on a real PR.
      addNote(
        'closing keyword: [DETECTOR] the body closes no issue and expresses no intent to. That is a PR with no ticket behind it, or an author who forgot — no reading of the body separates them',
      );
    }
  }

  // ── The verdict. Every ground reported, none suppressed by another ─────────
  // A refusal outranks an inability to establish: neither merges, and a named
  // reason is the more actionable of the two.
  const code = refusals.length > 0 ? 1 : unknowns.length > 0 ? 3 : 0;

  section(`grounds — ${notes.length} reported, ${unknowns.length} unread, ${refusals.length} refused`);
  for (const entry of notes) note(entry.message);
  for (const entry of unknowns) {
    bad(`CANNOT ESTABLISH — ${entry.message}`);
    if (entry.repair) fix(entry.repair);
  }
  for (const entry of refusals) {
    bad(`REFUSE — ${entry.message}`);
    if (entry.repair) fix(entry.repair);
  }

  section('what this run prevents and what it merely detects (R21)');
  note(`prevents  the declared checks, the review threads, staleness, the residual file and the closing keyword — each read against live state on ${sha}`);
  note("detects   the commits landed since the PR opened: a body's staleness is not mechanically decidable, so that ground lists and refuses, it does not verify");
  note('reports   landed-by-content, which answers the post-merge cleanup question, not this one');

  section(
    code === 0
      ? `PASS — ${slug}#${pr} is mergeable at ${sha}.`
      : code === 1
        ? `REFUSE — ${refusals.length} named reason(s). Nothing was mutated.`
        : `CANNOT ESTABLISH — ${unknowns.length} ground(s) unread. Nothing was mutated.`,
  );

  if (!doMerge) {
    // A printed command is advice a caller can substitute, and
    // `--match-head-commit` only closes the push race when the exact validated
    // command is the one that runs. So the merge lives here, behind a flag.
    note('DETECTOR RUN — no --merge, so this run decided nothing and mutated nothing');
    fix(`ax pr gate --pr ${pr}${repoArg === '' ? '' : ` --repo ${repoArg}`} --merge   # have this gate perform the merge it validated`);
    return code;
  }
  if (code !== 0) {
    note('--merge ignored: the verdict is not a pass, so nothing was mutated');
    return code;
  }

  note(`merging with the SHA this run validated (method: ${method})`);
  const merged = run(['pr', 'merge', pr, '--repo', slug, `--${method}`, '--match-head-commit', sha]);
  if (!succeeded(merged)) {
    bad(`MERGE FAILED — ${firstLine(merged.stderr) || `exit ${merged.status}`}; the head may have moved past ${sha}`);
    fix(`ax pr gate --pr ${pr} --merge   # re-run the gate against the new head`);
    return 1;
  }
  note(`MERGED — ${slug}#${pr} at ${sha} (${method})`);
  return 0;
}

/** The checkout's own repository, the way `ax triage publish` resolves it. */
function resolveRepo(run) {
  const out = run(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (!succeeded(out)) return '';
  return firstLine(out.stdout);
}
