// `ax worker launch` — the pipeline that turns a ticket into a verified session.
//
// Every proposition here is one the Bash suite proved (F-027): this file is the
// port of `orca-launch.test.ts`'s pipeline half — arguments, placement, the
// selector Orca can see, lineage, the STRANDED replay, verification. The ticket,
// host-grounds, brief and child-worktree halves are pinned in their own suites
// (worker-{ticket,hosts,brief,child}.test.mjs), because each is now its own
// module rather than a section of one 950-line function.
//
// Offline by construction: the Orca runner, `exec`, `ax worktree setup` and
// `ax worker start` are all injected, so no runtime, no ssh and no network is
// touched, and nothing is ever dispatched for real.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { launch, requestIdFor } from '../src/worker/launch.mjs';
import { verify } from '../src/worker/verify.mjs';
import { CONTEXT_PATH } from '../src/worktree/context.mjs';

const ISSUE = 'GAP-353';
const SLUG = 'loading-states';
const REQUEST = 'gap-353-loading-states';

function capture(fn) {
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
}

/**
 * A real repository with a real `.worktrees` base, because placement compares
 * paths the filesystem answers for and the reuse branch reads a directory.
 */
function repo({ launch = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-launch-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.worktrees'), { recursive: true });
  writeFileSync(
    join(dir, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, launch: { entry: '/entry', ...launch } }),
  );
  return dir;
}

/** A worktree that looks provisioned: the context file `setup` would write. */
function provisioned(root, name) {
  const path = join(root, '.worktrees', name);
  mkdirSync(join(path, '.agent'), { recursive: true });
  writeFileSync(join(path, CONTEXT_PATH), '- Web URL: `http://probe.test:3100`\n');
  return path;
}

/**
 * A stub Orca. `seen` decides whether `worktree show` resolves the selector a
 * dispatch will use; `cursors` is the liveness series; every argv is recorded so
 * "nothing was dispatched" is asserted rather than assumed.
 */
function fakeOrca({ seen = true, cursors = ['1', '2'], parent = 'repo-id::/parent/wt', terminals, created, emptyBody = false, labels = [] } = {}) {
  const calls = [];
  let reads = 0;
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      const line = args.join(' ');
      const receipt = result => ({ status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });
      if (args[0] === 'status') return receipt({ runtime: { reachable: true } });
      if (line.startsWith('linear issue')) {
        return receipt({ issue: { identifier: ISSUE, title: 'Loading states', url: 'https://linear.test/GAP-353', state: { name: 'In Progress' }, description: emptyBody ? '   ' : 'a decision, written down', labels: { nodes: labels.map(name => ({ name })) } } });
      }
      if (line.startsWith('worktree create')) return created ?? receipt({ worktree: { path: '/nonexistent' } });
      if (line.startsWith('worktree show')) {
        return seen ? receipt({ worktree: { path: 'x', parentWorktreeId: parent } }) : { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'selector_not_found' } }), stderr: '' };
      }
      if (line.startsWith('worktree set')) return receipt({ worktree: {} });
      if (line.startsWith('terminal list')) return receipt({ terminals: terminals ?? [{ handle: 'term_me', worktreePath: '/parent/wt' }], hostScope: { omittedHostIds: [] }, truncated: false });
      if (line.startsWith('terminal read')) {
        const cursor = cursors[Math.min(reads, cursors.length - 1)];
        reads += 1;
        return receipt({ terminal: { handle: 'term_child', status: 'running', latestCursor: cursor, tail: [] } });
      }
      return { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'unexpected' } }), stderr: '' };
    },
  });
  return { runner, calls };
}

/** A dispatch store record naming the child's pane, as `ax worker start` leaves it. */
function record(store, request, handle = 'term_child') {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      host: 'test',
      orca: 'stub-orca',
      createdAt: '2026-08-22T10:00:00.000Z',
      attempts: [
        {
          n: 1,
          settled: false,
          phases: [
            {
              name: 'worker-start',
              identity: 'id-1',
              argv: ['stub-orca', 'orchestration', 'worker-start'],
              exit: 0,
              receipt: { ok: true, result: { dispatchId: 'ctx_1', state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: handle }] } },
            },
          ],
        },
      ],
    }),
  );
}

