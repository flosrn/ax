---
title: A load-time const of an env-dependent fact breaks fresh-specifier test isolation after a module split
date: 2026-08-26
category: test-failures
module: omp/peer
problem_type: test_failure
component: testing_framework
severity: high
symptoms:
  - "27 omp-suite failures appeared only after `omp/peer/registry.ts` was split into seven modules; the same tests passed against the monolith"
  - "Every `orca()` call in `addressing.test.ts` and `lineage.test.ts` returned null instead of a parsed envelope"
  - "Failures pointed at case 1's already-deleted mkdtemp fake-orca path, not at the fake installed for the failing case"
  - "Cache-busting re-imports (`import('./lineage.ts?case=retry')`) produced a fresh module under test but a stale shared dependency"
root_cause: test_isolation
resolution_type: code_fix
related_components:
  - tooling
  - development_workflow
tags:
  - test-isolation
  - module-load-const
  - env-resolution
  - module-cache
  - bun-test
  - module-splitting
  - dependency-injection
  - per-call-resolution
---

# A load-time `const` of an env-dependent fact survives the module split that makes it shared

## Problem

`omp/peer/registry.ts` was 1308 lines bundling seven concerns. Commit `a8b0cd7`
(*"refactor(peer): registry.ts splits into the seven concerns it bundled"*, branch-local on
`feat/improve-codebase-architecture`) split it into `address.ts`, `lineage.ts`, `orca.ts`,
`report.ts`, `send.ts`, `store.ts` and `transcript.ts`.

The Orca CLI I/O moved into `omp/peer/orca.ts`, and it carried one line with it. In the
pre-split file the binary was resolved exactly once, at module load:

```ts
// registry.ts (pre-split), lines 31-34
import { resolveOrcaBin } from '../model/self.ts';
// …
const ORCA = resolveOrcaBin().bin;
// … then used by every spawn:
const p = Bun.spawnSync([ORCA, ...args], { … });
```

That line was harmless while `registry.ts` was a leaf that tests loaded directly. The split
turned it into a **shared dependency** of the modules the tests actually exercise — and that
is the whole bug.

Two Bun harnesses fake the Orca binary per test case:

- `omp/peer/addressing.test.ts:32-45` writes a fresh bash script named `orca` (the
  `installFakeOrca` helper); its `beforeEach` (`:77-89`) creates a fresh
  `mkdtempSync(join(tmpdir(), 'peer-addressing-'))` directory per case and points
  `process.env.ORCA_BIN` at the fake. Its `afterEach` (`:92-96`) restores the env and
  removes the directory.
- `omp/peer/lineage.test.ts` does the same (`process.env.ORCA_BIN = installFakeOrca()`).

Neither can rely on the env being read late, so both force a **fresh module instance per case**
via a cache-busting query specifier:

```ts
// addressing.test.ts:67-75
async function load() {
  caseId += 1;
  const address = await import(`./address.ts?addressing=${caseId}`);
  const send    = await import(`./send.ts?addressing=${caseId}`);
  return { ...address, ...send };
}
```

```ts
// lineage.test.ts:98, :114, :129, :143
const m = await import('./lineage.ts?case=cached');
const m = await import('./lineage.ts?case=retry');
const m = await import('./lineage.ts?case=orphan');
const m = await import('./lineage.ts?case=warm');
```

Before the split this worked because the fresh specifier re-executed the *entire* module —
including its load-time `const ORCA` — after the case's env was in place. After the split, the
fresh specifier only busts the cache for `lineage.ts` / `address.ts` / `send.ts`. Their own
import of the adapter is a plain, unqueried `./orca.ts`, so **every fresh instance resolved to
the one cached `orca.ts`**, whose `ORCA` had been frozen during case 1 and pointed at a temp
directory case 1's `afterEach` had already deleted.

## Symptoms

- 27 test failures across the omp suite (per this session's measurement of the pre-fix
  split), appearing in the same commit as the split, with no
  change to any assertion.
- `orca()` returns `null` on every call: `Bun.spawnSync` on a deleted path throws, and the
  adapter's `catch` maps that to `null` by design (`omp/peer/orca.ts:52-54`), so the failure
  surfaces as *empty answers*, never as an error.
- The stale path in the failures is the **first** case's `peer-addressing-…` /
  `peer-lineage-…` mkdtemp directory — a strong tell that a value was frozen at first load.
- Perfectly green while the code was monolithic.

## What Didn't Work

- **Trusting the fresh specifier.** `?case=` busts the cache for the module you name, not for
  its transitive imports. A stateless-looking dependency that captured env at load is exactly
  the thing that leaks across the boundary.
- **Keeping the resolution at load and re-importing the adapter under a fresh specifier too.**
  That would mean every consumer of the adapter needs a matching query string in every test,
  and any missed callsite silently reintroduces the shared instance. It pushes a production
  concern into every harness.
- **Test-side workarounds** (reordering cases, keeping the first temp dir alive) treat the
  symptom: the frozen binary is still wrong the moment any test wants a *different* fake.

## Solution

Resolve per call. `omp/peer/orca.ts:33`:

```ts
export const orcaBin = (): string => resolveOrcaBin().bin;
```

