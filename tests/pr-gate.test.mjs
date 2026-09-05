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
  // The title is a closure channel wherever policy makes it the merge subject
  // (#86), so the fixture's is deliberately inert.
  title: 'fix: the spin dedup',
  body: 'Closes #1786',
  createdAt: OPENED,
  mergeStateStatus: 'CLEAN',
  // The two halves of the release shape (#94), both deliberately NOT it: an
  // ordinary contributor and no label. A fixture that carried the shape by
  // default would exempt every other test from three grounds.
  author: { is_bot: false, login: 'contributor' },
  labels: [],
  ...over,
});

/**
 * One check-run row. The `id` is what makes two rows DISTINCT (#176): the
 * paginated read counts observed runs by it, so a fixture whose rows shared one
 * id would model a repeated page rather than a list. A counter keeps every row
 * this file mints distinct without a test having to say so; `over` is for the
 * rows that model a malformed id on purpose.
 */
let runId = 0;
const checkRun = (name, conclusion, status = 'completed', over = {}) => ({
  id: (runId += 1),
  name,
  status,
  conclusion,
  head_sha: HEAD_SHA,
  ...over,
});

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

/**
 * ONE PAGE of the check-runs endpoint, which answers a total beside its rows
 * (#176). `total_count` is the announced total of the whole list, not of this
 * page: a fixture that models a complete single-page read lets it default to
 * the rows it carries, and the paginated shapes state it explicitly.
 */
const checkPage = (rows, over = {}) => ({ total_count: rows.length, check_runs: rows, ...over });

/** `n` distinct rows of an undeclared name — the filler a page boundary needs. */
const filler = (n, from = 0) => Array.from({ length: n }, (_, i) => checkRun(`filler-${from + i + 1}`, 'success'));

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

/**
 * A `reviewThreads` payload built from the EXACT object the API answered, which
 * `threadPage` cannot express: it always writes a well-formed page. The shapes
 * measured on #175 are malformed ones — an absent, null or non-array `nodes`,
 * a `pageInfo` that names no boolean `hasNextPage` — and each of them read as
 * "zero threads, final page" through the old ground.
 */
const threadShape = reviewThreads => ({ data: { repository: { pullRequest: { reviewThreads } } } });

/**
 * One row of the PR commits payload. `parents` is read by name like every other
 * field (F-028, #90): Ground 6's shape rule asks how many parents a post-open
 * commit has, so a fixture that omitted them would be an unread payload, not a
 * commit with none. One parent is an ordinary commit; the rows that model a
 * merge name both.
 */
const commitRow = (sha, message, date, parents = ['0'.repeat(40)]) => ({
  sha,
  commit: { message, committer: { date } },
  parents: parents.map(parent => ({ sha: parent })),
});

/**
 * Two commits, `lateCount` of them landed after the PR was opened (KTD9's
 * ground). Every message is INERT: a fixture that quoted a closing construct
 * would arm it against the gate reading these very messages (#86), so the rows
 * that need one pass it in explicitly.
 */
const prCommits = (lateCount, messages = []) => {
  const rows = [commitRow('aaaaaaaaaaaa1111', messages[0] ?? 'feature work', '2026-08-09T09:00:00Z')];
  for (let i = 0; i < lateCount; i += 1) {
    // Distinct in the first TWELVE characters, which is all the gate prints.
    rows.push(commitRow(`bbbbbbbbbb${i}${i}3333`, messages[i + 1] ?? `later work ${i}`, '2026-08-09T11:00:00Z'));
  }
  return rows;
};

/**
 * A real commit of a fixture repository, as the PR commits payload reports it —
 * its own SHA and its own parents, which is what Ground 6's shape rule measures
 * against the commit graph (#90).
 */
const realCommitRow = (root, ref, date = '2026-08-09T11:00:00Z') => {
  const read = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sha = read(['rev-parse', ref]);
  return commitRow(sha, read(['log', '-1', '--format=%s', sha]), date, read(['show', '-s', '--format=%P', sha]).split(' '));
};

/**
 * The repository's merge-message policy (#86), the read that says which texts
 * will reach the default branch at all.
 *
 * THERE IS NO INERT POLICY. GitHub always writes a subject and a message for
 * the commit it lands, and every value those settings can take names a text:
 * the pull request title, the branch's commit messages, or a single commit's
 * subject. The default below is the narrowest real one — squash the only
 * allowed method, the merge message from the PR body, the subject from the PR
 * TITLE — so the commit messages stay off the default branch and the title is
 * the one extra channel. Every fixture title is therefore inert, and the rows
 * that arm one say so.
 */
const BODY_POLICY = {
  squash_merge_commit_message: 'PR_BODY',
  squash_merge_commit_title: 'PR_TITLE',
  merge_commit_title: 'MERGE_MESSAGE',
  merge_commit_message: 'PR_BODY',
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
};

