// `ax worktree panes <name> [--close <handle>…]` (src/worktree/panes.mjs): the
// panes that keep a worktree from being reclaimed, and closing exactly the ones
// the operator names. Real git repositories; Orca is the injected runner.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { panes } from '../src/worktree/panes.mjs';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'ignore' });

const fixtures = [];
after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function capture(fn) {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('').replace(/\u001B\[\d+m/g, '') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** A primary checkout and one linked worktree that no dispatch created. */
function stage() {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ax-panes-')));
  fixtures.push(fixture);
  const main = join(fixture, 'main');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  mkdirSync(dirname(join(main, 'a.txt')), { recursive: true });
  writeFileSync(join(main, 'a.txt'), 'x\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');
  const path = join(fixture, 'enterprise-pro-parity');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/parity', path);
  return { fixture, main, path };
}

const receiptOf = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '', error: undefined, receipt: value });

/**
 * The Orca runtime this verb reads: `terminals` are the panes of the queried
 * scope, each naming its own worktree. `stubborn` handles survive a close.
 */
function orca(s, { terminals = [], truncated = false, stubborn = [], closeFails = [] } = {}) {
  const calls = [];
  let live = terminals.map(pane => ({ worktreeId: `repo::${s.path}`, worktreePath: s.path, orphaned: false, ...pane }));
  const runner = args => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (key === 'status --json') return receiptOf({ ok: true, result: { runtime: { reachable: true } } });
    if (key === 'worktree show') {
      const selector = args[args.indexOf('--worktree') + 1];
      if (selector !== `path:${s.path}`) return { status: 1, stdout: '', stderr: 'no worktree', error: undefined, receipt: { ok: false } };
      return receiptOf({ ok: true, result: { worktree: { id: `repo::${s.path}`, path: s.path, hostId: 'local', isPinned: false, childWorktreeIds: [] } } });
    }
    if (key === 'terminal list') return receiptOf({ ok: true, result: { terminals: live, truncated, hostScope: { hostIds: ['local'], omittedHostIds: [] } } });
    if (key === 'terminal close') {
      const handle = args[args.indexOf('--terminal') + 1];
      if (closeFails.includes(handle)) return { status: 1, stdout: '', stderr: 'pty refused', error: undefined, receipt: { ok: false, error: { message: 'pty refused' } } };
      if (!stubborn.includes(handle)) live = live.filter(pane => pane.handle !== handle);
      return receiptOf({ ok: true, result: { close: { handle, ptyKilled: true } } });
    }
    return { status: 1, stdout: '', stderr: `unexpected orca call: ${args.join(' ')}`, error: undefined, receipt: {} };
  };
  return { runner, closes: () => calls.filter(args => args[0] === 'terminal' && args[1] === 'close').map(args => args[args.indexOf('--terminal') + 1]) };
}

function deps(s, world) {
  const built = orca(s, world);
  return {
    ...built,
    deps: { cwd: s.main, env: { HOME: s.fixture, PATH: process.env.PATH ?? '' }, resolve: () => 'orca', runner: built.runner },
  };
}

const TWO = s => [
  { handle: 'term_shell', title: 'Terminal 1', agentIdentity: null, lastOutputAt: '2026-10-04T09:00:00.000Z' },
  { handle: 'term_setup', title: 'Setup', agentIdentity: null, lastOutputAt: '2026-10-04T08:59:00.000Z' },
  // Another worktree's pane: never this verb's to list or close.
  { handle: 'term_elsewhere', title: 'Terminal 1', worktreeId: 'repo::/elsewhere', worktreePath: join(s.fixture, 'elsewhere') },
];

test('lists the panes holding a worktree no dispatch created, and prints the close naming exactly those handles', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const { code, out } = capture(() => panes(['enterprise-pro-parity'], d));

  assert.equal(code, 0, out);
  assert.match(out, /term_shell "Terminal 1"/);
  assert.match(out, /term_setup "Setup"/);
  assert.doesNotMatch(out, /term_elsewhere/);
  assert.match(out, /ax worktree panes enterprise-pro-parity --close term_shell term_setup/);
  assert.deepEqual(closes(), [], 'a listing closes nothing');
});

test('--close closes exactly the named panes, proves them gone, and names reclaim as the next step', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell', 'term_setup'], d));

  assert.equal(code, 0, out);
  assert.deepEqual(closes(), ['term_shell', 'term_setup']);
  assert.match(out, /ax worktree reclaim enterprise-pro-parity/);
});

test('a handle that is not one of this worktree’s panes refuses before any pane is closed', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell', 'term_elsewhere'], d));

  assert.equal(code, 1, out);
  assert.match(out, /term_elsewhere/);
  assert.deepEqual(closes(), [], 'one foreign handle closes nothing, not even the valid one');
});

