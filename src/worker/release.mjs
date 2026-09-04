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
// AND A KEEP IS A CATEGORY (#147). That sentence was true of the counted
// buckets and false of the rows an operator actually acts on: every KEEP —
// every row this verb declined to close — printed a verdict and stopped.
// `KEEP · uncommitted changes on <branch>` was measured twice (#79, #135) on
// the pane a finished child leaves behind, and both times the next move was a
// guess. So the proof answers with the repair beside the reason (`missing`
// takes no default for it), the two verdicts decided from pane movement carry
// their own, and a reason added without one fails the pin in
// tests/worker-release.test.mjs rather than shipping a finding nobody can act
// on (../log.mjs). The dirty row needs TWO of them, and `proveClean` says why.
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
// PLACEMENT IS BY REPOSITORY, NEVER BY PATH (#83)
// Landing proof is asked of ONE repository, so a row may only be judged when it
// belongs to the repository this run can ask about. That predicate was path
// containment against the checkout's toplevel until 2026-09-02, and ax places
// every child under Orca's workspace root — outside the checkout by
// construction. So no ax-dispatched pane was ever a candidate: the first pane
// this repository had to release (PR #79 merged, pane alive) was `continue`d
// before any tally, absent from all five buckets of a 92-row receipt, while the
// `--dispatch` route printed the same fact honestly. The key that places a row
// is the dispatch record's own `repo` (`--tracker-repo`), and a record naming
// none is UNKNOWN — not ours, not foreign, authorizing nothing (F-028). Whatever
// is declined is COUNTED and NAMED; a silent `continue` is how a receipt reports
// a clean sweep over the row it existed to close.
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
import { planProject, readManifest } from '../plan.mjs';
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
import { physical } from '../worktree/locate.mjs';

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
 * The long help this verb used to hold in a `HELP` string did NOT go away with
 * it: what proof is, what is never proof, the flags and the exit codes are
 * declared as `helpBody.release` in the registry and printed by that one read
 * (../commands.mjs). The distinction is who each text is for — this header is
 * for whoever patches the verb, `--help` is for whoever is typing it, and an
 * operator deciding whether to close someone's pane is reading the terminal.
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

/**
 * ONE ARGUMENT, QUOTED FOR A POSIX SHELL — and every repair in this file that
 * interpolates a path goes through it.
 *
 * Found in review on #157. A repair is a command an operator PASTES, and a
 * worktree path is not a token: ax places children under a workspace root it
 * does not choose, so `/Users/me/My Project/ws-147` printed bare is three
 * arguments, and a `$` or a backtick in a directory name is read by the shell
 * before `git` ever sees it. A row that says "the exact call this proof makes"
 * and then prints a different one is the same finding this verb exists to
 * remove, one layer down.
 *
 * Quoted ONLY when it has to be: an unquoted path is what an operator reads
 * every day, and `'…'` on all five words of `git -C … status --porcelain` is
 * noise that trains the reader to skim. The safe set is the shell-portable one
 * (no `~`, which must expand, and no `!`, which csh-style history would eat).
 * Single quotes are the only shape needing no escape table — a literal quote
 * is closed, escaped and reopened.
 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const shq = value => {
  const text = String(value);
  return text !== '' && SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
};

const firstLine = text => String(text ?? '').split('\n')[0].trim();
// A proof answer carries the REPAIR with the verdict, never a verdict alone:
// `missing` takes no default for it, so a reason added without one prints a
// KEEP with no `→` and fails the pin in tests/worker-release.test.mjs.
const landed = detail => ({ landed: true, detail, repair: '' });
const missing = (detail, repair) => ({ landed: false, detail, repair });

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

/**
 * THE REPAIRS A KEEP CARRIES (#147).
 *
 * A KEEP is the only verdict an operator can act on, and every one of them used
 * to print a verdict and stop — against this file's own header ("every category
 * below names itself, carries its own count, and names its repair") and against
 * `../log.mjs`, where a `bad` without a `fix` is a finding nobody can act on.
 * Measured twice on the dirty row (#79, #135): a finished child's pane named
 * `uncommitted changes on <branch>`, and the operator's next move was a guess.
 *
 * Three shapes cover every `missing()` below, because there are only three
 * kinds of answer an operator can act on:
 *   * a command REFUSED — the exact argv, so the refusal can be read whole
 *   * an artifact is ABSENT — read the pane, then the one route that closes a
 *     pane without an artifact (`--no-proof`), which is a claim only a human
 *     may make and no ax verb may make for them
 *   * the artifact EXISTS unmerged — the gate that says what still blocks it
 * The dirty tree has its own two, in `proveClean`. None of them is a look
 * alone: a `worker-show` changes nothing, which is what #100 paid for on the
 * `release_unknown` row.
 */
