// `briefDelivered` — the witness that reads the child's OWN session, and #204:
// WHICH checkout's session that is.
//
// The third of the three sites that lost the same information. This witness
// holds the single worktree the record names and handed the resolver only its
// basename, so a second checkout whose slug ends in that basename made the read
// refuse — measured 2026-09-05, two session directories on the reporting host
// end in `-ax`. It reads more truthfully now and decides no more than it
// decided before: the dispatch id still selects the session, a session older
// than the dispatch is still another agent's history, and zero or two
// candidates is still an inability to testify (F-028). Nothing here grants a
// close authorization that was not already granted.
//
// Offline by construction: records are written through record.mjs into a
// tmpdir, and every session file is a fixture.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { briefDelivered } from '../src/worker/delivered.mjs';
import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';
import { slugOf } from '../src/worker/transcript.mjs';

const DISPATCH = 'ctx_204204204204';
const ISSUED = '2026-09-05T08:00:00.000Z';

/**
 * The measured collision, as a whole dispatch on disk: a record naming ONE
 * worktree and ONE dispatch, that worktree's own session directory, and a
 * second checkout whose slug ends in the same basename.
 *
 * The sibling carries a brief naming the SAME dispatch, which is the
 * adversarial case: nothing but the directory can tell the two apart, so a read
 * that borrowed it would testify about another checkout's pane.
 */
function dispatched({ sibling = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-witness-')));
  const root = join(home, '.omp', 'agent', 'sessions');
  const store = join(home, 'store');
  const worktree = join(home, 'orca', 'workspaces', 'ax');
  const env = { HOME: home };

  const { path } = claimRecord(store, 'gap-204-exact-checkout-proof');
  initRecord(path, { request: 'gap-204-exact-checkout-proof', orca: 'orca', host: 'mac', now: () => ISSUED });
  phaseBegin(path, { name: 'worker-start', identity: 'id-1', argv: ['worker-start'], now: () => ISSUED });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({
      ok: true,
      result: { dispatchId: DISPATCH, state: 'ready', effects: [{ kind: 'worktree', id: `repo_1::${worktree}` }] },
    }),
  });

  const own = join(root, slugOf(worktree, env));
  mkdirSync(own, { recursive: true });
  if (sibling) session(join(root, '-Code-flosrn-ax'), { text: `You are a dispatched worker. Your dispatch is ${DISPATCH}.` });
  return { root, store, record: path, worktree, own, env };
}

/** A session as Orca writes one: its first user turn is the brief it delivered. */
function session(dir, { at = '2026-09-05T09:00:00.000Z', text } = {}) {
  mkdirSync(dir, { recursive: true });
  const entries = [{ type: 'session', version: 3, timestamp: at, cwd: dirname(dir) }];
  if (text !== undefined) entries.push({ type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } });
  writeFileSync(join(dir, `${at.replace(/[:.]/g, '-')}_child.jsonl`), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

test('#204 the witness testifies from the worktree the record names, never a checkout sharing its basename', () => {
  const { root, record, own, env } = dispatched();
  session(own, { text: `You are a dispatched worker. Your dispatch is ${DISPATCH}. Implement #204.` });

  const witness = briefDelivered(record, { env, sessionsRoot: root });
  assert.equal(witness.known, true, 'two directories ending in -ax used to make this refuse');
  assert.equal(witness.delivered, true);
  assert.ok(witness.file.startsWith(own), `the child's own session, not the sibling's: ${witness.file}`);
  assert.equal(witness.count, 1, 'the brief arrived and nothing since — the count is unchanged');
});

test('#204 an own session directory that holds nothing readable testifies to nothing', () => {
  const { root, record, env } = dispatched();

  // Present and empty. The sibling holds a brief naming this very dispatch, and
  // borrowing it on the strength of an absence is exactly what F-028 forbids.
  const witness = briefDelivered(record, { env, sessionsRoot: root });
  assert.equal(witness.known, false);
  assert.match(witness.reason, /no single session under/);
});

test('#204 every guard the witness already applied still refuses', () => {
  // A session in the RIGHT directory that names another dispatch: the id still
  // selects, so this is not the pane the record dispatched.
  const other = dispatched({ sibling: false });
  session(other.own, { text: 'You are a dispatched worker. Your dispatch is ctx_999999999999.' });
  assert.equal(briefDelivered(other.record, { env: other.env, sessionsRoot: other.root }).known, false);

  // A session that PREDATES the dispatch, naming it: another agent's history in
  // the same worktree, and the floor is the dispatching phase's own `beganAt`.
  const early = dispatched({ sibling: false });
  session(early.own, { at: '2026-09-05T07:00:00.000Z', text: `Your dispatch is ${DISPATCH}` });
  const stale = briefDelivered(early.record, { env: early.env, sessionsRoot: early.root });
  assert.equal(stale.known, false);
  assert.match(stale.reason, /predates this dispatch/);

  // Two sessions in that directory naming the dispatch: an ambiguity, never a
  // pick — the safe direction, since the answer authorizes closing a pane.
  const two = dispatched({ sibling: false });
  session(two.own, { text: `Your dispatch is ${DISPATCH}` });
  session(two.own, { at: '2026-09-05T10:00:00.000Z', text: `Your dispatch is ${DISPATCH}` });
  assert.equal(briefDelivered(two.record, { env: two.env, sessionsRoot: two.root }).known, false);

  // A worktree whose session directory is not there AT ALL falls back to the
  // tail match — the shape of a session recorded under a different HOME — and
  // that match still refuses two answers, exactly as it always did.
  const gone = dispatched();
  session(gone.own, { text: `Your dispatch is ${DISPATCH}` });
  rmSync(gone.own, { recursive: true });
  session(join(gone.root, '-Code-other-ax'), { text: `Your dispatch is ${DISPATCH}` });
  assert.equal(
    briefDelivered(gone.record, { env: gone.env, sessionsRoot: gone.root }).known,
    false,
    'two directories answering to the basename is an ambiguity, and no sibling is a substitute',
  );
});
