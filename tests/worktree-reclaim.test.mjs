// What `ax worktree reclaim` is allowed to destroy, and everything it must refuse first.
//
// The verb composes seams that already exist — the landed facts, the porcelain
// status, the pane count, `ax worktree clean`, Orca's own removal — so the cases
// here are not about those seams' internals. They are about the CONJUNCTION: a
// target is reclaimed only when every term holds, and a term that cannot be
// READ is a KEEP rather than a pass (F-028).
//
// Every case runs against a REAL temporary git repository with a real
// `git worktree add`, because the survivors are the only evidence that matters:
// what is still registered, still on disk and still readable after the verb ran.
// The host answers — Orca's receipts, `gh`, the project's declared cleanup
// command — are injected, so the whole file runs offline with no Orca session,
// no network and no bound port.
//
// The measured near-loss this exists to keep out (#204): a branch took a test
// commit AFTER its pull request merged at the head its Gate record validated.
// The tree was clean, the PR was MERGED, and the commit had not landed. That
// shape is `the #204 shape KEEPs` below, and it must never become a force flag.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { COMMANDS, subcommandNames } from '../src/commands.mjs';
import { run } from '../src/exec.mjs';
import { gitBlobSha } from '../src/hash.mjs';
import { readWorktrees } from '../src/git.mjs';
import { CREDENTIAL_GUARD_CONFIG, archiveScriptIn, cleanupStage, hookEnvironment, hookGuardEstablished, reclaim, reclaimRequestFor } from '../src/worktree/reclaim.mjs';
import { SUBCOMMANDS } from '../src/worktree/index.mjs';
import { attemptNew, claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const SLUG = 'flosrn/ax';

const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'ignore' });
const gitOut = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim();
const realGit = (at, args) => run('git', args, { cwd: at });

const file = (path, contents = 'x\n') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

const fixtures = [];
after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

/** Everything the verb told the human, on either stream, and its exit code. */
function capture(fn) {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('').replace(/\u001B\[\d+m/g, '') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** Every KEEP and every refusal owes a repair: a `✗` with no `→` under it is a finding nobody can act on. */
function assertRepair(out) {
  const lines = out.split('\n');
  const refusals = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes('✗'));
  assert.ok(refusals.length > 0, `no refusal line in:\n${out}`);
  for (const { index } of refusals) {
    const repair = lines.slice(index + 1).find(line => line.trim() !== '');
    assert.ok(repair !== undefined && repair.includes('→'), `refusal at line ${index} carries no repair:\n${out}`);
  }
}

/**
 * A primary checkout, one linked worktree that finished its slice, its Report,
 * the dispatch record that governs it and the Gate merge record that validated
 * the head it landed at. The eligible case, from which every KEEP below is one
 * mutation away.
 */
function stage({ name = 'slice', pr = 199, request = null } = {}) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ax-reclaim-')));
  fixtures.push(fixture);
  const main = join(fixture, 'main');

  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  file(join(main, 'ax.config.json'), `${JSON.stringify({ project: { name: 'demo' }, apps: { web: '.' } }, null, 2)}\n`);
  // `.scratch/` is gitignored in the real repository, which is the whole reason
  // the archive stage exists: a status read cannot see the Report, so nothing
  // but this verb stands between it and a deleted directory.
  file(join(main, '.gitignore'), '.scratch/\n');
  file(join(main, 'src', 'app.txt'));
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');

  const path = join(fixture, name);
  const branch = `feat/${name}`;
  git(main, 'worktree', 'add', '-q', '-b', branch, path);
  // The slice's own commits, so `git log main..branch` is NON-EMPTY on every
  // eligible case — the wave squash-merges, and a rule keyed on that range
  // refuses all of them forever.
  file(join(path, 'src', 'app.txt'), 'slice work\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-qm', 'slice work');
  const head = gitOut(path, 'rev-parse', 'HEAD');

  const id = request ?? name;
  const report = join(path, '.scratch', 'report', `${id}.md`);
  file(report, `# ${name}\n\n## CRITERIA\nproven\n`);

  const store = join(fixture, 'store');
  dispatchRecord({ store, request: id, worktrees: [path] });
  mergeRecord({ store, pr, sha: head });

  return { fixture, main, path, branch, head, request: id, report, store, pr };
}

/** The governing dispatch record: it names its worktree through the effect Orca reported. */
function dispatchRecord({ store, request, worktrees }) {
  const claim = claimRecord(store, request);
  initRecord(claim.path, { request, orca: 'orca', repo: SLUG, kind: 'implementation' });
  worktrees.forEach((worktree, index) => {
    if (index > 0) attemptNew(claim.path);
    phaseBegin(claim.path, { name: 'worker-start', identity: `id-${index}`, argv: ['orchestration', 'worker-start', '--task', `task_${index}`] });
    phaseEnd(claim.path, 'last', {
      exit: 0,
      receiptText: JSON.stringify({
        ok: true,
        result: { state: 'ready', dispatchId: `ctx_${index}`, agentTerminalHandle: `term_${index}`, effects: [{ kind: 'worktree', id: `repo::${worktree}` }] },
      }),
    });
  });
  return claim.path;
}

/** The Gate's own merge record — the authority for the head that actually landed. */
function mergeRecord({ store, pr, sha, exit = 0, slug = 'flosrn-ax' }) {
  const dir = join(store, 'merge');
  const request = `merge-${slug}-${pr}`;
  const claim = claimRecord(dir, request);
  initRecord(claim.path, { request, orca: 'gh' });
  phaseBegin(claim.path, {
    name: 'pr-merge',
    identity: 'm-1',
    argv: ['pr', 'merge', String(pr), '--repo', SLUG, '--squash', '--match-head-commit', sha],
  });
  phaseEnd(claim.path, 'last', { exit, receiptText: '' });
  return claim.path;
}

const receiptOf = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '', error: undefined, receipt: value });

/**
 * Every machine answer the verb reads, injected. Each knob below is one term of
 * the conjunction, so a case is the eligible world plus exactly one difference.
 */
