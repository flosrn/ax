---
title: A reflowed paragraph breaks a phrase pinned by regex — the wording is present and the assertion still fails
date: 2026-09-04
category: test-failures
module: omp/index.test.ts, omp/playbooks/implementation.md, omp/roles/orchestrator.md, src/worker/brief.mjs
problem_type: test_failure
component: agent-contracts
severity: low
symptoms:
  - "`expect(playbook).toMatch(/never a line to invent/)` failed while `grep 'line to invent'` found the sentence in the file"
  - "The received value printed in the failure contains the words, split as `never a\\nline to invent`"
  - "The same class in a JS-composed contract: `never through \\`orca orchestration ask\\`` written as two array rows never matches"
root_cause: assertion_over_hard_wrapped_prose
resolution_type: content_fix
related_components:
  - session-contracts
  - documentation
tags:
  - omp-roles
  - playbooks
  - brief
  - regex-pins
---
# A reflowed paragraph breaks a phrase pinned by regex

## Problem

The session contracts under `omp/roles/` and `omp/playbooks/` are prose, and `omp/index.test.ts`
grades them by matching phrases against the text the adapter injects — that is the only way a
doctrine sentence can be load-bearing. The text is hard-wrapped at about 80 columns, and the
pinned phrase is matched against the file's bytes, newlines included.

So editing a paragraph around a pinned phrase moves the wrap, and a phrase that now straddles a
line break stops matching while remaining, to a reader, entirely present:

```
$ bun test omp
Expected substring or pattern: /never a line to invent/
Received: "...A criterion the ticket never named is\nnever a line to invent: its absence..."
```

The same failure has a second door in JavaScript-composed contract text (`src/worker/brief.mjs`,
where each line of the brief is an array row): a code span split across two rows —
`'… never through \`orca'`, `'  orchestration ask\`, which …'` — is one sentence on the page and
two strings in the file.

It reads as "the wording is gone", which sends you rewriting text that is already correct.

## Fix

Reflow so the pinned phrase sits on one line, and check the phrase, not the paragraph:

```bash
grep -n 'never a line to invent' omp/playbooks/implementation.md   # one line, or it will not match
```

When composing contract text in JS, keep any phrase a test may pin — and every code span — inside
a single array row, even where that row is short.

## The general rule

A regex pin over hard-wrapped prose is an assertion about the LINE BREAKS as much as the words.
Rewrapping is therefore a behaviour change in this repository, not formatting: after editing a
graded document, re-run its suite before reading its diff for meaning. Where a phrase must survive
any future reflow, pin it with whitespace tolerance (`/never a\s+line to invent/`) rather than
asking every later editor to remember where the wrap fell.
