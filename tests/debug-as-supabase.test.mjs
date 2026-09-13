// The one module that holds a service-role key.
//
// It speaks the documented Supabase Auth (GoTrue) admin wire contract —
// `POST /auth/v1/admin/generate_link` with `apikey` and bearer authorization,
// answering a root `hashed_token` — and nothing else. Every rule here is a
// containment rule: the host must be a loopback literal or an exact private
// allowlist entry (a host that merely RESOLVES to loopback is not a literal, and
// a suffix is never a match), redirects are refused rather than followed with a
// credential attached, the body is bounded, `action_link` is never used, and no
// provider diagnostic reaches a caller.
//
// `tests/fixtures/supabase-generate-link.json` follows the published
// self-hosting Auth reference response for this endpoint. Replacing it with a
// byte capture from a real local stack is U9's obligation, before Gapila's own
// SDK-backed route is deleted.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SUPABASE_DEADLINE_MS, supabaseHandoff } from '../src/debug-as/supabase.mjs';
import { resetSecrets, scrub } from '../src/debug-as/emit.mjs';

const captured = JSON.parse(readFileSync(new URL('./fixtures/supabase-generate-link.json', import.meta.url), 'utf8'));

const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service-role-payload.signature';

const provider = (overrides = {}) => ({
  type: 'supabase',
  urlEnv: 'NEXT_PUBLIC_SUPABASE_URL',
  serviceRoleKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY',
  confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' },
  ...overrides,
});

const variables = (url = 'http://127.0.0.1:54321') => name =>
  ({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: KEY })[name];

const handoff = (options = {}) =>
  supabaseHandoff({
    provider: provider(),
    email: 'pro@makerkit.dev',
    tailnetOrigin: 'https://gapila-pro.tail1234.ts.net',
    destinationPath: '/home/gapila-pro',
    readVariable: variables(),
    allowedHosts: [],
    ...options,
  });

