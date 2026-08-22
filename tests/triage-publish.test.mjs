// `ax triage status` and `ax triage publish`.
//
// `status` carries the three Bash propositions verbatim: it is READ-ONLY, an
// unsettled mutation routes to `--resume` and never to a second dispatch
// (F-001), and a settled one is reported without that instruction.
//
// `publish` has no Bash ancestor — under the Bash contract the child applied its
// own labels, which is why four issues landed on 2026-08-10 with three empty
// groups each. Every proposition here is a refusal that failure bought.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { publish } from '../src/triage/publish.mjs';
import { status } from '../src/triage/index.mjs';

const REPO = 'acme/widgets';

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-triage-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'widgets' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' } }));
  return root;
}

const draft = (root, name, text) => {
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', `${name}.md`), text);
  return join(root, '.scratch', 'triage', `${name}.md`);
};

/** Every label the fake repository has. A name outside this set is refused locally. */
const REPO_LABELS = ['category/bug', 'priority/P2', 'domains/api', 'state/wontfix', 'needs-triage', 'needs-info'];

/**
 * A `gh` that records every call and answers per verb from a table.
 *
 * `label list` is answered because `publish` reads the repository's vocabulary
 * before it mutates: ax cannot know what a label name looks like, so the list is
 * the only authority. `labelList` overrides it, which is how the tests exercise
 * both an unknown name and a `gh` that cannot answer at all.
 */
function fakeGh({ labels = { status: 0 }, comment = { status: 0 }, labelList = null } = {}) {
  const calls = [];
  return {
    calls,
    exec: (bin, args) => {
      calls.push(`${bin} ${args.join(' ')}`);
      if (args[0] === 'repo') return { status: 0, stdout: `${REPO}\n`, stderr: '' };
      if (args[0] === 'label' && args[1] === 'list') {
        return labelList ?? { status: 0, stdout: JSON.stringify(REPO_LABELS.map(name => ({ name }))), stderr: '' };
      }
      if (args[1] === 'edit') return { stdout: '', stderr: '', ...labels };
      if (args[1] === 'comment') return { stdout: '', stderr: '', ...comment };
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
/** A settled dispatch record for one PASS, with a pane handle to probe. */
function passRecord(store, request, { handle = 'term_child', dispatchId = 'd-1' } = {}) {
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

const receipt = result => ({ status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });

/** An Orca that owns the panes it is told to own, and records every argv. */
function fakeOrca({ panes = [], omitted = [], reachable = true } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return receipt({ runtime: { reachable } });
      if (args.join(' ').startsWith('terminal list')) {
        return receipt({ terminals: panes.map(handle => ({ handle })), hostScope: { omittedHostIds: omitted } });
      }
      return { status: 1, stdout: '', stderr: 'unexpected orca call' };
    },
  });
  return { runner, calls };
}

const run = (argv, options = {}) => {
  const root = options.root ?? repo();
  const gh = options.gh ?? fakeGh(options.answers);
  const orca = options.orca === undefined ? null : fakeOrca(options.orca);
  const result = capture(() =>
    publish([...argv], {
      exec: gh.exec,
      env: options.env ?? {},
      cwd: root,
      runner: orca?.runner,
      // Never a real binary: an un-injected probe must answer "no Orca here"
      // rather than reach for the one on this machine.
      resolve: () => null,
    }),
  );
  return { ...result, root, calls: gh.calls, orcaCalls: orca?.calls ?? [] };
};

// `repo view` and `label list` are reads: publish asks both before it decides.
const mutations = calls => calls.filter(line => !line.includes('repo view') && !line.includes('label list'));

// ── publish: the mutation, and every way it refuses to make one ──────────────

test('publish applies exactly what the draft names, and posts its body', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug, priority/P2\nLabels: domains/api\n\n## Verdict\nIt reproduces on main.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 0);
  const [edit, comment] = mutations(r.calls);
  assert.match(edit, /issue edit 7 --repo acme\/widgets --add-label category\/bug --add-label priority\/P2 --add-label domains\/api/);
  // The body is a PATH on argv, never the prose itself: a verdict is multi-line
  // text with quotes and code fences, and argv is the channel that mangles it.
  const posted = /--body-file (\S+)/.exec(comment)[1];
  assert.match(readFileSync(posted, 'utf8'), /It reproduces on main\./);
});

