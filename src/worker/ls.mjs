// `ax worker ls` — how many children are actually working, counted by LIVE PANE.
//
// F-048 (gapilabs/omp#23): the cap counter answered ZERO while children were
// working. The mechanism: a `worker-start` left failed/retained and repaired
// with `--inject` produces a Dispatch WITHOUT touching worker terminal
// accounting — so `orca orchestration worker-list` invents free capacity and,
// worse, hides those children at release time. Anything that counts workers
// from that list inherits both bugs. The truth that no repair path can forge is
// the PANE: a terminal handle the runtime still owns and has not orphaned.
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
//      FOR COMPARISON ONLY, never as the count.
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
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  the list was rendered, including the honest "0 record"
//   2  usage error
//   3  cannot-establish: no Orca CLI, silent runtime, unreadable store,
//      unreadable terminal list

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { hostFor } from './hosts.mjs';
import { paneVerdict, terminalInventory } from './pane.mjs';
import { argvValue, defaultStore } from './record.mjs';

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
 * One record, read into the three facts a line needs. Never throws: a record
 * this verb cannot parse is a NAMED unknown on its own line — dropping it is
 * how a working child disappears from a count.
 */
function describeRecord(dir, file) {
  const stem = file.slice(0, -'.json'.length);
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    return { request: stem, taskId: null, dispatchId: null, handle: null, unsettled: null, why: `record unreadable: ${error.message}` };
  }

  const request = typeof rec.request === 'string' && rec.request !== '' ? rec.request : stem;
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
  // never carried forward: a `--replace` may move a child between hosts, and a
  // host taken from one phase beside a handle from another is a wrong verdict in
  // both directions.
  let latestHost;
  for (const ph of phases) {
    const result = ph !== null && typeof ph === 'object' && ph.receipt !== null && typeof ph.receipt === 'object' ? ph.receipt.result : undefined;
    if (result === null || typeof result !== 'object') continue;
    // Display metadata only: which task this request is about. It labels the
    // line and decides nothing — the pane and the dispatch below come from the
    // usable receipt alone.
    if (answered(ph)) {
      const seen = (result.task ?? {}).id ?? result.taskId;
      if (typeof seen === 'string') labelTask = seen;
    }
    // `undefined` where this phase cannot say: not a worker-start, or no argv
    // recorded. Only a phase that names its own placement may claim `local`.
    const on = ph.name !== 'worker-start' || !Array.isArray(ph.argv) ? undefined : argvValue(ph.argv, '--on') ?? '';
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
    return { request, taskId: labelTask, dispatchId: null, handle: null, host: undefined, unsettled, why: 'no usable receipt yet' };
  }

  const tid = (latest.task ?? {}).id ?? latest.taskId;
  const handle = agentPane(latest.effects);
  return {
    request,
    taskId: typeof tid === 'string' ? tid : labelTask,
    dispatchId: typeof latest.dispatchId === 'string' ? latest.dispatchId : null,
    handle,
    host: latestHost,
    unsettled: handle === null ? unsettled : null,
    why: handle === null ? 'no agent pane in the last usable receipt' : '',
  };
}

/**
 * Orca's accounting, indexed by both keys it exposes. Unreadable is NOT fatal:
 * this list is the suspect, not the witness — but its unreadability is named on
 * every line rather than shown as an absence of workers.
 */
function workerIndex(run) {
  const out = run(['orchestration', 'worker-list', '--json']);
  const receipt = out.receipt ?? {};
  if (out.status !== 0 || receipt.ok !== true || !('result' in receipt) || !Array.isArray(receipt.result.workers)) {
    const detail = receipt.unparseable ?? out.stderr ?? '';
    return { ok: false, reason: `orca orchestration worker-list unreadable (exit ${out.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}` };
  }
  const byDispatch = new Map();
  const byHandle = new Map();
  for (const worker of receipt.result.workers) {
    if (worker === null || typeof worker !== 'object') continue;
    if (typeof worker.dispatchId === 'string') byDispatch.set(worker.dispatchId, worker);
    if (typeof worker.agentTerminalHandle === 'string') byHandle.set(worker.agentTerminalHandle, worker);
  }
  return { ok: true, byDispatch, byHandle, total: receipt.result.workers.length };
}

/**
 * THE HOSTS A RECORD NAMES, asked for their own inventory.
 *
 * A record dispatched with `--on <env>` names its host by the name the project
 * declared it under, and `dispatch.hosts.<env>` is what says how ax reaches it —
 * so that host's OWN terminal list is available, and it answers for its panes.
 * Before this, the enquiry stopped at the local list's `omittedHostIds`: every
 * remote pane read INCONNU with "hosts were omitted from the terminal-list
 * scope", which is honest and was avoidable, since the declaration was right
 * there. An orchestrator arbitrating overlap then had to treat a working remote
 * child as an unknown.
 *
 * Asked ONCE per host, and only for a host a record actually names: a store with
 * no remote record reads no config and makes no extra call, and a declared host
 * no record mentions has no row to classify — this verb counts records, never
 * machines.
 *
 * A host that could not be asked is a NAMED refusal carrying the reason it
 * answered, never an empty inventory (F-028): its panes stay INCONNU, and only
 * the caller discloses why — once, not once per row.
 */
