// The Run a dispatched child must report into, read from the peer registry.
//
// This is not a detail of one verb: `worker dispatch` needs it, `ready dispatch` needs
// it, and any later verb that puts an agent in front of work needs it too. It
// lives here because the alternative already cost a bug — `defaultExec` was
// declared twice, one copy was dropped in a refactor, and no test noticed
// because every test injected its own.
//
// The Run is never a flag. `run-current` drifts and then fences, and a guessed
// Run sends a child's report to a session that will never read it — so the only
// legal source is the registry entry the peer extension wrote for THIS pane.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * This pane's registry entry, or null.
 *
 * ONE reader, because the two facts below are read off ONE file and a second
 * `readFileSync` here is the second copy that drifts (the `defaultExec` bug
 * above, in a new place). Every inability — no handle, no file, a truncated
 * write, an entry that is not an object — is null, and the exported readers
 * turn that into the empty string their callers must refuse on.
 */
function peerEntry(env) {
  const handle = env.ORCA_TERMINAL_HANDLE ?? '';
  if (handle === '') return null;
  const path = join(env.HOME ?? '', '.omp', 'run', 'orca-peers', `${handle}.json`);
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    return entry !== null && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

/**
 * The Run this session's own receiver consumes, or `''`.
 *
 * Empty is a real answer, and every caller must refuse on it rather than
 * inventing one: it means this pane is not a registered peer, so no child
 * dispatched from here could report back at all.
 */
export function peerRun(env = process.env) {
  return String(peerEntry(env)?.run ?? '');
}

/**
 * The id of the OMP session driving this pane, or `''`.
 *
 * The same registry entry carries it (`sessionId`, written by the peer
 * extension's `register` — omp/peer/address.ts, which refuses to publish
 * without one), and it is what binds a read of "the transcript" to THIS
 * session: `readModelConfirmation` compares it against the transcript's own
 * `session` header, so an approval collected in a sibling pane is refused
 * rather than borrowed. Empty is a real answer for the same reason as above,
 * and a caller that needs the session must refuse on it — a guessed session id
 * would authorize a decision no human here ever saw.
 */
export function peerSessionId(env = process.env) {
  return String(peerEntry(env)?.sessionId ?? '');
}
