// Completion, derived: is the Spec's approved result deployed and verified
// under the mandate it agreed — including the necessary work admitted while it
// ran?
//
// WHY THIS MODULE EXISTS (#191, `docs/adr/0003`). AX could finish every initial
// ticket of a Spec and leave the approved result unshipped, and no read said
// so. Three states were collapsed into one: an empty `takeable` list, a closed
// Wave, and Completion. The first is a graph fact, the second is proof-by-kind
// over one fan-out, and only the third is the thing the operator approved. A
// fresh session reading an empty frontier read "done" — measured as the whole
// point of the spec this file implements.
//
// SO THE JUDGEMENT IS ITS OWN FUNCTION, AND IT IS PURE. `completionOf` decides,
// from answers already read, which entries are satisfied, which leave the Spec
// unfinished, and which could not be established at all — it spawns nothing,
// opens no file and knows nothing about a pane, so every rule below is
// exercised by calling it with the machine's answers injected.
// `completionReceipt` is the other half: it issues the tracker reads and prints
// the receipt, with the `gh` runner, the permission read and the repository's
// own declaration all injected by its caller (`../src/frontier.mjs`, whose
// `--spec` flag is the only surface either half has).
//
// THE THREE LISTS ARE STRUCTURALLY DISTINCT, the grammar the frontier and the
// merge gate already taught this instrument: `satisfied` carries its proof,
// `unfinished` carries one named reason and a repair, `unestablished` carries
// the read that failed. An unestablished entry is NEVER folded into either of
// the others — a Spec whose membership could not be read is not a Spec whose
// members are all done, and it is not one with a member left to do either
// (F-028).
//
// WHAT SATISFIES A MEMBER, and the rule the criteria state twice: neither an
// author declaring success nor a local merge establishes the result. So a
// member closed as COMPLETED is satisfied only by a MERGED pull request the
// tracker attributes to it. A member closed NOT_PLANNED or DUPLICATE is
// EXPLICIT ABANDONMENT — proof a Wave may close on, and deliberately NOT
// Completion: work the Spec approved and nobody delivered changes the approved
// result, and that is a human's decision, never an inference here. It is
// therefore named and unfinished, so a Spec cannot complete itself by
// attrition. A member closed as completed with no merged pull request is
// unfinished and says which of the two it lacks; a close nobody could
// attribute is unestablished.
//
// AN EXCLUDED MEMBER STAYS VISIBLE. The frontier's exclusion — an ordinary
// blocker, an established cycle, a dead attempt — is annotation on an
// unfinished member, never a reason to drop it: exclusion is why a ticket is
// not dispatchable, and reading it as Completion is how two tickets blocking
// each other became a finished Spec.
//
// UNRELATED OPEN ISSUES ARE NOT IN THE CORPUS. Completion is scoped to the
// Spec's own members plus the work admitted against its obligations
// (`./triage/necessity.mjs`), so an empty tracker was never the test — and
// closing every original ticket does not hide an admitted finding, because the
// finding is a member of this read by its own necessity line.
//
// AN OPERATION OUTSIDE THE MANDATE IS A NAMED BLOCKER. An `Observed:` line for
// something the mandate never declared is not a widened authorization: it is
// reported as outside the mandate, unfinished, with the amendment as its
// repair. An impossible verification (`Blocked:`) is the same shape. Neither
// one silently changes what was approved.

import { bad, fix, note, ok, section } from './log.mjs';
import { mandateOf, observationsOf } from './mandate.mjs';
import { clean, payload } from './pr-grounds.mjs';
import { necessityOf } from './triage/necessity.mjs';

/**
 * Which state reasons the tracker itself uses to say a ticket was abandoned
 * rather than delivered. Read from the tracker so this package invents no
 * second abandonment vocabulary for a fact GitHub already records.
 */
const ABANDONED = new Set(['NOT_PLANNED', 'DUPLICATE']);

const COMPLETED = 'COMPLETED';

/** `#175 T175`, the way every list in this receipt names one issue. */
const nameOf = entry => `#${entry.number} ${entry.title}`;

/**
 * The pull requests the tracker attributes the close of one member to, judged
 * complete or not at all: a truncated page, malformed pagination or a
 * reference whose `merged` flag is not a boolean says nothing about whether
 * the work landed, and reading any of them as "not merged" is the F-028
 * mistake with the direction reversed — it would report an unfinished member
 * whose pull request merged, and send a worker to redo landed work.
 */
