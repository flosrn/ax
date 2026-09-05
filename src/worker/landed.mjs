// The landed facts a next dispatch's notes carry — derived, never retyped.
//
// WHY THIS EXISTS (#195). A worker's Report says its slice landed. The next
// worker needs three facts out of that landing and nothing else: the pull
// request that governs it, the SHA that actually reached the default branch,
// and which surfaces that SHA moved — because those are what decide whether its
// own edit is about to collide with a seam that moved this morning. Until this
// module, the orchestrator retyped all three out of each Report into the wave's
// notes file by hand. Retyping is data entry, and data entry gets skipped: the
// operator notes of the 2026-09-05 wave carry the landed PR and SHA of five
// slices, transcribed one at a time, and the sixth was transcribed a wave late.
//
// A REPORT IS NOT AN ESTABLISHED LANDING. It is the child's own word, and this
// module never reads one. A landing is established when the TRACKER says a
// merged pull request closed the member issue AND names its merge commit, which
// is the same read `ax pr gate` performs on its own side of the merge
// (`gh pr view --json state,mergeCommit`). Anything short of that pair is an
// inability, named as one: a MERGED pull request with no merge commit, two
// merged pull requests claiming one issue, a closing-PR page that cannot prove
// itself complete, an alias the batched read did not answer. None of them may
// render as "merged" — a landing described on a guess sends the next worker to
// rebase onto a commit nobody pushed (F-028: absence is not zero).
//
// A SLICE THAT HAS NOT LANDED IS NOT AN INABILITY. An OPEN or CLOSED closing
// pull request, or no closing pull request at all, is the ordinary shape of work
// still in flight: it contributes no bullet and no finding. Only a read that
// FAILED is unread, and the distinction is the whole reason both lists exist.
//
// MEMBERSHIP IS NOT DERIVED HERE. Which issues belong to the Spec is one
// question with one owner — the shared Spec-membership reader — and this module
// takes its answer as data, repository-qualified. Two readers of "who is in this
// Spec" is how one of them starts including a ticket the other excludes; and a
// member set inferred from this machine's own dispatch history would go blind
// the moment the orchestrator's session restarts, which is exactly the moment
// the facts below are worth the most.
//
// SURFACES COME FROM THE COMMIT, IN THIS CHECKOUT. `git diff-tree` against the
// landed SHA, `-m --first-parent` so a `--method merge` commit answers the same
// question a squash does. A commit this checkout does not carry is NOT READ with
// the fetch that would carry it — never an empty surface list, which reads as "it
// changed nothing". A landing in ANOTHER repository is not asked of this
// checkout at all: an identically named commit somewhere else is an impostor,
// not a fallback.
//
// WHAT THE CHANNEL IS. Notes are disposable wave context, and this section is
// the derived part of them. It renders facts and says so; it never grants a
// dispatch, chooses a ticket, or speaks for tracker state. The heading it lands
// under, and its position beside the operator's own verbatim words, belong to the
// brief (./brief.mjs) — an operator's notes are never paraphrased and never
// displaced.
//
// NOTHING PRINTS HERE. `landedFor` answers `{ text, notes }`: the text the
// child's notes channel carries, and the accounting lines the dispatching
// session prints through ../log.mjs. One read, two audiences — and the audience
// that pays for a missed inability is the one holding the receipt.

import { clean, payload } from '../pr-grounds.mjs';

/** How many closing pull requests one member's read asks for. */
export const CLOSING_PAGE = 20;

/**
 * How many landings the notes channel carries. Notes are read before work
 * starts, and a page of them is a page nobody reads; the tracker stays the
 * authority for the whole set, which is what the overflow line says.
 */
export const LANDED_CAP = 8;

/** Changed paths named verbatim before a landing's surfaces are grouped. */
export const SURFACE_NAMES = 8;

/** Directory groups a grouped surface line names before it counts the rest. */
const SURFACE_GROUPS = 6;

