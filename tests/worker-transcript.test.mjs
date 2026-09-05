// `ax worker transcript` — the full history of a child, structured and redacted.
//
// The propositions under test are the ones the 2026-08-21 measurements paid for:
// the capability token is in the transcript BY CONSTRUCTION and must never reach
// the output; a session file is never GUESSED (two candidates is a refusal, not
// a "newest wins"); and a single truncated line — the ordinary shape of a crash
// mid-append — must not swallow the rest of the history.
//
// Offline by construction: the Orca runner is always injected, and every file
// read is a fixture in a tmpdir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';
import { quote } from '../src/worker/hosts.mjs';
import { dispatchProof, slugOf, stampOf, transcript } from '../src/worker/transcript.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-transcript-'));

/** Everything the verb told the human, on either stream, and its exit code. */
function capture(fn) {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('').replace(/\u001B\[\d+m/g, '') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** A runner that answers the readiness probe and records every call. */
function fakeRunner({ ready = true } = {}) {
  const calls = [];
  const run = args => {
    calls.push(args.join(' '));
    return ready
      ? { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: true } } } }
      : { status: 1, stdout: '', stderr: 'not running', receipt: { unparseable: 'not running', error: 'x' } };
  };
  run.calls = calls;
  return run;
}

/** The dispatch capability shape Orca embeds in every worker preamble. */
const DCAP = 'dcap_01a02506c6187000_8c3fa2964578';

/**
 * A session file with the shapes the real transcript carries (sampled from
 * ~/.omp/agent/sessions/-Code-flosrn-ax/2026-08-21T15-53-16-056Z_…jsonl):
 * boot model_change, an adapter model_change, the preamble carrying the
 * capability twice, a tool call retyping it, one truncated line, a custom
 * message.
 */
