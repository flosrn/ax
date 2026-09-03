// `ax worker release` — close the agent pane of a session whose work has PROVABLY landed.
//
// WHY THIS EXISTS (measured 2026-08-10)
// 106 supervised workers against 7 live terminals. Nothing closed them, because
// the gesture that closes a landed pane is the same gesture that kills a working
// session — so nobody ran it. This verb is that gesture, made safe enough to run.
//
// THE RULE THE WHOLE FILE IS BUILT ON
// A pane closes because the WORK LANDED, never because the session said it was
// done. On 2026-08-09 a peer message announced "ws-1787 finished its work" while
// the child had sent no worker_done at all, its terminal was running and its
// branch carried zero commits (F-043). The signal had no sender. What saved that
// child was `git log origin/main..HEAD` returning nothing — an artifact
// question, not a status question. The mirror error costs as much: a real child
// sat legitimately silent for 26.8 minutes inside a CI loop (F-012), so silence
// proves nothing either.
//
// WHAT COUNTS AS LANDED, PER KIND OF SESSION
//   triage / brief    a comment on that issue, created AFTER the dispatch
//   implementation    a MERGED pull request for that branch. Nothing else.
// An OPEN PR is deliberately NOT proof: that session may still owe its CI loop
// and its review threads, and closing its pane is how a P1 waiting in a review
// comment goes unanswered (F-031). Commits with no PR show the work started, not
// that it shipped. An empty `git diff base..branch` was offered here once as a
// squash-safe second route and is gone: it holds only while the base tip's tree
// still equals the branch tip's, so one unrelated commit on the base makes it
// non-empty forever — `ok` for a few minutes after a squash, KEEP for the rest
// of time. A rule that reads as a safety property and is really an accident of
// timing is worse than no rule.
//
// CLASSIFY BY CAUSE, NEVER INTO A RESIDUAL
// The bash era reported `0 closeable · 1 kept · 80 with no pane to close`, and
// those eighty mixed terminals the operator had already released, corpses of
// failed attempts, and workers that never recorded a terminal at all — three
// causes needing three different answers, counted as one. A report whose
// dominant line leads to no action is a report that stops being read. So every
// category below names itself, carries its own count, and names its repair.
//
// Two of those causes were themselves measured wrong, and both are fixed here
// against this machine (2026-08-22, Orca 1.4.185, 218 workers, 5 live panes):
//   * the agent handle lives at `agentTerminalHandle` (217 of 218 rows) and only
//     sometimes also under `resource.terminalHandle` (132). The bash classifier
//     read the resource key alone, so 86 workers reported "no terminal
//     recorded". That is where the eighty came from.
//   * `terminalState` has six values, not two: `release_pending` is a release in
//     flight and `release_unknown` is one Orca cannot account for. Folding them
//     into "already released" hides the only rows an operator must chase.
//
// LIVENESS IS MOVEMENT, NOT CONTENT (F-041)
// A pane that has ever printed a line is not therefore working — reading it that
// way made every session that had printed anything permanently unclosable. Each
// candidate is sampled twice, `--gap` seconds apart, and only a CHANGED cursor
// counts as working. The read goes through ./pane.mjs, which never composes
// `--lines`: that flag returns an empty read rather than a shorter one, so a
// live pane, a dead one and a misread one all answer zero.
//
// WHAT IT NEVER DOES
//   * release a worker whose pane is already gone. That call returns ok:true
//     with `processAction: none` and merely moves the row from reclaimable to
//     retained; 36 of them were issued in one campaign — churn that reads
//     exactly like work.
//   * release a worker that is not settled. Orca refuses (`only a succeeded or
//     failed worker can release`), and cancelling a live session is a different
//     decision, which this verb never makes: it names `worker-stop` and stops.
//   * release a pane on another execution host: `worker-release` answers
//     `federation_unsupported` and retains the pane (measured 2026-08-14). That
//     row names `orca terminal close --environment <env>` instead.
//   * remove a worktree, delete a branch, or touch git state. Ever.
//
// EVERY CLOSE IS WRITE-AHEAD (F-001)
// A release is a mutation, so it follows the protocol a dispatch follows: the
// argv and the minted `--retry-request` identity land on disk BEFORE the call,
// and a recovery REPLAYS that record byte for byte rather than minting a second
// identity. Records live under `<store>/release/` because the reader verbs
// enumerate `<store>/*.json`: a release must be auditable without showing up in
// `ax worker ls` as a dispatch that never started. A lost claim is not an error
// and never a re-mint — it means another caller owns that release, and the safe
// move is that caller's record.
//
// A `release_unknown` IS A SCAR THIS VERB CANNOT CLEAR, AND IT SAYS WHY (#100)
// Both sites that report one — the live release's non-zero exit and the swept
// row — print the receipt's own `lastError` and `recovery` verbatim, and name
// the operator's fresh-identity call as the repair. Orca's own prescription
// (repeat with the SAME `--retry-request`) defeats itself: `release_unknown` is
// a returned result, so the request is completed in the mutation ledger and
// every later call is replayed from it. The escape needs a new identity, which
// the rule above forbids ax from minting, so the honest repair is a command the
// operator runs — never a `worker-show`, which is a look and not an action.
//
// DEFAULT IS A REPORT. Nothing closes without --close.
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  report printed, or every attempted release settled
//   1  at least one release did not settle — refused, or nobody knows
//   2  usage error
//   3  cannot-establish: no Orca CLI, a silent runtime, an unreadable inventory,
//      no `gh` to prove landing with, or no repository to scope the sweep to

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultExec } from '../exec.mjs';
import { repoView } from '../gh.mjs';
import { createRunner, parseReceipt, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok, raw, section } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { paneReadable, readPane, terminalInventory } from './pane.mjs';
import {
  argvValue,
  claimRecord,
  defaultStore,
  dispatchIndex,
  initRecord,
  newIdentity,
  phaseArgv,
  phaseBegin,
  phaseCount,
  phaseEnd,
  phaseExit,
  phaseVerdict,
  requestIdOk,
  attemptSettle,
} from './record.mjs';
import { physical, withinPath } from '../worktree/locate.mjs';

const USAGE =
  'ax worker release [--all] [--close] [--dispatch <id>] [--no-proof] [--base <ref>] [--gap <s>] [--store <dir>]';