/** A session transcript carrying the model mover and the session-role receipt. */
function transcript(root, needle, role, { sessionRole = 'worker', skills = ['implementation'], refusal = null } = {}) {
  const dir = join(root, `-x-${needle}`);
  mkdirSync(dir, { recursive: true });
  const entries = [];
  const model = { type: 'model_change', model: 'claude-sonnet-5' };
  if (role !== null) model.role = role;
  entries.push(model);
  if (sessionRole !== null) {
    entries.push({
      type: 'custom_message',
      customType: 'skill-prompt',
      details: { role: sessionRole, skills, status: 'applied' },
    });
  }
  if (refusal !== null) {
    entries.push({
      type: 'custom_message',
      customType: 'role-refused',
      details: refusal,
    });
  }
  writeFileSync(join(dir, 'a.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  return root;
}

const run = (argv, options = {}) => {
  const { runner, calls } = fakeOrca(options.orca ?? {});
  const root = options.root ?? repo();
  const home = options.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  const sessions = join(home, 'sessions');
  mkdirSync(sessions, { recursive: true });

  // The Run this session's receiver consumes, from the peer registry — never
  // invented, and the launch refuses without it.
  if (options.registry !== false) {
    mkdirSync(join(home, '.omp', 'run', 'orca-peers'), { recursive: true });
    writeFileSync(join(home, '.omp', 'run', 'orca-peers', 'term_me.json'), JSON.stringify({ run: 'run_owner' }));
  }

  const started = [];
  const result = capture(() =>
    launch([...argv], {
      runner: options.runnerOverride ?? runner,
      exec: options.exec ?? (() => ({ status: 0, stdout: '', stderr: '' })),
      env: { HOME: home, ORCA_TERMINAL_HANDLE: 'term_me', ORCA_DISPATCH_STORE: store, AX_LAUNCH_SPEC_DIR: join(home, 'specs'), AX_LAUNCH_TICK: '1', AX_LAUNCH_SEE_WAIT: '0', ...options.env },
      cwd: root,
      sleep: options.sleep ?? (() => {}),
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
      startFn: (args, context) => {
        started.push(args.join(' '));
        record(store, options.request ?? REQUEST);
        return options.startCodes ? options.startCodes.shift() : 0;
      },
      setupFn: options.setupFn ?? (() => 0),
      sessionsRoot: sessions,
    }),
  );
  return { ...result, calls, started, root, home, store, sessions };
};

// ── arguments, before anything is read ───────────────────────────────────────

test('a valued flag with no value is refused, never consumed', () => {
  // The Bash guarded the same thing: a lone trailing flag made its parse loop
  // spin instead of stopping. Node has no shift to desync, but the refusal is
  // the behaviour that was paid for.
  const r = run(['--issue']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--issue expects a value/);
  assert.deepEqual(r.started, []);
});

test('a ref that names no tracker is refused rather than guessed', () => {
  const r = run(['--issue', 'not-a-ref']);
  assert.equal(r.code, 2);
  assert.match(r.out, /Linear ref .*or a GitHub issue number/);
});

test('a Linear ref with no --slug is refused: nothing here invents a branch name', () => {
  const r = run(['--issue', ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--slug is required/);
  assert.deepEqual(r.started, []);
});

test('an unreadable --brief is refused before the ticket is even read', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--brief', '/nonexistent/brief.md']);
  assert.equal(r.code, 1);
  assert.match(r.out, /--brief file unreadable/);
  assert.deepEqual(r.calls, [], 'nothing is read when the arguments already refuse');
});

test('a project that declares no entry point must be given --task', () => {
  const root = repo();
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' } }));
  const bare = run(['--issue', ISSUE, '--slug', SLUG], { root });
  assert.equal(bare.code, 1);
  assert.match(bare.out, /declares no launch entry point/);
  assert.match(bare.out, /launch\.entry/);

  provisioned(root, `${ISSUE}-${SLUG}`);
  const told = run(['--issue', ISSUE, '--slug', SLUG, '--task', '/plan GAP-353', '--wait', '0'], { root });
  assert.equal(told.code, 0);
});

test('no Run to own the Task is a named inability, never a guess', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { registry: false, root: (() => { const root = repo(); provisioned(root, `${ISSUE}-${SLUG}`); return root; })() });
  assert.equal(r.code, 3);
  assert.match(r.out, /no Run to own the Task/);
  assert.deepEqual(r.started, []);
  // Measured 2026-08-24 on ofmchat: this refusal's repair line offered
  // `--run <run_id>`, so the operator minted a Run by hand. But an empty
  // registry means this session HAS NO RECEIVER — the adapter never loaded (the
  // repo carried `node_modules/@flosrn/ax` and no `.omp/settings.json` naming
  // it, so the machine-wide bridge stood down and the project loaded nothing).
  // A child dispatched into a hand-minted Run then reports into a Run nobody
  // consumes, which is the silent non-delivery peers.mjs refuses to allow. So
  // the repair named FIRST is the receiver, never the flag.
  const runFlagAt = r.out.indexOf('--run <run_id>');
  const initAt = r.out.indexOf('ax init');
  assert.notEqual(initAt, -1, 'the repair must name the wiring that gives this session a receiver');
  assert.match(r.out, /restart/i, 'a registered pane is what a restarted session gets, and nothing else does');
  assert.ok(runFlagAt === -1 || initAt < runFlagAt, 'the flag may only appear after the repair that makes a report arrive');
});

