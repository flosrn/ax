// What a triage session hands back, and the one place its shape is decided.
//
// The child of a triage dispatch mutates nothing: it reads the issue, judges it,
// and writes ONE file. The human reads that file, corrects it, and publishes it.
// That ordering is the whole point — a verdict that lands the moment it is
// rendered cannot be adjusted, and the four issues of 2026-08-10 landed with
// three empty label groups each precisely because the child was the one applying
// them.
//
// So this module owns two things and nothing else:
//
//   * the PATH, derived from the dispatch identity alone, so the child, `publish`
//     and the operator all reach the same file without being told where it is
//   * the SHAPE, as a set of refusals — every way a draft can fail to be
//     publishable has to be a named reason, because the alternative is a `gh`
//     call that applies half of what its author meant
//
// What is deliberately NOT here: how many label groups a complete triage has.
// `category, priority, complexity, source, domains` is one project's vocabulary,
// declared in that project's own docs and read by the child. A constant here
// would be a project constant in `src/`, which is the one thing this package
// cannot carry.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { gitBlobSha } from '../hash.mjs';

/** Where triage/brief/custom drafts live, relative to the repository root. Gitignored, by design. */
export const DRAFT_DIR = join('.scratch', 'triage');
/** Where refine drafts live. Its own directory, because one flat dir for every job was measured as noise. */
const REFINE_DIR = join('.scratch', 'refine');

/**
 * Where one identity's drafts live. Job-keyed and derived from the identity
 * alone — no record read, no network — which is the invariant the whole verb
 * set rests on: the child, `publish`, `status`, `ask`, `answer` and `release`
 * all reach the same directory without being told where it is.
 *
 * Grouping refine drafts by PARENT PRD was considered and deliberately
 * deferred: the parent is not in the identity, so a parent-keyed path would
 * need the dispatch record (or a `gh` call) at every read site — and the
 * record writer lives in `src/worker/start.mjs`, whose write-ahead schema
 * (F-001) has no seam for a triage parent. The wave record, which owns the
 * tickets→PRD mapping, is where per-PRD grouping belongs when it exists.
 * Triage/brief/custom paths stay byte-identical: transient per-machine drafts
 * are never migrated mid-flight.
 */
export const draftDirFor = (root, identity) => join(root, identity.job === 'refine' ? REFINE_DIR : DRAFT_DIR);

/**
 * The dispatch identity, which is also the record's key and the draft's name.
 *
 * The job is part of it: a `brief` run on an issue already dispatched as
 * `triage` must create its own request rather than replay the triage record and
 * re-send the triage instruction.
 *
 * PASSES ARE APPEND-ONLY, AND PASS 1 IS UNSUFFIXED
 *
 * A second pass on one issue is a real need — the coordinator's understanding
 * moved, a sibling ticket moved, or the first pass was wrong — and on
 * 2026-08-22 it had no verb at all: the operator went around `dispatch`
 * entirely, hand-editing the child's draft with string replacements.
 *
 * Nothing is ever renamed to make room for a new pass. A rename invalidates
 * every live reference to the old path — a status copied into notes, a brief
 * already sent, a concurrent read inside the rename window — which is the same
 * stale-anchor failure that cost draft #54. Immutable paths are the cure, and
 * the same one the draft fingerprint applies.
 *
 * Pass 1 carries no suffix so that every record and draft written before passes
 * existed keeps working, unmoved. `-p1` is therefore never a legal name: one
 * pass, one path.
 */
export const requestFor = ({ job, repo, issue, pass = 1 }) =>
  `${job}-${String(repo).replace(/\//g, '-')}-${issue}${pass > 1 ? `-p${pass}` : ''}`;

/** The one path three parties derive independently. */
export const draftPath = (root, identity) => join(draftDirFor(root, identity), `${requestFor(identity)}.md`);

/**
 * Which passes of one issue already exist in a directory, oldest first.
 *
 * One definition for two questions, because the naming rule is one rule: the
 * store answers "which passes were dispatched" (`.json`) and the draft dir
 * answers "which passes were written" (`.md`). A caller that scanned with its
 * own regex would be a second naming rule, which is what `draftPath`'s comment
 * already forbids.
 *
 * An unreadable directory answers `[]` rather than throwing: a machine that has
 * never dispatched has no passes, and that is the ordinary first run. Callers
 * that must not treat absence as emptiness check the directory themselves —
 * `dispatch` already refuses on an unreadable store for exactly that reason.
 */