// `why` is a PARAMETER and never an extra element of `args`: every word of
// `args` is shell-quoted, so a sentence appended to that array would come back
// quoted as if it were an argument.
const rerun = (args, why = 'read its refusal whole, then re-run this verb') =>
  `${args.map(shq).join(' ')}   # the exact call this proof makes — ${why}`;

const readThenSay = (dispatchId, why) =>
  `orca orchestration worker-read --dispatch ${dispatchId} --json   # ${why}: read the pane, then close it on your own word — ax worker release --close --dispatch ${dispatchId} --no-proof`;

const GH_AUTH = 'gh auth status   # every landing proof is a gh query, and this one had no repository to make it against';

/**
 * The paths `git status --porcelain` named, and whether each is UNTRACKED.
 *
 * Porcelain v1 and nothing else: two status columns, a space, then the path.
 * `??` is untracked. A rename carries `orig -> dest`, of which only `dest`
 * exists in this tree. A path git quoted (`core.quotePath`) keeps its quotes —
 * unquoting it would put an escape reader in a proof, and this list is READ by
 * an operator, beside the command that printed it.
 */
function dirtyRows(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(' -> ');
      return { untracked: line.slice(0, 2) === '??', path: arrow === -1 ? rest : rest.slice(arrow + 4) };
    });
}

/**
 * Does `plan.ignore` name this path? Every line on that list is ONE segment —
 * `.env.local`, `.agent/` — carrying no leading slash on purpose, so it matches
 * at any depth (../plan.mjs). The comparison is segment by segment for that
 * same reason: a consumer's `apps/web/.env.local` is the same finding as this
 * checkout's root one.
 */
const provisions = (path, ignore) => {
  const segments = path.split('/').filter(Boolean);
  return ignore.some(line => segments.includes(line.replace(/\/+$/, '')));
};

/**
 * A DIRTY TREE STAYS KEEP, AND SAYS WHICH KIND OF DIRTY IT IS (#147).
 *
 * The verdict does not move: #83 ruled there is no allowlist inside the landing
 * proof, because a proof that skips one path is how a hand-edited file carrying
 * real work stops blocking a close. What changes is the sentence, and there are
 * exactly two, because the operator's next move is different:
 *
 *   * EVERY dirty line is an untracked path `plan.ignore` names. The tool's own
 *     runtime state read as work — measured on #79 and again on #135 — and the
 *     repair is the ignore `ax init` writes on the checkout. That the path is
 *     in `git status --porcelain` at all IS the proof this checkout does not
 *     ignore it yet, so nothing here reads a `.gitignore` to find out.
 *   * ANYTHING ELSE — a modified tracked file, an untracked path the plan does
 *     not name. That is work the merge gate never saw, sitting in a tree whose
 *     PR is merged, and it is committed or stashed by whoever owns it. `ax
 *     init` is not named there: a repair that changes nothing is the defect
 *     #118 removed from the placement row.
 *
 * Returns null on a clean tree, so the caller reads "no finding" rather than a
 * verdict.
 */
function proveClean(stdout, { branch, worktree, checkout, ignore }) {
  const rows = dirtyRows(stdout);
  if (rows.length === 0) return null;
  const paths = rows.map(row => row.path).join(', ');
  if (rows.every(row => row.untracked && provisions(row.path, ignore))) {
    return missing(
      `uncommitted changes on ${branch} — all of it untracked state ax provisions and this checkout does not ignore: ${paths}`,
      `cd ${shq(checkout)} && ax init   # writes the managed .gitignore block that covers ${paths} (plan.ignore, src/plan.mjs). The verdict stays KEEP until this tree is clean — the block reaches this worktree with its branch, or those paths are removed there; no path is ever exempted inside the proof (#83)`,
    );
  }
  return missing(
    `uncommitted changes on ${branch} — work the merge gate never saw`,
    `git -C ${shq(worktree)} status --porcelain   # read it, then commit or stash it before this pane closes: a merged PR with local dirt is work no gate and no reviewer ever saw`,
  );
}

/**
 * A comment on that issue, created AFTER the dispatch. Nothing else.
 *
 * Every refusal names the query that produced it, and every absence names the
 * pane: a triage that cannot be proven is either an unanswered `gh` or a pass
 * that never published, and those are two different next moves.
 */
