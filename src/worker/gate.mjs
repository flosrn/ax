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
// AN UNPROVEN PANE IS NOT A DEAD ONE, AND THIS VERB ANSWERS THE DIFFERENCE
// (#192). Until then INCONNU was mapped to "down, disclosed": the omission was
// printed and `Safe to re-dispatch` was printed under it, so the only thing a
// caller consumes — the authorization — was granted by an absence of
// observation. `terminal list` omits hosts on this very Mac (measured
// 2026-08-22: one stale runtime, 155 of 218 dispatch panes absent because of
// it), so that was the ordinary case rather than the exotic one. Missing
// handles and incomplete host coverage are now refusals, not permissions.
//
// WHAT KEEPS THAT FROM REFUSING EVERY ORDINARY RE-DISPATCH is the dispatch
// store, which this verb already reads for its request-id substitution: a
// record says where its dispatch was PLACED, so a local pane absent from a list
// that covered `local` is proven dead whatever remote host that list omitted
// (omission is per host, ./pane.mjs), and a pane placed with `--on <env>` is
// put to THAT host through the same reader `ax worker ls` uses. The refusal is
// then the case nothing could decide, not the case nobody asked about.
//
// AND A RECORDED MUTATION WHOSE OUTCOME IS UNKNOWN OUTRANKS AN EMPTY LIST. A
// `worker-start` that never concluded may have COMMITTED (F-001): Orca can hold
// a Dispatch this host never learned the id of, so `worker-list` is empty while
// a child comes up. "First launch, safe to start" there is the duplicate by the
// front door, and the answer is the recorded replay — `ax worker start
// --resume` — never a fresh identity.
//
// A PROVEN-DEAD ATTEMPT IS AUTHORISED AND ROUTED. Death answers this verb's
// question, so it still exits 0; what it does NOT answer is which verb the
// record takes next, and that is decided by its branch's pull request
// (./continuation.mjs): OPEN takes `--replace`, MERGED is `release`'s, none or
// closed-unmerged is `settle`'s, and unreadable evidence takes none of them.
// Printing that beside the permission is what keeps a fresh orchestrator from
// reading "safe" as "start another one" over work that is already open.
//
// Exit codes are per-verb (ADR 0003), and this verb is FAIL-CLOSED — the
// opposite of `ax board`, because the act it authorises is irreversible:
//   0  safe: every dispatch of this task is proven gone (or there is none)
//   1  one live agent — do NOT re-dispatch
//   2  duplicate: two or more live agents on one task
//   3  cannot establish — never a permission, and that includes an unproven
//      pane, an unaskable host and a mutation whose outcome nobody knows
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
import { defaultExec } from '../exec.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { continuationFor } from './continuation.mjs';
import { declarationOf } from './hosts.mjs';
import { hostReader, hostScopes, terminalInventory } from './pane.mjs';
import { defaultStore, dispatchIndex, phaseVerdict, scanStore, taskIdScan } from './record.mjs';

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
 *
 * Exported because `ax worker settle` stands on THIS gate's evidence and must
 * read it the same way (#102): a second parser of the same receipt is how the
 * proof and the mutation end up disagreeing about who is alive.
 */
export function namedList(out, key, command) {
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

/**
 * THE RECORDS OF THIS TASK WHOSE LAST MUTATION NEVER CONCLUDED (#192).
 *
 * The one thing an empty `worker-list` cannot rule out. A `worker-start` whose
 * call died in transport, answered no legible receipt or recorded no exit status
 * may have COMMITTED — that is F-001's whole premise, and `phaseVerdict` names
 * it `unknown` rather than failed for exactly this reason (./record.mjs). Orca
 * then holds a Dispatch whose id this host never learned, so no row joins it and
 * no pane can be judged: the only evidence is the record, and the only safe act
 * is the replay it was written for.
 *
 * Read through the store's own scanner and its own verdict reader — no second
 * parser of either (#161) — and keyed on the task the record NAMES, the same
 * direction `taskFromRequest` resolves in reverse.
 *
 * Two absences are told apart. A store that was never created holds no record
 * and rules nothing out, so it is not an inability; a store that exists and
 * cannot be read is one, because the record that would have refused this gate
 * may be sitting in it. A single unparseable record is neither: it is disclosed
 * by name and the scan continues, because the store is host-global (./record.mjs)
 * and one corrupt file from another repository may not park every task on this
 * machine.
 */
function uncertainMutations(store, task) {
  const scan = scanStore(store);
  if (scan.reason !== '' && !scan.missing) return { ok: false, reason: `the dispatch store ${store} is unreadable: ${scan.reason}` };
  const rows = [];
  for (const { file, stem } of scan.records) {
    const path = join(store, file);
    let named;
    let verdict;
    try {
      named = taskIdScan(path);
      if (named !== task) continue;
      verdict = phaseVerdict(path, 'last');
    } catch {
      // A record naming no task, or holding no phase to judge, says nothing
      // about THIS task: it is the `unreadable` disclosure's business, not a
      // refusal of a gate about another subject.
      continue;
    }
    if (verdict.verdict === 'unknown') rows.push({ request: stem, evidence: String(verdict.evidence).slice(0, 300) });
  }
  return { ok: true, rows, unreadable: scan.unreadable };
}

export function gate(argv = [], { resolve = resolveOrca, runner, env = process.env, exec = defaultExec, cwd = process.cwd() } = {}) {
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

  // THE STORE, ONCE — the provenance every disposition below stands on. It is
  // the same store this verb already resolves a request id through, so it adds
  // no second source of truth: what it answers is which record produced a
  // Dispatch (and therefore where its pane was PLACED, ./record.mjs
  // `dispatchIndex`), and which recorded mutation of this task never concluded.
  const store = defaultStore(env);
  const uncertain = uncertainMutations(store, task);
  if (!uncertain.ok) {
    bad(`CANNOT ESTABLISH — ${uncertain.reason}`);
    note('A record in that store may hold a mutation whose outcome is unknown, and a re-dispatch over one of those is F-001.');
    fix(`ls -ld ${store}   # the store must be readable before any re-dispatch is authorised`);
    return 3;
  }

  // The panes, judged by the answer that can decide each one — the same reader
  // `ax worker ls` counts with (./pane.mjs `hostReader`). A row this store does
  // not attribute keeps `undefined` for its host, which is `paneVerdict`'s
  // conservative branch: a placement nobody recorded may never be asserted to
  // be local.
  const index = dispatchIndex(store);
  const hosts = hostReader(hostScopes(run, declarationOf(cwd)), terminals);
  const live = [];
  const dead = [];
  const unproven = [];
  if (rows.length > 0) note(`Dispatches for ${task}: ${rows.length}`);
  for (const w of rows) {
    const handle = typeof w.agentTerminalHandle === 'string' ? w.agentTerminalHandle : null;
    const prov = typeof w.dispatchId === 'string' ? index.byDispatch.get(w.dispatchId) : undefined;
    const verdict = hosts.verdictFor(handle, 'this dispatch recorded no pane, so nothing here proves it ended', prov === undefined ? undefined : prov.env).verdict;
    if (verdict.pane === 'VIVANT') live.push(w);
    else if (verdict.pane === 'MORT') dead.push({ w, prov });
    else unproven.push({ w, prov, detail: verdict.detail });
    const label = verdict.pane === 'VIVANT' ? 'LIVE   ' : verdict.pane === 'MORT' ? 'MORT   ' : 'INCONNU';
    note(
      `${label} ${w.dispatchId}  worker=${w.workerState}  terminal=${w.terminalState}  handle=${String(w.agentTerminalHandle ?? '—').slice(0, 24)}` +
        `${verdict.pane === 'VIVANT' ? '' : ` · ${verdict.detail}`}`,
    );
  }

  // A LIVE AGENT IS THE MOST CONCRETE REFUSAL, so it answers first: the operator
  // has a pane to go and read, which no other branch here can offer.
  if (live.length === 1) {
    bad(`STOP — one live agent (${live[0].dispatchId}). DO NOT re-dispatch: it is working.`);
    note('A `failed` Dispatch describes the receipt, never the process.');
    fix(`ax worker tail ${live[0].agentTerminalHandle}   # read it instead of re-dispatching`);
    return 1;
  }
  if (live.length > 1) {
    bad(`DUPLICATE — ${live.length} live agents on one task, therefore one working tree.`);
    for (const w of live) fix(`orca terminal close --terminal ${w.agentTerminalHandle}`);
    note('Keep the current Dispatch\'s. Then warn the survivor: its tree mixes two sets of writes, so it must re-read everything with `git diff`.');
    note('Check reflog / upstream / dangling too.');
    return 2;
  }

  // AN UNCONCLUDED MUTATION OUTRANKS AN EMPTY LIST (#192). It is checked before
  // both remaining answers because it is the one fact neither of them can see:
  // the Dispatch it may have created carries an id this host never learned, so
  // no row joins it, and "no Dispatch for this task" then reads as a first
  // launch over a child that is coming up.
  if (uncertain.rows.length > 0) {
    bad(`CANNOT ESTABLISH — ${uncertain.rows.length} recorded mutation(s) of ${task} never concluded, so a pane of this task may still be appearing.`);
    for (const row of uncertain.rows) note(`${row.request}: ${row.evidence}`);
    note('That is not a failure to report: the call may have COMMITTED (F-001), which is exactly what the recorded replay exists for.');
    for (const row of uncertain.rows) fix(`ax worker start --resume --request ${row.request}   # replay the recorded call; never a second request`);
    return 3;
  }

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

  // AN UNPROVEN PANE IS NOT A DEAD ONE (#192). Until then this branch printed
  // the omission and authorised anyway, on this very Mac, where `terminal list`
  // omits hosts as a matter of course — so the disclosure sat under a
  // permission, and the permission is the only thing a caller consumes. Each
  // cause is named apart from proven death and each carries the read that would
  // settle it: a host that could not be asked, an omission this list could not
  // see past, a dispatch no record attributes.
  if (unproven.length > 0) {
    bad(`CANNOT ESTABLISH — ${unproven.length} of ${rows.length} dispatch(es) of ${task} have NO proven pane, and an absence nobody covered is not a death (F-028).`);
    note('Do not re-dispatch on this result: a pane that may be alive is the pane a second child duplicates (F-001).');
    if (terminals.omitted) {
      note(`This host's terminal list omits ${terminals.omittedHosts.join(', ')}, so a pane placed on one of those is invisible from here.`);
    }
    for (const [host, scope] of hosts.unaskable()) {
      fix(`orca terminal list --environment ${host} --json   # '${host}' could not answer (${scope.reason}) — ask it, then re-run this gate`);
    }
    for (const row of unproven) {
      if (row.prov !== undefined) fix(`ax worker tail ${row.prov.request}   # the record behind ${row.w.dispatchId}: is its pane still emitting?`);
    }
    fix('ax worker ls   # every record, the pane it named and the host that answered for it');
    return 3;
  }

  // PROVEN DEAD: the question this verb was asked is answered, so it authorises
  // — and the verb that record takes NEXT is not this one's to guess. Its
  // branch's pull request decides between replacing an unfinished slice,
  // releasing a landed one and settling one that shipped nothing
  // (./continuation.mjs), and unreadable evidence decides none of them. Naming
  // it here is what keeps "safe to re-dispatch" from being read as "start
  // another one" over work that is already open.
  ok('no live agent: every dispatch of this task is a PROVEN corpse. Safe to re-dispatch (return the task to `ready` first).');
  const branches = new Map();
  for (const { w, prov } of dead) {
    if (prov === undefined) continue;
    const continuation = continuationFor(join(store, prov.file), {
      request: prov.request,
      dispatchId: typeof w.dispatchId === 'string' ? w.dispatchId : null,
      exec,
      memo: branches,
      run,
    });
    if (continuation.failed !== '') note(`the continuation of ${prov.request} is undecided: ${continuation.failed}`);
    if (continuation.fix !== '') fix(continuation.fix);
  }
  return 0;
}
