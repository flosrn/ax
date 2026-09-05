// `ax worker dispatch` — the pipeline that turns a ticket into a verified session.
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

import { addWorktree } from '../src/git.mjs';
import { createRunner } from '../src/orca-bin.mjs';
// The canonical name, from the module that APPLIES it. Imported rather than
// retyped: `ax triage publish` is what makes a ticket agent-grabbable, and a
// refusal keyed on a second spelling of that label would stop refusing the day
// either string moved.
import { READY_LABEL } from '../src/triage/spec.mjs';
import { dispatch, requestIdFor, retiredKnobs, trackerRepoOf } from '../src/worker/dispatch.mjs';
// The listing verb, imported because #161's proposition crosses both: the
// number `ax worker ls` prints and the number this fence refuses on are ONE
// reader's answer, and a suite that could only see one of them is how they
// diverged.
import { ls } from '../src/worker/ls.mjs';
import { reportPathFor } from '../src/worker/report.mjs';
import { READY_LABEL as TICKET_READY_LABEL } from '../src/worker/ticket.mjs';
import { readProof, verify } from '../src/worker/verify.mjs';
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

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

/**
 * A real repository with a real `.worktrees` base and one commit, because
 * placement compares paths the filesystem answers for and reuse reads the
 * worktrees GIT has registered — which needs a HEAD to add one against.
 */
function repo({ dispatch: block = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-dispatch-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.worktrees'), { recursive: true });
  writeFileSync(
    join(dir, 'ax.config.json'),
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', ...block } }),
  );
  execFileSync('git', [...IDENTITY, 'add', 'ax.config.json'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', [...IDENTITY, 'commit', '-qm', 'fixture'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/**
 * A worktree that looks provisioned: REGISTERED with git, then carrying the
 * context file `setup` would write. Registration is not decoration — reuse is
 * grounded in git's registry (#84), and both placers register before they
 * provision: Orca's `worktree create` runs `git worktree add` and only then
 * runs its setup hook, which is exactly how the reported orphan came to sit on
 * a branch with no provisioning.
 */
function provisioned(root, name) {
  const path = join(root, '.worktrees', name);
  assert.equal(addWorktree({ cwd: root, path, branch: `feat/${name}` }).ok, true, `fixture worktree ${name}`);
  mkdirSync(join(path, '.agent'), { recursive: true });
  writeFileSync(join(path, CONTEXT_PATH), '- Web URL: `http://probe.test:3100`\n');
  return path;
}

/**
 * A stub Orca. `seen` decides whether `worktree show` resolves the selector a
 * dispatch will use; `cursors` is the liveness series; `workspaces` is the
 * runtime's answer about its OWN placement root — the second root reuse may lend
 * from (#84) — and every argv is recorded so "nothing was dispatched" is
 * asserted rather than assumed.
 */
function fakeOrca({ seen = true, cursors = ['1', '2'], parent = 'repo-id::/parent/wt', terminals, hostTerminals = {}, hostTrees = [], repos = [], created, emptyBody = false, labels = [], state = { name: 'In Progress', type: 'started' }, workspaces = [] } = {}) {
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
        return receipt({ issue: { identifier: ISSUE, title: 'Loading states', url: 'https://linear.test/GAP-353', state, description: emptyBody ? '   ' : 'a decision, written down', labels: { nodes: labels.map(name => ({ name })) } } });
      }
      if (line.startsWith('worktree create')) return created ?? receipt({ worktree: { path: '/nonexistent' } });
      if (line.startsWith('repo list')) return receipt({ repos });
      // The runtime enumerates the trees IT placed for this repo, and flags the
      // primary checkout. An empty list is a host that has placed none.
      //
      // A DECLARED HOST ANSWERS FOR ITSELF: `--environment` is the remote
      // placement read (#103), served by that host's own runtime, and it is
      // never this machine's list.
      if (line.startsWith('worktree list')) {
        if (args.includes('--environment')) return receipt({ worktrees: hostTrees });
        return receipt({ worktrees: workspaces.map(path => ({ path, isMainWorktree: false })) });
      }
      if (line.startsWith('worktree show')) {
        return seen ? receipt({ worktree: { path: 'x', parentWorktreeId: parent } }) : { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'selector_not_found' } }), stderr: '' };
      }
      if (line.startsWith('worktree set')) return receipt({ worktree: {} });
      if (line.startsWith('terminal list')) {
        // A host's OWN list, when one is asked for: that is what turns a pane the
        // local scope omits into capacity in use (#88), and the local scope here
        // omits a remote runtime exactly as this Mac's does.
        const at = args.indexOf('--environment');
        if (at !== -1) {
          const own = hostTerminals[args[at + 1]];
          if (own === undefined) return { status: 1, stdout: '', stderr: 'ssh_unreachable' };
          return receipt({ terminals: own, hostScope: { hostIds: ['local'], omittedHostIds: [] }, truncated: false });
        }
        return receipt({
          terminals: terminals ?? [{ handle: 'term_me', worktreePath: '/parent/wt' }],
          hostScope: { omittedHostIds: Object.keys(hostTerminals).length === 0 ? [] : ['runtime:7930a317'] },
          truncated: false,
        });
      }
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

/**
 * One dispatch, fully injected.
 *
 * `slug` is what `gh repo view` answers for this checkout, and it is answered by
 * the harness rather than by each test's own `exec`: it places the pane this
 * dispatch records AND scopes the per-repository cap counted before it, so a
 * fixture without one is a checkout nothing can name — which since #88 is
 * cannot-establish rather than an ordinary dispatch. Pass `slug: ''` to model
 * exactly that.
 */
const run = (argv, options = {}) => {
  const { runner, calls } = fakeOrca(options.orca ?? {});
  const root = options.root ?? repo();
  const home = options.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  const sessions = join(home, 'sessions');
  mkdirSync(sessions, { recursive: true });

  // The Run this session's receiver consumes, from the peer registry — never
  // invented, and the dispatch refuses without it.
  if (options.registry !== false) {
    mkdirSync(join(home, '.omp', 'run', 'orca-peers'), { recursive: true });
    writeFileSync(join(home, '.omp', 'run', 'orca-peers', 'term_me.json'), JSON.stringify({ run: 'run_owner' }));
  }

  const started = [];
  const result = capture(() =>
    dispatch([...argv], {
      runner: options.runnerOverride ?? runner,
      exec: (bin, args, at) => {
        if (bin === 'gh' && args[0] === 'repo') {
          const slug = options.slug ?? 'acme/widgets';
          return slug === '' ? { status: 1, stdout: '', stderr: 'gh: no auth token\n' } : { status: 0, stdout: `${slug}\n`, stderr: '' };
        }
        return options.exec ? options.exec(bin, args, at) : { status: 0, stdout: '', stderr: '' };
      },
      env: { HOME: home, ORCA_TERMINAL_HANDLE: 'term_me', ORCA_DISPATCH_STORE: store, AX_DISPATCH_SPEC_DIR: join(home, 'specs'), AX_DISPATCH_TICK: '1', AX_DISPATCH_SEE_WAIT: '0', ...options.env },
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

test('an unreadable --notes file is refused before the ticket is even read', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--notes', '/nonexistent/wave-memory.md']);
  assert.equal(r.code, 1);
  assert.match(r.out, /--notes file unreadable/);
  assert.deepEqual(r.calls, [], 'nothing is read when the arguments already refuse');
});

// Measured 2026-09-03: #78 was closed by the operator at 05:19Z and dispatched
// at 13:xx through the `--slug` + `--because` path, which never consults the
// frontier. The child refused at its decision gate, posted nothing, and a pane
// was minted and released for a ticket nobody could work. The frontier already
// excludes `no-longer-open`; the verb must refuse the same state itself, before
// any mutation, because the verb can be reached without the frontier.
test('a closed ticket is refused before any mutation, with the repair on its own tracker', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG], { orca: { state: { name: 'Done', type: 'completed' } } });
  assert.equal(r.code, 1);
  assert.match(r.out, /GAP-353 is closed \(Done\)/);
  assert.match(r.out, /nothing to dispatch/);
  // `ax frontier` reads GitHub only; a Linear ticket is sent back to Linear.
  assert.match(r.out, /orca linear issue GAP-353 --json/);
  assert.doesNotMatch(r.out, /ax frontier/);
  assert.deepEqual(r.started, []);
  assert.ok(r.calls.every(argv => !argv.includes('worktree create') && !argv.includes('task-create')), r.calls.join(' | '));

  const canceled = run(['--issue', ISSUE, '--slug', SLUG], { orca: { state: { name: 'Canceled', type: 'canceled' } } });
  assert.equal(canceled.code, 1);
  assert.deepEqual(canceled.started, []);
});

test('a ticket whose state the tracker did not answer cannot establish — absence is never permission to mutate', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG], { orca: { state: { name: 'In Progress' } } });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /CANNOT ESTABLISH — GAP-353 answered no workflow state type/);
  assert.match(r.out, /orca linear issue GAP-353 --json/);
  assert.deepEqual(r.started, []);
  assert.ok(r.calls.every(argv => !argv.includes('worktree create') && !argv.includes('task-create')), r.calls.join(' | '));
});

