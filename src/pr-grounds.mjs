// The grounds `ax pr gate` executes — each one a predicate over live state,
// answering through its own interface with the entries it wants printed:
// `{ notes, unknowns, refusals }`, plus any fact another ground consumes
// (ciGround's `ciDecided`, closingChannels' `commitChannels`). NOTHING PRINTS
// HERE: gate() owns the order, the verdict and the exit code, so a ground can
// be proved alone without stubbing every sibling — which is what its tests do.
//
// The grounds' incident history — why each exists, what it measured — lives on
// each function below, moved intact from the file that paid for it.
//
// ONE SHAPE ANSWERS THREE OF THESE GROUNDS: the release pull request (#94).
// `readRelease`/`releaseShape` below decide it — the release bot's authorship
// AND the release label, or the `prGate.release` a project declares instead —
// and Grounds 6, 7 and 9 each ask it, because a release body is a changelog: it
// has no ticket by construction and never will. Measured on PR #68, the
// release-please pull request for 0.18.0: the keyword ground refused it
// structurally and 0.18.0 was merged by hand, while `.github/workflows/test.yml`
// promises in its own header that `workflow_dispatch` "is what keeps the
// release path gateable instead of permanently hand-merged".
//
// IT IS A SHAPE, NOT A FLAG. There is no `--no-keyword`, and `--ack-body` is
// not widened: nothing an author of an ordinary pull request can type reaches
// this exemption, which is why a ticket-less docs PR stays hand-merged. That is
// the ruled trade (2026-09-02), and it is what keeps R8's rule — absent closing
// intent is a refusal — honest for every PR that COULD have a ticket.

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

/**
 * WHAT A FIELD IS, in the one word a receipt has to print (#175). An incomplete
 * read is only actionable if it names the shape it got: "absent" sends the
 * caller to the query, "string" to the payload it came back with, and
 * "an empty string" to a cursor that would advance nowhere.
 */
const shapeOf = value =>
  value === undefined
    ? 'absent'
    : value === null
      ? 'null'
      : Array.isArray(value)
        ? 'a list'
        : value === ''
          ? 'an empty string'
          : typeof value;

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
 * The default release shape: the account release-please runs as, and the label
 * it puts on its own pull request.
 *
 * `github-actions[bot]` is the canonical login. It is not the only spelling a
 * read answers with, which is why the comparison below normalises rather than
 * matching literally — see `sameLogin`.
 *
 * A NAMED EXCEPTION TO "THE REPOSITORY IS INPUT", made by ruling (#94,
 * 2026-09-02: "declared wins; absent means the default shape"). AGENTS.md
 * requires labels and merge grounds to come from `ax.config.json`, and the rule
 * was paid for by `docs/residual-review-findings` — ONE project's directory
 * layout hardcoded into a tool that runs in other people's repositories. These
 * two strings are not that: they are release-please's own published contract,
 * identical in every repository that runs it, and a project whose automation
 * differs names its own with `prGate.release`, which then REPLACES this pair.
 *
 * The direction each choice fails in is what decided it. A required
 * declaration leaves every consumer's release path refusing until someone
 * discovers the key — the defect this shape exists to remove, one indirection
 * over. The default's cost is a bot-authored PR wearing release-please's label
 * in a repository that does not run release-please: it skips a body-staleness
 * detector, a keyword ground and a ticket comparison — never CI, threads,
 * staleness, residuals or the declaration guard — and producing it needs both
 * a workflow holding this repository's own token and that label deliberately
 * created.
 */
export const DEFAULT_RELEASE = { label: 'autorelease: pending', author: 'github-actions[bot]' };

/**
 * THE SUBJECT release-please COMMITS ITS BUMP UNDER. Its template is
 * `chore${scope}: release${component} ${version}`, and both the scope and the
 * component are optional in a project's configuration — measured on PR #68's
 * own commit, `chore(main): release 0.18.0`.
 *
 * THE VERSION IS THE LOAD-BEARING PART, not the word `release`. A first form
 * ended at `release\b` and accepted `chore: release-notes` and a bare
 * `chore: release` — release-shaped vocabulary with no bump behind it, which is
 * the vocabulary an exemption must not run on. A version is what a bump
 * carries, and it is the one part of the subject release-please cannot write
 * without.
 *
 * AND THE VERSION ENDS WHERE SEMVER ENDS. The second form closed on `\S*$`,
 * meaning to admit a prerelease or build tail and admitting anything welded to
 * the digits: `chore: release 1.2.3release-notes` read as a bump. What may
 * follow the digits is exactly SemVer's `-prerelease` and `+build`, so that is
 * what the pattern says. A tail nobody taught it is not a bump, which is the
 * direction an exemption must fail in.
 *
 * It is still prose, and prose is weaker evidence than an account. It is read
 * anyway, because the account is the strong half in the WRONG DIRECTION: the
 * release App's token belongs to every workflow this repository hands it to, so
 * authorship alone exempts commits release-please never wrote. Together they
 * name the bump; a subject this pattern cannot place refuses, and `--ack-body`
 * answers it — a cost one flag pays, unlike the structural refusal #94 removed.
 */
const RELEASE_SUBJECT = /^chore(\([^)]*\))?!?:\s+release\s+(?:\S+\s+)?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i;

/**
 * The release shape this checkout expects, or THE REASON ITS DECLARATION
 * CANNOT BE READ.
 *
 * Absent means the default shape, and says which one it is. A declared
 * `prGate.release` REPLACES it — a project whose release automation labels
 * differently names its own label, and the default stops applying, because two
 * shapes at once would mean the label a project did not declare still opens the
 * exemption. An incoherent declaration is neither: it is unread, and the gate
 * refuses to establish anything over it (Ground 0's disposition), because
 * falling back to the default there would silently answer a question the
 * project already answered differently.
 *
 * `author` stays part of a DECLARED shape, defaulting to the same bot. The
 * ruling's property is that no author can type their way into the exemption,
 * and a label is exactly something an author can add — so the identity half is
 * not optional, only nameable.
 */
export function readRelease(declared) {
  if (declared === undefined || declared === null) return { ok: true, ...DEFAULT_RELEASE, declared: false };
  if (typeof declared !== 'object' || Array.isArray(declared)) return { ok: false, reason: 'prGate.release is not an object' };
  const label = declared.label;
  if (typeof label !== 'string' || label.trim() === '') return { ok: false, reason: 'prGate.release names no label' };
  const author = declared.author === undefined ? DEFAULT_RELEASE.author : declared.author;
  if (typeof author !== 'string' || author.trim() === '') return { ok: false, reason: 'prGate.release.author is not a login' };
  return { ok: true, label: label.trim(), author: author.trim(), declared: true };
}

/**
 * ONE ACCOUNT, TWO SPELLINGS, measured 2026-09-03 on PR #68: `gh pr view 68
 * --json author` answers `app/github-actions` — gh's spelling for a GitHub App
 * over GraphQL — while that same PR's commits payload answers
 * `github-actions[bot]`. A literal comparison against either one alone is
 * false on the other read, and both reads decide this shape: the PR's author
 * comes from the receipt, each commit's from the commits endpoint.
 *
 * So `app/` and the `[bot]` suffix are normalised away and the comparison is
 * case-insensitive. It cannot collapse two different accounts: the bare login
 * of a GitHub App is reserved by that App, so `github-actions` names no other
 * identity a PR could be authored by.
 */
const loginOf = value =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^app\//, '')
    .replace(/\[bot\]$/, '');

const sameLogin = (left, right) => loginOf(left) !== '' && loginOf(left) === loginOf(right);

/**
 * Is THIS pull request the release shape?
 *
 * Both halves, read from the receipt the gate already fetches: the author is
 * the release bot, and the pull request carries the release label. Either half
 * alone is not the shape — the label is something a contributor can add, and
 * the bot opens ordinary pull requests too (a dependency bump carries no
 * release label).
 *
 * THE SHAPE IS A POSITIVE FINDING, which is how F-028 reads here: an author or
 * a label this run could not read leaves the shape unrecognised, and the ground
 * that would have refused refuses exactly as it did before the exemption
 * existed. Absence therefore cannot GRANT the exemption, which is the only
 * direction that mutates. `near` marks the diagnostic case worth printing on a
 * PR that is not exempt: the release bot's own pull request, missing the label.
 */