/** ax's own measured setting: the merge message IS the commit messages. */
const MESSAGES_POLICY = { ...BODY_POLICY, squash_merge_commit_message: 'COMMIT_MESSAGES', squash_merge_commit_title: 'COMMIT_OR_PR_TITLE' };

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
  // A REAL origin beside this checkout, with the refs a shape wants published.
  // Without one the git-backed grounds are on their local-only path, where the
  // head the PR announces must be this branch's own tip (#177) — so every shape
  // that models a head GitHub moved without this checkout following publishes
  // instead of pretending a remote is absent.
  let origin = '';
  const publish = (...refspecs) => {
    if (origin === '') {
      origin = `${root}-origin`;
      git(sandbox, 'init', '-q', '--bare', origin);
      git(root, 'remote', 'add', 'origin', origin);
    }
    git(root, 'push', '-q', 'origin', ...refspecs);
  };

  // #90's two shapes: a branch whose post-open commit is a CLEAN merge of the
  // base — the footprint `gh pr update-branch` leaves, and the same thing a
  // worker's own `git merge origin/main` leaves — either already on the head
  // (`base-merge`) or on the ref the self-repair moves the head to while
  // `feature` itself stays behind (`stale-merged`, the reported run, where
  // `origin/feature` is what carries the moved head).
  if (shape === 'base-merge' || shape === 'stale-merged' || shape === 'sibling-moved' || shape === 'head-behind-tip' || shape === 'remote-merged') {
    commit(root, 'src/a.txt', 'a\n', 'feature work');
    if (shape === 'remote-merged') publish('main', 'feature');
    git(root, 'checkout', '-q', 'main');
    commit(root, 'src/b.txt', 'b\n', 'the base moved');
    if (shape === 'stale-merged') git(root, 'checkout', '-q', '-b', 'updated', 'feature');
    else git(root, 'checkout', '-q', 'feature');
    git(root, 'merge', '-q', '--no-ff', '-m', "Merge branch 'main' into feature", 'main');
    git(root, 'checkout', '-q', 'feature');
    // The head GitHub answers for `feature` is the merge; this checkout's own
    // `feature` stays behind it, exactly as it does after `gh pr update-branch`.
    if (shape === 'stale-merged') publish('main', 'updated:feature');
    if (shape === 'remote-merged') publish('main', 'feature');
  }
  // #177's shapes, each one a head the PR announces that is NOT the branch tip
  // this checkout answers for the head NAME.
  //
  //   sibling-moved     the announced head IS the tip, and an unrelated local
  //                     branch has moved past it: movement elsewhere must not
  //                     change a coherent verdict.
  //   head-behind-tip   the branch kept working past the announced head, so the
  //                     announced commit carries the base and is not the tip.
  //   remote-merged     a REAL origin: the base advanced there and the branch
  //                     merged it, so the pre-merge head the PR announces does
  //                     not carry it while both published tips do.
  //   stale-twice       published, and BOTH of the branch's commits are behind
  //                     the advanced base: the head can move once and still
  //                     refuse, which is the second-refusal route (KTD6).
  if (shape === 'sibling-moved') {
    git(root, 'checkout', '-q', '-b', 'wip');
    commit(root, 'src/wip.txt', 'wip\n', 'an unrelated branch moves past the head');
    git(root, 'checkout', '-q', 'feature');
  }
  if (shape === 'head-behind-tip') {
    commit(root, 'src/c.txt', 'c\n', 'work past the announced head');
  }
  if (shape === 'stale-twice') {
    commit(root, 'src/a.txt', 'a\n', 'feature work');
    commit(root, 'src/c.txt', 'c\n', 'more feature work');
    git(root, 'checkout', '-q', 'main');
    commit(root, 'src/b.txt', 'b\n', 'the base moved');
    git(root, 'checkout', '-q', 'feature');
    publish('main', 'feature');
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
    policy = BODY_POLICY,
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
  // The commits payload may be a FUNCTION of how many times it has been read:
  // the staleness self-repair re-runs the whole gate, and the second run reads
  // a branch the update-branch call has moved (#90). A plain list answers every
  // read, as before.
  let commitReads = 0;

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
      // call (`--json state,mergeCommit,body,title`), so a run that does not sequence
      // its states still gets the MERGED answer that read exists to check.
      const readBack = args.includes('state,mergeCommit,body,title');
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
      // A LIST fixture is one entry per page, answered by the `page=` THIS
      // call names rather than by call order: the read is keyed on the head
      // SHA, and a staleness self-repair re-runs the whole gate from page 1.
      // Exhaustion repeats the last page, exactly as the GraphQL stub above
      // does — which is also the API shape a repeated page models, so a test
      // that means to end the list spells out every page it intends.
      const asked = Number(new URLSearchParams(String(target).split('?')[1] ?? '').get('page') ?? '1');
      const source = checks === undefined ? [checkPage(greenChecks())] : Array.isArray(checks) ? checks : [checks];
      const body = source[Math.min(Number.isInteger(asked) && asked >= 1 ? asked - 1 : 0, source.length - 1)];
      return body === null || body === undefined ? refusedByGh('HTTP 502') : answered(JSON.stringify(body));
    }
    if (verb === 'api' && target.includes('/pulls/')) {
      const rows = typeof commits === 'function' ? commits(commitReads) : commits;
      commitReads += 1;
      return rows === null ? refusedByGh('HTTP 502') : answered(JSON.stringify(rows ?? prCommits(0)));
    }
    // The merge-message policy (#86). `null` is the read that failed, which is
    // an inability to establish and never "the body is the only channel".
    if (verb === 'api' && target === `repos/${slug}`) {
      return policy === null ? refusedByGh('HTTP 502') : answered(JSON.stringify(policy));
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
        if (verb === 'api' && target.includes('/check-runs')) return answered(JSON.stringify(checkPage(greenChecks())));
        if (verb === 'api' && target.includes('/pulls/')) return answered(JSON.stringify(prCommits(0)));
        if (verb === 'api' && target === `repos/${SLUG}`) return answered(JSON.stringify(BODY_POLICY));
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
  const { code, out, headSha } = run(['--pr', '1845'], { ...CLEAN, checks: checkPage([checkRun('some other job', 'success')]) });
  assert.equal(code, 1);
  assert.match(out, new RegExp(`REFUSE — checks: expected aggregate check 'Playwright \\(public games\\)' has NO run on ${headSha.slice(0, 12)}`));
  // The repair reads EVERY page, like the gate does (#176).
  assert.match(out, /→ gh api --paginate repos\/gapilabs\/gapila\/commits\/.*check-runs/);
});

test('F-014: fewer check-runs than another PR is not a missing guard', () => {
  // Two runs here where the fixture set has four. The count is never the
  // measurement: the set depends on the diff, on labels and on bots that decide
  // for themselves whether to run.
  const { code, out, headSha } = run(['--pr', '1845'], { ...CLEAN, checks: checkPage([checkRun(AGGREGATE, 'success'), checkRun('claude-review', 'neutral')]) });
  assert.equal(code, 0);
  assert.match(out, new RegExp(`checks: 2 check-run\\(s\\) reported on ${headSha.slice(0, 12)}`));
});

test('F-031: a declared check concluding neutral refuses — neither success nor failure', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: checkPage([checkRun(AGGREGATE, 'neutral')]) });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — checks: 'Playwright \(public games\)' concluded neutral/);
});

test('a check still running is not decided, and that is an unknown, not a pass', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: checkPage([checkRun(AGGREGATE, null, 'in_progress')]) });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — checks: 'Playwright \(public games\)' is in_progress/);
});

test('a check-runs call that fails leaves CI unread rather than green', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — checks: page 1 of 'gh api .*check-runs' failed — HTTP 502/);
  assert.match(out, /CI state unread/);
});

test('F-004: the unknown carries the diagnostic, it does not consume it', () => {
  // Two different failures, and neither may be reported as a bare "could not
  // read": the reason is what a caller acts on. F-004 records the one time a
  // `jq` failure inside a pipe ate the only diagnostic that mattered.
  assert.match(run(['--pr', '1845'], { ...CLEAN, checks: null }).out, /HTTP 502/);
  const notJson = run(['--pr', '1845'], { ...CLEAN, checks: 'gh: command not found\n' });
  assert.equal(notJson.code, 3);
  assert.match(notJson.out, /checks: page 1 of 'gh api .*check-runs' answered something that is not JSON/);
});

test('F-028: an absent check_runs container raises instead of becoming an empty one', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: {} });
  assert.equal(code, 3);
  assert.match(out, /'check_runs' is absent from the payload/);
});

// ── #176: the check-run read has to cover EVERY page ───────────────────────
//
// One page is 100 rows and this endpoint announces its own total beside them.
// The old ground read `?per_page=100` once and measured whatever came back, so
// a declared check sitting on page 2 of a 101-run commit was invisible: absent
// from the read, and — where an earlier page carried a same-named green row —
// hidden behind it. These are injected-payload proofs through the real
// `gate()`, not live GitHub responses.

/** A page of the 101-run commit: 100 rows, the total that says one is missing. */
const overflowPage = (rows, over = {}) => checkPage(rows, { total_count: 101, ...over });

test('#176: a commit announcing 101 runs is read past its first page of 100', () => {
  const { code, out, calls, headSha } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), overflowPage(filler(1, 99))],
  });
  assert.equal(code, 0, out);
  const reads = calls.filter(call => call.includes('/check-runs'));
  assert.equal(reads.length, 2, reads.join(' | '));
  assert.match(reads[1], /page=2/);
  assert.match(out, new RegExp(`checks: page 1 — 100 run\\(s\\) read, 100 distinct of 101 announced on ${headSha.slice(0, 12)}`));
  assert.match(out, new RegExp(`checks: 101 check-run\\(s\\) reported on ${headSha.slice(0, 12)} — the read is complete`));
});

// ── the FULL page that counts enough, which is not the end of a list ────────
//
// A total that is an exact multiple of the page size is the case a reconciled
// COUNT cannot decide: page 1 announces 100 and supplies 100, so the tally
// balances on a page whose own length proves nothing (a short page is the last
// one; a full page is a list this run cannot prove complete). Establishing
// there authorises on arithmetic rather than on an observation — and the page
// never asked for is exactly where a stale or under-announced total shows
// itself.

/** A page of the commit that announces a round 100. */
const roundPage = (rows, over = {}) => checkPage(rows, { total_count: 100, ...over });

