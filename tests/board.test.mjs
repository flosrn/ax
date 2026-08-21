// `ax board` — the one writer of the sidebar checkpoint. The unit matrix ports
// the propositions of orca-checkpoint.test.ts; the race test proves the one
// thing the bash version never had: two same-host writers cannot move the
// board backwards. Real processes, real lock directory, a real stub orca.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { board, flattenComment } from '../src/board.mjs';
import { visibleCommands } from '../src/commands.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'ax.mjs');

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-board-'));

/** Fast lock timings + isolated lock dir for every unit call. */
const fastEnv = () => ({ HOME: scratch(), AX_LOCK_DIR: scratch(), AX_LOCK_WAIT_MS: '150', AX_LOCK_STALE_MS: '400' });

/**
 * A runner that answers `status` ready, `worktree show` from `worktree`, and
 * records every call. `failShow` simulates an unreadable current state.
 */
function fakeRunner({ worktree = {}, failShow = false, ready = true } = {}) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'status') {
      return ready
        ? { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { runtime: { reachable: true } } } }
        : { status: 1, stdout: '', stderr: 'not running', receipt: { unparseable: 'not running', error: 'x' } };
    }
    if (args[1] === 'show') {
      return failShow
        ? { status: 1, stdout: '', stderr: 'boom', receipt: { unparseable: 'boom', error: 'x' } }
        : { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: { worktree } } };
    }
    return { status: 0, stdout: '', stderr: '', receipt: { ok: true, result: {} } };
  };
  run.calls = calls;
  run.sets = () => calls.filter(args => args[1] === 'set');
  return run;
}

test('bad usage exits 0 without touching orca — a typo in a hook must not kill the hook', () => {
  const run = fakeRunner();
  assert.equal(board(['--bogus'], { runner: run, env: fastEnv() }), 0);
  assert.equal(board(['--status'], { runner: run, env: fastEnv() }), 0, 'a flag without a value bails politely');
  assert.equal(board([], { runner: run, env: fastEnv() }), 0, 'nothing to do is not an error');
  assert.equal(run.calls.length, 0);
});

test('no orca on the machine is a skip, exit 0', () => {
  assert.equal(board(['--comment', 'x'], { resolve: () => null, env: fastEnv() }), 0);
});

test('an unreachable runtime is a said skip, probed before the lock and the write', () => {
  const run = fakeRunner({ ready: false });
  assert.equal(board(['--comment', 'x'], { runner: run, env: fastEnv() }), 0);
  assert.deepEqual(run.calls, [['status', '--json']], 'nothing after the probe');
});

test('defaults to the current worktree; an explicit selector is honoured verbatim', () => {
  const run = fakeRunner();
  board(['--comment', 'hello'], { runner: run, env: fastEnv() });
  assert.deepEqual(run.sets()[0], ['worktree', 'set', '--worktree', 'current', '--comment', 'hello', '--json']);

  const explicit = fakeRunner();
  board(['--comment', 'hello', '--worktree', 'path:/x/y'], { runner: explicit, env: fastEnv() });
  assert.equal(explicit.sets()[0][3], 'path:/x/y');
});

test('a multi-line comment is flattened to one sidebar line and capped at 160', () => {
  const run = fakeRunner();
  board(['--comment', 'a\nb\tc   d'], { runner: run, env: fastEnv() });
  assert.equal(run.sets()[0][5], 'a b c d');
  assert.equal(flattenComment('x'.repeat(200)).length, 160);
  assert.match(flattenComment('x'.repeat(200)), /\.\.\.$/);
});

test('a forward status move passes; backwards and reaffirmation are dropped', () => {
  const forward = fakeRunner({ worktree: { workspaceStatus: 'in-progress' } });
  board(['--status', 'in-review'], { runner: forward, env: fastEnv() });
  assert.equal(forward.sets().length, 1);

  const backwards = fakeRunner({ worktree: { workspaceStatus: 'in-review' } });
  board(['--status', 'in-progress'], { runner: backwards, env: fastEnv() });
  assert.equal(backwards.sets().length, 0, 'in-review is never demoted');

  const same = fakeRunner({ worktree: { workspaceStatus: 'in-review' } });
  board(['--status', 'in-review'], { runner: same, env: fastEnv() });
  assert.equal(same.sets().length, 0, 'reaffirming the present status writes nothing');
});

test('an unreadable current status passes the move through — never strands a real transition', () => {
  const run = fakeRunner({ failShow: true });
  board(['--status', 'in-review'], { runner: run, env: fastEnv() });
  assert.equal(run.sets().length, 1);
});

test('a custom board column is forwarded without a ranking read', () => {
  const run = fakeRunner();
  board(['--status', 'parked'], { runner: run, env: fastEnv() });
  const calls = run.calls.filter(args => args[0] === 'worktree');
  assert.equal(calls.length, 1, 'no show — nothing to rank');
  assert.deepEqual(calls[0], ['worktree', 'set', '--worktree', 'current', '--workspace-status', 'parked', '--json']);
});