test('the retired --brief is refused BY NAME, with --notes named as the repair', () => {
  // 0.16.0 renamed the flag and published the contract that "every retired name
  // refuses with the replacement named rather than falling back silently". The
  // verb, env and config layers pay it; this flag answered a bare
  // unknown-argument usage line, so the operator was told which name is wrong
  // and never which one is right.
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--brief', '/tmp/nope.md']);
  assert.equal(r.code, 2, 'the argument lane already answers 2 here, and callers branch on it');
  assert.match(r.out, /--brief/);
  const usageAt = r.out.indexOf('ax worker dispatch (--issue');
  const repairAt = r.out.indexOf('--notes');
  assert.ok(repairAt !== -1 && usageAt !== -1 && repairAt < usageAt, 'the replacement is named ABOVE the usage line, not merely listed inside it');
  assert.deepEqual(r.calls, [], 'no binary is consulted for an argument that already refuses');
  assert.deepEqual(r.started, []);

  // The value that follows a retired flag is never consumed and never read: the
  // flag is what refuses, whether the path exists or not.
  const alone = run(['--issue', ISSUE, '--slug', SLUG, '--brief']);
  assert.equal(alone.code, 2);
  assert.ok(alone.out.indexOf('--notes') < alone.out.indexOf('ax worker dispatch (--issue'));
});

test('an unknown argument that is NOT retired keeps its message, with no invented repair', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--breif', '/tmp/nope.md']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument "--breif"/);
  assert.ok(!/retired/.test(r.out), 'a name absent from the map buys no repair');
});

