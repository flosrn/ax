// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * The tail of a peer's own OMP transcript. The session-aware selection rule
 * (F-023) carries its history on `transcriptFor` below.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { prop, str } from './orca.ts';

// ------------------------------------------------------------ transcripts --

/**
 * The tail of a peer's own OMP transcript.
 *
 * A dispatched session is useless if the caller cannot see its conclusions, and
 * a session that produced no file has its answer only in its last message. OMP
 * persists every session as JSONL under `<agent dir>/sessions/<slug>/`, and the
 * `{"type":"session"}` record carries the exact cwd — so a worktree maps to a
 * transcript with no guessing.
 *
 * The slug is a lossy encoding of the cwd, so it narrows the search and never
 * decides it: the recorded cwd is what a match is made on.
 *
 * There is no spawn-time cutoff, because nothing writes `.agent/orca-spawn.json`
 * any more. The newest cwd match is the honest answer, and its path is returned
 * so a caller who suspects a stale session can look.
 */
export function transcriptFor(
  worktree: string,
  last = 1,
  sessionId = '',
): { path?: string; messages?: string[]; reason?: string } {
  const root = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.omp/agent`;
  const sessions = `${root}/sessions`;
  let slugs: string[] = [];
  try {
    slugs = readdirSync(sessions);
  } catch {
    return { reason: `no session store at ${sessions}` };
  }

  // Two peers can share a worktree — `derive` names them `<base>·<handle4>` for
  // exactly that reason — so "newest session in this directory" answers the same
  // thing for both (F-023). OMP names a transcript `<timestamp>_<sessionId>`, and a
  // peer publishes its session, so the session picks the file when it is known.
  // Newest-in-worktree stays the fallback: a legacy entry published no session, and
  // refusing when a transcript has been rotated away is worse than a worktree tail.
  let owned = '';
  let newest = '';
  let newestAt = 0;
  for (const slug of slugs) {
    let files: string[] = [];
    try {
      files = readdirSync(`${sessions}/${slug}`).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = `${sessions}/${slug}/${f}`;
      const head = readLines(path).slice(0, 20);
      let cwd = '';
      let at = 0;
      for (const line of head) {
        let rec: unknown = null;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (prop(rec, 'type') !== 'session') continue;
        cwd = str(prop(rec, 'cwd'));
        at = Date.parse(str(prop(rec, 'timestamp'))) || 0;
        break;
      }
      if (cwd !== worktree) continue;
      if (sessionId && f.includes(sessionId)) owned = path;
      if (at >= newestAt) {
        newestAt = at;
        newest = path;
      }
    }
  }
  const chosen = owned || newest;

  if (!chosen) return { reason: `no OMP transcript recorded for ${worktree}` };

  // The record wraps the message: `{type:"message", message:{role, content}}`.
  // Only assistant `text` parts are prose — `thinking` is not addressed to the
  // reader and `toolCall` is machinery, so both are dropped. A turn that only
  // called tools contributes nothing, which is why this collects the last N
  // messages that HAVE text rather than the last N records.
  const messages: string[] = [];
  for (const line of readLines(chosen)) {
    let rec: unknown = null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (prop(rec, 'type') !== 'message') continue;
    const message = prop(rec, 'message');
    if (str(prop(message, 'role')) !== 'assistant') continue;
    const text = textOf(prop(message, 'content'));
    if (text) messages.push(text);
  }
  return { path: chosen, messages: messages.slice(-Math.max(1, last)) };
}

/** OMP writes content as a string or as an array of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (prop(part, 'type') === 'text' ? str(prop(part, 'text')) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