test('#176: a full page that reaches the announced total is still read to the endpoint’s own end', () => {
  const { code, out, calls } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [roundPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), roundPage([])],
  });
  assert.equal(code, 0, out);
  // TWO reads: the count balanced on page 1 and the gate asked anyway.
  const reads = calls.filter(call => call.includes('/check-runs'));
  assert.equal(reads.length, 2, reads.join(' | '));
  assert.match(reads[1], /page=2/);
  assert.match(out, /checks: 100 check-run\(s\) reported on .* — the read is complete/);
});

test('#176: a stale total that a full page happens to satisfy cannot pass on the count', () => {
  // The endpoint announced 100 and holds 150. The old exit — and a reconciled
  // count alone — would authorise on page 1; the terminal read finds the rows
  // the total did not admit to.
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [roundPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), roundPage(filler(50, 100))],
  });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: the read observed 150 distinct run\(s\).*where 100 were announced/);
  assert.doesNotMatch(out, /PASS —/);
});

test('#176: a repeated page after a balanced full page leaves the end of the list unread', () => {
  // Only page 1 is supplied, so page 2 is page 1 again: the count balances and
  // the endpoint never showed an end.
  const { code, out, calls } = run(['--pr', '1845'], { ...CLEAN, checks: [roundPage([checkRun(AGGREGATE, 'success'), ...filler(99)])] });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: page 2 repeats runs this read already observed and adds none/);
  assert.match(out, /100 distinct run\(s\) observed of the 100 announced/);
  assert.doesNotMatch(out, /checks: 100 check-run\(s\) reported/);
  // Two reads, then a stop: never a 25-page loop over one page.
  assert.equal(calls.filter(call => call.includes('/check-runs')).length, 2);
});

test('#176: a green declared check on page one alone cannot establish completeness', () => {
  // ONE page supplied where the endpoint announced 101 rows, so page 2 is page
  // 1 again — the read never reconciles, and the green aggregate on page 1
  // does not carry it.
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)])] });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: page 2 repeats runs this read already observed and adds none/);
  assert.doesNotMatch(out, /PASS —/);
  assert.doesNotMatch(out, /checks: 101 check-run\(s\) reported/);
});

test('#176: every page is read on the validated head SHA, and the pages ascend', () => {
  const { calls, headSha } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), overflowPage(filler(1, 99))],
  });
  const reads = calls.filter(call => call.includes('/check-runs'));
  assert.deepEqual(
    reads,
    [1, 2].map(page => `api repos/${SLUG}/commits/${headSha}/check-runs?per_page=100&page=${page}`),
  );
});

test('#176: a declared check that exists only on a later page is evaluated there', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage(filler(100)), overflowPage([checkRun(AGGREGATE, 'success')])],
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /has NO run/);
});

test('#176: a later-page failure refuses even though an earlier page ran the same check green', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), overflowPage([checkRun(AGGREGATE, 'failure')])],
  });
  assert.equal(code, 1, out);
  assert.match(out, /REFUSE — checks: 'Playwright \(public games\)' concluded failure/);
});

test('#176: a later-page pending run for a declared check leaves CI undecided, green page one and all', () => {
  const { code, out, calls } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), overflowPage([checkRun(AGGREGATE, null, 'queued')])],
  });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: 'Playwright \(public games\)' is queued/);
  // And the thread reader does not act on it (F-031).
  assert.ok(!calls.some(call => call.startsWith('api graphql')), 'the thread read ran over undecided CI');
});

test('#176: an unrelated name failing on a later page gains no authority to block', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), overflowPage([checkRun('some other job', 'failure')])],
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /some other job/);
});

test('#176: a declared check absent from a COMPLETE multi-page read is still a refusal', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage(filler(100)), overflowPage(filler(1, 100))],
  });
  assert.equal(code, 1, out);
  assert.match(out, /REFUSE — checks: expected aggregate check 'Playwright \(public games\)' has NO run/);
});

test('#176: a failed later page leaves CI unestablished and names what it observed', () => {
  const { code, out, calls, headSha } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), null],
  });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: page 2 of 'gh api .*check-runs' failed — HTTP 502/);
  assert.match(out, new RegExp(`100 distinct run\\(s\\) observed of the 101 announced on ${headSha.slice(0, 12)}`));
  // The repair is the page that failed, quoted so a pasted `&` cannot
  // background it.
  assert.match(out, new RegExp(`→ gh api 'repos/${SLUG}/commits/${headSha}/check-runs\\?per_page=100&page=2'`));
  // An incomplete read never authorises the absence refusal either: the
  // declared check WAS observed, and nothing claims the read finished.
  assert.doesNotMatch(out, /checks: 101 check-run\(s\) reported/);
  assert.ok(!calls.some(call => call.startsWith('api graphql')), 'the thread read ran over an incomplete check read');
});

test('#176: --merge over an incomplete check read issues no merge at all', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), null],
  });
  assert.equal(code, 3, out);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), `a merge was issued over an incomplete read: ${calls.join(' | ')}`);
  assert.match(out, /--merge ignored: the verdict is not a pass, so nothing was mutated/);
});

test('#176: an unknown announced total is stated as unknown, never as zero', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: null });
  assert.equal(code, 3, out);
  assert.match(out, /0 distinct run\(s\) observed of an announced total this run could not read/);
  assert.doesNotMatch(out, /observed of the 0 announced/);
});

for (const [what, total] of [
  ['absent', undefined],
  ['a string', '101'],
  ['negative', -1],
  ['fractional', 1.5],
]) {
  test(`#176: a total_count that is ${what} leaves the number of runs on the SHA unknown`, () => {
    const rows = [checkRun(AGGREGATE, 'success')];
    const page = total === undefined ? { check_runs: rows } : { check_runs: rows, total_count: total };
    const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: page });
    assert.equal(code, 3, out);
    assert.match(out, /CANNOT ESTABLISH — checks: page 1 announces no readable total/);
    assert.doesNotMatch(out, /PASS —/);
  });
}

test('#176: two pages announcing different totals cannot be reconciled', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), checkPage(filler(1, 99), { total_count: 137 })],
  });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: page 2 announces 137 check-run\(s\).*where page 1 announced 101/);
});

test('#176: more distinct runs observed than announced is an inconsistent read, not a pass', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: checkPage([checkRun(AGGREGATE, 'success'), ...filler(3)], { total_count: 2 }) });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: the read observed 4 distinct run\(s\).*where 2 were announced/);
});

test('#176: pagination that ends before its own announced total leaves the rest unread', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    checks: [overflowPage([checkRun(AGGREGATE, 'success'), ...filler(99)]), overflowPage([])],
  });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: page 2 answered 0 run\(s\) and the read stands at 100 of the 101 announced/);
});

test('#176: a run with no readable id cannot be told apart from a repeat', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: checkPage([checkRun(AGGREGATE, 'success', 'completed', { id: undefined })]) });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: page 1 carries a run with no readable 'id' \('id' is absent\)/);
});

test('#176: the page bound stops rather than looping, and never becomes a pass', () => {
  // Every page genuinely advances — 100 fresh rows each — against a total no
  // number of pages this run may read can reach.
  const huge = Array.from({ length: 25 }, (_, i) => checkPage(filler(100, i * 100), { total_count: 100_000 }));
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, checks: huge });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — checks: pagination exceeded 25 pages; stopped rather than looping/);
  assert.match(out, /2500 distinct run\(s\) observed of the 100000 announced/);
  assert.equal(calls.filter(call => call.includes('/check-runs')).length, 25);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a merge was issued at the page bound');
});

test('#176: an incomplete check read still leaves the other grounds reporting', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: null, shape: 'stale' });
  assert.equal(code, 1, out);
  assert.match(out, /REFUSE — staleness: [0-9a-f]{12} \(main\) is not an ancestor of the validated head [0-9a-f]{12}/);
  assert.match(out, /CANNOT ESTABLISH — checks: page 1 of 'gh api .*check-runs' failed/);
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