const FIXTURE = [
  JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: '2026-08-21T15:53:16.056Z', cwd: '/Users/fake/Code/proj' }),
  JSON.stringify({ type: 'model_change', model: 'anthropic/claude-opus-5', resolvedModelIsFallback: false }),
  JSON.stringify({ type: 'model_change', model: 'anthropic/claude-sonnet-5', role: 'default', resolvedModelIsFallback: false }),
  JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high', configured: null }),
  JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are a dispatched worker.\n  orca orchestration send --dispatch-capability ${DCAP} --type worker_done\n  orca orchestration send --dispatch-capability ${DCAP} --type escalation\n${'padding '.repeat(40)}`,
        },
      ],
    },
  }),
  '{"type":"message","message":{"role":"assis', // a crash mid-append: one truncated line
  JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reporting now' },
        {
          type: 'toolCall',
          id: 't1',
          name: 'bash',
          intent: 'Report to orchestrator',
          arguments: { command: `orca orchestration send --dispatch-capability ${DCAP} --type worker_done`, i: 'Report' },
        },
        { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'PORT.md', i: 'Reading the plan' } },
      ],
    },
  }),
  JSON.stringify({ type: 'custom_message', customType: 'advisor', content: 'Use the required orca orchestration send', display: true }),
  // The other place a tool call is recorded: this entry carries the name and the
  // args, and the capability the child retyped is in `data.args.command` too.
  JSON.stringify({
    type: 'custom',
    customType: 'tool_execution_start',
    data: { toolCallId: 't1', toolName: 'bash', intent: 'Report to orchestrator', args: { command: `orca orchestration send --dispatch-capability ${DCAP}` } },
  }),
  '',
].join('\n');

const fixtureFile = (dir, name = '2026-08-21T15-53-16-056Z_01a02506-c618-7000-8c3f-a296457c3769.jsonl') => {
  const path = join(dir, name);
  writeFileSync(path, FIXTURE);
  return path;
};

test('the cwd slug is the measured convention: HOME stripped, separators to dashes', () => {
  assert.equal(slugOf('/Users/flo/Code/flosrn/ax', { HOME: '/Users/flo' }), '-Code-flosrn-ax');
  assert.equal(slugOf('/Users/flo/.omp/.worktrees/adhd', { HOME: '/Users/flo' }), '-.omp-.worktrees-adhd');
  assert.equal(slugOf('/srv/work', { HOME: '/Users/flo' }), '-srv-work', 'a path outside HOME keeps all of itself');
  assert.equal(stampOf('2026-08-21T15-53-16-056Z_x.jsonl'), Date.parse('2026-08-21T15:53:16.056Z'));
  assert.equal(stampOf('handwritten.jsonl'), null, 'an unstamped name is never silently ranked');
});

test('no target and an unknown flag are usage errors that never touch orca', () => {
  const run = fakeRunner();
  assert.equal(capture(() => transcript([], { runner: run })).code, 2);
  assert.equal(capture(() => transcript(['--raw'], { runner: run })).code, 2, 'there is no bypass flag to mistype');
  assert.equal(capture(() => transcript(['a.jsonl', 'b.jsonl'], { runner: run })).code, 2);
  assert.deepEqual(run.calls, []);
});

test('no orca on the machine is a named inability — this verb fails CLOSED', () => {
  const { code, out } = capture(() => transcript(['ctx_x'], { resolve: () => null, env: { HOME: scratch() } }));
  assert.equal(code, 3);
  assert.match(out, /no orca CLI/);
  assert.match(out, /orca open/);
});

test('a runtime that does not answer refuses BEFORE any read', () => {
  const run = fakeRunner({ ready: false });
  const dir = scratch();
  const path = fixtureFile(dir);
  const { code, out } = capture(() => transcript([path], { runner: run, env: { HOME: dir } }));
  assert.equal(code, 3);
  assert.deepEqual(run.calls, ['status --json'], 'nothing is read after a failed probe');
  assert.match(out, /orca open/);
});

test('a .jsonl path is rendered entry by entry, and the capability NEVER appears', () => {
  const dir = scratch();
  const path = fixtureFile(dir);
  const { code, out } = capture(() => transcript([path], { runner: fakeRunner(), env: { HOME: dir } }));

  assert.equal(code, 0);
  // The whole point of the verb: the preamble carries the token twice and the
  // child retypes it into its tool call. None of the three may be printed.
  assert.equal(out.includes(DCAP), false, 'the dispatch capability must not be re-displayed');
  // A real token continues with the capability grammar; the inert marker
  // continues with `<`. So this catches any surviving PREFIX of the real one,
  // truncation included, without flagging a marker cut by the display cap.
  assert.equal(/dcap_[A-Za-z0-9_-]/.test(out), false, 'not even a truncated prefix of it');
  assert.match(out, /dcap_<redacted>/, 'the redaction is visible, so the reader knows something was there');

  assert.ok(out.includes(path), 'the source path is printed: the human who needs raw bytes has the disk');
  assert.match(out, /message user/);
  assert.match(out, /bash\(/, 'a tool call is named with its command');
  assert.match(out, /read\(/);
  assert.match(out, /custom_message advisor/);
  assert.match(out, /custom tool_execution_start {2}bash\(orca orchestration send/, 'the execution entry is rendered as the call it is');
  assert.match(out, /thinking_level_change high/);
});

test('model_change keeps WHO moved the model — boot, adapter and quota are three facts', () => {
  const dir = scratch();
  const path = join(dir, '2026-08-21T15-53-16-056Z_a.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'model_change', model: 'anthropic/claude-opus-5' }),
      JSON.stringify({ type: 'model_change', model: 'anthropic/claude-sonnet-5', role: 'default' }),
      JSON.stringify({ type: 'model_change', model: 'x-ai/grok-4', role: 'fallback' }),
    ].join('\n'),
  );
  const { code, out } = capture(() => transcript([path], { runner: fakeRunner(), env: { HOME: dir } }));

  assert.equal(code, 0);
  assert.match(out, /role=boot \(session boot\)/);
  assert.match(out, /role=default \(model adapter\)/);
  assert.match(out, /role=fallback \(quota chain\)/);
});

test('dispatch proof keeps model selection separate from role and skill application', () => {
  const root = scratch();
  const dir = join(root, '-repo-gap-353');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.jsonl'),
    [
      JSON.stringify({ type: 'model_change', model: 'anthropic/claude-sonnet-5', role: 'default' }),
      JSON.stringify({
        type: 'custom_message',
        customType: 'skill-prompt',
        details: { role: 'worker', skills: ['implementation'], status: 'applied' },
      }),
    ].join('\n'),
  );

  assert.deepEqual(dispatchProof({ needle: 'gap-353', sessionsRoot: root }), {
    model: { model: 'anthropic/claude-sonnet-5', role: 'default' },
    sessionRole: { status: 'applied', role: 'worker', skills: ['implementation'] },
  });

  const { code, out } = capture(() =>
    transcript(['--dispatch-proof', 'gap-353', '--sessions', root], { env: { HOME: root } }),
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), dispatchProof({ needle: 'gap-353', sessionsRoot: root }));
});

// Issue #57: the flag renamed with the glossary (`--launch-proof` →
// `--dispatch-proof`), but it travels over SSH from ax versions this machine
// does not choose — released 0.15.x still speaks the retired spelling. The
// alias answers identically; the warning rides STDERR because the remote
// reader takes the FIRST STDOUT LINE as the proof, so anything else on stdout
// would corrupt exactly the cross-version call the alias exists to serve.
test('the retired --launch-proof spelling answers, warns on stderr, keeps stdout pure', () => {
  const root = scratch();
  const dir = join(root, '-repo-gap-353');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.jsonl'),
    [
      JSON.stringify({ type: 'model_change', model: 'anthropic/claude-sonnet-5', role: 'default' }),
      JSON.stringify({
        type: 'custom_message',
        customType: 'skill-prompt',
        details: { role: 'worker', skills: ['implementation'], status: 'applied' },
      }),
    ].join('\n'),
  );

  const outs = [];
  const errs = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (outs.push(String(chunk)), true);
  process.stderr.write = chunk => (errs.push(String(chunk)), true);
  let code;
  try {
    code = transcript(['--launch-proof', 'gap-353', '--sessions', root], { env: { HOME: root } });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }

  assert.equal(code, 0);
  assert.deepEqual(
    JSON.parse(outs.join('')),
    dispatchProof({ needle: 'gap-353', sessionsRoot: root }),
    'stdout carries the proof line and nothing else',
  );
  assert.match(errs.join(''), /--dispatch-proof/, 'the warning names the live spelling');
  assert.match(errs.join(''), /retired/, 'and says the old one is retired');
});

test('dispatch proof carries the exact pre-turn role refusal', () => {
  const root = scratch();
  const dir = join(root, '-repo-gap-353');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.jsonl'),
    [
      JSON.stringify({ type: 'model_change', model: 'anthropic/claude-sonnet-5', role: 'default' }),
      JSON.stringify({
        type: 'custom_message',
        customType: 'role-refused',
        details: { role: 'worker', reason: 'skill-not-found', missingSkills: ['implementation'] },
      }),
    ].join('\n'),
  );

  assert.deepEqual(dispatchProof({ needle: 'gap-353', sessionsRoot: root })?.sessionRole, {
    status: 'refused',
    role: 'worker',
    reason: 'skill-not-found',
    missingSkills: ['implementation'],
  });
});

/**
 * One pass as the dispatch store knows it: a record whose newest `worker-start`
 * receipt names the `ctx_…` Orca minted. The reader keys on THAT id, never on
 * the request id in the child's prose (#126).
 */
function passRecord(store, request, dispatchId) {
  const { path } = claimRecord(store, request);
  initRecord(path, { request, orca: 'orca', host: 'mac', now: () => '2026-09-03T08:00:00.000Z' });
  phaseBegin(path, { name: 'worker-start', identity: `id-${dispatchId}`, argv: ['worker-start'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { dispatchId, state: 'ready', stage: 'input_accepted' } }) });
  return path;
}

/** A child's session file: Orca's preamble names the dispatch, the spec names the draft path. */
function childSession(dir, name, { dispatchId, request, role = 'triage-worker', skills = ['triage'], model = 'anthropic/claude-opus-5' }) {
  writeFileSync(
    join(dir, `${name}.jsonl`),
    [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `You are a dispatched worker. Your dispatch is ${dispatchId}. Write your verdict to /repo/.scratch/triage/${request}.md.` }] } }),
      JSON.stringify({ type: 'model_change', model, role: 'default' }),
      JSON.stringify({ type: 'custom_message', customType: 'skill-prompt', details: { role, skills, status: 'applied' } }),
    ].join('\n'),
  );
}

test('a request id selects one triage session among siblings sharing the current checkout', () => {
  const root = scratch();
  const store = join(root, 'store');
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });
  for (const [request, dispatchId] of [['triage-acme-7', 'ctx_a7a7a7a7a7a7'], ['triage-acme-8', 'ctx_b8b8b8b8b8b8']]) {
    passRecord(store, request, dispatchId);
    childSession(dir, request, { dispatchId, request, skills: ['triage', request] });
  }

  assert.deepEqual(dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root, store })?.sessionRole, {
    status: 'applied',
    role: 'triage-worker',
    skills: ['triage', 'triage-acme-7'],
  });
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme', sessionsRoot: root, store }), null, 'a request with no record names no dispatch, so it owns nothing (F-028)');
});

// The P1 on PR #124, and the reason it matters more than a sibling collision:
// the repair line this whole feature advertises is run FROM the orchestrator
// session, in the same checkout the children share. That session's own
// transcript names the dispatch — it printed the dispatch output, and it typed
// the command — so a whole-file match counts the caller as a candidate beside
// the child and refuses on an ambiguity it invented.
//
// Measured on this host, 2026-09-03: for four real triage passes, the whole-file
// match found 9, 14, 15 and 16 candidate files; the session whose FIRST TURN
// carried the dispatch was exactly one, every time. Reconciliation would have
// exited 1 on every invocation.
//
// OWNERSHIP IS THE FIRST TURN, which is where Orca's preamble names the
// dispatch it created the session for. A later mention is discussion.
test('a session that merely MENTIONS the dispatch is not a candidate for owning it', () => {
  const root = scratch();
  const store = join(root, 'store');
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });
  const request = 'triage-acme-7';
  const dispatchId = 'ctx_a7a7a7a7a7a7';
  passRecord(store, request, dispatchId);
  childSession(dir, 'child', { dispatchId, request });

  // The orchestrator: its own first turn is its own work, and the dispatch shows
  // up later — in the dispatch output it read and the repair it was told to run.
  writeFileSync(
    join(dir, 'orchestrator.jsonl'),
    [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'run the triage wave over this pile' }] } }),
      JSON.stringify({ type: 'model_change', model: 'anthropic/claude-opus-5', role: 'default' }),
      JSON.stringify({ type: 'custom_message', customType: 'skill-prompt', details: { role: 'orchestrator', skills: [], status: 'applied' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `RAN — dispatch=${dispatchId} stage=input_accepted state=ready` }] } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `ax worker transcript --dispatch-proof current --request ${request}` }] } }),
    ].join('\n'),
  );

  const proof = dispatchProof({ needle: 'current', request, sessionsRoot: root, store });
  assert.notEqual(proof, null, 'the caller naming the request must not make its own read ambiguous');
  assert.deepEqual(proof.sessionRole, { status: 'applied', role: 'triage-worker', skills: ['triage'] }, 'the child that OWNS the dispatch, not the session discussing it');
});

// #126 — WHY THE KEY IS THE DISPATCH ID FROM THE RECORD, AND NOT THE REQUEST ID
// IN THE CHILD'S PROSE. The request reaches a triage child only as its draft
// path, and a substring match on it has two defects measured on this host
// 2026-09-03: `triage-flosrn-ax-10` is a prefix of the #100–#103 children's
// first turns (four owners, so #10's read refuses for as long as they exist),
// and pass 2 of any issue names pass 1's draft path in its own spec, so one
// request owns two sessions. `ctx_…` has neither defect: Orca mints it per
// dispatch, fixed length, and writes it into the first turn of the session it
// created — the worker family (`./delivered.mjs`) always keyed on it. The record
// is what maps a request to its newest dispatch, and it does so for every
// record ever written, so nothing falls back to prose.
test('the request resolves through the record to the dispatch Orca minted — a prose prefix and a pass 1 draft path own nothing', () => {
  const root = scratch();
  const store = join(root, 'store');
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });

  // #10 beside #100: the request id of the first is a prefix of the second's prose.
  passRecord(store, 'triage-acme-10', 'ctx_101010101010');
  childSession(dir, 'ten', { dispatchId: 'ctx_101010101010', request: 'triage-acme-10', skills: ['triage', 'ten'] });
  passRecord(store, 'triage-acme-100', 'ctx_100100100100');
  childSession(dir, 'hundred', { dispatchId: 'ctx_100100100100', request: 'triage-acme-100', skills: ['triage', 'hundred'] });
  assert.deepEqual(
    dispatchProof({ needle: 'current', request: 'triage-acme-10', sessionsRoot: root, store })?.sessionRole.skills,
    ['triage', 'ten'],
    '#10 owns exactly its own session, whatever prose #100 carries',
  );

  // Pass 2 of #7: its spec names pass 1's draft path, and the record's newest
  // worker-start names the second dispatch.
  const path = passRecord(store, 'triage-acme-7', 'ctx_070707070707');
  childSession(dir, 'seven-pass-1', { dispatchId: 'ctx_070707070707', request: 'triage-acme-7', skills: ['triage', 'pass-1'] });
  phaseBegin(path, { name: 'worker-start', identity: 'id-pass-2', argv: ['worker-start', '--resume'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_727272727272', state: 'ready' } }) });
  writeFileSync(
    join(dir, 'seven-pass-2.jsonl'),
    [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'You are a dispatched worker. Your dispatch is ctx_727272727272. This is PASS 2 on this issue. Pass 1 already ran and its verdict is at /repo/.scratch/triage/triage-acme-7.md — read it first. Write your verdict to /repo/.scratch/triage/triage-acme-7.2.md.' }] } }),
      JSON.stringify({ type: 'model_change', model: 'm', role: 'default' }),
      JSON.stringify({ type: 'custom_message', customType: 'skill-prompt', details: { role: 'triage-worker', skills: ['triage', 'pass-2'], status: 'applied' } }),
    ].join('\n'),
  );
  assert.deepEqual(
    dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root, store })?.sessionRole.skills,
    ['triage', 'pass-2'],
    'the newest dispatch of the request, not both passes that name its path',
  );

  // A dispatch id that is a prefix of another owns nothing it did not create.
  passRecord(store, 'triage-acme-9', 'ctx_09');
  childSession(dir, 'nine-long', { dispatchId: 'ctx_09090909', request: 'triage-acme-9' });
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-9', sessionsRoot: root, store }), null, 'the id is matched whole, never as a prefix');

  // Two sessions carrying the same dispatch id is an ambiguity, never newest-wins.
  passRecord(store, 'triage-acme-11', 'ctx_111111111111');
  childSession(dir, 'eleven-a', { dispatchId: 'ctx_111111111111', request: 'triage-acme-11' });
  childSession(dir, 'eleven-b', { dispatchId: 'ctx_111111111111', request: 'triage-acme-11' });
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-11', sessionsRoot: root, store }), null, 'two owners cannot be established');

  // A record whose worker-start never came back names no dispatch, and an
  // unknown is not a match (F-028).
  const { path: bare } = claimRecord(store, 'triage-acme-12');
  initRecord(bare, { request: 'triage-acme-12', orca: 'orca', host: 'mac', now: () => '2026-09-03T08:00:00.000Z' });
  childSession(dir, 'twelve', { dispatchId: 'ctx_121212121212', request: 'triage-acme-12' });
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-12', sessionsRoot: root, store }), null, 'no dispatch on the record, no owner');
});

// Review of PR #128 (Codex, P2): the record is trusted for its dispatch id, so
// the record must be trustworthy in the way `dispatchIndex` already demands
// before a pane may be CLOSED — it names itself, and no other record claims
// the same dispatch. A copy under another name, or two records naming one
// dispatch, would otherwise prove the WRONG pass as verified (F-001).
test('a record that does not name itself, or a dispatch two records claim, proves nothing', () => {
  const root = scratch();
  const store = join(root, 'store');
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });
  passRecord(store, 'triage-acme-7', 'ctx_070707070707');
  childSession(dir, 'seven', { dispatchId: 'ctx_070707070707', request: 'triage-acme-7', skills: ['triage', 'seven'] });

  // `triage-acme-13.json` is a copy of #7's record: its inner `request` still says 7.
  writeFileSync(join(store, 'triage-acme-13.json'), readFileSync(join(store, 'triage-acme-7.json'), 'utf8'));
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-13', sessionsRoot: root, store }), null, 'a record naming another request vouches for nothing');
  assert.deepEqual(dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root, store })?.sessionRole.skills, ['triage', 'seven'], 'the record that names itself still resolves');

  // Two records, two requests, one dispatch id: ambiguous for both (F-001).
  passRecord(store, 'triage-acme-14', 'ctx_070707070707');
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-14', sessionsRoot: root, store }), null);
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root, store }), null, 'a dispatch claimed by two requests belongs to neither');
});

// Issue #97: the point-in-time CANNOT-ESTABLISH verdict of `ax triage dispatch`
// is re-derivable only by the verb that actually reads the session file — and
// it could not be pointed at ONE pass of a wave. Triage children run
// `--worktree current` and share the needle, so `request` is the only
// disambiguator; `dispatchProof` always took it and the CLI could not pass it.
//
// The three propositions below are the whole flag: it selects, it refuses
// ambiguity instead of falling back to newest, and a malformed value is a
// usage error rather than an unscoped read.

/** The proof mode with the streams kept apart: stdout is the proof, and only that. */
function proofRun(argv, env = { HOME: '/nonexistent-home' }) {
  const outs = [];
  const errs = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (outs.push(String(chunk)), true);
  process.stderr.write = chunk => (errs.push(String(chunk)), true);
  let code;
  try {
    code = transcript(argv, { env });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { code, out: outs.join(''), err: errs.join('') };
}

/**
 * A checkout shared by N triage passes, each with its own record and dispatch.
 *
 * Every pass carries a DISTINGUISHABLE payload — the skill and the model name
 * carry the request id — because the sibling files are otherwise byte-identical
 * proofs, and an unscoped newest-mtime read would then satisfy an assertion
 * about the pass it did not select. Written in order, so the LAST request is
 * the newest and is what a newest-wins fallback would answer. The CLI reads the
 * store through `ORCA_DISPATCH_STORE`, exactly as an operator's shell would.
 */
function wave(requests) {
  const root = scratch();
  const store = join(root, 'store');
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });
  for (const request of requests) {
    const dispatchId = `ctx_${request.replace(/[^a-z0-9]/g, '')}`;
    passRecord(store, request, dispatchId);
    childSession(dir, request, { dispatchId, request, skills: ['triage', request], model: `anthropic/claude-opus-5-${request}` });
  }
  return { root, store, env: { HOME: '/nonexistent-home', ORCA_DISPATCH_STORE: store } };
}

test('--dispatch-proof --request names one pass of a wave, as one JSON line on stdout', () => {
  const { root, store, env } = wave(['triage-acme-8', 'triage-acme-7']);

  const r = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme-8', '--sessions', root], env);
  assert.equal(r.code, 0);
  assert.equal(r.out.trimEnd().split('\n').length, 1, 'the remote reader takes the FIRST stdout line as the proof');
  assert.deepEqual(
    JSON.parse(r.out),
    dispatchProof({ needle: 'current', request: 'triage-acme-8', sessionsRoot: root, store }),
    'the CLI answers exactly what the reader it wraps answers',
  );
  assert.match(r.out, /triage-acme-8/, 'the named pass, not the newest one beside it');
  assert.doesNotMatch(r.out, /triage-acme-7/, 'an unscoped newest-wins read would answer the sibling');
});

test('--request with two or zero owners cannot establish — exit 1, and never newest-wins', () => {
  const { root, store, env } = wave(['triage-acme-7', 'triage-acme-8']);

  const unrecorded = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme', '--sessions', root], env);
  assert.equal(unrecorded.code, 1, 'a request with no record names no dispatch');
  assert.equal(unrecorded.out, '', 'nothing on stdout, so no caller reads a neighbouring pass as this one');

  const none = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme-9', '--sessions', root], env);
  assert.equal(none.code, 1);
  assert.equal(none.out, '');

  // Two sessions opened for one dispatch id: an ambiguity, not a pick.
  const dir = join(root, '-repo-current');
  childSession(dir, 'triage-acme-7-again', { dispatchId: 'ctx_triageacme7', request: 'triage-acme-7' });
  const two = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme-7', '--sessions', root], env);
  assert.equal(two.code, 1, 'two owners is an ambiguity, not a pick');
  assert.equal(two.out, '');
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root, store }), null);
});

test('--request without a value, or a value that is a flag, is a usage error', () => {
  const { root, env } = wave(['triage-acme-7']);
  // `bad`/`fix` write to stdout by this repository's convention (src/log.mjs),
  // exactly as the missing-needle check beside this one does. What must never
  // appear is a PROOF line: the remote reader parses the first stdout line, and
  // a silently-defaulted read would hand it a neighbouring pass as this one.
  const noProof = out => assert.throws(() => JSON.parse(out.split('\n')[0]), 'no caller can parse a proof out of a usage error');

  const bare = proofRun(['--dispatch-proof', 'current', '--sessions', root, '--request'], env);
  assert.equal(bare.code, 2);
  assert.match(bare.out, /--request expects the request id/);
  noProof(bare.out);

  const flagged = proofRun(['--dispatch-proof', 'current', '--request', '--sessions', root], env);
  assert.equal(flagged.code, 2, 'a flag consumed as a value would read an unscoped newest-wins proof');
  assert.match(flagged.out, /--request expects the request id/);
  noProof(flagged.out);
});

test('the retired --launch-proof spelling carries --request identically', () => {
  const { root, store, env } = wave(['triage-acme-7', 'triage-acme-8']);

  const r = proofRun(['--launch-proof', 'current', '--request', 'triage-acme-7', '--sessions', root], env);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root, store }));
  assert.doesNotMatch(r.out, /triage-acme-8/, 'the alias scopes, it does not fall back to newest');
  assert.match(r.err, /retired/, 'the alias still warns, and still on stderr');
});

// -- #204: two checkouts, one basename, and a caller holding the exact path ---
//
// Measured 2026-09-05 on integrated main f446f229: a real custom verification
// Dispatch spent its whole 120 s window and settled CANNOT ESTABLISH. Two
// session directories on that host end in `-ax` — `-Code-flosrn-ax` and
// `-orca-workspaces-improve-ax` — so the needle `ax` matched both and the tail
// match refused, correctly. `sessionFilesForNeedle({needle:'ax'})` answered 0
// files while the exact-cwd read answered that checkout's own directory with 63
// files and the applied `triage-worker` receipt in it. The caller had held
// `/Users/flo/Code/flosrn/ax` the whole time and handed over its basename.
//
// Exact-cwd selection is STRICTER than the tail match, so nothing below weakens
// the ambiguity refusal: it removes the ambiguity from the question instead of
// resolving one. The refusal on a basename is asserted unchanged in every case.

/**
 * That collision as a fixture: two session directories whose slugs both end in
 * `-ax`, one of them the caller's own checkout.
 */
function checkouts() {
  const home = scratch();
  const root = join(home, '.omp', 'agent', 'sessions');
  const store = join(home, 'store');
  const mine = join(home, 'Code', 'flosrn', 'ax');
  const sibling = join(home, 'orca', 'workspaces', 'improve-ax');
  const env = { HOME: home, ORCA_DISPATCH_STORE: store };
  const dirs = { mine: join(root, slugOf(mine, env)), sibling: join(root, slugOf(sibling, env)) };
  mkdirSync(dirs.mine, { recursive: true });
  mkdirSync(dirs.sibling, { recursive: true });
  return { root, store, mine, sibling, env, dirs };
}

const REQUEST = 'custom-flosrn-ax-174';
const OWNER = 'ctx_174174174174';

test('#204 the proof answers from the caller OWN checkout when two slugs end in its basename', () => {
  const { root, store, mine, env, dirs } = checkouts();
  passRecord(store, REQUEST, OWNER);
  childSession(dirs.mine, 'child', { dispatchId: OWNER, request: REQUEST, skills: ['triage', 'mine'] });
  // The adversarial sibling: it names the SAME dispatch, so nothing but the
  // directory can tell the two apart. A read that merely FILTERED by dispatch
  // would still be ambiguous here.
  childSession(dirs.sibling, 'stranger', { dispatchId: OWNER, request: REQUEST, skills: ['triage', 'sibling'] });

  assert.equal(
    dispatchProof({ needle: 'ax', request: REQUEST, sessionsRoot: root, store, env }),
    null,
    'a basename that names two checkouts still cannot choose — the refusal is untouched',
  );
  assert.deepEqual(
    dispatchProof({ needle: 'ax', cwd: mine, request: REQUEST, sessionsRoot: root, store, env })?.sessionRole.skills,
    ['triage', 'mine'],
    'the caller that holds the path gets ITS checkout, never the sibling ending in the same basename',
  );
});

test('#204 an own directory that holds no readable session is no proof — never a sibling one', () => {
  const { root, mine, sibling, env, dirs } = checkouts();
  childSession(dirs.sibling, 'stranger', { dispatchId: 'ctx_999999999999', request: 'other' });
  const readable = slugOf(sibling, env).replace(/^-+/, '');

  // Present and empty: an absence inside MY directory is not permission to
  // borrow another checkout's session (F-028).
  assert.equal(dispatchProof({ needle: 'ax', cwd: mine, sessionsRoot: root, env }), null);
  assert.notEqual(
    dispatchProof({ needle: readable, sessionsRoot: root, env }),
    null,
    'the sibling is readable, so the null above is a refusal and not an empty fixture',
  );

  // Present and unreadable — here a plain file, so `readdir` answers ENOTDIR.
  // Anything but ENOENT means the directory is THERE, and no fallback follows.
  rmSync(dirs.mine, { recursive: true });
  writeFileSync(dirs.mine, 'not a directory');
  assert.equal(dispatchProof({ needle: 'ax', cwd: mine, sessionsRoot: root, env }), null);
});

test('#204 an own directory that genuinely is not there still falls back to the tail match', () => {
  const { root, mine, env, dirs } = checkouts();
  rmSync(dirs.mine, { recursive: true });
  rmSync(dirs.sibling, { recursive: true });
  // The case the tail match still answers: a session recorded under a different
  // HOME than this process sees, and exactly one slug ending in the basename.
  const elsewhere = join(root, '-elsewhere-ax');
  mkdirSync(elsewhere, { recursive: true });
  childSession(elsewhere, 'recorded-elsewhere', { dispatchId: 'ctx_888888888888', request: 'other' });

  assert.equal(
    dispatchProof({ needle: 'ax', cwd: mine, sessionsRoot: root, env })?.sessionRole.role,
    'triage-worker',
    'ENOENT is the only absence that permits the fallback, and it still permits it',
  );
});

test('#204 every refusal names its own cause and its repair on stderr, with stdout still empty', () => {
  const { root, store, env, dirs } = checkouts();
  passRecord(store, REQUEST, OWNER);
  childSession(dirs.mine, 'child', { dispatchId: OWNER, request: REQUEST });

  // The reported argv, verbatim: exit 1, empty stdout — and no longer silent.
  const ambiguous = proofRun(['--dispatch-proof', 'ax', '--request', REQUEST, '--sessions', root], env);
  assert.equal(ambiguous.code, 1, 'the exit protocol is unchanged');
  assert.equal(ambiguous.out, '', 'and so is stdout: the remote reader parses its first line as the proof');
  assert.match(ambiguous.err, /2 session directories/, 'the cause: the needle named more than one checkout');
  assert.match(ambiguous.err, /-Code-flosrn-ax/, 'and it names the candidates');
  assert.match(ambiguous.err, /-orca-workspaces-improve-ax/);
  assert.match(ambiguous.err, /--dispatch-proof '<slug>' --request 'custom-flosrn-ax-174' --sessions '/, 'the repair keeps the scope AND the root it was asked with, quoted');

  // A request with no dispatch on record — a different fact, and it now reads
  // differently from the ambiguity above.
  const unrecorded = proofRun(['--dispatch-proof', 'Code-flosrn-ax', '--request', 'custom-flosrn-ax-999', '--sessions', root], env);
  assert.equal(unrecorded.code, 1);
  assert.equal(unrecorded.out, '');
  assert.match(unrecorded.err, /no dispatch on record/);
  assert.doesNotMatch(unrecorded.err, /session directories/, 'a missing record is not an ambiguous needle');

  // Zero owners: the directory is right, nothing in it names this dispatch.
  passRecord(store, 'custom-flosrn-ax-175', 'ctx_175175175175');
  const none = proofRun(['--dispatch-proof', 'Code-flosrn-ax', '--request', 'custom-flosrn-ax-175', '--sessions', root], env);
  assert.equal(none.code, 1);
  assert.equal(none.out, '');
  assert.match(none.err, /ctx_175175175175/, 'the refusal names the dispatch nothing owns');

  // Two owners: an ambiguity among the right directory files, still refused.
  childSession(dirs.mine, 'child-again', { dispatchId: OWNER, request: REQUEST });
  const two = proofRun(['--dispatch-proof', 'Code-flosrn-ax', '--request', REQUEST, '--sessions', root], env);
  assert.equal(two.code, 1);
  assert.equal(two.out, '');
  assert.match(two.err, /2 sessions/, 'two owners is an ambiguity, and it says so');

  // No session directory at all under the needle: the fourth distinct cause.
  const nowhere = proofRun(['--dispatch-proof', 'no-such-checkout', '--sessions', root], env);
  assert.equal(nowhere.code, 1);
  assert.equal(nowhere.out, '');
  assert.match(nowhere.err, /no session directory/);

  // Every refusal above carries a command, because a finding without one is not
  // actionable (AGENTS.md).
  for (const r of [ambiguous, unrecorded, none, two, nowhere]) assert.match(r.err, /→ ax /, 'each refusal names its repair');
});

// -- the printed repair, run by a real shell (review of #208) -----------------
//
// Two findings, one class: a repair line is program text an operator PASTES.
// Its slug is derived from a checkout path, so a checkout under a directory
// carrying a space or a `$(…)` yields a slug carrying it, and an unquoted one
// word-splits or EXPANDS. And a read scoped to an explicit `--sessions <root>`
// whose repair drops that root repairs a different question — the default root
// on this machine is another answer, or none.
//
// Both are proven by running the printed bytes through `sh`, never by matching
// their shape: a shape assertion is exactly what let a line that cannot run
// pass for a repair once already.

/**
 * `ax` on PATH pointing at THIS checkout's bin, so the printed word `ax` runs,
 * plus the machine answer the `worker` noun is gated on.
 *
 * `worker` is `gated: 'orca'`: on a machine that resolves no Orca binary the
 * whole noun does not exist, and the repair would read `unknown command
 * "worker"` — which is honest, since a line printed by `ax triage dispatch` was
 * printed on a machine that had one. `ORCA_BIN` is the documented operator
 * override and only has to be EXECUTABLE (`canRunDefault`), never runnable:
 * visibility and liveness are two propositions (../src/orca-bin.mjs), and the
 * proof branch answers before anything probes the runtime. So the suite stays
 * offline and needs no Orca.
 */
function shim(home) {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = fileURLToPath(new URL('../bin/ax.mjs', import.meta.url));
  writeFileSync(join(dir, 'ax'), `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(bin)} "$@"\n`, { mode: 0o755 });
  const orca = join(dir, 'orca-never-run');
  writeFileSync(orca, '#!/bin/sh\necho "this stub is never executed" >&2\nexit 97\n', { mode: 0o755 });
  return { path: dir, orca };
}

/**
 * The command as printed, run by a POSIX shell that can word-split and expand it.
 *
 * `cwd` is pinned because `bin/ax.mjs` is a delegating entry: it walks up from
 * the cwd looking for a project that declared an ax pin (../src/delegation.mjs).
 * Inheriting the runner's cwd would leave WHICH ax answers to the machine this
 * suite happens to run on, and the caller asserts below that the one the shell
 * reached is this code.
 */
const runInShell = (command, { home, store, path, orca }) =>
  spawnSync('sh', ['-c', command], {
    cwd: home,
    encoding: 'utf8',
    env: { HOME: home, PATH: `${path}:/usr/bin:/bin`, ORCA_DISPATCH_STORE: store, ORCA_BIN: orca },
  });

/** The `→ …` line a refusal printed, without the decoration or the trailing note. */
const repairIn = text =>
  (text.split('\n').find(line => line.includes('→ ax worker transcript')) ?? '')
    .replace(/^\s*→\s*/, '')
    .replace(/\s{3,}#.*$/, '');

test('#204 the printed repair survives a hostile checkout path and keeps its --sessions root', () => {
  // A sessions root under a directory whose name word-splits, globs, carries an
  // apostrophe, and would RUN if it reached a shell unquoted. `$(touch …)` is
  // the assertion: if the quoting is wrong, the sentinel appears. The
  // apostrophe is what a `'${path}'` wrap cannot survive (review of #210).
  const parent = mkdtempSync(join(tmpdir(), 'ax-shell-'));
  const home = join(parent, "flo's-home");
  mkdirSync(home);
  const sentinel = join(home, 'expanded');
  const hostile = join(home, `sessions dir; $(touch ${sentinel}) *`);
  const store = join(home, 'store');
  const { path, orca } = shim(home);

  // The collision, inside that root: two directories ending in `-ax`.
  const mine = join(hostile, '-Code-flosrn-ax');
  mkdirSync(mine, { recursive: true });
  mkdirSync(join(hostile, '-orca-workspaces-improve-ax'), { recursive: true });
  passRecord(store, REQUEST, OWNER);
  childSession(mine, 'child', { dispatchId: OWNER, request: REQUEST });

  const refused = proofRun(['--dispatch-proof', 'ax', '--request', REQUEST, '--sessions', hostile], { HOME: home, ORCA_DISPATCH_STORE: store });
  assert.equal(refused.code, 1);
  const printed = repairIn(refused.err);
  assert.ok(printed.startsWith('ax worker transcript'), `no repair was printed:\n${refused.err}`);

  // The operator's own gesture, and the only one: substitute one of the
  // directories the reason listed for the placeholder. Taken FROM the printed
  // reason, so nothing here is hardcoded.
  const candidate = refused.err.match(/: (-\S+), /)[1].replace(/^-+/, '');
  const executable = printed.replace("'<slug>'", `'${candidate}'`);

  const ran = runInShell(executable, { home, store, path, orca });
  assert.equal(ran.status, 0, `the printed repair did not run:\n${executable}\n${ran.stderr}`);
  assert.equal(JSON.parse(ran.stdout).sessionRole.role, 'triage-worker');
  assert.equal(existsSync(sentinel), false, 'the path was pasted as DATA — nothing in it was expanded');

  // And the root is load-bearing: the same command without it asks this
  // machine's default root, where none of this exists.
  const rootless = runInShell(executable.replace(/ --sessions .*$/, ''), { home, store, path, orca });
  assert.equal(rootless.status, 1, 'dropping the scoped root would have repaired a different question');

  // AND THE BINARY THE SHELL REACHED IS THIS CODE — otherwise the run above
  // could be satisfied by any ax on the machine and would prove nothing about
  // this one. The named stderr refusal exists only here (#204): an older ax
  // exits 1 with two empty streams and fails this line.
  //
  // `quote(hostile)`, never `'${hostile}'`: the latter closes at the first
  // apostrophe in TMPDIR (review of #210, `flo's-home` above) and is the same
  // class of defect as an unquoted printed repair. The helper is the one
  // production already uses, reused rather than re-decided.
  const reached = runInShell(`ax worker transcript --dispatch-proof ax --sessions ${quote(hostile)}`, { home, store, path, orca });
  assert.equal(reached.status, 1);
  assert.match(reached.stderr, /2 session directories/, 'the ax the shell reached is the one under test');
  assert.equal(existsSync(sentinel), false, 'the identity probe quoted the root as DATA too — nothing in it ran');
});

