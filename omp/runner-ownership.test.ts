/**
 * Every test file in this repository belongs to exactly one runner, and this is
 * what proves it rather than asking anyone to remember.
 *
 * WHY THIS EXISTS
 * Two runners split the suite: `node --test "tests/*.test.mjs"` (52 files) and
 * `bun test` scoped to `omp/` (18 files). Three separate declarations encode that
 * split — `package.json` scripts `test:node` and `test:omp`, and `bunfig.toml`'s
 * `[test] root` — and nothing made them agree with the files on disk. Both
 * failure directions cost something real:
 *
 *   TOO WIDE. Before `bunfig.toml`, a bare `bun test` at the root scanned the
 *   whole repository and ran the node-owned `tests/*.test.mjs` under Bun. It
 *   reported 9 failures that do not exist, and on 2026-08-23 that number was
 *   taken as truth and reported twice as a release blocker while `pnpm test` was
 *   green the whole time.
 *
 *   TOO NARROW. `test:omp` is `bun test omp`, and that argument is a filter on a
 *   path SUBSTRING, not a directory. A Bun test added anywhere whose path does
 *   not contain "omp" — `src/thing.test.ts` — was already invisible to CI before
 *   the root was scoped, and would stay invisible after. Scoping did not create
 *   that hole, but it must not be what hides it either.
 *
 * So this asserts the invariant both directions miss: every `*.test.*` file is
 * claimed by exactly one runner. A new Bun test outside `omp/` fails here with
 * its own path, which is the only moment someone can still fix it cheaply.
 */

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

/** Trees that hold no test this repository owns. */
const SKIP = /^(node_modules|\.git|dist|coverage|\.worktrees|\.scratch)$/;

/** `node --test "tests/*.test.mjs"` — one level, `.mjs` only, as the script spells it. */
const NODE_OWNED = /^tests\/[^/]+\.test\.mjs$/;

/** Bun's scan, scoped by `bunfig.toml` to `omp/`. */
const BUN_OWNED = /^omp\/.+\.test\.[cm]?[jt]sx?$/;

/** Bun and node both recognise these; the filename is what enrols a file. */
const IS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

function testFiles(dir = '', out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO, dir) || REPO, { withFileTypes: true })) {
    if (SKIP.test(entry.name)) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) testFiles(path, out);
    else if (IS_TEST.test(entry.name)) out.push(path);
  }
  return out;
}

test('every test file is claimed by exactly one runner', () => {
  const unclaimed = testFiles().filter((f) => !NODE_OWNED.test(f) && !BUN_OWNED.test(f));

  // The message is the repair: a Bun test belongs under `omp/`, a node one under
  // `tests/` with a `.mjs` extension. Anywhere else, no runner opens it.
  expect(unclaimed).toEqual([]);
});

test('no file is claimed by both runners', () => {
  // `tests/omp-runner.test.mjs` was in this state until 2026-08-23: it matched
  // the `bun test omp` substring filter AND the node glob, so it ran twice, once
  // under a runner it was never written for.
  const both = testFiles().filter((f) => NODE_OWNED.test(f) && BUN_OWNED.test(f));

  expect(both).toEqual([]);
});

test('the three declarations of the split still say the same thing', () => {
  // Drift here is silent: a script edited to widen the node glob, or a `root`
  // removed from bunfig, changes which files run without changing any test.
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const bunfig = readFileSync(join(REPO, 'bunfig.toml'), 'utf8');

  expect(manifest.scripts['test:node']).toBe('node --test "tests/*.test.mjs"');
  expect(manifest.scripts['test:omp']).toBe('bun test omp');
  expect(manifest.scripts.test).toBe('pnpm run test:node && pnpm run test:omp');
  expect(bunfig).toMatch(/^\s*root\s*=\s*"omp"\s*$/m);
});
