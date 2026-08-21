// `ax worker gate <task_id>` — is reissuing a worker-start for this task safe?
//
// One question, and it has to separate FOUR situations that all look like "no
// agent" from the outside:
//
//   the task exists and was never dispatched   -> 0, first launch, nothing to double
//   every dispatch's terminal is gone          -> 0, the corpses of F-003 are not agents
//   one terminal is still live                 -> 1, it is working
//   two are live                               -> 2, the duplicate itself
//   the task is in no list we can read         -> 3, and `task-list` is Run-scoped, so this
//                                                  covers "wrong id" AND "another Run"
//
// Until 2026-08-09 the bash/python original answered 3 for the FIRST of those
// as well as the last, because it read only `worker-list` and therefore saw one
// absence where there are two — it refused its most ordinary case for a day, on
// a real `ready` task. That is the shape this whole verb exists to keep apart:
// a control written for the case where its object is present and wrong, never
// for the case where it is absent.
//
// Liveness is measured against `terminal list`, never against the Dispatch row:
// a `failed` dispatch whose terminal is still there IS an agent at work (the
// measured heart of F-001, 2×2 agents on 2026-08-09), and a dispatch whose
// terminal has disappeared is a corpse (F-003), orphaned included.
//
// Exit codes are per-verb (ADR 0003), and this verb is FAIL-CLOSED — the
// opposite of `ax board`, because the act it authorises is irreversible:
//   0  safe: no live agent to duplicate
//   1  one live agent — do NOT relaunch
//   2  duplicate: two or more live agents on one task
//   3  cannot establish — never a permission
//
// No `--help`: the original never had one, and a `--help` lands in the
// positional slot and is answered as a task id would be (so: 3, cannot
// establish). Callers already depend on that, and the safe direction is the one
// it already points in.

