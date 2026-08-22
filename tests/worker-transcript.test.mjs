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
import { launchProof, slugOf, stampOf, transcript } from '../src/worker/transcript.mjs';

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
          intent: 'Report to coordinator',
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
    data: { toolCallId: 't1', toolName: 'bash', intent: 'Report to coordinator', args: { command: `orca orchestration send --dispatch-capability ${DCAP}` } },
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

test('launch proof keeps model selection separate from role and skill application', () => {
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
        details: { role: 'worker', skills: ['lfg'], status: 'applied' },
      }),
    ].join('\n'),
  );

  assert.deepEqual(launchProof({ needle: 'gap-353', sessionsRoot: root }), {
    model: { model: 'anthropic/claude-sonnet-5', role: 'default' },
    sessionRole: { status: 'applied', role: 'worker', skills: ['lfg'] },
  });

  const { code, out } = capture(() =>
    transcript(['--launch-proof', 'gap-353', '--sessions', root], { env: { HOME: root } }),
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), launchProof({ needle: 'gap-353', sessionsRoot: root }));
});

test('launch proof carries the exact pre-turn role refusal', () => {
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
        details: { role: 'worker', reason: 'skill-not-found', missingSkills: ['lfg'] },
      }),
    ].join('\n'),
  );

  assert.deepEqual(launchProof({ needle: 'gap-353', sessionsRoot: root })?.sessionRole, {
    status: 'refused',
    role: 'worker',
    reason: 'skill-not-found',
    missingSkills: ['lfg'],
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

  assert.deepEqual(launchProof({ needle: 'current', request: 'triage-acme-7', sessionsRoot: root })?.sessionRole, {
    status: 'applied',
    role: 'triage-worker',
    skills: ['triage'],
  });
  assert.equal(launchProof({ needle: 'current', request: 'triage-acme', sessionsRoot: root }), null, 'two matches are ambiguity');
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

  assert.deepEqual(launchProof({ needle: 'worker', sessionsRoot: root })?.model, {
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
