// The verbs of `ax ready`, and nothing else.
//
// This table is asserted equal to the `subcommands` declared in
// src/commands.mjs, which is what stops the help — and the AGENTS.md block
// generated from it — from advertising a verb that answers "unknown command".
//
// There is no default verb, on purpose. `ax ready --issue 7` could mean "put a
// session in front of it" or "publish what one already wrote", and guessing
// between a dispatch and a tracker mutation is not a guess worth making.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoPaths } from '../config.mjs';
import { bad, dim, fix, note, raw, section } from '../log.mjs';
import { createRunner, resolveOrca } from '../orca-bin.mjs';
import { paneVerdict, readPane, terminalInventory } from '../worker/pane.mjs';
import { defaultExec } from '../exec.mjs';
import { repoSlug } from '../gh.mjs';
import { defaultStore, heldRepaired, report, workerPane } from '../worker/record.mjs';
import { answer } from './answer.mjs';
import { ask } from './ask.mjs';
import { dispatch } from './dispatch.mjs';
import { draftDirFor, passesIn, passesOf, questionsIn, readDraft, requestFor } from './draft.mjs';
import { publish } from './publish.mjs';
import { readyRelease } from './release.mjs';
import { INBOX_WINDOW, askHeader, questionSpan } from './rulings.mjs';

const USAGE = 'ax ready status --issue N|N-M [--issue …] [--brief] [--job triage|brief|custom|refine] [--repo <owner/repo>]';

/** The widest --issue range status will expand — see the refusal for why. */
const RANGE_MAX = 100;

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

/**
 * Every unanswered question on this machine's mailbox, keyed by the pane that
 * asked it.
 *
 * This is ORCA's state, read from Orca — never deduced from the draft. A count
 * of `Q<n>:` lines cannot tell a child waiting on its ask from a child that
 * died after writing its questions, or from an answer that arrived without a
 * revision; the header comment below records what deducing it nearly cost.
 * The shapes are measured (2026-08-22): a question is a message with
 * `type: "question"`, and its answer — when one exists — is ANOTHER message
 * whose `thread_id` is the question's own id. Another, because Orca stamps the
 * ask's own row with its own id too, and reading that as an answer is what let
 * 17 of this machine's 25 questions close themselves the moment they were asked.
 *
 * Unreadable is NOT fatal and NOT silent: `status` answers from records and
 * drafts on a machine with no Orca at all, but the gap is named on the output,
 * because an absent answer is not an absent question (F-028).
 */
function readMailbox({ resolve, runner, env }) {
  const bin = runner ? 'injected' : resolve({ env });
  if (!runner && bin === null) return { ok: false, reason: 'no Orca CLI on this machine' };
  const run = runner ?? createRunner({ bin });
  const out = run(['orchestration', 'inbox', '--limit', String(INBOX_WINDOW), '--json']);
  const receipt = out.receipt ?? {};
  if (out.status !== 0 || receipt.ok !== true || !Array.isArray(receipt.result?.messages)) {
    // Flattened: an unparseable receipt is multi-line JSON, and a reason that
    // wraps the report is a reason nobody reads to the end.
    const detail = String(receipt.unparseable ?? out.stderr ?? '').replace(/\s+/g, ' ');
    return { ok: false, reason: `orca orchestration inbox unreadable (exit ${out.status})${detail ? `: ${detail.slice(0, 160)}` : ''}` };
  }
  const messages = receipt.result.messages.filter(entry => entry !== null && typeof entry === 'object');
  // A REPLY IS ANOTHER MESSAGE POINTING AT THIS ONE. Measured 2026-08-27 on
  // this machine's mailbox: of 25 questions, 17 carried `thread_id === id` —
  // Orca stamps the ask's own row that way — so collecting every thread_id made
  // each of those questions close itself the moment it was asked. That is the
  // root cause of the #87 contradiction: `--resume msg_59bbc463c531` answered
  // PENDING while this verb reported the pane had no pending question, and a
  // child settled its pass on the difference. 17 of 25 were invisible here.
  const threaded = new Set(
    messages.filter(entry => entry.thread_id && entry.thread_id !== entry.id).map(entry => entry.thread_id),
  );
  const pending = new Map();
  // THE SAME ROW, KEYED BY WHAT IT PROVES ABOUT ITSELF. `composeAsk` writes the
  // request id into the body, so an ax-sent ask names its own pass with no
  // handle involved at all — the only key that survives a transport this side
  // does not control. See `questionsForPass` for what that repaired.
  const byRequest = new Map();
  const push = (map, key, entry) => {
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  };
  for (const entry of messages) {
    if (entry.type !== 'question' || threaded.has(entry.id)) continue;
    push(pending, entry.from_handle, entry);
    const header = askHeader(entry.body);
    if (header !== null) push(byRequest, header.request, entry);
  }
  return { ok: true, pending, byRequest };
}