test('a worker proof ignores newer advisor sidecars and chooses the newest session', () => {
  const root = scratch();
  const dir = join(root, '--srv-orca-gapila-.worktrees-worker--');
  mkdirSync(dir, { recursive: true });
  const older = join(dir, 'older.jsonl');
  const newer = join(dir, 'newer.jsonl');
  const sidecar = join(dir, '__advisor.default.jsonl');
  writeFileSync(older, JSON.stringify({ type: 'model_change', model: 'old', role: 'default' }));
  writeFileSync(newer, JSON.stringify({ type: 'model_change', model: 'new', role: 'default' }));
  writeFileSync(sidecar, JSON.stringify({ type: 'model_change', model: 'advisor', role: 'slow' }));
  utimesSync(older, new Date(1_000), new Date(1_000));
  utimesSync(newer, new Date(2_000), new Date(2_000));
  utimesSync(sidecar, new Date(3_000), new Date(3_000));

  assert.deepEqual(dispatchProof({ needle: 'worker', sessionsRoot: root })?.model, {
    model: 'new',
    role: 'default',
  });
});

test('displayed text is capped, so one pasted preamble cannot become the whole output', () => {
  const dir = scratch();
  const path = fixtureFile(dir);
  const { out } = capture(() => transcript([path], { runner: fakeRunner(), env: { HOME: dir } }));
  const longest = Math.max(...out.split('\n').map(line => line.length));
  assert.ok(longest < 320, `no rendered line runs away (longest was ${longest})`);
  assert.match(out, /\.\.\./, 'the truncation is visible');
});

