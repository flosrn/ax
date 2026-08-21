// `ax worker tail` — the probe that keeps three readings of "zero" apart.
//
// One proposition per test, each the one its origin defends (F-027): the matrix
// is the port of orca-terminal-tail.test.ts, which itself exists because a
// terminal was closed on a tail read through the wrong key, and a `--lines`
// receipt answered a null status that looked like an empty pane (F-041).
//
// Offline by construction: the runner is always injected, so no real Orca and
// no runtime is ever touched. The receipts are the ones measured on 2026-08-09
// against a live handle — the interesting ones (moved key, null status) cannot
// be produced on demand against a real runtime.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { tail } from '../src/worker/tail.mjs';

const HANDLE = 'term_a51ccbf8-23e1-4aa7-8735-9d0cbf09a521';

/** Everything the verb told the human, on either stream, and its exit code. */
function capture(fn) {
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
}

/**
 * A stub Orca: `status` answers ready, `terminal read` answers one canned
 * receipt text, and every argv handed over is recorded. The real runner wraps
 * it, so the receipt goes through the real parse — an unparseable one included.
 */
function fakeRunner({ receipt = '', ready = true } = {}) {
  const calls = [];
  const runner = createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') {
        return ready
          ? { status: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }), stderr: '' }
          : { status: 1, stdout: '', stderr: 'connect ECONNREFUSED' };
      }
      return { status: 0, stdout: receipt, stderr: '' };
    },
  });
  return { runner, calls };
}

/** The receipt shape a running terminal actually returns. */
const alive = (lines, extra = {}) =>
  JSON.stringify({
    ok: true,
    result: { terminal: { handle: HANDLE, status: 'running', latestCursor: 30074, tail: lines, ...extra } },
  });

const probe = (receiptText, handle = HANDLE, options = {}) => {
  const { runner, calls } = fakeRunner({ receipt: receiptText, ...options });
  const { code, out } = capture(() => tail([handle], { runner }));
  return { code, out, calls };
};

test('a terminal with output is alive and its tail is printed', () => {
  const r = probe(alive(['⠋ Reading full e2e harness report']));

  assert.equal(r.code, 0);
  assert.match(r.out, /ALIVE —/);
  assert.match(r.out, /Reading full e2e harness report/);
});

test('a terminal that has printed nothing is ALIVE, SILENT — never the same answer as absent', () => {
  const r = probe(alive([]));

  assert.equal(r.code, 1);
  assert.match(r.out, /ALIVE, SILENT/);
  // The distinction the whole verb exists for.
  assert.notEqual(r.code, 3);
  assert.match(r.out, /not a dead terminal/);
});

test('the `--lines` shape — a null status — cannot establish, and says so by name', () => {
  // The exact receipt `--lines 60` produced against a running terminal.
  const r = probe(JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, status: null, returnedLineCount: null } } }));

  assert.equal(r.code, 3);
  assert.match(r.out, /--lines/);
});

test('the probe never passes --lines', () => {
  const r = probe(alive(['a line']));

  assert.ok(
    r.calls.some(argv => argv.startsWith('terminal read')),
    'the tail must come from `terminal read`',
  );
  assert.ok(
    r.calls.every(argv => !argv.includes('--lines')),
    '--lines annihilates the read (F-041) — it may never be passed',
  );
});

test('a receipt whose key moved cannot establish, and refuses to read it as empty', () => {
  // The shape a caller gets when it reaches for `result.output`, which does not exist.
  const r = probe(JSON.stringify({ ok: true, result: { output: '' } }));

  assert.equal(r.code, 3);
  assert.match(r.out, /Do NOT read this as an empty terminal/);
});

test('an error receipt cannot establish', () => {
  const r = probe(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no such terminal' } }));

  assert.equal(r.code, 3);
  assert.match(r.out, /not_found/);
});

test('output that is not JSON cannot establish', () => {
  const r = probe('Unknown command: terminal read');

  assert.equal(r.code, 3);
  assert.match(r.out, /not JSON/);
  assert.match(r.out, /Unknown command/, 'the raw diagnostic is carried, never dropped (F-004)');
});

test('a handle that is not a handle is refused before the runtime is called', () => {
  const r = probe(alive([]), 'not-a-handle');

  assert.equal(r.code, 3);
  assert.deepEqual(r.calls, [], 'no runtime call may be made on a handle that cannot be one');
});

test('there is no --help: it is not a term_… handle, so it is refused as one', () => {
  const r = probe(alive([]), '--help');

  assert.equal(r.code, 3);
  assert.deepEqual(r.calls, []);
});

test('a missing handle is refused with a repair, before any runtime call', () => {
  const { runner, calls } = fakeRunner({ receipt: alive([]) });
  const { code, out } = capture(() => tail([], { runner }));

  assert.equal(code, 3);
  assert.deepEqual(calls, []);
  assert.match(out, /→ /, 'every refusal carries its fix');
});

test('the tail of a supervised child is redacted — it carries its dcap_ by construction', () => {
  const r = probe(alive(['orca orchestration worker-done --dispatch-capability dcap_R3alT0k3n-42 --status ok']));

  assert.equal(r.code, 0);
  assert.match(r.out, /dcap_<redacted>/);
  assert.ok(!r.out.includes('dcap_R3alT0k3n-42'), 'a dispatch authority token may never be re-displayed');
});

test('no Orca on the machine is a named inability, never silence — and fails CLOSED', () => {
  const { code, out } = capture(() => tail([HANDLE], { resolve: () => null }));

  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH/);
  assert.match(out, /→ /);
});

test('an unreachable runtime cannot establish, and is probed before the read', () => {
  const { runner, calls } = fakeRunner({ receipt: alive(['a line']), ready: false });
  const { code, out } = capture(() => tail([HANDLE], { runner }));

  assert.equal(code, 3);
  assert.deepEqual(calls, ['status --json'], 'the read must not be attempted against a runtime that does not answer');
  assert.match(out, /orca open/);
});