/**
 * The command names that may be replayed as a program. `resolveOrca` produces
 * exactly these three, plus whatever `ORCA_CLI_COMMAND`/`ORCA_BIN` names — and a
 * caller who set that variable is already choosing the binary, so an absolute
 * path ending in one of them is honoured too.
 */
const ORCA_BINARY = /(^|\/)(orca|orca-ide|orca-dev)$/;

/*
 * `--help` is not answered here. `runCli` answers it from the registry, anywhere
 * in this noun's argv, before the verb is reached (../cli.mjs, #89) — a second
 * code path answering one question is how twenty subverbs came to answer it
 * five different ways, three of them by running (#93).
 *
 * The long `HELP` string that used to sit here is gone rather than moved: it
 * restated, in twenty lines, what proof is and what is never proof — the header
 * above, which this repository treats as the authority for a module's doctrine.
 * The registry keeps the one line a caller reads before typing: `close a landed
 * pane — proven by artifact, never by a word` (../commands.mjs).
 */

/** The store namespace release records live in — never beside the dispatches. */
export const RELEASE_NS = 'release';

/**
 * Orca settles a worker as `succeeded` or `failed`; only those may be released.
 *
 * This set is read from Orca's source and must not be widened. Its own
 * `WORKER_RELEASABLE_STATES` is exactly `['succeeded', 'failed']`
 * (orchestration/worker-terminal-ownership.ts, fork at ~/Code/flosrn/orca), and
 * `stopped`/`abandoned` — which ARE in its wider `WORKER_SETTLED_STATES` — are
 * answered `retained · identity_unproven` by `requestWorkerTerminalRelease`
 * (worker-terminal-release.ts:58). Adding them here would print a repair that
 * cannot land, which is the defect this file has now paid for twice.
 */
const SETTLED = new Set(['succeeded', 'failed']);

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

const firstLine = text => String(text ?? '').split('\n')[0].trim();
const landed = detail => ({ landed: true, detail });
const missing = detail => ({ landed: false, detail });

/**
 * What a `release_unknown` receipt SAID, and the repair that is honest about it.
 *
 * Measured on #100: the receipt Orca answered carried both `lastError` ("the
 * agent terminal was closed but its process could not be confirmed stopped …")
 * and `recovery` (Orca's own instruction), and this verb printed neither — the
 * operator read `exit 1: Orca cannot account for this release`, no reason, and a
 * repair line that only INSPECTED. A `worker-show` is a look, not an action, and
 * this repository's rule is that every finding names its repair.
 *
 * Both fields are printed VERBATIM. They are the runtime's sentences about a
 * mutation ax cannot re-enter, and paraphrasing them here would put a third
 * account of one event beside the receipt and the resource row.
 *
 * A receipt carrying NEITHER field is a receipt with no reason in it, and it
 * says so: silence would read as "ax dropped it", which is exactly the defect
 * this pays off. That sentence is NOT reused for a release this host never
 * recorded — an unread receipt is not an unexplained one (F-028), so the two
 * have separate wordings.
 *
 * THE REPAIR, and why it is not the receipt's own `recovery`. Orca prescribes
 * repeating the release with the SAME `--retry-request`, but `release_unknown`
 * is a returned result rather than a throw, so the mutation executor recorded
 * the request as completed and serves every later call from its ledger
 * (`replayed: true`) without re-entering the release. Its own advice defeats
 * itself. The server-side escape is one identity away — `requestWorkerTerminalRelease`
 * accepts a row in `unknown` — and ax may not mint that identity: F-001, stated
 * in this file's header, is why a recovery replays the recorded request byte for
 * byte. So the honest repair is the operator's own fresh-identity call, named
 * rather than implied, beside the inspection that shows the state it is in.
 */
const NO_REASON = 'no reason given by the runtime';

const UNREAD_REASON = 'no release receipt on this host to read a reason from';

const receiptReason = result => {
  const lastError = String(result?.lastError ?? '').trim();
  const recovery = String(result?.recovery ?? '').trim();
  if (lastError === '' && recovery === '') return NO_REASON;
  return [lastError, recovery === '' ? '' : `Orca's recovery: ${recovery}`].filter(part => part !== '').join(' · ');
};

const releaseRepair = dispatchId =>
  `orca orchestration worker-release --dispatch ${dispatchId} --retry-request "$(node -p "require('crypto').randomUUID()")" --json   # a FRESH identity is the only thing that re-enters this release: the recorded one is completed in Orca's ledger and is replayed from it, and ax may not mint a second identity (F-001). node mints it because ax already requires node and nothing else is guaranteed on the host. Read it first with orca orchestration worker-show --dispatch ${dispatchId} --json`;

/**
 * The result of the last recorded `worker-release` phase for this dispatch, or
 * null when this host has no readable record of one. Read from the record this
 * verb writes itself (`<store>/release/<dispatch>.json`), because a swept row
 * comes from `worker-list`, which reports the STATE and not the sentence.
 */
function recordedReleaseResult(dir, dispatchId) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(dir, `${dispatchId}.json`), 'utf8'));
  } catch {
    return null;
  }
  const phases = rec?.attempts?.[rec.attempts.length - 1]?.phases ?? [];
  for (const phase of [...phases].reverse()) {
    if (phase?.name !== 'worker-release') continue;
    const result = phase.receipt?.result;
    if (result !== null && typeof result === 'object') return result;
  }
  return null;
}

/**
 * Orca's own worker inventory. The handle is read from BOTH keys it has been
 * seen under, newest first: `agentTerminalHandle` is the one the current runtime
 * fills, `resource.terminalHandle` the one the bash classifier read alone.
 */