test('--run is refused: a launch cannot name a Run its own receiver does not consume', () => {
  // peers.mjs states the rule this closes: the Run is never a flag, because a
  // guessed one sends the child's completion report to a session that will
  // never read it. The refusal above used to PRESCRIBE `--run`, and a Run minted
  // by hand from an unregistered session is precisely that void — the report is
  // addressed, accepted, and consumed by nobody.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const empty = run(['--issue', ISSUE, '--slug', SLUG, '--run', 'run_minted', '--wait', '0'], { registry: false, root });
  assert.equal(empty.code, 2, 'refused on the argument alone, before anything is read');
  assert.match(empty.out, /--run is not a launch input/);
  assert.deepEqual(empty.started, [], 'a hand-minted Run buys no dispatch');

  const registered = run(['--issue', ISSUE, '--slug', SLUG, '--run', 'run_other', '--wait', '0'], { root });
  assert.equal(registered.code, 2);
  assert.match(registered.out, /--run/);
  assert.deepEqual(registered.started, [], 'not even a Run that exists may override the registry');
});

test('an unreadable ticket creates nothing, and cannot be established', () => {
  const { runner, calls } = fakeOrca({});
  const dead = args => (args[0] === 'linear' ? { status: 1, stdout: '', stderr: 'linear_not_connected', receipt: { ok: false, error: { code: 'linear_not_connected' } } } : runner(args));
  const r = run(['--issue', ISSUE, '--slug', SLUG], { orca: {}, runnerOverride: dead });

  assert.equal(r.code, 3);
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'nothing is placed for a ticket nobody could read');
  assert.deepEqual(r.started, []);
});

test('an empty ticket body creates nothing on the default entry point', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG], { orca: { emptyBody: true } });

  assert.equal(r.code, 1);
  assert.match(r.out, /body is empty|names none/i);
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'an empty ticket places nothing');
  assert.deepEqual(r.started, []);
});

test('a --needs-ref origin does not carry creates nothing, and a pattern is refused as one', () => {
  const missing = run(['--issue', ISSUE, '--slug', SLUG, '--needs-ref', 'refs/tags/v4/x'], {
    exec: (bin, args) => (bin === 'git' && args[0] === 'ls-remote' ? { status: 2, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /does not resolve on origin/);
  assert.ok(missing.calls.every(argv => !argv.startsWith('worktree create')));

  // `ls-remote` matches PATTERNS: `*` exits 0 and would prove any ref at all.
  const glob = run(['--issue', ISSUE, '--slug', SLUG, '--needs-ref', 'refs/tags/*'], {
    exec: (bin, args) => (bin === 'git' && args[0] === 'ls-remote' ? { status: 0, stdout: 'sha\trefs/tags/a\nsha\trefs/tags/b\n', stderr: '' } : { status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(glob.code, 1);
  assert.match(glob.out, /is a pattern, not a ref/);
});

// ── placement ────────────────────────────────────────────────────────────────

test('a worktree that already exists for the ticket is reused, and still proven habitable', () => {
  // `worktree create` carries no --retry-request, so a create that strands
  // cannot be replayed: finding the first tree IS the countermeasure. But the
  // launch that made it may be exactly the one that died before provisioning it,
  // so a reused tree is provisioned again — `ax worktree setup` is idempotent by
  // contract, and re-running it on a live worktree is its normal case.
  const root = repo();
  const existing = provisioned(root, `${ISSUE}-${SLUG}`);
  const setups = [];
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, setupFn: (a, c) => (setups.push(c.cwd), 0) });

  assert.equal(r.code, 0);
  assert.match(r.out, /reusing the worktree that already exists/);
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'no second placement');
  assert.deepEqual(setups, [existing], 'the reused tree is proven habitable, not assumed');
  assert.match(r.started[0], new RegExp(`--worktree path:${existing}`));
});

test("a ticket labelled as touching the database is provisioned with its own stack", () => {
  // Measured 2026-08-25 on ofmchat #71 (`domain:database`, `domain:security`):
  // the plan decides shared-vs-isolated from the DIFF of the tree it is
  // provisioning, and that tree is seconds old and empty — so the one ticket
  // whose whole subject was the database was told "this worktree does not touch
  // the database", and its child then reset a stack the primary checkout and
  // every other sharing worktree depend on.
  const root = repo({ launch: { databaseLabels: ['domain:database'] } });
  provisioned(root, `${ISSUE}-${SLUG}`);
  const setups = [];
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], {
    root,
    orca: { labels: ['domain:security', 'domain:database'] },
    setupFn: (argv, context) => (setups.push({ argv, cwd: context.cwd }), 0),
  });

  assert.equal(r.code, 0);
  assert.deepEqual(setups[0].argv, ['--database'], 'the label forces isolation instead of leaving it to an empty diff');
  assert.match(r.out, /this ticket says it touches the database/);
});

test('a ticket with no declared database label leaves the plan to decide alone', () => {
  // The scope this must not widen into: a project that declares no vocabulary
  // gets no forced isolation, and a label vocabulary measured for one fleet is
  // never inherited by a repo that never declared it.
  const undeclared = repo();
  const setups = [];
  provisioned(undeclared, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], {
    root: undeclared,
    orca: { labels: ['domain:database'] },
    setupFn: (argv, context) => (setups.push({ argv, cwd: context.cwd }), 0),
  });
  assert.equal(r.code, 0);
  assert.deepEqual(setups[0].argv, []);

  // Declared, and this ticket carries none of them: same answer.
  const declared = repo({ launch: { databaseLabels: ['domain:database'] } });
  provisioned(declared, `${ISSUE}-${SLUG}`);
  const other = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], {
    root: declared,
    orca: { labels: ['area:web'] },
    setupFn: (argv, context) => (setups.push({ argv, cwd: context.cwd }), 0),
  });
  assert.equal(other.code, 0);
  assert.deepEqual(setups[1].argv, []);
});

