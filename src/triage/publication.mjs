// The PUBLICATION a triage job and Pass are proven by: one attribution, stamped
// by the verb that lands it and read by the verb that closes on it.
//
// WHY THIS MODULE EXISTS (#178). `ax triage publish` posted a comment carrying a
// per-job disclaimer, and `ax worker release` proved a triage pane with "a
// comment on that issue, created AFTER the dispatch". Those are two different
// questions, and the second one is answered by artifacts that have nothing to do
// with the pass: a reporter's reply, another job's Agent Brief, the PREVIOUS
// pass's verdict — each of them newer than the dispatch, each of them enough to
// close a pane whose own work never landed. A disclaimer cannot close the hole
// either: it names the wording that wrote a comment, never the pass it belongs
// to, so `triage` pass 1 and `triage` pass 2 are indistinguishable under it.
//
// So the publication carries its own identity — repository, issue, job, pass —
// and the rule for reading it lives here, once, because a publisher and a
// releaser that each spelled it would be one rule with two spellings: the
// failure `provenance.mjs` was extracted for (#179).
//
// THE MARKER IS AN HTML COMMENT, for two properties a rendered line cannot have:
// GitHub hides it from every reader, so a verdict is not decorated with
// bookkeeping; and it is a machine field rather than prose, so a human editing
// the comment's text does not silently unpublish their own pass. It is written
// at the very TOP of the body: the bytes below it are exactly the rendering the
// publisher's duplicate protection compares, which is why `withoutMarker` exists
// rather than a second rendering.
//
// WHAT IS DELIBERATELY NOT HERE: any rule about WHEN a publication authorizes a
// close. That belongs to `../worker/release.mjs`, which owns every landing proof
// and asks this module only "which pass is this comment for". Nothing here reads
// the tracker, spawns a process or knows what a pane is.

/**
 * One attribution, and the fields a legal one carries.
 *
 * The pattern is deliberately loose about spacing and strict about fields: a
 * marker written by a future version with an extra key still parses (its unknown
 * keys are ignored), while a marker missing any of the four identifies nothing
 * and says so. `[^>]*?` cannot run past the comment's own terminator, so a body
 * carrying `-->` in prose below the marker cannot extend it.
 */
const MARKER = /<!--\s*ax:publication\s+([^>]*?)\s*-->/;

/**
 * The stamp a publication carries. `pass` is always written, including pass 1:
 * an absent field would make "pass 1" and "a marker from before passes were
 * attributed" the same bytes, and the second one proves nothing.
 */
export const publicationMarker = ({ job, repo, issue, pass = 1 }) =>
  `<!-- ax:publication job=${job} repo=${repo} issue=${issue} pass=${pass} -->`;

/**
 * The comment text WITHOUT its attribution — what a bytes comparison against a
 * locally rendered draft has to be made against.
 *
 * Both directions matter: a stamped comment must still be recognized as this
 * draft's rendering (the leftover-draft hazard, measured 26 times on
 * goodluckagency/ofmchat), and a comment published BEFORE attribution existed
 * carries no marker and must be recognized unchanged. Leading whitespace is left
 * to the caller's own normalization, which already trims.
 */
export const withoutMarker = text => String(text ?? '').replace(new RegExp(MARKER.source, 'g'), '');

/**
 * Repository and job names compared the way the rest of this package compares an
 * identity: trimmed and case-folded. `../worker/release.mjs` places a row on the
 * same comparison, so a marker stamped by a checkout that spells its slug with
 * different case is the same repository here as it is there.
 */
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Which pass a comment is the publication of.
 *
 * Three answers, and the distinction between the last two is load-bearing:
 *
 *   `null` — no attribution at all. An ordinary comment, or an AI publication
 *   from before #178. It identifies nothing, and it is not evidence of absence
 *   either: a caller that must not publish twice still has its own bytes and
 *   disclaimer checks.
 *
 *   `{ ok: false }` — an attribution that does not parse, or TWO attributions
 *   in one comment. AMBIGUOUS, never absent: something published for this
 *   ticket and nothing here can say for which pass, so no automatic decision
 *   may follow from it (F-028). A first marker that happens to match is not a
 *   match when a second one sits beside it.
 */
export function publicationIn(body) {
  const text = String(body ?? '');
  // `matchAll` needs the global flag; the module-level pattern stays unflagged
  // so a caller cannot be surprised by `lastIndex`. Two hits is the case a
  // first-match reader would have treated as this pass — and must not.
  const all = [...text.matchAll(new RegExp(MARKER.source, 'g'))];
  if (all.length === 0) return null;
  if (all.length > 1) return { ok: false, job: '', repo: '', issue: '', pass: 0 };
  const found = all[0];
  const fields = new Map();
  for (const pair of found[1].split(/\s+/)) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at);
    // A second `job=` (or repo/issue/pass) is two claims in one stamp: last-wins
    // would pick a side, which is how `job=brief job=triage` authorizes a triage
    // close. Unknown keys stay last-wins so a future version can add one.
    if (fields.has(key) && (key === 'job' || key === 'repo' || key === 'issue' || key === 'pass')) {
      return { ok: false, job: '', repo: '', issue: '', pass: 0 };
    }
    fields.set(key, pair.slice(at + 1));
  }
  const job = fields.get('job') ?? '';
  const repo = fields.get('repo') ?? '';
  const issue = fields.get('issue') ?? '';
  const pass = fields.get('pass') ?? '';
  if (job === '' || repo === '' || !/^[1-9][0-9]*$/.test(issue) || !/^[1-9][0-9]*$/.test(pass)) {
    return { ok: false, job, repo, issue, pass: 0 };
  }
  return { ok: true, job, repo, issue, pass: Number(pass) };
}

/**
 * Is this comment the publication of THAT pass? All four fields or nothing: one
 * field off is another job, another pass or another repository's ticket, and
 * every one of those was accepted as proof before this rule existed.
 */
export const samePublication = (identity, found) =>
  found !== null &&
  found.ok === true &&
  sameName(found.job, identity.job) &&
  sameName(found.repo, identity.repo) &&
  found.issue === String(identity.issue) &&
  found.pass === Number(identity.pass);

/** How a receipt names one publication: the pass it proves, in the words a refusal uses. */
export const publicationName = found => `${found.job} pass ${found.pass} of ${found.repo}#${found.issue}`;