function workerInventory(run) {
  const out = run(['orchestration', 'worker-list', '--json']);
  const receipt = out.receipt ?? {};
  if (out.status !== 0 || receipt.ok !== true || !('result' in receipt)) {
    const detail = receipt.unparseable ?? out.stderr ?? '';
    return { ok: false, reason: `orca orchestration worker-list did not answer (exit ${out.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}` };
  }
  if (!Array.isArray(receipt.result.workers)) {
    return { ok: false, reason: 'orca orchestration worker-list answered without a "workers" list — an absent container is not an empty machine (F-028)' };
  }

  const rows = [];
  for (const worker of receipt.result.workers) {
    if (worker === null || typeof worker !== 'object') continue;
    if (typeof worker.dispatchId !== 'string' || worker.dispatchId === '') continue;
    const resource = worker.resource !== null && typeof worker.resource === 'object' ? worker.resource : {};
    const worktreeId = typeof resource.worktreeId === 'string' ? resource.worktreeId : '';
    rows.push({
      dispatchId: worker.dispatchId,
      workerState: worker.workerState ?? '?',
      terminalState: worker.terminalState ?? '?',
      handle: (typeof worker.agentTerminalHandle === 'string' && worker.agentTerminalHandle) || (typeof resource.terminalHandle === 'string' && resource.terminalHandle) || '',
      // WHO Orca thinks owns the pane, and it decides which command can free it:
      // `worker-stop` refuses a `user_owned` terminal outright, answering
      // `processAction: "none"` (measured 2026-08-26). Absent on many rows, so
      // it stays '' rather than defaulting to a value that authorizes anything.
      ownership: typeof resource.ownershipState === 'string' ? resource.ownershipState : '',
      worktree: worktreeId.split('::').pop() ?? '',
      known: true,
    });
  }
  return { ok: true, rows };
}

/**
 * The dispatches this host recorded that Orca's inventory does not mention.
 *
 * F-048: a `worker-start` repaired with `--inject` produces a Dispatch without
 * touching worker terminal accounting, so its pane is invisible to the cap AND
 * to this sweep — the release that would clear it is the one thing that never
 * gets offered. They are added with `known: false` so every line says which
 * inventory answered for it.
 */
function unaccounted(index, seen) {
  const rows = [];
  for (const [dispatchId, entry] of index.byDispatch) {
    if (seen.has(dispatchId) || entry.handle === null || !entry.ready) continue;
    rows.push({
      dispatchId,
      workerState: 'absent',
      terminalState: 'absent',
      handle: entry.handle,
      ownership: '',
      worktree: '',
      known: false,
    });
  }
  return rows;
}

// ── proof ────────────────────────────────────────────────────────────────────

/** A comment on that issue, created AFTER the dispatch. Nothing else. */
function proveIssue(gh, { repo, number, issuedAt }) {
  if (!repo) return missing('no repo to query');
  if (issuedAt === null) return missing('the record carries no readable dispatch date');
  const out = gh(['issue', 'view', String(number), '--repo', repo, '--json', 'comments']);
  if (out.error) return missing(`gh could not run: ${String(out.error.message ?? out.error)}`);
  if (out.status !== 0) return missing(`gh refused — ${firstLine(out.stderr) || `exit ${out.status}`}`);
  const body = parseReceipt(out.stdout);
  if (!Array.isArray(body.comments)) return missing(`gh answered no comments array for #${number}`);
  const newest = body.comments.reduce((max, comment) => {
    const at = Date.parse(comment?.createdAt ?? '');
    return Number.isFinite(at) && at > max ? at : max;
  }, -1);
  if (newest < 0) return missing(`no comment on #${number}`);
  return newest > issuedAt ? landed(`comment on #${number} after dispatch`) : missing(`newest comment on #${number} predates dispatch`);
}

/**
 * A merged PR whose head ref IS that slug, or ends with `/<slug>`. Exactness is
 * ranked and a substring rank is deliberately absent: it made `wizard-178` match
 * `feat/wizard-1788` and reported it as proof. A near-miss must find nothing,
 * and a tie at the winning rank is ambiguity rather than a guess.
 */
function mergedPrFor(gh, { repo, slug }) {
  const out = gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '200', '--json', 'number,headRefName']);
  if (out.error) return missing(`gh could not run: ${String(out.error.message ?? out.error)}`);
  if (out.status !== 0) return missing(`gh refused — ${firstLine(out.stderr) || `exit ${out.status}`}`);
  const list = parseReceipt(out.stdout);
  if (!Array.isArray(list)) return missing('gh answered an unreadable merged-PR list');

  for (const predicate of [head => head === slug, head => head.endsWith(`/${slug}`)]) {
    const hits = list.filter(pr => predicate(String(pr?.headRefName ?? '')));
    if (hits.length === 1) return landed(`PR #${hits[0].number} merged (${hits[0].headRefName}, worktree gone)`);
    if (hits.length > 1) return missing(`'${slug}' matches ${hits.slice(0, 4).map(pr => `#${pr.number}`).join(',')}`);
  }
  return missing(`no merged PR for '${slug}', worktree gone`);
}

/**
 * Did an implementation land? A MERGED pull request, and nothing else.
 *
 * THE WORKTREE IS USUALLY GONE, and that is the normal state of the case this
 * exists for: after `gh pr merge` the repo's own cleanup removes it — measured
 * 15 of 15 implementation worktrees absent. An earlier revision opened with a
 * directory check and answered `no worktree to inspect`, which made the
 * post-merge pane permanently unclosable: the feature refused precisely the
 * situation it was asked for.
 *
 * No call below hides its stderr. A refused `git` formats exactly like good
 * news, and two audits concluded "nothing to save" that way before a third found
 * 116 unpushed commits.
 */
