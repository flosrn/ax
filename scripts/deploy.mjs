#!/usr/bin/env node
// The release-propagation runbook, executable — first run performed by hand on
// 2026-08-26 (v0.12.3) and captured here so every later release is one command:
//
//   node scripts/deploy.mjs             # merge, wait for npm, pin consumers, pull this tree + the VPS adapter
//   node scripts/deploy.mjs --check     # drift report across every surface; needs no release, mutates nothing
//   node scripts/deploy.mjs --dry-run   # print the plan and the discovered consumers, mutate nothing
//   node scripts/deploy.mjs --pins-only # propagation only: pin consumers + the VPS adapter, no merge
//   node scripts/deploy.mjs --skip-pins # release to npm only; leave consumers where they are
//   node scripts/deploy.mjs --skip-remote # skip the VPS adapter checkout
//
// WHAT IT AUTOMATES, IN ORDER. (1) Find the open release-please PR — the one
// place a version number is allowed to come from (AGENTS.md: a release is never
// a hand-edited number). (2) Dispatch Test on that PR's BRANCH (GitHub documents
// workflow_dispatch `ref` as a branch or tag, never a raw SHA), identify the
// run that dispatch created, and refuse to merge until that run's head SHA and
// the named `pnpm test` check succeeded. Then merge bound to the same SHA.
// (3) Wait for the Release workflow AND for the npm registry to actually serve
// the new version — the registry lags the workflow, and pinning against a
// version npm cannot serve yet fails every consumer at once. (4) Discover the
// consumers by reading manifests, never from a remembered list: the 2026-08-26
// run claimed "everywhere" off a scan that had errored, and the honest
// inventory afterwards is the shape this step encodes (F-028: an errored
// inventory is unknown, not empty). (5) `ax pin <version>` in each consumer —
// the pin verb owns migration, install proof and doctor — then commit and push,
// with one pull --rebase retry because a busy main rejects the first push
// routinely. (6) Fast-forward THIS checkout: release-please bumps the version on
// origin, so the tree that produced the release still read the previous one until
// 2026-08-26, when npm served 0.13.0 and the repository said 0.12.3. (7) Converge
// the VPS adapter checkout, which `consumers()` can never find because it is not
// a consumer — it is ax itself, and `/home/orca/.omp` loads the bundle from it.
// Measured the same day: 78 commits stale, silently, equipping every session on
// that host. The old closing note told the operator to `ax pin` there, which is
// the wrong gesture for a checkout that IS the package.
//
// MAINTAINER TOOLING, NOT A COMMAND. This is deliberately not `ax deploy`:
// which machine roots hold consumers and which VPS runs the fleet are facts
// about the maintainer's machine, not about a consuming repository — a verb
// would teach every consumer a gesture only one machine can perform.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run as defaultRun } from '../src/exec.mjs';
import { repoView } from '../src/gh.mjs';
import { bad, fix, note, ok, section } from '../src/log.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@flosrn/ax';
/**
 * The workflow that owns a release, by the `name:` its file declares
 * (`.github/workflows/publish.yml`). Named here because a run is selected by it:
 * the newest run on this repository is routinely a DIFFERENT workflow on a
 * different ref.
 */
const RELEASE_WORKFLOW = 'Release';
/**
 * The merge ground. File path is what `gh workflow run` takes; `name:` is what
 * `gh run list --workflow` matches. The enumerated check is the job name.
 */