test('every comment publish posts carries the AI disclaimer', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root });
  const posted = /--body-file (\S+)/.exec(mutations(r.calls)[1])[1];
  assert.match(readFileSync(posted, 'utf8'), /> \*This was generated by AI during triage\.\*/);
});

test('a draft that names no label publishes nothing', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', '## Verdict\nLooks fine.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /names no label/);
  assert.deepEqual(mutations(r.calls), [], 'nothing reached the tracker');
});

test('a draft that was never written is named, and nothing is published', () => {
  const r = run(['--issue', '7']);
  assert.equal(r.code, 1);
  assert.match(r.out, /no draft at .*triage-acme-widgets-7\.md/);
  assert.deepEqual(mutations(r.calls), []);
});

test('one bad draft blocks the whole batch — every draft is read before the first gh call', () => {
  // Publication happens at the end of a chain, over several issues at once. A
  // batch that lands half applied is the state nobody can read afterwards.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nFine.\n');
  draft(root, 'triage-acme-widgets-8', 'Labels: \n\nBroken.\n');
  const r = run(['--issue', '7', '--issue', '8'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /empty label/);
  assert.deepEqual(mutations(r.calls), [], 'not even the good issue was published');
});

test('publish NEVER closes an issue, however the draft concluded', () => {
  // The child may recommend wontfix. Closing is the one gesture the reporter is
  // owed by a human, so the verb applies the labels, posts the comment, and says
  // the close is not its to make.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: state/wontfix\nClose: yes\n\nAlready built, see src/x.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 0);
  assert.ok(
    r.calls.every(line => !line.includes('issue close')),
    'no close call, ever',
  );
  assert.match(r.out, /that is yours to do, and this verb never does it/);
});

test('a custom job is refused by name, not by an empty draft', () => {
  // Its draft is a report to the operator, not a label set — so the refusal says
  // so, instead of letting the caller read "names no label" and wonder.
  const r = run(['--issue', '7', '--job', 'custom']);
  assert.equal(r.code, 1);
  assert.match(r.out, /not publishable/);
  assert.match(r.out, /report to you/);
});

test('--dry-run shows the labels it would apply and mutates nothing', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7', '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /would run: gh issue edit 7/);
  assert.deepEqual(mutations(r.calls), []);
});

test('labels land before the comment, and a refused comment names the repair', () => {
  // A comment whose label set never applied reads to the next human as a
  // finished pass, so the order is fixed and the half-state is reported.
  const root = repo();
  const path = draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root, answers: { comment: { status: 1, stderr: 'rate limited' } } });

  assert.equal(r.code, 1);
  assert.match(r.out, /labels applied, comment refused/);
  // The repair is a command the operator can run verbatim, and it names the
  // rendered file rather than re-typing the prose.
  assert.match(r.out, new RegExp(`--body-file ${path.slice(0, -'.md'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.body\\.md`));
});

test('a refused label call posts nothing for that issue', () => {
  // The label EXISTS here, on purpose. A name the repository does not carry is
  // refused locally now, before any call — so to prove this proposition the call
  // has to reach `gh` and be refused for a reason ax could not have predicted.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root, answers: { labels: { status: 1, stderr: 'HTTP 403: Resource not accessible by integration' } } });

  assert.equal(r.code, 1);
  assert.match(r.out, /labels refused/);
  assert.ok(
    r.calls.every(line => !line.includes('issue comment')),
    'nothing was posted for this issue',
  );
});