// ── #175: the read has to be ESTABLISHED, not merely successful ────────────
//
// Every shape below returned HTTP 200 through a payload whose containers are
// all present, so `must` passes and the old ground read each one as an
// observed empty list on a final page — a PASS, and on `--merge` it would
// have issued a merge. That is an injected-payload proof, not three live
// GitHub responses or three real merges. The receipt now says which field
// or page could not be established, and an established read is the only
// one that can reach a pass.

for (const [what, nodes] of [
  ['absent', undefined],
  ['null', null],
  ['not a list', { edges: [] }],
]) {
  test(`#175: a page whose 'nodes' is ${what} is an unread page, never zero threads`, () => {
    const { code, out } = run(['--pr', '1845'], {
      threads: [threadShape({ pageInfo: { hasNextPage: false, endCursor: null }, ...(nodes === undefined ? {} : { nodes }) })],
    });
    assert.equal(code, 3, out);
    assert.match(out, /CANNOT ESTABLISH — threads: page 1 answered with no readable 'nodes' list/);
    assert.doesNotMatch(out, /PASS —/);
    // The distinction the receipt has to carry: nothing here claims an
    // established read, and no page line claims 0 threads were observed.
    assert.doesNotMatch(out, /threads: read established/);
  });
}

test("#175: a pageInfo that names no boolean 'hasNextPage' leaves the end of the list unestablished", () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadShape({ pageInfo: { endCursor: null }, nodes: [thread('T1', true)] })] });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — threads: page 1 names no boolean 'hasNextPage' \('hasNextPage' is absent\)/);
  // The threads it DID observe stay in the same receipt.
  assert.match(out, /threads: page 1 — 1 thread\(s\), 0 unresolved/);
});

test("#175: a non-boolean 'hasNextPage' is not a final page — a truthy string cannot end the read", () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadShape({ pageInfo: { hasNextPage: 'false', endCursor: null }, nodes: [] })] });
  assert.equal(code, 3, out);
  assert.match(out, /'hasNextPage' is string/);
});

test('#175: an absent pageInfo leaves whether a further page exists unread', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadShape({ nodes: [] })] });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — threads: page 1 answered with no readable 'pageInfo'/);
});

test('#175: a successor named with the cursor already read would repeat the page, so it is unread', () => {
  // The stub repeats its last page once the list is exhausted, which is
  // exactly the API shape this refuses: page 2 would be page 1 again.
  const { code, out, calls } = run(['--pr', '1845'], { threads: [threadPage([thread('T1', true)], true, 'CURSOR_2')] });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — threads: page 2 claims a next one and repeats the cursor it was read with/);
  // Two reads, then a stop: never a 50-page loop over one page.
  assert.equal(calls.filter(call => call.startsWith('api graphql')).length, 2);
});

test("#175: a successor whose 'endCursor' is not a usable string leaves the rest unread", () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadPage([thread('T1', true)], true, '')] });
  assert.equal(code, 3, out);
  assert.match(out, /claims a next one and names no cursor to advance on \('endCursor' is an empty string\)/);
});

test('#175: the complete-empty control — an observed final page with no threads does not block a passing PR', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadPage([])] });
  assert.equal(code, 0, out);
  assert.match(out, /threads: page 1 — 0 thread\(s\), 0 unresolved/);
  assert.match(out, /threads: read established — 0 thread\(s\) over 1 page\(s\), the final page was observed/);
});

test('#175: all-resolved over two complete pages is an established read, and passes', () => {
  const { code, out } = run(['--pr', '1845'], {
    threads: [threadPage([thread('T1', true)], true, 'CURSOR_2'), threadPage([thread('T2', true)])],
  });
  assert.equal(code, 0, out);
  assert.match(out, /threads: read established — 2 thread\(s\) over 2 page\(s\), the final page was observed/);
});

test('#175: an unresolved thread on a later page refuses even though every earlier page was clean', () => {
  const { code, out } = run(['--pr', '1845'], {
    threads: [threadPage([thread('T_ok', true)], true, 'CURSOR_2'), threadPage([thread('T_late', false)])],
  });
  assert.equal(code, 1, out);
  assert.match(out, /REFUSE — threads: unresolved thread T_late/);
  assert.match(out, /threads: read established — 2 thread\(s\) over 2 page\(s\)/);
});

test('#175: an unestablished read on --merge mutates nothing — no merge call is issued', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { threads: [threadShape({ pageInfo: { hasNextPage: false, endCursor: null } })] });
  assert.equal(code, 3, out);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), `a merge was issued over an unestablished thread read: ${calls.join(' | ')}`);
  assert.match(out, /--merge ignored: the verdict is not a pass, so nothing was mutated/);
});

test('#175: the page bound reached with the pagination still advancing is unestablished, and merges nothing', () => {
  // FIFTY pages, each one genuinely advancing — distinct cursors, so nothing
  // here trips the repeated-cursor refusal. The bound is the last exit that
  // could still have read as a finished list, and it is the one shape the
  // fixture list has to spell out in full: the stub repeats its LAST page, so
  // a shorter list would establish the read on a repeat instead.
  const advancing = Array.from({ length: 50 }, (_, i) => threadPage([thread(`T${i + 1}`, true)], true, `CURSOR_${i + 2}`));
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { threads: advancing });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — threads: pagination exceeded 50 pages; stopped rather than looping, so the end of the thread list is unestablished/);
  // The bound's finding is actionable — it used to carry no repair at all.
  assert.match(out, /gh api graphql .*reviewThreads/);
  // Fifty reads, then a stop: the bound holds, and it never becomes a pass.
  assert.equal(calls.filter(call => call.startsWith('api graphql')).length, 50);
  assert.doesNotMatch(out, /threads: read established/);
  assert.doesNotMatch(out, /PASS —/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), `a merge was issued at the page bound: ${calls.join(' | ')}`);
});

test('#175: an incomplete read still names an actionable repair, and the other grounds keep reporting', () => {
  const { code, out } = run(['--pr', '1845'], { threads: [threadShape({ pageInfo: { hasNextPage: false, endCursor: null } })], shape: 'stale' });
  assert.equal(code, 1, out);
  // The thread finding names its repair...
  assert.match(out, /gh api graphql .*reviewThreads/);
  // ...and does not suppress the staleness ground beside it.
  assert.match(out, /REFUSE — staleness: [0-9a-f]{12} \(main\) is not an ancestor of the validated head [0-9a-f]{12}/);
  assert.match(out, /CANNOT ESTABLISH — threads: page 1 answered with no readable 'nodes' list/);
});

test('threads read before CI is decided are no observation at all', () => {
  const { code, out, calls, headSha } = run(['--pr', '1845'], {
    threads: [threadPage([thread('T1', true)])],
    checks: checkPage([checkRun(AGGREGATE, null, 'queued')]),
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
  assert.match(
    out,
    /REFUSE — staleness: [0-9a-f]{12} \(main\) is not an ancestor of the validated head [0-9a-f]{12} — the head this verdict would authorize is behind its base \(mergeStateStatus reads CLEAN, which is not the question\)/,
  );
  assert.match(out, /mergeStateStatus CLEAN {2}\(context only — never a ground here, F-033\.2\)/);
});

test('a branch carrying its base is current', () => {
  const { code, out } = run(['--pr', '1845'], CLEAN);
  assert.equal(code, 0);
  assert.match(out, /staleness: the validated head [0-9a-f]{12} carries [0-9a-f]{12} \(main\) — the head this verdict authorizes is current/);
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

test('a head branch absent from this local-only checkout cannot establish that head is its tip', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ headRefName: 'no-such-branch' }) });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — staleness: .*local 'no-such-branch' branch is absent/);
});

// ── #177: every git-backed ground is computed on the validated head and the
// observed base commit, never on a branch tip that can move past either.

