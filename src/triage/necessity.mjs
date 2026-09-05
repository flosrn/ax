// The necessity vocabulary: the one line that admits a finding to a pass.
//
// WHY THIS MODULE EXISTS (#188). `provenanceVerdict` refused every finding in
// the triage and brief lanes, because a finding arrives WITH its measurement
// and a pass re-measures what is measured. That blanket had its own cost: a
// finding whose repair an APPROVED spec cannot be satisfied without had no
// lane — the maintainer answers the instrument, `to-tickets` needs a human
// to amend a spec, so necessary work discovered mid-wave waited on a person
// who was not in the room. The admission is this line, and only this line,
// so a recommendation an agent writes is not an admission, and a number
// without an obligation is not one either.
//
// THE TOOL GRADES THE SHAPE. Whether the work is genuinely necessary is the
// triage pass's analysis and the orchestrator's ruling. Admission to a pass
// is not authorization to implement: the frontier remains the authority.
//
// THE READ IS THE PROOF. An unanswered body is not an issue that carries no
// justification, and a comment whose body nobody could read could be the
// justification (F-028). Presence is established by the first well-formed
// line; absence is established only once every container that could hold one
// has been read.
//
// This module is pure and imports nothing: dispatch is the only consumer
// today, and a shared rule that dragged the dispatch verb's Orca chain into
// a second consumer would be the hole `provenance.mjs` was extracted to close.

/**
 * The line the vocabulary defines. An identified spec, then the obligation.
 *
 * The em dash is the spelling the doctrine quotes; en dash, `--` and `-` are
 * accepted so an operator who cannot type an em dash is not refused on
 * orthography. `--` is tried before `-` so a double ASCII dash is not eaten
 * as one.
 */
export const NECESSITY_LINE = /^Necessary for:\s+#([1-9]\d*)\s+(?:—|–|--|-)\s+(\S.*)$/m;

const unknown = (why, field) => ({ ok: false, kind: 'unknown', why, field });

const matchNecessity = text => {
  const found = String(text).match(NECESSITY_LINE);
  return found === null ? null : { ok: true, spec: Number(found[1]), obligation: found[2].trim() };
};

/**
 * Does this issue's own prose name an approved obligation the finding serves?
 *
 * `body` is the issue body; `comments` is each comment's body. A missing
 * container is unknown, never empty (F-028).
 *
 * Returns:
 *   `{ ok: true, spec, obligation }` — one well-formed line, first match
 *   `{ ok: false, kind: 'absent' }`
 *   `{ ok: false, kind: 'unknown', why, field }`
 */
export function necessityOf({ body, comments } = {}) {
  if (body === undefined || body === null) {
    return unknown(
      'the issue body could not be read — an unanswered body is not an issue that carries no justification, which is unknown and not an absence (F-028)',
      'body',
    );
  }
  const fromBody = matchNecessity(body);
  if (fromBody) return fromBody;

  if (!Array.isArray(comments)) {
    return unknown('the comments could not be read — an absent list is not an empty one (F-028)', 'comments');
  }
  for (const [index, text] of comments.entries()) {
    if (text === undefined || text === null) {
      return unknown(
        `comment ${index + 1} answered no body — a justification could be in the comment nobody could read, which is unknown and not an absence (F-028)`,
        'comments',
      );
    }
    const found = matchNecessity(text);
    if (found) return found;
  }
  return { ok: false, kind: 'absent' };
}
