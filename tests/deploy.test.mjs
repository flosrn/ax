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
import { mkdtempSync, rmSync } from 'node:fs';
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
  const exec = (bin, args) => {
    calls.push({ bin, args });
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const fail = (stderr, status = 1) => ({ status, stdout: '', stderr });

    if (bin === 'npm') {
      if (args[0] === 'view') return ok(`${s.npmVersion}\n`);
      return fail(`unexpected npm ${args.join(' ')}`);
    }
    if (bin === 'ssh') return fail('ssh must not run in this suite\n');
    if (bin === 'git') {
      if (args[0] === 'status') return ok('');
      if (args[0] === 'pull' || args[0] === 'fetch' || args[0] === 'add' || args[0] === 'commit' || args[0] === 'push') return ok('');
      if (args[0] === 'log') return ok('ccccccc chore: release\n');
      if (args[0] === 'rev-list') return ok('0\n');
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

async function runDeploy(extra = {}, argv = ['--skip-pins', '--skip-remote']) {
  const roots = mkdtempSync(join(tmpdir(), 'ax-deploy-roots-'));
  const s = scenario(extra);
  const { exec, calls } = fakeExec(s);
  const clock = fakeClock();
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
  const r = await runDeploy({}, ['--skip-pins', '--skip-remote', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.equal(dispatched(r), false, r.out);
  assert.equal(merged(r), false, r.out);
});

test('--pins-only does not dispatch Test and does not merge', async () => {
  const r = await runDeploy({}, ['--skip-pins', '--skip-remote', '--pins-only']);
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