test('a tree for another ticket is never reused for this one', () => {
  // A substring match read `GAP-35` as this ticket's tree inside `gap-357-…`,
  // which dispatches a child into a branch that is not its own.
  const root = repo();
  provisioned(root, 'GAP-3530-other-work');
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    root,
    orca: { created: { status: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' } },
  });

  assert.doesNotMatch(r.out, /reusing the worktree/);
  assert.equal(r.code, 3, 'it places a new one instead, and this fixture makes that placement fail');
});

test('the declared worktree tool places it, and its last stdout line is the path', () => {
  const root = repo();
  const tree = join(root, '.worktrees', 'placed-by-tool');
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, launch: { entry: '/entry', worktreeTool: 'place' } }));
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin !== 'place') return { status: 0, stdout: '', stderr: '' };
    mkdirSync(join(tree, '.agent'), { recursive: true });
    writeFileSync(join(tree, CONTEXT_PATH), '- Web URL: `http://x`\n');
    return { status: 0, stdout: `bootstrapping…\n${tree}\n`, stderr: 'progress on stderr\n' };
  };

  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, exec });
  assert.equal(r.code, 0);
  assert.ok(calls.some(line => line === `place ${ISSUE} ${SLUG}`), 'the tool is called with the ticket and the slug');
  assert.match(r.started[0], new RegExp(`--worktree path:${tree}`));
});

test('a placement tool that fails refuses, and dispatches nothing', () => {
  const root = repo();
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, launch: { entry: '/entry', worktreeTool: 'place' } }));
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, exec: bin => (bin === 'place' ? { status: 1, stdout: '', stderr: 'no branch\n' } : { status: 0, stdout: '', stderr: '' }) });

  assert.equal(r.code, 1);
  assert.match(r.out, /place failed for GAP-353; nothing was dispatched/);
  assert.deepEqual(r.started, []);
});

test('a create receipt that names no path cannot be dispatched into', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    orca: { created: { status: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' } },
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /names no path/);
  assert.deepEqual(r.started, []);
});

test('a tree that exists but is not provisioned cannot be established, and names itself', () => {
  // Once a worktree EXISTS, exit 1 would be a lie: it promises nothing was
  // created. So the failure is cannot-establish, and it names the tree — which
  // is also the tree a second launch will reuse rather than duplicate.
  const root = repo();
  const tree = join(root, '.worktrees', 'made');
  mkdirSync(tree, { recursive: true });
  const orca = { created: { status: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { path: tree } } }), stderr: '' } };

  const failed = run(['--issue', ISSUE, '--slug', SLUG], { root, orca, setupFn: () => 1 });
  assert.equal(failed.code, 3);
  assert.match(failed.out, /ax worktree setup did not finish/);
  assert.match(failed.out, new RegExp(tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the operator is told which tree exists now');
  assert.deepEqual(failed.started, []);

  // Setup ends 0 but writes nothing: the child would have no URL to test
  // against, which is what `--setup skip` produced on 2026-08-13.
  const empty = run(['--issue', ISSUE, '--slug', SLUG], { root, orca, setupFn: () => 0 });
  assert.equal(empty.code, 3);
  assert.match(empty.out, new RegExp(`has no ${CONTEXT_PATH.replace('.', '\\.')}`));
});

test('--probe skips provisioning, and says it is never for real work', () => {
  const root = repo();
  const tree = join(root, '.worktrees', 'probe-tree');
  mkdirSync(tree, { recursive: true });
  const setups = [];
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--probe', '--wait', '0'], {
    root,
    orca: { created: { status: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { path: tree } } }), stderr: '' } },
    setupFn: (a, c) => (setups.push(c.cwd), 0),
  });

  assert.equal(r.code, 0);
  assert.match(r.out, /never for real work/);
  assert.deepEqual(setups, [], '--probe provisions nothing');
});