test('#177: a newer local tip must not supply currency for the head the PR announces', () => {
  // The measured local-only case: the PR announces the pre-merge head, the base
  // advanced, and this checkout's own `feature` tip carries that base. Resolving
  // the head by NAME read the tip and called the announced commit current.
  const root = repoFor('base-merge', DEFAULT_GATE);
  const announced = shaOf(root, 'feature^1');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'base-merge', receipt: prView({ headRefOid: announced }) });
  assert.equal(code, 1, out);
  assert.match(out, new RegExp(`REFUSE — staleness: [0-9a-f]{12} \\(main\\) is not an ancestor of the validated head ${announced.slice(0, 12)}`));
  assert.match(out, new RegExp(`CANNOT ESTABLISH — staleness: .*local 'feature' tip is ${shaOf(root, 'feature').slice(0, 12)}`));
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'the announced old head was merged on a newer tip’s evidence');
});

test('#177: without a remote, a head that is not this branch tip cannot establish currency — and ancestry is still read', () => {
  const root = repoFor('head-behind-tip', DEFAULT_GATE);
  const announced = shaOf(root, 'feature~1');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'head-behind-tip', receipt: prView({ headRefOid: announced }) });
  assert.equal(code, 3, out);
  assert.match(out, new RegExp(`CANNOT ESTABLISH — staleness: .*not the validated head ${announced.slice(0, 12)}`));
  // The ancestry between the observed base and THAT head is still evaluated.
  assert.match(out, new RegExp(`staleness: the validated head ${announced.slice(0, 12)} carries [0-9a-f]{12} \\(main\\)`));
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('#177: a validated head this checkout does not hold is an unestablished read, never stale evidence', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, receipt: prView({ headRefOid: 'a'.repeat(40) }) });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — staleness: the validated head aaaaaaaaaaaa is absent from this checkout/);
  assert.match(out, /→ git fetch origin main feature/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('#177: an unrelated local branch moving past the head leaves a coherent verdict alone', () => {
  const { code, out, calls, headSha } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'sibling-moved' });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`staleness: the validated head ${headSha.slice(0, 12)} carries [0-9a-f]{12} \\(main\\)`));
  assert.ok(
    calls.some(call => call === `pr merge 1845 --repo ${SLUG} --squash --match-head-commit ${headSha}`),
    'the mutation is bound to the head the grounds were computed on',
  );
});

test('#177: with a remote, the refreshed base is resolved to a commit and the announced head is judged against it', () => {
  const root = repoFor('remote-merged', DEFAULT_GATE);
  const announced = shaOf(root, 'feature^1');
  const base = shaOf(root, 'origin/main');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'remote-merged', receipt: prView({ headRefOid: announced }) });
  assert.equal(code, 1, out);
  assert.match(out, new RegExp(`git evidence: base ${base.slice(0, 12)} \\(origin/main\\) and the validated head ${announced.slice(0, 12)}`));
  assert.match(out, new RegExp(`REFUSE — staleness: ${base.slice(0, 12)} \\(origin/main\\) is not an ancestor of the validated head ${announced.slice(0, 12)}`));
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('#177: with a remote, a head that carries the observed base passes and binds the merge to it', () => {
  const root = repoFor('remote-merged', DEFAULT_GATE);
  const base = shaOf(root, 'origin/main');
  const { code, out, calls, headSha } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'remote-merged' });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`staleness: the validated head ${headSha.slice(0, 12)} carries ${base.slice(0, 12)} \\(origin/main\\)`));
  assert.ok(calls.some(call => call.endsWith(`--match-head-commit ${headSha}`)), 'the merge names the head the grounds stood on');
});

// ── Ground 4: landed by content (advisory, never a refusal) ────────────────

test('F-033.1: a squashed branch is landed by content though ancestry says no', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'landed' });
  assert.match(out, /landed-by-content: YES — content equal to [0-9a-f]{12} \(main\).*ancestry says no/);
  // The only refusal is staleness. This ground never contributes one.
  assert.equal(code, 1);
  assert.doesNotMatch(out, /REFUSE — landed-by-content/);
  // Counted on the finding glyph, so the verdict's own "REFUSE — N reason(s)"
  // summary line is not mistaken for a fifth ground.
  assert.equal(out.match(/✗ REFUSE — /g).length, 1);
});

test('a branch with its own work reports the files that still differ', () => {
  const { out } = run(['--pr', '1845'], CLEAN);
  assert.match(out, /landed-by-content: NO — 1 file\(s\) still differ from [0-9a-f]{12} \(main\) \(ancestry says no\)/);
});

test('a diff that cannot be taken is reported, and still never refuses', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    // The pair is a base COMMIT and the validated head now, so the call is
    // named by its shape — two revisions and no pathspec — not by a branch name.
    git: (args, at) => (args[0] === 'diff' && args[1] === '--name-only' && !args.includes('--') ? refusedByGh('fatal: bad revision') : realGit(args, at)),
  });
  assert.equal(code, 0);
  assert.match(out, /landed-by-content: not decided — 'git diff' failed/);
});

// ── Ground 5: the residual-findings file ───────────────────────────────────

test('F-009: a residual file this branch wrote, then superseded, refuses', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'residual-stale', prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — residual findings: this branch wrote docs\/residual at [0-9a-f]{12} and 1 of its own commit\(s\) landed after it/);
  assert.match(out, /→ git log [0-9a-f]{40}\.\.[0-9a-f]{40}/);
});

test('a residual file written by the newest commit does not refuse', () => {
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'residual-current', prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } });
  assert.equal(code, 0);
  assert.match(out, /residual findings: written by this branch at [0-9a-f]{12}, the newest commit on the validated head [0-9a-f]{12}/);
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
  assert.match(out, /residual findings: docs\/residual differs from [0-9a-f]{12} \(main\) but no commit on this branch touched it/);
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

test('#90: a clean base merge as the only post-open commit passes with no --ack-body, in a fresh process', () => {
  // Criterion 2: nothing carried the SHA here — no record, no option, no flag.
  // A fresh invocation re-derives the shape from the commit graph, which is why
  // the owning worker's own gate run answers what the self-repair's run did.
  const root = repoFor('base-merge', DEFAULT_GATE);
  const merge = shaOf(root, 'feature');
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'base-merge', commits: [...prCommits(0), realCommitRow(root, 'feature')] });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`commits since open: 1 base merge — exempt: ${merge.slice(0, 12)}`));
  assert.doesNotMatch(out, /REFUSE — commits since open/, 'the gate refused base movement it could have minted itself');
  assert.doesNotMatch(out, /--ack-body/, 'a repair the caller cannot satisfy was printed anyway');
  assert.match(out, /grounds — \d+ reported, 0 unread, 0 refused/);
});