test('one truncated line is reported and does not swallow the entries after it', () => {
  const dir = scratch();
  const path = fixtureFile(dir);
  const { code, out } = capture(() => transcript([path], { runner: fakeRunner(), env: { HOME: dir } }));

  assert.equal(code, 0, 'a rendered transcript with one bad line is still a rendered transcript');
  assert.match(out, /6 {2}unparseable JSONL line/, 'the bad line is named by its number');
  assert.match(out, new RegExp(`sed -n '6p' ${path.replace(/[/\\]/g, '\\$&')}`), 'and carries the command that shows it raw');
  assert.match(out, /bash\(/, 'line 7 is still rendered');
  assert.match(out, /1 line\(s\) could not be parsed/);
});

test('a named .jsonl that does not exist is a refusal, never an empty rendering', () => {
  const dir = scratch();
  const { code, out } = capture(() => transcript([join(dir, 'nope.jsonl')], { runner: fakeRunner(), env: { HOME: dir } }));
  assert.equal(code, 3);
  assert.match(out, /no such session file/);
});

const storeEnv = () => {
  const home = scratch();
  return { HOME: home, ORCA_DISPATCH_STORE: join(home, 'dispatch'), AX_SESSIONS_ROOT: join(home, 'sessions') };
};

// The worktree lives under the fake HOME, because the slug is computed by
// stripping HOME: a worktree outside it produces a different directory name,
// which is a different test than the one this file means to run.
const worktreeOf = env => join(env.HOME, 'Code', 'proj');

const sessionDir = env => {
  const dir = join(env.AX_SESSIONS_ROOT, '-Code-proj');
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * A real record store, written through record.mjs, whose single phase reports a
 * worktree effect in Orca's `<repoId>::<PATH>` shape.
 */
function plantRecord(env, { request = 'req-1', dispatchId = 'ctx_9f2a', createdAt = '2026-08-21T15:00:00.000Z' } = {}) {
  const { path } = claimRecord(env.ORCA_DISPATCH_STORE, request);
  initRecord(path, { request, orca: '/usr/local/bin/orca', host: 'mac', now: () => createdAt });
  phaseBegin(path, { name: 'worker-start', identity: 'id-1', argv: ['worker-start'] });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({
      ok: true,
      result: {
        dispatchId,
        stage: 'dispatched',
        state: 'ready',
        effects: [{ kind: 'worktree', id: `repo_1::${worktreeOf(env)}` }],
      },
    }),
  });
  return path;
}