test('--close without a handle is a usage error, never a sweep of whatever is open', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const { code } = capture(() => panes(['enterprise-pro-parity', '--close'], d));

  assert.equal(code, 2);
  assert.deepEqual(closes(), []);
});

test('a pane list it cannot read in full closes nothing and says so', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s), truncated: true });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell'], d));

  assert.equal(code, 3, out);
  assert.match(out, /TRUNCATED/);
  assert.deepEqual(closes(), []);
});

test('a pane still listed after its close is reported, never counted as closed', () => {
  const s = stage();
  const { deps: d } = deps(s, { terminals: TWO(s), stubborn: ['term_setup'] });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell', 'term_setup'], d));

  assert.equal(code, 3, out);
  assert.match(out, /term_setup is still listed/);
  assert.doesNotMatch(out, /ax worktree reclaim enterprise-pro-parity/);
});

test('a close Orca refuses is named, and the panes after it are still attempted', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s), closeFails: ['term_shell'] });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell', 'term_setup'], d));

  assert.equal(code, 3, out);
  assert.match(out, /term_shell.*pty refused/);
  assert.deepEqual(closes(), ['term_shell', 'term_setup']);
});

test('closing from inside the target refuses: the pane running this command is one of them', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell'], { ...d, cwd: s.path }));

  assert.equal(code, 1, out);
  assert.deepEqual(closes(), []);
});

test('naming the pane this command runs in refuses, and the listing never offers it to close', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });
  const self = { ...d, env: { ...d.env, ORCA_TERMINAL_HANDLE: 'term_shell' } };

  const closing = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell', 'term_setup'], self));
  assert.equal(closing.code, 1, closing.out);
  assert.match(closing.out, /term_shell is the pane running this command/);
  assert.deepEqual(closes(), [], 'refused before anything is closed');

  const listing = capture(() => panes(['enterprise-pro-parity'], self));
  assert.equal(listing.code, 0, listing.out);
  assert.match(listing.out, /--close term_setup\b/);
  assert.doesNotMatch(listing.out, /--close[^\n]*term_shell/);
});

test('the primary checkout is never a target, listed or closed', () => {
  const s = stage();
  const { deps: d, closes } = deps(s, { terminals: [{ handle: 'term_main', worktreeId: 'repo::main', worktreePath: s.main }] });
  const outside = { ...d, cwd: s.path };

  for (const argv of [['main'], ['main', '--close', 'term_main']]) {
    const { code, out } = capture(() => panes(argv, outside));
    assert.equal(code, 1, out);
    assert.match(out, /primary checkout/);
  }
  assert.deepEqual(closes(), []);
});

/** A dispatch record whose worker-start bound `handle` as its agent pane. */
function recordWorker(s, request, handle) {
  const store = join(s.fixture, '.omp', 'run', 'dispatch');
  mkdirSync(store, { recursive: true });
  const result = { dispatchId: `ctx_${request}`, state: 'ready', effects: [{ kind: 'terminal', id: handle, role: 'agent' }] };
  const phase = { name: 'worker-start', identity: 'id', argv: ['orchestration', 'dispatch', '--worktree', s.path], receipt: { ok: true, result }, exit: 0 };
  writeFileSync(join(store, `${request}.json`), JSON.stringify({ request, host: 'h', orca: 'orca', createdAt: '2026-10-04T08:00:00.000Z', attempts: [{ n: 1, settled: false, phases: [phase] }] }));
  return store;
}

test('a pane a dispatch record binds is closed through ax worker close, never here', () => {
  const s = stage();
  recordWorker(s, 'fix-parity', 'term_shell');
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const closing = capture(() => panes(['enterprise-pro-parity', '--close', 'term_shell', 'term_setup'], d));
  assert.equal(closing.code, 1, closing.out);
  assert.match(closing.out, /term_shell is the agent pane of dispatch record fix-parity/);
  assert.match(closing.out, /ax worker close term_shell/);
  assert.deepEqual(closes(), [], 'one recorded pane closes nothing, not even the unrecorded one');

  const listing = capture(() => panes(['enterprise-pro-parity'], d));
  assert.equal(listing.code, 0, listing.out);
  assert.match(listing.out, /term_shell .*dispatch fix-parity — ax worker close term_shell/);
  assert.match(listing.out, /--close term_setup\b/);
  assert.doesNotMatch(listing.out, /--close[^\n]*term_shell/);
});

test('a dispatch store it cannot read in full closes nothing: an unread record may bind the pane', () => {
  const s = stage();
  const store = recordWorker(s, 'fix-parity', 'term_elsewhere');
  writeFileSync(join(store, 'torn.json'), '{"request":');
  const { deps: d, closes } = deps(s, { terminals: TWO(s) });

  const { code, out } = capture(() => panes(['enterprise-pro-parity', '--close', 'term_setup'], d));
  assert.equal(code, 3, out);
  assert.match(out, /torn\.json/);
  assert.deepEqual(closes(), []);
});
