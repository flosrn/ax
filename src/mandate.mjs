// The Deployment mandate vocabulary: what a Spec authorizes before execution,
// and the observations that establish its deployed result.
//
// WHY THIS MODULE EXISTS (#191). Completion is the approved result DEPLOYED and
// verified, and until this file nothing in the instrument could read what
// "deployed" meant for a given Spec. The gap was not cosmetic: a wave whose
// tickets all merged read as finished, so a local merge was the strongest
// evidence anyone had and the deployment step was authorized by whoever
// happened to be typing. An absent mandate is therefore a NAMED BLOCKER here,
// never a permissive default — an instrument that treats silence as
// authorization has granted the one thing it was asked to withhold.
//
// WHERE THE MANDATE LIVES: the Spec's own prose, read from the tracker. Three
// facts the criteria name, in three line kinds a human writes and a machine
// grades:
//
//   Deployment target: <where the approved result is deployed>
//   Permitted operations: <what may be done to deploy and verify it>
//   Observation: <name> — <what establishes it>
//
// One `Observation:` line per observation, each NAMED, because an observation
// has to be individually satisfiable: a paragraph cannot be half-observed and a
// single blob would make "we ran something" enough. The observation is then
// established by a line on that same Spec —
//
//   Observed: <name> — <the evidence>
//   Blocked: <name> — <why it cannot be verified here>
//
// — so a fresh session reads ONE issue and has both the authorization and the
// evidence, and no local file can supply either.
//
// THE GRAMMAR IS THE `Necessary for:` GRAMMAR (./triage/necessity.mjs), on
// purpose: a prose line on the issue, an em dash the doctrine quotes with the
// ASCII spellings accepted so an operator is not refused on orthography, and
// presence established by the first well-formed line. A second vocabulary for
// the same shape of fact is how one of them ends up wrong.
//
// COMPLETE OR ABSENT, NEVER PARTIAL — the rule `CONTEXT.md` already applies to
// an Assignment. A container carrying two of the three parts is `incomplete`,
// and the missing part is named: a target with no observations authorizes a
// deployment nobody can verify, and observations with no target authorize one
// anywhere.
//
// FIRST CONTAINER WINS, AND A SECOND DECLARATION IS AMBIGUOUS. The mandate is
// agreed BEFORE execution, so the body and then the comments in order is the
// reading order, and a second container declaring one is a mandate someone
// changed mid-flight: which one authorizes is not inferable, so nothing does.
// Two observations sharing one name are ambiguous for the same reason —
// neither could ever be established alone.
//
// This module is pure and imports nothing. Its consumer is the Completion read
// (`../completion.mjs` judges, `../frontier.mjs` reads the tracker); a shared
// rule that dragged either of those chains in would be the hole
// `./triage/provenance.mjs` was extracted to close.

/** `Deployment target: <text>` — one line, the first one that answers. */
export const MANDATE_TARGET = /^Deployment target:\s+(\S.*)$/m;

/** `Permitted operations: <text>` */
export const MANDATE_OPERATIONS = /^Permitted operations:\s+(\S.*)$/m;

/**
 * The dash the doctrine quotes is the em dash; en dash, `--` and `-` are
 * accepted so an operator who cannot type one is not refused on orthography.
 * `--` is tried before `-` so a double ASCII dash is not eaten as one.
 */
const DASH = '(?:—|–|--|-)';

/** `Observation: <name> — <what establishes it>`, every one of them. */
export const MANDATE_OBSERVATION = new RegExp(String.raw`^Observation:\s+(\S[^\n]*?)\s+${DASH}\s+(\S.*)$`, 'gm');

/** `Observed: <name> — <evidence>` */
export const OBSERVED_LINE = new RegExp(String.raw`^Observed:\s+(\S[^\n]*?)\s+${DASH}\s+(\S.*)$`, 'gm');

/** `Blocked: <name> — <why it cannot be verified>` */
export const BLOCKED_LINE = new RegExp(String.raw`^Blocked:\s+(\S[^\n]*?)\s+${DASH}\s+(\S.*)$`, 'gm');

/**
 * How two observation names are compared: the same normalization the rest of
 * this package applies to a label or a job name, plus internal whitespace, so
 * `CLI answers` and `cli  answers` are one observation and not two.
 */
export const sameObservation = name => String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const unknown = (why, field) => ({ ok: false, kind: 'unknown', why, field });

const ambiguous = why => ({ ok: false, kind: 'ambiguous', why });

/** Every match of a global pattern, with the pattern's own lastIndex left alone. */
const allOf = (pattern, text) => [...String(text).matchAll(new RegExp(pattern.source, pattern.flags))];

