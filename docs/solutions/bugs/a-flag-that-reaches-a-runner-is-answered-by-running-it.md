---
title: A read the CLI does not intercept is answered by the runner, which means it is answered by running the command
date: 2026-09-02
category: bugs
module: src/cli.mjs
problem_type: bug
component: command-surface
severity: high
symptoms:
  - "`ax init --help` exited 0 having created `ax.config.json`, `bin/ax`, `.omp/settings.json`, an `AGENTS.md` block and a `.gitignore` block, and having modified tracked `package.json` — in the repository the operator was only asking a question about (#69)"
  - "`ax worktree --help`, `ax worker --help`, `ax triage --help` and `ax pr --help` exited 2 with `unknown verb \"--help\"`"
  - "`ax doctor --help` ran the whole coherence scan and exited 1"
  - "`ax supabase --help` exited 1 on `no ax.config.json` before the Supabase CLI was ever reached"
  - "Only `ax --help` was a read: the top-level flag was intercepted, and nothing below it was"
root_cause: unclaimed_argument_falls_through_to_the_runner
resolution_type: code_fix
related_components:
  - command-registry
  - help
tags:
  - help-is-a-read
  - registry-composed
  - structural-guarantee
  - side-effect-on-a-question
---

# A flag nobody intercepts is answered by running the command

## Problem

`runCli` intercepted `--help` in argv[0] and dispatched everything else. Every verb therefore
answered `--help` the way its own argv parser happened to: `init` did not parse it at all, so it
fell through to the runner and init RAN — five paths created and one tracked file modified on a
repository whose operator had asked what the verb does. The nouns refused it as an unknown verb
(exit 2), `doctor` ignored it and scanned, `supabase` never got far enough to pass it on.

The shape is not "init has a bug". Asking a verb what it does is a READ, and a read that is not
answered before dispatch is answered by whatever the runner does with an argument it does not
recognize — which for a writing verb is the write.

## Resolution

The read is composed from the registry, which already carries the name, the section, the summary,
the verbs and the flags, and it is answered in `runCli` before any runner is reached:

```js
if (table[command] && !gatedOff) {
  if (['--help', '-h'].includes(argv[1])) {
    process.stdout.write(renderCommandHelp(command));
    return 0;
  }
  return table[command](context) ?? 0;
}
```

`renderCommandHelp` and `renderUsage` share ONE block renderer, so `ax <verb> --help` and the
verb's lines in `ax help` cannot drift into two descriptions of one command.

Two boundaries make the rule cheap to hold:

- **The gate stays the caller's.** A registry entry gated off this machine does not exist here,
  help included, so a gated noun still answers `unknown command` — the help read cannot be the one
  thing that makes it exist.
- **One position, the command's first.** Past argv[1] the argv belongs to whoever owns it: a noun's
  verb parses its own flags and answers its own `--help` (`ax triage ask --help`), and every
  argument after `ax supabase` is the Supabase CLI's. Claiming more would swallow a flag that was
  never ax's to answer.

## Lesson

A guarantee spelled per verb is not a guarantee — it is a list, and the next verb is not on it. The
structural version asks what data the answer is already made of: the registry knew every command's
help before this change, and the only thing missing was answering from it one dispatch earlier.

Grade it the same way. The test iterates the REGISTRY inside a committed temporary repository and
asserts exit 0 and an empty `git status --porcelain` for every entry, so a verb registered next
month is covered on the day it is registered rather than the day someone remembers it.
