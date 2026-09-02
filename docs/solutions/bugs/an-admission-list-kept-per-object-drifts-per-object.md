---
title: An admission list kept per object drifts per object, so the same annotation loads in one section and is refused in the next
date: 2026-09-02
category: bugs
module: src/schema.mjs
problem_type: bug
component: config-validation
severity: low
symptoms:
  - "`prGate.$comment` loaded clean while the identical `dispatch.$comment` was refused: `dispatch: unknown key \"$comment\"`"
  - "`$comment` on a keyed map read as an entry OF that map: `dispatch.hosts.$comment: expected object, got string`"
  - "The refusal named the key and not the shape, so `dispatch.entry \"<verb>\"` was advice no config accepts if pasted"
root_cause: per_instance_allowlist
resolution_type: code_fix
related_components:
  - ax.schema.json
  - src/worker/dispatch.mjs
tags:
  - json-schema
  - annotations
  - closed-schema
  - drift
  - refusal-shape
---
# An admission list kept per object drifts per object

## Problem

`$comment` is a reserved JSON-Schema annotation, and `ax.schema.json` closes every object with
`additionalProperties: false`. Admission was therefore hand-listed: `prGate` declared a `$comment`
property, `prGate.tracker` declared one, and no other object did. So the annotation a project
writes to record WHY a value is what it is loaded under one section and was refused under the next
— and on `dispatch.hosts`, a map whose `additionalProperties` is a schema rather than `false`, it
was not even refused as unknown: it was validated as a host, `expected object, got string`.

The list could not be kept correct by maintenance, because the sections a project needs to annotate
are not knowable in advance. Each new object either remembers the line or reintroduces the defect.

## Fix

`src/schema.mjs` treats `$comment` and `$schema` as admitted wherever an object is, checked
structurally in the object branch — **before** `additionalProperties` is consulted, which is what
covers both of its readings at once: a closed object must not refuse the annotation, and a keyed map
must not validate it as one of its entries. A non-string annotation is still refused by name, since
`$comment: {...}` is a section someone meant to nest and did not, and every other unknown key keeps
its `unknown key "<name>"` refusal.

The declarations left in `ax.schema.json` under `prGate` and `prGate.tracker` are documentation
only: they say what a comment THERE is for, and an editor validating `ax.config.json` against the
schema reads them. No code path depends on them any more.

## The general shape

An allowlist maintained per instance of a rule drifts to the number of instances. When the rule is
"this is admitted everywhere", the place to say so is the one function that walks the structure —
not each node of it.

The same pass fixed the refusal beside it: `ax worker dispatch` on a project with no `dispatch.entry`
printed the key path. A key path does not say where the key goes, and `dispatch` may not exist in
that file at all, so the repair is now the JSON to paste —
`{ "dispatch": { "entry": "<verb>" } }` — with `--task` still named as the other route out.