test('a project that declares no entry point must be given --task', () => {
  const root = repo();
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' } }));
  const bare = run(['--issue', ISSUE, '--slug', SLUG], { root });
  assert.equal(bare.code, 1);
  assert.match(bare.out, /declares no dispatch entry point/);
  // A key PATH says which setting is missing and not what to write: `dispatch`
  // may not exist at all in this file, and `dispatch.entry "<verb>"` is not
  // something any config accepts if pasted. So the repair is the JSON to paste.
  assert.match(bare.out, /\{ "dispatch": \{ "entry": "<verb>" \} \}/);
  assert.match(bare.out, /--task/, 'the other route out stays named on the same line');

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

test('--run is refused: a dispatch cannot name a Run its own receiver does not consume', () => {
  // peers.mjs states the rule this closes: the Run is never a flag, because a
  // guessed one sends the child's completion report to a session that will
  // never read it. The refusal above used to PRESCRIBE `--run`, and a Run minted
  // by hand from an unregistered session is precisely that void — the report is
  // addressed, accepted, and consumed by nobody.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const empty = run(['--issue', ISSUE, '--slug', SLUG, '--run', 'run_minted', '--wait', '0'], { registry: false, root });
  assert.equal(empty.code, 2, 'refused on the argument alone, before anything is read');
  assert.match(empty.out, /--run is not a dispatch input/);
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

// ── --task over a ticket the tracker calls complete ──────────────────────────
// R4/KTD3. `ready-for-agent` is not decoration: it is the tracker's own
// assertion that this ticket's body IS the assignment. `--task` replaces that
// assignment with one the ticket never carried, so an orchestrator that reaches
// for it on a ready ticket is either working around a label that is wrong or
// discarding a brief it did not read — and only it can say which. The predicate
// is the LABEL, never the body: a body that exists and underdetermines the work
// stays the child's own gate (worker-ticket.test.mjs pins that boundary).

test('the label dispatch refuses on is the one triage APPLIES, spelled once per layer', () => {
  // `src/worker/ticket.mjs` declares its own copy rather than importing this
  // one, because six triage modules read `worker` and one import back would make
  // the dependency mutual. The equality is therefore a proposition, held here:
  // without it, either string could move and the refusal would simply stop
  // refusing — the silent failure a label-keyed gate is most exposed to.
  assert.equal(TICKET_READY_LABEL, READY_LABEL);
});

test('--task over a ready-for-agent ticket is refused, and --because is the one way through', () => {
  const ready = () => {
    const root = repo();
    provisioned(root, `${ISSUE}-${SLUG}`);
    return root;
  };

  const barred = run(['--issue', ISSUE, '--slug', SLUG, '--task', '/lfg GAP-353', '--wait', '0'], {
    root: ready(),
    orca: { labels: [READY_LABEL] },
  });
  assert.equal(barred.code, 1);
  assert.match(barred.out, new RegExp(READY_LABEL));
  // The repair is the project's DECLARED entry, verbatim — nothing here invents a
  // verb, and an operator cannot copy a route this repo does not have.
  assert.match(barred.out, /\/entry GAP-353/);
  // Copy-pasteable, quotes included: the override has to be typeable from the
  // refusal alone, or the only route through it is guesswork.
  assert.ok(barred.out.includes("--because '"), 'the refusal must print the override it accepts');
  assert.deepEqual(barred.started, [], 'a refused dispatch creates nothing');
  assert.ok(barred.calls.every(argv => !argv.startsWith('worktree create')));

  // A task carrying a single quote still prints a COPY-RUNNABLE repair: the
  // interpolation goes through the POSIX quoting helper, never a bare '…'.
  const quoted = run(['--issue', ISSUE, '--slug', SLUG, '--task', "ship it's decided", '--wait', '0'], {
    root: ready(),
    orca: { labels: [READY_LABEL] },
  });
  assert.equal(quoted.code, 1);
  assert.ok(quoted.out.includes("--task 'ship it'\\''s decided'"), 'the printed repair single-quotes the task POSIX-safely');

  // Said out loud, the dispatch proceeds — and the reason is recorded with it,
  // because "why was this ticket's own brief overridden" is a question asked
  // weeks later, of the record, by someone who was not in the room.
  const told = run(['--issue', ISSUE, '--slug', SLUG, '--task', '/lfg GAP-353', '--because', 'the plan link on the ticket 404s', '--wait', '0'], {
    root: ready(),
    orca: { labels: [READY_LABEL] },
  });
  assert.equal(told.code, 0);
  assert.equal(told.started.length, 1);
  assert.match(told.started[0], /--because the plan link on the ticket 404s/, 'the reason travels with the recorded dispatch');
});

test('--because without --task is a recorded redispatch reason, never a usage error', () => {
  // KTD6's dead-route recovery: the ticket stays the assignment (no --task),
  // the fresh --slug mints the fresh request id, and --because records WHY a
  // second dispatch exists — the question the record is asked weeks later.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--because', 'gate-refusal', '--wait', '0'], { root });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.started.length, 1);
  assert.match(r.started[0], /--because gate-refusal/, 'the reason travels with the recorded dispatch');
});

// The dispatch store is host-global; a record must NAME its repository or a
// `42-api.json` from another checkout hides this repository's #42 forever, and
// `ax worker release` cannot place its pane. Until 2026-09-03 the name came
// from the ticket's URL, so `--name` and every Linear ticket recorded none —
// unplaceable by construction (review of #118). The name is now the identity
// of the CHECKOUT that dispatches — `gh repo view`'s nameWithOwner, the same
// read the frontier and release compare against — and the ticket URL is only
// the fallback for a checkout whose forge `gh` cannot name.
test('the record names the dispatching checkout, whatever the tracker — the ticket URL only as fallback', () => {
  assert.equal(trackerRepoOf('https://github.com/gapilabs/gapila/issues/42'), 'gapilabs/gapila');
  assert.equal(trackerRepoOf('https://ghe.example.com/owner/repo/issues/7'), 'owner/repo');
  assert.equal(trackerRepoOf('https://linear.test/GAP-353'), '');

  // A Linear ticket, from a checkout gh can name: the checkout's identity.
  const linear = repo();
  provisioned(linear, `${ISSUE}-${SLUG}`);
  const l = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root: linear, slug: 'flosrn/ax' });
  assert.equal(l.code, 0, l.out);
  assert.match(l.started[0], /--tracker-repo flosrn\/ax/, 'a Linear ticket records the checkout that dispatched it');

  // No ticket at all, same checkout: still the checkout's identity.
  const named = repo();
  provisioned(named, 'pilot-smoke');
  const n = run(['--name', 'pilot-smoke', '--task', 'smoke the pilot', '--wait', '0'], { root: named, slug: 'flosrn/ax', request: 'pilot-smoke' });
  assert.equal(n.code, 0, n.out);
  assert.match(n.started[0], /--tracker-repo flosrn\/ax/, 'a --name dispatch records the checkout that dispatched it');

  // A checkout gh cannot name, and a non-GitHub ticket: nothing to record — and
  // since #88 nothing to count either, so the dispatch only happens at all when
  // a declared machineCap bounds this machine instead. The record still names no
  // repository: unknown, never guessed (F-028).
  const noForge = repo({ dispatch: { machineCap: 4 } });
  provisioned(noForge, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root: noForge, slug: '' });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.started[0], /--tracker-repo/, 'no forge and no GitHub-shaped URL writes no repo key — unknown, never guessed');
});

