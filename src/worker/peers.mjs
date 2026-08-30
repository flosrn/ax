// The Run a dispatched child must report into, read from the peer registry.
//
// This is not a detail of one verb: `launch` needs it, `ready dispatch` needs
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
 * The Run this session's own receiver consumes, or `''`.
 *
 * Empty is a real answer, and every caller must refuse on it rather than
 * inventing one: it means this pane is not a registered peer, so no child
 * dispatched from here could report back at all.
 */
export function peerRun(env = process.env) {
  const handle = env.ORCA_TERMINAL_HANDLE ?? '';
  if (handle === '') return '';
  const path = join(env.HOME ?? '', '.omp', 'run', 'orca-peers', `${handle}.json`);
  try {
    return String(JSON.parse(readFileSync(path, 'utf8')).run ?? '');
  } catch {
    return '';
  }
}
