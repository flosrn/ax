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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch, roleWaitOf } from '../src/triage/dispatch.mjs';
import { createRunner } from '../src/orca-bin.mjs';
import { quote } from '../src/worker/hosts.mjs';
import { slugOf, transcript } from '../src/worker/transcript.mjs';

const REPO = 'acme/widgets';

/** A real git repo with a label contract, because the preflight reads both. */
function repo({ labels = 'docs/agents/triage-labels.md', provenance, dispatch: block, at } = {}) {
  // `at` exists for one proposition: a checkout path carrying whitespace or a
  // shell metacharacter, which is what a printed repair has to survive.
  if (at !== undefined) mkdirSync(at, { recursive: true });
  const root = realpathSync(at ?? mkdtempSync(join(tmpdir(), 'ax-triage-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({
      project: { name: 'widgets' },
      apps: { web: 'apps/web' },
      vendor: { repo: 'owner/kit' },
      triage: provenance === undefined ? { labels } : { labels, provenance },
      ...(block === undefined ? {} : { dispatch: block }),
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

/**
 * A `gh` that answers per issue from a table, and records what it was asked.
 *
 * `text` is the issue's own prose, keyed by issue number: `{ body, comments }`.
 * It is answered because the admission rule READS it — a finding is admitted to
 * a pass on a necessity justification written in the issue, so a fake that
 * answered labels but no prose would let a test pass on a read that never
 * happened. `omitBody` and `omitCommentBody` are the tracker answering with the
 * key ABSENT, which is an unknown and not an empty string (F-028).
 */
function fakeGh(
  issues = { 7: 'OPEN|0|Widget falls over' },
  { parentField = true, omitParent = false, malformedParent = false, text = {}, omitBody = false, omitCommentBody = false } = {},
) {
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
        const prose = text[args[2]] ?? {};
        const bodies = prose.comments ?? [];
        const body = {
          state,
          title,
          comments: Array.from({ length: Number(count) }, (unused, index) => (omitCommentBody ? {} : { body: bodies[index] ?? '' })),
        };
        if (!omitBody) body.body = prose.body ?? '';
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
  const gh = options.gh ?? fakeGh(options.issues, options.tracker ?? {});
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

/**
 * A settled dispatch record, as `worker start --tracker-repo` would have written
 * it. `repo` is what places the pane in a repository: the per-repository cap
 * counts only the panes whose record NAMES this checkout, and an absent key is
 * UNKNOWN rather than ours (F-028).
 */
function record(store, request, { handle = 'term_child', dispatchId = 'd-1', repo = REPO } = {}) {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      createdAt: '2026-08-20T10:00:00.000Z',
      ...(repo === '' ? {} : { repo }),
      attempts: [
        {
          n: 1,
          phases: [
            {
              name: 'worker-start',
              // Every real phase is written ahead with the argv it issues, and
              // the index reads a phase naming none as unreadable (#130).
              argv: ['orca', 'orchestration', 'worker-start'],
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

// ── the caps: per repository by default, machine ceiling opt-in (#88) ────────

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
    root: repo({ dispatch: { cap: 2 } }),
  });
  assert.equal(r.code, 0, 'three unrelated panes do not consume triage capacity');
});

test('one over the per-repository cap is refused, and the refusal shows the arithmetic', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-1', { handle: 'term_a', dispatchId: 'd-a' });
  record(store, 'triage-acme-widgets-2', { handle: 'term_b', dispatchId: 'd-b' });
  const r = run(['--issue', '7'], { home, store, orca: { panes: ['term_a', 'term_b'] }, root: repo({ dispatch: { cap: 2 } }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /2 live pane\(s\) in acme\/widgets \+ 1 new > dispatch\.cap 2/);
  assert.match(r.out, /raise dispatch\.cap/, 'the repair names the declared value, never an env knob');
  assert.deepEqual(r.started, []);
});

test('#161: a pane recorded by a legacy repair phase fills this verb’s cap too', () => {
  // The THIRD verb through the one reader (ruled shape 2, 2026-09-04). The
  // dispatch index carries a handle only for a `worker-start` phase, so a pane
  // the bash-era `--inject` repair opened occupied no slot here while
  // `ax worker ls` printed it VIVANT — the count that gates and the count that
  // is read disagreeing about one machine.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, 'triage-acme-widgets-1.json'),
    JSON.stringify({
      request: 'triage-acme-widgets-1',
      createdAt: '2026-08-20T10:00:00.000Z',
      repo: REPO,
      attempts: [
        {
          n: 1,
          phases: [
            // The failed start carries no effects at all: nothing about this
            // pane is a worker-start fact.
            {
              name: 'worker-start',
              argv: ['orca', 'orchestration', 'worker-start'],
              beganAt: '2026-08-20T10:00:00.000Z',
              exit: 1,
              receipt: { ok: false, error: { code: 'agent_readiness', message: 'timeout' } },
            },
            {
              name: 'worker-start-inject',
              argv: ['orca', 'orchestration', 'worker-start-inject'],
              beganAt: '2026-08-20T10:05:00.000Z',
              exit: 0,
              receipt: { ok: true, result: { dispatchId: 'd-inject', state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: 'term_live' }] } },
            },
          ],
        },
      ],
    }),
  );

  const r = run(['--issue', '7'], { home, store, orca: { panes: ['term_live'] }, root: repo({ dispatch: { cap: 1 } }) });
  assert.equal(r.code, 1, 'the pane is up, so the one slot this repository declared is taken');
  assert.match(r.out, /1 live pane\(s\) in acme\/widgets \+ 1 new > dispatch\.cap 1/);
  assert.deepEqual(r.started, []);
});

test('#88: panes belonging to ANOTHER repository never park this one', () => {
  // The reported measurement, on the verb that did refuse: live panes that all
  // belong to another checkout, and a 13-issue wave here running at one slot.
  // With no ceiling armed, this repository has its whole cap.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'other-1', { handle: 'term_far_a', dispatchId: 'd-fa', repo: 'goodluckagency/ofmchat' });
  record(store, 'other-2', { handle: 'term_far_b', dispatchId: 'd-fb', repo: 'goodluckagency/ofmchat' });
  // A pane whose record names no repository at all: it may be anyone's, so it
  // counts toward the machine total only (F-028).
  record(store, 'nameless-1', { handle: 'term_far_c', dispatchId: 'd-fc', repo: '' });
  const r = run(['--issue', '7', '--dry-run'], {
    home,
    store,
    orca: { panes: ['term_far_a', 'term_far_b', 'term_far_c'] },
    root: repo({ dispatch: { cap: 3 } }),
  });
  assert.equal(r.code, 0, "another project's wave is not this repository's cap");
  assert.match(r.out, /3 live pane\(s\) on this machine/, 'the machine total is still disclosed');
  assert.match(r.out, /no dispatch\.machineCap/, 'and it says nothing gates on it here');
});

test('#88: an ARMED machine ceiling refuses, and names the ceiling rather than the cap', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'other-1', { handle: 'term_far_a', dispatchId: 'd-fa', repo: 'goodluckagency/ofmchat' });
  record(store, 'other-2', { handle: 'term_far_b', dispatchId: 'd-fb', repo: 'goodluckagency/ofmchat' });
  const r = run(['--issue', '7'], {
    home,
    store,
    orca: { panes: ['term_far_a', 'term_far_b'] },
    root: repo({ dispatch: { cap: 3, machineCap: 2 } }),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /2 live pane\(s\) on this machine \+ 1 new > dispatch\.machineCap 2/);
  assert.match(r.out, /0 of them in acme\/widgets/, 'both numbers, so the reader knows which fence it hit');
  assert.match(r.out, /raise dispatch\.machineCap/);
  assert.deepEqual(r.started, []);
});

test('exactly at the cap the run is allowed — the boundary is greater-than', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-1', { handle: 'term_a', dispatchId: 'd-a' });
  const r = run(['--issue', '7', '--dry-run'], { home, store, orca: { panes: ['term_a'] }, root: repo({ dispatch: { cap: 2 } }) });
  assert.equal(r.code, 0);
});

test('a cap of zero is legal, and stops every new session', () => {
  const r = run(['--issue', '7'], { root: repo({ dispatch: { cap: 0 } }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /0 live pane\(s\) in acme\/widgets \+ 1 new > dispatch\.cap 0/);
});

test('the cap counts every new issue in the batch, not the invocation', () => {
  const r = run(['--issue', '7', '--issue', '8', '--issue', '9'], {
    issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b', 9: 'OPEN|0|c' },
    root: repo({ dispatch: { cap: 2 } }),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /0 live pane\(s\) in acme\/widgets \+ 3 new > dispatch\.cap 2/);
});

test('an undeclared dispatch.cap is 3 — the fairness cap binds even where nobody declared it', () => {
  const r = run(['--issue', '7', '--issue', '8', '--issue', '9', '--issue', '10'], {
    issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b', 9: 'OPEN|0|c', 10: 'OPEN|0|d' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /\+ 4 new > dispatch\.cap 3/);
});

test('an issue that already has a dispatch record is not new, so it does not consume cap', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const store = join(home, 'store');
  record(store, 'triage-acme-widgets-7', { handle: 'term_gone', dispatchId: 'd-7' });
  const r = run(['--issue', '7'], { home, store, orca: { panes: [] }, root: repo({ dispatch: { cap: 0 } }) });
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
    root: repo({ dispatch: { cap: 1 } }),
  });
  assert.equal(r.code, 0);
});

test('both retired cap knobs are refused, and the repair names dispatch.machineCap', () => {
  // An env var whose name says `triage` while it gated every verb, defaulting
  // to 3 whether or not anyone armed it, is #88's bug in a knob. It is refused
  // BY NAME rather than read past, exactly as its own predecessor was.
  for (const from of ['ORCA_TRIAGE_SESSION_CAP', 'ORCA_READY_SESSION_CAP']) {
    const r = run(['--issue', '7'], { env: { [from]: '5' } });
    assert.equal(r.code, 1, `${from} is not read past`);
    assert.match(r.out, new RegExp(`${from} is set`));
    assert.match(r.out, /dispatch\.machineCap/);
    assert.deepEqual(r.started, []);
  }
});

test('an empty retired knob does not refuse', () => {
  const r = run(['--issue', '7', '--dry-run'], { env: { ORCA_READY_SESSION_CAP: '', ORCA_TRIAGE_SESSION_CAP: '' } });
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
  const r = run(['--issue', '7', '--issue', '8'], { issues: { 7: 'OPEN|0|a', 8: 'OPEN|0|b' }, root: repo({ dispatch: { cap: 5 } }) });
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

// Issue #97: this is the ONE exit that fires on a healthy child that merely
// booted slowly, and it was the one naming no repair — against the AGENTS.md
// rule this repository enforces ("a `bad` without a `fix` is a finding neither
// an agent nor a human can act on"). Two repairs exist and both have to be
// named: the read that re-derives the proof for THIS pass, and the way to
// widen the window that closed too early.
test('the no-receipt verdict names both repairs — the request-scoped read, and the wider window', () => {
  const r = run(['--issue', '7'], {
    env: { AX_TRIAGE_ROLE_WAIT: '0' },
    proofFn: () => null,
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /--dispatch-proof/, 'the verb that actually reads the session file');
  // Quoted since #208's review: the line is pasted into a shell, and every
  // value in it is data.
  assert.match(r.out, /--request 'triage-acme-widgets-7'/, 'scoped to this pass, not newest-wins across the wave');
  assert.match(r.out, /--wait/, 'and the flag that would have kept the window open');
  assert.match(r.out, /AX_TRIAGE_ROLE_WAIT/, 'including the machine-wide default it reads');
});

// #204 — THE PRINTED REPAIR HAS TO EXECUTE, and the proof of that is a SHELL
// running the bytes it printed. Matching its shape, or calling the verb's
// function with a hand-split argv, is what let a line that cannot run pass for
// a repair once already (review of #208): both skip the two things that break
// it — word splitting and expansion.
//
// Measured 2026-09-05 on integrated main f446f229: this loop held the whole
// checkout path and handed the resolver `basename(root)`, then composed that
// same basename into the recovery it printed. On the reporting host two session
// directories end in `-ax`, so no read inside the 120 s window could have
// answered, and the printed recovery reproduced the inability it repairs —
// exit 1, both streams empty. The key is now the checkout's own session slug,
// quoted, which names one directory by construction.

/** `ax` on PATH pointing at THIS checkout's bin, plus the machine answer `worker` is gated on. */
function shim(home) {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = fileURLToPath(new URL('../bin/ax.mjs', import.meta.url));
  writeFileSync(join(dir, 'ax'), `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(bin)} "$@"\n`, { mode: 0o755 });
  // `worker` is `gated: 'orca'`, so a machine resolving no Orca binary does not
  // have the noun at all. `ORCA_BIN` only has to be EXECUTABLE — visibility and
  // liveness are two propositions — and the proof branch answers before
  // anything probes a runtime, so this stub is never run and the suite stays
  // offline.
  const orca = join(dir, 'orca-never-run');
  writeFileSync(orca, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return { path: dir, orca };
}

/** The `→ …` line a verdict printed, without the decoration or the trailing note. */
const repairIn = text =>
  (text.split('\n').find(line => line.includes('→ ax worker transcript')) ?? '')
    .replace(/^\s*→\s*/, '')
    .replace(/\s{3,}#.*$/, '');

test('#204 the CANNOT-ESTABLISH repair line runs, from a checkout path a shell would mangle', () => {
  // A checkout whose own path word-splits, globs, and would EXECUTE if it ever
  // reached a shell unquoted — `$(touch …)` is the assertion, since a wrong
  // quoting leaves the sentinel behind.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ax-triage-shell-')));
  const sentinel = join(parent, 'expanded');
  const root = repo({ at: join(parent, `my ax; $(touch ${sentinel}) *`) });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-home-')));
  const { path, orca } = shim(home);
  const asked = [];
  const r = run(['--issue', '7'], {
    root,
    home,
    env: { AX_TRIAGE_ROLE_WAIT: '0' },
    proofFn: options => (asked.push(options), null),
  });

  assert.equal(r.code, 3);
  assert.equal(asked[0].cwd, root, 'the wait passes the checkout it holds, not only that path\'s basename');

  const printed = repairIn(r.out);
  assert.ok(printed.startsWith('ax worker transcript'), `the verdict printed no proof recovery at all:\n${r.out}`);

  // The child this pass really dispatched, on disk: its record names the
  // dispatch Orca minted, and its session's first turn names the same id.
  const request = 'triage-acme-widgets-7';
  record(r.store, request, { dispatchId: 'ctx_204204204204' });
  const sessions = join(home, '.omp', 'agent', 'sessions');
  const mine = join(sessions, slugOf(root, { HOME: home }));
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    join(mine, '2026-09-05T21-00-00-000Z_child.jsonl'),
    [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'You are a dispatched worker. Your dispatch is ctx_204204204204.' }] } }),
      JSON.stringify({ type: 'model_change', model: 'claude-opus-5', role: 'default' }),
      JSON.stringify({ type: 'custom_message', customType: 'skill-prompt', details: { role: 'triage-worker', skills: ['triage'], status: 'applied' } }),
    ].join('\n'),
  );
  // THE COLLISION, which is the whole reason this test exists: a second session
  // directory whose slug ends in this checkout's basename.
  mkdirSync(join(sessions, `-elsewhere-${basename(root)}`), { recursive: true });

  // The printed bytes, handed to a POSIX shell exactly as an operator pastes
  // them. Nothing is re-quoted or re-split here.
  //
  // `cwd` IS THE CHECKOUT IT WAS PRINTED IN, which is the criterion's own
  // wording and not decoration: `bin/ax.mjs` is a delegating entry that walks
  // up from the cwd for a project that declared an ax pin (../src/delegation.mjs),
  // so inheriting the runner's cwd would leave WHICH ax answers to the machine
  // this suite happens to run on.
  const shell = command =>
    spawnSync('sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      env: { HOME: home, PATH: `${path}:/usr/bin:/bin`, ORCA_DISPATCH_STORE: r.store, ORCA_BIN: orca },
    });

  const ran = shell(printed);
  assert.equal(ran.status, 0, `the printed repair did not run:\n${printed}\n${ran.stderr}`);
  assert.equal(JSON.parse(ran.stdout).sessionRole.role, 'triage-worker', 'and it answered with THIS checkout\'s own receipt');
  assert.equal(existsSync(sentinel), false, 'the checkout path was pasted as DATA — nothing in it was expanded');

  // AND THE BINARY THE SHELL REACHED IS THIS CODE. Without this the run above
  // could be satisfied by any ax on the machine and would prove nothing about
  // this one. What identifies it is that a refused proof SPEAKS on stderr at
  // all — before #204 that branch returned exit 1 with both streams empty — and
  // that what it says carries a repair, which is the rule AGENTS.md states.
  const reached = shell(`ax worker transcript --dispatch-proof no-such-checkout --request ${quote(request)}`);
  assert.equal(reached.status, 1, 'still exit 1: the protocol did not move');
  assert.equal(reached.stdout, '', 'and stdout is still the payload channel, still empty');
  assert.match(reached.stderr, /✗ /, 'the ax the shell reached names its refusal — only this code does');
  assert.match(reached.stderr, /→ ax /, 'and names what repairs it');

  // The key it replaced, on the same fixture: still ambiguous, still refused.
  const old = capture(() => transcript(['--dispatch-proof', basename(root), '--request', request], { env: { HOME: home, ORCA_DISPATCH_STORE: r.store } }));
  assert.equal(old.code, 1, 'the basename names two checkouts here — that is the failure this line was printing');
});

// The reported friction: 30 s against the worker family's 120 s for one
// proposition, with no flag to widen it. The window is now the caller's, and
// the value it was given is what the refusal reports.
test('--wait bounds the role-verification window, and the refusal names the value it used', () => {
  let clock = 0;
  const r = run(['--issue', '7', '--wait', '7'], {
    now: () => (clock += 1000),
    proofFn: () => null,
  });
  assert.equal(r.code, 3);
  assert.match(r.out, /within 7s/, 'the wait the caller asked for, not the built-in default');
  assert.doesNotMatch(r.out, /within 120s/);
});

test('--wait wins over AX_TRIAGE_ROLE_WAIT, which wins over the built-in default', () => {
  let clock = 0;
  const flagged = run(['--issue', '7', '--wait', '3'], {
    env: { AX_TRIAGE_ROLE_WAIT: '99' },
    now: () => (clock += 1000),
    proofFn: () => null,
  });
  assert.match(flagged.out, /within 3s/, 'the per-invocation override is the last word');

  let envClock = 0;
  const fromEnv = run(['--issue', '7'], {
    env: { AX_TRIAGE_ROLE_WAIT: '9' },
    now: () => (envClock += 1000),
    proofFn: () => null,
  });
  assert.match(fromEnv.out, /within 9s/, 'the machine default still overrides the built-in one');
});

// Validated the way the worker family validates its own (`src/worker/
// dispatch.mjs`), never silently defaulted: a malformed window that reads as
// 120 is the same class of silence as the knob nobody could discover.
test('a malformed or valueless --wait is a usage error naming the reason', () => {
  const bad = run(['--issue', '7', '--wait', 'soon']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /--wait expects a number of seconds/);
  assert.deepEqual(bad.started, [], 'nothing is dispatched on a usage error');

  const bare = run(['--issue', '7', '--wait']);
  assert.equal(bare.code, 2);
  assert.match(bare.out, /--wait expects a number of seconds/);
  assert.deepEqual(bare.started, []);

  const negative = run(['--issue', '7', '--wait', '-5']);
  assert.equal(negative.code, 2, 'a negative window is not a window');
  assert.deepEqual(negative.started, []);
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

test('a triage record NAMES its repository, because that key is what places its pane', () => {
  // #83: `ax worker release` scopes by the record's `repo` — a record naming
  // none is UNKNOWN, and unknown authorizes no close (F-028). A triage dispatch
  // that recorded no repository would hand `ax triage release` a pane it can
  // never free. AX-OWNED like `--because`: Orca never sees it.
  const r = run(['--issue', '7']);
  assert.match(r.started[0], /--tracker-repo acme\/widgets/);
  assert.ok(
    r.started[0].indexOf('--tracker-repo') < r.started[0].indexOf(' -- '),
    'it is a recorded option, never forwarded past the placement separator',
  );
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
    root: repo({ dispatch: { cap: 5 } }),
    env: { AX_TRIAGE_ROLE_WAIT: '0' },
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
          phases: [{ name: 'worker-start', argv: ['orca', 'orchestration', 'worker-start'], beganAt: '2026-08-20T10:00:00.000Z', exit: 1, receipt: { ok: false, error: { code: 'runtime_unavailable' } } }],
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
              argv: ['orca', 'orchestration', 'worker-start'],
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
//
// ONE ADMISSION (#188). A blanket refusal has its own cost: a finding whose
// repair an APPROVED spec cannot be satisfied without had no lane at all — the
// maintainer channel answers the instrument's frictions and `to-tickets` needs a
// human to amend a spec, so necessary work discovered mid-wave waited on a
// person who was not in the room. So a finding is admitted when its own issue
// names the approved obligation it serves, in the one line the necessity
// vocabulary defines (`src/triage/necessity.mjs`). The tool grades the SHAPE —
// an identified spec, a written obligation, read from the issue itself — and
// never the merit: whether the work is genuinely necessary is the triage pass's
// analysis and the orchestrator's ruling, which is why admission to a pass is
// not authorization to implement.

const PROVENANCE_FINDINGS = { spec: ['source:roadmap'], inbound: ['source:user-report'], findings: ['source:agent-found'] };

/** The justification as the vocabulary defines it: an identified spec, then the obligation. */
const NECESSITY = 'Necessary for: #174 — the Gate ground "every check-run page is read" stays unsatisfied while the reader pages once.';

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

test('a finding whose issue names the approved obligation it serves is admitted to the triage lane', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|check-run reader pages once|source:agent-found|null' },
    tracker: { text: { 7: { body: `argv: ax pr gate --pr 12\n\n${NECESSITY}\n` } } },
  });
  assert.equal(r.code, 0, `a justified finding gets its pass: ${r.out}`);
  assert.match(r.out, /source:agent-found/, 'the class it keeps is named');
  assert.match(r.out, /#174/, 'the approved obligation it serves is named in the receipt');
  assert.match(r.out, /admitted/, 'the receipt says the lane was opened, not merely that nothing refused it');
  assert.doesNotMatch(r.out, /finder is the verifier/, 'the blanket refusal is not printed over an admission');
});

// Admission is a PASS, and a pass decides nothing about implementation: the
// frontier reads the ready label, which only the brief publication applies. A
// receipt that said "admitted" and nothing else would be read as a green light.
test('the admission says out loud that it is not readiness', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|check-run reader pages once|source:agent-found|null' },
    tracker: { text: { 7: { body: NECESSITY } } },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /frontier/, 'the authority for implementation dispatch is named');
});

// The justification is not required to be in the body: the obligation is
// frequently established by the orchestrator's own ruling, which lands as a
// comment. A reader that looked at the body alone would refuse the ticket its
// own operator had just justified. Triage still hits F-030 on any comment, so
// --force is the documented repair once those comments have been read.
test('a justification written in a comment is read too', () => {
  const r = run(['--issue', '7', '--force', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|1|check-run reader pages once|source:agent-found|null' },
    tracker: { text: { 7: { body: 'argv: ax pr gate --pr 12\n', comments: [NECESSITY] } } },
  });
  assert.equal(r.code, 0, `the triage lane reads a comment justification: ${r.out}`);
  assert.match(r.out, /#174/);
});

// A Necessary for: comment is not a completed triage pass. The brief precheck
// used to treat any nonzero comment count as something to distil, so a
// justification comment admitted --job brief and the child was told not to
// analyse. Brief distils a recorded draft or a published triage artifact.
test('a Necessary for: comment does not admit the brief lane', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|1|check-run reader pages once|source:agent-found|null' },
    tracker: { text: { 7: { body: 'argv: ax pr gate --pr 12\n', comments: [NECESSITY] } } },
  });
  assert.equal(r.code, 1, `a justification comment is not a triage pass: ${r.out}`);
  assert.match(r.out, /not a brief/);
  assert.match(r.out, /ax triage dispatch --issue 7/);
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'nothing was dispatched');
});

