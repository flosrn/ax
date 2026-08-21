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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { launch, requestIdFor } from '../src/worker/launch.mjs';
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
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-launch-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.worktrees'), { recursive: true });
  writeFileSync(
    join(dir, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, launch: { entry: '/entry' } }),
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
function fakeOrca({ seen = true, cursors = ['1', '2'], parent = 'wt-parent', terminals, created } = {}) {
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
        return receipt({ issue: { identifier: ISSUE, title: 'Loading states', url: 'https://linear.test/GAP-353', state: { name: 'In Progress' }, description: 'a decision, written down' } });
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

/** A session transcript carrying one `model_change`, the marker's only evidence. */
function transcript(root, needle, role) {
  const dir = join(root, `-x-${needle}`);
  mkdirSync(dir, { recursive: true });
  const entry = { type: 'model_change', model: 'claude-sonnet-5' };
  if (role !== null) entry.role = role;
  writeFileSync(join(dir, 'a.jsonl'), `${JSON.stringify(entry)}\n`);
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
      runner,
      exec: options.exec ?? (() => ({ status: 0, stdout: '', stderr: '' })),
      env: { HOME: home, ORCA_TERMINAL_HANDLE: 'term_me', ORCA_DISPATCH_STORE: store, AX_LAUNCH_SPEC_DIR: join(home, 'specs'), AX_LAUNCH_TICK: '1', AX_LAUNCH_SEE_WAIT: '0', ...options.env },
      cwd: root,
      sleep: () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
      startFn: (args, context) => {
        started.push(args.join(' '));
        record(store, REQUEST);
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
});

// ── placement ────────────────────────────────────────────────────────────────

test('a worktree that already exists for the ticket is reused, with no second bootstrap', () => {
  // `worktree create` carries no --retry-request, so a create that strands
  // cannot be replayed: finding the first tree IS the countermeasure.
  const root = repo();
  const existing = provisioned(root, `${ISSUE}-${SLUG}`);
  const setups = [];
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, setupFn: (a, c) => (setups.push(c.cwd), 0) });

  assert.equal(r.code, 0);
  assert.match(r.out, /reusing the worktree that already exists/);
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'no second placement');
  assert.deepEqual(setups, [], 'a reused worktree is not re-provisioned');
  assert.match(r.started[0], new RegExp(`--worktree path:${existing}`));
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

test('provisioning is ax worktree setup, and a tree it did not finish is refused', () => {
  const root = repo();
  const tree = join(root, '.worktrees', 'made');
  mkdirSync(tree, { recursive: true });
  const orca = { created: { status: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { path: tree } } }), stderr: '' } };

  const failed = run(['--issue', ISSUE, '--slug', SLUG], { root, orca, setupFn: () => 1 });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /ax worktree setup did not finish/);
  assert.deepEqual(failed.started, []);

  // Setup ends 0 but writes nothing: the child would have no URL to test
  // against, which is what `--setup skip` produced on 2026-08-13.
  const empty = run(['--issue', ISSUE, '--slug', SLUG], { root, orca, setupFn: () => 0 });
  assert.equal(empty.code, 1);
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

test('lineage is set and READ BACK, never trusted', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /lineage\s+wt-parent/);
});

test('a set that lands while the field still reads empty is announced, not claimed (F-002)', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, orca: { parent: '' } });

  assert.equal(r.code, 0, 'a degraded report channel never costs the slice');
  assert.match(r.out, /parentWorktreeId still reads empty \(F-002\)/);
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
  assert.equal(brief.split('\n')[0], '[omp model=@task] /entry GAP-353');
  assert.match(brief, /https:\/\/linear\.test\/GAP-353/);
});

test('--dry-run prints the brief and mutates nothing', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /\[omp model=@default\] \/entry GAP-353/);
  assert.match(r.out, /would run: ax worker start/);
  assert.deepEqual(r.started, [], 'a dry run dispatches nothing');
  assert.ok(r.calls.every(argv => !argv.includes('worktree set')), 'and sets no lineage');
});

test('a declared contract that cannot be read is refused, never silently replaced', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, launch: { entry: '/entry', contract: 'docs/pilot.md' } }),
  );
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /which cannot be read/);
  assert.deepEqual(r.started, []);
});

// ── dispatch and verification ────────────────────────────────────────────────

test('a STRANDED dispatch is replayed here, and the child is still verified', () => {
  // Both remote launches on record hit it, which makes the recovery the
  // ordinary path rather than an anomaly. Typing it by hand is what used to
  // drop the verification: the launch exited and the operator resumed from a
  // fresh shell.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    root,
    startCodes: [4, 0],
    env: { AX_LAUNCH_SESSIONS: 'x' },
    setupFn: () => 0,
  });

  assert.match(r.out, /STRANDED/);
  assert.match(r.out, /replaying the recorded call/);
  assert.equal(r.started.length, 2);
  assert.match(r.started[1], /--resume --request gap-353-loading-states/);
  assert.ok(!r.started[1].includes('--spec-file'), 'the replay is the recorded call, not a second composed one');
});

test('the marker applied WITH a role and a moving pane is a green verdict', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, 'default');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 0);
  assert.match(r.out, /role=default/);
  assert.match(r.out, /the pane advanced/);
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
