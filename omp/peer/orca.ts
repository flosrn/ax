// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * One place that spawns `orca … --json` and reads its envelope.
 *
 * No message text ever reaches a shell line: an argv array has no shell to
 * escape from, so peer-influenced text cannot be reinterpreted as a command.
 *
 * WHY SYNCHRONOUS. Every caller is an OMP event handler, and one of them is
 * `session_shutdown`. An async report there races the process exit it is
 * reporting — the very "silent finish" this channel exists to make impossible.
 * `spawnSync` costs a few hundred ms once per finished session and cannot be
 * cut off.
 */

// One resolver for the Orca binary, shared with `orca-model` rather than
// duplicated: the VPS names it `orca-ide`, and a bare `orca` there resolves to
// nothing under a minimal PATH.
import { resolveOrcaBin } from '../model/self.ts';

/**
 * Resolved per call, never at module load: `ORCA_BIN` short-circuits the probe
 * and the addressing/lineage suites point it at a fresh fake per case — a bin
 * frozen at load would outlive every one of them. An env-less resolution costs
 * a few stats against a spawn that costs hundreds of ms.
 *
 * Exported for the two sites that need the path rather than a call: the
 * `which` guard in `index.ts`'s session_start (the VPS case — plain `orca` is
 * the GNOME screen reader there and the CLI is `orca-ide`; a scheduled job
 * once ran 246 times reading nothing while reporting the exact shape of a
 * healthy report, most of what D-007 was waiting on) and the receiver's
 * construction.
 */
export const orcaBin = (): string => resolveOrcaBin().bin;

// ---------------------------------------------------------------- orca I/O --

/**
 * One `orca … --json`, parsed, or `null`.
 *
 * Never throws: a busy or absent runtime must degrade a peer feature, never
 * break the session hosting it.
 */
export function orca(args: string[], timeoutMs = 15_000): unknown {
  try {
    const p = Bun.spawnSync([orcaBin(), ...args], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    return JSON.parse(new TextDecoder().decode(p.stdout));
  } catch {
    return null;
  }
}

/**
 * `orca … --json` but the raw output too, because some failures are only in
 * stderr. `text` merges the two streams for a human diagnostic; `stdout` is
 * kept apart because it alone decides what a runner CLASSIFIES — stderr chatter
 * beside an empty answer must not turn "produced nothing" into "unparseable".
 */
export function orcaRaw(
  args: string[],
  timeoutMs = 20_000,
): { parsed: unknown; text: string; stdout: string } {
  try {
    const p = Bun.spawnSync([orcaBin(), ...args], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    const stdout = new TextDecoder().decode(p.stdout);
    const text = stdout + new TextDecoder().decode(p.stderr);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {}
    return { parsed, text, stdout: stdout.trim() };
  } catch {
    return { parsed: null, text: '', stdout: '' };
  }
}

/**
 * `orca … --json` in the injected-runner shape `route.ts` asks for: a parsed
 * value, or a NAMED reason — an empty answer and an unparseable one are
 * different failures, and the route resolver reports the one it saw.
 */
export function runOrca(args: string[]): { value?: unknown; reason?: string } {
  const { parsed, stdout } = orcaRaw(args, 15_000);
  if (stdout === '') return { reason: `${args.join(' ')} produced nothing` };
  return parsed === null ? { reason: `${args.join(' ')} was unparseable` } : { value: parsed };
}

export function prop(o: unknown, k: string): unknown {
  return o && typeof o === 'object' && k in o
    ? (o as Record<string, unknown>)[k]
    : undefined;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * A LIST ORCA ANSWERED, or the named reason it could not be read.
 *
 * A bare list of rows cannot carry that difference: a runtime that failed, an
 * unparseable answer and a genuinely empty list all arrive as `[]`, and every
 * caller above then reads the same absence out of them. That collapse is #220 —
 * a child whose `terminal list` failed was told its parent worktree "has no
 * live session to report to", which is a claim about the parent made out of an
 * inability to look. `unread` is set EXACTLY when nothing was established, and
 * `rows` is then empty and means nothing; an empty `rows` with no `unread` is
 * Orca stating that the list is empty, which is a fact a caller may act on.
 *
 * A success envelope is not enough. `result.truncated === true` is Orca saying
 * the rows it returned are a PREFIX, so they cannot authorise a complete view
 * either: a handle missing from a capped list reads identically to a handle
 * that is not there. The rows travel with the reason only as emptiness — a
 * partial list left in place is a list the next caller acts on.
 */
export interface Inventory {
  rows: Record<string, unknown>[];
  /** Named inability (F-028). Absent when Orca answered, empty list included. */
  unread?: string;
}

export function inventory(args: string[], key: string): Inventory {
  const spoken = args.filter((a) => a !== '--json').join(' ');
  const { parsed, stdout, text } = orcaRaw(args, 15_000);
  // stdout alone decides classification, exactly as `runOrca` does: stderr
  // chatter beside an empty answer must not turn "produced nothing" into
  // "unparseable". The stderr line rides along as the diagnostic, because it is
  // the only place a busy or absent runtime says why.
  const detail = text.trim().slice(0, 120).replace(/\s+/g, ' ');
  if (stdout === '')
    return { rows: [], unread: `\`${spoken}\` produced nothing${detail ? ` (${detail})` : ''}` };
  if (parsed === null) return { rows: [], unread: `\`${spoken}\` was unparseable` };
  if (prop(parsed, 'ok') === false)
    return { rows: [], unread: `\`${spoken}\` refused${detail ? ` (${detail})` : ''}` };
  const result = prop(parsed, 'result');
  if (prop(result, 'truncated') === true)
    return { rows: [], unread: `\`${spoken}\` truncated — a partial list is not a read list` };
  const listed = prop(result, key) ?? result;
  if (!Array.isArray(listed)) return { rows: [], unread: `\`${spoken}\` listed no ${key}` };
  return { rows: listed as Record<string, unknown>[] };
}

/** Every pane Orca knows about, or why that could not be read. */
export function terminalInventory(): Inventory {
  return inventory(['terminal', 'list', '--json'], 'terminals');
}

/** Every worktree with its lineage, or why that could not be read. */
export function worktreeInventory(): Inventory {
  return inventory(['worktree', 'ps', '--json'], 'worktrees');
}

// `worktree ps` and not `worktree list`: one row already carries lineage, board
// status, checkpoint comment AND live pane count, so no join is needed.
export function lineageRows(): Record<string, unknown>[] {
  return worktrees();
}

/**
 * The rows only. For readers whose answer is the same either way — a table, a
 * lineage walk that reports `-1` for an incomplete chain. Anything that turns an
 * absence into a claim about someone else takes `worktreeInventory` instead.
 */
export function worktrees(): Record<string, unknown>[] {
  return worktreeInventory().rows;
}

/** `<repoId>::<path>` is Orca's worktree id; a report is addressed by the path. */
export function idToPath(id: unknown): string {
  return str(id).replace(/^[^:]*::/, '');
}
