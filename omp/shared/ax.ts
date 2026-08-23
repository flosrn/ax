/**
 * How an extension in this bundle runs `ax` — its OWN ax, never a name on PATH.
 *
 * WHAT THIS REPLACED, AND WHY
 * This used to resolve an installed binary: `$HOME/.local/bin/ax` first, the
 * bare name `ax` as a fallback. That was correct while these extensions lived in
 * `~/.omp/agent/extensions` and belonged to no package — they were loose files
 * that had to FIND an ax somewhere on the machine.
 *
 * Inside the package the same resolution is a bug with three faces:
 *
 *   1. VERSION SKEW. The extension is loaded from one copy of `@flosrn/ax` and
 *      would spawn whichever copy a user-dir bin link happens to point at. Those
 *      are different versions the moment a project pins one, and the mismatch is
 *      invisible: `ax board` exits 0 on every path by design, so a stale writer
 *      producing the wrong sidebar value looks exactly like a healthy one.
 *   2. NO GLOBAL BIN, NO WRITER. A project install (`node_modules/.bin/ax`, no
 *      global link) is the normal shape in CI and the exact shape a fresh clone
 *      has. The old resolver fell through to the bare name, the spawn failed to
 *      resolve it, the caller latched `writerMissing = true`, and checkpoints
 *      were silently off for the whole session.
 *   3. PATH IS NOT OURS. Bun resolves argv[0] against the environment snapshot
 *      taken at process start (measured on bun 1.3.14 in checkpoint.test.ts), so
 *      an Orca-injected PATH missing the user dir loses the writer with nothing
 *      to read afterwards.
 *
 * A package-local argv prefix removes all three by construction: the target is
 * addressed from `import.meta.url`, so an installed copy under `node_modules`
 * runs its own entry and a checkout runs the checkout's, with no lookup that can
 * resolve to something else.
 *
 * WHY `omp/ax-run.mjs` AND NOT `bin/ax.mjs`
 * The bin entry is a dispatcher — `resolveDelegation` / `runDelegated` exist to
 * hand the invocation to ANOTHER project's install. That is the correct answer
 * for a human typing `ax`, and the wrong one here: it reintroduces exactly the
 * version skew above, by a different route. `omp/ax-run.mjs` imports the CLI body
 * from this package by relative path and runs it, so "which ax" has one answer.
 *
 * WHY THE CURRENT RUNTIME EXECUTABLE
 * `process.execPath` is the interpreter already running this code — `bun` under
 * OMP, `node` under a plain test runner — so the spawn needs no shebang, no exec
 * bit and no PATH entry. It is the one executable guaranteed to be present,
 * because it is the one that got here.
 */

import { fileURLToPath } from 'node:url';

/**
 * The argv prefix that runs THIS package's `ax`.
 *
 * An ARRAY rather than a string because it is two words and always will be:
 * joining them would put a path that may contain spaces back into something that
 * has to re-split it, which is the class of failure this file exists to remove.
 * Callers spread it.
 *
 * The env override is for the tests that pin the argv, and for an operator
 * bisecting against another checkout. It is read at call time rather than at
 * module load, so a caller can set it without controlling evaluation order.
 */
export function axArgv(env: Record<string, string | undefined> = process.env): string[] {
  const declared = env.AX_BIN;
  if (declared !== undefined && declared !== '') return [declared];
  return [process.execPath, fileURLToPath(new URL('../ax-run.mjs', import.meta.url))];
}