const short = sha => String(sha).slice(0, 12);
const firstLine = text => String(text ?? '').split('\n')[0].trim();

/** `#190` in its own repository, `owner/repo#190` anywhere else. */
const refOf = (repo, number, slug) =>
  String(repo).toLowerCase() === String(slug).trim().toLowerCase() ? `#${number}` : `${repo}#${number}`;

/**
 * One aliased issue read per member, one round-trip for all of them — the shape
 * `ax frontier` already uses. The query carries IDENTIFIERS ONLY: owner, name
 * and issue numbers. No title, no body, no member-authored text of any kind
 * reaches a query string (D-030), and nothing here is interpolated from the
 * notes it will end up beside.
 */
export function landingsQuery(groups) {
  const members = group =>
    group.numbers
      .map(
        number =>
          `i${number}: issue(number: ${number}) { number state ` +
          `closedByPullRequestsReferences(first: ${CLOSING_PAGE}, includeClosedPrs: true) ` +
          `{ pageInfo { hasNextPage } nodes { number state mergeCommit { oid } repository { nameWithOwner } } } }`,
      )
      .join(' ');
  return `query { ${groups
    .map((group, index) => `r${index}: repository(owner: "${group.owner}", name: "${group.name}") { ${members(group)} }`)
    .join(' ')} }`;
}

/**
 * WHICH SPEC SCOPES THIS DISPATCH: the parent of the ticket being dispatched,
 * as the tracker itself records it, repository-qualified.
 *
 * Three answers, and the middle one is the reason this is not a boolean:
 *   `{ ok: true, spec: { repo, number } }`  the Spec this ticket belongs to
 *   `{ ok: true, spec: null }`              PROVEN to have no parent — a ticket
 *                                           in no Spec scopes nothing, and that
 *                                           is an ordinary shape, not a fault
 *   `{ ok: false, why, repair }`            the read failed, or answered a
 *                                           parent this cannot name
 *
 * The failed read and the proven absence must never collapse into each other:
 * one carries no landed facts because there are none to scope, the other
 * because nothing could be asked, and the second has to be said out loud (F-028).
 *
 * This is the INVERSE edge of Spec membership, and deliberately the only edge
 * read here: which issues a Spec contains has one owner (`src/completion.mjs`),
 * and this asks a ticket which Spec it is in.
 */