function artifactsOf(entry) {
  const page = entry.closedByPullRequestsReferences;
  if (page === null || page === undefined || typeof page !== 'object') {
    return { ok: false, reason: 'the closing pull requests were not answered' };
  }
  const info = page.pageInfo;
  if (info === null || typeof info !== 'object' || Array.isArray(info) || typeof info.hasNextPage !== 'boolean') {
    return { ok: false, reason: 'the closing pull requests answered malformed pagination (pageInfo.hasNextPage is not a boolean)' };
  }
  if (info.hasNextPage) {
    return { ok: false, reason: 'the closing pull requests truncated, and the unread remainder can hold the merged one' };
  }
  if (!Array.isArray(page.nodes)) {
    return { ok: false, reason: 'the closing pull requests answered no nodes — an absent container is not an empty one' };
  }
  const merged = [];
  for (const node of page.nodes) {
    if (typeof node?.merged !== 'boolean') {
      return { ok: false, reason: `a closing pull request answered no readable merged flag (${JSON.stringify(node?.merged ?? null)})` };
    }
    if (node.merged) merged.push(`${node?.repository?.nameWithOwner ?? '?'}#${node?.number}`);
  }
  return { ok: true, merged };
}

/**
 * One member's verdict, from the tracker's answer about it alone.
 *
 * `frontier` is the exclusion the same receipt already classified for this
 * number, or null; `necessity` is the obligation an admitted finding names.
 */
function memberVerdict(entry, { repo }) {
  const what = nameOf(entry);
  const because = entry.necessity ? ` (necessary for: ${entry.necessity})` : '';
  const state = String(entry.state ?? '').toUpperCase();

  if (state !== 'OPEN' && state !== 'CLOSED') {
    return {
      list: 'unestablished',
      what,
      read: `the state of ${what} is ${entry.state === undefined || entry.state === null ? 'unanswered' : `unreadable (${String(entry.state)})`} — an unread member is not a finished one (F-028)`,
      repair: `gh issue view ${entry.number} --repo ${repo} --json state,stateReason`,
    };
  }

  if (state === 'OPEN') {
    // The annotation carries its own words (`excluded: …`, `takeable on this
    // receipt`) so this line never re-labels what the frontier already named.
    return { list: 'unfinished', what, why: `open${entry.frontier ? `, ${entry.frontier}` : ''}${because}` };
  }

  const reason = entry.stateReason === undefined || entry.stateReason === null ? null : String(entry.stateReason).toUpperCase();
  if (reason === null) {
    return {
      list: 'unestablished',
      what,
      read: `${what} is closed with no readable state reason, so whether it was delivered or abandoned is unknown — and a close nobody could attribute is not a landing (F-028)`,
      repair: `gh issue view ${entry.number} --repo ${repo} --json stateReason`,
    };
  }
  if (ABANDONED.has(reason)) {
    // Wave closure's proof-by-kind accepts an explicit abandonment; Completion
    // does not, and the criteria separate the two on purpose. Approved work
    // dropped is a change to the approved product result, which is a human's
    // decision — so the abandonment is NAMED and the Spec stays unfinished
    // rather than completing itself by attrition.
    return {
      list: 'unfinished',
      what,
      why: `closed ${reason}${because} — an explicit abandonment closes a Wave, and Wave closure is not Completion: approved work dropped changes the approved result, which is not inferred here`,
      repair: `gh issue view ${entry.number} --repo ${repo}   # deliver it, or have the operator amend the Spec's membership out loud`,
    };
  }
  if (reason !== COMPLETED) {
    return {
      list: 'unestablished',
      what,
      read: `${what} is closed with the state reason ${reason}, which this read has no rule for — guessing between delivered and abandoned is the judgement it exists to avoid`,
      repair: `gh issue view ${entry.number} --repo ${repo} --json stateReason`,
    };
  }

  const artifacts = artifactsOf(entry);
  if (artifacts.ok !== true) {
    return {
      list: 'unestablished',
      what,
      read: `the pull requests that closed ${what} could not be read (${artifacts.reason}) — an unread artifact is not an absent one (F-028)`,
      repair: `gh issue view ${entry.number} --repo ${repo} --json closedByPullRequestsReferences`,
    };
  }
  const merged = artifacts.merged.filter(ref => String(ref).length > 0);
  if (merged.length === 0) {
    return {
      list: 'unfinished',
      what,
      why: `closed ${COMPLETED} with no merged pull request observed${because} — an author declaring success is not the approved result`,
      repair: `gh issue view ${entry.number} --repo ${repo} --json closedByPullRequestsReferences   # merge the work, or close it NOT_PLANNED to abandon it out loud`,
    };
  }
  return { list: 'satisfied', what, proof: `merged ${merged.join(',')}${because}` };
}

