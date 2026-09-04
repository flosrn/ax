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
 * that survives. The tail names the file, which is the real record — a reader
 * who needs the rest opens it.
 */
export const REPORT_CAP_BYTES = 16 * 1024;

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
 * Redact FIRST, then cap. The other order leaks: truncating a `dcap_…` token
 * mid-way still prints its prefix (`src/worker/transcript.mjs` pays for that
 * ordering already). `block` redacts again, which is idempotent — this call is
 * here for the ORDER, not for the coverage.
 */
function bounded(text, cap, path) {
  const clean = redactSecrets(text);
  const total = Buffer.byteLength(clean, 'utf8');
  if (total <= cap) return clean.trimEnd();
  // Cut back to the last newline inside the cap: a line boundary is also a
  // codepoint boundary, so the head cannot end mid-character.
  const head = Buffer.from(clean, 'utf8').subarray(0, cap).toString('utf8');
  const cut = head.lastIndexOf('\n');
  const kept = cut > 0 ? head.slice(0, cut) : head;
  return `${kept}\n--- Report truncated at ${cap} bytes of ${total} — read it in full at ${path}`;
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
        `FINDING: the recorded worktree ${derived.worktree} does not resolve on this host (${err}), so the Report cannot be read.`,
      );
      return block(derived.path, lines);
    }

    let fileReal;
    try {
      fileReal = realpathSync(resolve(derived.path));
    } catch {
      lines.push('FINDING: no Report at this path — the worker completed without writing one there.');
      return block(derived.path, lines);
    }

    const fence = worktreeReal.endsWith(sep) ? worktreeReal : `${worktreeReal}${sep}`;
    if (!fileReal.startsWith(fence)) {
      lines.push(
        `FINDING: the derived path resolves outside the recorded worktree — ${fileReal} is not under ${worktreeReal}. It was NOT read.`,
      );
      return block(derived.path, lines);
    }

    let text;
    try {
      text = readFileSync(fileReal, 'utf8');
    } catch (err) {
      lines.push(`FINDING: the Report at this path could not be read: ${err}`);
      return block(derived.path, lines);
    }
    if (text.trim() === '') {
      lines.push('FINDING: the Report at this path is empty.');
      return block(derived.path, lines);
    }

    return block(derived.path, lines, bounded(text, cap, derived.path));
  } catch (err) {
    return block(null, [`FINDING: the Report could not be established: ${err}`]);
  }
}
