---
title: An admission list checked only from the artifact's side admits a keyword nobody implemented
date: 2026-09-03
category: bugs
module: src/schema.mjs
problem_type: bug
component: config-validation
severity: low
symptoms:
  - "`patternProperties` named in the validator's `SUPPORTED` set and read nowhere in the file"
  - "Silent no-op: `validate({ abc: 'not-an-integer' }, { type: 'object', patternProperties: { '^[a-z]+$': { type: 'integer' } } })` returned `[]`"
  - "Inverted refusal: beside `additionalProperties: false`, a key the pattern MATCHED carrying a VALID value was answered `root: unknown key \"abc\"` — an error that denies the keyword exists"
  - "The guarantee test `the shipped schema only uses keywords the validator implements` stayed green throughout"
root_cause: one_sided_invariant_check
resolution_type: code_fix
related_components:
  - tests/schema.test.mjs
  - ax.schema.json
tags:
  - json-schema
  - closed-schema
  - refusal-shape
  - test-blindness
  - drift
---
# An admission list checked from one side only

## Problem

`src/schema.mjs` publishes an invariant in its own header: a keyword nobody taught this file throws
at validation time instead of being ignored. `assertSupported` is the whole gate, and membership in
`SUPPORTED` is the whole check — so the invariant holds in one direction only. A keyword the SCHEMA
adds and the code does not know throws. A keyword the LIST names and the code does not honour is
admitted, and nothing downstream is required to implement it.

`patternProperties` was that keyword: listed, read nowhere, and the only entry in the set with zero
uses in `ax.schema.json` — which is the sole reason nothing was broken. Two modes waited for the
first author who reached for it because the list said it was supported. With nothing beside it, a
value violating the pattern subschema produced zero errors: the section is unvalidated and nothing
says so. With `additionalProperties: false` beside it — the shape most object nodes already use —
the key loop reached `additionalProperties` having never consulted the pattern map, so a key the
pattern matched, carrying a valid value, came back as `unknown key`.

The test that exists to guarantee the invariant could not see either mode, by construction: it walks
the shipped schema through `assertSupported`, so it can only ever catch the schema-side direction.

## Fix

The keyword left `SUPPORTED`. Implementing it was declined on the ticket — it widens what the schema
may declare and would have to settle a key matching two patterns, what `additionalProperties: false`
then refuses, and where the pattern map sits relative to the reserved-annotation check — so the
honest state is the refusal. `ax.schema.json` and `ax.config.json` needed no edit (zero uses), and
`src/config.mjs`, the only importer, validates the package's own schema, so no project's config can
start throwing.

The list is now pinned from BOTH sides. Beside the shipped-schema case, `tests/schema.test.mjs`
asserts the refusal by exact message — `ax.schema.json uses unsupported keyword "<keyword>" at
<path>` — for a root node, a root child (`at apps`), a deeper node (`at triage.labels`), and for the
`additionalProperties: false` shape that used to produce the inverted refusal.

## The general shape

An invariant of the form "these two artifacts agree" needs a check per direction. One check answers
"does the artifact use anything the code lacks"; it is silent on "does the code implement everything
the artifact is told it may use". The second direction is the one that ships an unvalidated section,
because the failure is an absence of behaviour and absences pass tests.

A permission list is a promise. Where the promise cannot be verified — the object branch here reads
no pattern map and no test could tell it to — the entry comes off the list rather than staying on it
as documentation of an intention.