test('#90: the staleness self-repair no longer refuses the commit it just created, and the re-run judges the moved head', () => {
  // The reported run, reproduced: the caller's command carries no --ack-body
  // because the PR had no post-open commit when they typed it, `gh pr
  // update-branch` then mints the merge, and the ONE re-run this verb has must
  // not spend itself refusing that commit. The fixture publishes that merge as
  // `origin/feature` while its own `feature` stays behind — what a checkout
  // holds after GitHub moves the head — so the re-run measures the MOVED head
  // and its mutation is bound to it (#177), never to the commit that refused.
  const root = repoFor('stale-merged', DEFAULT_GATE);
  const moved = shaOf(root, 'updated');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    shape: 'stale-merged',
    // receipt · the head after the update · the retried run's own receipt · the
    // post-merge read-back, which only a run that reaches the mutation makes
    prStates: [prView(), prView({ headRefOid: moved }), prView({ headRefOid: moved }), prView({ headRefOid: moved, state: 'MERGED' })],
    // The caller's run sees no post-open commit; the re-run reads the merge the
    // update-branch call left behind.
    commits: reads => (reads === 0 ? prCommits(0) : [...prCommits(0), realCommitRow(root, 'updated')]),
  });
  assert.equal(code, 0, out);
  assert.match(out, /self-repair: staleness is the only refusing ground/);
  assert.equal(calls.filter(call => call.startsWith('pr update-branch')).length, 1, 'exactly one update, never a loop');
  assert.match(out, new RegExp(`commits since open: 1 base merge — exempt: ${moved.slice(0, 12)}`));
  assert.doesNotMatch(out, /REFUSE — commits since open/);
  assert.doesNotMatch(out, /--ack-body/, 'the merge went back to a worker for a body edit describing the gate\'s own commit');
  // The re-run stands on the moved head alone: fresh grounds, and the mutation
  // names that commit rather than the one the first run validated.
  assert.match(out, new RegExp(`staleness: the validated head ${moved.slice(0, 12)} carries [0-9a-f]{12} \\(origin/main\\)`));
  assert.match(out, /grounds — \d+ reported, 0 unread, 0 refused/);
  assert.ok(
    calls.some(call => call === `pr merge 1845 --repo ${SLUG} --squash --match-head-commit ${moved}`),
    'the repaired run merged a head other than the one it validated',
  );
});

test('#90: a caller-authored commit beside the exempt base merge still demands the acknowledgement', () => {
  const root = repoFor('base-merge', DEFAULT_GATE);
  const merge = shaOf(root, 'feature');
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, shape: 'base-merge', commits: [...prCommits(1), realCommitRow(root, 'feature')] });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — commits since open \[DETECTOR\]: 1 commit\(s\) landed after the PR was opened \(bbbbbbbbbb00\)/);
  assert.doesNotMatch(out, new RegExp(`REFUSE.*${merge.slice(0, 12)}`), 'the exempt merge is named in a refusal');
  assert.match(out, /--ack-body/);
  assert.match(out, /commits since open: 1 base merge — exempt/);
});

test('#90: --stale-retried suppresses nothing, and no CLI surface names a SHA to exempt', () => {
  // The rejected alternative was to let the recursion acknowledge its own
  // argv, and the rejected carrier was a SHA on this flag. Both would make the
  // detector suppressible from the command line for commits the body genuinely
  // fails to describe, so the flag stays a bare boolean that decides one thing
  // only: whether the one retry was already spent.
  const flagged = run(['--pr', '1845', '--stale-retried'], { ...CLEAN, commits: prCommits(2) });
  assert.equal(flagged.code, 1);
  assert.match(flagged.out, /REFUSE — commits since open \[DETECTOR\]: 2 commit\(s\) landed after the PR was opened \(bbbbbbbbbb00 bbbbbbbbbb11\)/);

  const valued = run(['--pr', '1845', '--stale-retried', HEAD_SHA], { ...CLEAN, commits: prCommits(2) });
  assert.equal(valued.code, 2);
  assert.match(valued.out, new RegExp(`unknown argument "${HEAD_SHA}"`));
});

test('#90: a merge shape this host cannot measure is exit 3, with a repair that is not the fetch', () => {
  // The exemption's cleanliness half is `git merge-tree --write-tree`, which
  // arrived in git 2.38. An older host answers 129, and the ground's account
  // is asserted where it is built (tests/pr-grounds.test.mjs) — but the thing
  // a caller and every wrapper around this verb actually consume is the EXIT
  // CODE, and that is only observable through gate(). An unread shape must
  // land on 3/CANNOT ESTABLISH, never on 1/REFUSE, or a transient tooling
  // failure reads as established authored work (#119 P2).
  const root = repoFor('base-merge', DEFAULT_GATE);
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    shape: 'base-merge',
    commits: [...prCommits(0), realCommitRow(root, 'feature')],
    git: (args, at) => (args[0] === 'merge-tree' ? { status: 129, stdout: '', stderr: 'error: unknown option `write-tree\'', error: undefined } : realGit(args, at)),
  });
  assert.equal(code, 3, out);
  assert.match(out, /CANNOT ESTABLISH — commits since open: .*'git merge-tree --write-tree' is not available here/);
  assert.match(out, /unknown is not exempt \(F-028\)/);
  assert.doesNotMatch(out, /REFUSE — commits since open/, 'an unread read was reported as authored work');
  // The repair has to be one that can work: no fetch adds a git capability.
  assert.match(out, /→ git --version {3}# 'merge-tree --write-tree' needs git 2\.38 or newer/);
  assert.doesNotMatch(out, /commits since open.*\n.*→ git fetch/, 'a fetch repair here loops forever');
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
  assert.match(out, /REFUSE — closing keyword: neither the body nor the PR title closes an issue or expresses intent to/);
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
  assert.match(out, /REFUSE — closing keyword: neither the body nor the PR title closes an issue or expresses intent to/);
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
  assert.match(out, /REFUSE — closing keyword: neither the body nor the PR title closes an issue or expresses intent to/);
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
  assert.match(out, /REFUSE — ticket binding: this merge is for #1786 .*, and neither the body nor the PR title closes a same-repository issue/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')));
});

test('#86: a PR title closing another ticket refuses where policy makes the title the merge subject', () => {
  // BODY_POLICY is `squash_merge_commit_title=PR_TITLE`: the title IS the
  // subject of the commit that lands on main, so a construct there closes
  // exactly like one in a commit message.
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    receipt: prView({ title: 'fix: the gate — Fixes #11' }),
  });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — ticket binding: .*#11/);
  assert.match(out, /the PR title closes #11/);
  assert.match(out, /→ gh pr edit 1845 --repo gapilabs\/gapila --title/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a title closed an unrelated ticket');
});

test('#86: --merge without --method evaluates the squash channels alone — the method it will ISSUE', () => {
  // The documented default mutates with --squash unconditionally. Widening to
  // every allowed method here refused a merge over commit messages that cannot
  // reach the commit this run writes.
  const { code, out, calls, headSha } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    policy: { ...BODY_POLICY, allow_merge_commit: true, allow_rebase_merge: true },
    commits: prCommits(0, ['fix: the gate\n\nFixes #11']),
  });
  assert.equal(code, 0, out);
  assert.match(out, /methods evaluated: squash/);
  assert.doesNotMatch(out, /rebase/, 'a method this run cannot issue decided the channel');
  assert.doesNotMatch(out, /#11/, 'a message that cannot reach the squash commit refused a merge');
  assert.deepEqual(
    calls.filter(call => call.startsWith('pr merge')),
    [`pr merge 1845 --repo ${SLUG} --squash --match-head-commit ${headSha}`],
    'the run merged with the very method it evaluated',
  );
});

// ── The release shape: the PR with no ticket by construction (#94) ──────────
//
// PR #68, the release-please pull request for 0.18.0, refused on `closing
// keyword` — a changelog names no ticket and never will — while
// `.github/workflows/test.yml` promises in its own header that `workflow_dispatch`
// "is what keeps the release path gateable instead of permanently hand-merged".
// 0.18.0 was merged by hand. Ruled 2026-09-02: the release PR is a recognized
// SHAPE — the release bot's authorship AND the release label — and the three
// grounds that cannot hold on it answer to that shape, not to a flag.
//
// The author spelling is measured, not chosen: `gh pr view 68 --json author`
// answered `app/github-actions` while the same PR's commits payload answered
// `github-actions[bot]`.

/** A release-please body: a changelog, whose closing references are markdown links. */
const CHANGELOG =
  'chore(main): release 0.18.0\n\n### Bug Fixes\n\n* the gate reads the declaration it is measured by ' +
  '([#70](https://github.com/flosrn/ax/pull/70)) closes [#1786](https://github.com/flosrn/ax/issues/1786)\n';

