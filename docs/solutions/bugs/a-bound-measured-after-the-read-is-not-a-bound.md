---
title: A cap measured after the read bounds the output and not the work, so the writer of the input decides what the reader spends
date: 2026-09-05
category: bugs
module: omp/peer
problem_type: bug
component: injection
severity: medium
symptoms:
  - "`completionReport` on a 1 GiB Report took 3006 ms and a gigabyte of resident string to produce a 16 KB block"
  - "The truncation line printed `truncated at 16384 bytes of 1073741824` — a total only a full read could establish"
  - "A 35 KB Report built out of `dcap_…` tokens redacted to 13 KB, so it was injected WHOLE, tail included, with no truncation line at all"
root_cause: bound_applied_after_the_cost
resolution_type: code_fix
related_components:
  - orchestration
  - measurement
tags:
  - input-bound
  - child-authored-input
  - redaction
  - truncation-disclosure
  - proof-vs-absence
---
# A bound measured after the read is not a bound

## Problem

`REPORT_CAP_BYTES` (16 KB) capped what the completion receiver INJECTED. The read itself was
`readFileSync(fileReal, 'utf8')`: whole file into a string, redaction pass over all of it,
`Buffer.byteLength` on the result, and only then a cut. Every byte past the cap was decoded,
scanned and discarded.

The file is a Report, which is child-authored, and its size is the child's choice. So the cap
bounded the orchestrator's *context* and left the orchestrator's *session* paying whatever the
worker wrote. Measured 2026-09-05 against the old reader on a 1 GiB sparse Report: 3006 ms and a
gigabyte resident, for a 599-byte block.

## The second defect, which the first one hid

Because the whole file was redacted BEFORE being measured, redaction's own compression decided
completeness. A 35 KB Report made of `--dispatch-capability dcap_<80 chars>` lines redacts to
13 KB — under the cap — so it was injected whole with no truncation line. That output is correct
only in the sense that its bytes were all read; a 35 KB file arriving as a complete 13 KB Report is
a shape nobody designed.

## Fix

`boundedRead(path, cap)` opens the file, fills a `cap + 1` byte window in a loop (a `read(2)` on a
regular file may answer short), closes the descriptor in a `finally`, and returns
`{ text, truncated }`. One byte past the cap is what makes "there is more" an observation rather
than a guess — a `stat` would answer the same question from a different observation, and a file
being appended to makes the two disagree.

When the window is full, the cut is made **on the bytes, at the last 0x0A**, before anything
decodes them. `0x0A` never occurs inside a UTF-8 sequence, so the last newline in the window is at
once a codepoint boundary and a boundary no secret shape crosses. Decoding first would already have
turned a split character into `U+FFFD`; cutting later would leave a `dcap_` head whose tail is past
the bound.

## What the bound costs is knowledge, and the diagnostics had to give it up

Three claims the old block made are unavailable to a bounded reader, and each one was a claim a
merge gate or an orchestrator acts on:

- **The file's size.** `truncated at 16384 bytes of 1073741824` became
  `input-truncated at the 16384-byte input bound; what follows it was never read`. The retained
  text may be *shorter* than the cap after redaction and the disclosure still fires: an unread
  suffix is never presented as read.
- **The end of `## CRITERIA`.** The old rule took end-of-text as end-of-section, which under a
  bounded read means "the section ends where my bytes stopped" — a completeness claim over unseen
  content. `criteriaSpan` now answers `{ bytes }`, `{ open: true }` or `{ absent: true }`, and an
  `open` section is refused by name with no size stated. The measured overflow keeps its old
  wording, because that measurement was actually made.
- **That a heading is absent.** A missing `## CRITERIA` in a truncated window says
  "not found in the bytes that were read", never that the file has none.

## The rule for this bug

**A bound belongs where the cost is incurred, not where the output is produced.** A cap applied
after the read bounds only what is shown, and leaves the size of the work to whoever wrote the
input. When the input is authored by another party — a child session, a remote peer, an uploaded
file — that is the party deciding what your process spends.

And its corollary, which is where the diagnostics went: **once the read is bounded, every fact
downstream of it has to be re-derived from what was read.** A number that used to be a measurement
becomes a guess in silence, and it keeps printing with the authority of the measurement it was.
