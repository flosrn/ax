// The port of the bash orchestrator's `triage` — 42 propositions, each one paid
// for by an incident on 2026-08-10, when "N issues is N sessions" was given
// four times in prose and violated four different ways.
//
// F-027: every test here proves the SAME proposition as the Bash test it
// replaces, not a neighbouring one. Five could not be carried verbatim, and each
// says why at its own site:
//
//   * the label contract left the child's spec entirely — the child mutates
//     nothing now, so that proposition moved to the publisher
//   * `brief` accepts an unpublished draft as a pass
//   * the cap counts live CHILD panes, not `worker-list` rows (F-048)
//   * the dry run asserts the same "no session created", read from the new source
//   * `custom` is not publishable, which the Bash had no way to express
//
// Nothing here touches a real `gh`, a real `orca` or a real session: the runner
// and `exec` are injected, and a test that needed a container would be a design
// smell.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';

import { dispatch, roleWaitOf } from '../src/triage/dispatch.mjs';
import { createRunner } from '../src/orca-bin.mjs';

const REPO = 'acme/widgets';

/** A real git repo with a label contract, because the preflight reads both. */
function repo({ labels = 'docs/agents/triage-labels.md', provenance } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-triage-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({
      project: { name: 'widgets' },
      apps: { web: 'apps/web' },
      vendor: { repo: 'owner/kit' },
      triage: provenance === undefined ? { labels } : { labels, provenance },
    }),
  );
  if (labels) {
    mkdirSync(join(root, 'docs', 'agents'), { recursive: true });
    writeFileSync(join(root, 'docs', 'agents', 'triage-labels.md'), '# groups\ncategory, priority, complexity, source, domains\n');
  }
  return root;
}

const receipt = result => ({ status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });

/**
 * An Orca that is ready and owns the panes it is told to own.
 *
 * `panes` are handles the runtime still holds; every argv is recorded, so "no
 * session was created" is asserted rather than assumed.
 */
function fakeOrca({ panes = [], truncated = false, omitted = [], terminals = null } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      const line = args.join(' ');
      if (args[0] === 'status') return receipt({ runtime: { reachable: true } });
      if (line.startsWith('terminal list')) {
        if (terminals !== null) return terminals;
        return receipt({
          terminals: panes.map(handle => (typeof handle === 'string' ? { handle } : handle)),
          truncated,
          hostScope: { omittedHostIds: omitted },
        });
      }
      return receipt({});
    },
  });
  return { runner, calls };
}

/** A `gh` that answers per issue from a table, and records what it was asked. */
function fakeGh(issues = { 7: 'OPEN|0|Widget falls over' }, { parentField = true, omitParent = false, malformedParent = false } = {}) {
  const asked = [];
  return {
    asked,
    exec: (bin, args) => {
      asked.push(`${bin} ${args.join(' ')}`);
      if (bin !== 'gh') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: `${REPO}\n`, stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view') {
        const wantsParent = args.includes('--json') && String(args[args.indexOf('--json') + 1] ?? '').includes('parent');
        // A gh older than the sub-issues API fails the WHOLE view when asked for
        // the field — it does not answer with the field missing.
        if (wantsParent && !parentField) return { status: 1, stdout: '', stderr: 'Unknown JSON field: "parent"' };
        const row = issues[args[2]];
        if (row === undefined) return { status: 1, stdout: '', stderr: 'not found' };
        const [state, count, title, labelNames = '', parent = ''] = row.split('|');
        const body = { state, title, comments: Array.from({ length: Number(count) }, () => ({})) };
        body.labels = labelNames === '' ? [] : labelNames.split(';').map(name => ({ name }));
        if (wantsParent && !omitParent) {
          body.parent = malformedParent
            ? { number: 'not-a-number' }
            : parent === '' || parent === 'null'
              ? null
              : { number: Number(parent) };
        }
        return { status: 0, stdout: JSON.stringify(body), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const capture = fn => {
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
};

/** One dispatch, fully injected: no Orca, no gh, no network, no session. */
const run = (argv, options = {}) => {
  const root = options.root ?? repo();
  const home = options.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = options.store ?? join(home, 'store');
  const { runner, calls } = fakeOrca(options.orca ?? {});
  const gh = options.gh ?? fakeGh(options.issues);
  const started = [];

  if (options.registry !== false) {
    mkdirSync(join(home, '.omp', 'run', 'orca-peers'), { recursive: true });
    writeFileSync(join(home, '.omp', 'run', 'orca-peers', 'term_me.json'), JSON.stringify({ run: 'run_owner' }));
  }

  const result = capture(() =>
    dispatch([...argv], {
      runner,
      exec: gh.exec,
      env: { HOME: home, ORCA_TERMINAL_HANDLE: 'term_me', ORCA_DISPATCH_STORE: store, ...options.env },
      cwd: root,
      startFn: (args, context) => {
        started.push(args.join(' '));
        return options.startCodes ? options.startCodes.shift() : 0;
      },
      proofFn: options.proofFn ?? (() => ({
        model: { model: 'claude-opus-5', role: 'default' },
        sessionRole: { status: 'applied', role: 'triage-worker', skills: ['triage'] },
      })),
      now: options.now ?? (() => 0),
      sleep: options.sleep ?? (() => {}),
    }),
  );
  return { ...result, calls, started, root, home, store, asked: gh.asked };
};

/** A settled dispatch record, as `worker start` would have written it. */
function record(store, request, { handle = 'term_child', dispatchId = 'd-1' } = {}) {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      createdAt: '2026-08-20T10:00:00.000Z',
      attempts: [
        {
          n: 1,
          phases: [
            {
              name: 'worker-start',
              beganAt: '2026-08-20T10:00:00.000Z',
              exit: 0,
              receipt: { ok: true, result: { dispatchId, state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: handle }] } },
            },
          ],
        },
      ],
    }),
  );
}

// ── the isolation this whole file rests on ───────────────────────────────────

test('no invocation reaches a real gh or a real orca', () => {
  const r = run(['--issue', '7', '--dry-run']);
  assert.ok(r.asked.every(line => line.startsWith('gh ')), 'every exec was the injected gh');
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'the stub orca created nothing');
});

// ── arguments, before anything is read ───────────────────────────────────────

test('an unknown argument is refused before any binary is consulted', () => {
  const r = run(['--issue', '7', '--force-push']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument "--force-push"/);
  assert.deepEqual(r.calls, [], 'nothing was asked of Orca');
});

test('no --issue at all is refused', () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.out, /no --issue given/);
});

test('a non-numeric --issue is refused', () => {
  const r = run(['--issue', 'GAP-353']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--issue expects a number/);
});

test('an unknown --job is refused, and the refusal names the three legal ones', () => {
  const r = run(['--issue', '7', '--job', 'audit']);
  assert.equal(r.code, 2);
  assert.match(r.out, /triage\|brief\|custom/);
});

test('--job custom without --instruction is refused', () => {
  const r = run(['--issue', '7', '--job', 'custom']);
  assert.equal(r.code, 2);
  assert.match(r.out, /needs --instruction/);
});

test('--job custom with an unreadable --instruction is refused', () => {
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', '/nonexistent/task.txt']);
  assert.equal(r.code, 1);
  assert.match(r.out, /unreadable/);
});

