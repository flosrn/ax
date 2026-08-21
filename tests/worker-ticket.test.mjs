// The ticket half of `ax worker launch`, one proposition per incident (F-027).
//
// This is the stage that runs BEFORE anything is created, and each rule below is
// there because a child once inherited its absence: a doubled branch name
// (2026-08-15), a ticket with a zero-character body (GAP-355, 2026-08-14), a ref
// that lived in exactly one clone (2026-08-14), and a taught read command that
// exits 0 while showing the child a truncated ticket (GAP-372/356/376).
//
// Offline by construction: the Orca runner is built over a stubbed exec and `gh`
// is a stub, so no tracker credential and no network are touched. `needsRef` is
// the one exception and deliberately so — it runs REAL git against a real bare
// origin in a temp dir, because a mocked `ls-remote` would prove nothing about
// the question that incident was about.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import {
  emptyBodyRefusal,
  needsRef,
  normalizeSlug,
  readCommand,
  readTicket,
  ticketKind,
} from '../src/worker/ticket.mjs';

/** An Orca runner whose binary never runs: `answer` is what the CLI would print. */
const runnerOf = answer => createRunner({ bin: 'orca', exec: () => answer });

/** The measured `orca linear issue --json` shape: the issue under `result.issue`. */
const linearReceipt = (issue, extra = {}) => JSON.stringify({ ok: true, result: { issue }, ...extra });

const ISSUE = {
  identifier: 'GAP-353',
  title: 'Loading states for the wizard',
  url: 'https://linear.app/g/issue/GAP-353',
  state: { name: 'In Progress' },
  description: 'Plan: docs/plans/x.md, heading U1. Acceptance: V1-V3 pass.',
};

test('a ref is a Linear key or a GitHub number, and anything else is refused', () => {
  // Guessing a tracker from a free-form string is how a brief ends up pointing at
  // nothing, so the grammars are anchored: containing a key is not being one.
  assert.equal(ticketKind('GAP-353'), 'linear');
  assert.equal(ticketKind('ENG-7'), 'linear');
  assert.equal(ticketKind('1234'), 'github');

  for (const bad of ['GAP-353-loading-states', 'the wheel hangs', 'gap-353', 'GAP-', '', undefined]) {
    assert.equal(ticketKind(bad), null, `${bad} must not be taken for a ticket ref`);
  }

  // The refusal reaches the operator through readTicket, which must not attempt a read.
  let called = false;
  const read = readTicket('the wheel hangs', { exec: () => ((called = true), {}) });
  assert.equal(read.ok, false);
  assert.match(read.reason, /Linear ref like GAP-353 or a GitHub issue number/);
  assert.equal(called, false);
});

test('a --slug repeating the ticket ref is corrected, and the correction is announced', () => {
  // Measured 2026-08-15 on the first real use: `--slug GAP-356-cache-components`
  // produced `feat/gap-356-gap-356-cache-components`, because the request id already
  // carries the ref. Corrected rather than refused — the intent is unambiguous — but
  // never silently: the name is what the operator will later search for.
  const prefix = normalizeSlug('GAP-356', 'GAP-356-cache-components');
  assert.equal(prefix.slug, 'cache-components');
  assert.match(prefix.note, /repeated the ticket ref/);
  assert.match(prefix.note, /GAP-356/);

  // Case is not part of the identity of a ref, so the lowercase form doubles too.
  assert.equal(normalizeSlug('GAP-356', 'gap-356-cache-components').slug, 'cache-components');

  // A slug that IS the ref carries no information at all: it is dropped entirely.
  const equal = normalizeSlug('GAP-356', 'gap-356');
  assert.equal(equal.slug, '');
  assert.match(equal.note, /just the ticket ref/);

  // And a slug that merely starts with the same letters is left alone: `note` is
  // empty exactly when nothing was corrected.
  assert.deepEqual(normalizeSlug('GAP-356', 'gap-3560-thing'), { slug: 'gap-3560-thing', note: '' });
  assert.deepEqual(normalizeSlug('GAP-356', 'cache-components'), { slug: 'cache-components', note: '' });
});