export function releaseShape({ author, labels, declared }) {
  if (!declared?.ok) return { ok: false, why: 'the release declaration is unread, so no PR is the release shape' };
  const login = String(author ?? '').trim();
  if (login === '') return { ok: false, why: 'the PR receipt names no author, so the release shape is unread (F-028)' };
  if (!sameLogin(login, declared.author)) return { ok: false, why: `author '${clean(login)}' is not '${clean(declared.author)}'` };
  if (!Array.isArray(labels)) return { ok: false, near: true, why: `author '${clean(login)}' is the release bot, but the PR receipt names no labels, so the shape is unread (F-028)` };
  const wanted = declared.label.toLowerCase();
  if (!labels.some(entry => String(entry?.name ?? '').trim().toLowerCase() === wanted)) {
    return { ok: false, near: true, why: `author '${clean(login)}' is the release bot, but the PR carries no '${clean(declared.label)}' label` };
  }
  return {
    ok: true,
    author: declared.author,
    label: declared.label,
    why: `author '${clean(login)}' and label '${clean(declared.label)}'${declared.declared ? ' (declared in prGate.release)' : ''}`,
  };
}

/**
 * The most check-runs one page of this endpoint answers with, and the most
 * pages this run will ask for.
 *
 * The page size is the API's own cap. The page bound is what makes the loop
 * terminate on a total the endpoint keeps announcing and never delivers:
 * 2500 runs on one commit is far past anything a repository declares, and
 * crossing it registers an `unknown` — which fails this gate closed — never a
 * truncated read reported as a complete one.
 */
const CHECK_RUNS_PAGE = 100;
const MAX_CHECK_PAGES = 25;

/**
 * AN ANNOUNCED TOTAL, in the words a receipt has to print. `shapeOf` answers
 * "number" for `-1` and for `1.5`, which sends nobody anywhere: a count that
 * is a number but not a countable one is printed as the value it was.
 */
const countShape = value => (typeof value === 'number' ? String(value) : shapeOf(value));

/**
 * Ground 1. The declared checks, decided and passing on that exact SHA.
 * Never a count comparison between two PRs (F-014).
 *
 * Returns `ciDecided` beside the entries: threadsGround consumes it, and the
 * dependency is in the signatures rather than in a shared mutable.
 *
 * ONE PAGE IS NOT THE LIST (#176). This endpoint caps a page at one hundred
 * rows and announces the total of the whole list beside them, and the read was
 * a single `?per_page=100`. On a commit with 101 runs the hundred-and-first was
 * invisible in both directions that matter: a declared check living only there
 * read as "has NO run", and — where an earlier page carried a same-named green
 * row, which re-runs and matrix jobs produce routinely — a pending or failing
 * later run was hidden behind that green one. So the read is PAGINATED, and
 * "complete" is a positive reconciliation rather than the absence of a reason
 * to keep going: a valid announced total, and that many DISTINCT runs observed.
 *
 * DISTINCT BY `id`, because the failure this bound exists for is a page that
 * comes back twice. The stubs of a broken proxy — and `?page=` past the end on
 * some GitHub Enterprise versions — answer page 1 again rather than an empty
 * list, so counting rows would climb to the announced total over one page read
 * repeatedly. A page that adds no new id is an unknown, exactly as a repeated
 * cursor is on the thread read (#175).
 *
 * NOT `gh api --paginate`. It would hide the two things this loop decides on:
 * each page's own `total_count`, which is what a mid-read total change looks
 * like, and WHICH page failed. `--paginate` is the repair a human runs, not the
 * read a gate reconciles.
 *
 * THIS IS NOT AN ATOMIC SNAPSHOT, and nothing here claims one. Runs can be
 * created between the first page and the last; what the gate guarantees is that
 * it read every page the endpoint offered for the validated head SHA and
 * reconciled them against an announced total, never that GitHub stood still
 * while it did. The declared-name policy is untouched: unrelated names gain no
 * authority by appearing on a later page, and a declared name with no run in a
 * COMPLETE read is the same refusal it always was.
 */