function host(s, options = {}) {
  const {
    pinned = false,
    dropIsPinned = false,
    archived = false,
    terminals = [],
    siblings = [],
    children = [],
    prState = 'MERGED',
    prNumber = s.pr,
    prRows = null,
    mergeCommit = 'aa11bb22cc33',
    hookSettings = { mode: 'auto', setupRunPolicy: 'run-by-default', scripts: { setup: 'pnpm install', archive: '' }, commandSourcePolicy: 'local-only' },
    repoShow = 'ok',
    removal = { removed: true },
    cleanExit = 0,
    hookResult = null,
    gitOverride = null,
    beforeMutation = null,
    platform = 'darwin',
    hostScope = { hostIds: ['local'], omittedHostIds: [] },
    targetHost = 'local',
  } = options;

  const calls = { orca: [], gh: [], clean: [], hook: [] };
  let removed = false;

  const rowFor = (path, branch, extra = {}) => ({
    id: `repo::${path}`,
    identity: { key: `wt2:local:${gitBlobSha(path).slice(0, 8)}`, executionHostId: 'local' },
    path,
    head: existsSync(path) ? gitOut(path, 'rev-parse', 'HEAD') : s.head,
    branch: `refs/heads/${branch}`,
    isBare: false,
    isMainWorktree: path === s.main,
    isArchived: false,
    isPinned: false,
    workspaceStatus: 'in-progress',
    baseRef: 'refs/remotes/origin/main',
    parentWorktreeId: `repo::${s.main}`,
    childWorktreeIds: [],
    linkedPR: s.pr,
    ...extra,
  });

  const target = () => {
    const row = rowFor(s.path, s.branch, {
      isPinned: pinned,
      isArchived: archived,
      childWorktreeIds: children,
      hostId: targetHost,
      identity: { key: `wt2:${targetHost}:${gitBlobSha(s.path).slice(0, 8)}`, executionHostId: targetHost },
    });
    if (dropIsPinned) delete row.isPinned;
    return row;
  };

  const rows = () => [rowFor(s.main, 'main', { childWorktreeIds: [`repo::${s.path}`] }), ...(removed ? [] : [target()]), ...siblings];

  const runner = args => {
    calls.orca.push(args);
    const key = args.slice(0, 2).join(' ');
    if (key === 'status --json') return receiptOf({ ok: true, result: { runtime: { reachable: true } } });
    if (key === 'worktree show') {
      const selector = args[args.indexOf('--worktree') + 1];
      const row = rows().find(entry => selector === `path:${entry.path}`);
      if (row === undefined) {
        const answer = { ok: false, error: { code: 'worktree_not_found', message: `no worktree for ${selector}` } };
        return { status: 1, stdout: JSON.stringify(answer), stderr: '', error: undefined, receipt: answer };
      }
      return receiptOf({ ok: true, result: { worktree: row } });
    }
    if (key === 'worktree list') return receiptOf({ ok: true, result: { worktrees: rows() } });
    if (key === 'terminal list') {
      // The real receipt carries every pane of the queried scope, each naming
      // its own worktree — the shared reader filters, so the stub must not.
      const rowsForPanes = removed
        ? []
        : terminals.map(pane => ({ worktreeId: `repo::${s.path}`, worktreePath: s.path, orphaned: false, ...pane }));
      return receiptOf({ ok: true, result: { terminals: rowsForPanes, hostScope } });
    }
    if (key === 'repo show') {
      if (repoShow === 'refused') return { status: 1, stdout: '', stderr: 'runtime refused', error: undefined, receipt: {} };
      if (repoShow === 'no-repo') return receiptOf({ ok: true, result: {} });
      return receiptOf({ ok: true, result: { repo: { path: s.main, ...(hookSettings === null ? {} : { hookSettings }) } } });
    }
    if (key === 'worktree rm') {
      if (removal.unknown) return { status: null, stdout: '', stderr: '', error: new Error('etimedout'), receipt: {} };
      if (removal.refused) {
        const answer = { ok: false, error: { code: 'worktree_removal_failed', message: 'git refused to remove the worktree' } };
        return { status: 1, stdout: JSON.stringify(answer), stderr: '', error: undefined, receipt: answer };
      }
      execFileSync('git', [...IDENTITY, 'worktree', 'remove', '--force', s.path], { cwd: s.main, stdio: 'ignore' });
      removed = true;
      return receiptOf({
        ok: true,
        result: {
          removed: true,
          ...(removal.preservedBranch ? { preservedBranch: { branchName: s.branch } } : {}),
          ...(removal.warning ? { warning: removal.warning } : {}),
        },
      });
    }
    return { status: 1, stdout: '', stderr: `unexpected orca call: ${args.join(' ')}`, error: undefined, receipt: {} };
  };

  const gh = args => {
    calls.gh.push(args);
    const line = args.join(' ');
    if (line.startsWith('repo view')) return { status: 0, stdout: `${SLUG}\n`, stderr: '' };
    if (line.startsWith('pr list')) {
      return { status: 0, stdout: JSON.stringify(prRows ?? [{ number: prNumber, state: prState, headRefName: s.branch }]), stderr: '' };
    }
    if (line.startsWith('pr view')) {
      return {
        status: 0,
        stdout: JSON.stringify({ state: prState, mergeCommit: mergeCommit === null ? null : { oid: mergeCommit } }),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh call: ${line}` };
  };

  return {
    calls,
    deps: {
      cwd: s.main,
      env: { HOME: s.fixture, PATH: process.env.PATH ?? '' },
      platform,
      resolve: () => 'orca',
      runner,
      gh,
      git: (at, args) => {
        if (beforeMutation !== null && args[0] === 'status') beforeMutation();
        return gitOverride ? gitOverride(at, args) : realGit(at, args);
      },
      clean: argv => (calls.clean.push(argv), cleanExit),
      // The registry reader is a NAMED dependency: a suite that injects every
      // other probe must not leave the verb asking the host's own git.
      worktrees: at => readWorktrees(at),
      hook: opts => (calls.hook.push(opts), hookResult ?? { status: 0, stdout: '', stderr: '', error: undefined, timedOut: false }),
    },
  };
}

const registered = (main, path) => gitOut(main, 'worktree', 'list', '--porcelain').includes(`worktree ${path}`);

// ── the reclaimed case ───────────────────────────────────────────────────────

test('a landed, clean, unclaimed target is reclaimed from git and from Orca, with the branch outcome it produced', () => {
  const s = stage();
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.match(out, /RECLAIMED/);
  assert.equal(registered(s.main, s.path), false, `still registered:\n${out}`);
  assert.equal(existsSync(s.path), false);
  // The Orca view converged in the same operation, and the receipt says which
  // branch outcome the removal actually produced.
  assert.match(out, new RegExp(`branch ${s.branch.replace('/', '\\/')}`));
  assert.match(out, /deleted with the tree/);
  const rm = calls.orca.find(args => args.slice(0, 2).join(' ') === 'worktree rm');
  assert.deepEqual(rm, ['worktree', 'rm', '--worktree', `path:${s.path}`, '--json']);
});

test('a squash-merged branch whose commits are still ahead of the base is reclaimed', () => {
  const s = stage();
  // The shape of every one of the eleven #174 worktrees: the branch carries its
  // own commits over main because the pull request squashed.
  assert.notEqual(gitOut(s.path, 'rev-list', '--count', 'main..HEAD'), '0');
  const { deps } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.equal(registered(s.main, s.path), false);
});

test('the branch that git could not safely delete is reported as retained, not as deleted', () => {
  const s = stage();
  const { deps } = host(s, { removal: { removed: true, preservedBranch: true } });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.match(out, /branch .* retained/);
  assert.doesNotMatch(out, /deleted with the tree/);
});

// ── the landing terms ────────────────────────────────────────────────────────

test('the #204 shape KEEPs, naming the undelivered commit and delivery as its repair', () => {
  const s = stage();
  // A test commit lands on the branch AFTER the pull request merged at the head
  // the Gate record validated. Clean tree, merged PR, work that never landed.
  file(join(s.path, 'src', 'late.txt'), 'late\n');
  git(s.path, 'add', '-A');
  git(s.path, 'commit', '-qm', 'late test commit');
  const late = gitOut(s.path, 'rev-parse', 'HEAD');
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /KEEP/);
  assert.match(out, new RegExp(late.slice(0, 12)));
  assert.match(out, /late test commit/);
  assert.match(out, /pull request/i);
  assertRepair(out);
  // The repair is DELIVERY: no force flag is offered anywhere, and the only
  // mention of a stash is the refusal to substitute one for delivery.
  assert.doesNotMatch(out, /--force/);
  assert.match(out, /nothing here discards or stashes them/);
  assert.equal(registered(s.main, s.path), true);
  assert.deepEqual(calls.clean, []);
});

test('a target with no Gate merge record KEEPs naming the missing proof, even when the tracker head equals HEAD', () => {
  const s = stage();
  rmSync(join(s.store, 'merge'), { recursive: true, force: true });
  const { deps } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /merge-flosrn-ax-199/);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
});

test('a Gate record whose merge never concluded KEEPs rather than authorising the head it wrote', () => {
  const s = stage();
  rmSync(join(s.store, 'merge'), { recursive: true, force: true });
  mergeRecord({ store: s.store, pr: s.pr, sha: s.head, exit: 1 });
  const { deps } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
});

test('a MERGED pull request with no merge commit is a named inability, distinct from work still in flight', () => {
  const s = stage();
  const { deps } = host(s, { mergeCommit: null });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /merge commit/i);
  assert.doesNotMatch(out, /not landed yet/);
  assertRepair(out);
});

test('an open pull request KEEPs as work still in flight, and says so in those words', () => {
  const s = stage();
  const { deps } = host(s, { prState: 'OPEN' });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /not landed yet/);
  assertRepair(out);
});

test('two pull requests claiming one head KEEP rather than picking the one that proves it', () => {
  const s = stage();
  const { deps } = host(s, {
    prRows: [
      { number: 199, state: 'MERGED', headRefName: s.branch },
      { number: 210, state: 'MERGED', headRefName: s.branch },
    ],
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /#199/);
  assert.match(out, /#210/);
  assertRepair(out);
});

// ── the tree, the panes, the claims ─────────────────────────────────────────

test('a dirty tree KEEPs', () => {
  const s = stage();
  file(join(s.path, 'src', 'app.txt'), 'edited\n');
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /src\/app\.txt/);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('an untracked file alone KEEPs — a status read includes it, and nothing here forces past it', () => {
  const s = stage();
  file(join(s.path, 'notes.md'), 'a thought nobody has a second copy of\n');
  const { deps } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /notes\.md/);
  assertRepair(out);
});

test('an unreadable git status KEEPs with the missing fact named — never a clean verdict', () => {
  const s = stage();
  const { deps } = host(s, {
    gitOverride: (at, args) => (args[0] === 'status' ? { status: 128, stdout: '', stderr: 'fatal: not a git repository', error: undefined } : realGit(at, args)),
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /not a git repository/);
  assert.doesNotMatch(out, /RECLAIMED/);
  assertRepair(out);
});

test('a live pane in the target KEEPs, counted from panes while the row claims no live terminal', () => {
  const s = stage();
  const { deps, calls } = host(s, {
    // A pane that is NOT the released worker's, and a `liveTerminalCount` that
    // would read zero: this build does not emit that key, and a reader of it
    // reads `undefined` (#213). The count comes from the panes themselves.
    terminals: [{ handle: 'term_sibling', worktreePath: s.path, orphaned: false, liveTerminalCount: 0 }],
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /term_sibling/);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('a terminal list that refuses or truncates KEEPs — an absent list is not an empty machine', () => {
  const s = stage();
  const { deps } = host(s);
  const inner = deps.runner;
  deps.runner = args =>
    args.slice(0, 2).join(' ') === 'terminal list'
      ? receiptOf({ ok: true, result: { terminals: [], truncated: true, hostScope: { hostIds: ['local'], omittedHostIds: [] } } })
      : inner(args);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /truncated/i);
  assertRepair(out);
});

test('a git-locked worktree KEEPs, quoting the reason the lock carries', () => {
  const s = stage();
  git(s.main, 'worktree', 'lock', '--reason', 'holding this for the release audit', s.path);
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /holding this for the release audit/);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('an Orca-pinned worktree KEEPs naming the pin', () => {
  const s = stage();
  const { deps } = host(s, { pinned: true });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /pinned/i);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
});

test('a receipt that cannot answer the pin state KEEPs naming the unread field', () => {
  const s = stage();
  const { deps } = host(s, { dropIsPinned: true });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /isPinned/);
  assertRepair(out);
});

test('a landed target whose branch another worktree is based on KEEPs, naming the keep-branch operation Orca does not offer', () => {
  const s = stage();
  const dependent = join(s.fixture, 'dependent');
  const { deps, calls } = host(s, {
    siblings: [
      {
        id: `repo::${dependent}`,
        path: dependent,
        head: s.head,
        branch: 'refs/heads/feat/dependent',
        isBare: false,
        isMainWorktree: false,
        isArchived: false,
        isPinned: false,
        workspaceStatus: 'in-progress',
        baseRef: `refs/heads/${s.branch}`,
        parentWorktreeId: `repo::${s.path}`,
        childWorktreeIds: [],
        linkedPR: null,
      },
    ],
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  // The claim is named by the workspace that holds it — the path an operator acts on.
  assert.match(out, new RegExp(dependent.replace(/[/\\]/g, '\\$&')));
  assert.match(out, /keep-branch|keep the branch/i);
  assertRepair(out);
  // Nothing is released, signalled, stopped, deleted or written for it.
  assert.deepEqual(calls.clean, []);
  assert.deepEqual(calls.hook, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.equal(existsSync(join(s.main, '.scratch', 'reclaim')), false);
  assert.equal(registered(s.main, s.path), true);
});

test('a worktree with a dependent lineage child KEEPs', () => {
  const s = stage();
  const { deps } = host(s, { children: [`repo::${join(s.fixture, 'grandchild')}`] });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /grandchild/);
  assertRepair(out);
});

// ── the targets it may not be pointed at ────────────────────────────────────

test('the primary checkout, an unregistered path and an ambiguous bare name are each refused, and nothing is mutated', () => {
  const s = stage();
  const { deps, calls } = host(s);

  const primary = capture(() => reclaim([s.main, '--store', s.store], deps));
  assert.equal(primary.code, 1, primary.out);
  assert.match(primary.out, /primary checkout/);
  assertRepair(primary.out);

  const stranger = capture(() => reclaim([join(s.fixture, 'nowhere'), '--store', s.store], deps));
  assert.equal(stranger.code, 1, stranger.out);
  assert.match(stranger.out, /not a registered worktree/);
  assertRepair(stranger.out);

  // Two registered worktrees sharing a basename: the name is refused WITH its
  // candidates rather than resolved by position.
  const twin = join(s.fixture, 'twin', 'slice');
  git(s.main, 'worktree', 'add', '-q', '-b', 'feat/twin', twin);
  const ambiguous = capture(() => reclaim(['slice', '--store', s.store], deps));
  assert.equal(ambiguous.code, 1, ambiguous.out);
  assert.match(ambiguous.out, new RegExp(s.path.replace(/[/\\]/g, '\\$&')));
  assert.match(ambiguous.out, new RegExp(twin.replace(/[/\\]/g, '\\$&')));
  assertRepair(ambiguous.out);

  assert.deepEqual(calls.clean, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.equal(registered(s.main, s.path), true);
  assert.equal(existsSync(s.main), true);
});

test("the caller's own tree is refused from inside it", () => {
  const s = stage();
  const { deps } = host(s);
  deps.cwd = s.path;

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /from outside/);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
});

test('--force is not a flag this verb accepts', () => {
  const s = stage();
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--force', '--store', s.store], deps));

  assert.equal(code, 2, out);
  assert.match(out, /--force/);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('no target is a usage error, not a sweep', () => {
  const s = stage();
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim(['--store', s.store], deps));

  assert.equal(code, 2, out);
  assert.deepEqual(calls.orca.filter(args => args.slice(0, 2).join(' ') === 'worktree rm'), []);
  assert.equal(registered(s.main, s.path), true);
});

// ── evidence ────────────────────────────────────────────────────────────────

test('the Report is archived outside the worktree, byte-identical, and its reference is readable after the tree is gone', () => {
  const s = stage();
  const original = readFileSync(s.report);
  const { deps } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.equal(existsSync(s.path), false);
  const archives = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else archives.push(full);
    }
  };
  walk(join(s.main, '.scratch', 'reclaim'));
  const copy = archives.find(path => path.endsWith(`${s.request}.md`));
  assert.ok(copy !== undefined, `no archived Report among ${archives.join(', ')}`);
  assert.deepEqual(readFileSync(copy), original);
  // The reference stays discoverable: it names the source it came from and the
  // digest that proves the copy.
  const reference = archives.find(path => path.endsWith('reference.json'));
  assert.ok(reference !== undefined, `no archive reference among ${archives.join(', ')}`);
  const record = JSON.parse(readFileSync(reference, 'utf8'));
  assert.equal(record.worktree, s.path);
  assert.equal(record.files.length, 1);
  assert.equal(record.files[0].source, s.report);
  assert.equal(record.files[0].archive, copy);
  assert.match(record.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(out, new RegExp(copy.replace(/[/\\]/g, '\\$&')));
});

test('two worktrees of one request produce two distinct preserved Reports, never one flattened file', () => {
  const s = stage();
  // The second attempt of one request, placed in another worktree: both hold a
  // Report whose file name is the request's, so a flat archive would overwrite.
  const second = join(s.fixture, 'replacement');
  git(s.main, 'worktree', 'add', '-q', '-b', 'feat/replacement', second);
  file(join(second, 'src', 'app.txt'), 'second attempt\n');
  git(second, 'add', '-A');
  git(second, 'commit', '-qm', 'second attempt');
  const secondReport = join(second, '.scratch', 'report', `${s.request}.md`);
  file(secondReport, '# the replacement attempt\n');
  rmSync(join(s.store, `${s.request}.json`));
  dispatchRecord({ store: s.store, request: s.request, worktrees: [s.path, second] });

  const first = host(s);
  const one = capture(() => reclaim([s.path, '--store', s.store], first.deps));
  assert.equal(one.code, 0, one.out);

  const twin = { ...s, path: second, branch: 'feat/replacement', head: gitOut(second, 'rev-parse', 'HEAD'), report: secondReport, pr: 210 };
  mergeRecord({ store: s.store, pr: 210, sha: twin.head });
  const other = host(twin, { prNumber: 210 });
  const two = capture(() => reclaim([second, '--store', s.store], other.deps));
  assert.equal(two.code, 0, two.out);

  const copies = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === `${s.request}.md`) copies.push(full);
    }
  };
  walk(join(s.main, '.scratch', 'reclaim'));
  assert.equal(copies.length, 2, `expected two preserved Reports, got ${copies.join(', ')}`);
  // Order-independent: both bodies survived, neither overwrote the other.
  const bodies = copies.map(path => readFileSync(path, 'utf8'));
  assert.equal(bodies.filter(body => /replacement attempt/.test(body)).length, 1, bodies.join(' | '));
  assert.equal(bodies.filter(body => /## CRITERIA/.test(body)).length, 1, bodies.join(' | '));
});

test('a required Report that is missing KEEPs naming the failed step, and no force overrides it', () => {
  const s = stage();
  rmSync(s.report);
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, new RegExp(s.report.replace(/[/\\]/g, '\\$&')));
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
});

test('scratch content no governing record accounts for KEEPs rather than being copied or deleted', () => {
  const s = stage();
  file(join(s.path, '.scratch', 'notes', 'thinking.md'), 'the only copy of something a human wrote\n');
  const { deps } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /thinking\.md/);
  assertRepair(out);
  assert.equal(existsSync(join(s.path, '.scratch', 'notes', 'thinking.md')), true);
});

test('an existing archive whose bytes differ from the source KEEPs instead of overwriting it', () => {
  const s = stage();
  // A prior run archived this Report and then refused at the removal; the
  // source has since been rewritten under the same name.
  const first = host(s, { removal: { refused: true } });
  const one = capture(() => reclaim([s.path, '--store', s.store], first.deps));
  assert.equal(one.code, 1, one.out);
  file(s.report, '# a different Report under the same name\n');

  const { deps } = host(s);
  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /differ/i);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
});

test('a second run after an interrupted one neither duplicates the archive nor destroys it, and re-runs no settled cleanup', () => {
  const s = stage();
  const first = host(s, { removal: { refused: true } });
  const one = capture(() => reclaim([s.path, '--store', s.store], first.deps));
  assert.equal(one.code, 1, one.out);
  assert.equal(first.calls.clean.length, 1, one.out);
  const before = readdirSync(join(s.main, '.scratch', 'reclaim'), { recursive: true }).map(String).sort();
  const bytes = readFileSync(s.report);

  const { deps, calls } = host(s);
  const two = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(two.code, 0, two.out);
  // The cleanup stage is settled, so it is not run a second time.
  assert.deepEqual(calls.clean, []);
  const after = readdirSync(join(s.main, '.scratch', 'reclaim'), { recursive: true }).map(String).sort();
  assert.deepEqual(after, before);
  const copy = after.map(entry => join(s.main, '.scratch', 'reclaim', entry)).find(path => path.endsWith(`${s.request}.md`));
  assert.deepEqual(readFileSync(copy), bytes);
});

// ── ordering, boundaries and re-entry ───────────────────────────────────────

test('a preflight KEEP signals nothing, writes no archive and issues no removal', () => {
  const s = stage();
  file(join(s.path, 'src', 'app.txt'), 'edited\n');
  const { deps, calls } = host(s);

  const { code } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1);
  assert.deepEqual(calls.clean, []);
  assert.deepEqual(calls.hook, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.equal(existsSync(join(s.main, '.scratch', 'reclaim')), false);
  assert.equal(existsSync(join(s.store, 'reclaim')), false);
});

test('a removal that fails after the cleanup ran retains the tree and reports the partial effects, never "nothing happened"', () => {
  const s = stage();
  const { deps, calls } = host(s, { removal: { refused: true } });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.equal(calls.clean.length, 1, out);
  assert.match(out, /already ran|partial/i);
  assert.match(out, /git refused to remove the worktree/);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
  // The verified archive of a run that later refused stays preserved.
  assert.equal(existsSync(join(s.main, '.scratch', 'reclaim')), true);
});

test('state that changes between the checks and the mutation is caught at the mutation boundary', () => {
  const s = stage();
  let armed = false;
  const { deps, calls } = host(s, {
    beforeMutation: () => {
      // The second status read is the one at the boundary: a sibling session
      // writes into the tree while the eligibility checks are being made.
      if (armed) file(join(s.path, 'src', 'app.txt'), 'a sibling just wrote this\n');
      armed = true;
    },
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /changed/i);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('re-entry after a removal nobody observed replays the recorded identity, mints no second one and claims no removal', () => {
  const s = stage();
  const stranded = host(s, { removal: { unknown: true } });
  const one = capture(() => reclaim([s.path, '--store', s.store], stranded.deps));
  assert.equal(one.code, 1, one.out);
  assert.match(one.out, /STRANDED|nobody knows|never concluded/i);
  // The identity carries the TARGET, not just its basename — two worktrees of
  // one repository may share a name and must never share a record.
  const recordPath = join(s.store, 'reclaim', `${reclaimRequest(s)}.json`);
  assert.equal(existsSync(recordPath), true, `no reclaim record at ${recordPath}`);
  const first = JSON.parse(readFileSync(recordPath, 'utf8'));
  const identities = phasesIn(first).map(phase => phase.identity);

  const { deps, calls } = host(s);
  const two = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(two.code, 1, two.out);
  assert.match(two.out, new RegExp(recordPath.replace(/[/\\]/g, '\\$&')));
  const second = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.deepEqual(phasesIn(second).map(phase => phase.identity), identities);
  // It re-creates no worktree, re-runs no cleanup and claims no removal it did not see.
  assert.deepEqual(calls.clean, []);
  assert.doesNotMatch(two.out, /RECLAIMED/);
  assert.equal(registered(s.main, s.path), true);
  assertRepair(two.out);
});

const phasesIn = record => record.attempts.flatMap(attempt => attempt.phases);

test('re-entry after a removal that DID land reports the removal this host observed, and re-creates nothing', () => {
  const s = stage();
  const { deps } = host(s);
  const one = capture(() => reclaim([s.path, '--store', s.store], deps));
  assert.equal(one.code, 0, one.out);

  const again = host(s);
  const two = capture(() => reclaim([s.path, '--store', s.store], again.deps));

  // The tree is gone, and that reads as the removal this host recorded — never
  // as a target to go and re-create, and never as a fresh removal to claim.
  assert.equal(two.code, 0, two.out);
  assert.match(two.out, /already reclaimed/i);
  assert.equal(existsSync(s.path), false);
  assert.equal(again.calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.deepEqual(again.calls.clean, []);
});

// ── the cleanup stage's owner ───────────────────────────────────────────────

test('a declared archive command owns the cleanup stage and runs exactly once, with ax clean never beside it', () => {
  const s = stage();
  const marker = join(s.fixture, 'invocations.log');
  const { deps, calls } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
  });
  file(join(s.main, 'orca.yaml'), `scripts:\n  archive: |\n    printf 'ran\\n' >> ${marker}\n`);
  // The probe is the command's own append-only marker, executed for real.
  deps.hook = opts => (calls.hook.push(opts), run('/bin/bash', ['-c', opts.command], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs }));

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.equal(readFileSync(marker, 'utf8'), 'ran\n');
  assert.deepEqual(calls.clean, []);
  assert.equal(calls.hook.length, 1);
  // The environment contract the hook expects, reproduced rather than guessed.
  assert.equal(calls.hook[0].cwd, s.path);
  assert.equal(calls.hook[0].env.ORCA_WORKTREE_PATH, s.path);
  assert.equal(calls.hook[0].env.ORCA_ROOT_PATH, s.main);
  assert.equal(calls.hook[0].env.ORCA_WORKSPACE_NAME, 'slice');
  assert.equal(calls.hook[0].timeoutMs, 120000);
  assert.match(out, /orca\.yaml/);
});

test('a local Settings archive command wins under the local-only policy, and a shared one under shared-only', () => {
  const s = stage();
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: echo shared\n');
  const local = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: 'echo local' }, commandSourcePolicy: 'local-only' },
  });
  const one = capture(() => reclaim([s.path, '--store', s.store], local.deps));
  assert.equal(one.code, 0, one.out);
  assert.equal(local.calls.hook.length, 1);
  assert.equal(local.calls.hook[0].command, 'echo local');
});

test('with no declaration the cleanup stage is ax worktree clean, invoked once and named as the stage owner', () => {
  const s = stage();
  const { deps, calls } = host(s);

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.deepEqual(calls.clean, [[s.path]]);
  assert.deepEqual(calls.hook, []);
  assert.match(out, /ax worktree clean/);
});

test('a declaration read that fails is unknown rather than absent, and unknown KEEPs', () => {
  const s = stage();
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: &anchor\n    - not a scalar\n');
  const { deps, calls } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /orca\.yaml/);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.deepEqual(calls.hook, []);
});

test('a repo receipt that cannot answer the hook settings KEEPs rather than falling back to ax clean', () => {
  const s = stage();
  const { deps, calls } = host(s, { repoShow: 'refused' });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
});

test('the removal issued after a successful cleanup stage carries no repo-hook flag', () => {
  const s = stage();
  const { deps, calls } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
  });
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: echo archived\n');

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.equal(calls.hook.length, 1);
  const rm = calls.orca.find(args => args.slice(0, 2).join(' ') === 'worktree rm');
  assert.equal(rm.includes('--run-hooks'), false, `removal argv re-ran the repo hooks: ${rm.join(' ')}`);
});

test('a declared cleanup command that exits non-zero KEEPs with its stage, exit and output, and no removal is attempted', () => {
  const s = stage();
  const { deps, calls } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
    hookResult: { status: 3, stdout: 'stopping the stack\n', stderr: 'supabase stop failed\n', error: undefined, timedOut: false },
  });
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: bash scripts/archive.sh\n');

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /exit 3/);
  assert.match(out, /supabase stop failed/);
  assertRepair(out);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.equal(registered(s.main, s.path), true);
});

test('a declared cleanup command that cannot be launched KEEPs', () => {
  const s = stage();
  const { deps, calls } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
    hookResult: { status: null, stdout: '', stderr: '', error: new Error('spawn /bin/bash ENOENT'), timedOut: false },
  });
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: bash scripts/archive.sh\n');

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /ENOENT/);
  assertRepair(out);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
});

test('a declared cleanup command that warns and exits zero is reported as the project reported it', () => {
  const s = stage();
  const { deps } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
    hookResult: { status: 0, stdout: 'warn: portless prune overran its budget\n', stderr: '', error: undefined, timedOut: false },
  });
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: bash scripts/archive.sh\n');

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  // Neither upgraded to a proven-complete reclamation nor turned into a failure.
  assert.match(out, /portless prune overran its budget/);
  assert.match(out, /reported success/);
  assert.doesNotMatch(out, /every resource/);
});
// ── review round 2: five destructive-safety regressions ─────────────────────

test('two same-basename targets never share a reclaim record, and neither borrows the other’s settled stages', () => {
  // P1. `reclaim-<owner>-<repo>-<basename>` collided: /a/slice and /b/slice are
  // one key, so the second target adopted the first's record and could read
  // ALREADY RECLAIMED — or skip a cleanup — from work done on another tree.
  const s = stage();
  const twinDir = join(s.fixture, 'b');
  mkdirSync(twinDir, { recursive: true });
  const twin = join(twinDir, basename(s.path));
  git(s.main, 'worktree', 'add', '-q', '-b', 'feat/twin-slice', twin);
  file(join(twin, 'src', 'app.txt'), 'twin work\n');
  git(twin, 'add', '-A');
  git(twin, 'commit', '-qm', 'twin work');
  const twinHead = gitOut(twin, 'rev-parse', 'HEAD');
  file(join(twin, '.scratch', 'report', 'twin.md'), '# twin\n');
  dispatchRecord({ store: s.store, request: 'twin', worktrees: [twin] });
  mergeRecord({ store: s.store, pr: 300, sha: twinHead });

  const first = host(s);
  const one = capture(() => reclaim([s.path, '--store', s.store], first.deps));
  assert.equal(one.code, 0, one.out);

  const twinStage = { ...s, path: twin, branch: 'feat/twin-slice', head: twinHead, request: 'twin', report: join(twin, '.scratch', 'report', 'twin.md'), pr: 300 };
  const second = host(twinStage, { prNumber: 300 });
  const two = capture(() => reclaim([twin, '--store', s.store], second.deps));

  // The second target does its OWN work: it is not reported as already
  // reclaimed, and its cleanup stage runs rather than being read as settled.
  assert.equal(two.code, 0, two.out);
  assert.doesNotMatch(two.out, /already reclaimed/i);
  assert.deepEqual(second.calls.clean, [[twin]], two.out);
  const records = readdirSync(join(s.store, 'reclaim')).sort();
  assert.equal(records.length, 2, `one record served two targets: ${records.join(', ')}`);
});

test('a reclaim record naming another target is never adopted for this one', () => {
  const s = stage();
  const { deps } = host(s);
  // A record sitting at this target's key that names a different tree: adopting
  // its stages would let one tree's settled cleanup authorise another's removal.
  const dir = join(s.store, 'reclaim');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${reclaimRequest(s)}.json`),
    `${JSON.stringify({
      request: reclaimRequest(s),
      host: 'somewhere-else',
      orca: 'orca',
      repo: 'someone/else',
      createdAt: new Date().toISOString(),
      attempts: [{ n: 1, settled: false, phases: [{ name: 'worktree-rm', identity: 'x', argv: ['worktree', 'rm', '--worktree', 'path:/elsewhere/slice', '--json'], receipt: { ok: true, result: { removed: true } }, exit: 0, beganAt: new Date().toISOString() }] }],
    }, null, 1)}\n`,
  );

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /another target|another repository|another host/i);
  assertRepair(out);
  assert.equal(registered(s.main, s.path), true);
});

