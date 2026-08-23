#!/usr/bin/env node
// The dispatcher, not the CLI: it decides WHOSE ax answers, then gets out of
// the way. `src/cli.mjs` is the CLI, and `src/dispatch.mjs` explains why the
// project's install wins over this one.
import { runCli } from '../src/cli.mjs';
import { resolveDelegation, runDelegated } from '../src/dispatch.mjs';

const argv = process.argv.slice(2);
const decision = resolveDelegation();

process.exitCode = decision.mode === 'self' ? runCli(argv) : await runDelegated(decision, argv);
