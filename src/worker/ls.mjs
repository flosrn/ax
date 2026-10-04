// `ax worker ls` — how many children are actually working, counted by LIVE PANE.
//
// F-048 (gapilabs/omp#23): Orca's worker counter answered ZERO while children were
// working. The mechanism: a `worker-start` left failed/retained and repaired
// with `--inject` produces a Dispatch WITHOUT touching worker terminal
// accounting — so `orca orchestration worker-list` invents free capacity and,
// worse, hides those children at release time. Anything that counts workers
// from that list inherits both bugs. The truth that no repair path can forge is
// the PANE: a terminal handle the runtime still owns and has not orphaned.
// An additive operator-close ending is shown as its own cause, not as landing
// proof and not as a settlement debt. Liveness still comes from the host list.
//
// So this verb joins FOUR sources and shows their disagreement rather than
// picking a winner silently:
//   1. the local dispatch store (src/worker/record.mjs) — which requests exist,
//      which agent terminal each one was recorded to have opened, and on which
//      host it was dispatched;
//   2. `orca terminal list --json` — liveness per handle, `orphaned` = dead;
//   3. `orca terminal list --environment <host> --json`, once per host a record
//      names — that host's own inventory, asked because `dispatch.hosts.<host>`
//      in ax.config.json is what says how to reach it (#76);
//   4. `orca orchestration worker-list --json` — Orca's own accounting, printed
//      FOR COMPARISON ONLY, never as the count. Since Orca 867d38397893 an
//      unscoped list is the Run BOUND to the calling terminal, so a live or
//      unknown row it lacks is asked of the Run its own record names
//      (`worker-list --run <run>`, once per Run) before it reads ABSENT.
// A live pane whose worker-list entry is absent or `retained` is exactly the
// F-048 shape, and it is reported as a failure with the release that repairs it.
//
// Reading discipline (F-028): a record with no usable receipt is rendered
// UNKNOWN, never dropped — an absence of information is not an absence of a
// child. Same for the two containers: a `terminal list` that answers without a
// `terminals` array is a refusal, not an empty machine. And measured 2026-08-22
// on this Mac, `terminal list` carries `hostScope.omittedHostIds`: when hosts
// are omitted, a handle missing from the list is UNKNOWN, not dead.
//
// THE OMISSION SET IS EARNED, NOT ASSUMED (#76). Every remote pane used to read
// INCONNU behind "hosts were omitted from the terminal-list scope" — honest, and
// avoidable: the project's declaration already carried how to reach that host.
// Each host a record names is therefore asked for its own inventory, and only
// what could NOT be asked is disclosed, with the reason each answered. A host
// that answered classifies its own panes: present is capacity, and absent from
// the list that host itself gave is a corpse there (see pane.mjs `asked`).
//
// This verb is FAIL-CLOSED, unlike `ax board`: a count that cannot be
// established must refuse, because the caller is about to decide whether it has
// room for another child.
//
// TWO VIEWS, ONE JOIN (#70). The reader is an orchestrator about to dispatch,
// and it reads two answers: how many panes are live, and which. Measured
// 2026-09-02, this verb printed 189 records — 263 lines, ≈40 KB — to deliver
// them, once per dispatch. The default now lists the dispositions that carry a
// decision (VIVANT and INCONNU) and discloses the MORT count with `--all`, the
// view that still prints every record. Both views join every record: the count,
// the F-048 drift and the worker-list comparison are facts about the store, so
// the flag changes what is SHOWN and never what was established.
//
// AND A ROW CARRIES A DECISION WHEN IT NAMES A VERB (#165). A MORT row left
// this view because it named no repair; one whose pull request is still OPEN
// names `ax worker start --replace` and is shown, because an unfinished slice
// whose pane died is the row an operator most has to act on. Which verb — or
// none — is ./continuation.mjs, the answer `ax worker tail` prints too.
//
// A DEAD ROW IS ITS OWN REPOSITORY'S DECISION (F6c). The store is host-global,
// so read from gapila on 2026-09-29 the default view listed ofmchat's gone
// worktrees and counted 310 MORT rows and 26 settlement debts, almost none of
// them gapila's — while `settle` refuses a foreign record from here. Capacity
// and overlap stay machine facts (VIVANT and INCONNU rows of every repository
// are listed, and both counts are unchanged); a MORT row or a dead attempt of
// another repository is one count naming `--all`, and its branch is not read
// with this checkout's `gh`. A record naming no repository is unknown, never
// foreign (F-028), and a checkout `gh` cannot name keeps every row.
//
// A STRANDED REMOTE START IS ASKED ABOUT WHERE IT RAN (F2). A worker-start
// written ahead on `--on <host>` that never answered may have opened a pane,
// and #2120's orchestrator had to ssh to gapicore to rule out a duplicate.
// This verb guesses no ownership by worktree name; it asks that host (the
// same memoized ask the rows use) which live panes no receipt in this store
// names, prints them with their worktree, and names the replay
// (`ax worker start --resume`) that answers for the record itself.
//
// TWO COUNTS, AND NEITHER GATES (#88, ADR 0005). This verb used to end with
// `N live pane(s) — this is the cap count`, where N was every live pane on the
// machine: the store is host-global (./record.mjs), so read from one checkout it
// counted another's children under a label claiming to be a fence. Measured
// 2026-09-02 from the ofmchat checkout: three panes, all of them flosrn/ax's,
// and an orchestrator that honours "count with `ls`, never from memory" spent a
// turn deciding whether it was allowed to dispatch at all. So the count is two
// liveness facts — this repository's live panes and the machine total — from
// the reader remote admission spends Slots against (./slots.mjs), and neither
// admits nor refuses anything: admission is by each host's Slots (`ax worker
// hosts`). A record naming NO repository is UNKNOWN: it counts toward the
// machine total alone, and the line says how many (F-028).
//
// WHICH REPOSITORY THIS IS comes from `gh repo view`, the read every other
// repository-scoped verb here uses. It is not a pane count, so a checkout `gh`
// cannot name does not lose the listing: the per-repository line reads NOT
// MEASURED, the machine total still stands, and the verbs that authorise a
// mutation refuse for themselves.
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  the list was rendered, including the honest "0 record"
//   2  usage error
//   3  cannot-establish: no Orca CLI, silent runtime, unreadable store,
//      unreadable terminal list

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { defaultExec } from '../exec.mjs';
import { repoSlug } from '../gh.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { NO_CONTINUATION, continuationFor } from './continuation.mjs';
import { declarationOf } from './hosts.mjs';
import { createdPane, hostReader, hostScopes, terminalInventory } from './pane.mjs';
import { argvValue, defaultStore, recordedRun } from './record.mjs';
import { livePanes, liveLines } from './slots.mjs';

