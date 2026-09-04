// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * THE REPORT ARRIVES WITH THE COMPLETION, or the completion says why it did not.
 *
 * A worker's `worker_done` body is the **Summary** — three sentences, Orca's
 * preamble rules it and ax does not fight that (`docs/adr/0002`). The criteria
 * and the evidence live in the **Report**, one file per request, and until this
 * module existed the orchestrator was handed the three sentences and nothing
 * else. Measured on the 2026-09-03 wave: eight workers, eight completions, zero
 * Reports in the channel the orchestrator reads.
 *
 * WHERE THE PATH COMES FROM. The dispatch record, and only the record — the same
 * rule `src/worker/report.mjs` applies for the brief, twinned here because a
 * runtime that derives it must not shell out to the CLI mid-injection. Two rules
 * that must agree drift unless something proves they agree, so
 * `completion.test.ts` reads #135's committed fixture through BOTH and demands
 * one path. The request grammar is NOT twinned: `requestIdOk` is imported, one
 * grammar for every party, which is the ruling #135's gate produced.
 *
 * `payload.reportPath` IS NEVER OPENED. The reference exists for Orca (it lands
 * on the task result) and for a human. Opening it would let a worker choose
 * which file the orchestrator reads as its own criteria — the one thing the
 * derivation exists to prevent. A reference that contradicts the derived path is
 * therefore a finding about the sender, not an alternative location.
 *
 * FOUR DISPOSITIONS, NONE OF THEM A SILENCE. Missing file, contradicted
 * reference, absent reference, worktree on another host: each is a named line on
 * a completion that is still injected in full. A withheld completion would cost
 * the orchestrator the one message that says the slice ended.
 *
 * TOTAL BY CONSTRUCTION. The receiver appends this block to the message it is
 * about to inject, inside a try whose catch withholds the ack and replays the
 * whole delivery. So every fault here is absorbed into a finding line: a
 * misparsed record must not turn into a re-delivered completion.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { redactSecrets } from '../../src/redact.mjs';
import { requestIdOk } from '../../src/worker/record.mjs';
import { dispatchRecord } from './attribution.ts';
import { environmentOfDispatch } from './route.ts';

/** Where every implementation Report lives, relative to the child's worktree. */
export const REPORT_DIR = join('.scratch', 'report');

/**
 * The byte cap on injected Report text.
 *
 * A HEAD cap, not a tail one, and that is the whole design: the playbook puts
 * `## CRITERIA` first, so the section the orchestrator decides on is the section
 * that survives, whole, while the sections after it are truncated. The tail
 * names the file, which is the real record — a reader who needs the rest opens
 * it. A `## CRITERIA` larger than this cap is refused by name instead
 * (`bounded`): nothing partial is shown, because a cut criteria list reads as
 * complete.
 */
export const REPORT_CAP_BYTES = 16 * 1024;

/**
 * WHAT TO DO ABOUT A REPORT THAT IS NOT THERE.
 *
 * `AGENTS.md`: every finding names its repair, because a `bad` without a `fix`
 * is a finding neither an agent nor a human can act on. The hazard here is
 * specific — `worker_done` has already settled the Dispatch, so the obvious
 * reflex (ask for the completion again) is the one thing that cannot happen:
 * Orca allows exactly one, and `96-work` sent six. The channel is the one this
 * completion arrived on, the file is the DERIVED path and never one the worker
 * picks, and a rewritten Report travels by the board card (`docs/adr/0002`).
 */
const REPAIR =
  'Repair: answer this completion on the channel it arrived on (`peer_reply` when the delivery above recorded a route) and have the worker write THIS path, then report by its board card — never a second `worker_done`, which Orca has already settled.';

/**
 * The worktree paths a record's effects name — the twin of `worktreesOf` in
 * `src/worker/transcript.mjs`. Orca reports them as
 * `{kind:'worktree', id:'<repoId>::<PATH>'}`; a missing `effects` container is
 * an absence, never an empty answer (F-028).
 */
function worktreesOf(rec) {
  const paths = new Set();
  for (const attempt of Array.isArray(rec?.attempts) ? rec.attempts : []) {
    for (const phase of Array.isArray(attempt?.phases) ? attempt.phases : []) {
      const effects = phase?.receipt?.result?.effects;
      if (!Array.isArray(effects)) continue;
      for (const effect of effects) {
        if (effect?.kind !== 'worktree' || typeof effect.id !== 'string') continue;
        const cut = effect.id.indexOf('::');
        const path = cut === -1 ? effect.id : effect.id.slice(cut + 2);
        if (path) paths.add(path);
      }
    }
  }
  return [...paths];
}

/**
 * `{ path, worktree }` | `{ reason }` — the runtime-local twin of
 * `reportPath` in `src/worker/report.mjs`, whose refusals it repeats word for
 * word so the parity test can compare them.
 *
 * Failure carries `reason` and NO `path` key, so a caller cannot read an empty
 * string as a location (F-028). `worktree` rides along because the containment
 * proof needs the directory this path was derived FROM, and deriving it a second
 * time would be a second way to disagree.
 */
