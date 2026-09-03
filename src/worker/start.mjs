// `ax worker start` — create one supervised Orca worker, never two.
//
// The record is written before every resource-creating mutation. A recovery may
// only replay the argv already on disk, byte for byte; it never reconstructs a
// command and never mints a new identity because a live-state snapshot looks
// empty. That is F-001: the snapshot cannot see a mutation still in flight.
//
// Exit codes belong to this verb (ADR 0003):
//   0  USABLE (or --show succeeded)
//   1  refused with a named reason
//   2  duplicate proved by --replace's gate
//   3  cannot establish — never permission
//   4  fresh mutation STRANDED — recover with --resume

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { createRunner, resolveOrca } from '../orca-bin.mjs';
import { redactSecrets } from '../redact.mjs';
import { bad, fix, note, ok, raw, section, status } from '../log.mjs';
import { gate } from './gate.mjs';
import {
  acquireLock,
  attemptNew,
  argvValue,
  claimRecord,
  defaultStore,
  initRecord,
  newIdentity,
  phaseArgv,
  phaseBegin,
  phaseCount,
  phaseEnd,
  phaseVerdict,
  recordedBin,
  recordedRun,
  recordRepo,
  report,
  requestIdOk,
  staleClaim,
  taskId,
  taskIdScan,
  taskUpdateOk,
} from './record.mjs';
import { briefDelivered } from './delivered.mjs';

const STALL_MODULE = fileURLToPath(new URL('./stall.mjs', import.meta.url));
// No sleep here any more: nothing in this verb waits on a pane. The cursor
// polling that used to live in `ensureSpecSubmitted` is gone with it, and the
// one place that still measures a pane over time is `ax worker repair`.

const usage = 'ax worker start --request <id> --run <run_id> --spec-file <path> [-- <worker-start args>]';

function refuse(message, repair = '') {
  bad(redactSecrets(`REFUSED — ${message}`));
  if (repair) fix(redactSecrets(repair));
  return 1;
}

function cannot(message, repair = '') {
  bad(redactSecrets(`CANNOT ESTABLISH — ${message}`));
  note('This is NOT permission to start a fresh dispatch.');
  if (repair) fix(redactSecrets(repair));
  return 3;
}

function callerBug(message) {
  bad(redactSecrets(message));
  fix(redactSecrets(usage));
  return 1;
}


function parse(argv) {
  let mode = 'start';
  let modeSeen = false;
  let request = '';
  let runId = '';
  let specFile = '';
  let explicitOrca = '';
  // Why the caller overrode a ticket's own assignment (`ax worker dispatch
  // --task … --because …`, R4/KTD3). AX-OWNED, so it is consumed here and never
  // reaches the passthrough: Orca's `worker-start` knows no such flag, and an
  // unrecognised argument forwarded to it fails the dispatch instead of
  // recording the reason. It is provenance, written once at init and never read
  // by a mutation — so a record that carries it and one that does not are the
  // same record to every recovery path.
  let because = '';
  // WHICH repository the dispatched ticket lives in (`--tracker-repo`,
  // ax-owned like `--because`): the store is host-global, and the frontier
  // uses this name to tell one checkout's `42-…` record from another's.
  let trackerRepo = '';
  let passthru = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthru = argv.slice(i + 1);
      break;
    }
    if (['--resume', '--replace', '--show'].includes(arg)) {
      if (modeSeen) return { error: 'choose only one of --resume, --replace or --show' };
      mode = arg.slice(2);
      modeSeen = true;
      continue;
    }
    const fields = [
      ['--request', value => { request = value; }],
      ['--run', value => { runId = value; }],
      ['--spec-file', value => { specFile = value; }],
      ['--orca', value => { explicitOrca = value; }],
      ['--because', value => { because = value; }],
      ['--tracker-repo', value => { trackerRepo = value; }],
    ];
    const split = fields.find(([name]) => arg === name);
    if (split) {
      i += 1;
      if (argv[i] === undefined) return { error: `${split[0]} needs a value` };
      split[1](argv[i]);
      continue;
    }
    const joined = fields.find(([name]) => arg.startsWith(`${name}=`));
    if (joined) {
      joined[1](arg.slice(joined[0].length + 1));
      continue;
    }
    passthru.push(arg);
  }

  return { mode, request, runId, specFile, explicitOrca, because, trackerRepo, passthru };
}