test('a state transition asks for the removal, in the same invocation as the adds', () => {
  // Reported by the first real coordinator campaign, 2026-08-22: publish only
  // ever built `--add-label`, so publishing a draft that moved an issue off
  // `needs-triage` left BOTH state labels on it.
  //
  // This proves ONE INVOCATION carrying both directions, and deliberately not
  // atomicity — an earlier version of this name claimed that and was wrong. `gh`
  // runs the two directions as concurrent GraphQL mutations in an errgroup, and
  // GitHub offers no atomic add-and-remove at all, so no argv here could buy
  // one. What one invocation buys is the absence of a SECOND window, plus a
  // single exit status to react to.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: needs-info\nRemove labels: needs-triage\n\nTwo rulings are missing.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 0);
  const edits = mutations(r.calls).filter(line => line.includes('issue edit'));
  assert.equal(edits.length, 1, 'one edit carries both directions');
  assert.match(edits[0], /--add-label needs-info/);
  assert.match(edits[0], /--remove-label needs-triage/);
});

test('a refused edit says the label state is indeterminate, and how to read it', () => {
  // gh's errgroup returns the FIRST error, so the other direction may have
  // landed. A refusal that only says "nothing was posted" reads as "nothing
  // changed" and invites a blind retry onto a half-applied transition.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: needs-info\nRemove labels: needs-triage\n\nTwo rulings are missing.\n');
  const r = run(['--issue', '7'], { root, answers: { labels: { status: 1, stderr: 'HTTP 502' } } });

  assert.equal(r.code, 1);
  assert.match(r.out, /may have landed/);
  assert.match(r.out, /issue view 7 .*--json labels/, 'the repair reads the state first');
  assert.ok(r.calls.every(line => !line.includes('issue comment')), 'no comment on an unknown label state');
});

test('a directive naming a label the repository does not have is refused before any call', () => {
  // Measured across the campaign's three drafts, which used three grammars. One
  // wrote `Labels: category → enhancement`; comma-split-and-trim makes that a
  // label name, and ax cannot tell it from a real one — GitHub allows arrows,
  // spaces and parentheses in a label. The repository's list can.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category → category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /does not have/);
  assert.match(r.out, /category → category\/bug/, 'the refusal quotes what it read');
  assert.deepEqual(mutations(r.calls), [], 'refused before the first mutation');
});

test('an unknown name on the REMOVE side is refused too, because a wrong remove does not undo', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\nRemove labels: needs-triage (superseded by needs-info).\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /does not have/);
  assert.deepEqual(mutations(r.calls), [], 'nothing was removed on a guess');
});

test('a draft that both applies and removes one label is a contradiction, not a transition', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: needs-info\nRemove labels: needs-info\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /both applies and removes needs-info/);
  assert.deepEqual(mutations(r.calls), [], 'gh would have accepted it and picked an order');
});

test('a gh that cannot list labels refuses the batch instead of checking nothing', () => {
  // Fail CLOSED, and say which measurement is missing. Treating an unreachable
  // `gh` as "no label exists" would refuse every draft with the wrong reason;
  // treating it as "every name is fine" would let a guessed remove through.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const r = run(['--issue', '7'], { root, answers: { labelList: { status: 1, stderr: 'gh: not authenticated' } } });

  assert.equal(r.code, 1);
  assert.match(r.out, /could not list/);
  assert.match(r.out, /unchecked remove/);
  assert.deepEqual(mutations(r.calls), [], 'no issue was touched');
});

test('a label list that came back AT the cap refuses, because absence is what it would prove', () => {
  // Same rule as a partial `terminal list` in pane.mjs: a truncated list cannot
  // establish an absence, and absence is the only thing this check decides. `gh
  // label list` stops at its cap silently, so a legitimate name past the page
  // would read exactly like one the repository does not have — a false refusal
  // that sends the operator hunting a typo that is not there.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const capped = Array.from({ length: 500 }, (_, i) => ({ name: `filler/${i}` }));
  const r = run(['--issue', '7'], { root, answers: { labelList: { status: 0, stdout: JSON.stringify(capped), stderr: '' } } });

  assert.equal(r.code, 1);
  assert.match(r.out, /exactly the cap/);
  assert.deepEqual(mutations(r.calls), [], 'no issue was touched on an unprovable absence');
});

test('a non-numeric --issue is refused before any draft is read', () => {
  const r = run(['--issue', 'GAP-353']);
  assert.equal(r.code, 2);
  assert.match(r.out, /expects a number/);
});

test('an unknown argument is refused', () => {
  const r = run(['--issue', '7', '--close']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument "--close"/);
});

