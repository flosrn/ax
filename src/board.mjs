// `ax board` — the ONE writer of a worktree's sidebar checkpoint.
//
// Orca keeps a per-worktree `comment` + `workspaceStatus`, surfaced in the
// sidebar. Measured 2026-08-02 on this machine: 0 comments across 37 worktrees,
// all stuck at Orca's `in-progress` default — hand-written checkpoints are a
// discipline-shaped signal, and those go silent exactly when it matters. So the
// writers are automatic (OMP extensions on todo flips and PR transitions), and
// they all funnel HERE. Before the port the monotonicity rule lived in three
// files (orca-checkpoint.ts, orca-peer/registry.ts, and the bash orchestrator).
//
// Monotonicity is read-then-write, and Orca's `worktree set` has no conditional
// form — so without a lock two concurrent writers can interleave and a delayed
// `in-review` can land after a `completed` (the bash version had exactly this
// race). Same-host writers are therefore SERIALISED by a per-worktree lock
// around the read→write window. The honest bound: writers on ANOTHER host are
// not covered — unchanged from before, and the writer population is hooks of
// sessions inside the worktree, which live on its host.
//
// This verb is FAIL-OPEN by design, unlike every other Orca-facing verb: it is
// called from hooks, and a typo in a hook must not take the hook down with it.
// Bad usage says so and exits 0. Orca missing, unreachable, a stale selector —
// all normal, all exit 0. The one thing fail-open never buys is a LYING board:
// when the lock cannot be acquired the checkpoint is SKIPPED with a visible
// warning, never written unserialised. (ADR 0003: exit codes are per-verb.)
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createRunner, resolveOrca, runtimeReady } from './orca-bin.mjs';
import { note, warn } from './log.mjs';

/** Board ranks. A custom column is legal in Orca: unknown ids rank -1 and are forwarded. */
const RANK = { todo: 0, 'in-progress': 1, 'in-review': 2, completed: 3 };

/** One sidebar line: newlines and tabs flattened, runs of spaces collapsed, capped at 160. */
export function flattenComment(text) {
  const flat = String(text)
    .replace(/[\n\r\t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

const lockDir = env => env.AX_LOCK_DIR || join(env.HOME ?? '', '.omp', 'run', 'ax-locks');

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Serialise same-host writers of one worktree. `mkdir` is the atomic claim; a
 * lock older than `staleMs` is a crashed writer and is broken; a lock that
 * cannot be acquired within `waitMs` yields `held: false` — and the caller then
 * SKIPS the write loudly rather than racing it.
 */
function acquireLock(selector, env, { waitMs = Number(env.AX_LOCK_WAIT_MS ?? 2000), staleMs = Number(env.AX_LOCK_STALE_MS ?? 10000) } = {}) {
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `board-${createHash('sha256').update(selector).digest('hex').slice(0, 16)}.lock`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(path);
      return { held: true, release: () => rmSync(path, { recursive: true, force: true }) };
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // the holder released between our attempt and the stat — retry now
      }
      sleep(50);
    }
  }
  return { held: false, release: () => {} };
}

/** The worktree record out of a `worktree show` receipt — lenient: this verb never refuses. */
const shownWorktree = out => (out.status === 0 ? ((out.receipt.result ?? {}).worktree ?? out.receipt.result ?? null) : null);