test('the brief lane admits a justified finding once a triage draft exists to distil', () => {
  const root = repo({ provenance: PROVENANCE_FINDINGS });
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md'), 'Verdict: page every check-run.\n');
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], {
    root,
    issues: { 7: 'OPEN|0|check-run reader pages once|source:agent-found|null' },
    tracker: { text: { 7: { body: NECESSITY } } },
  });
  assert.equal(r.code, 0, `brief distils the recorded draft: ${r.out}`);
  assert.match(r.out, /admitted/);
});


// The read is the proof. A gate that judged admission from labels alone would
// pass this test suite and admit every finding on the tracker.
test('the issue content admission is judged on is actually asked for', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
    tracker: { text: { 7: { body: NECESSITY } } },
  });
  const view = r.asked.find(line => line.includes('issue view 7'));
  assert.ok(view, 'the issue was read');
  assert.match(view, /--json [^ ]*\bbody\b/, `the body is in the read: ${view}`);
  assert.match(view, /--json [^ ]*\bcomments\b/, `so are the comments: ${view}`);
});

test('a bare spec reference names no obligation, so it is not a justification', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
    tracker: { text: { 7: { body: 'Necessary for: #174\n' } } },
  });
  assert.equal(r.code, 1, 'a number is an identification, not a written necessity');
  assert.match(r.out, /finder is the verifier/);
});

