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
 * reference, absent reference, evidence that could not be established: each is a
 * named line on a completion that is still injected in full. A withheld
 * completion would cost the orchestrator the one message that says the slice
 * ended.
 *
 * A WORKTREE ON ANOTHER HOST IS AN ADDRESS, NOT A DEAD END (#193). A dispatch
 * placed with `--on <env>` writes its Report over there, and this module used to
 * stop at that fact. It now retrieves it through `./remote.ts` — the recorded
 * environment, the recorded worktree and the recorded request, over the ssh
 * boundary the project's own `dispatch.hosts` declaration describes. Two rules
 * hold whatever that retrieval answers: the owning host resolves its own
 * realpaths and containment is proved on them before a byte is accepted, and
 * NOTHING falls back to this machine. The same derived path usually exists here,
 * holding another slice's file, so a failed retrieval is the named inability it
 * always was — never a read of the impostor next door.
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
import { parseRequest } from '../../src/triage/draft.mjs';
import { requestIdOk } from '../../src/worker/record.mjs';
import { dispatchRecord } from './attribution.ts';
import { fetchRemoteReport } from './remote.ts';
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

/**
 * The four kinds a mint writes (`initRecord`), and nothing else is one. The
 * membership is `../../src/worker/release.mjs`'s: a `kind` outside it collapses
 * to "no kind", exactly as `prove()` collapses it, because a vocabulary read two
 * ways is two vocabularies.
 */
const RECORDED_KINDS = { implementation: true, triage: true, brief: true, custom: true };

/** The kinds whose Pass produces a Draft and no implementation Report. */
const ANALYSIS_KINDS = { triage: true, brief: true, custom: true };

/**
 * `{ kind: 'implementation' }` | `{ analysis }` | `{ reason }` — WHICH artifact
 * this completion owes, decided by the kind its dispatch recorded.
 *
 * THE MEASUREMENT (#207, 2026-09-05). A `--job custom` verification of #174
 * completed with its prescribed Draft written, and this receiver — which never
 * read `kind` — derived an implementation Report path for it, called the Draft
 * the completion named an unauthorized path, reported the Report absent and
 * printed a repair instructing the worker to write one. Two findings, wrong in
 * opposite directions, about an artifact that Pass is forbidden to produce.
 *
 * THE VOCABULARY IS `prove()`'s, NOT A SECOND ONE. `rec.kind` plus the job word
 * `parseRequest` reads, and the same precedence:
 *
 *   * a recorded `implementation` is an implementation, whatever its request
 *     spells — `--name custom-migration` records `kind: implementation` and was
 *     never a job (`../../src/triage/draft.mjs`), so a name that merely looks
 *     like a job word is not a conflict;
 *   * a recorded analysis kind owes a Draft, unless the request's job word names
 *     a DIFFERENT job — the disagreement `prove()` refuses for `triage`/`brief`,
 *     and an exemption is the one thing a contradiction must not buy;
 *   * no kind and no job word is the established implementation it always was,
 *     which keeps every pre-`--kind` record readable;
 *   * no kind and a job word is the untypeable case #178 measured, where both
 *     guesses closed the wrong pane: the fact that is missing is named, and
 *     nothing is derived (F-028).
 *
 * WHY THE MINT-LEGALITY HALF IS NOT CONSULTED, though `prove()` does consult it
 * for `triage`/`brief` (`named.problem`): that verb has to FIND a publication,
 * so it needs the issue and the pass the request encodes, and a request that is
 * no legal mint of the recorded repository denies it both. This side needs
 * neither — the only question here is which artifact is owed, and the kind
 * answers it whole. So an odd but same-job request keeps its Draft exemption,
 * and only a DIFFERENT job word contradicts the record. `parseRequest` carries
 * no emitter dependency — its module imports `node:fs`, `node:path`, the
 * package's hash helper and the spec module, which imports nothing — so reusing
 * it costs this runtime no startup.
 */
export function classifyDispatch(rec) {
  const declared = typeof rec?.kind === 'string' ? rec.kind.trim() : '';
  const recorded = RECORDED_KINDS[declared] === true ? declared : '';
  const request = String(rec?.request ?? '');
  const named = parseRequest(request, rec?.repo);
  if (recorded === 'implementation') return { kind: 'implementation' };
  if (ANALYSIS_KINDS[recorded] === true) {
    if (named.job !== null && named.job !== recorded) {
      return {
        reason: `the record types this dispatch as '${recorded}' while its request \`${request}\` opens on the job word '${named.job}', so which artifact this completion owes cannot be established`,
      };
    }
    return { analysis: recorded };
  }
  if (named.job === null) return { kind: 'implementation' };
  return {
    reason: `the record names no kind, and the request \`${request}\` carries the job word '${named.job}', so which artifact this completion owes cannot be established`,
  };
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
 * WHERE THE CUT IS MADE is `boundWindow`'s, shared with retrieved evidence. What
 * stays here is the descriptor: opened once, filled in a loop, closed on both
 * exits.
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
    return boundWindow(buf, read, cap);
  } finally {
    closeSync(fd);
  }
}