test('a repository that cannot be resolved is refused rather than guessed', () => {
  const gh = { asked: [], exec: () => ({ status: 1, stdout: '', stderr: 'no remote' }) };
  const r = run(['--issue', '7'], { gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /could not resolve the current repository/);
});

test('a checkout with no ax.config.json refuses, and dispatches nothing', () => {
  // Found by the live smoke, not by a fixture: every fixture here writes a
  // config, so the one path a real checkout can take was the uncovered one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-triage-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /no ax\.config\.json/);
  assert.deepEqual(r.started, []);
});

// ── the vocabulary the child is answerable to ────────────────────────────────

test('an undeclared label contract refuses a triage job, and says what it would have cost', () => {
  // The generic playbook cannot name one project's label groups: left to it
  // alone a session recommends in prose and stops. That is measured — four
  // issues, three empty groups each, and the maintainer doing the data entry.
  const root = repo({ labels: '' });
  const r = run(['--issue', '7'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /declares triage\.labels nowhere/);
  assert.match(r.out, /three empty groups/);
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'no child is dispatched under-specified');
});

test('a label contract that is a directory is unreadable, not present', () => {
  // existsSync says yes to a directory, and the child reads this path for real.
  const root = repo();
  mkdirSync(join(root, 'docs', 'agents', 'dir.md'), { recursive: true });
  const config = JSON.parse(readFileSync(join(root, 'ax.config.json'), 'utf8'));
  config.triage.labels = 'docs/agents/dir.md';
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify(config));

  const r = run(['--issue', '7'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /which cannot be read: EISDIR/);
});

test('an empty label contract names no group, so it is a refusal too', () => {
  const root = repo();
  writeFileSync(join(root, 'docs', 'agents', 'triage-labels.md'), '\n  \n');
  const r = run(['--issue', '7'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /which is empty/);
});

test('a custom job needs no label contract — its draft is a report, not a label set', () => {
  const root = repo({ labels: '' });
  const instruction = join(root, 'task.txt');
  writeFileSync(instruction, 'Measure the query\nand report the number\n');
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', instruction, '--dry-run'], { root });
  assert.equal(r.code, 0);
  assert.match(r.out, /Measure the query and report the number/);
});

// ── the cap ──────────────────────────────────────────────────────────────────

test('the cap counts live CHILD panes, never every pane the runtime owns (F-048)', () => {
  // THE change from Bash. `worker-list` answered zero while children worked, so
  // the count moved to panes — but `terminal list` also carries this session's
  // pane, an editor's, an unrelated worker's. Counting those would let a busy
  // sidebar fence the work, so only a pane a dispatch RECORD names is counted.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-1', { handle: 'term_child_a', dispatchId: 'd-a' });
  const r = run(['--issue', '7', '--dry-run'], {
    home,
    store,
    orca: { panes: ['term_child_a', 'term_me', 'term_editor', 'term_stranger'] },
    env: { ORCA_TRIAGE_SESSION_CAP: '2' },
  });
  assert.equal(r.code, 0, 'three unrelated panes do not consume triage capacity');
});

test('one over the cap is refused, and the refusal shows the arithmetic', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-1', { handle: 'term_a', dispatchId: 'd-a' });
  record(store, 'triage-acme-widgets-2', { handle: 'term_b', dispatchId: 'd-b' });
  const r = run(['--issue', '7'], { home, store, orca: { panes: ['term_a', 'term_b'] }, env: { ORCA_TRIAGE_SESSION_CAP: '2' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /cap: 2 live child pane\(s\) \+ 1 new > 2/);
  assert.deepEqual(r.started, []);
});

test('exactly at the cap the run is allowed — the boundary is greater-than', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-1', { handle: 'term_a', dispatchId: 'd-a' });
  const r = run(['--issue', '7', '--dry-run'], { home, store, orca: { panes: ['term_a'] }, env: { ORCA_TRIAGE_SESSION_CAP: '2' } });
  assert.equal(r.code, 0);
});

test('a cap that is not a number refuses, rather than silently removing the fence', () => {
  // `Number('bad')` is NaN, and `live + new > NaN` is false for every input: the
  // guard would disappear on the one path whose whole job is to fail closed.
  const r = run(['--issue', '7'], { env: { ORCA_TRIAGE_SESSION_CAP: 'lots' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /not a whole number of sessions/);
  assert.deepEqual(r.started, []);
});

test('a cap of zero is legal, and stops every new session', () => {
  const r = run(['--issue', '7'], { env: { ORCA_TRIAGE_SESSION_CAP: '0' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /0 live child pane\(s\) \+ 1 new > 0/);
});

test('the cap counts every new issue in the batch, not the invocation', () => {
  const r = run(['--issue', '7', '--issue', '8', '--issue', '9'], {
    issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b', 9: 'OPEN|0|c' },
    env: { ORCA_TRIAGE_SESSION_CAP: '2' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /0 live child pane\(s\) \+ 3 new > 2/);
});

test('an issue that already has a dispatch record is not new, so it does not consume cap', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_gone', dispatchId: 'd-7' });
  const r = run(['--issue', '7'], { home, store, orca: { panes: [] }, env: { ORCA_TRIAGE_SESSION_CAP: '0' } });
  assert.equal(r.code, 0, 'a replay is not a new session');
  assert.match(r.out, /replaying it rather than creating a second task/);
});

test('a dead pane frees its capacity — an orphaned terminal is not a live child', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-1', { handle: 'term_a', dispatchId: 'd-a' });
  const r = run(['--issue', '7', '--dry-run'], {
    home,
    store,
    orca: { panes: [{ handle: 'term_a', orphaned: true }] },
    env: { ORCA_TRIAGE_SESSION_CAP: '1' },
  });
  assert.equal(r.code, 0);
});

test('ORCA_TRIAGE_SESSION_CAP moves the cap', () => {
  const r = run(['--issue', '7', '--issue', '8'], { issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b' }, env: { ORCA_TRIAGE_SESSION_CAP: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /> 1/);
});

test('ORCA_READY_SESSION_CAP is refused and the repair names ORCA_TRIAGE_SESSION_CAP', () => {
  const r = run(['--issue', '7'], { env: { ORCA_READY_SESSION_CAP: '5' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /ORCA_READY_SESSION_CAP is set/);
  assert.match(r.out, /unset ORCA_READY_SESSION_CAP and export ORCA_TRIAGE_SESSION_CAP instead/);
  assert.deepEqual(r.started, []);
});

test('an empty ORCA_READY_SESSION_CAP does not refuse', () => {
  const r = run(['--issue', '7', '--dry-run'], { env: { ORCA_READY_SESSION_CAP: '' } });
  assert.equal(r.code, 0);
});

test('a terminal list that does not answer cannot establish the cap, and dispatches nothing', () => {
  const r = run(['--issue', '7'], { orca: { terminals: { status: 1, stdout: '', stderr: 'runtime gone' } } });
  assert.equal(r.code, 3);
  assert.match(r.out, /CANNOT ESTABLISH/);
  assert.deepEqual(r.started, []);
});

test('a TRUNCATED terminal list cannot establish the cap either', () => {
  const r = run(['--issue', '7'], { orca: { truncated: true } });
  assert.equal(r.code, 3);
  assert.match(r.out, /TRUNCATED/);
});

test('omitted hosts are disclosed, never a wall', () => {
  // Measured 2026-08-22: `hostScope.omittedHostIds` is non-empty on this Mac, so
  // refusing on it would refuse every ordinary dispatch — the fail-closed hole
  // `gate` had, where 155 panes of 218 were absent behind a stale runtime.
  const r = run(['--issue', '7', '--dry-run'], { orca: { omitted: ['runtime-7930a317'] } });
  assert.equal(r.code, 0);
  assert.match(r.out, /hosts are omitted/);
});

test('an unreadable dispatch record cannot establish the count, and refuses', () => {
  // An absence of information is not an absence of a child (F-028).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'triage-acme-widgets-1.json'), '{ not json');
  const r = run(['--issue', '7'], { home, store });
  assert.equal(r.code, 3);
  assert.match(r.out, /cannot be read/);
  assert.deepEqual(r.started, []);
});

test('a store that was never created is zero children, not a refusal', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const r = run(['--issue', '7', '--dry-run'], { home, store: join(home, 'never') });
  assert.equal(r.code, 0, 'the first dispatch on a fresh machine is not blocked');
});

// ── the per-issue precheck ───────────────────────────────────────────────────

test('an open untriaged issue passes, and is listed with its metadata', () => {
  const r = run(['--issue', '7', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /#7 OPEN 0 comment\(s\)/);
  assert.match(r.out, /Widget falls over/);
});

test('a closed issue is skipped, and the reason is reported', () => {
  const r = run(['--issue', '7'], { issues: { 7: 'CLOSED|0|Done long ago' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /not OPEN/);
  assert.deepEqual(r.started, []);
});

test('an issue absent from the repo is UNREADABLE rather than dispatched blind', () => {
  const r = run(['--issue', '9'], { issues: { 7: 'OPEN|0|a' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /#9 UNREADABLE/);
  assert.deepEqual(r.started, []);
});

test('gh answering without a comments array is an absence of information, not an empty issue', () => {
  const gh = {
    asked: [],
    exec: (bin, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: `${REPO}\n`, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ state: 'OPEN', title: 'x' }), stderr: '' };
    },
  };
  const r = run(['--issue', '7'], { gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /an absent container is not an empty one/);
});

test('F-030 with a RECORDED pass points at the brief, because the pass really happened', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_gone' });
  const r = run(['--issue', '7'], { home, store, issues: { 7: 'OPEN|2|Triaged already' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /F-030/);
  assert.match(r.out, /competing verdict/);
  assert.match(r.out, /--job brief/, 'a pass that ran is distilled, never re-run');
  assert.deepEqual(r.started, []);
});

test('F-030 with NO pass anywhere says so, and its repair is --force', () => {
  // Measured 2026-08-26 on an issue whose single comment was a stale coordination
  // note — no Triage Notes, no Agent Brief, still `needs-triage`. The refusal was
  // right and its repair was wrong: `--job brief` would have distilled a brief
  // out of a pass that never happened. The comment count cannot tell the two
  // apart, but the store and the drafts can.
  const r = run(['--issue', '7'], { issues: { 7: 'OPEN|1|Never triaged, one note' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /F-030/);
  assert.match(r.out, /no triage pass is recorded/);
  assert.match(r.out, /--force/, 'the way out is to read the comments and force, not to brief nothing');
  assert.doesNotMatch(r.out, /--job brief/, 'briefing a pass that never ran is the wrong repair');
  assert.deepEqual(r.started, [], 'it still fails closed: a human verdict is one this tool cannot see');
});

test('F-030 counts an unpublished DRAFT as a pass, like the brief job does', () => {
  const root = repo();
  const r = run(['--issue', '7'], { root, issues: { 7: 'OPEN|2|Triaged already' } });
  draftAt(root, 'triage-acme-widgets-7');
  const again = run(['--issue', '7'], { root, issues: { 7: 'OPEN|2|Triaged already' } });
  assert.equal(r.code, 1);
  assert.equal(again.code, 1);
  assert.match(again.out, /--job brief/);
});

test('--force overrides the comment count and lets the triage job through', () => {
  const r = run(['--issue', '7', '--force', '--dry-run'], { issues: { 7: 'OPEN|2|Triaged already' } });
  assert.equal(r.code, 0);
});

test('--force does not override the closed-issue guard', () => {
  // `--force` means "I read the comments and I still want a pass". It was never
  // a way past every guard: on 2026-08-10 it silenced the one that mattered.
  const r = run(['--issue', '7', '--force'], { issues: { 7: 'CLOSED|2|Done'  } });
  assert.equal(r.code, 1);
  assert.match(r.out, /not OPEN/);
});

test('brief on an issue with neither comment nor draft is refused — no pass to distil', () => {
  const r = run(['--issue', '7', '--job', 'brief'], { issues: { 7: 'OPEN|0|Fresh' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /no comment and no triage draft/);
  assert.deepEqual(r.started, []);
});

test('brief accepts an UNPUBLISHED draft as a pass', () => {
  // The change parent-publish forces: publication happens at the end of a chain,
  // so refusing on the comment count alone refuses the ordinary sequence.
  const root = repo();
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md'), 'Labels: category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], { root, issues: { 7: 'OPEN|0|Fresh' } });
  assert.equal(r.code, 0);
  assert.match(r.out, /distilling the unpublished draft/);
});

test('brief on a commented issue passes the precheck', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], { issues: { 7: 'OPEN|2|Triaged' } });
  assert.equal(r.code, 0);
});

test('custom notes an already-triaged issue but does not block on it', () => {
  const root = repo();
  const instruction = join(root, 'task.txt');
  writeFileSync(instruction, 'Check the log rotation\n');
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', instruction, '--dry-run'], { root, issues: { 7: 'OPEN|2|Triaged' } });
  assert.equal(r.code, 0);
  assert.match(r.out, /already triaged/);
});

test('every issue is prechecked before any is dispatched', () => {
  const r = run(['--issue', '7', '--issue', '8'], { issues: { 7: 'OPEN|0|fine', 8: 'CLOSED|0|closed' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing was dispatched/);
  assert.deepEqual(r.started, [], 'the good issue is not dispatched while the bad one blocks');
});

// ── the Run this session's receiver consumes ─────────────────────────────────

test('a session absent from the peer registry cannot establish a Run, and dispatches nothing', () => {
  const r = run(['--issue', '7'], { registry: false });
  assert.equal(r.code, 3);
  assert.match(r.out, /no Run in the peer registry/);
  assert.deepEqual(r.started, []);
});

test('the Run comes from the registry entry for this handle, never from a flag', () => {
  const r = run(['--issue', '7']);
  assert.equal(r.code, 0);
  assert.match(r.started[0], /--run run_owner/);
});

// ── the spec ─────────────────────────────────────────────────────────────────

test('the triage spec sends the child to the project contract, and forbids every mutation', () => {
  // The proposition that MOVED: the Bash spec carried the label contract because
  // the child applied it. The child applies nothing now, so what the spec has to
  // carry is the vocabulary its draft must speak — and the refusal to mutate.
  const r = run(['--issue', '7', '--dry-run']);
  assert.match(r.out, /\[omp role=triage-worker model=@default\]/);
  assert.match(r.out, /preloaded triage playbook AND .*triage-labels\.md/);
  assert.match(r.out, /issue:\/\/7/);
  assert.match(r.out, /Apply no label, post no comment, close nothing/);
  assert.match(r.out, /\.scratch\/triage\/triage-acme-widgets-7\.md/);
  assert.match(r.out, /Leaving a group empty means you have not finished/);
  assert.match(r.out, /Close: yes/, 'a wontfix verdict is recommended, never done');
});

test('the brief spec forbids a second verdict and names the bundled Agent Brief contract', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], { issues: { 7: 'OPEN|2|Triaged' } });
  assert.match(r.out, /preloaded triage playbook, especially its Agent Brief section/);
  assert.match(r.out, /ALREADY had its triage pass/);
  assert.match(r.out, /do not render a competing verdict/);
  assert.match(r.out, /brief-acme-widgets-7\.md/, 'a brief writes its own draft, not the triage one');
});

test('the custom spec inlines the instruction on ONE line, prefixed by the triage state', () => {
  const root = repo();
  const instruction = join(root, 'task.txt');
  writeFileSync(instruction, 'Measure the query\nand report the number\n');
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', instruction, '--dry-run'], { root, issues: { 7: 'OPEN|2|Triaged' } });
  assert.match(r.out, /has ALREADY had its triage pass/);
  assert.match(r.out, /Measure the query and report the number/);
});

test('the custom spec omits the already-triaged prefix on an untriaged issue', () => {
  const root = repo();
  const instruction = join(root, 'task.txt');
  writeFileSync(instruction, 'Check the log rotation\n');
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', instruction, '--dry-run'], { root });
  assert.match(r.out, /Check the log rotation/);
  assert.doesNotMatch(r.out, /ALREADY had its triage pass/);
});

test('--model travels in the spec marker rather than in a worker-start flag', () => {
  const r = run(['--issue', '7', '--model', '@smol', '--dry-run']);
  assert.match(r.out, /\[omp role=triage-worker model=@smol\]/);
  assert.match(r.out, /model @smol/);
});

test('free text never touches argv: the spec goes to a file, always', () => {
  const r = run(['--issue', '7']);
  assert.match(r.started[0], /--spec-file/);
  const path = /--spec-file (\S+)/.exec(r.started[0])[1];
  assert.ok(existsSync(path), 'the file the dispatch names exists');
  assert.match(readFileSync(path, 'utf8'), /Apply no label/);
});

// ── dry run ──────────────────────────────────────────────────────────────────

test('a dry run renders the spec and creates no session', () => {
  const r = run(['--issue', '7', '--issue', '8', '--dry-run'], { issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b' } });
  assert.equal(r.code, 0);
  assert.match(r.out, /#7 DRY/);
  assert.match(r.out, /#8 DRY/);
  assert.deepEqual(r.started, [], 'worker start is the only thing that creates a session');
  // Same proposition as the Bash test, read from the new source: the only Orca
  // verbs a dry run may reach are reads.
  assert.ok(
    r.calls.every(line => line.startsWith('status') || line.startsWith('terminal list')),
    `a dry run only read: ${r.calls.join(' | ')}`,
  );
  assert.equal(existsSync(join(r.store, 'triage-acme-widgets-7.json')), false);
});

// ── the dispatch itself ──────────────────────────────────────────────────────

test('a real run creates one verified triage-worker session per issue', () => {
  const r = run(['--issue', '7', '--issue', '8'], { issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b' }, env: { ORCA_TRIAGE_SESSION_CAP: '5' } });
  assert.equal(r.code, 0);
  assert.equal(r.started.length, 2, 'one session per issue, never one session for two');
  assert.match(r.out, /#7 VERIFIED/);
  assert.match(r.out, /#8 VERIFIED/);
});

// The verdict is a snapshot: a quota fallback is written when the first
// provider call fails, which can land after the receipt this loop settles on,
// and no bounded wait can prove a later mover will not arrive. So the success
// line NAMES the model it proved — that is what makes a later `fallback` in the
// same session file legible against it rather than silently contradicting a
// green line nobody can re-read.
test('the verified line names the model it proved, so a later mover is legible', () => {
  const r = run(['--issue', '7'], {
    proofFn: () => ({
      model: { model: 'omniroute/or-opus', role: 'default' },
      sessionRole: { status: 'applied', role: 'triage-worker', skills: ['triage'] },
    }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /reached the first turn on omniroute\/or-opus/);
});

test('a dispatch with no role receipt is cannot-establish and is never re-dispatched', () => {
  let reads = 0;
  const r = run(['--issue', '7'], {
    env: { AX_TRIAGE_ROLE_WAIT: '0' },
    proofFn: () => (reads += 1, null),
  });
  assert.equal(r.code, 3, 'a live child whose effects are unproven is not the code that means "retry"');
  assert.equal(r.started.length, 1);
  assert.equal(reads, 1);
  assert.match(r.out, /#7 CANNOT-ESTABLISH/);
  assert.match(r.out, /Do NOT re-dispatch/);
});

// The friction reported from goodluckagency/ofmchat#101 on 2026-08-27: the
// session file exists as soon as the child boots, carrying the boot
// `model_change` and no receipt. Reading once is reading that boot state.
test('a booted session file is waited out, not reported as an unproven marker', () => {
  let read = 0;
  const answers = [
    { model: { model: 'omniroute/or-opus', role: '' }, sessionRole: null },
    { model: { model: 'omniroute/or-opus', role: '' }, sessionRole: null },
    { model: { model: 'omniroute/or-opus', role: 'default' }, sessionRole: null },
    // A read that carries only the receipt must not erase the latched model.
    { model: null, sessionRole: { status: 'applied', role: 'triage-worker', skills: ['triage'] } },
  ];
  const r = run(['--issue', '7'], { proofFn: () => answers[Math.min(read++, answers.length - 1)] });
  assert.equal(r.code, 0);
  assert.equal(read, 4, 'each proposition latches on its own read');
  assert.match(r.out, /triage-worker \+ triage reached the first turn/);
  assert.match(r.out, /#7 VERIFIED/);
});

test('a child still on its boot model when the window closes is named as such', () => {
  const r = run(['--issue', '7'], {
    env: { AX_TRIAGE_ROLE_WAIT: '0' },
    proofFn: () => ({ model: { model: 'omniroute/or-opus', role: '' }, sessionRole: null }),
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /still runs its BOOT model/);
  assert.match(r.out, /no session-role receipt/);
  assert.match(r.out, /#7 CANNOT-ESTABLISH/);
});

test('a pre-turn triage role refusal names the missing playbook', () => {
  const r = run(['--issue', '7'], {
    proofFn: () => ({
      model: { model: 'claude-opus-5', role: 'default' },
      sessionRole: {
        status: 'refused',
        role: 'triage-worker',
        reason: 'skill-not-found',
        missingSkills: ['triage'],
      },
    }),
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /role triage-worker refused — skill-not-found; missing triage/);
  assert.match(r.out, /#7 CANNOT-ESTABLISH/);
});

test('the session is placed in the CURRENT worktree, with no tree and no setup', () => {
  const r = run(['--issue', '7']);
  assert.match(r.started[0], /-- --worktree current --agent omp/);
  assert.ok(!r.started[0].includes('--name'), 'no creation flag: a triage session needs no tree');
  assert.ok(!r.started[0].includes('--setup'), 'and no setup run');
});

test('the request names the job, so a brief never replays the triage record', () => {
  const r = run(['--issue', '7', '--job', 'brief'], { issues: { 7: 'OPEN|2|Triaged' } });
  assert.match(r.started[0], /--request brief-acme-widgets-7/);
});

test('a second run on the same issue replays the record instead of creating a second session', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7');
  const r = run(['--issue', '7'], { home, store });
  assert.equal(r.code, 0);
  assert.match(r.started[0], /--resume --request triage-acme-widgets-7/);
  assert.ok(!r.started[0].includes('--spec-file'), 'a replay is the recorded call, not a freshly composed one');
});

test('a dispatch that cannot establish is reported as such, and does not become DISPATCHED', () => {
  const r = run(['--issue', '7'], { startCodes: [3] });
  assert.equal(r.code, 3, 'the summary carries the same code the start did — never 1, which reads as "nothing happened"');
  assert.match(r.out, /#7 CANNOT-ESTABLISH/);
});

test('an unproven live child dominates a duplicate in the summary code', () => {
  const mixed = run(['--issue', '7', '--issue', '8'], {
    issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b' },
    env: { ORCA_TRIAGE_SESSION_CAP: '5', AX_TRIAGE_ROLE_WAIT: '0' },
    startCodes: [2, 0],
    proofFn: () => null,
  });
  assert.equal(mixed.code, 3, 'one unproven child dominates a duplicate: the worse hazard decides the code');
  assert.match(mixed.out, /#7 DUPLICATE/);
  assert.match(mixed.out, /#8 CANNOT-ESTABLISH/);
});

test('a duplicate exit is named, never counted as a fresh session', () => {
  const r = run(['--issue', '7'], { startCodes: [2] });
  assert.equal(r.code, 1);
  assert.match(r.out, /#7 DUPLICATE/);
});

test('the summary refuses to let a report stand for a landing', () => {
  const r = run(['--issue', '7']);
  assert.match(r.out, /a report is a signal, not a verdict/);
  assert.match(r.out, /nothing lands until you publish it/);
  assert.match(r.out, /do not poll/);
});

// ── a second pass on one issue ───────────────────────────────────────────────
//
// Measured 2026-08-22: the orchestrator never ran a second pass, because there
// was no verb for one. It hand-edited the child's draft with string replacements
// and published that. Every refusal below is a way that shortcut could have gone
// wrong once it became a real verb.

/** A record that never settled: worker-start answered, its mutation may run on. */
function stranded(store, request) {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      createdAt: '2026-08-20T10:00:00.000Z',
      attempts: [
        {
          n: 1,
          phases: [{ name: 'worker-start', beganAt: '2026-08-20T10:00:00.000Z', exit: 1, receipt: { ok: false, error: { code: 'runtime_unavailable' } } }],
        },
      ],
    }),
  );
}

/** A draft on disk for one pass, so `passesIn` can see it. */
function draftAt(root, request, text = 'Labels: category/bug\n\nIt reproduces.\n') {
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', `${request}.md`), text);
  return join(root, '.scratch', 'triage', `${request}.md`);
}

test('--fresh without --because is refused, because an unexplained redo is a child repeating itself', () => {
  const r = run(['--issue', '7', '--fresh']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--fresh needs --because/);
  assert.deepEqual(r.started, [], 'nothing was dispatched');
});

test('--because without --fresh is refused rather than dropped, because the caller wrote it down', () => {
  const r = run(['--issue', '7', '--because', 'the sibling moved']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--because only means something with --fresh/);
});

test('--fresh on an issue with no recorded pass says a first pass is an ordinary dispatch', () => {
  const r = run(['--issue', '7', '--fresh', '--because', 'nothing to redo']);
  assert.equal(r.code, 1);
  assert.match(r.out, /no recorded pass/);
  assert.match(r.out, /ax triage dispatch --issue 7/);
  assert.deepEqual(r.started, []);
});

test('--fresh is refused while the previous pass still holds a live pane', () => {
  // The duplicate this whole subsystem exists to prevent, under a new number.
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_child' });
  const r = run(['--issue', '7', '--fresh', '--because', 'the ruling changed'], { root, home, store, orca: { panes: ['term_me', 'term_child'] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /still holds a live pane \(term_child\)/);
  assert.deepEqual(r.started, []);
});

test('--fresh cannot establish anything when the previous pane is absent from a partial list', () => {
  // F-028: an absence from an inventory that omits hosts is not a death, and this
  // call is about to create a rival child on the strength of it.
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_child' });
  const r = run(['--issue', '7', '--fresh', '--because', 'the ruling changed'], {
    root,
    home,
    store,
    orca: { panes: ['term_me'], omitted: ['host_b'] },
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /cannot be proven finished/);
  assert.deepEqual(r.started, []);
});

test('--fresh cannot establish anything when a settled legacy pass recorded no pane', () => {
  // REACHABLE, not theoretical: `report()` calls a Bash-era record usable on
  // `terminal !== null || legacyUsable`, and `legacyUsable` is just a non-empty
  // `receiptPath` (record.mjs:367). Such a record clears gate 1 as settled and
  // maps no handle at all — so nothing on this machine can say whether its child
  // is gone, and creating a rival pass on that silence is the F-028 mistake.
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, 'triage-acme-widgets-7.json'),
    JSON.stringify({
      request: 'triage-acme-widgets-7',
      createdAt: '2026-08-20T10:00:00.000Z',
      attempts: [
        {
          n: 1,
          phases: [
            {
              name: 'worker-start',
              beganAt: '2026-08-20T10:00:00.000Z',
              exit: 0,
              receiptPath: '/legacy/receipts/worker-start.json',
              receipt: { ok: true, result: { dispatchId: 'd-1', state: 'ready', effects: [] } },
            },
          ],
        },
      ],
    }),
  );
  const r = run(['--issue', '7', '--fresh', '--because', 'the ruling changed'], { root, home, store, orca: { panes: ['term_me'] } });
  assert.equal(r.code, 3);
  assert.match(r.out, /no pane recorded against it/);
  assert.deepEqual(r.started, []);
});

test('--fresh never overrides F-001: an unsettled pass routes to --resume, not to a new number', () => {
  // `worker-start` has answered `runtime_unavailable` twice while its mutation
  // ran on. A second pass on top of that is the same duplicate, renamed.
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  stranded(store, 'triage-acme-widgets-7');
  const r = run(['--issue', '7', '--fresh', '--because', 'the ruling changed'], { root, home, store, orca: { panes: ['term_me'] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /never settled/);
  assert.match(r.out, /--resume --request triage-acme-widgets-7/);
  assert.deepEqual(r.started, []);
});

test('a fresh pass runs as p2, and its child is told the path, the fingerprint and the reason', () => {
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_gone' });
  const path = draftAt(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one said this.\n');
  const sha = execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();

  const r = run(['--issue', '7', '--fresh', '--because', 'issue #8 changed the cost model'], { root, home, store, orca: { panes: ['term_me'] } });
  assert.equal(r.code, 0);
  assert.match(r.out, /pass 2/);
  assert.match(r.out, /PASS 2 on this issue/);
  assert.match(r.out, new RegExp(`Pass 1 already ran and its verdict is at ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.out, new RegExp(`git hash-object ${sha}`));
  assert.match(r.out, /WHAT CHANGED SINCE: issue #8 changed the cost model/);
  assert.equal(r.started.length, 1);
  assert.match(r.started[0], /triage-acme-widgets-7-p2/);
});

test('a plain dispatch on an issue that has two passes replays the NEWEST, never pass 1', () => {
  // Otherwise the ordinary command reruns a verdict its own author replaced.
  const root = repo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_one', dispatchId: 'd-1' });
  record(store, 'triage-acme-widgets-7-p2', { handle: 'term_two', dispatchId: 'd-2' });
  const r = run(['--issue', '7'], { root, home, store, orca: { panes: ['term_me'] } });
  assert.equal(r.code, 0);
  assert.equal(r.started.length, 1);
  assert.match(r.started[0], /--resume --request triage-acme-widgets-7-p2/);
});

// ── what a child with open questions is told to do ───────────────────────────

test('a child that must ask is told the exact command, and told to wait on it', () => {
  // The first cut of this spec ended on "Report when the draft is written",
  // which told a child with open questions to FINISH — and finishing is what
  // broke the answer channel both ways on 2026-08-22: the children's `ask` was
  // refused because the stall had revoked their capability, and the
  // orchestrator's replies had no route left "after their report".
  //
  // The command is ax's OWN, fully rendered — issue, job, repo, pass — for the
  // same reason the label grammar is named: an unnamed gesture gets improvised,
  // and a raw `orchestration ask` lets the questions on the wire diverge from
  // the Q<n>: lines on record. One commit shipped the raw command; this pins
  // its replacement.
  const r = run(['--issue', '7', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /ax triage ask --issue 7 --job triage --repo acme\/widgets --pass 1/, 'the global command delegates to the consuming repo version');
  assert.doesNotMatch(r.out, /orca orchestration ask/, 'the raw transport is not the child’s interface');
  assert.match(r.out, /blocks until they are answered/);
  assert.match(r.out, /ax triage ask --resume <message_id>/, 'an unbounded human latency is survivable, not fatal');
  // The routing ruling (maintainer, 2026-08-23, tightened 2026-08-27): the
  // dispatching parent RULES, reversibly. `[product]` is advisory — not a
  // handoff to the operator. The tag opens the question TEXT, because
  // `Q<n> [technical]:` would break the one Q-line grammar while
  // `Q<n>: [technical] …` travels verbatim. The parent is named by ROLE in
  // neither direction: a triage child is dispatched by a readiness session or by
  // an orchestrator sweeping its own wave's follow-ups, and the ruler is
  // whichever pane dispatched it.
  assert.match(r.out, /OPEN each question's text with its routing tag/);
  assert.match(r.out, /\[technical\].*parent that dispatched you rules itself/);
  assert.match(r.out, /\[product\].*advisory for that parent/);
  assert.match(r.out, /Do not report and do not end your turn while a question is open — with ONE exception/);
  // The write-failure ladder (measured 2026-08-23 on #60: an unwritable draft
  // left the verdict in a scrollback and the report was a lost peer message —
  // the transcript is the one channel here that never loses).
  assert.match(r.out, /If that write FAILS, retry it once/);
  assert.match(r.out, /BEGIN DRAFT and a line reading END DRAFT/);
  assert.match(r.out, /the pane transcript is the recovery channel/);
  // The exception exists because the rule and ask's proven-stall repair would
  // otherwise contradict each other on the 9/9 measured path of this machine:
  // the spec said "never report with a question open" while the only working
  // recovery says "report NOW". A child holding both either deadlocks parked
  // or improvises; the spec now says which sentence wins, and when.
  //
  // Widened 2026-08-27 (ofmchat #83): the exception named the composer stall
  // ONLY, so a child refused `runtime_busy` had no exit at all and burned 62
  // minutes over 11 hand-rolled retries with its advisors correctly blocking
  // every alternative. The exception now defers to the VERB — whatever refusal
  // carries a repair line saying report, wins — so the next class of dead
  // transport needs a named arm in ask.mjs and no second edit here.
  assert.match(r.out, /THE ASK ITSELF DECLARES IT/);
  assert.match(r.out, /runtime_busy/);
  assert.match(r.out, /retrying by hand buys nothing/);
  // And the boundary the widening must not blur: a timeout stays resumable.
  assert.match(r.out, /On every other refusal, and on a timeout, you do NOT report/);
  assert.match(r.out, /the parent answers by peer/);
  assert.match(r.out, /Report when the draft is FINAL/);
  assert.doesNotMatch(r.out, /Report when the draft is written/);
});

test('the same instruction reaches a brief child, because a brief escalates too', () => {
  const root = repo();
  draftAt(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nThe triage pass.\n');
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], { root });
  assert.equal(r.code, 0);
  assert.match(r.out, /ax triage ask --issue 7 --job brief --repo acme\/widgets --pass 1/);
  assert.match(r.out, /Report when the draft is FINAL/);
});

test('the child keeps its own context: the spec says why the answer comes back to IT', () => {
  // The reason a later session is not the answer: it would re-derive the issue
  // and the code this child has already read.
  const r = run(['--issue', '7', '--dry-run']);
  assert.match(r.out, /You hold the issue and the code you have already read/);
  assert.match(r.out, /revise the draft into a final verdict/);
});

// ── the retired readiness lane ───────────────────────────────────────────────
// `refine` was a Definition-of-Ready pass over spec sub-issues, and it was the
// deviation: `to-tickets` publishes `ready-for-agent` itself, so its tickets are
// agent-grabbable by construction, and triage is the on-ramp for work that
// arrived instead. A pass wedged between the two had nothing left to decide.
// What must hold now is that the name is refused BY NAME, with the reason and
// the repair, before any read of the tracker happens.

test('--job refine is refused by name, with its reason and repair, and reads nothing', () => {
  const r = run(['--issue', '7', '--job', 'refine', '--dry-run'], { issues: { 7: 'OPEN|0|Widget import|.|10' } });
  assert.equal(r.code, 2, 'a retired lane is a usage error, not a tracker refusal');
  assert.match(r.out, /--job refine no longer exists/);
  assert.match(r.out, /to-tickets` publishes ready-for-agent itself/);
  assert.match(r.out, /triage is for inbound work only/);
  assert.match(r.out, /fix it on the ticket/);
  assert.doesNotMatch(r.out, /--job expects/, 'it never falls through to the generic unknown-job error');
  assert.deepEqual(r.started, [], 'nothing was dispatched');
  assert.ok(r.calls.every(line => !line.includes('issue view')), 'the refusal precedes every tracker read');
});

test('a genuinely unknown job still gets the ordinary usage error naming the three passes', () => {
  const r = run(['--issue', '7', '--job', 'groom', '--dry-run']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--job expects triage\|brief\|custom, got "groom"/);
  assert.doesNotMatch(r.out, /no longer exists/, 'only the retired name earns the named refusal');
});

test('a gh without the parent field degrades to a note, never a refusal', () => {
  // The parent read rides on every label-applying lane now, so a gh too old to
  // answer `--json parent` reaches the fallback read on the ORDINARY dispatch.
  // It must cost nothing when the project declared no provenance to gate on.
  const gh = fakeGh({ 7: 'OPEN|0|a' }, { parentField: false });
  const r = run(['--issue', '7', '--dry-run'], { gh });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /UNREADABLE/, 'a capability gap is not an unreadable issue');
});

test('a successful issue read with no parent key does not refuse either (F-028)', () => {
  const gh = fakeGh({ 7: 'OPEN|0|a' }, { omitParent: true });
  assert.equal(run(['--issue', '7', '--dry-run'], { gh }).code, 0);
});

test('malformed parent metadata is never coerced into a fake parent number', () => {
  const gh = fakeGh({ 7: 'OPEN|0|a' }, { malformedParent: true });
  const r = run(['--issue', '7', '--dry-run'], { gh });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /parent #NaN/);
});

// ── provenance: whether a ticket's ORIGIN forbids the pass ───────────────────
//
// Triage is an ON-RAMP, not a step in the spec chain: it is the pass for work
// that ARRIVED, and `to-tickets` publishes its own tickets as `ready-for-agent`
// by construction. So a spec-born ticket in a label-applying lane is refused,
// and until now only prose said so — the retired readiness role told the operator
// "provenance decides the job", and `readIssue` asked for the parent ONLY in the
// retired readiness lane, so `--job triage` on a spec-born ticket could not
// notice what it was looking at. Measured 2026-08-30 on ofmchat: ten tickets
// carrying `needs-triage`, `source:roadmap` AND a parent spec at once (#118 →
// #11), and one sentence was enough to start triaging the lot — re-deciding a
// categorization those specs had already fixed.
//
// NEITHER SIGNAL DECIDES ALONE. A parent proves nesting, not provenance: a
// follow-up nested under its origin ticket is inbound and would be misjudged by
// a parent-only rule. A `source:` label declares intent, and the repository owns
// that vocabulary — so the gate reads the DECLARED label, the parent only
// colours the message, and a disagreement between the two is itself the finding.
//
// NO OVERRIDE AND NO REDIRECT. Every other precheck gate takes `--force`
// because it asks about state the operator may have already read. Here there is
// no other lane to offer: the two repairs are the ready label the spec flow owed
// the ticket, or a fix to the ticket itself.

const PROVENANCE = { spec: ['source:roadmap'], inbound: ['source:agent-found', 'source:user-report'] };

test('a spec-born ticket is refused in the triage lane because it is already agent-ready', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|spec 2 — ingestion|source:roadmap;needs-triage|11' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:roadmap/);
  assert.match(r.out, /#11/, 'the parent spec is named, so the refusal is checkable');
  assert.match(r.out, /published ready-for-agent by construction/);
  assert.match(r.out, /re-decide a categorization its spec already fixed/);
  // The two repairs, and NO third lane to switch to.
  assert.match(r.out, /gh issue edit 7 --repo acme\/widgets --add-label ready-for-agent/);
  assert.match(r.out, /defect in the ticket its spec produced/);
  assert.doesNotMatch(r.out, /--job refine/, 'there is no other pass to redirect into');
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'nothing was dispatched');
});

test('a spec label with no parent is a contradiction, and no pass is authorized', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|orphan roadmap ticket|source:roadmap|null' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /links to no spec|no parent/i);
  assert.doesNotMatch(r.out, /--job refine/);
});

test('an unreadable parent refuses the lane on the label alone, and the repair is the read', () => {
  // The label stands on its own as a reason to stop — it is the repository's
  // declaration of intent. It does not stand on its own as a reason to GO
  // either: "the parent could not be read" is an unknown, not a link (F-028),
  // so the repair is the readability rather than a verdict about the ticket.
  const gh = fakeGh({ 7: 'OPEN|0|a|source:roadmap' }, { parentField: false });
  const r = run(['--issue', '7', '--dry-run'], { root: repo({ provenance: PROVENANCE }), gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:roadmap/);
  assert.match(r.out, /could not be read/i);
  assert.doesNotMatch(r.out, /--job refine/, 'one signal authorizes nothing');
  assert.match(r.out, /--json parent/, 'the repair is the read that failed');
});

test('an INBOUND ticket is exactly what the triage lane is for, and passes the gate', () => {
  // The flat rule: triage is only for issues you did not create. An inbound
  // label is the repository saying this is one of those, so nothing is refused.
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|analyzer accepts prototype versions|source:agent-found|null' },
  });
  assert.equal(r.code, 0, 'the on-ramp does not gate the work it exists for');
});

test('one ticket carrying both vocabularies is refused without picking a side', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|a|source:roadmap;source:user-report|11' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:roadmap/);
  assert.match(r.out, /source:user-report/);
  // The negative assertion has to name something the OTHER branches would print,
  // or it asserts nothing. It used to read `--job refine`, which stopped existing
  // with that lane — leaving the test green against a gate that had started
  // picking a side. If the contradiction branch fell through, this ticket (spec
  // label + numeric parent) would land in the spec branch, whose repair offers
  // `--add-label ready-for-agent`: choosing the spec reading of a ticket that
  // declares both.
  assert.doesNotMatch(r.out, /--add-label ready-for-agent/, 'the tool does not choose between two declarations');
  assert.match(r.out, /remove whichever of the two is wrong/, 'the repair is to fix the contradiction, not to resolve it here');
});

test('a repository that declares no provenance keeps dispatching exactly as before', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    issues: { 7: 'OPEN|0|a|source:roadmap|11' },
  });
  assert.equal(r.code, 0, 'an undeclared vocabulary is not an inferred one');
});

test('a declared vocabulary the ticket does not carry gates nothing', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|a|needs-triage|null' },
  });
  assert.equal(r.code, 0);
});

// The brief lane applies labels too — `LABEL_JOBS` has said so since the
// vocabulary preflight was written — so it is judged by provenance for the same
// reason triage is: its child spec permits `Labels:` directives, and a spec-born
// ticket's categorization was decided by its spec. Measured on the 2026-08-30
// review: `readIssue` routed on a second, hand-kept list of jobs that had
// drifted from the first, so `--job brief` read no labels at all and the gate
// ran on an empty set — indistinguishable from a project that declared nothing.
test('a spec-born ticket refuses the BRIEF lane too, because a brief may apply labels', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|2|spec 2 — ingestion|source:roadmap;needs-triage|11' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:roadmap/);
  assert.match(r.out, /#11/);
  assert.match(r.out, /published ready-for-agent by construction/);
  assert.match(r.out, /gh issue edit 7 --repo acme\/widgets --add-label ready-for-agent/);
  assert.doesNotMatch(r.out, /--job refine/);
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'nothing was dispatched');
});

test('an INBOUND ticket is legitimate in the brief lane — a brief distils the triage pass that happened', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|2|analyzer accepts prototype versions|source:agent-found|null' },
  });
  assert.equal(r.code, 0, 'a brief follows the inbound triage pass that already ran');
});

// ── provenance: a finding your own agents filed ──────────────────────────────
//
// A third declared class. Inbound in the glossary's sense — it arrived instead
// of being planned — but it arrives WITH its measurement: the birth contract for
// a finding carries argv, raw output, expected state and cost, so the finder is
// the verifier and a triage or brief pass re-measures what is measured. Measured
// 2026-09-02 on the package's own checkout: two dozen findings ran through a
// triage pass and a brief pass each, hours of sessions for a pile where a third
// were ten-line repairs a maintainer closes in an hour, and the passes minted
// carve-out tickets and a duplicate. The route is the channel that owns what was
// found, and the verb names it instead of offering a pass. Opt-in: a project
// that declares no `findings` keeps the two-class behaviour to the byte.

const PROVENANCE_FINDINGS = { spec: ['source:roadmap'], inbound: ['source:user-report'], findings: ['source:agent-found'] };

test('a finding your own agents filed is refused in the triage lane, and the repair is the channel that owns it', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|worker dispatch --brief falls through|source:agent-found|null' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:agent-found/);
  assert.match(r.out, /finder is the verifier/);
  assert.match(r.out, /maintainer/, 'the instrument route is named');
  assert.match(r.out, /to-tickets/, 'the product route is named');
  assert.match(r.out, /gh issue edit 7 --repo acme\/widgets --remove-label source:agent-found/);
  assert.doesNotMatch(r.out, /--add-label ready-for-agent/, 'no lane is offered in its place');
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'nothing was dispatched');
});

test('the brief lane refuses a finding for the same reason — it applies labels too', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|2|worker dispatch --brief falls through|source:agent-found|null' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:agent-found/);
  assert.match(r.out, /a brief pass would re-measure/);
});

test('a custom pass applies no label, so a finding is not refused there', () => {
  const root = repo({ provenance: PROVENANCE_FINDINGS });
  const instruction = join(root, 'q.txt');
  writeFileSync(instruction, 'Measure the boot time\n');
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', instruction, '--dry-run'], {
    root,
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
  });
  assert.equal(r.code, 0, 'a bounded question about a finding decides nothing about it');
});

test('a finding declared inbound too is a contradiction, refused without picking a side', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found;source:user-report|null' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /source:agent-found/);
  assert.match(r.out, /source:user-report/);
  assert.match(r.out, /remove whichever/, 'the repair is to fix the contradiction, not to resolve it here');
});

test('a project that declares no findings class keeps admitting the same ticket', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
  });
  assert.equal(r.code, 0, 'an undeclared class is not an inferred one');
});

// A tracker label name is case-insensitively unique on GitHub, so comparing the
// declared name to the carried one byte-exactly buys nothing and costs the gate:
// a config that wrote `Source:Roadmap`, or left a trailing space, produced an
// empty intersection — which this function cannot tell from "this project
// declared no vocabulary", so it returned null and the wrong lane started.
test('a declared provenance label gates despite case and surrounding whitespace', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: { spec: [' Source:Roadmap '], inbound: ['source:user-report'] } }),
    issues: { 7: 'OPEN|0|spec sub-issue|source:roadmap|11' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Source:Roadmap/, 'the refusal prints the DECLARED name that matched, not a normalized form');
  assert.match(r.out, /published ready-for-agent by construction/);
});

// `meta.parent === undefined` has three causes and only one of them is a `gh`
// too old to answer `--json parent`. Offering the upgrade for the other two
// sends the operator after a binary that answered fine; and the label-removal
// clause that used to ride along was worse than useless — removing the spec
// label routes a spec-born ticket into the very pass this gate exists to stop.
test('an unreadable parent from a gh CAPABILITY gap offers the upgrade, and never the label removal', () => {
  const gh = fakeGh({ 7: 'OPEN|0|a|source:roadmap' }, { parentField: false });
  const r = run(['--issue', '7', '--dry-run'], { root: repo({ provenance: PROVENANCE }), gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /could not be read/i);
  assert.match(r.out, /gh --version/);
  assert.match(r.out, /--json parent/);
  assert.doesNotMatch(r.out, /--remove-label/, 'removing the spec label starts the pass the gate refused');
  assert.doesNotMatch(r.out, /--job refine/, 'one signal authorizes nothing');
});

test('a parent key ABSENT from an answer gh gave names the read, not an upgrade', () => {
  const gh = fakeGh({ 7: 'OPEN|0|a|source:roadmap' }, { omitParent: true });
  const r = run(['--issue', '7', '--dry-run'], { root: repo({ provenance: PROVENANCE }), gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /could not be read/i);
  assert.match(r.out, /no parent key/i, 'the cause is named, because the three repairs differ');
  assert.doesNotMatch(r.out, /gh --version/, 'this gh answered — upgrading it repairs nothing');
  assert.doesNotMatch(r.out, /--remove-label/);
  assert.match(r.out, /gh issue view 7 --repo acme\/widgets --json parent/);
});

test('an UNPARSEABLE parent number names that, rather than sending the operator to gh --version', () => {
  const gh = fakeGh({ 7: 'OPEN|0|a|source:roadmap' }, { malformedParent: true });
  const r = run(['--issue', '7', '--dry-run'], { root: repo({ provenance: PROVENANCE }), gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /could not be read/i);
  assert.match(r.out, /not a usable issue number/i);
  assert.doesNotMatch(r.out, /gh --version/);
  assert.doesNotMatch(r.out, /--remove-label/);
  assert.match(r.out, /gh issue view 7 --repo acme\/widgets --json parent/);
});

// This diff widened the parent-bearing read from refine to every label-applying
// lane, so the DEFAULT lane now asks for `parent` and can reach the non-zero
// fallback where its old `state,title,comments` read would have succeeded. A
// token, network or permission failure reading as "not found in acme/widgets"
// sends the operator to look for an issue that is sitting right there.
test('a non-capability gh failure surfaces its exit and stderr, never a guessed "not found"', () => {
  const gh = {
    asked: [],
    exec: (bin, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: `${REPO}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '  HTTP 401: Bad credentials\n' };
    },
  };
  const r = run(['--issue', '7'], { gh });
  assert.equal(r.code, 1);
  assert.match(r.out, /#7 UNREADABLE/);
  assert.match(r.out, /exit 1/);
  assert.match(r.out, /Bad credentials/);
  assert.doesNotMatch(r.out, /not found in/, 'a non-zero exit is not evidence the issue is absent');
  assert.match(
    r.out,
    /gh issue view 7 --repo acme\/widgets --json state,title,comments/,
    'the repair is the narrower read that isolates a parent-field failure',
  );
  assert.deepEqual(r.started, []);
});

// `--repo` is a real flag, so a repair pasted into a shell in a different
// checkout re-resolves the issue NUMBER against whatever repo it lands in — and
// mutates a different ticket. Every repair this gate prints carries it.
test('every provenance repair carries --repo, so a pasted repair cannot address another repo', () => {
  const spec = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|a|source:roadmap|11' },
  });
  const repairs = spec.out.split('\n').filter(line => line.includes('gh issue'));
  assert.ok(repairs.length >= 2, 'both repairs are printed');
  for (const line of repairs) assert.match(line, /--repo acme\/widgets/, line);
});

test('the brief lane verifies its role pair off the one shared map', () => {
  const good = run(['--issue', '7', '--job', 'brief'], {
    issues: { 7: 'OPEN|2|a' },
    proofFn: () => ({ model: { model: 'm', role: 'default' }, sessionRole: { status: 'applied', role: 'triage-worker', skills: ['triage'] } }),
  });
  assert.equal(good.code, 0);
  assert.match(good.out, /triage-worker \+ triage reached the first turn/);
  assert.match(good.started[0], /\.scratch\/triage\/brief-acme-widgets-7\.spec\.txt/, 'the spec file lands beside the draft, in the one draft dir');
  const wrong = run(['--issue', '7', '--job', 'brief'], {
    env: { AX_TRIAGE_ROLE_WAIT: '0' },
    issues: { 7: 'OPEN|2|a' },
    proofFn: () => ({ model: { model: 'm', role: 'default' }, sessionRole: { status: 'applied', role: 'launch-worker', skills: ['launch'] } }),
  });
  assert.equal(wrong.code, 3);
  assert.match(wrong.out, /expected triage-worker/);
});

test('AX_READY_ROLE_WAIT is refused and the repair names AX_TRIAGE_ROLE_WAIT', () => {
  const r = run(['--issue', '7', '--dry-run'], { env: { AX_READY_ROLE_WAIT: '0' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /AX_READY_ROLE_WAIT is set/);
  assert.match(r.out, /unset AX_READY_ROLE_WAIT and export AX_TRIAGE_ROLE_WAIT instead/);
  assert.deepEqual(r.started, []);
});

test('an empty AX_READY_ROLE_WAIT does not refuse', () => {
  const r = run(['--issue', '7', '--dry-run'], { env: { AX_READY_ROLE_WAIT: '' } });
  assert.equal(r.code, 0);
});

test('roleWaitOf honours AX_TRIAGE_ROLE_WAIT and still defaults to 30', () => {
  assert.deepEqual(roleWaitOf({}), { ok: true, wait: 30 });
  assert.deepEqual(roleWaitOf({ AX_TRIAGE_ROLE_WAIT: '0' }), { ok: true, wait: 0 });
  assert.deepEqual(roleWaitOf({ AX_TRIAGE_ROLE_WAIT: '12' }), { ok: true, wait: 12 });
});

test('roleWaitOf refuses AX_READY_ROLE_WAIT rather than reading it', () => {
  const out = roleWaitOf({ AX_READY_ROLE_WAIT: '0' });
  assert.equal(out.ok, false);
  assert.equal(out.from, 'AX_READY_ROLE_WAIT');
  assert.equal(out.to, 'AX_TRIAGE_ROLE_WAIT');
  assert.equal(roleWaitOf({ AX_READY_ROLE_WAIT: '' }).ok, true);
});