test('--if-empty protects an existing comment, writes over emptiness, and fails CLOSED', () => {
  const kept = fakeRunner({ worktree: { comment: 'richer, written at creation' } });
  board(['--comment', 'seed', '--if-empty'], { runner: kept, env: fastEnv() });
  assert.equal(kept.sets().length, 0);

  const empty = fakeRunner({ worktree: { comment: '' } });
  board(['--comment', 'seed', '--if-empty'], { runner: empty, env: fastEnv() });
  assert.equal(empty.sets()[0][5], 'seed');

  // Unreadable current comment: the overwrite is exactly where damage happens,
  // so the comment is dropped — the status still goes through.
  const closed = fakeRunner({ failShow: true });
  board(['--comment', 'seed', '--if-empty', '--status', 'in-review'], { runner: closed, env: fastEnv() });
  const set = closed.sets()[0];
  assert.ok(!set.includes('--comment'));
  assert.ok(set.includes('--workspace-status'));
});

test('a held lock skips the checkpoint instead of racing it, and a stale lock is broken', () => {
  const env = fastEnv();
  const run = fakeRunner();
  // Hold the lock exactly where the module computes it, for the default
  // 'current' selector.
  const held = join(env.AX_LOCK_DIR, `board-${createHash('sha256').update('current').digest('hex').slice(0, 16)}.lock`);
  mkdirSync(held, { recursive: true });

  assert.equal(board(['--comment', 'x'], { runner: run, env }), 0);
  assert.equal(run.sets().length, 0, 'no write without the lock');

  // Age the lock beyond AX_LOCK_STALE_MS: the next writer breaks it and writes.
  const old = (Date.now() - 5000) / 1000;
  utimesSync(held, old, old);
  const after = fakeRunner();
  board(['--comment', 'x'], { runner: after, env });
  assert.equal(after.sets().length, 1, 'a crashed holder does not starve the board');
});


test('gated out: a machine without orca answers unknown command and hides board from the help', () => {
  const env = { PATH: '/nonexistent', HOME: scratch() };
  const help = execFileSync(process.execPath, [CLI], { encoding: 'utf8', env });
  assert.doesNotMatch(help, /^  board\b/m);

  const out = (() => {
    try {
      execFileSync(process.execPath, [CLI, 'board', '--comment', 'x'], { encoding: 'utf8', env, stdio: 'pipe' });
      return { status: 0, text: '' };
    } catch (error) {
      return { status: error.status, text: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  })();
  assert.equal(out.status, 2);
  assert.match(out.text, /unknown command "board"/);
});

test('visibleCommands applies the gate after the full table — both states, injectable', () => {
  const withOrca = visibleCommands({ orca: true }).map(command => command.name);
  const without = visibleCommands({ orca: false }).map(command => command.name);
  assert.ok(withOrca.includes('board'));
  assert.ok(!without.includes('board'));
  assert.deepEqual(
    withOrca.filter(name => name !== 'board'),
    without,
    'the gate removes gated entries and nothing else',
  );
});

/** A stateful stub orca: `show` answers after a delay, `set` persists the status. */
function writeStubOrca(dir) {
  const stub = join(dir, 'orca');
  writeFileSync(
    stub,
    `#!/bin/bash
STATE="$AX_TEST_STATE"
if [ "$1" = status ]; then
  printf '{"ok":true,"result":{"runtime":{"reachable":true}}}'
elif [ "$1" = worktree ] && [ "$2" = show ]; then
  # Snapshot BEFORE the delay: a reader that raced the other writer must
  # return what it saw at read time, or this test cannot catch a removed lock.
  SNAP="$(cat "$STATE")"
  sleep 0.4
  printf '{"ok":true,"result":{"worktree":{"comment":"","workspaceStatus":"%s"}}}' "$SNAP"
elif [ "$1" = worktree ] && [ "$2" = set ]; then
  status=""
  prev=""
  for arg in "$@"; do
    [ "$prev" = --workspace-status ] && status="$arg"
    prev="$arg"
  done
  [ -n "$status" ] && printf '%s' "$status" > "$STATE"
  printf '{"ok":true,"result":{}}'
fi
`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

test('race: two concurrent same-host writers cannot move the board backwards', async () => {
  const dir = scratch();
  const state = join(dir, 'state');
  writeFileSync(state, 'in-progress');
  writeStubOrca(dir);

  const env = {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: dir,
    AX_LOCK_DIR: join(dir, 'locks'),
    AX_TEST_STATE: state,
  };
  const spawnBoard = status =>
    new Promise(resolve => {
      execFile(process.execPath, [CLI, 'board', '--status', status], { env }, (_error, stdout, stderr) => resolve({ stdout, stderr }));
    });

  // Without the lock, the second writer reads `in-progress` during the first
  // writer's show window and its later `in-review` write regresses a board
  // already at `completed`. With the lock the writes serialise and the second
  // one is dropped by the monotonic guard.
  const first = spawnBoard('completed');
  await new Promise(resolve => setTimeout(resolve, 120));
  const second = spawnBoard('in-review');
  await Promise.all([first, second]);

  assert.equal(readFileSync(state, 'utf8'), 'completed', 'the board never moved backwards');
});
