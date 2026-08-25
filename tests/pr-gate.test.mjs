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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { subcommandNames } from '../src/commands.mjs';
import { gate, readDeclaration } from '../src/pr-gate.mjs';
import { SUBCOMMANDS, pr as prNoun } from '../src/pr/index.mjs';
import { defaultExec } from '../src/worker/release.mjs';

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

/** `gh pr view` receipt. `mergeStateStatus: CLEAN` is deliberate: never a ground. */
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

const commit = (cwd, path, content, message) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
};

/** A repository whose `main`/`feature` pair reproduces one measured shape. */
function buildRepo(root, shape) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  // The inherited shape writes the residual directory on the BASE, before the
  // branch point: that is F-039's repository, where the file is present in the
  // tree and is not this branch's record.
  if (shape === 'residual-inherited') commit(root, `${RESIDUAL}/f-001.md`, 'a finding main filed\n', 'main files a residual');
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

const SHAPES = ['current', 'stale', 'landed', 'residual-stale', 'residual-current', 'residual-inherited'];
const repos = {};
let sandbox = '';

before(() => {
  // realpath up front: os.tmpdir() is a symlink on macOS and git reports
  // physical paths, so `repoPaths` would answer a path these expectations do not
  // hold.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ax-pr-gate-')));
  for (const shape of SHAPES) repos[shape] = buildRepo(join(sandbox, shape), shape);
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const writeConfig = (root, prGate) =>
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({ project: { name: 'fixture' }, apps: { web: 'apps/web' }, vendor: { repo: 'makerkit/kit' }, ...(prGate ? { prGate } : {}) }),
  );

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
 */
const run = (
  argv,
  { shape = 'current', prGate = DEFAULT_GATE, receipt, checks, threads, commits, slug = SLUG, mergeFails = false, git: gitOverride } = {},
) => {
  const root = repos[shape];
  writeConfig(root, prGate);

  const calls = [];
  const pages = threads ?? [threadPage([])];
  let page = 0;

  const gh = args => {
    calls.push(args.join(' '));
    const [verb, target] = args;
    if (verb === 'repo' && target === 'view') return slug === null ? refusedByGh('no remote') : answered(`${slug}\n`);
    if (verb === 'pr' && target === 'view') {
      return receipt === null ? refusedByGh('could not resolve to a Pull Request') : answered(JSON.stringify(receipt ?? prView()));
    }
    if (verb === 'pr' && target === 'merge') return mergeFails ? refusedByGh('Head branch was modified') : answered('merged\n');
    if (verb === 'api' && target === 'graphql') {
      const body = pages[page];
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

  const result = capture(() => gate([...argv], { gh, git: gitOverride ?? realGit, cwd: root }));
  return { ...result, calls };
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
  assert.notEqual(run(['--pr', '1845'], { receipt: prView({ headRefOid: `  ${HEAD_SHA}\n` }) }).code, 3);
});

test('a checkout may declare its gate WITHOUT the provisioning contract', () => {
  // Measured 2026-08-22: the two repositories whose merge gate this replaces have
  // no `ax.config.json` at all and provision themselves with their own hooks.
  // Requiring them to declare a web app, a port range and a vendor remote in
  // order to gate a pull request would be this package asserting a layout it does
  // not own — and this verb reads none of those values.
  const root = repos.current;
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ prGate: { aggregate: AGGREGATE, residualFindings: RESIDUAL } }));
  const { code, out } = capture(() =>
    gate(['--pr', '1845'], {
      gh: args => {
        const [verb, target] = args;
        if (verb === 'repo' && target === 'view') return answered(`${SLUG}\n`);
        if (verb === 'pr' && target === 'view') return answered(JSON.stringify(prView()));
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
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: { check_runs: [checkRun('some other job', 'success')] } });
  assert.equal(code, 1);
  assert.match(out, /REFUSE — checks: expected aggregate check 'Playwright \(public games\)' has NO run on 3f9a1c27b4d6/);
  assert.match(out, /→ gh api repos\/gapilabs\/gapila\/commits\/.*check-runs/);
});

test('F-014: fewer check-runs than another PR is not a missing guard', () => {
  // Two runs here where the fixture set has four. The count is never the
  // measurement: the set depends on the diff, on labels and on bots that decide
  // for themselves whether to run.
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, checks: { check_runs: [checkRun(AGGREGATE, 'success'), checkRun('claude-review', 'neutral')] } });
  assert.equal(code, 0);
  assert.match(out, /checks: 2 check-run\(s\) reported on 3f9a1c27b4d6/);
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
  const { code, out, calls } = run(['--pr', '1845'], {
    threads: [threadPage([thread('T1', true)])],
    checks: { check_runs: [checkRun(AGGREGATE, null, 'queued')] },
  });
  assert.equal(code, 3);
  assert.match(out, /threads: CI is not decided on 3f9a1c27b4d6e8f0a2c4e6081a3c5e7092b4d6f8 — a thread read now is no observation at all/);
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

test('F-040: a PR that closes no issue is a detector, not a refusal', () => {
  // gapila #1867, a tooling fix with no ticket behind it. Refusing here would
  // block every chore forever.
  const { code, out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ body: 'Tooling fix: the doctor read the wrong path.' }) });
  assert.equal(code, 0);
  assert.match(out, /closing keyword: \[DETECTOR\] the body closes no issue and expresses no intent to/);
});