const OPEN = 'orca open   # start the Orca runtime, then re-run: ax worker ls';

/** A receipt that came back at all: exit 0, `ok`, a result object. Believable, not authoritative. */
const answered = ph =>
  ph !== null &&
  typeof ph === 'object' &&
  ph.exit === 0 &&
  ph.receipt !== null &&
  typeof ph.receipt === 'object' &&
  ph.receipt.ok === true &&
  ph.receipt.result !== null &&
  typeof ph.receipt.result === 'object';

/**
 * USABLE, the conjunction `report()` fixes in record.mjs: exit 0 AND
 * `state === 'ready'`. Exit 0 alone is only a receipt; a receipt reporting a
 * partial mutation is STRANDED however cleanly the process ended. This is the
 * ONLY receipt allowed to name a pane and the dispatch this verb would tell an
 * operator to release — a `task-create` answer (`{task, mutation}`, no state,
 * measured 2026-08-22) is display metadata and never that authority.
 */
const usablePhase = ph => answered(ph) && ph.receipt.result.state === 'ready';

/**
 * The agent pane out of one receipt's effects. Measured shape, 2026-08-22:
 * `{kind:'terminal', role:'agent', action:'created'|'reused_agent_terminal', id:'term_…'}`.
 * The action is deliberately NOT filtered: a reused agent terminal is just as
 * alive as a created one, and F-048's repaired dispatches reuse.
 */
function agentPane(effects) {
  if (!Array.isArray(effects)) return null;
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    if (effect !== null && typeof effect === 'object' && effect.kind === 'terminal' && effect.role === 'agent' && typeof effect.id === 'string') {
      return effect.id;
    }
  }
  return null;
}

/**
 * One record, read into the facts a line needs. Never throws: a record this
 * verb cannot parse is a NAMED unknown on its own line — dropping it is how a
 * working child disappears from a count.
 *
 * `repo` is the repository the record NAMES, trimmed, or `''` when it names
 * none — the same reading `recordRepo` and `dispatchIndex` give, and what
 * places a live pane in this repository's count rather than only in the
 * machine's (#88). An unreadable record names none: it is UNKNOWN twice over,
 * and the row already says so.
 */