// ── status: read-only, and never a second dispatch ───────────────────────────

const runStatus = (argv, options = {}) => {
  const root = options.root ?? repo();
  const gh = options.gh ?? fakeGh();
  const result = capture(() =>
    status([...argv], {
      exec: gh.exec,
      env: { ORCA_DISPATCH_STORE: options.store ?? join(root, 'store') },
      cwd: root,
      // A machine with no Orca unless the test says otherwise: the waiting
      // state is Orca's, and these tests must answer identically beside a live
      // runtime and on a bare CI box.
      resolve: options.resolve ?? (() => null),
      runner: options.runner,
    }),
  );
  return { ...result, root, calls: gh.calls };
};

/** An Orca whose inbox holds exactly these messages, newest-first like the real one. */
function fakeInbox(messages, { readable = true } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'orchestration' && args[1] === 'inbox') {
        if (!readable) return { status: 1, stdout: '', stderr: 'runtime not reachable' };
        return receipt({ count: messages.length, messages });
      }
      return { status: 1, stdout: '', stderr: 'unexpected orca call' };
    },
  });
  return { runner, calls };
}

function record(store, request, { usable = true, repaired = false } = {}) {
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      createdAt: '2026-08-20T10:00:00.000Z',
      // The fact `start.mjs` persists after a CONFIRMED submission, and the only
      // thing that tells a reader a child is alive behind a `failed` Dispatch.
      ...(repaired ? { heldRepairAt: '2026-08-20T10:00:26.000Z' } : {}),
      attempts: [
        {
          n: 1,
          phases: [
            {
              name: 'worker-start',
              beganAt: '2026-08-20T10:00:00.000Z',
              exit: usable ? 0 : 1,
              receipt: usable
                ? { ok: true, result: { dispatchId: 'd-1', state: 'ready', stage: 'dispatched', effects: [{ kind: 'terminal', role: 'agent', id: 'term_child' }] } }
                : { ok: false, result: { state: 'unknown' } },
            },
          ],
        },
      ],
    }),
  );
}

test('status reports the absence of a record and of a draft, and mutates nothing', () => {
  const r = runStatus(['--issue', '7']);
  assert.equal(r.code, 0);
  assert.match(r.out, /no dispatch record/);
  assert.match(r.out, /nothing to publish yet/);
  assert.deepEqual(mutations(r.calls), [], 'status is a read');
});

test('status names an unsettled mutation and routes recovery to --resume, never to a new dispatch', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7', { usable: false });
  const r = runStatus(['--issue', '7'], { root, store });

  assert.equal(r.code, 0);
  assert.match(r.out, /UNSETTLED/);
  assert.match(r.out, /--resume --request triage-acme-widgets-7/);
  assert.match(r.out, /F-001/);
});

test('a repaired held composer is never offered a --resume, because its child is running', () => {
  // Measured 2026-08-22 on the first real coordinator campaign: #50 and #51 both
  // read `RAN · failed · <handle> — UNSETTLED` and both were offered a resume,
  // while `orca terminal read` answered `status: running` on their panes and the
  // children were mid-analysis. Following that line puts a SECOND agent in a
  // working session — printed as the repair, which is the worst place for it.
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7', { usable: false, repaired: true });
  const r = runStatus(['--issue', '7'], { root, store });

  assert.equal(r.code, 0);
  assert.match(r.out, /UNSETTLED/, 'the record is still unsettled, and still says so');
  assert.match(r.out, /its child IS running/);
  assert.match(r.out, /ax worker transcript triage-acme-widgets-7/);
  // The COMMAND must be gone, not the word: the surviving prose names `--resume`
  // on purpose, to say which line not to type.
  assert.doesNotMatch(r.out, /ax worker start --resume/, 'the one line that would double the agent');
});

test('a settled record is reported without the recovery instruction', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  const r = runStatus(['--issue', '7'], { root, store });

  assert.equal(r.code, 0);
  assert.match(r.out, /term_child/);
  assert.doesNotMatch(r.out, /--resume/);
});

test('status shows the draft once the child has written one', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nIt reproduces.\n');
  const r = runStatus(['--issue', '7'], { root });
  assert.match(r.out, /draft .*triage-acme-widgets-7\.md/);
});

