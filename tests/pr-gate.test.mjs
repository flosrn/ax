// The port of `merge-gate.sh` (624 L) and its propositions.
//
// Two things are real here and everything else is injected. The REPOSITORIES are
// real: each shape below is a `git init` in a temp dir whose `main`/`feature`
// pair reproduces one measured situation, because ancestry, three-dot ranges and
// `rev-list --count` are exactly what a mocked filesystem cannot have. `gh` is
// NOT real: every payload is a fixture, so the suite is offline and — more to the
// point — can hold the one state that matters and never occurs on demand, a
// green dashboard over an unresolved P1 thread (F-031, gapila #1845,
// 2026-08-09).
//
// The fixture bodies carry the P1 prose on purpose. It exists so a test can
// prove the gate never reproduces it: the GraphQL query asks for no `body`
// field, because a review body is contributor-authored text and reproducing it
// into a decision channel puts untrusted prose where a caller reads instructions
// (R11, KTD7).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { subcommandNames } from '../src/commands.mjs';
import { gate, readDeclaration } from '../src/pr-gate.mjs';
import { SUBCOMMANDS, pr as prNoun } from '../src/pr/index.mjs';
import { defaultExec } from '../src/exec.mjs';

const SLUG = 'gapilabs/gapila';
const HEAD_SHA = '3f9a1c27b4d6e8f0a2c4e6081a3c5e7092b4d6f8';
const AGGREGATE = 'Playwright (public games)';
const OPENED = '2026-08-09T10:00:00Z';
const RESIDUAL = 'docs/residual';

/** The P1 body from F-031. It is in the fixture and must never reach the output. */
const P1_BODY =
  'P1: this fix reproduces the very defect it corrects. The merchant spins at the first ' +
  'step, jumps ahead, and because both steps now resolve to the same value, deduplication ' +
  'by value emits no message at all and the winnings screen stays up.';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * `gh pr view` receipt. `mergeStateStatus: CLEAN` is deliberate: never a ground.
 *
 * `HEAD_SHA` is a PLACEHOLDER: the declaration guard reads
 * `<validated sha>:ax.config.json` out of the checkout, so the receipt's head
 * must be a commit the fixture repository actually holds. `run()` swaps this
 * exact value for the shape repo's real `feature` tip, and a test that sets
 * `headRefOid` itself keeps whatever it set.
 */
const prView = (over = {}) => ({
  number: 1845,
  headRefOid: HEAD_SHA,
  headRefName: 'feature',
  baseRefName: 'main',
  body: 'Closes #1786',
  createdAt: OPENED,
  mergeStateStatus: 'CLEAN',
  ...over,
});

const checkRun = (name, conclusion, status = 'completed') => ({ name, status, conclusion, head_sha: HEAD_SHA });

/**
 * F-031's check set: the aggregate verdict green, and three review bots reporting
 * `neutral` — neither a success nor a failure, and invisible to the dashboard
 * that came before. Four rows here, and a sibling PR would show a different
 * count (F-014): the count is never the measurement.
 */
const greenChecks = () => [
  checkRun(AGGREGATE, 'success'),
  checkRun('claude-review', 'neutral'),
  checkRun('codex-review', 'neutral'),
  checkRun('cursor-bugbot', 'neutral'),
];

const thread = (id, isResolved, over = {}) => ({
  id,
  isResolved,
  isOutdated: false,
  // `body` is here to prove it never comes out. The real query never asks for it.
  comments: {
    nodes: [{ author: { login: 'reviewer' }, path: 'apps/web/spin.ts', url: `https://github.com/${SLUG}/pull/1845#discussion_${id}`, body: P1_BODY }],
  },
  ...over,
});

const threadPage = (nodes, hasNextPage = false, endCursor = null) => ({
  data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
});

/** Two commits, `lateCount` of them landed after the PR was opened (KTD9's ground). */
const prCommits = lateCount => {
  const rows = [{ sha: 'aaaaaaaaaaaa1111', commit: { committer: { date: '2026-08-09T09:00:00Z' } } }];
  for (let i = 0; i < lateCount; i += 1) {
    // Distinct in the first TWELVE characters, which is all the gate prints.
    rows.push({ sha: `bbbbbbbbbb${i}${i}3333`, commit: { committer: { date: '2026-08-09T11:00:00Z' } } });
  }
  return rows;
};

const DEFAULT_GATE = { aggregate: AGGREGATE };

// ── Sandbox ─────────────────────────────────────────────────────────────────

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'ignore' });

/** One real commit id out of a fixture repository. */
const shaOf = (cwd, ref) => execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).trim();

const commit = (cwd, path, content, message) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
};

const writeConfig = (root, prGate) =>
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({ project: { name: 'fixture' }, apps: { web: 'apps/web' }, vendor: { repo: 'makerkit/kit' }, ...(prGate ? { prGate } : {}) }),
  );

/**
 * The dispatch record that BINDS a PR to the ticket it was dispatched for,
 * written the way `initRecord`/`phaseBegin` write it — the gate reads it with
 * record.mjs's own strictness, so `request` must equal the file's stem and only
 * a `worker-start` phase may name a placement.
 *
 * `worktree` is the local placement selector (`--worktree path:<abs>`), which is
 * how a dispatch records WHERE it put the branch; a record written without one
 * is matched by its request id against the PR's head branch instead.
 */
