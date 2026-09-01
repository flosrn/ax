// `ax pr gate` — decides whether a pull request may merge, and merges it.
//
// WHY THIS VERB EXISTS (measured 2026-08-09). The gate an orchestrator carried
// in prose read `gh pr checks` and `gh pr view --json`. On `gapila` #1845 that
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
// The grounds themselves live in ./pr-grounds.mjs, one function per ground
// (the three git-backed ones share one, standing on one shared measurement).
// This file resolves the head SHA once, runs them in order, and owns the
// verdict, the printing and the merge.
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
//   3  cannot establish — "no prGate declared", an unreadable merge record,
//      and a recorded merge whose ticket closure could not be observed
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
//
// THE MERGE IS RECORDED BEFORE IT MUTATES (KTD4). Every live mutation in ax
// goes through `record.mjs`'s write-ahead protocol; this verb was the one
// exception, and a crash between its decision and its mutation left nothing to
// replay. The record lives under `<store>/merge/` as `merge-<owner>-<repo>-<pr>`
// and recovery classifies THREE ways: merged at the recorded SHA is
// replayed-success; merged at a DIVERGENT SHA is a named report, never a
// success — the record must not become false proof of validation; open with a
// moved head settles the attempt and opens a new one on a freshly validated
// head; open with the head unchanged reissues the recorded argv byte for byte.
//
// TWO MORE THINGS ONLY THE MERGE PATH DOES. Staleness self-repair (KTD6): when
// base-ancestor staleness is the ONLY refusing ground, the verb updates the
// branch from base and re-runs itself once — a merge that landed a sibling
// makes every open PR stale, and round-tripping each one to its worker is N
// wasted round-trips for a mechanical update. And closure verification (KTD5):
// after a recorded merge, the linked issue is re-read with bounded retries;
// closure is eventually consistent on GitHub's side, and a ticket that never
// closes leaves every dependent deriving from a stale blocker — that is an
// operator escalation (exit 3), never a silent note. The subgraph halt KTD5
// asks for is MECHANICAL, not a marker file: an unclosed issue stays OPEN in
// the tracker, so `ax frontier` keeps every dependent excluded `blocked-by`
// until a human acts — fail-closed by construction, with no cached state that
// can outlive the repair. `gh pr update-branch` is the one unrecorded mutation
// here: it mints no identity and is idempotently re-runnable, which is exactly
// what the record protocol exists to protect.
//
// THE MERGE CALL'S EXIT 0 IS NOT A MERGE. `gh pr merge` exits 0 on three
// different outcomes: the PR merged, auto-merge was ENABLED, or the PR was
// queued. On the last two nothing has landed yet, and printing `MERGED —` there
// publishes a completion nobody observed — with closure then verified against a
// ticket no merge has closed. So a successful merge call is followed by a
// READ-BACK of `state`, and anything but `MERGED` is an inability to establish
// (exit 3): the mutation was issued, its completion was not observed.
//
// THE BODY CLOSURE IS VERIFIED FROM IS THE POST-MERGE ONE. GitHub closes from
// the body as it stands AT MERGE TIME, so the pre-merge capture is the wrong
// text the moment anyone edits the description while the gate runs. The
// read-back above carries `body`, and that is what closure reads.
//
// THE MERGE GESTURE IS SERIALIZED, not merely claimed. `claimRecord` guards the
// BIRTH of a record; the reissue path is reached with the record already born,
// so two concurrent `--merge` runs both read a matching head, both reissue the
// recorded argv and both write `phaseEnd` — one logical mutation issued twice,
// with a load-mutate-save race over the record that proves it. The claim/replay
// decision through `phaseEnd` is therefore held under `record.mjs`'s
// `acquireLock`, exactly as `worker start` holds its claim recovery. A refusal
// names the holder's pid and host and prints the removal rather than taking it:
// `acquireLock` has no time-based takeover, and stealing a lock from a working
// sibling is how the duplicate is born.
//
// A ZERO-LENGTH RECORD IS PRE-MUTATION, NOT UNREADABLE. `claimRecord` creates
// the file and `initRecord` fills it; a crash in between — or a sibling caught
// mid-write — leaves nothing to parse. Calling that "unreadable" printed a
// repair that removes the file, which on the second reading is a live sibling's
// claim. Zero length is the one length write-ahead ordering makes provable: no
// phase, therefore no mutation, so the merge path initialises it and proceeds
// as the first run.
//
// THE DECLARATION MUST BE COMMITTED. `declarationOf` reads the working tree, so
// on a merging run the gate also reads `HEAD:ax.config.json`: a prGate edited
// and not committed would have this gate measure a merge against a declaration
// nobody can review, which is Ground 8's hazard arriving through the filesystem
// instead of through a diff. Detector runs are unaffected — they mutate nothing.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, repoPaths } from './config.mjs';
import { bad, fix, note, section } from './log.mjs';
import { defaultExec } from './exec.mjs';
import { repoSlug } from './gh.mjs';
import {
  ciGround,
  canonical,
  clean,
  closedIssueOf,
  commitsGround,
  declarationGround,
  firstLine,
  gitGrounds,
  keywordGround,
  must,
  payload,
  succeeded,
  threadsGround,
} from './pr-grounds.mjs';
import { acquireLock, argvValue, attemptNew, claimRecord, defaultStore, initRecord, newIdentity, phaseArgv, phaseBegin, phaseCount, phaseEnd } from './worker/record.mjs';

