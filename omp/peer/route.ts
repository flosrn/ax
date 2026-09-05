// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * WHERE TO WRITE BACK to a worker on another execution host.
 *
 * A worker we dispatched is named (`attribution.ts`) and, until now, unanswerable: its
 * report carries no reply address, and this side refuses to take one out of a payload that
 * travelled over the relay. So the address is DERIVED from things we own, and the derivation
 * is the whole subject of this module.
 *
 * WHAT DOES NOT WORK, measured 2026-08-13, and why the two fields below are the ones used:
 *
 *   `--to dispatch:<id>`      Stored on the remote host under `run_legacy_local` and consumed
 *                             by nobody: the federated importer inserts the row with no
 *                             `runId` and the DB defaults it. Looks accepted, delivers
 *                             nothing (stablyai/orca#13656).
 *   `--to run:<its Run>`      Consumed and injected — but ONLY with `--environment`, because
 *                             a bare `run:<id>` is resolved against the runtime receiving the
 *                             call, which does not know that Run.
 *   a pane key                Not available: `worker-show` exposes none, and a Mac pane can
 *                             never be witnessed by the remote runtime anyway.
 *
 * THE JOIN. Orca answers both halves, so nothing here reads a file on the other host and
 * nothing keeps a long-lived connection:
 *
 *   worker-show --dispatch <id>          → `agent_terminal_handle`, `worktree_id`
 *   run-list --environment <env>         → rows carrying `coordinator_handle`, `objective`
 *
 * A remote OMP session publishes its own Run through `orca-peer`, which is why that Run's
 * `coordinator_handle` is the worker's terminal and its `objective` is
 * `peer session: <worktree>`. Both are required to match. One would be enough on a good day;
 * requiring two is what makes a stale row fail closed instead of answering confidently —
 * `coordinator_handle` is a snapshot taken when the Run was created, and terminal handles are
 * known to churn (stablyai/orca#9163, a different defect worth respecting here).
 *
 * FAIL CLOSED, ALWAYS. Zero matches, several matches, a `legacy` row, an unreadable receipt:
 * all return `null`, and `peer_reply` then refuses with its existing message. A wrong address
 * would deliver this session's answer to a stranger, which is worse than a refusal an agent
 * can read and work around with one command.
 */

export interface RemoteRoute {
  run: string;
  environment: string;
  peer: string;
}

/** One `orca … --json` call, parsed, or a named reason. Injected so tests need no Orca. */
export type Runner = (args: string[]) => { value?: unknown; reason?: string };

function field(bag: unknown, key: string): unknown {
  if (bag === null || typeof bag !== 'object') return undefined;
  return (bag as Record<string, unknown>)[key];
}

function str(bag: unknown): string {
  return typeof bag === 'string' ? bag : '';
}

// No `ok` check anywhere below, on purpose: a refusal carries no `result`, so every read
// comes back empty and the resolver fails closed through the same path as a missing field.

/** The last path segment of `<repo-id>::<abs path>`, which is the worktree's name. */
export function worktreeName(worktreeId: string): string {
  const path = worktreeId.includes('::') ? worktreeId.split('::').pop() ?? '' : worktreeId;
  return path.split('/').filter((part) => part !== '').pop() ?? '';
}

/**
 * Resolve `{run, environment}` for a dispatch we issued, or `null`.
 *
 * `environment` is not discovered — it is read from the argv this session recorded before
 * issuing the mutation, so a dispatch nobody here started resolves to nothing. An EMPTY
 * environment is the local case, not a failure: a dispatch placed on this machine records no
 * `--on`, and its Runs are the ones `run-list` reports without the flag.
 *
 * That empty case used to refuse, and refusing it was a trap rather than a safety property.
 * Measured 2026-08-14: answering a child cost one gesture cross-host (`peer_reply`) and a
 * different one locally (`orca terminal send`), decided by where the child happened to run,
 * and the refusal text named neither. Nothing about the local case is weaker — the same four
 * conditions below still have to hold, and locally there is MORE attribution available, not
 * less, since Orca owns the terminal. Only the lookup's scope changes.
 */
export function resolveChildRoute(
  run: Runner,
  dispatchId: string,
  environment: string,
  peer: string,
): RemoteRoute | null {
  if (dispatchId === '') return null;

  const shown = run(['orchestration', 'worker-show', '--dispatch', dispatchId, '--json']);
  if (shown.reason !== undefined) return null;
  const worker = field(field(shown.value, 'result'), 'worker');
  const handle = str(field(worker, 'agent_terminal_handle'));
  const name = worktreeName(str(field(worker, 'worktree_id')));
  if (handle === '' || name === '') return null;

  const listed = run(
    environment === ''
      ? ['orchestration', 'run-list', '--json']
      : ['orchestration', 'run-list', '--environment', environment, '--json'],
  );
  if (listed.reason !== undefined) return null;
  const rows = field(field(listed.value, 'result'), 'runs');
  if (!Array.isArray(rows)) return null;

  // BOTH fields, and `legacy` excluded. A row that matches only one of them is exactly the
  // stale-handle case this must not answer for.
  const matches = rows.filter(
    (row) =>
      field(row, 'legacy') !== 1 &&
      str(field(row, 'coordinator_handle')) === handle &&
      str(field(row, 'objective')) === `peer session: ${name}`,
  );
  if (matches.length !== 1) return null;

  const id = str(field(matches[0], 'id'));
  if (!/^run:?[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { run: id.startsWith('run:') ? id : `run:${id}`, environment, peer };
}

/**
 * The environment a dispatch was issued onto, read from the recorded argv.
 *
 * `ax worker start` writes every phase's argv before issuing it, so `--on <env>`
 * is already on disk for anything this machine dispatched. Reading it back
 * beats asking the message, which is the point of the whole module.
 *
 * PER ATTEMPT, not per file. One record accumulates every attempt for a request, including a
 * `--resume` and a `--replace`, and a replacement may land on a different server than the
 * start it replaced. Scanning the whole file would answer with whichever `--on` came last and
 * attach it to a dispatch that never went there — a wrong address that looks resolved, which
 * is the one outcome this module exists to refuse.
 */
export function environmentOfDispatch(record: unknown, dispatchId: string): string {
  const attempts = field(record, 'attempts');
  if (!Array.isArray(attempts)) return '';

  for (const attempt of attempts) {
    const phases = field(attempt, 'phases');
    if (!Array.isArray(phases)) continue;

    let environment = '';
    let owns = false;
    for (const phase of phases) {
      const argv = field(phase, 'argv');
      if (Array.isArray(argv)) {
        for (let i = 0; i < argv.length; i += 1) {
          const arg = str(argv[i]);
          if (arg === '--on') environment = str(argv[i + 1]);
          else if (arg.startsWith('--on=')) environment = arg.slice('--on='.length);
        }
      }
      if (str(field(field(field(phase, 'receipt'), 'result'), 'dispatchId')) === dispatchId)
        owns = true;
    }
    if (owns) return environment;
  }
  return '';
}

/**
 * The agent pane a dispatch RECORDED, read from the worker-start receipt that
 * names that dispatch id — `{kind:'terminal', role:'agent', id}` among its
 * effects. `''` when the record names none.
 *
 * This is the cross-check a witnessed completion needs (#168): on the fork
 * build a local supervised worker's `worker_done` arrives from its pane, with
 * the dispatch id in the payload rather than in the address, and the payload is
 * the sender's word. The record wrote which pane it dispatched before the
 * dispatch went; a claim from any other pane is a finding, never a derivation.
 * Per attempt and per phase for the same reason `environmentOfDispatch` is: a
 * `--replace` may have recorded a second pane under a second dispatch id.
 */
export function paneOfDispatch(record: unknown, dispatchId: string): string {
  const attempts = field(record, 'attempts');
  if (!Array.isArray(attempts)) return '';
  for (const attempt of attempts) {
    const phases = field(attempt, 'phases');
    if (!Array.isArray(phases)) continue;
    for (const phase of phases) {
      const result = field(field(phase, 'receipt'), 'result');
      if (str(field(result, 'dispatchId')) !== dispatchId) continue;
      const effects = field(result, 'effects');
      if (!Array.isArray(effects)) return '';
      for (const effect of effects) {
        if (str(field(effect, 'kind')) === 'terminal' && str(field(effect, 'role')) === 'agent') {
          return str(field(effect, 'id'));
        }
      }
      return '';
    }
  }
  return '';
}