function proveIssue(gh, { repo, number, issuedAt, dispatchId, recordPath }) {
  if (!repo) return missing('no repo to query', GH_AUTH);
  const query = ['gh', 'issue', 'view', String(number), '--repo', repo, '--json', 'comments'];
  if (issuedAt === null) {
    return missing(
      'the record carries no readable dispatch date',
      readThenSay(dispatchId, `${recordPath} carries no readable dispatch date, so no comment can be proven newer than it`),
    );
  }
  const out = gh(query.slice(1));
  if (out.error) return missing(`gh could not run: ${String(out.error.message ?? out.error)}`, rerun(query));
  if (out.status !== 0) return missing(`gh refused — ${firstLine(out.stderr) || `exit ${out.status}`}`, rerun(query));
  const body = parseReceipt(out.stdout);
  if (!Array.isArray(body.comments)) return missing(`gh answered no comments array for #${number}`, rerun(query));
  const newest = body.comments.reduce((max, comment) => {
    const at = Date.parse(comment?.createdAt ?? '');
    return Number.isFinite(at) && at > max ? at : max;
  }, -1);
  if (newest < 0) return missing(`no comment on #${number}`, readThenSay(dispatchId, `#${number} carries no comment, so this pass published nothing`));
  return newest > issuedAt
    ? landed(`comment on #${number} after dispatch`)
    : missing(
        `newest comment on #${number} predates dispatch`,
        readThenSay(dispatchId, `every comment on #${number} is older than this dispatch, so this pass published nothing`),
      );
}

/**
 * A merged PR whose head ref IS that slug, or ends with `/<slug>`. Exactness is
 * ranked and a substring rank is deliberately absent: it made `wizard-178` match
 * `feat/wizard-1788` and reported it as proof. A near-miss must find nothing,
 * and a tie at the winning rank is ambiguity rather than a guess.
 */
