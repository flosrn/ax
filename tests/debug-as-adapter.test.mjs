// The project's Debug adapter, run as a bounded conversation.
//
// These spawn a REAL node process, because everything this contract bounds is a
// property of a real child: a deadline that must kill, an output cap that must
// not be reached by reading forever, a non-zero exit whose stderr tail is the
// only diagnostic an operator gets. A fake runner would pin the wrapper and
// prove none of it.
//
// The env assertion is the security half (R26/R27): AX resolves `.env.local`
// values for its own use, and an adapter that inherits them would turn every
// project script into a credential path AX opened.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ADAPTER_PROTOCOL, MAX_ADAPTER_OUTPUT, runAdapter } from '../src/debug-as/adapter.mjs';

/** A worktree holding one adapter script. */
function adapter(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ax-debug-adapter-'));
  writeFileSync(join(dir, 'adapter.mjs'), body);
  return { dir, command: ['node', 'adapter.mjs'] };
}

/** The adapter every happy path uses: echo the request back as its answer. */
const ECHO = `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({ protocol: request.protocol, ok: true, saw: request, cwd: process.cwd(), env: Object.keys(process.env).sort() }));
});
`;

test('the adapter receives a versioned JSON request on stdin and answers one JSON object', async () => {
  const { dir, command } = adapter(ECHO);
  const answer = await runAdapter({
    command,
    timeoutSeconds: 20,
    request: { action: 'prepare', identity: 'owner', storageState: 'apps/e2e/.auth/owner.json', origin: 'http://localhost:3110' },
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  assert.equal(answer.ok, true);
  assert.equal(answer.saw.protocol, ADAPTER_PROTOCOL);
  assert.equal(answer.saw.identity, 'owner');
  assert.equal(answer.saw.origin, 'http://localhost:3110');
});

test('it runs from the worktree root, with no shell between AX and the argv', async () => {
  const { dir, command } = adapter(ECHO);
  const answer = await runAdapter({ command: [...command, 'an argument with spaces; echo pwned'], timeoutSeconds: 20, request: {}, cwd: dir, env: { PATH: process.env.PATH } });

  assert.equal(answer.saw.protocol, ADAPTER_PROTOCOL);
  assert.ok(answer.cwd.endsWith(dir.split('/').pop()), answer.cwd);
});

test('AX adds no value it resolved from an env file to the adapter environment', async () => {
  const { dir, command } = adapter(ECHO);
  // A real project variable AX is able to resolve, and the credential name the
  // phone provider reads. Neither may reach the child: R27 keeps resolved
  // values inside AX, so an adapter that needs them reads its own project
  // configuration exactly as it does when a developer runs it by hand.
  writeFileSync(join(dir, '.env.local'), 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_should_never_travel\nAX_DIRECT_URL=http://localhost:3110\n');
  const given = { PATH: process.env.PATH, AMBIENT_ONLY: 'kept' };
  const answer = await runAdapter({ command, timeoutSeconds: 20, request: { identity: 'owner' }, cwd: dir, env: given });

  assert.ok(answer.env.includes('AMBIENT_ONLY'), 'the ambient environment is inherited');
  for (const key of ['SUPABASE_SERVICE_ROLE_KEY', 'AX_DIRECT_URL']) {
    assert.ok(!answer.env.includes(key), `adapter saw ${key}, which AX resolved from an env file`);
  }
  // `__CF_USER_TEXT_ENCODING` and friends are injected by the OS spawn itself,
  // so the assertion is about keys AX could have added, not about an exact set.
  const added = answer.env.filter(key => !['PATH', 'AMBIENT_ONLY'].includes(key) && !key.startsWith('__'));
  assert.deepEqual(added, [], `adapter saw extra environment keys: ${added.join(', ')}`);
});

test('a declared adapter without its own deadline refuses as an incomplete contract', async () => {
  const { dir, command } = adapter(ECHO);
  await assert.rejects(runAdapter({ command, request: {}, cwd: dir }), error => {
    assert.match(error.message, /deadline/);
    assert.match(error.fix, /timeoutSeconds/);
    return true;
  });
});

test('an empty or non-argv command refuses before anything is spawned', async () => {
  const { dir } = adapter(ECHO);
  for (const command of [[], undefined, 'node adapter.mjs', ['']]) {
    await assert.rejects(runAdapter({ command, timeoutSeconds: 5, request: {}, cwd: dir }), error => {
      assert.ok(error.fix);
      return true;
    });
  }
});

test('the deadline kills the adapter and the refusal carries its stderr tail', async () => {
  const { dir, command } = adapter(`
process.stderr.write('supabase reset in progress\\n');
setTimeout(() => {}, 60000);
`);
  const started = Date.now();
  await assert.rejects(runAdapter({ command, timeoutSeconds: 0.4, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.match(error.message, /supabase reset in progress/);
    assert.match(error.message, /0\.4|deadline/);
    assert.ok(error.fix);
    return true;
  });
  assert.ok(Date.now() - started < 20000, 'the deadline did not bound the run');
});

test('a non-zero exit refuses with the adapter\'s own stderr tail', async () => {
  const { dir, command } = adapter(`
process.stderr.write('TOTP secret missing for owner@example.com\\n');
process.exit(3);
`);
  await assert.rejects(runAdapter({ command, timeoutSeconds: 10, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.match(error.message, /TOTP secret missing/);
    assert.match(error.message, /3/);
    assert.ok(error.fix);
    return true;
  });
});

test('a stderr tail that carries a token shape reaches the operator redacted', async () => {
  const { dir, command } = adapter(`
process.stderr.write('failed with eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.Q2hhbmdlTWVOb3c\\n');
process.exit(1);
`);
  await assert.rejects(runAdapter({ command, timeoutSeconds: 10, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.ok(!error.message.includes('eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.Q2hhbmdlTWVOb3c'), error.message);
    return true;
  });
});

test('output beyond the cap refuses instead of being buffered without bound', async () => {
  const { dir, command } = adapter(`
const chunk = 'x'.repeat(1024);
for (let i = 0; i < 200; i += 1) process.stdout.write(chunk);
process.stdout.write(JSON.stringify({ protocol: 1 }));
`);
  await assert.rejects(runAdapter({ command, timeoutSeconds: 15, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.match(error.message, /64|bounded|too much/i);
    assert.ok(error.fix);
    return true;
  });
  assert.equal(MAX_ADAPTER_OUTPUT, 64 * 1024);
});

test('the output cap is 64 KiB of bytes, not of JavaScript characters', async () => {
  const { dir, command } = adapter(`
const chunk = 'é'.repeat(1024);
for (let i = 0; i < 40; i += 1) process.stdout.write(chunk);
process.stdout.write(JSON.stringify({ protocol: 1, ok: true }));
`);
  await assert.rejects(runAdapter({ command, timeoutSeconds: 15, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.match(error.message, /64|bounded|too much/i);
    assert.ok(error.fix);
    return true;
  });
});

test('a deadline kills the process group, including a descendant that holds stdout', async () => {
  const { dir, command } = adapter(`
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.stderr.write('holding stdout through a grandchild\\n');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
writeFileSync('grandchild.pid', String(grandchild.pid));
setTimeout(() => {}, 60000);
`);
  const pidFile = join(dir, 'grandchild.pid');
  const started = Date.now();
  try {
    await assert.rejects(runAdapter({ command, timeoutSeconds: 0.4, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
      assert.match(error.message, /deadline|holding stdout/i);
      assert.ok(error.fix);
      return true;
    });
    assert.ok(Date.now() - started < 8000, 'killing the parent left a descendant holding stdout');
  } finally {
    let pid;
    try {
      pid = Number(readFileSync(pidFile, 'utf8'));
    } catch {
      pid = undefined;
    }
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already reaped by the group kill */
      }
    }
  }
});

test('anything printed beside the one JSON object refuses — stdout is the protocol', async () => {
  const { dir, command } = adapter(`
process.stdout.write('preparing owner...\\n');
process.stdout.write(JSON.stringify({ protocol: 1, ok: true }));
`);
  await assert.rejects(runAdapter({ command, timeoutSeconds: 10, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.match(error.message, /one JSON object/);
    assert.ok(error.fix);
    return true;
  });
});

test('a wrong or missing protocol version refuses rather than being interpreted', async () => {
  for (const answer of ['{"protocol":2,"ok":true}', '{"ok":true}', '[]', '"ok"']) {
    const { dir, command } = adapter(`process.stdout.write(${JSON.stringify(answer)});`);
    await assert.rejects(runAdapter({ command, timeoutSeconds: 10, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
      assert.ok(error.fix, answer);
      return true;
    }, answer);
  }
});

test('a missing binary refuses with a repair instead of an unhandled spawn error', async () => {
  const { dir } = adapter(ECHO);
  await assert.rejects(runAdapter({ command: ['ax-no-such-adapter-binary', 'x'], timeoutSeconds: 10, request: {}, cwd: dir, env: { PATH: process.env.PATH } }), error => {
    assert.ok(error.fix);
    return true;
  });
});