const writeRecord = (storeDir, { request, worktree = '', repo = SLUG } = {}) => {
  mkdirSync(storeDir, { recursive: true });
  const path = join(storeDir, `${request}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      request,
      host: hostname(),
      orca: 'orca',
      createdAt: OPENED,
      ...(repo === null ? {} : { repo }),
      attempts: [
        {
          n: 1,
          settled: false,
          phases: [
            {
              name: 'worker-start',
              identity: '11111111-1111-4111-8111-111111111111',
              argv: ['orchestration', 'worker-start', '--task', 'task_1', ...(worktree === '' ? [] : ['--worktree', `path:${worktree}`]), '--json'],
              receiptPath: null,
              receipt: null,
              exit: null,
              beganAt: OPENED,
            },
          ],
        },
      ],
    }),
  );
  return path;
};

/**
 * A repository whose `main`/`feature` pair reproduces one measured shape.
 *
 * The declaration is COMMITTED, in the pre-branch commit both sides share: the
 * merge path refuses a working-tree prGate the head does not carry, and the
 * declaration guard refuses a prGate this branch edits. A fixture that left
 * `ax.config.json` untracked would therefore be measuring a declaration nobody
 * committed — which is the very thing under test, not a background condition.
 */
function buildRepo(root, shape, prGate) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  // The inherited shape writes the residual directory on the BASE, before the
  // branch point: that is F-039's repository, where the file is present in the
  // tree and is not this branch's record.
  if (shape === 'residual-inherited') commit(root, `${RESIDUAL}/f-001.md`, 'a finding main filed\n', 'main files a residual');
  writeConfig(root, prGate);
  commit(root, 'README.md', '# fixture\n', 'first');
  git(root, 'checkout', '-q', '-b', 'feature');

  if (shape === 'current' || shape === 'stale' || shape === 'landed' || shape === 'residual-inherited') {
    commit(root, 'src/a.txt', 'a\n', 'feature work');
  }
  if (shape === 'stale') {
    git(root, 'checkout', '-q', 'main');
    commit(root, 'src/b.txt', 'b\n', 'the base moved');
    git(root, 'checkout', '-q', 'feature');
  }
  if (shape === 'landed') {
    // A squash: the base now carries the same content under a new commit, so
    // ancestry answers "not merged" for the branch that just landed (F-033.1).
    git(root, 'checkout', '-q', 'main');
    commit(root, 'src/a.txt', 'a\n', 'squashed');
    git(root, 'checkout', '-q', 'feature');
  }
  if (shape === 'residual-stale') {
    commit(root, `${RESIDUAL}/f-001.md`, 'a finding\n', 'file a residual');
    commit(root, 'src/a.txt', 'a\n', 'keep working past it');
  }
  if (shape === 'residual-current') {
    commit(root, 'src/a.txt', 'a\n', 'work');
    commit(root, `${RESIDUAL}/f-001.md`, 'a finding\n', 'file a residual last');
  }
  return root;
}

const repos = {};
let sandbox = '';

/**
 * The repository for one shape AND one declaration, built on demand and reused.
 * Keyed by both because the declaration is committed at the branch point: two
 * tests declaring different prGate values cannot share one checkout.
 */
const repoFor = (shape, prGate) => {
  const key = `${shape}::${JSON.stringify(prGate ?? null)}`;
  if (!repos[key]) repos[key] = buildRepo(join(sandbox, `r${Object.keys(repos).length}-${shape}`), shape, prGate);
  return repos[key];
};

before(() => {
  // realpath up front: os.tmpdir() is a symlink on macOS and git reports
  // physical paths, so `repoPaths` would answer a path these expectations do not
  // hold.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ax-pr-gate-')));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

const answered = stdout => ({ status: 0, stdout, stderr: '', error: undefined });
const refusedByGh = stderr => ({ status: 1, stdout: '', stderr, error: undefined });

const realGit = (args, at) => defaultExec('git', args, at);

/**
 * One gate run, fully injected.
 *
 * `null` for a fixture means "that call failed", which is a different finding
 * from an empty payload and is tested as one. `threads` is a LIST of pages, so
 * pagination is modelled by the sequence the stub hands back. `git` may be
 * wrapped to fail one call and delegate the rest to the real repository.
 *
 * `record` is the dispatch record that binds this PR to its ticket: by default
 * a dispatch for #1786 placed in THIS checkout, which is what the fixture body
 * closes. `record: null` models a PR no dispatch on this host recorded.
 */
const run = (
  argv,
  {
    shape = 'current',
    prGate = DEFAULT_GATE,
    receipt,
    checks,
    threads,
    commits,
    slug = SLUG,
    mergeFails = false,
    git: gitOverride,
    defaultBranch = 'main',
    issueStates = ['CLOSED'],
    prStates,
    store,
    record = { request: '1786-work' },
    updateBranchFails = false,
    onMerge,
    onPrView,
  } = {},
) => {
  // The declaration rides the fixture's pre-branch commit, so the working tree
  // and the head carry the same one — the merging path refuses any other.
  const root = repoFor(shape, prGate);
  writeConfig(root, prGate);
  const headSha = shaOf(root, 'feature');

  const calls = [];
  const pages = threads ?? [threadPage([])];
  let page = 0;
  let issuePoll = 0;
  let prViews = 0;

  const gh = args => {
    calls.push(args.join(' '));
    const [verb, target] = args;
    if (verb === 'repo' && target === 'view' && args.includes('defaultBranchRef')) {
      return defaultBranch === null ? refusedByGh('HTTP 502') : answered(JSON.stringify({ defaultBranchRef: { name: defaultBranch } }));
    }
    if (verb === 'repo' && target === 'view') return slug === null ? refusedByGh('no remote') : answered(`${slug}\n`);
    if (verb === 'pr' && target === 'view') {
      // An OBSERVER: a test may inspect on-disk state at the moment of a read
      // (which lock is held while the read-back runs), never answer for it.
      if (onPrView) onPrView(args);
      // `prStates` sequences the receipts a replaying run reads; the plain
      // `receipt` answers every read. The POST-MERGE read-back is a distinct
      // call (`--json state,mergeCommit,body`), so a run that does not sequence
      // its states still gets the MERGED answer that read exists to check.
      const readBack = args.includes('state,mergeCommit,body');
      const base = receipt === null ? null : (receipt ?? prView());
      const answer = prStates ? prStates[Math.min(prViews, prStates.length - 1)] : base === null ? null : readBack ? { ...base, state: 'MERGED' } : base;
      prViews += 1;
      // The placeholder becomes the fixture's real head: the declaration guard
      // reads `<sha>:ax.config.json` out of this checkout.
      const body = answer !== null && answer?.headRefOid === HEAD_SHA ? { ...answer, headRefOid: headSha } : answer;
      return body === null || body === undefined ? refusedByGh('could not resolve to a Pull Request') : answered(JSON.stringify(body));
    }
    if (verb === 'pr' && target === 'update-branch') return updateBranchFails ? refusedByGh('update failed') : answered('updated\n');
    if (verb === 'pr' && target === 'merge') {
      // `onMerge` may RETURN a forced result (a transport crash is data, not a
      // throw); an observer hook returns anything else and is ignored.
      const forced = onMerge ? onMerge(args) : undefined;
      if (forced && typeof forced === 'object' && ('status' in forced || 'error' in forced)) return forced;
      return mergeFails ? refusedByGh('Head branch was modified') : answered('merged\n');
    }
    if (verb === 'issue' && target === 'view') {
      const state = issueStates[Math.min(issuePoll, issueStates.length - 1)];
      issuePoll += 1;
      return state === null ? refusedByGh('HTTP 502') : answered(JSON.stringify({ state }));
    }
    if (verb === 'api' && target === 'graphql') {
      // Exhaustion repeats the LAST page (a staleness self-repair re-runs the
      // whole gate); a test modelling a failed page still says so with null.
      const body = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return body === null || body === undefined ? refusedByGh('GraphQL: Something went wrong') : answered(JSON.stringify(body));
    }
    if (verb === 'api' && target.includes('/check-runs')) {
      if (checks === null) return refusedByGh('HTTP 502');
      // A string fixture is RAW stdout: a call that exited 0 and answered
      // something that is not JSON at all.
      if (typeof checks === 'string') return answered(checks);
      return answered(JSON.stringify(checks === undefined ? { check_runs: greenChecks() } : checks));
    }
    if (verb === 'api' && target.includes('/pulls/')) {
      return commits === null ? refusedByGh('HTTP 502') : answered(JSON.stringify(commits ?? prCommits(0)));
    }
    return refusedByGh(`unstubbed gh call: ${args.join(' ')}`);
  };

  // Every run gets its OWN store unless the test replays across runs: the merge
  // record is keyed by owner/repo/pr, so a shared default would leak one test's
  // record into the next as a phantom replay.
  const storeDir = store ?? mkdtempSync(join(sandbox, 'store-'));
  const env = { HOME: sandbox, ORCA_DISPATCH_STORE: storeDir };
  // The dispatch record lives in the store ROOT (the merge namespace is the
  // `merge/` subdirectory below it), and its default placement is this
  // checkout: the fixture's branch is the one a dispatch for #1786 would have
  // put here.
  if (record !== null) writeRecord(storeDir, { worktree: root, ...record });
  const result = capture(() => gate([...argv], { gh, git: gitOverride ?? realGit, cwd: root, env, sleep: () => {} }));
  return { ...result, calls, store: storeDir, headSha };
};

const CLEAN = { threads: [threadPage([thread('T1', true)])] };

// ── Ground 0: the declaration ───────────────────────────────────────────────

test('no declaration for this checkout is cannot-establish, not a pass', () => {
  const { code, out, calls } = run(['--pr', '1845'], { prGate: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — no prGate key/);
  assert.match(out, /an undeclared repository is not a repository with nothing left to check/);
  assert.match(out, /→ add "prGate"/);
  // Nothing was even asked of GitHub: the run stops before any ground.
  assert.deepEqual(calls, []);
});

test('a declaration naming both an aggregate and a list of checks cannot be read', () => {
  const { code, out } = run(['--pr', '1845'], { prGate: { aggregate: AGGREGATE, checks: ['ʦ TypeScript'] } });
  assert.equal(code, 3);
  assert.match(out, /declares both aggregate and checks/);
});

test('the declaration reader names each incoherent shape instead of defaulting', () => {
  assert.equal(readDeclaration(undefined).ok, false);
  assert.equal(readDeclaration({}).reason, 'prGate declares neither aggregate nor checks');
  assert.equal(readDeclaration({ aggregate: '  ' }).reason, 'prGate.aggregate is not a check-run name');
  assert.equal(readDeclaration({ checks: [] }).reason, 'prGate.checks is not a non-empty list');
  assert.equal(readDeclaration({ checks: ['ok', ''] }).reason, 'prGate.checks holds a value that is not a name');
  assert.deepEqual(readDeclaration({ checks: ['a', 'b'] }), { ok: true, mode: 'checks', expected: ['a', 'b'] });
  assert.deepEqual(readDeclaration({ aggregate: AGGREGATE }), { ok: true, mode: 'aggregate', expected: [AGGREGATE] });
});

// ── The setup every ground depends on ───────────────────────────────────────

test('a PR receipt that cannot be read stops the run before any ground', () => {
  const { code, out, calls } = run(['--pr', '1845'], { receipt: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — 'gh pr view 1845 --repo gapilabs\/gapila' failed/);
  assert.ok(!calls.some(call => call.includes('check-runs')), 'no ground ran');
});

test('a receipt missing a field this gate needs is cannot-establish, never an empty value', () => {
  const { code, out } = run(['--pr', '1845'], { receipt: { ...prView(), headRefName: undefined } });
  assert.equal(code, 3);
  assert.match(out, /'headRefName' is absent from the payload/);
});

test('a head SHA that is not 40 hex characters is never used to validate anything', () => {
  // Both halves, because they fail differently. A non-hex value is obviously
  // wrong; a value that is hex but the WRONG LENGTH is the dangerous one — it
  // interpolates cleanly into `repos/<r>/commits/<sha>/check-runs`, which then
  // answers about a commit nobody asked about, and into `--match-head-commit`,
  // where the race this gate closes is exactly a SHA that does not match.
  for (const oid of ['HEAD', 'abcdef', `${HEAD_SHA}0`, HEAD_SHA.slice(0, 39), HEAD_SHA.toUpperCase(), '']) {
    const { code, out, calls } = run(['--pr', '1845'], { receipt: prView({ headRefOid: oid }) });
    assert.equal(code, 3, `${JSON.stringify(oid)} must stop the run`);
    assert.match(out, /the head SHA is not a 40-hex commit id|a field this gate needs is empty/);
    assert.ok(!calls.some(call => call.includes('check-runs')), `${JSON.stringify(oid)} reached the API`);
  }
  // Surrounding whitespace is NOT one of those cases: every receipt field is
  // trimmed before it is validated, so this is the same commit id and the run
  // proceeds on it.
  assert.notEqual(run(['--pr', '1845'], { receipt: prView({ headRefOid: `  ${shaOf(repoFor('current', DEFAULT_GATE), 'feature')}\n` }) }).code, 3);
});

test('a checkout may declare its gate WITHOUT the provisioning contract', () => {
  // Measured 2026-08-22: the two repositories whose merge gate this replaces have
  // no `ax.config.json` at all and provision themselves with their own hooks.
  // Requiring them to declare a web app, a port range and a vendor remote in
  // order to gate a pull request would be this package asserting a layout it does
  // not own — and this verb reads none of those values.
  const root = repoFor('current', DEFAULT_GATE);
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } }));
  const { code, out } = capture(() =>
    // `--issue` because this run injects no dispatch store: the caller names the
    // ticket it is gating, which is the orchestrator's own gesture.
    gate(['--pr', '1845', '--issue', '1786'], {
      gh: args => {
        const [verb, target] = args;
        if (verb === 'repo' && target === 'view' && args.includes('defaultBranchRef')) return answered(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
        if (verb === 'repo' && target === 'view') return answered(`${SLUG}\n`);
        if (verb === 'pr' && target === 'view') return answered(JSON.stringify(prView({ headRefOid: shaOf(root, 'feature') })));
        if (verb === 'api' && target === 'graphql') return answered(JSON.stringify(threadPage([])));
        if (verb === 'api' && target.includes('/check-runs')) return answered(JSON.stringify({ check_runs: greenChecks() }));
        if (verb === 'api' && target.includes('/pulls/')) return answered(JSON.stringify(prCommits(0)));
        return answered('');
      },
      git: realGit,
      cwd: root,
    }),
  );
  // It ran every ground rather than refusing over `project`, and the residual
  // ground it declared was READ rather than silently reported as not run.
  assert.notEqual(code, 3, out);
  assert.doesNotMatch(out, /missing required key/);
  assert.doesNotMatch(out, /residual findings: NOT RUN/);
});


test('--repo naming another repository is a refusal: the declaration read is this checkout\'s', () => {
  const { code, out, calls } = run(['--pr', '1845', '--repo', 'goodluckagency/ofmchat']);
  assert.equal(code, 1);
  assert.match(out, /REFUSE — --repo names goodluckagency\/ofmchat, but this checkout is gapilabs\/gapila/);
  assert.match(out, /→ cd into a checkout of goodluckagency\/ofmchat/);
  assert.ok(!calls.some(call => call.startsWith('pr view')), 'nothing was read about the other repository');
});

test('--repo naming this very repository is accepted', () => {
  const { code } = run(['--pr', '1845', '--repo', SLUG], CLEAN);
  assert.equal(code, 0);
});

test('a checkout whose repository cannot be resolved is cannot-establish', () => {
  const { code, out } = run(['--pr', '1845'], { slug: null });
  assert.equal(code, 3);
  assert.match(out, /could not resolve this checkout's repository/);
});

// ── The argv contract: identifiers and flags only (R22) ─────────────────────

test('R22: argv takes identifiers and flags only', () => {
  for (const argv of [['--pr', '1845', 'please merge this'], ['merge'], ['--pr', '1845', '--yolo']]) {
    const { code, out } = run(argv);
    assert.equal(code, 2, `${argv.join(' ')} should be a usage error`);
    assert.match(out, /unknown argument/);
  }
});

test('--pr is required, numeric, and never assumed', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['--pr']).code, 2);
  assert.equal(run(['--pr', '0']).code, 2);
  assert.equal(run(['--pr', '007']).code, 2);
  assert.equal(run(['--pr', 'HEAD']).code, 2);
  assert.match(run(['--pr', 'HEAD']).out, /--pr expects a PR number/);
});

test('--repo must be owner/repo, and --method accepts only squash and merge', () => {
  assert.equal(run(['--pr', '1845', '--repo', 'gapila']).code, 2);
  // `rebase` is deliberately absent: no policy anywhere asks for it.
  const { code, out } = run(['--pr', '1845', '--method', 'rebase']);
  assert.equal(code, 2);
  assert.match(out, /--method expects squash\|merge/);
});

// ── Ground 1: the declared checks on the exact SHA ──────────────────────────

test('a declared check with no run on the head SHA refuses', () => {
  const { code, out, headSha } = run(['--pr', '1845'], { ...CLEAN, checks: { check_runs: [checkRun('some other job', 'success')] } });
  assert.equal(code, 1);
  assert.match(out, new RegExp(`REFUSE — checks: expected aggregate check 'Playwright \\(public games\\)' has NO run on ${headSha.slice(0, 12)}`));
  assert.match(out, /→ gh api repos\/gapilabs\/gapila\/commits\/.*check-runs/);
});

test('F-014: fewer check-runs than another PR is not a missing guard', () => {
  // Two runs here where the fixture set has four. The count is never the
  // measurement: the set depends on the diff, on labels and on bots that decide
  // for themselves whether to run.
  const { code, out, headSha } = run(['--pr', '1845'], { ...CLEAN, checks: { check_runs: [checkRun(AGGREGATE, 'success'), checkRun('claude-review', 'neutral')] } });
  assert.equal(code, 0);
  assert.match(out, new RegExp(`checks: 2 check-run\\(s\\) reported on ${headSha.slice(0, 12)}`));
});

test('F-031: a declared check concluding neutral refuses — neither success nor failure', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: { check_runs: [checkRun(AGGREGATE, 'neutral')] } });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — checks: 'Playwright \(public games\)' concluded neutral/);
});

test('a check still running is not decided, and that is an unknown, not a pass', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: { check_runs: [checkRun(AGGREGATE, null, 'in_progress')] } });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — checks: 'Playwright \(public games\)' is in_progress/);
});

test('a check-runs call that fails leaves CI unread rather than green', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — checks: 'gh api .*check-runs' failed — HTTP 502; CI state unread/);
});

test('F-004: the unknown carries the diagnostic, it does not consume it', () => {
  // Two different failures, and neither may be reported as a bare "could not
  // read": the reason is what a caller acts on. F-004 records the one time a
  // `jq` failure inside a pipe ate the only diagnostic that mattered.
  assert.match(run(['--pr', '1845'], { ...CLEAN, checks: null }).out, /HTTP 502/);
  const notJson = run(['--pr', '1845'], { ...CLEAN, checks: 'gh: command not found\n' });
  assert.equal(notJson.code, 3);
  assert.match(notJson.out, /checks: 'gh api .*check-runs' answered something that is not JSON/);
});

test('F-028: an absent check_runs container raises instead of becoming an empty one', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: {} });
  assert.equal(code, 3);
  assert.match(out, /'check_runs' is absent from the payload/);
});

// ── Ground 2: review threads, only after CI is decided ─────────────────────

test('F-031: green everywhere, one unresolved thread — refuses and names it', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadPage([thread('T_p1', false), thread('T_ok', true)])] });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — threads: unresolved thread T_p1 by reviewer on apps\/web\/spin\.ts/);
  assert.match(out, /discussion_T_p1/);
  // The resolved one is silent, and the count is stated.
  assert.match(out, /threads: page 1 — 2 thread\(s\), 1 unresolved/);
});

test('R11: a refusal reproduces no substring of the comment body', () => {
  const { out } = run(['--pr', '1845'], { threads: [threadPage([thread('T_p1', false)])] });
  assert.doesNotMatch(out, /reproduces the very defect/);
  assert.ok(!out.includes(P1_BODY.slice(0, 40)), 'the review prose reached the output');
});

test('the GraphQL query asks for no body field anywhere', () => {
  const { calls } = run(['--pr', '1845'], CLEAN);
  const graphql = calls.find(call => call.startsWith('api graphql'));
  assert.ok(graphql, 'no GraphQL call was issued');
  assert.doesNotMatch(graphql, /body/);
  assert.match(graphql, /isResolved isOutdated/);
});

test('#1865: every thread resolved — no refusal on threads', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadPage([thread('T1', true), thread('T2', true)])] });
  assert.equal(code, 0);
  assert.match(out, /threads: page 1 — 2 thread\(s\), 0 unresolved/);
});

test('a thread beyond the first page is still read', () => {
  const { code, out, calls } = run(['--pr', '1845'], {
    threads: [threadPage([thread('T1', true)], true, 'CURSOR_2'), threadPage([thread('T_p1', false)])],
  });
  assert.equal(code, 1);
  assert.match(out, /unresolved thread T_p1/);
  const graphql = calls.filter(call => call.startsWith('api graphql'));
  assert.equal(graphql.length, 2);
  assert.match(graphql[1], /cursor=CURSOR_2/);
});

test('a page that claims a successor and names no cursor leaves the rest unread', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadPage([thread('T1', true)], true, null)] });
  assert.equal(code, 3);
  assert.match(out, /claims a next one and names no cursor/);
});

test('a GraphQL query that fails leaves resolution state unread', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [null] });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — threads: the GraphQL reviewThreads query failed/);
});

test('F-028: a GraphQL payload missing its containers raises rather than reading zero threads', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [{ data: { repository: null } }] });
  assert.equal(code, 3);
  assert.match(out, /'repository' is absent from the payload/);
});

test('threads read before CI is decided are no observation at all', () => {
  const { code, out, calls, headSha } = run(['--pr', '1845'], {
    threads: [threadPage([thread('T1', true)])],
    checks: { check_runs: [checkRun(AGGREGATE, null, 'queued')] },
  });
  assert.equal(code, 3);
  assert.match(out, new RegExp(`threads: CI is not decided on ${headSha} — a thread read now is no observation at all`));
  // The proof is the absence of the call: an empty thread read here would look
  // exactly like a clean one (F-031, #1847).
  assert.ok(!calls.some(call => call.startsWith('api graphql')), 'a GraphQL call was issued while CI was undecided');
});

// ── Ground 3: staleness by ancestry ────────────────────────────────────────

test('F-033.2: a base that advanced refuses, while mergeStateStatus still reads CLEAN', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'stale' });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — staleness: main is not an ancestor of feature — the branch is behind its base \(mergeStateStatus reads CLEAN, which is not the question\)/);
  assert.match(out, /mergeStateStatus CLEAN {2}\(context only — never a ground here, F-033\.2\)/);
});

test('a branch carrying its base is current', () => {
  const { code, out } = run(['--pr', '1845'], CLEAN);
  assert.equal(code, 0);
  assert.match(out, /staleness: feature carries main — the branch is current/);
});

test('outside a git checkout, ancestry is unread rather than assumed', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    git: (args, at) => (args[0] === 'rev-parse' && args[1] === '--git-dir' ? refusedByGh('not a git repository') : realGit(args, at)),
  });
  assert.equal(code, 3);
  assert.match(out, /staleness: not inside a git checkout/);
  assert.match(out, /landed-by-content: not decided — not inside a git checkout/);
});

test('refs that cannot be refreshed are cannot-establish: a stale local ref must never decide staleness', () => {
  // Measured 2026-08-14 on #1939. The dangerous direction is the symmetric one:
  // a stale local `origin/main` makes a branch that HAS fallen behind read as
  // current, which is this gate passing the very thing it exists to stop.
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    shape: 'stale',
    git: (args, at) => {
      if (args[0] === 'remote') return answered('git@github.com:gapilabs/gapila.git\n');
      if (args[0] === 'fetch') return refusedByGh('fatal: could not read from remote repository');
      return realGit(args, at);
    },
  });
  assert.equal(code, 3, 'a failed fetch must not fall through to a comparison');
  assert.match(out, /could not fetch 'main' and 'feature' from origin/);
  assert.doesNotMatch(out, /the branch is behind its base/);
  assert.match(out, /landed-by-content: not decided — the refs could not be refreshed/);
});

test('a branch absent from this checkout is cannot-establish, never a pass', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ headRefName: 'no-such-branch' }) });
  assert.equal(code, 3);
  assert.match(out, /staleness: 'main' or 'no-such-branch' is absent from this checkout/);
});

// ── Ground 4: landed by content (advisory, never a refusal) ────────────────

test('F-033.1: a squashed branch is landed by content though ancestry says no', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'landed' });
  assert.match(out, /landed-by-content: YES — content equal to main.*ancestry says no/);
  // The only refusal is staleness. This ground never contributes one.
  assert.equal(code, 1);
  assert.doesNotMatch(out, /REFUSE — landed-by-content/);
  // Counted on the finding glyph, so the verdict's own "REFUSE — N reason(s)"
  // summary line is not mistaken for a fifth ground.
  assert.equal(out.match(/✗ REFUSE — /g).length, 1);
});

test('a branch with its own work reports the files that still differ', () => {
  const { out } = run(['--pr', '1845'], CLEAN);
  assert.match(out, /landed-by-content: NO — 1 file\(s\) still differ from main \(ancestry says no\)/);
});

test('a diff that cannot be taken is reported, and still never refuses', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    git: (args, at) => (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'main' ? refusedByGh('fatal: bad revision') : realGit(args, at)),
  });
  assert.equal(code, 0);
  assert.match(out, /landed-by-content: not decided — 'git diff' failed/);
});

// ── Ground 5: the residual-findings file ───────────────────────────────────

test('F-009: a residual file this branch wrote, then superseded, refuses', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'residual-stale', prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — residual findings: this branch wrote docs\/residual at [0-9a-f]{12} and 1 of its own commit\(s\) landed after it/);
  assert.match(out, /→ git log main\.\.feature/);
});

test('a residual file written by the newest commit does not refuse', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'residual-current', prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } });
  assert.equal(code, 0);
  assert.match(out, /residual findings: written by this branch at [0-9a-f]{12}, the newest commit on feature/);
});

test('F-039: a residual file the branch inherited from the base is not this branch\'s record', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'residual-inherited', prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } });
  assert.equal(code, 0);
  assert.match(out, /residual findings: \[DETECTOR\] this branch wrote nothing under docs\/residual/);
  assert.match(out, /read the PR's linked issues \(F-011\)/);
  assert.doesNotMatch(out, /REFUSE — residual findings/);
});

test('an undeclared residualFindings means the ground is NOT RUN, and the gate says so', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'residual-stale' });
  assert.equal(code, 0);
  assert.match(out, /residual findings: NOT RUN — this checkout declares no prGate\.residualFindings, and an unrun ground is not a passed one/);
  assert.doesNotMatch(out, /REFUSE — residual findings/);
  assert.doesNotMatch(out, /CANNOT ESTABLISH — residual findings/);
});

test('a residual directory that differs with no commit behind it is cannot-establish', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    shape: 'residual-stale',
    prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL },
    git: (args, at) => (args[0] === 'log' ? answered('\n') : realGit(args, at)),
  });
  assert.equal(code, 3);
  assert.match(out, /residual findings: docs\/residual differs from main but no commit on this branch touched it/);
});

test('a rev-list that cannot count is cannot-establish, never zero later commits', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    shape: 'residual-stale',
    prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL },
    git: (args, at) => (args[0] === 'rev-list' ? refusedByGh('fatal: bad revision') : realGit(args, at)),
  });
  assert.equal(code, 3);
  assert.match(out, /residual findings: 'git rev-list --count' could not answer/);
});

// ── Ground 6: the commits since the PR opened (a detector) ─────────────────

test('commits landed since the PR opened refuse, and say they are a detector', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, commits: prCommits(2) });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — commits since open \[DETECTOR\]: 2 commit\(s\) landed after the PR was opened \(bbbbbbbbbb00 bbbbbbbbbb11\)/);
  assert.match(out, /--ack-body/);
});

test('--ack-body clears the commit list without touching another ground', () => {
  const { code, out } = run(['--pr', '1845', '--ack-body'], { ...CLEAN, commits: prCommits(2) });
  assert.equal(code, 0);
  assert.match(out, /commits since open: 2 acknowledged via --ack-body/);
});

test('a PR with no commit after it opened says so', () => {
  const { out } = run(['--pr', '1845'], CLEAN);
  assert.match(out, /commits since open: none — the body describes every commit on the branch/);
});

test('a commits call that fails, or a payload missing its named keys, is cannot-establish', () => {
  assert.equal(run(['--pr', '1845'], { ...CLEAN, commits: null }).code, 3);
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, commits: [{ sha: 'x' }] });
  assert.equal(code, 3);
  assert.match(out, /commits since open: a PR commit: 'commit' is absent from the payload/);
});

// ── Ground 7: the closing keyword ──────────────────────────────────────────

test('F-018: a French closing keyword counts as missing, and is named', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ body: 'Ferme #1786\n\nlong prose about the fix' }) });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — closing keyword: 'Ferme #1786' closes nothing — GitHub acts only on Closes \/ Fixes \/ Resolves/);
  assert.doesNotMatch(out, /long prose about the fix/);
});

test('a recognised keyword passes and is echoed without the surrounding prose', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ body: 'This one is subtle.\n\nFixes #1786\n\nand then some more prose' }) });
  assert.equal(code, 0);
  assert.match(out, /closing keyword: 'Fixes #1786' — GitHub will close the issue/);
  assert.doesNotMatch(out, /some more prose/);
});

test('AE6: a PR that closes no issue is a refusal naming the two readings and the by-hand exit', () => {
  // F-040 made this a detector so a chore with no ticket could merge; R8
  // inverts it — under autonomous frontier derivation nobody reads the merge,
  // and a delivered ticket that closes nothing stalls its whole subgraph. The
  // chore case survives through the repair: the human merges by hand.
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ body: 'Tooling fix: the doctor read the wrong path.' }) });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — closing keyword: the body closes no issue and expresses no intent to/);
  assert.match(out, /→ gh pr edit 1845 --repo gapilabs\/gapila --body-file -/);
});

test('a declared tracker turns the false "no intent" line into the actionable one', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Fixes GAP-380 — the spin dedup.' }),
    // Tracked in Linear: no ax dispatch record binds a GitHub ticket here, so
    // this run is about the keyword line alone.
    record: null,
  });
  assert.equal(code, 0);
  assert.match(out, /closing keyword: no GitHub keyword, but the body names Linear 'GAP-380' — GitHub closes nothing there, so that ticket moves by hand/);
  assert.doesNotMatch(out, /expresses no intent/);
});

test('without a declared tracker the refusal wording is the bare one, so no other repository moves', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ body: 'Fixes GAP-380 — the spin dedup.' }) });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — closing keyword: the body closes no issue and expresses no intent to/);
  assert.doesNotMatch(out, /moves by hand/);
});

test('the tracker ref reported is the one a closing verb points at, not the first mention', () => {
  // Measured on gapila #1959: the first tracker match was GAP-377 (background),
  // the body's actual subject ten paragraphs down was `Fixes GAP-379`.
  const { out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Context: GAP-377 described the area.\n\nMany paragraphs later.\n\nFixes GAP-379' }),
  });
  assert.match(out, /names Linear 'GAP-379'/);
  assert.doesNotMatch(out, /GAP-377/);
});

test('with no closing verb anywhere, the tracker ref still gets reported', () => {
  const { out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Part of GAP-380.' }),
  });
  assert.match(out, /names Linear 'GAP-380'/);
});

test('a GitHub keyword still wins over the tracker ref when both are present', () => {
  const { out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Closes #1786, which is GAP-380 in Linear.' }),
  });
  assert.match(out, /closing keyword: 'Closes #1786' — GitHub will close the issue/);
  assert.doesNotMatch(out, /moves by hand/);
});

test('a tracker pattern that does not compile falls back to the bare refusal, and gains no vote', () => {
  // The tracker half is a WORDING aid: it exists so the refusal below is not
  // false on a repository that tracks elsewhere. A typo in it must not change
  // the verdict beyond what the bare body already earns — which under R8 is
  // the no-closing-intent refusal, exactly as if no tracker were declared.
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9' } },
    receipt: prView({ body: 'Part of GAP-380.' }),
  });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — closing keyword: the body closes no issue and expresses no intent to/);
  assert.doesNotMatch(out, /moves by hand/);
});

// ── Ground 9: the ticket this merge is FOR ──────────────────────────────────

test('a PR body that closes another ticket than the one dispatched is refused before any merge', () => {
  // The whole defect: the gate verified closure of whatever the body named, so
  // a worker whose PR said `Closes #999` while #1786 was dispatched passed —
  // #999 got the closure check, and #1786 plus everything blocked by it stayed
  // blocked forever, because the frontier never re-derives a ticket that never
  // closed.
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, receipt: prView({ body: 'Closes #999' }) });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — ticket binding: this merge is for #1786 .*, but the body closes #999/);
  assert.match(out, /→ gh pr edit 1845 --repo gapilabs\/gapila --body-file -/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'the wrong ticket was merged for');
  assert.ok(!calls.some(call => call.startsWith('issue view')), 'the wrong issue was polled for closure');
});

