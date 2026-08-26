# Orchestration Frictions

Each finding below names a reproducible command, the observed result, its operational impact, and
the current repair. Absence is unknown unless the covered runtime proves otherwise.

## How an entry earns its place

This file is the standing channel for a friction the live runtime found: the direction of reporting
that has no contract anywhere else. A child reports blockers UP to its coordinator, a coordinator
assigns work DOWN to its children, and both are written into the roles. A defect in the INSTRUMENT
has nowhere to go, so it becomes a silent workaround — one consumer had carried "`ax triage ask` is
unavailable" in durable memory since v0.6.x, and the cause was a missing flag that took one grep of
the runtime source to find once it was finally reported.

An entry carries four things, and the first is what makes the other three usable:

- **Commands** — the exact argv, runnable, with the cwd when it is not the repository root. A
  reproduction that mutates state names its `--dry-run` first. Measured across two children refused
  by the SAME runtime error: the one that reported "the supervised channel is unavailable" produced
  no repair across two dispatches, and the one that quoted `dispatch_capability_invalid` had the
  cause found in the runtime source and fixed within the hour. The form is the causal lever.
- **Observed** — raw output, not a summary of it. A rendering is lossy on purpose.
- **Impact** — what an operator loses, in the run they were actually doing.
- **Repair status** — one of the four verdicts below, never a mood.

### The four verdicts

|Verdict|Means|
|---|---|
|`open`|reproduced, not yet repaired — the entry stays, with its command|
|`fixed`|repaired AND released; a source-only change is not this|
|`refused`|reproduced and left alone on purpose, with the reason — a tool that repairs every report is a tool being designed by whoever complains loudest|
|`unreproducible`|the command was run and the symptom did not appear|

`refused` and `unreproducible` are first-class results, not failures of the reporter. A file that
only ever records `fixed` is measuring how agreeable it is, not how the tool behaves.

### Measure before believing, including a reviewer, including yourself

Every claim here is about behaviour, and behaviour is measurable. Two entries in this file's own
history were plausible and false: an automated review filed a P1 saying these reproductions would
create a `55-55-…` request and dispatch an unrelated worker (they cannot — `normalizeSlug` in
`src/worker/ticket.mjs` strips a repeated ticket ref and says so), and the reply refuting it asserted
the commands had never carried the prefix, having read the file at branch HEAD instead of the commit
under review. Two correct measurements, wrong subject.

So: run the command before writing the entry, and name the commit or version the reading applies to.
An "impossible" and a "surely" are claims, and they get measured like the rest.

## Test environment

- Consumer: `goodluckagency/ofmchat`
- Consumer pin during the incidents: `@flosrn/ax@0.11.3`
- Orca: `1.4.188`
- OMP observed in the #57 worktree: `18.0.4`
- AX source baseline for this file: `deadfbffedfabd523b6e2efdeb0f37ceb146fd18`

## Open findings

### F1 — Cold OMP launch can revoke capability before submission

**Commands**

```bash
ax worker launch --issue 55 --slug turn-analyzer-r2
ax worker launch --issue 56 --slug scores-r2
ax worker launch --issue 71 --slug rls-refute
```

**Observed**

| Request | Dispatch | Result |
|---|---|---|
| `55-turn-analyzer-r2` | `ctx_047889f5daa4` | `agent_prompt_stalled`, capability revoked |
| `56-scores-r2` | `ctx_febc0a00702f` | `agent_prompt_stalled`, capability revoked |
| `71-rls-refute` | `ctx_a8c1c8b9d585` | `agent_prompt_stalled`, capability revoked |

Orca waits five seconds for `workingSequence` to increase after one carriage return. Repair found
all three composers holding the brief and submitted it 49–88 seconds after launch, after capability
revocation. Each child later delivered a real PR, but `escalation` and `worker_done` were rejected.

A warm-pane probe also returned `agent_prompt_stalled`: `tui-idle` proves idle, not the OSC braille
`working` transition Orca's verifier requires.

**Impact**

