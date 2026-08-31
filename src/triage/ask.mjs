// `ax triage ask` — the child's escalation, sent from its own draft and nowhere
// else.
//
// The questions that go on the wire ARE the draft's `Q<n>:` lines, read back off
// disk at send time. That is the whole reason this verb exists instead of the
// spec naming `orca orchestration ask` raw (which it did, for one commit): a
// child typing its own `--question` can ask something other than what its draft
// records, and then the answer closes a question that is not on file. Here the
// two cannot diverge, because there is only one source.
//
// The transport is Orca's, measured from the shipped runtime on 2026-08-22
// (app.asar, orchestration.ask): the call BLOCKS until answered; `--json` prints
// a BARE object (no ok/result envelope) whose fields are `answer`, `messageId`,
// `threadId`, `timedOut`, `cancelled`, `connectionLost`, `timeoutMs`; a timeout
// leaves the question PENDING under `messageId`, and `--resume <messageId>` goes
// back to waiting on that same question. Errors (`dispatch_inactive`,
// `question_not_found`, …) come as the usual envelope. From an active Dispatch
// the question defaults to its owning Run mailbox, so no addressing is needed.
//
// Exit codes follow the house grammar (ADR 0003, worker/start.mjs):
//   0  answered — the ruling is printed, and the draft is the next edit
//   1  refused with a named reason
//   2  usage
//   3  cannot establish — the machine, not the caller
//   4  PENDING — the question survived the wait; recover with --resume

import { join } from 'node:path';

import { repoPaths } from '../config.mjs';
import { bad, fix, note, raw } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { redactSecrets } from '../redact.mjs';
import { askBegin, askSettle, defaultStore, heldRepaired, recordsForAsk } from '../worker/record.mjs';
import { ownCapability } from '../worker/capability.mjs';
import { defaultExec } from '../exec.mjs';
import { repoSlug } from '../gh.mjs';
import { draftDirFor, passesOf, questionProblem, readDraft, requestFor } from './draft.mjs';
import { composeAsk } from './rulings.mjs';
import { REFINE_REMOVED } from './spec.mjs';

const USAGE =
  'ax triage ask --issue N [--pass P] [--job triage|brief|custom] [--repo <owner/repo>] [--dispatch-capability <token>] [--timeout-ms <n>] [--dry-run]\n'
  + '       ax triage ask --resume <message_id> [--dispatch-capability <token>] [--timeout-ms <n>]\n'
  + '\n'
  + 'Exit codes — a blocked child routes on these alone:\n'
  + '  0  answered — the rulings are printed; revise the draft, then report\n'
  + '  1  refused — the reason is named, and the repair line says what to do\n'
  + '  2  usage\n'
  + '  3  cannot establish — the machine, not you\n'
  + '  4  PENDING — the question outlived the wait; resume the printed id\n';

/**
 * The wait this verb starts, and the margin that keeps ax from killing `orca`
 * in the window where the runtime has already decided but the receipt is still
 * in flight — a kill there loses the messageId that names the recovery.
 *
 * THE DEFAULT IS NOT THE SERVER'S. Orca's own default is 600s (measured from
 * the shipped orchestration-ask-timeout.js, 2026-08-22) and mirroring it put
 * one call at 620s of wall clock, while the agent harness running the child
 * kills bash at 600s. Measured 2026-08-26 on ofmchat #87: killed at 600.09s
 * with NO output, losing exactly the receipt this margin exists to protect, and
 * the child concluded nothing had landed. So the default fits WHOLE inside a
 * 600s budget, receipt included; a caller who wants the server's ceiling passes
 * --timeout-ms and owns a budget to match.
 */
export const ASK_DEFAULT_TIMEOUT_MS = 540_000;
export const ASK_MAX_TIMEOUT_MS = 1_800_000;
export const ASK_EXIT_MARGIN_MS = 20_000;

/**
 * Backoff between internal retries of a `runtime_busy` refusal, and the whole
 * budget this verb spends on one before it hands the caller an exit.
 *
 * Measured 2026-08-27 (ofmchat #83): `long-poll capacity reached` is Orca's
 * GLOBAL long-poll guard (runtime-rpc.ts:1563-1565, LONG_POLL_CAP=16, shared
 * with terminal.wait, check --wait and browser-host attachments), and it stood
 * for over an hour. So retrying is worth exactly one thing — absorbing a blip
 * the child should never have seen — and nothing beyond it: refused asks are
 * SHED, not queued, so no amount of waiting earns priority.
 *
 * 30s total, deliberately small. The expensive failure was not a short retry
 * budget; it was the absence of an exit at the end of one, which sent a child
 * into 11 hand-rolled attempts over 62 minutes.
 */