test('a justification that identifies no approved spec is refused', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
    tracker: { text: { 7: { body: 'Necessary for: the gate — it would be much nicer if this paged properly.\n' } } },
  });
  assert.equal(r.code, 1, 'necessity is measured against an identified approved spec, never against a preference');
  assert.match(r.out, /finder is the verifier/);
});

// The refusal has to name what would make the ticket admissible, WITH the bound
// on it: an improvement an agent recommends is not necessary work, and a repair
// line that read "write the line" without that bound is a recipe for minting one.
test('the refusal names the admission route and the bound on it', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Necessary for: #/, 'the line the vocabulary defines is quoted');
  assert.match(r.out, /recommend/, 'and the bound: an agent recommending it is not necessity');
});

// F-028 in the admission's own shape. An issue whose text the tracker did not
// answer is not an issue that carries no justification, and the two have
// different repairs: read the issue, versus route the finding.
test('an unanswered issue body makes the justification unknown, never absent', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
    tracker: { omitBody: true },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /F-028|unknown/i, 'the state is named as an unknown');
  assert.match(r.out, /--json body/, 'and the repair is the read that failed');
  assert.doesNotMatch(r.out, /admitted/, 'an unknown never admits');
});

test('a comment whose body the tracker did not answer is an unknown too', () => {
  const r = run(['--issue', '7', '--job', 'brief', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|2|a|source:agent-found|null' },
    tracker: { omitCommentBody: true, text: { 7: { body: 'argv: ax pr gate --pr 12\n' } } },
  });
  assert.equal(r.code, 1, 'a justification could be in the comment nobody could read');
  assert.match(r.out, /F-028|unknown/i);
});