const releaseReceipt = (over = {}) =>
  prView({
    author: { is_bot: true, login: 'app/github-actions' },
    labels: [{ name: 'autorelease: pending' }],
    title: 'chore(main): release 0.18.0',
    body: CHANGELOG,
    ...over,
  });

/** A commit row carrying the account GitHub named for it. */
const authored = (row, login) => ({ ...row, author: login === null ? null : { login } });

/** The version bump release-please pushes AFTER opening its own pull request. */
const bump = () => authored(commitRow('bbbbbbbbbb003333', 'chore(main): release 0.18.0', '2026-08-09T11:00:00Z'), 'github-actions[bot]');

test('#94: the release path is gateable — the shape answers keyword, the bump and ticket binding', () => {
  // A release branch has no dispatch record and the orchestrator passes no
  // --issue, which is why teaching the parse alone would only move this run
  // from exit 1 to exit 3.
  const { code, out } = run(['--pr', '68'], { ...CLEAN, receipt: releaseReceipt(), commits: [bump()], record: null });
  assert.equal(code, 0, out);
  assert.match(out, /release shape\s+recognised/);
  assert.match(out, /closing keyword: release PR — no ticket by construction/);
  assert.match(out, /commits since open: 1 release commit .*bbbbbbbbbb00/);
  assert.match(out, /ticket binding: NOT RUN/);
  assert.match(out, /an unrun check is never a passed one/);
});

test('#94: the bot author alone is not the shape — a ticket-less PR it opened still refuses', () => {
  // The label is what an author can type; the authorship is what they cannot.
  // Neither half alone is the shape, so the ruled trade holds: a ticket-less
  // docs PR stays hand-merged.
  const { code, out } = run(['--pr', '104'], { ...CLEAN, receipt: releaseReceipt({ labels: [] }), commits: [bump()], record: null });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — closing keyword: neither the body nor the PR title closes an issue or expresses intent to/);
  assert.match(out, /REFUSE — commits since open \[DETECTOR\]: 1 commit\(s\) landed after the PR was opened/);
});

test('#94: a human commit on a release branch still refuses — the exemption is the bot\'s commits, not the branch', () => {
  const { code, out } = run(['--pr', '68'], {
    ...CLEAN,
    receipt: releaseReceipt(),
    commits: [bump(), authored(commitRow('cccccccccc003333', 'fix: a hand edit', '2026-08-09T11:30:00Z'), 'flosrn')],
    record: null,
  });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — commits since open \[DETECTOR\]: 1 commit\(s\) landed after the PR was opened \(cccccccccc00\)/);
  assert.match(out, /closing keyword: release PR — no ticket by construction/, 'the keyword ground still answers the shape');
  assert.match(out, /commits since open: 1 release commit/, 'and the bump is still named as exempt');
});

test('#94: a declared prGate.release names this project\'s label, and the default stops being the shape', () => {
  const declared = { aggregate: AGGREGATE, release: { label: 'release: pending' } };
  const own = run(['--pr', '68'], {
    ...CLEAN,
    prGate: declared,
    receipt: releaseReceipt({ labels: [{ name: 'release: pending' }] }),
    commits: [bump()],
    record: null,
  });
  assert.equal(own.code, 0, own.out);
  assert.match(own.out, /label 'release: pending'/);

  const defaulted = run(['--pr', '68'], { ...CLEAN, prGate: declared, receipt: releaseReceipt(), commits: [bump()], record: null });
  assert.equal(defaulted.code, 1, 'a declaration REPLACES the default shape, it does not add to it');
  assert.match(defaulted.out, /REFUSE — closing keyword/);
});

test('#94: a prGate.release naming no label is cannot-establish, never the default shape', () => {
  const { code, out, calls } = run(['--pr', '68'], { ...CLEAN, prGate: { aggregate: AGGREGATE, release: {} } });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — prGate\.release names no label/);
  assert.match(out, /→ declare "release": \{ "label"/);
  assert.deepEqual(calls, [], 'an unreadable declaration stops the run before any ground');
});

test('#94: a release merge verifies no ticket binding, and its replay stays fail-closed', () => {
  const storeDir = mkdtempSync(join(sandbox, 'store-'));
  const release = { ...CLEAN, receipt: releaseReceipt(), commits: [bump()], record: null, store: storeDir };
  const merged = run(['--pr', '68', '--merge'], release);
  assert.equal(merged.code, 0, merged.out);
  assert.match(merged.out, /MERGED — gapilabs\/gapila#68/);
  assert.match(merged.out, /closure: NOT RUN — release PR/, 'the unbound branch would have escalated a landed release to exit 3');
  assert.ok(!merged.calls.some(call => call.startsWith('issue view')), 'a release has no dispatched ticket to poll');

  // The REPLAY precheck runs before the receipt the shape is read from, and a
  // merged release PR no longer carries the pending label — GitHub's own
  // release-please moves it to `autorelease: tagged`. So the shape is NOT
  // remembered across runs (this module's rule for its sibling exemption too,
  // #90) and the replay answers exactly what it answered before: a changelog
  // names no same-repository closure to verify, and nothing is re-mutated.
  const merges = [];
  const replayed = run(['--pr', '68', '--merge'], { ...release, prStates: [prView({ state: 'MERGED', body: CHANGELOG })], onMerge: args => merges.push(args) });
  assert.equal(replayed.code, 0, replayed.out);
  assert.match(replayed.out, /REPLAYED-SUCCESS/);
  assert.match(replayed.out, /closure: nothing this merge closed from names a same-repository #N to verify/);
  assert.deepEqual(merges, [], 'a replayed release success issues no mutation');
});

// ── The second closure channel: the branch's commit messages (#86) ──────────
//
// The incident: on a repository whose squash merge message is BUILT from the
// commit messages, a commit whose prose quoted a closing construct naming an
// unrelated open ticket would have closed it on merge, and no ground could
// refuse — the body carried only the bound ticket's construct, which is all
// Ground 7 asks, and Ground 9's comparison set came from that body alone.

/** Two commits, both older than the PR, so only the channel is under test. */
const twoEarlyCommits = messages => messages.map((message, index) => commitRow(`${'abcdef'.repeat(2)}${index}${index}${index}${index}`, message, '2026-08-09T09:00:00Z'));

test('#86: a commit message closing another ticket refuses under COMMIT_MESSAGES, before the merge', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    policy: MESSAGES_POLICY,
    commits: prCommits(0, ['fix: the gate\n\nFixes #11']),
  });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — ticket binding: .*#11/);
  assert.match(out, /commit aaaaaaaaaaaa/);
  assert.match(out, /→ git rebase -i aaaaaaaaaaaa\^/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a merge closed an unrelated ticket');
  assert.ok(!calls.some(call => call.startsWith('issue view')), 'closure was polled for a merge that never happened');
});

test('#86: the same messages under PR_BODY change nothing — they never reach the default branch', () => {
  const { code, out } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    commits: prCommits(0, ['fix: the gate\n\nFixes #11']),
  });
  assert.equal(code, 0, out);
  assert.match(out, /ticket binding: the body closes #1786, the ticket this merge is for/);
  assert.doesNotMatch(out, /#11/, 'a message that cannot reach the merge commit contributed a finding');
  // The note names the ONE channel policy does land here — the PR title, which
  // becomes the squash subject — and no commit message at all.
  assert.match(out, /closing channels: the body, plus the PR title —/);
  assert.doesNotMatch(out, /commit message\(s\) on this branch/);
});