export function ciGround({ run, slug, sha, declared, pr }) {
  const out = account();
  const short = sha.slice(0, 12);
  const call = `gh api repos/${slug}/commits/${sha}/check-runs`;
  const names = `gh api --paginate repos/${slug}/commits/${sha}/check-runs --jq '.check_runs[].name'`;
  // The repair every incomplete read prints: every page, with the two fields
  // this loop reconciles.
  const probe = `gh api --paginate repos/${slug}/commits/${sha}/check-runs --jq '{total_count, names: [.check_runs[].name]}'   # read the pages this gate could not, then re-run it`;

  let ciDecided = true;
  /** The total the pages announce, or null while no page has answered one. */
  let announced = null;
  let established = false;
  let pagesRead = 0;
  /** The distinct runs observed, in observation order, and the ids behind them. */
  const runs = [];
  const seen = new Set();
  /** Observed against announced, with "unknown" said as unknown, never as 0. */
  const tally = () => `${runs.length} distinct run(s) observed of ${announced === null ? 'an announced total this run could not read' : `the ${announced} announced`}`;
  const unread = (message, repair = probe) => {
    ciDecided = false;
    out.unknown(message, repair);
  };

  for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
    // The SHA is the one this run validated, on every page: the read never
    // moves to a branch name or to a dashboard that follows the head.
    const query = `repos/${slug}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PAGE}&page=${page}`;
    const answered = payload(run(['api', query]));
    if (!answered.ok) {
      // The repair is THE PAGE THAT FAILED, quoted: an unquoted `&` would
      // background the command a caller pasted, and the whole-list read is
      // the wrong instrument for a call that did not answer.
      unread(`checks: page ${page} of '${call}' ${answered.reason}; ${tally()} on ${short}; CI state unread`, `gh api '${query}'   # the page this read could not get; then re-run the gate`);
      break;
    }
    let rows;
    let total;
    try {
      rows = must(answered.value, 'check_runs', 'the check-runs payload');
      if (!Array.isArray(rows)) throw new Error('the check-runs payload: check_runs is not a list');
      total = answered.value?.total_count;
    } catch (error) {
      unread(`checks: page ${page} — ${error.message}; ${tally()} on ${short}; CI state unread`, call);
      break;
    }
    // A COUNTABLE total, or nothing to reconcile against. `Number.isInteger`
    // is the whole rule: a string, a float and a negative are each a total
    // this read cannot complete on, and defaulting any of them to the rows in
    // hand is F-028 pointed at the merge.
    if (!Number.isInteger(total) || total < 0) {
      unread(
        `checks: page ${page} announces no readable total on ${short} ('total_count' is ${countShape(total)}), so how many check-runs exist there is unknown, not zero`,
      );
      break;
    }
    if (announced === null) announced = total;
    else if (total !== announced) {
      unread(
        `checks: page ${page} announces ${total} check-run(s) on ${short} where page 1 announced ${announced}, so the pages cannot be reconciled and the read is incomplete`,
      );
      break;
    }
    let fresh = 0;
    let unidentified = false;
    for (const row of rows) {
      const id = row === null || typeof row !== 'object' ? undefined : row.id;
      if (typeof id !== 'number' && typeof id !== 'string') {
        unread(
          `checks: page ${page} carries a run with no readable 'id' ('id' is ${shapeOf(id)}), so this read cannot tell a new page from a repeat of one it already observed`,
        );
        unidentified = true;
        break;
      }
      const key = `${typeof id}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      runs.push(row);
      fresh += 1;
    }
    if (unidentified) break;
    pagesRead = page;
    out.note(`checks: page ${page} — ${rows.length} run(s) read, ${runs.length} distinct of ${announced} announced on ${short}`);
    if (runs.length > announced) {
      unread(`checks: the read observed ${runs.length} distinct run(s) on ${short} where ${announced} were announced, so the pages cannot be reconciled`);
      break;
    }
    // A PAGE SHORT OF THE CAP IS THE LAST ONE, and a FULL page is not — the
    // same inference `prCommits` below stands on: a full page is a list this
    // run cannot prove complete. So reaching the announced total on a full
    // page is NOT the end of the read. Where the total is an exact multiple of
    // the page size, stopping there would authorise on a count instead of on
    // an observation, and the page that was never asked for is where a stale
    // or under-announced total shows itself: the next page's rows either
    // exceed the total (inconsistent, below) or repeat the one just read.
    const ended = rows.length < CHECK_RUNS_PAGE;
    if (ended) {
      // The ONE thing that establishes the read: every announced run observed,
      // AND a page the endpoint's own pagination ended on.
      if (runs.length === announced) {
        established = true;
        break;
      }
      unread(
        `checks: page ${page} answered ${rows.length} run(s) and the read stands at ${runs.length} of the ${announced} announced on ${short}, so the endpoint's pagination ended before its own total and the rest are unread`,
      );
      break;
    }
    if (fresh === 0) {
      unread(
        `checks: page ${page} repeats runs this read already observed and adds none, so advancing would re-read it rather than reach the end of the list, and whether ${short} carries further runs is unread (${tally()})`,
      );
      break;
    }
    if (page === MAX_CHECK_PAGES) {
      unread(`checks: pagination exceeded ${MAX_CHECK_PAGES} pages; stopped rather than looping, so the check-run read on ${short} is unestablished (${tally()})`);
    }
  }

  // The receipt's own distinction between a read that RECONCILED and one that
  // merely stopped. The `else` is the structural backstop for that obligation:
  // whatever a later exit path forgets to name, an unreconciled read still
  // fails the gate closed instead of passing on the rows it happened to get.
  if (established) {
    out.note(`checks: ${runs.length} check-run(s) reported on ${short} — the read is complete: every one of the ${announced} announced observed over ${pagesRead} page(s)`);
  } else if (out.unknowns.length === 0) {
    unread(`checks: the check-run read on ${short} ended after ${pagesRead} page(s) with no total it could reconcile, so CI state is unestablished`);
  }

  for (const expected of declared.expected) {
    const rows = runs.filter(row => row?.name === expected);
    if (rows.length === 0) {
      // A check that never ran is not a check that passed. This is the trap
      // the gate exists for: when a guard job fails early, everything
      // downstream never executes.
      //
      // ONLY ON A COMPLETE READ (#176). On an incomplete one the run may sit
      // on a page this gate never got, so absence is unproven — and the
      // unknown above already holds the gate closed. Refusing here would send
      // a worker to fix a check that is green on page 2.
      if (established) {
        out.refuse(
          `checks: expected ${declared.mode} check '${clean(expected)}' has NO run on ${short}`,
          `${names}   # is the name still spelled this way?`,
        );
      }
      continue;
    }
    const pending = rows.find(row => row?.status !== 'completed');
    if (pending) {
      ciDecided = false;
      out.unknown(`checks: '${clean(expected)}' is ${clean(pending.status)} on ${short} — not decided`, 'gh run watch   # then re-run this gate');
      continue;
    }
    for (const row of rows) {
      // `neutral` is neither a success nor a failure, and the old dashboard
      // did not see it at all (F-031). Here it is a refusal like any other
      // non-success. Every row of the name is judged, on whichever page it
      // was observed: a later re-run concluding `failure` refuses even where
      // an earlier page carried a green row of the same name.
      if (row?.conclusion !== 'success') {
        out.refuse(
          `checks: '${clean(expected)}' concluded ${clean(row?.conclusion)} on ${short}`,
          `gh pr checks ${pr} --repo ${slug}   # then fix the job, or re-run it`,
        );
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
 *
 * A SUCCESSFUL RESPONSE IS NOT AN ESTABLISHED READ (#175). Every container
 * this query needs was read by name — F-028's rule, applied down to
 * `reviewThreads` — and then the two fields that decide the verdict were read
 * with an `or`: `nodes` fell back to `[]` and `pageInfo` to `{}`. Three injected
 * shapes — `nodes` absent, `nodes: null`, `nodes` an object — return HTTP 200
 * with all containers present, and the old ground read each as "zero threads
 * on a final page", which is this gate's PASSING answer. That is proved by the
 * red entry-point tests with those payloads, not by live GitHub responses of
 * that form or by three real merges. The same `or` on `pageInfo` made an
 * absent or non-boolean `hasNextPage` end the pagination: `!== true` cannot
 * tell "there is no next page" from "whether there is one was never answered"
 * (the string `'false'` ended the read, same as an absent field).
 *
 * So the end of the list is a POSITIVE observation, tracked in `established`,
 * and it is set by exactly one thing: a page whose `hasNextPage` is the boolean
 * `false`. Every other exit registers an unknown that names the field or the
 * page it could not establish — an unknown fails this gate closed, so an
 * unestablished read is unmergeable-until-read and can never become the
 * complete-empty case that passes.
 *
 * A CURSOR HAS TO ADVANCE. `endCursor` was read with `?? null`, so a page
 * claiming a successor and naming a non-string cursor sent that value straight
 * back into `-f cursor=`; naming the cursor it was ALREADY read with re-read
 * the same page as though it were new, up to the page bound, and every thread
 * past it stayed unread while the receipt showed fifty pages of progress. The
 * cursors handed out are therefore remembered, and a repeat is an unknown.
 */
export function threadsGround({ run, owner, name, pr, sha, ciDecided, invocation }) {
  const out = account();
  if (!ciDecided) {
    out.unknown(`threads: CI is not decided on ${sha} — a thread read now is no observation at all`, `${invocation()}   # once CI has finished`);
    return out;
  }
  // The repair every incomplete read prints: the same query, narrowed to the
  // shape that could not be established. `gh auth status` answers a call that
  // FAILED; a call that answered 200 with a malformed page is diagnosed by
  // looking at the page.
  const probe =
    `gh api graphql -f 'query=query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:50){pageInfo{hasNextPage endCursor} nodes{id isResolved}}}}}'` +
    ` -F owner=${owner} -F name=${name} -F pr=${pr}   # read the shape this gate could not, then re-run the gate`;
  let cursor = null;
  let established = false;
  let observed = 0;
  let pagesRead = 0;
  // The cursors this loop has already been READ WITH, so a page that names one
  // of them is refused instead of re-read.
  const spent = new Set();
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
    // The threads on this page, or the reason there is no list to read. NEVER
    // `[]`: an absent list is unknown, and zero threads is a merge.
    if (!Array.isArray(threads.nodes)) {
      out.unknown(
        `threads: page ${page} answered with no readable 'nodes' list ('nodes' is ${shapeOf(threads.nodes)}) — the threads on that page are unread, not absent`,
        probe,
      );
      break;
    }
    const nodes = threads.nodes;
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
    // Counted before the page's own end is decided: a thread observed on an
    // incompletely paginated read is still an observation, and it stays in the
    // receipt beside the unknown that follows it.
    observed += nodes.length;
    pagesRead = page;
    out.note(`threads: page ${page} — ${nodes.length} thread(s), ${unresolved} unresolved`);
    const info = threads.pageInfo;
    if (info === null || typeof info !== 'object' || Array.isArray(info)) {
      out.unknown(
        `threads: page ${page} answered with no readable 'pageInfo' ('pageInfo' is ${shapeOf(info)}) — whether a further page of threads exists is unread`,
        probe,
      );
      break;
    }
    if (typeof info.hasNextPage !== 'boolean') {
      out.unknown(
        `threads: page ${page} names no boolean 'hasNextPage' ('hasNextPage' is ${shapeOf(info.hasNextPage)}) — the end of the thread list is unestablished`,
        probe,
      );
      break;
    }
    // The ONE thing that establishes the read: the API said there is no next
    // page.
    if (info.hasNextPage === false) {
      established = true;
      break;
    }
    const next = info.endCursor;
    if (typeof next !== 'string' || next === '') {
      out.unknown(
        `threads: page ${page} claims a next one and names no cursor to advance on ('endCursor' is ${shapeOf(next)}), so the remaining threads are unread`,
        probe,
      );
      break;
    }
    if (spent.has(next)) {
      out.unknown(
        `threads: page ${page} claims a next one and repeats the cursor it was read with, so advancing would re-read this same page rather than a new one and the threads past it are unread`,
        probe,
      );
      break;
    }
    spent.add(next);
    cursor = next;
    if (page === MAX_THREAD_PAGES) {
      out.unknown(
        `threads: pagination exceeded ${MAX_THREAD_PAGES} pages; stopped rather than looping, so the end of the thread list is unestablished`,
        probe,
      );
    }
  }
  // The receipt's own distinction between a read that ENDED and one that
  // merely stopped. The `else` is the structural backstop for this obligation:
  // whatever a later exit path forgets to name, an unread end still fails the
  // gate closed instead of passing as the complete-empty case.
  if (established) out.note(`threads: read established — ${observed} thread(s) over ${pagesRead} page(s), the final page was observed`);
  else if (out.unknowns.length === 0) {
    out.unknown(`threads: the thread read ended after ${pagesRead} page(s) without an observed final page, so resolution is unestablished`, probe);
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
 * The most commits one page of the PR commits endpoint answers with — the
 * boundary this run's read cannot see past, not a preference.
 */
const COMMITS_PAGE = 100;

/**
 * EVERY commit on the PR branch, read ONCE per run.
 *
 * Two things stand on this payload: Ground 6's "commits since open" detector,
 * and the closing-construct channel that #86 added — the branch's commit
 * messages, which GitHub acts on at merge time whenever they reach the default
 * branch. The message was always in this payload and was never touched: the
 * gate read `commit.committer.date` and `sha` and nothing else, so a commit
 * whose prose quoted a closing construct naming an unrelated open ticket was
 * one squash away from closing it with no ground able to refuse.
 *
 * A FULL PAGE IS A LIST THIS RUN CANNOT PROVE COMPLETE. The read is one
 * unpaginated page, and GitHub caps this endpoint at 250 commits whatever the
 * page size, so `length === COMMITS_PAGE` is the one honest answer boundary:
 * beyond it the channel is unread, never empty (F-028). The repair is the read
 * a human makes instead, because a gate that silently measured the first
 * hundred messages would be exactly the hole #86 records, one page over.
 */
export function prCommits({ run, slug, pr }) {
  const call = `gh api repos/${slug}/pulls/${pr}/commits`;
  const got = payload(run(['api', `repos/${slug}/pulls/${pr}/commits?per_page=100`]));
  if (!got.ok) return { ok: false, reason: `'${call}' ${got.reason}`, repair: call };
  try {
    const rows = got.value;
    if (!Array.isArray(rows)) throw new Error('the PR commits payload is not a list');
    if (rows.length >= COMMITS_PAGE) {
      return {
        ok: false,
        reason: `'${call}' answered a full page of ${rows.length} commit(s), so this run cannot prove the list complete`,
        repair: `gh api --paginate repos/${slug}/pulls/${pr}/commits --jq '.[].commit.message'   # read every message, then merge by hand: gh pr merge ${pr} --repo ${slug}`,
      };
    }
    const commits = rows.map(entry => {
      // Named keys throughout (F-028).
      const commit = must(entry, 'commit', 'a PR commit');
      const when = Date.parse(must(must(commit, 'committer', 'commit'), 'date', 'committer'));
      if (Number.isNaN(when)) throw new Error('a PR commit carries a committer date that is not a date');
      // The PARENTS are the third thing standing on this payload (#90): Ground
      // 6's shape rule asks how many a post-open commit has and which one the
      // base reaches, and this endpoint has always carried them. Read by name
      // like every other field — an absent list is an unread shape, never a
      // commit with no parents, and defaulting it to `[]` would make every
      // commit read as a non-merge and quietly disable the rule.
      const parents = must(entry, 'parents', 'a PR commit');
      if (!Array.isArray(parents)) throw new Error("a PR commit's 'parents' is not a list");
      return {
        sha: String(must(entry, 'sha', 'a PR commit')),
        message: String(must(commit, 'message', 'commit')),
        when,
        parents: parents.map(parent => String(must(parent, 'sha', "a PR commit's parent"))),
        // THE ACCOUNT GITHUB NAMED for this commit, which is what the release
        // exemption stands on (#94). Deliberately NOT `must`: this endpoint
        // answers `author: null` for a commit whose email matches no account,
        // and that is an ANSWER, not a missing key. An unnamed account
        // withholds the exemption and can never grant it, so an absence here
        // fails closed by construction — the one direction F-028 leaves open.
        authorLogin: typeof entry.author?.login === 'string' ? entry.author.login : '',
      };
    });
    return { ok: true, commits };
  } catch (error) {
    return { ok: false, reason: error.message, repair: call };
  }
}

/**
 * The repository's MERGE-MESSAGE POLICY: which texts a merge here will put on
 * the default branch, and by which methods it is allowed to do it.
 *
 * ONE `gh api repos/<slug>` read answers all of it. It cannot ride on the
 * `gh repo view <slug> --json defaultBranchRef` call the gate already makes:
 * `gh repo view --json` has no `squashMergeCommitMessage` field and errors with
 * `Unknown JSON field` (verified 2026-09-02).
 *
 * FOUR SETTINGS, not one. The squash pair decides the squash commit's message
 * and its SUBJECT; the merge pair decides the merge commit's. A subject is
 * always written and always comes from somewhere — the pull request title, or a
 * single commit's own subject — which is why there is no configuration where
 * the body is the only text that lands (#86, Codex P1 on PR #114).
 *
 * An absent field RAISES rather than defaulting, and so does a value this
 * predicate cannot place. "This repository probably builds its merge message
 * from the pull request body" is the assumption that left the channel unread in
 * the first place; a spelling nobody has taught this code is the same unknown
 * arriving as a string instead of as an absence (F-028).
 */
const POLICY_VALUES = {
  squash_merge_commit_message: ['PR_BODY', 'COMMIT_MESSAGES', 'BLANK'],
  squash_merge_commit_title: ['PR_TITLE', 'COMMIT_OR_PR_TITLE'],
  merge_commit_title: ['PR_TITLE', 'MERGE_MESSAGE'],
  merge_commit_message: ['PR_BODY', 'PR_TITLE', 'BLANK'],
};

export function mergePolicy({ run, slug }) {
  const call = `gh api repos/${slug}`;
  const repair = `${call} --jq '{${Object.keys(POLICY_VALUES).join(',')},allow_squash_merge,allow_merge_commit,allow_rebase_merge}'`;
  const got = payload(run(['api', `repos/${slug}`]));
  if (!got.ok) return { ok: false, reason: `'${call}' ${got.reason}`, repair };
  try {
    const where = `the repository payload for ${slug}`;
    const setting = key => {
      const value = String(must(got.value, key, where)).trim().toUpperCase();
      if (!POLICY_VALUES[key].includes(value)) {
        throw new Error(`${where}: '${key}' names '${clean(value)}', which this gate cannot place, so which text reaches the default branch is undecided`);
      }
      return value;
    };
    const squashMessage = setting('squash_merge_commit_message');
    const squashTitle = setting('squash_merge_commit_title');
    const mergeTitle = setting('merge_commit_title');
    const mergeMessage = setting('merge_commit_message');
    const allowed = ['squash', 'merge', 'rebase'].filter(
      method => must(got.value, `allow_${method === 'merge' ? 'merge_commit' : `${method}_merge`}`, where) === true,
    );
    if (allowed.length === 0) throw new Error(`${where} names no allowed merge method`);
    return { ok: true, squashMessage, squashTitle, mergeTitle, mergeMessage, allowed };
  } catch (error) {
    return { ok: false, reason: error.message, repair };
  }
}

/**
 * Ground 6. The commits made since the PR opened.
 *
 * A DETECTOR: a PR body's staleness is not mechanically decidable, so the gate
 * lists the commits and refuses until the caller acknowledges the list with
 * `--ack-body` (KTD9).
 *
 * The payload arrives already read (`prCommits`): this ground and the closing
 * channel stand on ONE fetch, and each names its own inability over it rather
 * than sharing one sentence about two different questions.
 *
 * ONE SHAPE IS EXEMPT, AND IT IS EXEMPT BY MEASUREMENT: a clean merge FROM the
 * base. #90 measured the cost of not having it — the gate's own staleness
 * self-repair ran `gh pr update-branch`, the merge that produced was committed
 * after the PR opened, and this ground then listed and refused that very
 * commit, printing an `--ack-body` repair the caller could not have satisfied
 * because the commit did not exist when they typed the command. The merge of
 * #87 went to a worker for a body edit whose only content was the gate's own
 * footprint.
 *
 * KTD9's premise is what fails there, not KTD9: a body written before a commit
 * existed cannot describe it, and base movement is not work the body was ever
 * meant to describe. So the exemption is not a suppressor anyone can pass — it
 * is a PREDICATE ON THE COMMIT, all three parts read, none assumed:
 *
 *   1. exactly two parents,
 *   2. the second one reachable from the base ref, and
 *   3. its tree IDENTICAL to the tree an ordinary merge of its two parents
 *      produces (`git merge-tree --write-tree`) — it is exactly what
 *      `git merge origin/<base>` would have written, and nothing else.
 *
 * Re-derived on every run and remembered nowhere, so it holds identically in
 * the process that minted the commit, in the owning worker's fresh gate run,
 * and in a resumed merge; a worker's own clean `git merge origin/<base>` is the
 * same shape and gets the same answer.
 *
 * PART 3 IS THE WHOLE ANTI-SMUGGLING GUARANTEE, and its first form was not one.
 * `git diff-tree --cc` EMPTY looked like "carries nothing of its own" and is
 * not: `--cc` drops hunks whose result matches a parent wholesale, so
 * `git merge -X ours <base>` — two parents, second reachable, the base's change
 * to a file silently DROPPED — printed an empty `--cc` and read as exempt
 * (measured 2026-09-03 in a repository built for it, after a Codex P1 on PR
 * #119). The lesson generalises: a diff FILTERED for human interest cannot
 * answer a question about content, and an inspection of a result is weaker than
 * a recomputation of it. Asking whether the tree IS the merge admits nothing —
 * a conflict resolution, an evil merge, a restored file, a dropped upstream
 * change all move the tree off the recomputed one, so all four are work,
 * refuse, and are named as such.
 *
 * THE READS ARE READS — a base ref this checkout cannot resolve, a
 * `merge-tree` that cannot answer, or a tree that cannot be resolved leaves the
 * shape undecided, and undecided is not exempt (F-028). An undecided shape is
 * this module's `unknown` — CANNOT ESTABLISH, exit 3 — and never a refusal.
 * Both fail closed, and the first version's refusal even carried the right
 * repair — the fetch. What it got wrong was the SENTENCE and the exit code: it
 * told the caller a transient git failure was a named, established reason to
 * refuse, on exit 1, where every other unreadable git read in this file answers
 * `unknown` on exit 3. Downstream tooling routes on that code.
 *
 * Each undecided shape carries its OWN repair, because "re-run the read" is not
 * one for all of them: `merge-tree --write-tree` arrived in git 2.38, so an
 * older git answers 129, and a repair naming a fetch there would fail
 * identically forever — no fetch adds a capability. That one names the version.
 *
 * The rejected alternative, named so it is not re-invented: having the
 * self-repair append `--ack-body` to its own re-run. That suppresses the
 * detector for EVERY post-open commit, including the caller-authored ones the
 * body genuinely fails to describe — a one-commit exemption turned into a
 * blanket bypass of the ground.
 *
 * A SECOND SHAPE IS EXEMPT, AND ALSO BY PREDICATE: on a release pull request
 * (#94), THE RELEASE COMMIT. release-please pushes the version bump after
 * opening its own PR — measured on #68, `634d59af7c38` landed after the PR
 * opened — so the detector listed and refused it, and the report's own
 * diagnosis called that refusal expected. Two halves, both read: the account
 * GitHub named for the commit is the release shape's author, AND its subject is
 * a release commit (`chore: release <version>`, with release-please's optional
 * scope and component).
 *
 * THE IDENTITY ALONE WAS REJECTED, and the reason is who holds it: the release
 * App's token is reachable by every workflow this repository grants it to, so
 * "authored by the bot" exempts commits release-please never wrote. The ruling
 * says the detector accepts the bump; a second bot commit doing something else
 * is any other post-open commit.
 *
 * The subject IS configurable prose, which is the cost this direction pays: a
 * project that retemplates its release commit gets a refusal, with `--ack-body`
 * to answer it. That asymmetry is deliberate — a refusal here is recoverable
 * with one flag, while the keyword refusal this ticket removed had no flag at
 * all, and a false EXEMPTION is a hole in a ground nobody can see.
 *
 * Every other post-open commit on a release branch refuses without
 * `--ack-body`: a hand edit pushed to the release branch is work no body
 * written before it describes, exactly as it is anywhere else.
 */
export function commitsGround({ commits, git, root, baseBranch, headBranch, refsRefreshed, slug, pr, openedAt, ackBody, invocation, release }) {
  const out = account();
  if (!commits.ok) {
    out.unknown(`commits since open: ${commits.reason}`, commits.repair);
    return out;
  }
  // The FULL sha rides each row — the shape is measured against the commit
  // graph, which a 12-character prefix cannot address — and the prefix is
  // derived where it is printed.
  const late = commits.commits.filter(entry => entry.when > openedAt);
  const short = sha => String(sha).slice(0, 12);
  const ackRepair = `gh pr view ${pr} --repo ${slug} --json body   # re-read the body against them, then: ${invocation('--ack-body')}`;
  if (late.length === 0) {
    out.note('commits since open: none — the body describes every commit on the branch');
    return out;
  }
  if (ackBody) {
    // The caller answered for the whole list, so nothing here refuses and no
    // shape needs measuring: a git read whose failure could only produce a
    // refusal on an already-acknowledged run is a read this ground must not
    // make.
    out.note(`commits since open: ${late.length} acknowledged via --ack-body (${late.map(entry => short(entry.sha)).join(' ')})`);
    return out;
  }

  // The release commit, split off BEFORE any git read: a version bump asks no
  // question of the commit graph, and a release PR whose only post-open commit
  // is that bump costs this ground nothing (#94). Both halves read — the
  // account, and the subject release-please writes.
  const isBump = entry => release?.ok === true && sameLogin(entry.authorLogin, release.author) && RELEASE_SUBJECT.test(firstLine(entry.message));
  const bumps = late.filter(isBump);
  const authored = bumps.length === 0 ? late : late.filter(entry => !isBump(entry));

  const gitRun = args => git(args, root);
  // Resolved ONCE, and only because a two-parent commit is asking: a PR with no
  // post-open merge costs this ground no git read at all.
  const merges = authored.filter(entry => entry.parents.length === 2);
  const baseRef = merges.length === 0 || !refsRefreshed ? '' : resolveRef(gitRun, baseBranch);
  // An undecided shape carries its OWN repair. Most of them are a read to
  // retry, so the fetch is the default; a git that does not have the read at
  // all is a different repair, and handing it a fetch would loop forever on a
  // capability no fetch can add (#119 P2).
  const fetchRepair = `git fetch origin ${baseBranch} ${headBranch}   # then: ${invocation()}`;
  const undecided = (reason, repair = fetchRepair) => ({ kind: 'undecided', reason, repair });
  const shapeOf = entry => {
    if (baseRef === '') {
      return undecided(
        refsRefreshed
          ? `'${baseBranch}' cannot be read here, so whether its second parent is base movement is unmeasurable`
          : `the refs could not be refreshed, so '${baseBranch}' cannot be read here and whether its second parent is base movement is unmeasurable`,
      );
    }
    const second = entry.parents[1];
    const reaches = gitRun(['merge-base', '--is-ancestor', second, baseRef]);
    // git answers this question with 1, and everything else — a missing object
    // above all — with a failure that is not an answer.
    if (!succeeded(reaches) && reaches.status !== 1) {
      return undecided(`'git merge-base --is-ancestor ${short(second)} ${baseRef}' could not answer (${clean(firstLine(reaches.stderr)) || `exit ${reaches.status}`})`);
    }
    if (!succeeded(reaches)) return { kind: 'work', why: `is a merge of ${short(second)}, which ${baseRef} does not reach — another branch merged in is work, not base movement` };
    // THE MERGE IS RECOMPUTED AND THE TREES COMPARED, never inspected for
    // "interesting" hunks. `git diff-tree --cc` was the first predicate here
    // and it is not one: `--cc` drops hunks where the result matches a parent
    // wholesale, so `git merge -X ours <base>` — two parents, second reachable,
    // and the base's change to a file silently DROPPED — prints an empty `--cc`
    // and read as exempt (measured 2026-09-03 on PR #119, Codex P1). That is
    // caller-authored content passing the detector, which is the one thing this
    // exemption must never do.
    //
    // So the question is asked positively: is this commit's tree EXACTLY what
    // an ordinary merge of its two parents produces? `--write-tree` needs git
    // 2.38 and writes an unreferenced tree object; an older git answers 129 and
    // becomes undecided, which fails closed.
    const recomputed = gitRun(['merge-tree', '--write-tree', entry.parents[0], second]);
    // Exit 1 is BOTH "the ordinary merge conflicts" and "an object is missing",
    // so the tree id on stdout is what separates them: a conflicted merge still
    // writes one, a failed read writes nothing.
    const wrote = firstLine(recomputed.stdout);
    if (!/^[0-9a-f]{40,64}$/.test(wrote)) {
      // git's usage exit. `--write-tree` arrived in git 2.38, and a fetch
      // cannot add it: naming one here would print a repair that fails
      // identically forever (#119 P2).
      if (recomputed.status === 129) {
        return undecided(
          `'git merge-tree --write-tree' is not available here (${clean(firstLine(recomputed.stderr)) || 'exit 129'}), so what an ordinary merge of its parents produces cannot be recomputed`,
          `git --version   # 'merge-tree --write-tree' needs git 2.38 or newer; upgrade git, then: ${invocation()}`,
        );
      }
      return undecided(`'git merge-tree --write-tree ${short(entry.parents[0])} ${short(second)}' could not answer (${clean(firstLine(recomputed.stderr)) || `exit ${recomputed.status}`})`);
    }
    if (!succeeded(recomputed)) {
      return { kind: 'work', why: `merges ${baseRef} and an ordinary merge of its parents CONFLICTS, so the content it carries is a resolution someone authored, not base movement` };
    }
    const tree = gitRun(['rev-parse', `${entry.sha}^{tree}`]);
    if (!succeeded(tree)) return undecided(`'git rev-parse ${short(entry.sha)}^{tree}' could not answer (${clean(firstLine(tree.stderr)) || `exit ${tree.status}`})`);
    if (firstLine(tree.stdout) !== wrote) {
      return {
        kind: 'work',
        why: `merges ${baseRef} but its tree is not the one an ordinary merge of its parents produces (${short(firstLine(tree.stdout))} against ${short(wrote)}), so it carries a decision someone made — dropped, restored or added content — not base movement`,
      };
    }
    return { kind: 'exempt' };
  };

  const exempt = [];
  const plain = [];
  for (const entry of authored) {
    if (entry.parents.length !== 2) {
      plain.push(entry);
      continue;
    }
    const shape = shapeOf(entry);
    if (shape.kind === 'exempt') exempt.push(entry);
    else if (shape.kind === 'work') {
      out.refuse(`commits since open [DETECTOR]: ${short(entry.sha)} ${shape.why}`, ackRepair);
    } else {
      // A READ THAT FAILED IS THIS MODULE'S `unknown`, not a refusal: it fails
      // closed either way (exit 3 merges nothing), but calling it a refusal
      // tells the caller a transient git failure is an established, named
      // reason on exit 1 — where every other unreadable git read in this file
      // answers `unknown` on exit 3, and downstream tooling routes on the code
      // (#119 P2). The repair was already the fetch; only the channel was wrong.
      out.unknown(
        `commits since open: ${short(entry.sha)} landed after the PR opened and ${shape.reason}, so whether it is base movement or work is undecided — unknown is not exempt (F-028)`,
        shape.repair,
      );
    }
  }
  if (bumps.length > 0) {
    out.note(
      `commits since open: ${bumps.length} release commit${bumps.length === 1 ? '' : 's'} — exempt: ${bumps.map(entry => short(entry.sha)).join(' ')} ` +
        `(authored by ${clean(release.author)} on a '${clean(release.label)}' pull request: the version bump release-please writes after opening its own PR, which no body written before it could describe)`,
    );
  }
  if (exempt.length > 0) {
    out.note(
      `commits since open: ${exempt.length} base merge${exempt.length === 1 ? '' : 's'} — exempt: ${exempt.map(entry => short(entry.sha)).join(' ')} ` +
        `(clean merge of ${baseRef}: two parents, the second one the base reaches, and a tree identical to the one an ordinary merge of those parents produces — base movement, which no body written before it could describe)`,
    );
  }
  if (plain.length > 0) {
    out.refuse(
      `commits since open [DETECTOR]: ${plain.length} commit(s) landed after the PR was opened (${plain.map(entry => short(entry.sha)).join(' ')})`,
      ackRepair,
    );
  }
  return out;
}

/**
 * THE TEXTS A MERGE OF THIS PR PUTS ON THE DEFAULT BRANCH, beside the body.
 *
 * #86: GitHub acts on every closing construct in the text that lands, and the
 * pull request body is only one of the texts that get there. Which others do is
 * a property of the repository and of the METHOD, never of the PR:
 *
 *   - `merge` and `rebase` land every commit on the default branch verbatim, so
 *     the messages arrive whatever the squash settings say. GitHub's own
 *     documentation is explicit: a closing keyword in a commit message closes
 *     its issue once that commit is merged into the default branch.
 *   - `squash` writes ONE commit, and the two squash settings decide its two
 *     halves. `squash_merge_commit_message=COMMIT_MESSAGES` makes the message
 *     the concatenated commit messages. The SUBJECT is always written and
 *     always comes from somewhere: `PR_TITLE` takes the pull request title,
 *     `COMMIT_OR_PR_TITLE` takes the single commit's subject when the branch
 *     has exactly one and the pull request TITLE otherwise.
 *   - a `merge` commit's own halves come from `merge_commit_title` and
 *     `merge_commit_message`, either of which may be `PR_TITLE`.
 *
 * SO THE TITLE IS A CHANNEL (Codex P1 on PR #114). It does not close as a
 * "pull request title" — GitHub's linking mechanism reads the body and commit
 * messages — it closes because policy makes it the SUBJECT of the commit that
 * lands on the default branch. Reading only the message settings called that
 * case inert and left `Fixes #11` in a title free to close an unrelated ticket
 * while Ground 9 approved the body's bound construct. There is consequently no
 * configuration under which the body is the only channel.
 *
 * THE METHODS THE VERDICT STANDS ON ARE THE ONES THIS RUN CAN CAUSE. A merging
 * run mutates with exactly one method — `--method`, or the `squash` default —
 * so it evaluates that method alone; widening there refuses a merge over text
 * that cannot reach the commit the run is about to write (Codex P1 on PR #114).
 * A DETECTOR run causes nothing and names no method, so it fails closed over
 * every method the repository ALLOWS: on a repository that allows merge or
 * rebase, assuming squash would be a false negative by construction. Either
 * way the note says which methods it evaluated.
 */
export function closingChannels({ policy, commits, title, method, methodGiven, merging = false }) {
  const out = account();
  out.channels = [];
  if (!policy.ok) {
    out.unknown(
      `closing channels: ${policy.reason} — which texts reach the default branch is unread, and an unread policy is not "the body is the only channel" (F-028)`,
      policy.repair,
    );
    return out;
  }
  // A merging run stands on the method it will issue; a detector run has none
  // to stand on and answers for every method that could be issued.
  const decided = methodGiven || merging;
  const methods = decided ? [method] : policy.allowed;
  const evaluated = `methods evaluated: ${methods.join(', ')}${decided ? '' : ' (no --method given, so every method this repository allows)'}`;
  const squash = methods.includes('squash');
  const verbatim = methods.filter(one => one === 'merge' || one === 'rebase');

  // Every commit message lands, and the commit COUNT decides which text fills a
  // COMMIT_OR_PR_TITLE subject. Those are the only two questions the commit list
  // answers, and where neither is asked an unread list decides nothing.
  const everyMessage = verbatim.length > 0 || (squash && policy.squashMessage === 'COMMIT_MESSAGES');
  const countDecides = squash && policy.squashTitle === 'COMMIT_OR_PR_TITLE';
  if ((everyMessage || countDecides) && !commits.ok) {
    out.unknown(
      `closing channels: ${commits.reason} — this branch's commit messages decide what a merge here lands, so the closing constructs in them are unread (${evaluated})`,
      commits.repair,
    );
    return out;
  }

  const rows = commits.ok ? commits.commits : [];
  const because = [];
  const channels = [];

  // The pull request title, wherever policy makes it the subject that lands.
  let titled = false;
  if (squash && policy.squashTitle === 'PR_TITLE') {
    titled = true;
    because.push('squash takes the merge subject from the pull request title (squash_merge_commit_title=PR_TITLE)');
  }
  if (countDecides && rows.length !== 1) {
    titled = true;
    because.push(`squash takes the merge subject from the pull request title, because this branch has ${rows.length} commits (squash_merge_commit_title=COMMIT_OR_PR_TITLE)`);
  }
  if (methods.includes('merge')) {
    if (policy.mergeTitle === 'PR_TITLE') {
      titled = true;
      because.push('the merge commit takes its subject from the pull request title (merge_commit_title=PR_TITLE)');
    }
    if (policy.mergeMessage === 'PR_TITLE') {
      titled = true;
      because.push('the merge commit takes its message from the pull request title (merge_commit_message=PR_TITLE)');
    }
  }
  if (titled) channels.push({ kind: 'title', label: 'the PR title', text: String(title ?? ''), sha: '' });

  if (everyMessage) {
    for (const one of verbatim) because.push(`the ${one} method lands every commit on the default branch verbatim`);
    if (squash && policy.squashMessage === 'COMMIT_MESSAGES') {
      because.push('squash builds the merge message from the commit messages (squash_merge_commit_message=COMMIT_MESSAGES)');
    }
    for (const entry of rows) {
      const short = entry.sha.slice(0, 12);
      channels.push({ kind: 'commit', label: `commit ${short}`, text: entry.message, sha: short });
    }
  } else if (countDecides && rows.length === 1) {
    const short = rows[0].sha.slice(0, 12);
    channels.push({ kind: 'commit', label: `commit ${short}`, text: firstLine(rows[0].message), sha: short });
    because.push("squash takes the merge subject from the single commit's subject (squash_merge_commit_title=COMMIT_OR_PR_TITLE)");
  }

  // Reachable on a PR whose commit list came back empty under a method that
  // lands messages and writes no title: nothing beside the body then lands.
  if (channels.length === 0) return out;
  out.channels = channels;
  const commitCount = channels.filter(channel => channel.kind === 'commit').length;
  const described = [
    ...(titled ? ['the PR title'] : []),
    ...(everyMessage ? [`${commitCount} commit message(s) on this branch`] : commitCount === 1 ? [`the subject of ${channels[channels.length - 1].label}`] : []),
  ].join(' and ');
  out.note(`closing channels: the body, plus ${described} — ${because.join('; ')}; ${evaluated}`);
  return out;
}

/**
 * The channels BESIDE the body, named the way a repair has to name them: the
 * PR title, or a short sha an operator can `git rebase -i`. Past three, the
 * list stops being a thing anyone reads and the count is the useful fact.
 */
const restOf = channels => {
  const rest = (channels ?? []).filter(channel => channel.kind !== 'body');
  if (rest.length === 0) return '';
  if (rest.length > 3) return `the ${rest.length} other texts this merge lands`;
  return rest.map(channel => channel.label).join(', ');
};

/**
 * THE COMMAND THAT EDITS THE CHANNEL A CONSTRUCT ACTUALLY LIVES IN. A repair
 * pointing at the description while the construct sits in a commit message or a
 * title is a repair that cannot work, and the whole point of naming the channel
 * is that the author can go and fix the right text.
 */
const editChannel = (source, pr, slug) =>
  source.kind === 'commit'
    ? `git rebase -i ${source.sha}^`
    : source.kind === 'title'
      ? `gh pr edit ${pr} --repo ${slug} --title '<subject>'`
      : `gh pr edit ${pr} --repo ${slug} --body-file -`;

/**
 * The first closing construct one of these channels carries, and WHERE. Only
 * the matched phrase travels out: the surrounding prose is contributor-authored
 * text, and a commit message is no more quotable in a decision channel than a
 * review body is (F-018's rule, R11's reason).
 */
const firstIn = (channels, verbs) => {
  const pattern = new RegExp(`\\b(?:${verbs})\\b\\s*:?\\s+${TARGET}`, 'i');
  for (const channel of channels ?? []) {
    const found = pattern.exec(String(channel.text ?? ''));
    if (found) return { channel, phrase: found[0].trim(), where: channel.kind === 'body' ? '' : ` in ${channel.label}` };
  }
  return null;
};

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
 * the caller is not asking (the ground answers on the channels alone); with
 * one, the ground is unread and says so — an absent default branch is not a
 * match (F-028).
 *
 * IT READS A CHANNEL SET, NOT A BODY (#86). Every text a merge of this PR puts
 * on the default branch is a place GitHub finds a closing construct: the body,
 * plus the branch's commit messages wherever `closingChannels` establishes they
 * arrive. A construct in a commit message therefore COUNTS AS CLOSING INTENT —
 * refusing to read it while GitHub acts on it printed "the body closes no
 * issue" about a merge that closes one, which is the false sentence this ground
 * exists to remove, arriving from the other channel. A match away from the body
 * names the commit that carries it, because that is where the repair happens.
 *
 * ONE SHAPE IS EXEMPT (#94): the release pull request. Its body is a changelog,
 * it names no ticket and never will, so both readings the refusal above hands
 * to a human — "no ticket behind it" and "an author who forgot" — are decided
 * in advance by the shape itself. That refusal made every release-please PR
 * structurally unmergeable through this gate, which is what `test.yml`'s header
 * says the release path must not be. The ground still ANSWERS on that shape,
 * with the reason, because an exemption nobody can read in the report is
 * indistinguishable from a ground that quietly passed; and a construct the
 * changelog does carry is still named, because GitHub acts on it and saying "no
 * ticket by construction" alone would be a false sentence about that body — the
 * species this ground exists to remove.
 */
export function keywordGround({ channels, tracker, pr, slug, baseBranch = '', defaultBranch = '', release }) {
  const out = account();
  // The shape answers before anything else this ground asks. Base inertness is
  // not asked either: there is no ticket to be inert about, and a release PR
  // that targets something other than the default branch closes nothing
  // whichever way this ground answers.
  if (release?.ok) {
    const carried = firstIn(channels, KEYWORDS);
    out.note(
      `closing keyword: release PR — no ticket by construction (${release.why}); its body is a changelog${
        carried ? `, and '${clean(carried.phrase)}'${carried.where} is recognised — GitHub will close that issue on merge` : ' and names no ticket'
      }`,
    );
    return out;
  }
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
  // The first construct GitHub would act on, in whichever channel carries it.
  // The body is channel 0, so a body that closes something still answers this
  // ground the way it always did.
  const matched = firstIn(channels, KEYWORDS);
  const intended = firstIn(channels, INTENT);
  if (matched) {
    out.note(
      inert
        ? `closing keyword: '${clean(matched.phrase)}'${matched.where} — recognised, but inert on this base (see the refusal below)`
        : `closing keyword: '${clean(matched.phrase)}'${matched.where} — GitHub will close the issue`,
    );
    return out;
  }
  if (intended) {
    out.refuse(
      `closing keyword: '${clean(intended.phrase)}'${intended.where} closes nothing — GitHub acts only on Closes / Fixes / Resolves and their documented variants (F-018)`,
      intended.channel.kind === 'body'
        ? `gh pr edit ${pr} --repo ${slug}   # rewrite it as "Closes #N"`
        : `${editChannel(intended.channel, pr, slug)}   # rewrite it as "Closes #N"${intended.channel.kind === 'commit' ? ', force-push' : ''}, then re-run`,
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
  let refWhere = '';
  if (declaredTracker) {
    try {
      // The ref that FOLLOWS a closing verb, before any other mention. A body
      // legitimately cites sibling tickets for context — measured on gapila
      // #1959, whose first tracker match was `GAP-377` (background) while the
      // body's actual subject, ten paragraphs down, was `Fixes GAP-379`.
      // Naming the wrong ticket in a merge verdict is the same species this
      // key was added to remove, one field over.
      const verbed = new RegExp(`\\b(?:${INTENT})\\b\\s*:?\\s+(${declaredTracker.pattern})`, 'i');
      const bare = new RegExp(declaredTracker.pattern);
      for (const channel of channels) {
        const text = String(channel.text ?? '');
        const afterVerb = verbed.exec(text);
        const found = afterVerb ? bare.exec(afterVerb[0]) : bare.exec(text);
        if (found) {
          ref = found;
          refWhere = channel.sha === '' ? 'the body' : channel.label;
          break;
        }
      }
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
      `closing keyword: no GitHub keyword, but ${refWhere} names ${clean(declaredTracker.name)} '${clean(ref[0])}' — GitHub closes nothing there, so that ticket moves by hand`,
    );
  } else {
    // Genuinely nothing — and under R8 that is where the loop breaks, not a
    // detector line. "Absent by mistake" and "absent by design" are still
    // undecidable from the text (the reading that made this a note), so the
    // refusal names both readings and hands the choice to a human: name the
    // ticket, or merge by hand. Same family as the residual ground (F-039).
    //
    // The sentence names every channel it read: "the body closes no issue" is
    // FALSE about a repository whose merge message is built from the commit
    // messages, and a false absence is what #86 removed from the other half of
    // this ground.
    const rest = restOf(channels);
    out.refuse(
      rest === ''
        ? 'closing keyword: the body closes no issue and expresses no intent to. That is a PR with no ticket behind it, or an author who forgot — no reading of the body separates them, and the frontier re-derives from issue state, so an unclosed delivered ticket stalls its subgraph'
        : `closing keyword: neither the body nor ${rest} closes an issue or expresses intent to. That is a PR with no ticket behind it, or an author who forgot — no reading of them separates the two, and the frontier re-derives from issue state, so an unclosed delivered ticket stalls its subgraph`,
      `gh pr edit ${pr} --repo ${slug} --body-file -   # add "Closes #N", or merge this one by hand if no ticket is behind it`,
    );
  }
  return out;
}

/**
 * EVERY issue a merged PR will close in THIS repository, ascending, and the
 * CHANNEL that named each one.
 *
 * GitHub acts on every recognised construct in the text it lands, not on the
 * first one: `Closes #999` followed by `Closes #1786` closes both. Reading only
 * the first made Ground 9 refuse a body that does close the dispatched ticket —
 * a round-trip charged for a merge that was correct (PR #77 review, P2). A
 * comma-separated tail is NOT a second construct: GitHub wants the keyword
 * before each reference, so `Closes #1, #2` closes #1 alone, and this regex
 * says the same.
 *
 * IT TAKES A CHANNEL SET (#86), not a body: on a repository whose merge message
 * is built from the commit messages, those messages close issues too, and one
 * derivation over every channel is what keeps the pre-merge verdict and the
 * post-merge closure sentence from disagreeing about the same merge. A ticket
 * named in two channels collapses to ONE entry carrying both sources — the
 * union is deduplicated, and a repair has to know where to act.
 *
 * Only bare `#N` is collected. A qualified `owner/repo#N` or a full URL is a
 * real closing target too, but it closes in ANOTHER repository — the caller
 * verifying closure has nothing to poll here, so leaving it out is what sends
 * that caller to the "moves by hand" note instead of polling the wrong tracker.
 * That holds in a commit message exactly as it holds in the body.
 */
export function closedIssuesOf(channels) {
  const found = new Map();
  for (const channel of channels ?? []) {
    for (const matched of String(channel.text ?? '').matchAll(new RegExp(`\\b(?:${KEYWORDS})\\b\\s*:?\\s+(${TARGET})`, 'gi'))) {
      const bare = /^#(\d+)$/.exec(matched[1]);
      if (!bare) continue;
      const issue = Number(bare[1]);
      const sources = found.get(issue) ?? [];
      if (!sources.some(source => source.label === channel.label)) sources.push({ kind: channel.kind, label: channel.label, sha: channel.sha ?? '' });
      found.set(issue, sources);
    }
  }
  return [...found.entries()].map(([issue, sources]) => ({ issue, sources })).sort((left, right) => left.issue - right.issue);
}

/** The channels that named one ticket, as a repair has to read them. */
const sourcesOf = entry => {
  const labels = entry.sources.map(source => source.label);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};

/** "the body closes #7", "commit a1b2c3d4e5f6 closes #7" — provenance and all. */
const closureOf = entry => `${sourcesOf(entry)} closes #${entry.issue}`;

/**
 * Ground 9. The closure this merge is verified against is the ticket that was
 * DISPATCHED, not the one the PR happens to name.
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
 *    number. Sibling closures the BODY declares are named, never refused — a
 *    body may deliver more than one ticket, and GitHub closes every construct
 *    it recognises (PR #77 review, P2).
 *  - the set is non-empty and does NOT contain it: a REFUSAL, so it lands
 *    before the mutation rather than after it, where a merged PR cannot be
 *    un-merged.
 *  - bound with nothing closing in this repository: also a refusal — the
 *    dispatched ticket would stay open, which is the same stall by omission.
 *  - unbound while the PR DOES close a ticket here: an inability to
 *    establish, never a pass. That is F-001's rule applied to a read: an
 *    absent record is unknown, and unknown must not become "the body must be
 *    right". A caller who knows better says so with `--issue`.
 *
 * A PR that closes nothing here AND no binding is not this ground's business:
 * nothing closes, nothing was claimed, and Ground 7 already owns whether that
 * PR may merge at all.
 *
 * AN UNDECLARED CLOSURE REFUSES (#86). The set now spans the commit messages
 * and the pull request title too, and a construct that lives ONLY there names a
 * ticket no reviewer of this description ever saw — the #67 incident exactly:
 * explanatory prose quoted a closing keyword for an unrelated open ticket, and
 * the squash merge message would have closed it. So a same-repository ticket
 * other than the bound one is refused when THE BODY does not declare it, and
 * named when it does. The distinction is not politeness: the body is the text a
 * review reads as the statement of what this merge delivers, and the repair for
 * every other channel is a reword of that channel, not a description edit.
 *
 * THIS GROUND IS NOT RUN ON A RELEASE PR (#94), and says so rather than
 * passing. A release has no dispatched ticket: no `--issue` names one and no
 * dispatch record claims a release branch, so the comparison this ground makes
 * has no left-hand side. Running it anyway is not neutral — it takes its
 * "unbound while the body DOES close a ticket here" branch and answers CANNOT
 * ESTABLISH, which is the exit-3 verdict a parse repair alone would have moved
 * PR #68 to. Printing NOT RUN keeps the report honest in the direction that
 * matters: an unrun check is never a passed one, and a reader of this verdict
 * must not believe a binding was verified.
 */
export function ticketGround({ binding, closes, channels, pr, slug, release }) {
  const out = account();
  if (release?.ok) {
    out.note(
      `ticket binding: NOT RUN — release PR (${release.why}): no dispatch record binds a ticket to a release branch and a changelog names none, so this ground has nothing to compare${
        closes.length === 0 ? '' : `, though this merge closes ${closes.map(entry => `#${entry.issue}`).join(', ')}`
      } — an unrun check is never a passed one`,
    );
    return out;
  }
  const named = closes.map(entry => `#${entry.issue}`).join(', ');
  if (!binding.ok) {
    if (closes.length === 0) return out;
    out.unknown(`ticket binding: this PR's body closes ${named}, and ${binding.reason}`, binding.repair);
    return out;
  }
  const bound = binding.issue;
  const rest = restOf(channels);
  if (closes.length === 0) {
    out.refuse(
      `ticket binding: this merge is for #${bound} (${binding.source}), and ${
        rest === '' ? 'the body closes no same-repository issue' : `neither the body nor ${rest} closes a same-repository issue`
      }, so #${bound} would stay open after it — every ticket blocked by #${bound} then derives from a stale blocker`,
      `gh pr edit ${pr} --repo ${slug} --body-file -   # add "Closes #${bound}", or merge by hand if this PR is not that ticket's delivery`,
    );
    return out;
  }
  const mine = closes.find(entry => entry.issue === bound);
  if (!mine) {
    const away = closes.filter(entry => entry.sources.every(source => source.kind !== 'body'));
    out.refuse(
      `ticket binding: this merge is for #${bound} (${binding.source}), but ${closes.map(closureOf).join('; ')} — merging would close ${named} and leave #${bound} open, and every ticket blocked by #${bound} keeps deriving from a stale blocker`,
      away.length === closes.length
        ? `${editChannel(away[0].sources[0], pr, slug)}   # make it close #${bound}${away[0].sources[0].kind === 'commit' ? ', force-push' : ''}, then re-run`
        : `gh pr edit ${pr} --repo ${slug} --body-file -   # make the body close #${bound}, or re-run naming the ticket this PR really delivers`,
    );
    return out;
  }
  // A closure the description never declared: invisible to review, and GitHub
  // acts on it anyway.
  const undeclared = closes.filter(entry => entry.issue !== bound && entry.sources.every(source => source.kind !== 'body'));
  if (undeclared.length > 0) {
    out.refuse(
      `ticket binding: this merge is for #${bound} (${binding.source}) and ${sourcesOf(mine)} closes it, but ${undeclared
        .map(closureOf)
        .join('; ')} — merging would also close ${undeclared.map(entry => `#${entry.issue}`).join(', ')}, which this PR's description never declared, and a merged PR cannot be un-merged`,
      `${editChannel(undeclared[0].sources[0], pr, slug)}   # drop #${undeclared[0].issue} from that text${undeclared[0].sources[0].kind === 'commit' ? ', force-push' : ''}, then re-run`,
    );
    return out;
  }
  const siblings = closes.filter(entry => entry.issue !== bound);
  out.note(
    `ticket binding: ${sourcesOf(mine)} closes #${bound}, the ticket this merge is for (${binding.source})` +
      (siblings.length === 0 ? '' : `; it also closes ${siblings.map(entry => `#${entry.issue}`).join(', ')}, which GitHub closes too`),
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