The child can edit and open a PR without a usable question/completion channel. The coordinator gets
an unattributed copy with no reply route and cannot describe the Dispatch as healthy.

**Repair status**

Open. Capture paste, carriage return, OSC title, `input`, `before_agent_start`, `agent_start`, and
Orca's verdict in the same five-second window before adding another launch path.

### F2 — Start-immediately can boot before the project AX bundle exists

**Command**

```bash
ax worker launch --issue 57 --slug policy-offer-engine
```

**Observed**

Launch reported `node_modules missing` and started setup and OMP concurrently. The worktree's
`.omp/settings.json` pointed to `./node_modules/@flosrn/ax`, which did not exist when OMP booted.
Orca still returned `state=ready`, `stage=input_accepted`; child JSONL showed:

```text
model_change anthropic/claude-opus-5 role=boot (session boot)
message user <ticket and pilot contract>
```

The child began reading the ticket under `role=boot`. It was stopped before editing; the worktree
remained clean.

After setup installed the bundle, a correctly placed replacement (`ctx_82955b491a90`) produced,
before its first tool call:

```text
model_change anthropic/claude-opus-5 role=default resolvedModelIsFallback=false
skill-prompt playbook=implementation
message user <ticket and pilot contract>
```

`role=default` is the requested model selector `@default`; `playbook=implementation` is the
child-side session-role witness.

**Impact**

`input_accepted` proves delivery, not the invariant that the pinned role/model applies before the
first task turn. A valid Task can otherwise run under boot behavior.

**Repair status**

Open. Do not start OMP until the extension named by `.omp/settings.json` exists. General setup may
run concurrently only after the role/model bundle needed by the first turn is available.

### F3 — Replacement does not inherit recorded agent or worktree

**Commands**

```bash
ax worker start --replace --request 57-policy-offer-engine
ax worker start --replace --request 57-policy-offer-engine --agent omp
```

**Observed**

The first command returned `agent_unconfigured` although the record named `agent=omp`. Adding only
`--agent omp` created `ctx_dc69d19edb5b` in `worktree=current`: the primary ofmchat checkout on
`main`, not `.worktrees/57-policy-offer-engine`. The coordinator stopped it immediately; Orca
recorded `operator_close`, and the primary checkout remained clean.

The safe invocation required repeating both fields:

```bash
ax worker start --replace \
  --request 57-policy-offer-engine \
  --worktree path:/Users/flo/Code/ofm/ofmchat/.worktrees/57-policy-offer-engine \
  --agent omp
```

**Impact**

A continuation intended to preserve PR ownership can silently target the coordinator checkout and
put unrelated user work at risk.

**Repair status**

Open. Inherit recorded placement exactly, or refuse replacement when required passthrough fields
are absent. Never default a replacement to `current`.

### F4 — `tui-idle` and accepted input do not prove an OMP command ran

**Commands**

```bash
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text '/role worker' --enter --json
```

**Observed**

The first wait completed before the OMP welcome screen finished. Two sends reported
`accepted=true`; neither produced a user message, JSONL session, role receipt, or command output.
The final terminal preview contained `/role worker` at the prompt, then the pane exited. The
worktree remained clean.

**Impact**

`tui-idle` can be a startup false positive, and `send.accepted` proves bytes reached the PTY rather
than that OMP processed the command.

**Repair status**

Open. A role preflight needs a role receipt or session event. Do not attach a Task based on the wait
result or echoed input.

### F5 — A ready Dispatch completion can still arrive without a reply route

**Command**

```text
peer_reply(message_id from 57-policy-offer-engine)
peer_reply(message_id from 59-process-turn)
```

**Observed**

The healthy #57 Dispatch `ctx_82955b491a90` reported completion and PR #75, but `peer_reply`
returned `No reply route`. The same refusal recurred on active #59 Dispatch
`ctx_c41934de6519` for a load-bearing architecture question. In both cases the coordinator had to
send its decision directly to the Dispatch's verified terminal handle.

**Impact**

A coordinator cannot answer load-bearing worker questions through the structured route even when
capability, role, model, and Dispatch are valid.