test('a placement Orca cannot SEE stops the launch before any dispatch', () => {
  // Measured 2026-08-21: `worker-start` answered selector_not_found five seconds
  // after placement and the same recorded call replayed clean three minutes
  // later, with no argument changed. It is indistinguishable from a bad
  // selector, which is what makes it expensive.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, orca: { seen: false } });

  assert.equal(r.code, 3);
  assert.match(r.out, /does not resolve path:/);
  assert.match(r.out, /selector_not_found/);
  assert.deepEqual(r.started, [], 'nothing is dispatched into a tree the dispatch cannot address');
});

// ── lineage ──────────────────────────────────────────────────────────────────

test('lineage is set and READ BACK, and the read-back must be the parent it set', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root });

  assert.equal(r.code, 0);
  assert.ok(r.calls.some(argv => argv.includes('worktree set') && argv.includes('--parent-worktree')));
  assert.match(r.out, /lineage\s+repo-id::\/parent\/wt/);
});

test('a set that lands while the field still reads empty is announced, not claimed (F-002)', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, orca: { parent: '' } });

  assert.equal(r.code, 0, 'a degraded report channel never costs the slice');
  assert.match(r.out, /parentWorktreeId still reads empty \(F-002\)/);
});

test('a parent that reads back as someone else is NOT SET, however non-empty it is', () => {
  // A tree reused from an earlier launch already carries a parent. Reading "some
  // parent" back would report success over a `set` Orca discarded — which is
  // exactly the shape F-002 is about.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, orca: { parent: 'repo-id::/somebody/else' } });

  assert.equal(r.code, 0, 'a degraded report channel never costs the slice');
  assert.match(r.out, /not the \/parent\/wt this launch set/);
});

test('a session Orca witnesses nowhere gets no guessed parent', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, orca: { terminals: [{ handle: 'term_someone_else', worktreePath: '/elsewhere' }] } });

  assert.equal(r.code, 0);
  assert.match(r.out, /would send this child\u2019s report to a stranger/);
  assert.ok(r.calls.every(argv => !argv.includes('--parent-worktree')), 'a guessed parent is never set');
});

test('a cross-host child says lineage is impossible rather than attempting it', () => {
  const root = repo();
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, launch: { entry: '/entry', hosts: { far: { ssh: 'far-host' } } } }),
  );
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--on', 'far', '--repo-id', 'abc', '--wait', '0'], { root });
  assert.match(r.out, /lineage\s+impossible \(cross-host/);
  assert.ok(r.calls.every(argv => !argv.includes('--parent-worktree')));
});

// ── the brief, and what is never mutated ─────────────────────────────────────

test('the brief is a FILE, and its first line carries the marker with the instruction', () => {
  // 2026-08-01: a brief typed into a TUI as a payload left three worktrees
  // skipping every stage after the first while the sender reported success.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--model', '@task', '--wait', '0'], { root });

  const spec = r.started[0].match(/--spec-file (\S+)/)[1];
  assert.ok(existsSync(spec), 'the dispatch is handed a path, not a payload');
  const brief = readFileSync(spec, 'utf8');
  assert.equal(brief.split('\n')[0], '[omp role=worker model=@task] /entry GAP-353');
  assert.match(brief, /https:\/\/linear\.test\/GAP-353/);
});

test('--dry-run prints the brief and mutates nothing', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /\[omp role=worker model=@default\] \/entry GAP-353/);
  assert.match(r.out, /would run: ax worker start/);
  assert.deepEqual(r.started, [], 'a dry run dispatches nothing');
  assert.ok(r.calls.every(argv => !argv.includes('worktree set')), 'and sets no lineage');
});

/**
 * The bundle `.omp/settings.json` registers, installed in that worktree — the
 * state pnpm reaches a few seconds after `git worktree add` returns.
 */
function equipped(worktree, { installed = true } = {}) {
  mkdirSync(join(worktree, '.omp'), { recursive: true });
  writeFileSync(join(worktree, '.omp', 'settings.json'), JSON.stringify({ extensions: ['./node_modules/@flosrn/ax'] }));
  if (!installed) return worktree;
  const pkg = join(worktree, 'node_modules', '@flosrn', 'ax');
  mkdirSync(join(pkg, 'omp'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@flosrn/ax', omp: { extensions: ['./omp/index.ts'] } }));
  writeFileSync(join(pkg, 'omp', 'index.ts'), 'export default {};\n');
  return worktree;
}

// ── the bundle the child boots with, BEFORE the dispatch ─────────────────────

test('a worktree whose registered OMP bundle is not installed dispatches NOTHING', () => {
  // Measured 2026-08-28, ofmchat #101: the dispatch went out five seconds before
  // pnpm created `node_modules/@flosrn/ax`, so the child never consumed its own
  // `[omp role=worker model=@default]` marker — boot model, no role, no playbook,
  // for the whole of a real implementation. Refusing here is cheap; that child
  // cost a wave.
  const root = repo();
  equipped(provisioned(root, `${ISSUE}-${SLUG}`), { installed: false });
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, env: { AX_LAUNCH_EQUIP_WAIT: '0' } });

  assert.equal(r.code, 3);
  assert.match(r.out, /node_modules\/@flosrn\/ax/);
  assert.match(r.out, /no worker role, no playbook/);
  assert.deepEqual(r.started, [], 'nothing is dispatched into a worktree that cannot equip it');
});