test('status reads the record for the job it was asked about', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'brief-acme-widgets-7');
  const r = runStatus(['--issue', '7', '--job', 'brief'], { root, store });
  assert.match(r.out, /request brief-acme-widgets-7/);
  assert.doesNotMatch(r.out, /no dispatch record/);
});

// ── status: the waiting state is Orca's, read from Orca ──────────────────────
//
// NEVER deduced from the draft: a count of `Q<n>:` lines cannot tell a child
// blocked on its ask from a child that died after writing its questions, or
// from an answer that arrived without a revision. A question is PENDING when
// Orca holds a `type: "question"` message that no other message threads back
// to — both shapes measured 2026-08-22.

const question = (over = {}) => ({
  id: 'msg_q1',
  from_handle: 'term_child',
  to_handle: 'run:run_owner',
  type: 'question',
  body: 'triage-acme-widgets-7 is blocked on the question(s) below, asked from draft abc. Each needs one ruling, paired by number.\nQ1: bug or enhancement?\nQ2: which priority?',
  thread_id: null,
  created_at: '2026-08-22T10:00:00Z',
  ...over,
});

test('a pass whose child is blocked on questions says WAITING, names them, and names the repair', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  const orca = fakeInbox([question({ from_handle: 'term_child' })]);
  const r = runStatus(['--issue', '7'], { root, store, runner: orca.runner });

  assert.equal(r.code, 0);
  assert.match(r.out, /WAITING since 2026-08-22T10:00:00Z on Q1-Q2 — message msg_q1/);
  assert.match(r.out, /ax triage answer --issue 7 --job triage --id msg_q1 --file/);
  assert.doesNotMatch(r.out, /waiting state unknown/);
});

test('an answered question is not WAITING: the reply that threads back to it closes the row', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  const orca = fakeInbox([
    { id: 'msg_a1', from_handle: 'run:run_owner', type: 'status', body: 'Q1: …\nA1: bug', thread_id: 'msg_q1', created_at: '2026-08-22T11:00:00Z' },
    question(),
  ]);
  const r = runStatus(['--issue', '7'], { root, store, runner: orca.runner });

  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /WAITING/);
});

test("another pane's question is not attributed to this pass", () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  const orca = fakeInbox([question({ from_handle: 'term_other' })]);
  const r = runStatus(['--issue', '7'], { root, store, runner: orca.runner });

  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /WAITING/);
});

test('an unreadable mailbox is NAMED, never rendered as an absence of questions', () => {
  // F-028 on the reading side: status still answers from records and drafts,
  // but the gap has to be on the page — an operator deciding "nobody is
  // waiting" from this output must be able to see the ground it stands on.
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  const orca = fakeInbox([], { readable: false });
  const r = runStatus(['--issue', '7'], { root, store, runner: orca.runner });

  assert.equal(r.code, 0);
  assert.match(r.out, /waiting state unknown: orca orchestration inbox unreadable/);
  assert.match(r.out, /request triage-acme-widgets-7/, 'the rest of the report survives');
});

test('a machine with no Orca at all names the gap the same way', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  const r = runStatus(['--issue', '7'], { root, store });

  assert.equal(r.code, 0);
  assert.match(r.out, /waiting state unknown: no Orca CLI on this machine/);
});

// ── which pass lands ─────────────────────────────────────────────────────────
//
// Once one issue can hold two verdicts, "publish it" stops being unambiguous.
// Every case below is a way the wrong one could land silently.

const passStore = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'ax-store-'))), 'store');

test('with two drafts and no --pass, the NEWEST lands', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  draft(root, 'triage-acme-widgets-7-p2', 'Labels: priority/P2\n\nPass two.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /passes 1, 2 — publishing 2/);
  const edit = r.calls.find(line => line.includes('issue edit'));
  assert.match(edit, /--add-label priority\/P2/);
  assert.ok(!edit.includes('category/bug'), 'pass 1 did not land');
});