test('--issue outranks the dispatch record: the orchestrator names the ticket it merges', () => {
  // The record binds #1786; a caller merging the ticket the body names says so,
  // and the flag is what the record's default cannot override.
  const explicit = run(['--pr', '1845', '--issue', '999', '--merge'], { ...CLEAN, receipt: prView({ body: 'Closes #999' }) });
  assert.equal(explicit.code, 0, explicit.out);
  assert.match(explicit.out, /ticket binding: the body closes #999, the ticket this merge is for \(--issue\)/);
  assert.deepEqual(explicit.calls.filter(call => call.startsWith('issue view')), [`issue view 999 --repo ${SLUG} --json state`]);
  // And it outranks it the other way too: the flag disagreeing with the body
  // refuses, whatever the record says.
  const crossed = run(['--pr', '1845', '--issue', '1786', '--merge'], { ...CLEAN, receipt: prView({ body: 'Closes #999' }) });
  assert.equal(crossed.code, 1);
  assert.match(crossed.out, /REFUSE — ticket binding: this merge is for #1786 \(--issue\), but the body closes #999/);
});

test('--issue expects a ticket number, and never a bare word', () => {
  assert.equal(run(['--pr', '1845', '--issue']).code, 2);
  assert.equal(run(['--pr', '1845', '--issue', '0']).code, 2);
  assert.equal(run(['--pr', '1845', '--issue', '#1786']).code, 2);
  assert.match(run(['--pr', '1845', '--issue', 'the-one']).out, /--issue expects an issue number/);
});

test('the record BINDS by request id when the branch carries it, without a placement to read', () => {
  // A dispatch whose worktree this host no longer holds — or one placed on
  // another host — still names its ticket: the request id is the worktree name
  // `ax worker dispatch --issue 1786 --slug chat` created, and the branch
  // carries it (the predicate `ax worker release` proves a landing with).
  const root = repoFor('current', DEFAULT_GATE);
  git(root, 'branch', '-f', 'feat/1786-chat', 'feature');
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    record: { request: '1786-chat', worktree: '' },
    receipt: prView({ headRefName: 'feat/1786-chat' }),
  });
  assert.equal(code, 0, out);
  assert.match(out, /ticket binding: the body closes #1786, the ticket this merge is for \(dispatch record 1786-chat\)/);
});

test('neither --issue nor a readable record is cannot-establish, never a silent pass', () => {
  // F-001's rule applied to a read: an absent record is UNKNOWN, and unknown
  // must not become "the body must be right".
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, record: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — ticket binding: this PR's body closes #1786, and no dispatch record on this host names the ticket branch 'feature' was dispatched for/);
  assert.match(out, /→ ax pr gate --pr 1845 --issue <n>/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'an unbound merge mutated');
});

test('a record that names no ticket binds nothing: a named dispatch is not a ticket number', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, record: { request: 'readiness-sweep' } });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — ticket binding: this PR's body closes #1786, and no dispatch record on this host names the ticket/);
});