/**
 * The containers a Spec's prose can live in, in reading order, with the author
 * of each — the body first, because the mandate is agreed before execution.
 *
 * A missing body is UNKNOWN and not a Spec with no mandate; an absent comment
 * list is unknown and not an empty one; a comment whose body nobody could read
 * could be the mandate itself (F-028).
 */
function containersOf({ body, comments, author } = {}) {
  if (body === undefined || body === null) {
    return unknown(
      'the Spec body could not be read — an unanswered body is not a Spec that declares no mandate, which is unknown and not an absence (F-028)',
      'body',
    );
  }
  const containers = [{ text: String(body), from: 'the issue body', by: author ?? null }];
  if (!Array.isArray(comments)) {
    return unknown('the Spec comments could not be read — an absent list is not an empty one (F-028)', 'comments');
  }
  for (const [index, entry] of comments.entries()) {
    const text = entry === null || entry === undefined ? undefined : typeof entry === 'string' ? entry : entry.body;
    if (text === undefined || text === null) {
      return unknown(
        `comment ${index + 1} answered no body — a mandate or an observation could be in the comment nobody could read, which is unknown and not an absence (F-028)`,
        'comments',
      );
    }
    containers.push({ text: String(text), from: `comment ${index + 1}`, by: entry?.author?.login ?? null });
  }
  return { ok: true, containers };
}

/** Does this container carry any part of a mandate at all? */
const declaresMandate = text => MANDATE_TARGET.test(text) || MANDATE_OPERATIONS.test(text) || allOf(MANDATE_OBSERVATION, text).length > 0;

/**
 * The Deployment mandate this Spec agreed, read from its own prose.
 *
 * `body` is the Spec body, `author` its login, `comments` each comment as
 * `{ body, author: { login } }` (a bare string is accepted).
 *
 * Returns:
 *   `{ ok: true, target, operations, observations: [{ name, display, establishedBy }], from, by }`
 *   `{ ok: false, kind: 'absent' }`
 *   `{ ok: false, kind: 'incomplete', missing: [...], from, by }`
 *   `{ ok: false, kind: 'ambiguous', why }`
 *   `{ ok: false, kind: 'unknown', why, field }`
 */
export function mandateOf({ body, comments, author } = {}) {
  const read = containersOf({ body, comments, author });
  if (!read.ok) return read;

  const declaring = read.containers.filter(container => declaresMandate(container.text));
  if (declaring.length === 0) return { ok: false, kind: 'absent' };
  if (declaring.length > 1) {
    return ambiguous(
      `two containers of this Spec declare a Deployment mandate (${declaring.map(container => container.from).join(' and ')}) — which one authorizes the deployment is not inferable, and picking one would authorize an operation nobody agreed`,
    );
  }

  const [container] = declaring;
  const target = container.text.match(MANDATE_TARGET);
  const operations = container.text.match(MANDATE_OPERATIONS);
  const observations = allOf(MANDATE_OBSERVATION, container.text);

  const missing = [];
  if (target === null) missing.push('Deployment target');
  if (operations === null) missing.push('Permitted operations');
  if (observations.length === 0) missing.push('Observation');
  if (missing.length > 0) return { ok: false, kind: 'incomplete', missing, from: container.from, by: container.by };

  const seen = new Map();
  for (const found of observations) {
    const name = sameObservation(found[1]);
    if (seen.has(name)) {
      return ambiguous(
        `two observations of this mandate are both named "${found[1].trim()}" — an observation has to be establishable on its own, and one name for two of them can never be`,
      );
    }
    seen.set(name, found);
  }

  return {
    ok: true,
    target: target[1].trim(),
    operations: operations[1].trim(),
    observations: observations.map(found => ({ name: sameObservation(found[1]), display: found[1].trim(), establishedBy: found[2].trim() })),
    from: container.from,
    by: container.by,
  };
}

/**
 * The observations recorded on this Spec, and the verifications declared
 * impossible on it — each with the login that stated it, because an
 * observation is authority and this package never trusts an unattributed one
 * (the frontier's `untrusted-labeler` rule, one level up).
 *
 * Returns `{ ok: true, observed: [...], blocked: [...] }` or the same
 * `unknown` shape as `mandateOf`.
 */
export function observationsOf({ body, comments, author } = {}) {
  const read = containersOf({ body, comments, author });
  if (!read.ok) return read;

  const observed = [];
  const blocked = [];
  for (const container of read.containers) {
    for (const found of allOf(OBSERVED_LINE, container.text)) {
      observed.push({ name: sameObservation(found[1]), display: found[1].trim(), evidence: found[2].trim(), by: container.by, from: container.from });
    }
    for (const found of allOf(BLOCKED_LINE, container.text)) {
      blocked.push({ name: sameObservation(found[1]), display: found[1].trim(), why: found[2].trim(), by: container.by, from: container.from });
    }
  }
  return { ok: true, observed, blocked };
}
