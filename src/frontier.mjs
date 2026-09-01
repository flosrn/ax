// `ax frontier` — the takeable ticket set, derived from tracker truth in one receipt.
//
// WHY THIS VERB EXISTS. Before it, the orchestrator derived the frontier by
// hand every wake: raw `gh issue list`, one `gh issue view` per ticket for its
// blockers, a mental cross-reference against the dispatch store — judgment
// spent on mechanics, and a re-derivation that drifted between sessions. This
// verb answers the one question the orchestrator asks at every wake — "what can
// I dispatch right now, and why not the rest?" — with the same three-part
// grammar the merge gate already taught it: reported, unread, refused.
//
// THE RECEIPT IS A TRIAD, and the lists are structurally distinct:
//   takeable          every blocker closed, no exclusion — dispatchable now
//   excluded          one NAMED reason each: blocked-by:<refs>, is-spec-parent,
//                     provenance-refused, already-dispatched,
//                     attempt-ended-unmerged, untrusted-labeler
//   cannot-establish  the read that failed, named — NEVER folded into either
//                     list above. Tracker data this verb cannot obtain is an
//                     inability to establish, not an empty frontier (F-028).
//
// `already-dispatched` keys on an UNSETTLED record only. A settled record whose
// ticket is still open classifies `attempt-ended-unmerged` — a dead or
// abandoned attempt stays VISIBLE instead of vanishing from the loop, which is
// what lets the AFK cycle's termination condition ("takeable, attempt-ended-
// unmerged and cannot-establish all empty") mean finished rather than stalled.
//
// `untrusted-labeler`: the ready label is the tracker's assertion that a ticket
// is a complete assignment, and on a public repository anyone can apply it. A
// label applied by an actor without repository write permission is excluded —
// the ticket body would otherwise become verbatim instruction to a worker with
// no human left in the path.
//
// This verb READS and classifies; it never dispatches, never mutates, and
// consults the dispatch store read-only. gh ≥ 2.97 is the floor — 2.94 added
// `blockedBy`/`blocking`, 2.97 the `parent`/`subIssues` fields — and an older
// gh is cannot-establish naming the version, never a silent fallback.
//
// EXIT CODES (ADR 0003 — per verb, never a shared alphabet)
//   0  receipt produced — including one whose takeable list is empty
//   2  usage error
//   3  cannot establish at the declaration level: no checkout, unreadable
//      config, gh below the floor, tracker unreachable. Never an empty receipt.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoPaths } from './config.mjs';
import { defaultExec } from './exec.mjs';
import { repoSlug } from './gh.mjs';
import { bad, fix, note, ok, section } from './log.mjs';
import { clean, must, payload, succeeded } from './pr-grounds.mjs';
import { READY_LABEL } from './triage/spec.mjs';
import { defaultStore } from './worker/record.mjs';

const USAGE = 'ax frontier [--dry-run]';

const CONFIG_FILE = 'ax.config.json';

/** The gh floor: `parent`/`subIssues` and the dependency fields it stands on. */
const GH_FLOOR = [2, 97];

/** Case-insensitive label identity — same rule as triage's `sameLabel`. */
const sameLabel = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * The `triage` block alone, read from the checkout's own config — the same
 * one-key discipline as `pr gate`'s `declarationOf`: this verb consumes the
 * provenance mapping and nothing else, so it judges nothing else. A config
 * that EXISTS but does not parse is cannot-establish: the repository declared
 * a vocabulary and this run cannot read it, which is not the same repository
 * as one that declared nothing.
 */
function triageDeclaration({ root, main }) {
  const candidates = [root, main].filter((dir, index, all) => dir && all.indexOf(dir) === index);
  for (const dir of candidates) {
    const path = join(dir, CONFIG_FILE);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return { ok: true, triage: parsed?.triage, path };
    } catch (error) {
      return { ok: false, path, reason: `not readable JSON (${String(error.message ?? error).slice(0, 120)})` };
    }
  }
  return { ok: true, triage: undefined, path: join(root, CONFIG_FILE) };
}

