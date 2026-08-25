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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, repoPaths } from './config.mjs';
import { bad, fix, note, section } from './log.mjs';
import { defaultExec } from './exec.mjs';
import { repoSlug } from './gh.mjs';
import { ciGround, clean, commitsGround, firstLine, gitGrounds, keywordGround, must, payload, succeeded, threadsGround } from './pr-grounds.mjs';

const USAGE = 'ax pr gate --pr <n> [--repo <owner/repo>] [--merge] [--ack-body] [--method squash|merge]';

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
  /** Insertion-ordered, so a reprinted command reads the way it was typed. */
  const acks = new Set();
  let method = 'squash';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--pr') pr = value();
    else if (arg === '--repo') repoArg = value();
    else if (arg === '--merge') doMerge = true;
    else if (ACK_FLAGS.includes(arg)) acks.add(arg);
    else if (arg === '--method') method = value();
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
  const grounds = [
    ci,
    threadsGround({ run, owner, name, pr, sha, ciDecided: ci.ciDecided, invocation }),
    gitGrounds({ git, root: paths.root, baseBranch, headBranch, mergeState, residualDir }),
    commitsGround({ run, slug, pr, openedAt, ackBody, invocation }),
    keywordGround({ body, tracker: loaded.prGate?.tracker, pr, slug }),
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

  note(`merging with the SHA this run validated (method: ${method})`);
  const merged = run(['pr', 'merge', pr, '--repo', slug, `--${method}`, '--match-head-commit', sha]);
  if (!succeeded(merged)) {
    bad(`MERGE FAILED — ${firstLine(merged.stderr) || `exit ${merged.status}`}; the head may have moved past ${sha}`);
    fix(`${invocation('--merge')}   # re-run the gate against the new head`);
    return 1;
  }
  note(`MERGED — ${slug}#${pr} at ${sha} (${method})`);
  return 0;
}