test('a ticket the tracker has NOT called complete takes --task with no reason asked', () => {
  // The label is the whole predicate. Every other ticket keeps the route it had:
  // an untriaged one, and (below) one whose body is empty — where the label would
  // be a false assertion anyway, so it is the empty-body gate that owns the case.
  const untriaged = () => {
    const root = repo();
    provisioned(root, `${ISSUE}-${SLUG}`);
    return root;
  };
  const other = run(['--issue', ISSUE, '--slug', SLUG, '--task', '/lfg GAP-353', '--wait', '0'], {
    root: untriaged(),
    orca: { labels: ['domain:web'] },
  });
  assert.equal(other.code, 0);

  const empty = run(['--issue', ISSUE, '--slug', SLUG, '--task', '/lfg GAP-353', '--wait', '0'], {
    root: untriaged(),
    orca: { emptyBody: true, labels: [READY_LABEL] },
  });
  assert.equal(empty.code, 0, 'zero characters cannot be a complete assignment, whatever the label claims');
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

// ── the caps, before anything is created (#88) ────────────────────────────────
// This verb enforced NOTHING: measured 2026-09-02, it admitted a 4th and 5th
// pane without a word while `ax triage dispatch` refused at the same moment,
// against the same store, on the same machine. Two verbs, one machine, two cap
// semantics — and the count `ax worker ls` labelled "the cap count" gated
// neither.

/** A live pane already recorded in the store, placed in the repository it names. */
function livePane(store, request, { handle, dispatchId = `ctx-${request}`, repo = 'acme/widgets', on = '' } = {}) {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      orca: 'stub-orca',
      createdAt: '2026-09-02T10:00:00.000Z',
      ...(repo === '' ? {} : { repo }),
      attempts: [
        {
          n: 1,
          settled: false,
          phases: [
            {
              name: 'worker-start',
              identity: `id-${request}`,
              argv: ['stub-orca', 'orchestration', 'worker-start', ...(on === '' ? [] : ['--on', on])],
              beganAt: '2026-09-02T10:00:00.000Z',
              exit: 0,
              receipt: { ok: true, result: { dispatchId, state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: handle }] } },
            },
          ],
        },
      ],
    }),
  );
}

test('#88: a remote pane the local scope omits, confirmed by its declared host, IS capacity', () => {
  // `ax worker ls` has counted it since #76; the fence counted the local list
  // alone. On this Mac the local scope omits a remote runtime, so a repository
  // with a working remote child had no cap at all.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'far-1', { handle: 'term_far', on: 'gapicore' });
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    home,
    root: repo({ dispatch: { cap: 1, hosts: { gapicore: { ssh: 'orca@vps' } } } }),
    orca: { terminals: [{ handle: 'term_me', worktreePath: '/parent/wt' }], hostTerminals: { gapicore: [{ handle: 'term_far' }] } },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /1 live pane\(s\) in acme\/widgets \+ 1 new > dispatch\.cap 1/);
  assert.deepEqual(r.started, []);
});

test('#88: one over dispatch.cap is refused, and NOTHING is created', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'gap-1-work', { handle: 'term_a' });
  livePane(store, 'gap-2-work', { handle: 'term_b' });
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    home,
    root: repo({ dispatch: { cap: 2 } }),
    orca: { terminals: [{ handle: 'term_a' }, { handle: 'term_b' }, { handle: 'term_me', worktreePath: '/parent/wt' }] },
  });
  assert.equal(r.code, 1, 'a refusal, so nothing was created');
  assert.match(r.out, /2 live pane\(s\) in acme\/widgets \+ 1 new > dispatch\.cap 2/);
  assert.match(r.out, /raise dispatch\.cap/);
  assert.deepEqual(r.started, [], 'no dispatch was issued');
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'and no worktree was placed');
});

test('#88: panes belonging to another repository do not consume this one’s cap', () => {
  // The reported cost: a full orchestrator turn spent deciding whether it was
  // allowed to dispatch at all, because the only count it could read was
  // machine-wide.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'far-1', { handle: 'term_x', repo: 'goodluckagency/ofmchat' });
  livePane(store, 'far-2', { handle: 'term_y', repo: 'goodluckagency/ofmchat' });
  livePane(store, 'far-3', { handle: 'term_z', repo: '' });
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], {
    home,
    root: repo({ dispatch: { cap: 2 } }),
    orca: { terminals: [{ handle: 'term_x' }, { handle: 'term_y' }, { handle: 'term_z' }, { handle: 'term_me', worktreePath: '/parent/wt' }] },
  });
  assert.equal(r.code, 0, "another checkout's wave is not this repository's cap");
  assert.match(r.out, /0 live pane\(s\) in acme\/widgets/);
  assert.match(r.out, /3 live pane\(s\) on this machine/);
  assert.match(r.out, /1 .*name no repository/, 'a record naming none counts toward the machine total only (F-028)');
});

test('#88: an armed dispatch.machineCap refuses on the machine total, naming the ceiling', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'far-1', { handle: 'term_x', repo: 'goodluckagency/ofmchat' });
  livePane(store, 'far-2', { handle: 'term_y', repo: 'goodluckagency/ofmchat' });
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    home,
    root: repo({ dispatch: { cap: 3, machineCap: 2 } }),
    orca: { terminals: [{ handle: 'term_x' }, { handle: 'term_y' }, { handle: 'term_me', worktreePath: '/parent/wt' }] },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /2 live pane\(s\) on this machine \+ 1 new > dispatch\.machineCap 2/);
  assert.match(r.out, /0 of them in acme\/widgets/);
  assert.deepEqual(r.started, []);
});

test('#88: a checkout gh cannot name AUTHORIZES NO DISPATCH — exit 3, and nothing created', () => {
  // Ruled 2026-09-03: `gh repo view` is what places a record in a repository,
  // so without it `dispatch.cap` has no count to gate — and an unmeasurable cap
  // is an inability, not room (F-028). A mutation never proceeds on a container
  // that could not be read, and the repair names both routes out.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'far-1', { handle: 'term_x', repo: 'goodluckagency/ofmchat' });
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    home,
    root: repo({ dispatch: { cap: 1 } }),
    slug: '',
    orca: { terminals: [{ handle: 'term_x' }, { handle: 'term_me', worktreePath: '/parent/wt' }] },
  });
  assert.equal(r.code, 3, 'cannot-establish: about the machine, never about the ticket');
  assert.match(r.out, /CANNOT ESTABLISH/);
  assert.match(r.out, /NOT MEASURED/);
  assert.match(r.out, /origin/, 'route one: make gh able to name this checkout');
  assert.match(r.out, /dispatch\.machineCap/, 'route two: declare the ceiling that bounds it');
  assert.deepEqual(r.started, [], 'nothing was dispatched');
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'and nothing was created');
});

test('#88: a declared machineCap BOUNDS a checkout gh cannot name, so the dispatch proceeds', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'far-1', { handle: 'term_x', repo: 'goodluckagency/ofmchat' });
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], {
    home,
    root: repo({ dispatch: { cap: 1, machineCap: 4 } }),
    slug: '',
    orca: { terminals: [{ handle: 'term_x' }, { handle: 'term_me', worktreePath: '/parent/wt' }] },
  });
  assert.equal(r.code, 0, 'a bounded mutation may proceed');
  assert.match(r.out, /NOT MEASURED/, 'with the absent per-repository count still disclosed');
  assert.match(r.out, /dispatch\.machineCap 4/, 'and the ceiling named as what bounds it');
});

