// `ax worker settle <task|request>` — write down the death the gate can prove.
//
// WHY IT IS ITS OWN VERB (#102, carved out of #78)
// `ax worker gate` can establish that every agent of an attempt is gone, and
// until this file existed nothing wrote that verdict into the record:
// `attemptSettle` (./record.mjs) had exactly one caller, the `--close` branch of
// `ax worker release`, and a row only reaches it after LANDING PROOF — a merged
// pull request. A failed, artifact-less attempt can never produce that, so the
// one function that would settle it was unreachable for exactly the records that
// needed it. Measured on this machine 2026-09-02: 206 of 233 records unsettled,
// and `ax worker ls` counting the debt with no verb to name.
//
// THE PROOF AND THE MUTATION ARE TWO VERBS. `gate` detects, `settle` writes, and
// `gate` grows no `--settle`: a detector does not mutate (`docs/adr/0001`). The
// rule is one sentence — IF THE GATE CANNOT PROVE DEATH, SETTLE CANNOT SETTLE —
// so liveness here is read the way the gate reads it: Orca's `worker-list` rows
// for the resolved task, each recorded pane judged against the shared terminal
// inventory (./pane.mjs). Neither the record's own dispatch pane (`null` on
// exactly the rows that carry this debt) nor an unsettled `worker-start`'s pane
// (an association `ax worker ls` already calls unproven) decides anything.
//
// AND THE DISPOSITION ON "UNKNOWN" IS THE GATE'S, INVERTED — deliberately. The
// gate asks whether a re-dispatch is safe, where an unknown pane must fail
// closed toward NOT DISPATCHING, so it discloses the omission and answers 0.
// This verb asks whether death may be WRITTEN, where the same unknown must fail
// closed toward not writing. Same evidence, opposite safe direction.
//
// SCOPE IS THE CHECKOUT WHOSE FRONTIER THE FLIP CHANGES. Settling moves a
// request from `already-dispatched` to `attempt-ended-unmerged` in
// `../frontier.mjs`, so the record must name THIS repository: the comparison is
// the one the frontier already makes (record `repo` against the checkout's slug,
// trimmed, case-insensitive), and `ax worker release` is the precedent for
// scoping a mutation to the checkout it can prove things about. A record naming
// another repository is refused with the `cd` that would settle it; a record
// naming NONE is unknown, never local (F-028) — reading an absent `repo` as
// "this one" would flip a classification in every repository on the host at
// once. There is no `--all` and no `--dispatch`: a dispatch is one attempt of a
// request, and settlement is a fact about the request's LAST attempt.
//
// AND THAT UNKNOWN HAD NO EXIT UNTIL `--repo` (#146, finding #133). `repo` is
// additive, so every record written before 0.20 carries none: the frontier kept
// its ticket `already-dispatched` in EVERY repository on the host — the absence
// is conservative there too — while this verb refused it in every one, and the
// record could never leave the frontier. Measured on this machine 2026-09-02:
// 205 of 206 unsettled records. `--repo <owner/name>` is the way out, and it is
// an ASSERTION SAID OUT LOUD rather than an inference: accepted only where the
// record carries no `repo`, the value equals the slug `gh` answers for this
// checkout, and the liveness proof below passes unchanged. It then BACKFILLS
// that name in the same write as the flag (./record.mjs `attemptSettle`), so
// the next frontier read classifies the ticket here and skips the record
// everywhere else. It never re-attributes a record that already names one —
// that record's owner is not in doubt, and a flag that could overwrite it would
// be an inference wearing an assertion's clothes.
//
// TWO EDGES OF THAT FLAG, both found by review of PR #155 and both about what
// "carries no repo" means. A record whose last attempt is ALREADY settled and
// which names none sits in the same trap one state later — it reads
// `attempt-ended-unmerged` in every repository — so an assertion is honoured
// there too, and the idempotence below is spent only when nothing was
// asserted; what is not re-demanded is the liveness proof, because the death it
// would establish is already written in that record. And a `repo` that is
// PRESENT but is not a name (an object, a list, a number) is corrupted
// metadata, not an absence: `recordRepo` collapses it to `''` for readers that
// only ask which repository, and the writer reads through `recordRepoNaming`
// instead so that it is an inability rather than something to overwrite.
// `null` is not in that class — it is how a pre-0.20 record spells the absence.
//
// It writes one flag and issues no Orca mutation, so it needs no write-ahead
// phase of its own: there is nothing in flight to recover.
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet), and the DIRECTION
// decides which one: a fact about the subject that forbids the write is a
// refusal; a read this run could not make is an inability.
//   0  settled, already settled, or already settled and now scoped by --repo
//   1  refused: a live agent, a foreign `repo`, a `repo` no --repo asserted, an
//      assertion the checkout contradicts, a record already attributed, an open
//      phase
//   2  usage error
//   3  cannot establish: no Orca CLI, a silent runtime, an unreadable store or
//      terminal list, no repository slug, a `repo` that is not a name, an
//      unknown pane, no row at all

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { defaultExec } from '../exec.mjs';
import { repoView } from '../gh.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { namedList } from './gate.mjs';
import { paneVerdict, terminalInventory } from './pane.mjs';
import { acquireLock, attemptSettle, defaultStore, lastAttemptState, recordRepoNaming, requestIdOk, taskIdScan } from './record.mjs';