test("a store full of OTHER branches' dispatches binds nothing: the record has to claim THIS branch", () => {
  // The store is host-global — many tickets, many branches, one directory. A
  // lookup that took "the only record" (or the first) would bind this merge to
  // whichever dispatch happens to sit there, which is the defect one directory
  // over: the closure check would run against a ticket nobody merged for.
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  writeRecord(storeDir, { request: '4242-elsewhere', worktree: join(sandbox, 'some-other-worktree') });
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, record: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — ticket binding: this PR's body closes #1786, and no dispatch record on this host names the ticket branch 'feature' was dispatched for/);
  assert.doesNotMatch(out, /#4242/, "another branch's dispatch was read as this one's binding");
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a merge stood on a foreign record');
});

test('a record for this branch in ANOTHER repository is another checkout, and binds nothing', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const root = repoFor('current', DEFAULT_GATE);
  writeRecord(storeDir, { request: '4242-work', worktree: root, repo: 'goodluckagency/ofmchat' });
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, store: storeDir, record: null });
  assert.equal(code, 3);
  assert.match(out, /no dispatch record on this host names the ticket branch 'feature' was dispatched for/);
  assert.doesNotMatch(out, /#4242/, "another repository's dispatch bound this merge");
});

test('two dispatch records claiming this branch for different tickets is ambiguous, never last-file-wins', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const root = repoFor('current', DEFAULT_GATE);
  writeRecord(storeDir, { request: '1786-work', worktree: root });
  writeRecord(storeDir, { request: '4242-work', worktree: root });
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, record: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — ticket binding: this PR's body closes #1786, and this checkout's dispatch records name #1786 and #4242 for branch 'feature'/);
  assert.match(out, /→ ax pr gate --pr 1845 --issue <n>/);
});