/** `gh version 2.97.0 (…)` → [2, 97, 0], or null when the line is not gh's. */
export function ghVersionOf(stdout) {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(String(stdout ?? ''));
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

const meetsFloor = ([major, minor]) => major > GH_FLOOR[0] || (major === GH_FLOOR[0] && minor >= GH_FLOOR[1]);

/**
 * One aliased issue read per candidate, one round-trip for all of them. The
 * query carries identifiers only — owner, name and issue numbers — never any
 * contributor-authored text (D-030).
 */
function frontierQuery(owner, name, numbers) {
  const fields = numbers
    .map(
      n =>
        `i${n}: issue(number: ${n}) { number state ` +
        `subIssues(first: 1) { totalCount } ` +
        `blockedBy(first: 50) { nodes { number state } pageInfo { hasNextPage } } ` +
        `timelineItems(itemTypes: [LABELED_EVENT], last: 100) { nodes { ... on LabeledEvent { label { name } actor { login } } } } }`,
    )
    .join(' ');
  return `query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`;
}

/**
 * The dispatch store's answer about one candidate, read-only — derived from
 * the request ids dispatches RECORD, never synthesized into one filename.
 * `requestIdFor(issue, slug)` composes every id as `<issue>-<suffix>` (the
 * suffix is a human slug or `work`, never the repository), and `--resume`
 * already stands on that leading component; so membership here is the same
 * rule: every record whose name begins `<number>-`. Absence is the one clean
 * "no record" answer; an unreadable or malformed record is an inability to
 * establish, never permission to classify (F-001's rule, applied to a read).
 */
function dispatchStateOf(names, store, number) {
  const prefix = `${number}-`;
  let settledSeen = false;
  for (const name of names.filter(entry => entry.startsWith(prefix) && entry.endsWith('.json')).sort()) {
    const path = join(store, name);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      const attempts = must(record, 'attempts', 'dispatch record');
      if (!Array.isArray(attempts) || attempts.length === 0) throw new Error('dispatch record: attempts is not a non-empty list');
      const settled = must(attempts[attempts.length - 1], 'settled', 'last attempt');
      if (settled !== true) return { state: 'unsettled' };
      settledSeen = true;
    } catch (error) {
      return { state: 'unreadable', reason: String(error.message ?? error).slice(0, 160), path };
    }
  }
  return settledSeen ? { state: 'settled' } : { state: 'none' };
}

/**
 * Who applied the CURRENT ready label — the newest labeled event naming it.
 * No matching event in the window is an unattributable label, which is an
 * unknown, not a trusted one.
 */
function readyLabelerOf(timelineNodes, label) {
  let labeler = null;
  for (const node of timelineNodes) {
    if (node !== null && typeof node === 'object' && node.label && sameLabel(node.label.name ?? '', label)) {
      labeler = node.actor?.login ?? null;
    }
  }
  return labeler;
}

