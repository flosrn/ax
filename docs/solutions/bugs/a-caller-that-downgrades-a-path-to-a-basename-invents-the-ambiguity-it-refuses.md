---
title: A caller that holds an exact path and hands over its basename invents the ambiguity the resolver then refuses
date: 2026-09-06
category: bugs
module: src/worker/transcript.mjs
problem_type: design_rule
component: retrieval
severity: medium
symptoms:
  - "`ax triage dispatch` spent its whole 120 s role-proof window and settled `CANNOT ESTABLISH` on a healthy child whose receipt was already on disk"
  - "`node bin/ax.mjs worker transcript --dispatch-proof ax --request custom-flosrn-ax-174` exited 1 with NOTHING on stdout or stderr"
  - "The printed recovery command was the failing argv by construction, so running it reproduced the inability it repaired"
  - "The same read scoped to the checkout's own slug answered immediately, with the applied `triage-worker` receipt"
root_cause: exact_key_downgraded_to_an_ambiguous_one_by_the_caller
resolution_type: code_fix
related_components:
  - orchestration
  - session-resolution
tags:
  - derived-keys
  - f-028
  - ambiguity-refusal
  - actionable-refusal
  - stream-discipline
---
# A caller that downgrades a path to a basename invents the ambiguity it refuses

## Problem

Session proof is resolved by a **tail match on a basename**: keep every session directory whose
slug equals the needle or ends in `-<needle>`, and answer nothing unless exactly one survives.
Two survivors is an inability to establish, never a newest-wins guess — that rule is right and
stayed untouched.

Three local callers held the whole checkout or worktree path the proof belonged to and passed
`basename(path)`. On a host with a second checkout whose slug ends in the same basename
(`-Code-flosrn-ax` and `-orca-workspaces-improve-ax`, both ending `-ax`) every read asked a
question with two answers and got none. Measured 2026-09-05: the needle read returned 0 files
while the exact-cwd read returned 66 in that checkout's own directory, carrying the receipt the
window was waiting for. The 120 s window was never the cause — no read inside it could have
answered.

Two failures compounded it. The printed recovery composed the same basename, so the repair was the
failure. And the CLI's refusal branch was `return 1` with both streams empty, so an ambiguous
needle, a request with no dispatch on record and a dispatch with two owning sessions were one
indistinguishable silence.

## Fix

The rule lives in the shared resolver seam (`selectSessionFile`), never caller-side: given an
owning **local** `cwd` it selects candidates by that cwd's exact session slug, on
`sessionFilesForCwd`'s existing semantics. Exact-cwd is *narrower* than the tail match, so no
module's rule is reversed — the ambiguity is removed from the question rather than resolved by a
guess. The three callers now pass the path they already held: the triage role-proof wait, the
dispatch verification loop, and the brief-delivery witness. The verification loop's no-worktree
fallback holds no path and stays needle-only, and no cwd is derived from this machine for a remote
read.

The seam answers `{ file, reason, repair }`, and the printed recovery is keyed on `slugOf(root)`
with leading dashes stripped — a slug names one directory by construction, and the CLI refuses a
proof value beginning with `-` before reading anything.

## Three rules this paid for

**Refusing correctly is not the same as being asked correctly.** The resolver's ambiguity refusal
was right in every reading; the defect was one level up, in a caller that owned a unique key and
volunteered a shared one. When a refusal looks like a false negative, check what the caller passed
before touching the rule that refused.

**An absence in MY directory is not permission to read a sibling's.** The fallback is asymmetric on
purpose: a directory that exists and holds nothing readable is no proof and permits no sibling read,
because borrowing another checkout's session on the strength of an absence is how one dispatch's
grant reaches another caller (F-028). Only `ENOENT` — no directory at all, the shape of a session
recorded under a different `HOME` — falls back to the tail match, which still refuses two answers.

**A verb whose stdout is a payload still owes a reason, on the other stream.** `bad`/`fix` write to
stdout, and here the first stdout line IS the proof a remote reader parses — so the finding would
have been parsed as the answer. `log.mjs` grew a `refuse(message, command)` that writes both halves
to stderr and takes no default for the command, which makes "a `bad` without a `fix`" structurally
impossible on that stream. Exit codes and stdout stayed byte-identical, because a cross-version SSH
reader discriminates on them.

## How it is proven

Each of the three callers carries its own regression over a fixture of the measured collision — two
session directories whose slugs both end in the checkout's basename, one of them the caller's own.
The printed recovery is proven by **executing the printed string** rather than by matching its
shape: a shape assertion is exactly what let a line that cannot run pass for a repair.