test('an unreadable record is named, and absence beside it is never read as an answer', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  writeFileSync(join(storeDir, '1786-work.json'), '{ this is not json');
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, record: null });
  assert.equal(code, 3);
  assert.match(out, /1786-work\.json is unreadable/);
});

test('an unreadable record BESIDE a matching one binds nothing: it may be the second claim (PR #77 review, P1)', () => {
  // The unreadable file's repository, branch and ticket are all unread, so it
  // may be a second claim on this very branch — the ambiguity two lines above,
  // invisible. Answering "one candidate, therefore bound" authorises a merge
  // over a store this run could not read: F-001's rule in the one direction
  // that mutates.
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const root = repoFor('current', DEFAULT_GATE);
  writeRecord(storeDir, { request: '1786-work', worktree: root });
  writeFileSync(join(storeDir, '4242-work.json'), '{ this is not json');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, record: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — ticket binding: .*4242-work\.json is unreadable/);
  assert.match(out, /→ ax pr gate --pr 1845 --issue <n>/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a merge stood on a store this run could not read');
});

test('every closing construct counts, not just the first: a body closing both closes both (PR #77 review, P2)', () => {
  // GitHub closes EVERY recognised construct in the body. Reading only the
  // first made this ground refuse a body that does close the dispatched ticket,
  // which is a round-trip charged for a merge that was correct.
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    receipt: prView({ body: 'Closes #999\n\nCloses #1786' }),
  });
  assert.equal(code, 0, out);
  assert.match(out, /ticket binding: the body closes #1786, the ticket this merge is for \(dispatch record 1786-work\)/);
  assert.match(out, /it also closes #999/);
  assert.deepEqual(calls.filter(call => call.startsWith('issue view')), [`issue view 1786 --repo ${SLUG} --json state`]);
});

