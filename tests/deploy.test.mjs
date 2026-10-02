// #227 — a release-please PR is not mergeable until Test has run on THAT head.
//
// GitHub creates a `pull_request` run for the bot push that REST concludes
// `failure` with zero jobs (run 34303568653 on f893666). Other runs sit
// `action_required`. Those are not the same state, and neither is a Test of the
// head about to merge. `scripts/deploy.mjs` used to merge first and only wait
// for Release afterwards. The documented workaround is `workflow_dispatch` of
// Test on the release-please branch (ref is a branch or tag, not a raw SHA),
// then merge bound to the SHA that run actually executed.
//
// `exec`/`sleep`/`now` are injected. Timeouts use the named 10-minute default
// against a fake clock — not an environment bypass. A pre-existing Test of the
// same head is not the attributable run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { deploy } from '../scripts/deploy.mjs';

const BRANCH = 'release-please--branches--main';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MERGE = 'cccccccccccccccccccccccccccccccccccccccc';
const VERSION = '0.24.6';
const OLD_RUN = 88;
const NEW_RUN = 99;

function capture(fn) {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => (written.push(String(chunk)), true);
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  return Promise.resolve()
    .then(fn)
    .then((code) => ({ code, out: written.join('') }))
    .finally(() => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function greenJob(head = HEAD) {
  return { name: 'pnpm test', conclusion: 'success', status: 'completed', head_sha: head };
}

function greenRun(id, head = HEAD) {
  return {
    databaseId: id,
    status: 'completed',
    conclusion: 'success',
    headSha: head,
    headBranch: BRANCH,
    event: 'workflow_dispatch',
    name: 'Test',
    workflowName: 'Test',
    jobs: [greenJob(head)],
  };
}

function scenario(extra = {}) {
  return {
    pr: {
      number: 42,
      title: `chore(main): release ${VERSION}`,
      headRefName: BRANCH,
      headRefOid: HEAD,
    },
    headNow: HEAD,
    mergeCommit: MERGE,
    npmVersion: VERSION,
    preexisting: extra.preexisting ?? [],
    after: extra.after ?? [],
    views: extra.views ?? {},
    releaseRun: extra.releaseRun ?? { status: 'completed', conclusion: 'success', databaseId: 7, headSha: MERGE },
    refuseMerge: extra.refuseMerge ?? false,
    dispatchId: extra.dispatchId === undefined ? NEW_RUN : extra.dispatchId,
    // The correlated run becomes VISIBLE only after this many Test list reads:
    // the REST dispatch is async, so an immediately empty list is not "no run".
    correlatedAfter: extra.correlatedAfter ?? 0,
    correlatedRun: extra.correlatedRun ?? null,
    headFail: extra.headFail ?? '',
    viewFail: extra.viewFail ?? false,
    ...extra,
  };
}

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function fakeExec(s) {
  const calls = [];
  const exec = (bin, args, opts = {}) => {
    calls.push({ bin, args, cwd: opts.cwd });
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const fail = (stderr, status = 1) => ({ status, stdout: '', stderr });

    if (bin === 'npm') {
      if (args[0] === 'view') {
        // `npmServedAt`: the clock time from which the registry serves the
        // release (npm's post-publish processing). Before it, the exact version
        // is a 404 and the bare package answers the previous release.
        const served = s.npmServedAt === undefined || s.clock.now() >= s.npmServedAt;
        const exact = String(args[1] ?? '').lastIndexOf('@') > 0;
        if (exact) return served ? ok(`${s.npmVersion}\n`) : fail('npm error code E404\n');
        return ok(`${served ? s.npmVersion : '0.24.5'}\n`);
      }
      if (args[0] === 'ci') return ok('');
      return fail(`unexpected npm ${args.join(' ')}`);
    }
    if (bin === 'ssh') return fail('ssh must not run in this suite\n');
    // `ax pin`, as far as a consumer's files go: the pin, its lockfile, and the
    // version pnpm appends to a `minimumReleaseAgeExclude` entry (#274).
    if (bin === 'ax') {
      if (s.realGit && args[0] === 'pin') writeConsumer(opts.cwd, args[1]);
      s.onPin?.(opts.cwd);
      return ok('');
    }
    if (bin === 'pnpm') return s.installRefused ? fail('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n') : ok('');
    if (bin === 'bun') return ok('');
    if (bin === 'git') {
      if (s.realGit) return realGit(args, opts.cwd);
      if (args[0] === 'status') return ok('');
      if (args[0] === 'pull' || args[0] === 'fetch' || args[0] === 'add' || args[0] === 'commit' || args[0] === 'push') return ok('');
      if (args[0] === 'log') return ok('ccccccc chore: release\n');
      return fail(`unexpected git ${args.join(' ')}`);
    }
    if (bin !== 'gh') return fail(`unexpected binary ${bin}\n`);

    if (args[0] === 'repo' && args[1] === 'view') return ok('flosrn/ax\n');
    if (args[0] === 'pr' && args[1] === 'list') return ok(`${JSON.stringify([s.pr])}\n`);
    if (args[0] === 'pr' && args[1] === 'view') {
      const jq = flag(args, '--jq');
      if (jq === '.mergeCommit.oid // ""' || jq === '.mergeCommit.oid') return ok(`${s.mergeCommit}\n`);
      const headViews = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('headRefOid,headRefName'));
      if (s.headFail === 'always' || (s.headFail === 'after-test' && headViews.length > 1)) {
        return fail('HTTP 502: head unread\n');
      }
      const oid = s.headAfterTest && headViews.length > 1 ? s.headAfterTest : s.headNow;
      return ok(`${JSON.stringify({ mergeCommit: { oid: s.mergeCommit }, headRefOid: oid, headRefName: s.pr.headRefName })}\n`);
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (s.refuseMerge) return fail('GraphQL: Head branch was modified\n');
      return ok('merged\n');
    }
    if (args[0] === 'workflow' && args[1] === 'run') return ok('');
    if (args[0] === 'api' && args.includes('--method') && args.includes('POST')) {
      const input = args.find((a) => String(a).startsWith('inputs[ax_dispatch]='));
      if (input) s.token = String(input).slice('inputs[ax_dispatch]='.length);
      if (s.dispatchId == null) return ok('{}\n');
      return ok(`${JSON.stringify({ workflow_run_id: s.dispatchId, run_url: 'https://api.github.com', html_url: 'https://github.com' })}\n`);
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const workflow = flag(args, '--workflow');
      if (workflow === 'Test') {
        const dispatchAt = calls.findIndex((c) => c.bin === 'gh' && c.args[0] === 'api' && c.args.includes('POST'));
        if (dispatchAt < 0) return ok(`${JSON.stringify(s.preexisting)}\n`);
        const reads = calls.filter((c, i) => i > dispatchAt && c.bin === 'gh' && c.args[0] === 'run' && c.args[1] === 'list' && c.args.includes('Test')).length;
        const correlated = s.correlatedRun && reads > s.correlatedAfter ? [{ ...s.correlatedRun, name: s.token }] : [];
        return ok(`${JSON.stringify([...s.preexisting, ...s.after, ...correlated])}\n`);
      }
      return ok(`${JSON.stringify([s.releaseRun])}\n`);
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const id = Number(args[2]);
      if (s.viewFail) return fail('HTTP 502: run unread\n');
      const pool = [...s.after, ...s.preexisting, ...(s.correlatedRun ? [s.correlatedRun] : [])];
      const run = s.views[id] ?? pool.find((row) => row.databaseId === id);
      if (!run) return fail(`HTTP 404: run ${id} not found\n`);
      return ok(`${JSON.stringify(run)}\n`);
    }
    return fail(`unexpected gh ${args.join(' ')}`);
  };
  return { exec, calls };
}

/**
 * `inspect` reads the scenario's repositories BEFORE the roots are removed —
 * the consumer tests assert on what origin and the checkout hold afterwards.
 */
async function runDeploy(extra = {}, argv = ['--skip-pins'], { seed = () => ({}), inspect = () => ({}) } = {}) {
  const roots = mkdtempSync(join(tmpdir(), 'ax-deploy-roots-'));
  const s = scenario({ ...extra, ...seed(roots) });
  const clock = fakeClock();
  s.clock = clock;
  const { exec, calls } = fakeExec(s);
  try {
    const { code, out } = await capture(() =>
      deploy([`--roots=${roots}`, ...argv], { exec, sleep: clock.sleep, now: clock.now, root: roots }),
    );
    return { code, out, calls, s, seen: inspect(s, calls) };
  } finally {
    rmSync(roots, { recursive: true, force: true });
  }
}

const merged = (r) => r.calls.some((c) => c.bin === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
const dispatched = (r) =>
  r.calls.some(
    (c) =>
      c.bin === 'gh' &&
      ((c.args[0] === 'workflow' && c.args[1] === 'run' && c.args.includes('test.yml')) ||
        (c.args[0] === 'api' && c.args.includes('POST') && c.args.some((a) => String(a).includes('test.yml')))),
  );
const dispatchRef = (r) => {
  const c = r.calls.find(
    (row) =>
      row.bin === 'gh' &&
      ((row.args[0] === 'workflow' && row.args[1] === 'run') || (row.args[0] === 'api' && row.args.includes('POST'))),
  );
  if (!c) return undefined;
  const i = c.args.indexOf('--ref');
  if (i >= 0) return c.args[i + 1];
  const f = c.args.find((a) => String(a).startsWith('ref='));
  return f ? f.slice('ref='.length) : undefined;
};
const mergeHead = (r) => {
  const c = r.calls.find((row) => row.bin === 'gh' && row.args[0] === 'pr' && row.args[1] === 'merge');
  if (!c) return undefined;
  const i = c.args.indexOf('--match-head-commit');
  return i >= 0 ? c.args[i + 1] : undefined;
};
const releaseWait = (r) =>
  r.calls.some((c) => c.bin === 'gh' && c.args[0] === 'run' && c.args[1] === 'list' && c.args.includes('Release'));

test('--dry-run does not dispatch Test and does not merge', async () => {
  const r = await runDeploy({}, ['--skip-pins', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.equal(dispatched(r), false, r.out);
  assert.equal(merged(r), false, r.out);
});

test('--pins-only does not dispatch Test and does not merge', async () => {
  const r = await runDeploy({}, ['--skip-pins', '--pins-only']);
  assert.equal(r.code, 0, r.out);
  assert.equal(dispatched(r), false, r.out);
  assert.equal(merged(r), false, r.out);
});

test('a release PR is not merged when Test never produced a run', async () => {
  const r = await runDeploy({ dispatchId: null, after: [] });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Test never produced a run/);
  assert.doesNotMatch(r.out, /action_required/);
});

test('a REST failure on Test is a failure, not action_required, and blocks merge', async () => {
  const r = await runDeploy({
    dispatchId: 34303568653,
    after: [
      {
        databaseId: 34303568653,
        status: 'completed',
        conclusion: 'failure',
        headSha: HEAD,
        headBranch: BRANCH,
        event: 'workflow_dispatch',
        name: 'Test',
        workflowName: 'Test',
        jobs: [],
      },
    ],
  });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /failure/);
  assert.doesNotMatch(r.out, /action_required/);
});

test('approval required is named as such, not as failure, and blocks merge', async () => {
  const r = await runDeploy({
    dispatchId: 11,
    after: [
      {
        databaseId: 11,
        status: 'waiting',
        conclusion: 'action_required',
        headSha: HEAD,
        headBranch: BRANCH,
        event: 'workflow_dispatch',
        name: 'Test',
        workflowName: 'Test',
      },
    ],
  });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /approv/i);
  assert.doesNotMatch(r.out, /\bfailure\b/);
});

test('a Test run on another head does not authorize this merge', async () => {
  const r = await runDeploy({ after: [greenRun(NEW_RUN, OTHER)] });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(OTHER.slice(0, 7)));
  assert.match(r.out, new RegExp(HEAD.slice(0, 7)));
  assert.match(r.out, /does not authorize|wrong head/);
});