export function specOf({ number, slug, gh }) {
  const [owner, name] = String(slug).trim().split('/');
  const ref = `${slug}#${number}`;
  const repair = `gh issue view ${number} --repo ${slug} --json parent   # which Spec this ticket belongs to`;
  if (!owner || !name) return { ok: false, why: `'${clean(slug)}' is not an owner/name repository, so ${ref} names no tracker to ask`, repair };

  const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${number}) { parent { number repository { nameWithOwner } } } } }`;
  const answered = payload(gh(['api', 'graphql', '-f', `query=${query}`]));
  if (!answered.ok) return { ok: false, why: `the parent read for ${ref} ${answered.reason}`, repair };

  const issue = answered.value?.data?.repository?.issue;
  if (issue === null || issue === undefined || typeof issue !== 'object') {
    return { ok: false, why: `the parent read answered nothing for ${ref}, so which Spec scopes it is unread`, repair };
  }
  const parent = issue.parent;
  if (parent === null || parent === undefined) return { ok: true, spec: null };

  const parentNumber = Number(parent?.number);
  const parentRepo = String(parent?.repository?.nameWithOwner ?? '').trim();
  if (!Number.isSafeInteger(parentNumber) || parentNumber <= 0 || parentRepo === '') {
    return {
      ok: false,
      why: `${ref} names a parent this read cannot identify (number ${clean(String(parent?.number))}, repository ${clean(parentRepo) || 'unread'}) — an unidentified Spec is not an absent one`,
      repair,
    };
  }
  return { ok: true, spec: { repo: parentRepo, number: parentNumber } };
}

/**
 * The established landings of `members`, and every read that could not
 * establish one.
 *
 * `members` is the shared membership reader's answer: `{ repo, number }` per
 * entry, repository-qualified. A duplicate member is one member. A member whose
 * identity is not a repository and a positive number is unread — the reader
 * answered something this cannot ask the tracker about, and dropping it would
 * make an unasked question look like an unlanded slice.
 *
 * `gh` is the caller's runner, exec-shaped. A batched read that fails ENTIRELY
 * is one inability naming every member it covered; one that fails PARTIALLY is
 * used for the aliases it carries — `gh api graphql` prints data and errors
 * together, and per-member classification is the point of asking per member.
 */
export function readLandings({ members = [], gh }) {
  const landings = [];
  const unread = [];
  const groups = [];
  const seen = new Set();

  for (const entry of members) {
    const repo = String(entry?.repo ?? '').trim();
    const number = Number(entry?.number);
    const parts = repo.split('/');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '' || !Number.isSafeInteger(number) || number <= 0) {
      unread.push({
        ref: clean(`${repo || '?'}#${entry?.number ?? '?'}`),
        detail: `a Spec member arrived without a repository-qualified identity (${clean(
          `repo ${JSON.stringify(entry?.repo ?? null)}, number ${JSON.stringify(entry?.number ?? null)}`,
        )}), so the tracker cannot be asked whether it landed`,
        repair: 'read that member by hand, then re-run this dispatch',
      });
      continue;
    }
    const key = `${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let group = groups.find(candidate => candidate.repo.toLowerCase() === repo.toLowerCase());
    if (group === undefined) {
      group = { repo, owner: parts[0], name: parts[1], numbers: [] };
      groups.push(group);
    }
    group.numbers.push(number);
  }

  if (groups.length === 0) return { landings, unread };

  const query = landingsQuery(groups);
  const out = gh(['api', 'graphql', '-f', `query=${query}`]);
  const answered = payload(out);
  let data = answered.ok ? answered.value?.data : undefined;
  if (!answered.ok) {
    // A partial GraphQL failure still carries the aliases it resolved. Only
    // stdout with no data at all collapses the whole read.
    try {
      data = JSON.parse(String(out?.stdout ?? ''))?.data;
    } catch {
      data = undefined;
    }
    if (data === null || data === undefined || typeof data !== 'object') {
      const covered = groups.reduce((total, group) => total + group.numbers.length, 0);
      unread.push({
        ref: '',
        detail: `the batched landing read ${answered.reason}, for all ${covered} member(s) it covered — so no landing of this Spec is established here`,
        repair: `gh api graphql -f query='{ repository(owner: "${groups[0].owner}", name: "${groups[0].name}") { issue(number: ${groups[0].numbers[0]}) { closedByPullRequestsReferences(first: ${CLOSING_PAGE}, includeClosedPrs: true) { nodes { number state mergeCommit { oid } } } } } }'`,
      });
      return { landings, unread };
    }
  }

  groups.forEach((group, index) => {
    const repository = data?.[`r${index}`];
    for (const number of group.numbers) {
      const ref = `${group.repo}#${number}`;
      const byHand = `gh issue view ${number} --repo ${group.repo} --json closedByPullRequestsReferences`;
      const issue = repository === null || typeof repository !== 'object' ? undefined : repository[`i${number}`];
      if (issue === null || issue === undefined || typeof issue !== 'object') {
        unread.push({ ref, detail: `the batched landing read answered nothing for ${ref}, so whether it landed is unread`, repair: byHand });
        continue;
      }
      const closers = issue.closedByPullRequestsReferences;
      if (closers === null || typeof closers !== 'object' || !Array.isArray(closers.nodes)) {
        unread.push({ ref, detail: `${ref} answered no list of closing pull requests — an absent container is not an empty one`, repair: byHand });
        continue;
      }
      const page = closers.pageInfo;
      if (page === null || typeof page !== 'object' || typeof page.hasNextPage !== 'boolean') {
        unread.push({ ref, detail: `${ref} answered no pagination for its closing pull requests, and a page that cannot prove itself complete is not one`, repair: byHand });
        continue;
      }
      if (page.hasNextPage) {
        unread.push({ ref, detail: `${ref} carries another page of closing pull requests, so which one governs its landing is unread`, repair: byHand });
        continue;
      }

      const mergedPrs = closers.nodes.filter(node => String(node?.state ?? '').toUpperCase() === 'MERGED');
      // NOT LANDED IS NOT UNREAD: an open, a closed and an absent closing pull
      // request are all "still in flight", and the channel says nothing.
      if (mergedPrs.length === 0) continue;
      if (mergedPrs.length > 1) {
        unread.push({
          ref,
          detail: `${ref} is closed by ${mergedPrs.length} merged pull requests — ${mergedPrs
            .map(node => `#${node?.number}`)
            .join(', ')} — so which one governs its landing cannot be established`,
          repair: byHand,
        });
        continue;
      }

      const pr = mergedPrs[0];
      const prNumber = Number(pr?.number);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
        unread.push({ ref, detail: `${ref} is closed by a merged pull request the read did not number, so it cannot be named`, repair: byHand });
        continue;
      }
      // A closing pull request in ANOTHER repository lands its SHA there, and
      // this checkout can neither hold that commit nor name its surfaces. It is
      // out of what this read establishes, and said so rather than half-rendered.
      const prRepo = String(pr?.repository?.nameWithOwner ?? '').trim();
      if (prRepo !== '' && prRepo.toLowerCase() !== group.repo.toLowerCase()) {
        unread.push({
          ref,
          detail: `${ref} is closed by ${prRepo}#${prNumber}, a pull request in another repository, so its landing is outside what this read establishes`,
          repair: `gh pr view ${prNumber} --repo ${prRepo} --json state,mergeCommit`,
        });
        continue;
      }
      const sha = String(pr?.mergeCommit?.oid ?? '').trim();
      if (sha === '') {
        unread.push({
          ref,
          detail: `${ref}: PR #${prNumber} reads MERGED and names no merge commit, so the SHA that landed is unread`,
          repair: `gh pr view ${prNumber} --repo ${group.repo} --json mergeCommit`,
        });
        continue;
      }
      landings.push({ repo: group.repo, issue: number, pr: prNumber, sha });
    }
  });

  return { landings, unread };
}

