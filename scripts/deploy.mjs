#!/usr/bin/env node
// The release-propagation runbook, executable — first run performed by hand on
// 2026-08-26 (v0.12.3) and captured here so every later release is one command:
//
//   node scripts/deploy.mjs             # merge, wait for npm, pin consumers, pull this tree + the VPS adapter
//   node scripts/deploy.mjs --check     # drift report across every surface; needs no release, mutates nothing
//   node scripts/deploy.mjs --dry-run   # print the plan and the discovered consumers, mutate nothing
//   node scripts/deploy.mjs --skip-pins # release to npm only; leave consumers where they are
//   node scripts/deploy.mjs --skip-remote # skip the VPS adapter checkout
//
// WHAT IT AUTOMATES, IN ORDER. (1) Find the open release-please PR — the one
// place a version number is allowed to come from (AGENTS.md: a release is never
// a hand-edited number). (2) Merge it: release-please then owns the tag, the
// GitHub Release, and publish.yml publishes to npm via OIDC trusted publishing.
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

import { run } from '../src/exec.mjs';
import { bad, fix, note, ok, section } from '../src/log.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@flosrn/ax';
/** Where consumer checkouts live on this machine. Override: --roots a,b */
const DEFAULT_ROOTS = [join(homedir(), 'Code'), join(homedir(), 'orca', 'workspaces')];
/** Directories a manifest walk never enters. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.worktrees']);
const WALK_DEPTH = 4;
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

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const check = argv.includes('--check');
const skipPins = argv.includes('--skip-pins');
const skipRemote = argv.includes('--skip-remote');
const rootsArg = argv.find((a) => a.startsWith('--roots='));
const roots = rootsArg ? rootsArg.slice('--roots='.length).split(',') : DEFAULT_ROOTS;
const FLAGS = ['--dry-run', '--check', '--skip-pins', '--skip-remote'];
const unknown = argv.filter((a) => !FLAGS.includes(a) && !a.startsWith('--roots='));
if (unknown.length > 0) {
  bad(`unknown argument(s): ${unknown.join(' ')}`);
  fix('node scripts/deploy.mjs [--check] [--dry-run] [--skip-pins] [--skip-remote] [--roots=/a,/b]');
  process.exit(2);
}

const gh = (args) => run('gh', args, { cwd: ROOT, timeout: 60_000 });
const git = (cwd, args) => run('git', args, { cwd, timeout: 120_000 });
const succeeded = (out) => !out.error && out.status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One remote shell as the checkout's OWNER. `sudo -u orca -H` is not politeness:
 * `-H` sets HOME so git finds the right config, and running as the owner is what
 * keeps the NEXT pull from failing on files this one created.
 */
const remote = (script) =>
  run('ssh', [REMOTE_HOST, `sudo -u ${REMOTE_USER} -H bash -lc ${JSON.stringify(script)}`], { cwd: ROOT, timeout: 180_000 });

/**
 * The maintainer's OWN checkout, which the release leaves behind. release-please
 * lands the version bump on origin, so after a merge this tree still reads the
 * PREVIOUS version — measured 2026-08-26: npm served 0.13.0 while the repository
 * that produced it said 0.12.3, and the gap was closed by hand. A propagation
 * runbook that leaves its own origin stale has propagated to everywhere but home.
 */
function pullSelf() {
  const dirty = git(ROOT, ['status', '--porcelain']);
  if (!succeeded(dirty)) return { ok: false, reason: 'git status failed here' };
  if (dirty.stdout.trim() !== '') return { ok: false, reason: 'this checkout is not clean, so it is not fast-forwarded' };
  const pulled = git(ROOT, ['pull', '--ff-only', '-q', 'origin', 'main']);
  if (!succeeded(pulled)) return { ok: false, reason: (pulled.stderr || '').split('\n')[0] || `exit ${pulled.status}` };
  return { ok: true };
}

/** The version a checkout's manifest declares, or '' when it cannot be read. */
function declaredVersion(dir) {
  try {
    return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/** Every checkout under `roots` that DECLARES this package, read from manifests
 *  fresh on every run. Named keys only: an absent dependencies block is "not a
 *  consumer", never an error, and a manifest that will not parse is reported
 *  rather than silently skipped. */
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
            return; // a consumer root; its workspaces inherit the root pin
          }
        } else {
          return; // the package itself (a checkout or worktree), never a consumer
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
  for (const root of roots) if (existsSync(root)) walk(root, WALK_DEPTH);
  return found;
}

/** The open release-please PR, or null. The version comes from ITS title. */
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

async function waitForWorkflow() {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const out = gh(['run', 'list', '--limit', '1', '--json', 'status,conclusion']);
    if (succeeded(out)) {
      try {
        const row = JSON.parse(out.stdout)[0];
        if (row?.status === 'completed') return row.conclusion === 'success';
      } catch {}
    }
    if (Date.now() >= deadline) return false;
    await sleep(15_000);
  }
}

