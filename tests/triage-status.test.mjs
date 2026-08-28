// `ax triage status` — the verb that tells a coordinator whether a child is
// waiting on it, and on WHICH message id.
//
// It had no behavioral test at all, and that is exactly how it shipped blind to
// half the questions on the machine. Measured 2026-08-28 across this machine's
// mailbox: 12 of 24 open `type: "question"` rows carried
// `from_handle: "dispatch:ctx_…"`, because `ax triage ask` sends from the
// child's DISPATCH — while this verb looked those rows up by the child's
// TERMINAL handle, which is what the dispatch record stores. Every ask ax sends
// itself was therefore invisible to the verb documented as its authority
// (goodluckagency/ofmchat#101: a live child blocked on a legitimate question,
// with no sanctioned path to an id).
//
// So the fixtures here are the three keys a real row can carry, and the
// propositions are: the id is printed, and the repair that names it is
// printable — never a command that re-runs this one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { gitBlobSha } from '../src/hash.mjs';
import { createRunner } from '../src/orca-bin.mjs';
import { status } from '../src/triage/index.mjs';
import { composeAsk } from '../src/triage/rulings.mjs';

const REPO = 'acme/widgets';
const REQUEST = 'triage-acme-widgets-7';
const HANDLE = 'term_child';
const DISPATCH = 'ctx_ff9aa6dce051';

const DRAFT = 'Labels: category/bug\n\nQ1: bug or enhancement?\nQ2: which priority?\n';
const QUESTIONS = [
  { n: 1, text: 'bug or enhancement?' },
  { n: 2, text: 'which priority?' },
];

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-status-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', `${REQUEST}.md`), DRAFT);
  return root;
}

/**
 * A settled dispatch record: a terminal effect (the pane) AND a dispatchId,
 * which is the key an ask actually travels under.
 */
const record = (root, { ask = null, request = REQUEST } = {}) => {
  const store = join(root, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${request}.json`),
    JSON.stringify({
      request,
      createdAt: '2026-08-28T01:30:00.000Z',
      ...(ask === null ? {} : { ask }),
      attempts: [
        {
          n: 1,
          phases: [
            {
              name: 'worker-start',
              beganAt: '2026-08-28T01:30:00.000Z',
              exit: 0,
              receipt: {
                ok: true,
                result: {
                  dispatchId: DISPATCH,
                  stage: 'input_accepted',
                  state: 'ready',
                  effects: [{ kind: 'terminal', role: 'agent', id: HANDLE }],
                },
              },
            },
          ],
        },
      ],
    }),
  );
  return store;
};

/** One pending ask, byte-for-byte as `ax triage ask` composes it. */
const question = (over = {}) => ({
  id: 'msg_bf6613d0ee33',
  from_handle: HANDLE,
  to_handle: 'run:run_owner',
  type: 'question',
  body: composeAsk({ request: REQUEST, sha: gitBlobSha(DRAFT), questions: QUESTIONS }),
  thread_id: 'msg_bf6613d0ee33',
  created_at: '2026-08-28T01:37:14Z',
  ...over,
});

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

/** An Orca whose inbox holds `messages`, and whose panes answer a cursor. */
function fakeOrca({ messages = [], inbox = null } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'orchestration' && args[1] === 'inbox') {
        return inbox ?? { status: 0, stdout: JSON.stringify({ ok: true, result: { count: messages.length, messages } }), stderr: '' };
      }
      if (args[0] === 'terminal' && args[1] === 'read') {
        return { status: 0, stdout: JSON.stringify({ ok: true, result: { cursor: 1, content: '' } }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected orca call: ${args.join(' ')}` };
    },
  });
  return { runner, calls };
}

const run = (argv, { root = repo(), orca = fakeOrca(), store } = {}) => {
  const result = capture(() =>
    status([...argv, '--repo', REPO], {
      runner: orca.runner,
      exec: () => ({ status: 1, stdout: '', stderr: 'gh must not be needed with --repo' }),
      env: { ORCA_DISPATCH_STORE: store ?? join(root, 'store') },
      cwd: root,
      sleep: () => {},
    }),
  );
  return { ...result, root, orcaCalls: orca.calls };
};

test('a question keyed by the pane handle is printed with its id', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], { root, orca: fakeOrca({ messages: [question()] }) });
  assert.equal(r.code, 0);
  assert.match(r.out, /WAITING since 2026-08-28T01:37:14Z on Q1-Q2 — message msg_bf6613d0ee33/);
  assert.match(r.out, /ax triage answer --issue 7 --job triage --id msg_bf6613d0ee33/);
});