test('#88: a pane of THIS repository on an unaskable host authorizes no dispatch — exit 3', () => {
  // The P1 review finding on PR #129: excluding an unknown pane from the count
  // makes the count understated, and a fence built on it can admit a pane past
  // a cap that is already full.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'mine-far', { handle: 'term_far', on: 'gapicore' });
  const r = run(['--issue', ISSUE, '--slug', SLUG], {
    home,
    root: repo({ dispatch: { cap: 3, hosts: { gapicore: { ssh: 'orca@vps' } } } }),
    orca: { terminals: [{ handle: 'term_me', worktreePath: '/parent/wt' }], hostTerminals: { other: [] } },
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /cannot be established/);
  assert.match(r.out, /1 pane\(s\) in acme\/widgets/);
  assert.match(r.out, /host 'gapicore' could not be asked/);
  assert.deepEqual(r.started, []);
});

test('#88: an unaskable host in ANOTHER repository stops nothing until a ceiling is armed', () => {
  // The other edge of the same rule: treating it as an inability would park this
  // repository on another checkout's unreachable host, which is #88 through a
  // new door. Armed, the ceiling counts every pane, so it becomes unmeasurable.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'far-1', { handle: 'term_far', repo: 'goodluckagency/ofmchat', on: 'gapicore' });
  const hosts = { gapicore: { ssh: 'orca@vps' } };
  const orca = { terminals: [{ handle: 'term_me', worktreePath: '/parent/wt' }], hostTerminals: { other: [] } };

  const unarmed = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], {
    home,
    root: repo({ dispatch: { cap: 3, hosts } }),
    orca,
  });
  assert.equal(unarmed.code, 0, "another repository's unreachable host is not this repository's fence");
  assert.match(unarmed.out, /stop nothing|in neither count/);

  const armed = run(['--issue', ISSUE, '--slug', SLUG], {
    home,
    root: repo({ dispatch: { cap: 3, machineCap: 2, hosts } }),
    orca,
  });
  assert.equal(armed.code, 3, 'an armed ceiling counts every pane, so an unknown one makes its number unmeasurable');
  assert.match(armed.out, /machine total dispatch\.machineCap 2/);
  assert.deepEqual(armed.started, []);
});

test('#88: a dead pane is not capacity, and the cap is counted from records, not from the sidebar', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  livePane(store, 'gap-1-work', { handle: 'term_gone' });
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], {
    home,
    root: repo({ dispatch: { cap: 1 } }),
    // The recorded pane is orphaned; the other three belong to no record at all.
    orca: {
      terminals: [
        { handle: 'term_gone', orphaned: true },
        { handle: 'term_me', worktreePath: '/parent/wt' },
        { handle: 'term_editor' },
      ],
    },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /0 live pane\(s\) in acme\/widgets/);
});

test('#88: an unreadable dispatch record cannot establish a cap, and dispatches nothing', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'gap-9-work.json'), '{ not json');
  const r = run(['--issue', ISSUE, '--slug', SLUG], { home });
  assert.equal(r.code, 3, 'an absence of information is not an absence of a child (F-028)');
  assert.match(r.out, /cannot be read/);
  assert.deepEqual(r.started, []);
});

// ── ONE READER, THREE VERBS (#161, ruled shape 2 by the maintainer 2026-09-04) ─
// The dispatch index answers "which dispatch owns this record", and by its own
// authority rule only a `worker-start` phase may name one. Capacity is a
// different question — is this pane consuming a slot — and a pane recorded by
// the bash-era `--inject` repair lives in a `worker-start-inject` phase, so it
// carries no handle in that index: `ax worker ls` showed it VIVANT (a77e40b)
// while both fences counted zero, and a dispatch was admitted past a full cap.
//
// `ls` is imported here on purpose: the proposition is that ONE number answers
// both verbs, and it cannot be pinned inside either suite alone.

/**
 * The F-048 record shape, as the bash era left it on this machine's store: a
 * `worker-start` that failed with no effects at all, repaired by an injected
 * dispatch whose own phase carries the agent pane.
 */
function injectRepaired(store, request, { handle, repo: named = 'acme/widgets' } = {}) {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      orca: 'stub-orca',
      createdAt: '2026-09-04T10:00:00.000Z',
      ...(named === '' ? {} : { repo: named }),
      attempts: [
        {
          n: 1,
          settled: false,
          phases: [
            {
              name: 'task-create',
              identity: `id-${request}-task`,
              argv: ['stub-orca', 'orchestration', 'task-create'],
              exit: 0,
              receipt: { ok: true, result: { task: { id: 'task_live' }, mutation: { requestId: 'r', replayed: false } } },
            },
            {
              name: 'worker-start',
              identity: `id-${request}`,
              argv: ['stub-orca', 'orchestration', 'worker-start'],
              exit: 1,
              receipt: { ok: false, error: { code: 'agent_readiness', message: 'timeout' } },
            },
            {
              name: 'worker-start-inject',
              identity: `id-${request}-inject`,
              argv: ['stub-orca', 'orchestration', 'worker-start-inject'],
              beganAt: '2026-09-04T10:05:00.000Z',
              exit: 0,
              receipt: {
                ok: true,
                result: {
                  dispatchId: 'ctx_live',
                  state: 'ready',
                  effects: [{ kind: 'terminal', role: 'agent', action: 'reused_agent_terminal', id: handle }],
                },
              },
            },
          ],
        },
      ],
    }),
  );
}

/** The listing, run against a store this file also puts a dispatch through. */
const listing = (store, root, orca) => {
  const { runner } = fakeOrca(orca);
  return capture(() =>
    ls([], {
      runner,
      exec: (bin, args) => (bin === 'gh' && args[0] === 'repo' ? { status: 0, stdout: 'acme/widgets\n', stderr: '' } : { status: 0, stdout: '', stderr: '' }),
      env: { ORCA_DISPATCH_STORE: store },
      cwd: root,
    }),
  );
};