function proveLanded(gh, git, { repo, worktree, base }) {
  if (!worktree) return missing('no worktree recorded');
  if (!repo) return missing('no repo to query');
  const slug = worktree.split('/').filter(Boolean).pop() ?? '';
  if (slug === '') return missing('the recorded worktree names no slug');

  if (!existsSync(worktree)) return mergedPrFor(gh, { repo, slug });

  const branchOut = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = firstLine(branchOut.stdout);
  if (branchOut.error) return missing(`git could not run: ${String(branchOut.error.message ?? branchOut.error)}`);
  if (branchOut.status !== 0 || branch === '' || branch.includes(' ')) {
    return missing(`git refused — ${firstLine(branchOut.stderr) || branch || `exit ${branchOut.status}`}`);
  }

  const dirtyOut = git(worktree, ['status', '--porcelain']);
  if (dirtyOut.status !== 0) return missing(`git refused — ${firstLine(dirtyOut.stderr) || `exit ${dirtyOut.status}`}`);
  if (firstLine(dirtyOut.stdout) !== '') return missing(`uncommitted changes on ${branch}`);

  // The PR that proves THIS branch, matched by name. Trusting the first row was
  // a bug in waiting: `--head` is a filter the caller cannot verify, and a first
  // row for another branch — or one carrying no head ref at all — would land.
  const prOut = gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName']);
  if (prOut.error) return missing(`gh could not run: ${String(prOut.error.message ?? prOut.error)}`);
  // A failed query is IGNORANCE, and it may not fall through to the commit count
  // below: "I could not ask about PRs" would be reported as "there is no PR".
  if (prOut.status !== 0) return missing(`gh refused — ${firstLine(prOut.stderr) || `exit ${prOut.status}`}`);
  const list = parseReceipt(prOut.stdout);
  if (!Array.isArray(list)) return missing('gh answered an unreadable PR list');
  const mine = list.filter(pr => String(pr?.headRefName ?? '') === branch);
  if (mine.length > 1) return missing(`${mine.length} PRs claim head ${branch}`);
  if (mine.length === 1) {
    const pr = mine[0];
    if (pr.state === 'MERGED') return landed(`PR #${pr.number} merged`);
    if (pr.state === 'OPEN') return missing(`PR #${pr.number} still open`);
    if (pr.state === 'CLOSED') return missing(`PR #${pr.number} closed unmerged`);
    return missing(`PR #${pr.number} is in state ${JSON.stringify(pr.state)}`);
  }

  const aheadOut = git(worktree, ['rev-list', '--count', `${base}..${branch}`]);
  const ahead = firstLine(aheadOut.stdout);
  if (aheadOut.status !== 0 || !/^\d+$/.test(ahead)) {
    return missing(`git refused — ${firstLine(aheadOut.stderr) || `exit ${aheadOut.status}`}`);
  }
  return missing(ahead === '0' ? 'branch carries no commit' : `${ahead} commit(s), no PR`);
}

/** Which proof a session owes, decided by the request that dispatched it. */
function prove(gh, git, { request, issuedAt, worktree, repo, base }) {
  if (request === null) return missing('unknown provenance — this host recorded no request for that dispatch');
  // The set shrank from three to two, and that is a removal and not an
  // omission: the `refine-` request kind went with the readiness lane `ax
  // ready` no longer has. A stale `refine-…` record on some host falls through
  // to `proveLanded`, which asks for a merged PR and answers MISSING — the
  // conservative direction, and the one a retired kind deserves.
  const kind = /^(triage|brief)-/.exec(request);
  if (kind === null) return proveLanded(gh, git, { repo, worktree, base });
  const number = request.split('-').pop() ?? '';
  if (!/^[1-9][0-9]*$/.test(number)) return missing('the request names no issue');
  return proveIssue(gh, { repo, number, issuedAt });
}

// ── the mutation ─────────────────────────────────────────────────────────────

/**
 * Does this record describe THIS release? Returns '' when it binds, and the
 * reason it does not otherwise.
 *
 * A stored argv is replayed byte for byte and its first element is the program
 * that runs, so an unbound record is an arbitrary command against an arbitrary
 * dispatch. Six things are checked, and every one of them is a property this
 * verb wrote itself: the record's request names this dispatch, the phase is a
 * `worker-release`, the argv is strings, it carries `--dispatch <this id>`, its
 * `--retry-request` is the identity written beside it, and its program is the
 * runtime this process resolved or another Orca CLI — never a program of
 * somebody else's choosing.
 */
function releaseBinding(path, dispatchId, argv, index, bin) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return `it is unreadable (${String(error.message ?? error)})`;
  }
  if (rec.request !== `release-${dispatchId}`) return `it is the record of ${JSON.stringify(rec.request)}`;
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) return 'its recorded argv is not a list of strings';

  const phase = (rec.attempts?.[rec.attempts.length - 1]?.phases ?? [])[index];
  if (phase?.name !== 'worker-release') return `phase ${index} is ${JSON.stringify(phase?.name)}, not a worker-release`;
  if (argvValue(argv, '--dispatch') !== dispatchId) return `its argv releases ${JSON.stringify(argvValue(argv, '--dispatch'))}`;
  if (argvValue(argv, '--retry-request') !== phase.identity) return 'its retry identity is not the one recorded beside it';
  if (argv[0] !== bin && !ORCA_BINARY.test(argv[0] ?? '')) return `its argv would run ${JSON.stringify(argv[0])}, which is not an Orca CLI`;
  return '';
}

/**
 * One release, write-ahead. Returns `{ settled, line, repair }`: `settled` is
 * false for every outcome an operator still owns — a refusal, and above all an
 * outcome nobody knows.
 */
