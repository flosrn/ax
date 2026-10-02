#!/usr/bin/env node
// The release-propagation runbook, executable — first run performed by hand on
// 2026-08-26 (v0.12.3) and captured here so every later release is one command:
//
//   node scripts/deploy.mjs             # merge, wait for npm, pin consumers, pull this tree
//   node scripts/deploy.mjs --check     # drift report across every surface; needs no release, mutates nothing
//   node scripts/deploy.mjs --dry-run   # print the plan and the discovered consumers, mutate nothing
//   node scripts/deploy.mjs --pins-only # propagation only: pin consumers, no merge
//   node scripts/deploy.mjs --skip-pins # release to npm only; leave consumers where they are
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
// inventory is unknown, not empty). (5) Pin each consumer REPOSITORY once, on
// origin's default branch, from a temporary worktree of it: install with the
// lockfile that tree has (pnpm-lock.yaml, else bun.lock, else package-lock.json),
// `ax pin <version>` — the pin verb owns migration, install proof and doctor — commit,
// push, with one rebase retry because a busy main rejects the first push
// routinely. The checkout the walk found is never mutated (#286). (6)
// Fast-forward THIS checkout: release-please bumps the version on
// origin, so the tree that produced the release still read the previous one until
// 2026-08-26, when npm served 0.13.0 and the repository said 0.12.3.
//
// COMPUTE HOSTS ARE NOT REACHED FROM HERE. Their AX checkout is a HarnessOS
// component (`components.toml` `ax`, pinned to this checkout's package.json
// version), so the fast-forward in (6) is what moves their pin, and
// `components.ts apply --host <host> --apply` in HarnessOS is what converges
// them. Until 2026-09-27 this script pulled a checkout under /home/orca on the
// VPS itself; that checkout was decommissioned with the legacy harness.
//
// MAINTAINER TOOLING, NOT A COMMAND. This is deliberately not `ax deploy`:
// which machine roots hold consumers is a fact about the maintainer's machine,
// not about a consuming repository — a verb would teach every consumer a
// gesture only one machine can perform.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
/**
 * npm's post-publish processing, not a deploy step: `npm publish` ends with
 * "Your package is being processed and may take a few minutes to become
 * available", and on 2026-09-29 0.29.0 was served ~20 minutes after it. The
 * 5-minute wait this replaced gave up on every release that day (#283).
 */
