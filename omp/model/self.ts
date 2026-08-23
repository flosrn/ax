import { accessSync, closeSync, constants, openSync, readSync } from 'node:fs';

/**
 * "Which Task am I the worker for, and what did my parent write in its spec?"
 *
 * WHY THIS IS TWO CALLS AND NOT A SCAN
 * The obvious shape — walk every Run, list its Tasks, find mine — was measured
 * and rejected on 2026-08-06: a Task record carries `created_by_terminal_handle`
 * (the PARENT) and no assignee at all, so matching a worker would need one
 * `dispatch-show` per Task across every Run. `worker-list` answers the same
 * question in one call, returning `agentTerminalHandle` alongside `taskId` and
 * `runId`, and it reports no cursor.
 *
 * The scan also had a live trap: `run-list --json` returned 100 runs AND a
 * non-null `nextCursor` when this was written, so a scan that ignored the cursor
 * would silently see only the newest page and conclude "not supervised" with no
 * error. `worker-list` sidesteps that entirely.
 */

/**
 * WHY ABSOLUTE CANDIDATES AND NOT JUST `orca`.
 * A bare name resolves in an operator's shell and fails wherever PATH is
 * minimal. That failure was paid for: a scheduled job ran 246 times reading
 * nothing, reporting the exact shape of a healthy report. On the VPS the binary
 * is `orca-ide` (it collides with the GNOME screen reader), so both names are
 * probed and the adapter works on either host.
 */
const ORCA_CANDIDATES = [
  '/usr/local/bin/orca',
  '/opt/homebrew/bin/orca',
  '/usr/local/bin/orca-ide',
  '/opt/homebrew/bin/orca-ide',
  '/usr/bin/orca-ide',
];

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveOrcaBin(
  env: Record<string, string | undefined> = process.env,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
): { bin: string; how: 'env' | 'candidate' | 'path' } {
  const declared = env.ORCA_BIN;
  if (declared !== undefined && declared !== '') return { bin: declared, how: 'env' };
  for (const candidate of ORCA_CANDIDATES) {
    if (isExecutable(candidate)) return { bin: candidate, how: 'candidate' };
  }
  // Last resort: the bare name. It works in an operator's shell and fails under
  // a minimal environment — but the failure is then NAMED by the caller rather
  // than silent.
  return { bin: 'orca', how: 'path' };
}

/** Runs one `orca … --json` and returns its parsed envelope, or a named reason. */
export type OrcaRunner = (args: string[]) => Promise<{ value?: unknown; reason?: string }>;

export function createRunner(bin: string, timeoutMs = 8_000): OrcaRunner {
  return async (args) => {
    try {
      // NO WATCHDOG TIMER. This used to be a raw `setTimeout(() => proc.kill())`,
      // and a raw timer in an extension is a session-killer: OMP runs extensions
      // in-process with no isolation, so a throw in the callback escapes as an
      // unhandled rejection and the postmortem handler exits the session with
      // code 1 (measured 2026-08-11 in an isolated `omp --mode rpc` sandbox).
      // There is no ctx to borrow here — `createRunner` is called from a module
      // with no host — but there is no scheduling problem either: killing a
      // subprocess this call owns is a spawn concern, and Bun implements it.
      // Measured on bun 1.3.14: `timeout: 300` on a `sleep 5` returned at 304ms
      // with code 137 and `signalCode` SIGKILL, while a process that exits on
      // its own is unaffected.
      const proc = Bun.spawn([bin, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
      });
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) return { reason: `${args.join(' ')} exited ${code}` };
      return { value: JSON.parse(text) };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  };
}