and both spawn sites call it (`omp/peer/orca.ts:45`, `:68`):

```ts
const p = Bun.spawnSync([orcaBin(), ...args], { cwd: process.cwd(), stdout: 'pipe', … });
```

The reasoning is recorded in the doc comment above the export (`omp/peer/orca.ts:20-32`):

> *Resolved per call, never at module load: `ORCA_BIN` short-circuits the probe and the
> addressing/lineage suites point it at a fresh fake per case — a bin frozen at load would
> outlive every one of them.*

The spawn guard in `omp/model/model.test.ts` had to learn the new shape: `RESOLVERS` at
`:1154` accepts `orcaBin()` as a legitimate `argv[0]` resolver form, and `:1249` asserts the
`which` probe spawns through it. The guard exists so a spawn is always a *resolved* binary,
never a bare name.

## Why This Works

`resolveOrcaBin` reads the environment on every invocation and short-circuits before touching
the filesystem when `ORCA_BIN` is set (`omp/model/self.ts:45-52`):

```ts
export function resolveOrcaBin(
  env: Record<string, string | undefined> = process.env,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
): { bin: string; how: 'env' | 'candidate' | 'path' } {
  const declared = env.ORCA_BIN;
  if (declared !== undefined && declared !== '') return { bin: declared, how: 'env' };
  for (const candidate of ORCA_CANDIDATES) {
    if (isExecutable(candidate)) return { bin: candidate, how: 'candidate' };
  }
  …
}
```

The cost argument is decisive: in the env case the resolution is a property read; in the
env-less case it is a handful of executable probes over `ORCA_CANDIDATES`. Both are noise
next to the `Bun.spawnSync` they precede, which the module's header explains must stay
synchronous and costs *"a few hundred ms once per finished session"* (`omp/peer/orca.ts:8-12`).
There is nothing to memoize that is worth a correctness hazard.

**Measured follow-on benefit.** Because the env is read at call time, a test no longer needs a
fresh specifier at all — it can set `ORCA_BIN` in `beforeEach` *after* the module has loaded.
Commit `917a43c` (*"refactor(peer): index.ts spawns Orca through the one adapter"*, also
branch-local) added `omp/peer/runner.test.ts`, which imports the adapter statically
(`omp/peer/runner.test.ts:17`) and says so in its header (`:8-9`):

> *Static imports are safe here: the adapter resolves `ORCA_BIN` per call, so the fake
> installed in beforeEach is the binary every call spawns.*

## Prevention

**Symptom signature — recognize it in seconds.** Tests are green while a module is monolithic;
after a split they fail with *empty or null* answers rather than errors; and the failing paths
point at the **first** test case's temp directory. That triad means a value captured at module
load is being shared across instances the harness believed were fresh.

**The rule.** An env-dependent fact stored in a module-level `const` is a hidden freeze. It is
invisible while the module is a leaf, and it becomes a test-isolation bug the moment a refactor
makes that module a shared dependency of modules the tests re-import under fresh specifiers.
This is the narrower corollary of AGENTS.md's **"Machine answers are injected"**: injecting the
dependency is not enough if a caller freezes the resolved answer in a module-level `const`.

**What to do instead, in order of preference:**

1. **Resolve per call** when the resolution is cheap — especially when the env path
   short-circuits, as `ORCA_BIN` does. A getter (`() => resolve().bin`) costs nothing next to
   the I/O it guards.
2. **Inject the dependency** when resolution is genuinely expensive: pass the resolved value in
   at construction, as `createRunner(bin, timeoutMs)` does (`omp/model/self.ts:63`), so the
   caller — production or test — decides when it is fixed.
3. Never rely on a cache-busting import specifier to reset a *transitive* dependency. `?case=`
   busts one module; its plain imports still hit the cache.

**When splitting a file, audit its module-level `const`s first.** Every one that reads
`process.env`, the clock, the filesystem, or `process.cwd()` is a candidate freeze, and the
split is exactly the change that promotes it from harmless to load-bearing.

## Related Issues

- No GitHub issue tracks this failure (two `gh issue list` searches on 2026-08-26, zero
  matches) — the red was caught and fixed inside the same working session as the split.
- `omp/peer/orca.ts:20-33` — the fix and its rationale, in the module's own header.
- `omp/peer/runner.test.ts` — the measured follow-on benefit (static imports safe in tests);
  its suite also pins `runOrca`'s stdout-only failure classification.
- `AGENTS.md` > "Machine answers are injected" — the governing rule this learning sharpens;
  and "A behavior fix starts red" — the 27 failures were the observed red.
- Known drift, reported here rather than fixed by this doc: `omp/peer/addressing.test.ts:10-11`
  and `omp/peer/lineage.test.ts:16-18` headers still say the binary is "read … at module load";
  the fresh specifier those suites keep is now about the module under test's *own* state, not
  about when the binary is resolved. `runner.test.ts:8-9` states the post-fix behavior
  correctly.
- Merge state: commits `a8b0cd7` and `917a43c` are branch-local on
  `feat/improve-codebase-architecture` — no PR opened, nothing pushed, as of 2026-08-26.