test('a declared tracker turns the false "no intent" line into the actionable one', () => {
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9]+' } },
    receipt: prView({ body: 'Fixes GAP-380 — the spin dedup.' }),
  });
  assert.equal(code, 0);
  assert.match(out, /closing keyword: no GitHub keyword, but the body names Linear 'GAP-380' — GitHub closes nothing there, so that ticket moves by hand/);
  assert.doesNotMatch(out, /expresses no intent/);
});

test('without a declared tracker the wording is unchanged, so no other repository moves', () => {
  const { out } = run(['--pr', '1845'], { ...CLEAN, receipt: prView({ body: 'Fixes GAP-380 — the spin dedup.' }) });
  assert.match(out, /\[DETECTOR\] the body closes no issue and expresses no intent to/);
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

test('a tracker pattern that does not compile falls back to the detector, and decides nothing', () => {
  // The tracker half is a WORDING aid: it exists so the line below is not false
  // on a repository that tracks elsewhere. A typo in it must not gain a vote on
  // a merge, so it reverts to the bare detector line and the verdict is
  // whatever the other grounds said.
  const { code, out } = run(['--pr', '1845'], {
    ...CLEAN,
    prGate: { aggregate: AGGREGATE, tracker: { name: 'Linear', pattern: 'GAP-[0-9' } },
    receipt: prView({ body: 'Part of GAP-380.' }),
  });
  assert.equal(code, 0);
  assert.match(out, /closing keyword: \[DETECTOR\] the body closes no issue and expresses no intent to/);
  assert.doesNotMatch(out, /moves by hand/);
});

// ── The verdict and the merge ──────────────────────────────────────────────

test('a clean PR passes and reports what it prevents and what it merely detects', () => {
  const { code, out } = run(['--pr', '1845'], CLEAN);
  assert.equal(code, 0);
  assert.match(out, /PASS — gapilabs\/gapila#1845 is mergeable at 3f9a1c27b4d6e8f0a2c4e6081a3c5e7092b4d6f8\./);
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
  const { code, calls } = run(['--pr', '1845', '--merge'], CLEAN);
  assert.equal(code, 0);
  assert.deepEqual(
    calls.filter(call => call.startsWith('pr merge')),
    [`pr merge 1845 --repo ${SLUG} --squash --match-head-commit ${HEAD_SHA}`],
  );
});

test('--method merge lands a real merge commit, and squash never appears', () => {
  const { code, calls } = run(['--pr', '1845', '--merge', '--method', 'merge'], CLEAN);
  assert.equal(code, 0);
  const merge = calls.find(call => call.startsWith('pr merge'));
  assert.match(merge, /--merge --match-head-commit/);
  assert.doesNotMatch(merge, /--squash/);
});

test('--merge on a refusal mutates nothing', () => {
  const { code, out, calls } = run(['--pr', '1845', '--merge'], { ...CLEAN, shape: 'stale' });
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
    /REFUSE — closing keyword: 'Ferme #1786'/,
    /checks: 4 check-run\(s\) reported/,
    /staleness: feature carries main/,
    /landed-by-content: NO/,
  ]) {
    assert.match(out, ground);
  }
  assert.equal(out.match(/✗ REFUSE — /g).length, 4);
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