/** Refusals that must happen before binary resolution, claim or mutation. */
function placementRefusal(passthru) {
  const worktree = argvValue(passthru, '--worktree') ?? '';
  const on = argvValue(passthru, '--on') ?? '';
  if (worktree === 'new-child') {
    return 'worker-start --worktree new-child is not recoverable: create it first, then pass --worktree "path:<abs>"';
  }
  if (on && ['current', 'new-child'].includes(worktree)) {
    return `remote placement --on ${on} cannot resolve --worktree ${worktree}; use --on ${on} --worktree new-top-level --repo id:<uuid>`;
  }
  return '';
}

/**
 * The four options ax owns. They ARE the F-001 identity: `--task` and `--run`
 * name what is being mutated, `--retry-request` is the fingerprint Orca
 * deduplicates on, and `--json` is the receipt the record is written from. A
 * caller passing one of them again would either mutate a different task than
 * the record names or hand Orca two fingerprints for one dispatch, so the
 * duplicate is refused BEFORE any claim or mutation — never silently dropped,
 * never appended twice. Everything else (`--from`, `--model`, `--effort`, the
 * placement flags) stays opaque and is forwarded untouched.
 */
const RESERVED = ['--task', '--run', '--retry-request', '--json'];

function reservedRefusal(passthru) {
  const taken = RESERVED.find(name => passthru.some(arg => arg === name || arg.startsWith(`${name}=`)));
  if (!taken) return '';
  return `worker-start passthrough may not carry ${taken}: ax owns ${RESERVED.join(', ')} — they are the recorded dispatch identity`;
}

function phaseRun(path, name, args, { bin, execute, identity = newIdentity() }) {
  const full = [bin, ...args];
  phaseBegin(path, { name, identity, argv: full });
  const out = execute(full);
  phaseEnd(path, 'last', { exit: out.status, receiptText: out.stdout, stderr: out.stderr, error: out.error });
  return phaseVerdict(path, 'last');
}

function stranded(request) {
  bad('STRANDED — the recorded mutation may still be running. Do not start a new request.');
  fix(redactSecrets(`ax worker start --resume --request ${request}`));
  return 4;
}

/**
 * The exit for a phase that did not simply succeed, and the one place where
 * "refused" and "nobody knows" must not be collapsed.
 *
 * An `unknown` outcome — a call that never concluded, an illegible receipt —
 * may have COMMITTED the mutation. Freshly, that is exactly STRANDED (4), the
 * caller's cue to recover. Under --resume/--replace the record already exists,
 * so the answer is a refusal that points at the same exact replay: reporting it
 * as an Orca rejection is how an operator concludes "it failed, start again"
 * over a worker that is running.
 */
function phaseFailure(verdict, { request, fresh: isFresh = false } = {}) {
  if (verdict.verdict === 'mismatch') {
    return refuse(
      `Orca refused the exact recorded request: ${String(verdict.evidence).slice(0, 300)}. Do not 'fix' this by minting a new identity.`,
      'ax worker start --resume --request <same_request>',
    );
  }
  if (verdict.verdict === 'failed') {
    return refuse(`Orca rejected the recorded mutation: ${JSON.stringify(verdict.evidence).slice(0, 300)}`);
  }
  if (verdict.verdict === 'unknown') {
    if (isFresh) return stranded(request);
    return refuse(
      `the recorded mutation's outcome is UNKNOWN — Orca never answered it, so it may be running: ${String(verdict.evidence).slice(0, 300)}`,
      `ax worker start --resume --request ${request}`,
    );
  }
  return null;
}

function summarize(path) {
  const result = report(path);
  const summary = result.summary;
  note(redactSecrets(`${result.mode} — dispatch=${summary.dispatchId ?? '—'} stage=${summary.stage ?? '—'} state=${summary.state ?? '—'}`));
  return result;
}

