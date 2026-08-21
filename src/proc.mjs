// Finding, and killing, the processes a worktree left behind — by their cwd.
//
// The command line is not a usable identifier for these. `next dev` workers
// retitle themselves to "next-server (vX.Y.Z)" (process.title overwrites argv),
// erasing the worktree path, and once their pnpm parent exits they reparent
// with a fresh process group, so neither the argv nor the tree leads back to the
// worktree. Language servers are the same shape and each pin gigabytes of heap.
//
// A process's cwd stays truthful, so match on that. The lookup is platform-split
// because Linux exposes cwd through /proc and macOS only through lsof; both
// branches produce the same `{ pid, comm }` records, so the reaper is written
// once.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

// There is deliberately no built-in list of spared command names. The shell
// version hardcoded one (shells, pagers, editors, agent CLIs), which is project
// policy living in a library: it silently overrode the caller's own `pattern`,
// and it could only ever be wrong for the next project. Two mechanisms cover
// what it was for — the caller's process group is always skipped, which spares
// the shell the cleanup was launched from, and `pattern` says what to signal.

const basename = path => path.slice(path.lastIndexOf('/') + 1);

/** Strip the marker the kernel appends once the target has been unlinked. */
const undeleted = path => path.replace(/ \(deleted\)$/, '');

/**
 * Best available name for a Linux pid: the executable, then argv[0], then comm.
 *
 * comm is last because the kernel truncates it to 15 bytes, which turns
 * `next-server` and `node` into the same useless prefix for pattern matching.
 */
function commandName(pidDir) {
  try {
    const exe = undeleted(readlinkSync(`${pidDir}/exe`));
    if (exe !== '') return basename(exe);
  } catch {
    // Not readable without matching credentials; fall through.
  }
  try {
    const argv0 = readFileSync(`${pidDir}/cmdline`, 'utf8').split('\0')[0];
    if (argv0) return basename(argv0);
  } catch {
    // Zombie or vanished; fall through.
  }
  try {
    return readFileSync(`${pidDir}/comm`, 'utf8').trim() || '?';
  } catch {
    return '?';
  }
}

const withinPath = (candidate, root) => candidate === root || candidate.startsWith(root + sep);

/**
 * Every process whose cwd is inside `worktreePath`, as `[{ pid, comm }]`.
 *
 * Sorted by pid, deduplicated, and never including this process — the caller is
 * usually running from inside the worktree it is tearing down.
 *
 * The path is symlink-resolved first: /proc and lsof both report PHYSICAL paths,
 * so a caller passing a path through a symlinked parent (`/var` → `/private/var`
 * on macOS, which is where `os.tmpdir()` lives) matches nothing at all, silently.
 */
export function procsByCwd(worktreePath) {
  if (!worktreePath) return [];
  let root;
  try {
    if (!statSync(worktreePath).isDirectory()) return [];
    root = realpathSync(worktreePath);
  } catch {
    return [];
  }

  const found = new Map();
  for (const { pid, comm } of existsSync('/proc') ? scanProc(root) : scanLsof(root)) {
    if (pid !== process.pid) found.set(pid, comm);
  }
  return [...found.entries()].sort(([a], [b]) => a - b).map(([pid, comm]) => ({ pid, comm }));
}

function* scanProc(root) {
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pidDir = `/proc/${name}`;
    let cwd;
    try {
      cwd = undeleted(readlinkSync(`${pidDir}/cwd`));
    } catch {
      continue; // exited mid-scan, or owned by another user
    }
    if (!withinPath(cwd, root)) continue;
    yield { pid: Number(name), comm: commandName(pidDir) };
  }
}

function* scanLsof(root) {
  // One pass over every process's cwd descriptor, filtered here rather than with
  // lsof's `+D`: `+D` walks the whole worktree tree and costs roughly 25x more
  // on a monorepo checkout.
  //
  // A non-zero exit is expected, not a failure: lsof reports it whenever a pid
  // vanishes mid-scan, which is the normal case during a teardown that is itself
  // killing processes. The stdout collected before that is still complete.
  const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpcn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (typeof result.stdout !== 'string') return; // lsof absent

  let pid;
  let comm = '?';
  for (const line of result.stdout.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) {
      pid = Number(value);
      comm = '?';
    } else if (line.startsWith('c')) comm = value;
    else if (line.startsWith('n') && pid !== undefined && withinPath(value, root)) yield { pid, comm };
  }
}

/**
 * Process group id of a pid, or `undefined` when it has exited.
 *
 * Read from /proc where available and from `ps` otherwise, rather than through
 * procps: a host without it would answer empty for every pid, which the reaper
 * reads as "already exited" — a reaper that spares every victim and reports
 * success.
 */
export function pgidOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 is the command, parenthesised and free to contain spaces and
    // parentheses, so split after the LAST ')'. Then: state, ppid, pgid.
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    const pgid = Number(fields[2]);
    return Number.isInteger(pgid) ? pgid : undefined;
  } catch {
    // Not Linux, or the pid is gone. `ps` distinguishes the two.
  }
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pgid = Number((result.stdout ?? '').trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
}

/**
 * Signal the worktree's leftover processes, and report what was signalled.
 *
 * The caller's own process group is skipped, which is the entire reason `pgidOf`
 * exists: cleanup runs from inside the worktree it is tearing down, so it
 * matches itself, and a reaper that kills its own group dies halfway through —
 * after the dev servers, before the database stack.
 *
 * A pid disappearing between the scan and the signal is normal in a teardown
 * that is itself killing processes, so it is skipped, never thrown.
 *
 * `pattern` filters on the process name and is the ONLY name filter — a string
 * is read as a regular expression, matching the ERE the shell version took;
 * omitted means every process rooted in the tree.
 */
export function reapByCwd(
  worktreePath,
  { signal = 'TERM', pattern, scan = procsByCwd, pgid = pgidOf, kill = process.kill.bind(process) } = {},
) {
  const named = typeof signal === 'number' ? signal : signal.startsWith('SIG') ? signal : `SIG${signal}`;
  const match = pattern === undefined ? undefined : pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const ownGroup = pgid(process.pid);
  const reaped = [];

  for (const { pid, comm } of scan(worktreePath)) {
    if (pid === process.pid) continue;
    if (match && !match.test(comm)) continue;

    const group = pgid(pid);
    if (group === undefined) continue; // exited between discovery and now
    if (ownGroup !== undefined && group === ownGroup) continue;

    try {
      kill(pid, named);
    } catch {
      continue; // vanished, or not ours to signal — neither is an error here
    }
    reaped.push({ pid, comm, signal: named });
  }
  return reaped;
}