const USAGE = 'ax worker settle <task|request> [--repo <owner/name>]';

const OPEN = 'orca open   # bring up the Orca runtime, then re-run this settle';

/**
 * Every record in the store, parsed — and the ones that could not be. An
 * unreadable record is not a record that names no task (F-028): the task being
 * looked for may be inside it, so the caller refuses instead of concluding.
 */
function storeRecords(store) {
  const parsed = [];
  const unreadable = [];
  for (const name of readdirSync(store).filter(entry => entry.endsWith('.json'))) {
    const path = join(store, name);
    try {
      JSON.parse(readFileSync(path, 'utf8'));
      parsed.push({ request: name.slice(0, -'.json'.length), path });
    } catch (error) {
      unreadable.push(`${name} (${String(error.message ?? error).slice(0, 80)})`);
    }
  }
  return { parsed, unreadable };
}

/**
 * The subject, resolved to ONE record — request id and task id both, whichever
 * of the two was typed.
 *
 * The request direction is the gate's own read: a record whose file name IS the
 * argument (./gate.mjs `taskFromRequest`), so no id is ever guessed from the
 * shape of a string. The task direction is the store scan, and it is where the
 * two failures live that must not be collapsed: no record names this task
 * (nothing to settle here), and several do (which request's last attempt this
 * would settle cannot be established). Both are inabilities.
 */
function resolveSubject(store, subject) {
  const direct = join(store, `${subject}.json`);
  if (existsSync(direct)) {
    try {
      return { ok: true, request: subject, task: taskIdScan(direct), path: direct };
    } catch (error) {
      return {
        ok: false,
        reason: `${subject} is a record here, and no phase of it recorded a task id: ${String(error.message ?? error)} — nothing names the dispatches whose death this would write`,
        repair: `ax worker ls --all   # the request -> task columns of every record in this store`,
      };
    }
  }

  let listed;
  try {
    listed = storeRecords(store);
  } catch (error) {
    return {
      ok: false,
      reason: `the dispatch store at ${store} cannot be read: ${String(error.message ?? error)}`,
      repair: `ls -ld ${store}   # the store is the only thing that resolves a subject to a record`,
    };
  }
  if (listed.unreadable.length > 0) {
    return {
      ok: false,
      reason: `${listed.unreadable.length} record(s) in ${store} cannot be parsed, and one of them may be the record for ${subject}: ${listed.unreadable.join(', ')}`,
      repair: `ax worker ls --all   # every record, each unreadable one named`,
    };
  }

  const hits = listed.parsed.filter(entry => {
    try {
      return taskIdScan(entry.path) === subject;
    } catch {
      // A record that recorded no task id names no task. That is a fact about
      // the record, not a failure of this read.
      return false;
    }
  });
  if (hits.length === 1) return { ok: true, request: hits[0].request, task: subject, path: hits[0].path };
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `no record in ${store} is named ${subject}.json, and none of the ${listed.parsed.length} readable records recorded the task ${subject}`,
      repair: 'ax worker ls --all   # the request -> task columns; the subject is one of those two',
    };
  }
  return {
    ok: false,
    reason: `${hits.length} records recorded the task ${subject} (${hits.map(entry => entry.request).join(', ')}) — which request's last attempt this would settle cannot be established`,
    repair: `ax worker settle ${hits[0].request}   # name the request instead: the record file is unambiguous`,
  };
}