test('#161: a pane recorded by a repair phase is one slot in ls AND in the fence', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  injectRepaired(store, 'gap-353-u3', { handle: 'term_live' });
  const root = repo({ dispatch: { cap: 1 } });
  const orca = { terminals: [{ handle: 'term_live' }, { handle: 'term_me', worktreePath: '/parent/wt' }] };

  const listed = listing(store, root, orca);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /1 live pane\(s\) in acme\/widgets/, 'the pane is up, whichever phase recorded it');

  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], { home, root, orca });
  assert.equal(r.code, 1, 'one number for one question: the cap the listing filled is the cap that refuses');
  assert.match(r.out, /1 live pane\(s\) in acme\/widgets \+ 1 new > dispatch\.cap 1/);
  assert.deepEqual(r.started, []);
});

test('#161: two records naming one pane are one slot, in both verbs', () => {
  // A repair REUSES the agent terminal, so the injected phase and the record of
  // the request it repaired can name one handle. Counting rows there would
  // report two panes for one and refuse a dispatch the machine had room for.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  injectRepaired(store, 'gap-353-u3', { handle: 'term_live' });
  livePane(store, 'gap-353-u4', { handle: 'term_live', dispatchId: 'ctx_reuse' });
  const root = repo({ dispatch: { cap: 2 } });
  const orca = { terminals: [{ handle: 'term_live' }, { handle: 'term_me', worktreePath: '/parent/wt' }] };

  const listed = listing(store, root, orca);
  assert.match(listed.out, /1 live pane\(s\) in acme\/widgets/, 'one terminal, one slot');

  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], { home, root, orca });
  assert.equal(r.code, 0, 'the fence counts the same one, so the room is real');
  assert.match(r.out, /1 live pane\(s\) in acme\/widgets/);
});

// ── placement ────────────────────────────────────────────────────────────────

test('a worktree that already exists for the ticket is reused, and still proven habitable', () => {
  // `worktree create` carries no --retry-request, so a create that strands
  // cannot be replayed: finding the first tree IS the countermeasure. But the
  // dispatch that made it may be exactly the one that died before provisioning it,
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

test('#84: the tree Orca placed OUTSIDE .worktrees is this ticket\u2019s tree, so a retry mints no -2', () => {
  // The reported dispatch placed through Orca — which places into its own
  // workspaces root, not `<root>/.worktrees` — and then failed
  // `ax worktree setup`, correctly recording nothing and correctly leaving the
  // tree. The retry asked for a second one, and Orca disambiguated the taken
  // name by suffix: two worktrees, two branches, one ticket, and a request id
  // that no longer named its own worktree.
  const root = repo();
  const workspaces = realpathSync(mkdtempSync(join(tmpdir(), 'ax-workspaces-')));
  const tree = join(workspaces, REQUEST);
  assert.equal(addWorktree({ cwd: root, path: tree, branch: `feat/${REQUEST}` }).ok, true);

  const setups = [];
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], {
    root,
    orca: { workspaces: [tree] },
    setupFn: (argv, context) => {
      setups.push(context.cwd);
      mkdirSync(join(context.cwd, '.agent'), { recursive: true });
      writeFileSync(join(context.cwd, CONTEXT_PATH), '- Web URL: `http://probe.test:3100`\n');
      return 0;
    },
  });

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /reusing the worktree that already exists/);
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')), 'no second create, so nothing is there to suffix');
  assert.deepEqual(setups, [tree], 'a tree that never finished provisioning is lent, and provisioned');
  assert.match(r.started[0], new RegExp(`--worktree path:${tree}`));
});

test('a config refusal in a checkout carrying another ax than the one running names the skew (#84)', () => {
  // `1 problem(s) in ax.config.json` was the whole diagnostic when a global
  // 0.17.0 validated a 0.18.0-dev config, and its only readable repair — edit
  // the config — was the wrong one.
  const root = repo();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@flosrn/ax', version: '0.0.1-skewed' }));
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'p' }, apps: { web: 5 } }));
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root });

  assert.equal(r.code, 1, 'the exit code is untouched');
  assert.match(r.out, /problem\(s\) in ax\.config\.json/);
  assert.match(r.out, /0\.0\.1-skewed/);
  assert.match(r.out, /own ax/);
  assert.deepEqual(r.started, [], 'nothing was dispatched');
  assert.ok(r.calls.every(argv => !argv.startsWith('worktree create')));
});

test("a ticket labelled as touching the database is provisioned with its own stack", () => {
  // Measured 2026-08-25 on ofmchat #71 (`domain:database`, `domain:security`):
  // the plan decides shared-vs-isolated from the DIFF of the tree it is
  // provisioning, and that tree is seconds old and empty — so the one ticket
  // whose whole subject was the database was told "this worktree does not touch
  // the database", and its child then reset a stack the primary checkout and
  // every other sharing worktree depend on.
  const root = repo({ dispatch: { databaseLabels: ['domain:database'] } });
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
  const declared = repo({ dispatch: { databaseLabels: ['domain:database'] } });
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
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', worktreeTool: 'place' } }));
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

test('a worktree tool that prints a RELATIVE path is resolved, not passed on as one', () => {
  // The schema asks the tool to print "the path" and does not demand an absolute
  // one, and `existsSync` answers true for a repository-relative path whenever
  // the dispatch runs from the repository — so a relative answer used to travel
  // all the way through: `--worktree path:.worktrees/…` for a runtime that
  // resolves selectors against ITS OWN cwd, and (review of PR #141, P2) a
  // Report path that cannot be established while placement succeeded. It is
  // resolved where it is accepted, once, so every consumer downstream holds one
  // absolute path.
  const root = repo();
  const tree = join(root, '.worktrees', 'placed-by-tool');
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', worktreeTool: 'place' } }));
  const exec = (bin, args, at) => {
    if (bin !== 'place') return { status: 0, stdout: '', stderr: '' };
    assert.equal(at, root, 'the tool runs in the dispatch cwd, which is what its relative path is relative to');
    mkdirSync(join(tree, '.agent'), { recursive: true });
    writeFileSync(join(tree, CONTEXT_PATH), '- Web URL: `http://x`\n');
    return { status: 0, stdout: 'bootstrapping…\n.worktrees/placed-by-tool\n', stderr: '' };
  };

  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, exec });
  assert.equal(r.code, 0);
  assert.match(r.started[0], new RegExp(`--worktree path:${tree}`), 'the selector Orca is given is absolute');
  const expected = reportPathFor({ worktree: tree, request: REQUEST }).path;
  assert.ok(r.out.includes(expected), `the child's Report path is established: ${expected}`);
});