/**
 * `{ text, truncated }` — the window's own rule, applied to bytes from a local
 * descriptor or from the host that owns them. ONE rule, because a second one for
 * retrieved evidence is how a remote read comes to be bounded differently from a
 * local one.
 *
 * `read` is how many of `buf`'s bytes are real. More than `cap` means the source
 * ran past the bound, and the last newline inside the window is the cut: 0x0A
 * never occurs inside a UTF-8 sequence, so it is at once a line boundary, a
 * codepoint boundary and a boundary no secret shape crosses. An empty `text`
 * WITH `truncated` is a source whose first line outruns the window — no safe
 * prefix exists, and the caller names that instead of showing the fragment.
 */
function boundWindow(buf, read, cap) {
  // The window is cap + 1, even when the source handed over more: a retrieved
  // buffer is only as trustworthy as the host that produced it, and decoding
  // past the bound is the cost #180 already refused on a local file.
  const available = Math.min(read, buf.length);
  const truncated = available > cap;
  const window = truncated ? cap + 1 : available;
  if (!truncated) return { text: buf.toString('utf8', 0, window), truncated };
  const nl = buf.lastIndexOf(0x0a, window - 1);
  return { text: nl <= 0 ? '' : buf.toString('utf8', 0, nl), truncated };
}

/**
 * Whether `fileReal` is UNDER `dirReal`, both already resolved, with the
 * separator named by the caller: `sep` for a path this runtime resolved, `/` for
 * one a POSIX host resolved and reported. A prefix test on text would pass
 * `/wt-other/…` against `/wt`, which is why the separator is part of the fence.
 * An empty side is not a location (F-028): `''` plus `/` is `/`, which every
 * absolute path starts with, so the empty case is a refusal rather than a
 * containment of everything.
 */
