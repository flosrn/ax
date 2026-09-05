// The provenance vocabulary: which classes a ticket's ORIGIN can be, and how a
// declared name is matched against a carried label. One rule, three consumers.
//
// WHY THIS MODULE EXISTS. The classes were declared once, in `ax.schema.json`,
// and then re-listed by every verb that judges them — `provenanceVerdict`
// (`./dispatch.mjs`) read three, `ax frontier` read three, and `ax triage
// publish` composed its own list of two. Measured 2026-09-05 (#179): an issue
// born with a declared FINDING label was invisible to publish's add-side gate,
// so a draft naming an inbound `source:` label published over it and the issue
// carried two provenance labels at once — the exact state the group's doctrine
// forbids ("already on the issue at birth — keep it, never add a second") and
// the one `ax frontier` then excludes as `provenance-refused`. A third class
// added to two lists out of three is not a hole in one verb; it is a
// vocabulary that was never one thing.
//
// So the list lives here, and each verb keeps its own DECISION over it: publish
// grades a draft's directives against the proposed result, dispatch refuses a
// pass whose lane the origin forbids, frontier excludes a ticket whose labels
// contradict each other. What none of them keeps is a private copy of which
// classes exist.
//
// THE NAMES ARE ALWAYS THE PROJECT'S. Nothing here names a label: `spec`,
// `inbound` and `findings` are config keys, and the strings under them are the
// consuming repository's own (`triage.provenance`). A `source:`-style spelling
// hard-coded in this package would be one project's taxonomy living in a tool.
//
// This module is pure and imports nothing: `src/frontier.mjs` consumes it, and
// a shared rule that dragged the dispatch verb's Orca and worker chain into a
// read-only verb's import graph would be paid at every `ax frontier` run.

/**
 * Does a DECLARED provenance label name the same tracker label as a carried one?
 *
 * GitHub label names are case-insensitively unique, so this comparison cannot
 * over-match — and byte-exact matching had a real cost: a config that wrote
 * `Source:Roadmap`, or left a trailing space, produced an empty intersection,
 * which `provenanceVerdict` cannot tell from "this project declared no
 * vocabulary". So the gate returned null and the wrong lane started. Every
 * message still prints the DECLARED name that matched, because that is the
 * string an operator has to go and correct.
 */
export const sameLabel = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Which of `names` the label set carries, in declared order. */
export const declaredCarried = (names, labels) => names.filter(name => labels.some(carried => sameLabel(name, carried)));

/**
 * The supported classes, in the order a receipt names them: the config key the
 * project declares its labels under, and the words a refusal uses for it.
 *
 * `a finding` reads as an article on purpose — the refusals it appears in say
 * "one ticket cannot be both inbound and a finding", and a bare `finding`
 * there would be a sentence nobody wrote.
 */
export const PROVENANCE_CLASSES = [
  { key: 'spec', kind: 'spec-born' },
  { key: 'inbound', kind: 'inbound' },
  { key: 'findings', kind: 'a finding' },
];

/** The declared keys alone — what a config-shape check has to cover. */
export const PROVENANCE_KEYS = PROVENANCE_CLASSES.map(({ key }) => key);

/**
 * Every provenance name this project declared, whatever class declared it.
 *
 * The one list a caller wants when the question is "is this name provenance at
 * all" rather than "which class is it": publish's birth rule grades an ADD
 * against it, because the group's doctrine forbids a second name whichever
 * class the second name belongs to.
 */
export const declaredProvenance = declared => PROVENANCE_KEYS.flatMap(key => declared?.[key] ?? []);

/**
 * Which declared classes a label set carries — `{ key, kind, names }` per
 * class, non-empty ones only, in `PROVENANCE_CLASSES` order.
 *
 * Two or more entries is the contradiction every consumer refuses, and none of
 * them picks a side: no pass, and no publication, follows from a ticket that is
 * two origins at once. An UNDECLARED class contributes nothing — an absent
 * declaration is not a rule (F-028) — and a project that declares no
 * provenance at all gets an empty list, which is its opt-out.
 *
 * The caller passes label STRINGS: the shapes a tracker read answers with
 * (`{ name }` nodes, a `labels` array) differ per verb, and normalizing them
 * here would make this rule the one place that has to know all of them.
 */
export function carriedClasses(declared, labels) {
  return PROVENANCE_CLASSES.map(({ key, kind }) => ({ key, kind, names: declaredCarried(declared?.[key] ?? [], labels) })).filter(
    ({ names }) => names.length > 0,
  );
}