test('a successful Test without the named pnpm test check does not merge', async () => {
  const r = await runDeploy({
    after: [
      {
        ...greenRun(NEW_RUN, HEAD),
        jobs: [{ name: 'something else', status: 'completed', conclusion: 'success' }],
      },
    ],
  });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /pnpm test/);
});

test('a moved branch head cannot merge on the previous Test', async () => {
  const r = await runDeploy({ after: [greenRun(NEW_RUN, HEAD)], headNow: HEAD, headAfterTest: OTHER });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(OTHER.slice(0, 7)));
  assert.match(r.out, new RegExp(HEAD.slice(0, 7)));
  assert.match(r.out, /head moved|stale/);
});

test('a Test that never completes is a timeout, not a merge', async () => {
  const r = await runDeploy({
    dispatchId: 12,
    after: [
      {
        databaseId: 12,
        status: 'in_progress',
        conclusion: '',
        headSha: HEAD,
        headBranch: BRANCH,
        event: 'workflow_dispatch',
        name: 'Test',
        workflowName: 'Test',
      },
    ],
  });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /timeout/);
});

test('a pre-existing green Test of this head is not the attributable run', async () => {
  const r = await runDeploy({
    dispatchId: NEW_RUN,
    preexisting: [greenRun(OLD_RUN, HEAD)],
    after: [],
  });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(
    r.calls.some((c) => c.bin === 'gh' && c.args[0] === 'run' && c.args[1] === 'view' && c.args.includes(String(OLD_RUN))),
    false,
    'must not treat the pre-existing run as this dispatch',
  );
});

