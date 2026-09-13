// The optional machine-private notifier: a convenience, never an authority.
//
// A notifier never decides whether a handoff succeeded (R24). AX prints the
// relay URL itself, so a delivery that fails must leave a working session
// behind. Successful deliveries are deduplicated by publication GENERATION as
// well as by target: a republication supersedes the old link, so a key without
// the generation would keep re-delivering a URL that now renders the
// superseded page.

import { scrub } from './emit.mjs';

const DEADLINE_SECONDS = 15;

/** Successful deliveries, keyed so a matching retry is skipped and a new generation is not. */
const delivered = new Set();

export function resetNotifications() {
  delivered.clear();
}

export function notificationKey({ project, worktree, identity, path, generation }) {
  return [project, worktree, identity, path, generation].join('\0');
}

/**
 * Best-effort delivery of intent metadata and the generation-addressed URL.
 * Never throws: a failure is a finding the caller may print.
 */
export async function notify({ machine, intent, url, runAdapter, cwd } = {}) {
  if (machine?.notifier == null) return { delivered: false, reason: 'absent', finding: null };

  const key = notificationKey(intent);
  if (delivered.has(key)) return { delivered: false, reason: 'deduplicated', finding: null };

  const command = machine.notifier.command;
  try {
    await runAdapter({
      command,
      timeoutSeconds: DEADLINE_SECONDS,
      cwd,
      at: 'notifier.command',
      request: {
        kind: 'phone-handoff',
        project: intent.project,
        worktree: intent.worktree,
        identity: intent.identity,
        path: intent.path,
        generation: intent.generation,
        url,
      },
    });
  } catch (error) {
    const problem = scrub(error?.message ?? 'the notifier failed');
    return {
      delivered: false,
      reason: 'failed',
      finding: {
        at: 'notifier.command',
        problem,
        fix: `run ${JSON.stringify(command.join(' '))} by hand, or omit "notifier" from the machine contract — AX already printed the relay URL`,
      },
    };
  }

  delivered.add(key);
  return { delivered: true, reason: 'ok', finding: null };
}