/**
 * Every pending question that belongs to ONE pass, from three keys, deduped by
 * message id.
 *
 * THE PANE HANDLE IS NOT THE KEY A QUESTION CARRIES, and reading only that key
 * is what made this verb blind to the asks it sends itself. `ax ready ask`
 * sends from the child's DISPATCH, so Orca stamps
 * `from_handle: "dispatch:ctx_…"`, while the dispatch record names the child's
 * TERMINAL (`term_…`). Measured 2026-08-28 across this machine's mailbox: 12 of
 * 24 open question rows were keyed `dispatch:…`, i.e. exactly half of them were
 * unreachable through the verb documented as the authority on them.
 *
 * goodluckagency/ofmchat#101 is what that cost. `msg_bf6613d0ee33`, a real
 * `type: "question"` from `dispatch:ctx_ff9aa6dce051`, sat in the mailbox while
 * `ax ready status` printed no row for it and its own repair line pointed back
 * at itself — so a child blocked on a legitimate question had no sanctioned way
 * to be answered, and the operator unblocked it out of band.
 *
 * The header pin is tried FIRST because it is transport-independent, and the
 * two handle keys stay because a child that asked through raw
 * `orca orchestration ask` writes no header — for those rows a handle is the
 * only evidence there is.
 *
 * SO THE RESULT IS TWO LISTS, NOT ONE, and that split is the whole reason this
 * returns an object. `ax ready answer` refuses any id whose body carries no ax
 * header (`answer.mjs`: nothing proves which draft it asked from) and any id
 * whose header names another pass. Rendering a headerless row as answerable
 * would print a repair that is guaranteed to be refused AND suppress the manual
 * fold/publish escape — rebuilding the exact loop-with-no-exit that
 * `tests/triage-publish.test.mjs` was written for on 2026-08-26, where four
 * correct refusals closed a circle with no way out. A headerless row is still
 * REAL EVIDENCE that a child is blocked, so it is reported; it is simply not
 * something this tool can pair a ruling to.
 */
function questionsForPass({ mailbox, request, handle = '', dispatchId = '' }) {
  if (!mailbox.ok) return { answerable: [], unpairable: [], all: [] };
  const seen = new Set();
  const answerable = [];
  const unpairable = [];
  const take = list => {
    for (const row of list ?? []) {
      const id = String(row?.id ?? '');
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      const header = askHeader(row.body);
      if (header !== null && header.request === request) answerable.push(row);
      else unpairable.push({ row, why: header === null ? 'no ax header' : `asked by ${header.request}` });
    }
  };
  take(mailbox.byRequest.get(request));
  if (handle !== '') take(mailbox.pending.get(handle));
  if (dispatchId !== '') take(mailbox.pending.get(`dispatch:${dispatchId}`));
  return { answerable, unpairable, all: [...answerable, ...unpairable.map(entry => entry.row)] };
}

/**
 * What each dispatch recorded, and the recovery it routes to.
 *
 * An unsettled record routes to `--resume`, never to a second dispatch: the
 * mutation may still be running, and no snapshot can see one in flight (F-001).
 * The draft is reported beside it, because "the session settled" and "the
 * session produced something" are two different questions.
 *
 * EXCEPT over a repaired held composer, and that exception is the whole reason
 * this comment is longer than the loop. Measured 2026-08-22 on the first real
 * coordinator campaign: #50 and #51 both read `RAN · failed · <handle> —
 * UNSETTLED` and both were offered a `--resume`, while their panes answered
 * `status: running` and their children were mid-analysis. An operator who
 * followed that line would have put a SECOND agent into a session that was
 * working — the one outcome this whole subsystem exists to prevent, printed as
 * the repair.
 *
 * The record already knows. `heldRepairAt` is written only after a confirmed
 * submission, so it says a child is running behind a Dispatch that settled
 * `failed` and will never settle again. Read that instead of probing: a probe
 * would add an Orca round-trip to a read-only verb, and `paneReadable` is true
 * for a pane whose status is `exited` — measured the same day — so the naive
 * probe answers "alive" over a corpse.
 */
