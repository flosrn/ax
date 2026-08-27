// `ax triage answer` — everything is checked BEFORE the reply leaves, because
// the receiver is a live child that consumes it once.
//
// The proof is three-layered, outermost first: the id must name a `question`
// message at all (measured 2026-08-22: `orchestration reply` on anything else
// quietly lands a PLAIN message and returns success); its header must pin it to
// THIS pass and THIS draft version, because Q-line text legitimately coincides
// across issues; and the rulings must pair to the questions one-to-one. The
// receipt's missing `question` field stays as a belt behind all of it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { gitBlobSha } from '../src/hash.mjs';
import { createRunner } from '../src/orca-bin.mjs';
import { answer } from '../src/triage/answer.mjs';
import { composeAsk } from '../src/triage/rulings.mjs';

const REPO = 'acme/widgets';

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-answer-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

const DRAFT = 'Labels: category/bug\n\nQ1: bug or enhancement?\nQ2: which priority?\n';
const QUESTIONS = [
  { n: 1, text: 'bug or enhancement?' },
  { n: 2, text: 'which priority?' },
];

const draft = (root, name, text = DRAFT) => {
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', `${name}.md`), text);
};

const rulingsFile = (root, text) => {
  const path = join(root, 'rulings.md');
  writeFileSync(path, text);
  return path;
};

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

/** The pending ask, byte-for-byte as `ax triage ask` would have sent it. */
const question = (over = {}) => ({
  id: 'msg_q1',
  from_handle: 'term_child',
  to_handle: 'run:run_owner',
  type: 'question',
  body: composeAsk({ request: 'triage-acme-widgets-7', sha: gitBlobSha(DRAFT), questions: QUESTIONS }),
  thread_id: null,
  created_at: '2026-08-22T10:00:00Z',
  ...over,
});

/**
 * An Orca with an inbox and a scripted reply. The reply's default receipt
 * carries a `question`, like a real answered question does; `reply` overrides
 * it to exercise the error paths.
 */
function fakeOrca({ messages = [question()], reply = null, reachable = true } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable } } }), stderr: '' };
      if (args[0] === 'orchestration' && args[1] === 'inbox') {
        return { status: 0, stdout: JSON.stringify({ ok: true, result: { count: messages.length, messages } }), stderr: '' };
      }
      if (args[0] === 'orchestration' && args[1] === 'reply') {
        return reply ?? { status: 0, stdout: JSON.stringify({ ok: true, result: { message: { id: 'msg_a1' }, question: { status: 'answered' }, duplicate: false } }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected orca call' };
    },
  });
  return { runner, calls };
}

/**
 * The pass's dispatch record. A reply is a live mutation, so it is written
 * against a record or refused (F-001) — and in the new world a question
 * carrying a valid ax header implies `ax triage ask` ran, which implies this
 * file exists. `ask` is the lifecycle `ax triage ask` left behind.
 */
