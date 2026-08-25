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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * A store on disk holding one record, whose newest `worker-start` recorded
 * `panes` and ran with `--on host` when `on` is given. Real files: the resolver
 * this exercises reads the store the way the verb does.
 */
function storeWith(records) {
  const store = mkdtempSync(join(tmpdir(), 'ax-tail-store-'));
  for (const [request, phases] of Object.entries(records)) {
    writeFileSync(
      join(store, `${request}.json`),
      JSON.stringify({
        request,
        attempts: [{
          n: 1,
          settled: false,
          phases: phases.map(({ dispatchId, pane, on = '', state = 'failed', beganAt }) => ({
            name: 'worker-start',
            exit: 0,
            beganAt,
            argv: ['orca', 'orchestration', 'worker-start', ...(on ? ['--on', on] : []), '--json'],
            receipt: {
              ok: true,
              result: {
                dispatchId,
                state,
                effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: pane }],
              },
            },
          })),
        }],
      }),
    );
  }
  return { HOME: store, ORCA_DISPATCH_STORE: store };
}

test('a request id resolves to the pane its dispatch recorded, settled or not', () => {
  // Measured 2026-08-25 on 55-work: `ax worker ls` named no handle because the
  // worker-start settled `failed`, `ax worker transcript 55-work` read the same
  // record happily, and this verb refused the slug on its argument shape — so
  // the one verb that says whether the pane still emits was unreachable for
  // exactly the record that needed it.
  const env = storeWith({ '55-work': [{ dispatchId: 'ctx_047889f5daa4', pane: HANDLE }] });
  const { runner, calls } = fakeRunner({ receipt: alive(['⠋ Reading contracts/memory.ts']) });
  const r = capture(() => tail(['55-work'], { runner, env }));

  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`55-work → ${HANDLE}`));
  assert.match(r.out, /ALIVE —/);
  assert.ok(calls.some(line => line.includes(`terminal read --terminal ${HANDLE}`)), 'the resolved pane is the one read');
});

test('a dispatch id resolves through the same store, and never through another dispatch of that record', () => {
  // A `--replace` records a second worker-start, so the record's NEWEST pane is
  // not the pane the named dispatch opened. Taking the newest would tail the
  // wrong child of the right request.
  const env = storeWith({
    'comm-1': [
      { dispatchId: 'ctx_old', pane: 'term_old-pane', beganAt: '2026-08-25T03:00:00.000Z' },
      { dispatchId: 'ctx_new', pane: HANDLE, beganAt: '2026-08-25T04:00:00.000Z' },
    ],
  });
  const { runner, calls } = fakeRunner({ receipt: alive([]) });
  const r = capture(() => tail(['ctx_old'], { runner, env }));

  assert.equal(r.code, 1, 'ALIVE, SILENT — the pane was read');
  assert.match(r.out, /ctx_old → term_old-pane/);
  assert.ok(calls.some(line => line.includes('terminal read --terminal term_old-pane')));
});

test("a remote request's pane is read on the runtime its own worker-start named", () => {
  // The handle alone addresses the wrong machine: a remote pane read without
  // `--environment` interrogates the local runtime, which either answers about
  // nothing or about a stranger.
  const env = storeWith({ 'rem-1': [{ dispatchId: 'ctx_rem', pane: HANDLE, on: 'envx' }] });
  const { runner, calls } = fakeRunner({ receipt: alive(['working']) });
  const r = capture(() => tail(['rem-1'], { runner, env }));

  assert.equal(r.code, 0);
  assert.match(r.out, /on 'envx'/);
  assert.ok(calls.some(line => line.includes('--environment envx')), 'the pane is read on its own host');
});

test('a request the store maps to no pane cannot establish, and names the route that needs none', () => {
  const env = storeWith({});
  const { runner, calls } = fakeRunner({ receipt: alive([]) });
  const r = capture(() => tail(['55-work'], { runner, env }));

  assert.equal(r.code, 3);
  assert.match(r.out, /no dispatch record on this host names a pane/);
  assert.match(r.out, /ax worker transcript 55-work/);
  assert.equal(calls.filter(line => line.startsWith('terminal read')).length, 0, 'nothing was read');
});

test('a request whose panes disagree is refused, never guessed', () => {
  const env = storeWith({
    'two-1': [
      { dispatchId: 'ctx_a', pane: 'term_first' },
      { dispatchId: 'ctx_b', pane: 'term_second' },
    ],
  });
  const { runner, calls } = fakeRunner({ receipt: alive([]) });
  const r = capture(() => tail(['two-1'], { runner, env }));

  assert.equal(r.code, 3);
  assert.match(r.out, /names 2 panes/);
  assert.equal(calls.filter(line => line.startsWith('terminal read')).length, 0, 'nothing was read');
});

test('a record this scan could not READ is never reported as a record that does not exist', () => {
  // F-028: an absence claimed out of a failed look. The store holds a file for
  // this exact request and it does not parse, so nothing here knows which pane
  // it opened — which is not the same sentence as "no record names a pane".
  const env = storeWith({ 'other-1': [{ dispatchId: 'ctx_o', pane: 'term_other' }] });
  writeFileSync(join(env.ORCA_DISPATCH_STORE, '55-work.json'), '{ truncated');
  const { runner, calls } = fakeRunner({ receipt: alive([]) });
  const r = capture(() => tail(['55-work'], { runner, env }));

  assert.equal(r.code, 3);
  assert.match(r.out, /the record for '55-work' cannot be read/);
  assert.match(r.out, /55-work\.json/);
  assert.match(r.out, /ax worker start --show --request 55-work/);
  assert.doesNotMatch(r.out, /no dispatch record on this host/, 'a failed read is not an absence');
  assert.equal(calls.filter(line => line.startsWith('terminal read')).length, 0, 'nothing was read');
});

test('an EXITED pane is never called alive, whether it has a last frame or not', () => {
  // Measured 2026-08-25 on 56-scores-r2: the child's pane had closed,
  // `terminal read` answered `status=exited cursor=0` with no line, and this
  // verb printed `ALIVE, SILENT` followed by "This is not a dead terminal" —
  // about a terminal that was exactly that. The status sat in the receipt and on
  // the printed line; nothing read it.
  const silent = probe(JSON.stringify({
    ok: true,
    result: { terminal: { handle: HANDLE, status: 'exited', latestCursor: 0, tail: [] } },
  }));
  assert.equal(silent.code, 4, 'its own verdict, never 1 — a caller must not wait for a corpse to speak');
  assert.match(silent.out, /EXITED, SILENT/);
  assert.doesNotMatch(silent.out, /ALIVE/);
  assert.doesNotMatch(silent.out, /not a dead terminal/, 'the reassurance argued against the only correct action');
  assert.match(silent.out, new RegExp(`ax worker transcript ${HANDLE}`), 'the session outlives the pane');

  // With a last frame, the frame is still worth printing — it is just not proof
  // of a living session.
  const framed = probe(JSON.stringify({
    ok: true,
    result: { terminal: { handle: HANDLE, status: 'exited', latestCursor: 98216, tail: ['Tests  709 passed'] } },
  }));
  assert.equal(framed.code, 4);
  assert.match(framed.out, /EXITED — /);
  assert.match(framed.out, /709 passed/);
  assert.match(framed.out, /last frame/);
});

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