/** The line an operator writes to declare the mandate this read could not find. */
const mandateRepair = spec =>
  `gh issue edit ${spec} --body-file -   # the Spec declares: 'Deployment target: <where>', 'Permitted operations: <what>', and one 'Observation: <name> — <what establishes it>' per observation`;

/**
 * Completion for one Spec, judged from answers already read.
 *
 * Inputs, every one of them an injected answer:
 *   `spec`         `{ number, ref }` — the Spec and how a receipt names it
 *   `mandate`      the `mandateOf()` result for that Spec
 *   `mandateAuthority`  `{ ok }` for the login that declared it; absent is unknown
 *   `members`      the Spec's enumerated members, each as the tracker answered
 *                  it — `{ number, title, state, stateReason,
 *                  closedByPullRequestsReferences }` plus the `frontier`
 *                  exclusion this receipt classified for it, or null
 *   `membership`   `{ ok }` — did the caller's member read prove itself? A
 *                  false one is already a named finding on `unestablished`,
 *                  and this function does not report it a second time
 *   `necessary`    admitted necessary work, same shape plus `necessity`
 *   `observed` / `blocked`  the lines `observationsOf()` read, each carrying
 *                  `authority` for the login that stated it
 *   `unestablished`  reads the caller already failed (membership, admissions)
 *
 * Returns `{ satisfied, unfinished, unestablished, established }`. `established`
 * is true only when nothing is unfinished and nothing is unestablished: this
 * read never rounds an inability up to a result.
 */