/**
 * Does the child have its brief? `'delivered'` or `'unproven'`, and NOTHING is
 * ever sent to the pane from here.
 *
 * This function used to type one Enter into a pane whose cursor had not moved,
 * and report that as the repair. Three findings killed that, in order:
 *
 *   1. The cursor cannot tell a held composer from a child waiting on a model.
 *      15 dispatches of 15 on 2026-08-24 were working children; #56 recorded its
 *      brief at 10:49:40.338Z and the "repair" Enter went in at 10:49:48.203Z.
 *   2. Movement after the Enter proves nothing either — the model answering
 *      reads exactly like a brief being submitted.
 *   3. And once the witness is the child's own session, a HELD composer can no
 *      longer be recognised automatically at all: the only token tying a session
 *      to this dispatch is the `ctx_…` in Orca's preamble, and an unsubmitted
 *      preamble is precisely what a held composer is holding. So the automatic
 *      path would have had to act on `unproven`, which is what (1) forbids.
 *
 * The Enter therefore has ONE owner left: `ax worker repair`, invoked by an
 * operator against one named request, which probes the cursor, sends the Enter
 * as a discriminator, and only then decides. An automatic gesture that cannot
 * name what it is repairing does not get to touch a live pane.
 */
export function briefWitness(path, { env = process.env, sessionsRoot } = {}) {
  const witness = briefDelivered(path, { env, sessionsRoot });
  if (witness.known && witness.delivered) {
    ok(redactSecrets(`BRIEF DELIVERED — the child's own session recorded it${witness.at ? ` at ${witness.at}` : ''}.`));
    return 'delivered';
  }
  note(redactSecrets(`BRIEF NOT PROVEN — ${witness.known ? `the child's session names no user message yet` : witness.reason}.`));
  return 'unproven';
}

/**
 * Spawn the fail-open watcher as a separate process; the caller exits
 * immediately. FAIL-OPEN is the whole contract: a watcher that cannot be armed
 * says so and the dispatch stands — a supervisor must never be able to fail a
 * worker that is already running. There are three ways it can fail, and all
 * three end the same way: the module is absent, `spawn` throws synchronously,
 * or the child fails asynchronously (ENOENT on the interpreter arrives on the
 * 'error' event, after this function has returned — unhandled, it would take
 * the process down at a point where the mutation is already committed).
 */
export function armStallWatcher({ request, bin, env = process.env, spawnProcess = spawn, modulePath = STALL_MODULE } = {}) {
  if (String(env.ORCA_STALL_WATCH ?? '1') === '0') return;
  const notArmed = detail => status(redactSecrets(`stall-watch NOT armed: ${detail}`));
  if (!existsSync(modulePath)) {
    notArmed(`${modulePath} is missing.`);
    return;
  }

  const dir = env.ORCA_STALL_DIR || join(env.HOME ?? '', '.omp', 'run', 'stall-watch');
  let fd;
  try {
    const logPath = join(dir, `${request}.log`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(logPath, 'a', 0o600);
    const child = spawnProcess(process.execPath, [modulePath, '--request', request, '--orca', bin], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, ORCA_DISPATCH_STORE: defaultStore(env) },
    });
    child.on('error', error => notArmed(String(error)));
    child.unref();
    status(`STALL-WATCH armed (pid ${child.pid}) — a silent hang will be reported to the dispatching run.`);
  } catch (error) {
    notArmed(String(error));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


function finishUsable(path, context) {
  // No witness call here: a USABLE dispatch is one whose `dispatch_input` stage
  // Orca itself verified, so the brief is submitted by construction and there is
  // nothing left to establish.
  (context.arm ?? armStallWatcher)({ request: context.request, bin: context.bin, env: context.env });
  return 0;
}

/**
 * The dispatch whose pane, worktree and agent all exist, and whose Dispatch
 * settled `failed` at `dispatch_input` regardless.
 *
 * Two different failures wear this receipt, and the entry condition stays as
 * broad as the receipt allows because the recovery is the same shape for both —
 * measure whether the child has the brief, never re-dispatch. `repairHeld`
 * names which one it found.
 *
 * A HELD COMPOSER: the brief typed, the Enter missing. Measured 2026-08-22,
 * three launches on this Mac, each rescued by one Enter typed by hand. It is NOT
 * separable from the case below by any automatic reading — see `briefWitness` —
 * so `ax worker repair` owns it.
 *
 * ORCA'S READINESS VERDICT ON A HEALTHY CHILD, which is the common case:
 * 15 dispatches of 15 on 2026-08-24. `verifyAgentPromptSubmission` allows 5s
 * for the pane to report `working` through its OSC status title, a cold OMP
 * session cannot, and the Dispatch is failed with the brief already submitted.
 * ./delivered.mjs carries the mechanism, the asar coordinates and the timestamps.
 */
const heldComposer = summary =>
  summary.state === 'failed'
  && summary.stage === 'dispatch_input'
  && summary.lastError === 'agent_prompt_stalled'
  && summary.terminal !== null;

/**
 * Say what is true of this child, then say exactly what is NOT true of it.
 *
 * The child runs. It is not a supervised worker: its Dispatch already settled
 * `failed`, so its capability is revoked and every lifecycle message it sends is
 * rejected — measured 2026-08-22, `Orca rejected this worker_done: Dispatch …
 * capability is revoked`. What still reaches the orchestrator is the child's own
 * peer report and this watcher, which sends from the PARENT's pane and needs no
 * capability of the child's.
 *
 * So this is exit 3, never 0: claiming USABLE would promise a `worker_done` that
 * cannot arrive. And it never offers a re-dispatch — a second dispatch into that
 * worktree is the duplicate agent F-001 is about, and the pane it would race is
 * the one this just measured.
 */
function repairHeld(path, context) {
  // The cause line follows the evidence instead of preceding it. Announcing "the
  // brief never left the composer" before looking is how an orchestrator came to
  // relay a phantom Enter as the rescue of three children that had each been
  // working for eight seconds already.
  const outcome = briefWitness(path, context);

  if (outcome === 'delivered') {
    note('agent_prompt_stalled — the child HAS the brief: Orca allows 5s for the pane to report `working` and a cold session cannot, so it settled a working worker `failed`.');
  } else {
    note('agent_prompt_stalled — the worktree, the pane and the agent exist; nothing here proves the brief reached the child.');
  }

  // NO MARKER FROM HERE, EVER. `heldRepairAt` silences the watcher's death
  // check, and a recorded brief proves RECEIPT, not liveness — a child can
  // record its brief and then crash, and AGENTS.md is explicit that liveness is
  // cursor movement. This path deliberately reads no cursor (that reading is
  // what produced 15 false positives out of 15), so it holds no evidence that
  // could justify the marker. `ax worker repair` measures the pane and owns it.
  (context.arm ?? armStallWatcher)({ request: context.request, bin: context.bin, env: context.env });
  bad('NOT A SUPERVISED WORKER — this Dispatch settled `failed`, so its capability is revoked and any worker_done it sends will be rejected.');

  if (outcome === 'delivered') {
    note('The child has its brief: its own peer report, and the watcher armed above, are the channels that still reach you.');
  } else {
    bad('The brief is NOT PROVEN delivered either — no child is known to be working behind that pane.');
  }
  note('No repair is recorded, so the watcher above keeps its right to report this pane as a death.');
  fix(redactSecrets(`ax worker repair --request ${context.request}   # measure the pane: it owns the Enter, and records a repair on live evidence`));
  fix(redactSecrets(`ax worker transcript ${context.request}   # what it is doing. Do NOT re-dispatch: that is a second agent in one worktree.`));
  return 3;
}

/**
 * A recovery must speak to the runtime it MUTATED. `--orca` on a resume names
 * the binary this process resolved today; the pane, the dispatch and the task
 * live in the one recorded on disk, and on a host carrying both `orca` and
 * `orca-ide` those are two different runtimes (see orca-bin.mjs). The replay
 * already follows the recorded argv byte for byte, so the probes and the
 * watcher follow the same binary rather than a newly resolved one.
 */
function recoveredContext(path, context) {
  let recorded;
  try {
    recorded = recordedBin(path);
  } catch {
    return context; // A record that cannot name its binary keeps this caller's.
  }
  if (!recorded || recorded === context.bin) return context;
  note(redactSecrets(`recovering through the recorded runtime ${recorded}, not ${context.bin}`));
  return { ...context, bin: recorded, run: context.makeRun(recorded) };
}

function resume(path, context) {
  let count;
  try {
    count = phaseCount(path);
  } catch (error) {
    if (error.code === 'ENOENT') return cannot(`no record at ${path}`, 'Recover the original record; do not choose a new request id.');
    return cannot(`record at ${path} is unreadable: ${String(error)}`, 'Repair or recover that record before any retry.');
  }
  if (count === 0) return cannot(`record at ${path} has no recorded phase to replay`);

  const recovered = recoveredContext(path, context);

  for (let index = 0; index < count; index += 1) {
    let full;
    try {
      full = phaseArgv(path, index);
    } catch (error) {
      return cannot(`phase ${index} cannot be reconstructed: ${String(error)}`);
    }
    const out = recovered.execute(full);
    phaseEnd(path, index, { exit: out.status, receiptText: out.stdout, stderr: out.stderr, error: out.error });
    const failed = phaseFailure(phaseVerdict(path, index), { request: context.request });
    if (failed !== null) return failed;
  }

  const result = summarize(path);
  if (!result.usable) {
    if (heldComposer(result.summary)) return repairHeld(path, recovered);
    return refuse('the replay faithfully returned a partial mutation, not a working worker', `ax worker start --resume --request ${context.request}`);
  }
  return finishUsable(path, recovered);
}

/**
 * The replacement itself, under the record's replace lock.
 *
 * Every step here reads or acts on state a sibling replace could be changing:
 * the gate's "no live agent", the task returned to `ready`, the new attempt.
 * The lock is therefore held across ALL of them — a gate answer released before
 * the worker-start is just an old measurement.
 */
function replaceLocked(path, passthru, context) {
  let task;
  let runId;
  try {
    phaseCount(path); // readability gate before any Orca call
    task = taskIdScan(path);
    // The gate's `task-list` read is Run-scoped: unscoped, a task from another
    // Run is absent exactly as an invented one is, and the gate answers 3 on a
    // record that names its Run perfectly well.
    runId = recordedRun(path);
  } catch (error) {
    if (error.code === 'ENOENT') return cannot(`no record at ${path}`);
    return cannot(`the first phase never succeeded: ${String(error)}`);
  }

  const gateCode = (context.gateFn ?? gate)([task, '--run', runId], { runner: context.run, env: context.env });
  if (gateCode === 1) return refuse('an agent is still alive for this task — do NOT replace it');
  if (gateCode === 2) {
    bad('DUPLICATE — more than one live agent exists; replacement is forbidden.');
    return 2;
  }
  if (gateCode === 3) return cannot('the live-agent gate could not answer', `ax worker start --resume --request ${context.request}`);

  const updated = context.run(['orchestration', 'task-update', '--id', task, '--status', 'ready', '--json']);
  if (updated.status !== 0 || !taskUpdateOk(updated.receipt)) {
    return refuse('task-update did not read back ready; not replacing');
  }

  attemptNew(path);
  const identity = newIdentity();
  const args = ['orchestration', 'worker-start', '--task', task, '--retry-request', identity, ...passthru, '--json'];
  const failed = phaseFailure(phaseRun(path, 'worker-start', args, { ...context, identity }), { request: context.request });
  if (failed !== null) return failed;

  const result = summarize(path);
  if (!result.usable) return refuse('the replacement did not reach a ready worker');
  return finishUsable(path, context);
}

/**
 * One replace at a time per record, on this host. Two concurrent replaces each
 * pass the gate (neither has started anything yet), each return the task to
 * `ready`, and each start a worker — F-001 rebuilt out of two legitimate
 * recoveries. A live holder means this caller establishes nothing and mints
 * nothing.
 */
function replace(path, passthru, context) {
  const recovered = recoveredContext(path, context);
  let lock;
  try {
    lock = acquireLock(path);
  } catch (error) {
    return cannot(`the replace lock could not be taken: ${String(error)}`);
  }
  if (!lock.held) return cannot(lock.reason, `ax worker start --resume --request ${context.request}`);
  try {
    return replaceLocked(path, passthru, recovered);
  } finally {
    lock.release();
  }
}

function fresh(path, spec, passthru, context) {
  const taskIdentity = newIdentity();
  const taskArgs = [
    'orchestration', 'task-create', '--run', context.runId, '--spec', spec,
    '--retry-request', taskIdentity, '--json',
  ];
  const taskFailed = phaseFailure(phaseRun(path, 'task-create', taskArgs, { ...context, identity: taskIdentity }), {
    request: context.request,
    fresh: true,
  });
  if (taskFailed !== null) return taskFailed;

  let task;
  try {
    task = taskId(path);
  } catch (error) {
    return refuse(`task-create returned no usable task id: ${String(error)}`);
  }
  if (!/^task_[A-Za-z0-9_-]+$/.test(task)) return refuse(`task-create returned malformed id ${JSON.stringify(task)}`);

  const workerIdentity = newIdentity();
  const workerArgs = [
    'orchestration', 'worker-start', '--task', task, '--run', context.runId,
    '--retry-request', workerIdentity, ...passthru, '--json',
  ];
  const workerFailed = phaseFailure(phaseRun(path, 'worker-start', workerArgs, { ...context, identity: workerIdentity }), {
    request: context.request,
    fresh: true,
  });
  if (workerFailed !== null) return workerFailed;

  const result = summarize(path);
  if (!result.usable) {
    return heldComposer(result.summary) ? repairHeld(path, context) : stranded(context.request);
  }
  return finishUsable(path, context);
}

export function start(
  argv = [],
  {
    resolve = resolveOrca,
    runner,
    makeRunner = options => createRunner(options),
    env = process.env,
    gateFn,
    arm,
    now = () => new Date().toISOString(),
  } = {},
) {
  const parsed = parse(argv);
  if (parsed.error) return callerBug(parsed.error);
  if (!requestIdOk(parsed.request)) return callerBug(`invalid --request ${JSON.stringify(parsed.request)}`);

  const placement = placementRefusal(parsed.passthru);
  if (placement) return refuse(placement);

  const reserved = reservedRefusal(parsed.passthru);
  if (reserved) return refuse(reserved);

  const store = defaultStore(env);
  const path = join(store, `${parsed.request}.json`);

  if (parsed.mode === 'show') {
    try {
      raw(redactSecrets(JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 1)));
      return 0;
    } catch (error) {
      return cannot(`record at ${path} is unreadable: ${String(error)}`);
    }
  }

  let spec = '';
  if (parsed.mode === 'start') {
    if (!parsed.runId) return callerBug('--run is required for a fresh start');
    if (!parsed.specFile) return callerBug('--spec-file is required for a fresh start');
    try {
      spec = readFileSync(parsed.specFile, 'utf8');
      if (spec.length === 0) return callerBug(`--spec-file is empty: ${parsed.specFile}`);
    } catch (error) {
      return callerBug(`cannot read --spec-file ${parsed.specFile}: ${String(error)}`);
    }
  }

  const bin = parsed.explicitOrca || (runner ? 'injected' : resolve({ env }));
  if (!bin) return cannot('no Orca CLI on this machine', 'orca open   # then retry the same request');
  const makeRun = target => runner ?? makeRunner({ bin: target });
  const run = makeRun(bin);
  const execute = full => (runner ? runner(full.slice(1)) : makeRunner({ bin: full[0] })(full.slice(1)));
  const context = {
    request: parsed.request,
    runId: parsed.runId,
    bin,
    run,
    execute,
    makeRun,
    env,
    gateFn,
    arm,
  };

  section(redactSecrets(`worker start ${parsed.request}`));
  if (parsed.mode === 'resume') return resume(path, context);
  if (parsed.mode === 'replace') return replace(path, parsed.passthru, context);

  let claim;
  try {
    claim = claimRecord(store, parsed.request);
  } catch (error) {
    return cannot(`record claim failed: ${String(error)}`);
  }

  if (!claim.claimed) {
    let ownership;
    try {
      ownership = acquireLock(claim.path, { suffix: '.claim.lock' });
    } catch (error) {
      return cannot(`the claim-recovery lock could not be taken: ${String(error)}`);
    }
    if (!ownership.held) return cannot(ownership.reason, `ax worker start --resume --request ${context.request}`);

    // THE REPOSITORY RULE COMES BEFORE THE STALENESS RULE. The store is
    // host-global and a request id is `<issue>-<suffix>` with no repository in
    // it, so two checkouts' #89 share one filename. A record that NAMES another
    // repository is that checkout's dispatch — a collision, never a resume —
    // and replaying it would issue this caller's mutation under the other
    // repository's Run. Measured 2026-09-03 on flosrn/ax: `89-work`, `78-work`
    // and `83-work` were ofmchat's, every dispatch of this repository's #89
    // replayed ofmchat's record and collected `consumer_fenced`, and the
    // operator learned to pass a fresh --slug each time. `staleClaim` cannot
    // see this: those records carry a task id, which is the harshest "precious"
    // it knows. A record naming NO repository is unknown, not local (F-028,
    // `recordRepo`): it may be this checkout's own earlier dispatch, and only
    // an explicit --resume — a human reading — may replay it. Both fences need
    // the caller's own name; a caller naming no repository keeps the replay.
    try {
      if (parsed.trackerRepo !== '') {
        let owner;
        try {
          owner = recordRepo(claim.path);
        } catch {
          owner = null;
        }
        if (owner === '') {
          return cannot(
            `request ${parsed.request} is already recorded at ${claim.path} by a record that names no repository — it may be this checkout's own earlier dispatch or another's, and a replay under the wrong Run is a mutation into a foreign consumer`,
            `ax worker start --resume --request ${parsed.request}   # after reading the record's worker-start --worktree; a foreign record is repaired by writing its "repo" key, a fresh name by --slug`,
          );
        }
        if (typeof owner === 'string' && owner.toLowerCase() !== parsed.trackerRepo.trim().toLowerCase()) {
          return refuse(
            `request ${parsed.request} is already recorded by another repository (${owner}) at ${claim.path} — the store is host-global and request ids carry no repository, so this is a name collision, not a resume`,
            `ax worker dispatch --issue <n> --slug <distinct-name>   # mints a request id the other repository's record does not hold`,
          );
        }
      }

      let stale = null;
      try {
        // Re-read only AFTER serialization. A stale answer from before the
        // lock can otherwise rename a sibling's new canonical claim.
        stale = staleClaim(claim.path, parsed.runId);
      } catch {
        // An unreadable owner record is still precious: it cannot be proven stale.
      }
      if (!stale?.stale) {
        note(redactSecrets(`CLAIM LOST — ${stale?.reason ?? 'the owner record is unreadable'}; replaying the owner's record instead of minting a second identity.`));
        return resume(claim.path, context);
      }

      const stamp = now().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const foreign = `${claim.path}.foreign-${stamp}-${newIdentity()}`;
      note(redactSecrets(`stale foreign claim from ${stale.foreignRun}; preserving it at ${foreign}`));
      try {
        renameSync(claim.path, foreign);
        claim = claimRecord(store, parsed.request);
        if (!claim.claimed) return cannot('lost the record claim race after preserving a stale foreign record');
        // Install the new owner's identity before releasing the recovery lock.
        // A sibling then sees a zero-phase record and cannot call it stale.
        initRecord(claim.path, { request: parsed.request, orca: bin, because: parsed.because, repo: parsed.trackerRepo, now });
      } catch (error) {
        return cannot(`could not preserve stale foreign record: ${String(error)}`);
      }
      // MINT UNDER THE LOCK, not after it. Releasing first published a
      // half-built record: a sibling then took the recovery lock, read a record
      // holding one open phase, and replayed it — and because `phaseBegin` and
      // `phaseEnd` are load-mutate-save, that replay's write CLOBBERED the
      // phase this process was adding. `save()` is atomic per write, which
      // prevents a torn file and not a lost update.
      //
      // Measured in CI 2026-08-27 (the first run this repository ever had):
      // `two reclaimers of one closed foreign refusal serialize before minting`
      // ended with the canonical record holding `['task-create']` alone while
      // the stub log proved a full task/worker pair had been issued. A recorded
      // `worker-start` had gone missing — a pane that exists, invisible to
      // every recovery that reads this file. That is F-001 by another route,
      // and it is what the test's own name always demanded.
      //
      // Holding across the dispatch is safe here BECAUSE `acquireLock` has no
      // time-based takeover: a sibling gets `held: false` with a named reason
      // and the `--resume` repair (line 600), never a silent second mint.
      return fresh(claim.path, spec, parsed.passthru, context);
    } finally {
      ownership.release();
    }
  }

  initRecord(claim.path, { request: parsed.request, orca: bin, because: parsed.because, repo: parsed.trackerRepo, now });
  return fresh(claim.path, spec, parsed.passthru, context);
}