export function passesIn(dir, identity, extension) {
  const base = requestFor({ ...identity, pass: 1 });
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const found = [];
  for (const name of names) {
    if (!name.endsWith(extension)) continue;
    const stem = name.slice(0, -extension.length);
    if (stem === base) {
      found.push(1);
      continue;
    }
    if (!stem.startsWith(`${base}-p`)) continue;
    const digits = stem.slice(base.length + 2);
    // `-p1` is not pass 1 under another name, it is a name no writer here
    // produces — so it is ignored rather than silently folded into pass 1.
    if (!/^[1-9][0-9]*$/.test(digits)) continue;
    const pass = Number(digits);
    if (pass > 1) found.push(pass);
  }
  return found.sort((a, b) => a - b);
}

/**
 * Every pass of one issue that exists at all: dispatched, written, or both.
 *
 * The union is the load-bearing part, and it was got wrong three times in one
 * sitting before being named here. A pass just dispatched has a RECORD and a
 * live pane but no `.md` yet; a pass written by hand can be the reverse. Any
 * reader that consults one side alone concludes an older pass is the newest —
 * and then publishes it, distils it, or reports it, under a child that is at
 * that moment writing its replacement.
 *
 * So: three callers, one universe. `publish` decides what lands, `status`
 * decides what to show, and the `brief` precheck decides what to distil.
 */
export function passesOf(storeDir, draftDir, identity) {
  const both = new Set([...passesIn(storeDir, identity, '.json'), ...passesIn(draftDir, identity, '.md')]);
  return [...both].sort((a, b) => a - b);
}

/**
 * Every `Q<n>:` line of one text, in the order written.
 *
 * One extraction for three readers: `parseDraft` collects the draft's own
 * questions with it, `ask` sends exactly what it returns, and `answer` runs it
 * over the ask message it is about to answer to prove the wire and the record
 * still agree. A second regex in any of them is a second grammar, which is how
 * three children produced three escalation layouts on 2026-08-22.
 */
export function questionsIn(text) {
  const questions = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^Q([0-9]+):\s*(.*)$/.exec(line);
    if (match !== null) questions.push({ n: Number(match[1]), text: match[2].trim() });
  }
  return questions;
}

/**
 * Why a question set cannot be answered by number, or null when it can.
 *
 * Named once because it guards two gates: `parseDraft` refuses to call such a
 * draft publishable, and `ask` refuses to put it on the wire — a ruling keyed
 * by number must reach exactly one question, so blanks, repeats and gaps are
 * all the same defect: a pairing that would drop or misroute an answer.
 */
export function questionProblem(questions) {
  if (questions.some(question => question.text === '')) {
    return 'a Q line carries no question — an empty ask cannot be answered, and a fold would pair a ruling to nothing';
  }
  const numbered = questions.map(question => question.n);
  const twice = numbered.filter((n, index) => numbered.indexOf(n) !== index);
  if (twice.length > 0) return `two questions are numbered Q${twice[0]} — a ruling keyed by number could not reach either`;
  // Consecutive from 1, in order. A fold pairs answers BY NUMBER, so a gap is a
  // question whose ruling would be silently dropped.
  const misnumbered = numbered.findIndex((n, index) => n !== index + 1);
  if (misnumbered !== -1) {
    return `questions are numbered ${numbered.join(', ')} — they have to run 1..${numbered.length} in order, because a fold pairs rulings by number`;
  }
  return null;
}

/**
 * Read the labels and the comment out of a draft, or say why it cannot be
 * published.
 *
 * `Labels:` lines may repeat — a child writing one line per group is the shape
 * that makes a correction cheap, and the shape the spec asks for. Everything
 * that is not a directive line is the comment body, verbatim: it is what a human
 * will read on the issue months later, so nothing here rewrites it.
 *
 * A directive value is split on commas and trimmed, and NOTHING else is done to
 * it. No group prefix is stripped, no trailing justification is removed, and
 * that restraint is the whole design. Measured 2026-08-22 across the first three
 * real drafts, which used three different grammars: `Labels: category → enhancement`,
 * `Labels: enhancement` plus an invented `Remove on publish: needs-triage
 * (superseded by needs-info).`, and the canonical bare form. Normalising those
 * would mean guessing what a label name looks like, which this package cannot
 * know — GitHub allows spaces, arrows and parentheses in a label. On the add
 * side a guess merely fails at the API; on the REMOVE side a guess that happens
 * to hit an existing name deletes something no child ever asked for, silently
 * and irreversibly. So the names travel verbatim, and `publish` checks them
 * against the repository's own label list before it mutates anything.
 *
 * `Q<n>:` lines are the one directive that is ALSO body. A question is content —
 * the maintainer reads it on the issue and answers it there — so consuming it
 * the way `Labels:` is consumed would delete the escalation it exists to carry.
 * What the number buys is addressability: a ruling can name Q2 without quoting
 * it, which is what makes folding answers back a mechanical step instead of
 * markdown surgery. Measured 2026-08-22: three children asked their questions in
 * three layouts ("What we still need from you", a/b/c sub-points, inline forks),
 * and every fold was a bespoke ~200-line string edit against anchors that went
 * stale when a child rewrote its draft.
 */