test('a worktree whose settings file registers no ax bundle dispatches NOTHING, and says ax init', () => {
  // An unequipped child by the other route: OMP loads, and nothing in it consumes
  // the role marker the brief carries. Waiting is not the repair here.
  const root = repo();
  const tree = provisioned(root, `${ISSUE}-${SLUG}`);
  mkdirSync(join(tree, '.omp'), { recursive: true });
  writeFileSync(join(tree, '.omp', 'settings.json'), JSON.stringify({ extensions: [] }));
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root });

  assert.equal(r.code, 3);
  assert.match(r.out, /none of them is @flosrn\/ax/);
  assert.match(r.out, /ax init/);
  assert.deepEqual(r.started, []);
});

test('a settings file that exists and cannot be parsed dispatches NOTHING', () => {
  const root = repo();
  const tree = provisioned(root, `${ISSUE}-${SLUG}`);
  mkdirSync(join(tree, '.omp'), { recursive: true });
  writeFileSync(join(tree, '.omp', 'settings.json'), '{ not json');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root });

  assert.equal(r.code, 3);
  assert.match(r.out, /could not be read/);
  assert.deepEqual(r.started, [], 'a declared loader that loads nothing is not a launch');
});

test('an unequipped child is named as the CAUSE, not left as two unexplained UNPROVENs', () => {
  // The verdict that was overruled (ofmchat #101). Reachable after the ground
  // because a concurrent pnpm install RELINKS: the bundle can be there when the
  // dispatch goes out and gone while the child boots. The three cheap checks an
  // operator reaches for — `--show`, `gate`, `tail` — all answer "healthy" over an
  // unequipped child, so this line is the only one that separates them.
  const root = repo();
  const tree = equipped(provisioned(root, `${ISSUE}-${SLUG}`));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  // Boot model, no role receipt: exactly what a child with no AX bundle writes.
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, null, { sessionRole: null });
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    root,
    home,
    sleep: () => rmSync(join(tree, 'node_modules'), { recursive: true, force: true }),
  });

  assert.equal(r.code, 3);
  assert.match(r.out, /CAUSE: this worktree cannot load its AX bundle/);
  assert.match(r.out, /working UNEQUIPPED, not still booting/);
  assert.match(r.out, /install in/);
  assert.equal(r.started.length, 1, 'the dispatch happened once and is never repeated');
});

test('a wiring fault discovered at verification names `ax init`, not an install', () => {
  // The other half of the CAUSE line, and the reason the probe is an INJECTED
  // dependency: a registration that broke between the pre-dispatch ground and the
  // child's boot is real but not worth staging on disk, and the two states route
  // to different repairs — one is bytes to install, the other is wiring `ax init`
  // rewrites. `verify` is called directly here because that is the unit that owns
  // the verdict.
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  const sessions = join(home, 'sessions');
  transcript(sessions, `${ISSUE}-${SLUG}`, null, { sessionRole: null });
  record(store, REQUEST);
  const { runner } = fakeOrca();
  let clock = 0;
  const r = capture(() =>
    verify({
      run: runner,
      env: { HOME: home, ORCA_DISPATCH_STORE: store },
      on: '',
      wait: 1,
      worktree: join(root, '.worktrees', `${ISSUE}-${SLUG}`),
      request: REQUEST,
      ticket: null,
      instruction: '/entry',
      lineage: 'repo-id::/parent/wt',
      sessionsRoot: sessions,
      host: null,
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
      cwd: root,
      now: () => (clock += 1000),
      sleep: () => {},
      tickMs: 1,
      equipmentProbe: () => ({
        measured: true,
        ready: false,
        wiring: true,
        missing: [],
        reason: '.omp/settings.json registers 1 extension(s) and none of them is @flosrn/ax',
      }),
    }),
  );

  assert.equal(r.code, 3);
  assert.match(r.out, /CAUSE: this worktree cannot load its AX bundle \(\.omp\/settings\.json registers 1 extension/);
  assert.match(r.out, /ax init {3}# then settle this dispatch and launch again/);
  assert.doesNotMatch(r.out, /package manager's install/, 'a wiring fault is not repaired by an install');
});

test('an install that lands during the wait is dispatched into, not refused', () => {
  // `ax worktree setup` installs nothing, so a concurrent install is the ORDINARY
  // state of a fresh worktree. The measured window was five seconds.
  const root = repo();
  const tree = equipped(provisioned(root, `${ISSUE}-${SLUG}`), { installed: false });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default');
  let slept = 0;
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    root,
    home,
    sleep: () => {
      slept += 1;
      if (slept === 1) equipped(tree);
    },
  });

  assert.equal(r.code, 0);
  assert.match(r.out, /AX bundle/);
  assert.equal(r.started.length, 1);
});

test('an installed bundle is proven before the dispatch, and says so once', () => {
  const root = repo();
  equipped(provisioned(root, `${ISSUE}-${SLUG}`));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 0);
  assert.match(r.out, /AX bundle this worktree registers is loadable/);
});