test('a Linear ticket reduces to the five fields a brief needs, and never to its body', () => {
  const t = readTicket('GAP-353', {
    kind: 'linear',
    run: runnerOf({ status: 0, stdout: linearReceipt(ISSUE), stderr: '' }),
  });
  assert.deepEqual(t, {
    ok: true,
    id: 'GAP-353',
    title: 'Loading states for the wizard',
    url: 'https://linear.app/g/issue/GAP-353',
    state: 'In Progress',
    bodyLength: ISSUE.description.length,
  });
  // The body TEXT is the child's to read on its own host. Only its size crosses.
  assert.equal(Object.hasOwn(t, 'body'), false);
});

test('a GitHub issue answers the same shape, from the top level of its own JSON', () => {
  // Two trackers, one shape: a launcher that parses both inline grows a second
  // parser the day a third tracker appears (record.py v_ticket).
  const gh = (bin, args) => {
    assert.equal(bin, 'gh');
    assert.deepEqual(args, ['issue', 'view', '1234', '--json', 'title,url,state,body']);
    return {
      status: 0,
      stdout: JSON.stringify({ title: 'Wheel hangs', url: 'https://github.com/o/r/issues/1234', state: 'OPEN', body: 'steps' }),
      stderr: '',
    };
  };
  assert.deepEqual(readTicket('1234', { kind: 'github', exec: gh }), {
    ok: true,
    id: '#1234',
    title: 'Wheel hangs',
    url: 'https://github.com/o/r/issues/1234',
    state: 'OPEN',
    bodyLength: 5,
  });
});

test("an unreadable ticket is a refusal that carries the tracker's own words", () => {
  // 2026-08-01: three worktrees ran without ever reading their brief. A brief whose
  // ticket line is empty sends a child to improvise, so a read that does not answer
  // must stop the launch here, before anything exists.
  const dead = readTicket('GAP-353', {
    kind: 'linear',
    run: runnerOf({ status: 1, stdout: '{"ok": false, "error": "linear_not_connected"}', stderr: 'auth failed\nretry' }),
  });
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /could not read GAP-353 from Linear/);
  assert.match(dead.reason, /linear_not_connected|auth failed/);

  // A ticket that answers without an identifier, a title or a url is unreadable too:
  // half a ticket in a brief is a brief pointing at nothing.
  const partial = readTicket('GAP-353', {
    kind: 'linear',
    run: runnerOf({ status: 0, stdout: linearReceipt({ identifier: 'GAP-353', state: { name: 'Todo' } }), stderr: '' }),
  });
  assert.equal(partial.ok, false);

  // `gh` that cannot RUN is its own named reason: a missing binary, a missing
  // credential and a dead network need three different repairs.
  const noGh = readTicket('1234', {
    kind: 'github',
    exec: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn gh ENOENT') }),
  });
  assert.equal(noGh.ok, false);
  assert.match(noGh.reason, /gh cannot run/);
  assert.match(noGh.reason, /Install the GitHub CLI/);
});

test('the taught read command shows the comment thread, and is never `--full`', () => {
  // Measured on GAP-372/356/376: `orca linear issue <KEY> --full` prints a ~350-byte
  // header and reports `Comments: 0` on issues that HAVE comments, while exiting 0 —
  // which is why five dispatches carried it without anyone noticing. The assertion is
  // on the RUNNABLE form: the text names `--full` in order to forbid it, so a bare word
  // check would go red on the prohibition while a child pasting the command stayed broken.
  const linear = readCommand({ kind: 'linear', ref: 'GAP-353' });
  assert.doesNotMatch(linear, /orca linear issue \S+ --full/);
  assert.match(linear, /get_issue/);
  assert.match(linear, /list_comments/);
  assert.match(linear, /orca linear issue GAP-353 --json/);

  assert.equal(readCommand({ kind: 'github', ref: '1234' }), '`gh issue view 1234 --comments`');
});

