/**
 * The subagent-vs-lead latch, which three extensions rely on to stay silent
 * for a session that is not theirs.
 *
 * Every case below is a race that has either happened or was designed against:
 * a child stealing the latch, a child overwriting it at its own
 * `session_start`, and an unlatched extension acting on an event it cannot
 * attribute.
 */

import { expect, test } from 'bun:test';
import { createSessionOwner, isSubagentSession, sessionIdOf } from './session';

const ctxFor = (id: unknown) => ({ sessionManager: { getSessionId: () => id } });
const LEAD = ctxFor('sess-lead');
const CHILD = ctxFor('sess-child');


const fileCtx = (file: string) => ({ sessionManager: { getSessionFile: () => file } });

test('subagent detection survives a fresh extension factory because it reads the file shape', () => {
  const parent = '2026-08-23T09-00-00-000Z_019fdb81-47a2-7000-8fca-2b66b08f9e99';
  expect(isSubagentSession(fileCtx(`/sessions/-repo/${parent}/Reviewer.jsonl`))).toBe(true);
  expect(isSubagentSession(fileCtx(`/sessions/-repo/${parent}.jsonl`))).toBe(false);
  expect(isSubagentSession(fileCtx(''))).toBe(false);
  expect(isSubagentSession({})).toBe(false);
});
test('an unclaimed latch calls everything foreign', () => {
  // Fail closed. `session_start` may not have fired yet, and an extension that
  // acted here would act for whoever spoke first.
  const owner = createSessionOwner();
  expect(owner.isForeign(LEAD)).toBe(true);
  expect(owner.isForeign(CHILD)).toBe(true);
});

test('the first non-empty session_start wins and is never overwritten', () => {
  const owner = createSessionOwner();
  owner.claim(LEAD);
  owner.claim(CHILD); // a subagent gets a session_start too
  expect(owner.isForeign(LEAD)).toBe(false);
  expect(owner.isForeign(CHILD)).toBe(true);
});

test('a child that starts first owns the latch, and the lead is then foreign', () => {
  // Not a bug — a statement of the invariant. This is why `claim` is wired to
  // `session_start` and nothing later: the lead's fires at startup, before it
  // can spawn anything at all.
  const owner = createSessionOwner();
  owner.claim(CHILD);
  expect(owner.isForeign(CHILD)).toBe(false);
  expect(owner.isForeign(LEAD)).toBe(true);
});

test('an unreadable ctx never claims the latch', () => {
  const owner = createSessionOwner();
  for (const bad of [undefined, null, {}, { sessionManager: {} }, ctxFor('')])
    owner.claim(bad);
  // Still unclaimed, so still failing closed — a ctx with no id must not
  // become an owner that every real session then fails to match.
  expect(owner.isForeign(LEAD)).toBe(true);
  owner.claim(LEAD);
  expect(owner.isForeign(LEAD)).toBe(false);
});

test('an unreadable ctx is foreign to a claimed latch, rather than matching it', () => {
  const owner = createSessionOwner();
  owner.claim(LEAD);
  for (const bad of [undefined, null, {}, ctxFor('')])
    expect(owner.isForeign(bad)).toBe(true);
});

test('each extension gets its own latch', () => {
  // A factory, not shared state: this is what makes the extraction a
  // replacement of three copies rather than a change of behaviour.
  const a = createSessionOwner();
  const b = createSessionOwner();
  a.claim(LEAD);
  expect(a.isForeign(LEAD)).toBe(false);
  expect(b.isForeign(LEAD)).toBe(true);
});

test('sessionIdOf reads the id, and never throws on a hostile ctx', () => {
  expect(sessionIdOf(LEAD)).toBe('sess-lead');
  expect(sessionIdOf(undefined)).toBe('');
  expect(sessionIdOf({ sessionManager: { getSessionId: 'not-a-function' } })).toBe('');
  expect(
    sessionIdOf({
      sessionManager: {
        getSessionId: () => {
          throw new Error('boom');
        },
      },
    }),
  ).toBe('');
  // A non-string id is coerced, not trusted as-is — two sessions must never
  // compare equal by accident.
  expect(sessionIdOf(ctxFor(42))).toBe('42');
  expect(sessionIdOf(ctxFor(null))).toBe('');
});