test('workflow_dispatch of Test on the release branch precedes merge of that SHA; Release is still waited after', async () => {
  const r = await runDeploy({
    dispatchId: NEW_RUN,
    preexisting: [greenRun(OLD_RUN, HEAD)],
    after: [greenRun(NEW_RUN, HEAD)],
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(dispatched(r), true, r.out);
  assert.equal(dispatchRef(r), BRANCH, `dispatch ref must be the branch, not a SHA: ${dispatchRef(r)}`);
  assert.ok(!/^[0-9a-f]{40}$/i.test(dispatchRef(r) ?? ''), 'GitHub documents workflow_dispatch ref as branch or tag');
  assert.equal(merged(r), true, r.out);
  assert.equal(mergeHead(r), HEAD, r.out);
  const dispatchAt = r.calls.findIndex(
    (c) =>
      c.bin === 'gh' &&
      ((c.args[0] === 'workflow' && c.args[1] === 'run') || (c.args[0] === 'api' && c.args.includes('POST'))),
  );
  const mergeAt = r.calls.findIndex((c) => c.bin === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(dispatchAt >= 0 && mergeAt > dispatchAt, 'Test must be dispatched before merge');
  assert.equal(releaseWait(r), true, r.out);
  const releaseAt = r.calls.findIndex(
    (c) => c.bin === 'gh' && c.args[0] === 'run' && c.args[1] === 'list' && c.args.includes('Release'),
  );
  assert.ok(releaseAt > mergeAt, 'Release remains a post-merge verification');
  assert.equal(
    r.calls.some((c) => c.bin === 'gh' && c.args[0] === 'run' && c.args[1] === 'view' && c.args.includes(String(NEW_RUN))),
    true,
    'the attributable run is the new databaseId',
  );
});

// ── F-028: an unread answer is not a verdict ─────────────────────────────────

test('the correlation fallback keeps looking: a run visible only later is still this dispatch', async () => {
  // REST omitted workflow_run_id and Actions had not yet listed the run. One
  // immediate read answering empty is API latency, not "Test produced nothing".
  const r = await runDeploy({
    dispatchId: null,
    correlatedAfter: 2,
    correlatedRun: { ...greenRun(NEW_RUN, HEAD) },
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(merged(r), true, r.out);
  assert.equal(mergeHead(r), HEAD, r.out);
  assert.equal(
    r.calls.some((c) => c.bin === 'gh' && c.args[0] === 'run' && c.args[1] === 'view' && c.args.includes(String(NEW_RUN))),
    true,
    'the correlated run is the one polled',
  );
});

test('an unread head read refuses before any dispatch, never a stale PR field', async () => {
  const r = await runDeploy({ headFail: 'always' });
  assert.equal(dispatched(r), false, r.out);
  assert.equal(merged(r), false, r.out);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /cannot read head|unread/i);
});

test('an unread head read AFTER a green Test refuses instead of merging the old SHA', async () => {
  const r = await runDeploy({ after: [greenRun(NEW_RUN, HEAD)], headFail: 'after-test' });
  assert.equal(dispatched(r), true, r.out);
  assert.equal(merged(r), false, r.out);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /cannot read head|unread/i);
});

test('an unread Test run refuses: no conclusion was observed', async () => {
  const r = await runDeploy({ after: [greenRun(NEW_RUN, HEAD)], viewFail: true });
  assert.equal(merged(r), false, r.out);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /unread/i);
});

// ── #283: the release pipeline's timing ─────────────────────────────────────

test('#283: a registry that serves the release 15 minutes after publish is waited for, and asked online', async () => {
  // Measured 2026-09-29: npm answered 0.29.0 ~20 minutes after `npm publish`
  // ("being processed"), and the 5-minute wait gave up on 0.29.1 every time.
  const r = await runDeploy({ npmServedAt: 15 * 60_000, after: [greenRun(NEW_RUN, HEAD)] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /npm serves @flosrn\/ax@0\.24\.6/);
  const views = r.calls.filter(c => c.bin === 'npm' && c.args[0] === 'view');
  assert.ok(views.length > 0 && views.every(c => c.args.includes('--prefer-online')), 'a cached packument answered 0.28.2 while the registry served 0.29.0');
  assert.ok(views.every(c => c.args[1] === `@flosrn/ax@${VERSION}`), 'the release is asked for by its exact version');
});

// ── #286: a consumer is pinned on origin's default branch, never in its checkout ──
//
// Measured 2026-09-30 releasing 0.29.2: deploy pinned 1 consumer of 5. It ran
// `ax pin` and `git push` INSIDE each consumer's working checkout, so a
// checkout on a feature branch was refused (chatnow_bot, ofmchat), a checkout
// whose install lagged its manifest could not run its own ax (ofmchat-engine,
// 0.28.1 installed under a 0.29.1 pin), and a second worktree of one repository
// was a consumer of its own (v1-walk-harness, a worktree of ofmchat). Each was
// pinned by hand from a worktree of origin/main. These run real git against a
// bare origin; only `ax pin` and `pnpm install` are faked.

const GIT_HOME = mkdtempSync(join(tmpdir(), 'ax-deploy-git-'));
writeFileSync(join(GIT_HOME, 'config'), '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: join(GIT_HOME, 'config'), GIT_CONFIG_NOSYSTEM: '1' };
after(() => rmSync(GIT_HOME, { recursive: true, force: true }));

function realGit(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error };
}

function git(cwd, ...args) {
  const out = realGit(args, cwd);
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${out.stderr}`);
  return out.stdout.trim();
}

/** A consumer's bump files at `pinned`; the workspace file only where one exists. */
function writeConsumer(dir, pinned, { workspace = existsSync(join(dir, 'pnpm-workspace.yaml')), lock } = {}) {
  const kind = lock ?? (existsSync(join(dir, 'bun.lock')) && !existsSync(join(dir, 'pnpm-lock.yaml')) ? 'bun' : 'pnpm');
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'consumer', devDependencies: { '@flosrn/ax': pinned } }, null, 2)}\n`);
  if (kind === 'bun') writeFileSync(join(dir, 'bun.lock'), `{"lockfileVersion":1}\n`);
  else writeFileSync(join(dir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# @flosrn/ax ${pinned}\n`);
  if (workspace) {
    const path = join(dir, 'pnpm-workspace.yaml');
    const listed = existsSync(path) ? /@flosrn\/ax@([^']*)'/.exec(readFileSync(path, 'utf8'))?.[1] ?? '' : '';
    writeFileSync(path, `minimumReleaseAgeExclude:\n  - '@flosrn/ax@${listed === '' ? pinned : `${listed} || ${pinned}`}'\n`);
  }
}

/** A consumer checkout on `main` whose bare origin holds the same commit. */
function consumerRepo(roots, name, { pinned = '0.24.0', workspace = false, lock = 'pnpm' } = {}) {
  const checkout = join(roots, name);
  const origin = join(roots, '.origins', `${name}.git`);
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(roots, '.origins'), { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  writeConsumer(checkout, pinned, { workspace, lock });
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'init');
  git(roots, 'clone', '-q', '--bare', checkout, origin);
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'fetch', '-q', 'origin');
  git(checkout, 'branch', '-q', '-u', 'origin/main');
  git(checkout, 'remote', 'set-head', 'origin', 'main');
  return { checkout, origin };
}

/** Somebody else's commit on origin's main, made from a scratch clone. */
function pushFromElsewhere(roots, origin, file, content, message) {
  const scratch = mkdtempSync(join(roots, '.scratch-'));
  git(scratch, 'clone', '-q', origin, 'c');
  writeFileSync(join(scratch, 'c', file), content);
  git(join(scratch, 'c'), 'add', file);
  git(join(scratch, 'c'), 'commit', '-qm', message);
  git(join(scratch, 'c'), 'push', '-q', 'origin', 'HEAD:main');
}

const subjects = origin => git(origin, 'log', '--format=%s', 'main').split('\n');
const worktreesOf = checkout => git(checkout, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length;
const BUMP = `chore(deps): bump @flosrn/ax to ${VERSION}`;

test('#286: a checkout on a feature branch, with local commits and edits, is pinned on origin/main — and left exactly as it was', async () => {
  const r = await runDeploy({ realGit: true }, ['--pins-only'], {
    seed: roots => {
      const repo = consumerRepo(roots, 'app');
      git(repo.checkout, 'checkout', '-q', '-b', 'feat/panel');
      writeFileSync(join(repo.checkout, 'notes.md'), 'local\n');
      git(repo.checkout, 'add', 'notes.md');
      git(repo.checkout, 'commit', '-qm', 'local work');
      writeConsumer(repo.checkout, '0.23.0');
      return { repo, headBefore: git(repo.checkout, 'rev-parse', 'HEAD') };
    },
    inspect: ({ repo }) => ({
      pinOnMain: JSON.parse(git(repo.origin, 'show', 'main:package.json')).devDependencies['@flosrn/ax'],
      subjects: subjects(repo.origin),
      branches: git(repo.origin, 'branch', '--format=%(refname:short)'),
      branch: git(repo.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'),
      head: git(repo.checkout, 'rev-parse', 'HEAD'),
      edit: readFileSync(join(repo.checkout, 'package.json'), 'utf8'),
      worktrees: worktreesOf(repo.checkout),
    }),
  });

  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen.pinOnMain, VERSION, r.out);
  assert.deepEqual(r.seen.subjects, [BUMP, 'init'], 'the bump sits on origin/main alone: the local commit is not published');
  assert.equal(r.seen.branches, 'main', 'nothing pushed to the feature branch');
  assert.equal(r.seen.branch, 'feat/panel');
  assert.equal(r.seen.head, r.s.headBefore);
  assert.match(r.seen.edit, /0\.23\.0/, 'the local edit is still there');
  assert.equal(r.seen.worktrees, 1, 'the temporary worktree is removed');

  const install = r.calls.findIndex(c => c.bin === 'pnpm' && c.args[0] === 'install');
  const pin = r.calls.findIndex(c => c.bin === 'ax' && c.args[0] === 'pin');
  assert.ok(install >= 0 && install < pin, 'the worktree is installed before its ax runs: delegation needs an install at the declared version (ofmchat-engine)');
  assert.equal(r.calls[install].cwd, r.calls[pin].cwd);
  assert.ok(!r.calls[pin].cwd.startsWith(r.s.repo.checkout), `pinned in ${r.calls[pin].cwd}, not in the checkout`);
  assert.equal(existsSync(r.calls[pin].cwd), false, 'the temporary worktree is gone from disk');
  assert.equal(r.calls.some(c => c.cwd === r.s.repo.checkout && (c.bin === 'ax' || c.bin === 'pnpm' || ['push', 'pull', 'commit', 'add', 'checkout'].includes(c.args[0]))), false, 'nothing runs in the checkout but reads and a fetch');
});

test('#286: origin/main already pinning the release is current — no worktree, and a checkout behind it is not pulled', async () => {
  const r = await runDeploy({ realGit: true }, ['--pins-only'], {
    seed: roots => {
      const repo = consumerRepo(roots, 'app');
      pushFromElsewhere(roots, repo.origin, 'package.json', `${JSON.stringify({ name: 'consumer', devDependencies: { '@flosrn/ax': VERSION } })}\n`, BUMP);
      return { repo, headBefore: git(repo.checkout, 'rev-parse', 'HEAD') };
    },
    inspect: ({ repo }) => ({ head: git(repo.checkout, 'rev-parse', 'HEAD'), subjects: subjects(repo.origin) }),
  });

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /app.*origin\/main already pins 0\.24\.6/);
  assert.equal(r.calls.some(c => c.bin === 'git' && c.args[0] === 'worktree'), false, r.out);
  assert.equal(r.calls.some(c => c.bin === 'ax' || c.bin === 'pnpm'), false, r.out);
  assert.equal(r.seen.head, r.s.headBefore, 'the checkout is somebody\'s working tree: it is not fast-forwarded');
  assert.deepEqual(r.seen.subjects, [BUMP, 'init']);
});

test('#286: two checkouts of one repository bump its main once', async () => {
  const r = await runDeploy({ realGit: true }, ['--pins-only'], {
    seed: roots => {
      const repo = consumerRepo(roots, 'app');
      git(repo.checkout, 'worktree', 'add', '-q', '-b', 'feat/walk', join(roots, 'walk'));
      return { repo };
    },
    inspect: ({ repo }) => ({ subjects: subjects(repo.origin) }),
  });

  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.seen.subjects, [BUMP, 'init'], r.out);
  assert.equal(r.calls.filter(c => c.bin === 'ax' && c.args[0] === 'pin').length, 1, r.out);
  assert.match(r.out, /walk.*same repository as .*app/);
});

test('#286/#274: a pnpm-workspace.yaml the install rewrote is committed with the bump', async () => {
  const r = await runDeploy({ realGit: true }, ['--pins-only'], {
    seed: roots => ({ repo: consumerRepo(roots, 'app', { workspace: true }) }),
    inspect: ({ repo }) => ({ workspace: git(repo.origin, 'show', 'main:pnpm-workspace.yaml') }),
  });

  assert.equal(r.code, 0, r.out);
  assert.match(r.seen.workspace, /0\.24\.0 \|\| 0\.24\.6/, r.out);
});

test('#286: a push rejected because origin/main moved is rebased onto it once, and lands', async () => {
  const r = await runDeploy({ realGit: true }, ['--pins-only'], {
    seed: roots => {
      const repo = consumerRepo(roots, 'app');
      let moved = false;
      return {
        repo,
        onPin: () => {
          if (moved) return;
          moved = true;
          pushFromElsewhere(roots, repo.origin, 'README.md', 'busy main\n', 'someone else');
        },
      };
    },
    inspect: ({ repo }) => ({ subjects: subjects(repo.origin) }),
  });

  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.seen.subjects, [BUMP, 'someone else', 'init'], r.out);
});

test('#286: an install origin/main refuses pins nothing, pushes nothing, and still removes the worktree', async () => {
  const r = await runDeploy({ realGit: true, installRefused: true }, ['--pins-only'], {
    seed: roots => ({ repo: consumerRepo(roots, 'app') }),
    inspect: ({ repo }) => ({ subjects: subjects(repo.origin), worktrees: worktreesOf(repo.checkout) }),
  });

  assert.notEqual(r.code, 0, r.out);
  assert.equal(r.calls.some(c => c.bin === 'ax'), false, r.out);
  assert.deepEqual(r.seen.subjects, ['init']);
  assert.equal(r.seen.worktrees, 1);
  assert.match(r.out, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.match(r.out, /node scripts\/deploy\.mjs --pins-only/);
});

test('a bun.lock consumer is installed with bun, not pnpm', async () => {
  const r = await runDeploy({ realGit: true }, ['--pins-only'], {
    seed: roots => ({ repo: consumerRepo(roots, 'app', { lock: 'bun' }) }),
    inspect: ({ repo }) => ({ subjects: subjects(repo.origin) }),
  });

  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.some(c => c.bin === 'pnpm'), false, r.out);
  assert.deepEqual(r.calls.find(c => c.bin === 'bun')?.args, ['install', '--frozen-lockfile']);
  assert.deepEqual(r.seen.subjects, [BUMP, 'init']);
});
