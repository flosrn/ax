#!/usr/bin/env node
// The entry the bundle's extensions spawn when they need `ax`, and the reason
// they do not spawn `bin/ax.mjs`.
//
// `bin/ax.mjs` is a DISPATCHER: it asks `src/dispatch.mjs` whether some other
// project's install should answer instead, and hands the invocation over when it
// says yes. That is right for a human typing `ax` into a shell, where the
// question "whose ax?" is genuinely open. It is wrong here. An extension was
// loaded from one specific copy of this package and its writes are part of that
// copy's behaviour, so an invocation that can land in a different version is a
// silent version skew — and `ax board`, the one command these extensions call,
// exits 0 on every path by design, so the skew would never surface.
//
// So this runner answers the question before it is asked: it imports the CLI
// body from the package it is part of, by relative path, and runs it. No
// resolution, no delegation, no PATH.
import { runCli } from '../src/cli.mjs';

// Awaited because a runner is allowed to be async even though `runCli` itself is
// not; `bin/ax.mjs` gets away without it only because its self path is the one
// case where nothing async can be returned yet. Awaiting a non-promise costs a
// microtask and removes a whole class of "exit code 0, work unfinished".
process.exitCode = await runCli(process.argv.slice(2));