export function reportPath(rec) {
  const trees = worktreesOf(rec);
  if (trees.length !== 1) {
    return {
      reason:
        trees.length === 0
          ? 'the record names no worktree, so the Report path cannot be established'
          : `the record names ${trees.length} worktrees, so which Report path it means cannot be established`,
    };
  }
  if (!requestIdOk(rec?.request)) {
    return { reason: "the record's request violates the request-id grammar, so the Report path cannot be established" };
  }
  const path = join(trees[0], REPORT_DIR, `${rec.request}.md`);
  if (!isAbsolute(path)) {
    return { reason: "the record's worktree is not absolute, so the Report path cannot be established" };
  }
  return { path, worktree: trees[0] };
}

/** JSON or null. Local, because this module borrows nothing from the host. */
function bag(payload) {
  if (payload !== null && typeof payload === 'object') return payload;
  try {
    return JSON.parse(String(payload ?? ''));
  } catch {
    return null;
  }
}

/**
 * `{ body }` | `{ reason }` — the injected text, bounded, or the named inability
 * that says why no complete one exists.
 *
 * THE CAP IS SPENT ON `## CRITERIA` FIRST. The section is what a merge gate
 * decides on, the playbook puts it first, so a head cut keeps it whole and
 * truncates the sections after it. What a head cut cannot do is keep a section
 * that is larger than the cap ITSELF, and raising the cap for one is not
 * available: an unbounded section is an unbounded injection into the
 * orchestrator's context. So that case is refused by name instead — a partial
 * criteria list presented as a Report is the one outcome worse than no Report,
 * because it reads as complete and the reader decides on it.
 *
 * Redact FIRST, then cap. The other order leaks: truncating a `dcap_…` token
 * mid-way still prints its prefix (`src/worker/transcript.mjs` pays for that
 * ordering already). `block` redacts again, which is idempotent — this call is
 * here for the ORDER, not for the coverage.
 */
function bounded(text, cap, path) {
  const clean = redactSecrets(text);
  const total = Buffer.byteLength(clean, 'utf8');
  if (total <= cap) return { body: clean.trimEnd() };

  const criteria = criteriaBytes(clean);
  if (criteria !== null && criteria > cap) {
    return {
      reason: `the Report's \`## CRITERIA\` section alone is ${criteria} bytes, past the ${cap}-byte cap, so no complete criteria list can be injected. Nothing partial stands in for it — read it at ${path}`,
    };
  }

  // Cut back to the last newline inside the cap: a line boundary is also a
  // codepoint boundary, so the head cannot end mid-character.
  const head = Buffer.from(clean, 'utf8').subarray(0, cap).toString('utf8');
  const cut = head.lastIndexOf('\n');
  const kept = cut > 0 ? head.slice(0, cut) : head;
  // A Report with no `## CRITERIA` heading at all gets the NEUTRAL trailer. The
  // section-is-whole claim is the one a decision gate acts on, so asserting it
  // over a file where the heading was missing or misspelled would be a false
  // completeness claim — worse than the malformed Report it describes.
  const trailer =
    criteria === null
      ? `no \`## CRITERIA\` heading was found, so nothing above is a complete criteria list; read it in full at ${path}`
      : `\`## CRITERIA\` is whole above; read the rest at ${path}`;
  return { body: `${kept}\n--- Report truncated at ${cap} bytes of ${total} — ${trailer}` };
}

/**
 * How many bytes of `text` the `## CRITERIA` section occupies, counted from the
 * start of the file, or `null` for a Report that has no such heading — an
 * absence, never a zero (F-028).
 */
function criteriaBytes(text) {
  const heading = /^## CRITERIA\b.*$/m.exec(text);
  if (heading === null) return null;
  const from = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(from));
  return Buffer.byteLength(text.slice(0, next === null ? text.length : from + next.index), 'utf8');
}

/**
 * The block appended after the Summary: one header, the named lines, then the
 * text.
 *
 * ONE REDACTION BOUNDARY, ON THE EMITTER — the rule
 * `src/worker/transcript.mjs` states and the reason it states it: redacting
 * field by field leaks through the one field nobody thought carried child text.
 * Here that field is `payload.reportPath`, quoted verbatim into a finding, and
 * every `${err}` beside it: a worker's own path claim and a filesystem error
 * naming the line it failed on are both child-authored, and the preamble puts a
 * `dcap_…` in reach of both.
 */
function block(path, lines, body = '') {
  const head =
    path === null
      ? '--- REPORT (derived from the dispatch record)'
      : `--- REPORT (derived from the dispatch record) · ${path}`;
  const parts = [head, ...lines];
  if (body !== '') parts.push('---', body);
  return `\n\n${redactSecrets(parts.join('\n'))}\n`;
}

/**
 * The Report block for a dispatched worker's completion, or `''` for a message
 * that is not one.
 *
 * `record` and `environmentOf` are named options with real defaults: the
 * dispatch store and the recorded argv are host answers, and a test must be able
 * to hand over both without a store on disk.
 */