const record = (root, request = 'triage-acme-widgets-7', ask = { state: 'pending', messageId: 'msg_q1', at: '2026-08-22T10:00:00Z' }) => {
  const store = join(root, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${request}.json`), JSON.stringify({ request, createdAt: '2026-08-20T10:00:00.000Z', ask, attempts: [{ n: 1, phases: [] }] }));
  return join(store, `${request}.json`);
};

const askOf = path => JSON.parse(readFileSync(path, 'utf8')).ask;

const run = (argv, { root = repo(), orca = fakeOrca() } = {}) => {
  const result = capture(() =>
    answer([...argv, '--repo', REPO], {
      runner: orca.runner,
      exec: () => ({ status: 1, stdout: '', stderr: 'gh must not be needed with --repo' }),
      env: { ORCA_DISPATCH_STORE: join(root, 'store') },
      cwd: root,
    }),
  );
  return { ...result, root, orcaCalls: orca.calls };
};

const replied = calls => calls.filter(line => line.startsWith('orchestration reply'));

// ── local refusals: nothing touches Orca ──────────────────────────────────────

test('a skipped question is refused by name, and nothing is sent', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\n');
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /Q2 got no ruling/);
  assert.match(r.out, /asks Q1-Q2 — answer those, exactly/);
  assert.deepEqual(r.orcaCalls, []);
});

test('a ruling with no question is refused by name', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\nA3: extra.\n');
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /A3 answers no question/);
  assert.deepEqual(r.orcaCalls, []);
});

test('an orphan line is refused by LINE NUMBER — its author meant it, and no question would get it', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'context first\nA1: bug.\nA2: P2.\n');
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /line 1 is under no A<n>: marker/);
  assert.deepEqual(r.orcaCalls, []);
});

test('a missing rulings file is refused with the repair', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', join(root, 'nope.md')], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /rulings file cannot be read/);
  assert.deepEqual(r.orcaCalls, []);
});

test('a draft that asks nothing is refused — there is nothing this file could answer', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nNo questions.\n');
  const file = rulingsFile(root, 'A1: bug.\n');
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /asks nothing/);
  assert.deepEqual(r.orcaCalls, []);
});

test('usage: --file and --id are required, and --issue must be a number', () => {
  assert.equal(run(['--issue', '7', '--id', 'msg_q1']).code, 2);
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: a.\nA2: b.\n');
  assert.equal(run(['--issue', '7', '--file', file], { root }).code, 2);
  assert.equal(run(['--issue', 'seven', '--id', 'x', '--file', file], { root }).code, 2);
});

// ── the pre-send proof ────────────────────────────────────────────────────────

test('an id absent from the inbox window is CANNOT ESTABLISH, never a blind send', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ messages: [] });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 3);
  assert.match(r.out, /cannot be proven a question/);
  assert.match(r.out, /F-028/);
  assert.deepEqual(replied(r.orcaCalls), []);
});

test('an id that names a non-question message is refused BEFORE the send', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ messages: [question({ type: 'status' })] });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /is a "status" message, not a question/);
  assert.match(r.out, /while the child stays blocked/);
  assert.deepEqual(replied(r.orcaCalls), []);
});

test('a question with no ax header is refused — nothing proves which draft it asked from', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ messages: [question({ body: 'Q1: bug or enhancement?\nQ2: which priority?' })] });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /carries no ax ask header/);
  assert.deepEqual(replied(r.orcaCalls), []);
});

test("another pass's ask is refused by REQUEST, even when its Q lines coincide word for word", () => {
  // The whole reason identity outranks content: "bug or enhancement?" reads the
  // same on every issue, and a reply keyed to a look-alike would wake the wrong
  // live child with rulings it never asked for.
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ messages: [question({ body: composeAsk({ request: 'triage-acme-widgets-9', sha: gitBlobSha(DRAFT), questions: QUESTIONS }) })] });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /was asked by triage-acme-widgets-9, not triage-acme-widgets-7/);
  assert.deepEqual(replied(r.orcaCalls), []);
});

test('a draft that moved since the ask is refused by FINGERPRINT', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: y\n\nQ1: bug or enhancement?\nQ2: which priority?\n');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca(); // asked from DRAFT's sha, which is not what is on disk now
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /the draft moved since the ask/);
  assert.deepEqual(replied(r.orcaCalls), []);
});

test('an ask that disagrees on the questions themselves is refused', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({
    messages: [question({ body: composeAsk({ request: 'triage-acme-widgets-7', sha: gitBlobSha(DRAFT), questions: [{ n: 1, text: 'a different question entirely?' }] }) })],
  });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /disagree on the questions/);
  assert.deepEqual(replied(r.orcaCalls), []);
});

// ── the send ──────────────────────────────────────────────────────────────────

test('a valid ruling set is paired, composed Q-above-A, and replied to the exact id', () => {
  const root = repo();
  record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A2: P2, the trace is a crash.\nA1: bug.\n');
  const orca = fakeOrca();
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 0);
  assert.match(r.out, /answered Q1-Q2 on msg_q1/);
  const sent = replied(r.orcaCalls)[0];
  assert.match(sent, /--id msg_q1/);
  assert.match(sent, /Q1: bug or enhancement\?\nA1: bug\./, 'the reply restates the question above its ruling');
  assert.match(sent, /A2: P2, the trace is a crash\./);
});

test('an identical re-answer is reported as already recorded, not as new', () => {
  const root = repo();
  record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ reply: { status: 0, stdout: JSON.stringify({ ok: true, result: { message: { id: 'msg_a1' }, question: { status: 'answered' }, duplicate: true } }), stderr: '' } });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 0);
  assert.match(r.out, /already recorded — nothing new was sent/);
});

test('answer_conflict is refused: two rulings cannot both stand, and nothing was changed', () => {
  const root = repo();
  record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ reply: { status: 1, stdout: JSON.stringify({ id: 'x', ok: false, error: { code: 'answer_conflict', message: 'already has a different answer' } }), stderr: '' } });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /DIFFERENT answer/);
});

test('a closed question names the recovery: the child is gone, a fresh pass carries the rulings', () => {
  const root = repo();
  record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ reply: { status: 1, stdout: JSON.stringify({ id: 'x', ok: false, error: { code: 'dispatch_inactive', message: 'closed' } }), stderr: '' } });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /the child that asked is gone/);
  assert.match(r.out, /--fresh --because/);
});

test('the belt: a success receipt with no question is reported as the plain-message misfire it is', () => {
  const root = repo();
  record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ reply: { status: 0, stdout: JSON.stringify({ ok: true, result: { message: { id: 'msg_plain' } } }), stderr: '' } });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /landed as a PLAIN message/);
  assert.match(r.out, /still blocked/);
});

// ── the reply is recorded before it is issued (F-001) ─────────────────────────
//
// A reply unblocks a live child exactly once. Issuing one no record accounts for
// is how a retry after a crash sends a second ruling to a child that already
// consumed the first, and how a successful reply leaves a durable `pending` that
// makes `ax triage status` report a live question over an answered one.

test('the reply intent is written BEFORE the reply is issued', () => {
  const root = repo();
  const path = record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');

  let atSendTime = null;
  const orca = fakeOrca();
  const wrapped = {
    calls: orca.calls,
    runner: args => {
      if (args[0] === 'orchestration' && args[1] === 'reply') atSendTime = askOf(path);
      return orca.runner(args);
    },
  };
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca: wrapped });

  assert.equal(r.code, 0);
  assert.equal(atSendTime?.state, 'replying', 'the intent exists at the moment the mutation is issued');
  assert.equal(atSendTime?.messageId, 'msg_q1');
});

test('a proven reply settles the lifecycle to ANSWERED', () => {
  const root = repo();
  const path = record(root);
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root });

  assert.equal(r.code, 0);
  assert.equal(askOf(path).state, 'answered');
  assert.equal(askOf(path).messageId, 'msg_q1');
});

test('a record that cannot be written REFUSES before the reply leaves', () => {
  const root = repo();
  mkdirSync(join(root, 'store', 'triage-acme-widgets-7.json'), { recursive: true });
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca();
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 3);
  assert.match(r.out, /could not record this reply/);
  assert.deepEqual(replied(orca.calls), [], 'nothing was sent');
});

test('an unreachable runtime refuses with nothing sent', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const orca = fakeOrca({ reachable: false });
  const r = run(['--issue', '7', '--id', 'msg_q1', '--file', file], { root, orca });

  assert.equal(r.code, 3);
  assert.deepEqual(replied(r.orcaCalls), []);
});

// ── dry run ───────────────────────────────────────────────────────────────────

test('--dry-run validates and prints the exact reply body with no Orca anywhere', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7');
  const file = rulingsFile(root, 'A1: bug.\nA2: P2.\n');
  const r = run(['--issue', '7', '--file', file, '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /^Q1: bug or enhancement\?$/m);
  assert.match(r.out, /^A1: bug\.$/m);
  assert.deepEqual(r.orcaCalls, []);
});