function releaseOne(dir, dispatchId, { bin, execute }) {
  const attempt = (path, index, argv) => {
    const out = execute(argv);
    phaseEnd(path, index, { exit: out.status, receiptText: out.stdout, stderr: out.stderr, error: out.error });
    return { exit: out.status, verdict: phaseVerdict(path, index), receipt: parseReceipt(out.stdout) };
  };

  const claim = claimRecord(dir, dispatchId);
  let outcome;

  if (claim.claimed) {
    const identity = newIdentity();
    initRecord(claim.path, { request: `release-${dispatchId}`, orca: bin });
    const argv = [bin, 'orchestration', 'worker-release', '--dispatch', dispatchId, '--retry-request', identity, '--json'];
    phaseBegin(claim.path, { name: 'worker-release', identity, argv });
    outcome = attempt(claim.path, 'last', argv);
  } else {
    // The claim is lost: another caller owns this release. Replay ITS request —
    // Orca deduplicates on the identity already on disk, so the answer is that
    // caller's, not a second mutation.
    // A claim file is created EMPTY and filled a moment later, so a record that
    // holds nothing is the window between another caller's claim and its
    // write-ahead — that caller may be inside it right now. Both that and a
    // record whose phases are still empty are somebody else's request, and
    // neither is ever re-minted here.
    const owned = {
      settled: false,
      line: `${dispatchId}  another caller owns this release and has not recorded its request yet`,
      repair: `ax worker release --close --dispatch ${dispatchId}   # once that caller has written its request, this replays it`,
    };
    let count;
    try {
      count = phaseCount(claim.path);
    } catch (error) {
      if (readFileSync(claim.path, 'utf8').trim() === '') return owned;
      return {
        settled: false,
        line: `${dispatchId}  the existing release record is unreadable: ${String(error.message ?? error)}`,
        repair: `cat ${claim.path}   # repair or recover that record; do NOT mint a second release identity`,
      };
    }
    if (count === 0) return owned;
    const index = count - 1;
    const recorded = phaseVerdict(claim.path, index);
    // A concluded record is the answer, and concluded means BOTH: Orca answered
    // a legible receipt AND its exit code settled. A recorded `release_unknown`
    // exits 1 with a perfectly readable receipt, so reading the verdict alone
    // would report "already released" over a release nobody can account for.
    if ((recorded.verdict === 'ran' || recorded.verdict === 'replayed') && phaseExit(claim.path, index) === 0) {
      return { settled: true, line: `${dispatchId}  already released — this host recorded it`, repair: '' };
    }
    // A record found on disk is a REQUEST TO REISSUE, and its argv becomes both
    // the program this process runs and the dispatch Orca acts on. So the
    // binding is proved before the replay: this record is about THIS dispatch,
    // it carries the release request and nothing else, and its argv[0] is an
    // Orca binary rather than an arbitrary program. Every mismatch is
    // cannot-establish — the point of the record is that it can be trusted
    // verbatim, so a record that cannot be is never partially believed.
    let argv;
    try {
      argv = phaseArgv(claim.path, index);
    } catch (error) {
      return {
        settled: false,
        line: `${dispatchId}  the recorded release cannot be reconstructed: ${String(error.message ?? error)}`,
        repair: `cat ${claim.path}   # a request that cannot be replayed is never re-minted`,
      };
    }
    const unbound = releaseBinding(claim.path, dispatchId, argv, index, bin);
    if (unbound !== '') {
      return {
        settled: false,
        line: `${dispatchId}  the release record at ${claim.path} does not describe this release: ${unbound}`,
        repair: `cat ${claim.path}   # settle it by hand; a record that does not bind is never replayed`,
      };
    }
    outcome = attempt(claim.path, index, argv);
  }

  const verdict = outcome.verdict.verdict;
  if (verdict === 'mismatch') {
    return {
      settled: false,
      line: `${dispatchId}  Orca refused the exact recorded request: ${String(outcome.verdict.evidence).slice(0, 200)}`,
      repair: 'orca orchestration worker-show --dispatch ' + dispatchId + ' --json   # settle it by hand; do not mint a new identity',
    };
  }
  if (verdict === 'failed') {
    return {
      settled: false,
      line: `${dispatchId}  REFUSED: ${JSON.stringify(outcome.verdict.evidence).slice(0, 200)}`,
      repair: `orca orchestration worker-show --dispatch ${dispatchId} --json`,
    };
  }
  if (verdict === 'unknown') {
    return {
      settled: false,
      line: `${dispatchId}  UNSETTLED — nobody knows whether the pane closed: ${String(outcome.verdict.evidence).slice(0, 200)}`,
      repair: `ax worker release --close --dispatch ${dispatchId}   # replays the recorded request; it never issues a second one`,
    };
  }

  // Orca's own contract: retained, release_pending and already_released all exit
  // 0; only `release_unknown` exits 1. A non-zero exit here is therefore a
  // release Orca cannot account for, whatever the receipt reads like.
  //
  // Receipt shape measured 2026-08-22 on an idempotent repeat:
  // `{state:'already_released', processAction:'none', archive:{status:'captured'},
  // mutation:{requestId, replayed}}`. `state` is what distinguishes a pane this
  // call closed from one that was already shut, so it is printed rather than
  // reduced to the action.
  const result = outcome.receipt.result ?? {};
  const state = result.state ?? 'unnamed state';
  const action = result.processAction ?? 'none';
  const archive = (result.archive ?? {}).status ?? '-';
  const detail = `${dispatchId}  ${state} · ${action} · archive=${archive}${action === 'none' ? '   (nothing was open)' : ''}`;
  // And the receipt has to be ABOUT this dispatch. `ok:true` with an object
  // result is what `phaseVerdict` calls a run; that is a statement about the
  // record's shape, not about which pane was closed.
  if (result.dispatchId !== dispatchId) {
    return {
      settled: false,
      line: `${detail}  — the receipt names dispatch ${JSON.stringify(result.dispatchId)}, not this one`,
      repair: `orca orchestration worker-show --dispatch ${dispatchId} --json`,
    };
  }
  if (outcome.exit !== 0) {
    return {
      settled: false,
      line: `${detail}  — exit ${outcome.exit}: Orca cannot account for this release: ${receiptReason(result)}`,
      repair: releaseRepair(dispatchId),
    };
  }
  return { settled: true, line: detail, repair: '' };
}

// ── the verb ─────────────────────────────────────────────────────────────────

