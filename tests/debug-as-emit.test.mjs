// The one emission boundary every `src/debug-as/` module writes through, and the
// redaction vocabulary behind it.
//
// R35 is a structural rule, not a style preference: a debug session resolves a
// service-role key, a hashed token and a magic link into memory, and any of the
// three reaching a terminal is the authority leak this feature exists to avoid.
// So two things are pinned here — that the boundary keeps `src/log.mjs`'s stream
// choices byte for byte (a payload is still a payload, a refusal is still on
// stderr), and that a value nothing can pattern-match is still redacted once it
// has been registered.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { emit, addSecrets, resetSecrets, scrub, raw, refuse, progress, refusal } from '../src/debug-as/emit.mjs';
import { redactSecrets } from '../src/redact.mjs';

/** Capture one stream while `fn` runs; restore it whatever happens. */
function captured(stream, fn) {
  const target = process[stream];
  const original = target.write.bind(target);
  let text = '';
  target.write = chunk => {
    text += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    target.write = original;
  }
  return text;
}

test('the payload stays a payload: emit.raw writes stdout unchanged', () => {
  const out = captured('stdout', () => emit.raw('{"verdict":"VIVANT"}'));
  assert.equal(out, '{"verdict":"VIVANT"}\n');
  assert.equal(raw, emit.raw);
});

test('a refusal and its repair go to stderr, never to the payload stream', () => {
  const err = captured('stderr', () => {
    const out = captured('stdout', () => emit.refuse('no live Role browser in this worktree', 'ax debug-as --as owner'));
    assert.equal(out, '');
  });
  assert.match(err, /no live Role browser in this worktree/);
  assert.match(err, /ax debug-as --as owner/);
  assert.equal(refuse, emit.refuse);
});

test('a step line is stderr progress, so a legitimate wait is not a hang', () => {
  const err = captured('stderr', () => progress('preparing authentication'));
  assert.equal(err, 'preparing authentication\n');
});

test('refusal() prints the triple with its repair and answers the same message', () => {
  let message;
  const err = captured('stderr', () => {
    message = refusal({ at: 'debugAs.browser', problem: 'declares no start command', fix: 'declare "debugAs.browser.start"' });
  });
  assert.match(err, /debugAs\.browser/);
  assert.match(err, /declares no start command/);
  assert.match(err, /declare "debugAs\.browser\.start"/);
  assert.match(message, /declares no start command/);
});

test('a registered runtime value is redacted everywhere it appears, on every helper', () => {
  resetSecrets();
  addSecrets(['s3cret-service-role-value']);
  try {
    const out = captured('stdout', () => emit.note('adapter used s3cret-service-role-value twice: s3cret-service-role-value'));
    assert.ok(!out.includes('s3cret-service-role-value'), out);
    const err = captured('stderr', () => emit.refuse('failed with s3cret-service-role-value', 'retry with s3cret-service-role-value'));
    assert.ok(!err.includes('s3cret-service-role-value'), err);
  } finally {
    resetSecrets();
  }
});

test('a trivially short or empty registration is refused rather than redacting every line', () => {
  resetSecrets();
  addSecrets(['', '  ', 'ab']);
  try {
    assert.equal(scrub('ab is an ordinary word'), 'ab is an ordinary word');
  } finally {
    resetSecrets();
  }
});

test('the token and magic-link shapes are redacted with no registration at all', () => {
  resetSecrets();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.Q2hhbmdlTWVDaGFuZ2VNZQ';
  const text = [
    `service key ${jwt}`,
    'link https://app.example.ts.net/auth/confirm?token_hash=pkce_9f8e7d6c5b4a3f2e1d0c&type=magiclink',
    '{"hashed_token":"9f8e7d6c5b4a3f2e1d0c9f8e"}',
    'apikey: sb_secret_3f2e1d0c9f8e7d6c5b4a',
    'authorization: Bearer sb_secret_3f2e1d0c9f8e7d6c5b4a',
  ].join('\n');

  const out = scrub(text);
  assert.ok(!out.includes(jwt), out);
  assert.ok(!out.includes('pkce_9f8e7d6c5b4a3f2e1d0c'), out);
  assert.ok(!out.includes('9f8e7d6c5b4a3f2e1d0c9f8e'), out);
  assert.ok(!out.includes('sb_secret_3f2e1d0c9f8e7d6c5b4a'), out);
  // The shape around the value survives, or a reader cannot tell what leaked.
  assert.match(out, /token_hash=/);
  assert.match(out, /hashed_token/);
});

test('the existing dispatch-capability vocabulary is extended, not replaced', () => {
  assert.equal(redactSecrets('run --dispatch-capability dcap_abc123'), 'run --dispatch-capability dcap_<redacted>');
  assert.equal(scrub('run --dispatch-capability dcap_abc123'), 'run --dispatch-capability dcap_<redacted>');
});

test('redactSecrets substitutes caller-registered values too, so one pass covers both', () => {
  assert.equal(redactSecrets('key=abcdef123456', { values: ['abcdef123456'] }), 'key=<redacted>');
});

test('no module in src/debug-as/ imports src/log.mjs directly (R35)', () => {
  const dir = new URL('../src/debug-as/', import.meta.url).pathname;
  const offenders = readdirSync(dir)
    .filter(name => name.endsWith('.mjs') && name !== 'emit.mjs')
    .filter(name => /from\s+['"][^'"]*\/log\.mjs['"]/.test(readFileSync(join(dir, name), 'utf8')));
  assert.deepEqual(offenders, []);
});