test('#86: the title arm — one commit and COMMIT_OR_PR_TITLE puts its subject on the default branch', () => {
  const subject = { ...BODY_POLICY, squash_merge_commit_title: 'COMMIT_OR_PR_TITLE' };
  const refused = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    policy: subject,
    commits: prCommits(0, ['fix: the gate — Fixes #11']),
  });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /squash_merge_commit_title=COMMIT_OR_PR_TITLE/);
  assert.match(refused.out, /REFUSE — ticket binding: .*#11/);

  // PR_TITLE takes the merge title from the pull request instead: inert.
  const inert = run(['--pr', '1845', '--merge'], { ...CLEAN, commits: prCommits(0, ['fix: the gate — Fixes #11']) });
  assert.equal(inert.code, 0, inert.out);

  // Two commits close the title arm too — GitHub then takes the PR title.
  const two = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    policy: subject,
    commits: twoEarlyCommits(['fix: the gate — Fixes #11', 'fix: the other half']),
  });
  assert.equal(two.code, 0, two.out);
  assert.doesNotMatch(two.out, /#11/);
});

test('#86: a detector run names no method, so it evaluates every one the repository allows and fails closed', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    policy: { ...BODY_POLICY, allow_merge_commit: true },
    commits: prCommits(0, ['fix: the gate\n\nFixes #11']),
  });
  assert.equal(code, 1);
  assert.match(out, /methods evaluated: squash, merge/);
  assert.match(out, /REFUSE — ticket binding: .*#11/);

  // Naming the method the caller stands on narrows it back to the squash arm.
  const named = run(['--pr', '1845', '--method', 'squash'], {
    ...CLEAN,
    policy: { ...BODY_POLICY, allow_merge_commit: true },
    commits: prCommits(0, ['fix: the gate\n\nFixes #11']),
  });
  assert.equal(named.code, 0, named.out);
  // And the next action it prints carries that method, or re-running it would
  // evaluate a wider set than the verdict stood on.
  assert.match(named.out, /→ ax pr gate --pr 1845 --method squash --merge/);
});

test('#86: a construct in a commit message is closing intent — Ground 7 prints no false absence', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    policy: MESSAGES_POLICY,
    receipt: prView({ body: 'A repair with no description.' }),
    commits: prCommits(0, ['fix: the gate\n\nCloses #1786']),
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /closes no issue and expresses no intent to/);
  assert.match(out, /closing keyword: 'Closes #1786' in commit aaaaaaaaaaaa — GitHub will close the issue/);
  assert.match(out, /ticket binding: commit aaaaaaaaaaaa closes #1786, the ticket this merge is for/);
  // One closure set, both sides of the merge: the post-merge sentence never
  // disagrees with the set the merge was approved against.
  assert.doesNotMatch(out, /the post-merge body closes/);
  assert.deepEqual(calls.filter(call => call.startsWith('issue view')), [`issue view 1786 --repo ${SLUG} --json state`]);
});

test('#86: the policy is read ONCE per run, and the commit messages ride the payload the gate already fetches', () => {
  const { code, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, policy: MESSAGES_POLICY });
  assert.equal(code, 0);
  assert.deepEqual(
    calls.filter(call => call === `api repos/${SLUG}`),
    [`api repos/${SLUG}`],
  );
  assert.deepEqual(
    calls.filter(call => call.includes('/pulls/1845/commits')),
    [`api repos/${SLUG}/pulls/1845/commits?per_page=100`],
  );
});

test('#86: an unread merge-message policy is cannot-establish, with the repair naming the command', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, policy: null });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — closing channels: 'gh api repos\/gapilabs\/gapila' failed — HTTP 502/);
  assert.match(out, /F-028/);
  assert.match(out, /→ gh api repos\/gapilabs\/gapila/);
  assert.ok(!calls.some(call => call.startsWith('pr merge')), 'a merge stood on a policy this run could not read');
});

test('#86: a commit list this run cannot prove complete leaves the channel unread, never empty', () => {
  const page = [];
  for (let i = 0; i < 100; i += 1) page.push(commitRow(String(i).padStart(40, '0'), `fix: ${i}`, '2026-08-09T09:00:00Z'));
  const { code, out } = run(['--pr', '1845', '--merge'], { ...CLEAN, policy: MESSAGES_POLICY, commits: page });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — closing channels: .*a full page of 100 commit\(s\)/);
  assert.match(out, /→ gh api --paginate/);
});

test('#86: base inertness outranks the channel — a commit construct closes nothing on a non-default base', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    policy: MESSAGES_POLICY,
    receipt: prView({ body: 'A repair with no description.', baseRefName: 'develop' }),
    commits: prCommits(0, ['fix: the gate\n\nCloses #1786']),
  });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — closing keyword: base 'develop' is not the default branch 'main'/);
  assert.match(out, /inert on this base/);
  assert.doesNotMatch(out, /GitHub will close the issue/);
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
    /staleness: the validated head [0-9a-f]{12} carries [0-9a-f]{12} \(main\)/,
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
  assert.equal(run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'remote-merged', store: storeDir }).code, 0);
  const recordPath = join(storeDir, 'merge', 'merge-gapilabs-gapila-1845.json');
  // A REAL commit this checkout holds AND its origin publishes: the declaration
  // guard reads the validated SHA's own `ax.config.json`, and the git-backed
  // grounds refuse to read a head this checkout cannot resolve (#177), so a
  // fabricated oid proves nothing about the record.
  const moved = shaOf(repoFor('remote-merged', DEFAULT_GATE), 'main');
  const merges = [];
  const replayed = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    shape: 'remote-merged',
    store: storeDir,
    receipt: prView({ headRefOid: moved }),
    onMerge: args => merges.push([...args]),
  });
  assert.equal(replayed.code, 0, replayed.out);
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
  // The head MOVED, so the one retry buys a real re-measurement — and the
  // commit it moved TO is still behind the base, which is the second-refusal
  // path: one update, then routing. Both commits are published, so the retried
  // run is judging the head GitHub answered and not a local tip (#177).
  const root = repoFor('stale-twice', DEFAULT_GATE);
  const announced = shaOf(root, 'feature~1');
  const moved = shaOf(root, 'feature');
  const { code, out, calls } = run(['--pr', '1845', '--merge'], {
    ...CLEAN,
    shape: 'stale-twice',
    // receipt · the head after the update · the retried run's own receipt
    prStates: [prView({ headRefOid: announced }), prView({ headRefOid: moved }), prView({ headRefOid: moved })],
  });
  assert.equal(code, 1, out);
  assert.match(out, /self-repair: staleness is the only refusing ground — updating the branch from base/);
  assert.equal(calls.filter(call => call.startsWith('pr update-branch')).length, 1, 'exactly one update, never a loop');
  assert.match(out, new RegExp(`REFUSE — staleness: [0-9a-f]{12} \\(origin/main\\) is not an ancestor of the validated head ${moved.slice(0, 12)}`));
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
    if (verb === 'api' && target.includes('/check-runs')) return answered(JSON.stringify(checkPage(greenChecks())));
    if (verb === 'api' && target.includes('/pulls/')) return answered(JSON.stringify(prCommits(0)));
    if (verb === 'api' && target === `repos/${SLUG}`) return answered(JSON.stringify(BODY_POLICY));
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
  // The sentence names the channels, not the body: #86 made the body one of
  // several texts a merge can close from, and a verdict that says "the body"
  // where it read three would be false on this project's own repository.
  assert.match(out, /closure: nothing this merge closed from names a same-repository #N to verify — that ticket moves by hand/);
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
      if (args.includes('state,mergeCommit,body,title')) heldAtReadBack = existsSync(lock);
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
    if (verb === 'api' && target.includes('/check-runs')) return answered(JSON.stringify(checkPage(greenChecks())));
    if (verb === 'api' && target.includes('/pulls/')) return answered(JSON.stringify(prCommits(0)));
    if (verb === 'api' && target === `repos/${SLUG}`) return answered(JSON.stringify(BODY_POLICY));
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