async function waitForNpm(version) {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const out = run('npm', ['view', PKG, 'version'], { timeout: 30_000 });
    if (succeeded(out) && out.stdout.trim() === version) return true;
    if (Date.now() >= deadline) return false;
    await sleep(10_000);
  }
}

/** Pin one consumer and land the bump. Returns a one-word verdict for the summary. */
function pinConsumer({ dir, pinned }, version) {
  if (pinned === version) {
    ok(`${dir} already pins ${version}`);
    return 'current';
  }
  // REFUSED UNLESS CLEAN. The bump commit below has no pathspec fence against a
  // pre-staged index: on a dirty tree, `git commit` would sweep unrelated staged
  // work into the bump, and `ax pin`'s install can collide with local edits to
  // the very files it rewrites. A dirty consumer is the operator's to settle.
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
  const pin = run('ax', ['pin', version], { cwd: dir, timeout: 600_000 });
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
    // Nothing to commit means a previous run already landed it; anything else is a finding.
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
    // A busy main rejects the first push routinely; one rebase retry, then a named repair.
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

section(`deploy — ${PKG}`);
note(`roots        ${roots.join(', ')}${rootsArg ? '' : '   (defaults — override with --roots=/a,/b)'}`);

// ── --check: the drift report, which needs no release to exist ───────────────
//
// The gap this closes: between releases nothing looked at these surfaces, and on
// 2026-08-26 the remote adapter checkout had been 78 commits stale for days. A
// release-time script cannot catch that, because at release time it is already
// too late to have known. This mode answers "is everything where the registry
// says it should be", mutates nothing, and needs no open release PR.
if (check) {
  section('check');
  const head = git(ROOT, ['log', '--oneline', '-1']);
  const fetched = git(ROOT, ['fetch', '-q', 'origin', 'main']);
  const behind = succeeded(fetched) ? git(ROOT, ['rev-list', '--count', 'HEAD..origin/main']) : null;
  const served = run('npm', ['view', PKG, 'version'], { cwd: ROOT, timeout: 60_000 });
  const registry = succeeded(served) ? served.stdout.trim() : '';
  note(`here         ${declaredVersion(ROOT) || '?'} · ${(head.stdout || '').trim() || 'unreadable HEAD'}`);
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
  process.exit(drifted === 0 ? 0 : 1);
}

const found = releasePr();
if (found.error) {
  bad(`CANNOT ESTABLISH — ${found.error}`);
  fix('gh auth status   # then re-run');
  process.exit(3);
}
if (found.pr === null) {
  bad('no open release-please PR — there is nothing to release');
  fix('land fix:/feat: commits on main first; release-please opens the PR on the next push, then re-run this script');
  // Discovery still answers "who would receive it", which is the dry question.
  const list = consumers();
  note(`consumers that would receive the next release: ${list.length === 0 ? 'none found' : list.map((c) => `${c.dir} (${c.pinned})`).join(', ')}`);
  process.exit(dry ? 0 : 1);
}
if (found.version === '') {
  bad(`the release PR title does not carry a version: "${found.pr.title}"`);
  fix(`gh pr view ${found.pr.number}   # read it by hand; the title is release-please's contract`);
  process.exit(3);
}

const version = found.version;
note(`release PR   #${found.pr.number} — ${found.pr.title}`);
note(`version      ${version}`);
const list = consumers();
note(`consumers    ${list.length === 0 ? 'none found under ' + roots.join(', ') : list.map((c) => `${c.dir} (${c.pinned})`).join(', ')}`);

if (dry) {
  note('dry run — nothing merged, nothing pinned');
  process.exit(0);
}

section('release');
const merged = gh(['pr', 'merge', String(found.pr.number), '--merge']);
if (!succeeded(merged)) {
  bad(`merge failed — ${(merged.stderr || '').split('\n')[0] || `exit ${merged.status}`}`);
  fix(`gh pr merge ${found.pr.number} --merge   # then re-run this script; it will find nothing to merge and continue`);
  process.exit(1);
}
ok(`merged release PR #${found.pr.number}`);

if (!(await waitForWorkflow())) {
  bad('the Release workflow did not complete successfully within 10 minutes');
  fix('gh run list --limit 3   # read the failing run, repair, then re-run this script');
  process.exit(1);
}
ok('Release workflow completed');

if (!(await waitForNpm(version))) {
  bad(`npm still does not serve ${version} after 5 minutes — the registry may be lagging`);
  fix(`npm view ${PKG} version   # once it answers ${version}, re-run with the pins: node scripts/deploy.mjs`);
  process.exit(1);
}
ok(`npm serves ${PKG}@${version}`);

const self = pullSelf();
if (self.ok) ok(`this checkout now reads ${declaredVersion(ROOT) || 'an unreadable version'}`);
else {
  bad(`this checkout was NOT fast-forwarded: ${self.reason}`);
  fix('git pull --ff-only origin main   # the release bumped package.json on origin, not here');
}

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
    // A host that cannot be reached is UNKNOWN, not converged and not broken —
    // and it does not fail the release that already published.
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
process.exit(failed);
