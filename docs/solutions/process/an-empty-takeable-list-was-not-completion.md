---
title: An empty takeable list was read as done, because Completion had no derived read
date: 2026-09-06
category: process
module: src/completion.mjs, src/mandate.mjs, src/frontier.mjs
problem_type: process
component: completion
severity: medium
symptoms:
  - "A Spec whose last two tickets blocked each other printed takeable — 0 and a fresh session treated the wave as finished"
  - "Every original ticket merged while an admitted necessary finding stayed open, and nothing named the unfinished work"
  - "A local merge was the strongest evidence anyone had of a deployed result, because the Spec declared no Deployment mandate and silence authorized anything"
root_cause: empty_frontier_stood_in_for_completion
resolution_type: code_fix
related_components:
  - frontier
  - orchestrator-role
  - necessity
tags:
  - completion
  - deployment-mandate
  - f-028
  - empty-takeable-is-not-done
---
# An empty takeable list was not Completion

## Problem

Three states collapsed into one: an empty `takeable` list, a closed Wave, and
the approved result deployed. Only the first two had a contract. A fresh
session reading silence dispatched nothing and reported the Spec finished.

## Fix

`ax frontier --spec <ref>` extends the existing receipt. Membership is one
reader (`specMembership`): repository-qualified identities, pagination proved
or unestablished. The Deployment mandate lives on the Spec as prose; an absent
one is a named blocker. Completion requires a merged pull request per member
and a recorded observation per obligation the mandate named. Wave closure
stays proof-by-kind and is not that verdict.

## The rules this paid for

**EMPTY TAKEABLE IS NOT COMPLETION.** An excluded member, including an
established cycle, stays visible as unfinished work.

**A MISSING MANDATE AUTHORIZES NOTHING.** Silence is not a permissive default.

**ABANDONMENT CLOSES A WAVE, NOT A SPEC.** Dropping approved work changes the
approved result; that is a human's decision, named here as unfinished.
