// `ax triage ask` — the child's escalation, and every refusal that keeps the
// questions on the wire identical to the `Q<n>:` lines on record.
//
// The transport shapes are the measured ones (shipped runtime, 2026-08-22):
// `ask --json` answers a BARE object — `answer`, `messageId`, `timedOut`,
// `cancelled`, `connectionLost`, `timeoutMs` — and errors arrive as the usual
// `{ok:false, error:{code}}` envelope. Every fake below speaks exactly that.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { ASK_DEFAULT_TIMEOUT_MS, ASK_EXIT_MARGIN_MS, ASK_MAX_TIMEOUT_MS, ask } from '../src/triage/ask.mjs';
import { slugOf } from '../src/worker/transcript.mjs';

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
 *
 * `script` is a SEQUENCE of `{ envelope | bare, status }` answers, consumed one
 * per `orchestration ask` call and the last one repeating. It exists because a
 * transient refusal is only transient if a SECOND call answers differently, and
 * a single-receipt fake cannot express that.
 */
function fakeOrca({ bare = null, envelope = null, status = 0, reachable = true, script = null } = {}) {
  const calls = [];
  let at = 0;
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable } } }), stderr: '' };
      if (args[0] === 'orchestration' && args[1] === 'ask') {
        if (script !== null) {
          const step = script[Math.min(at, script.length - 1)];
          at += 1;
          return { status: step.status ?? 0, stdout: JSON.stringify(step.envelope ?? step.bare), stderr: '' };
        }
        return { status, stdout: JSON.stringify(envelope ?? bare), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected orca call' };
    },
  });
  return { runner, calls };
}

/** Every ms this verb slept, so a backoff is asserted rather than waited out. */
const slept = [];

const run = (argv, { root = repo(), orca = fakeOrca(), env = {}, sessionsRoot } = {}) => {
  const store = env.ORCA_DISPATCH_STORE ?? join(root, 'store');
  slept.length = 0;
  const result = capture(() =>
    ask([...argv, '--repo', REPO], {
      runner: orca.runner,
      exec: () => ({ status: 1, stdout: '', stderr: 'gh must not be needed with --repo' }),
      env: { ORCA_DISPATCH_STORE: store },
      cwd: root,
      sessionsRoot,
      sleep: ms => slept.push(ms),
    }),
  );
  return { ...result, root, store, orcaCalls: orca.calls, slept: [...slept] };
};

/**
 * The child's OWN session, as Orca leaves it: the injected preamble is the first
 * user message, and it embeds `--dispatch-capability <token>` in every command
 * it teaches. The slug directory ends in the cwd's basename, which is how
 * ../src/worker/transcript.mjs finds it.
 */
