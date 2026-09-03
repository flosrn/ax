// `ax worker gate <task|request>` — is reissuing a worker-start for this safe?
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
//   1  one live agent — do NOT re-dispatch
//   2  duplicate: two or more live agents on one task
//   3  cannot establish — never a permission
//
// `--help` NEVER REACHES THIS VERB, and that reverses what this header said
// until #89. The rule was that the original had no `--help`, that a `--help`
// therefore landed in the positional slot and was answered as a task id would
// be (3, cannot establish), and that callers depended on it. What that bought
// was measured: `ax worker gate --help` diagnosed a task named `--help` —
// a diagnosis of the wrong question entirely (#93). `runCli` now answers the
// flag from the registry, anywhere in this noun's argv, before the verb is
// reached (../cli.mjs). A `--help` arriving at the function directly is not a
// second contract: it is a string that names no task, which is still 3.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveOrca, createRunner, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { paneVerdict, terminalInventory } from './pane.mjs';
import { defaultStore, taskIdScan } from './record.mjs';

/**
 * The task a REQUEST id names, read from the dispatch record store, or null.
 *
 * A REQUEST ID IS NOT A TASK ID, and until 2026-08-26 this verb was the only one
 * in the family that said so by refusing. Measured that day on a live wave: the
 * orchestrator typed the id `worker launch` had just printed as `· request
 * 60-work` — the same id `worker tail`, `worker transcript` and `worker start
 * --show` all accept, and the leading column of `worker ls` — and the one verb
 * whose entire job is "can this be re-dispatched without duplicating an agent?"
 * answered CANNOT ESTABLISH, offering two causes that were both false: the
 * dispatch existed, on this host, in the Run consulted. An anti-duplication gate
 * that refuses the most natural identifier for its subject is a gate that gets
 * read as broken and then bypassed, which is F-001 by another road.
 *
 * The store is the same resolver `worker ls` prints its first two columns from,
 * so this adds no second source of truth. It is tried ONLY when a record bears
 * the argument as its exact file name: a task id typed correctly never reaches
 * it, and no id is ever guessed from the shape of a string.
 */
