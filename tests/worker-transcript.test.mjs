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
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';
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

test('a request id selects one triage session among siblings sharing the current checkout', () => {
  const root = scratch();
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });
  for (const request of ['triage-acme-7', 'triage-acme-8']) {
    writeFileSync(
      join(dir, `${request}.jsonl`),
      [
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `write .scratch/triage/${request}.md` }] } }),
        JSON.stringify({ type: 'model_change', model: 'anthropic/claude-opus-5', role: 'default' }),
        JSON.stringify({
          type: 'custom_message',
          customType: 'skill-prompt',
          details: { role: 'triage-worker', skills: ['triage'], status: 'applied' },
        }),
      ].join('\n'),
    );
  }

  assert.deepEqual(dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root })?.sessionRole, {
    status: 'applied',
    role: 'triage-worker',
    skills: ['triage'],
  });
  assert.equal(dispatchProof({ needle: 'current', request: 'triage-acme', sessionsRoot: root }), null, 'two matches are ambiguity');
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
function proofRun(argv) {
  const outs = [];
  const errs = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (outs.push(String(chunk)), true);
  process.stderr.write = chunk => (errs.push(String(chunk)), true);
  let code;
  try {
    code = transcript(argv, { env: { HOME: '/nonexistent-home' } });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { code, out: outs.join(''), err: errs.join('') };
}

/**
 * A checkout shared by N triage passes, each naming its own request id.
 *
 * Every pass carries a DISTINGUISHABLE payload — the skill and the model name
 * carry the request id — because the sibling files are otherwise byte-identical
 * proofs, and an unscoped newest-mtime read would then satisfy an assertion
 * about the pass it did not select. Written in order, so the LAST request is
 * the newest and is what a newest-wins fallback would answer.
 */
function wave(requests) {
  const root = scratch();
  const dir = join(root, '-repo-current');
  mkdirSync(dir, { recursive: true });
  for (const request of requests) {
    writeFileSync(
      join(dir, `${request}.jsonl`),
      [
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `write .scratch/triage/${request}.md` }] } }),
        JSON.stringify({ type: 'model_change', model: `anthropic/claude-opus-5-${request}`, role: 'default' }),
        JSON.stringify({
          type: 'custom_message',
          customType: 'skill-prompt',
          details: { role: 'triage-worker', skills: ['triage', request], status: 'applied' },
        }),
      ].join('\n'),
    );
  }
  return root;
}

test('--dispatch-proof --request names one pass of a wave, as one JSON line on stdout', () => {
  const root = wave(['triage-acme-8', 'triage-acme-7']);

  const r = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme-8', '--sessions', root]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trimEnd().split('\n').length, 1, 'the remote reader takes the FIRST stdout line as the proof');
  assert.deepEqual(
    JSON.parse(r.out),
    dispatchProof({ needle: 'current', request: 'triage-acme-8', sessionsRoot: root }),
    'the CLI answers exactly what the reader it wraps answers',
  );
  assert.match(r.out, /triage-acme-8/, 'the named pass, not the newest one beside it');
  assert.doesNotMatch(r.out, /triage-acme-7/, 'an unscoped newest-wins read would answer the sibling');
});

test('--request with two or zero candidates cannot establish — exit 1, and never newest-wins', () => {
  const root = wave(['triage-acme-7', 'triage-acme-8']);

  const two = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme', '--sessions', root]);
  assert.equal(two.code, 1, 'two matches is an ambiguity, not a pick');
  assert.equal(two.out, '', 'nothing on stdout, so no caller reads a neighbouring pass as this one');

  const none = proofRun(['--dispatch-proof', 'current', '--request', 'triage-acme-9', '--sessions', root]);
  assert.equal(none.code, 1);
  assert.equal(none.out, '');
});

test('--request without a value, or a value that is a flag, is a usage error', () => {
  const root = wave(['triage-acme-7']);
  // `bad`/`fix` write to stdout by this repository's convention (src/log.mjs),
  // exactly as the missing-needle check beside this one does. What must never
  // appear is a PROOF line: the remote reader parses the first stdout line, and
  // a silently-defaulted read would hand it a neighbouring pass as this one.
  const noProof = out => assert.throws(() => JSON.parse(out.split('\n')[0]), 'no caller can parse a proof out of a usage error');

  const bare = proofRun(['--dispatch-proof', 'current', '--sessions', root, '--request']);
  assert.equal(bare.code, 2);
  assert.match(bare.out, /--request expects the request id/);
  noProof(bare.out);

  const flagged = proofRun(['--dispatch-proof', 'current', '--request', '--sessions', root]);
  assert.equal(flagged.code, 2, 'a flag consumed as a value would read an unscoped newest-wins proof');
  assert.match(flagged.out, /--request expects the request id/);
  noProof(flagged.out);
});

test('the retired --launch-proof spelling carries --request identically', () => {
  const root = wave(['triage-acme-7', 'triage-acme-8']);

  const r = proofRun(['--launch-proof', 'current', '--request', 'triage-acme-7', '--sessions', root]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), dispatchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root }));
  assert.doesNotMatch(r.out, /triage-acme-8/, 'the alias scopes, it does not fall back to newest');
  assert.match(r.err, /retired/, 'the alias still warns, and still on stderr');
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
