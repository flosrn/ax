// `ax triage answer` — the coordinator's ruling, paired to the questions before
// anything is sent.
//
// The receiving side is a LIVE child blocked mid-analysis: whatever this verb
// sends is consumed once and acted on, with no second read. So everything that
// can be checked is checked BEFORE the reply leaves — the rulings file must
// parse (no orphan line, no empty or doubled A<n>), every draft question must
// get exactly one ruling, and the message being answered must be proven to BE
// this draft's question. The proof is not optional politeness: measured from
// the shipped runtime (2026-08-22), `orchestration reply` on a message that is
// not a question quietly lands a PLAIN message — the child stays blocked and
// nothing says so.
//
// The ruling text arrives by FILE, never on this verb's argv: the coordinator
// is an agent typing into a shell, and free text on a shell line is the one
// hazard the whole worker subsystem already routes around (spec files, brief
// files). Flags and ids on argv; bodies on disk.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoPaths } from '../config.mjs';
import { bad, fix, note, raw } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { redactSecrets } from '../redact.mjs';
import { defaultStore } from '../worker/record.mjs';
import { defaultExec } from '../exec.mjs';
import { repoSlug } from '../gh.mjs';
import { draftDirFor, passesOf, questionProblem, questionsIn, readDraft, requestFor } from './draft.mjs';
import { INBOX_WINDOW, askHeader, composeReply, pairRulings, parseRulings, questionSpan } from './rulings.mjs';

const USAGE =
  'ax triage answer --issue N --id <message_id> --file <rulings> [--pass P] [--job triage|brief|custom|refine] [--repo <owner/repo>] [--dry-run]';