function contained(dirReal, fileReal, separator) {
  if (dirReal === '' || fileReal === '') return false;
  const fence = dirReal.endsWith(separator) ? dirReal : `${dirReal}${separator}`;
  return fileReal.startsWith(fence);
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
function bounded(text, cap, path, truncated, where) {
  const clean = redactSecrets(text);
  const criteria = criteriaSpan(clean, truncated);
  if (criteria.open === true) {
    return {
      reason: `the Report's \`## CRITERIA\` section runs past the ${cap}-byte input bound — its end was never read, so no complete criteria list can be injected and nothing partial stands in for it`,
      repair: `Repair: read ${path} ${where} — the criteria are there in full, and this block would only have shown the part that fit the bound.`,
    };
  }
  if (criteria.bytes !== undefined && criteria.bytes > cap) {
    return {
      reason: `the Report's \`## CRITERIA\` section alone is ${criteria.bytes} bytes, past the ${cap}-byte cap, so no complete criteria list can be injected and nothing partial stands in for it`,
      repair: `Repair: read ${path} ${where} — the criteria are there in full, and this block would only have shown part of them.`,
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
      repair: `Repair: read ${path} ${where} — a cut inside that line could split a character or a token, and the cap is not a quota to fill.`,
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
 *
 * `head` exists because the default one is a CLAIM: a Pass that owes no
 * implementation Report had nothing derived from its record, and printing
 * "derived from the dispatch record" over that block would be the same false
 * assertion this module exists to refuse (#207).
 */
function block(path, lines, body = '', head = '') {
  const stated =
    head !== ''
      ? head
      : path === null
        ? '--- REPORT (derived from the dispatch record)'
        : `--- REPORT (derived from the dispatch record) · ${path}`;
  const parts = [stated, ...lines];
  if (body !== '') parts.push('---', body);
  return `\n\n${redactSecrets(parts.join('\n'))}\n`;
}

/**
 * The block a window of Report bytes earns, whatever host they came off: the
 * empty cases named apart, then the cap, the redaction and the criteria rules.
 *
 * ONE emitter for local and retrieved evidence. The alternative is a second copy
 * of every disposition below, and the wordings that decide a merge gate are
 * exactly the wordings two copies drift on — the same argument the Report-path
 * twin pays a parity test for.
 */
function injected(input, cap, path, lines, where, diagnose) {
  if (input.text.trim() === '') {
    // TWO WAYS TO HAVE NOTHING TO SHOW, and one of them is not an absence: a
    // truncated window with no complete line inside it came off a file that has
    // bytes, so calling it empty aims the repair at a worker who wrote one.
    if (input.truncated) {
      lines.push(
        `FINDING: the Report ran past the ${cap}-byte input bound with no complete line inside it, so nothing from it can be shown safely — a cut mid-line could split a UTF-8 character or a secret.`,
      );
      lines.push(
        `Repair: read ${path} ${where} — the file is not empty; its first line is longer than the bound this block reads.`,
      );
      diagnose?.({ disposition: 'truncated-empty', path });
    } else {
      lines.push('FINDING: the Report at this path is empty.');
      lines.push(REPAIR);
      diagnose?.({ disposition: 'empty', path });
    }
    return block(path, lines);
  }

  const shown = bounded(input.text, cap, path, input.truncated, where);
  if (shown.body === undefined) {
    lines.push(`FINDING: ${shown.reason}.`);
    lines.push(shown.repair);
    diagnose?.({ disposition: 'unreadable', path, detail: shown.reason });
    return block(path, lines);
  }
  return block(path, lines, shown.body);
}

/**
 * The Report block for a dispatched worker's completion, or `''` for a message
 * that is not one.
 *
 * `record`, `environmentOf` and `retrieve` are named options with real defaults:
 * the dispatch store, the recorded argv and another host's filesystem are all
 * machine answers, and a test must be able to hand over every one of them
 * without a store on disk and without a network.
 */
export function completionReport(msg, deps = {}) {
  const lookup = deps.record ?? dispatchRecord;
  const environmentOf = deps.environmentOf ?? environmentOfDispatch;
  const retrieve = deps.retrieve ?? fetchRemoteReport;
  const cap = deps.cap ?? REPORT_CAP_BYTES;
  // The kind this receiver ESTABLISHED, once it has: it rides every diagnostic
  // written after classification and nothing before it (#207). A guard row
  // carries none, because the guards decide before any kind is read, and a row
  // asserting a job the receiver never typed is the readout defect this repair
  // is about.
  let established = '';
  const diagnose = (entry) => {
    try {
      deps.diagnose?.({
        reason: 'report-unreadable',
        messageId: String(msg?.id ?? '') || undefined,
        ...(established === '' ? {} : { kind: established }),
        ...entry,
      });
    } catch {}
  };

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
        diagnose({
          disposition: 'unwitnessed',
          request: rec.request,
          dispatch: claimed,
        });
        return block(null, [
          `FINDING: this worker_done claims dispatch ${claimed} (request \`${rec.request}\`) from ${from || 'no handle'}, but the sender is not witnessed — Orca recorded no pane key for it. The Report was NOT derived: a completion without a witness is a claim, not a completion.`,
          `Repair: read the pane the record names (\`ax worker tail ${rec.request}\`) before acting on this message.`,
        ]);
      }
      const recordedPane = paneOfDispatch(rec.json, claimed);
      if (recordedPane === '') {
        diagnose({
          disposition: 'pane-unrecorded',
          request: rec.request,
          dispatch: claimed,
        });
        return block(null, [
          `FINDING: this worker_done claims dispatch ${claimed} (request \`${rec.request}\`), and its record names no pane for that dispatch, so the sender ${from} cannot be cross-checked. The Report was NOT derived.`,
          `Repair: \`ax worker ls\` for \`${rec.request}\` — a worker-start receipt with no terminal effect is the record's inability, and \`ax worker transcript ${rec.request}\` reads the session directly.`,
        ]);
      }
      if (recordedPane !== from) {
        diagnose({
          disposition: 'pane-mismatch',
          request: rec.request,
          dispatch: claimed,
        });
        return block(null, [
          `FINDING: this worker_done claims dispatch ${claimed} (request \`${rec.request}\`), whose record names pane ${recordedPane} — not the sender ${from}. The Report was NOT derived: the claim is not this pane's to make.`,
          `Repair: read both panes before acting — \`ax worker tail ${rec.request}\` for the recorded one; the sender is a peer, not this dispatch's worker.`,
        ]);
      }
      id = claimed;
    }

    // WHICH ARTIFACT THIS COMPLETION OWES, read from the record's own `kind`
    // BEFORE any path is derived — and after the guards above, which decide
    // whether there is a completion to classify at all. A job-aware exemption
    // is not authentication, and no kind turns an unproven claim into one.
    const typed = classifyDispatch(rec.json);
    if (typed.reason !== undefined) {
      // NEITHER OBLIGATION IS GRANTED. Not an implementation Report — nothing is
      // derived and no absence is asserted; not an analysis exemption either —
      // a contradiction must not buy one. The fact that is missing is the whole
      // finding (#178, F-028).
      diagnose({ disposition: 'kind-unestablished', request: rec.request, detail: typed.reason });
      return block(
        null,
        [
          `FINDING: ${typed.reason}.`,
          `Repair: read the dispatch record for \`${rec.request}\` in ax's store — it is the only thing that says which artifact this Pass owes, and nothing here derived a path or asked for a file.`,
        ],
        '',
        '--- REPORT (the dispatch record does not type this completion)',
      );
    }
    established = typed.kind ?? typed.analysis;
    if (typed.analysis !== undefined) {
      // A TYPED ANALYSIS PASS OWES A DRAFT, and the Draft is STATED rather than
      // located: this receiver derives, names and opens no Draft path, so no
      // second twin of a path rule is created (the ruling on #207). The
      // obligation is the block's own statement, which leaves the ONE note below
      // for the one thing that is news about this completion.
      const lines = [
        `The governing artifact of this Pass is the Draft its own assignment prescribed — not an implementation Report. None was derived here, and none is owed.`,
      ];
      // The path a worker names is still never opened, and here it is not even a
      // finding: an analysis completion naming its Draft is doing what its
      // assignment asked. The note says a path arrived and that this side did
      // nothing with it — the bytes stay out, because quoting them would be the
      // one thing "not validated" must not look like.
      if (String(bag(msg?.payload)?.reportPath ?? '').trim() !== '') {
        lines.push(
          'NOTE: this completion supplied a path in payload.reportPath; it was neither opened nor validated, and no containment proof is claimed for it.',
        );
      }
      return block(null, lines, '', `--- PASS ARTIFACT (typed from the dispatch record) · ${typed.analysis} Pass \`${rec.request}\``);
    }

    const derived = reportPath(rec.json);
    if (derived.path === undefined) {
      diagnose({
        disposition: 'path-unestablished',
        request: rec.request,
        detail: derived.reason,
      });
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

    // THE HOST DECIDES WHERE THE FILE IS, AND IT IS NOT NEGOTIABLE. The same
    // path exists on this machine often enough — every worktree tree is laid out
    // identically — and reading it would answer with another slice's file.
    // `--on <env>` on the recorded argv is this runtime's evidence for "that
    // worktree is elsewhere" (`route.ts`), and `./remote.ts` is what goes and
    // gets it from there. No local fallback exists on this path: a retrieval that
    // cannot be established is the named inability it always was, never a read of
    // the impostor next door.
    const environment = String(environmentOf(rec.json, id) ?? '');
    if (environment !== '') {
      const where = `on '${environment}'`;
      const got = retrieve({ env: environment, worktree: derived.worktree, path: derived.path, cap });
      if (got.absent === true) {
        lines.push(`FINDING: no Report at this path ${where} — the worker completed without writing one there.`);
        lines.push(REPAIR);
        diagnose({ disposition: 'absent', path: derived.path, request: rec.request, environment });
        return block(derived.path, lines);
      }
      if (got.buf === undefined) {
        lines.push(
          `FINDING: Report inaccessible from this host — this dispatch ran on '${environment}', so the recorded worktree and its Report are on that host, and ${got.reason}.`,
        );
        lines.push(got.repair ?? REPAIR);
        diagnose({
          disposition: 'inaccessible',
          path: derived.path,
          request: rec.request,
          environment,
          detail: got.reason,
        });
        return block(derived.path, lines);
      }
      // THE HOST RESOLVED, THIS SIDE DECIDES. Only that host can resolve its own
      // symlinks, so it reports the two real paths; the containment rule is the
      // one below, on a POSIX separator because a POSIX shell answered. The host
      // refuses to send an escaping path at all, and this refuses to accept one —
      // a boundary that returns bytes anyway never turns them into evidence.
      if (!contained(String(got.worktreeReal ?? ''), String(got.fileReal ?? ''), '/')) {
        lines.push(
          `FINDING: the derived path resolves outside the recorded worktree ${where} — ${got.fileReal} is not under ${got.worktreeReal}. It was NOT read.`,
        );
        lines.push(
          'Repair: inspect that link before trusting anything from this slice; the Report must be a file under the worktree the record names, and a path leading out of it was not written by the rule.',
        );
        diagnose({ disposition: 'outside-worktree', path: derived.path, request: rec.request, environment });
        return block(derived.path, lines);
      }
      // A retrieval that honours the bound sends at most cap + 1. More than that
      // is the same protocol break `./remote.ts` refuses on the wire: accepting
      // a prefix would let an incomplete `## CRITERIA` look complete. The clip
      // in `boundWindow` is defense in depth, not authorization.
      if (got.buf.length > cap + 1) {
        lines.push(
          `FINDING: Report inaccessible from this host — this dispatch ran on '${environment}', so the recorded worktree and its Report are on that host, and the retrieval returned ${got.buf.length} bytes, past the ${cap}-byte bound this receiver reads.`,
        );
        lines.push(
          `Repair: read ${derived.path} ${where} — a retrieval that honours the bound sends at most ${cap + 1} bytes, and an answer past that bound is not a Report this side will decode.`,
        );
        diagnose({ disposition: 'oversize', path: derived.path, request: rec.request, environment });
        return block(derived.path, lines);
      }
      lines.push(
        `NOTE: retrieved from '${environment}', the host this dispatch ran on, where ${got.fileReal} resolves under ${got.worktreeReal}.`,
      );
      return injected(boundWindow(got.buf, got.buf.length, cap), cap, derived.path, lines, where, diagnose);
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
      diagnose({
        disposition: 'worktree-unresolved',
        path: derived.path,
        request: rec.request,
        detail: String(err?.code ?? err),
      });
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
        diagnose({ disposition: 'absent', path: derived.path, request: rec.request });
      } else {
        lines.push(
          `FINDING: the Report at this path did not resolve (${err?.code ?? err}); an absence would be ENOENT, so this is a path fault and not a missing Report.`,
        );
        lines.push(`Repair: inspect ${derived.path} on this host — the fault is in the path, not in the completion.`);
        diagnose({
          disposition: 'path-fault',
          path: derived.path,
          request: rec.request,
          detail: String(err?.code ?? err),
        });
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
      diagnose({ disposition: 'outside-worktree', path: derived.path, request: rec.request });
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
      diagnose({
        disposition: 'unreadable',
        path: derived.path,
        request: rec.request,
        detail: String(err?.code ?? err),
      });
      return block(derived.path, lines);
    }
    return injected(input, cap, derived.path, lines, 'on this host', diagnose);
  } catch (err) {
    // A fault in THIS receiver, not in the completion above it. Saying so is the
    // repair: the reader must not go looking for a worker that misbehaved.
    diagnose({ disposition: 'receiver-fault', detail: String(err) });
    return block(null, [
      `FINDING: the Report could not be established: ${err}`,
      'Repair: the fault is in this receiver, not in the completion above — the Summary stands, and the Report is still on disk under the worktree the dispatch record names.',
    ]);
  }
}