export function completionReport(msg, deps = {}) {
  const lookup = deps.record ?? dispatchRecord;
  const environmentOf = deps.environmentOf ?? environmentOfDispatch;
  const cap = deps.cap ?? REPORT_CAP_BYTES;

  try {
    // A completion, and one from a worker THIS machine dispatched. Anything else
    // has no record to derive from, and inventing one is the failure mode the
    // whole derivation exists to avoid.
    if (String(msg?.type ?? '') !== 'worker_done') return '';
    const dispatched = /^dispatch:(.+)$/.exec(String(msg?.from_handle ?? '').trim());
    if (dispatched === null) return '';
    const id = dispatched[1] ?? '';
    const rec = lookup(id);
    if (rec === null || rec === undefined) return '';

    const derived = reportPath(rec.json);
    if (derived.path === undefined) return block(null, [`FINDING: ${derived.reason}.`]);

    const lines = [];
    // A statement about the SENDER, made before any file is touched, because it
    // is true whether or not the derived Report exists.
    const named = String(bag(msg?.payload)?.reportPath ?? '').trim();
    if (named !== '' && named !== derived.path) {
      lines.push(
        `FINDING: the completion named ${named} in payload.reportPath, which is not the derived path. The named path was NOT opened.`,
      );
    } else if (named === '') {
      lines.push('NOTE: the completion named no reportPath; this Report was derived from the dispatch record.');
    }

    // THE HOST CHECK COMES BEFORE THE FILESYSTEM. The same path exists on this
    // machine often enough — every worktree tree is laid out identically — and
    // reading it would answer with another slice's file. `--on <env>` on the
    // recorded argv is this runtime's existing evidence for "that worktree is
    // elsewhere" (`route.ts`).
    const environment = String(environmentOf(rec.json, id) ?? '');
    if (environment !== '') {
      lines.push(
        `FINDING: Report inaccessible from this host — this dispatch ran on '${environment}', so the recorded worktree and its Report are on that host. No repair from here: \`ax worker transcript\` reads a session file that is over there too.`,
      );
      return block(derived.path, lines);
    }

    // RESOLVE + REALPATH, both sides. The derived path is built from a record,
    // and the directory it names can hold a symlink; comparing real paths is what
    // makes "under the recorded worktree" a proof rather than a prefix test on
    // text.
    let worktreeReal;
    try {
      worktreeReal = realpathSync(derived.worktree);
    } catch (err) {
      lines.push(
        `FINDING: the recorded worktree ${derived.worktree} does not resolve on this host (${err?.code ?? err}), so the Report cannot be read.`,
      );
      lines.push(
        'Repair: check that worktree still exists — a released one takes its Report with it, and the record is then the only account of the slice.',
      );
      return block(derived.path, lines);
    }

    let fileReal;
    try {
      fileReal = realpathSync(resolve(derived.path));
    } catch (err) {
      // ENOENT IS THE ONLY ABSENCE. `EACCES`, `ELOOP`, an unreadable parent —
      // each of those is a path that exists and will not resolve, and calling it
      // "the worker never wrote one" aims recovery at a worker with no fault in
      // it while hiding the fault there is.
      if (err?.code === 'ENOENT') {
        lines.push('FINDING: no Report at this path — the worker completed without writing one there.');
        lines.push(REPAIR);
      } else {
        lines.push(
          `FINDING: the Report at this path did not resolve (${err?.code ?? err}); an absence would be ENOENT, so this is a path fault and not a missing Report.`,
        );
        lines.push(`Repair: inspect ${derived.path} on this host — the fault is in the path, not in the completion.`);
      }
      return block(derived.path, lines);
    }

    const fence = worktreeReal.endsWith(sep) ? worktreeReal : `${worktreeReal}${sep}`;
    if (!fileReal.startsWith(fence)) {
      lines.push(
        `FINDING: the derived path resolves outside the recorded worktree — ${fileReal} is not under ${worktreeReal}. It was NOT read.`,
      );
      lines.push(
        'Repair: inspect that link before trusting anything from this slice; the Report must be a file under the worktree the record names, and a path leading out of it was not written by the rule.',
      );
      return block(derived.path, lines);
    }

    let text;
    try {
      text = readFileSync(fileReal, 'utf8');
    } catch (err) {
      lines.push(`FINDING: the Report at this path could not be read: ${err?.code ?? err}.`);
      lines.push(`Repair: read ${derived.path} on this host; the file resolved, so the fault is in reading it.`);
      return block(derived.path, lines);
    }
    if (text.trim() === '') {
      lines.push('FINDING: the Report at this path is empty.');
      lines.push(REPAIR);
      return block(derived.path, lines);
    }

    const shown = bounded(text, cap, derived.path);
    if (shown.body === undefined) {
      lines.push(`FINDING: ${shown.reason}.`);
      return block(derived.path, lines);
    }
    return block(derived.path, lines, shown.body);
  } catch (err) {
    return block(null, [`FINDING: the Report could not be established: ${err}`]);
  }
}