export function status(argv = [], { exec = defaultExec, env = process.env, cwd = process.cwd(), resolve = resolveOrca, runner, sleep = sleepDefault } = {}) {
  const issues = [];
  let job = 'triage';
  let repo = '';
  let brief = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--issue') issues.push(value());
    else if (arg === '--job') job = value();
    else if (arg === '--repo') repo = value();
    else if (arg === '--brief') brief = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else {
      process.stderr.write(`ax ready status: unknown argument "${arg}"\n${USAGE}\n`);
      return 2;
    }
  }
  if (issues.length === 0) {
    process.stderr.write(`ax ready status: no --issue given\n${USAGE}\n`);
    return 2;
  }
  // A wave is a RANGE, and typing seven --issue flags to poll one is the
  // friction that left #59 finished and unread (2026-08-23): the final report
  // travelled a peer transport that loses messages, nothing else signals
  // completion, and the pull that would have caught it was expensive to type.
  const expanded = [];
  for (const issue of issues) {
    const range = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(issue);
    if (range !== null) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from >= to) {
        process.stderr.write(`ax ready status: --issue ${issue} is not a range — N-M needs N < M\n${USAGE}\n`);
        return 2;
      }
      // Bounded, because expansion is EAGER and every issue below pays real
      // filesystem work (two readdirs, a record read): a typo like 55-610000000
      // would hang the verb allocating six hundred million rows. A wave is
      // seven tickets today; a hundred is headroom, not a policy.
      if (to - from + 1 > RANGE_MAX) {
        process.stderr.write(`ax ready status: --issue ${issue} spans ${to - from + 1} issues — more than ${RANGE_MAX} is a typo, not a wave; split the range\n${USAGE}\n`);
        return 2;
      }
      for (let n = from; n <= to; n += 1) expanded.push(String(n));
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(issue)) {
      process.stderr.write(`ax ready status: --issue expects a number or a range N-M, got "${issue}"\n${USAGE}\n`);
      return 2;
    }
    expanded.push(issue);
  }

  const paths = repoPaths(cwd);
  const root = paths.root ?? cwd;
  const slug = repo === '' ? repoSlug(args => exec('gh', args, root)) : repo;
  if (slug === '') {
    bad('could not resolve the current repository');
    fix('ax ready status --repo <owner>/<repo> --issue N');
    return 1;
  }

  // One mailbox read for the whole report, before the loop: a question PENDING
  // in Orca is the one state neither the record nor the draft can carry, and
  // the budget of the parked children will be read off these rows.
  const mailbox = readMailbox({ resolve, runner, env });
  if (!mailbox.ok) note(dim(`waiting state unknown: ${mailbox.reason} — an absent answer is not an absent question (F-028)`));
  const store = defaultStore(env);

  // WHOSE FILE IS THAT DRAFT RIGHT NOW. Read lazily, once per execution
  // environment, and ONLY when a finding is about to tell an operator to write
  // into a draft by hand — every other row here answers from records and drafts,
  // and this verb stays usable on a machine with no Orca.
  //
  // Measured 2026-08-28 on goodluckagency/ofmchat#100: the fold-it-yourself
  // repair below printed while `ax worker gate` said LIVE and the child's own
  // pane read "Retrying final draft write after gate cleared" — its rulings
  // already folded into its text. Following the line would have put a second
  // writer on one file, and the only reason it did not is that the operator held
  // gate as the authority over this verb's own advice.
  //
  // The verdict is the SHARED one (../worker/pane.mjs), never a second definition
  // of "is that pane dead": VIVANT withholds the write, MORT allows it, and
  // INCONNU discloses and names the verb that decides — an absence of information
  // is not a permission (F-028).
  const inventories = new Map();
  const paneStanding = (handle, paneEnv, why) => {
    if (!inventories.has(paneEnv)) {
      const bin = runner ? 'injected' : resolve({ env });
      inventories.set(
        paneEnv,
        bin === null
          ? { ok: false, reason: 'no Orca CLI on this machine' }
          : terminalInventory(runner ?? createRunner({ bin }), { environment: paneEnv }),
      );
    }
    const inventory = inventories.get(paneEnv);
    if (!inventory.ok) return { pane: 'INCONNU', detail: inventory.reason };
    return paneVerdict(handle === '' ? null : handle, why, inventory, { host: paneEnv });
  };

  // ── the completion view: one line per issue, built to be POLLED ────────────
  // The push half of the loop is lossy by measurement (five peer messages lost
  // on 2026-08-23, one of them a final report — the wave stalled on finished
  // work until a human noticed). A cheap pull is the floor that survives every
  // transport, so this renders the NEWEST pass of each issue as one greppable
  // line: what the coordinator polls between reports it may never receive.
  if (brief) {
    const rows = [];
    for (const issue of expanded) {
      const base = { job, repo: slug, issue };
      const all = passesOf(store, draftDirFor(root, base), base);
      if (all.length === 0) {
        rows.push({ line: `#${issue} — no pass`, handle: '' });
        continue;
      }
      const pass = all[all.length - 1];
      const identity = { ...base, pass };
      const recordPath = join(store, `${requestFor(identity)}.json`);
      let recordState = 'no record';
      let handle = '';
      let paneEnv = '';
      let dispatchId = '';
      if (existsSync(recordPath)) {
        try {
          const state = report(recordPath);
          handle = typeof state.summary?.terminal === 'string' ? state.summary.terminal : '';
          dispatchId = typeof state.summary?.dispatchId === 'string' ? state.summary.dispatchId : '';
          recordState = state.usable ? 'settled' : heldRepaired(recordPath) ? 'child running (repaired)' : 'UNSETTLED';
          // The execution ENVIRONMENT rides with the handle, exactly as
          // workerPane preserves it for autosubmit: a remote child (--on) read
          // without it answers nothing, and the probe below would call a
          // healthy remote pane UNREADABLE.
          paneEnv = workerPane(recordPath).env;
        } catch {
          recordState = recordState === 'no record' ? 'record UNREADABLE' : recordState;
        }
      }
      const draft = readDraft(root, identity);
      const final = draft.sha !== '' && draft.ok && draft.questions.length === 0;
      const shape = draft.sha === ''
        ? 'no draft'
        : draft.questions.length > 0
          ? `ASKING ${questionSpan(draft.questions.map(question => question.n))} · ${draft.sha.slice(0, 12)}`
          : draft.ok
            ? `FINAL ${draft.sha.slice(0, 12)} · ${draft.lines} ln`
            : draft.ready === 'no'
              // Only the refine grammar sets `ready`: a repair-carrying verdict
              // is the coordinator's row to arbitrate, not a malformed draft.
              ? `NOT-READY ${draft.sha.slice(0, 12)} · repair proposed`
              : `NOT-PUBLISHABLE ${draft.sha.slice(0, 12)}`;
      const pending = questionsForPass({ mailbox, request: requestFor(identity), handle, dispatchId });
      // A polled row says WAITING either way — a blocked child is the fact an
      // operator scans for — but only an ax-sent ask is one `ax ready answer`
      // can pair, so the unpairable case says so instead of naming an id that
      // would be refused.
      const waiting = pending.answerable.length > 0
        ? ` · WAITING on ${pending.answerable[0].id}`
        : pending.unpairable.length > 0
          ? ` · WAITING on ${pending.unpairable[0].row.id} (UNPAIRABLE — ${pending.unpairable[0].why})`
          : '';
      rows.push({ line: `#${issue} p${pass} · ${shape} · ${recordState}${waiting}`, handle: final ? '' : handle, paneEnv });
    }

    // The pane, sampled ONLY behind an unfinished row: measured 2026-08-23,
    // #60 finished long before anyone knew — its draft could not be written
    // (the verdict lived in its scrollback) and its report was the day's sixth
    // lost peer message, so "no draft · child running" was indistinguishable
    // from a child at work. Two cursor reads around ONE shared sleep name the
    // observation: EMITTING is a child producing; QUIET is the alarm — yielded,
    // parked or stuck, a QUIET pane with no draft is the row to inspect with
    // `ax worker tail`. It is an observation, never a verdict: a child mid-
    // think is QUIET too, which is why the poll loop reads it, not one shot.
    const probed = rows.filter(row => row.handle !== '');
    if (probed.length > 0) {
      const bin = runner ? 'injected' : resolve({ env });
      if (bin !== null) {
        const orca = runner ?? createRunner({ bin });
        const gapMs = Math.max(0, Number(env.ORCA_DISPATCH_AUTOSUBMIT_GAP ?? 8) * 1000);
        const sample = () => new Map(probed.map(row => {
          const pane = readPane(orca, row.handle, { environment: row.paneEnv, limit: 1 });
          return [row.handle, pane.exit === 0 ? pane.cursor : null];
        }));
        const before = sample();
        sleep(gapMs);
        const after = sample();
        for (const row of probed) {
          const [a, b] = [before.get(row.handle), after.get(row.handle)];
          row.line += a === null || b === null ? ' · pane UNREADABLE' : a === b ? ' · pane QUIET' : ' · pane EMITTING';
        }
      }
    }

    for (const row of rows) note(row.line);
    return 0;
  }
  for (const issue of expanded) {
    const base = { job, repo: slug, issue };
    // Every pass, oldest first, records UNION drafts. A pass just dispatched has
    // a record and no draft; one written by hand could be the reverse. Reporting
    // only the newest would hide the row an operator is deciding against, and
    // reporting only one silently is what cost draft #54.
    const all = [...new Set([...passesIn(store, base, '.json'), ...passesIn(draftDirFor(root, base), base, '.md')])].sort((a, b) => a - b);
    const passes = all.length === 0 ? [1] : all;
    section(`issue #${issue} — ${passes.length} pass(es)`);

    for (const pass of passes) {
      const identity = { ...base, pass };
      const request = requestFor(identity);
      // The number is printed even when there is only one of it: a number that
      // shows up only once it matters is one nobody has learned to read.
      note(`pass ${pass} — request ${request}`);

      const path = join(store, `${request}.json`);
      let handle = '';
      let dispatchId = '';
      // The execution ENVIRONMENT rides with the handle (../worker/record.mjs
      // workerPane): a remote child's pane is invisible to a list that never
      // asked its host, and reading that absence as death is how a live agent
      // gets written over.
      let paneEnv = '';
      // The pass's own ask lifecycle, read from the record rather than deduced
      // from the mailbox. THE MAILBOX IS NOT THE ONLY WITNESS: measured
      // 2026-08-27 on ofmchat #87, a question that `--resume` proved PENDING was
      // absent from its pane's rows here, and this verb reported "it never asked
      // through `ax ready ask`" about it. Two surfaces of one tool, opposite
      // instructions, and the child believed this one and settled its pass.
      let recorded = null;
      if (!existsSync(path)) note(dim('  no dispatch record'));
      else {
        try {
          const state = report(path);
          const summary = state.summary ?? {};
          handle = typeof summary.terminal === 'string' ? summary.terminal : '';
          dispatchId = typeof summary.dispatchId === 'string' ? summary.dispatchId : '';
          recorded = state.ask;
          try {
            paneEnv = workerPane(path).env;
          } catch {
            paneEnv = '';
          }
          note(`  ${state.mode} · ${summary.state ?? 'unnamed state'} · ${summary.terminal ?? 'no pane recorded'}${state.usable ? '' : ' — UNSETTLED'}`);
          // Never a fresh dispatch: the recorded mutation may still be running,
          // and no snapshot can see one in flight.
          if (!state.usable) {
            if (heldRepaired(path)) {
              note('  a repaired held composer — this Dispatch settled `failed` and never will again, but its child IS running');
              note('  its report arrives by peer, and its work lands in the draft below — never `--resume`, which would be a second agent in one session');
              note(dim(`  ax worker transcript ${request}   # what it is doing`));
            } else fix(`ax worker start --resume --request ${request}   # replays the recorded call (F-001)`);
          }
        } catch (error) {
          bad(`pass ${pass} record unreadable: ${String(error.message ?? error)}`);
        }
      }

      // This pass's PENDING questions, from every key one can carry — the ask
      // header, the recorded pane, and the DISPATCH the ask was sent from. Only
      // here, behind a real record, because a draft-only pass has no child to
      // have asked anything.
      let pending = null;
      if (mailbox.ok && (handle !== '' || dispatchId !== '')) {
        pending = questionsForPass({ mailbox, request, handle, dispatchId });
        for (const question of pending.answerable) {
          const numbers = questionsIn(question.body).map(entry => entry.n);
          note(`  WAITING since ${question.created_at ?? 'an unrecorded time'} on ${numbers.length > 0 ? questionSpan(numbers) : 'its question'} — message ${question.id}`);
          fix(`ax ready answer --issue ${issue} --job ${job} --id ${question.id} --file <rulings.md>   # one A<n>: line per question`);
        }
        // A row this pass's child is blocked on that `ax ready answer` cannot
        // pair. Reported, because a blocked child is the fact that matters —
        // but never with the answer command, which `answer` would refuse, and
        // never in a way that hides the fold-and-publish exit below.
        for (const { row, why } of pending.unpairable) {
          const numbers = questionsIn(row.body).map(entry => entry.n);
          note(`  WAITING since ${row.created_at ?? 'an unrecorded time'} on ${numbers.length > 0 ? questionSpan(numbers) : 'its question'} — message ${row.id}`);
          bad(`  ^ UNPAIRABLE (${why}) — \`ax ready answer\` refuses an id it cannot prove asked from this draft, so that command is not the exit here`);
        }
      }

      // The RECORD's view, when the mailbox has nothing for this pane. It is not
      // a fallback — it is a second witness that outranks an empty list, because
      // an absence from a bounded, eventually-consistent inbox is not proof that
      // no question exists (F-028).
      const openRecorded = recorded !== null && (recorded.state === 'pending' || recorded.state === 'replying');
      // Wider than `openRecorded` on purpose: `asking` means a send happened and
      // its outcome was never written, so a question may be live. Anything but a
      // PROVEN terminal state must suppress the "rule it yourself and publish"
      // advice further down — publishing over a live question cannot be undone.
      const liveRecorded = recorded !== null && ['asking', 'pending', 'replying'].includes(recorded.state);
      if (openRecorded && (pending === null || pending.answerable.length === 0)) {
        note(`  WAITING since ${recorded.at ?? 'an unrecorded time'} on message ${recorded.messageId} — from THIS PASS'S RECORD, not the mailbox`);
        note(dim(`  the mailbox shows no such row${mailbox.ok ? '' : ' (and could not be read)'} — an inbox absence does not close a question the record says is open`));
        fix(`ax ready answer --issue ${issue} --job ${job} --id ${recorded.messageId} --file <rulings.md>   # one A<n>: line per question`);
      }
      // Issued, outcome never written: the state a process killed between the
      // send and the write leaves behind. It must never read as "no question".
      //
      // AND ITS REPAIR MUST NOT BE THIS COMMAND. It used to name "the mailbox
      // row above, if any" and then re-print the verb the reader had just run —
      // a loop with no exit whenever no row was rendered, which on
      // goodluckagency/ofmchat#101 was every time, because the row was keyed by
      // dispatch and this verb only looked up panes. So the branch says which of
      // the two states it is in, and each names a command that produces
      // something the other did not.
      if (recorded !== null && recorded.state === 'asking') {
        bad(`  an ask was ISSUED for this pass and its outcome was never recorded — the process died between the send and the write, so a question may be open on the parent's mailbox`);
        if (pending !== null && pending.answerable.length > 0) {
          note(`  the WAITING row above IS that ask (its ax header names ${request}) — the record never learned it landed, the mailbox proves it did`);
        } else {
          note(dim(`  no ax-sent row for this pass is visible here${mailbox.ok ? '' : ' (the mailbox could not be read)'}, so there is no id \`ax ready answer\` can pair`));
          fix(`orca orchestration inbox --limit ${INBOX_WINDOW} --full --json   # find the question row by hand: it is the one whose body opens with ${request}`);
          fix(`ax worker tail ${handle || '<pane>'}   # what the child is blocked on, if the row cannot be found`);
        }
      }

      // The draft's IDENTITY, not merely its existence. A coordinator reads a
      // draft, decides against it, and in between the child that owns it may
      // rewrite it. Measured 2026-08-22: #54 went from 106 to 117 lines after
      // its own peer report, with no signal, so every anchor a human had taken
      // against it was silently stale. The sha is `git hash-object`'s, so it can
      // be re-checked with a command an operator already trusts.
      const draft = readDraft(root, identity);
      if (draft.sha === '') note(dim(`  ${draft.reason}`));
      else {
        note(`  draft ${draft.path}`);
        note(dim(`  ${draft.sha.slice(0, 12)} · ${draft.lines} line(s)${draft.questions.length > 0 ? ` · ${draft.questions.length} open question(s)` : ''}${draft.ok ? '' : ` · NOT publishable: ${draft.reason}`}`));
      }

      // A COUNT IS NOT AN ID, and five refusals in ./answer.mjs send the caller
      // here for one. Measured 2026-08-26 on a child whose own `ax ready ask`
      // had failed `dispatch_capability_invalid`, so it asked through
      // `orca orchestration ask` instead: this verb printed `4 open question(s)`
      // off the draft and nothing else, `answer` refused the resulting id for
      // carrying no ax header, and its repair pointed back here. Four correct
      // refusals closing a loop with no exit.
      //
      // So when the draft asks and no answerable ask is visible, the reason is
      // named and the way out is the one that exists. `ax ready answer` pairs
      // rulings to an ask THIS tool sent; nothing else can be paired, and no
      // amount of re-reading status will produce an id that was never minted.
      //
      // TWO FIXES HERE, both from ofmchat #87 (2026-08-27).
      //
      // It is GATED on the record now. It used to fire on an empty mailbox
      // alone, so it announced "it never asked" about a question `--resume`
      // proved pending, and the child settled the pass on that sentence.
      //
      // And it no longer says "the supervised reply is not available". That
      // phrasing was verbatim the trigger the injected child contract uses to
      // authorise reporting with questions still open — one wording meaning
      // "a lookup returned empty" here and "the channel is dead" there. The
      // child cannot be asked to distrust one of two texts it is given; the
      // cheaper fix is to stop the collision, so this says what it actually
      // knows: nothing this verb can PAIR exists.
      // GATED ON THE ANSWERABLE SET, NEVER ON THE ROWS SEEN. A headerless row
      // reached by pane or dispatch key is a question this tool cannot pair, so
      // counting it as "an ask is visible" would withhold the only exit that
      // exists — which is precisely the 2026-08-26 loop this branch was written
      // to end, rebuilt by a wider lookup.
      if (draft.questions.length > 0 && !liveRecorded && (pending === null || pending.answerable.length === 0)) {
        bad(`  the draft asks ${draft.questions.length}, and no answerable ask is visible: ${
          !mailbox.ok
            ? 'the mailbox could not be read'
            : pending !== null && pending.unpairable.length > 0
              ? `${pending.unpairable.length} question row(s) reach this pass, but none carries an ax header naming it (${pending.unpairable[0].why})`
              : handle === '' && dispatchId === ''
                ? 'this pass records neither a pane nor a dispatch, so no ask can be matched to it'
                : recorded === null
                  ? 'this pass never asked through `ax ready ask`, and no question is keyed to its request, its pane or its dispatch'
                  : `this pass's ask is recorded ${recorded.state}${recorded.code ? ` (${recorded.code})` : ''}, and no question is keyed to its request, its pane or its dispatch`
        }`);
        note('  `ax ready answer` pairs rulings to an ask THIS tool sent; a child that asked another way cannot be answered by it');

        // THE FINDING IS A FACT; THE REPAIR IS A WRITE, and a write needs to know
        // who else holds that file. See `paneStanding` above for what this cost.
        const standing = paneStanding(handle, paneEnv, 'this pass records no pane, so nothing here can say whether a child still holds that draft');
        if (standing.pane === 'VIVANT') {
          bad(`  and this pass's pane is LIVE (${standing.detail}) — folding rulings into a draft its child is still writing loses one of the two writes, whichever lands second`);
          note('  it may already have absorbed them: a child that asked outside `ax ready ask` reads its own answers however it asked for them');
          fix(`  ax worker tail ${handle}   # what it is doing before you touch its draft`);
        } else {
          if (standing.pane === 'INCONNU') {
            note(dim(`  this pass's pane could not be established (${standing.detail}), so the write below is not proven unopposed — \`ax worker gate ${request}\` is the authority, never this line`));
          }
          fix(`  rule the questions and fold them into ${draft.sha === '' ? 'the draft' : draft.path} yourself, then publish — there is no ask here for \`ax ready answer\` to pair`);
        }
      }
    }
  }
  return 0;
}

export const SUBCOMMANDS = { dispatch, ask, status, answer, publish, release: readyRelease };

/** `ax ready <verb> [args]`. */
export function ready(argv = []) {
  const [verb, ...rest] = argv;
  const run = SUBCOMMANDS[verb];

  if (!run) {
    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax ready: unknown verb "${verb}" (${known})\n` : `ax ready: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