test('a placement tool that fails refuses, and dispatches nothing', () => {
  const root = repo();
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', worktreeTool: 'place' } }));
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
  // is also the tree a second dispatch will reuse rather than duplicate.
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

test('a placement Orca cannot SEE stops the pipeline before any dispatch', () => {
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

// ── placement onto a declared host (#103) ────────────────────────────────────
// A retry after a refused setup used to ask the host for a second top-level
// tree, and Orca suffixes a taken name: one ticket, two trees, two branches on
// a machine nothing here lists. The reuse question is the local one transposed
// — the host's own listing, under the root the host itself reports.

const FAR = { project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', hosts: { far: { ssh: 'far-host' } } } };
const onFar = () => {
  const root = repo();
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify(FAR));
  return root;
};

test('a --on dispatch reuses the tree the host already carries, instead of new-top-level', () => {
  const tree = '/srv/orca/probe/.worktrees/gap-353-loading-states';
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--on', 'far', '--repo-id', 'abc', '--wait', '0'], {
    root: onFar(),
    orca: {
      repos: [{ id: 'abc', path: '/srv/orca/probe', worktreeBasePath: '.worktrees' }],
      hostTrees: [{ path: tree, isMainWorktree: false, repoId: 'abc' }],
    },
  });

  assert.equal(r.code, 0);
  assert.equal(r.started.length, 1);
  assert.match(r.started[0], new RegExp(`--worktree id:abc::${tree}`), 'the record’s own selector, composed by nothing');
  assert.doesNotMatch(r.started[0], /new-top-level/, 'and no second tree is asked for');
  assert.match(r.out, /reusing/);
});

test('no tree on the host keeps today’s remote argv, byte for byte', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--on', 'far', '--repo-id', 'abc', '--wait', '0'], { root: onFar() });

  assert.equal(r.code, 0);
  assert.match(r.started[0], /--on far --worktree new-top-level --repo id:abc --name gap-353-loading-states --agent omp/);
});

test('a candidate the host places outside its reported root dispatches NOTHING', () => {
  const tree = '/srv/orca/probe/hand-made/gap-353-loading-states';
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--on', 'far', '--repo-id', 'abc', '--wait', '0'], {
    root: onFar(),
    orca: {
      repos: [{ id: 'abc', path: '/srv/orca/probe', worktreeBasePath: '.worktrees' }],
      hostTrees: [{ path: tree, isMainWorktree: false, repoId: 'abc' }],
    },
  });

  assert.equal(r.code, 3, 'cannot-establish: about the host, never about the ticket');
  assert.ok(r.out.includes(tree), 'the candidate is named');
  assert.match(r.out, /--worktree id:abc::/, 'both repairs, and this is the one that has to work');
  assert.deepEqual(r.started, [], 'no dispatch, and no second tree minted on the host');
});

test('--worktree with --on takes an exact remote selector, and reaches the dispatch', () => {
  const selector = 'id:abc::/srv/orca/probe/.worktrees/kept';
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--on', 'far', '--repo-id', 'abc', '--worktree', selector, '--wait', '0'], { root: onFar() });

  assert.equal(r.code, 0, 'the route the refusal advertises is a route');
  assert.doesNotMatch(r.out, /is not a directory on this host/);
  assert.ok(r.started[0].includes(`--worktree ${selector}`), r.started[0]);
  assert.ok(r.calls.every(line => !line.startsWith('worktree list --repo id:abc --environment')), 'an explicit selector asks the host nothing');
});

test('--worktree with --on refuses a local path spelling, naming the forms a host resolves', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--on', 'far', '--repo-id', 'abc', '--worktree', '/srv/orca/probe/.worktrees/kept', '--wait', '0'], { root: onFar() });

  assert.equal(r.code, 1);
  assert.match(r.out, /exact remote selector/);
  assert.match(r.out, /id:<repo-id>::<path>/);
  assert.deepEqual(r.started, []);
});

test('a LOCAL --worktree keeps its existence guard', () => {
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--worktree', '/nonexistent/tree', '--wait', '0']);

  assert.equal(r.code, 1);
  assert.match(r.out, /is not a directory on this host/);
  assert.deepEqual(r.started, []);
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
  // A tree reused from an earlier dispatch already carries a parent. Reading "some
  // parent" back would report success over a `set` Orca discarded — which is
  // exactly the shape F-002 is about.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--wait', '0'], { root, orca: { parent: 'repo-id::/somebody/else' } });

  assert.equal(r.code, 0, 'a degraded report channel never costs the slice');
  assert.match(r.out, /not the \/parent\/wt this dispatch set/);
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
    JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', hosts: { far: { ssh: 'far-host' } } } }),
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
  // A ticketed dispatch with no declared contract gets the TRACKED mechanics —
  // the other half of the choice `renderBrief` makes once dispatch stops
  // filling the contract slot itself.
  assert.match(r.out, /Keep the ticket current yourself/);
  assert.doesNotMatch(r.out, /There is NO ticket for this work/);
  assert.deepEqual(r.started, [], 'a dry run dispatches nothing');
  assert.ok(r.calls.every(argv => !argv.includes('worktree set')), 'and sets no lineage');
});

