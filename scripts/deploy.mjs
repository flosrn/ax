#!/usr/bin/env node
// The release-propagation runbook, executable — first run performed by hand on
// 2026-08-26 (v0.12.3) and captured here so every later release is one command:
//
//   node scripts/deploy.mjs             # merge the release PR, wait for npm, pin every consumer
//   node scripts/deploy.mjs --dry-run   # print the plan and the discovered consumers, mutate nothing
//   node scripts/deploy.mjs --skip-pins # release to npm only; leave consumers where they are
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
// routinely. (6) Say out loud what this script does NOT reach: remote hosts.
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

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const skipPins = argv.includes('--skip-pins');
const rootsArg = argv.find((a) => a.startsWith('--roots='));
const roots = rootsArg ? rootsArg.slice('--roots='.length).split(',') : DEFAULT_ROOTS;
const unknown = argv.filter((a) => !['--dry-run', '--skip-pins'].includes(a) && !a.startsWith('--roots='));
if (unknown.length > 0) {
  bad(`unknown argument(s): ${unknown.join(' ')}`);
  fix('node scripts/deploy.mjs [--dry-run] [--skip-pins] [--roots=/a,/b]');
  process.exit(2);
}

const gh = (args) => run('gh', args, { cwd: ROOT, timeout: 60_000 });
const git = (cwd, args) => run('git', args, { cwd, timeout: 120_000 });
const succeeded = (out) => !out.error && out.status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

if (skipPins) {
  note('--skip-pins: consumers left as they are');
  process.exit(0);
}

section('consumers');
const verdicts = [];
for (const consumer of list) verdicts.push({ dir: consumer.dir, verdict: pinConsumer(consumer, version) });

section('summary');
let failed = 0;
for (const { dir, verdict } of verdicts) {
  note(`${dir}  ${verdict}`);
  if (verdict !== 'pinned' && verdict !== 'current') failed = 1;
}
note('NOT REACHED FROM HERE: remote hosts. The VPS fleet converges through the ops flow —');
note(`  ssh orca@vps, then \`ax pin ${version}\` in each consuming clone (gapihub owns the layout).`);
process.exit(failed);