function mergedPrFor(gh, { repo, slug, dispatchId }) {
  const query = ['gh', 'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '200', '--json', 'number,headRefName'];
  const out = gh(query.slice(1));
  if (out.error) return missing(`gh could not run: ${String(out.error.message ?? out.error)}`, rerun(query));
  if (out.status !== 0) return missing(`gh refused — ${firstLine(out.stderr) || `exit ${out.status}`}`, rerun(query));
  const list = parseReceipt(out.stdout);
  if (!Array.isArray(list)) return missing('gh answered an unreadable merged-PR list', rerun(query));

  for (const predicate of [head => head === slug, head => head.endsWith(`/${slug}`)]) {
    const hits = list.filter(pr => predicate(String(pr?.headRefName ?? '')));
    if (hits.length === 1) return landed(`PR #${hits[0].number} merged (${hits[0].headRefName}, worktree gone)`);
    if (hits.length > 1) {
      return missing(
        `'${slug}' matches ${hits.slice(0, 4).map(pr => `#${pr.number}`).join(',')}`,
        readThenSay(dispatchId, `${hits.length} merged PRs carry the slug '${slug}' and its worktree is gone, so nothing here can say which one this pane opened`),
      );
    }
  }
  return missing(
    `no merged PR for '${slug}', worktree gone`,
    readThenSay(dispatchId, `no merged PR carries the slug '${slug}' and its worktree is gone, so there is no tree left to inspect either`),
  );
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
function proveLanded(gh, git, { repo, worktree, base, dispatchId, checkout, ignore }) {
  if (!worktree) return missing('no worktree recorded', readThenSay(dispatchId, 'this host recorded no worktree for the dispatch, so there is no branch to ask about'));
  if (!repo) return missing('no repo to query', GH_AUTH);
  const slug = worktree.split('/').filter(Boolean).pop() ?? '';
  if (slug === '') return missing('the recorded worktree names no slug', readThenSay(dispatchId, `the recorded worktree ${worktree} names no slug to match a PR head against`));

  if (!existsSync(worktree)) return mergedPrFor(gh, { repo, slug, dispatchId });

  const branchQuery = ['git', '-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'];
  const branchOut = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = firstLine(branchOut.stdout);
  if (branchOut.error) return missing(`git could not run: ${String(branchOut.error.message ?? branchOut.error)}`, rerun(branchQuery));
  if (branchOut.status !== 0 || branch === '' || branch.includes(' ')) {
    return missing(`git refused — ${firstLine(branchOut.stderr) || branch || `exit ${branchOut.status}`}`, rerun(branchQuery));
  }

  const dirtyOut = git(worktree, ['status', '--porcelain']);
  if (dirtyOut.status !== 0) {
    return missing(`git refused — ${firstLine(dirtyOut.stderr) || `exit ${dirtyOut.status}`}`, rerun(['git', '-C', worktree, 'status', '--porcelain']));
  }
  const dirt = proveClean(dirtyOut.stdout, { branch, worktree, checkout, ignore });
  if (dirt !== null) return dirt;

  // The PR that proves THIS branch, matched by name. Trusting the first row was
  // a bug in waiting: `--head` is a filter the caller cannot verify, and a first
  // row for another branch — or one carrying no head ref at all — would land.
  const prQuery = ['gh', 'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName'];
  const prOut = gh(prQuery.slice(1));
  if (prOut.error) return missing(`gh could not run: ${String(prOut.error.message ?? prOut.error)}`, rerun(prQuery));
  // A failed query is IGNORANCE, and it may not fall through to the commit count
  // below: "I could not ask about PRs" would be reported as "there is no PR".
  if (prOut.status !== 0) return missing(`gh refused — ${firstLine(prOut.stderr) || `exit ${prOut.status}`}`, rerun(prQuery));
  const list = parseReceipt(prOut.stdout);
  if (!Array.isArray(list)) return missing('gh answered an unreadable PR list', rerun(prQuery));
  const mine = list.filter(pr => String(pr?.headRefName ?? '') === branch);
  if (mine.length > 1) {
    return missing(
      `${mine.length} PRs claim head ${branch}`,
      rerun(prQuery, 'close or retarget the duplicates: one head, one PR, or nothing here can name the one that proves this pane'),
    );
  }
  if (mine.length === 1) {
    const pr = mine[0];
    if (pr.state === 'MERGED') return landed(`PR #${pr.number} merged`);
    // AN OPEN PR IS NOT PROOF (F-031), so the repair is the merge decision and
    // not this verb: `ax pr gate` names every ground that still refuses it.
    if (pr.state === 'OPEN') {
      return missing(`PR #${pr.number} still open`, `cd ${shq(worktree)} && ax pr gate --pr ${pr.number}   # this pane closes when that PR is MERGED and never before; the gate names what still blocks it`);
    }
    if (pr.state === 'CLOSED') {
      return missing(`PR #${pr.number} closed unmerged`, readThenSay(dispatchId, `PR #${pr.number} was closed without merging, so nothing this pane did ever landed`));
    }
    return missing(`PR #${pr.number} is in state ${JSON.stringify(pr.state)}`, rerun(['gh', 'pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergedAt,headRefName']));
  }

  const aheadQuery = ['git', '-C', worktree, 'rev-list', '--count', `${base}..${branch}`];
  const aheadOut = git(worktree, ['rev-list', '--count', `${base}..${branch}`]);
  const ahead = firstLine(aheadOut.stdout);
  if (aheadOut.status !== 0 || !/^\d+$/.test(ahead)) {
    return missing(`git refused — ${firstLine(aheadOut.stderr) || `exit ${aheadOut.status}`}`, rerun(aheadQuery));
  }
  return ahead === '0'
    ? missing('branch carries no commit', readThenSay(dispatchId, `${branch} carries no commit over ${base}, so this session produced nothing to land`))
    : missing(`${ahead} commit(s), no PR`, readThenSay(dispatchId, `${branch} carries ${ahead} commit(s) that never became a PR — re-engage that pane to open one, or accept the work is unshipped`));
}

/** Which proof a session owes, decided by the request that dispatched it. */
function prove(gh, git, { request, issuedAt, worktree, repo, base, dispatchId, checkout, ignore, recordPath }) {
  if (request === null) {
    return missing(
      'unknown provenance — this host recorded no request for that dispatch',
      readThenSay(dispatchId, 'this host recorded no request for the dispatch, so nothing here knows which proof it owes'),
    );
  }
  // The set shrank from three to two, and that is a removal and not an
  // omission: the `refine-` request kind went with the readiness lane `ax
  // ready` no longer has. A stale `refine-…` record on some host falls through
  // to `proveLanded`, which asks for a merged PR and answers MISSING — the
  // conservative direction, and the one a retired kind deserves.
  const kind = /^(triage|brief)-/.exec(request);
  if (kind === null) return proveLanded(gh, git, { repo, worktree, base, dispatchId, checkout, ignore });
  const number = request.split('-').pop() ?? '';
  if (!/^[1-9][0-9]*$/.test(number)) {
    return missing('the request names no issue', readThenSay(dispatchId, `the request "${request}" names no issue number, so no comment can be asked for`));
  }
  return proveIssue(gh, { repo, number, issuedAt, dispatchId, recordPath });
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
        repair: `cat ${shq(claim.path)}   # repair or recover that record; do NOT mint a second release identity`,
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
        repair: `cat ${shq(claim.path)}   # a request that cannot be replayed is never re-minted`,
      };
    }
    const unbound = releaseBinding(claim.path, dispatchId, argv, index, bin);
    if (unbound !== '') {
      return {
        settled: false,
        line: `${dispatchId}  the release record at ${claim.path} does not describe this release: ${unbound}`,
        repair: `cat ${shq(claim.path)}   # settle it by hand; a record that does not bind is never replayed`,
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

  // THE REPOSITORY THIS RUN CAN PROVE THINGS ABOUT. Landing proof is a question
  // asked of ONE repository — `gh repo view` here, in this working directory —
  // so a row may only be judged when it BELONGS to that repository. Without the
  // scope, `--all` and `--dispatch` asked repository A about a pane belonging to
  // repository B: a same-named branch merged in A would close a live session in
  // B, which is the exact failure the proof rule exists to prevent.
  //
  // THE PREDICATE IS SAME-REPOSITORY, NEVER SAME-PATH (#83). It was path
  // containment against this checkout's toplevel until 2026-09-02, and ax places
  // every child under Orca's workspace root — outside the checkout by
  // construction. So on the first pane this repository ever had to release (PR
  // #79 merged, pane alive) the sweep tallied 92 rows and offered none of them:
  // the live merged row was `continue`d before any tally, absent from all five
  // buckets. A worktree of THIS repository is provable from here wherever Orca
  // put it — Orca placement is a linked git worktree of the same repository, so
  // the `git -C <worktree>` calls below are correct over it — and the key that
  // says so is the one the dispatch record carries (`--tracker-repo`).
  //
  // `git worktree list` cannot be that predicate: the case this verb exists for
  // is the post-merge row whose worktree is already GONE, and a removed worktree
  // is in no worktree list. It can corroborate a tree that still exists, nothing
  // more.
  const top = exec('git', ['rev-parse', '--show-toplevel'], cwd);
  const home = physical(firstLine(top.stdout));
  // A sweep needs a repository to scope itself to, and this working directory is
  // where the answer comes from. `--dispatch` names one row and still compares
  // its record against `repo` below.
  if (only === '' && (top.status !== 0 || home === '')) {
    return cannot(
      'not inside a git repository, so this sweep has no repository to scope itself to — placement is the repository a record NAMES',
      'cd <a checkout of the repository whose panes you are releasing> && ax worker release',
    );
  }

  const viewed = repoView(gh);
  const repo = viewed.slug;
  // Without a repository there is no artifact to ask about, so every row would
  // be an unprovable KEEP and the report would read like a clean sweep. That is
  // an inability, and it is named as one.
  if (repo === '' && !noProof) {
    return cannot(`gh cannot name this repository, so no landing can be proven: ${viewed.detail}`, 'gh auth login   # then re-run; or --close --dispatch <id> --no-proof for one pane you have looked at');
  }

  // WHAT AX PROVISIONS IN A WORKTREE, read from the project plan and never
  // re-listed here: `plan.ignore` is the same field `ax init` writes into the
  // managed `.gitignore` block and `ax doctor` grades it against, so the dirty
  // row below and the repair it names cannot disagree about which paths are the
  // tool's own runtime state (../plan.mjs, #83).
  const plan = planProject({ manifest: readManifest(home || cwd) });
  // The checkout `ax init` would run in. `--dispatch` may be typed from outside
  // any repository, and a repair naming an empty path is not a repair.
  const checkout = home === '' ? `<your ${repo || 'own'} checkout>` : home;

  const workers = workerInventory(run);
  if (!workers.ok) return cannot(workers.reason, 'orca orchestration worker-list --json   # the inventory is the only list of releasable dispatches');

  const terminals = terminalInventory(run);
  if (!terminals.ok) return cannot(terminals.reason, 'orca terminal list --json   # a pane that cannot be seen must never be judged closed');

  const store = storeArg || defaultStore(env);
  const index = dispatchIndex(store);
  // A store that cannot be enumerated is not an absence of provenance. Left
  // unread, this is exactly "I could not look" reported as "nothing is there".
  if (!index.missing && index.reason) {
    return cannot(`the dispatch store at ${store} cannot be read: ${index.reason}`, `ls -ld ${shq(store)}   # provenance decides which proof applies to a pane`);
  }

  const seen = new Set(workers.rows.map(row => row.dispatchId));
  const rows = [...workers.rows, ...unaccounted(index, seen)];

  const selfHandle = env.ORCA_TERMINAL_HANDLE ?? '';
  const tally = { released: 0, pending: 0, noTerminal: 0, gone: 0, unprovable: 0, foreign: 0, unplaced: 0 };
  const lines = [];
  const candidates = [];
  let matched = 0;
  let kept = 0;

  const keep = (line, repair = '') => {
    kept += 1;
    lines.push({ level: 'note', text: line, repair });
  };

  // ARCHAEOLOGY, BEHIND --all. A row declined for a reason that needs no
  // repository to establish — a pane already released, gone, never recorded, or
  // one whose release is in flight — is COUNTED on every route and shown one
  // line each under `--all`: the same reading `ax worker ls --all` settled
  // (#82), where the flag changes what is SHOWN and never what was established.
  // `--all` is this repository's archaeology and nothing else — it stopped
  // meaning "every repo on this machine" when placement stopped being a path
  // (#83), so a row belonging to another repository is never listed here as if
  // this run had read it.
  const archaeology = [];
  // How much of those buckets nothing places: a share of the counts above, and
  // never a bucket beside them (see `caused` below).
  let unplacedByCause = 0;

  for (const row of rows) {
    if (only !== '' && row.dispatchId !== only) continue;
    matched += 1;

    const terminal = row.handle === '' ? undefined : terminals.byHandle.get(row.handle);
    // Canonical on both sides: the proof calls below ask the filesystem and git
    // about this path, and a raw `/scope/../elsewhere` from an inventory names a
    // tree other than the one it reads like.
    const worktree = physical(row.worktree || String(terminal?.worktreePath ?? ''));

    // WHICH REPOSITORY THIS ROW BELONGS TO — from the record that dispatched it,
    // never from where its worktree sits. `ours` is judged on artifacts; the
    // other two are declined by `decline()`, each in its own named bucket.
    //
    // An absent `repo` key is UNKNOWN: a record written before `--tracker-repo`
    // existed carries none, and reading that absence as "this repository" would
    // let any checkout close every legacy pane on a host-global store (F-028;
    // that legacy gap is #78's). It is unknown even when the worktree lies
    // inside this checkout — path containment is not evidence about a
    // repository, which is the whole finding of #83.
    //
    // THE IDENTITY IS THE BARE SLUG, trimmed and case-folded, because that is
    // already what a repository IS in this package: `../pr-gate.mjs` binds a
    // ticket with the same comparison and `./settle.mjs` scopes its write with
    // it. A second identity shape introduced here would be a second convention
    // beside a shipped one, and it would read every existing record as unknown.
    //
    // `--no-proof` asks no artifact question, so it has no repository to scope:
    // that route is ONE named pane an operator says they have looked at, and
    // closing a pane belongs to no repository. It is also the only route left
    // for a row nothing places, which is why `decline()` names it.
    //
    // ONE RESIDUAL THIS PREDICATE HAS AND CANNOT CLOSE FROM HERE (found in
    // review on #118; the other, a dispatch class recording no repository,
    // closed 2026-09-03 when `../worker/dispatch.mjs` began recording the
    // dispatching checkout's own identity for `--name` and Linear alike —
    // records written before that still take the `unknown` branch, and
    // `--no-proof` stays their route):
    //   * The key names `owner/repo` and no forge. `trackerRepoOf` accepts a
    //     GitHub Enterprise URL and keeps only the slug, and `repoView` answers
    //     `nameWithOwner`, so one host-global store cannot tell
    //     `github.com/owner/repo` from `ghe.example.com/owner/repo`. Comparing a
    //     host neither side records would make EVERY row unknown, so the fix is
    //     to record it at dispatch first — until then, two same-named
    //     repositories on two forges, dispatched from one machine, compare equal.
    //     Ruled 2026-09-03: the key stays `owner/repo` until a second forge is
    //     measured on a host; every repository this machine dispatches lives on
    //     github.com, and a key-format change touches three readers and every
    //     record already written.
    const entry = index.byDispatch.get(row.dispatchId);
    const belongsTo = entry?.repo ?? '';
    const placed = noProof
      ? 'ours'
      : belongsTo === ''
        ? 'unknown'
        : belongsTo.toLowerCase() === repo.trim().toLowerCase()
          ? 'ours'
          : 'foreign';
    // A CAUSE ESTABLISHED WITHOUT ANY REPOSITORY — the pane is released, gone,
    // never recorded, or its release is in flight. Two disclosures ride on it:
    // the row is listed under `--all` when it is OURS, and it is COUNTED as
    // unplaced-by-record when nothing places it, so the receipt can say how much
    // of its own tally has no repository on record (F-028, #78's gap: 219 of the
    // 243 records on this machine, 2026-09-03). That second number is stated as
    // a share OF those buckets, never as a bucket beside them — a row counted
    // twice is how these numbers stop being readable.
    const caused = reason => {
      if (placed === 'unknown') unplacedByCause += 1;
      if (all && placed === 'ours') archaeology.push(`${row.dispatchId} · ${row.workerState}/${row.terminalState} · ${reason}`);
    };

    // ONE DECLINE, IN TWO MOMENTS. On a sweep a declined row is counted in the
    // bucket that says why; when the caller NAMED it, it is printed with the
    // command that can judge it from where it belongs.
    const decline = () => {
      if (only === '') {
        if (placed === 'foreign') tally.foreign += 1;
        else tally.unplaced += 1;
        return;
      }
      keep(
        placed === 'foreign'
          ? `${row.dispatchId} · ${row.workerState}/${row.terminalState} · KEEP · its record names ${belongsTo}, and this run can only prove landing in ${repo}`
          : `${row.dispatchId} · ${row.workerState}/${row.terminalState} · KEEP · nothing places this pane: ${
              entry === undefined ? 'this host recorded no request for it' : 'its record names no repository'
            }, and an absent repository is UNKNOWN, never "this one" (F-028)`,
        placed === 'foreign'
          ? worktree === ''
            ? `cd <your ${belongsTo} checkout> && ax worker release --close --dispatch ${row.dispatchId}`
            : `cd ${shq(worktree)} && ax worker release --close --dispatch ${row.dispatchId}`
          // A REPAIR THAT CHANGES THE OUTCOME, not a second look at the absence
          // (validated review finding on #118). Reading the record again still
          // computes `unknown`, so this row would refuse forever: what closes it
          // is the route that already exists for one pane an operator has read —
          // `--no-proof`, which asks no artifact question and therefore needs no
          // repository. The transcript is named first because that is what makes
          // the operator's claim ("I looked at it") true rather than asserted,
          // and no ax verb may make it for them.
          : `orca orchestration worker-read --dispatch ${row.dispatchId} --json   # read the pane, then close it on your own word: ax worker release --close --dispatch ${row.dispatchId} --no-proof${
              entry === undefined
                ? '. This host recorded no request for it, so nothing here can place it'
                : `. Its record ${join(store, entry.file)} names no repository — written before --tracker-repo existed, and nothing here may guess one (#78)`
            }`,
      );
    };

    // A PROVEN FOREIGN ROW LEAVES HERE, before any pane-state tally. This run
    // says nothing about another repository's pane — not even that it is already
    // released or gone, which would count it among THIS checkout's archaeology
    // and show it under `--all`.
    //
    // UNKNOWN is not the same claim (F-028): a record naming no repository is
    // not proven foreign, so the facts establishable about its pane without any
    // repository at all — released, gone, no pane recorded, a release in flight —
    // are still counted under their own cause, and only the JUDGEMENT is
    // declined, at the placement site further down. Folding those into the
    // placement bucket would rebuild the residual this file was written to
    // remove: 219 of the 243 records on this machine carry no repository, and
    // `129 already released · 104 terminal gone` would become one unreadable
    // number.
    if (placed === 'foreign') {
      decline();
      continue;
    }

    if (row.terminalState === 'released') {
      tally.released += 1;
      caused('already released — nothing to close');
      continue;
    }
    if (row.terminalState === 'release_pending') {
      tally.pending += 1;
      caused('a release is in flight — it settles on its own or it is chased, never re-issued from here');
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
      caused('no terminal recorded — this dispatch never named a pane to close');
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
      if (terminals.omitted && !localProven) {
        tally.unprovable += 1;
        caused(`pane ${row.handle} is absent from a terminal list that omitted hosts — UNKNOWN here, never a corpse`);
      } else {
        tally.gone += 1;
        caused(`pane ${row.handle} is gone — the terminal this dispatch opened no longer exists`);
      }
      continue;
    }
    if (terminal.orphaned === true) {
      tally.gone += 1;
      caused(`pane ${row.handle} is orphaned — its process is gone`);
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
        // The glob stays OUTSIDE the quotes: quoting `*.json` too would hand
        // grep a literal filename that does not exist.
        `grep -l ${row.dispatchId} ${shq(store)}/*.json   # settle which request owns it`,
      );
      continue;
    }
    // PLACEMENT'S SECOND MOMENT, at the last instant before the artifact
    // question: only `unknown` reaches here (a proven foreign row left before
    // any pane-state tally), and it is declined by the SAME helper — one decline
    // in one place, so a route cannot drift into naming a repair the other does
    // not (it did, for one commit on #118: the late copy still named a
    // `worker-show` that changes nothing).
    if (placed !== 'ours') {
      decline();
      continue;
    }

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
      : prove(gh, git, {
          request: candidate.request,
          issuedAt: candidate.issuedAt,
          worktree: candidate.worktree,
          repo,
          base,
          dispatchId: candidate.dispatchId,
          checkout,
          ignore: plan.ignore,
          recordPath: candidate.request === null ? store : join(store, `${candidate.request}.json`),
        });
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
    // EVERY KEEP CARRIES ITS REPAIR (#147). The proof answers with one; the two
    // verdicts decided here from pane movement carry their own, because neither
    // is an artifact question and neither is a dead end:
    //   * a pane nobody can read is a pane to read — and `--no-proof` is NOT
    //     the route out, because it bypasses the artifact and never the
    //     movement rule, so it would print the same row again.
    //   * a BUSY row LANDED and is still emitting, which is a wait and not a
    //     finding: the pane goes quiet and this verb closes it, or the operator
    //     closes it themselves.
    let repair;
    if (!readable) {
      verdict = 'KEEP';
      why = 'the pane cannot be established — a pane nobody can read is never judged closed';
      repair = `orca terminal read --terminal ${candidate.handle} --json   # why the pane cannot be read; --no-proof will not close it either (it bypasses the artifact, never the movement rule), so close it yourself with orca terminal close --terminal ${candidate.handle} once you have`;
    } else if (!candidate.proof.landed) {
      verdict = 'KEEP';
      why = candidate.proof.detail;
      repair = candidate.proof.repair;
    } else if (moving) {
      // Landed AND still emitting: the work shipped but the session is doing
      // something. --no-proof does not bypass this; it only bypasses the artifact.
      verdict = 'BUSY';
      why = `${candidate.proof.detail}, but the pane is still moving`;
      repair = `orca orchestration worker-read --dispatch ${candidate.dispatchId} --json   # the work landed and this pane is still printing: re-run this verb once it is quiet, or close it yourself with orca terminal close --terminal ${candidate.handle}`;
    } else {
      verdict = 'CLOSE';
      why = candidate.proof.detail;
      repair = '';
    }

    const pane = !readable ? 'INCONNU' : moving ? 'WORKING' : 'QUIET';
    const source = candidate.known ? '' : ' · absent from worker-list (F-048)';
    const text = `${candidate.dispatchId} · ${candidate.workerState}/${candidate.terminalState} · pane ${pane} · ${verdict} · ${why} · ${candidate.request ?? 'no local record'}${source}`;

    if (verdict === 'CLOSE') {
      toClose.push(candidate);
      lines.push({ level: 'ok', text, repair: '' });
    } else {
      keep(text, repair);
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
  //
  // The last two buckets are the silent `continue` #83 removed: a row is
  // declined by PLACEMENT, and a decline this receipt does not name is how 92
  // tallied rows hid the one live merged pane the run existed to close.
  note(
    `not offered: ${tally.released} already released · ${tally.gone} terminal gone · ${tally.noTerminal} no terminal recorded · ` +
      `${tally.pending} release in flight · ${tally.unprovable} pane not establishable · ` +
      `${tally.foreign} in another repository · ${tally.unplaced} no repository on record`,
  );
  if (tally.unprovable > 0) {
    note(`hosts omitted from this terminal list (${terminals.omittedHosts.join(', ')}): a handle absent from it is UNKNOWN here, never a corpse`);
  }
  if (tally.unplaced + unplacedByCause > 0) {
    note(
      `no repository on record: ${tally.unplaced} declined at placement · ${unplacedByCause} of the buckets above — UNKNOWN, never assumed ours (F-028), so nothing there authorizes a close; ` +
        '`ax worker release --dispatch <id>` prints each one with the pane read and the --no-proof close that is its only route',
    );
  }
  if (archaeology.length > 0) {
    note(`--all: the ${archaeology.length} row(s) counted above, one line each — this repository's archaeology, and nothing another repository owns`);
    for (const line of archaeology) note(`  ${redactSecrets(line)}`);
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
          fix(`cat ${shq(join(store, `${entry.request}.json`))}   # settle the last attempt by hand`);
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