test('the brief a dispatch composes names the Report path the record rule answers', () => {
  // `docs/adr/0002`: the child is told where its Report goes in the last text it
  // reads, and the location is derived — never a path the worker names. This is
  // the whole join: the worktree this dispatch is about to place a child in, and
  // the request id it is about to record, crossing the one rule in
  // src/worker/report.mjs. A dry run answers it before anything is created,
  // which is what makes the path readable BEFORE a child depends on it.
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const r = run(['--issue', ISSUE, '--slug', SLUG, '--dry-run'], { root });

  assert.equal(r.code, 0);
  const expected = reportPathFor({ worktree: join(root, '.worktrees', `${ISSUE}-${SLUG}`), request: REQUEST }).path;
  assert.ok(expected, 'the fixture placement resolves a path');
  assert.ok(r.out.includes(expected), `the brief must carry ${expected}`);
  assert.match(r.out, /this brief wins/, 'and the precedence rule that lets it override the preamble');
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
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, env: { AX_DISPATCH_EQUIP_WAIT: '0' } });

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
  assert.deepEqual(r.started, [], 'a declared loader that loads nothing is not a dispatch');
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
  assert.match(r.out, /ax init {3}# then settle this dispatch and re-dispatch/);
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
  // Both remote dispatches on record hit it, which makes the recovery the ordinary
  // path rather than an anomaly. Typing it by hand is what used to drop the
  // verification: the verb exited and the operator resumed from a fresh shell,
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
  assert.match(r.out, /Do NOT re-dispatch/);
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

test('a child on its BOOT model is exit 3, and says not to dispatch again', () => {
  const root = repo();
  provisioned(root, `${ISSUE}-${SLUG}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  transcript(join(home, 'sessions'), `${ISSUE}-${SLUG}`, null);
  const r = run(['--issue', ISSUE, '--slug', SLUG], { root, home });

  assert.equal(r.code, 3);
  assert.match(r.out, /runs its BOOT model/);
  assert.match(r.out, /Do NOT re-dispatch/);
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
  // Measured 2026-08-26 (ofmchat, two dispatches of a live wave): the receipt said
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
  // dispatch would find the first one's tree and place a child into it.
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
    assert.match(r.out, new RegExp(`ax worker dispatch --name ${suggestion}$`, 'm'), `${given} should suggest ${suggestion}`);
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
  // With a ticket, `dispatch.entry` composes `<entry> GAP-353` and the body carries
  // the rest. A name has neither, so a dispatch that let this through would place
  // a child holding `/entry loading-states` and nothing else — the 2026-08-01
  // failure with better spelling.
  const r = run(['--name', 'loading-states']);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing here knows what "loading-states" means/);
  assert.match(r.out, /--task "<instruction>"/);
  assert.deepEqual(r.started, []);
});

test('a named dispatch reads no ticket, and its brief never points at one', () => {
  const root = repo();
  const r = run(['--name', 'loading-states', '--task', 'fix the skeletons', '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.ok(
    r.calls.every(argv => !argv.includes('linear issue') && !argv.includes('issue view')),
    `a tracker was read for a dispatch that has no ticket: ${r.calls.join(' | ')}`,
  );
  assert.doesNotMatch(r.out, /Read the ticket/);
  assert.match(r.out, /^# loading-states$/m);
  // The MECHANICS block has to agree with the heading. `renderBrief` chooses
  // MECHANICS_UNTRACKED when the ticket is null AND no contract text arrives —
  // and dispatch used to hand it ax's own tracked MECHANICS as "the contract"
  // whenever a project declared none, so the untracked branch was unreachable
  // from this verb: the same brief said "NO ticket" at the top and "Keep the
  // ticket current yourself" further down (measured 2026-09-04 on #136's branch).
  assert.match(r.out, /There is NO ticket for this work/);
  assert.doesNotMatch(r.out, /Keep the ticket current/);
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

test('a named dispatch reports no ticket instead of empty tracker fields', () => {
  const root = repo();
  provisioned(root, 'loading-states');
  const r = run(['--name', 'loading-states', '--task', 'fix the skeletons', '--wait', '0'], { root, request: 'loading-states' });

  assert.equal(r.code, 0);
  assert.match(r.out, /DISPATCHED loading-states — fix the skeletons/);
  assert.match(r.out, /ticket {4}none — dispatched by name/);
  assert.doesNotMatch(r.out, /ticket {4}undefined/);
  assert.match(r.out, /request {3}loading-states/);
});

// -- readProof: the cross-version SSH contract (issue #57) --------------------
//
// `--launch-proof` became `--dispatch-proof` in 0.16.0, but the flag travels
// over SSH to a REMOTE ax whose version this machine does not choose. The
// remote's exit codes discriminate the three answers: 0 proof, 1 no proof yet,
// 2 unknown flag — a pre-0.16 remote. The retry arms ONLY on 2: retrying on 1
// would double every SSH round-trip of the ordinary boot-wait poll.

const PROOF_LINE = JSON.stringify({
  model: { model: 'anthropic/claude-sonnet-5', role: 'default' },
  sessionRole: { status: 'applied', role: 'worker', skills: ['implementation'] },
});
const REMOTE_HOST = { ssh: 'orca@vps', sessions: '/home/orca/.omp/agent/sessions' };

/** An exec that plays the remote ax: one scripted answer per call, argv recorded. */
function remoteAx(...answers) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return answers[calls.length - 1] ?? { status: null, stdout: '', stderr: '', error: new Error('unscripted call') };
  };
  exec.calls = calls;
  return exec;
}

const remoteProof = exec =>
  capture(() => readProof({ needle: 'gap-353', env: {}, sessionsRoot: '', host: REMOTE_HOST, exec, cwd: '/' }));

test('the sender speaks the renamed flag and asks a fluent remote exactly once', () => {
  const exec = remoteAx({ status: 0, stdout: `${PROOF_LINE}\n`, stderr: '' });
  const got = readProof({ needle: 'gap-353', env: {}, sessionsRoot: '', host: REMOTE_HOST, exec, cwd: '/' });

  assert.deepEqual(got, JSON.parse(PROOF_LINE));
  assert.equal(exec.calls.length, 1, 'a remote that answers is never asked twice');
  assert.match(exec.calls[0], /--dispatch-proof/);
  assert.doesNotMatch(exec.calls[0], /--launch-proof/, 'the retired spelling is a fallback, never the opener');
});

test('a pre-0.16 remote (exit 2) is retried once through the retired spelling', () => {
  const exec = remoteAx(
    { status: 2, stdout: '', stderr: 'unknown argument: --dispatch-proof' },
    { status: 0, stdout: `${PROOF_LINE}\n`, stderr: '' },
  );
  const r = remoteProof(exec);

  assert.deepEqual(r.code, JSON.parse(PROOF_LINE), 'the proof still arrives');
  assert.equal(exec.calls.length, 2);
  assert.match(exec.calls[1], /--launch-proof/);
  assert.match(r.out, /older ax|pre-0\.16|--launch-proof/, 'the version skew is named, not absorbed');
});

test('no-proof-yet (exit 1) is never retried — the poll must not double', () => {
  const exec = remoteAx({ status: 1, stdout: '', stderr: '' });
  const got = readProof({ needle: 'gap-353', env: {}, sessionsRoot: '', host: REMOTE_HOST, exec, cwd: '/' });

  assert.equal(got, null);
  assert.equal(exec.calls.length, 1);
});

test('a transport failure is never retried — ssh down is not a vocabulary problem', () => {
  const exec = remoteAx({ status: null, stdout: '', stderr: '', error: new Error('ssh: connect refused') });
  const got = readProof({ needle: 'gap-353', env: {}, sessionsRoot: '', host: REMOTE_HOST, exec, cwd: '/' });

  assert.equal(got, null);
  assert.equal(exec.calls.length, 1);
});