test('a dispatch id resolves through the record store to the session file it created', () => {
  const env = storeEnv();
  plantRecord(env);
  const path = fixtureFile(sessionDir(env));

  const { code, out } = capture(() => transcript(['ctx_9f2a'], { runner: fakeRunner(), env }));

  assert.equal(code, 0);
  assert.ok(out.includes(path), 'the resolved file is named');
  assert.ok(out.includes(`resolved from record req-1.json → worktree ${worktreeOf(env)}`), 'how it got there is diagnosable');
  assert.equal(out.includes(DCAP), false, 'redaction does not depend on how the target was resolved');
});

test('a request id resolves the same way as its dispatch id', () => {
  const env = storeEnv();
  plantRecord(env);
  fixtureFile(sessionDir(env));
  assert.equal(capture(() => transcript(['req-1'], { runner: fakeRunner(), env })).code, 0);
});

test('two session files postdating the record is a refusal that LISTS them', () => {
  const env = storeEnv();
  plantRecord(env);
  const dir = sessionDir(env);
  const first = fixtureFile(dir);
  const second = fixtureFile(dir, '2026-08-21T18-00-00-000Z_b1c2d3e4-0000-7000-8000-000000000000.jsonl');

  const { code, out } = capture(() => transcript(['ctx_9f2a'], { runner: fakeRunner(), env }));

  assert.equal(code, 3, 'newest-wins would render the wrong agent under the right name');
  assert.match(out, /2 session files/);
  assert.ok(out.includes(first) && out.includes(second), 'both candidates are named so the human can pick');
});