function childSession(root, { request = '', token = 'dcap_measured_token', preamble = true } = {}) {
  const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ax-ask-sessions-')));
  const dir = join(sessionsRoot, `-Users-someone-${basename(root)}`);
  mkdirSync(dir, { recursive: true });
  const first = preamble
    ? `orca orchestration ask --from term_child --dispatch-capability ${token} --question <text>`
    : 'no preamble here, just work';
  const lines = [
    { type: 'session', version: 3, cwd: root },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `${first}\n${request}` }] } },
  ];
  writeFileSync(join(dir, 'a.jsonl'), `${lines.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  return sessionsRoot;
}

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
  record(join(root, 'store'), 'triage-acme-widgets-7');
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
  assert.match(sent, new RegExp(`--timeout-ms ${ASK_DEFAULT_TIMEOUT_MS}`), 'the default this verb chose, which is NOT the server default — see ASK_DEFAULT_TIMEOUT_MS');
});

test('a NEWEST pass is the default: a p2 draft asks as p2', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  record(join(root, 'store'), 'triage-acme-widgets-7-p2');
  draft(root, 'triage-acme-widgets-7', 'Q1: old?\n');
  draft(root, 'triage-acme-widgets-7-p2', 'Q1: new?\n');
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 0);
  assert.match(r.orcaCalls.find(line => line.startsWith('orchestration ask')), /triage-acme-widgets-7-p2/);
});

test('a timeout is PENDING, exit 4, and the repair resumes the SAME question', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ bare: { answer: null, messageId: 'msg_q9', threadId: 'msg_q9', timedOut: true, cancelled: false, connectionLost: false, timeoutMs: 5000 }, status: 1 });
  const r = run(['--issue', '7', '--timeout-ms', '5000'], { root, orca });

  assert.equal(r.code, 4);
  assert.match(r.out, /PENDING, not dead/);
  assert.match(r.out, /do not report, do not end your turn/);
  assert.match(r.out, /ax triage ask --resume msg_q9 --timeout-ms 5000/, 'copied verbatim by a parked child, so it must use the global dispatcher');
});

test('a cut connection is CANNOT ESTABLISH, and the question is not declared dead', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ bare: { answer: null, messageId: 'msg_q9', threadId: 'msg_q9', timedOut: false, cancelled: true, connectionLost: true, timeoutMs: 600000 }, status: 1 });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 3);
  assert.match(r.out, /connection lost/);
  assert.match(r.out, /may still be pending/);
  assert.match(r.out, /ax triage ask --resume msg_q9/);
});

test('dispatch_inactive over a repaired stall is PROVEN from the record, and hands the child its real channel', () => {
  // Measured 3/3 on the first equipped wave (2026-08-23): every child of a
  // repaired composer stall got this refusal — their Dispatch settled `failed`
  // at dispatch time and the capability died with it. The proof is the pass's
  // own record: `heldRepairAt` is written only after a confirmed submission
  // behind a `failed` Dispatch. A child told the truth follows its fallback;
  // the first cut of this refusal accused it of not being a dispatched
  // session, and a child accused improvises.
  const root = repo();
  const store = join(root, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'triage-acme-widgets-7.json'), JSON.stringify({ heldRepairAt: '2026-08-23T17:04:49.000Z' }));
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ envelope: { id: 'x', ok: false, error: { code: 'dispatch_inactive', message: 'ask requires an active supervised Dispatch.' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /record proves why/);
  assert.match(r.out, /the capability died with the settlement/);
  assert.match(r.out, /report NOW/, 'the finding names its repair: the peer report that still reaches the parent');
  assert.match(r.out, /do not decide the open questions yourself/);
});

test('dispatch_inactive with no repaired-stall proof stays a named disjunction, never a guess', () => {
  // Same transport code, different world: an operator running ask outside any
  // Dispatch, or a pass whose record shows no repaired stall. Asserting "the
  // stall killed your capability" here would be the same defect the proven
  // branch fixes — a diagnosis stated without its measure.
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ envelope: { id: 'x', ok: false, error: { code: 'dispatch_inactive', message: 'ask requires an active supervised Dispatch.' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 1);
  assert.match(r.out, /either this session was never a dispatched child, or its Dispatch is no longer active/);
  assert.match(r.out, /ax triage status/);
  assert.doesNotMatch(r.out, /composer stall/, 'no stall diagnosis without the record that proves it');
});

test('a token-shaped receipt is redacted before it reaches the child’s eyes', () => {
  // The error message is untrusted runtime output, exactly like a transcript:
  // Orca's preamble embeds the dispatch capability, and an error that quotes
  // the request can quote the token with it. These branches emit through
  // bad()/note() directly, so the redaction has to be proven here, not assumed
  // from refuse/cannot.
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ envelope: { id: 'x', ok: false, error: { code: 'dispatch_inactive', message: 'Dispatch dcap_s3cr3tT0ken capability is revoked.' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /dcap_s3cr3tT0ken/, 'the authority token must never be routine output');
  assert.match(r.out, /dcap_<redacted>/);
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
  record(join(root, 'store'), 'triage-acme-widgets-7');
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

// ── the dispatch capability: re-typed, never inherited ───────────────────────
//
// Measured 2026-08-26 on ofmchat #78 and #79, two independent triage dispatches:
// this verb composed the ask with no capability and was refused
// `dispatch_capability_invalid`, through a branch that named no repair. Orca's
// own handler takes the token from the flag and from nowhere else — there is no
// `ORCA_*CAPABILITY` variable in its source — while the preamble it injects
// hands that exact token to the child. So the child's own session is where it
// comes from.

test('the capability is read off the child own preamble and sent with the ask', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');
  const sessionsRoot = childSession(root, { request: 'triage-acme-widgets-7', token: 'dcap_from_preamble' });
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot });

  assert.equal(r.code, 0);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.match(sent, /--dispatch-capability dcap_from_preamble/);
});

test('an explicit --dispatch-capability wins over the session read', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');
  const sessionsRoot = childSession(root, { request: 'triage-acme-widgets-7', token: 'dcap_from_preamble' });
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7', '--dispatch-capability', 'dcap_typed'], { root, orca, sessionsRoot });

  assert.equal(r.code, 0);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.match(sent, /--dispatch-capability dcap_typed/);
  assert.doesNotMatch(sent, /dcap_from_preamble/);
});

test('no readable capability sends the ask WITHOUT one rather than inventing a token', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot: join(root, 'no-sessions-here') });

  assert.equal(r.code, 0);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.doesNotMatch(sent, /--dispatch-capability/);
});

test('dispatch_capability_invalid with NO token names the flag and the preamble it lives in', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');
  const orca = fakeOrca({ envelope: { ok: false, error: { code: 'dispatch_capability_invalid', message: 'The Dispatch capability is missing' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot: join(root, 'no-sessions-here') });

  assert.equal(r.code, 1, 'the caller can act on this, so it is a refusal and not a cannot-establish');
  assert.match(r.out, /the ask carried NO capability/);
  assert.match(r.out, /could not read one:/);
  assert.match(r.out, /--dispatch-capability <token>/);
  assert.match(r.out, /questions stay in the draft/);
});

test('dispatch_capability_invalid WITH a read token blames the Dispatch, not the caller', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');
  const sessionsRoot = childSession(root, { request: 'triage-acme-widgets-7', token: 'dcap_stale' });
  const orca = fakeOrca({ envelope: { ok: false, error: { code: 'dispatch_capability_invalid', message: 'The Dispatch capability is invalid' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot });

  assert.equal(r.code, 1);
  assert.match(r.out, /a capability this runtime rejected/);
  assert.match(r.out, /re-minted or settled the Dispatch/);
  assert.doesNotMatch(r.out, /dcap_stale/, 'the token is never displayed');
});

test('a token mentioned LATE is not this session grant, and is not taken', () => {
  // Measured over 227 session files carrying a raw token: the preamble cluster
  // ends at line ~8, and every outlier past line 40 is a session that was never
  // handed a capability but mentions one later — a coordinator quoting a child's
  // command, or a session reasoning about this code. Taking it would hand one
  // dispatch's grant to another caller, so the scan is bounded on purpose.
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Labels: x\n\nQ1: bug or enhancement?\n');

  const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ax-ask-late-')));
  const dir = join(sessionsRoot, `-Users-someone-${basename(root)}`);
  mkdirSync(dir, { recursive: true });
  const filler = Array.from({ length: 60 }, (_, n) => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `turn ${n} triage-acme-widgets-7` }] } }));
  writeFileSync(join(dir, 'a.jsonl'), `${[...filler, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'someone else ran --dispatch-capability dcap_not_mine' }] } })].join('\n')}\n`);

  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot });

  assert.equal(r.code, 0);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.doesNotMatch(sent, /dcap_not_mine/, 'a token this session merely mentions is not a grant it holds');
  assert.doesNotMatch(sent, /--dispatch-capability/);
});

test('the PARENT session sharing the checkout does not make the capability ambiguous', () => {
  // Measured 2026-08-27 on ofmchat #87 and #88: `ownCapability` answered "no
  // single session file under a cwd slug ending in \"ofmchat\" that names
  // triage-goodluckagency-ofmchat-87" inside a genuine dispatched child.
  //
  // The cause is structural, not a coincidence of that machine: triage puts the
  // child in the CURRENT checkout, so the coordinator's own session file lives
  // in the same slug directory — and the coordinator typed the request id when
  // it dispatched, so a whole-file `includes(request)` matches it too. Two
  // matches read as ambiguity, and the child was told it might not be a
  // dispatched session at all.
  //
  // The discriminant is the PREAMBLE: only the child is handed a capability, and
  // only in its first lines. The parent mentions the request much later and
  // holds no token there.
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\n');

  const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ax-ask-shared-')));
  const dir = join(sessionsRoot, `-Users-someone-${basename(root)}`);
  mkdirSync(dir, { recursive: true });

  // The coordinator: no capability in its preamble, and it names the request
  // deep in the transcript, exactly where it ran the dispatch.
  const parentTail = Array.from({ length: 30 }, (_, n) => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `turn ${n}` }] } }));
  writeFileSync(
    join(dir, 'parent.jsonl'),
    `${[
      JSON.stringify({ type: 'session', version: 3, cwd: root }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '/role coordinator' }] } }),
      ...parentTail,
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ax triage dispatch --issue 7 → triage-acme-widgets-7' }] } }),
    ].join('\n')}\n`,
  );

  // The child: its injected preamble carries both the request and the token.
  writeFileSync(
    join(dir, 'child.jsonl'),
    `${[
      JSON.stringify({ type: 'session', version: 3, cwd: root }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'orca orchestration ask --from term_child --dispatch-capability dcap_the_child_token --question <text>\ntriage-acme-widgets-7' }] } }),
    ].join('\n')}\n`,
  );

  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot });

  assert.equal(r.code, 0);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.match(sent, /--dispatch-capability dcap_the_child_token/, "the child's own grant, not an ambiguity");
});

test('a SECOND checkout whose slug ends the same way does not hide this one', () => {
  // The other half of the ofmchat report, and a tail match cannot answer it:
  // `basename(cwd)` matches every directory ending in `-<name>`, so two
  // checkouts called ofmchat — a worktree and its primary, say — make the lookup
  // ambiguous and refuse. But the caller passed the WHOLE cwd, and the slug that
  // produces is unique by construction, so the ambiguity was self-inflicted.
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\n');

  const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ax-ask-twin-')));
  // This checkout's OWN directory, named exactly as a session for it would be.
  const mine = join(sessionsRoot, slugOf(root, {}));
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    join(mine, 'child.jsonl'),
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'orca orchestration ask --dispatch-capability dcap_mine --question <t>\ntriage-acme-widgets-7' }] } })}\n`,
  );
  // A different checkout that merely ends with the same basename.
  const twin = join(sessionsRoot, `-Users-someone-else-${basename(root)}`);
  mkdirSync(twin, { recursive: true });
  writeFileSync(
    join(twin, 'other.jsonl'),
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'orca orchestration ask --dispatch-capability dcap_theirs --question <t>\ntriage-acme-widgets-7' }] } })}\n`,
  );

  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot });

  assert.equal(r.code, 0);
  const sent = r.orcaCalls.find(line => line.startsWith('orchestration ask'));
  assert.match(sent, /--dispatch-capability dcap_mine/);
  assert.doesNotMatch(sent, /dcap_theirs/, "another checkout's grant is never this session's");
});

test('an AMBIGUITY says so, and never borrows the vocabulary of an absence', () => {
  // Reported by the child that hit it (2026-08-27): the refusal read "no single
  // session file … — this may not be a dispatched child, or its session is not
  // on this host". "No SINGLE file" is true of zero matches AND of two, but both
  // causes it then offered were zero-match causes, and both were false. The
  // child read it as "this channel does not exist for me" and slid toward the
  // irrecoverable branch instead of passing the token.
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\n');

  const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ax-ask-ambig-')));
  const dir = join(sessionsRoot, slugOf(root, {}));
  mkdirSync(dir, { recursive: true });
  for (const [name, token] of [['a.jsonl', 'dcap_one'], ['b.jsonl', 'dcap_two']]) {
    writeFileSync(
      join(dir, name),
      `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `orca orchestration ask --dispatch-capability ${token} --question <t>\ntriage-acme-widgets-7` }] } })}\n`,
    );
  }

  const orca = fakeOrca({ envelope: { ok: false, error: { code: 'dispatch_capability_invalid', message: 'The Dispatch capability is missing' } }, status: 1 });
  const r = run(['--issue', '7'], { root, orca, sessionsRoot });

  assert.equal(r.code, 1);
  assert.match(r.out, /2 candidate session/, 'the count, so the reader knows it is an ambiguity');
  assert.match(r.out, /--dispatch-capability/, 'and the one gesture that resolves it');
  assert.doesNotMatch(r.out, /may not be a dispatched child/, 'a zero-match cause must not be offered for a two-match condition');
  assert.doesNotMatch(r.out, /dcap_one|dcap_two/, 'neither candidate token is displayed');
});

// ── runtime_busy: a refusal that must not become an infinite loop ─────────────
//
// Measured 2026-08-27, ofmchat #83. `long-poll capacity reached` is Orca's
// GLOBAL long-poll guard (runtime-rpc.ts:1563-1565, LONG_POLL_CAP=16, shared
// with terminal.wait / check --wait / browser-host). It fell into the terminal
// generic `cannot()` here: no repair, no message id, so no `--resume` either.
// The child then obeyed the spec sentence — never report with a question open,
// exception `not supervised` only — and spent 62 minutes over 11 hand-rolled
// retries, its own advisors correctly blocking every other exit. A refusal with
// no exit is a trap, and AGENTS.md already forbids a `bad` with no `fix`.
//
// Two propositions: absorb a genuinely transient blip, and when it is not
// transient, hand the child an exit it is allowed to take.

const BUSY = { envelope: { ok: false, error: { code: 'runtime_busy', message: 'long-poll capacity reached; retry with backoff' } }, status: 1 };

test('a transient runtime_busy is absorbed: the ask retries itself and the child never sees it', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\n');
  const orca = fakeOrca({ script: [BUSY, { bare: ANSWERED }] });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 0, 'the second call answered, so the verb answered');
  assert.match(r.out, /A1: bug\./);
  assert.equal(r.orcaCalls.filter(line => line.startsWith('orchestration ask')).length, 2);
  assert.ok(r.slept.length > 0, 'it waited between attempts rather than hammering');
});

test('a persistent runtime_busy names what it tried and hands the child an exit', () => {
  const root = repo();
  record(join(root, 'store'), 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\nQ2: which priority?\n');
  const orca = fakeOrca({ script: [BUSY] });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 3, 'the machine, not the caller');
  // What it tried: a measured fact the child can report instead of guessing.
  assert.match(r.out, /after \d+ attempts over \d+s/);
  // Why hand-rolling more retries is not the answer.
  assert.match(r.out, /shed, not queued/);
  // The exit itself, which is the whole point of this arm.
  assert.match(r.out, /report NOW/);
  assert.match(r.out, /quote them/);
  assert.match(r.out, /do not decide/i);
  // And never a resume: no id was ever minted on this path.
  assert.doesNotMatch(r.out, /--resume/);
});

test('--help carries the exit codes, because a child routes on them alone', () => {
  // The shipped help was two usage lines and a flag list. A child meeting exit 1
  // or 3 had to choose between retry, resume and report with nothing to read.
  const r = capture(() => ask(['--help']));
  assert.equal(r.code, 0);
  for (const line of [/0\s+answered/, /1\s+refused/, /3\s+cannot establish/, /4\s+PENDING/]) {
    assert.match(r.out, line);
  }
  assert.match(r.out, /--resume/);
});

// ── the recorded ask: write-ahead, then settled ───────────────────────────────
//
// Measured 2026-08-27 on ofmchat #87. `ask` minted a real question, printed its
// id ONLY on the exit-4 branch, and persisted nothing. So `status`, reading the
// pane mailbox alone, answered "this pane has no pending question — it never
// asked through `ax triage ask`" about a question that was provably pending
// under `--resume`. Two shipped surfaces of one tool, opposite instructions,
// and the child followed the wrong one and settled its pass.
//
// The record is the surface every other verb already reads, and AGENTS.md
// already requires a live orchestration mutation to be written BEFORE it is
// issued. So the ask keeps a lifecycle there: asking → pending | answered |
// refused, with `asking` meaning "issued, outcome never recorded" — the state a
// crash between the send and the write leaves behind, and a state that must
// never read as "no question exists".

const askOf = (store, request) => JSON.parse(readFileSync(join(store, `${request}.json`), 'utf8')).ask;

test('the intent is written BEFORE the wire, carrying the draft it was composed from', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\n');

  let atSendTime = null;
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }), stderr: '' };
      atSendTime = askOf(store, 'triage-acme-widgets-7');
      return { status: 0, stdout: JSON.stringify(ANSWERED), stderr: '' };
    },
  });
  const r = run(['--issue', '7'], { root, orca: { runner, calls: [] } });

  assert.equal(r.code, 0);
  assert.equal(atSendTime?.state, 'asking', 'the intent exists at the moment the mutation is issued');
  assert.match(String(atSendTime?.sha), /^[0-9a-f]{40}$/, 'and names the exact draft it was composed from');
});

test('a timeout settles the intent to PENDING under the id it printed', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ bare: { answer: null, messageId: 'msg_q9', threadId: 'msg_q9', timedOut: true, cancelled: false, connectionLost: false, timeoutMs: 5000 }, status: 1 });
  const r = run(['--issue', '7', '--timeout-ms', '5000'], { root, orca });

  assert.equal(r.code, 4);
  assert.deepEqual(
    { state: askOf(store, 'triage-acme-widgets-7').state, messageId: askOf(store, 'triage-acme-widgets-7').messageId },
    { state: 'pending', messageId: 'msg_q9' },
  );
});

test('an answered ask settles to ANSWERED, so nothing downstream reports it waiting', () => {
  const root = repo();
  const store = join(root, 'store');
  record(store, 'triage-acme-widgets-7');
  draft(root, 'triage-acme-widgets-7', 'Q1: bug or enhancement?\n');
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 0);
  assert.equal(askOf(store, 'triage-acme-widgets-7').state, 'answered');
});

test('an intent that cannot be persisted REFUSES to send — never an unrecorded mutation', () => {
  // F-001's rule, applied to this mutation: a record that cannot be written is
  // an inability to establish, never permission to issue anyway. A draft-only
  // pass loses nothing real — it has no Dispatch, so its ask could only have
  // been refused by the runtime a moment later, with a worse reason.
  const root = repo();
  const store = join(root, 'store');
  mkdirSync(join(store, 'triage-acme-widgets-7.json'), { recursive: true });
  draft(root, 'triage-acme-widgets-7', 'Q1: really?\n');
  const orca = fakeOrca({ bare: ANSWERED });
  const r = run(['--issue', '7'], { root, orca });

  assert.equal(r.code, 3);
  assert.match(r.out, /could not record this ask/);
  assert.deepEqual(r.orcaCalls.filter(line => line.startsWith('orchestration ask')), [], 'nothing was issued');
});

test('the default wait fits under a 600s harness kill, receipt included', () => {
  // Measured 2026-08-26: the default was 600_000 with a 20s exit margin, so one
  // call needed 620s of wall clock while the agent harness killed bash at 600s.
  // The receipt died at 600.09s — and with it the messageId that names the only
  // recovery. The margin existed to protect exactly that window and sat outside
  // it.
  assert.ok(
    ASK_DEFAULT_TIMEOUT_MS + ASK_EXIT_MARGIN_MS < 600_000,
    `${ASK_DEFAULT_TIMEOUT_MS} + ${ASK_EXIT_MARGIN_MS} must leave the receipt inside a 600s budget`,
  );
  assert.equal(ASK_MAX_TIMEOUT_MS, 1_800_000, 'the server cap is unchanged — only the default moved');
});
