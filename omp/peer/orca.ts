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
 */
const orcaBin = (): string => resolveOrcaBin().bin;

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

/** `orca … --json` but the raw text too, because some failures are only in stderr. */
export function orcaRaw(
  args: string[],
  timeoutMs = 20_000,
): { parsed: unknown; text: string } {
  try {
    const p = Bun.spawnSync([orcaBin(), ...args], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    const text =
      new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(p.stdout));
    } catch {}
    return { parsed, text };
  } catch {
    return { parsed: null, text: '' };
  }
}

export function prop(o: unknown, k: string): unknown {
  return o && typeof o === 'object' && k in o
    ? (o as Record<string, unknown>)[k]
    : undefined;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Orca has answered `{result: {things: []}}` and `{result: []}` across versions. */
export function rows(envelope: unknown, key: string): Record<string, unknown>[] {
  const result = prop(envelope, 'result');
  const listed = prop(result, key) ?? result;
  return Array.isArray(listed) ? (listed as Record<string, unknown>[]) : [];
}

// `worktree ps` and not `worktree list`: one row already carries lineage, board
// status, checkpoint comment AND live pane count, so no join is needed.
export function lineageRows(): Record<string, unknown>[] {
  return worktrees();
}

export function worktrees(): Record<string, unknown>[] {
  return rows(orca(['worktree', 'ps', '--json']), 'worktrees');
}

/** `<repoId>::<path>` is Orca's worktree id; a report is addressed by the path. */
export function idToPath(id: unknown): string {
  return str(id).replace(/^[^:]*::/, '');
}