**Repair status**

Open in the consuming version. Preserve/derive the reply route from the active Dispatch; never guess
an unrelated pane.

### F6 — A finished PR can outlive its owner without surfacing continuation

**Observed**

After #56 opened PR #72, its agent pane exited while the PR remained open. `peer_reply` had no
route, the worker was absent from `peer_list`, and direct input returned
`terminal_not_writable`. AX's landing contract separately requires a merged PR before release may
close an implementation pane; this run exercised release only after #72 merged.

The supported continuation is:

```bash
ax worker start --replace --request <request> --worktree <recorded> --agent <recorded>
```

**Impact**

Without a printed continuation route, a recoverable durable request appears abandoned.

**Repair status**

Open UX gap. Print the exact replacement command, including recorded placement fields, when an open
PR has lost its pane.

### F7 — Dispatch records accumulate indefinitely

**Observed**

`ax worker ls` read 126 historical records while the live capacity was zero. Released, failed, and
current requests remained together under `~/.omp/run/dispatch`.

**Impact**

Relevant records are buried among old records and cross-host unknowns.

**Repair status**

Open design decision. Add a conservative history filter or ownership-proving sweep. Never infer
that a record is disposable from age alone.

### F8 — Database isolation still has fail-open paths

**Observed**

The #71 launch initially declared a shared database because ticket labels were not fetched. AX main
now reads configured database labels, but review found two remaining paths:

- an absent or unknown label container is coerced to `[]`, authorizing a non-database plan;
- `worker launch --worktree <path>` bypasses the new database-provisioning branch.

**Impact**

A database-labelled ticket can still inherit the primary stack, and a reset through a path that
bypasses `ax supabase` can target shared containers.

**Repair status**

Open. Unknown labels must refuse provisioning when database labels affect the plan, and explicit
worktrees must receive the same isolation proof or be refused.

### F9 — `tail <handle>` reverse mapping is ambiguous around unreadable records

**Observed**

AX main stopped suggesting `transcript term_…`, which transcript cannot resolve. Review of the
replacement reverse-map found that a non-empty `dispatchIndex().unreadable` set can still allow a
unique-looking match and suggest the transcript of the wrong child.

**Impact**

The recovery command can cross assignment boundaries precisely when the record store says it could
not read every candidate.

**Repair status**

Open. Any unreadable candidate that could alias the handle must make reverse mapping
`cannot-establish`; never choose a unique readable row from an incomplete index.

## Fixed on AX main and verified, pending exact-version consumer adoption

A source fix does not alter a consuming session pinned to an older package.

| Friction observed | Repair on AX main |
|---|---|
| Repaired watcher retained `repaired=false` and called normal closure death | Re-read repair marker on every tick |
| Failed starts hid their recorded pane and readable transcript | Preserve failed receipts and print usable routes |
| `worker tail` accepted only handles while transcript accepted requests | Resolve request/dispatch through the record store |
| `tail` called `status=exited` alive | Give `EXITED` exit code 4 and document it |
| One omitted remote runtime made covered local panes unknowable | Decide omission per runtime named by the record |
| Proxy lookup ran from AX's cwd | Resolve route from inside the target worktree |
| `peer_send` rejected Orca's displayed short session ID | Resolve verified session-ID prefixes |
| Missing reply route was discovered only after reply failure | Inject `[NO REPLY ROUTE]` before the reader responds |
| `pr gate --ack-body` printed a next command without the acknowledgement | Preserve invocation-local acknowledgement flags |

## Artifact outcomes from the degraded run

- PR #72 merged only after CI and `ax pr gate` passed on its rebased head.
- PR #73 merged only after integrated unit tests, body review, and `ax pr gate` passed.
- PR #74 merged only after 50 pgTAP files / 2088 assertions passed and the required proof was
  cross-posted before issue #71 closed.

A merged PR proves landing. It does not retroactively make a revoked Dispatch healthy.
`worker release` closes an owned terminal; it does not rewrite a Dispatch already settled failed.