const NPM_WAIT_MS = 30 * 60_000;
const MERGE_COMMIT_WAIT_MS = 60_000;
const POLL_MS = 15_000;
const MERGE_COMMIT_POLL_MS = 5_000;
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
  const pinsOnly = argv.includes('--pins-only');
  const rootsArg = argv.find((a) => a.startsWith('--roots='));
  const roots = rootsArg ? rootsArg.slice('--roots='.length).split(',') : DEFAULT_ROOTS;
  const FLAGS = ['--dry-run', '--check', '--skip-pins', '--pins-only'];
  const unknown = argv.filter((a) => !FLAGS.includes(a) && !a.startsWith('--roots='));
  if (unknown.length > 0) {
    bad(`unknown argument(s): ${unknown.join(' ')}`);
    fix('node scripts/deploy.mjs [--check] [--dry-run] [--pins-only] [--skip-pins] [--roots=/a,/b]');
    return 2;
  }

  const gh = (args) => exec('gh', args, { cwd: root, timeout: 60_000 });
  const git = (cwd, args) => exec('git', args, { cwd, timeout: 120_000 });

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

  /**
   * The EXACT version, read ONLINE. A bare `npm view <pkg> version` answered
   * from a cached packument — 0.28.2 while the registry already served 0.29.0
   * (#283) — so the release is asked for by name, past the cache.
   */
  async function waitForNpm(version) {
    const deadline = now() + NPM_WAIT_MS;
    for (;;) {
      const out = exec('npm', ['view', `${PKG}@${version}`, 'version', '--prefer-online'], { timeout: 30_000 });
      if (succeeded(out) && out.stdout.trim() === version) return true;
      if (now() >= deadline) return false;
      await sleep(30_000);
    }
  }

  const firstLine = out => (out.stderr || out.stdout || '').split('\n').find(line => line.trim() !== '')?.trim() || `exit ${out.status}`;

  /**
   * A CONSUMER IS A REPOSITORY, NOT THE CHECKOUT THE WALK FOUND (#286). The walk
   * finds working trees — a primary checkout on a feature branch, a linked
   * worktree of another, a checkout whose install lags its manifest — and each
   * is somebody's. So a consumer is keyed by its common git dir plus the
   * manifest's path inside it: two checkouts of one repository are one bump
   * (v1-walk-harness is a worktree of ofmchat). The default branch is the one
   * origin names; an unread answer is refused by name, never assumed `main`
   * (F-028).
   */
  function repositoryOf(dir) {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const prefix = git(dir, ['rev-parse', '--show-prefix']);
    if (!succeeded(common) || !succeeded(prefix)) {
      return { reason: `not a readable git checkout — ${firstLine(succeeded(common) ? prefix : common)}`, repair: `git -C ${dir} status   # a consumer is pinned through its repository; repair this checkout, then re-run` };
    }
    const origin = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (!succeeded(origin)) {
      return { reason: `which branch origin names default is unread — ${firstLine(origin)}`, repair: `git -C ${dir} remote set-head origin --auto   # then re-run` };
    }
    return {
      key: `${common.stdout.trim()}\0${prefix.stdout.trim()}`,
      prefix: prefix.stdout.trim(),
      main: origin.stdout.trim().replace(/^origin\//, ''),
    };
  }

  /**
   * The ax pin origin's default branch declares — the only pin a release moves.
   * `null` when that manifest declares none; `undefined` when it is unread.
   */
  function pinOnOrigin(dir, { main, prefix }) {
    const shown = git(dir, ['show', `origin/${main}:${prefix}package.json`]);
    if (!succeeded(shown)) return undefined;
    try {
      const pkg = JSON.parse(shown.stdout);
      const pinned = pkg.devDependencies?.[PKG] ?? pkg.dependencies?.[PKG];
      return typeof pinned === 'string' ? pinned : null;
    } catch {
      return undefined;
    }
  }

  /**
   * THE BUMP IS MADE IN A DETACHED WORKTREE OF origin/<default>, NEVER IN THE
   * CHECKOUT (#286). Measured releasing 0.29.2: running `ax pin` and `git push`
   * in the checkout the walk found pinned 1 consumer of 5. Two sat on feature
   * branches, where a push lands on that branch (chatnow_bot's 0.28.0 bump did,
   * 2026-09-29); one's install lagged its manifest, so its own ax refused to
   * run (ofmchat-engine, 0.28.1 installed under 0.29.1, right after the #283
   * sync had fast-forwarded a checkout four sessions were using); one was a
   * worktree of another. A worktree of origin's tip carries none of that: no
   * branch but the one pushed to, no local commit published with the bump, no
   * edit mixed into it. It is INSTALLED FIRST because the global ax delegates
   * to the version the manifest declares, and a tree with no install of its
   * own is answered by the primary checkout's — the stale one. It is removed
   * whatever happens, so a failed step is repaired on origin and re-run.
   */
  function pinConsumer({ dir }, version, seen) {
    const repo = repositoryOf(dir);
    if (repo.reason) {
      bad(`${dir}: ${repo.reason}`);
      fix(repo.repair);
      return 'unreadable';
    }
    if (seen.has(repo.key)) {
      note(`${dir}: same repository as ${seen.get(repo.key)} — its ${repo.main} is bumped once, there`);
      return 'same-repository';
    }
    seen.set(repo.key, dir);
    const fetched = git(dir, ['fetch', '-q', 'origin', repo.main]);
    if (!succeeded(fetched)) {
      bad(`${dir}: git fetch origin ${repo.main} failed — ${firstLine(fetched)}`);
      fix(`git -C ${dir} fetch origin ${repo.main}   # then re-run`);
      return 'unreadable';
    }
    const pinned = pinOnOrigin(dir, repo);
    if (pinned === undefined) {
      bad(`${dir}: the ${PKG} pin on origin/${repo.main} is unread`);
      fix(`git -C ${dir} show origin/${repo.main}:${repo.prefix}package.json   # then re-run`);
      return 'unreadable';
    }
    if (pinned === null) {
      note(`${dir}: origin/${repo.main} declares no ${PKG} — only a branch adopted it, and a release bumps default branches`);
      return 'not-on-default';
    }
    if (pinned === version) {
      ok(`${dir}: origin/${repo.main} already pins ${version}`);
      return 'current';
    }

    const parent = mkdtempSync(join(tmpdir(), 'ax-pin-'));
    const tree = join(parent, 'tree');
    const added = git(dir, ['worktree', 'add', '-q', '--detach', tree, `origin/${repo.main}`]);
    if (!succeeded(added)) {
      rmSync(parent, { recursive: true, force: true });
      bad(`${dir}: no worktree of origin/${repo.main} — ${firstLine(added)}`);
      fix(`git -C ${dir} worktree add --detach <path> origin/${repo.main}   # read why, then re-run`);
      return 'worktree-failed';
    }
    try {
      note(`${dir}: ${pinned} → ${version} on origin/${repo.main}, from a worktree of it`);
      return bump(dir, join(tree, repo.prefix), version, repo.main);
    } finally {
      const removed = git(dir, ['worktree', 'remove', '--force', tree]);
      rmSync(parent, { recursive: true, force: true });
      if (!succeeded(removed) && !succeeded(git(dir, ['worktree', 'prune']))) {
        bad(`${dir}: the temporary worktree ${tree} is still registered`);
        fix(`git -C ${dir} worktree prune`);
      }
    }
  }

  /** Install, pin, commit and push from `at`, a worktree of origin/<main> of the consumer at `dir`. */
  function bump(dir, at, version, main) {
    const long = args => exec('git', args, { cwd: at, timeout: 600_000 });
    const rerun = 'node scripts/deploy.mjs --pins-only';
    // A bun repo has no pnpm-lock.yaml. Sending it to pnpm --frozen-lockfile
    // refuses the pin (harnessos, 0.29.3). The lockfile present names the installer.
    const [installBin, installArgs] = existsSync(join(at, 'pnpm-lock.yaml'))
      ? ['pnpm', ['install', '--frozen-lockfile']]
      : existsSync(join(at, 'bun.lock')) || existsSync(join(at, 'bun.lockb'))
        ? ['bun', ['install', '--frozen-lockfile']]
        : existsSync(join(at, 'package-lock.json'))
          ? ['npm', ['ci']]
          : ['pnpm', ['install', '--frozen-lockfile']];
    const install = exec(installBin, installArgs, { cwd: at, timeout: 600_000 });
    if (!succeeded(install)) {
      bad(`${dir}: ${installBin} ${installArgs.join(' ')} refused origin/${main} as it stands — ${firstLine(install)}`);
      fix(`${rerun}   # once ${main} installs frozen again`);
      return 'install-failed';
    }
    const pin = exec('ax', ['pin', version], { cwd: at, timeout: 600_000 });
    process.stdout.write(pin.stdout ?? '');
    if (!succeeded(pin)) {
      bad(`${dir}: ax pin ${version} exited ${pin.status} on origin/${main}`);
      fix(`${rerun}   # once the findings above are repaired on ${main}`);
      return 'pin-failed';
    }
    // Every file the install rewrote is the bump's: pnpm also appends the
    // version to a `minimumReleaseAgeExclude` entry that enumerates them
    // (chatnow_bot), and leaving that behind broke the next `pull --rebase`
    // (#274, #283). The pin that ran is the consumer's CURRENT version, which
    // may predate #274 and print a commit line without it.
    const lock = ['pnpm-lock.yaml', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock'].filter((f) => existsSync(join(at, f)));
    const workspace = existsSync(join(at, 'pnpm-workspace.yaml')) && !succeeded(git(at, ['diff', '--quiet', '--', 'pnpm-workspace.yaml'])) ? ['pnpm-workspace.yaml'] : [];
    const add = git(at, ['add', '--', 'package.json', ...lock, ...workspace]);
    if (!succeeded(add)) {
      bad(`${dir}: git add failed — ${firstLine(add)}`);
      fix(`${rerun}   # read why the bump files could not be staged`);
      return 'commit-failed';
    }
    // Consumer hooks run here (ofmchat: oxlint and a full typecheck), hence the
    // install above and the install-sized timeout.
    const commit = long(['commit', '-m', `chore(deps): bump ${PKG} to ${version}`]);
    if (!succeeded(commit)) {
      bad(`${dir}: git commit failed on origin/${main} — ${firstLine(commit)}`);
      fix(`${rerun}   # a hook may have refused, or ax pin changed nothing; read the output above`);
      return 'commit-failed';
    }
    const target = `HEAD:refs/heads/${main}`;
    let push = long(['push', '-q', 'origin', target]);
    if (!succeeded(push)) {
      note(`${dir}: push rejected — rebasing onto origin/${main} once`);
      const rebase = long(['pull', '-q', '--rebase', 'origin', main]);
      push = succeeded(rebase) ? long(['push', '-q', 'origin', target]) : rebase;
      if (!succeeded(push)) {
        bad(`${dir}: push to origin/${main} failed — ${firstLine(push)}`);
        fix(`${rerun}   # the bump is rebuilt on origin/${main}'s new tip`);
        return 'push-failed';
      }
    }
    ok(`${dir}: pinned on origin/${main}, committed, pushed`);
    return 'pinned';
  }

  function propagate(version, list) {
    const verdicts = [];

    if (skipPins) note('--skip-pins: consumers left as they are');
    else {
      section('consumers');
      const seen = new Map();
      for (const consumer of list) verdicts.push({ dir: consumer.dir, verdict: pinConsumer(consumer, version, seen) });
    }

    section('compute hosts');
    note('their AX checkout is a HarnessOS component pinned to this package.json: once this tree is fast-forwarded, converge each host with');
    fix('bun ~/Code/flosrn/harnessos/scripts/components.ts apply --host <host> --apply');

    section('summary');
    let failed = 0;
    for (const { dir, verdict } of verdicts) {
      note(`${dir}  ${verdict}`);
      if (!['pinned', 'current', 'same-repository', 'not-on-default'].includes(verdict)) failed = 1;
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
    const served = exec('npm', ['view', PKG, 'version', '--prefer-online'], { cwd: root, timeout: 60_000 });
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

    if (drifted === 0) ok('every surface matches the registry');
    return drifted === 0 ? 0 : 1;
  }

  if (pinsOnly) {
    section('pins only');
    const served = exec('npm', ['view', PKG, 'version', '--prefer-online'], { cwd: root, timeout: 60_000 });
    if (!succeeded(served) || served.stdout.trim() === '') {
      bad('the registry did not answer a version, so there is nothing a consumer may be pinned to');
      fix(`npm view ${PKG} version --prefer-online   # then re-run`);
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
    bad(`npm still does not serve ${version} after ${NPM_WAIT_MS / 60_000} minutes — the release is merged and tagged; only the registry is missing`);
    fix(`npm view ${PKG}@${version} version --prefer-online   # once it answers ${version}: node scripts/deploy.mjs --pins-only`);
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