test('a bound ticket the body closes nothing for is refused: the dispatched ticket would stay open', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Fixes GAP-380 — the spin dedup.' }),
  });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — ticket binding: this merge is for #1786 .*, and the body closes no same-repository issue/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

// ── The verdict and the merge ──────────────────────────────────────────────

test('a clean PR passes and reports what it prevents and what it merely detects', () => {
  const { code, out, headSha } = run(['--pr', '1845'], CLEAN);
  assert.equal(code, 0);
  assert.match(out, new RegExp(`PASS — gapilabs/gapila#1845 is mergeable at ${headSha}\\.`));
  assert.match(out, /what this run prevents and what it merely detects \(R21\)/);
  assert.match(out, /prevents {2}the declared checks/);
  assert.match(out, /detects {3}the commits landed since the PR opened/);
  assert.match(out, /reports {3}landed-by-content/);
});

test('without --merge nothing mutates and the run names itself a detector', () => {
  const { code, out, calls } = run(['--pr', '1845'], CLEAN);
  assert.equal(code, 0);
  assert.match(out, /DETECTOR RUN — no --merge/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a merge was issued without --merge');
});

test('the next action a PASS prints carries the acknowledgements that PASS stood on', () => {
  // Measured 2026-08-25 on ofmchat #72: a PASS under `--ack-body` printed
  // `ax pr gate --pr 72 --merge`, and running exactly that refused again on the
  // same two commits. An acknowledgement answers for the list ONE run printed,
  // so it is never persisted — the command therefore has to carry it.
  const { code, out } = run(['--pr', '1845', '--repo', SLUG, '--ack-body'], { ...CLEAN, commits: prCommits(2) });
  assert.equal(code, 0);
  assert.match(out, /→ ax pr gate --pr 1845 --repo gapilabs\/gapila --ack-body --merge /);
});

test('--merge carries the SHA this run validated, and squash is the default', () => {
  const { code, calls, headSha } = run(['--pr', '1845', '--merge'], CLEAN);
  assert.equal(code, 0);
  assert.deepEqual(
    calls.filter(call => call.startsWith('pr merge')),
    [`pr merge 1845 --repo ${SLUG} --squash --match-head-commit ${headSha}`],
  );
});

test('a merge writes its record BEFORE the merge call is issued (KTD4)', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const recordPath = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json');
  // Snapshot taken INSIDE the injected merge call: an after-merge write would
  // leave this null, which is exactly the ordering bug the record exists to
  // remove — a mutation that cannot be replayed because nothing preceded it.
  let atMergeTime = null;
  const { code, headSha } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    onMerge: () => {
      atMergeTime = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
    },
  });
  assert.equal(code, 0);
  assert.ok(atMergeTime !== null, 'the record was on disk before the merge was issued');
  const begun = atMergeTime.attempts[0].phases[0];
  assert.deepEqual(begun.argv, ['pr', 'merge', '1845', '--repo', SLUG, '--squash', '--match-head-commit', headSha]);
  assert.equal(begun.exit, null, 'at merge time the phase is begun, not ended');
  assert.ok(Array.isArray(begun.grounds) && begun.grounds.length > 0, 'the per-ground verdicts ride the phase');
  const settled = JSON.parse(readFileSync(recordPath, 'utf8')).attempts[0].phases[0];
  assert.equal(settled.exit, 0, 'the phase closed with the merge exit');
});

test('--method merge lands a real merge commit, and squash never appears', () => {
  const { code, calls } = run(['--pr', '1845', '--merge', '--method', 'merge'], CLEAN);
  assert.equal(code, 0);
  const merge = calls.find(call => call.startsWith('pr merge'));
  assert.match(merge, /--merge --match-head-commit/);
  assert.doesNotMatch(merge, /--squash/);
});

test('--merge on a refusal mutates nothing', () => {
  // An unresolved thread rather than staleness: staleness alone has its own
  // self-repair path (KTD6), which ends the run before this line is reached.
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { threads: [threadPage([thread('T1', false)])] });
  assert.equal(code, 1);
  assert.match(out, /--merge ignored: the verdict is not a pass, so nothing was mutated/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a refusing verdict issued a merge');
});

test('--merge on an unknown mutates nothing either', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, checks: null });
  assert.equal(code, 3);
  assert.match(out, /--merge ignored/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('a merge the head outran fails loudly and names the re-run', () => {
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, mergeFails: true });
  assert.equal(code, 1);
  assert.match(out, /MERGE FAILED — Head branch was modified; the head may have moved past/);
  assert.match(out, /→ ax pr gate --pr 1845 --merge/);
});

test('every ground is reported, none short-circuited by another', () => {
  // A refusal AND an unknown on one run: the refusal outranks the unknown in the
  // verdict, and neither suppresses the other's line (F-033 recorded two grounds
  // firing on one merge).
  const { code, out } = run(['--pr', '1845'], {
    shape: 'residual-stale',
    prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL },
    threads: [threadPage([thread('T_p1', false)])],
    commits: prCommits(1),
    receipt: prView({ body: 'Ferme #1786' }),
  });
  assert.equal(code, 1);
  for (const ground of [
    /REFUSE — threads: unresolved thread T_p1/,
    /REFUSE — residual findings: this branch wrote docs\/residual/,
    /REFUSE — commits since open \[DETECTOR\]/,
    /REFUSE — ticket binding: this merge is for #1786/,
    /REFUSE — closing keyword: 'Ferme #1786'/,
    /checks: 4 check-run\(s\) reported/,
    /staleness: feature carries main/,
    /landed-by-content: NO/,
  ]) {
    assert.match(out, ground);
  }
  assert.equal(out.match(/✗ REFUSE — /g).length, 5);
});

test('a refusal outranks an inability to establish when both apply', () => {
  const { code, out } = run(['--pr', '1845'], {
    shape: 'stale',
    threads: [threadPage([thread('T1', true)])],
    commits: null,
  });
  assert.equal(code, 1, 'the named reason is the more actionable of the two');
  assert.match(out, /CANNOT ESTABLISH — commits since open/);
  assert.match(out, /REFUSE — staleness/);
  assert.match(out, /REFUSE — 1 named reason\(s\)\. Nothing was mutated\./);
});


test('AE3: a crash between record and merge replays the recorded argv exactly, and mints no second record', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const recordPath = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json');
  // First run: the merge call itself dies after the record landed.
  // First run: the merge transport dies after the record landed — the spawn
  // never returns, which defaultExec reports as error-as-data.
  const crashed = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    onMerge: () => ({ status: null, stdout: '', stderr: '', error: new Error('simulated crash between record and merge') }),
  });
  assert.notEqual(crashed.code, 0);
  const recorded = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(recorded.attempts.length, 1);
  const recordedArgv = recorded.attempts[0].phases[0].argv;

  // Recovery: same PR, same head — the reissued merge is the recorded argv,
  // byte for byte, on the same single record.
  const merges = [];
  const recovered = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, onMerge: args => merges.push([...args]) });
  assert.equal(recovered.code, 0);
  assert.match(recovered.out, /replay — reissuing the recorded merge argv byte for byte/);
  assert.deepEqual(merges, [recordedArgv]);
  const after = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(after.attempts.length, 1, 'no second attempt was minted for an unchanged head');
  assert.equal(after.attempts[0].phases.length, 1, 'the recorded phase was reissued, not duplicated');
});