export function parseDraft(text, job = 'triage') {
  if (job === 'refine') return parseRefineDraft(text);
  const labels = [];
  const remove = [];
  const body = [];
  let close = false;
  let empty = false;
  // Collected by the shared extraction, and deliberately NOT consumed out of
  // the body below: a question is content — the human reads it on the issue —
  // so eating it the way `Labels:` is eaten would delete the escalation.
  const questions = questionsIn(text);

  const collect = (into, value) => {
    for (const entry of value.split(',')) {
      const label = entry.trim();
      // A trailing or doubled comma is how a hand-edited draft loses a group
      // without saying so. Dropping it silently applies less than its author
      // meant, which is the failure this whole file exists to prevent.
      if (label === '') empty = true;
      else if (!into.includes(label)) into.push(label);
    }
  };

  for (const line of String(text ?? '').split('\n')) {
    // Ordered longest-first: `Labels:` is a prefix of nothing here, but
    // `Remove labels:` must be tried before any looser pattern is added later.
    const removeLine = /^Remove labels:\s*(.*)$/.exec(line);
    if (removeLine !== null) {
      collect(remove, removeLine[1]);
      continue;
    }
    const labelLine = /^Labels:\s*(.*)$/.exec(line);
    if (labelLine !== null) {
      collect(labels, labelLine[1]);
      continue;
    }
    const closeLine = /^Close:\s*(.*)$/.exec(line);
    if (closeLine !== null) {
      close = /^(yes|true)$/i.test(closeLine[1].trim());
      continue;
    }
    body.push(line);
  }

  const comment = body.join('\n').trim();
  const out = { labels, remove, body: comment, close, questions };
  if (empty) return { ok: false, reason: 'a Labels line carries an empty label — a lost group is not a label', ...out };
  const asked = questionProblem(questions);
  if (asked !== null) return { ok: false, reason: asked, ...out };
  if (labels.length === 0) return { ok: false, reason: 'this draft names no label, so there is nothing to apply', ...out };
  // Both directives naming one label is not a transition, it is a contradiction,
  // and `gh` would accept it and leave the outcome to its own ordering.
  const both = labels.filter(label => remove.includes(label));
  if (both.length > 0) return { ok: false, reason: `this draft both applies and removes ${both.join(', ')} — one of the two lines is wrong`, ...out };
  if (comment === '') return { ok: false, reason: 'this draft names no verdict — a label set with no reasoning is the data entry it replaced', ...out };
  return { ok: true, ...out };
}

/**
 * The refine ruleset: a Definition-of-Ready verdict, not a categorization.
 *
 * Everything the triage grammar treats as the point — label directives — is a
 * refusal here. A refine child that writes `Labels:` has misread its job
 * (categorization was decided by the PRD), and silently ignoring the line would
 * publish a draft whose author believed something the publisher discarded.
 *
 * Readiness is said out loud, `Ready: yes|no`, because with directives gone the
 * draft has no structured channel left and structural inference is wrong twice
 * over: a gate-failed draft carrying a repair proposal has no `Q<n>:` lines
 * either, and an absent line must be a MALFORMED refusal, never a quiet verdict
 * — a hand edit that drops the line, or leaves two of them, must not publish by
 * parser accident. That is also why the cardinality rules below are fail-closed:
 * exactly one `Ready:`, exactly one `## Agent Brief`, then exactly one
 * `## Verification`.
 *
 * The split between the two sections is the noise fix measured on
 * goodluckagency/ofmchat#52-#54: the published comment triple-stated rulings and
 * justified labels the PRD had already decided, while the evidence a reviewer
 * needs (file:line reads) rots on the tracker. So `body` is the Agent Brief
 * slice ONLY — what `publish` posts — and the Verification section never leaves
 * `.scratch`; it is the coordinator's review material.
 *
 * The return distinguishes three states `status` must render apart (R8):
 * publishable (`ok: true`), not-ready-by-verdict (`ok: false, ready: 'no'`,
 * structure valid — the repair path), and malformed (`ok: false, ready: null`
 * or a structural reason). `ready` is set only once the structure held, so a
 * caller may branch on it without re-deriving the grammar.
 */
