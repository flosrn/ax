# Triage labels — flosrn/ax

The file `ax.config.json` names under `triage.labels`. A triage child reads it
beside the injected triage playbook, and it wins wherever the two diverge. It
names the groups a finished pass has to fill and the label strings this
tracker actually carries — read `gh label list --repo flosrn/ax` before trusting
any name here; someone may have changed the set.

## Groups

Every triage pass fills three groups. A pass that leaves one empty has not
finished. Names are exact label strings, colon and no space where a prefix
exists.

| Group | Labels | Rule |
| --- | --- | --- |
| state | `needs-triage` · `needs-info` · `ready-for-agent` · `ready-for-human` · `wontfix` | exactly one; the pass moves the issue from `needs-triage` to what it concluded |
| category | `bug` · `enhancement` · `documentation` · `question` | exactly one; GitHub's default set, already on the repo |
| source | `source:agent-found` · `source:user-report` · `source:roadmap` | already on the issue at birth — keep it, never add a second |

There is no priority, complexity or domain group on this repository. The place
of a domain label is taken by one body line:

```
Module: <path from docs/ownership.md>   # the file whose header owns the rule the issue is about
```

An issue that spans two owners names both, in the order a fix would touch
them. A path that is not in `docs/ownership.md` is a finding about the map,
and the draft says so.

## What each state means here

- `needs-info` — the draft cannot reach a verdict without a measurement or an
  answer the reporter has and the code does not. Name the exact question. A
  reporter that is an agent session is gone; the question is then for the
  operator, and the draft says which.
- `ready-for-agent` — the fix is decided at the resolution of acceptance
  criteria a test could be written against, and it touches nothing an operator
  has to rule on. ONLY the `brief` publication applies this label — a `triage`
  pass that concludes it recommends it and stops.
- `ready-for-human` — the fix needs a ruling this repository's doctrine reserves
  to a person: a module header's rule reversed, a cross-verb contract (release,
  repair, stall, triage status and ls answering one question the same way), a
  change in what `ax.config.json` is allowed to mean, or a tracker mutation.
  Say which ruling, and name the two or three candidate rulings when the issue
  already lists them.
- `wontfix` — recommend it with `Close: yes` and the reason; the operator
  closes. This includes an issue the code no longer exhibits (say which merged
  PR repaired it, with proof on `main`) and an issue that is the remaining
  scope of another (name it: the verdict routes there instead of opening a
  second front).

## Draft directive grammar

The draft opens with directive lines, then the comment body a human reads on
the issue months later:

```
Labels: <name>[, <name>…]            repeatable — one line per group is cheapest to correct
Remove labels: <name>[, <name>…]     the state label the transition supersedes
Close: yes                           only with wontfix; you recommend, the operator closes
```

A directive carries label NAMES ONLY — never a group name, never a
parenthetical. `Labels: state → needs-info` and `Remove labels: needs-triage
(superseded)` both name no label that exists and are refused at publish. The
justification goes in the body, one line per group. A state transition is
always both lines: adding `needs-info` without removing `needs-triage` leaves
two state labels on the issue.

## What the body carries, in order

1. The claim, separated from the reporter's diagnosis.
2. Whether it reproduces on `main` at the SHA you read, with the command.
3. The shape of the fix and its `Module:` line.
4. What the issue leaves undecided — each item either ruled here, asked of the
   orchestrator (`Q<n>:` line, then wait), or the reason for `ready-for-human`.
5. One line per group naming why that label.

An issue born by another session already carries the four reporter fields —
argv, raw output, expected, cost. Quote the argv when you reproduce; never
summarize the raw output back at the reporter.
