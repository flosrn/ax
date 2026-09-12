// The PROCESS BOUNDARY around the model probe: what is spawned, what crosses
// ssh, and what every unreadable answer becomes.
//
// The probe's own decisions are proven in omp/model/probe.test.ts against a fake
// facade. Nothing here re-decides a model: these cases are about the boundary,
// because that is where the failures are shaped like silence — a probe that
// printed nothing, a host whose ax has no probe, a remote that landed in the
// wrong directory, and an environment that leaked this machine's HOME into a
// question about another configuration.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { PROBE_PREFIX, SELECTORS_ENV, parseProbe, probeArgs, probeExtensionPath, probeModels } from '../src/worker/model-probe.mjs';

/** A recording exec with a scripted answer, in the shape `run()` returns. */
function execStub(answer = {}) {
  const calls = [];
  const exec = (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    return { status: 0, stdout: '', stderr: '', error: undefined, ...answer };
  };
  return { exec, calls };
}

const probeLine = payload => `${PROBE_PREFIX}${JSON.stringify(payload)}\n`;
const ANSWER = {
  candidates: [{ selector: 'anthropic/claude-sonnet-5:low', model: 'anthropic/claude-sonnet-5', effort: 'low', available: true }],
  errors: [],
};

test('the probe extension this package ships is where the local probe looks for it', () => {
  // The one assertion that would catch a rename or a missing `files` entry: the
  // local probe passes this path to `omp -e`, and a path that does not exist is
  // a session that boots, answers nothing, and exits 0.
  assert.equal(probeExtensionPath().endsWith(`${['omp', 'model', 'probe.ts'].join('/')}`), true);
  assert.equal(existsSync(probeExtensionPath()), true);
});

test('a probe session carries no tools, no discovery and no history', () => {
  const args = probeArgs('/pkg/omp/model/probe.ts');
  for (const flag of ['-p', '--no-session', '--no-extensions', '--no-tools', '--no-lsp', '--no-skills', '--no-rules', '--no-title']) {
    assert.ok(args.includes(flag), `${flag} is part of what makes this read-only`);
  }
  // The explicit extension still loads with discovery off, which is the whole
  // arrangement: the probe, and nothing else this package publishes.
  assert.equal(args[args.indexOf('-e') + 1], '/pkg/omp/model/probe.ts');
});

test('the request travels in the environment, and the environment is the caller’s alone', () => {
  const { exec, calls } = execStub({ stdout: probeLine(ANSWER) });
  const result = probeModels(['@worker-balanced'], { exec, cwd: '/repo', env: { HOME: '/tmp/probe-home', PATH: '/usr/bin' } });

  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, ANSWER.candidates);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'omp');
  assert.equal(calls[0].options.cwd, '/repo');
  // EXACTLY what was passed, plus the request. A merged `process.env` would
  // answer about this machine's configuration while claiming to answer about
  // the injected one.
  assert.deepEqual(calls[0].options.env, {
    HOME: '/tmp/probe-home',
    PATH: '/usr/bin',
    [SELECTORS_ENV]: '["@worker-balanced"]',
  });
  // The selectors are never argv: argv in print mode is the prompt.
  assert.equal(
    calls[0].args.some(arg => arg.includes('@worker-balanced')),
    false,
  );
  assert.ok(Number.isFinite(calls[0].options.timeout) && calls[0].options.timeout > 0, 'a probe that hangs blocks a dispatch nobody can interrupt');
});

test('a request with nothing to prove spawns nothing and refuses in the same envelope', () => {
  const { exec, calls } = execStub();
  for (const selectors of [[], undefined, ['@worker-balanced', ''], ['@worker-balanced', 7]]) {
    const result = probeModels(selectors, { exec });
    assert.equal(result.ok, false);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0], result.reason);
  }
  assert.equal(calls.length, 0);
});

test('the answer is read out of the probe’s own line, whichever stream carried it and whatever else was printed', () => {
  const noise = `warning: something\n${probeLine({ candidates: [], errors: ['first'] })}${probeLine(ANSWER)}trailing\n`;
  const fromStdout = parseProbe({ stdout: noise });
  // The LAST line wins: a warning above the result is not the result, and a
  // first-match read would answer with a line that is not the answer.
  assert.deepEqual(fromStdout, { ok: true, candidates: ANSWER.candidates, errors: [] });
  assert.deepEqual(parseProbe({ stdout: 'nothing here\n', stderr: probeLine(ANSWER) }).candidates, ANSWER.candidates);
});

test('an unreadable or absent answer is a refusal that names the process, not an empty candidate list', () => {
  const malformed = parseProbe({ stdout: `${PROBE_PREFIX}{not json}\n` });
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /cannot read/);

  const wrongShape = parseProbe({ stdout: probeLine({ candidates: 'all of them' }) });
  assert.equal(wrongShape.ok, false);
  assert.match(wrongShape.reason, /\{candidates,errors\} was expected/);

  assert.match(parseProbe({}).reason, /printed no AX_MODEL_PROBE= line/);

  const { exec } = execStub({ status: 1, stdout: 'Error: model catalog unavailable\nsecond line\n' });
  const silent = probeModels(['@worker-balanced'], { exec, env: {} });
  assert.equal(silent.ok, false);
  assert.deepEqual(silent.candidates, []);
  assert.equal(silent.errors[0], silent.reason);
  assert.match(silent.reason, /printed no AX_MODEL_PROBE= line/);
  assert.match(silent.reason, /exit 1/);
  // One bounded line of the real output, so the refusal is diagnosable.
  assert.match(silent.reason, /model catalog unavailable/);
  assert.equal(silent.reason.includes('second line'), false);
});