function parseRefineDraft(text) {
  const lines = String(text ?? '').split('\n');
  const questions = questionsIn(text);
  const refuse = (reason, ready = null) => ({ ok: false, reason, labels: [], remove: [], body: '', close: false, questions, ready });

  for (const line of lines) {
    if (/^(Labels|Remove labels|Close):/.test(line)) {
      return refuse(`a refine draft carries no label directives, but this one says \`${line.trim()}\` — categorization was decided by the PRD; refine publishes only ready-for-agent`);
    }
  }

  const verdicts = lines.filter(line => /^Ready:/.test(line));
  if (verdicts.length === 0) return refuse('this draft says no `Ready: yes|no` — an absent verdict is a malformed draft, never a quiet not-ready');
  if (verdicts.length > 1) return refuse(`this draft says \`Ready:\` ${verdicts.length} times — two verdicts cannot both stand, and a hand edit that left both must not publish by accident`);
  const verdict = verdicts[0].slice('Ready:'.length).trim().toLowerCase();
  if (verdict !== 'yes' && verdict !== 'no') return refuse(`\`${verdicts[0].trim()}\` is neither \`Ready: yes\` nor \`Ready: no\` — the verdict has two values, said exactly`);

  const briefAt = lines.flatMap((line, i) => (/^## Agent Brief\s*$/.test(line) ? [i] : []));
  const verifAt = lines.flatMap((line, i) => (/^## Verification\s*$/.test(line) ? [i] : []));
  if (briefAt.length === 0) return refuse('this draft has no `## Agent Brief` section — there is nothing to publish');
  if (briefAt.length > 1) return refuse('this draft has two `## Agent Brief` sections — the publishable slice must be unambiguous');
  if (verifAt.length === 0) return refuse('this draft has no `## Verification` section — the coordinator reviews the gate evidence, not the verdict alone');
  if (verifAt.length > 1) return refuse('this draft has two `## Verification` sections — the boundary of what never reaches the tracker must be unambiguous');
  if (verifAt[0] < briefAt[0]) return refuse('the `## Verification` section precedes `## Agent Brief` — the published slice is the bytes between the two, in that order');

  const body = lines.slice(briefAt[0] + 1, verifAt[0]).join('\n').trim();
  if (body === '') return refuse('the Agent Brief is empty — a verdict with nothing to publish is not ready');

  const out = { labels: [], remove: [], body, close: false, questions, ready: verdict };
  const asked = questionProblem(questions);
  if (asked !== null) return { ok: false, reason: asked, ...out };
  if (verdict === 'no') return { ok: false, reason: 'not ready — this draft carries a repair proposal; correct the ticket (or the draft) and redispatch with --fresh', ...out };
  return { ok: true, ...out };
}

/**
 * The draft for one dispatch, off disk.
 *
 * An absent file is the ordinary case, not an error: it means the session has
 * not finished, or was never dispatched. So the refusal names the path the child
 * owed, which is also the path an operator can look at to see how far it got.
 */
export function readDraft(root, identity) {
  const path = draftPath(root, identity);
  if (!existsSync(path)) {
    return { ok: false, reason: `no draft at ${path} — nothing to publish yet`, path, labels: [], remove: [], body: '', close: false, questions: [], sha: '', lines: 0 };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, reason: `${path} could not be read: ${String(error.message ?? error)}`, path, labels: [], remove: [], body: '', close: false, questions: [], sha: '', lines: 0 };
  }
  // The fingerprint is `git hash-object`'s, not an invented digest: a draft that
  // moved between a read and a fold is the failure this answers, and an operator
  // has to be able to check the version they hold with a command they already
  // trust. Measured 2026-08-22: #54 went from 106 lines to 117 after its child
  // had already reported, with no signal, and every anchor against it was stale.
  return { ...parseDraft(text, identity.job), path, sha: gitBlobSha(text), lines: text.split('\n').length };
}
