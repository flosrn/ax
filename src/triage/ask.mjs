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
import { defaultStore, heldRepaired } from '../worker/record.mjs';
import { defaultExec } from '../worker/release.mjs';
import { DRAFT_DIR, passesOf, questionProblem, readDraft, requestFor } from './draft.mjs';
import { composeAsk } from './rulings.mjs';

const USAGE =
  'ax triage ask --issue N [--pass P] [--job triage|brief|custom] [--repo <owner/repo>] [--timeout-ms <n>] [--dry-run]\n'
  + '       ax triage ask --resume <message_id> [--timeout-ms <n>]';

/**
 * The server's own clamp, mirrored so the local process outlives the wait it
 * starts. Measured from the shipped orchestration-ask-timeout.js (2026-08-22):
 * default 600s, hard cap 1800s, and Orca's own CLI waits clamped+5s. The margin
 * keeps ax from killing `orca` in the window where the runtime has already
 * decided (answered or timed out) but the receipt is still in flight — a kill
 * there loses the messageId that names the recovery.
 */
export const ASK_DEFAULT_TIMEOUT_MS = 600_000;
export const ASK_MAX_TIMEOUT_MS = 1_800_000;
const ASK_EXIT_MARGIN_MS = 20_000;

export function ask(argv = [], { resolve = resolveOrca, runner, exec = defaultExec, env = process.env, cwd = process.cwd() } = {}) {
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
    else if (arg === '--dry-run') dry = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }

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
  if (issue !== '') {
    const paths = repoPaths(cwd);
    if (!paths.root) return refuse('not inside a git repository — the draft this ask reads lives in one');
    const root = paths.root;

    let slug = repo;
    if (slug === '') {
      const out = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root);
      slug = out.error || out.status !== 0 ? '' : String(out.stdout ?? '').trim().split('\n')[0];
    }
    if (slug === '') return refuse('could not resolve the current repository', `ax triage ask --issue ${issue} --repo <owner>/<repo>`);

    const base = { job, repo: slug, issue };
    const store = defaultStore(env);
    const passes = passesOf(store, join(root, DRAFT_DIR), base);
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
    const request = requestFor(identity);
    recordPath = join(store, `${request}.json`);
    body = composeAsk({ request, sha: draft.sha, questions: draft.questions });
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

  const out = run(
    issue !== ''
      ? ['orchestration', 'ask', '--question', body, '--timeout-ms', String(timeout), '--json']
      : ['orchestration', 'ask', '--resume', resume, '--timeout-ms', String(timeout), '--json'],
  );

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
    if (code === 'question_not_found') {
      return refuse(`${detail} — a resume only reaches a question this same Dispatch asked`, 'ax triage status   # which questions are actually pending');
    }
    return cannot(`orca refused the ask (${code || 'no code'}): ${detail}`);
  }
  if (receipt.timedOut === true) {
    bad(`no answer within ${receipt.timeoutMs ?? timeout}ms — the question is PENDING, not dead`);
    note(redactSecrets(`message ${receipt.messageId} stays open on the parent's mailbox; do not report, do not end your turn, do not decide it yourself`));
    // The global command delegates to the exact package version this repo
    // pinned. A parked child copies this repair verbatim, so it must use the
    // same entry point the generated AGENTS.md teaches.
    fix(redactSecrets(`ax triage ask --resume ${receipt.messageId} --timeout-ms ${timeout}   # goes back to waiting on the SAME question`));
    return 4;
  }
  if (receipt.cancelled === true) {
    return cannot(
      `the wait was cut (${receipt.connectionLost === true ? 'connection lost' : 'cancelled'}) — question ${receipt.messageId} may still be pending`,
      `ax triage ask --resume ${receipt.messageId}   # nothing was lost; go back to waiting`,
    );
  }
  if (typeof receipt.answer === 'string') {
    raw(redactSecrets(receipt.answer));
    note('revise the draft with what this decides — drop the Q<n>: lines the rulings close — and only then report');
    return 0;
  }
  return cannot(`orca orchestration ask answered an unrecognized receipt: ${JSON.stringify(receipt).slice(0, 200)}`);
}