test('replay against a PR merged at the recorded SHA is replayed-success, with zero merge calls', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const first = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir });
  assert.equal(first.code, 0);
  const merges = [];
  const replayed = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    prStates: [prView({ state: 'MERGED' })],
    onMerge: args => merges.push(args),
  });
  assert.equal(replayed.code, 0);
  assert.match(replayed.out, new RegExp(`REPLAYED-SUCCESS — the recorded merge already landed at ${first.headSha}`));
  assert.deepEqual(merges, [], 'a replayed success issues no mutation');
});

test('replay against a PR merged at a DIVERGENT SHA is a named report, never a success receipt', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  assert.equal(run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir }).code, 0);
  const moved = 'aaaa1c27b4d6e8f0a2c4e6081a3c5e7092b4d6f8';
  const merges = [];
  const replayed = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    prStates: [prView({ state: 'MERGED', headRefOid: moved })],
    onMerge: args => merges.push(args),
  });
  assert.equal(replayed.code, 1);
  assert.match(replayed.out, /REPLAY — gapilabs\/gapila#1845 merged OUTSIDE this gate's validated head/);
  assert.doesNotMatch(replayed.out, /REPLAYED-SUCCESS|MERGED — /);
  assert.deepEqual(merges, []);
});

test('replay against an open PR whose head moved opens a NEW attempt on the freshly validated head', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  assert.equal(run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir }).code, 0);
  const recordPath = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json');
  // A REAL commit this checkout holds: the declaration guard reads the
  // validated SHA's own `ax.config.json`, so a fabricated oid is unreadable.
  const moved = shaOf(repoFor('current', DEFAULT_GATE), 'main');
  const merges = [];
  const replayed = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    receipt: prView({ headRefOid: moved }),
    onMerge: args => merges.push([...args]),
  });
  assert.equal(replayed.code, 0);
  assert.match(replayed.out, /replay — the head moved past the recorded/);
  assert.deepEqual(merges, [['pr', 'merge', '1845', '--repo', SLUG, '--squash', '--match-head-commit', moved]]);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.attempts.length, 2, 'the stale attempt settled and a new one opened');
  assert.equal(record.attempts[0].settled, true);
});

test('KTD6 rider: an update-branch the head did not follow refuses instead of recursing', () => {
  // `gh pr update-branch` returns before GitHub has moved the head, and the
  // recursion is the ONE retry this verb gets. Spending it on an unchanged head
  // re-runs every ground against the very commit that just refused, and reports
  // the second refusal as if a repair had been attempted.
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'stale' });
  assert.equal(code, 1);
  assert.match(out, /self-repair: staleness is the only refusing ground — updating the branch from base/);
  assert.equal(calls.filter(call => call.startsWith('pr update-branch')).length, 1, 'exactly one update, never a loop');
  assert.match(out, /REFUSE — self-repair: the head is still .* after gh pr update-branch/);
  assert.doesNotMatch(out, /self-repair already ran once/, 'the one retry was spent on an unmoved head');
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'nothing merged through a refusing verdict');
});

test('KTD6 rider: a head that cannot be re-read is cannot-establish, never a spent retry', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    shape: 'stale',
    // receipt, then the post-update head read fails.
    prStates: [prView(), null],
  });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — self-repair: the head after gh pr update-branch 1845 is unread/);
  assert.match(out, /→ gh pr view 1845 --repo gapilabs\/gapila --json headRefOid/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('KTD6: staleness as the only refusing ground updates the branch and re-runs once; the second refusal routes', () => {
  // The head MOVED, so the one retry buys a real re-measurement. The fixture
  // repository cannot move with it, so the retried run refuses on staleness
  // again — which is exactly the second-refusal path: one update, then routing.
  const moved = shaOf(repoFor('stale', DEFAULT_GATE), 'main');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    shape: 'stale',
    // receipt · the head after the update · the retried run's own receipt
    prStates: [prView(), prView({ headRefOid: moved }), prView({ headRefOid: moved })],
  });
  assert.equal(code, 1);
  assert.match(out, /self-repair: staleness is the only refusing ground — updating the branch from base/);
  assert.equal(calls.filter(call => call.startsWith('pr update-branch')).length, 1, 'exactly one update, never a loop');
  assert.match(out, /self-repair already ran once — a second staleness refusal routes to the owning worker/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'nothing merged through a refusing verdict');
});

test('a failing update-branch stops the self-repair with the named repair', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'stale', updateBranchFails: true });
  assert.equal(code, 1);
  assert.match(out, /self-repair failed — update failed/);
  assert.match(out, /→ gh pr update-branch 1845/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('a detector run never self-repairs staleness', () => {
  const { code, calls } = run(['--pr', '1845'], { ...CLEAN, shape: 'stale' });
  assert.equal(code, 1);
  assert.ok(!calls.some(call => call.startsWith('pr update-branch')), 'a detector run mutated the branch');
});

test('KTD5: a PR that edits the prGate declaration it is measured by refuses toward the human merge', () => {
  // A dedicated repository: main commits one declaration, feature commits a
  // weakened one. The guard compares committed prGate values across the
  // merge-base, so an uncommitted local config cannot trip it.
  const root = join(sandbox, 'declaration-guard');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'ax.config.json', JSON.stringify({ prGate: { aggregate: AGGREGATE } }), 'declare the gate');
  git(root, 'checkout', '-q', '-b', 'feature');
  commit(root, 'ax.config.json', JSON.stringify({ prGate: { checks: ['lint'] } }), 'weaken the gate');
  const calls = [];
  const gh = args => {
    calls.push(args.join(' '));
    const [verb, target] = args;
    if (verb === 'repo' && target === 'view' && args.includes('defaultBranchRef')) return answered(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
    if (verb === 'repo' && target === 'view') return answered(`${SLUG}\n`);
    if (verb === 'pr' && target === 'view') return answered(JSON.stringify(prView({ headRefOid: shaOf(root, 'feature') })));
    if (verb === 'api' && target === 'graphql') return answered(JSON.stringify(threadPage([thread('T1', true)])));
    if (verb === 'api' && target.includes('/check-runs')) return answered(JSON.stringify({ check_runs: greenChecks() }));
    if (verb === 'api' && target.includes('/pulls/')) return answered(JSON.stringify(prCommits(0)));
    return refusedByGh(`unstubbed gh call: ${args.join(' ')}`);
  };
  const { code, out } = capture(() => gate(['--pr', '1845', '--merge'], { gh, git: realGit, cwd: root, env: { HOME: sandbox }, sleep: () => {} }));
  assert.equal(code, 1);
  assert.match(out, /REFUSE — declaration guard: this PR edits the prGate declaration it is measured by/);
  assert.match(out, /→ review the prGate diff, then merge by hand: gh pr merge 1845/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'the disarming PR was not merged autonomously');
});

test('closure verification: an issue that closes on a later poll is merged and delivered', () => {
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, issueStates: ['OPEN', 'CLOSED'] });
  assert.equal(code, 0);
  assert.match(out, /MERGED — gapilabs\/gapila#1845/);
  assert.match(out, /closure: issue #1786 reads closed — merged and delivered/);
});

test('KTD5: an issue that never closes is an operator escalation, never a silent exit-0 note', () => {
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, issueStates: ['OPEN'] });
  assert.equal(code, 3);
  assert.match(out, /MERGED — gapilabs\/gapila#1845/, 'the merge itself is reported — it happened');
  assert.match(out, /CANNOT ESTABLISH — issue #1786 is not closed after the recorded merge/);
  assert.match(out, /→ check the repository setting "auto-close issues with merged linked pull requests"/);
});

test('closure verification has nothing to poll for a declared-tracker body, and says so', () => {
  const { code, out } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Fixes GAP-380 — the spin dedup.' }),
    issueStates: [null],
    // A repository that tracks in Linear has no ax dispatch record binding a
    // GitHub ticket to this branch: nothing here closes on GitHub, and nothing
    // claims a GitHub ticket is owed.
    record: null,
  });
  assert.equal(code, 0);
  assert.match(out, /closure: the body names no same-repository #N to verify — that ticket moves by hand/);
});