function describeRecord(dir, file) {
  const stem = file.slice(0, -'.json'.length);
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    return { request: stem, taskId: null, dispatchId: null, handle: null, repo: '', unsettled: null, pending: undefined, claims: [], why: `record unreadable: ${error.message}` };
  }

  const request = typeof rec.request === 'string' && rec.request !== '' ? rec.request : stem;
  const repo = typeof rec.repo === 'string' ? rec.repo.trim() : '';
  const attempts = Array.isArray(rec.attempts) ? rec.attempts : [];
  const last = attempts[attempts.length - 1];
  const phases = last !== undefined && last !== null && Array.isArray(last.phases) ? last.phases : [];

  // ONE receipt answers for the pane: the LAST usable one. Carrying the handle
  // forward from an older phase while taking the ids from a newer one would
  // pair a pane with a dispatch that never owned it — and this verb's repair
  // line is `worker-release --dispatch <id>`, so a mispaired id releases the
  // wrong child.
  //
  // A pane recorded by a receipt that did NOT settle is therefore not promoted
  // to an established pane: an effect on an incomplete `worker-start` is no
  // proof that the dispatch/handle association took. It is not dropped either
  // (F-028 — measured on ws-1874, 2026-08-22: a worker-start that timed out at
  // agent_readiness had already recorded a reused agent terminal). It is
  // carried as a SUSPICION: if that handle turns out to be alive, the line says
  // so and points at `worker-show`, never at a release.
  let latest = null;
  let unsettled = null;
  let labelTask = null;
  // The runtime the pane's OWN phase dispatched onto (`worker-start --on`, empty
  // for a local dispatch). It decides whether an omitted REMOTE host can explain
  // that pane's absence, so it is PAIRED with the phase that named the handle,
  // never carried forward: a `--replace` records a SECOND worker-start phase,
  // and only the phase that named a handle can say where that handle lives. A
  // host taken from one phase beside a handle from another is a wrong verdict
  // in both directions. (A replace no longer moves a child between hosts —
  // `start.mjs` inherits the recorded placement and refuses a contradicting
  // one, #11 — but the pairing is what makes THIS phase's answer this phase's.)
  let latestHost;
  // A worker-start written ahead that NEVER CONCLUDED — no exit, no receipt:
  // the STRANDED shape, whose mutation may have run (F2). Its host is kept so
  // the listing can ask that host which panes nobody claims; it establishes
  // nothing about this record's own pane.
  let pending;
  // Every terminal ANY receipt of this record named, agent or setup: the panes
  // this store accounts for, which is what makes the others unclaimed.
  const claims = [];
  for (const ph of phases) {
    const result = ph !== null && typeof ph === 'object' && ph.receipt !== null && typeof ph.receipt === 'object' ? ph.receipt.result : undefined;
    // `undefined` where this phase cannot say: not a worker-start, or no argv
    // recorded. Only a phase that names its own placement may claim `local`.
    const on = ph?.name !== 'worker-start' || !Array.isArray(ph.argv) ? undefined : argvValue(ph.argv, '--on') ?? '';
    if (result === null || typeof result !== 'object') {
      // Never concluded is `exit` absent or null, whatever text came back:
      // measured on qual-gapicore (2026-09-28), the STRANDED shape is
      // `exit: null, transport: 'spawnSync orca ETIMEDOUT'` beside a receipt
      // `{unparseable: ''}` — the call timed out, its mutation may have run.
      if (on !== undefined && (ph.exit === undefined || ph.exit === null)) pending = on;
      continue;
    }
    pending = undefined;
    for (const effect of Array.isArray(result.effects) ? result.effects : []) {
      if (effect !== null && typeof effect === 'object' && effect.kind === 'terminal' && typeof effect.id === 'string') claims.push(effect.id);
    }
    // Display metadata only: which task this request is about. It labels the
    // line and decides nothing — the pane and the dispatch below come from the
    // usable receipt alone.
    if (answered(ph)) {
      const seen = (result.task ?? {}).id ?? result.taskId;
      if (typeof seen === 'string') labelTask = seen;
    }
    if (usablePhase(ph)) {
      latest = result;
      latestHost = on;
    } else {
      const leaked = agentPane(result.effects);
      if (leaked !== null) {
        unsettled = { handle: leaked, dispatchId: typeof result.dispatchId === 'string' ? result.dispatchId : null, host: on };
      }
    }
  }

  if (latest === null) {
    return { request, taskId: labelTask, dispatchId: null, handle: null, repo, host: undefined, unsettled, pending: unsettled === null ? pending : undefined, claims, ending: last?.ending, why: 'no usable receipt yet' };
  }

  const tid = (latest.task ?? {}).id ?? latest.taskId;
  const handle = agentPane(latest.effects);
  return {
    request,
    taskId: typeof tid === 'string' ? tid : labelTask,
    dispatchId: typeof latest.dispatchId === 'string' ? latest.dispatchId : null,
    handle,
    repo,
    host: latestHost,
    unsettled: handle === null ? unsettled : null,
    pending: undefined,
    claims,
    ending: last?.ending,
    why: handle === null ? 'no agent pane in the last usable receipt' : '',
  };
}

/**
 * Orca's accounting, indexed by both keys it exposes. Unreadable is NOT fatal:
 * this list is the suspect, not the witness — but its unreadability is named on
 * every line rather than shown as an absence of workers.
 *
 * `runId` scopes it. Since Orca 867d38397893 (worker-list-run-scope.ts) the
 * UNSCOPED list is the Run bound to the calling terminal, so a dispatch of
 * another Run is absent from it by scope, not by fact: a live or unknown row
 * that list lacks is asked of its own recorded Run before it reads ABSENT.
 */
function workerIndex(run, runId = '') {
  const out = run(['orchestration', 'worker-list', ...(runId === '' ? [] : ['--run', runId]), '--json']);
  const receipt = out.receipt ?? {};
  if (out.status !== 0 || receipt.ok !== true || !('result' in receipt) || !Array.isArray(receipt.result.workers)) {
    const detail = receipt.unparseable ?? out.stderr ?? '';
    return { ok: false, reason: `orca orchestration worker-list unreadable (exit ${out.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}` };
  }
  const byDispatch = new Map();
  const byHandle = new Map();
  const byTask = new Map();
  for (const worker of receipt.result.workers) {
    if (worker === null || typeof worker !== 'object') continue;
    if (typeof worker.dispatchId === 'string') byDispatch.set(worker.dispatchId, worker);
    if (typeof worker.agentTerminalHandle === 'string') byHandle.set(worker.agentTerminalHandle, worker);
    if (typeof worker.taskId === 'string') byTask.set(worker.taskId, [...(byTask.get(worker.taskId) ?? []), worker]);
  }
  const scope = receipt.result.scope;
  return { ok: true, byDispatch, byHandle, byTask, total: receipt.result.workers.length, run: scope !== null && typeof scope === 'object' && typeof scope.run === 'string' ? scope.run : '' };
}

// THE HOSTS A RECORD NAMES, and THIS CHECKOUT'S DECLARATION of them, live in
// `./hosts.mjs` (`declarationOf`) and `./pane.mjs` (`hostReader`). They used
// to live here because this verb was the only one that asked; `ax worker gate`
// now judges a recorded pane the same way (#192), so a second copy is how one
// of them would start reading an absence as a corpse where the other does not.
// What stays this verb's own is the DISPOSITION of each row: a leaked pane
// counted as capacity is still INCONNU, still routed to `worker-show`, and
// never offered a release.