function envelope(value: unknown): { ok: boolean; result: unknown } {
  if (typeof value !== 'object' || value === null) return { ok: false, result: null };
  const record = value as Record<string, unknown>;
  return { ok: record.ok === true, result: record.result ?? null };
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A worker entry as `worker-list` reports it, narrowed to what we consume. */
export interface WorkerEntry {
  dispatchId: string | null;
  taskId: string | null;
  runId: string | null;
  workerState: string | null;
  dispatchStatus: string | null;
}

/**
 * The one dispatch status that means "this attempt is running now".
 *
 * An ALLOW-list, not a deny-list, and that is the whole point. Three overlapping
 * vocabularies describe a worker — `workerState` (`ready`/`succeeded`/`failed`
 * observed), `dispatchStatus` (`dispatched`/`completed`/`failed` observed) and
 * Task status (`pending, ready, dispatched, completed, failed, blocked`). A
 * deny-list over one of them retunes on any word it was never told about, and
 * `completed` — the Task vocabulary's word for done — was exactly such a word.
 * Failing closed costs a named refusal in the log; failing open retunes whatever
 * session inherited the terminal.
 */
const LIVE_DISPATCH = 'dispatched';

export interface SelfLookup {
  entry: WorkerEntry | null;
  /**
   * Orca answered, and this handle is simply not in the list.
   *
   * Distinct from `reason` because it is NOT a fault and NOT yet a verdict: at
   * `session_start` it may only mean the Dispatch is not recorded yet, and at
   * `before_agent_start` it means this is an ordinary interactive session. Same
   * observation, different meaning, and only the occasion can tell them apart —
   * collapsing the two is what killed the retry this lookup exists to enable.
   */
  absent?: boolean;
  /** Why there is no usable entry — journaled, never swallowed. */
  reason?: string;
}

/**
 * Find the live worker entry for `handle`.
 *
 * Returns every decision explicitly rather than collapsing to null, because
 * "you are not a supervised worker" and "Orca could not be read" must not lead
 * to the same conclusion silently: the first is a normal interactive session,
 * the second is a fault worth printing.
 */
export async function findSelf(run: OrcaRunner, handle: string): Promise<SelfLookup> {
  const listed = await run(['orchestration', 'worker-list', '--json']);
  if (listed.reason !== undefined) return { entry: null, reason: `worker-list: ${listed.reason}` };
  const unwrapped = envelope(listed.value);
  if (!unwrapped.ok) return { entry: null, reason: 'worker-list answered ok=false' };
  const workers = field(unwrapped.result, 'workers');
  if (!Array.isArray(workers)) return { entry: null, reason: 'worker-list returned no workers array' };

  // ALL matches, not the first. One handle can carry several dispatches when a
  // terminal is reused, and picking "the first" would make the applied model
  // depend on list order — a non-deterministic choice is the worst kind to audit
  // because it does not reproduce.
  const mine = workers
    .filter((worker) => str(field(worker, 'agentTerminalHandle')) === handle)
    .map<WorkerEntry>((worker) => ({
      dispatchId: str(field(worker, 'dispatchId')),
      taskId: str(field(worker, 'taskId')),
      runId: str(field(worker, 'runId')),
      workerState: str(field(worker, 'workerState')),
      dispatchStatus: str(field(worker, 'dispatchStatus')),
    }));

  if (mine.length === 0) return { entry: null, absent: true };

  const live = mine.filter((entry) => (entry.dispatchStatus ?? '').toLowerCase() === LIVE_DISPATCH);
  if (live.length === 0) {
    const seen = mine.map((entry) => entry.dispatchStatus ?? '<none>').join(', ');
    return { entry: null, reason: `handle carries no live dispatch (status: ${seen})` };
  }
  if (live.length > 1) {
    const ids = live.map((entry) => entry.dispatchId).sort().join(', ');
    return { entry: null, reason: `handle carries ${live.length} live dispatches (${ids}) — no model inferred` };
  }
  return { entry: live[0] as WorkerEntry };
}

/** Read the spec of one Task. `null` means unreadable, which the caller treats as "nobody decided". */
export async function readSpec(
  run: OrcaRunner,
  runId: string,
  taskId: string,
): Promise<{ spec: string | null; reason?: string }> {
  const listed = await run(['orchestration', 'task-list', '--run', runId, '--json']);
  if (listed.reason !== undefined) return { spec: null, reason: `task-list: ${listed.reason}` };
  const unwrapped = envelope(listed.value);
  if (!unwrapped.ok) return { spec: null, reason: 'task-list answered ok=false' };
  const tasks = field(unwrapped.result, 'tasks');
  if (!Array.isArray(tasks)) return { spec: null, reason: 'task-list returned no tasks array' };
  for (const task of tasks) {
    if (str(field(task, 'id')) === taskId) return { spec: str(field(task, 'spec')) };
  }
  return { spec: null, reason: `task ${taskId} absent from run ${runId}` };
}

/**
 * How much of a transcript is read looking for its first user message.
 *
 * The whole file would be wrong, and not for style. This reader runs in every
 * Orca pane, not only in dispatched children: an operator's own session is
 * `absent` from `worker-list` too, so it reaches the same fallback. Its
 * transcript can be megabytes after an hour, and `readFileSync` + `split` would
 * allocate all of it twice per session to find an entry that is always in the
 * first few rows.
 */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;

/** The first `limit` bytes of a file, without materialising the rest of it. */
function readHead(path: string, limit = TRANSCRIPT_HEAD_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.toString('utf8', 0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * The spec as the SESSION received it, read from its own transcript.
 *
 * WHY A SECOND SOURCE EXISTS AT ALL. `readSpec` above asks Orca, and Orca answers
 * for the runtime the caller can reach. Measured 2026-08-13: a worker started with
 * `worker-start --on gapicore` runs on the VPS while its Run and Task stay
 * authoritative on the Mac, so the child's own `worker-list` answers without its
 * handle, `findSelf` returns `absent`, and every marker the parent wrote is
 * discarded in silence. The child served `claude-opus-5` for a spec that said
 * `@smol`. D-007 recorded that as a standing caveat on 2026-08-05 — "on a remote
 * worker the model is inscribed, not applied" — and it stayed true for eight days.
 *
 * The dispatch delivers the spec INTO the session, as its first user message, and
 * that copy needs no runtime to read. Measured on the same probe: its transcript
 * held one `role: "user"` entry carrying the preamble, `taskId` and `dispatchId`
 * verbatim, and the marker text.
 *
 * NOT a replacement. Orca stays the first source, because it answers the Task
 * record rather than a rendering of it; this is what the caller reaches for when
 * Orca cannot see the dispatch at all.
 */
export function readSpecFromTranscript(
  file: string | null | undefined,
  read: (path: string) => string = readHead,
): { spec: string | null; reason?: string } {
  if (file === null || file === undefined || file === '')
    return { spec: null, reason: 'host named no session file' };
  let raw: string;
  try {
    raw = read(file);
  } catch (error) {
    return { spec: null, reason: `session file unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  // FIRST user message, not the last. A dispatched session's spec arrives once, at
  // the start; later user entries are the operator steering it, and honouring
  // those would let any later message retune the session mid-flight.
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // One malformed line is not a malformed transcript: a session writing its
      // JSONL can be interrupted mid-line, and the entries before that are still
      // the truth.
      continue;
    }
    const text = userText(row);
    if (text !== null) return { spec: text };
  }
  return {
    spec: null,
    reason: `no user message in the first ${TRANSCRIPT_HEAD_BYTES} bytes of the transcript`,
  };
}

/**
 * The text of one transcript row, when that row is a user message.
 *
 * THE ENVELOPE IS NESTED, and assuming otherwise cost a full round trip on
 * 2026-08-13: the first version tested `row.role`, which does not exist. An OMP
 * entry is `{type: "message", message: {role, content, …}}`, and its `content` is
 * a block array whose first block is Orca's injected preamble with the spec
 * appended — so the blocks are JOINED rather than searched one by one, because
 * nothing promises which block the marker lands in.
 *
 * The un-nested shape is still accepted: it costs one field read and it is what
 * every test fixture and any other host would write.
 */
function userText(row: unknown): string | null {
  const envelope = field(row, 'message');
  const message = envelope === undefined || envelope === null ? row : envelope;
  if (str(field(message, 'role')) !== 'user') return null;
  const content = field(message, 'content');
  if (typeof content === 'string') return content === '' ? null : content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => str(field(block, 'text')) ?? '')
    .filter((part) => part !== '')
    .join('\n');
  return text === '' ? null : text;
}