const TEST_WORKFLOW = 'Test';
const TEST_WORKFLOW_FILE = 'test.yml';
const TEST_CHECK = 'pnpm test';
/** Where consumer checkouts live on this machine. Override: --roots a,b */
const DEFAULT_ROOTS = [join(homedir(), 'Code'), join(homedir(), 'orca', 'workspaces')];
/** Directories a manifest walk never enters. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.worktrees']);
const WALK_DEPTH = 4;
const TEST_WAIT_MS = 10 * 60_000;
const RELEASE_WAIT_MS = 10 * 60_000;
const NPM_WAIT_MS = 5 * 60_000;
const MERGE_COMMIT_WAIT_MS = 60_000;
const POLL_MS = 15_000;
const MERGE_COMMIT_POLL_MS = 5_000;
/**
 * The remote surface `consumers()` can NEVER find, because it is not a consumer.
 * `/home/orca/Code/flosrn/ax` declares this package as its OWN name, not as a
 * dependency, and yet `/home/orca/.omp/agent/extensions/ax.ts` loads the AX
 * adapter from it — so every agent session on that host is equipped by whatever
 * commit this checkout happens to sit on. Measured 2026-08-26, right after the
 * 0.13.0 release: it was 78 commits behind, silently, and nothing watched it.
 *
 * `ax pin` is the WRONG gesture here and the old closing note said to use it:
 * there is nothing to pin, the checkout IS the package. It converges with a
 * fast-forward pull, run as `orca` and never as root — a root pull leaves
 * root:root files and the next pull as orca dies on "unable to unlink old file"
 * (the ops runbook has paid for this three times).
 */
const REMOTE_HOST = 'vps';
const REMOTE_USER = 'orca';
const REMOTE_ADAPTER = '/home/orca/Code/flosrn/ax';

const succeeded = (out) => !out.error && out.status === 0;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN_FIELDS = 'databaseId,status,conclusion,headSha,headBranch,event,name,workflowName,displayTitle,createdAt';

/**
 * The release-please runbook. `exec`/`sleep`/`now` are the seam tests inject;
 * production uses `run` and wall time. Timeouts are named defaults, not env.
 */