const reclaimRequest = s => reclaimRequestFor({ owner: 'flosrn', repoName: 'ax', path: s.path });

test('a PARTIAL reclaim record proves nothing and is never consumed, however little it contradicts', () => {
  // The gap review round 2 named: "absence is not a mismatch" was weaker than a
  // positive identity. This record contradicts NOTHING — its request matches the
  // filename and it names no repository, no host and no target — yet it carries a
  // settled cleanup stage. Adopting it would decide that a cleanup need not run.
  // There is no legacy to accommodate: `initRecord` writes request, repo and host
  // on the first write of every record of this kind.
  const s = stage();
  const dir = join(s.store, 'reclaim');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${reclaimRequest(s)}.json`),
    `${JSON.stringify({
      request: reclaimRequest(s),
      orca: 'orca',
      createdAt: new Date().toISOString(),
      attempts: [{ n: 1, settled: false, phases: [{ name: 'cleanup-ax-clean', identity: 'p', argv: ['ax', 'worktree', 'clean'], receipt: {}, exit: 0, beganAt: new Date().toISOString() }] }],
    }, null, 1)}\n`,
  );

  const { deps, calls } = host(s);
  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /names no repository|names no host|names no worktree/i);
  assertRepair(out);
  // No stage of it was trusted and nothing destructive was issued.
  assert.deepEqual(calls.clean, []);
  assert.deepEqual(calls.hook, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.equal(registered(s.main, s.path), true);
  assert.doesNotMatch(out, /already reclaimed/i);
});

test('a record whose stages name no worktree cannot attribute them to this target', () => {
  const s = stage();
  const dir = join(s.store, 'reclaim');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${reclaimRequest(s)}.json`),
    `${JSON.stringify({
      request: reclaimRequest(s),
      repo: SLUG,
      host: hostname(),
      orca: 'orca',
      createdAt: new Date().toISOString(),
      attempts: [{ n: 1, settled: false, phases: [{ name: 'worktree-rm', identity: 'p', argv: ['worktree', 'rm', '--json'], receipt: { ok: true, result: { removed: true } }, exit: 0, beganAt: new Date().toISOString() }] }],
    }, null, 1)}\n`,
  );

  const { deps, calls } = host(s);
  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /names no worktree/i);
  assert.doesNotMatch(out, /already reclaimed/i);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('a keep-chomping block header is deliberately refused, not accidentally dropped', () => {
  // `|+` keeps trailing newlines, which this reader's join would silently drop —
  // so it is refused rather than folded into a command that differs from what
  // the project wrote. Named here so the choice cannot be mistaken for an
  // oversight alongside the digit variants.
  assert.equal('unknown' in archiveScriptIn('scripts:\n  archive: |+\n    echo one\n'), true);
  assert.equal('unknown' in archiveScriptIn('scripts:\n  archive: >+\n    echo one\n'), true);
});