export function release(
  argv = [],
  { resolve = resolveOrca, runner, exec = defaultExec, env = process.env, cwd = process.cwd(), sleep = sleepDefault } = {},
) {
  const usageError = message => {
    process.stderr.write(`ax worker release: ${message}\n${USAGE}\n`);
    return 2;
  };
  const cannot = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    if (repair) fix(repair);
    return 3;
  };

  let close = false;
  let all = false;
  let noProof = false;
  let only = '';
  let base = 'origin/main';
  let storeArg = '';
  let gap = Number(env.ORCA_CLOSE_SAMPLE_GAP ?? 2);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      return argv[i];
    };
    if (arg === '--close') close = true;
    else if (arg === '--all') all = true;
    else if (arg === '--no-proof') noProof = true;
    else if (arg === '--dispatch') only = value() ?? '';
    else if (arg === '--base') base = value() ?? '';
    else if (arg === '--store') storeArg = value() ?? '';
    else if (arg === '--gap') gap = Number(value());
    else return usageError(`unknown argument "${arg}"`);
  }

  if (only === '' && argv.includes('--dispatch')) return usageError('--dispatch needs a dispatch id');
  if (base === '') return usageError('--base needs a ref');
  if (!Number.isFinite(gap) || gap < 0) return usageError('--gap needs a number of seconds (0 or more)');
  // `--no-proof` is an operator saying "I looked at that pane". It cannot be
  // said about a batch, so it is refused for one.
  if (noProof && only === '') {
    return usageError('--no-proof only applies to a single --dispatch <id>: it is for an operator who has looked at one pane, not for a batch');
  }
  if (only !== '' && !requestIdOk(only)) return usageError(`dispatch id "${only}" cannot name a release record`);

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) return cannot('no Orca CLI on this machine — no pane state can be established here', 'ORCA_CLI_COMMAND=<binary> ax worker release');
  const run = runner ?? createRunner({ bin });

  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # start the runtime, then re-run this report');

  // `safe.directory` names the ONE tree being inspected, never `*`: the wildcard
  // grants git's ownership trust to every repository on the machine, and these
  // paths arrive from a runtime inventory rather than from the caller.
  const git = (at, args) => exec('git', ['-c', `safe.directory=${at}`, '-C', at, ...args], cwd);
  const gh = args => exec('gh', args, cwd);

  // THE CHECKOUT THIS RUN CAN PROVE THINGS ABOUT. Landing proof is a question
  // asked of ONE repository — `gh repo view` here, in this working directory —
  // so a candidate may only be proven when its worktree lives inside that
  // checkout. Without this, `--all` and `--dispatch` asked repository A about a
  // pane belonging to repository B: a same-named branch merged in A would close
  // a live session in B, which is the exact failure the proof rule exists to
  // prevent.
  const top = exec('git', ['rev-parse', '--show-toplevel'], cwd);
  const home = physical(firstLine(top.stdout));
  // A machine-wide sweep is opt-in: this verb closes panes, and doing it to every
  // repository on the host because the caller happened to sit outside one is not
  // a default. `--dispatch` names its own row and needs no path scope.
  if (!all && only === '' && (top.status !== 0 || home === '')) {
    return cannot('not inside a git repository and --all not given — refusing to sweep machine-wide by accident', 'ax worker release --all   # every repo on this machine');
  }
  const scope = all || only !== '' ? '' : home;

  const viewed = repoView(gh);
  const repo = viewed.slug;
  // Without a repository there is no artifact to ask about, so every row would
  // be an unprovable KEEP and the report would read like a clean sweep. That is
  // an inability, and it is named as one.
  if (repo === '' && !noProof) {
    return cannot(`gh cannot name this repository, so no landing can be proven: ${viewed.detail}`, 'gh auth login   # then re-run; or --close --dispatch <id> --no-proof for one pane you have looked at');
  }

  const workers = workerInventory(run);
  if (!workers.ok) return cannot(workers.reason, 'orca orchestration worker-list --json   # the inventory is the only list of releasable dispatches');

  const terminals = terminalInventory(run);
  if (!terminals.ok) return cannot(terminals.reason, 'orca terminal list --json   # a pane that cannot be seen must never be judged closed');

  const store = storeArg || defaultStore(env);
  const index = dispatchIndex(store);
  // A store that cannot be enumerated is not an absence of provenance. Left
  // unread, this is exactly "I could not look" reported as "nothing is there".
  if (!index.missing && index.reason) {
    return cannot(`the dispatch store at ${store} cannot be read: ${index.reason}`, `ls -ld ${store}   # provenance decides which proof applies to a pane`);
  }

  const seen = new Set(workers.rows.map(row => row.dispatchId));
  const rows = [...workers.rows, ...unaccounted(index, seen)];

  const selfHandle = env.ORCA_TERMINAL_HANDLE ?? '';
  const tally = { released: 0, pending: 0, noTerminal: 0, gone: 0, unprovable: 0 };
  const lines = [];
  const candidates = [];
  let matched = 0;
  let kept = 0;

  const keep = (line, repair = '') => {
    kept += 1;
    lines.push({ level: 'note', text: line, repair });
  };

  for (const row of rows) {
    if (only !== '' && row.dispatchId !== only) continue;
    matched += 1;

    const terminal = row.handle === '' ? undefined : terminals.byHandle.get(row.handle);
    // Canonical paths on both sides: `withinPath` compares physical paths, and a
    // raw `/scope/../elsewhere` from an inventory starts with the scope as a
    // string while naming a tree outside it.
    const worktree = physical(row.worktree || String(terminal?.worktreePath ?? ''));
    if (scope !== '' && worktree !== '' && !withinPath(worktree, scope)) continue;

    if (row.terminalState === 'released') {
      tally.released += 1;
      continue;
    }
    if (row.terminalState === 'release_pending') {
      tally.pending += 1;
      continue;
    }
    if (row.terminalState === 'release_unknown') {
      // Printed and KEPT rather than tallied: it is the one not-offered state an
      // operator has to chase, so it belongs to the rows that carry a repair.
      //
      // The row itself carries the STATE and not the sentence, so the reason is
      // read from the release record this verb wrote when it made the call
      // (`receiptReason` / `recordedReleaseResult`). A release this host never
      // recorded says that instead — an unread receipt is not an unexplained
      // one (F-028).
      const recorded = recordedReleaseResult(join(store, RELEASE_NS), row.dispatchId);
      keep(
        `${row.dispatchId} · ${row.workerState}/${row.terminalState} · Orca cannot account for an earlier release: ${
          recorded === null ? UNREAD_REASON : receiptReason(recorded)
        }`,
        releaseRepair(row.dispatchId),
      );
      continue;
    }
    if (row.handle === '') {
      tally.noTerminal += 1;
      continue;
    }

    if (terminal === undefined) {
      // Absence proves nothing while the pane's OWN runtime is out of scope:
      // those two readings are the difference between a corpse and a remote
      // child. But omission is PER HOST, and reading it globally made a record
      // unclosable for as long as an unrelated remote slept — measured
      // 2026-08-25: `ax worker release --dispatch ctx_febc0a00702f --close`
      // answered `1 pane not establishable` on a LOCAL dispatch whose PR was
      // already merged, because one paired remote runtime was omitted.
      //
      // The record's own `--on` settles it, and `''` (a local dispatch) is the
      // only claim made here: the receipt names `local` among the hosts it read,
      // so that pane's runtime WAS covered. A remote row stays unprovable —
      // this store names hosts by environment name and the receipt namespaces
      // runtimes, and no mapping between the two is established.
      const owner = index.byDispatch.get(row.dispatchId)?.env;
      const localProven = owner === '' && Array.isArray(terminals.hosts) && terminals.hosts.includes('local');
      if (terminals.omitted && !localProven) tally.unprovable += 1;
      else tally.gone += 1;
      continue;
    }
    if (terminal.orphaned === true) {
      tally.gone += 1;
      continue;
    }

    if (selfHandle !== '' && row.handle === selfHandle) {
      keep(`${row.dispatchId} · ${row.workerState}/${row.terminalState} · pane SELF · this session's own pane is never a candidate`);
      continue;
    }

    const host = String(terminal.executionHostId ?? 'local');
    if (host !== 'local') {
      keep(
        `${row.dispatchId} · ${row.workerState}/${row.terminalState} · pane REMOTE on ${host} · worker-release answers federation_unsupported (2026-08-14)`,
        `orca terminal close --terminal ${row.handle} --environment ${host}`,
      );
      continue;
    }

    if (row.workerState === 'unsupervised') {
      keep(
        `${row.dispatchId} · ${row.workerState}/${row.terminalState} · pane VIVANT · a context-only dispatch owns no terminal for release to close`,
        `orca terminal close --terminal ${row.handle}`,
      );
      continue;
    }

    if (row.known && !SETTLED.has(row.workerState)) {
      // THREE REPAIRS, ONE BRANCH, and the row says which applies. A `ready`
      // worker is normally a live session someone may still want, so the offer
      // is `worker-stop` and the decision stays the operator's. But a pane Orca
      // classifies `user_owned` — what a triage dispatch running in the current
      // checkout gets — can never be closed by a stop: it answers
      // `processAction: "none"`, `lastError: The worker terminal is user_owned`,
      // the Dispatch never settles, and the pane holds a cap slot for good.
      // Measured 2026-08-26: three commands, two of them refusals, to free one
      // pane this tool created. Naming the stop there sends the operator down a
      // route this row already proves cannot work.
      //
      // AND OWNERSHIP HAS THREE STATES HERE, NOT TWO. Read from Orca's source
      // (rpc/methods/orchestration-worker-stop.ts:141, fork at ~/Code/flosrn/orca):
      // a stop closes a terminal only when the runtime's own resource row reads
      // `ownership_state === 'owned'`; `transferred`, `external`, `released` and
      // `user_owned` all answer `processAction: 'none'` and close nothing. This
      // row's `ownership` is often ABSENT (pane.mjs reads it by name and never
      // defaults it), and an absent value is "unknown to this row" — not proven
      // owned, and not proven user-owned either. Measured 2026-08-28 on ofmchat
      // #100: an unproven row named the stop alone, the stop answered
      // `dispatch_inactive`, and neither verb could close the record. So the stop
      // stays named where it may still work, and the command that follows a
      // `processAction: none` is named ON THE SAME LINE rather than one refusal
      // later.
      //
      // The aftermath rides on the same comment rather than a row of its own: this
      // verb never runs a stop, so it reports no outcome — it qualifies a command
      // it offers. `dispatch_inactive: "… is not stopping."` is thrown by
      // `settleWorkerStop` (orchestration/db/worker-dispatch/worker-dispatch-stop.ts:96),
      // which runs only AFTER `closeTerminal` reported `ptyKilled`, so that failure
      // can arrive over a pane that is already gone — and reading it as "nothing
      // happened" is what left #100's record unclosable in the operator's head.
      //
      // CONFIRMED on that dispatch, 2026-08-28: ctx_5ffd0641bcf5 answered
      // `dispatch_inactive` to the stop, and the very next `ax triage release`
      // counted it `1 terminal gone` — the pty was already dead and the error
      // described the settle, not the action. So the caveat is a measured
      // sequence, not a reading of the state machine.
      const stopSuffix = `${
        row.ownership === 'owned'
          ? ''
          : `; a processAction: none or state stop_unknown means this pane is not Orca-owned and only \`orca terminal close --terminal ${row.handle}\` frees it`
      }; a dispatch_inactive answer can arrive AFTER the pane was closed, so re-run this verb rather than reading it as a no-op`;
      keep(
        `${row.dispatchId} · ${row.workerState}/${row.terminalState} · pane VIVANT · not settled, so not releasable${
          row.ownership === 'user_owned'
            ? ' · and user_owned, so no worker-stop can ever settle it'
            : row.ownership === '' && row.workerState === 'ready'
              ? ' · ownership unproven on this row, so a stop may close nothing'
              : row.ownership !== 'owned' && row.workerState === 'ready'
                ? ` · ownership ${row.ownership}, so a stop closes nothing`
                : ''
        }`,
        row.ownership === 'user_owned'
          ? `orca terminal close --terminal ${row.handle}   # closing a live pane is still your decision — a stop would answer processAction: none`
          : row.workerState === 'ready'
            ? `orca orchestration worker-stop --dispatch ${row.dispatchId} --json   # cancelling a live session is a different decision${stopSuffix}`
            : `orca terminal close --terminal ${row.handle}   # a ${row.workerState} worker cannot be released`,
      );
      continue;
    }

    // Provenance decides which proof applies, so it must be UNAMBIGUOUS: one
    // named request for this dispatch, in a record whose filename agrees with it.
    if (index.ambiguous.has(row.dispatchId)) {
      keep(
        `${row.dispatchId} · ${row.workerState}/${row.terminalState} · pane VIVANT · two records claim this dispatch — provenance is ambiguous, so nothing is proven`,
        `grep -l ${row.dispatchId} ${store}/*.json   # settle which request owns it`,
      );
      continue;
    }
    // And the pane has to sit in the checkout whose repository this run can ask
    // about. A pane we cannot place is never proven — asking THIS repo about
    // ANOTHER repo's branch is how a same-named merged PR closes a live session.
    if (worktree === '' || !withinPath(worktree, home)) {
      keep(
        `${row.dispatchId} · ${row.workerState}/${row.terminalState} · pane VIVANT · ${worktree === '' ? 'no worktree recorded' : `outside ${home}`} — this run can only prove landing in ${repo || 'this checkout'}`,
        worktree === ''
          ? `orca orchestration worker-show --dispatch ${row.dispatchId} --json   # establish where it belongs, then release from there`
          : `cd ${worktree} && ax worker release --close --dispatch ${row.dispatchId}`,
      );
      continue;
    }

    const entry = index.byDispatch.get(row.dispatchId);
    candidates.push({
      ...row,
      worktree,
      request: entry?.request ?? null,
      issuedAt: entry?.issuedAt ?? null,
    });
  }

  if (only !== '' && matched === 0) {
    return cannot(
      `no worker and no local record names dispatch ${only} — nothing can be established about it`,
      'ax worker ls   # the dispatches this host recorded, counted by live pane',
    );
  }

  // Proof first, then movement: one sleep for the whole batch rather than one
  // per row. The samples are what decide BUSY, and they are taken after the
  // artifact question is already answered.
  for (const candidate of candidates) {
    candidate.proof = noProof
      ? landed('bypassed by --no-proof — an operator looked at this pane')
      : prove(gh, git, { request: candidate.request, issuedAt: candidate.issuedAt, worktree: candidate.worktree, repo, base });
  }

  const before = new Map(candidates.map(candidate => [candidate.dispatchId, readPane(run, candidate.handle, { limit: 1 })]));
  if (candidates.length > 0) sleep(gap * 1000);
  const after = new Map(candidates.map(candidate => [candidate.dispatchId, readPane(run, candidate.handle, { limit: 1 })]));

  const toClose = [];
  for (const candidate of candidates) {
    const a = before.get(candidate.dispatchId);
    const b = after.get(candidate.dispatchId);
    // A pane is QUIET only when BOTH reads came back whole. `paneReadable` is the
    // watchers' lenient predicate — it accepts a receipt that named its own
    // inability — and a destructive verdict cannot be taken on one: two refused
    // receipts carrying the same (or no) cursor would read as "it did not move".
    const whole = pane => paneReadable(pane) && pane.refusal === null && pane.cursor !== null;
    const readable = whole(a) && whole(b);
    const moving = readable && a.cursor !== b.cursor;

    let verdict;
    let why;
    if (!readable) {
      verdict = 'KEEP';
      why = 'the pane cannot be established — a pane nobody can read is never judged closed';
    } else if (!candidate.proof.landed) {
      verdict = 'KEEP';
      why = candidate.proof.detail;
    } else if (moving) {
      // Landed AND still emitting: the work shipped but the session is doing
      // something. --no-proof does not bypass this; it only bypasses the artifact.
      verdict = 'BUSY';
      why = `${candidate.proof.detail}, but the pane is still moving`;
    } else {
      verdict = 'CLOSE';
      why = candidate.proof.detail;
    }

    const pane = !readable ? 'INCONNU' : moving ? 'WORKING' : 'QUIET';
    const source = candidate.known ? '' : ' · absent from worker-list (F-048)';
    const text = `${candidate.dispatchId} · ${candidate.workerState}/${candidate.terminalState} · pane ${pane} · ${verdict} · ${why} · ${candidate.request ?? 'no local record'}${source}`;

    if (verdict === 'CLOSE') {
      toClose.push(candidate);
      lines.push({ level: 'ok', text, repair: '' });
    } else {
      keep(text);
    }
  }

  section(`${toClose.length} closeable · ${kept} kept — landing is proven from artifacts, never from a session's own word`);
  for (const line of lines) {
    const emit = line.level === 'ok' ? ok : line.level === 'bad' ? bad : note;
    emit(redactSecrets(line.text));
    if (line.repair) fix(redactSecrets(line.repair));
  }

  // Every row is in exactly ONE place: printed with its repair above, or counted
  // here. A cause that appeared in both would make these numbers unreadable, and
  // an unreadable summary is what the residual this replaced already was.
  note(
    `not offered: ${tally.released} already released · ${tally.gone} terminal gone · ${tally.noTerminal} no terminal recorded · ` +
      `${tally.pending} release in flight · ${tally.unprovable} pane not establishable`,
  );
  if (tally.unprovable > 0) {
    note(`hosts omitted from this terminal list (${terminals.omittedHosts.join(', ')}): a handle absent from it is UNKNOWN here, never a corpse`);
  }
  if (index.missing) note(`no dispatch store at ${store} — no provenance on this host, so no bulk proof either`);
  for (const broken of index.unreadable) note(`record ${broken.file} is unreadable (${broken.error}) — the dispatches it names have no provenance here`);

  if (toClose.length === 0) {
    note('nothing to close.');
    return 0;
  }

  if (!close) {
    note('report only — nothing was closed. Add --close to act.');
    note('a CLOSE verdict needs an artifact: a comment after the dispatch for a triage, a MERGED PR for an');
    note('implementation. An OPEN PR is not proof — that session may still owe its review threads.');
    return 0;
  }

  const dir = join(store, RELEASE_NS);
  let code = 0;
  for (const candidate of toClose) {
    const outcome = releaseOne(dir, candidate.dispatchId, {
      bin,
      // The replay speaks to the runtime the record NAMES, not to whatever this
      // process resolved today: on a host carrying both `orca` and `orca-ide`
      // those are two different runtimes, and the pane lives in one of them.
      execute: full => (runner ? runner(full.slice(1)) : createRunner({ bin: full[0] })(full.slice(1))),
    });
    if (outcome.settled) {
      ok(redactSecrets(outcome.line));
      // The release is the attempt's END, and the frontier reads that end from
      // the DISPATCH record: an unsettled record classifies already-dispatched
      // (a live attempt), a settled one with its ticket still open classifies
      // attempt-ended-unmerged. Fail-open: a bookkeeping failure never turns a
      // settled release into a refusal, but it is named, never swallowed.
      const entry = index.byDispatch.get(candidate.dispatchId);
      if (entry?.request) {
        try {
          attemptSettle(join(store, `${entry.request}.json`));
        } catch (error) {
          note(`the release settled but its dispatch record did not: ${String(error.message ?? error).slice(0, 160)}`);
          fix(`cat ${join(store, `${entry.request}.json`)}   # settle the last attempt by hand`);
        }
      }
    } else {
      bad(redactSecrets(outcome.line));
      code = 1;
    }
    if (outcome.repair) fix(redactSecrets(outcome.repair));
  }
  note('transcripts survive: `orca orchestration worker-read --dispatch <id>` still answers.');
  return code;
}