export function settle(argv = [], { resolve = resolveOrca, runner, exec = defaultExec, env = process.env, cwd = process.cwd() } = {}) {
  const usageError = message => {
    process.stderr.write(`ax worker settle: ${message}\n${USAGE}\n`);
    return 2;
  };
  /** A fact about the subject that forbids the write. */
  const refuse = (message, repair) => {
    bad(message);
    if (repair) fix(repair);
    return 1;
  };
  /** A read this run could not make. Never a permission. */
  const cannot = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    if (repair) fix(repair);
    return 3;
  };

  let subject = '';
  // The repository this run ASSERTS the record belongs to, or null when nothing
  // was asserted. Null and `''` are not the same answer here — the second would
  // read as "asserted nothing", which is exactly the inference this flag exists
  // to refuse.
  let asserted = null;
  // No help branch: `runCli` answers the flag from the registry, anywhere in
  // this noun's argv, before the verb is reached (../cli.mjs, #89). This verb
  // arrived from main carrying one, written against the boundary #89 replaced —
  // the drift AGENTS.md's "Adding a surface" section now names by rule.
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // Both absent modes are refused BY NAME rather than as unknown flags: each
    // is a gesture an operator can reasonably expect, and the reason it does not
    // exist is the design.
    if (arg === '--dispatch' || arg.startsWith('--dispatch=')) {
      return usageError('there is no --dispatch mode: a dispatch is ONE attempt of a request, and settlement is a fact about that request\'s last attempt');
    }
    if (arg === '--all') {
      return usageError('there is no --all: settling flips a frontier classification, and that flip is made one request at a time, from the checkout whose frontier it changes');
    }
    if (arg === '--repo' || arg.startsWith('--repo=')) {
      if (asserted !== null) return usageError(`one --repo only, got "${asserted}" and a second assertion — two names for one record name none of them`);
      // The split form's value slot is the NEXT argument whatever it looks like,
      // the arity convention the registry states for its own flags
      // (../commands.mjs `valueFlags`): a `--repo --all` asserts `--all`, which
      // this checkout's slug then contradicts, rather than half-parsing.
      const value = arg === '--repo' ? argv[index + 1] : arg.slice('--repo='.length);
      if (arg === '--repo') index += 1;
      if (value === undefined || String(value).trim() === '') {
        return usageError('--repo needs the repository this checkout is (owner/name): an empty assertion asserts nothing, and settling on it is the inference this flag replaces');
      }
      asserted = String(value).trim();
      continue;
    }
    if (arg.startsWith('-')) return usageError(`unknown argument "${arg}"`);
    if (subject !== '') return usageError(`one subject only, got "${subject}" and "${arg}"`);
    subject = arg;
  }
  if (subject === '') return usageError('which one? a settlement with no subject writes death on nothing');
  // The subject names a file in the store, so the grammar that closes that file
  // name closes this argument: a separator or a leading dot is not a subject
  // this verb can look up, and must never become a path it walks.
  if (!requestIdOk(subject)) return usageError(`"${subject}" cannot name a task or a record in the dispatch store`);

  const store = defaultStore(env);
  const resolved = resolveSubject(store, subject);
  if (!resolved.ok) return cannot(resolved.reason, resolved.repair);
  const { request, task, path } = resolved;

  // STATED BEFORE ANYTHING ELSE, exactly as the gate states its own substitution
  // (./gate.mjs): an operator who typed one of the two ids must be able to see
  // which record is about to be written, and see it above the verdict rather
  // than after it.
  section(`settle ${request} (task ${task})`);

  // THE PROOF AND THE WRITE ARE ONE GESTURE, under the SAME lock
  // `ax worker start --replace` takes (./record.mjs `acquireLock`, default
  // suffix), for the reason that lock's own header gives: "the gate's answer is
  // worthless the instant a sibling can act on it".
  //
  // Without it (P1, review of PR #112): a `--replace` acquiring between this
  // verb's liveness read and its write returns the task to `ready`, opens a NEW
  // attempt and starts an agent — and `attemptSettle` reloads the file from disk,
  // so the flag would land on THAT live attempt, authorising a re-dispatch over a
  // working child. Interleaved load-modify-save is also how a phase gets
  // clobbered, which would cost the write-ahead identity of the running child.
  //
  // A lost lock is an inability, never a takeover: `acquireLock` has no
  // time-based takeover and every pre-existing lock fails closed, so the answer
  // is the named holder plus a re-run.
  let lock;
  try {
    lock = acquireLock(path);
  } catch (error) {
    return cannot(`the record lock could not be taken: ${String(error.message ?? error)}`, `ls -l ${path}.lock   # then re-run once nothing holds this record`);
  }
  if (!lock.held) {
    return cannot(
      `${lock.reason} — another caller is mid-gesture on this record, and an ending may not be written over one`,
      `ax worker settle ${request}   # re-run once that caller has finished`,
    );
  }
  try {
    return prove();
  } finally {
    lock.release();
  }

  /**
   * Everything the lock has to cover: the record's own state, the repository
   * scope, the liveness proof, and the one write. Declared as a closure so the
   * whole gesture is inside one `finally` rather than releasing the lock down
   * every refusal path by hand.
   */
  function prove() {

    let state;
    try {
      state = lastAttemptState(path);
    } catch (error) {
      return cannot(
        `the record ${path} does not answer for its last attempt: ${String(error.message ?? error)}`,
        `ax worker ls --all   # a record whose shape cannot be read is never written to`,
      );
    }

    // Already written, so there is nothing to prove and nothing to do — the
    // idempotence `attemptSettle` already has, spent before any read of the
    // machine rather than after it.
    //
    // UNLESS AN ASSERTION WAS MADE. `--repo` on a settled record that names
    // none is not a no-op: such a record is `attempt-ended-unmerged` in EVERY
    // repository on the host, which is #133's trap one state later, and a verb
    // reporting 0 while the assertion goes unwritten is success claimed for
    // work not done (review of PR #155, P2). The assertion is corroborated
    // below and the backfill written; what is NOT re-demanded is the liveness
    // proof, because the death it would establish is already recorded here.
    if (state.settled && asserted === null) {
      ok(`${request}'s last attempt is already settled — nothing to write`);
      return 0;
    }

    // THE CHECKOUT IS READ FIRST, and it has to be: every refusal below names
    // the slug this run can speak for, and the repair for a record that names
    // none IS that slug (`--repo <it>`). A `gh` that cannot answer is therefore
    // an inability even for a record whose scope is not in question — the same
    // direction the rest of this verb takes, one read earlier than before #146.
    const naming = recordRepoNaming(path);
    // A `repo` that is PRESENT and is not a name is corrupted metadata, and the
    // direction is the one this whole verb takes on a read it cannot make: the
    // ownership cannot be established, so neither a refusal nor a backfill is
    // warranted over it (review of PR #155, P1). `null` and blank are absences,
    // not corruption — that is the shape this flag exists for.
    if (naming.state === 'malformed') {
      return cannot(
        `${request} cannot be attributed: ${naming.detail} — a value this run cannot read is never an absence to fill, nor a name to compare`,
        `ax worker ls --all   # then repair that field by hand: the record is the only thing that says whose frontier this flip changes`,
      );
    }
    const recorded = naming.repo;
    const viewed = repoView(args => exec('gh', args, cwd));
    if (viewed.slug === '') {
      return cannot(
        `gh cannot name this checkout's repository, so no record can be scoped to it: ${viewed.detail}`,
        'gh auth login   # then re-run from a checkout with a GitHub remote',
      );
    }
    const here = viewed.slug.trim();
    const same = (left, right) => left.toLowerCase() === right.toLowerCase();

    if (asserted !== null && recorded !== '') {
      return refuse(
        `${request} already names ${recorded}, and --repo BACKFILLS a record that names none — it never re-attributes one`,
        same(recorded, here)
          ? `ax worker settle ${request}   # this record is already scoped to ${recorded}: settle it without the flag`
          : `cd <your ${recorded} checkout> && ax worker settle ${request}`,
      );
    }
    if (asserted !== null && !same(asserted, here)) {
      return refuse(
        `--repo says ${asserted} and gh says this checkout is ${here} — the assertion is accepted only where the two agree, because what corroborates it is this checkout`,
        `cd <your ${asserted} checkout> && ax worker settle ${request} --repo ${asserted}`,
      );
    }
    if (recorded === '' && asserted === null) {
      return refuse(
        `${request} names no repository, and an absent \`repo\` is UNKNOWN, never "this one" (F-028) — settling it from here would flip its frontier classification in every repository on this host at once`,
        `ax worker settle ${request} --repo ${here}   # say it out loud: accepted from this checkout only, and it writes ${here} onto the record`,
      );
    }
    if (recorded !== '' && !same(recorded, here)) {
      return refuse(
        `${request} belongs to ${recorded}, and this checkout is ${viewed.slug} — the flip changes ${recorded}'s frontier, so it is made from there`,
        `cd <your ${recorded} checkout> && ax worker settle ${request}`,
      );
    }
    // What the write will carry: the slug GH answered, never the operator's
    // spelling of it — the two agree case-insensitively, and the canonical one
    // is what the frontier compares against next.
    const backfill = asserted === null ? '' : here;

    // The settlement is already recorded, so the only thing left for the
    // assertion to do is narrow WHICH frontier reads this record. Written
    // through the same one-save writer, whose `settled: true` is idempotent.
    if (state.settled) {
      try {
        attemptSettle(path, { repo: backfill });
      } catch (error) {
        return cannot(
          `${path} could not be written: ${String(error.message ?? error)}`,
          `ls -l ${path}   # the attempt stays settled and unscoped; nothing partial was written (./record.mjs writes atomically)`,
        );
      }
      ok(`${request}'s last attempt is already settled — repo backfilled to ${backfill}, and that is the whole write`);
      note(`the frontier reads this record in ${backfill} from now on, and skips it in every other repository. No proof was re-demanded: this record already records the death.`);
      return 0;
    }

    // The one refusal the issue did not name and the triage census proved free
    // (open in 0 of 206 unsettled records): a phase with no exit and no receipt is
    // a mutation that MAY have committed, and `settled: true` written over it is
    // F-001 by another road.
    if (state.phases === 0) {
      return refuse(
        `${request} has no phase yet — its first mutation may be in flight, so nothing here proves an attempt ended`,
        `ax worker ls --all   # then re-run once that mutation has an outcome`,
      );
    }
    if (state.openPhase !== null) {
      return refuse(
        `phase "${state.openPhase}" of ${request} is still open — its mutation may be in flight`,
        `ax worker ls --all   # the verb that opened that phase owns its recovery; this one only writes an ending`,
      );
    }

    const bin = runner ? 'injected' : resolve({ env });
    if (!bin) {
      return cannot('no Orca CLI on this machine, so no attempt can be proved ended here', OPEN);
    }
    const run = runner ?? createRunner({ bin });

    const ready = runtimeReady(run);
    if (!ready.ready) return cannot(ready.reason, OPEN);

    // The gate's own two reads, in its own order and through its own readers: the
    // dispatches, then the panes that make each one an agent or a corpse. An
    // absent `workers` container is a cannot-establish that says so — on a host
    // whose command set has no `worker-list`, an empty read would authorise the
    // very write it must forbid.
    const workers = namedList(run(['orchestration', 'worker-list', '--json']), 'workers', 'orca orchestration worker-list');
    if (!workers.ok) {
      return cannot(`${workers.reason} (absent on this host?)`, 'orca orchestration worker-list --json   # settle from the host that carries it');
    }
    const terminals = terminalInventory(run);
    if (!terminals.ok) {
      return cannot(terminals.reason, 'orca terminal list --json   # without it, a corpse and a working agent are the same row');
    }

    const rows = workers.rows.filter(worker => worker.taskId === task);
    if (rows.length === 0) {
      return cannot(
        `no dispatch of ${task} is in this host's worker-list, so nothing here proves the attempt ended`,
        `ax worker gate ${request}   # the detector, and where an unknown is the safe answer`,
      );
    }

    note(`Dispatches for ${task}: ${rows.length}`);
    const live = [];
    const unknown = [];
    for (const worker of rows) {
      const handle = typeof worker.agentTerminalHandle === 'string' ? worker.agentTerminalHandle : null;
      // One verdict definition (./pane.mjs), and the conservative branch on
      // purpose: `worker-list` carries no per-dispatch host, so a pane absent from
      // a list that omitted hosts is INCONNU rather than MORT.
      const verdict = paneVerdict(handle, 'no pane recorded on this dispatch', terminals, {});
      if (verdict.pane === 'VIVANT') live.push(worker);
      else if (verdict.pane !== 'MORT') unknown.push({ worker, verdict });
      note(
        `${verdict.pane === 'VIVANT' ? 'LIVE   ' : verdict.pane === 'MORT' ? 'dead   ' : 'unknown'} ${worker.dispatchId}  worker=${worker.workerState}  terminal=${worker.terminalState}  handle=${String(worker.agentTerminalHandle ?? '—').slice(0, 24)}`,
      );
    }

    if (live.length > 0) {
      const first = live[0];
      return refuse(
        `STOP — ${live.length} live agent(s) on ${task} (${live.map(worker => worker.dispatchId).join(', ')}): an attempt whose agent is working has not ended`,
        `ax worker tail ${first.agentTerminalHandle}   # read that agent; a \`failed\` dispatch describes the receipt, never the process`,
      );
    }

    if (unknown.length > 0) {
      return cannot(
        `${unknown.length} pane(s) of ${task} cannot be established${terminals.omitted ? `, and this terminal list omits ${terminals.omittedHosts.join(', ')}` : ''} — ${unknown[0].verdict.detail}`,
        terminals.omitted
          ? `ax worker settle ${request}   # once ${terminals.omittedHosts.join(', ')} answers; or read the pane from the host it was dispatched to`
          : `ax worker tail ${request}   # establish that pane, then re-run: an unknown pane is never a corpse`,
      );
    }

    try {
      // One call, one write: `attemptSettle` puts the backfilled `repo` and the
      // flag in the same atomic save, so no crash can leave a record scoped and
      // unsettled (or settled and still host-wide).
      attemptSettle(path, { repo: backfill });
    } catch (error) {
      return cannot(
        `${path} could not be written: ${String(error.message ?? error)}`,
        `ls -l ${path}   # the attempt is still unsettled; nothing partial was written (./record.mjs writes atomically)`,
      );
    }

    ok(`settled ${request} — every pane of ${task}'s ${rows.length} dispatch(es) is a corpse on a host this list read`);
    if (backfill !== '') note(`repo backfilled to ${backfill} — the frontier reads this record in ${backfill} from now on, and skips it in every other repository`);
    note(`the frontier can classify it attempt-ended-unmerged now. No pane was released, closed or stopped: this verb writes one record flag.`);
    return 0;
  }
}