export function completionOf({
  spec = {},
  mandate = null,
  mandateAuthority = null,
  members = [],
  membership = { ok: true },
  necessary = [],
  observed = [],
  blocked = [],
  unestablished: seeded = [],
} = {}) {
  const repo = String(spec.ref ?? '').split('#')[0] || 'this repository';
  const satisfied = [];
  const unfinished = [];
  const unestablished = [...seeded];

  const place = verdict => {
    if (verdict.list === 'satisfied') satisfied.push({ what: verdict.what, proof: verdict.proof });
    else if (verdict.list === 'unfinished') unfinished.push({ what: verdict.what, why: verdict.why, repair: verdict.repair });
    else unestablished.push({ what: verdict.what, read: verdict.read, repair: verdict.repair });
  };

  // ── The Spec's own work: its members, then the work admitted against its
  // obligations. Both are judged by the same rule — an admitted finding is not
  // a softer member.
  if (membership.ok !== false && members.length === 0) {
    unestablished.push({
      what: 'spec membership',
      read: `the sub-issue read answered no member for ${spec.ref ?? `#${spec.number}`} — a Spec with no enumerated member establishes no approved result`,
      repair: `gh issue view ${spec.number} --repo ${repo} --json subIssues`,
    });
  }
  for (const entry of [...members, ...necessary]) place(memberVerdict(entry, { repo }));

  // ── The Deployment mandate, and the observations it named. A mandate that is
  // absent, partial, ambiguous or unreadable authorizes nothing, and the
  // observations are not judged against a mandate nobody could read.
  if (mandate === null || mandate.ok !== true) {
    const kind = mandate?.kind ?? 'unknown';
    if (kind === 'unknown') {
      unestablished.push({
        what: 'deployment mandate',
        read: `the Spec's mandate could not be read — ${mandate?.why ?? 'no answer'}`,
        repair: `gh issue view ${spec.number} --repo ${repo} --json body,comments`,
      });
    } else {
      const why =
        kind === 'absent'
          ? "absent — this Spec declares no Deployment mandate, and a missing mandate authorizes no deployment rather than any deployment the agent can reach"
          : kind === 'incomplete'
            ? `incomplete — ${mandate.from} declares a mandate missing ${mandate.missing.join(' and ')}; complete or absent, never partial`
            : `ambiguous — ${mandate.why}`;
      unfinished.push({ what: 'deployment mandate', why, repair: mandateRepair(spec.number) });
    }
    return { satisfied, unfinished, unestablished, established: false };
  }

  if (mandateAuthority === null || mandateAuthority.ok === null || mandateAuthority.ok === undefined) {
    unestablished.push({
      what: 'deployment mandate',
      read: `the write permission of ${mandate.by ?? 'the login that declared this mandate'} could not be read, so whether the mandate carries authority is unknown${mandateAuthority?.why ? ` (${mandateAuthority.why})` : ''}`,
      repair: `gh api repos/${repo}/collaborators/${mandate.by ?? '<login>'}/permission`,
    });
  } else if (mandateAuthority.ok === false) {
    unfinished.push({
      what: 'deployment mandate',
      why: `declared in ${mandate.from} by ${mandate.by ?? 'an unattributable author'}, who ${mandateAuthority.why ?? 'has no write permission on this repository'} — an authorization nobody with write access stated is not one`,
      repair: `gh issue view ${spec.number} --repo ${repo}   # have a maintainer restate the mandate, then re-run`,
    });
  }

  const declared = new Map(mandate.observations.map(observation => [observation.name, observation]));
  const firstOf = (list, name) => list.find(entry => entry.name === name) ?? null;

  for (const observation of mandate.observations) {
    const what = `observation "${observation.display}"`;
    const seen = firstOf(observed, observation.name);
    const stopped = firstOf(blocked, observation.name);

    if (seen !== null && stopped !== null) {
      unfinished.push({
        what,
        why: `recorded both observed (${seen.from}) and impossible (${stopped.from}) — contradictory evidence establishes nothing`,
        repair: `gh issue view ${spec.number} --repo ${repo}   # retract one of the two lines, then re-run`,
      });
      continue;
    }
    if (seen !== null) {
      const authority = seen.authority ?? null;
      if (authority === null || authority.ok === null || authority.ok === undefined) {
        unestablished.push({
          what,
          read: `the write permission of ${seen.by ?? 'the login that recorded this observation'} could not be read, so the observation's authority is unknown${authority?.why ? ` (${authority.why})` : ''}`,
          repair: `gh api repos/${repo}/collaborators/${seen.by ?? '<login>'}/permission`,
        });
        continue;
      }
      if (authority.ok === false) {
        unfinished.push({
          what,
          why: `recorded in ${seen.from} by ${seen.by ?? 'an unattributable author'}, who ${authority.why ?? 'has no write permission on this repository'} — an observation nobody with authority stated does not establish a deployment`,
          repair: `gh issue view ${spec.number} --repo ${repo}   # have a maintainer restate the observation, then re-run`,
        });
        continue;
      }
      satisfied.push({ what, proof: `observed by ${seen.by} (${seen.from}): ${seen.evidence}` });
      continue;
    }
    if (stopped !== null) {
      unfinished.push({
        what,
        why: `declared impossible in ${stopped.from} by ${stopped.by ?? 'an unattributable author'} — ${stopped.why}`,
        repair: `gh issue view ${spec.number} --repo ${repo}   # a verification the mandate requires and this machine cannot perform is the operator's decision: amend the mandate or supply the access`,
      });
      continue;
    }
    unfinished.push({
      what,
      why: `not observed — the mandate establishes it by: ${observation.establishedBy}`,
      repair: `gh issue comment ${spec.number} --repo ${repo} --body 'Observed: ${observation.display} — <the evidence>'`,
    });
  }

  // ── Lines outside the mandate. Recording an observation the Spec never
  // agreed does not widen the authorization; it is reported as what it is.
  for (const [entry, kind] of [...observed.map(row => [row, 'observed']), ...blocked.map(row => [row, 'declared impossible'])]) {
    if (declared.has(entry.name)) continue;
    unfinished.push({
      what: `observation "${entry.display}"`,
      why: `${kind} in ${entry.from}, but outside the mandate — this Spec's mandate declares ${[...declared.values()].map(observation => `"${observation.display}"`).join(', ') || 'none'}, and a line naming another one is not an authorization the Spec agreed`,
      repair: `gh issue view ${spec.number} --repo ${repo}   # amend the mandate on the Spec, or retract the line`,
    });
  }

  return { satisfied, unfinished, unestablished, established: unfinished.length === 0 && unestablished.length === 0 };
}

