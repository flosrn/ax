---
title: One bot identity, two spellings — gh answers app/<slug> over GraphQL and <slug>[bot] over REST, and a check comparing literally is false on one of them
date: 2026-09-03
category: bugs
module: src/pr-grounds.mjs, src/pr-gate.mjs
problem_type: bug
component: verification
severity: medium
symptoms:
  - "`gh pr view 68 --json author` answered `{\"is_bot\":true,\"login\":\"app/github-actions\"}` while that same PR's `gh api repos/<slug>/pulls/68/commits` answered `github-actions[bot]`"
  - "A predicate written against the canonical login `github-actions[bot]` reads FALSE on the receipt, and one written against `app/github-actions` reads false on every commit"
  - "Neither read fails: both answer, with different strings for one account, so the disagreement is silent"
root_cause: one_identity_two_spellings
resolution_type: code_fix
related_components:
  - merge-gate
  - measurement
tags:
  - merge-gate
  - release-please
  - gh-cli
  - identity
  - f-028
---
# One identity, two spellings

## Problem

`ax pr gate` had to decide whether a pull request is the release shape (#94): the release bot's
authorship plus the release label. Two different reads carry that authorship, and the gate needs
both — the PR's author comes from the receipt it already fetches, and each post-open commit's
author comes from the commits endpoint.

Measured 2026-09-03 on `flosrn/ax` PR #68, the release-please pull request for 0.18.0:

```
$ gh pr view 68 --repo flosrn/ax --json author
{"author":{"is_bot":true,"login":"app/github-actions"}}

$ gh api repos/flosrn/ax/pulls/68/commits --jq '.[].author.login'
github-actions[bot]
```

One account. `gh`'s `--json author` goes through GraphQL, where a GitHub App is a `Bot` node and
`gh` prefixes it `app/`; the REST commits payload carries the account's own login, suffixed
`[bot]`. A comparison written against either string alone is a false statement about the other
read — and both reads answered, so nothing fails and nothing says why.

## Fix

Normalise before comparing, in one place (`loginOf`/`sameLogin` in `src/pr-grounds.mjs`): strip a
leading `app/`, strip a trailing `[bot]`, compare case-insensitively. It cannot collapse two
different accounts, because the bare login of a GitHub App is reserved by that App.

## The general rule

An identity that arrives through two transports is two strings until something proves otherwise.
Before writing a predicate over a login, a slug or a ref, read it through **every** transport the
code will use, and compare the strings — not the docs. The gate's own history has the same species
one field over: `gh repo view --json` has no `squashMergeCommitMessage` field at all, so the
merge-message policy had to come from `gh api repos/<slug>` (#86).

The direction of failure matters too. Here a spelling mismatch withholds an exemption, so it fails
closed: the ground refuses, as it did before the exemption existed. A predicate whose mismatch
*granted* something would have been the same bug with a merged PR behind it.