// The admission is the findings class's own, and it does not travel: a spec-born
// ticket writing the line would be the spec flow's own work re-entering the
// on-ramp, which is the thing the class above exists to refuse.
test('a spec-born ticket carrying a necessity justification is still refused', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|spec 2 — ingestion|source:roadmap|11' },
    tracker: { text: { 7: { body: NECESSITY } } },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /published ready-for-agent by construction/);
  assert.doesNotMatch(r.out, /admitted/);
});

// A justified finding is still one ticket with one origin. Admission decides
// which LANE it may enter, never which class it is.
test('a justified finding that also carries an inbound label stays a contradiction', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE_FINDINGS }),
    issues: { 7: 'OPEN|0|a|source:agent-found;source:user-report|null' },
    tracker: { text: { 7: { body: NECESSITY } } },
  });
  assert.equal(r.code, 1, 'no pass follows from a contradiction, justified or not');
  assert.match(r.out, /remove whichever/);
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

// The contradiction rule is job-independent — "no pass follows from a
// contradiction" — so the custom lane has to SEE the labels too. Review of the
// first draft (Codex, P2) caught that `readIssue` asked for labels only in the
// label-applying lanes, which handed this branch an empty list under
// `--job custom` and dispatched the contradictory ticket. Labels are now read
// for every job; only the parent read stays scoped to the routed lanes.
test('a custom pass on a ticket carrying two provenance classes is refused as well', () => {
  const root = repo({ provenance: PROVENANCE_FINDINGS });
  const instruction = join(root, 'q.txt');
  writeFileSync(instruction, 'Measure the boot time\n');
  const r = run(['--issue', '7', '--job', 'custom', '--instruction', instruction, '--dry-run'], {
    root,
    issues: { 7: 'OPEN|0|a|source:agent-found;source:user-report|null' },
  });
  assert.equal(r.code, 1, 'no pass follows from a contradiction, a bounded one included');
  assert.match(r.out, /remove whichever/);
  assert.ok(r.calls.every(line => !line.includes('worker-start')), 'nothing was dispatched');
});