test('naming an older pass IS the permission to publish it', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  draft(root, 'triage-acme-widgets-7-p2', 'Labels: priority/P2\n\nPass two.\n');
  const r = run(['--issue', '7', '--pass', '1'], { root });

  assert.equal(r.code, 0);
  assert.match(r.calls.find(line => line.includes('issue edit')), /--add-label category\/bug/);
});

test('naming a pass nobody wrote is refused, and the refusal lists the ones that exist', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  draft(root, 'triage-acme-widgets-7-p2', 'Labels: priority/P2\n\nPass two.\n');
  const r = run(['--issue', '7', '--pass', '5'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /has no pass 5 — it has 1, 2/);
  assert.ok(r.calls.every(line => !line.includes('issue edit')), 'nothing was mutated');
});

test('an UNWRITTEN newer pass with a live pane blocks the older one', () => {
  // The union case, and the reason the pass universe is records ∪ drafts: pass 2
  // has been dispatched and its child is writing right now, so it owns no `.md`
  // yet. Reading drafts alone would call pass 1 the newest and land it under a
  // child that is at that moment replacing it.
  const root = repo();
  const store = passStore();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  passRecord(store, 'triage-acme-widgets-7-p2', { handle: 'term_busy' });
  const r = run(['--issue', '7'], { root, env: { ORCA_DISPATCH_STORE: store }, orca: { panes: ['term_busy'] } });

  assert.equal(r.code, 1);
  assert.match(r.out, /pass 2 is VIVANT/);
  assert.ok(r.calls.every(line => !line.includes('issue edit')), 'nothing was mutated');
});

test('an unwritten newer pass whose pane is gone does not block the older one', () => {
  const root = repo();
  const store = passStore();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  passRecord(store, 'triage-acme-widgets-7-p2', { handle: 'term_gone' });
  const r = run(['--issue', '7'], { root, env: { ORCA_DISPATCH_STORE: store }, orca: { panes: [] } });

  assert.equal(r.code, 0);
  assert.match(r.out, /newer pass\(es\) 2 are finished/);
  assert.match(r.calls.find(line => line.includes('issue edit')), /--add-label category\/bug/);
});

test('a newer pane that cannot be read blocks the older pass, rather than being assumed finished', () => {
  // F-028 at the publishing end: an absence from a list that omits hosts is not
  // a death, and this mutation cannot be taken back.
  const root = repo();
  const store = passStore();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  passRecord(store, 'triage-acme-widgets-7-p2', { handle: 'term_elsewhere' });
  const r = run(['--issue', '7'], { root, env: { ORCA_DISPATCH_STORE: store }, orca: { panes: [], omitted: ['host_b'] } });

  assert.equal(r.code, 1);
  assert.match(r.out, /pass 2 is INCONNU/);
  assert.ok(r.calls.every(line => !line.includes('issue edit')));
});

test('with no Orca at all, a newer dispatched pass still blocks — the probe fails closed', () => {
  const root = repo();
  const store = passStore();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  passRecord(store, 'triage-acme-widgets-7-p2', { handle: 'term_busy' });
  const r = run(['--issue', '7'], { root, env: { ORCA_DISPATCH_STORE: store } });

  assert.equal(r.code, 1);
  assert.match(r.out, /no Orca CLI on this machine/);
  assert.ok(r.calls.every(line => !line.includes('issue edit')));
});

test('a newer pass that was never dispatched is not probed, because no child ever existed', () => {
  // A hand-written newer draft has no record. Probing it would refuse on an
  // absence that means nothing, and this path must not need Orca at all.
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nPass one.\n');
  draft(root, 'triage-acme-widgets-7-p2', 'Labels: priority/P2\n\nPass two.\n');
  const r = run(['--issue', '7', '--pass', '1'], { root });

  assert.equal(r.code, 0);
  assert.deepEqual(r.orcaCalls, [], 'no Orca round-trip on this path');
});

test('an ordinary publish on a single pass never reaches for Orca', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nOne pass.\n');
  const r = run(['--issue', '7'], { root });

  assert.equal(r.code, 0);
  assert.deepEqual(r.orcaCalls, []);
});

test('--pass expects a number', () => {
  const r = run(['--issue', '7', '--pass', 'latest']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--pass expects a number/);
});
