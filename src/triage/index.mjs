// The verbs of `ax triage`, and nothing else.
//
// This table is asserted equal to the `subcommands` declared in
// src/commands.mjs, which is what stops the help — and the AGENTS.md block
// generated from it — from advertising a verb that answers "unknown command".
//
// There is no default verb, on purpose. `ax triage --issue 7` could mean "put a
// session in front of it" or "publish what one already wrote", and guessing
// between a dispatch and a tracker mutation is not a guess worth making.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoPaths } from '../config.mjs';
import { bad, dim, fix, note, raw, section } from '../log.mjs';
import { createRunner, resolveOrca } from '../orca-bin.mjs';
import { readPane } from '../worker/pane.mjs';
import { defaultExec } from '../worker/release.mjs';
import { defaultStore, heldRepaired, report, workerPane } from '../worker/record.mjs';
import { answer } from './answer.mjs';
import { ask } from './ask.mjs';
import { dispatch } from './dispatch.mjs';
import { DRAFT_DIR, passesIn, passesOf, questionsIn, readDraft, requestFor } from './draft.mjs';
import { publish } from './publish.mjs';
import { triageRelease } from './release.mjs';
import { INBOX_WINDOW, questionSpan } from './rulings.mjs';

const USAGE = 'ax triage status --issue N|N-M [--issue …] [--brief] [--job triage|brief|custom] [--repo <owner/repo>]';

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
 * `type: "question"`, and its answer — when one exists — is a message whose
 * `thread_id` is the question's own id.
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
  const threaded = new Set(messages.map(entry => entry.thread_id).filter(Boolean));
  const pending = new Map();
  for (const entry of messages) {
    if (entry.type !== 'question' || threaded.has(entry.id)) continue;
    const list = pending.get(entry.from_handle) ?? [];
    list.push(entry);
    pending.set(entry.from_handle, list);
  }
  return { ok: true, pending };
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
      process.stderr.write(`ax triage status: unknown argument "${arg}"\n${USAGE}\n`);
      return 2;
    }
  }
  if (issues.length === 0) {
    process.stderr.write(`ax triage status: no --issue given\n${USAGE}\n`);
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
        process.stderr.write(`ax triage status: --issue ${issue} is not a range — N-M needs N < M\n${USAGE}\n`);
        return 2;
      }
      // Bounded, because expansion is EAGER and every issue below pays real
      // filesystem work (two readdirs, a record read): a typo like 55-610000000
      // would hang the verb allocating six hundred million rows. A wave is
      // seven tickets today; a hundred is headroom, not a policy.
      if (to - from + 1 > RANGE_MAX) {
        process.stderr.write(`ax triage status: --issue ${issue} spans ${to - from + 1} issues — more than ${RANGE_MAX} is a typo, not a wave; split the range\n${USAGE}\n`);
        return 2;
      }
      for (let n = from; n <= to; n += 1) expanded.push(String(n));
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(issue)) {
      process.stderr.write(`ax triage status: --issue expects a number or a range N-M, got "${issue}"\n${USAGE}\n`);
      return 2;
    }
    expanded.push(issue);
  }

  const paths = repoPaths(cwd);
  const root = paths.root ?? cwd;
  let slug = repo;
  if (slug === '') {
    const out = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root);
    slug = out.error || out.status !== 0 ? '' : String(out.stdout ?? '').trim().split('\n')[0];
  }
  if (slug === '') {
    bad('could not resolve the current repository');
    fix('ax triage status --repo <owner>/<repo> --issue N');
    return 1;
  }

  // One mailbox read for the whole report, before the loop: a question PENDING
  // in Orca is the one state neither the record nor the draft can carry, and
  // the budget of the parked children will be read off these rows.
  const mailbox = readMailbox({ resolve, runner, env });
  if (!mailbox.ok) note(dim(`waiting state unknown: ${mailbox.reason} — an absent answer is not an absent question (F-028)`));
  const store = defaultStore(env);

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
      const all = passesOf(store, join(root, DRAFT_DIR), base);
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
      if (existsSync(recordPath)) {
        try {
          const state = report(recordPath);
          handle = typeof state.summary?.terminal === 'string' ? state.summary.terminal : '';
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
            : `NOT-PUBLISHABLE ${draft.sha.slice(0, 12)}`;
      const pending = mailbox.ok && handle !== '' ? (mailbox.pending.get(handle) ?? []) : [];
      const waiting = pending.length > 0 ? ` · WAITING on ${pending[0].id}` : '';
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
    const all = [...new Set([...passesIn(store, base, '.json'), ...passesIn(join(root, DRAFT_DIR), base, '.md')])].sort((a, b) => a - b);
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
      if (!existsSync(path)) note(dim('  no dispatch record'));
      else {
        try {
          const state = report(path);
          const summary = state.summary ?? {};
          handle = typeof summary.terminal === 'string' ? summary.terminal : '';
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

      // The pane's PENDING questions, matched by the handle the record holds.
      // Only here — behind a real record — because a draft-only pass has no
      // pane to have asked anything.
      if (mailbox.ok && handle !== '') {
        for (const question of mailbox.pending.get(handle) ?? []) {
          const numbers = questionsIn(question.body).map(entry => entry.n);
          note(`  WAITING since ${question.created_at ?? 'an unrecorded time'} on ${numbers.length > 0 ? questionSpan(numbers) : 'its question'} — message ${question.id}`);
          fix(`ax triage answer --issue ${issue} --job ${job} --id ${question.id} --file <rulings.md>   # one A<n>: line per question`);
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
    }
  }
  return 0;
}

export const SUBCOMMANDS = { dispatch, ask, status, answer, publish, release: triageRelease };

/** `ax triage <verb> [args]`. */
export function triage(argv = []) {
  const [verb, ...rest] = argv;
  const run = SUBCOMMANDS[verb];

  if (!run) {
    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax triage: unknown verb "${verb}" (${known})\n` : `ax triage: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
