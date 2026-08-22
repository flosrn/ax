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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where drafts live, relative to the repository root. Gitignored, by design. */
export const DRAFT_DIR = join('.scratch', 'triage');

/**
 * The dispatch identity, which is also the record's key and the draft's name.
 *
 * The job is part of it: a `brief` run on an issue already dispatched as
 * `triage` must create its own request rather than replay the triage record and
 * re-send the triage instruction.
 */
export const requestFor = ({ job, repo, issue }) => `${job}-${String(repo).replace(/\//g, '-')}-${issue}`;

/** The one path three parties derive independently. */
export const draftPath = (root, identity) => join(root, DRAFT_DIR, `${requestFor(identity)}.md`);

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
 */
export function parseDraft(text) {
  const labels = [];
  const remove = [];
  const body = [];
  let close = false;
  let empty = false;

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
  const out = { labels, remove, body: comment, close };
  if (empty) return { ok: false, reason: 'a Labels line carries an empty label — a lost group is not a label', ...out };
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
  if (!existsSync(path)) return { ok: false, reason: `no draft at ${path} — nothing to publish yet`, path, labels: [], body: '', close: false };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, reason: `${path} could not be read: ${String(error.message ?? error)}`, path, labels: [], body: '', close: false };
  }
  return { ...parseDraft(text), path };
}
