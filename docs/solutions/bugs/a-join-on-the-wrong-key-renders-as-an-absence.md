---
title: A lookup keyed on the wrong field returns empty, and an empty lookup renders as "the thing does not exist"
date: 2026-08-28
category: bugs
module: src/triage
problem_type: bug
component: ask-channel
severity: high
symptoms:
  - "`ax triage status --issue 101` printed no mailbox row for a child that was blocked on a real `type: \"question\"` message sitting in the mailbox"
  - "The finding's own repair was `ax triage status --issue 101 --job triage`, i.e. the command that had just printed it — a loop with no exit"
  - "`ax triage answer` was unusable because it needs `--id`, and no surface emitted one"
  - "The operator unblocked the child with `peer_send` out of band, outside the ask/answer lifecycle entirely"
  - "Measured across the machine's mailbox: 12 of 24 open question rows were unreachable by this verb"
root_cause: wrong_join_key
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - f-028
  - join-key
  - proof-vs-absence
  - ask-channel
  - false-negative
  - self-referential-repair
---
# A join on the wrong key renders as an absence

## Problem

`ax triage status` reads Orca's mailbox, keeps the rows that are `type: "question"` with no reply
threaded to them, and keys them by `from_handle`. Each pass then looked itself up like this:

```js
pending = mailbox.pending.get(handle) ?? [];   // handle = the record's terminal effect
```

`ax triage ask` sends from the child's **Dispatch**, not from its pane. Orca stamps those rows
`from_handle: "dispatch:ctx_ff9aa6dce051"`. The dispatch record stores the child's **terminal**
(`term_d599b612-…`). The two keys never meet, so `.get(handle)` returned nothing for every ask ax
sends itself.

Measured on this machine's mailbox, 2026-08-28: 24 open question rows, **12 keyed `dispatch:…`**.
Half of the machine's live questions were invisible to the verb documented as the authority on them.

## What it cost

goodluckagency/ofmchat#101. A triage child asked a legitimate question; `msg_bf6613d0ee33`
(`type: "question"`, `from_handle: "dispatch:ctx_ff9aa6dce051"`) was in the mailbox the whole time.
`ax triage status` printed no row, and then printed this:

```
X an ask was ISSUED for this pass and its outcome was never recorded …
   -> ax triage status --issue 101 --job triage   # the mailbox row above, if any, is the authority
```

The repair named the command the reader had just run, and the row it called the authority was the
one the join could not find. Three exits, all closed: the relayed peer copy carried
`[NO REPLY ROUTE]` so `peer_reply` refused it by construction; `ax triage answer` requires `--id` and
no surface emitted one; `status` documented itself as the source of that id and emitted none. The
operator unblocked the child with a `peer_send` to its registry name — outside the lifecycle, so the
record still shows an unrecorded ask.

## Fix

Three keys, deduped by message id, header first:

```js
take(mailbox.byRequest.get(request));                    // the ask's own body names its pass
if (handle !== '') take(mailbox.pending.get(handle));    // pane-sent asks
if (dispatchId !== '') take(mailbox.pending.get(`dispatch:${dispatchId}`));
```

`composeAsk` writes the request id into the body, so the header pin is **transport-independent**: it
proves which pass a row belongs to without any handle at all. The two handle keys stay because a
child that asked through raw `orca orchestration ask` writes no header, and for those rows a handle
is the only evidence there is.

The `asking` finding now branches. With a row: *the WAITING row above IS that ask, its ax header
names this request* — the record never learned it landed, the mailbox proves it did. Without one:
the scoped `orca orchestration inbox --full` read and `ax worker tail <pane>`, i.e. two commands
that produce something the reader did not already have.

## The near-miss the fix itself carried, caught in review

The first version of this fix widened the keys without splitting the verdict, and a P1 review caught
what that produced. A child whose own `ax triage ask` fails falls back to raw
`orca orchestration ask`: that row is dispatch-keyed but carries **no ax header**. The wider lookup
admitted it, so `status` printed `ax triage answer --id <id>` for a row `answer()` refuses
unconditionally (nothing proves which draft it asked from) — and, worse, the non-empty list
suppressed the fold-and-publish escape below it. The repair for a loop with no exit had rebuilt that
loop one layer up.

So `questionsForPass` returns two lists, not one. **Answerable** means an ax header naming *this*
request; a missing header and a header naming another pass are both **unpairable**, because `answer`
refuses each for its own reason. Unpairable rows are still reported — a blocked child is the fact an
operator scans for — but with the reason and never with the command, and every downstream branch
(the escape, the record-witness, the `asking` finding, the `--brief` row) gates on the answerable
set alone.

Two fixtures turned out to be wrong rather than merely affected, and were repaired instead of
pinned: the publish suite's ask body used `draft abc`, which `askHeader` never parsed, so it had
been standing for a raw ask while claiming to be an ax one; and the pane-attribution test now guards
a header naming another pass, because the pin outranks the pane by design.

## The class, named by the reporter

Three instances now, and they are one defect wearing three faces — an **authority emitting an
instruction that cannot succeed**:

|When|The authority said|Why it could not succeed|
|---|---|---|
|2026-08-26|`ax triage status` prints the pending question's real id|the child asked through a channel that mints no ax header, so no id was pairable|
|2026-08-28|the mailbox row above is the authority — answer THAT id|the row was keyed by dispatch and this verb only read panes, so no row was rendered|
|2026-08-28 (caught in review)|`ax triage answer --id <id>`|the row carried no ax header, so `answer` refuses it unconditionally|

The failure is never the refusal — each refusal was individually correct. It is that the surface
*routing* the reader is not answerable to the same evidence the surface *refusing* them uses. Two
correct components compose into a circle, and a reader who follows it twice concludes the tool has
no answer.

**So a repair line is a claim, and it gets checked like one.** Before printing a command, ask what
the receiving verb requires and whether this evidence satisfies it — `answer` needs a header-pinned
id, so a row without one may be reported but never routed to it. When nothing satisfies the
requirement, say the state is blocked, name the reason, and route to something that does work
(read the row by hand, tail the pane, or rule it and fold it into the draft).

## Why it survived

`ax triage status` had **no behavioral test file**. `tests/triage-index.test.mjs` covered the verb
table and the help text; the mailbox rows it renders had only incidental coverage from
`triage-publish`, whose fixtures use pane-keyed questions exclusively — the half that worked.

The new `tests/triage-status.test.mjs` fixtures are the three keys a real row can carry. Five of its
nine cases fail on the old code.

## The rule for this bug

**A key that names a sender is chosen by the SENDER, not by the reader's record.** Before joining a
foreign list against a local id, read one real row and check which field actually carries the id you
hold. One `orca orchestration inbox --limit 500 --json | jq '[.result.messages[] | select(.type ==
"question")] | [.[].from_handle] | unique'` settled this in one call, after the code had shipped for
six days.

And the corollary that makes it expensive rather than merely wrong — the same one as
`latched-container-reports-an-empty-read-as-a-verdict.md`, arrived at from a different direction:
**an empty lookup is not evidence about the world.** That file is about a container that is non-null
before its fields exist; this one is about a `Map.get` that misses. Both printed the miss as a
verdict about the thing, with the authority of a measurement.

**A repair line must name a command that produces something the reader does not already have.** A
`fix` that re-runs the verb printing it is not a repair; it is a loop, and the reader who follows it
twice concludes the tool has no answer — which here was true, and was the tool's own fault.