test('closure reads that all FAILED are not an unclosed issue: the unread read is named, never the ticket', () => {
  // Five 502s answered nothing about #1786. Reporting "not closed" out of that
  // sends an operator to a repository setting and a `gh issue close` for a
  // ticket that may well have closed — F-028 on the closure read.
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, issueStates: [null, null, null, null, null] });
  assert.equal(code, 3);
  assert.match(out, /MERGED — gapilabs\/gapila#1845/, 'the merge happened and is reported');
  assert.match(out, /CANNOT ESTABLISH — the closure read 'gh issue view 1786' never answered/);
  assert.match(out, /→ gh auth status && gh issue view 1786 --repo gapilabs\/gapila --json state/);
  assert.doesNotMatch(out, /is not closed after the recorded merge/, 'an unread read is not an unclosed ticket');
});

test('closure: a read that failed once and then answered CLOSED is merged and delivered', () => {
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, issueStates: [null, 'CLOSED'] });
  assert.equal(code, 0);
  assert.match(out, /closure: issue #1786 reads closed — merged and delivered/);
});

test('a merge call that succeeds while the PR stays OPEN is queued, not merged (auto-merge, merge queue)', () => {
  // `gh pr merge` exits 0 when it ENABLES auto-merge or enqueues: the mutation
  // was issued, the merge has not happened. Printing MERGED there publishes a
  // completion nobody observed.
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, prStates: [prView(), prView({ state: 'OPEN' })] });
  assert.equal(code, 3);
  assert.doesNotMatch(out, /MERGED — /, 'a queued PR is never reported merged');
  assert.match(out, /CANNOT ESTABLISH — the merge was issued and gapilabs\/gapila#1845 reads OPEN, not MERGED/);
  assert.match(out, /QUEUED, not completed/);
  assert.match(out, /→ gh pr view 1845 --repo gapilabs\/gapila --json state,mergeCommit/);
});

test('a body edited to close another ticket while the gate ran polls the BOUND ticket, and names the edit', () => {
  // GitHub closes from the body as it stands at merge time, so the post-merge
  // read is the one that says what closed. It is not what this merge was FOR:
  // #1786 was dispatched, #999 is what the edited body closes, and polling #999
  // would report a delivery of a ticket nobody merged for.
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    prStates: [prView(), prView({ state: 'MERGED', body: 'Closes #999' })],
    issueStates: ['OPEN'],
  });
  assert.equal(code, 3);
  assert.match(out, /closure: the post-merge body closes #999, not #1786 — the ticket this merge was for/);
  assert.match(out, /CANNOT ESTABLISH — issue #1786 is not closed after the recorded merge/);
  assert.deepEqual(
    calls.filter(call => call.startsWith('issue view')),
    Array.from({ length: 5 }, () => `issue view 1786 --repo ${SLUG} --json state`),
  );
});

test('two concurrent --merge runs cannot both reissue: a held lock is cannot-establish naming its holder', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const lock = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json.merge.lock');
  mkdirSync(join(storeDir, 'merge'), { recursive: true });
  // Written the way acquireLock writes it, with a pid that IS alive: this
  // process. A sibling gate holding the merge gesture must not be raced.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: 'sibling', at: new Date().toISOString() }));
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir });
  assert.equal(code, 3);
  assert.match(out, new RegExp(`CANNOT ESTABLISH — pre-existing lock at .*belongs to ${hostname()} pid ${process.pid}`));
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a locked gesture issued a second merge');
  assert.ok(existsSync(lock), "the sibling's lock survived");
});

test('a reissue re-reads the PR under the lock: a merge that landed while this run waited is not reissued', () => {
  // The precheck's read predates the lock. A sibling that held it and merged in
  // between must be observed BEFORE the recorded argv is reissued, or this run
  // overwrites the recorded receipt of the run that actually merged.
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const first = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, onMerge: () => ({ status: null, stdout: '', stderr: '', error: new Error('transport died') }) });
  assert.notEqual(first.code, 0);
  const merges = [];
  const replayed = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    // precheck: still open · receipt: the same head · under the lock: MERGED
    prStates: [prView(), prView(), prView({ state: 'MERGED' })],
    onMerge: args => merges.push([...args]),
  });
  assert.equal(replayed.code, 0, replayed.out);
  assert.match(replayed.out, /REPLAYED-SUCCESS — the recorded merge landed at .* while this run waited for the lock/);
  assert.deepEqual(merges, [], 'the recorded merge was reissued over a landed merge');
});

test('the lock outlives the merge call: the post-merge read-back happens while a sibling is still refused', () => {
  // Releasing at `phaseEnd` leaves the auto-merge window open: a sibling would
  // acquire while GitHub still answers OPEN and reissue over a merge that is
  // landing. The read-back and its verdict are part of the same gesture.
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const lock = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json.merge.lock');
  let heldAtReadBack = null;
  const { code } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    store: storeDir,
    onPrView: args => {
      if (args.includes('state,mergeCommit,body')) heldAtReadBack = existsSync(lock);
    },
  });
  assert.equal(code, 0);
  assert.equal(heldAtReadBack, true, 'the merge lock was released before the read-back');
  assert.ok(!existsSync(lock), 'the lock was released once the gesture finished');
});

test('a zero-length claim file is pre-mutation: one merge, one record, never an unreadable-record exit', () => {
  // The crash window between `claimRecord` and `initRecord` leaves an empty
  // file. JSON.parsing it called the record unreadable and printed a repair
  // that would delete a sibling's live claim.
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const recordPath = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json');
  mkdirSync(join(storeDir, 'merge'), { recursive: true });
  writeFileSync(recordPath, '');
  const merges = [];
  const { code, out, headSha } = run(['--pr', '1845', '--merge'], { ...CLEAN, store: storeDir, onMerge: args => merges.push([...args]) });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /is unreadable/);
  assert.deepEqual(merges, [['pr', 'merge', '1845', '--repo', SLUG, '--squash', '--match-head-commit', headSha]]);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].phases.length, 1, 'exactly one recorded mutation');
});

test('a merging run refuses a prGate the head does not carry: the gate never measures with an uncommitted declaration', () => {
  const root = join(sandbox, 'worktree-drift');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'ax.config.json', JSON.stringify({ prGate: { aggregate: AGGREGATE } }), 'declare the gate');
  git(root, 'checkout', '-q', '-b', 'feature');
  commit(root, 'src/a.txt', 'a\n', 'feature work');
  const calls = [];
  const gh = args => {
    calls.push(args.join(' '));
    const [verb, target] = args;
    if (verb === 'repo' && target === 'view' && args.includes('defaultBranchRef')) return answered(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
    if (verb === 'repo' && target === 'view') return answered(`${SLUG}\n`);
    if (verb === 'pr' && target === 'view') return answered(JSON.stringify({ ...prView({ headRefOid: shaOf(root, 'feature') }), state: 'MERGED' }));
    if (verb === 'api' && target === 'graphql') return answered(JSON.stringify(threadPage([thread('T1', true)])));
    if (verb === 'api' && target.includes('/check-runs')) return answered(JSON.stringify({ check_runs: greenChecks() }));
    if (verb === 'api' && target.includes('/pulls/')) return answered(JSON.stringify(prCommits(0)));
    if (verb === 'pr' && target === 'merge') return answered('merged\n');
    if (verb === 'issue' && target === 'view') return answered(JSON.stringify({ state: 'CLOSED' }));
    return refusedByGh(`unstubbed gh call: ${args.join(' ')}`);
  };
  const env = { HOME: sandbox, ORCA_DISPATCH_STORE: mkdtempSync(join(sandbox, 'store-')) };
  writeRecord(env.ORCA_DISPATCH_STORE, { request: '1786-work', worktree: root });
  const merge = () => capture(() => gate(['--pr', '1845', '--merge'], { gh, git: realGit, cwd: root, env, sleep: () => {} }));

  // Committed and equal: the check says so and changes nothing else.
  const clean = merge();
  assert.equal(clean.code, 0, clean.out);

  // Edited in the working tree AFTER the commit: the gate would measure with a
  // declaration nobody committed.
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ prGate: { checks: ['lint'] } }));
  calls.length = 0;
  const drifted = merge();
  assert.equal(drifted.code, 1);
  assert.match(drifted.out, /REFUSE — the prGate in .*ax\.config\.json differs from the one committed at HEAD/);
  assert.match(drifted.out, /→ git diff HEAD -- ax\.config\.json/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a drifting declaration merged anyway');
});

// ── The noun ───────────────────────────────────────────────────────────────

test('every declared pr verb has a runner, and every runner is declared', () => {
  assert.deepEqual(subcommandNames('pr').sort(), Object.keys(SUBCOMMANDS).sort());
  for (const [verb, runner] of Object.entries(SUBCOMMANDS)) assert.equal(typeof runner, 'function', `${verb} is not callable`);
});

test('an unknown pr verb is a usage error, never a default action', () => {
  const missing = capture(() => prNoun(['review']));
  assert.equal(missing.code, 2);
  assert.match(missing.out, /unknown verb "review"/);
  const none = capture(() => prNoun([]));
  assert.equal(none.code, 2);
  assert.match(none.out, /which one\? \(gate\)/);
});
