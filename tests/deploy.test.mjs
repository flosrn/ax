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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
      return fail(`unexpected npm ${args.join(' ')}`);
    }
    if (bin === 'ssh') return fail('ssh must not run in this suite\n');
    if (bin === 'ax') return ok('');
    if (bin === 'git') {
      if (args[0] === 'status') return ok('');
      if (args[0] === 'pull' && args.includes('--ff-only')) s.onPull?.(opts.cwd);
      if (args[0] === 'pull' || args[0] === 'fetch' || args[0] === 'add' || args[0] === 'commit' || args[0] === 'push') return ok('');
      if (args[0] === 'log') return ok('ccccccc chore: release\n');
      // Per consumer: how far its checkout is behind / ahead of origin.
      if (args[0] === 'rev-list') {
        const rev = s.revs?.[opts.cwd] ?? {};
        if (args.includes('HEAD..origin/main')) return ok(`${rev.behind ?? 0}\n`);
        if (args.includes('origin/main..HEAD')) return ok(`${rev.ahead ?? 0}\n`);
        return ok('0\n');
      }
      // `git diff --quiet -- pnpm-workspace.yaml`: exit 1 when pnpm rewrote it.
      if (args[0] === 'diff') return s.workspaceRewritten?.[opts.cwd] ? fail('', 1) : ok('');
      // Which branch a consumer checkout is on, and which one its origin names
      // default. Unlisted checkouts are on `main`, as a released consumer is.
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok(`${s.branches?.[opts.cwd] ?? 'main'}\n`);
      if (args[0] === 'symbolic-ref') return ok('origin/main\n');
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

async function runDeploy(extra = {}, argv = ['--skip-pins'], { seed = () => ({}) } = {}) {
  const roots = mkdtempSync(join(tmpdir(), 'ax-deploy-roots-'));
  const s = scenario({ ...extra, ...seed(roots) });
  const clock = fakeClock();
  s.clock = clock;
  const { exec, calls } = fakeExec(s);
  try {
    const { code, out } = await capture(() =>
      deploy([`--roots=${roots}`, ...argv], { exec, sleep: clock.sleep, now: clock.now, root: roots }),
    );
    return { code, out, calls, s };
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

test('a consumer checked out on a feature branch is refused: the bump would land on that branch', async () => {
  // Measured 2026-09-29 rolling 0.28.0 out: chatnow_bot's checkout sat on
  // feat/wallet-contacts-ignore-menu, and `git push` published
  // "chore(deps): bump @flosrn/ax to 0.28.0" to that feature branch while
  // main kept 0.26.3 — reported as pinned.
  const r = await runDeploy({}, ['--pins-only'], {
    seed: roots => {
      const consumer = dir => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', devDependencies: { '@flosrn/ax': '0.24.0' } }));
        return dir;
      };
      const onMain = consumer(join(roots, 'on-main'));
      const onFeature = consumer(join(roots, 'on-feature'));
      return { onMain, onFeature, branches: { [onFeature]: 'feat/wallet-contacts-ignore-menu' } };
    },
  });

  const pinnedIn = dir => r.calls.some(c => c.bin === 'ax' && c.args[0] === 'pin' && c.cwd === dir);
  const pushedFrom = dir => r.calls.some(c => c.bin === 'git' && c.args[0] === 'push' && c.cwd === dir);
  assert.equal(pinnedIn(r.s.onMain) && pushedFrom(r.s.onMain), true, r.out);
  assert.equal(pinnedIn(r.s.onFeature), false, 'no pin in a checkout off the default branch');
  assert.equal(pushedFrom(r.s.onFeature), false, 'nothing pushed to the feature branch');
  assert.match(r.out, /on-feature.*feat\/wallet-contacts-ignore-menu, not main/);
  assert.notEqual(r.code, 0, r.out);
});

// ── #283: the release pipeline's timing and the consumer's own state ───────

const consumerAt = (dir, pinned = '0.24.0') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', devDependencies: { '@flosrn/ax': pinned } }));
  return dir;
};

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

test('#283: a consumer behind its origin is fast-forwarded first — and one whose origin already pins the release is current', async () => {
  // Measured 2026-09-29: chatnow_bot's main was one commit behind origin,
  // which already carried the 0.29.1 bump. deploy pinned the stale checkout,
  // committed a duplicate, and left it diverged when the push was rejected.
  const r = await runDeploy({}, ['--pins-only'], {
    seed: roots => {
      const stale = consumerAt(join(roots, 'stale'));
      return {
        stale,
        revs: { [stale]: { behind: 1, ahead: 0 } },
        onPull: dir => consumerAt(dir, VERSION),
      };
    },
  });
  const on = cmd => r.calls.filter(c => c.cwd === r.s.stale && c.bin === cmd.bin && c.args[0] === cmd.verb);
  assert.equal(on({ bin: 'git', verb: 'fetch' }).length > 0, true, 'the consumer is fetched before anything is decided');
  assert.ok(on({ bin: 'git', verb: 'pull' }).some(c => c.args.includes('--ff-only')), r.out);
  assert.equal(on({ bin: 'ax', verb: 'pin' }).length, 0, 'origin already pins the release: nothing to bump');
  assert.equal(on({ bin: 'git', verb: 'push' }).length, 0);
  assert.match(r.out, /stale.*already pins 0\.24\.6/);
  assert.equal(r.code, 0, r.out);
});

test('#283: a consumer with commits its origin lacks is refused — a bump push would publish them', async () => {
  const r = await runDeploy({}, ['--pins-only'], {
    seed: roots => {
      const ahead = consumerAt(join(roots, 'ahead'));
      return { ahead, revs: { [ahead]: { behind: 0, ahead: 2 } } };
    },
  });
  const touched = verb => r.calls.some(c => c.cwd === r.s.ahead && (c.bin === 'ax' || c.args[0] === verb) && (c.bin === 'ax' ? c.args[0] === 'pin' : true));
  assert.equal(touched('push'), false, r.out);
  assert.equal(r.calls.some(c => c.cwd === r.s.ahead && c.bin === 'ax'), false, 'no pin over unpublished local commits');
  assert.match(r.out, /ahead.*2 commit\(s\) origin\/main does not have/);
  assert.notEqual(r.code, 0, r.out);
});

test('#283/#274: a pnpm-workspace.yaml the install rewrote is committed with the bump', async () => {
  const r = await runDeploy({}, ['--pins-only'], {
    seed: roots => {
      const listed = consumerAt(join(roots, 'listed'));
      writeFileSync(join(listed, 'pnpm-workspace.yaml'), "minimumReleaseAgeExclude:\n  - '@flosrn/ax@0.24.0'\n");
      return { listed, workspaceRewritten: { [listed]: true } };
    },
  });
  const add = r.calls.find(c => c.cwd === r.s.listed && c.bin === 'git' && c.args[0] === 'add');
  assert.ok(add, r.out);
  assert.ok(add.args.includes('pnpm-workspace.yaml'), `staged: ${add.args.join(' ')}`);
  assert.equal(r.code, 0, r.out);
});