// ── The read ────────────────────────────────────────────────────────────────
//
// One GraphQL round-trip for the Spec — its body, its comments and every
// member with the pull requests that closed it — then one label-scoped list
// per declared findings class for the work admitted against its obligations.
// Every page is PROVED complete or the read that failed is named: a truncated
// comment page can hide the mandate, and a member the sub-issue read did not
// return is not a member that is done.

/** Sub-issues read in one page, and the cap the receipt names when it fills. */
const MEMBER_CAP = 100;

/** Comments read in one page: the mandate and every observation live here. */
const COMMENT_CAP = 100;

/** Closing pull requests per member. A member closed by twenty is already odd. */
const PR_CAP = 20;

/**
 * The Spec read. Identifiers only — owner, name and one issue number — never
 * contributor-authored text (D-030).
 */
const specQuery = (owner, name, number) => `
query {
  repository(owner: "${owner}", name: "${name}") {
    issue(number: ${number}) {
      number
      title
      state
      body
      author { login }
      comments(first: ${COMMENT_CAP}) { nodes { body author { login } } pageInfo { hasNextPage } }
      subIssues(first: ${MEMBER_CAP}) {
        totalCount
        pageInfo { hasNextPage }
        nodes {
          number
          title
          state
          stateReason
          repository { nameWithOwner }
          closedByPullRequestsReferences(first: ${PR_CAP}, includeClosedPrs: true) {
            nodes { number merged repository { nameWithOwner } }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  }
}`;

/**
 * The fields the admitted-work LIST supports. `closedByPullRequestsReferences`
 * is not one of them (`gh issue list --json` refuses it), so a closed
 * finding's pull requests are a second, GraphQL, read of the numbers this
 * list already graded as this Spec's work.
 */
const FINDINGS_FIELDS = 'number,title,state,stateReason,body,comments';

/** One aliased issue per closed admitted finding, identifiers only (D-030). */
const findingsQuery = (owner, name, numbers) => `
query {
  repository(owner: "${owner}", name: "${name}") {
    ${numbers.map(n => `i${n}: issue(number: ${n}) {
      number
      state
      stateReason
      repository { nameWithOwner }
      closedByPullRequestsReferences(first: ${PR_CAP}, includeClosedPrs: true) {
        nodes { number merged repository { nameWithOwner } }
        pageInfo { hasNextPage }
      }
    }`).join('\n')}
  }
}`;

/**
 * Is this page proved complete? The same rule the frontier applies to a
 * blocker page: `pageInfo.hasNextPage` must be a BOOLEAN, and the nodes must
 * be a list — absent or malformed pagination is an unproved page, never a
 * complete one.
 */
function pageComplete(page) {
  const info = page?.pageInfo;
  if (info === null || typeof info !== 'object' || Array.isArray(info) || typeof info.hasNextPage !== 'boolean') {
    return { ok: false, why: 'the answer carries malformed pagination (pageInfo.hasNextPage is not a boolean)' };
  }
  if (info.hasNextPage) return { ok: false, why: 'the page truncated, and this read never infers the remainder' };
  if (!Array.isArray(page.nodes)) return { ok: false, why: 'the answer carries no nodes — an absent container is not an empty one (F-028)' };
  return { ok: true, nodes: page.nodes };
}

/**
 * THE ONE MEMBERSHIP READER. One GraphQL round-trip answers what a Spec is:
 * its own prose, and the members it declares.
 *
 * Exported because it is the seam a second consumer needs (#195's landed-facts
 * notes derive from the same membership), and two readers of one tracker fact
 * would be two interpretations of it — the failure `provenance.mjs` was
 * extracted to close. It reads and returns; it never prints, never judges
 * Completion and never touches the mandate.
 *
 * A member's identity is REPOSITORY-QUALIFIED, the frontier's own rule for a
 * blocker: sub-issues can live in another repository, and two issues numbered
 * 10 in two repositories are different members. A node whose repository nobody
 * could read is outside the corpus, not this repository's.
 *
 * Returns, and every failure is named rather than emptied:
 *   `{ ok: false, kind: 'unknown', why, repair }`  the Spec itself is unreadable
 *   `{ ok: false, kind: 'absent', why, repair }`   the tracker answered no such issue
 *   `{ ok: true, spec, members, comments }` where
 *     `spec`      `{ number, ref, title, state, body, author }`
 *     `members`   `{ ok: true, total, nodes: [{ number, ref, repo, title,
 *                 state, stateReason, closedByPullRequestsReferences }] }`
 *                 or `{ ok: false, why, repair }` — an unproved page, an
 *                 unreadable totalCount, or a count the nodes contradict.
 *                 `ok: true` with `total: 0` is a Spec that declares no members,
 *                 which is not a failed read and not an absent Spec.
 *     `comments`  `{ ok: true, nodes }` or `{ ok: false, why, repair }`
 *
 * `run` is one `gh` argv; `slug`/`owner`/`name` identify the checkout. Nothing
 * here reads process.env or the filesystem.
 */
