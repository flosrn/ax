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
 * TWO ADDRESS SHAPES, ONE RECORD (#168). A remote worker reports under
 * `dispatch:<id>`, an address the receiving runtime minted from its own row, and
 * carries no pane key by contract. A LOCAL supervised worker on the fork build
 * reports from its own pane — `from_handle: term_…`, a `sender_pane_key`, the
 * dispatch id in `payload.dispatchId`. Measured 2026-09-05 on the first real
 * measurement wave: the module keyed on the first shape alone and injected the
 * second with nothing appended. The payload's id is the sender's word, so it is
 * accepted only through two proofs this side already holds: the pane key (the
 * witness) and the record's own recorded pane equal to `from_handle`. Either
 * proof missing is a finding line, never a derivation.
 *
 * FOUR DISPOSITIONS, NONE OF THEM A SILENCE. Missing file, contradicted
 * reference, absent reference, worktree on another host: each is a named line on
 * a completion that is still injected in full. A withheld completion would cost
 * the orchestrator the one message that says the slice ended.
 *
 * TWO BOUNDS, AND THEY ARE NOT THE SAME BOUND (#180). `REPORT_CAP_BYTES` caps
 * what is INJECTED, after redaction. It never capped what was READ: the receiver
 * pulled the whole file into a string and redacted all of it before measuring,
 * so a Report — a file whose size is the CHILD's choice — decided how much work
 * and memory the ORCHESTRATOR's session spent on a message it did not ask for.
 * Measured 2026-09-05 against the old reader: a 1 GiB Report cost three seconds
 * and a gigabyte of resident string to produce a 16 KB block. The same number
 * now bounds the input too — `cap + 1` bytes off a descriptor closed on both
 * exits, one byte past the cap so that "there is more" is an observation and not
 * a guess.
 *
 * WHAT A BOUND COSTS IS KNOWLEDGE, so this block no longer claims what the old
 * reader could measure. The file's size is unknown. The end of a section whose
 * heading was among the last bytes read is unknown, so a criteria list counts as
 * complete only when its END was read as well — one whose end lies past the bound
 * is refused by name, exactly like one too large to inject. And an unread suffix
 * is DISCLOSED (`input-truncated`), never presented as read: including when
 * redaction leaves less than the cap, which is how the old order injected an
 * oversized file whole and called it complete.
 *
 * TOTAL BY CONSTRUCTION. The receiver appends this block to the message it is
 * about to inject, inside a try whose catch withholds the ack and replays the
 * whole delivery. So every fault here is absorbed into a finding line: a
 * misparsed record must not turn into a re-delivered completion.
 */

import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { redactSecrets } from '../../src/redact.mjs';
import { requestIdOk } from '../../src/worker/record.mjs';
import { dispatchRecord } from './attribution.ts';
import { environmentOfDispatch, paneOfDispatch } from './route.ts';

/** Where every implementation Report lives, relative to the child's worktree. */
export const REPORT_DIR = join('.scratch', 'report');

/**
 * The byte cap on Report text, spent in two places: it bounds the raw INPUT
 * (`boundedRead` consumes `cap + 1` bytes and no more) and it bounds the
 * redacted INJECTION (`bounded`). One number, because a second one would be a
 * second thing to keep in step for no gain — reading more than can ever be
 * injected buys nothing but the cost of reading it.
 *
 * A HEAD cap, not a tail one, and that is the whole design: the playbook puts
 * `## CRITERIA` first, so the section the orchestrator decides on is the section
 * that survives, whole, while the sections after it are truncated. The tail
 * names the file, which is the real record — a reader who needs the rest opens
 * it. A `## CRITERIA` this cap cannot hold whole, or whose end the input bound
 * never reached, is refused by name instead (`bounded`): nothing partial is
 * shown, because a cut criteria list reads as complete.
 *
 * Raising it raises what an arbitrary child spends of its orchestrator's context
 * and memory; lowering it refuses ordinary Reports whose criteria are merely
 * long. Neither direction is a performance knob.
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
 * `{ path, worktree }` | `{ reason }` — the runtime-local twin of `reportPath`
 * in `src/worker/report.mjs`, whose refusals it repeats word for word so the
 * parity test can compare them.
 *
 * It twins BOTH halves of that rule as #136 split them (`087c3be`): the record
 * resolution, and the `reportPathFor` recipe the brief also crosses. That split
 * moved one wording — "the record's request violates …" became "the request
 * violates …" — and the parity test caught it on the merged base, which is the
 * entire argument for having the test rather than trusting two copies.
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
  const worktree = trees[0];
  // The worktree BEFORE the request, in that order, because the other rule
  // answers them in that order and a record can be malformed in both ways at
  // once. The empty branch is unreachable from a record — `worktreesOf` drops an
  // effect that names no path — and is carried anyway: the twin is a twin of the
  // whole wording, not of the subset today's caller can reach.
  if (!isAbsolute(worktree)) {
    return {
      reason:
        worktree === ''
          ? 'no worktree is named on this host, so the Report path cannot be established'
          : `the worktree '${worktree}' is not absolute, so the Report path cannot be established`,
    };
  }
  if (!requestIdOk(rec?.request)) {
    return { reason: 'the request violates the request-id grammar, so the Report path cannot be established' };
  }
  return { path: join(worktree, REPORT_DIR, `${rec.request}.md`), worktree };
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
 * `{ text, truncated }` — at most `cap + 1` bytes of `path`, cut back to the last
 * line boundary when the file ran past the bound, with the descriptor closed on
 * both exits.
 *
 * THE BOUND IS ON THE READ. `readFileSync` decides nothing until the whole file
 * is resident, and the file is a child's: that cost belongs to whoever wrote it,
 * not to the session it reports to. `cap + 1` is the smallest window that still
 * answers "is there more?" from the read itself — a `stat` would answer it from a
 * different observation, and a file being appended to makes the two disagree.
 *
 * THE LAST NEWLINE IS THE CUT, AND IT IS MADE ON THE BYTES. The bound falls where
 * the file put it: mid-line, mid-character, mid-token. 0x0A never occurs inside a
 * UTF-8 sequence, so the last newline in the window is at once a codepoint
 * boundary and a boundary no secret shape crosses. Decoding first would already
 * have turned a split character into U+FFFD; cutting later would leave a `dcap_`
 * head whose tail is past the bound. An empty `text` WITH `truncated` is a file
 * whose first line outruns the window — no safe prefix exists, and the caller
 * names that instead of showing the fragment.
 */
function boundedRead(path, cap) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(cap + 1);
    let read = 0;
    // A read(2) on a regular file may answer short — a signal is enough — so the
    // window is filled in a loop, and never past its own length.
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const truncated = read > cap;
    if (!truncated) return { text: buf.toString('utf8', 0, read), truncated };
    const nl = buf.lastIndexOf(0x0a, read - 1);
    return { text: nl <= 0 ? '' : buf.toString('utf8', 0, nl), truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * `{ body }` | `{ reason }` — the injected text, bounded, or the named inability
 * that says why no complete one exists. `truncated` is the input bound's answer
 * from `boundedRead`, and it is what separates "the rest was dropped" from "the
 * rest was never read".
 *
 * THE CAP IS SPENT ON `## CRITERIA` FIRST. The section is what a merge gate
 * decides on, the playbook puts it first, so a head cut keeps it whole and
 * truncates the sections after it. What a head cut cannot do is keep a section
 * that is larger than the cap ITSELF, and raising the cap for one is not
 * available: an unbounded section is an unbounded injection into the
 * orchestrator's context. Nor can it keep one whose END the input bound never
 * reached, which is a section of unknown size rather than a known oversized one.
 * Both are refused by name — a partial criteria list presented as a Report is the
 * one outcome worse than no Report, because it reads as complete and the reader
 * decides on it — and only the measured one states a size.
 *
 * Redact FIRST, then cap. The other order leaks: truncating a `dcap_…` token
 * mid-way still prints its prefix (`src/worker/transcript.mjs` pays for that
 * ordering already). `block` redacts again, which is idempotent — this call is
 * here for the ORDER, not for the coverage. And redaction can GROW text
 * (`dcap_x`, six bytes, becomes fifteen), which is why the cap is enforced below
 * on the redacted bytes and never on the raw window alone.
 */
function bounded(text, cap, path, truncated) {
  const clean = redactSecrets(text);
  const criteria = criteriaSpan(clean, truncated);
  if (criteria.open === true) {
    return {
      reason: `the Report's \`## CRITERIA\` section runs past the ${cap}-byte input bound — its end was never read, so no complete criteria list can be injected and nothing partial stands in for it`,
      repair: `Repair: read ${path} — the criteria are there in full, and this block would only have shown the part that fit the bound.`,
    };
  }
  if (criteria.bytes !== undefined && criteria.bytes > cap) {
    return {
      reason: `the Report's \`## CRITERIA\` section alone is ${criteria.bytes} bytes, past the ${cap}-byte cap, so no complete criteria list can be injected and nothing partial stands in for it`,
      repair: `Repair: read ${path} — the criteria are there in full, and this block would only have shown part of them.`,
    };
  }

  const total = Buffer.byteLength(clean, 'utf8');
  // A complete Report inside both bounds: exactly what it has always been.
  if (total <= cap && !truncated) return { body: clean.trimEnd() };

  // A Report with no `## CRITERIA` heading at all gets the NEUTRAL trailer. The
  // section-is-whole claim is the one a decision gate acts on, so asserting it
  // over a file where the heading was missing or misspelled would be a false
  // completeness claim — worse than the malformed Report it describes. Under the
  // input bound the absence is weaker still: the heading may be past the bound,
  // so the trailer says where it was not found rather than that it does not exist.
  const trailer =
    criteria.absent === true
      ? `no \`## CRITERIA\` heading was found${truncated ? ' in the bytes that were read' : ''}, so nothing above is a complete criteria list; read it in full at ${path}`
      : `\`## CRITERIA\` is whole above; read the rest at ${path}`;
  // `total` is the size of what was READ. Stating it as the file's size would be
  // the one fact a bounded read cannot have, so a truncated input names the bound
  // it stopped at and no size at all.
  const disclosure = truncated
    ? `input-truncated at the ${cap}-byte input bound; what follows it was never read`
    : `truncated at ${cap} bytes of ${total}`;
  if (total <= cap) return { body: `${clean.trimEnd()}\n--- Report ${disclosure} — ${trailer}` };

  // Cut back to the last newline inside the cap: a line boundary is also a
  // codepoint boundary, so the head cannot end mid-character. No boundary inside
  // the cap means no safe prefix, and nothing incomplete is emitted to fill it.
  const head = Buffer.from(clean, 'utf8').subarray(0, cap).toString('utf8');
  const cut = head.lastIndexOf('\n');
  if (cut <= 0) {
    return {
      reason: `the Report's first ${cap} redacted bytes hold no line boundary, so no safe prefix of it can be injected`,
      repair: `Repair: read ${path} — a cut inside that line could split a character or a token, and the cap is not a quota to fill.`,
    };
  }
  return { body: `${head.slice(0, cut)}\n--- Report ${disclosure} — ${trailer}` };
}

/**
 * `{ bytes }` | `{ open: true }` | `{ absent: true }` — how many bytes of `text`
 * the `## CRITERIA` section occupies counted from the start, or which of the two
 * things that count cannot be: no such heading here, or a section whose END was
 * never read. Three named answers and no zero, because "no criteria heading" and
 * "a criteria section of zero bytes" are the same number and different facts
 * (F-028).
 */
function criteriaSpan(text, truncated) {
  const heading = /^## CRITERIA\b.*$/m.exec(text);
  if (heading === null) return { absent: true };
  const from = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(from));
  if (next !== null) return { bytes: Buffer.byteLength(text.slice(0, from + next.index), 'utf8') };
  // Nothing follows it. In a COMPLETE input that is the end of the file and the
  // section is whole; in a truncated one its end is past the bound, and "the
  // section ends where the bytes stopped" is exactly the false completeness claim
  // a decision gate would act on.
  return truncated ? { open: true } : { bytes: Buffer.byteLength(text, 'utf8') };
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
    const from = String(msg?.from_handle ?? '').trim();
    const dispatched = /^dispatch:(.+)$/.exec(from);

    let id;
    let rec;
    if (dispatched !== null) {
      // THE FEDERATED SHAPE: the runtime minted the address from its own
      // dispatch row and the sender carries no pane key by contract.
      id = dispatched[1] ?? '';
      rec = lookup(id);
      if (rec === null || rec === undefined) return '';
    } else {
      // THE WITNESSED SHAPE (#168, measured 2026-09-05 on the fork build): a
      // local supervised worker reports from its own pane, and the dispatch id
      // travels in the payload — the sender's word. The record wrote which pane
      // it dispatched before the dispatch went, and that is what proves the
      // claim; the pane key is what proves the sender is that pane at all
      // (Orca nulls it when a sender overrides its identity). A claim that
      // fails either proof is a finding on the completion, never a derivation
      // and never a silence — a forged "the slice ended" is the hazard here.
      const claimed = String(bag(msg?.payload)?.dispatchId ?? '').trim();
      if (claimed === '') return '';
      rec = lookup(claimed);
      if (rec === null || rec === undefined) return '';
      const witnessed = String(msg?.sender_pane_key ?? '').trim() !== '';
      if (!witnessed) {
        return block(null, [
          `FINDING: this worker_done claims dispatch ${claimed} (request \`${rec.request}\`) from ${from || 'no handle'}, but the sender is not witnessed — Orca recorded no pane key for it. The Report was NOT derived: a completion without a witness is a claim, not a completion.`,
          `Repair: read the pane the record names (\`ax worker tail ${rec.request}\`) before acting on this message.`,
        ]);
      }
      const recordedPane = paneOfDispatch(rec.json, claimed);
      if (recordedPane === '') {
        return block(null, [
          `FINDING: this worker_done claims dispatch ${claimed} (request \`${rec.request}\`), and its record names no pane for that dispatch, so the sender ${from} cannot be cross-checked. The Report was NOT derived.`,
          `Repair: \`ax worker ls\` for \`${rec.request}\` — a worker-start receipt with no terminal effect is the record's inability, and \`ax worker transcript ${rec.request}\` reads the session directly.`,
        ]);
      }
      if (recordedPane !== from) {
        return block(null, [
          `FINDING: this worker_done claims dispatch ${claimed} (request \`${rec.request}\`), whose record names pane ${recordedPane} — not the sender ${from}. The Report was NOT derived: the claim is not this pane's to make.`,
          `Repair: read both panes before acting — \`ax worker tail ${rec.request}\` for the recorded one; the sender is a peer, not this dispatch's worker.`,
        ]);
      }
      id = claimed;
    }

    const derived = reportPath(rec.json);
    if (derived.path === undefined) {
      return block(null, [
        `FINDING: ${derived.reason}.`,
        `Repair: read the dispatch record for \`${rec.request}\` in ax's store — it is the only thing that establishes where this worker's Report is, and it names no single worktree here.`,
      ]);
    }

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

    // THE READ IS BOUNDED BEFORE ANYTHING DECODES OR REDACTS IT (#180): the file
    // is a child's, its size is the child's choice, and this session pays for
    // every byte of it.
    let input;
    try {
      input = boundedRead(fileReal, cap);
    } catch (err) {
      lines.push(`FINDING: the Report at this path could not be read: ${err?.code ?? err}.`);
      lines.push(`Repair: read ${derived.path} on this host; the file resolved, so the fault is in reading it.`);
      return block(derived.path, lines);
    }
    if (input.text.trim() === '') {
      // TWO WAYS TO HAVE NOTHING TO SHOW, and one of them is not an absence: a
      // truncated window with no complete line inside it came off a file that has
      // bytes, so calling it empty aims the repair at a worker who wrote one.
      if (input.truncated) {
        lines.push(
          `FINDING: the Report ran past the ${cap}-byte input bound with no complete line inside it, so nothing from it can be shown safely — a cut mid-line could split a UTF-8 character or a secret.`,
        );
        lines.push(
          `Repair: read ${derived.path} on this host — the file is not empty; its first line is longer than the bound this block reads.`,
        );
      } else {
        lines.push('FINDING: the Report at this path is empty.');
        lines.push(REPAIR);
      }
      return block(derived.path, lines);
    }

    const shown = bounded(input.text, cap, derived.path, input.truncated);
    if (shown.body === undefined) {
      lines.push(`FINDING: ${shown.reason}.`);
      lines.push(shown.repair);
      return block(derived.path, lines);
    }
    return block(derived.path, lines, shown.body);
  } catch (err) {
    // A fault in THIS receiver, not in the completion above it. Saying so is the
    // repair: the reader must not go looking for a worker that misbehaved.
    return block(null, [
      `FINDING: the Report could not be established: ${err}`,
      'Repair: the fault is in this receiver, not in the completion above — the Summary stands, and the Report is still on disk under the worktree the dispatch record names.',
    ]);
  }
}