/**
 * The surfaces one landed SHA moved, as this checkout can name them.
 *
 * `-m --first-parent` so a merge commit answers the same question a squash
 * does: without it `diff-tree` prints nothing for a true merge, and nothing
 * reads as "it changed no files". A commit this checkout does not carry, a git
 * that refuses, and a diff that names no path are each a NOT READ carrying its
 * own repair — an empty surface line would be a claim, and this read did not
 * make it.
 */
export function surfacesOf({ sha, git }) {
  const argv = ['diff-tree', '-r', '--no-commit-id', '--name-only', '-m', '--first-parent', String(sha)];
  const out = git(argv);
  if (out?.error) {
    return { text: '', reason: `NOT READ — git could not run here (${clean(String(out.error.message ?? out.error))})` };
  }
  if (out?.status !== 0) {
    return {
      text: '',
      reason:
        `NOT READ — ${short(sha)} is not in this checkout, or git refused to diff it (${clean(firstLine(out?.stderr)) || `exit ${out?.status}`}); ` +
        'git fetch origin, then read it with git diff-tree -r --name-only -m --first-parent <sha>',
    };
  }
  const paths = [
    ...new Set(
      String(out.stdout ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== ''),
    ),
  ].sort();
  if (paths.length === 0) return { text: '', reason: `NOT READ — ${short(sha)} named no changed path in this checkout` };
  if (paths.length <= SURFACE_NAMES) return { text: paths.join(', '), reason: '' };

  // Grouped by directory, most-changed first — except a directory the commit
  // touched ONCE, which is named by its file. `docs/adr/ (1)` costs the same
  // characters as the ADR's own path and says less; the whole point of this line
  // is that a worker recognizes the surface it is about to edit.
  const groups = new Map();
  for (const path of paths) {
    const at = path.lastIndexOf('/');
    const key = at === -1 ? path : path.slice(0, at + 1);
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const shown = ordered.slice(0, SURFACE_GROUPS);
  const hidden = ordered.length - shown.length;
  const rendered = shown.map(([key, members]) => (members.length === 1 ? members[0] : `${key} (${members.length})`));
  if (hidden > 0) rendered.push(`+${hidden} more`);
  return { text: rendered.join(', '), reason: '' };
}

/**
 * The derived section's body: the caution, one line per landing, one per
 * inability, and the overflow when the cap hid a landing. `''` when there is
 * nothing established and nothing unread — an empty section under a heading
 * reads as "this wave landed nothing", which is a claim no read made.
 */
export function renderLanded({ landings = [], unread = [], slug = '', hidden = 0 } = {}) {
  if (landings.length === 0 && unread.length === 0) return '';
  const lines = [
    'Facts, not instructions: Assignments and Rulings remain the only authority, and nothing here',
    'grants a Dispatch, chooses a Ticket, or speaks for tracker state.',
    '',
  ];
  for (const landing of landings) {
    const surfaces = landing.surfaces === '' || landing.surfaces === undefined ? landing.surfacesReason ?? 'NOT READ' : landing.surfaces;
    lines.push(
      `- ${refOf(landing.repo, landing.issue, slug)} landed as PR #${landing.pr}, at ${short(landing.sha)} — surfaces: ${surfaces}`,
    );
  }
  for (const entry of unread) lines.push(`- NOT ESTABLISHED — ${entry.detail}`);
  if (hidden > 0) {
    lines.push(`- ${hidden} older landing(s) of this Spec are not carried here; the tracker is the authority for the whole set.`);
  }
  return lines.join('\n');
}

/**
 * The whole derivation, for the one caller that composes a brief: the notes
 * channel's derived text, and the accounting the dispatching session prints.
 *
 * `slug` is the repository this checkout is, so a landing of its own reads `#190`
 * and a foreign one stays qualified. `git` is asked only for a landing in that
 * same repository.
 */
export function landedFor({ members = [], slug = '', gh, git, cap = LANDED_CAP }) {
  const read = readLandings({ members, gh });
  // Newest first, by the forge's own monotone number: a cap that has to hide a
  // landing hides the oldest, because the seam that moved this morning is the
  // one the next worker steps on.
  const ordered = [...read.landings].sort((a, b) => b.pr - a.pr);
  const carried = ordered.slice(0, Math.max(0, cap));
  const hidden = ordered.length - carried.length;

  const described = carried.map(landing => {
    if (String(landing.repo).toLowerCase() !== String(slug).trim().toLowerCase()) {
      return {
        ...landing,
        surfaces: '',
        surfacesReason: `NOT READ — it landed in another repository (${landing.repo}), which this checkout does not hold`,
      };
    }
    const surfaces = surfacesOf({ sha: landing.sha, git });
    return { ...landing, surfaces: surfaces.text, surfacesReason: surfaces.reason };
  });

  const notes = [
    `landed facts  ${read.landings.length} landing(s) established for this Spec, ${read.unread.length} unread; ${described.length} carried into this dispatch's notes`,
  ];
  for (const entry of read.unread) notes.push(`  NOT ESTABLISHED — ${entry.detail}${entry.repair ? ` — ${entry.repair}` : ''}`);
  for (const landing of described) {
    if (landing.surfacesReason !== '') notes.push(`  surfaces of PR #${landing.pr} — ${landing.surfacesReason}`);
  }

  return { text: renderLanded({ landings: described, unread: read.unread, slug, hidden }), notes };
}

/**
 * THE WHOLE PATH, for the one caller that composes a brief: the dispatched
 * ticket → its Spec → that Spec's members → their established landings → the
 * text the notes channel carries, plus the accounting the dispatching session
 * prints.
 *
 * `membership` is the SHARED Spec-membership reader, injected — one question,
 * one owner (`src/completion.mjs`'s `specMembership`). This module never
 * implements it and never asks the tracker for a member set: two readers of
 * "who is in this Spec" is how one of them starts including a ticket the other
 * excludes. It is called as that reader declares itself, with `run` taking gh
 * argv, and only its `members` half is consumed — its `comments` are the
 * mandate's business, not this channel's.
 *
 * WHAT REACHES THE CHILD WHEN A READ FAILED, and why it is not silence. A
 * dispatch whose derivation could not establish anything renders the inability
 * INTO the channel: absence of the section is indistinguishable from "this Spec
 * landed nothing", and a worker who concludes that rebases onto a base that
 * moved this morning. The one absence that is rendered as nothing is a ticket
 * PROVEN to have no parent — there is no Spec to scope, so there is no claim to
 * make.
 */
export function landedNotes({ ticket, slug = '', gh, git, membership, cap = LANDED_CAP }) {
  const number = Number(ticket?.number);
  const repo = String(ticket?.repo ?? slug).trim() || String(slug).trim();
  const cannot = (why, repair) => ({
    text: renderLanded({ unread: [{ ref: '', detail: why }], slug }),
    notes: [`landed facts  NOT ESTABLISHED — ${why}${repair ? ` — ${repair}` : ''}`],
  });
  if (!Number.isSafeInteger(number) || number <= 0 || repo === '') {
    // A dispatch with no GitHub ticket (`--name`, or a Linear ref, which carries
    // no parent edge this read can follow) belongs to no Spec here, and a
    // checkout nothing can name has no tracker to ask. Neither is a failure to
    // announce to the child: there is no Spec-scoped fact to be missing.
    return {
      text: '',
      notes: ['landed facts  not derived: no GitHub ticket in a named repository scopes this dispatch, and a Spec is read from GitHub’s own parent edge'],
    };
  }

  const spec = specOf({ number, slug: repo, gh });
  if (!spec.ok) return cannot(spec.why, spec.repair);
  if (spec.spec === null) {
    return { text: '', notes: [`landed facts  not derived: ${repo}#${number} has no parent Spec, so no Spec-scoped landing is in scope for it`] };
  }

  const [owner, name] = spec.spec.repo.split('/');
  const read = membership(spec.spec.number, { run: args => gh(args), slug: spec.spec.repo, owner, name });
  if (read?.ok !== true) {
    return cannot(
      `the Spec read for ${spec.spec.repo}#${spec.spec.number} could not establish its members${read?.kind === 'absent' ? ' (this tracker has no such Spec)' : ''}: ${clean(read?.why)}`,
      read?.repair ?? '',
    );
  }
  const members = read.members;
  if (members?.ok !== true) return cannot(`${spec.spec.repo}#${spec.spec.number}: ${clean(members?.why)}`, members?.repair ?? '');
  if (!Array.isArray(members.nodes)) {
    return cannot(`the Spec read for ${spec.spec.repo}#${spec.spec.number} answered no member list — an absent container is not an empty one`, '');
  }

  const answered = landedFor({
    members: members.nodes.map(node => ({ repo: node?.repo ?? spec.spec.repo, number: node?.number })),
    slug,
    gh,
    git,
    cap,
  });
  return {
    text: answered.text,
    notes: [`landed facts  scoped by ${spec.spec.repo}#${spec.spec.number} (${members.nodes.length} member(s))`, ...answered.notes],
  };
}