test('no session file postdating the record is a refusal, and unstamped names are shown as such', () => {
  const env = storeEnv();
  plantRecord(env);
  const dir = sessionDir(env);
  fixtureFile(dir, '2026-08-20T09-00-00-000Z_older-than-the-record.jsonl');
  fixtureFile(dir, 'handwritten.jsonl');

  const { code, out } = capture(() => transcript(['ctx_9f2a'], { runner: fakeRunner(), env }));

  assert.equal(code, 3);
  assert.match(out, /no session file in .* postdates the record/);
  assert.match(out, /handwritten\.jsonl {2}\(unstamped name\)/);
});

test('a record with no worktree effect is a named inability, not a default (F-028)', () => {
  const env = storeEnv();
  const { path } = claimRecord(env.ORCA_DISPATCH_STORE, 'req-bare');
  initRecord(path, { request: 'req-bare', orca: 'orca', host: 'mac', now: () => '2026-08-21T15:00:00.000Z' });
  phaseBegin(path, { name: 'worker-start', identity: 'id', argv: ['worker-start'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_bare', state: 'ready' } }) });

  const { code, out } = capture(() => transcript(['ctx_bare'], { runner: fakeRunner(), env }));
  assert.equal(code, 3);
  assert.match(out, /carries no worktree effect/);
});

test('two records answering to one target is a refusal that lists both', () => {
  const env = storeEnv();
  const a = plantRecord(env, { request: 'req-a', dispatchId: 'ctx_dup' });
  const b = plantRecord(env, { request: 'req-b', dispatchId: 'ctx_dup' });

  const { code, out } = capture(() => transcript(['ctx_dup'], { runner: fakeRunner(), env }));

  assert.equal(code, 3);
  assert.match(out, /names 2 dispatch records/);
  assert.ok(out.includes(a) && out.includes(b));
});

test('a target no record knows, and an unreadable record, are both said out loud', () => {
  const env = storeEnv();
  plantRecord(env);
  writeFileSync(join(env.ORCA_DISPATCH_STORE, 'broken.json'), '{ truncated');

  const { code, out } = capture(() => transcript(['ctx_unknown'], { runner: fakeRunner(), env }));

  assert.equal(code, 3);
  assert.match(out, /record broken\.json is not readable JSON/);
  assert.match(out, /no dispatch record names "ctx_unknown"/);
});

// ── --last-message: the last thing the agent SAID, not the last thing it DID ──
//
// Built for the lost-report case (8 peer messages lost in transit on
// 2026-08-23): the session file is the copy that cannot be lost, and the final
// assistant text is the report. The measured tail of a real session ends
// `toolCall → toolResult → assistant text → session_exit`, so "last entry"
// would answer with a tool move — these tests pin every exclusion separately.

const say = (role, parts) => JSON.stringify({ type: 'message', message: { role, content: parts } });

function lastFixture(dir) {
  const path = join(dir, 'last.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: '2026-08-22T12:04:59.329Z', cwd: '/Users/fake/Code/proj' }),
    say('user', [{ type: 'text', text: 'do the thing' }]),
    say('assistant', [{ type: 'text', text: 'an EARLY word that must never win' }]),
    say('assistant', [
      { type: 'thinking', thinking: 'private reasoning, never printed' },
      { type: 'text', text: `Final report: 11/11 done.\nThe capability was ${DCAP} and must not survive.` },
      { type: 'toolCall', name: 'bash', arguments: { command: 'echo done' } },
    ]),
    say('toolResult', [{ type: 'text', text: 'done' }]),
    say('assistant', [{ type: 'toolCall', name: 'bash', arguments: { command: 'git push' } }]),
    JSON.stringify({ type: 'custom', customType: 'session_exit' }),
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"a truncated fina',
  ].join('\n'));
  return path;
}

test('--last-message answers with the last WORD: tool moves, thinking and truncation after it are not it', () => {
  const path = lastFixture(scratch());
  const r = capture(() => transcript([path, '--last-message'], { runner: fakeRunner() }));
  assert.equal(r.code, 0);
  assert.match(r.out, /Final report: 11\/11 done\./);
  assert.match(r.out, /must not survive/, 'the text is rendered in FULL, not capped');
  assert.doesNotMatch(r.out, /dcap_[0-9a-f]/, 'the capability is redacted with no bypass');
  assert.doesNotMatch(r.out, /an EARLY word/, 'only the last message, never the history');
  assert.doesNotMatch(r.out, /private reasoning/, 'thinking is the model’s own, not something said');
  assert.match(r.out, /1 later line\(s\) unparseable and skipped/, 'the crash-mid-append tail is named, not fatal');
});

test('--last-message on a session with no assistant text is exit 1 — an absence, never a failure to look', () => {
  const dir = scratch();
  const path = join(dir, 'mute.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: '2026-08-22T12:04:59.329Z', cwd: '/x' }),
    say('user', [{ type: 'text', text: 'hello?' }]),
    say('assistant', [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }]),
  ].join('\n'));
  const r = capture(() => transcript([path, '--last-message'], { runner: fakeRunner() }));
  assert.equal(r.code, 1);
  assert.match(r.out, /no assistant message with text/);
  assert.match(r.out, /ax worker transcript/, 'the repair names the full-history reader');
});