test('a project that declares no findings class keeps admitting the same ticket', () => {
  const r = run(['--issue', '7', '--dry-run'], {
    root: repo({ provenance: PROVENANCE }),
    issues: { 7: 'OPEN|0|a|source:agent-found|null' },
  });
  assert.equal(r.code, 0, 'an undeclared class is not an inferred one');
});

// The admission is the third class's rule, so a project that never declared the
// class has nothing to admit and nothing to refuse: an unreadable body, a
// missing justification and a written one all behave the way they did before
// this rule existed. An absent declaration is not a rule (F-028).
test('a project that declares no findings class is untouched by the admission rule', () => {
  const undeclared = repo({ provenance: PROVENANCE });
  for (const tracker of [{}, { omitBody: true }, { text: { 7: { body: NECESSITY } } }]) {
    const r = run(['--issue', '7', '--dry-run'], {
      root: undeclared,
      issues: { 7: 'OPEN|0|a|source:agent-found|null' },
      tracker,
    });
    assert.equal(r.code, 0, `an undeclared class judges nothing: ${r.out}`);
    assert.doesNotMatch(r.out, /admitted/, 'and says nothing about an admission it never ran');
  }
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

// Updated rather than deleted (issue #97): the proposition is still "the env
// name is honoured and there is a built-in default", and the default is now the
// worker family's proven 120 — one proposition, one window, both families.
test('roleWaitOf honours AX_TRIAGE_ROLE_WAIT, takes a caller override, and defaults to 120', () => {
  assert.deepEqual(roleWaitOf({}), { ok: true, wait: 120 });
  assert.deepEqual(roleWaitOf({ AX_TRIAGE_ROLE_WAIT: '0' }), { ok: true, wait: 0 });
  assert.deepEqual(roleWaitOf({ AX_TRIAGE_ROLE_WAIT: '12' }), { ok: true, wait: 12 });
  assert.deepEqual(roleWaitOf({}, 7), { ok: true, wait: 7 }, 'the per-invocation override');
  assert.deepEqual(roleWaitOf({ AX_TRIAGE_ROLE_WAIT: '12' }, 7), { ok: true, wait: 7 }, 'and it outranks the machine default');
  assert.deepEqual(roleWaitOf({ AX_TRIAGE_ROLE_WAIT: 'soon' }), { ok: true, wait: 120 }, 'an unreadable env value falls back to the built-in, as it always did');
});

test('roleWaitOf refuses AX_READY_ROLE_WAIT rather than reading it', () => {
  const out = roleWaitOf({ AX_READY_ROLE_WAIT: '0' });
  assert.equal(out.ok, false);
  assert.equal(out.from, 'AX_READY_ROLE_WAIT');
  assert.equal(out.to, 'AX_TRIAGE_ROLE_WAIT');
  assert.equal(roleWaitOf({ AX_READY_ROLE_WAIT: '' }).ok, true);
});