const USAGE = 'ax pr gate --pr <n> [--repo <owner/repo>] [--merge] [--ack-body] [--method squash|merge]';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const defaultSleep = ms => Atomics.wait(waitCell, 0, 0, ms);

/** Closure is event-driven on GitHub's side: the reads and the tick between them. */
const CLOSURE_READS = 5;
const CLOSE_TICK = 2000;

/**
 * The flags that acknowledge a detector's list, declared once so the parser and
 * every command this verb prints read the same set.
 *
 * An acknowledgement is INVOCATION-LOCAL on purpose: it answers for the list
 * ONE run printed, and a body that changed since is a different list — the
 * stale-proof species this file exists to refuse. So it is never persisted, and
 * the cost of that is carried here. Measured 2026-08-25 on ofmchat #72: a PASS
 * under `--ack-body` printed `ax pr gate --pr 72 --merge`, the caller ran
 * exactly that, and the same two post-open commits refused it again. The
 * locality was right; the printed command was the defect.
 */
const ACK_FLAGS = ['--ack-body'];

/**
 * The `prGate` key alone, read from the checkout's own `ax.config.json`.
 *
 * Deliberately NOT `loadCheckoutConfig`, which also enforces `project`, `apps`
 * and `vendor` — the provisioning contract `worktree setup` and `doctor` are
 * built on. This verb reads no port, no app path and no vendor remote, so a
 * project may declare what its merge must prove without adopting a contract it
 * does not use. Measured 2026-08-22: the two repositories whose merge gate this
 * replaces have no `ax.config.json` at all and provision themselves with their
 * own hooks; requiring them to declare a web app in order to gate a pull request
 * would be this package asserting a layout it does not own.
 *
 * A problem elsewhere in the file is a NOTE, never fatal: it cannot change this
 * verdict, so it must not decide it either. An unreadable or absent file, and a
 * `prGate` that is incoherent, both fall through to Ground 0's refusal.
 */
function declarationOf({ root, main }) {
  const notes = [];
  const candidates = [root, main].filter((dir, index, all) => dir && all.indexOf(dir) === index);
  for (const dir of candidates) {
    const path = join(dir, CONFIG_FILE);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed?.prGate !== undefined) return { prGate: parsed.prGate, path, notes };
      notes.push(`${path} declares no prGate`);
    } catch (error) {
      notes.push(`${path} is not readable JSON (${String(error.message ?? error).slice(0, 120)})`);
    }
  }
  return { prGate: undefined, path: join(root, CONFIG_FILE), notes };
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

/**
 * The `prGate` the head COMMITTED, read from git rather than from the disk.
 *
 * The two "confirmed absent" answers git gives are a read that ANSWERED — no
 * declaration is committed — and compare cleanly against a working tree that
 * declares none either. Any other failure is unread, never a match (F-028).
 */