// The measured miss. `ax triage ask` sends from the child's Dispatch, so Orca
// stamps `dispatch:<ctx>` — never the terminal handle the record stores.
test('a question keyed by the DISPATCH is found, not reported as absent', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}` })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /message msg_bf6613d0ee33/);
  assert.match(r.out, /ax triage answer --issue 7 --job triage --id msg_bf6613d0ee33/);
  assert.doesNotMatch(r.out, /no answerable ask is visible/);
});

// The transport-independent pin: the body names its own request, so a row whose
// handle matches nothing this side recorded is still provably this pass's ask.
test('a question whose handle matches nothing is still pinned by its ax header', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: 'term_someone_else' })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /message msg_bf6613d0ee33/);
});

test('the same row reached by two keys is printed once', () => {
  const root = repo();
  record(root);
  // Header pin AND pane key both select it.
  const r = run(['--issue', '7'], { root, orca: fakeOrca({ messages: [question()] }) });
  const hits = r.out.match(/message msg_bf6613d0ee33/g) ?? [];
  assert.equal(hits.length, 1);
});

test('an answered question is not reported as waiting', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({
      messages: [
        question(),
        { id: 'msg_reply', from_handle: 'run:run_owner', type: 'status', body: 'A1: bug', thread_id: 'msg_bf6613d0ee33', created_at: '2026-08-28T01:40:00Z' },
      ],
    }),
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /WAITING/);
});

// The repair that pointed at itself. `asking` means the send happened and its
// outcome was never written; with the row now visible, the finding must name it
// rather than re-print this command.
test('an ISSUED-but-unrecorded ask names the row that proves it landed', () => {
  const root = repo();
  record(root, { ask: { state: 'asking', at: '2026-08-28T01:37:00Z' } });
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}` })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /an ask was ISSUED for this pass and its outcome was never recorded/);
  assert.match(r.out, new RegExp(`the WAITING row above IS that ask \\(its ax header names ${REQUEST}\\)`));
  assert.doesNotMatch(r.out, /ax triage status --issue 7 --job triage {3}# the mailbox row above/);
});

test('an ISSUED ask with no visible row routes somewhere other than this verb', () => {
  const root = repo();
  record(root, { ask: { state: 'asking', at: '2026-08-28T01:37:00Z' } });
  const r = run(['--issue', '7'], { root, orca: fakeOrca({ messages: [] }) });
  assert.equal(r.code, 0);
  assert.match(r.out, /an ask was ISSUED for this pass and its outcome was never recorded/);
  assert.match(r.out, /no ax-sent row for this pass is visible here/);
  assert.match(r.out, /orca orchestration inbox --limit \d+ --full --json/);
  assert.match(r.out, new RegExp(`ax worker tail ${HANDLE}`));
  // The old repair was this command, which produced nothing the reader did not
  // already have. A loop with no exit is not a repair.
  assert.doesNotMatch(r.out, /# the mailbox row above, if any, is the authority/);
});

// Codex P1 on #27. A child whose own `ax triage ask` failed falls back to raw
// `orca orchestration ask`: the row is dispatch-keyed but carries NO ax header.
// `answer()` refuses such an id ("carries no ax ask header"), so rendering it as
// answerable prints a guaranteed-refused repair AND hides the fold/publish exit
// — the exact loop-with-no-exit measured on 2026-08-26, rebuilt by a wider
// lookup.
const RAW_ASK = 'Q1: bug or enhancement?\nQ2: which priority?\n';

test('a headerless raw ask is reported, but never as an answerable id', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}`, body: RAW_ASK })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /message msg_bf6613d0ee33/, 'a blocked child is still the fact that matters');
  assert.match(r.out, /UNPAIRABLE \(no ax header\)/);
  assert.doesNotMatch(r.out, /ax triage answer .* --id msg_bf6613d0ee33/, 'answer() would refuse this id');
});

test('a headerless row does not suppress the fold-and-publish exit', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}`, body: RAW_ASK })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /no answerable ask is visible: 1 question row\(s\) reach this pass, but none carries an ax header/);
  assert.match(r.out, /rule the questions and fold them into/);
});

// A header that names ANOTHER pass is equally unpairable: `answer` refuses it
// with "was asked by X, not Y", so it must not be offered either.
test("a row whose header names another pass is unpairable, not this pass's ask", () => {
  const root = repo();
  record(root);
  const foreign = composeAsk({ request: 'triage-acme-widgets-99', sha: gitBlobSha(DRAFT), questions: QUESTIONS });
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}`, body: foreign })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /UNPAIRABLE \(asked by triage-acme-widgets-99\)/);
  assert.doesNotMatch(r.out, /ax triage answer .* --id msg_bf6613d0ee33/);
});

test('an ISSUED ask with only a headerless row does not claim an ax header exists', () => {
  const root = repo();
  record(root, { ask: { state: 'asking', at: '2026-08-28T01:37:00Z' } });
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}`, body: RAW_ASK })] }),
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /IS that ask \(its ax header names/);
  assert.match(r.out, /no ax-sent row for this pass is visible here/);
});

test('the brief row marks an unpairable question instead of naming it answerable', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7', '--brief'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}`, body: RAW_ASK })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /WAITING on msg_bf6613d0ee33 \(UNPAIRABLE — no ax header\)/);
});


test('an unreadable mailbox is named, never rendered as no question', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7'], {
    root,
    orca: fakeOrca({ inbox: { status: 1, stdout: '', stderr: 'runtime not reachable' } }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /waiting state unknown/);
  assert.match(r.out, /an absent answer is not an absent question/);
});

test('the brief view carries the waiting id for a dispatch-keyed question', () => {
  const root = repo();
  record(root);
  const r = run(['--issue', '7', '--brief'], {
    root,
    orca: fakeOrca({ messages: [question({ from_handle: `dispatch:${DISPATCH}` })] }),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /#7 p1 · ASKING Q1-Q2 .* · WAITING on msg_bf6613d0ee33/);
});
