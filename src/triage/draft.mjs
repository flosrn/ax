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
import { ROLE_BY_JOB } from './spec.mjs';

/** Where every triage draft lives, relative to the repository root. Gitignored, by design. */
export const DRAFT_DIR = join('.scratch', 'triage');

/**
 * Where one identity's drafts live. Derived from the ROOT alone — no record
 * read, no network — which is the invariant the whole verb set rests on: the
 * child, `publish`, `status`, `ask`, `answer` and `release` all reach the same
 * directory without being told where it is.
 *
 * One directory, because there is one lane. The retired readiness pass had its
 * own `.scratch/refine/`, and nothing here migrates it: a draft is a transient
 * per-machine artifact, so an old directory left on disk is simply never read
 * again. Files still key on the request id, which carries the job, so two jobs
 * on one issue cannot collide inside it.
 */
export const draftDirFor = root => join(root, DRAFT_DIR);

/**
 * The dispatch identity, which is also the record's key and the draft's name.
 *
 * The job is part of it: a `brief` run on an issue already dispatched as
 * `triage` must create its own request rather than replay the triage record and
 * re-send the triage instruction.
 *
 * PASSES ARE APPEND-ONLY, AND PASS 1 IS UNSUFFIXED
 *
 * A second pass on one issue is a real need — the orchestrator's understanding
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

/**
 * THE SAME GRAMMAR, READ BACK: which job, issue and pass a request names, judged
 * against the repository identity that minted it.
 *
 * It lives beside `requestFor` because it is the same rule in the other
 * direction, and because the alternative was measured: `../worker/release.mjs`
 * took requests apart with `/^(triage|brief)-/` and `request.split('-').pop()`,
 * which reads `p2` as the issue number of every suffixed pass — so pass 2 was
 * refused as "the request names no issue" and its pane could never close, while
 * `custom` matched no kind at all and fell through to the implementation rule,
 * where it asked the PARENT CHECKOUT for a merged pull request and could find
 * one belonging to somebody else's branch.
 *
 * THE REPOSITORY IS AN ARGUMENT, NEVER A GUESS. `owner/ax-tools` slugifies to
 * `owner-ax-tools`, and no amount of hyphen counting says where the repository
 * stops and the issue begins. The recorded identity says, so it is passed in and
 * matched as a whole — trimmed and case-folded, the comparison
 * `../worker/release.mjs` already places a row with.
 *
 * Three shapes, and the third is the one that keeps a mismatch honest:
 *
 *   `{ job: null, problem: '' }` — the request names no triage job. An
 *   implementation request, whose proof is its own branch's merged PR: the
 *   grammar above is complete, so a request with no job word never was one.
 *
 *   `{ job, problem: '<why>' }` — it names a job word and is not a legal mint
 *   of this repository. `prove` consults the recorded `kind` before treating
 *   that as a refusal: a `--name custom-migration` records `kind:
 *   implementation` and never comes here as a job.
 *
 *   `{ job, issue, pass, problem: '' }` — a legal mint of this repository.
 *
 * Neither of the last two shapes TYPES a record on its own, and `prove` never
 * reads them that way: a request carrying a job word and a record carrying no
 * `kind` is an untypeable pane that closes on nothing (../worker/release.mjs).
 */
export function parseRequest(request, repo) {
  const text = String(request ?? '');
  // The job vocabulary is `spec.mjs`'s, where each job's role and playbook are
  // declared: a private list here would be a fourth place a job word lives.
  const job = Object.keys(ROLE_BY_JOB).find(name => text.toLowerCase().startsWith(`${name}-`)) ?? null;
  if (job === null) return { job: null, issue: '', pass: 0, problem: '' };
  const named = String(repo ?? '').trim();
  if (named === '') return { job, issue: '', pass: 0, problem: 'this host recorded no repository for it, so there is no identity to read it against' };
  const prefix = `${job}-${named.replace(/\//g, '-')}-`.toLowerCase();
  if (!text.toLowerCase().startsWith(prefix)) return { job, issue: '', pass: 0, problem: `it does not name ${named}` };
  const tail = text.slice(prefix.length);
  // `-p1` is not legal on the way in either (see above): one pass, one path.
  const shape = /^([1-9][0-9]*)(?:-p([2-9]|[1-9][0-9]+))?$/.exec(tail);
  if (shape === null) return { job, issue: '', pass: 0, problem: `"${tail}" is not an issue number with an optional -p<pass>` };
  return { job, issue: shape[1], pass: shape[2] === undefined ? 1 : Number(shape[2]), problem: '' };
}

/** The one path three parties derive independently. */
export const draftPath = (root, identity) => join(draftDirFor(root), `${requestFor(identity)}.md`);

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
  // `\r?\n`: a CRLF draft otherwise leaves a trailing `\r`, and `$` on the
  // Q-line regex then misses — measured 2026-08-27, ofmchat #81, three legal
  // `Q<n>: [technical] …` openings refused as `carries no Q<n>: line`.
  for (const line of String(text ?? '').split(/\r?\n/)) {
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
export function parseDraft(text) {
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
  return { ...parseDraft(text), path, sha: gitBlobSha(text), lines: text.split('\n').length };
}