export function ls(argv = [], { resolve = resolveOrca, runner, exec = defaultExec, env = process.env, cwd = process.cwd() } = {}) {
  let storeArg = '';
  let all = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--store') {
      i += 1;
      if (argv[i] === undefined) {
        process.stderr.write('ax worker ls: --store needs a value\n');
        return 2;
      }
      storeArg = argv[i];
    } else {
      process.stderr.write(`ax worker ls: unknown argument "${arg}" (only --all and --store <dir>)\n`);
      return 2;
    }
  }

  const bin = runner ? 'injected' : resolve();
  if (!bin) {
    bad('no Orca CLI on this machine — pane liveness cannot be established');
    fix(OPEN);
    return 3;
  }
  const run = runner ?? createRunner({ bin });

  // The execution gate of the socle, before ANY read: a silent runtime cannot
  // be distinguished from a machine with no children, and this verb exists
  // precisely because that confusion costs duplicated agents.
  const ready = runtimeReady(run);
  if (!ready.ready) {
    bad(ready.reason);
    fix(OPEN);
    return 3;
  }

  // WHICH REPOSITORY, AND HOW MANY LIVE — read once, and printed by every path
  // that answers at all. An empty store is a real answer to "what is running":
  // both counts are zero there, and saying so beats making the caller infer it
  // from "0 record".
  //
  // A config still declaring a retired cap is refused here, before any record
  // is read: a count printed beside it would read as the ceiling in force.
  const declarations = declarationOf(cwd);
  const retired = declarations().retired;
  if (retired) {
    bad(retired.problem);
    fix(retired.fix);
    return 1;
  }
  const slug = repoSlug(args => exec('gh', args, cwd));
  const liveSummary = live => {
    for (const line of liveLines({ live, repo: slug })) note(line);
  };
  const NONE = { machine: 0, mine: 0, unknown: 0, unmeasured: { machine: 0, mine: 0, occupied: { machine: 0, mine: 0 }, occupancy: [] } };

  const dir = storeArg || defaultStore(env);
  let files;
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      section('0 record');
      note(`no dispatch store at ${dir} — nothing was ever claimed on this host`);
      liveSummary(NONE);
      return 0;
    }
    bad(`dispatch store unreadable at ${dir}: ${error.message}`);
    fix(`ls -ld ${dir}   # the store must be readable before any worker can be counted`);
    return 3;
  }

  if (files.length === 0) {
    section('0 record');
    note(`the dispatch store ${dir} is empty — no request was ever claimed on this host`);
    liveSummary(NONE);
    return 0;
  }

  const terminals = terminalInventory(run);
  if (!terminals.ok) {
    bad(terminals.reason);
    fix('orca terminal list --json   # panes are the only trustworthy count (F-048); without them nothing is established');
    return 3;
  }
  const workers = workerIndex(run);

  // EVERY record is joined, whatever the view. The capacity counts, the F-048
  // drift and the worker-list comparison are facts about the whole store, and a
  // flag that narrowed them would make the two views disagree about the machine
  // — while the count is this verb's entire job.
  //
  // `slug` is which repository THIS checkout is, and it decides only which
  // count a live pane joins — never whether the row is shown, and never a
  // verdict. A checkout `gh` cannot name loses the per-repository number and
  // keeps everything else (#88).
  //
  // THE COUNT IS NOT TALLIED HERE (#161, ruled shape 2 on 2026-09-04). It comes
  // from `livePanes` (./slots.mjs), the one reader remote admission spends a
  // host's Slots against, so the number this verb PRINTS is the number
  // admission read. Two tallies for one question is what this verb and the old
  // fence had: a live worker is a live terminal, not a proven association
  // (#152), and each of them widened to that on its own — this verb from its
  // rows, the fence from a dispatch index that carries a handle only for a
  // `worker-start` phase. A pane recorded by a legacy repair phase was VIVANT
  // here and absent from the fence's count (#161).
  //
  // What stays this verb's own is the DISPOSITION of each row: a leaked pane
  // counted as live is still INCONNU, still routed to `worker-show`, and
  // never offered a release — the association is unproven, and a release on a
  // guess is a mutation on a guess.
  //
  // The reader shares this verb's own host reader, so a pane it has to ask
  // about costs the same one round trip the rows already pay for.
  let suspects = 0;
  let unplaced = 0;
  const drift = [];
  const matched = new Set();
  const scopes = hostScopes(run, declarations);
  const hosts = hostReader(scopes, terminals);
  const slots = livePanes({ store: dir, local: terminals, scopes, repo: slug });
  if (slots.live === null) {
    // The store was enumerated for the rows above and could not be enumerated
    // for the count: it went away under this invocation. Fail-closed, like every
    // other unreadable container here — the caller is about to decide whether it
    // has room for another child.
    bad(`the dispatch store ${dir} became unreadable while it was being counted: ${slots.reason}`);
    fix(`ls -ld ${dir}   # the store must be readable before any worker can be counted`);
    return 3;
  }

  // ONE pull-request answer per branch, for this invocation (#165). Two records
  // naming one worktree is ordinary — a re-dispatch under a fresh request id
  // reuses the tree — and measured here 2026-09-05 it asked `feat/157-xapikey`
  // twice out of 8 reads. The map is the listing's, so both rows read the same
  // answer and neither pays for it twice.
  const branchAnswers = new Map();

  // ITS OWN RUN'S WORKER-LIST, memoized per Run: the Run a record's phases
  // name (`--run`, `recordedRun`). `null` where no Run is recorded, where it is
  // the list already read, or where that list does not answer — an unread list
  // is never an empty one (F-028).
  const runLists = new Map();
  const ownRun = file => {
    let runId = '';
    try {
      runId = recordedRun(join(dir, file));
    } catch {
      return null;
    }
    if (!runId || runId === workers.run) return null;
    if (!runLists.has(runId)) {
      const listed = workerIndex(run, runId);
      runLists.set(runId, listed.ok ? { runId, index: listed } : null);
    }
    return runLists.get(runId);
  };

  // EVERY TERMINAL THIS STORE ACCOUNTS FOR — any receipt's agent or setup pane
  // — so that a pane a host carries and no record names can be told apart from
  // one another dispatch owns (F2).
  const rows = files.map(file => ({ file, row: describeRecord(dir, file) }));

  // A START THAT BOUND NO PANE, READ AS GATE READS IT (F2, #2107). A record
  // whose own worker-start named no dispatch (refused, or never answered) can
  // still own one: Orca holds a Dispatch for its TASK, and when that row binds
  // no pane (a start failed at `agent_readiness`) `worker-show` names the pane
  // the start created — ./pane.mjs `createdPane`, the reader gate uses. The
  // join is by the task the record's own task-create named, in the Run its own
  // phases name, and only a task with exactly ONE dispatch there is joined:
  // two are a choice this verb does not make (F-028).
  if (workers.ok) {
    for (const { file, row } of rows) {
      if (row.handle !== null || row.dispatchId !== null || row.unsettled !== null || typeof row.taskId !== 'string') continue;
      const index = ownRun(file)?.index ?? workers;
      const mine = index.byTask?.get(row.taskId) ?? [];
      if (mine.length !== 1 || typeof mine[0].dispatchId !== 'string') continue;
      const [worker] = mine;
      const bound = typeof worker.agentTerminalHandle === 'string'
        ? { ok: true, handle: worker.agentTerminalHandle, host: row.pending, from: 'worker-list' }
        : { ...createdPane(run, worker.dispatchId), from: 'worker-show' };
      if (!bound.ok) continue;
      Object.assign(row, { handle: bound.handle, dispatchId: worker.dispatchId, host: bound.host, pending: undefined, why: '', origin: `from ${bound.from} of ${worker.dispatchId}` });
      row.claims.push(bound.handle);
    }
  }
  const claimed = new Set(rows.flatMap(({ row }) => row.claims));

  // WHICH REPOSITORY A ROW IS (F6c): only this checkout's rows, and those
  // naming none (unknown is never foreign, F-028), carry a MORT decision in the
  // default view. Another repository's dead row is continued and settled from
  // its own checkout — `settle` refuses it here — so it is COUNTED, and listed
  // under `--all`. A checkout `gh` cannot name keeps every row, as before.
  const ours = row => slug === '' || row.repo === '' || row.repo.toLowerCase() === slug.trim().toLowerCase();

  const strandedOn = host => {
    const scope = scopes.scopeFor(host);
    if (scope.ok !== true) return { host, ok: false, panes: [] };
    return { host, ok: true, panes: [...scope.byHandle.values()].filter(terminal => terminal.orphaned !== true && !claimed.has(terminal.handle)) };
  };

  const views = rows.map(({ file, row }) => {
    // EACH PANE IS JUDGED BY THE ANSWER THAT CAN DECIDE IT (#76). The first list
    // decides a local dispatch, an unknown placement, and any handle it already
    // carries; a remote handle it does not carry is put to that host itself.
    const { verdict, asked } = hosts.verdictFor(row.handle, row.why, row.host);
    const { pane, detail } = verdict;
    // A WORKER-START THAT NEVER ANSWERED ON A NAMED HOST (F2) — the STRANDED
    // shape. Nothing establishes this record's pane, and nothing here guesses
    // one by worktree name; what the host CAN say is which of its live panes
    // no record claims, and one of those is the pane this dispatch may have
    // opened. Asked through the same memoized reader the rows use.
    const stranded = typeof row.pending === 'string' && row.pending !== '' ? strandedOn(row.pending) : null;
    // A row left unknowable by the LOCAL list's own omission — a record whose
    // placement no phase could name, so no host could be asked for it. That is
    // the only case the blanket disclosure below still explains.
    if ((row.host === undefined || row.host === '') && pane === 'INCONNU' && row.handle !== null && terminals.omitted) unplaced += 1;

    let state;
    let entry;
    if (!workers.ok) {
      state = 'ILLISIBLE';
    } else {
      // The comparison column, and only that: a record with no usable receipt
      // still names its dispatch in the failed one, so looking it up here is
      // what turns a permanent `ABSENT` into Orca's real accounting for it.
      // Never used for the pane or for a release — those stay on the usable
      // receipt, because a mispaired dispatch releases the wrong child.
      const lookup = index =>
        (row.dispatchId !== null ? index.byDispatch.get(row.dispatchId) : undefined)
        ?? (row.unsettled?.dispatchId ? index.byDispatch.get(row.unsettled.dispatchId) : undefined)
        ?? (row.handle !== null ? index.byHandle.get(row.handle) : undefined);
      entry = lookup(workers);
      // ITS OWN RUN, where the bound Run's list lacks it and the column can
      // change a reading: a VIVANT row absent from worker-list is the F-048
      // failure this verb prints with a release, and an INCONNU row is one an
      // operator arbitrates on. A MORT row keeps what the default list said.
      let foreignRun = '';
      if (entry === undefined && pane !== 'MORT') {
        const listed = ownRun(file);
        if (listed !== null) {
          foreignRun = listed.runId;
          entry = lookup(listed.index);
        }
      }
      if (entry === undefined) state = foreignRun === '' ? 'ABSENT' : `ABSENT from Run ${foreignRun}`;
      else {
        if (typeof entry.dispatchId === 'string' && foreignRun === '') matched.add(entry.dispatchId);
        state = `${entry.workerState ?? '?'}/${entry.terminalState ?? '?'}`;
      }
    }

    // A pane recorded by a receipt that never settled. Its ASSOCIATION with this
    // dispatch is unproven, so it is never released — a release on a guess is a
    // mutation on a guess — and it is NAMED whatever its state, which is the part
    // this verb used to get wrong: a handle was printed only while it was still
    // alive, so the records most in need of a route (a dispatch that failed at
    // `dispatch_input`, its pane long closed) rendered as `pane INCONNU · no
    // usable receipt yet` and named nothing an operator could type. Measured
    // 2026-08-25 on 55-work and 56-work, whose recorded panes were in the
    // receipt all along.
    //
    // It IS capacity when it reads VIVANT (#152) — counted by the reader above,
    // whose answer is about the terminal and not about the proof. What this
    // suspicion decides here is the ROW: named, inspected, never released.
    const leaked = row.unsettled ?? null;
    const leakedRead = leaked === null ? null : hosts.verdictFor(leaked.handle, '', leaked.host);
    const leakedVerdict = leakedRead === null ? null : leakedRead.verdict;
    const leakedLive = leakedVerdict !== null && leakedVerdict.pane === 'VIVANT';
    if (leakedLive) suspects += 1;


    // THE F-048 line: a pane the runtime still owns, while Orca's accounting
    // either does not know it (a `--inject` repair) or calls its terminal
    // `retained`. Both mean the same thing — that child is invisible to Orca's
    // worker accounting and to the release sweep, and only a release BY
    // DISPATCH clears it.
    const disagrees = workers.ok && pane === 'VIVANT' && (entry === undefined || entry.terminalState === 'retained');
    if (disagrees) drift.push(row);

    // A DEAD ATTEMPT: nothing was established (so the disposition is INCONNU and
    // stays INCONNU — the listing never relabels a verdict), and the pane this
    // record DID name is a corpse on a host the receipt read. No capacity, no
    // overlap. What it still holds is a settlement debt, and the verb that pays
    // it is `ax worker settle` (#102) — this one only counts it.
    const deadAttempt = row.handle === null && leakedVerdict !== null && leakedVerdict.pane === 'MORT';

    // AND A MORT ROW MAY STILL NAME ONE VERB (#165). A pane the runtime cannot
    // see whose pull request is still OPEN is an unfinished slice, and the verb
    // that continues it is `ax worker start --replace` — advertised only now
    // that it lands where the first attempt ran (`inheritPlacement`, #164).
    // Which verb (or none) is ./continuation.mjs's single answer, shared with
    // `ax worker tail` so the two readers cannot disagree.
    //
    // ASKED FOR MORT ROWS ONLY, and only where a branch can be named at all.
    // Measured on this machine 2026-09-05: 255 records, 222 of them MORT, and
    // 10 naming a worktree that still exists — so the `gh` reads are bounded by
    // the rows an operator can still act on, and the archaeology costs none. A
    // VIVANT row is never asked: a working child's branch has an open PR by
    // construction, and replacing that child is the mutation this verdict
    // exists to prevent.
    //
    // AND ONLY FOR A ROW THIS VIEW CAN SHOW (F6c): another repository's dead
    // row is counted in the default view, so its branch is read under `--all`
    // alone — asking this checkout's `gh` about another repository's branch is
    // a read that cannot answer it.
    const mine = ours(row);
    const continuation =
      pane === 'MORT' && (all || mine)
        ? continuationFor(join(dir, file), { request: row.request, dispatchId: row.dispatchId, exec, memo: branchAnswers, run })
        : NO_CONTINUATION;

    return { row, pane, detail, state, leaked, leakedVerdict, leakedLive, disagrees, deadAttempt, continuation, stranded, mine };
  });

  // THE DEFAULT VIEW (#70, ruled 2026-09-02). Measured on this machine: 189
  // records, 263 lines, ≈40 KB into an orchestrator's context on EVERY dispatch
  // — to deliver the live-pane count (capacity) and the live panes themselves
  // (overlap arbitration). So the default carries the rows that answer one of
  // those two, and nothing else:
  //
  //   VIVANT                      capacity in use, and the pane to arbitrate against
  //   INCONNU, host unaskable     may be alive on a host nothing here can ask (#76)
  //   INCONNU, pane alive         an unsettled worker-start whose terminal is up right now
  //   INCONNU, no pane named      a write-ahead record; nothing proves it dead either
  //
  // Two dispositions answer neither and leave, each disclosed as its own count:
  // a MORT row (a recorded handle the runtime cannot see), and a dead attempt
  // (unsettled, its recorded pane a corpse on a host that WAS read). Neither can
  // be arbitrated against and neither is capacity, and a dead attempt's two
  // settlement routes ride with it into `--all`.
  //
  // EXCEPT A MORT ROW THAT NAMES A VERB (#165). "A MORT row names no repair"
  // was the reason that disposition left this view, and it stopped being true
  // the moment its pull request decided a continuation: an unfinished slice
  // whose pane died is exactly the row an operator must act on, and hiding it
  // behind a flag is hiding the action. So a MORT row is shown when it carries
  // one — a route to type, or a read that FAILED and must not read as an
  // absence of one (F-028) — and the archaeology that names nothing keeps its
  // count. Bounded by construction: only a record whose worktree still exists
  // can name a branch at all (10 of 255 on this machine, 2026-09-05).
  //
  // The tallies above were taken before this split, so both views answer the
  // same machine: the flag changes what is SHOWN, never what was established.
  // A ROW CARRIES SOMETHING IF IT NAMES ANYTHING TO TYPE OR ANYTHING UNREAD:
  // the route, the failure, and the repair are three ways of saying it, and
  // the fix is the one an operator acts on — a continuation that names a
  // command under no route (an unreadable delivery mode, #3) would otherwise
  // be hidden by the very predicate that exists to stop hiding repairs.
  //
  // AND A DEAD ROW IS THIS REPOSITORY'S DECISION (F6c, measured 2026-09-29 from
  // gapila: 356 records, 14 of them gapila's). The store is host-global, and
  // capacity and overlap are machine facts, so VIVANT and INCONNU rows stay
  // whatever repository they name. A MORT row or a dead attempt is not: its
  // continuation is read and its ending written from its own checkout —
  // `settle` refuses a foreign record — so here it is one count, and `--all`
  // lists it.
  const carries = view => view.continuation.route !== null || view.continuation.failed !== '' || view.continuation.fix !== '';
  const dead = view => view.pane === 'MORT' || view.deadAttempt;
  const shown = all ? views : views.filter(view => (view.pane === 'MORT' ? view.mine && carries(view) : !view.deadAttempt));
  const hidden = views.length - shown.length;
  const withheldMort = views.filter(view => view.mine && view.pane === 'MORT' && !carries(view)).length;
  const withheldAttempts = views.filter(view => view.mine && view.deadAttempt).length;
  const withheldForeign = views.filter(view => !view.mine && dead(view)).length;

  // The columns are sized on what is PRINTED: padding every line to the widest
  // request in the store would put the hidden rows' width back into the receipt.
  const width = key => shown.reduce((max, { row }) => Math.max(max, String(row[key] ?? '').length), 0);
  const requestWidth = width('request');
  const taskWidth = Math.max(width('taskId'), 'no task id'.length);
  const pad = (text, size) => (text.length >= size ? text : text + ' '.repeat(size - text.length));

  section(`${hidden > 0 ? `${shown.length} of ${views.length}` : String(views.length)} record(s) — counted by LIVE PANE, never by worker-list (F-048)`);

  for (const { row, pane, detail, state, leaked, leakedVerdict, leakedLive, disagrees, deadAttempt, continuation, stranded, mine } of shown) {
    const suffix = leaked === null
      ? ''
      : leakedLive
        ? ` · an unsettled worker-start recorded ${leaked.handle}, ALIVE right now`
        : ` · an unsettled worker-start recorded ${leaked.handle}, ${leakedVerdict.pane}`;
    const line = `${pad(row.request, requestWidth)} · ${pad(row.taskId ?? 'no task id', taskWidth)} · pane ${pane} · worker-list ${state}${detail ? ` · ${detail}` : ''}${row.origin ? ` (${row.origin})` : ''}${suffix}${row.ending?.cause === 'operator-close' ? ` · operator ending at ${row.ending.at} (${row.ending.handle} on ${row.ending.host || 'here'}), not a landing` : ''}`;

    if (disagrees) {
      bad(line);
      fix(
        row.dispatchId !== null
          ? `orca orchestration worker-release --dispatch ${row.dispatchId} --json   # after landing proof; worker-list will never sweep this pane for you`
          : `orca orchestration worker-list --json   # ${row.handle} is alive with no recorded dispatchId — find its Dispatch before releasing it`,
      );
    } else if (leakedLive) {
      bad(line);
      fix(
        leaked.dispatchId !== null
          ? `orca orchestration worker-show --dispatch ${leaked.dispatchId} --json   # establish who owns ${leaked.handle} before assuming free capacity`
          : `orca terminal list --json   # establish who owns ${leaked.handle} before assuming free capacity`,
      );
    } else if (pane === 'VIVANT') ok(line);
    else {
      note(line);
      // A dispatch DID happen here and established nothing, so this verb can
      // name no pane — but the child's own session outlives its pane, and one
      // verb reads it without needing either. Naming the route is not claiming
      // the fact: `transcript` is fail-closed and answers for itself.
      if (row.handle === null && leaked !== null) {
        fix(`ax worker tail ${row.request}   # the recorded pane, resolved from this store`);
        fix(`ax worker transcript ${row.request}   # what that child actually did — a session outlives its pane`);
      }
      // And the debt itself, on the one row that carries it (#102). Named
      // unconditionally EXCEPT where the continuation has just established
      // that this attempt has no ending to write yet (#3): this verb resolves
      // no repository slug and grades no row by settleability — 205 per-row
      // predicates on every invocation to answer a question the verb itself
      // answers for one — but a row whose branch is unshipped parent work is
      // one this reader ALREADY asked about, and printing the ending beside
      // the handoff offers the operator the exact line #3 exists to withdraw.
      // `settle` is fail-closed and refuses that row too, which is what makes
      // naming it on every other row honest rather than a guess.
      if (deadAttempt && row.ending === undefined && continuation.route !== 'deliver') {
        fix(`ax worker settle ${row.request}   # write the ending, once the gate's evidence proves it`);
      }
      // AND THE CONTINUATION OF A GONE PANE (#165), decided by
      // ./continuation.mjs and rendered here. A failed read is printed as the
      // failure it is, with the call to make, and offers no route: a route
      // guessed over an unread pull request sends an operator to replace a
      // child whose work already landed.
      if (continuation.failed !== '') note(`the continuation of this row is undecided: ${continuation.failed}`);
      if (continuation.fix !== '') fix(continuation.fix);
      // THE STRANDED REMOTE START (F2): what its host says, and the replay
      // that answers for this record. The replay re-sends the RECORDED request
      // identity, so Orca answers the first call's outcome rather than
      // creating a second worker (F-001) — `start`'s own repair for this state.
      if (stranded !== null) {
        if (!stranded.ok) {
          note(`this record's worker-start on '${stranded.host}' never answered, and that host could not be asked which panes it holds`);
        } else if (stranded.panes.length === 0) {
          note(`this record's worker-start on '${stranded.host}' never answered, and every live pane '${stranded.host}' holds is claimed by a record here`);
        } else {
          const named = stranded.panes.slice(0, 5).map(terminal => `${terminal.handle} (${terminal.worktreePath ?? 'no worktree named'})`).join(', ');
          note(`this record's worker-start on '${stranded.host}' never answered — ${stranded.panes.length} live pane(s) there no record claims: ${named}`);
        }
        // `start` refuses a record another repository wrote (a request-id
        // collision), so a foreign record's replay is typed from its checkout.
        fix(`${mine ? '' : `cd <your ${row.repo} checkout> && `}ax worker start --resume --request ${row.request}   # replays the recorded call, never a second request: its receipt names the pane`);
      }
    }
  }

  // THE COUNTS, from the one reader remote admission spends Slots against
  // (./slots.mjs), printed as liveness facts (`liveLines`): the sentence a
  // reader counts by and the live workers a host's Slots are spent from are
  // one measurement rather than two tallies that agreed by maintenance (#161).
  liveSummary(slots.live);
  // A PANE ESTABLISHED FROM ORCA'S DISPATCH, NOT FROM A RECEIPT, IS IN NEITHER
  // COUNT: both counts read the panes this store's receipts recorded
  // (./slots.mjs, #161), and a start that bound no pane recorded none. Said
  // rather than silently left out of a number printed as the live total.
  const liveFromShow = views.filter(view => view.row.origin !== undefined && view.pane === 'VIVANT').length;
  if (liveFromShow > 0) {
    note(`${liveFromShow} live pane(s) above were read from Orca's dispatch (a start that bound no pane) and are in NEITHER count — the counts read recorded panes only, so they understate by that many`);
  }
  // A RECORD THE COUNT COULD NOT READ IS DISCLOSED, because this verb is
  // lenient per record and the fences are not: a row can render here — with the
  // pane its last usable receipt named — while the reader that counts refuses
  // it, and a number silently missing a row it printed is the divergence #161
  // is about. The dispatch verbs turn this same list into cannot-establish.
  if (slots.unreadable.length > 0) {
    const first = slots.unreadable[0];
    note(
      `${slots.unreadable.length} record(s) are in NEITHER count — the reader that counts panes cannot read them, and both dispatch verbs refuse on that (F-028). First: ${first.file} — ${String(first.error).slice(0, 160)}`,
    );
  }
  // COUNTED AS CAPACITY, NOT AS A PROVEN OWNER (#152). These panes are in the
  // totals above — a terminal that is up occupies a slot whatever recorded it —
  // and what stays unproven is WHOSE they are, which is why the rows route to an
  // inspection and never to a release. Saying "never counted" here, as this line
  // did, contradicted the number printed two lines up.
  if (suspects > 0) {
    note(`${suspects} of them were recorded by a worker-start that never settled: counted as capacity, and their owner is established by hand — no release is offered on one`);
  }
  // A shortened list says so, one line per class withheld, each with the flag
  // that lengthens it: an omission a reader cannot see is the same defect as a
  // count it cannot establish (F-028). The dead-attempt line is also the only
  // surface that counts a settlement debt, which is why it is a count and not
  // silence.
  if (!all && withheldMort > 0) {
    note(`${withheldMort} MORT record(s) not shown — their pane is gone and nothing here can name a branch to continue them with (#165): ax worker ls --all`);
  }
  if (!all && withheldAttempts > 0) {
    note(`${withheldAttempts} unsettled record(s) whose pane is MORT — ax worker settle <request> writes the ending, ax worker ls --all names them`);
  }
  if (!all && withheldForeign > 0) {
    note(`${withheldForeign} record(s) of other repositories whose pane is MORT are not shown — each is continued or settled from its own checkout: ax worker ls --all`);
  }
  // THE OMISSION SET, now only what it really is (#76): the hosts that could
  // NOT be asked, each with the reason it answered — a host that answered
  // classified its own panes and is no omission at all. One line per host and
  // never per row: the reason is a fact about the host, and repeating it per
  // record is the receipt this verb was shortened out of (#70).
  for (const [host, scope] of hosts.unaskable()) {
    note(`host '${host}' could not be asked, so its panes stay INCONNU, never MORT: ${scope.reason}`);
  }
  // And the residue no declaration can reach: a record whose own phase never
  // named a placement, absent from a list that omits hosts. Nothing says which
  // host to ask for it, so the scope itself is the disclosure.
  if (unplaced > 0) {
    note(`${unplaced} recorded pane(s) name no placement, and this list omits ${terminals.omittedHosts.join(', ')}: absent from it is INCONNU here, never MORT`);
  }
  if (!workers.ok) {
    bad(workers.reason);
    fix('orca orchestration worker-list --json   # the comparison column is missing; the pane count above still stands');
  } else {
    const unmatched = workers.total - matched.size;
    note(`worker-list reports ${workers.total} entry(ies), ${unmatched} of them with no local record`);
    if (drift.length > 0) note(`${drift.length} live pane(s) absent or retained in worker-list — that is F-048, and the count above is the one to trust`);
  }

  return 0;
}