export function frontier(argv = [], { gh = (args, at) => defaultExec('gh', args, at), env = process.env, cwd = process.cwd() } = {}) {
  const usageError = message => {
    process.stderr.write(`ax frontier: ${message}\n${USAGE}\n`);
    return 2;
  };
  /** Fatal before any candidate could be classified: nothing is claimed. */
  const cannot = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    if (repair) fix(repair);
    return 3;
  };

  // Identifiers and flags only. `--dry-run` follows `init`/`pin`: name what
  // would be read, touch nothing — here that means NO gh call at all, which is
  // also what lets the AGENTS-block liveness test exercise this verb offline.
  let dry = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dry = true;
    else return usageError(`unknown argument "${arg}"`);
  }

  const paths = repoPaths(cwd);
  if (!paths.root) {
    return cannot('not inside a git repository, so this checkout names no tracker to read', 'cd into the checkout whose frontier you want, then re-run');
  }

  const declared = triageDeclaration(paths);
  if (!declared.ok) {
    return cannot(
      `${declared.path} is ${declared.reason} — the declared label vocabulary cannot be read, and guessing it would classify with the wrong project's words`,
      `cat ${declared.path}   # repair the JSON, then re-run`,
    );
  }
  const provenance = declared.triage?.provenance;
  const specLabels = Array.isArray(provenance?.spec) ? provenance.spec : [];
  const inboundLabels = Array.isArray(provenance?.inbound) ? provenance.inbound : [];

  if (dry) {
    section(`frontier — dry run (nothing read from the tracker)`);
    note(`would probe   gh ≥ ${GH_FLOOR.join('.')} (blockedBy/parent/subIssues floor)`);
    note(`would list    open issues carrying ${READY_LABEL}`);
    note(`would batch   one GraphQL round-trip: blockedBy, subIssues, labeled events per candidate`);
    note(`would cross   the dispatch store read-only: unsettled → already-dispatched, settled → attempt-ended-unmerged`);
    return 0;
  }
  const run = args => gh(args, paths.root);

  // ── The floor. Below it the dependency fields do not answer, and a frontier
  // read without blockers is not a frontier read.
  const versionOut = run(['--version']);
  const version = succeeded(versionOut) ? ghVersionOf(versionOut.stdout) : null;
  if (version === null) {
    return cannot("could not read gh's version, and the dependency fields this verb stands on arrived in 2.97", 'gh --version   # then re-run');
  }
  if (!meetsFloor(version)) {
    return cannot(
      `gh ${version.join('.')} is below 2.97, which added the blockedBy/parent/subIssues reads this verb stands on`,
      'upgrade gh to ≥ 2.97, then re-run',
    );
  }

  const slug = repoSlug(run);
  if (slug === '') {
    return cannot("could not resolve this checkout's repository", 'gh auth status   # then re-run from a checkout with a GitHub remote');
  }
  const [owner, name] = slug.split('/');

  // ── Candidates: every OPEN issue carrying the ready label. An unreachable
  // tracker stops here — an empty answer from a failed read is not an empty
  // frontier (F-028).
  const listed = payload(run(['issue', 'list', '--repo', slug, '--state', 'open', '--label', READY_LABEL, '--json', 'number,title,labels', '--limit', '200']));
  if (!listed.ok) {
    return cannot(`'gh issue list --label ${READY_LABEL}' ${listed.reason}`, `gh issue list --repo ${slug} --label ${READY_LABEL}   # read it by hand`);
  }
  if (!Array.isArray(listed.value)) {
    return cannot('gh answered no issue list — an absent container is not an empty one', `gh issue list --repo ${slug} --label ${READY_LABEL}`);
  }

  const candidates = listed.value
    .map(row => ({ number: Number(row?.number), title: clean(row?.title), labels: (row?.labels ?? []).map(label => String(label?.name ?? '')) }))
    .filter(candidate => Number.isSafeInteger(candidate.number) && candidate.number > 0)
    .sort((a, b) => a.number - b.number);

  section(`frontier — ${slug} (${READY_LABEL})`);
  note(`candidates  ${candidates.length} open issue(s) carrying the label`);

  const takeable = [];
  const excluded = [];
  const unestablished = [];

  if (candidates.length > 0) {
    // ── One batched round-trip: state, sub-issues, blockers and the labeled
    // events, aliased per candidate.
    const answered = payload(run(['api', 'graphql', '-f', `query=${frontierQuery(owner, name, candidates.map(candidate => candidate.number))}`]));
    if (!answered.ok) {
      return cannot(`the batched blocker read ${answered.reason}`, `gh api graphql   # the aliased blockedBy read failed for every candidate`);
    }

    const store = defaultStore(env);
    // The store listing, read ONCE for the run: the per-candidate question is a
    // filter over one directory that does not change mid-receipt.
    let storeNames = [];
    try {
      storeNames = readdirSync(store);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return cannot(`the dispatch store at ${store} is unreadable (${String(error.message ?? error).slice(0, 160)})`, `ls ${store}`);
      }
    }

    /** One permission read per unique labeler, cached for the run. */
    const permissionCache = new Map();
    const writeAccess = login => {
      if (!permissionCache.has(login)) {
        const answer = payload(run(['api', `repos/${slug}/collaborators/${login}/permission`]));
        permissionCache.set(login, answer.ok ? ['admin', 'write'].includes(String(answer.value?.permission ?? '')) : null);
      }
      return permissionCache.get(login);
    };

    for (const candidate of candidates) {
      const issue = answered.value?.data?.repository?.[`i${candidate.number}`];
      if (issue === undefined || issue === null) {
        unestablished.push({ ...candidate, read: `the batched read answered nothing for #${candidate.number}`, repair: `gh issue view ${candidate.number} --repo ${slug}` });
        continue;
      }

      // is-spec-parent: a parent is the wave's grouping artifact, not a ticket.
      let subIssueCount;
      try {
        subIssueCount = Number(must(must(issue, 'subIssues', `issue #${candidate.number}`), 'totalCount', 'subIssues'));
      } catch (error) {
        unestablished.push({ ...candidate, read: String(error.message ?? error), repair: `gh issue view ${candidate.number} --repo ${slug} --json subIssues` });
        continue;
      }
      if (subIssueCount > 0) {
        excluded.push({ ...candidate, reason: 'is-spec-parent' });
        continue;
      }

      // provenance-refused: the repository's own vocabulary contradicts itself
      // on this ticket — spec-born AND inbound at once. Only measured where the
      // mapping is declared; an undeclared ground is NOT measured (the
      // repository is input).
      const spec = specLabels.filter(declaredName => candidate.labels.some(carried => sameLabel(declaredName, carried)));
      const inbound = inboundLabels.filter(declaredName => candidate.labels.some(carried => sameLabel(declaredName, carried)));
      if (spec.length > 0 && inbound.length > 0) {
        excluded.push({ ...candidate, reason: `provenance-refused (carries ${spec[0]} and ${inbound[0]} at once)` });
        continue;
      }

      // untrusted-labeler: who applied the ready label, and can they write?
      const timeline = issue.timelineItems?.nodes;
      if (!Array.isArray(timeline)) {
        unestablished.push({
          ...candidate,
          read: `the labeled-event read answered no timeline for #${candidate.number}`,
          repair: `gh api repos/${slug}/issues/${candidate.number}/timeline`,
        });
        continue;
      }
      const labeler = readyLabelerOf(timeline, READY_LABEL);
      if (labeler === null) {
        unestablished.push({
          ...candidate,
          read: `no labeled event attributes ${READY_LABEL} on #${candidate.number} — an unattributable label is an unknown, not a trusted one`,
          repair: `gh api repos/${slug}/issues/${candidate.number}/timeline   # find who applied the label`,
        });
        continue;
      }
      const trusted = writeAccess(labeler);
      if (trusted === null) {
        unestablished.push({
          ...candidate,
          read: `the permission read for ${clean(labeler)} failed`,
          repair: `gh api repos/${slug}/collaborators/${clean(labeler)}/permission`,
        });
        continue;
      }
      if (trusted === false) {
        excluded.push({ ...candidate, reason: `untrusted-labeler (${clean(labeler)} has no write permission)` });
        continue;
      }

      // Dispatch state, read-only from the store. Unsettled → a live attempt
      // owns this ticket; settled with the ticket still open → the attempt
      // ended without a merge, and the loop must SEE that.
      const dispatched = dispatchStateOf(storeNames, store, candidate.number);
      if (dispatched.state === 'unreadable') {
        unestablished.push({ ...candidate, read: `the dispatch record at ${dispatched.path} is unreadable (${dispatched.reason})`, repair: `cat ${dispatched.path}` });
        continue;
      }
      if (dispatched.state === 'unsettled') {
        excluded.push({ ...candidate, reason: 'already-dispatched' });
        continue;
      }
      if (dispatched.state === 'settled') {
        excluded.push({ ...candidate, reason: 'attempt-ended-unmerged' });
        continue;
      }

      // Blockers, last: a truncated page proves the set is UNKNOWN, and fifty
      // read blockers say nothing about the fifty-first.
      let blockerPage;
      try {
        blockerPage = must(issue, 'blockedBy', `issue #${candidate.number}`);
      } catch (error) {
        unestablished.push({ ...candidate, read: String(error.message ?? error), repair: `gh issue view ${candidate.number} --repo ${slug} --json blockedBy` });
        continue;
      }
      if (blockerPage.pageInfo?.hasNextPage === true) {
        unestablished.push({
          ...candidate,
          read: `the blocker read for #${candidate.number} truncated at 50 (hasNextPage) — the unread remainder can hold an open blocker`,
          repair: `gh issue view ${candidate.number} --repo ${slug} --json blockedBy   # page the rest`,
        });
        continue;
      }
      const blockers = Array.isArray(blockerPage.nodes) ? blockerPage.nodes : null;
      if (blockers === null) {
        unestablished.push({ ...candidate, read: `the blocker read answered no nodes for #${candidate.number}`, repair: `gh issue view ${candidate.number} --repo ${slug} --json blockedBy` });
        continue;
      }
      const open = blockers.filter(blocker => String(blocker?.state ?? '').toUpperCase() !== 'CLOSED').map(blocker => `#${blocker?.number}`);
      if (open.length > 0) {
        excluded.push({ ...candidate, reason: `blocked-by:${open.join(',')}` });
        continue;
      }
      const closedRefs = blockers.map(blocker => `#${blocker?.number}`);
      takeable.push({ ...candidate, proof: closedRefs.length === 0 ? 'no blockers declared' : `blockers ${closedRefs.join(',')} all closed` });
    }
  }

  // ── The receipt. Three lists, all printed, none folded into another.
  section(`takeable — ${takeable.length}`);
  for (const entry of takeable) ok(`#${entry.number} ${entry.title} — ${entry.proof}`);

  section(`excluded — ${excluded.length}`);
  for (const entry of excluded) note(`#${entry.number} ${entry.title} — ${entry.reason}`);

  section(`cannot establish — ${unestablished.length}`);
  for (const entry of unestablished) {
    bad(`CANNOT ESTABLISH — #${entry.number}: ${entry.read}`);
    fix(entry.repair);
  }

  return 0;
}