function taskFromRequest(id, env) {
  try {
    const path = join(defaultStore(env), `${id}.json`);
    if (!existsSync(path)) return null;
    const tid = taskIdScan(path);
    return typeof tid === 'string' && tid !== '' && tid !== id ? tid : null;
  } catch {
    return null;
  }
}

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
    fix('ax worker gate <task|request> [--run <run_id>]');
    return 3;
  }

  // The substitution is STATED, never silent: the whole value of this gate is
  // that its answer is about an identifiable subject, and an operator who typed
  // one id must be able to see which one was actually counted.
  const resolved = taskFromRequest(task, env);
  if (resolved !== null) {
    section(`gate ${resolved} (request ${task})`);
    task = resolved;
  } else {
    section(`gate ${task}`);
  }

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) {
    bad('CANNOT ESTABLISH — no Orca CLI on this machine, so no dispatch can be counted');
    note('Count the worktree\'s agent processes from the system side before any re-dispatch.');
    fix('orca open   # bring up the Orca runtime, then re-run this gate');
    return 3;
  }
  const run = runner ?? createRunner({ bin });

  // The execution gate of the socle. Unlike `ax board`, an unreachable runtime
  // is not a skip here: "I could not ask" must never read as "nobody is there".
  const ready = runtimeReady(run);
  if (!ready.ready) {
    bad(`CANNOT ESTABLISH — ${ready.reason}`);
    note('Count the worktree\'s agent processes from the system side before any re-dispatch.');
    fix('orca open   # bring up the Orca runtime, then re-run this gate');
    return 3;
  }

  // Read 1: the dispatches. Its absence is the one that must never be silent —
  // on a host where `orchestration worker-list` does not exist (the VPS ships a
  // different command set; the 2026-08-09 duplicate was born there) an empty
  // read would authorise the re-dispatch it exists to forbid.
  const workers = namedList(run(['orchestration', 'worker-list', '--json']), 'workers', 'orca orchestration worker-list');
  if (!workers.ok) {
    bad(`CANNOT ESTABLISH — ${workers.reason} (absent on this host?)`);
    note('Count the worktree\'s agent processes from the system side before any re-dispatch.');
    fix('orca open   # then re-run; if worker-list is missing here, gate from the host that has it');
    return 3;
  }

  // Read 2: which panes still exist. This is what makes a Dispatch row a live
  // agent or a corpse, and nothing else does — so it goes through the shared
  // inventory (src/worker/pane.mjs), which refuses a TRUNCATED list and reports
  // whether every host was asked. Reading `terminals` by hand here missed both,
  // and "absent from the list" is precisely what "no live agent" is read from.
  const terminals = terminalInventory(run);
  if (!terminals.ok) {
    bad(`CANNOT ESTABLISH — ${terminals.reason}`);
    note('Without the terminal list, a dead dispatch and a working agent are the same row.');
    fix('orca open   # bring up the Orca runtime, then re-run this gate');
    return 3;
  }

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
    // Fail CLOSED, and name every cause rather than calling it "wrong id":
    // `task-list` is bounded to the caller's Run, so a task from another Run is
    // absent from it exactly as an invented task is — and a REQUEST id whose
    // record this store does not hold is absent for a third reason entirely, the
    // one measured on 2026-08-26. Two causes presented as exhaustive sent the
    // operator hunting a Run failure that did not exist.
    bad(`CANNOT ESTABLISH — no Dispatch for ${task}, and ${listed ? 'it is in no task of the Run consulted' : "'task-list' did not answer"}.`);
    note('Three causes are indistinguishable from here: the id is wrong; it is a REQUEST id whose record this store does not hold; or the task lives in another Run or on another host.');
    note('Do not re-dispatch on this result.');
    fix('ax worker ls   # the request -> task column, if what you typed was a request id');
    fix(`ax worker gate ${task} --run <run_id>   # name the Run to decide`);
    return 3;
  }

  note(`Dispatches for ${task}: ${rows.length}`);
  const live = [];
  const unproven = [];
  for (const w of rows) {
    // One verdict definition (pane.mjs), this verb's own disposition on top:
    // `worker-list` carries no per-dispatch host, so the verdict keeps its
    // conservative branch (absent + omitted hosts = INCONNU), and the mapping
    // here — VIVANT is live, MORT and INCONNU are down, INCONNU is disclosed
    // below — is what keeps this gate's documented fail-open answer.
    const handle = typeof w.agentTerminalHandle === 'string' ? w.agentTerminalHandle : null;
    const verdict = paneVerdict(handle, 'no pane recorded on this dispatch', terminals, {});
    const on = verdict.pane === 'VIVANT';
    if (on) live.push(w);
    if (verdict.pane === 'INCONNU' && handle !== null) unproven.push(w);
    note(`${on ? 'LIVE ' : 'down '} ${w.dispatchId}  worker=${w.workerState}  terminal=${w.terminalState}  handle=${String(w.agentTerminalHandle ?? '—').slice(0, 24)}`);
  }

  if (live.length === 0) {
    // An absent handle is a corpse only when every host was asked, and
    // `terminal list` omits hosts on this very Mac (measured 2026-08-22: one
    // stale runtime, and 155 of 218 dispatch panes absent because of it). So the
    // absence is DISCLOSED rather than either hidden or turned into a refusal:
    // refusing here answered 3 for every ordinary re-dispatch on this machine,
    // and "answered 3 for a day" is the bug this verb was written to stop
    // repeating. The gate's scope is this host, as its header says, and a pane
    // on another one is `--on <host>`'s business, not a duplicate this host can
    // create.
    if (terminals.omitted && unproven.length > 0) {
      note(`${unproven.length} of these panes are absent from a terminal list that omits ${terminals.omittedHosts.join(', ')}.`);
      note('On this host they are down. If this task was dispatched with `--on <host>`, establish them there before re-dispatching.');
    }
    ok('no live agent. Safe to re-dispatch (return the task to `ready` first).');
    return 0;
  }

  if (live.length === 1) {
    bad(`STOP — one live agent (${live[0].dispatchId}). DO NOT re-dispatch: it is working.`);
    note('A `failed` Dispatch describes the receipt, never the process.');
    fix(`ax worker tail ${live[0].agentTerminalHandle}   # read it instead of re-dispatching`);
    return 1;
  }

  bad(`DUPLICATE — ${live.length} live agents on one task, therefore one working tree.`);
  for (const w of live) fix(`orca terminal close --terminal ${w.agentTerminalHandle}`);
  note('Keep the current Dispatch\'s. Then warn the survivor: its tree mixes two sets of writes, so it must re-read everything with `git diff`.');
  note('Check reflog / upstream / dangling too.');
  return 2;
}