export function answer(argv = [], { resolve = resolveOrca, runner, exec = defaultExec, env = process.env, cwd = process.cwd() } = {}) {
  const usageError = message => {
    process.stderr.write(`ax triage answer: ${message}\n${USAGE}\n`);
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
  let id = '';
  let file = '';
  let job = 'triage';
  let repo = '';
  let passArg = '';
  let dry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--issue') issue = value();
    else if (arg === '--id') id = value();
    else if (arg === '--file') file = value();
    else if (arg === '--job') job = value();
    else if (arg === '--repo') repo = value();
    else if (arg === '--pass') passArg = value();
    else if (arg === '--dry-run') dry = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }

  if (issue === '') return usageError('no --issue given');
  if (!/^[1-9][0-9]*$/.test(issue)) return usageError(`--issue expects a number, got "${issue}"`);
  if (passArg !== '' && !/^[1-9][0-9]*$/.test(passArg)) return usageError(`--pass expects a number, got "${passArg}"`);
  if (file === '') return usageError('no --file given — the ruling text travels by file, never on argv');
  if (id === '' && !dry) return usageError('no --id given — `ax triage status` prints the pending question\'s message id');

  // ── 2. the record: which questions this issue is actually blocked on ───────
  const paths = repoPaths(cwd);
  if (!paths.root) return refuse('not inside a git repository — the draft this answers lives in one');
  const root = paths.root;

  const slug = repo === '' ? repoSlug(args => exec('gh', args, root)) : repo;
  if (slug === '') return refuse('could not resolve the current repository', `ax triage answer --issue ${issue} --repo <owner>/<repo> …`);

  const base = { job, repo: slug, issue };
  const store = defaultStore(env);
  const passes = passesOf(store, draftDirFor(root, base), base);
  if (passes.length === 0) {
    return refuse(`no pass of #${issue} exists here — there is no draft whose questions this could answer`, `ax triage status --issue ${issue} --job ${job}`);
  }
  const pass = passArg === '' ? passes[passes.length - 1] : Number(passArg);
  if (!passes.includes(pass)) {
    return refuse(`pass ${pass} of #${issue} does not exist (existing: ${passes.join(', ')})`, `ax triage status --issue ${issue} --job ${job}`);
  }

  const draft = readDraft(root, { ...base, pass });
  if (draft.sha === '') return refuse(draft.reason, `ax triage status --issue ${issue} --job ${job}`);
  if (draft.questions.length === 0) {
    return refuse(`the draft at ${draft.path} carries no Q<n>: line — it asks nothing, so there is nothing to answer`, `ax triage status --issue ${issue} --job ${job}   # the waiting pass, if any, is named there`);
  }
  const problem = questionProblem(draft.questions);
  if (problem !== null) return refuse(problem, `repair the Q<n>: lines in ${draft.path} before answering — a ruling pairs by number`);

  // ── 3. the rulings, refused before they can half-arrive ───────────────────
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return refuse(`the rulings file cannot be read: ${String(error.message ?? error)}`, `write one A<n>: line per question to ${file || '<rulings>'}, then re-run`);
  }
  const parsed = parseRulings(text);
  if (!parsed.ok) return refuse(`${file}: ${parsed.reason}`, 'one `A<n>: <ruling>` marker per question; every other line belongs to the marker above it');
  const paired = pairRulings(draft.questions, parsed.rulings);
  if (!paired.ok) return refuse(`${file}: ${paired.reason}`, `the draft at ${draft.path} asks ${questionSpan(draft.questions.map(question => question.n))} — answer those, exactly`);

  const body = composeReply(draft.questions, parsed.rulings);

  if (dry) {
    raw(body);
    return 0;
  }

  // ── 4. the machine ─────────────────────────────────────────────────────────
  const bin = runner ? null : resolve({ env });
  if (!runner && bin === null) return cannot('no Orca CLI on this machine — the reply crosses the Orca mailbox, so none can be sent from here');
  const run = runner ?? createRunner({ bin });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # nothing was sent — re-run once the runtime answers');

  // ── 5. prove the id names THIS draft's question, before the mutation ───────
  // A reply to a non-question is not an error on Orca's side — it lands as a
  // plain message and returns success — so the proof has to happen here, first.
  const seen = run(['orchestration', 'inbox', '--limit', String(INBOX_WINDOW), '--json']);
  const inboxReceipt = seen.receipt ?? {};
  if (seen.status !== 0 || inboxReceipt.ok !== true || !Array.isArray(inboxReceipt.result?.messages)) {
    const detail = String(inboxReceipt.unparseable ?? seen.stderr ?? '').replace(/\s+/g, ' ');
    return cannot(`the inbox cannot be read, so ${id} cannot be proven a question${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const message = inboxReceipt.result.messages.find(entry => entry !== null && typeof entry === 'object' && entry.id === id);
  if (message === undefined) {
    return cannot(
      `${id} is not among the last ${INBOX_WINDOW} inbox rows, so it cannot be proven a question — an absence from a bounded list is not proof (F-028)`,
      `ax triage status --issue ${issue} --job ${job}   # the pending question's real id`,
    );
  }
  if (message.type !== 'question') {
    return refuse(
      `${id} is a "${message.type}" message, not a question — replying to it would land a plain message while the child stays blocked`,
      `ax triage status --issue ${issue} --job ${job}   # the pending question's real id`,
    );
  }
  // Identity FIRST, content second: Q-line text can legitimately coincide
  // across issues ("bug or enhancement?" reads the same everywhere), so the
  // header `composeAsk` embeds — request and draft fingerprint — is what pins
  // this id to THIS pass. A reply keyed to a look-alike would wake the wrong
  // live child with rulings it never asked for.
  const request = requestFor({ ...base, pass });
  const header = askHeader(message.body);
  if (header === null) {
    return refuse(
      `${id} carries no ax ask header — it was not sent by \`ax triage ask\`, so nothing proves which draft it asked from`,
      `ax triage status --issue ${issue} --job ${job}   # the pending question's real id`,
    );
  }
  if (header.request !== request) {
    return refuse(
      `${id} was asked by ${header.request}, not ${request} — the id names another ask`,
      `ax triage status --issue ${issue} --job ${job}   # which pass is waiting, and on which message`,
    );
  }
  if (header.sha !== draft.sha) {
    return refuse(
      `${id} was asked from draft ${header.sha.slice(0, 12)}, but ${draft.path} is now ${draft.sha.slice(0, 12)} — the draft moved since the ask, and these rulings may answer questions that no longer stand`,
      `ax triage status --issue ${issue} --job ${job}   # re-read the draft, then answer the ask it actually sent`,
    );
  }
  const asked = questionsIn(message.body);
  const same = asked.length === draft.questions.length
    && draft.questions.every((question, at) => asked[at].n === question.n && asked[at].text === question.text);
  if (!same) {
    return refuse(
      `${id} and the draft at ${draft.path} disagree on the questions — the id may name another pass's ask, or the draft moved since it was sent`,
      `ax triage status --issue ${issue} --job ${job}   # which pass is waiting, and on which message`,
    );
  }

  // ── 6. the reply ───────────────────────────────────────────────────────────
  const sent = run(['orchestration', 'reply', '--id', id, '--body', body, '--json']);
  if (sent.error) return cannot(`orca orchestration reply did not finish: ${String(sent.error)}`);
  const receipt = sent.receipt ?? {};
  if (sent.status !== 0 || receipt.ok !== true) {
    const code = receipt.error?.code ?? '';
    const detail = receipt.error?.message ?? receipt.unparseable ?? sent.stderr ?? 'unnamed error';
    if (code === 'answer_conflict') {
      return refuse(`the question already carries a DIFFERENT answer — nothing was changed, and two rulings cannot both stand`, `orca orchestration inbox --limit 20 --full --json   # read what was already sent, then decide which ruling is right`);
    }
    if (code === 'question_not_found') {
      return refuse(`${String(detail)}`, `ax triage status --issue ${issue} --job ${job}`);
    }
    if (code === 'dispatch_inactive') {
      return refuse('the question is closed because its Dispatch is inactive — the child that asked is gone, and no reply can reach it', `ax triage dispatch --issue ${issue} --job ${job} --fresh --because <what the rulings decided>`);
    }
    return cannot(`orca refused the reply (${code || 'no code'}): ${String(detail).slice(0, 200)}`);
  }
  const result = receipt.result ?? {};
  // The belt behind step 5's proof: if this fires, the mutation ALREADY landed
  // as a plain message, and saying so is the only honest output left.
  if (result.question === undefined) {
    bad(`orca answered success but recorded no question — the reply to ${id} landed as a PLAIN message, and the child is still blocked`);
    fix(`ax triage status --issue ${issue} --job ${job}   # find the pending question and answer THAT id`);
    return 1;
  }
  if (result.duplicate === true) note('this exact ruling was already recorded — nothing new was sent');
  note(`answered ${questionSpan(draft.questions.map(question => question.n))} on ${id} — the child revises its draft, then reports`);
  return 0;
}