export async function deploy(
  argv = process.argv.slice(2),
  { exec = defaultRun, sleep = defaultSleep, now = Date.now, root = ROOT } = {},
) {
  const dry = argv.includes('--dry-run');
  const check = argv.includes('--check');
  const skipPins = argv.includes('--skip-pins');
  const skipRemote = argv.includes('--skip-remote');
  const pinsOnly = argv.includes('--pins-only');
  const rootsArg = argv.find((a) => a.startsWith('--roots='));
  const roots = rootsArg ? rootsArg.slice('--roots='.length).split(',') : DEFAULT_ROOTS;
  const FLAGS = ['--dry-run', '--check', '--skip-pins', '--skip-remote', '--pins-only'];
  const unknown = argv.filter((a) => !FLAGS.includes(a) && !a.startsWith('--roots='));
  if (unknown.length > 0) {
    bad(`unknown argument(s): ${unknown.join(' ')}`);
    fix('node scripts/deploy.mjs [--check] [--dry-run] [--pins-only] [--skip-pins] [--skip-remote] [--roots=/a,/b]');
    return 2;
  }

  const gh = (args) => exec('gh', args, { cwd: root, timeout: 60_000 });
  const git = (cwd, args) => exec('git', args, { cwd, timeout: 120_000 });

  const remote = (script) =>
    exec('ssh', [REMOTE_HOST, `sudo -u ${REMOTE_USER} -H bash -lc ${JSON.stringify(script)}`], { cwd: root, timeout: 180_000 });

  function pullSelf() {
    const dirty = git(root, ['status', '--porcelain']);
    if (!succeeded(dirty)) return { ok: false, reason: 'git status failed here' };
    if (dirty.stdout.trim() !== '') return { ok: false, reason: 'this checkout is not clean, so it is not fast-forwarded' };
    const pulled = git(root, ['pull', '--ff-only', '-q', 'origin', 'main']);
    if (!succeeded(pulled)) return { ok: false, reason: (pulled.stderr || '').split('\n')[0] || `exit ${pulled.status}` };
    return { ok: true };
  }

  function declaredVersion(dir) {
    try {
      return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '');
    } catch {
      return '';
    }
  }

  function consumers() {
    const found = [];
    const walk = (dir, depth) => {
      const path = join(dir, 'package.json');
      if (existsSync(path)) {
        try {
          const pkg = JSON.parse(readFileSync(path, 'utf8'));
          if (pkg.name !== PKG) {
            const pinned = pkg.devDependencies?.[PKG] ?? pkg.dependencies?.[PKG];
            if (typeof pinned === 'string') {
              found.push({ dir, pinned });
              return;
            }
          } else {
            return;
          }
        } catch {
          note(`skipping unreadable manifest: ${path}`);
        }
      }
      if (depth === 0) return;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth - 1);
      }
    };
    for (const dir of roots) if (existsSync(dir)) walk(dir, WALK_DEPTH);
    return found;
  }

  function releasePr() {
    const out = gh(['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName']);
    if (!succeeded(out)) return { error: `gh pr list failed — ${(out.stderr || '').split('\n')[0] || `exit ${out.status}`}` };
    let rows;
    try {
      rows = JSON.parse(out.stdout);
    } catch {
      return { error: 'gh pr list answered something that is not JSON' };
    }
    const pr = rows.find((row) => String(row.headRefName ?? '').startsWith('release-please--'));
    if (!pr) return { pr: null };
    const version = /release (\d+\.\d+\.\d+)/.exec(String(pr.title ?? ''))?.[1] ?? '';
    return { pr, version };
  }

  async function mergeCommitOf(number) {
    const deadline = now() + MERGE_COMMIT_WAIT_MS;
    for (;;) {
      const out = gh(['pr', 'view', String(number), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid // ""']);
      if (succeeded(out) && out.stdout.trim() !== '') return out.stdout.trim();
      if (now() >= deadline) return '';
      await sleep(MERGE_COMMIT_POLL_MS);
    }
  }

  async function waitForWorkflow(sha) {
    const deadline = now() + RELEASE_WAIT_MS;
    const short = sha.slice(0, 7);
    for (;;) {
      const out = gh(['run', 'list', '--workflow', RELEASE_WORKFLOW, '--commit', sha, '--limit', '1', '--json', 'status,conclusion,databaseId']);
      if (succeeded(out)) {
        try {
          const row = JSON.parse(out.stdout)[0];
          if (row?.status === 'completed') {
            return row.conclusion === 'success'
              ? { ok: true }
              : { ok: false, reason: `the ${RELEASE_WORKFLOW} workflow for ${short} concluded ${row.conclusion}`, id: row.databaseId };
          }
        } catch {}
      }
      if (now() >= deadline) {
        return { ok: false, reason: `the ${RELEASE_WORKFLOW} workflow for ${short} had not completed within 10 minutes` };
      }
      await sleep(POLL_MS);
    }
  }

  async function waitForNpm(version) {
    const deadline = now() + NPM_WAIT_MS;
    for (;;) {
      const out = exec('npm', ['view', PKG, 'version'], { timeout: 30_000 });
      if (succeeded(out) && out.stdout.trim() === version) return true;
      if (now() >= deadline) return false;
      await sleep(10_000);
    }
  }

  function pinConsumer({ dir, pinned }, version) {
    if (pinned === version) {
      ok(`${dir} already pins ${version}`);
      return 'current';
    }
    const state = git(dir, ['status', '--porcelain']);
    if (!succeeded(state)) {
      bad(`${dir}: git status failed — ${(state.stderr || '').split('\n')[0] || `exit ${state.status}`}`);
      fix(`cd ${dir} && git status   # not a healthy checkout; repair it, then re-run`);
      return 'unreadable';
    }
    if (state.stdout.trim() !== '') {
      bad(`${dir}: working tree is not clean — refusing to mix the bump with local work`);
      fix(`cd ${dir} && git status   # commit or stash what is there, then re-run this script`);
      return 'dirty';
    }
    note(`${dir}: ${pinned} → ${version}`);
    const pin = exec('ax', ['pin', version], { cwd: dir, timeout: 600_000 });
    process.stdout.write(pin.stdout ?? '');
    if (!succeeded(pin)) {
      bad(`${dir}: ax pin exited ${pin.status}`);
      fix(`cd ${dir} && ax pin ${version}   # read its findings; pin owns migration, install proof and doctor`);
      return 'pin-failed';
    }
    const lock = ['pnpm-lock.yaml', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock'].filter((f) => existsSync(join(dir, f)));
    const add = git(dir, ['add', '--', 'package.json', ...lock]);
    if (!succeeded(add)) {
      bad(`${dir}: git add failed — ${(add.stderr || '').split('\n')[0]}`);
      fix(`cd ${dir} && git add package.json ${lock.join(' ')} && git commit -m "chore(deps): bump ${PKG} to ${version}" && git push`);
      return 'commit-failed';
    }
    const commit = git(dir, ['commit', '-m', `chore(deps): bump ${PKG} to ${version}`]);
    if (!succeeded(commit)) {
      if (/nothing to commit/.test(commit.stdout + commit.stderr)) {
        ok(`${dir}: bump already committed`);
      } else {
        bad(`${dir}: git commit failed — ${(commit.stderr || commit.stdout || '').split('\n')[0]}`);
        fix(`cd ${dir} && git commit -m "chore(deps): bump ${PKG} to ${version}"   # hooks may have refused; read their output`);
        return 'commit-failed';
      }
    }
    let push = git(dir, ['push']);
    if (!succeeded(push)) {
      note(`${dir}: push rejected — retrying after pull --rebase`);
      const rebase = git(dir, ['pull', '--rebase']);
      push = succeeded(rebase) ? git(dir, ['push']) : push;
      if (!succeeded(push)) {
        bad(`${dir}: push failed — ${(push.stderr || '').split('\n')[0]}`);
        fix(`cd ${dir} && git pull --rebase && git push`);
        return 'push-failed';
      }
    }
    ok(`${dir}: pinned, committed, pushed`);
    return 'pinned';
  }

  function propagate(version, list) {
    const verdicts = [];

    if (skipPins) note('--skip-pins: consumers left as they are');
    else {
      section('consumers');
      for (const consumer of list) verdicts.push({ dir: consumer.dir, verdict: pinConsumer(consumer, version) });
    }

    section('remote adapter');
    if (skipRemote) note(`--skip-remote: ${REMOTE_HOST}:${REMOTE_ADAPTER} left as it is`);
    else {
      const out = remote(
        `cd ${REMOTE_ADAPTER} && git pull --ff-only -q origin main && git log --oneline -1 && node bin/ax.mjs help 2>&1 | head -1`,
      );
      if (!succeeded(out)) {
        bad(`${REMOTE_HOST} did not converge: ${(out.stderr || out.error || '').toString().split('\n').filter((l) => !l.includes('Address already in use'))[0] || `exit ${out.status}`}`);
        fix(`ssh ${REMOTE_HOST} 'sudo -u ${REMOTE_USER} -H git -C ${REMOTE_ADAPTER} pull --ff-only origin main'   # as ${REMOTE_USER}, never root`);
        verdicts.push({ dir: `${REMOTE_HOST}:${REMOTE_ADAPTER}`, verdict: 'unreached' });
      } else {
        for (const line of out.stdout.trim().split('\n')) note(`  ${line.trim()}`);
        ok(`${REMOTE_HOST} adapter checkout fast-forwarded — every session there is equipped from it`);
        verdicts.push({ dir: `${REMOTE_HOST}:${REMOTE_ADAPTER}`, verdict: 'pulled' });
      }
    }

    section('summary');
    let failed = 0;
    for (const { dir, verdict } of verdicts) {
      note(`${dir}  ${verdict}`);
      if (!['pinned', 'current', 'pulled'].includes(verdict)) failed = 1;
    }
    return failed;
  }

  function listTestDispatchRuns() {
    const out = gh(['run', 'list', '--workflow', TEST_WORKFLOW, '--event', 'workflow_dispatch', '--limit', '50', '--json', RUN_FIELDS]);
    if (!succeeded(out)) return { ok: false, rows: [], detail: (out.stderr || '').split('\n')[0] || `exit ${out.status}` };
    try {
      const rows = JSON.parse(out.stdout);
      return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch {
      return { ok: false, rows: [], detail: 'gh run list answered something that is not JSON' };
    }
  }

  function headOf(pr) {
    const out = gh(['pr', 'view', String(pr.number), '--json', 'headRefOid,headRefName']);
    if (!succeeded(out)) {
      return { ok: false, reason: `cannot read head of #${pr.number} — ${(out.stderr || '').split('\n')[0] || `exit ${out.status}`}` };
    }
    try {
      const data = JSON.parse(out.stdout);
      const head = String(data.headRefOid ?? '').trim();
      const branch = String(data.headRefName ?? '').trim();
      if (head === '' || branch === '') return { ok: false, reason: `head SHA or branch of #${pr.number} unread` };
      return { ok: true, head, branch };
    } catch {
      return { ok: false, reason: `head of #${pr.number} is not JSON` };
    }
  }

  function namedCheck(jobs) {
    if (!Array.isArray(jobs)) return null;
    return jobs.find((job) => job?.name === TEST_CHECK) ?? null;
  }

  function viewTestRun(id) {
    const out = gh(['run', 'view', String(id), '--json', 'databaseId,status,conclusion,headSha,event,name,jobs,headBranch,workflowName']);
    if (!succeeded(out)) return { ok: false, detail: (out.stderr || '').split('\n')[0] || `exit ${out.status}` };
    try {
      return { ok: true, run: JSON.parse(out.stdout) };
    } catch {
      return { ok: false, detail: 'gh run view answered something that is not JSON' };
    }
  }

  function parseWorkflowRunId(stdout) {
    try {
      const body = JSON.parse(stdout);
      const id = Number(body.workflow_run_id);
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * REST `failure` (including a zero-job startup_failure) is failure.
   * `action_required` / waiting-for-approval is named as approval, never as failure.
   * https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
   */
  function testRunVerdict(run, { head, branch, id }) {
    const runId = Number(run.databaseId);
    if (!Number.isInteger(runId) || runId <= 0 || runId !== Number(id)) {
      return { ok: false, reason: `Test run ${id} is unread — the bound id was not the run that answered` };
    }
    if (!run.event) return { ok: false, reason: `Test run ${id}: event unread` };
    if (run.event !== 'workflow_dispatch') {
      return { ok: false, reason: `Test run ${id} event is ${run.event}, not workflow_dispatch` };
    }
    const workflow = run.workflowName || run.name || '';
    if (workflow !== TEST_WORKFLOW) {
      return { ok: false, reason: `Test run ${id} is workflow ${workflow || 'unread'}, not ${TEST_WORKFLOW}` };
    }
    if (!run.headBranch) return { ok: false, reason: `Test run ${id}: branch unread` };
    if (run.headBranch !== branch) {
      return { ok: false, reason: `Test run ${id} ran on ${run.headBranch}, not ${branch}` };
    }
    if (!run.headSha) return { ok: false, reason: `Test run ${id}: head unread` };
    if (run.headSha !== head) {
      return {
        ok: false,
        reason: `Test run ${id} executed ${run.headSha.slice(0, 7)}, which does not authorize merge of ${head.slice(0, 7)} — wrong head`,
      };
    }
    const conclusion = run.conclusion ?? '';
    const status = run.status ?? '';
    if (conclusion === 'action_required' || status === 'waiting') {
      return {
        ok: false,
        reason: `Test run ${id} is waiting for approval (action_required) — not a merge ground`,
      };
    }
    if (status === 'completed' && conclusion && conclusion !== 'success') {
      return { ok: false, reason: `Test run ${id} concluded ${conclusion}` };
    }
    if (status !== 'completed' || conclusion !== 'success') return { ok: null };
    const job = namedCheck(run.jobs);
    if (!job) {
      return { ok: false, reason: `Test run ${id} has no named ${TEST_CHECK} check` };
    }
    if (job.conclusion !== 'success') {
      return { ok: false, reason: `Test run ${id}: ${TEST_CHECK} concluded ${job.conclusion || job.status}` };
    }
    return { ok: true };
  }

  /**
   * POST workflow_dispatch (API 2026-03-10 returns workflow_run_id). Poll that
   * id only. If the body omits it, match run-name to the ax_dispatch input —
   * never the newest Test. https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
   */
  async function waitForDispatchedTest({ branch, head }) {
    const viewed = repoView(gh);
    if (viewed.slug === '') {
      return { ok: false, reason: `cannot name this checkout's repository — ${viewed.detail}` };
    }
    const token = `ax-dispatch-${now()}`;
    const dispatched = gh([
      'api',
      '--method',
      'POST',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      `repos/${viewed.slug}/actions/workflows/${TEST_WORKFLOW_FILE}/dispatches`,
      '-f',
      `ref=${branch}`,
      '-f',
      `inputs[ax_dispatch]=${token}`,
    ]);
    if (!succeeded(dispatched)) {
      return {
        ok: false,
        reason: `could not dispatch Test on ${branch} — ${(dispatched.stderr || '').split('\n')[0] || `exit ${dispatched.status}`}`,
      };
    }
    note(`dispatched ${TEST_WORKFLOW} on ${branch} (workflow_dispatch ref is the branch, not ${head.slice(0, 7)})`);

    let id = parseWorkflowRunId(dispatched.stdout);
    const deadline = now() + TEST_WAIT_MS;
    if (id === null) {
      for (;;) {
        const listed = listTestDispatchRuns();
        if (!listed.ok) {
          return { ok: false, reason: `REST omitted workflow_run_id and Test runs are unread — ${listed.detail}` };
        }
        const matched = listed.rows.filter((row) => row.name === token || row.displayTitle === token);
        if (matched.length > 1) {
          return { ok: false, reason: 'Test run id unread — more than one run-name matched ax_dispatch' };
        }
        if (matched.length === 1) {
          const found = Number(matched[0].databaseId);
          if (!Number.isInteger(found) || found <= 0) {
            return { ok: false, reason: 'Test run id unread — ax_dispatch matched a run without a positive id' };
          }
          id = found;
          break;
        }
        if (now() >= deadline) {
          return { ok: false, reason: 'Test never produced a run — REST omitted workflow_run_id and no run-name matched ax_dispatch' };
        }
        await sleep(POLL_MS);
      }
    }


    for (;;) {
      const viewed = viewTestRun(id);
      if (!viewed.ok) {
        return { ok: false, reason: `Test run ${id} unread — ${viewed.detail}`, id };
      }
      const verdict = testRunVerdict(viewed.run, { head, branch, id });
      if (verdict.ok === true) return { ok: true, id, head };
      if (verdict.ok === false) return { ok: false, reason: verdict.reason, id };
      if (now() >= deadline) {
        return { ok: false, reason: `Test run ${id} had not completed within 10 minutes — timeout`, id };
      }
      await sleep(POLL_MS);
    }
  }

  section(`deploy — ${PKG}`);
  note(`roots        ${roots.join(', ')}${rootsArg ? '' : '   (defaults — override with --roots=/a,/b)'}`);

  if (check) {
    section('check');
    const head = git(root, ['log', '--oneline', '-1']);
    const fetched = git(root, ['fetch', '-q', 'origin', 'main']);
    const behind = succeeded(fetched) ? git(root, ['rev-list', '--count', 'HEAD..origin/main']) : null;
    const served = exec('npm', ['view', PKG, 'version'], { cwd: root, timeout: 60_000 });
    const registry = succeeded(served) ? served.stdout.trim() : '';
    note(`here         ${declaredVersion(root) || '?'} · ${(head.stdout || '').trim() || 'unreadable HEAD'}`);
    note(`             ${behind === null ? 'origin unreachable — behind-count UNKNOWN' : `${behind.stdout.trim()} commit(s) behind origin/main`}`);
    note(`npm          ${registry || 'unreadable — the registry answered nothing'}`);

    let drifted = 0;
    for (const consumer of consumers()) {
      const aligned = registry !== '' && consumer.pinned === registry;
      note(`${aligned ? 'aligned' : 'DRIFTED'}      ${consumer.dir} pins ${consumer.pinned}${aligned ? '' : ` — npm serves ${registry || '?'}`}`);
      if (!aligned) drifted += 1;
    }

    const out = remote(`cd ${REMOTE_ADAPTER} && git fetch -q origin main; git log --oneline -1; git rev-list --count HEAD..origin/main`);
    if (!succeeded(out)) {
      bad(`${REMOTE_HOST} unreachable — the adapter checkout's state is UNKNOWN, which is not the same as current`);
      fix(`ssh ${REMOTE_HOST}   # then: sudo -u ${REMOTE_USER} -H git -C ${REMOTE_ADAPTER} status`);
      drifted += 1;
    } else {
      const lines = out.stdout.trim().split('\n');
      const count = Number(lines[lines.length - 1]);
      note(`${count === 0 ? 'aligned' : 'DRIFTED'}      ${REMOTE_HOST}:${REMOTE_ADAPTER} — ${lines[0]?.trim()}`);
      if (count !== 0) {
        bad(`that checkout is ${count} commit(s) behind, and it equips EVERY agent session on ${REMOTE_HOST}`);
        fix(`node scripts/deploy.mjs --check   # then converge it: node scripts/deploy.mjs (or --skip-pins to release only)`);
        drifted += 1;
      }
    }

    if (drifted === 0) ok('every surface matches the registry');
    return drifted === 0 ? 0 : 1;
  }

  if (pinsOnly) {
    section('pins only');
    const served = exec('npm', ['view', PKG, 'version'], { cwd: root, timeout: 60_000 });
    if (!succeeded(served) || served.stdout.trim() === '') {
      bad('the registry did not answer a version, so there is nothing a consumer may be pinned to');
      fix(`npm view ${PKG} version   # then re-run`);
      return 3;
    }
    const registry = served.stdout.trim();
    const found = consumers();
    note(`version      ${registry}   (from the registry — this mode makes no release)`);
    note(`consumers    ${found.length === 0 ? 'none found under ' + roots.join(', ') : found.map((c) => `${c.dir} (${c.pinned})`).join(', ')}`);
    if (dry) {
      note('dry run — nothing pinned, nothing pulled');
      return 0;
    }
    return propagate(registry, found);
  }

  const found = releasePr();
  if (found.error) {
    bad(`CANNOT ESTABLISH — ${found.error}`);
    fix('gh auth status   # then re-run');
    return 3;
  }
  if (found.pr === null) {
    bad('no open release-please PR — there is nothing to release');
    fix('land fix:/feat: commits on main first; release-please opens the PR on the next push, then re-run this script');
    const list = consumers();
    note(`consumers that would receive the next release: ${list.length === 0 ? 'none found' : list.map((c) => `${c.dir} (${c.pinned})`).join(', ')}`);
    return dry ? 0 : 1;
  }
  if (found.version === '') {
    bad(`the release PR title does not carry a version: "${found.pr.title}"`);
    fix(`gh pr view ${found.pr.number}   # read it by hand; the title is release-please's contract`);
    return 3;
  }

  const version = found.version;
  note(`release PR   #${found.pr.number} — ${found.pr.title}`);
  note(`version      ${version}`);
  const list = consumers();
  note(`consumers    ${list.length === 0 ? 'none found under ' + roots.join(', ') : list.map((c) => `${c.dir} (${c.pinned})`).join(', ')}`);

  if (dry) {
    note('dry run — nothing merged, nothing pinned');
    return 0;
  }

  section('test');
  const headed = headOf(found.pr);
  if (!headed.ok) {
    bad(headed.reason);
    fix(`gh pr view ${found.pr.number} --json headRefOid,headRefName`);
    return 3;
  }
  const { head: expectedHead, branch } = headed;
  note(`head         ${expectedHead.slice(0, 7)} on ${branch}`);

  const test = await waitForDispatchedTest({ branch, head: expectedHead });
  if (!test.ok) {
    bad(test.reason);
    if (test.id) fix(`gh run view ${test.id}   # the Test run this dispatch produced`);
    else {
      const named = repoView(gh);
      const path = named.slug
        ? `repos/${named.slug}/actions/workflows/${TEST_WORKFLOW_FILE}/dispatches`
        : `repos/<owner>/<repo>/actions/workflows/${TEST_WORKFLOW_FILE}/dispatches`;
      fix(`gh api --method POST ${path} -f ref=${branch}`);
    }
    return 1;
  }
  ok(`${TEST_WORKFLOW} run ${test.id} succeeded ${TEST_CHECK} on ${expectedHead.slice(0, 7)}`);

  const again = headOf(found.pr);
  if (!again.ok) {
    bad(again.reason);
    fix(`gh pr view ${found.pr.number} --json headRefOid,headRefName`);
    return 3;
  }
  if (again.head !== expectedHead) {
    bad(
      `head moved from ${expectedHead.slice(0, 7)} to ${again.head.slice(0, 7)} — Test of ${expectedHead.slice(0, 7)} is stale and does not authorize this merge`,
    );
    fix(`gh pr view ${found.pr.number} --json headRefOid   # dispatch Test on the new head, then re-run`);
    return 1;
  }

  section('release');
  const merged = gh(['pr', 'merge', String(found.pr.number), '--merge', '--match-head-commit', expectedHead]);
  if (!succeeded(merged)) {
    bad(`merge failed — ${(merged.stderr || '').split('\n')[0] || `exit ${merged.status}`}`);
    fix(`gh pr merge ${found.pr.number} --merge --match-head-commit ${expectedHead}   # then re-run this script; it will find nothing to merge and continue`);
    return 1;
  }
  ok(`merged release PR #${found.pr.number} at ${expectedHead.slice(0, 7)}`);

  const mergeSha = await mergeCommitOf(found.pr.number);
  if (mergeSha === '') {
    bad(`GitHub did not name the merge commit of #${found.pr.number} within a minute, so no run can be attributed to it`);
    fix(`gh pr view ${found.pr.number} --json mergeCommit   # then: node scripts/deploy.mjs --check`);
    return 3;
  }

  const workflow = await waitForWorkflow(mergeSha);
  if (!workflow.ok) {
    bad(workflow.reason);
    if (workflow.id) fix(`gh run view ${workflow.id} --log-failed   # what failed, on the merge commit itself`);
    else fix(`gh run list --workflow ${RELEASE_WORKFLOW} --commit ${mergeSha}   # what that commit's release run is doing`);
    fix('node scripts/deploy.mjs --check   # the drift report: what the registry serves, and which surfaces lag it');
    return 1;
  }
  ok(`${RELEASE_WORKFLOW} workflow completed for ${mergeSha.slice(0, 7)}`);

  if (!(await waitForNpm(version))) {
    bad(`npm still does not serve ${version} after 5 minutes — the registry may be lagging`);
    fix(`npm view ${PKG} version   # once it answers ${version}, re-run with the pins: node scripts/deploy.mjs`);
    return 1;
  }
  ok(`npm serves ${PKG}@${version}`);

  const self = pullSelf();
  if (self.ok) ok(`this checkout now reads ${declaredVersion(root) || 'an unreadable version'}`);
  else {
    bad(`this checkout was NOT fast-forwarded: ${self.reason}`);
    fix('git pull --ff-only origin main   # the release bumped package.json on origin, not here');
  }

  return propagate(version, list);
}

const invokedAs = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  process.exit(await deploy(process.argv.slice(2)));
}