function hostReader(run, cwd) {
  const asked = new Map();
  let declaration;

  const declarations = () => {
    if (declaration !== undefined) return declaration;
    const paths = repoPaths(cwd);
    if (paths.root === null) {
      declaration = { ok: false, reason: `${cwd} is not inside a repository, so nothing declares how to reach a host` };
      return declaration;
    }
    const loaded = loadCheckoutConfig({ root: paths.root, main: paths.main });
    if (!loaded.exists) declaration = { ok: false, reason: `no ax.config.json under ${paths.root}, so no host is declared here` };
    else if (loaded.errors.length > 0) declaration = { ok: false, reason: `ax.config.json is invalid, so its host declarations cannot be read: ${loaded.errors[0]}` };
    else declaration = { ok: true, config: loaded.config };
    return declaration;
  };

  const scopeOf = name => {
    const declared = declarations();
    if (!declared.ok) return { ok: false, reason: declared.reason };
    const found = hostFor(declared.config, name);
    // The declaration is the transport: without one there is no call to make,
    // and a bare guess at a host name is exactly what `hostFor` refuses.
    if (!found.ok) return { ok: false, reason: found.reason };
    return terminalInventory(run, { environment: name });
  };

  return {
    /**
     * The inventory that answers for ONE record's pane, plus whether that answer
     * came from the host itself — which is what lets an absence there be a
     * corpse rather than an omission (see paneVerdict).
     */
    scopeFor(local, host) {
      if (host === undefined || host === '') return { inventory: local, asked: false };
      if (!asked.has(host)) asked.set(host, scopeOf(host));
      const scope = asked.get(host);
      return { inventory: scope, asked: scope.ok === true };
    },
    /** Every host that was asked and could not answer, with what it answered. */
    unaskable: () => [...asked].filter(([, scope]) => scope.ok !== true),
  };
}