export function board(argv = [], { resolve = resolveOrca, runner, env = process.env } = {}) {
  let selector = '';
  let comment = '';
  let status = '';
  let ifEmpty = false;
  let verbose = false;

  const say = message => {
    if (verbose) note(message);
  };
  // A caller bug is worth a message even without --verbose — but never a
  // non-zero exit: this runs from hooks.
  const bail = message => {
    warn(`ax board: ${message}`);
    return 0;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--if-empty') ifEmpty = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--worktree' || arg === '--comment' || arg === '--status') {
      i += 1;
      const value = argv[i];
      if (value === undefined) return bail(`${arg} needs a value`);
      if (arg === '--worktree') selector = value;
      else if (arg === '--comment') comment = value;
      else status = value;
    } else return bail(`unknown argument: ${arg}`);
  }

  if (!comment && !status) return bail('nothing to do: pass --comment and/or --status');
  if (status && !(status in RANK)) say(`status '${status}' is not a default board id; forwarding as a custom column`);

  const bin = runner ? 'injected' : resolve();
  if (!bin) {
    say('orca CLI not found — skipping');
    return 0;
  }
  const run = runner ?? createRunner({ bin });

  // The execution gate of the socle, uniformly: is the runtime ANSWERING? For
  // this fail-open verb an unreachable runtime is NORMAL (Orca not running is
  // an ordinary hook condition), so the answer is a said skip, never a refusal
  // — and it is probed BEFORE the lock, so a doomed write never holds it.
  const ready = runtimeReady(run);
  if (!ready.ready) {
    say(`${ready.reason} — skipping`);
    return 0;
  }

  // `current` resolves from cwd — what an agent calling this by hand wants.
  // Callers that already know the worktree (a setup hook, an orchestrator) pass
  // --worktree and are honoured verbatim: `current` would silently answer for
  // whatever directory the hook happens to run in.
  if (!selector) selector = 'current';
  if (comment) comment = flattenComment(comment);

  // No lock, no write: an unserialised read→set is exactly the backwards-write
  // race the lock exists to close, and a LOST checkpoint is cheaper than a
  // LYING board — the next todo flip rewrites it anyway. Announced via warn
  // (always visible, hooks included); a crashed holder is broken after 10s, so
  // starvation is bounded and a simple re-run repairs.
  const lock = acquireLock(selector, env);
  if (!lock.held) {
    warn(`ax board: lock for ${selector} not acquired within 2s — checkpoint SKIPPED; re-run ax board (a stale lock breaks after 10s)`);
    return 0;
  }
  try {
    // ONE read serves both guards, inside the lock so no concurrent same-host
    // writer can move the board between this read and the write below.
    const needsRead = (ifEmpty && comment) || (status && status in RANK);
    const shown = needsRead ? shownWorktree(run(['worktree', 'show', '--worktree', selector, '--json'])) : null;

    // --if-empty exists for one interlock: seeding at creation must not clobber
    // a richer comment already written by `worktree create --comment` or
    // `worker-start --comment`. It fails CLOSED: "I could not read the current
    // comment" is never read as "there isn't one" — that is precisely when the
    // overwrite does damage. The status is never guarded; moving it is always
    // the caller's intent.
    if (ifEmpty && comment) {
      if (shown === null) {
        say('cannot read the current comment — not overwriting');
        comment = '';
      } else if ((shown.comment ?? '') !== '') {
        say(`comment already set (${String(shown.comment).slice(0, 60)}) — keeping it`);
        comment = '';
      }
      if (!comment && !status) return 0;
    }

    // Monotonic status lives HERE, not in the callers: a caller can only latch
    // what it has itself observed. Unknown ids are not ranked and pass through;
    // an unreadable current status also passes through, because refusing to
    // move a status we cannot compare would strand a real transition.
    if (status && status in RANK) {
      const current = shown === null ? '' : (shown.workspaceStatus ?? '');
      if (current !== '' && (RANK[current] ?? -1) >= RANK[status]) {
        say(`status '${current}' already at or beyond '${status}' — not moving it backwards`);
        status = '';
        if (!comment) return 0;
      }
    }

    const args = ['worktree', 'set', '--worktree', selector];
    if (comment) args.push('--comment', comment);
    if (status) args.push('--workspace-status', status);
    args.push('--json');

    const out = run(args);
    if (out.status === 0) say(`checkpoint written: ${status ? `[${status}] ` : ''}${comment || '<status only>'}`);
    else say(`orca worktree set failed (non-fatal): ${String(out.stderr || out.stdout).slice(0, 200)}`);
    return 0;
  } finally {
    lock.release();
  }
}