/** A fetch stand-in that records the one request this module is allowed to make. */
const recorder = (answer = () => new Response(JSON.stringify(captured), { status: 200, headers: { 'content-type': 'application/json' } })) => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    return answer(input, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

test('a confirmed handoff posts the documented admin call and lands on the app callback', async () => {
  const fetchImpl = recorder();
  const { url } = await handoff({ fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:54321/auth/v1/admin/generate_link');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(JSON.parse(call.init.body), { type: 'magiclink', email: 'pro@makerkit.dev' });
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('apikey'), KEY);
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`);

  const built = new URL(url);
  assert.equal(built.origin, 'https://gapila-pro.tail1234.ts.net');
  assert.equal(built.pathname, '/auth/confirm');
  assert.equal(built.searchParams.get('token_hash'), captured.hashed_token);
  assert.equal(built.searchParams.get('type'), 'magiclink');
  assert.equal(built.searchParams.get('next'), '/home/gapila-pro');
  assert.equal(built.searchParams.get('redirect_to'), null);
  assert.doesNotMatch(url, /verify\?token=/, 'action_link is never used');
});

test('the SDK\'s `properties` wrapper is tolerated, because that shape is a client-side construction', async () => {
  const wrapped = { properties: { hashed_token: captured.hashed_token, action_link: captured.action_link }, user: { email: 'pro@makerkit.dev' } };
  const fetchImpl = recorder(() => new Response(JSON.stringify(wrapped), { status: 200 }));
  const { url } = await handoff({ fetchImpl });
  assert.equal(new URL(url).searchParams.get('token_hash'), captured.hashed_token);
});

test('two different token hashes in one response refuse rather than picking one', async () => {
  const ambiguous = { hashed_token: 'aaaa', properties: { hashed_token: 'bbbb' } };
  const fetchImpl = recorder(() => new Response(JSON.stringify(ambiguous), { status: 200 }));
  let error;
  await assert.rejects(handoff({ fetchImpl }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
});

test('a magic link with no token hash refuses instead of falling back to action_link', async () => {
  const only = { action_link: captured.action_link };
  const fetchImpl = recorder(() => new Response(JSON.stringify(only), { status: 200 }));
  let error;
  await assert.rejects(handoff({ fetchImpl }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.doesNotMatch(String(error.message), /auth\/v1\/verify/);
});

test('a non-string or empty token hash refuses', async () => {
  for (const value of [42, '', null, { token: 'x' }]) {
    const fetchImpl = recorder(() => new Response(JSON.stringify({ hashed_token: value }), { status: 200 }));
    await assert.rejects(handoff({ fetchImpl }), Error);
  }
});

test('the deadline AX owns end to end is fifteen seconds, and exceeding it refuses with no credential retry', async () => {
  assert.equal(SUPABASE_DEADLINE_MS, 15000);
  const fetchImpl = recorder(async (_input, init) => {
    await new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      setTimeout(resolve, 1000);
    });
    return new Response('{}', { status: 200 });
  });
  let error;
  await assert.rejects(handoff({ fetchImpl, timeoutMs: 20 }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.equal(fetchImpl.calls.length, 1, 'a deadline is not a retry');
});

// --- Host containment --------------------------------------------------------

const refusesHost = async (url, { allowedHosts = [] } = {}) => {
  const fetchImpl = recorder();
  let error;
  await assert.rejects(handoff({ fetchImpl, readVariable: variables(url), allowedHosts }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.equal(fetchImpl.calls.length, 0, `${url} must be refused before any request carries the key`);
  assert.ok(error.fix);
  return error;
};

test('loopback literals and exactly "localhost" are the default hosts', async () => {
  for (const url of ['http://127.0.0.1:54321', 'http://127.2.3.4:54321', 'http://[::1]:54321', 'http://localhost:54321']) {
    const fetchImpl = recorder();
    await handoff({ fetchImpl, readVariable: variables(url) });
    assert.equal(fetchImpl.calls.length, 1, url);
  }
});

test('a hostname that merely resolves to loopback is not a literal and refuses with zero requests', async () => {
  await refusesHost('http://localtest.me:54321');
  await refusesHost('http://localhost.evil.example.com:54321');
  await refusesHost('http://127.0.0.1.evil.example.com:54321');
});

test('an allowlist entry matches verbatim by host and port, and a suffix is never a match', async () => {
  const allowedHosts = [{ host: 'supabase.example.ts.net', port: 443 }];
  const fetchImpl = recorder();
  await handoff({ fetchImpl, readVariable: variables('https://supabase.example.ts.net'), allowedHosts });
  assert.equal(fetchImpl.calls.length, 1);

  await refusesHost('https://evil-supabase.example.ts.net', { allowedHosts });
  await refusesHost('https://a.supabase.example.ts.net', { allowedHosts });
  await refusesHost('https://supabase.example.ts.net:8443', { allowedHosts });
  await refusesHost('https://supabase.example.ts.net', { allowedHosts: [{ host: 'other.example.ts.net', port: 443 }] });
});

test('an allowlisted host still refuses over http: only loopback may be unencrypted', async () => {
  await refusesHost('http://supabase.example.ts.net', { allowedHosts: [{ host: 'supabase.example.ts.net', port: 80 }] });
});

test('a missing or unparseable variable refuses by name, never by value', async () => {
  let missing;
  await assert.rejects(handoff({ fetchImpl: recorder(), readVariable: () => undefined }), err => {
    missing = err;
    return err instanceof Error;
  });
  assert.match(missing.problem, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.ok(missing.fix);

  let noKey;
  await assert.rejects(
    handoff({ fetchImpl: recorder(), readVariable: name => (name === 'NEXT_PUBLIC_SUPABASE_URL' ? 'http://127.0.0.1:54321' : undefined) }),
    err => {
      noKey = err;
      return err instanceof Error;
    },
  );
  assert.match(noKey.problem, /SUPABASE_SERVICE_ROLE_KEY/);

  let bad;
  await assert.rejects(handoff({ fetchImpl: recorder(), readVariable: variables('not a url') }), err => {
    bad = err;
    return err instanceof Error;
  });
  assert.ok(bad.fix);
});

// --- Hostile responses, against a real local server --------------------------

/** A local HTTP server standing in for a hostile or broken Auth host. */
const hostile = handler =>
  new Promise(resolve => {
    const hits = [];
    const server = createServer((request, response) => {
      hits.push({ url: request.url, method: request.method, headers: request.headers });
      handler(request, response);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) }));
  });

test('a redirect is refused rather than followed with the service-role key attached', async () => {
  const local = await hostile((request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1:1/steal' });
    response.end();
  });
  let error;
  await assert.rejects(handoff({ readVariable: variables(local.url) }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  assert.equal(local.hits.length, 1, 'exactly one request: the redirect was never followed');
  await local.close();
});

test('an oversized response body is refused at the cap rather than buffered', async () => {
  const local = await hostile((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"hashed_token":"');
    response.write('a'.repeat(80 * 1024));
    response.end('"}');
  });
  let error;
  await assert.rejects(handoff({ readVariable: variables(local.url) }), err => {
    error = err;
    return err instanceof Error;
  });
  assert.ok(error.fix);
  await local.close();
});

test('a malformed body, an HTML error page and a server error all refuse without exposing provider detail', async () => {
  for (const [status, body, type] of [
    [200, '{ "hashed_token": ', 'application/json'],
    [200, '<html><body>Cloudflare</body></html>', 'text/html'],
    [500, JSON.stringify({ msg: 'service_role key rejected for project abcdefgh', code: 'unexpected_failure' }), 'application/json'],
    [401, JSON.stringify({ msg: 'invalid JWT: eyJhbGciOiJIUzI1NiJ9.leak.sig' }), 'application/json'],
  ]) {
    const local = await hostile((request, response) => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    });
    let error;
    await assert.rejects(handoff({ readVariable: variables(local.url) }), err => {
      error = err;
      return err instanceof Error;
    });
    assert.ok(error.fix);
    const said = `${error.message} ${error.problem} ${error.fix}`;
    assert.doesNotMatch(said, /service_role key rejected|Cloudflare|eyJhbGciOiJIUzI1NiJ9\.leak/);
    assert.match(said, /[a-z0-9]{6,}/i, 'a safe failure still carries a diagnostic identifier');
    await local.close();
  }
});

test('the resolved key and the minted token cannot survive a later emission', async () => {
  // The rule is not "a register was called"; it is that nothing this module
  // touched can be printed afterwards. So the real registry is used, and the
  // proof is what `src/debug-as/emit.mjs` does to a message that carries both.
  resetSecrets();
  const answer = await handoff({ fetchImpl: recorder() });
  const said = scrub(`key=${KEY} token=${captured.hashed_token} url=${answer.url}`);
  assert.equal(said.includes(KEY), false, 'the service-role key is unprintable for the rest of the process');
  assert.equal(said.includes(captured.hashed_token), false, 'and so is the token it minted');
  resetSecrets();
});

test('an unsafe callback parameter name or destination path refuses before a URL is built', async () => {
  const unsafe = provider({ confirm: { path: '/auth/confirm', tokenParam: 'token hash', typeParam: 'type', typeValue: 'magiclink', nextParam: 'next' } });
  await assert.rejects(handoff({ fetchImpl: recorder(), provider: unsafe }), Error);
  await assert.rejects(handoff({ fetchImpl: recorder(), destinationPath: '//evil.example.com' }), Error);
  await assert.rejects(handoff({ fetchImpl: recorder(), destinationPath: 'home' }), Error);
});

test('the callback kind is pinned to the magic link AX actually issues, and a mismatch refuses before any request', async () => {
  // The POST always asks for `type: "magiclink"`. A callback declaring any other
  // kind would hand the phone a token of one kind under the name of another, so
  // the shape check is not "a safe word" but "the kind this module issues".
  for (const typeValue of ['recovery', 'signup', 'invite', 'email_change', 'magic_link']) {
    const fetchImpl = recorder();
    const mismatched = provider({ confirm: { path: '/auth/confirm', tokenParam: 'token_hash', typeParam: 'type', typeValue, nextParam: 'next' } });
    let error;
    await assert.rejects(handoff({ fetchImpl, provider: mismatched }), err => {
      error = err;
      return err instanceof Error;
    });
    assert.equal(fetchImpl.calls.length, 0, `${typeValue} must be refused before a request carries the key`);
    assert.ok(error.fix);
    assert.match(error.problem, /magiclink/);
  }
});

test('a host that answers headers and then stalls the body is refused inside the same deadline', async () => {
  // The deadline is one budget over the whole call, not over the headers alone:
  // a host can answer 200 instantly and then never finish the body.
  const stalled = [];
  const local = await hostile((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"hashed_token":"');
    stalled.push(response);
  });
  const started = Date.now();
  let error;
  await assert.rejects(handoff({ readVariable: variables(local.url), timeoutMs: 150 }), err => {
    error = err;
    return err instanceof Error;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `a stalled body must be refused inside its budget, took ${elapsed}ms`);
  assert.ok(error.fix);
  const said = `${error.message} ${error.problem} ${error.fix}`;
  assert.equal(said.includes(KEY), false, 'a timed-out call never says the credential it carried');
  assert.match(said, /[a-z0-9]{6,}/i, 'a safe failure still carries a diagnostic identifier');
  for (const response of stalled) response.destroy();
  await local.close();
});