test('a string-content message still answers — the older session shape is a message too', () => {
  const dir = scratch();
  const path = join(dir, 'plain.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: '2026-08-22T12:04:59.329Z', cwd: '/x' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'plain string report' } }),
  ].join('\n'));
  const r = capture(() => transcript([path, '--last-message'], { runner: fakeRunner() }));
  assert.equal(r.code, 0);
  assert.match(r.out, /plain string report/);
});

// ── a session id is a valid target — what a card shows is enough ─────────────

function idFixtures(dir) {
  const root = join(dir, 'sessions');
  const a = join(root, '-Code-fake-proj-a');
  const b = join(root, '-Code-fake-proj-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, '2026-08-22T12-04-59-329Z_01a0295c-2341-77c8-bf40-dec648fe300a.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: '01a0295c-2341-77c8-bf40-dec648fe300a', timestamp: '2026-08-22T12:04:59.329Z', cwd: '/x' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'the report of session A' }] } }),
  ].join('\n'));
  writeFileSync(join(b, '2026-08-23T09-00-00-000Z_01a02fff-9999-7000-8000-aaaaaaaaaaaa.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: '01a02fff-9999-7000-8000-aaaaaaaaaaaa', timestamp: '2026-08-23T09:00:00.000Z', cwd: '/y' }),
  ].join('\n'));
  return { root, env: { ORCA_DISPATCH_STORE: join(dir, 'store') } };
}