import { resolveOrca, createRunner, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';

/**
 * A named list out of a receipt — the F-028 read. An absent `workers` container
 * is a cannot-establish that says so, never an empty list: an `or` on a
 * container is how an empty worker list was once read as a count of 2.
 */
function namedList(out, key, command) {
  if (out.status !== 0) {
    const detail = String(out.stderr || out.stdout || '').trim().slice(0, 200);
    return { ok: false, reason: `'${command}' failed (exit ${out.status})${detail ? `: ${detail}` : ''}` };
  }
  const receipt = out.receipt ?? {};
  if (receipt.unparseable !== undefined) return { ok: false, reason: `'${command}' did not answer JSON: ${String(receipt.unparseable).slice(0, 200)}` };
  const result = receipt.result;
  if (result === null || typeof result !== 'object' || !(key in result)) return { ok: false, reason: `'${command}' answered a receipt with no "${key}"` };
  const rows = result[key];
  if (!Array.isArray(rows)) return { ok: false, reason: `'${command}' answered "${key}" as ${typeof rows}, not a list` };
  return { ok: true, rows };
}

/** A terminal that is present and not orphaned. An orphaned pane is a dead one. */
const liveHandles = terminals => new Set(terminals.filter(t => !t.orphaned).map(t => t.handle));

export function gate(argv = [], { resolve = resolveOrca, runner, env = process.env } = {}) {
  let task = '';
  let runId = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') {
      i += 1;
      if (argv[i] === undefined) {
        bad('--run needs a run id');
        fix('ax worker gate <task_id> --run <run_id>');
        return 3;
      }
      runId = argv[i];
    } else if (!task) task = arg;
  }

  if (!task) {
    bad('which task? a gate with no task id cannot conclude anything');
    fix('ax worker gate <task_id> [--run <run_id>]');
    return 3;
  }

  section(`gate ${task}`);

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) {
    bad('CANNOT ESTABLISH — no Orca CLI on this machine, so no dispatch can be counted');
    note('Count the worktree\'s agent processes from the system side before any relaunch.');
    fix('orca open   # bring up the Orca runtime, then re-run this gate');
    return 3;
  }
  const run = runner ?? createRunner({ bin });

  // The execution gate of the socle. Unlike `ax board`, an unreachable runtime
  // is not a skip here: "I could not ask" must never read as "nobody is there".
  const ready = runtimeReady(run);
  if (!ready.ready) {
    bad(`CANNOT ESTABLISH — ${ready.reason}`);
    note('Count the worktree\'s agent processes from the system side before any relaunch.');
    fix('orca open   # bring up the Orca runtime, then re-run this gate');
    return 3;
  }

  // Read 1: the dispatches. Its absence is the one that must never be silent —
  // on a host where `orchestration worker-list` does not exist (the VPS ships a
  // different command set; the 2026-08-09 duplicate was born there) an empty
  // read would authorise the relaunch it exists to forbid.
  const workers = namedList(run(['orchestration', 'worker-list', '--json']), 'workers', 'orca orchestration worker-list');
  if (!workers.ok) {
    bad(`CANNOT ESTABLISH — ${workers.reason} (absent on this host?)`);
    note('Count the worktree\'s agent processes from the system side before any relaunch.');
    fix('orca open   # then re-run; if worker-list is missing here, gate from the host that has it');
    return 3;
  }

  // Read 2: which panes still exist. This is what makes a Dispatch row a live
  // agent or a corpse, and nothing else does.
  const terminals = namedList(run(['terminal', 'list', '--json']), 'terminals', 'orca terminal list');
  if (!terminals.ok) {
    bad(`CANNOT ESTABLISH — ${terminals.reason}`);
    note('Without the terminal list, a dead dispatch and a working agent are the same row.');
    fix('orca open   # bring up the Orca runtime, then re-run this gate');
    return 3;
  }
  const alive = liveHandles(terminals.rows);

  // Read 3: does the task exist at all? A failure here is NOT an answer — it is
  // an ignorance, and it is reported as one.
  const listArgs = ['orchestration', 'task-list'];
  if (runId) listArgs.push('--run', runId);
  listArgs.push('--json');
  const tasks = namedList(run(listArgs), 'tasks', 'orca orchestration task-list');
  const listed = tasks.ok;
  const known = listed && tasks.rows.some(t => t.id === task);

  const rows = workers.rows.filter(w => w.taskId === task);

  if (rows.length === 0) {
    if (known) {
      // The task exists and nothing was ever dispatched for it. First launch,
      // and it carries no risk: there is no agent to duplicate. Answering 3
      // here — what this did until 2026-08-09 — refuses the ordinary case.
      ok(`${task} exists and has no Dispatch. First launch, safe to start.`);
      return 0;
    }
    // Fail CLOSED, and name the ambiguity rather than calling it "wrong id":
    // `task-list` is bounded to the caller's Run, so a task from another Run is
    // absent from it exactly as an invented task is.
    bad(`CANNOT ESTABLISH — no Dispatch for ${task}, and ${listed ? 'it is in no task of the Run consulted' : "'task-list' did not answer"}.`);
    note('Two causes are indistinguishable from here: the id is wrong, or the task lives in another Run or on another host.');
    note('Do not relaunch on this result.');
    fix(`ax worker gate ${task} --run <run_id>   # name the Run to decide`);
    return 3;
  }

  note(`Dispatches for ${task}: ${rows.length}`);
  const live = [];
  for (const w of rows) {
    const handle = w.agentTerminalHandle;
    const on = alive.has(handle);
    if (on) live.push(w);
    note(`${on ? 'LIVE ' : 'down '} ${w.dispatchId}  worker=${w.workerState}  terminal=${w.terminalState}  handle=${String(handle ?? '—').slice(0, 24)}`);
  }

  if (live.length === 0) {
    ok('no live agent. Safe to relaunch (return the task to `ready` first).');
    return 0;
  }

  if (live.length === 1) {
    bad(`STOP — one live agent (${live[0].dispatchId}). DO NOT relaunch: it is working.`);
    note('A `failed` Dispatch describes the receipt, never the process.');
    fix(`ax worker tail ${live[0].agentTerminalHandle}   # read it instead of relaunching`);
    return 1;
  }

  bad(`DUPLICATE — ${live.length} live agents on one task, therefore one working tree.`);
  for (const w of live) fix(`orca terminal close --terminal ${w.agentTerminalHandle}`);
  note('Keep the current Dispatch\'s. Then warn the survivor: its tree mixes two sets of writes, so it must re-read everything with `git diff`.');
  note('Check reflog / upstream / dangling too.');
  return 2;
}
