---
title: A reader that answers with a container is non-null before its fields exist, so latching the container latches an absence as a verdict
date: 2026-08-26
category: bugs
module: src/worker
problem_type: bug
component: verification
severity: high
symptoms:
  - "`ax worker launch` exited 3 with `model anthropic/claude-opus-5|` and `session unreadable` on two children that were on the marker's model with the role applied twenty seconds later"
  - "The same receipt reported `liveness cursor 0 -> 604`, so the pane was proven live by the same loop that called the configuration unproven"
  - "Reproducible on every launch, both slugs, with a clean `ax worker start --show` receipt and a readable `ax worker tail`"
  - "The coordinator had to read the pane by hand after each launch to disbelieve the verb's own verdict"
root_cause: absence_read_as_value
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - polling
  - latching
  - proof-vs-absence
  - launch-verification
  - race-condition
  - false-negative
  - report-vs-artifact
---
# Latching a container latches its empty fields

## Problem

`verify()` polls for two independent propositions about a freshly dispatched child — the model
marker applied, and the child-side role receipt written — plus pane movement. It read them like
this:

```js
if (proof === null) proof = readProof({ needle, env, sessionsRoot, host, exec, cwd });
```

`launchProof()` answers `{ model, sessionRole }` as soon as the session **file** exists. That file
exists the moment the child boots, carrying only the boot `model_change` Orca writes before the spec
marker applies, and nothing at all from the role extension, which writes after OMP discovery and
skill loading. So the first successful read returned a non-null object with `model.role === ''` and
`sessionRole === null` — and `proof === null` was false forever after.

The loop then exited on `proof !== null && moved !== null`. The cursor moves within a tick, so both
conditions were met while both configuration proofs were still unwritten. Exit 3, on a healthy
dispatch, every time.

## Why it survived seven tests

Every existing case wrote a complete transcript before invoking the verb. A fixture that is already
final cannot exhibit a latch. The bug lived entirely in the interval between "a file exists" and
"the file is finished", which only a fixture that CHANGES between two polls can reach.

## Fix

Latch each proposition separately, and define settled as "someone selected the model" plus "the role
receipt exists in either polarity":

```js
const settled = () => model !== null && model.role !== '' && sessionRole !== null;

for (;;) {
  if (!settled()) {
    const proof = readProof({ needle, env, sessionsRoot, host, exec, cwd });
    if (proof !== null) {
      if (proof.model !== null) model = proof.model;
      if (proof.sessionRole !== null) sessionRole = proof.sessionRole;
    }
  }
  // …cursor sample…
  if (settled() && moved !== null) break;
  if (now() >= deadline) break;
  sleep(tickMs);
}
```

A `refused` role is a real verdict and stops the wait; an empty model mover is indistinguishable
from "not yet" and continues it. The session file is cumulative, so a later read supersedes an
earlier one — which is what keeps a quota fallback arriving after the marker reported as a fallback.

The two verdicts now name the window they spent (`after ${wait}s`, `within ${wait}s`), and
`session unreadable` became `session not written within the window`. A verdict that has spent a
window is earned; the old wording described a failure where there was a race.

## The rule for this bug

**A reader that returns a container answers non-null before its fields are populated.** Test the
proposition you need, never the envelope that carries it. `if (x === null) x = read()` is a latch,
and a latch over a partially written source records the earliest observation as the final one.

This is F-028 — absence is not zero — in its most expensive form: not an absent list read as empty,
but an absent receipt read as a *verdict about the thing*, printed with the authority of a
measurement.

## The same defect, again, in the instrument built to measure it

Hours after this fix, a coordinator session built an instrument to measure how much CI output a
child had to read, so an arbitrage about a playbook could rest on a number. Its first run printed
`(a) averaged over 2 child(ren): 0.00% → CHANGE NOTHING` — for two children that had not opened a
pull request. A 0% that means "not yet measured" rendered as "no cost measured, change nothing".

Same shape, opposite direction: there, an absence produced the conservative verdict, which is the
one nobody questions. The repair was the same in kind — refuse the verdict until the measurement
exists, and say which:

```
NO VERDICT — 60-work, 61-work have not reached CI (no gh pr create, or no CI read after it).
A 0% here means UNMEASURED, never "no tax".
```

Both were found by RUNNING the thing against a source that was still being written, and neither was
visible to a reading of the code. When a reader polls something another process is producing, the
test has to change the source between two polls.

## The other half: a report of failure on an operation that succeeded

Same session, same day, the mirror image. A durable-memory store refused a write at its size limit
and reported `Auto-consolidation attempted but failed: Consolidation subprocess was terminated
(likely timeout or cancellation)`. The consolidation had in fact run and merged several entries into
one. Acting on the failure report, its reader hand-consolidated what had just been consolidated,
built replacement keys from what the store's SEARCH rendering printed, and got three concordant
`No entry matched` refusals — because the rendering strips a leading `[tag]` prefix the stored text
carries, so a key copied from a rendering is malformed even when the entry exists.

One false negative produced three symptoms that confirmed each other, and a confident conclusion
that the store was dead on three axes. The file was 7 KB and one `cat` away.

**A false success is dangerous because it is agreeable. A false failure is dangerous because it is
COHERENT** — refusals that corroborate one another make a story, and a story does not ask to be
checked. The costs are symmetric: one makes you ignore what is broken, the other makes you repair
what is not.

## The rule behind all four

A report about an operation is not the operation. Neither a claimed absence nor a claimed failure is
checkable from the report that carries it, so both have to be settled against the thing itself — the
file's bytes, the entry separator count, the cursor position, the artifact on disk.

Two habits follow, and they are cheap:

- **Never build a key, a count, or a verdict out of a rendering.** A rendering is lossy on purpose.
- **When a report and a `cat` disagree, the `cat` wins.** Reach for it first when the report is bad
  news: bad news is when a reader is least inclined to ask for proof, and most inclined to start
  repairing.