test('a session id prefix resolves alone when it names ONE file — the card is enough', () => {
  const { root, env } = idFixtures(scratch());
  const r = capture(() => transcript(['01a0295c', '--last-message'], { runner: fakeRunner(), env, sessionsRoot: root }));
  assert.equal(r.code, 0);
  assert.match(r.out, /the report of session A/);
  assert.match(r.out, /resolved as a session id under/, 'the via line says HOW, so a wrong answer is diagnosable');
});

test('a prefix shared by two sessions is a refusal naming both — never newest-wins', () => {
  const { root, env } = idFixtures(scratch());
  const r = capture(() => transcript(['01a0', '--last-message'], { runner: fakeRunner(), env, sessionsRoot: root }));
  assert.equal(r.code, 3);
  assert.match(r.out, /prefix of 2 session ids — refusing to guess/);
  assert.match(r.out, /01a0295c-2341/);
  assert.match(r.out, /01a02fff-9999/);
});

test('a hex target no record and no session knows names BOTH absences', () => {
  const { root, env } = idFixtures(scratch());
  const r = capture(() => transcript(['deadbeef', '--last-message'], { runner: fakeRunner(), env, sessionsRoot: root }));
  assert.equal(r.code, 3);
  assert.match(r.out, /no dispatch record names "deadbeef"/);
  assert.match(r.out, /no session id under .* starts with it/);
});