const ASK_BUSY_BACKOFF_MS = [2_000, 8_000, 20_000];

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

/** Is this receipt Orca refusing to admit the long poll at all? */
const busyRefusal = out => (out.receipt ?? {}).ok === false && (out.receipt?.error?.code ?? '') === 'runtime_busy';

export function ask(argv = [], { resolve = resolveOrca, runner, exec = defaultExec, env = process.env, cwd = process.cwd(), sessionsRoot, sleep = sleepDefault } = {}) {
  const usageError = message => {
    process.stderr.write(`ax triage ask: ${message}\n${USAGE}\n`);
    return 2;
  };
  const refuse = (message, repair) => {
    bad(redactSecrets(message));
    if (repair) fix(redactSecrets(repair));
    return 1;
  };
  const cannot = (message, repair) => {
    bad(redactSecrets(`CANNOT ESTABLISH — ${message}`));
    if (repair) fix(redactSecrets(repair));
    return 3;
  };

  // ── 1. arguments ───────────────────────────────────────────────────────────
  let issue = '';
  let job = 'triage';
  let repo = '';
  let passArg = '';
  let timeoutArg = '';
  let resume = '';
  let capabilityArg = '';
  let dry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--issue') issue = value();
    else if (arg === '--job') job = value();
    else if (arg === '--repo') repo = value();
    else if (arg === '--pass') passArg = value();
    else if (arg === '--timeout-ms') timeoutArg = value();
    else if (arg === '--resume') resume = value();
    else if (arg === '--dispatch-capability') capabilityArg = value();
    else if (arg === '--dry-run') dry = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }

  if (job === 'refine') return usageError(REFINE_REMOVED);

  // Exactly one mode, like the transport underneath: a new ask reads the draft,
  // a resume waits on a question that already exists and needs nothing local.
  if ((issue !== '' ? 1 : 0) + (resume !== '' ? 1 : 0) !== 1) {
    return usageError('choose exactly one of --issue (a new ask, from the draft) or --resume <message_id> (back to a pending one)');
  }
  if (issue !== '' && !/^[1-9][0-9]*$/.test(issue)) return usageError(`--issue expects a number, got "${issue}"`);
  if (passArg !== '' && !/^[1-9][0-9]*$/.test(passArg)) return usageError(`--pass expects a number, got "${passArg}"`);
  if (timeoutArg !== '' && !/^[1-9][0-9]*$/.test(timeoutArg)) return usageError(`--timeout-ms expects a number of milliseconds, got "${timeoutArg}"`);
  const timeout = timeoutArg === '' ? ASK_DEFAULT_TIMEOUT_MS : Math.min(Number(timeoutArg), ASK_MAX_TIMEOUT_MS);

  // ── 2. the ask, composed from the draft (never improvised) ────────────────
  let body = '';
  // The record of the pass this ask belongs to, kept for the verdict below: a
  // `dispatch_inactive` refusal can PROVE the repaired-stall case by reading
  // `heldRepairAt` off this file instead of asserting a disjunction — the same
  // rule as everywhere else, a measure available is consulted at the verdict.
  let recordPath = '';
  const store = defaultStore(env);
  // Hoisted for the same reason: it selects THIS pass's session file when the
  // capability has to be read off disk, and triage passes share one checkout.
  let request = '';
  // Hoisted too: the write-ahead intent names the exact draft this ask was
  // composed from, so a reader can tell a settled question from one asked
  // against a draft the child has since rewritten.
  let sha = '';
  if (issue !== '') {
    const paths = repoPaths(cwd);
    if (!paths.root) return refuse('not inside a git repository — the draft this ask reads lives in one');
    const root = paths.root;

    const slug = repo === '' ? repoSlug(args => exec('gh', args, root)) : repo;
    if (slug === '') return refuse('could not resolve the current repository', `ax triage ask --issue ${issue} --repo <owner>/<repo>`);

    const base = { job, repo: slug, issue };

    const passes = passesOf(store, draftDirFor(root), base);
    if (passes.length === 0) {
      return refuse(`no pass of #${issue} exists here — nothing was dispatched and no draft was written`, `ax triage dispatch --issue ${issue} --job ${job}`);
    }
    // The NEWEST pass by default: at most one child per issue is alive (the
    // dispatch gates enforce it), and it is always the newest. `--pass` stays an
    // override so a hand run can name what it means.
    const pass = passArg === '' ? passes[passes.length - 1] : Number(passArg);
    if (!passes.includes(pass)) {
      return refuse(`pass ${pass} of #${issue} does not exist (existing: ${passes.join(', ')})`, `ax triage status --issue ${issue} --job ${job}`);
    }

    const identity = { ...base, pass };
    const draft = readDraft(root, identity);
    if (draft.sha === '') {
      return refuse(draft.reason, `write ${draft.path} first — the ask sends the draft's own Q<n>: lines, never improvised ones`);
    }
    if (draft.questions.length === 0) {
      return refuse(`the draft at ${draft.path} carries no Q<n>: line — there is nothing to ask`, 'write one `Q<n>: <question>` line per open decision into the draft, then re-run');
    }
    const problem = questionProblem(draft.questions);
    if (problem !== null) {
      return refuse(problem, `renumber the Q<n>: lines in ${draft.path} — 1..n, consecutive, no repeats — then re-run`);
    }
    request = requestFor(identity);
    recordPath = join(store, `${request}.json`);
    sha = draft.sha;
    body = composeAsk({ request, sha, questions: draft.questions, issue, job });
  }

  // A RESUME CARRIES NO IDENTITY BUT ITS ID, so the pass it belongs to is
  // recovered from that id. Without this the prescribed post-timeout path —
  // the ordinary one — settled nothing, and the record stayed `pending` for
  // good: status kept advertising an answered question and the pass's next
  // question was refused as a duplicate.
  if (resume !== '') {
    const found = recordsForAsk(store, resume);
    // UNIQUE means unique among records this process could READ. An unreadable
    // record may claim the same id, so one readable match beside one unreadable
    // file is not proof of ownership — it is the same ambiguity as two matches,
    // and settling on it would write an outcome onto a pass that may not own
    // this question (F-028). The ruling still reaches the child either way; the
    // record is a side effect, not the payload.
    if (found.paths.length === 1 && found.unreadable.length === 0) recordPath = found.paths[0];
    else if (found.paths.length > 1) {
      note(`${found.paths.length} records claim ${resume} — none will be settled, because choosing between them would be a guess`);
    } else if (found.paths.length === 1) {
      note(`1 record claims ${resume} but ${found.unreadable.length} could not be read — none will be settled, because uniqueness cannot be established`);
    }
    if (found.unreadable.length > 0) note(`  unreadable while looking for ${resume}: ${found.unreadable.join(', ')}`);
  }

  if (dry) {
    if (body !== '') raw(body);
    else note(`would resume ${resume} and wait ${timeout}ms`);
    return 0;
  }

  // ── 3. the machine, only now that there is something valid to send ─────────
  const bin = runner ? null : resolve({ env });
  if (!runner && bin === null) return cannot('no Orca CLI on this machine — an ask crosses the Orca mailbox, so none can be sent from here');
  // No injected exec here: the default 30s would kill a wait this verb starts on
  // purpose. The runner's own budget is the server's, plus the margin above.
  const run = runner ?? createRunner({ bin, timeoutMs: timeout + ASK_EXIT_MARGIN_MS });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # nothing was sent — re-run once the runtime answers');

  // THE CAPABILITY IS RE-TYPED, NEVER INHERITED. `--from` self-resolves from the
  // pane's own environment, but this token has no env fallback anywhere in
  // Orca's source, so a wrapper that omits it is refused
  // `dispatch_capability_invalid` — measured on two independent triage
  // dispatches, 2026-08-26. The flag wins when a caller passes it; otherwise it
  // comes off the child's own preamble, which is where Orca put it.
  const capability = capabilityArg !== '' ? { token: capabilityArg, reason: '' } : ownCapability({ cwd, request, env, sessionsRoot });
  const authorized = capability.token === '' ? [] : ['--dispatch-capability', capability.token];

  const wire = issue !== ''
    ? ['orchestration', 'ask', '--question', body, ...authorized, '--timeout-ms', String(timeout), '--json']
    : ['orchestration', 'ask', '--resume', resume, ...authorized, '--timeout-ms', String(timeout), '--json'];

  // WRITE-AHEAD, and it can REFUSE. A live lifecycle (`asking` — issued,
  // outcome unknown — or `pending`/`replying`) means a question from this pass
  // may already be open on the parent's mailbox, and a second one would let a
  // ruling keyed by number reach either. `--resume` skips this: it carries no
  // identity to record and mints nothing.
  // The write-ahead intent belongs to a NEW question only. `--resume` mints
  // nothing: it goes back to waiting on one that already exists, so it records
  // no intent — but it must still be able to settle the outcome, which is why
  // `recordPath` was recovered from the id above.
  if (issue !== '') {
    let began;
    try {
      began = askBegin(recordPath, { request, sha, argv: wire });
    } catch (error) {
      return cannot(
        `could not record this ask: ${String(error.message ?? error)} — nothing was sent, because a mutation issued from no record cannot be recovered (F-001)`,
        'ax triage status   # what this pass recorded, and whether a child is behind it',
      );
    }
    if (!began.ok) {
      bad(`this pass already has a question in flight (${began.state}${began.messageId ? ` on ${began.messageId}` : ', outcome never recorded'}) — a second ask would put two questions on one draft`);
      if (began.messageId) fix(`ax triage ask --resume ${began.messageId} --timeout-ms ${timeout}   # go back to waiting on the SAME question`);
      else fix('ax triage status   # the mailbox is the authority on whether it landed; answer THAT id rather than asking again');
      return 1;
    }
  }

  /** Settle the lifecycle, or say why it could not be. */
  const settle = (state, { messageId = null, code = null } = {}) => {
    if (recordPath === '') return;
    try {
      askSettle(recordPath, { state, messageId, code });
    } catch (error) {
      // The mutation already happened; refusing now would be theatre. But a
      // reader that cannot see the outcome must be told, not left to infer it.
      note(redactSecrets(`  the ask landed but its outcome could not be recorded: ${String(error.message ?? error)}`));
    }
  };

  // The blip absorber. Bounded on purpose — see ASK_BUSY_BACKOFF_MS.
  let out = run(wire);
  let attempts = 1;
  let waited = 0;
  for (const pause of ASK_BUSY_BACKOFF_MS) {
    if (!busyRefusal(out)) break;
    sleep(pause);
    waited += pause;
    attempts += 1;
    out = run(wire);
  }

  // ── 4. the receipt, on the measured shapes and no others ──────────────────
  if (out.error) {
    return cannot(`orca orchestration ask did not finish: ${String(out.error)} — the question may still be pending`, 'ax triage status   # the pending question, if it exists, is named there');
  }
  const receipt = out.receipt ?? {};
  if (receipt.unparseable !== undefined) {
    return cannot(`orca orchestration ask did not answer JSON: ${String(receipt.unparseable).slice(0, 200)}`);
  }
  if (receipt.ok === false) {
    const code = receipt.error?.code ?? '';
    // A NAMED refusal is a proven terminal outcome: nothing was minted, so the
    // lifecycle closes and a later ask may legitimately begin. The generic
    // `cannot` at the end deliberately does NOT settle — an unrecognized
    // failure leaves `asking`, the honest "issued, outcome unknown", which is
    // what stops a blind re-ask from doubling a question that may exist.
    if (['dispatch_inactive', 'dispatch_capability_invalid', 'question_not_found', 'runtime_busy'].includes(code)) {
      settle('refused', { code });
    }
    // Untrusted runtime output, exactly like a transcript: the preamble embeds
    // the dispatch capability, and an error message that quotes the request
    // can quote the token with it. Redacted HERE, once, because the branches
    // below emit through bad()/note()/fix() directly rather than refuse/cannot.
    const detail = redactSecrets(receipt.error?.message ?? 'unnamed error');
    if (code === 'dispatch_inactive') {
      // Proven when it can be: in question mode this pass's own record says
      // whether a repaired composer stall is what killed the capability
      // (`heldRepairAt` is written only after a confirmed submission behind a
      // `failed` Dispatch — start.mjs documents that child as NOT A SUPERVISED
      // WORKER, and 3/3 children of the first equipped wave, 2026-08-23, hit
      // exactly this). A child told the truth follows its fallback; a child
      // accused of not being a dispatched session — the first cut of this
      // refusal — improvises. On `--resume` there is no identity to consult,
      // so the refusal stays a named disjunction rather than a guess.
      if (recordPath !== '' && heldRepaired(recordPath)) {
        bad(`${detail} — this pass's own record proves why: its Dispatch settled \`failed\` at the composer stall and the capability died with the settlement, so this child runs UNSUPERVISED and no ask can ever land from it`);
        fix('keep the Q<n>: lines in the draft, and report NOW — quote them, and say the supervised channel is unavailable; your peer report is the one channel that still reaches the parent, and it answers by peer');
        note('do not decide the open questions yourself, and do not drop them from the draft until the answers arrive');
        return 1;
      }
      bad(`${detail} — either this session was never a dispatched child, or its Dispatch is no longer active`);
      fix('ax triage status   # what this issue\'s passes recorded, and whether a child is behind them');
      return 1;
    }
    if (code === 'dispatch_capability_invalid') {
      // The code the generic branch below used to swallow, on both dispatches
      // that measured it: exit 3 with no repair, and a child that improvised.
      // Two different failures wear this one code, and only the first is the
      // caller's to fix — so the reason names which one this is.
      bad(`${detail} — the ask carried ${capability.token === '' ? 'NO capability' : 'a capability this runtime rejected'}`);
      if (capability.token === '') {
        note(`  could not read one: ${capability.reason}`);
        fix('ax triage ask --issue <n> --dispatch-capability <token>   # the token is in YOUR preamble, on the `orchestration ask` line it teaches');
      } else {
        note('  the token was read off this session\'s own preamble, so it is the one this child was dispatched with — a runtime that rejects it has re-minted or settled the Dispatch');
        fix('ax triage status   # whether this pass\'s Dispatch is still active');
      }
      note('either way the questions stay in the draft: quote them in your report and say the supervised channel is unavailable, rather than deciding them yourself');
      return 1;
    }
    if (code === 'question_not_found') {
      return refuse(`${detail} — a resume only reaches a question this same Dispatch asked`, 'ax triage status   # which questions are actually pending');
    }
    if (code === 'runtime_busy') {
      // The arm that did not exist. Measured 2026-08-27 on ofmchat #83: this
      // fell into the generic branch below, so the child got exit 3 with no
      // repair, no message id and therefore nothing to resume — while the spec
      // sentence permitted reporting with an open question ONLY on the
      // `not supervised` refusal. It retried 11 times over 62 minutes and its
      // advisors correctly blocked every other exit. A refusal with no exit is
      // a trap, and the trap was ax's, not the child's.
      bad(`${detail} — after ${attempts} attempts over ${Math.round(waited / 1000)}s, no ask could be admitted`);
      note('  this is the RUNTIME\'s long-poll budget, shared with terminal waits and browser hosts — not your draft, and not this repository');
      note('  refused asks are shed, not queued, so a hand-rolled retry loop earns no priority, and no message id is minted on this path — there is nothing to go back to');
      fix('keep the Q<n>: lines in the draft, and report NOW — quote them, and say the supervised channel is at long-poll capacity');
      note('do not decide the open questions yourself, and do not drop them from the draft');
      return 3;
    }
    return cannot(`orca refused the ask (${code || 'no code'}): ${detail}`);
  }
  // An id is the ONLY thing that makes a surviving question recoverable, so a
  // receipt without one is an unknown outcome and not a pending question. Both
  // halves matter: settling `pending` with a null id would block every later ask
  // on a question nothing can resume, and the repair line below printed
  // `--resume undefined` when the runtime answered without one.
  const minted = typeof receipt.messageId === 'string' && receipt.messageId !== '' ? receipt.messageId : '';
  if ((receipt.timedOut === true || receipt.cancelled === true) && minted === '') {
    return cannot(
      `the wait ended (${receipt.timedOut === true ? 'timed out' : 'cancelled'}) and the receipt named NO message id — a question may be open and nothing here can resume it; this pass stays recorded as issued-outcome-unknown`,
      'ax triage status   # the mailbox is the authority on whether a question landed, and names the id if one did',
    );
  }
  if (receipt.timedOut === true) {
    settle('pending', { messageId: minted });
    bad(`no answer within ${receipt.timeoutMs ?? timeout}ms — the question is PENDING, not dead`);
    note(redactSecrets(`message ${minted} stays open on the parent's mailbox; do not report, do not end your turn, do not decide it yourself`));
    // The global command delegates to the exact package version this repo
    // pinned. A parked child copies this repair verbatim, so it must use the
    // same entry point the generated AGENTS.md teaches.
    fix(redactSecrets(`ax triage ask --resume ${minted} --timeout-ms ${timeout}   # goes back to waiting on the SAME question`));
    return 4;
  }
  if (receipt.cancelled === true) {
    // A cut wait leaves a question that MAY exist under this id — so the
    // lifecycle stays `pending` rather than closing, and the id is on record
    // for the resume the repair names.
    settle('pending', { messageId: minted });
    return cannot(
      `the wait was cut (${receipt.connectionLost === true ? 'connection lost' : 'cancelled'}) — question ${minted} may still be pending`,
      `ax triage ask --resume ${minted}   # nothing was lost; go back to waiting`,
    );
  }
  if (typeof receipt.answer === 'string') {
    settle('answered', { messageId: receipt.messageId ?? null });
    raw(redactSecrets(receipt.answer));
    note('revise the draft with what this decides — drop the Q<n>: lines the rulings close — and only then report');
    return 0;
  }
  return cannot(`orca orchestration ask answered an unrecognized receipt: ${JSON.stringify(receipt).slice(0, 200)}`);
}