// ── dispatch and verification ────────────────────────────────────────────────

test('a STRANDED dispatch is replayed here, and the child is still verified', () => {
  // Both remote launches on record hit it, which makes the recovery the ordinary
  // path rather than an anomaly. Typing it by hand is what used to drop the
  // verification: the launch exited and the operator resumed from a fresh shell,
  // so the child was never proven.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home, startCodes: [4, 0] });

  assert.match(r.out, /STRANDED/);
  assert.match(r.out, /replaying the recorded call/);
  assert.equal(r.started.length, 2);
  assert.match(r.started[1], /--resume --request gap-353-loading-states/);
  assert.ok(!r.started[1].includes('--spec-file'), 'the replay is the recorded call, not a second composed one');
  // The proposition is that the replay reaches a full green verdict in ONE run.
  assert.equal(r.code, 0);
  assert.match(r.out, /model .*\|default/);
});

test('the model, worker and implementation receipts with a moving pane are a green verdict', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 0);
  assert.match(r.out, /model .*\|default/);
  assert.match(r.out, /session .*worker.*implementation/);
  assert.match(r.out, /the role, playbook, model marker, and pane movement are proven/);
});

test('an applied model without a session-role receipt is exit 3', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default', { sessionRole: null });
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 3);
  assert.match(r.out, /UNPROVEN session role/);
  assert.match(r.out, /Do NOT relaunch/);
});

test('a pre-turn role refusal is exit 3 with its exact cause', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default', {
    sessionRole: null,
    refusal: { role: 'worker', reason: 'skill-not-found', missingSkills: ['implementation'] },
  });
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 3);
  assert.match(r.out, /REFUSED session role worker: skill-not-found/);
  assert.match(r.out, /missing implementation/);
});

test('a child on its BOOT model is exit 3, and says not to relaunch', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, null);
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 3);
  assert.match(r.out, /runs its BOOT model/);
  assert.match(r.out, /Do NOT relaunch/);
  assert.equal(r.started.length, 1, 'a failed verdict never dispatches again');
});

test('the quota chain moving a session is not the marker applying', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'fallback');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 3);
  assert.match(r.out, /quota chain moved this session/);
});

test('a proof read before the child finished booting is re-read, never latched', () => {
  // Measured 2026-08-26 (ofmchat, two launches of a live wave): the receipt said
  // `model …|` and `session unreadable` with the cursor moving 0 -> 604, and 20s
  // later the pane was on the marker's model with the role applied. The loop had
  // latched the FIRST read that found a session file — a file that exists as soon
  // as the child boots and carries only its boot `model_change`. So the transcript
  // gains both receipts here between two polls, and the verdict must be green.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const sessions = join(home, 'sessions');
  transcript(sessions, `${ISSUE}-${SLUG}`, null, { sessionRole: null });
  let slept = 0;
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    root,
    home,
    sleep: () => {
      slept += 1;
      if (slept === 1) transcript(sessions, `${ISSUE}-${SLUG}`, 'default');
    },
  });

  assert.equal(r.code, 0);
  assert.match(r.out, /model .*\|default/);
  assert.match(r.out, /session .*worker.*implementation/);
});

test('no transcript yet is UNPROVEN, never a boot-model verdict', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root });

  assert.equal(r.code, 3);
  assert.match(r.out, /no transcript yet/);
  assert.doesNotMatch(r.out, /BOOT model/, 'absence is "too early to tell", never a verdict');
});

test('a pane that never advances is UNPROVEN liveness, and says a spinner looks the same', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home, orca: { cursors: ['7', '7'] } });

  assert.equal(r.code, 3);
  assert.match(r.out, /cursor did not advance/);
  assert.match(r.out, /in-place spinner/);
});

test('--wait 0 exits green without ever claiming the child was verified', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /verified {2}skipped \(--wait 0\)/);
  assert.doesNotMatch(r.out, /role=default/);
});

test('the request id is the key every later gesture uses', () => {
  assert.equal(requestIdFor('GAP-353', 'loading-states'), REQUEST);
  assert.equal(requestIdFor('1234', ''), '1234-work');
  assert.equal(requestIdFor('GAP-353', 'Feature/Two Words'), 'gap-353-feature-two-words');
});

// ── --name: a worktree with no ticket ────────────────────────────────────────

