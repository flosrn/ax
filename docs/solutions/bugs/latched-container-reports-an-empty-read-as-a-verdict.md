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

## The instance with no tool in it: an author contradicting their own verification

Same session, and the only one where nothing automated had a part. A coordinator wrote the
`$comment` that documents a repository's merge-gate check set, and put in it: "It is unconditional
across the job axes — no `if:`, no `paths:` or `paths-ignore:` — so every pull request produces the
exact check-run name the gate enumerates."

The workflow's trigger is `pull_request: branches: [main, v2]`. A PR based anywhere else — one
stacked on a feature branch — produces neither enumerated check, and the gate refuses it for both.

The author HAD read that trigger, two turns earlier, and had written the correct narrow claim about
it: a pre-existing workflow-level filter does not *widen* what enumerating this check costs. That
reasoning is sound for the decision to enumerate. The sentence then shipped as "so it covers
everything" — a different proposition, contradicted by a note in the same context. Both halves were
present; they were never confronted.

It was caught by a reviewer re-reading the sentence against that note, after the merge, and repaired
in the comment rather than in the trigger: widening a trigger changes every PR's CI spend and is a
maintainer's decision, not something a comment fix smuggles through.

**The rule generalizes one level up: a report about an operation is not the operation, including
when the report is your own prose and the operation is a YAML read you have already done.** A
document whose entire value is that its claims are trustworthy is exactly where an unconfronted
contradiction is most expensive — and re-reading a claim against the observation that produced it
costs one turn.

## The sixth: a correct value with a false justification

A distinct shape, and the most dangerous to *correct*. The five above are readers, prose or reports
that got something wrong. Here nothing was wrong. `PREAMBLE_LINES = 40` bounded a scan for the
dispatch capability a child was handed, and it did exactly the right thing. Its comment said
"performance".

That is worse than a false claim, because of the gesture it invites. A false sentence gets caught by
someone re-reading it against the source. A correct constant explained as an optimisation invites the
next reader to *improve* it — and the improvement here is to raise the bound "so a token is not
missed", which is precisely the unsafe move. Measured over 859 session files, 227 carrying a raw
token: first occurrence at min 5, median 7, p90 8, max 1651, with exactly one file between lines 11
and 40. The cluster is the preamble; the outliers are sessions that were never handed a capability
and merely *mention* one — a coordinator quoting a child's command, or a session reasoning about this
code. An unbounded scan would answer "here is your capability" to a caller that has none, handing one
dispatch's grant to another. The bound was never an optimisation that happened to be safe; it was a
safety boundary that happened to look like one.

**A constant that carries a boundary must document what breaks when it moves, never why it was
picked.** "40 for performance" invites raising it. "past line 8 it is no longer a preamble but a
mention, and taking it hands over another dispatch's key" closes the door. Same distinction as
`prevents` versus `detects`: name the consequence, not the intention.

Applied as an audit rather than a note, every module-scope boundary in this repo was re-read against
that rule. Two were already exemplary — `MAX_BUFFER` names the child it kills when lower,
`LABEL_CAP` names the silent pagination it is read back to detect. One was not: `MAX_THREAD_PAGES`
said "stop rather than loop forever", which describes the intent and leaves out the only thing a
reader needs — that crossing it registers an `unknown`, which fails the merge gate closed, so a
bigger PR becomes unmergeable-until-read and never passed on a partial read.

## The seventh: the one with no consequence at all

Written into a message whose subject was this file: a test count of `986` where the suite says `985`.
No test had been added between the two runs; the number was incremented from memory while drafting.

It is worth recording precisely because it breaks the pattern. The other six each had a
consequence — a re-dispatched worker, a skewed arbitrage, a merge gate bypassed, a key handed to the
wrong caller — and the consequence is what creates verification pressure. Here there is none: a
count in a chat message, wrong by one, that nobody would have caught and that would have broken
nothing. So "prefer the direction whose failure is loud" does not reach it. There is no failure at
all, only an unverified claim, and no rule about boundaries or renderings would have caught it.

**Discipline degrades where it costs nothing, which is exactly where it is trained.** A figure with
no consequence is the one place a person can practise incrementing from memory and never be
punished — until the same reflex lands on a safety boundary. The positive side of the same mechanism
is already in this repo: `MAX_BUFFER` and `LABEL_CAP` were exemplary before any rule named them,
because someone held the practice where nobody was looking.

## The rule behind all seven

A report about an operation is not the operation. Neither a claimed absence nor a claimed failure is
checkable from the report that carries it, so both have to be settled against the thing itself — the
file's bytes, the entry separator count, the cursor position, the artifact on disk.

And underneath the first six — the seventh is outside it, having no failure to be loud — one choice
made by accident: **preferring the silent failure to the loud
one.** In every instance the defect was not a wrong value, it was a direction whose failure nothing
downstream could see. A latched read printed a verdict about a session it had not waited for. A 0%
meaning "unmeasured" rendered as "no cost, change nothing". A draft's question count stood in for an
ask id that was never minted. A comment promised coverage a trigger did not give. A bound explained
as an optimisation invited the move that would hand over another dispatch's key.

A false pass is agreeable and a false failure is coherent, and what they share is that neither asks
to be checked. So when two directions are available and the evidence does not separate them, take
the one whose failure is loud: a refusal that names its repair is cheap to be wrong about, and an
unnoticed success is not. The three habits below are cases of that one rule.

Three habits follow, and they are cheap:

- **Never build a key, a count, or a verdict out of a rendering.** A rendering is lossy on purpose.
- **When a report and a `cat` disagree, the `cat` wins.** Reach for it first when the report is bad
  news: bad news is when a reader is least inclined to ask for proof, and most inclined to start
  repairing.
- **A boundary documents its consequence in BOTH directions, and says which side is safe.** A
  reader arrives with a symptom, not a theory, and does not know in advance which way they are
  tempted: raising `PREAMBLE_LINES` hands over another dispatch's key, while *lowering*
  `MAX_THREAD_PAGES` makes ordinary PRs undecidable. So name both, then name the asymmetry — "raise
  it and the cost is API calls, never a wrong verdict" is the one clause a hurried reader will use.
  One side usually costs resources and the other costs a verdict; only the second is a trap.