export function ls(argv = [], { resolve = resolveOrca, runner, env = process.env, cwd = process.cwd() } = {}) {
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
      return 0;
    }
    bad(`dispatch store unreadable at ${dir}: ${error.message}`);
    fix(`ls -ld ${dir}   # the store must be readable before any worker can be counted`);
    return 3;
  }

  if (files.length === 0) {
    section('0 record');
    note(`the dispatch store ${dir} is empty — no request was ever claimed on this host`);
    return 0;
  }

  const terminals = terminalInventory(run);
  if (!terminals.ok) {
    bad(terminals.reason);
    fix('orca terminal list --json   # panes are the only trustworthy count (F-048); without them nothing is established');
    return 3;
  }
  const workers = workerIndex(run);

  // EVERY record is joined, whatever the view. The capacity count, the F-048
  // drift and the worker-list comparison are facts about the whole store, and a
  // flag that narrowed them would make the two views disagree about the machine
  // — while the count is this verb's entire job.
  let alive = 0;
  let suspects = 0;
  let unplaced = 0;
  const drift = [];
  const matched = new Set();
  const hosts = hostReader(run, cwd);

  const views = files.map(file => {
    const row = describeRecord(dir, file);
    // EACH PANE IS JUDGED BY ITS OWN HOST (#76). The local list answers for a
    // local dispatch and for a record whose placement is unknown; a record that
    // names a host is judged by what that host said about itself.
    const scope = hosts.scopeFor(terminals, row.host);
    const { pane, detail } = paneVerdict(row.handle, row.why, scope.inventory, { host: row.host, asked: scope.asked });
    if (pane === 'VIVANT') alive += 1;
    // A row left unknowable by the LOCAL list's own omission — a record whose
    // placement no phase could name, so no host could be asked for it. That is
    // the only case the blanket disclosure below still explains.
    if ((row.host === undefined || row.host === '') && pane === 'INCONNU' && row.handle !== null && terminals.omitted) unplaced += 1;

    let state;
    let entry;
    if (!workers.ok) {
      state = 'ILLISIBLE';
    } else {
      entry = (row.dispatchId !== null ? workers.byDispatch.get(row.dispatchId) : undefined)
        // The comparison column, and only that: a record with no usable receipt
        // still names its dispatch in the failed one, so looking it up here is
        // what turns a permanent `ABSENT` into Orca's real accounting for it.
        // Never used for the pane or for a release — those stay on the usable
        // receipt, because a mispaired dispatch releases the wrong child.
        ?? (row.unsettled?.dispatchId ? workers.byDispatch.get(row.unsettled.dispatchId) : undefined)
        ?? (row.handle !== null ? workers.byHandle.get(row.handle) : undefined);
      if (entry === undefined) state = 'ABSENT';
      else {
        if (typeof entry.dispatchId === 'string') matched.add(entry.dispatchId);
        state = `${entry.workerState ?? '?'}/${entry.terminalState ?? '?'}`;
      }
    }

    // A pane recorded by a receipt that never settled. It is NOT counted —
    // nothing proves that terminal belongs to this dispatch — and it is NOT
    // released, because a release on an unproven association is a mutation on a
    // guess. It is NAMED whatever its state, which is the part this verb used to
    // get wrong: a handle was printed only while it was still alive, so the
    // records most in need of a route (a dispatch that failed at
    // `dispatch_input`, its pane long closed) rendered as `pane INCONNU · no
    // usable receipt yet` and named nothing an operator could type. Measured
    // 2026-08-25 on 55-work and 56-work, whose recorded panes were in the
    // receipt all along.
    const leaked = row.unsettled ?? null;
    const leakedScope = leaked === null ? null : hosts.scopeFor(terminals, leaked.host);
    const leakedVerdict = leaked === null ? null : paneVerdict(leaked.handle, '', leakedScope.inventory, { host: leaked.host, asked: leakedScope.asked });
    const leakedLive = leakedVerdict !== null && leakedVerdict.pane === 'VIVANT';
    if (leakedLive) suspects += 1;

    // THE F-048 line: a pane the runtime still owns, while Orca's accounting
    // either does not know it (a `--inject` repair) or calls its terminal
    // `retained`. Both mean the same thing — that child is invisible to the cap
    // and to the release sweep, and only a release BY DISPATCH clears it.
    const disagrees = workers.ok && pane === 'VIVANT' && (entry === undefined || entry.terminalState === 'retained');
    if (disagrees) drift.push(row);

    // A DEAD ATTEMPT: nothing was established (so the disposition is INCONNU and
    // stays INCONNU — the listing never relabels a verdict), and the pane this
    // record DID name is a corpse on a host the receipt read. No capacity, no
    // overlap. What it still holds is a settlement debt, and the verb that pays
    // it is #78 rather than this one.
    const deadAttempt = row.handle === null && leakedVerdict !== null && leakedVerdict.pane === 'MORT';

    return { row, pane, detail, state, leaked, leakedVerdict, leakedLive, disagrees, deadAttempt };
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
  // be arbitrated against and neither is capacity; a MORT row additionally
  // names no repair, and a dead attempt's two settlement routes ride with it
  // into `--all`.
  //
  // The tallies above were taken before this split, so both views answer the
  // same machine: the flag changes what is SHOWN, never what was established.
  const shown = all ? views : views.filter(view => view.pane !== 'MORT' && !view.deadAttempt);
  const hidden = views.length - shown.length;
  const withheldMort = views.filter(view => view.pane === 'MORT').length;
  const withheldAttempts = views.filter(view => view.deadAttempt).length;

  // The columns are sized on what is PRINTED: padding every line to the widest
  // request in the store would put the hidden rows' width back into the receipt.
  const width = key => shown.reduce((max, { row }) => Math.max(max, String(row[key] ?? '').length), 0);
  const requestWidth = width('request');
  const taskWidth = Math.max(width('taskId'), 'no task id'.length);
  const pad = (text, size) => (text.length >= size ? text : text + ' '.repeat(size - text.length));

  section(`${hidden > 0 ? `${shown.length} of ${views.length}` : String(views.length)} record(s) — counted by LIVE PANE, never by worker-list (F-048)`);

  for (const { row, pane, detail, state, leaked, leakedVerdict, leakedLive, disagrees } of shown) {
    const suffix = leaked === null
      ? ''
      : leakedLive
        ? ` · an unsettled worker-start recorded ${leaked.handle}, ALIVE right now`
        : ` · an unsettled worker-start recorded ${leaked.handle}, ${leakedVerdict.pane}`;
    const line = `${pad(row.request, requestWidth)} · ${pad(row.taskId ?? 'no task id', taskWidth)} · pane ${pane} · worker-list ${state}${detail ? ` · ${detail}` : ''}${suffix}`;

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
    }
  }

  note(`${alive} live pane(s) — this is the cap count`);
  if (suspects > 0) note(`${suspects} live terminal(s) recorded by a worker-start that never settled — established by hand, never by this verb`);
  // A shortened list says so, one line per class withheld, each with the flag
  // that lengthens it: an omission a reader cannot see is the same defect as a
  // count it cannot establish (F-028). The dead-attempt line is also the only
  // surface that counts a settlement debt, which is why it is a count and not
  // silence.
  if (!all && withheldMort > 0) note(`${withheldMort} MORT record(s) not shown — a pane the runtime cannot see names no repair: ax worker ls --all`);
  if (!all && withheldAttempts > 0) note(`${withheldAttempts} unsettled record(s) whose pane is MORT — ax worker ls --all`);
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