function committedDeclaration(git, root) {
  const shown = git(['show', `HEAD:${CONFIG_FILE}`], root);
  if (succeeded(shown)) {
    try {
      return { ok: true, prGate: JSON.parse(String(shown.stdout ?? '')).prGate };
    } catch (error) {
      return { ok: false, reason: `${CONFIG_FILE} at HEAD is not readable JSON (${clean(String(error.message ?? error))})`, repair: `git show HEAD:${CONFIG_FILE}` };
    }
  }
  const stderr = String(shown.stderr ?? '');
  if (/does not exist|exists on disk, but not in|invalid object name|unknown revision/i.test(stderr)) return { ok: true, prGate: undefined };
  return { ok: false, reason: `git show HEAD:${CONFIG_FILE} failed (${clean(firstLine(stderr))})`, repair: `git show HEAD:${CONFIG_FILE}` };
}

export function gate(
  argv = [],
  {
    gh = (args, at) => defaultExec('gh', args, at),
    git = (args, at) => defaultExec('git', args, at),
    cwd = process.cwd(),
    env = process.env,
    sleep = defaultSleep,
  } = {},
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
  /** Insertion-ordered, so a reprinted command reads the way it was typed. */
  const acks = new Set();
  let method = 'squash';
  /** Set by the one recursive re-run the staleness self-repair issues (KTD6). */
  let staleRetried = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--pr') pr = value();
    else if (arg === '--repo') repoArg = value();
    else if (arg === '--merge') doMerge = true;
    else if (ACK_FLAGS.includes(arg)) acks.add(arg);
    else if (arg === '--method') method = value();
    else if (arg === '--stale-retried') staleRetried = true;
    // Identifiers and flags only — an extra bare word is not a sentence this
    // command reads, it is an argument it does not have.
    else return usageError(`unknown argument "${arg}"`);
  }

  const ackBody = acks.has('--ack-body');

  /**
   * This run's own command line, plus whatever the caller must add next. Every
   * next action this verb prints is a command a caller runs VERBATIM, so it
   * carries what this run consumed — the repository, the acknowledgements the
   * verdict stood on, and a method that is not the default.
   */
  const invocation = (...extra) =>
    [
      'ax pr gate',
      '--pr',
      pr,
      ...(repoArg === '' ? [] : ['--repo', repoArg]),
      ...acks,
      ...(method === 'squash' ? [] : ['--method', method]),
      ...extra,
    ].join(' ');

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

  // This verb reads ONE key and uses no provisioning value — no port, no app
  // path, no vendor remote. So it asks the config for that key alone, rather
  // than through the loader that also enforces `project`/`apps`/`vendor`: a
  // project may declare what its merge must prove without adopting a
  // provisioning contract it does not use, and this package runs in other
  // people's repos. It therefore says NOTHING about the rest of the file —
  // `ax doctor` is where the whole config is judged, and a verdict about a web
  // app has no place in a verdict about a merge.
  const loaded = declarationOf(paths);
  for (const line of loaded.notes) note(line);

  // ── Ground 0. The declaration ──────────────────────────────────────────────
  const declared = readDeclaration(loaded.prGate);
  if (!declared.ok) {
    return cannot(
      `${declared.reason} in ${loaded.path} — an undeclared repository is not a repository with nothing left to check`,
      'add "prGate": { "aggregate": "<check-run name>" } to ax.config.json, or "checks": ["<name>", …] where no aggregate job exists',
    );
  }

  // ── The declaration a MERGE is measured by must be the committed one ──────
  // A detector mutates nothing, so it may report on whatever the disk holds; a
  // merge may not, because an uncommitted prGate is a declaration no review
  // ever saw (Ground 8's hazard, arriving through the filesystem).
  if (doMerge) {
    const committed = committedDeclaration(git, paths.root);
    if (!committed.ok) {
      return cannot(`the committed declaration is unread — ${committed.reason}, so whether this merge's expectation is the committed one cannot be established`, committed.repair);
    }
    if (canonical(committed.prGate) !== canonical(loaded.prGate)) {
      bad(
        `REFUSE — the prGate in ${loaded.path} differs from the one committed at HEAD, so this merge would be measured by a declaration nobody committed`,
      );
      fix(`git diff HEAD -- ${CONFIG_FILE}   # commit that declaration, or discard the edit, then: ${invocation('--merge')}`);
      return 1;
    }
  }

  const run = args => gh(args, paths.root);
  const own = repoSlug(run);
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

  // The default branch, read once: the keyword ground's base pair stands on
  // it, and a failed read leaves the half-pair unread rather than assumed
  // matching (F-028).
  const defaulted = payload(run(['repo', 'view', slug, '--json', 'defaultBranchRef']));
  const defaultBranch = defaulted.ok ? String(defaulted.value?.defaultBranchRef?.name ?? '').trim() : '';

  const store = join(defaultStore(env), 'merge');
  const requestId = `merge-${owner}-${name}-${pr}`;
  const recordPath = join(store, `${requestId}.json`);

  /**
   * KTD5: a merged PR proves delivery only when its ticket actually closed.
   * Bounded re-reads, then an operator escalation: every ticket blocked by an
   * unclosed-but-delivered issue derives from a stale blocker, so the gap must
   * never travel as a note.
   */
  const verifyClosure = body => {
    const issue = closedIssueOf(body);
    if (issue === null) {
      note('closure: the body names no same-repository #N to verify — that ticket moves by hand (declared tracker or cross-repository target)');
      return 0;
    }
    // The two outcomes are kept apart: a read that ANSWERED non-closed, and a
    // read that never answered at all. Reporting the second as the first sent
    // an operator to a repository setting and a `gh issue close` for a ticket
    // whose state nobody had observed — F-028 on the closure read.
    let answeredOnce = false;
    let unread = '';
    for (let attempt = 0; attempt < CLOSURE_READS; attempt += 1) {
      if (attempt > 0) sleep(CLOSE_TICK);
      const read = payload(run(['issue', 'view', String(issue), '--repo', slug, '--json', 'state']));
      if (!read.ok) {
        unread = read.reason;
        continue;
      }
      answeredOnce = true;
      if (String(read.value?.state ?? '').toUpperCase() === 'CLOSED') {
        note(`closure: issue #${issue} reads closed — merged and delivered`);
        return 0;
      }
    }
    if (!answeredOnce) {
      bad(
        `CANNOT ESTABLISH — the closure read 'gh issue view ${issue}' never answered in ${CLOSURE_READS} attempts (${unread}); the merge landed and the ticket's state is unread, which is not the same finding as an unclosed ticket`,
      );
      fix(`gh auth status && gh issue view ${issue} --repo ${slug} --json state`);
      return 3;
    }
    bad(
      `CANNOT ESTABLISH — issue #${issue} is not closed after the recorded merge (${CLOSURE_READS} reads); every ticket blocked by it now stands on a stale blocker, so its subgraph must not re-derive silently`,
    );
    fix(`check the repository setting "auto-close issues with merged linked pull requests", then close by hand: gh issue close ${issue} --repo ${slug}`);
    return 3;
  };

  // ── Replay precheck (KTD4). An existing record means a merge was already
  // issued or intended for this PR; what happened to it decides everything
  // before any ground re-runs.
  // A ZERO-LENGTH file is `claimRecord` interrupted before `initRecord`: there
  // is nothing to parse and nothing to replay, and calling it unreadable
  // printed a repair that deletes what may be a sibling's live claim. The merge
  // path's phase count owns that case instead.
  if (doMerge && existsSync(recordPath) && statSync(recordPath).size > 0) {
    let recordedArgv = null;
    try {
      if (phaseCount(recordPath) > 0) recordedArgv = phaseArgv(recordPath, 'last');
    } catch (error) {
      bad(
        `CANNOT ESTABLISH — the merge record at ${recordPath} is unreadable (${clean(String(error.message ?? error))}); a record that cannot be read is never permission to mint a second mutation`,
      );
      fix(`cat ${recordPath}   # repair or remove it by hand, then re-run`);
      return 3;
    }
    if (recordedArgv !== null) {
      const recordedSha = argvValue(recordedArgv, '--match-head-commit') ?? '';
      const seen = payload(run(['pr', 'view', pr, '--repo', slug, '--json', 'state,headRefOid,body']));
      if (!seen.ok) return cannot(`the replay read 'gh pr view ${pr}' ${seen.reason}`, `gh pr view ${pr} --repo ${slug}`);
      const prState = String(seen.value?.state ?? '').toUpperCase();
      const headNow = String(seen.value?.headRefOid ?? '').trim();
      if (prState === 'MERGED') {
        section(`pr gate — ${slug}#${pr} (replay)`);
        if (recordedSha !== '' && recordedSha === headNow) {
          note(`REPLAYED-SUCCESS — the recorded merge already landed at ${recordedSha}; no second mutation minted`);
          return verifyClosure(typeof seen.value?.body === 'string' ? seen.value.body : '');
        }
        bad(
          `REPLAY — ${slug}#${pr} merged OUTSIDE this gate's validated head (recorded ${recordedSha || 'nothing'}, merged ${headNow || 'unread'}); the record must not become false proof of validation`,
        );
        fix(`gh pr view ${pr} --repo ${slug} --json headRefOid,mergeCommit   # inspect what actually landed, then decide by hand`);
        return 1;
      }
      if (prState === 'CLOSED') {
        bad('REPLAY — the recorded merge\'s PR is now closed unmerged; replaying would mutate a PR someone decided against');
        fix(`gh pr reopen ${pr} --repo ${slug}   # or remove ${recordPath} once the attempt is truly abandoned`);
        return 1;
      }
      note(`replay pending — an unsettled merge record exists for ${slug}#${pr}; the gate revalidates the current head before any reissue`);
    }
  }

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

  section(`pr gate — ${slug}#${pr}`);
  note(`head SHA         ${sha}  (resolved once; every ground below uses this value)`);
  note(`branch / base    ${headBranch} -> ${baseBranch}`);
  // Printed as context and never read as a ground: `BEHIND` only appears where
  // branch protection demands an up-to-date branch (F-033.2).
  note(`mergeStateStatus ${mergeState}  (context only — never a ground here, F-033.2)`);
  note(`expectation      ${declared.mode}: ${declared.expected.join(', ')}`);

  // ── The grounds, in execution order. Each returns its account, and nothing
  // short-circuits (F-033 recorded two grounds firing on the same merge). The
  // one cross-ground fact, ciDecided, travels by signature: threads are read
  // ONLY after CI is decided (F-031).
  const residualDir = typeof loaded.prGate?.residualFindings === 'string' ? loaded.prGate.residualFindings : '';
  const ci = ciGround({ run, slug, sha, declared, pr });
  const gitOut = gitGrounds({ git, root: paths.root, baseBranch, headBranch, mergeState, residualDir });
  const grounds = [
    ci,
    threadsGround({ run, owner, name, pr, sha, ciDecided: ci.ciDecided, invocation }),
    gitOut,
    // The guard stands on the head SHA this run resolved — never on a branch
    // name a stale `origin/<head>` shadows — and on gitGrounds' OWN refresh:
    // `ok` and `local-only` are as fresh as this checkout can be, a failed or
    // unattempted fetch is not, and re-probing origin here would answer about a
    // different moment than the grounds above.
    declarationGround({ git, root: paths.root, baseBranch, sha, refsRefreshed: ['ok', 'local-only'].includes(gitOut.fetchState), pr, slug }),
    commitsGround({ run, slug, pr, openedAt, ackBody, invocation }),
    keywordGround({ body, tracker: loaded.prGate?.tracker, pr, slug, baseBranch, defaultBranch }),
  ];
  const notes = grounds.flatMap(ground => ground.notes);
  const unknowns = grounds.flatMap(ground => ground.unknowns);
  const refusals = grounds.flatMap(ground => ground.refusals);

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

  // ── Staleness self-repair (KTD6): mechanical, once, and only on the merge
  // path — a detector run mutates nothing, and a second staleness refusal
  // routes to the owning worker instead of looping here.
  if (doMerge && code === 1 && unknowns.length === 0 && refusals.every(entry => entry.message.startsWith('staleness:'))) {
    if (staleRetried) {
      note('self-repair already ran once — a second staleness refusal routes to the owning worker, not another update (KTD6)');
    } else {
      note('self-repair: staleness is the only refusing ground — updating the branch from base and re-running this gate once (KTD6)');
      const updated = run(['pr', 'update-branch', pr, '--repo', slug]);
      if (!succeeded(updated)) {
        bad(`self-repair failed — ${firstLine(updated.stderr) || `exit ${updated.status}`}`);
        fix(`gh pr update-branch ${pr} --repo ${slug}   # then: ${invocation('--merge')}`);
        return 1;
      }
      return gate([...argv, '--stale-retried'], { gh, git, cwd, env, sleep });
    }
  }

  if (!doMerge) {
    // A printed command is advice a caller can substitute, and
    // `--match-head-commit` only closes the push race when the exact validated
    // command is the one that runs. So the merge lives here, behind a flag.
    note('DETECTOR RUN — no --merge, so this run decided nothing and mutated nothing');
    fix(`${invocation('--merge')}   # have this gate perform the merge it validated`);
    return code;
  }
  if (code !== 0) {
    note('--merge ignored: the verdict is not a pass, so nothing was mutated');
    return code;
  }

  // ── The merge, recorded before it mutates (KTD4) and held under one lock ──
  mkdirSync(store, { recursive: true, mode: 0o700 });
  let ownership;
  try {
    ownership = acquireLock(recordPath, { suffix: '.merge.lock' });
  } catch (error) {
    return cannot(
      `the merge lock could not be taken: ${clean(String(error.message ?? error))}`,
      `ls -la ${store}   # the lock lives beside the record; fix that path, then re-run`,
    );
  }
  if (!ownership.held) {
    // The lock answer carries the holder's pid and host. The removal is
    // PRINTED, never taken: `acquireLock` has no time-based takeover, and a
    // lock stolen from a working sibling is how one merge is issued twice.
    return cannot(
      `${ownership.reason} — a concurrent gate holds the merge for ${slug}#${pr}, and two runs reissuing one recorded merge is one mutation issued twice`,
      `rm ${recordPath}.merge.lock   # ONLY once no other 'ax pr gate --pr ${pr} --merge' is running, then: ${invocation('--merge')}`,
    );
  }

  try {
    note(`merging with the SHA this run validated (method: ${method})`);
    const mergeArgv = ['pr', 'merge', pr, '--repo', slug, `--${method}`, '--match-head-commit', sha];
    const groundLines = notes.map(entry => entry.message).slice(0, 40);
    const claim = claimRecord(store, requestId);
    let issueArgv = mergeArgv;
    if (claim.claimed) {
      initRecord(claim.path, { request: requestId, orca: 'gh' });
      phaseBegin(claim.path, { name: 'pr-merge', identity: newIdentity(), argv: mergeArgv, grounds: groundLines });
    } else {
      // The precheck established this record is readable and its PR still open,
      // or skipped it because the file is zero-length. Both answer here.
      const empty = statSync(claim.path).size === 0;
      const phases = empty ? 0 : phaseCount(claim.path);
      if (phases === 0) {
        // Claimed and initialised, but no phase was ever begun: write-ahead
        // ordering proves no mutation was issued, so this run may proceed as
        // the first. A zero-length file is initialised here rather than handed
        // to a reader that would have to parse it.
        if (empty) initRecord(claim.path, { request: requestId, orca: 'gh' });
        phaseBegin(claim.path, { name: 'pr-merge', identity: newIdentity(), argv: mergeArgv, grounds: groundLines });
      } else {
        const recordedArgv = phaseArgv(claim.path, 'last');
        const recordedSha = argvValue(recordedArgv, '--match-head-commit') ?? '';
        if (recordedSha === sha) {
          // The replay precheck's read happened BEFORE this lock, so a sibling
          // holding it may have landed the recorded merge in between. Under the
          // lock that state is authoritative: reissuing over a merge that
          // already landed overwrites the recorded receipt of the run that
          // actually issued it, leaving a successful merge recorded as failed.
          const settled = payload(run(['pr', 'view', pr, '--repo', slug, '--json', 'state,headRefOid,body']));
          if (!settled.ok) {
            bad(
              `CANNOT ESTABLISH — with the merge lock held, the read 'gh pr view ${pr}' ${settled.reason}, so whether the recorded merge already landed is unread and a reissue could be a second mutation`,
            );
            fix(`gh pr view ${pr} --repo ${slug} --json state,headRefOid   # then: ${invocation('--merge')}`);
            return 3;
          }
          const settledState = String(settled.value?.state ?? '').toUpperCase();
          const settledHead = String(settled.value?.headRefOid ?? '').trim();
          if (settledState === 'MERGED' && settledHead === sha) {
            note(`REPLAYED-SUCCESS — the recorded merge landed at ${sha} while this run waited for the lock; no second mutation minted`);
            return verifyClosure(typeof settled.value?.body === 'string' ? settled.value.body : '');
          }
          if (settledState === 'MERGED') {
            bad(
              `REPLAY — ${slug}#${pr} merged OUTSIDE this gate's validated head while this run waited for the lock (recorded ${sha}, merged ${settledHead || 'unread'}); the record must not become false proof of validation`,
            );
            fix(`gh pr view ${pr} --repo ${slug} --json headRefOid,mergeCommit   # inspect what landed, then decide by hand`);
            return 1;
          }
          issueArgv = [...recordedArgv];
          note(`replay — reissuing the recorded merge argv byte for byte (head unchanged at ${sha})`);
        } else {
          // KTD4 class (c): the head moved past the recorded SHA. A replacement
          // is a NEW logical attempt on the head THIS run just validated.
          note(`replay — the head moved past the recorded ${recordedSha || 'nothing'}; settling that attempt and opening a new one at ${sha}`);
          attemptNew(claim.path);
          phaseBegin(claim.path, { name: 'pr-merge', identity: newIdentity(), argv: mergeArgv, grounds: groundLines });
        }
      }
    }
    const merged = run(issueArgv);
    phaseEnd(claim.path, 'last', {
      exit: merged.error ? null : (merged.status ?? null),
      receiptText: String(merged.stdout ?? ''),
      stderr: String(merged.stderr ?? ''),
      error: merged.error ? String(merged.error.message ?? merged.error) : null,
    });
    if (!succeeded(merged)) {
      bad(`MERGE FAILED — ${firstLine(merged.stderr) || `exit ${merged.status}`}; the head may have moved past ${sha}`);
      fix(`${invocation('--merge')}   # re-run the gate against the new head`);
      return 1;
    }

    // ── The read-back, STILL UNDER THE LOCK. `gh pr merge` exits 0 on a
    // merge, on auto-merge ENABLED and on a queued PR, so the merge call's own
    // success says only that the mutation was issued — and releasing before
    // this read leaves a sibling free to acquire while GitHub still answers
    // OPEN and reissue over a merge that is landing.
    const landed = payload(run(['pr', 'view', pr, '--repo', slug, '--json', 'state,mergeCommit,body']));
    if (!landed.ok) {
      bad(
        `CANNOT ESTABLISH — the merge was issued and the post-merge read 'gh pr view ${pr}' ${landed.reason}, so whether ${slug}#${pr} merged, queued or enabled auto-merge is unread`,
      );
      fix(`gh pr view ${pr} --repo ${slug} --json state,mergeCommit   # read what the merge did, then re-run this gate to verify closure`);
      return 3;
    }
    const landedState = String(landed.value?.state ?? '').toUpperCase();
    if (landedState !== 'MERGED') {
      bad(
        `CANNOT ESTABLISH — the merge was issued and ${slug}#${pr} reads ${landedState || 'no state'}, not MERGED: the call also exits 0 when it enables auto-merge or queues the PR, so this merge is QUEUED, not completed`,
      );
      fix(`gh pr view ${pr} --repo ${slug} --json state,mergeCommit   # watch it land, then: ${invocation('--merge')} to verify closure`);
      return 3;
    }
    const mergeCommit = clean(String(landed.value?.mergeCommit?.oid ?? '')).slice(0, 12);
    note(`MERGED — ${slug}#${pr} at ${sha} (${method}${mergeCommit === '' ? '' : `, merge commit ${mergeCommit}`})`);

    // Closure is verified from the POST-MERGE body: GitHub closes from the body
    // as it stands at merge time, and the pre-merge capture is a different text
    // the moment the description is edited while this gate runs.
    const landedBody = landed.value?.body;
    if (typeof landedBody !== 'string') {
      bad(
        `CANNOT ESTABLISH — the post-merge read of ${slug}#${pr} answered no body, so the issue GitHub closes from it cannot be named`,
      );
      fix(`gh pr view ${pr} --repo ${slug} --json body   # then verify the linked issue by hand`);
      return 3;
    }
    return verifyClosure(landedBody);
  } finally {
    // Every path releases: a lock outliving its gesture wedges every later run.
    ownership.release();
  }
}