export function specMembership(number, { run, slug, owner, name }) {
  const ref = `${slug}#${number}`;
  const answered = payload(run(['api', 'graphql', '-f', `query=${specQuery(owner, name, number)}`]));
  if (!answered.ok) {
    return {
      ok: false,
      kind: 'unknown',
      why: `the Spec read for ${ref} ${answered.reason} — a Spec's members, artifacts and mandate are all derived from this one answer, and none of them can be guessed`,
      repair: `gh issue view ${number} --repo ${slug} --json subIssues,body,comments   # read it by hand`,
    };
  }
  const issue = answered.value?.data?.repository?.issue;
  if (issue === null || issue === undefined) {
    return {
      ok: false,
      kind: 'absent',
      why: `the Spec read answered no issue for ${ref} — this tracker has no such Spec, which is not a Spec whose members are all done`,
      repair: `gh issue view ${number} --repo ${slug}`,
    };
  }
  if (typeof issue !== 'object') {
    return {
      ok: false,
      kind: 'unknown',
      why: `the Spec read for ${ref} answered an unreadable issue (${typeof issue})`,
      repair: `gh issue view ${number} --repo ${slug}`,
    };
  }

  const page = pageComplete(issue.subIssues);
  const total = Number(issue.subIssues?.totalCount);
  let members;
  if (!page.ok) {
    members = {
      ok: false,
      why: `the sub-issue read for ${ref} could not be proved complete — ${page.why}; a member this read did not return is not a member that is done`,
      repair: `gh issue view ${number} --repo ${slug} --json subIssues   # page the rest (cap here is ${MEMBER_CAP})`,
    };
  } else if (!Number.isSafeInteger(total)) {
    members = {
      ok: false,
      why: `the sub-issue read for ${ref} answered no readable totalCount, so the ${page.nodes.length} member(s) it returned cannot be proved to be all of them`,
      repair: `gh issue view ${number} --repo ${slug} --json subIssues`,
    };
  } else if (total !== page.nodes.length) {
    members = {
      ok: false,
      why: `${ref} declares ${total} member(s) and the read returned ${page.nodes.length} — an incomplete membership read is not a shorter Spec`,
      repair: `gh issue view ${number} --repo ${slug} --json subIssues   # page the rest (cap here is ${MEMBER_CAP})`,
    };
  } else {
    members = {
      ok: true,
      total,
      nodes: page.nodes.map(node => {
        const repo = node?.repository?.nameWithOwner ?? null;
        return { ...node, repo, ref: repo === null ? `?#${node?.number}` : `${repo}#${node?.number}` };
      }),
    };
  }

  const commentPage = pageComplete(issue.comments);
  const comments = commentPage.ok
    ? { ok: true, nodes: commentPage.nodes }
    : {
        ok: false,
        why: `the comment read for ${ref} could not be proved complete — ${commentPage.why}; the mandate or an observation can be in the unread remainder (F-028)`,
        repair: `gh issue view ${number} --repo ${slug} --json comments   # page the rest (cap here is ${COMMENT_CAP})`,
      };

  return {
    ok: true,
    spec: { number, ref, title: issue.title ?? null, state: issue.state ?? null, body: issue.body, author: issue.author?.login ?? null },
    members,
    comments,
  };
}

/**
 * The Spec-scoped Completion read, printed as its own part of the frontier
 * receipt.
 *
 * Injected, all of it: `run` issues one `gh` argv, `writeAccess` answers
 * whether one login may write (true / false / null for a read that failed),
 * `provenance` is the repository's declared label vocabulary, and `frontierOf`
 * answers how this same receipt already classified an issue number.
 *
 * Returns 0 when a receipt was produced — including one that establishes
 * nothing — and 3 only when the Spec itself could not be read: an unfinished
 * Spec is an answer, and a verb that exited non-zero for it would teach a
 * caller to treat "not done" as a broken read.
 */