test('an empty ticket body refuses on the default entry point, and --task lifts the gate', () => {
  // Measured 2026-08-14: GAP-355 was dispatched with a body of zero characters. Every
  // other check passed, the child was created, and the only correct move left to it was
  // to escalate — the decision it was defined by was named nowhere it could read.
  const alternates = [
    { task: '/ce-plan GAP-355', why: 'the work is not decided yet; plan it first' },
    { task: '/ce-debug GAP-355', why: 'a bug report, where the ticket is evidence and not a spec' },
  ];
  const refusal = emptyBodyRefusal({ bodyLength: 0, id: 'GAP-355', alternates });
  assert.match(refusal, /GAP-355 reads, but its body is empty/);
  // The escape routes come from the CALLER: `ax` runs in repos whose agents answer to
  // verbs it has never heard of, so no skill name is written into the module — which is
  // provable here only because this test supplies the two it asserts.
  assert.match(refusal, /--task '\/ce-plan GAP-355'/);
  assert.match(refusal, /the work is not decided yet/);
  const bare = emptyBodyRefusal({ bodyLength: 0, id: 'GAP-355' });
  assert.equal(/ce-plan|ce-debug|lfg/.test(bare), false);
  // A caller that declared no alternates still gets a refusal, and still gets told the
  // shape of the way out.
  assert.match(bare, /--task '<entry point>'/);

  // `--task` names another entry point on purpose. Refusing it would make the one
  // correct route to an undecided ticket unreachable.
  assert.equal(emptyBodyRefusal({ bodyLength: 0, id: 'GAP-355', task: '/ce-plan GAP-355', alternates }), '');

  // A body that exists and says nothing is the CHILD's gate to refuse, not this one's:
  // only emptiness is decidable from here.
  assert.equal(emptyBodyRefusal({ bodyLength: 3, id: 'GAP-355' }), '');
});

test('--needs-ref refuses a ref origin does not carry, proved against real git', () => {
  // Measured 2026-08-14: nine Makerkit `v4-step/*` tags existed solely in one Mac's
  // clone, behind a paid private remote the other host has no credential for. A child
  // placed there was defined by a merge it could not perform, while disk, habitability,
  // context file and marker all proved true. `ls-remote` answers for every host at once,
  // which is why the question is asked of origin rather than of the target host.
  const dir = mkdtempSync(join(tmpdir(), 'ax-needs-ref-'));
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'work');
  const git = (at, ...args) => {
    const out = spawnSync('git', args, { cwd: at, encoding: 'utf8' });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  };
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 'ax@example.test');
  git(clone, 'config', 'user.name', 'ax');
  writeFileSync(join(clone, 'README.md'), 'ax\n');
  git(clone, 'add', 'README.md');
  git(clone, 'commit', '-m', 'seed');
  git(clone, 'tag', 'v4-step/01-base');
  git(clone, 'push', 'origin', 'main');

  // The tag exists in this clone and NOWHERE else — precisely the measured situation.
  const local = needsRef('v4-step/01-base', { cwd: clone });
  assert.equal(local.ok, false);
  assert.match(local.reason, /does not resolve on origin/);
  // Every finding names its repair: how to see what origin carries, and how to publish.
  assert.match(local.reason, /git ls-remote --refs origin/);
  assert.match(local.reason, /git push origin/);

  git(clone, 'push', 'origin', 'refs/tags/v4-step/01-base');
  assert.deepEqual(needsRef('v4-step/01-base', { cwd: clone }), { ok: true });
  // A branch on origin resolves too, and no ref at all is nothing to prove.
  assert.deepEqual(needsRef('main', { cwd: clone }), { ok: true });
  assert.deepEqual(needsRef('', { cwd: clone }), { ok: true });
});