test('the request id is NOT injective, which is why a name is refused rather than normalised', () => {
  // The reason the canonical rule exists, stated as the measurement it comes
  // from: three different names, one request id. Keyed on that, the second
  // launch would find the first one's tree and dispatch a child into it.
  const collide = ['My Feature', 'my/feature', 'my@@feature'].map(name => requestIdFor(name, 'x'));
  assert.deepEqual(collide, ['my-feature-x', 'my-feature-x', 'my-feature-x']);
});

test('exactly one identity: both --issue and --name is refused, and so is neither', () => {
  const both = run(['--issue', ISSUE, '--slug', SLUG, '--name', 'loading-states']);
  assert.equal(both.code, 2);
  assert.match(both.out, /two identities for one worktree/);
  assert.deepEqual(both.started, []);

  const neither = run(['--task', 'do the thing']);
  assert.equal(neither.code, 2);
  assert.match(neither.out, /no --issue and no --name/);
});

test('a name that is not already the request id is refused, and the refusal shows the one it means', () => {
  for (const [given, suggestion] of [
    ['My Feature', 'my-feature'],
    ['my/feature', 'my-feature'],
    ['UPPER', 'upper'],
    ['-lead', 'lead'],
    ['trail-', 'trail'],
    ['a b', 'a-b'],
  ]) {
    const r = run(['--name', given, '--task', 'do the thing']);
    assert.equal(r.code, 2, `${given} must be refused`);
    assert.match(r.out, /must be lowercase alphanumerics/);
    assert.match(r.out, new RegExp(`ax worker launch --name ${suggestion}$`, 'm'), `${given} should suggest ${suggestion}`);
    assert.deepEqual(r.started, []);
  }
});

test('a name that is a path segment is refused before anything is placed', () => {
  // `.` and `..` survive a round-trip through `requestIdFor` unchanged, so a rule
  // written as "normalise and compare" accepts them — and `.worktrees/<request>`
  // then resolves to the worktree base or the repository above it.
  for (const given of ['.', '..', './x', '../x']) {
    const r = run(['--name', given, '--task', 'do the thing']);
    assert.equal(r.code, 2, `${given} must be refused`);
    assert.deepEqual(r.started, []);
  }
});

test('--slug is refused with --name: the name is the whole identity', () => {
  const r = run(['--name', 'loading-states', '--slug', 'again', '--task', 'do the thing']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--slug belongs to a ticket ref/);
});

test('a name with no instruction is refused: there is no ticket to read one from', () => {
  // With a ticket, `launch.entry` composes `<entry> GAP-353` and the body carries
  // the rest. A name has neither, so a launch that let this through would dispatch
  // a child holding `/entry loading-states` and nothing else — the 2026-08-01
  // failure with better spelling.
  const r = run(['--name', 'loading-states']);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing here knows what "loading-states" means/);
  assert.match(r.out, /--task "<instruction>"/);
  assert.deepEqual(r.started, []);
});

test('a named launch reads no ticket, and its brief never points at one', () => {
  const root = repo();
  const r = run(['--name', 'loading-states', '--task', 'fix the skeletons', '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.ok(
    r.calls.every(argv => !argv.includes('linear issue') && !argv.includes('issue view')),
    `a tracker was read for a launch that has no ticket: ${r.calls.join(' | ')}`,
  );
  assert.doesNotMatch(r.out, /Read the ticket/);
  assert.match(r.out, /^# loading-states$/m);
  // The identity is the name, verbatim — not `loading-states-work`.
  assert.match(r.out, /--request loading-states /);
  assert.match(r.out, new RegExp(`predicted at ${join(root, '.worktrees', 'loading-states')}`));
});

test('reuse is EXACT for a name: `auth` never takes the tree of `auth-refactor`', () => {
  // The prefix rule exists for tickets, where `gap-353-old-slug` is the same
  // ticket's earlier tree. A name has no slug hanging off it, so the same rule
  // would hand `--name auth` a different piece of work, already provisioned and
  // already someone's.
  const root = repo();
  provisioned(root, 'auth-refactor');
  const r = run(['--name', 'auth', '--task', 'add the guard', '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /auth-refactor/);

  // Its own tree, on the other hand, IS reused rather than placed a second time.
  provisioned(root, 'auth');
  const again = run(['--name', 'auth', '--task', 'add the guard', '--wait', '0'], { root, request: 'auth' });
  assert.equal(again.code, 0);
  assert.match(again.out, /reusing the worktree that already exists for auth/);
});

test('a named launch reports no ticket instead of empty tracker fields', () => {
  const root = repo();
  provisioned(root, 'loading-states');
  const r = run(['--name', 'loading-states', '--task', 'fix the skeletons', '--wait', '0'], { root, request: 'loading-states' });

  assert.equal(r.code, 0);
  assert.match(r.out, /LAUNCHED loading-states — fix the skeletons/);
  assert.match(r.out, /ticket {4}none — dispatched by name/);
  assert.doesNotMatch(r.out, /ticket {4}undefined/);
  assert.match(r.out, /request {3}loading-states/);
});