export function completionReceipt(number, { run, slug, owner, name, writeAccess, provenance, frontierOf = () => null }) {
  const read = specMembership(number, { run, slug, owner, name });
  if (!read.ok) {
    bad(`CANNOT ESTABLISH — ${read.why}`);
    fix(read.repair);
    return 3;
  }
  const { spec, comments } = read;
  const ref = spec.ref;

  const unestablished = [];
  const members = read.members.ok ? read.members.nodes.map(node => ({ ...node, frontier: frontierOf(Number(node?.number)) })) : [];
  if (!read.members.ok) unestablished.push({ what: 'spec membership', read: read.members.why, repair: read.members.repair });

  // ── The mandate and its observations, from the Spec's own prose. An unproved
  // comment page makes both UNKNOWN: the mandate, or the observation that
  // establishes the deployed result, can be in the comment nobody read.
  const prose = { body: spec.body, comments: comments.ok ? comments.nodes : undefined, author: spec.author };
  const unread = { ok: false, kind: 'unknown', why: comments.why, field: 'comments' };
  const mandate = comments.ok ? mandateOf(prose) : unread;
  const observations = comments.ok ? observationsOf(prose) : unread;
  if (!observations.ok) {
    unestablished.push({
      what: 'mandate observations',
      read: observations.why,
      repair: comments.repair ?? `gh issue view ${number} --repo ${slug} --json comments`,
    });
  }

  /** Write permission, asked once per login and answered true / false / null. */
  const authorityOf = login => {
    if (login === null || login === undefined || String(login) === '') {
      return { ok: false, why: 'is not attributable to any login' };
    }
    const allowed = writeAccess(String(login));
    if (allowed === null || allowed === undefined) return { ok: null, why: `the permission read for ${login} failed` };
    return allowed ? { ok: true } : { ok: false, why: `has no write permission on ${slug}` };
  };

  const observed = (observations.observed ?? []).map(entry => ({ ...entry, authority: authorityOf(entry.by) }));
  const blocked = observations.blocked ?? [];
  const mandateAuthority = mandate.ok === true ? authorityOf(mandate.by ?? spec.author) : null;

  // ── Admitted necessary work: the findings class this repository declares,
  // graded by the necessity line on the issue itself (#188). A project that
  // declares no findings class is NOT-MEASURED here and says so — the
  // repository is input, and an undeclared class is not an empty one.
  const findingsLabels = Array.isArray(provenance?.findings) ? provenance.findings : [];
  const necessary = [];
  const memberNumbers = new Set(members.map(entry => Number(entry.number)));
  for (const label of findingsLabels) {
    const listed = payload(run(['issue', 'list', '--repo', slug, '--state', 'all', '--label', label, '--json', FINDINGS_FIELDS, '--limit', String(MEMBER_CAP)]));
    if (!listed.ok || !Array.isArray(listed.value)) {
      unestablished.push({
        what: 'admitted necessary work',
        read: `the read of issues carrying '${label}' ${listed.ok ? 'answered no list — an absent container is not an empty one' : listed.reason} — an unread admission is not an absent one (F-028)`,
        repair: `gh issue list --repo ${slug} --state all --label ${label}   # read it by hand`,
      });
      continue;
    }
    if (listed.value.length >= MEMBER_CAP) {
      unestablished.push({
        what: 'admitted necessary work',
        read: `the read of issues carrying '${label}' filled its cap of ${MEMBER_CAP} rows, so an admission can be in the unread remainder`,
        repair: `gh issue list --repo ${slug} --state all --label ${label} --limit 1000`,
      });
      continue;
    }
    for (const row of listed.value) {
      const found = necessityOf({ body: row?.body, comments: Array.isArray(row?.comments) ? row.comments.map(entry => entry?.body) : row?.comments });
      if (found.ok !== true) {
        if (found.kind === 'unknown') {
          unestablished.push({
            what: `admitted necessary work #${row?.number}`,
            read: `whether #${row?.number} names this Spec's obligation could not be read — ${found.why}`,
            repair: `gh issue view ${row?.number} --repo ${slug} --comments`,
          });
        }
        continue;
      }
      if (found.spec !== number || memberNumbers.has(Number(row?.number))) continue;
      necessary.push({
        number: row.number,
        title: row.title,
        state: row.state,
        stateReason: row.stateReason ?? null,
        necessity: found.obligation,
        frontier: frontierOf(Number(row?.number)),
        closedByPullRequestsReferences: undefined,
      });
    }
  }

  // Closed admitted findings still need the pull requests that closed them,
  // which the list cannot answer. One batched GraphQL round-trip, proved
  // complete per finding — an unread artifact is not an absent one (F-028).
  const closedAdmitted = necessary.filter(entry => String(entry.state ?? '').toUpperCase() === 'CLOSED');
  if (closedAdmitted.length > 0) {
    const artifacts = payload(run(['api', 'graphql', '-f', `query=${findingsQuery(owner, name, closedAdmitted.map(entry => entry.number))}`]));
    if (!artifacts.ok) {
      unestablished.push({
        what: 'admitted necessary work',
        read: `the closing pull requests of ${closedAdmitted.length} admitted finding(s) ${artifacts.reason} — an unread artifact is not an absent one (F-028)`,
        repair: `gh issue view ${closedAdmitted[0].number} --repo ${slug} --json closedByPullRequestsReferences`,
      });
    } else {
      for (const entry of closedAdmitted) {
        const node = artifacts.value?.data?.repository?.[`i${entry.number}`];
        if (node === undefined || node === null) {
          unestablished.push({
            what: `admitted necessary work #${entry.number}`,
            read: `the closing-pull-request read answered nothing for #${entry.number}`,
            repair: `gh issue view ${entry.number} --repo ${slug} --json closedByPullRequestsReferences`,
          });
          continue;
        }
        entry.state = node.state ?? entry.state;
        entry.stateReason = node.stateReason ?? entry.stateReason;
        entry.closedByPullRequestsReferences = node.closedByPullRequestsReferences;
      }
    }
  }

  const verdict = completionOf({
    spec: { number, ref },
    mandate,
    mandateAuthority,
    members,
    membership: { ok: read.members.ok },
    necessary,
    observed,
    blocked,
    unestablished,
  });

  // ── The receipt.
  section(`completion — ${ref} · ${clean(String(spec.title ?? ''))}`);
  note(
    `spec        ${clean(String(spec.state ?? 'state unread'))}${String(spec.state ?? '').toUpperCase() === 'CLOSED' && !verdict.established ? ' — closed while this read establishes no Completion' : ''}`,
  );
  note(
    mandate.ok === true
      ? `mandate     ${mandate.observations.length} observation(s), declared in ${mandate.from}${mandate.by === null ? '' : ` by ${clean(mandate.by)}`} — target: ${clean(mandate.target)}`
      : `mandate     ${mandate.kind} — nothing here authorizes a deployment`,
  );
  note(`members     ${members.length} enumerated from the Spec's sub-issues${read.members.ok ? ` of ${read.members.total} declared` : ' (membership unproved)'}`);
  note(
    findingsLabels.length === 0
      ? `necessary   not measured — this repository declares no triage.provenance.findings class, so no admission can be graded`
      : `necessary   ${necessary.length} admitted by 'Necessary for: #${number}' among issues carrying ${findingsLabels.join(', ')}`,
  );

  section(`satisfied — ${verdict.satisfied.length}`);
  for (const entry of verdict.satisfied) ok(`${entry.what} — ${entry.proof}`);

  section(`unfinished — ${verdict.unfinished.length}`);
  for (const entry of verdict.unfinished) {
    note(`${entry.what} — ${entry.why}`);
    if (entry.repair) fix(entry.repair);
  }

  section(`completion cannot establish — ${verdict.unestablished.length}`);
  for (const entry of verdict.unestablished) {
    bad(`CANNOT ESTABLISH — ${entry.what}: ${entry.read}`);
    if (entry.repair) fix(entry.repair);
  }

  section('completion verdict');
  if (verdict.established) {
    ok(
      `COMPLETION ESTABLISHED — every member of ${ref} is satisfied by its own artifact and every observation its Deployment mandate named was recorded with authority. Unrelated open issues do not bear on it.`,
    );
  } else {
    bad(
      `COMPLETION NOT ESTABLISHED — ${verdict.unfinished.length} unfinished, ${verdict.unestablished.length} could not be established. Wave closure is not Completion, and an empty takeable list is not either.`,
    );
  }
  return 0;
}
