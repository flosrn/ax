// `ax triage ask` — the child's escalation, and every refusal that keeps the
// questions on the wire identical to the `Q<n>:` lines on record.
//
// The transport shapes are the measured ones (shipped runtime, 2026-08-22):
// `ask --json` answers a BARE object — `answer`, `messageId`, `timedOut`,
// `cancelled`, `connectionLost`, `timeoutMs` — and errors arrive as the usual
// `{ok:false, error:{code}}` envelope. Every fake below speaks exactly that.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { ASK_DEFAULT_TIMEOUT_MS, ASK_MAX_TIMEOUT_MS, ask } from '../src/triage/ask.mjs';

const REPO = 'acme/widgets';

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-ask-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

const draft = (root, name, text) => {
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', `${name}.md`), text);
};

/** A pass exists once it is dispatched: the record's NAME is the pass universe. */
const record = (store, request) => {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${request}.json`), '{}');
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

/**
 * An Orca whose `orchestration ask` answers one scripted receipt.
 *
 * `bare` is printed WITHOUT an envelope, exactly like the shipped CLI; an
 * `envelope` is the error path. `status --json` answers reachable so the
 * readiness gate passes unless `reachable: false` says otherwise.
 */
function fakeOrca({ bare = null, envelope = null, status = 0, reachable = true } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable } } }), stderr: '' };
      if (args[0] === 'orchestration' && args[1] === 'ask') {
        return { status, stdout: JSON.stringify(envelope ?? bare), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected orca call' };
    },
  });
  return { runner, calls };
}

const run = (argv, { root = repo(), orca = fakeOrca(), env = {} } = {}) => {
  const store = env.ORCA_DISPATCH_STORE ?? join(root, 'store');
  const result = capture(() =>
    ask([...argv, '--repo', REPO], {
      runner: orca.runner,
      exec: () => ({ status: 1, stdout: '', stderr: 'gh must not be needed with --repo' }),
      env: { ORCA_DISPATCH_STORE: store },
      cwd: root,
    }),
  );
  return { ...result, root, store, orcaCalls: orca.calls };
};

const ANSWERED = { answer: 'Q1: bug or enhancement?\nA1: bug.', messageId: 'msg_q1', threadId: 'msg_q1', timedOut: false, cancelled: false, connectionLost: false, timeoutMs: 600000 };

// ── refusals before anything touches the wire ─────────────────────────────────

test('an issue with no pass at all is refused — there is no draft to ask from', () => {
  const r = run(['--issue', '7']);
  assert.equal(r.code, 1);
  assert.match(r.out, /no pass of #7 exists here/);
  assert.match(r.out, /ax triage dispatch --issue 7/);
  assert.deepEqual(r.orcaCalls, [], 'nothing was sent');
});

test('a dispatched pass whose draft is unwritten is refused, naming the path owed', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  const r = run(['--issue', '7'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /no draft at .*triage-acme-widgets-7\.md/);
  assert.match(r.out, /the ask sends the draft's own Q<n>: lines/);
  assert.deepEqual(r.orcaCalls, []);
});

test('a draft with no Q line is refused — the ask is never improvised', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: category/bug\n\nA verdict, no questions.\n');
  const r = run(['--issue', '7'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /carries no Q<n>: line/);
  assert.deepEqual(r.orcaCalls, []);
});

test('a malformed question set is refused with the shared reason, before it can misroute a ruling', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ2: which priority?\n');
  const r = run(['--issue', '7'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /have to run 1\.\.1 in order/);
  assert.match(r.out, /renumber the Q<n>: lines/);
  assert.deepEqual(r.orcaCalls, []);
});

test('naming a pass nobody ran is refused, listing the ones that exist', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const r = run(['--issue', '7', '--pass', '3'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /pass 3 of #7 does not exist \(existing: 1\)/);
});

// ── the wire ──────────────────────────────────────────────────────────────────

test('an answered ask prints the ruling and says what the child does next', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 0);
  assert.match(r.out, /A1: bug\./);
  assert.match(r.out, /revise the draft/);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.match(sent, /--question/);
  assert.match(sent, /Q1: bug or enhancement\?/, 'the wire carries the draft verbatim');
  assert.match(sent, /triage-acme-widgets-7/, 'the ask names its sender');
  assert.match(sent, new RegExp(`--timeout-ms ${ASK_DEFAULT_TIMEOUT_MS}`), "the server's own default, mirrored");
});

test('a NEWEST pass is the default: a p2 draft asks as p2', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: old?\n');
  draft(root, 'triage-acme-widgets-7-p2', 'Q1: new?\n');
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 0);
  assert.match(r.orcaCalls.find(line => line.startsWith('orchestration ask')), /triage-acme-widgets-7-p2/);
});

test('a timeout is PENDING, exit 4, and the repair resumes the SAME question', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ bare: { answer: null, messageId: 'msg_q9', threadId: 'msg_q9', timedOut: true, cancelled: false, connectionLost: false, timeoutMs: 5000 }, status: 1 });
  const r = run(['--issue', '7', '--timeout-ms', '5000'], { root, orca });

  assert.equal(r.code, 4);
  assert.match(r.out, /PENDING, not dead/);
  assert.match(r.out, /do not report, do not end your turn/);
  assert.match(r.out, /ax triage ask --resume msg_q9 --timeout-ms 5000/);
});

test('a cut connection is CANNOT ESTABLISH, and the question is not declared dead', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ bare: { answer: null, messageId: 'msg_q9', threadId: 'msg_q9', timedOut: false, cancelled: true, connectionLost: true, timeoutMs: 600000 }, status: 1 });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 3);
  assert.match(r.out, /connection lost/);
  assert.match(r.out, /may still be pending/);
  assert.match(r.out, /ax triage ask --resume msg_q9/);
});

test('dispatch_inactive is a refusal that names where ask may run', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ envelope: { id: 'x', ok: false, error: { code: 'dispatch_inactive', message: 'ask requires an active supervised Dispatch.' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /inside the child that `ax triage dispatch` created/);
});

test('an unreachable runtime refuses before anything is sent', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ reachable: false });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 3);
  assert.match(r.out, /not reachable/);
  assert.ok(r.orcaCalls.every(line => !line.startsWith('orchestration ask')), 'nothing was sent');
});

test('a non-JSON answer is CANNOT ESTABLISH, with the raw text preserved', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const broken = { runner: createRunner({ bin: 'stub', exec: (bin, args) => (args[0] === 'status' ? { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }), stderr: '' } : { status: 0, stdout: 'not json', stderr: '' }) }), calls: [] };
  const r = run(['--issue', '7'], { root, orca: broken });

  assert.equal(r.code, 3);
  assert.match(r.out, /did not answer JSON: not json/);
});

// ── resume mode ───────────────────────────────────────────────────────────────

test('--resume waits on the SAME question and needs no draft at all', () => {
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--resume', 'msg_q1'], { orca });

  assert.equal(r.code, 0);
  assert.match(r.orcaCalls.find(line => line.startsWith('orchestration ask')), /--resume msg_q1/);
});

test('--issue and --resume together are a usage error: two different asks', () => {
  const r = run(['--issue', '7', '--resume', 'msg_q1']);
  assert.equal(r.code, 2);
  assert.match(r.out, /choose exactly one/);
});

test('a timeout above the server cap is clamped to it, so the wait budget is real', () => {
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--resume', 'msg_q1', '--timeout-ms', '99999999'], { orca });
  assert.equal(r.code, 0);
  assert.match(r.orcaCalls.find(line => line.startsWith('orchestration ask')), new RegExp(`--timeout-ms ${ASK_MAX_TIMEOUT_MS}`));
});

// ── dry run ───────────────────────────────────────────────────────────────────

test('--dry-run prints the exact body and sends nothing', () => {
  const root = repo();
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\nQ2: which priority?\n');
  const r = run(['--issue', '7', '--dry-run'], { root });

  assert.equal(r.code, 0);
  assert.match(r.out, /^Q1: bug or enhancement\?$/m);
  assert.match(r.out, /^Q2: which priority\?$/m);
  assert.deepEqual(r.orcaCalls, [], 'a dry run never reaches for Orca');
});