test('a complete answer is an answer even when the host called the exit a failure', () => {
  // The probe exits from inside `session_start`; a host is free to read that as
  // a failed start. The line is the contract, not the status.
  const { exec } = execStub({ status: 1, stdout: probeLine(ANSWER) });
  const result = probeModels(['@worker-balanced'], { exec, env: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, ANSWER.candidates);
});

test('a probe that could not be spawned at all names the failure', () => {
  const { exec } = execStub({ status: null, error: new Error('spawn omp ENOENT') });
  const result = probeModels(['@worker-balanced'], { exec, env: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /spawn omp ENOENT/);
});

const HOST = { ssh: 'orca@vps', sessions: '/home/orca/.omp/agent/sessions' };

test('a remote probe crosses ssh as data, and derives the probe from the host’s own install', () => {
  const { exec, calls } = execStub({ stdout: probeLine(ANSWER) });
  const result = probeModels(['@worker-balanced:high'], { exec, cwd: '/repo', host: HOST, remotePath: '/srv/orca/acme' });

  assert.equal(result.ok, true);
  assert.equal(result.where, 'orca@vps:/srv/orca/acme');
  assert.equal(calls[0].bin, 'ssh');
  const [dashO, batch, terminator, target, command] = calls[0].args;
  assert.deepEqual([dashO, batch, terminator, target], ['-o', 'BatchMode=yes', '--', 'orca@vps']);
  // Derived THERE: the local path names nothing on another machine, and sending
  // it would probe a file that does not exist.
  assert.equal(command.includes(probeExtensionPath()), false);
  assert.match(command, /AX_PROBE="\$AX_ROOT\/omp\/model\/probe\.ts"/);
  assert.match(command, /command -v omp/);
  // The checkout is entered first, so project-scoped model roles are what gets read.
  assert.ok(command.includes('/srv/orca/acme'), 'the named checkout is entered');
  assert.ok(command.includes('@worker-balanced:high'), 'the request travels in the remote environment');
  assert.ok(command.startsWith('bash -lc '), 'one quoted remote command, never interpolated argv');
});

test('a remote probe with no checkout is refused rather than answered from the login directory', () => {
  const { exec, calls } = execStub({ stdout: probeLine(ANSWER) });
  for (const remotePath of [undefined, null, '   ']) {
    const result = probeModels(['@worker-balanced'], { exec, host: HOST, remotePath });
    assert.equal(result.ok, false);
    assert.deepEqual(result.candidates, []);
    // The weaker answer — that host's user-level roles — must never be
    // presented as the project's candidate list.
    assert.match(result.reason, /user-level model roles rather than the project's/);
  }
  assert.equal(calls.length, 0, 'nothing is spawned for a question that cannot be asked');
});

test('a host with no ssh target is refused before any transport is attempted', () => {
  const { exec, calls } = execStub();
  const result = probeModels(['@worker-balanced'], { exec, host: { sessions: '/x' }, remotePath: '/srv/orca/acme' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /declares no ssh target/);
  assert.equal(calls.length, 0);
});

test('a target that cannot answer is explicitly unavailable, never an invented candidate list', () => {
  const cases = [
    [95, /could not be entered on orca@vps/],
    [97, /ships no model probe/],
    [96, /has no omp on its PATH/],
  ];
  for (const [status, expected] of cases) {
    const { exec } = execStub({ status });
    const result = probeModels(['@worker-balanced'], { exec, host: HOST, remotePath: '/srv/orca/acme' });
    assert.equal(result.ok, false);
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.errors[0], result.reason);
    assert.match(result.reason, expected);
  }
});

test('an ssh target ssh would read as a local option never reaches ssh', () => {
  const { exec, calls } = execStub({ stdout: probeLine(ANSWER) });
  const result = probeModels(['@worker-balanced'], { exec, host: { ssh: '-oProxyCommand=touch /tmp/pwned' }, remotePath: '/srv/orca/acme' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /is not a host name/);
  assert.equal(calls.length, 0);
});

test('the target’s own refusals are carried through, candidates and errors together', () => {
  const answer = {
    candidates: [
      { selector: 'anthropic/claude-sonnet-5:low', model: 'anthropic/claude-sonnet-5', effort: 'low', available: true },
      {
        selector: 'deepseek/deepseek-v4:medium',
        model: 'deepseek/deepseek-v4',
        effort: 'medium',
        available: false,
        reason: "'deepseek/deepseek-v4' does not support effort 'medium' (it declares high, max) and maps no alias for it — refused rather than clamped",
      },
    ],
    errors: ["'@worker-intensive' is not a model role this host configures"],
  };
  const { exec } = execStub({ stdout: probeLine(answer) });
  const result = probeModels(['@worker-balanced', '@worker-intensive'], { exec, env: {} });
  assert.equal(result.ok, true);
  // Order is the preference, and an unavailable candidate is reported rather
  // than dropped: the caller decides, with the reason in hand.
  assert.deepEqual(result.candidates, answer.candidates);
  assert.deepEqual(result.errors, answer.errors);
});