test('an empty pane list whose scope omits the target’s own host authorizes nothing', () => {
  // P1. `terminals: []` is only a real zero when the host that owns the target
  // was actually queried. An omitted scope made an unread machine look empty.
  const s = stage();
  const { deps, calls } = host(s, { hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:7930a317'] }, targetHost: 'runtime:7930a317' });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /runtime:7930a317/);
  assertRepair(out);
  assert.deepEqual(calls.clean, []);
  assert.equal(registered(s.main, s.path), true);
});

test('an unrelated omitted host does not refuse a target whose own host was queried', () => {
  // The other direction: a sleeping remote runtime must not make a local
  // worktree unreclaimable — that is the #83 cost, paid again.
  const s = stage();
  const { deps } = host(s, { hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:unrelated'] }, targetHost: 'local' });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
});

test('an unknown block-scalar header fails closed and is never run as a command', () => {
  // P1. `>+` fell through to the plain-scalar branch, so the archive command
  // became the literal string '>+', which bash exits 0 on — the worktree was
  // deleted with no cleanup having run at all.
  for (const header of ['>+', '|2', '>-2', '|+2', '>3', '|~', '>>']) {
    const read = archiveScriptIn(`scripts:\n  archive: ${header}\n    echo one\n`);
    assert.equal(read.archive, undefined, `${header} produced a command: ${JSON.stringify(read.archive)}`);
    assert.equal('unknown' in read, true, `${header} was not refused`);
  }
  // The folded and chomped forms this reader DOES read keep working.
  assert.deepEqual(archiveScriptIn('scripts:\n  archive: |\n    echo one\n    echo two\n'), { archive: 'echo one\necho two' });
  assert.deepEqual(archiveScriptIn('scripts:\n  archive: |-\n    echo one\n'), { archive: 'echo one' });
  assert.deepEqual(archiveScriptIn('scripts:\n  archive: >\n    echo one\n    echo two\n'), { archive: 'echo one echo two' });
  // A plain scalar can never begin with a block indicator.
  for (const value of ['>+ echo one', '| echo two']) {
    assert.equal('unknown' in archiveScriptIn(`scripts:\n  archive: ${value}\n`), true, `${value} was read as a command`);
  }
});

test('a declared chain is never composed from an unreadable block header', () => {
  const s = stage();
  const { deps, calls } = host(s, {
    hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' },
  });
  file(join(s.main, 'orca.yaml'), 'scripts:\n  archive: >+\n    bash scripts/archive.sh\n');

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.deepEqual(calls.hook, [], 'a literal block header was executed');
  assert.deepEqual(calls.clean, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
  assert.equal(registered(s.main, s.path), true);
  assertRepair(out);
});

test('an unreadable archive reference KEEPs and preserves the mappings it could not parse', () => {
  // P2. A malformed reference.json was reset to `{files:[]}` and rewritten,
  // destroying the source→archive mappings of every earlier run.
  const s = stage();
  const first = host(s, { removal: { refused: true } });
  const one = capture(() => reclaim([s.path, '--store', s.store], first.deps));
  assert.equal(one.code, 1, one.out);

  const reference = readdirSync(join(s.main, '.scratch', 'reclaim'), { recursive: true })
    .map(String)
    .filter(entry => entry.endsWith('reference.json'))
    .map(entry => join(s.main, '.scratch', 'reclaim', entry))[0];
  assert.ok(reference !== undefined, 'no reference was written by the first run');
  // An interrupted write: valid JSON prefix, truncated mid-object.
  const whole = readFileSync(reference, 'utf8');
  writeFileSync(reference, whole.slice(0, Math.floor(whole.length / 2)));
  const damaged = readFileSync(reference, 'utf8');

  const { deps, calls } = host(s);
  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /reference/i);
  assertRepair(out);
  // The bytes it could not read are still there, untouched.
  assert.equal(readFileSync(reference, 'utf8'), damaged);
  assert.deepEqual(calls.clean, []);
  assert.equal(calls.orca.some(args => args.slice(0, 2).join(' ') === 'worktree rm'), false);
});

test('an absent archive reference is not an unreadable one', () => {
  const s = stage();
  const { deps } = host(s);
  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /reference.*could not/i);
});

test('every registry read goes through the injected reader, at all three boundaries', () => {
  // P1. Two of the three reads called `readWorktrees` directly, so a suite that
  // injected every other probe still let the verb ask the HOST's git — and a
  // registry that changed or refused mid-run was never observed.
  const s = stage();
  for (const failAt of [1, 2, 3]) {
    const { deps, calls } = host(s);
    let seen = 0;
    const real = deps.worktrees;
    assert.equal(typeof real, 'function', 'the registry reader is not an injected dependency');
    deps.worktrees = at => {
      seen += 1;
      return seen === failAt ? { known: false, trees: [] } : real(at);
    };

    const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

    assert.notEqual(code, 0, `boundary ${failAt} was not observed: ${out}`);
    assert.equal(seen >= failAt, true, `boundary ${failAt} was never reached (${seen} reads)`);
    if (failAt < 3) assert.deepEqual(calls.clean, [], `boundary ${failAt} refused after cleanup ran`);
  }
});
// ── the execution boundary a declared chain runs under ──────────────────────

test('the hook environment carries Orca’s whole credential guard, appended without clobbering a caller’s own config', () => {
  // The two option identifiers are extracted from Orca's helper into the module
  // (`scripts/extract-hook-guard-keys.mjs`), so this suite asserts the SHAPE and
  // the protocol rather than spelling them: an equivalence run against Orca's own
  // helper belongs to a throwaway comparison, never to a suite that must pass
  // offline on a machine with no Orca checkout.
  assert.equal(hookGuardEstablished(), true, 'the guard identifiers were never extracted into this checkout');
  assert.equal(CREDENTIAL_GUARD_CONFIG.length, 2);
  for (const [key, value] of CREDENTIAL_GUARD_CONFIG) {
    assert.match(key, /^credential\.[A-Za-z][A-Za-z0-9.-]*$/, 'a guard entry is not a git option identifier');
    assert.equal(value, 'false');
  }

  const clean = hookEnvironment({ env: { PATH: '/usr/bin' }, main: '/main', worktree: '/tree/slice' });
  assert.equal(clean.GIT_TERMINAL_PROMPT, '0');
  assert.equal(clean.GCM_INTERACTIVE, 'never');
  assert.equal(clean.GIT_ASKPASS, '');
  assert.equal(clean.SSH_ASKPASS, '');
  assert.equal(clean.ORCA_WORKTREE_PATH, '/tree/slice');
  assert.equal(clean.GIT_CONFIG_COUNT, '2');
  assert.equal(clean.GIT_CONFIG_KEY_0, CREDENTIAL_GUARD_CONFIG[0][0]);
  assert.equal(clean.GIT_CONFIG_VALUE_1, 'false');

  // A caller's askpass is PRESERVED, never emptied.
  const mine = hookEnvironment({ env: { GIT_ASKPASS: '/opt/askpass', SSH_ASKPASS: '/opt/ssh' }, main: '/main', worktree: '/tree/slice' });
  assert.equal(mine.GIT_ASKPASS, '/opt/askpass');
  assert.equal(mine.SSH_ASKPASS, '/opt/ssh');

  // A caller's own indexed config survives, and the guard appends after it.
  const shared = hookEnvironment({
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' },
    main: '/main',
    worktree: '/tree/slice',
  });
  assert.equal(shared.GIT_CONFIG_KEY_0, 'core.pager');
  assert.equal(shared.GIT_CONFIG_VALUE_0, 'cat');
  assert.equal(shared.GIT_CONFIG_COUNT, '3');
  assert.equal(shared.GIT_CONFIG_KEY_1, CREDENTIAL_GUARD_CONFIG[0][0]);

  // An AMBIGUOUS protocol is never appended into: the caller's data may sit at
  // any index, so the guard is skipped rather than overwriting it.
  for (const broken of [
    { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'x', GIT_CONFIG_KEY_7: 'c.d', GIT_CONFIG_VALUE_7: 'y' },
    { GIT_CONFIG_COUNT: 'many' },
  ]) {
    const out = hookEnvironment({ env: { ...broken }, main: '/main', worktree: '/tree/slice' });
    assert.deepEqual(out.GIT_CONFIG_COUNT, broken.GIT_CONFIG_COUNT, 'an ambiguous protocol was rewritten');
    assert.equal(out.GIT_CONFIG_KEY_1, broken.GIT_CONFIG_KEY_1, 'the guard appended into an ambiguous protocol');
    // The scalar guards still apply — they are not part of the protocol.
    assert.equal(out.GIT_TERMINAL_PROMPT, '0');
  }
});

test('a placeholder guard identifier authorises nothing', () => {
  // What an unextracted clone carries. `hookGuardEstablished` is the predicate
  // the cleanup stage refuses on, so a weaker boundary can never run a
  // project's chain silently.
  assert.equal(hookGuardEstablished([['__GUARD_KEY_0__', 'false'], ['__GUARD_KEY_1__', 'false']]), false);
  assert.equal(hookGuardEstablished([['credential.one', 'false']]), false, 'a one-entry guard is not the guard');
  assert.equal(hookGuardEstablished([]), false);
});

test('the primary checkout carrying no baseRef is not an unread branch claim', () => {
  // Measured on the real repository: the main worktree's row omits `baseRef`
  // entirely, and reading that as unknown refused every target forever.
  const s = stage();
  const { deps } = host(s);
  const inner = deps.runner;
  deps.runner = args => {
    const out = inner(args);
    if (args.slice(0, 2).join(' ') !== 'worktree list') return out;
    const rows = out.receipt.result.worktrees.map(row => {
      if (row.path !== s.main) return row;
      const bare = { ...row, isMainWorktree: true };
      delete bare.baseRef;
      return bare;
    });
    return receiptOf({ ok: true, result: { worktrees: rows } });
  };

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /baseRef/);
});

test('a linked workspace that cannot answer its baseRef is still an unread claim', () => {
  const s = stage();
  const sibling = join(s.fixture, 'sibling');
  const { deps } = host(s, {
    siblings: [{ id: `repo::${sibling}`, path: sibling, head: s.head, branch: 'refs/heads/feat/sibling', isBare: false, isMainWorktree: false, isArchived: false, isPinned: false, workspaceStatus: 'in-progress', parentWorktreeId: `repo::${s.main}`, childWorktreeIds: [], linkedPR: null }],
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  assert.match(out, /baseRef/);
  assert.match(out, new RegExp(sibling.replace(/[/\\]/g, '\\$&')));
  assertRepair(out);
});

test('the live-pane KEEP names per-handle closes, never a bulk sweep of the worktree', () => {
  const s = stage();
  const { deps } = host(s, {
    terminals: [
      { handle: 'term_shell', worktreePath: s.path, orphaned: false },
      { handle: 'term_setup', title: 'Setup', worktreePath: s.path, orphaned: false },
    ],
  });

  const { code, out } = capture(() => reclaim([s.path, '--store', s.store], deps));

  assert.equal(code, 1, out);
  // Inspection first, then the exact handles — and never `--all`, which would
  // sweep a shell somebody opened after this line was printed.
  assert.match(out, /orca terminal show --terminal term_shell/);
  assert.match(out, /orca terminal close --terminal term_shell --json/);
  assert.match(out, /orca terminal close --terminal term_setup --json/);
  assert.doesNotMatch(out, /--all/);
});

// ── the declaration reader ──────────────────────────────────────────────────

test('the archive declaration is read from the supported shapes, and refuses to guess at anything else', () => {
  assert.deepEqual(archiveScriptIn('scripts:\n  archive: bash scripts/archive.sh\n'), { archive: 'bash scripts/archive.sh' });
  assert.deepEqual(archiveScriptIn('scripts:\n  archive: |\n    echo one\n    echo two\n'), { archive: 'echo one\necho two' });
  assert.deepEqual(archiveScriptIn('scripts:\n  setup: pnpm install\n'), { archive: null });
  assert.deepEqual(archiveScriptIn('issueCommand: gh issue view\n'), { archive: null });
  assert.equal('unknown' in archiveScriptIn('scripts: { archive: echo flow }\n'), true);
  assert.equal('unknown' in archiveScriptIn('scripts:\n  archive: *alias\n'), true);
  assert.equal('unknown' in archiveScriptIn('scripts:\n\tarchive: echo tabbed\n'), true);
});

test('the cleanup stage owner is the effective declaration, and an unread policy is unknown', () => {
  assert.deepEqual(cleanupStage({ yaml: 'scripts:\n  archive: echo shared\n', hookSettings: { scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' } }), {
    owner: 'declared',
    source: 'orca.yaml',
    command: 'echo shared',
  });
  assert.deepEqual(cleanupStage({ yaml: null, hookSettings: { scripts: { setup: '', archive: 'echo local' }, commandSourcePolicy: 'local-only' } }), {
    owner: 'declared',
    source: 'Orca repository settings',
    command: 'echo local',
  });
  assert.deepEqual(
    cleanupStage({ yaml: 'scripts:\n  archive: echo shared\n', hookSettings: { scripts: { setup: '', archive: 'echo local' }, commandSourcePolicy: 'run-both' } }),
    { owner: 'declared', source: 'orca.yaml and Orca repository settings', command: 'echo shared\necho local' },
  );
  assert.deepEqual(cleanupStage({ yaml: null, hookSettings: null }), { owner: 'ax-clean', source: 'ax worktree clean', command: '' });
  assert.equal('unknown' in cleanupStage({ yaml: 'scripts: { archive: x }\n', hookSettings: { scripts: { setup: '', archive: '' }, commandSourcePolicy: 'shared-only' } }), true);
  assert.equal('unknown' in cleanupStage({ unreadable: 'orca.yaml could not be read' }), true);
});

// ── the surface ─────────────────────────────────────────────────────────────

const ax = (cwd, ...args) => {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.AX_MAIN_CHECKOUT;
  const result = spawnSync(process.execPath, [join(PACKAGE, 'bin', 'ax.mjs'), ...args], { cwd, encoding: 'utf8', env });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

test('the verb is registered, and asking what it does never runs it', () => {
  assert.ok(subcommandNames('worktree').includes('reclaim'), 'reclaim is not a declared worktree verb');
  assert.ok('reclaim' in SUBCOMMANDS, 'reclaim has no runner');

  const s = stage();
  const bare = ax(s.main, 'worktree', '--help');
  assert.equal(bare.status, 0, bare.out);
  assert.match(bare.out, /reclaim/);

  const asked = ax(s.main, 'worktree', 'reclaim', '--help');
  assert.equal(asked.status, 0, asked.out);
  // The contract an operator needs before typing: how the three verbs differ,
  // and which existing retention claims this one honours.
  assert.match(asked.out, /clean/);
  assert.match(asked.out, /rm/);
  assert.match(asked.out, /reclaim/);
  assert.match(asked.out, /locked/);
  assert.match(asked.out, /pinned/i);
  assert.equal(registered(s.main, s.path), true);

  // After a value-taking flag, the question is still the question.
  const late = ax(s.main, 'worktree', 'reclaim', '--store', s.store, '--help');
  assert.equal(late.status, 0, late.out);
  assert.match(late.out, /reclaim/);
  assert.equal(registered(s.main, s.path), true);
  assert.equal(existsSync(join(s.main, '.scratch', 'reclaim')), false);

  const line = COMMANDS.find(command => command.name === 'worktree').agentLine;
  assert.match(line, /reclaim/);
});

test('the orchestrator contract reaches the step on the per-slice path', () => {
  const contract = readFileSync(join(PACKAGE, 'omp', 'roles', 'orchestrator.md'), 'utf8');
  assert.match(contract, /ax worktree reclaim/);
  const release = contract.indexOf('ax worker release');
  const step = contract.indexOf('ax worktree reclaim');
  assert.ok(release !== -1 && step > release, 'the reclaim step does not follow the pane release on the per-slice path');
});
