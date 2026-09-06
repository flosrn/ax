// `ax worktree reclaim <target>` — the guarded post-merge lifecycle of ONE worktree.
//
// WHY THIS EXISTS (#213). `ax worker release` closes the recorded agent pane of
// a session whose work provably landed, and its own header states it never
// removes a worktree, deletes a branch or touches git state. Nothing else in the
// flow closed that gap, so after the eleven implementation pull requests of the
// #174 wave merged and every pane was released with `archive=captured`, eleven
// finished child checkouts were still on disk, still in `ax worktree ls` and
// still in Orca's sidebar — three of them still wearing a green PR badge for a
// merged pull request. This verb is the missing step, and it is called per slice
// right after the governing merge and that release: not at wave end, not by a
// daemon, and not as a suggestion printed to an operator who will not run it.
//
// THE THREE WORKTREE VERBS, AND WHY A THIRD EXISTS
//   `clean`    reclaim resources, KEEP the checkout. Safe on a tree in use.
//   `rm`       explicit removal a human types at a target they chose.
//   `reclaim`  this: decide eligibility, preserve evidence, clean, remove —
//              refusing on anything it cannot establish. It re-decides none of
//              those seams; it composes them, and `release.mjs` is untouched.
//
// ONE TARGET, NEVER A SWEEP. The argument is an exact target, resolved through
// ./locate.mjs, and there is no pattern, no `--all` and no `--force`. A verb
// that could delete "everything eligible" would be one unreadable probe away
// from deleting everything.
//
// ELIGIBILITY IS A CONJUNCTION, AND AN UNREADABLE TERM IS A KEEP (F-028)
//
//  1. IT LANDED — a MERGED pull request for this branch AND a named merge
//     commit, the same pair ../worker/landed.mjs already calls a landing.
//     Anything short of it is a NAMED inability, distinct from "not landed yet".
//  2. NOTHING ESCAPED THE LANDING — the worktree HEAD equals the head the
//     completed Gate merge record validated (`--match-head-commit`, bound to
//     the record whose identity names that pull request). This is the safety
//     property, and the measured near-loss is why it is not a commit count:
//     #204's branch took test commit 2a0ba02 AFTER #208 merged at 40f8a10, with
//     a CLEAN tree — work that had not landed and went out as follow-up #210.
//     `git log origin/main..<branch>` is worthless here for the mirror reason:
//     the wave squash-merges, so it is non-empty on every finished slice, and a
//     rule keyed on it refuses all of them forever. A different HEAD is retained
//     work whose repair is DELIVERY — never a force flag, never an auto-stash.
//  3. NOTHING UNCOMMITTED — porcelain status, untracked included. One term of
//     the conjunction and never an authorisation on its own.
//  4. NOBODY IS STILL THERE — the panes of that worktree, counted from the pane
//     list itself. Never from `liveTerminalCount`: `orca worktree list --json`
//     does not emit that key on this build, so a reader of it reads `undefined`.
//     A released worker does not make every pane in its tree disposable, and a
//     live sibling is a KEEP.
//  5. NOBODY HAS CLAIMED IT — the machine-readable claims that ALREADY exist:
//     git's own worktree `locked` flag with its reason, and Orca's `isPinned` on
//     the supported receipt. This work adds no retention marker, config key or
//     flag of its own, and parses no free-text comment as authority. An
//     inventory that cannot answer either field is a KEEP naming the unread one.
//  6. THE TARGET IS AX'S AND IS NOT THE CALLER'S — ./locate.mjs, unchanged.
//  7. THE BRANCH CAN BE LET GO, OR THE WHOLE TARGET IS KEPT. The only supported
//     Orca removal ALWAYS attempts to delete the checked-out local branch: the
//     CLI exposes no keep-branch flag (`orca worktree rm --worktree <s>
//     [--force] [--run-hooks]`) and `orca worktree set` exposes no field for the
//     fork's internal `preserveBranchOnDelete`, which no supported receipt emits
//     either (measured 2026-09-06 against `worktree show --json` and
//     `worktree list --json`, Orca 1.4.178-rc.2). So "remove the tree but retain
//     the branch" is NOT COMPOSABLE, and this verb never issues a removal that
//     might delete a claimed branch and then report the damage. The claim it can
//     prove is dependency, read from the same supported inventory: another
//     registered worktree whose `baseRef` is `refs/heads/<this branch>` is work
//     based on it, and a lineage child is work still pointing at the tree. Both
//     are a KEEP that names the claim and the operation the interface does not
//     offer; nothing is released, signalled, stopped, deleted or written.
//
// EVIDENCE SURVIVES FIRST, FAIL-CLOSED. `.scratch/` is gitignored, so the
// worktree holds the ONLY filesystem copy of the worker Report — measured, one
// in each of the eleven. Before anything is destroyed, every Report the
// governing dispatch records require is copied under the PRIMARY checkout's
// `.scratch/reclaim/`, scoped by repository, by the recorded request and by the
// worktree it came from, verified byte-identical by digest, and referenced in a
// `reference.json` that stays readable after the tree is gone. There is no
// copy-all: what must survive is INVENTORIED from the records, and any other
// `.scratch/` content — potentially the only copy of something a human wrote —
// is a KEEP rather than something this verb copies or deletes. An existing
// archive is REUSED when its bytes already match and is never overwritten when
// they do not, so a repeated run neither duplicates nor destroys prior evidence.
//
// THE PROJECT'S DECLARED CLEANUP OWNS CLEANUP, AND IT RUNS EXACTLY ONCE.
// Measured 2026-09-06 on the two consumers of this package: both declare an
// `archive` script, and their contents differ where it matters — one BUDGETS AND
// THEN CALLS `ax worktree clean` (so ax clean is the inner implementation and
// the declaration is its wrapper), the other runs three phases ax knows nothing
// about and never calls ax at all. So the two are never substituted for one
// another: where a declaration exists it OWNS the stage, and `ax worktree clean`
// owns it only where absence is PROVEN. A declaration read that fails is
// unknown, not absent, and unknown is a KEEP.
//
// Exactly once is a property of the composition, not a hope: the declared
// command is invoked HERE, and the removal that follows is issued WITHOUT
// `--run-hooks` — the flag whose absence Orca's own `worktree rm` notes
// ("Repo-defined orca.yaml archive hooks are skipped unless --run-hooks is
// passed"). Delegating cleanup to that flag instead would put it inside an
// operation that proceeds whether the hook succeeds or not; here a chain that
// cannot be found, cannot be launched or exits non-zero KEEPS the worktree and
// the removal is never attempted. A chain that reports success is taken AT ITS
// WORD: a project that chooses to warn and continue on an overrun phase has made
// its own judgement, and this verb reports what it observed without upgrading it
// to a proven-complete reclamation or reading the warning as a failure.
//
// Nothing consumer-specific is hardcoded — no script path, no package-manager
// invocation, no project name, no phase list. What ax carries is the ability to
// read the supported declaration (`orca.yaml` `scripts.archive`, resolved
// against Orca's own repository hook settings and their source policy) and run
// what it names, under the cwd and environment contract Orca's own runner uses.
//
// RECORDED BEFORE IT MUTATES (F-001). Every stage is written to the store before
// it is issued, under `<store>/reclaim/`, so a partial cleanup is REPLAYED and
// reconciled rather than re-derived: a stage whose outcome nobody knows is
// reported as stranded and never re-run — an arbitrary project command whose
// result is uncertain cannot be re-executed and still called exactly-once — a
// settled stage is not repeated, re-entry mints no second identity, re-creates
// no worktree, and claims no removal it did not observe.
//
// ORDER IS LOAD-BEARING. Every refusal runs before anything destructive
// (./clean.mjs's own rule, and ./remove.mjs's reason for pre-checking what git
// would refuse), and eligibility is REVALIDATED at the mutation boundary,
// because the checks and the mutation are not one instant. A refusal reached
// halfway reads to a caller as "nothing happened" while the dev server is
// already dead — so once the cleanup has been issued, a later failure retains
// the checkout and reports the effects that may already exist, naming the
// recorded state that recovers it.
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  RECLAIMED, or a removal this host already recorded
//   1  KEEP / REFUSED / STRANDED — the target is retained and named
//   2  usage error
//   3  cannot establish: no git repository, no Orca CLI, a silent runtime, an
//      unreadable worktree registry, or no repository for `gh` to be asked about

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';

import { repoPaths } from '../config.mjs';
import { defaultExec, run as execRun } from '../exec.mjs';
import { repoView } from '../gh.mjs';
import { gitBlobSha } from '../hash.mjs';
import { readWorktrees } from '../git.mjs';
import { terminalInventory } from '../worker/pane.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import {
  acquireLock,
  argvValue,
  attemptSettle,
  claimRecord,
  defaultStore,
  initRecord,
  newIdentity,
  phaseBegin,
  phaseEnd,
  phaseStages,
  recordedRequest,
  requestIdOk,
  scanStore,
} from '../worker/record.mjs';
import { reportPathFor } from '../worker/report.mjs';
import { worktreesOf } from '../worker/transcript.mjs';
import { clean } from './clean.mjs';
import { locateWorktree, physical, withinPath } from './locate.mjs';

const USAGE = 'ax worktree reclaim <name-or-path> [--store <dir>]';

/** The store namespace these records live in — never beside the dispatches. */
export const RECLAIM_NS = 'reclaim';

/** Where a preserved Report lands, under the PRIMARY checkout. */
export const ARCHIVE_DIR = join('.scratch', RECLAIM_NS);

/**
 * The budget Orca gives a repo-declared archive hook (`HOOK_TIMEOUT`, 120 s in
 * its own runner). Reproduced rather than chosen: a project whose declared chain
 * is written to warn and exit inside that window behaves the same either way,
 * and a longer one here would let a chain Orca would have killed run on.
 */
export const HOOK_TIMEOUT_MS = 120_000;

/** How many paths a refusal names before it counts the rest. */
const NAMED = 5;

const firstLine = text => String(text ?? '').split('\n')[0].trim();
const lines = text => String(text ?? '').split('\n').filter(line => line.trim() !== '');
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * ONE ARGUMENT, QUOTED FOR A POSIX SHELL. Every repair here is a command a human
 * or an agent pastes, and a worktree path may hold a space, a quote or a `$`.
 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shq = value => {
  const text = String(value);
  return SHELL_SAFE.test(text) && text !== '' ? text : `'${text.replaceAll("'", `'\\''`)}'`;
};

// ── the declaration ─────────────────────────────────────────────────────────

/**
 * The only block-scalar headers this reader reproduces: literal and folded,
 * each with clip (default) or strip (`-`) chomping. A keep-chomping `+` retains
 * trailing newlines this reader's join would silently drop, and an explicit
 * indent indicator (`|2`) changes where the body starts — both are UNKNOWN
 * rather than approximated, because the value becomes a command line.
 */
const BLOCK_HEADERS = new Set(['|', '|-', '>', '>-']);

/**
 * `orca.yaml`'s `scripts.archive`, or a named inability — never a guess.
 *
 * Orca parses this file with a full YAML library and then reads exactly one
 * value out of it: `scripts.archive`, trimmed.
 *
 * NO SUPPORTED INTERFACE ANSWERS THIS ONE, and that was measured before the
 * reader was written (2026-09-06, Orca 1.4.178-rc.2): `orca agent-context
 * --json` names no command that reads a repository's hook scripts, and across
 * every CLI spec the only hook surfaces are `orca agent hooks *` — Codex status
 * hooks, a different subject — and the `--run-hooks` flags, which EXECUTE a
 * hook rather than reporting it. `orca repo show --json` answers the LOCAL half
 * (`hookSettings`) and nothing about the committed file. So the shared half is
 * either read here or never read, and never read means ax can only ever run its
 * own cleanup in a repository whose project declared another one — which is the
 * substitution this whole slice exists to refuse.
 *
 * ax carries no dependencies and no build step, so this reads the SHAPES that
 * value is actually written in — a plain scalar, a quoted scalar, a block
 * scalar — and refuses everything else as UNKNOWN rather than approximating a
 * parser. The asymmetry is the safety property: `{ archive: null }` authorises
 * the ax-clean fallback, so it may ONLY ever mean proven absence, while a shape
 * this reader does not positively recognise costs a KEEP and nothing else. An
 * anchor, an alias, a flow mapping, a tab-indented key, a second YAML document,
 * an inline comment after a plain scalar and a file too large to bound are each
 * `{ unknown }` — the same answer as an unreadable file.
 */
export function archiveScriptIn(text) {
  if (typeof text !== 'string') return { unknown: 'orca.yaml could not be read as text' };
  if (text.length > 256 * 1024) return { unknown: 'orca.yaml is larger than this reader bounds (256 KiB)' };
  const rows = text.replaceAll('\r\n', '\n').split('\n');

  let inScripts = false;
  let indent = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.trim() === '' || row.trimStart().startsWith('#')) continue;
    if (/^\t/.test(row) || /^ *\t/.test(row)) return { unknown: 'orca.yaml indents with a tab, which YAML does not permit' };

    const top = row.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (top !== null) {
      if (top[1] !== 'scripts') {
        inScripts = false;
        continue;
      }
      if (top[2].trim() !== '') return { unknown: `orca.yaml writes 'scripts' as ${JSON.stringify(top[2].trim())}, a shape this reader does not read` };
      inScripts = true;
      indent = null;
      continue;
    }
    if (!inScripts) continue;

    const entry = row.match(/^( +)([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (entry === null) return { unknown: `orca.yaml line ${index + 1} is a shape this reader does not read: ${JSON.stringify(row.trim())}` };
    if (indent === null) indent = entry[1].length;
    if (entry[1].length !== indent) {
      // A deeper key belongs to the entry above it, which this reader already
      // refused if that entry was not a scalar; a shallower one cannot be here.
      return { unknown: `orca.yaml line ${index + 1} is indented past the 'scripts' entries this reader reads` };
    }
    if (entry[2] !== 'archive') continue;

    const value = entry[3].trim();
    // A BLOCK INDICATOR IS NEVER A COMMAND. Measured on review: `>+` fell past
    // the recognized set into the plain-scalar branch below, so the archive
    // command became the literal string '>+' — which `bash -c` exits 0 on. The
    // cleanup stage then "succeeded" having run nothing, and the worktree was
    // removed. So anything opening with `|` or `>` is a block scalar by
    // definition, and only the four headers whose folding this reader
    // reproduces exactly are read; every other one — a keep-chomping `+`, an
    // explicit indent indicator, a malformed repetition — is UNKNOWN, which is
    // a KEEP. Never a fallback, and never a command.
    if (/^[|>]/.test(value) && !BLOCK_HEADERS.has(value)) {
      return { unknown: `orca.yaml writes 'scripts.archive' with the block header ${JSON.stringify(value)}, whose folding this reader does not reproduce — it is never read as a command` };
    }
    if (BLOCK_HEADERS.has(value)) {
      const body = [];
      let block = null;
      for (let next = index + 1; next < rows.length; next += 1) {
        const line = rows[next];
        if (line.trim() === '') {
          body.push('');
          continue;
        }
        const depth = line.length - line.trimStart().length;
        if (depth <= indent) break;
        if (block === null) block = depth;
        if (depth < block) return { unknown: `orca.yaml line ${next + 1} dedents inside the archive block scalar` };
        body.push(line.slice(block));
      }
      const joined = body.join(value.startsWith('>') ? ' ' : '\n').trim();
      return { archive: joined === '' ? null : joined };
    }
    if (value === '') return { unknown: "orca.yaml writes 'scripts.archive' with no scalar value on its own line" };
    if (/^[&*!{[]/.test(value)) return { unknown: `orca.yaml writes 'scripts.archive' as ${JSON.stringify(value)}, a shape this reader does not read` };
    if (/^['"]/.test(value)) {
      const quote = value[0];
      if (!value.endsWith(quote) || value.length < 2 || value.slice(1, -1).includes('\\')) {
        return { unknown: `orca.yaml writes 'scripts.archive' as ${JSON.stringify(value)}, a quoted shape this reader does not read` };
      }
      const inner = value.slice(1, -1);
      return { archive: inner === '' ? null : inner };
    }
    if (value.includes(' #')) return { unknown: "orca.yaml writes 'scripts.archive' with a trailing comment this reader will not split" };
    return { archive: value };
  }
  return { archive: null };
}

/**
 * WHO OWNS THE CLEANUP STAGE: the effective archive declaration, resolved the
 * way Orca resolves it, or a named inability.
 *
 * Orca composes the committed `orca.yaml` script and the per-repository Settings
 * script through a source policy (`local-only` takes the local one, `run-both`
 * concatenates shared then local, anything else — including a legacy value —
 * takes the shared one; an absent policy with a local script present reads
 * `local-only`). Both halves come from a SUPPORTED read: the file for the shared
 * one, `orca repo show --json`'s `hookSettings` for the local one. Reproducing
 * that resolution is the point — invoking the shared script where Orca would run
 * the local one is not "reusing the project's cleanup", it is running something
 * else with the project's name on it.
 *
 * `hookSettings: null` is a repository whose receipt carries no such key: no
 * local override, established. A receipt that could not be read at all arrives
 * as `unreadable` and is UNKNOWN, because the fallback it would otherwise
 * authorise runs a DIFFERENT cleanup.
 */
export function cleanupStage({ yaml = null, hookSettings = null, unreadable = '' } = {}) {
  if (unreadable !== '') return { unknown: unreadable };

  let shared = null;
  if (yaml !== null) {
    const read = archiveScriptIn(yaml);
    if (read.unknown !== undefined) return { unknown: read.unknown };
    shared = read.archive;
  }

  let local = null;
  let policy = 'shared-only';
  if (hookSettings !== null) {
    if (hookSettings.scripts === null || typeof hookSettings.scripts !== 'object') {
      return { unknown: 'orca repo show answered hookSettings with no scripts object, so the local archive command is unread' };
    }
    const declared = hookSettings.scripts.archive;
    if (declared !== undefined && typeof declared !== 'string') {
      return { unknown: `orca repo show answered a local archive command of type ${typeof declared}, which this reader does not read` };
    }
    local = String(declared ?? '').trim() === '' ? null : String(declared).trim();
    const raw = hookSettings.commandSourcePolicy;
    policy = raw === 'local-only' || raw === 'run-both' || raw === 'shared-only' ? raw : raw === undefined && local !== null ? 'local-only' : 'shared-only';
  }

  if (policy === 'local-only') {
    return local === null
      ? { owner: 'ax-clean', source: 'ax worktree clean', command: '' }
      : { owner: 'declared', source: 'Orca repository settings', command: local };
  }
  if (policy === 'run-both') {
    const both = [shared, local].filter(part => part !== null);
    return both.length === 0
      ? { owner: 'ax-clean', source: 'ax worktree clean', command: '' }
      : {
          owner: 'declared',
          source: both.length === 2 ? 'orca.yaml and Orca repository settings' : shared === null ? 'Orca repository settings' : 'orca.yaml',
          command: both.join('\n'),
        };
  }
  return shared === null
    ? { owner: 'ax-clean', source: 'ax worktree clean', command: '' }
    : { owner: 'declared', source: 'orca.yaml', command: shared };
}

/**
 * The environment Orca's own hook runner exports, reproduced: the two path
 * variables a declared chain reads, the workspace name it labels output with,
 * the two conductor-compatible aliases Orca keeps, and the whole credential
 * guard that keeps an unattended git call inside that chain from hanging on a
 * prompt with no terminal to answer it. The cwd is the worktree and the shell
 * is `/bin/bash`, both as Orca spawns them.
 *
 * THE GUARD IS THE WHOLE GUARD, scalars AND the indexed-config protocol, and
 * the two option identifiers below were EXTRACTED from Orca's own helper rather
 * than retyped: `scripts/extract-hook-guard-keys.mjs` copies the two static
 * literals out of `shared/git-credential-prompt-env.ts` byte for byte and
 * rewrites them here, once, at authoring time. They are public git option
 * identifiers set to `false`, never credential values, and nothing reads that
 * checkout at runtime — this file carries the bytes.
 *
 * `tests/worktree-reclaim.test.mjs` pins the composition offline: the scalars,
 * the append position, the non-clobbering of a caller's own indices, and the
 * refusal to append into a malformed protocol.
 */
export function hookEnvironment({ env, main, worktree }) {
  const base = {
    ...env,
    ORCA_ROOT_PATH: main,
    ORCA_WORKTREE_PATH: worktree,
    ORCA_WORKSPACE_NAME: basename(worktree),
    CONDUCTOR_ROOT_PATH: main,
    GHOSTX_ROOT_PATH: main,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: env.GIT_ASKPASS ?? '',
    SSH_ASKPASS: env.SSH_ASKPASS ?? '',
    GCM_INTERACTIVE: 'never',
  };
  // An UNEXTRACTED checkout appends nothing. A placeholder written into
  // `GIT_CONFIG_KEY_n` would be a git option nobody declared, which is worse
  // than the gap it stands in for — and the caller refuses to run a declared
  // chain in that state anyway (`hookGuardEstablished`).
  return hookGuardEstablished() ? appendGitConfig(base, CREDENTIAL_GUARD_CONFIG) : base;
}

/**
 * The two git option identifiers Orca's guard appends, each `false`. Written by
 * the extraction script named above; the placeholders below are what an
 * un-extracted checkout would carry, and `hookGuardEstablished` refuses to run
 * a declared chain while either is still in place.
 */
export const CREDENTIAL_GUARD_CONFIG = [
  ["credential.interactive", 'false'],
  ["credential.guiPrompt", 'false'],
];

/** Is the guard the real one? A placeholder key never authorises a declared chain. */
export const hookGuardEstablished = (entries = CREDENTIAL_GUARD_CONFIG) =>
  Array.isArray(entries) && entries.length === 2 && entries.every(([key]) => typeof key === 'string' && key.startsWith('credential.') && !key.includes('__'));

const INDEXED_CONFIG = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/;

/**
 * The append position for git's indexed-config protocol, or `null` when the
 * inherited protocol is AMBIGUOUS — a count that disagrees with its indices, a
 * dangling pair, a non-numeric count. Orca's own rule, and the reason it is a
 * rule: an ambiguous protocol may carry the CALLER's data at any index, so
 * appending into it would overwrite a git config somebody else set.
 */
function validGitConfigCount(env) {
  const raw = env.GIT_CONFIG_COUNT;
  const indexed = Object.keys(env).filter(key => INDEXED_CONFIG.test(key));
  if (raw === undefined) return indexed.length === 0 ? 0 : null;
  if (!/^(?:0|[1-9]\d*)$/.test(String(raw))) return null;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || indexed.length !== count * 2) return null;
  for (let index = 0; index < count; index += 1) {
    if (env[`GIT_CONFIG_KEY_${index}`] === undefined || env[`GIT_CONFIG_VALUE_${index}`] === undefined) return null;
  }
  return indexed.some(key => Number(key.match(INDEXED_CONFIG)[1]) >= count) ? null : count;
}

/** Append, never clobber, and skip the append entirely when the protocol is ambiguous. */
function appendGitConfig(env, entries) {
  const next = { ...env };
  const base = validGitConfigCount(env);
  if (base === null) return next;
  entries.forEach(([key, value], index) => {
    next[`GIT_CONFIG_KEY_${base + index}`] = key;
    next[`GIT_CONFIG_VALUE_${base + index}`] = value;
  });
  next.GIT_CONFIG_COUNT = String(base + entries.length);
  return next;
}

/**
 * The declared chain, run the way Orca runs it: `/bin/bash -c <script>`, cwd the
 * WORKTREE, Orca's own hook environment, and the 120 s budget Orca gives it.
 * `defaultExec` is deliberately not used here — it carries no `env` and a 30 s
 * deadline, which would run a different command under a shorter clock than the
 * project wrote its chain against. Injected in every test, so no suite spawns it.
 */
const declaredHook = ({ command, cwd, env, timeoutMs = HOOK_TIMEOUT_MS }) => {
  const out = execRun('/bin/bash', ['-c', command], { cwd, env, timeout: timeoutMs });
  // spawnSync reports a child killed on its deadline as an ETIMEDOUT error with
  // a null status — the one failure whose wording a caller has to be told.
  return { ...out, timedOut: String((out.error ?? {}).code ?? '') === 'ETIMEDOUT', timeoutMs };
};

// ── the verb ────────────────────────────────────────────────────────────────

export function reclaim(
  argv = [],
  {
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    resolve: resolveBin = resolveOrca,
    runner,
    exec = defaultExec,
    gh = args => exec('gh', args, cwd),
    git = (at, args) => exec('git', args, at),
    // NAMED, with a real default. Two of the three registry reads used to call
    // `readWorktrees` directly, so a caller that injected every other probe
    // still let this verb ask the HOST's git — and a registry that changed or
    // refused between the boundaries was never observed by any test.
    worktrees = readWorktrees,
    clean: cleanup = clean,
    hook = declaredHook,
    store,
  } = {},
) {
  const usage = message => {
    bad(message);
    fix(USAGE);
    return 2;
  };
  const cannot = (reason, repair) => {
    bad(`CANNOT ESTABLISH — ${reason}`);
    fix(repair);
    return 3;
  };
  const deny = (kind, reason, repair) => {
    bad(`${kind} — ${reason}`);
    fix(repair);
    return 1;
  };

  // ── the argv this verb claims, and the flags it deliberately does not ─────
  if (argv.includes('--force')) {
    return usage(
      'this verb accepts no --force: a git lock and an Orca pin are retention claims an operator made, and a landed head is the only thing that authorises a removal',
    );
  }
  const unknown = argv.filter(arg => arg.startsWith('-') && arg !== '--store' && !arg.startsWith('--store='));
  if (unknown.length > 0) return usage(`unknown flag ${unknown[0]}`);
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--store') {
      index += 1;
      continue;
    }
    if (argv[index].startsWith('-')) continue;
    positional.push(argv[index]);
  }
  if (positional.length === 0) return usage('which worktree? this verb takes one exact target and never a pattern');
  if (positional.length > 1) return usage(`one target, not ${positional.length} (${positional.join(', ')}) — this verb never sweeps`);
  const target = positional[0];
  const storeRoot = argvValue(argv, '--store') ?? defaultStore(env);

  const { root, main } = repoPaths(cwd);
  if (root === null) return cannot('this is not inside a git repository, so no worktree of it can be named', `cd <checkout> && ${USAGE}`);
  const checkout = main ?? root;

  // ── the machine has to be able to answer before anything is judged ────────
  const bin = resolveBin({ env, platform });
  if (bin === null) {
    return cannot('this machine resolves no Orca CLI, and the git and Orca views cannot be reconciled without it', 'orca open   # then re-run');
  }
  const run = runner ?? createRunner({ bin, exec });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # then re-run');

  const named = repoView(gh);
  if (named.slug === '') {
    return cannot(`gh cannot name this repository, so no landing can be asked about: ${named.detail}`, 'gh auth status   # every landing proof is a gh query');
  }
  const slug = named.slug;
  const [owner, repoName] = slug.split('/');

  const registry = worktrees(checkout);
  if (!registry.known) {
    return cannot('git cannot enumerate this repository’s worktrees, and an unreadable registry proves nothing about a target', `git -C ${shq(checkout)} worktree list --porcelain`);
  }

  // ── the target ────────────────────────────────────────────────────────────
  const located = locateWorktree(target, { cwd, root, main, trees: registry.trees });
  if (located.error !== undefined) {
    // A target that no longer resolves may be one this host already reclaimed.
    // Reading that from the record is the difference between reporting a removal
    // it OBSERVED and going off to re-create a worktree nobody asked for.
    const prior = priorRemoval({ storeRoot, owner, repoName, target, cwd, slug, host: hostname() });
    if (prior !== null) {
      section(`reclaim ${prior.path}`);
      note(`the record ${prior.record} observed this removal at ${prior.at}`);
      note('nothing remains to release here: the checkout is gone from git and from Orca');
      ok(`ALREADY RECLAIMED ${prior.path} — no second removal was issued and no worktree was re-created`);
      return 0;
    }
    return deny('REFUSED', located.error, 'ax worktree ls   # every checkout this repository registers');
  }
  const path = located.path;
  if (path === checkout) {
    return deny('REFUSED', `${path} is the primary checkout — it is never a reclaim target`, 'ax worktree ls   # name one of the linked checkouts instead');
  }
  if (withinPath(physical(resolvePath(cwd)), physical(path))) {
    return deny(
      'REFUSED',
      `run this from outside the worktree you are reclaiming — ${path} is the tree this command is standing in, and reclaiming it would delete that directory`,
      `cd ${shq(checkout)} && ax worktree reclaim ${shq(target)}`,
    );
  }

  section(`reclaim ${path}`);

  const entry = registry.trees.find(tree => physical(tree.path) === physical(path));
  if (entry === undefined) {
    return deny('KEEP', `git no longer reports ${path} among its worktrees, so nothing here can account for it`, `git -C ${shq(checkout)} worktree list --porcelain`);
  }
  if (entry.branch === undefined) {
    return deny(
      'KEEP',
      `${path} has a detached HEAD, so no branch names the pull request that would prove it landed`,
      `git -C ${shq(path)} status   # put this checkout back on its branch, then re-run`,
    );
  }
  const branch = entry.branch;

  // ── the terms, cheapest and most conservative first ───────────────────────
  const state = measure({ run, git, worktrees, path, branch, checkout });
  if (state.keep !== undefined) return deny('KEEP', state.keep.reason, state.keep.repair);

  note(`retention: no git lock, and Orca reports isPinned=false`);
  note(`panes: 0 live in this worktree`);
  note('tree: clean, untracked files included');

  const claims = dependencyClaims({ run, checkout, path, branch });
  if (claims.keep !== undefined) return deny('KEEP', claims.keep.reason, claims.keep.repair);

  const landing = provenLanding({ gh, git, slug, branch, path, head: state.head, storeRoot, owner, repoName });
  if (landing.keep !== undefined) return deny('KEEP', landing.keep.reason, landing.keep.repair);
  note(`landed: ${slug}#${landing.pr} merged, merge commit ${landing.mergeCommit.slice(0, 12)}`);
  note(`landed head: ${state.head.slice(0, 12)} is the head ${landing.record} validated, so nothing on this branch escaped the landing`);

  const evidence = requiredEvidence({ storeRoot, path });
  if (evidence.keep !== undefined) return deny('KEEP', evidence.keep.reason, evidence.keep.repair);
  note(evidence.files.length === 0 ? 'evidence: the records require no artifact from this worktree' : `evidence: ${evidence.files.length} required artifact(s) to preserve`);

  // The cleanup stage's OWNER is decided before anything is destroyed: an
  // unknown declaration must not be discovered halfway, where the fallback it
  // would authorise runs a different cleanup than the project declared.
  const stage = resolveStage({ run, checkout });
  if (stage.unknown !== undefined) {
    return deny(
      'KEEP',
      `the project's archive declaration could not be read, and unknown is not absent: ${stage.unknown}`,
      `orca repo show --repo path:${shq(checkout)} --json   # and read ${shq(join(checkout, 'orca.yaml'))}; then re-run`,
    );
  }
  // A DECLARED CHAIN RUNS UNDER ORCA'S BOUNDARY OR NOT AT ALL. The credential
  // guard's two option identifiers are extracted from Orca's own helper into
  // this module (`scripts/extract-hook-guard-keys.mjs`); a checkout where that
  // extraction never ran carries placeholders, and running a project's chain
  // under a weaker boundary than the project's own tooling gives it is a
  // different command with the project's name on it. So it is a KEEP, and the
  // repair is the extraction rather than a flag.
  if (stage.owner === 'declared' && !hookGuardEstablished()) {
    return deny(
      'KEEP',
      `${stage.source} declares an archive command, and this checkout cannot reproduce the execution boundary Orca runs it under — its credential-guard option identifiers were never extracted, so the chain would run under a weaker guard than the project's own tooling gives it`,
      `node scripts/extract-hook-guard-keys.mjs --source <orca-checkout>   # then re-run; ax carries the bytes afterwards and reads no checkout at runtime`,
    );
  }
  if (stage.owner === 'declared' && platform === 'win32') {
    return deny(
      'KEEP',
      `${stage.source} declares an archive command, and Orca runs it under this platform's command shell, which this verb does not reproduce`,
      `orca worktree rm --worktree path:${shq(path)} --run-hooks --json   # run it through Orca on this platform, by hand`,
    );
  }
  note(`cleanup owner: ${stage.source}${stage.owner === 'declared' ? ` — ${firstLine(stage.command)}` : ' (this checkout declares no archive command)'}`);

  // ── recorded before it mutates ────────────────────────────────────────────
  //
  // THE KEY CARRIES THE TARGET, NOT ITS BASENAME. `git worktree add` accepts any
  // path, so `/a/slice` and `/b/slice` are two registered worktrees of one
  // repository with one basename — and keyed on the basename they were ONE
  // record. The second target then adopted the first's stages: a settled
  // cleanup it never ran, or a recorded removal read back as ALREADY RECLAIMED
  // for a tree still on disk. The digest is the same deterministic naming the
  // archive scope uses (../hash.mjs), so the identity is stable across runs and
  // distinct per target.
  const request = reclaimRequestFor({ owner, repoName, path });
  if (!requestIdOk(request)) {
    return deny('KEEP', `the recorded identity this reclaim would need ("${request}") violates the request-id grammar, so no mutation may be issued from it`, 'ax worktree ls   # rename or remove this checkout by hand');
  }
  const dir = join(storeRoot, RECLAIM_NS);
  const claim = claimRecord(dir, request);
  const fresh = claim.claimed || statSync(claim.path).size === 0;
  if (fresh) {
    initRecord(claim.path, { request, orca: bin, repo: slug, kind: RECLAIM_NS });
  }

  const lock = acquireLock(claim.path);
  if (!lock.held) {
    return deny('KEEP', `another caller owns this reclaim: ${lock.reason}`, `cat ${shq(claim.path)}   # read who holds it, and let that call finish`);
  }

  try {
    // AN ADOPTED RECORD IS PROVEN TO BE THIS TARGET'S BEFORE ANY STAGE OF IT IS
    // READ. The key alone is not that proof: a record can be hand-edited,
    // restored from another machine, or left by a run in another repository, and
    // every stage below decides whether something destructive is skipped or
    // repeated. So the identity is checked against what this run established.
    if (!fresh) {
      const adopted = recordIdentity(claim.path);
      if (adopted.unreadable !== undefined) {
        return deny('KEEP', `the reclaim record ${claim.path} cannot be read: ${adopted.unreadable}`, `cat ${shq(claim.path)}   # repair or move it aside, then re-run`);
      }
      const mismatch = identityMismatch(adopted, { request, slug, path, host: hostname() });
      if (mismatch !== '') {
        return deny(
          'KEEP',
          `the reclaim record ${claim.path} ${mismatch}, so its recorded stages say nothing about this target and adopting them could skip a cleanup or claim a removal that happened elsewhere`,
          `cat ${shq(claim.path)}   # establish which target it belongs to, then move it aside and re-run`,
        );
      }
    }

    // What THIS record already settled. A stage nobody knows the outcome of is
    // never re-run: an arbitrary project command re-executed on an uncertain
    // result is a second reclamation reported as one.
    let stages;
    try {
      stages = phaseStages(claim.path);
    } catch (error) {
      return deny('KEEP', `the reclaim record ${claim.path} cannot be read: ${String(error.message ?? error)}`, `cat ${shq(claim.path)}   # repair or move it aside, then re-run`);
    }
    const open = stages.find(row => row.exit === null);
    if (open !== undefined) {
      note(`recorded stages: ${stages.map(row => `${row.name}=${row.exit ?? 'unknown'}`).join(' ')}`);
      return deny(
        'STRANDED',
        `the recorded stage '${open.name}' never concluded${open.transport === null ? '' : ` (${open.transport})`}, so nobody knows whether it took effect — it is not re-run from here`,
        `cat ${shq(claim.path)}   # establish what that stage did, then finish or reverse it by hand`,
      );
    }
    const settled = name => stages.some(row => row.name === name && row.exit === 0);
    if (settled(STAGE.removal)) {
      note('the removal recorded here already returned removed:true');
      ok(`ALREADY RECLAIMED ${path} — the recorded removal is not issued a second time`);
      return 0;
    }

    // ── the archive, before anything is destroyed ─────────────────────────
    //
    // RUN ON EVERY ENTRY, settled or not. A recorded stage means "the bytes are
    // already there", never "stop proving they are": between an interrupted run
    // and this one the source Report may have been rewritten, and skipping the
    // comparison would delete a version nobody archived. `preserve` is
    // comparison-first — it reuses a copy whose digest already matches, refuses
    // one whose digest differs, and only writes what is missing — so re-running
    // it duplicates nothing and is the proof itself.
    phaseBegin(claim.path, { name: STAGE.archive, identity: newIdentity(), argv: ['evidence-archive', '--worktree', path, '--into', join(checkout, ARCHIVE_DIR)] });
    const kept = preserve({ checkout, path, owner, repoName, files: evidence.files });
    phaseEnd(claim.path, 'last', { exit: kept.keep === undefined ? 0 : 1, receiptText: JSON.stringify(kept.receipt ?? {}) });
    if (kept.keep !== undefined) return deny('KEEP', kept.keep.reason, kept.keep.repair);
    for (const line of kept.notes) note(line);

    // ── the mutation boundary: the checks and the mutation are not one instant
    const again = measure({ run, git, worktrees, path, branch, checkout });
    if (again.keep !== undefined) {
      return deny('KEEP', `the target changed between the eligibility checks and the mutation: ${again.keep.reason}`, again.keep.repair);
    }
    if (again.head !== state.head) {
      return deny(
        'KEEP',
        `the target changed between the eligibility checks and the mutation: HEAD moved from ${state.head.slice(0, 12)} to ${again.head.slice(0, 12)}`,
        `cd ${shq(path)} && git log --oneline ${state.head.slice(0, 12)}..HEAD   # deliver what arrived, then re-run`,
      );
    }

    // ── cleanup, exactly once, owned by whoever the project says ──────────
    if (settled(STAGE.declared) || settled(STAGE.axClean)) {
      note('cleanup: already settled by the recorded stage, so it is not run again');
    } else if (stage.owner === 'declared') {
      phaseBegin(claim.path, { name: STAGE.declared, identity: newIdentity(), argv: ['/bin/bash', '-c', stage.command] });
      const out = hook({ command: stage.command, cwd: path, env: hookEnvironment({ env, main: checkout, worktree: path }), timeoutMs: HOOK_TIMEOUT_MS });
      phaseEnd(claim.path, 'last', {
        exit: out.error ? null : (out.status ?? null),
        receiptText: String(out.stdout ?? ''),
        stderr: String(out.stderr ?? ''),
        error: out.error ? String(out.error.message ?? out.error) : null,
      });
      const failure =
        out.error
          ? `it could not be launched: ${String(out.error.message ?? out.error)}`
          : out.timedOut
            ? `it overran the ${HOOK_TIMEOUT_MS} ms Orca budgets for it`
            : out.status !== 0
              ? `it reported exit ${out.status}`
              : '';
      if (failure !== '') {
        for (const line of [...lines(out.stdout).slice(-NAMED), ...lines(out.stderr).slice(-NAMED)]) note(line);
        return deny(
          'KEEP',
          `the cleanup stage the project declares in ${stage.source} failed — ${failure}; the worktree is retained and no removal was attempted`,
          `cd ${shq(path)} && ${stage.command.includes('\n') ? firstLine(stage.command) : stage.command}   # run the project's own chain and read it whole, then re-run`,
        );
      }
      // Taken at its word: a project that warns and continues has made its own
      // judgement, and this line neither upgrades nor overrides it.
      for (const line of [...lines(out.stdout).slice(-NAMED), ...lines(out.stderr).slice(-NAMED)]) note(line);
      note(`cleanup: ${stage.source} reported success (exit 0) — reported as the project reported it`);
    } else {
      phaseBegin(claim.path, { name: STAGE.axClean, identity: newIdentity(), argv: ['ax', 'worktree', 'clean', path] });
      const code = cleanup([path]);
      phaseEnd(claim.path, 'last', { exit: code, receiptText: '' });
      if (code !== 0) {
        return deny(
          'KEEP',
          `ax worktree clean refused this checkout (exit ${code}), and it owns the cleanup stage here; the worktree is retained and no removal was attempted`,
          `ax worktree clean ${shq(path)}   # read its refusal whole, then re-run`,
        );
      }
      note('cleanup: ax worktree clean reclaimed this checkout’s processes, containers and caches');
    }

    // ── the removal, with no repo-hook flag ───────────────────────────────
    const removeArgv = ['worktree', 'rm', '--worktree', `path:${path}`, '--json'];
    phaseBegin(claim.path, { name: STAGE.removal, identity: newIdentity(), argv: removeArgv });
    const removal = run(removeArgv);
    phaseEnd(claim.path, 'last', {
      exit: removal.error ? null : (removal.status ?? null),
      receiptText: String(removal.stdout ?? ''),
      stderr: String(removal.stderr ?? ''),
      error: removal.error ? String(removal.error.message ?? removal.error) : null,
    });
    const receipt = removal.receipt ?? {};
    if (removal.error) {
      return deny(
        'STRANDED',
        `the removal never concluded (${String(removal.error.message ?? removal.error)}), so whether it took effect is unknown — the cleanup stage above already ran, so this worktree may be holding nothing`,
        `orca worktree show --worktree path:${shq(path)} --json   # establish what remains; the record is ${claim.path}`,
      );
    }
    if (receipt.ok !== true || (receipt.result ?? {}).removed !== true) {
      const detail = (receipt.error ?? {}).message ?? receipt.unparseable ?? firstLine(removal.stderr) ?? '';
      return deny(
        'KEEP',
        `Orca refused the removal: ${String(detail).slice(0, 300) || `exit ${removal.status}`} — the cleanup stage already ran, so this checkout is retained but may be holding none of its resources`,
        `orca worktree rm --worktree path:${shq(path)} --json   # read the refusal whole; the recorded state is ${claim.path}`,
      );
    }

    // Both views, or a half-state named. A removal that convinced git and left
    // Orca holding the row is exactly the state this verb exists to end.
    const after = worktrees(checkout);
    if (!after.known) {
      return deny(
        'KEEP',
        'the removal returned removed:true and git can no longer be asked whether the checkout is gone, so the outcome is unverified',
        `git -C ${shq(checkout)} worktree list --porcelain   # confirm what remains; the record is ${claim.path}`,
      );
    }
    if (after.trees.some(tree => physical(tree.path) === physical(path))) {
      return deny(
        'KEEP',
        `the removal returned removed:true and git still registers ${path} — a half-state, not a reclaim`,
        `git -C ${shq(checkout)} worktree list --porcelain   # then: git -C ${shq(checkout)} worktree prune`,
      );
    }
    const orphan = run(['worktree', 'show', '--worktree', `path:${path}`, '--json']);
    if ((orphan.receipt ?? {}).ok === true && ((orphan.receipt.result ?? {}).worktree ?? null) !== null) {
      return deny(
        'KEEP',
        `git no longer registers ${path} and Orca still holds its workspace row — a half-state, not a reclaim`,
        `orca worktree rm --worktree path:${shq(path)} --json   # converge the Orca view; the record is ${claim.path}`,
      );
    }

    const result = receipt.result ?? {};
    const preserved = (result.preservedBranch ?? {}).branchName ?? null;
    if (typeof result.warning === 'string' && result.warning.trim() !== '') note(`orca: ${result.warning.trim()}`);
    note(`orca: the workspace row is gone, and its stale pull-request badge with it`);
    // No `repo` backfill: `initRecord` already wrote it, and that parameter
    // fills an ABSENCE — passing a name a record already carries throws.
    attemptSettle(claim.path);
    ok(
      `RECLAIMED ${path} — gone from git and from Orca; branch ${branch} ${preserved === null ? 'deleted with the tree' : `retained (Orca could not prove it safe to delete: ${preserved})`}`,
    );
    return 0;
  } finally {
    lock.release();
  }
}

/** The recorded stage names. One vocabulary, read by the recovery above. */
const STAGE = { archive: 'evidence-archive', declared: 'cleanup-declared', axClean: 'cleanup-ax-clean', removal: 'worktree-rm' };

/**
 * THIS TARGET'S RECLAIM IDENTITY: the repository, the checkout's own name, and a
 * deterministic digest of its absolute path.
 *
 * The digest is what makes it a TARGET identity rather than a name: two
 * worktrees of one repository may share a basename (`git worktree add` accepts
 * any path), and keyed on the name alone they shared one record — so the second
 * one adopted the first's settled stages. `gitBlobSha` is the same deterministic
 * naming the archive scope uses, so the key is stable across runs.
 */
export function reclaimRequestFor({ owner, repoName, path }) {
  return `${RECLAIM_NS}-${owner}-${repoName}-${basename(path)}-${gitBlobSha(path).slice(0, 12)}`;
}

/**
 * What a record on disk SAYS it belongs to:
 * `{ request, repo, host, targets, stages }`, or `{ unreadable }`.
 *
 * `targets` is every worktree path its stages name, read from the recorded argv
 * — the only place a reclaim record states its subject — and `stages` is how
 * many phases it carries, so the caller can tell "nothing recorded yet" from
 * "stages that name no target". Those are different facts: the first is a
 * record with nothing to trust, the second is a record whose stages cannot be
 * attributed to this tree.
 */
function recordIdentity(recordPath) {
  try {
    const rec = JSON.parse(readFileSync(recordPath, 'utf8'));
    const targets = new Set();
    let stages = 0;
    for (const attempt of Array.isArray(rec.attempts) ? rec.attempts : []) {
      for (const phase of Array.isArray(attempt.phases) ? attempt.phases : []) {
        stages += 1;
        for (const word of Array.isArray(phase.argv) ? phase.argv : []) {
          if (typeof word === 'string' && word.startsWith('path:')) targets.add(word.slice('path:'.length));
          if (typeof word === 'string' && word.startsWith('--worktree=path:')) targets.add(word.slice('--worktree=path:'.length));
        }
        // The archive stage names its worktree as a bare argument.
        if (Array.isArray(phase.argv) && phase.argv[0] === STAGE.archive) {
          const at = phase.argv.indexOf('--worktree');
          if (at !== -1 && typeof phase.argv[at + 1] === 'string') targets.add(phase.argv[at + 1]);
        }
      }
    }
    return {
      request: typeof rec.request === 'string' ? rec.request : '',
      repo: typeof rec.repo === 'string' ? rec.repo.trim() : '',
      host: typeof rec.host === 'string' ? rec.host.trim() : '',
      targets: [...targets],
      stages,
    };
  } catch (error) {
    return { unreadable: String(error.message ?? error) };
  }
}

/**
 * Why an adopted record may NOT be consumed for this target, or `''` when it
 * POSITIVELY binds to it.
 *
 * BINDING IS POSITIVE, NOT MERELY NON-CONTRADICTORY, and the first cut of this
 * had it the weak way ("absence is not a mismatch"). A partial record —
 * request-shaped filename, no `repo`, no `host`, a settled cleanup stage whose
 * argv names nothing — contradicts nothing at all, and would therefore have
 * been adopted: its stages then decide that a cleanup need not run, or that a
 * removal already happened. That is an unproven identity authorising a
 * destructive skip, which is the F-001 shape.
 *
 * There is no legacy to accommodate here: this record kind is introduced by
 * this verb, and `initRecord` writes `request`, `repo` and `host` on the first
 * write of every one of them. So all three are REQUIRED, and an absent one is a
 * KEEP rather than a permissive pass.
 *
 * THE FILENAME IS NOT THE IDENTITY. The store path is caller-supplied
 * (`--store`) and the key embeds a path digest, so a collision or a hand-placed
 * file could put anything at this name — the record has to say what it is.
 *
 * TARGET BINDING IS DERIVED FROM THE RECORDED ARGV, positively: every stage
 * this verb writes names its worktree in its own argv (`path:<p>` for the
 * removal, `--worktree <p>` for the archive), so a record WITH stages must name
 * this target and nothing else. A record with NO stages binds on the three
 * fields alone — there is no stage to trust, so nothing destructive can be
 * skipped by adopting it.
 */
function identityMismatch(adopted, { request, slug, path, host }) {
  if (adopted.request === '') return 'records no request of its own, so what it belongs to is unproven and its filename cannot stand in for it';
  if (adopted.request !== request) return `names the request ${JSON.stringify(adopted.request)}, not ${JSON.stringify(request)}`;
  if (adopted.repo === '') return 'names no repository, so that it belongs to this one is unproven';
  if (adopted.repo.toLowerCase() !== String(slug).toLowerCase()) return `belongs to another repository (${adopted.repo})`;
  if (adopted.host === '') return 'names no host, so that its recorded stages ran on this machine is unproven';
  if (adopted.host !== host) return `was written on another host (${adopted.host})`;
  const foreign = adopted.targets.filter(named => physical(named) !== physical(path));
  if (foreign.length > 0) return `records stages against another target (${foreign.slice(0, NAMED).join(', ')})`;
  if (adopted.stages > 0 && adopted.targets.length === 0) {
    return `records ${adopted.stages} stage(s) whose argv names no worktree, so that they were performed on THIS target is unproven`;
  }
  return '';
}

/**
 * A removal THIS HOST recorded for a target that no longer resolves.
 *
 * Only for a path-shaped target, and only when the recorded removal argv names
 * that exact path: a bare name cannot be resolved once its worktree is gone, and
 * a record that names another path is another target's.
 */
function priorRemoval({ storeRoot, owner, repoName, target, cwd, slug, host }) {
  const candidate = physical(resolvePath(cwd, target));
  const request = reclaimRequestFor({ owner, repoName, path: candidate });
  if (!requestIdOk(request)) return null;
  const record = join(storeRoot, RECLAIM_NS, `${request}.json`);
  if (!existsSync(record)) return null;
  const adopted = recordIdentity(record);
  // The same binding the mutation path makes: a record that is not provably
  // this target's reports no removal for it.
  if (adopted.unreadable !== undefined) return null;
  if (identityMismatch(adopted, { request, slug, path: candidate, host }) !== '') return null;
  try {
    if (recordedRequest(record) !== request) return null;
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    for (const attempt of Array.isArray(rec.attempts) ? rec.attempts : []) {
      for (const phase of Array.isArray(attempt.phases) ? attempt.phases : []) {
        if (phase.name !== STAGE.removal || phase.exit !== 0) continue;
        if (!Array.isArray(phase.argv) || !phase.argv.includes(`path:${candidate}`)) continue;
        if (((phase.receipt ?? {}).result ?? {}).removed !== true) continue;
        return { path: candidate, record, at: phase.beganAt ?? rec.createdAt ?? 'an unrecorded time' };
      }
    }
  } catch {
    // An unreadable record proves no removal; the caller's refusal stands.
  }
  return null;
}

/**
 * The terms a KEEP is decided from, measured together so the boundary can take
 * the SAME measurement a second time: the retention claims, the panes, the
 * status and the head. `{ head }` when every one of them holds, `{ keep }` on
 * the first that does not — including every one that could not be READ.
 */
function measure({ run, git, worktrees, path, branch, checkout }) {
  const registry = worktrees(checkout);
  if (!registry.known) {
    return { keep: { reason: 'git cannot enumerate this repository’s worktrees, so the target cannot be accounted for', repair: `git -C ${shq(checkout)} worktree list --porcelain` } };
  }
  const entry = registry.trees.find(tree => physical(tree.path) === physical(path));
  if (entry === undefined) {
    return { keep: { reason: `git no longer registers ${path}`, repair: `git -C ${shq(checkout)} worktree list --porcelain` } };
  }
  if (entry.locked) {
    return {
      keep: {
        reason: `${path} is locked in git${entry.lockReason ? `, and the lock says: "${entry.lockReason}"` : ' with no reason recorded'} — a lock is a retention claim, and this verb honours it`,
        repair: `git -C ${shq(checkout)} worktree unlock ${shq(path)}   # only once that claim no longer holds, then re-run`,
      },
    };
  }

  const show = run(['worktree', 'show', '--worktree', `path:${path}`, '--json']);
  const receipt = show.receipt ?? {};
  const worktree = (receipt.result ?? {}).worktree ?? null;
  if (receipt.ok !== true || worktree === null || typeof worktree !== 'object') {
    const detail = (receipt.error ?? {}).message ?? receipt.unparseable ?? firstLine(show.stderr) ?? '';
    return {
      keep: {
        reason: `orca worktree show could not answer for ${path}: ${String(detail).slice(0, 200) || `exit ${show.status}`} — an unread inventory is not an unclaimed target`,
        repair: `orca worktree show --worktree path:${shq(path)} --json   # then re-run`,
      },
    };
  }
  if (typeof worktree.isPinned !== 'boolean') {
    return {
      keep: {
        reason: `the Orca receipt for ${path} carries no isPinned field, so whether an operator pinned this workspace is unread — an absent answer is never "not retained"`,
        repair: `orca worktree show --worktree path:${shq(path)} --json   # establish isPinned, then re-run`,
      },
    };
  }
  if (worktree.isPinned === true) {
    return {
      keep: {
        reason: `${path} is pinned in Orca, which is a retention claim this verb honours rather than overrides`,
        repair: `orca worktree set --worktree path:${shq(path)} --json   # unpin it in Orca once the claim no longer holds, then re-run`,
      },
    };
  }
  const kids = worktree.childWorktreeIds;
  if (!Array.isArray(kids)) {
    return {
      keep: {
        reason: `the Orca receipt for ${path} carries no childWorktreeIds field, so whether dependent work still points at this checkout is unread`,
        repair: `orca worktree show --worktree path:${shq(path)} --json   # establish its lineage, then re-run`,
      },
    };
  }
  if (kids.length > 0) {
    return {
      keep: {
        reason: `${kids.length} worktree(s) still name ${path} as their lineage parent: ${kids.slice(0, NAMED).join(', ')} — dependent work is a retention claim`,
        repair: `orca worktree ps --json   # reclaim the dependents first, or repoint them, then re-run`,
      },
    };
  }

  // PANES COME THROUGH THE SHARED READER, WITH ITS COVERAGE RULE.
  //
  // `terminalInventory` (../worker/pane.mjs) is the one reader of "which panes
  // does this runtime still own": it refuses an absent container and a
  // TRUNCATED list, and it carries the scope — `hostIds` covered,
  // `omittedHostIds` not asked. Reading a scoped `terminal list` here instead
  // reproduced none of that: an EMPTY `terminals` array from a reply whose scope
  // omitted the host that owns this target read as "nobody is there", which is
  // an unread machine authorising a deletion (F-028).
  //
  // Coverage is judged for THIS TARGET'S OWN HOST and nothing else. An
  // unrelated sleeping runtime must not make a local worktree unreclaimable —
  // that is the #83 cost, and `paneVerdict` states the same rule: a reply that
  // read `local` covers the runtime that answered it.
  const inventory = terminalInventory(run);
  if (!inventory.ok) {
    return {
      keep: {
        reason: `${inventory.reason} — an absent or partial pane list cannot prove nobody is still in ${path}`,
        repair: `orca terminal list --json   # then re-run`,
      },
    };
  }
  const host = String(worktree.hostId ?? (worktree.identity ?? {}).executionHostId ?? '');
  if (host === '') {
    return {
      keep: {
        reason: `the Orca receipt for ${path} names no execution host, so which runtime had to be asked about its panes is unread`,
        repair: `orca worktree show --worktree path:${shq(path)} --json   # establish hostId, then re-run`,
      },
    };
  }
  const covered = Array.isArray(inventory.hosts) && (inventory.hosts.includes(host) || (host === 'local' && inventory.hosts.includes('local')));
  if (!covered) {
    const omitted = Array.isArray(inventory.omittedHosts) ? inventory.omittedHosts : [];
    return {
      keep: {
        reason: `${path} is owned by execution host '${host}', which this pane list did not read (it covered ${(inventory.hosts ?? []).join(', ') || 'nothing it named'}${omitted.length > 0 ? `, omitting ${omitted.slice(0, NAMED).join(', ')}` : ''}) — an unqueried host is not an empty one`,
        repair: `orca terminal list --environment ${shq(host)} --json   # ask the host that owns it, then re-run`,
      },
    };
  }
  const mine = pane =>
    (typeof pane.worktreeId === 'string' && worktree.id !== undefined && pane.worktreeId === worktree.id) ||
    (typeof pane.worktreePath === 'string' && physical(pane.worktreePath) === physical(path));
  const live = [...inventory.byHandle.values()].filter(pane => pane !== null && typeof pane === 'object' && mine(pane) && pane.orphaned !== true);
  if (live.length > 0) {
    return {
      keep: {
        reason: `${live.length} live pane(s) in ${path}: ${live.slice(0, NAMED).map(pane => pane.handle).join(', ')} — a released worker does not make every pane in its tree disposable`,
        // NEVER `--worktree … --all`. That sweeps whatever is registered at the
        // moment it runs — including a shell a human opened after this reason
        // was printed — and a title is not ownership: measured on a freshly
        // created workspace, `kind`, `command`, `agentType`, `cliProvenance`
        // and `createdAt` are all null, so nothing in the list distinguishes a
        // generated Setup pane from somebody's own terminal. The repair names
        // the INSPECTION first, then the exact handles it was printed for.
        repair: `orca terminal show --terminal ${live[0].handle} --json   # inspect each, then close only the ones you own, by handle: ${live
          .slice(0, NAMED)
          .map(pane => `orca terminal close --terminal ${pane.handle} --json`)
          .join(' ; ')}`,
      },
    };
  }

  const status = git(path, ['status', '--porcelain']);
  if (status.error || status.status !== 0 || typeof status.stdout !== 'string') {
    const detail = status.error ? String(status.error.message ?? status.error) : firstLine(status.stderr) || `exit ${status.status}`;
    return {
      keep: {
        reason: `git cannot answer whether ${path} is clean: ${detail} — an unreadable status is never a clean verdict`,
        repair: `git -C ${shq(path)} status --porcelain   # then re-run`,
      },
    };
  }
  const dirty = lines(status.stdout);
  if (dirty.length > 0) {
    return {
      keep: {
        reason: `${dirty.length} uncommitted change(s) in ${path}: ${dirty.slice(0, NAMED).map(line => line.trim()).join(', ')} — retained work is delivered, never discarded`,
        repair: `cd ${shq(path)} && git status   # commit and deliver it, or remove it deliberately with ax worktree rm`,
      },
    };
  }

  const head = git(path, ['rev-parse', 'HEAD']);
  const sha = firstLine(head.stdout);
  if (head.error || head.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    const detail = head.error ? String(head.error.message ?? head.error) : firstLine(head.stderr) || `exit ${head.status}`;
    return { keep: { reason: `git cannot answer the HEAD of ${path}: ${detail}`, repair: `git -C ${shq(path)} rev-parse HEAD   # then re-run` } };
  }
  return { head: sha };
}

/**
 * Is another registered worktree BASED on this branch? That is the branch
 * retention claim this verb can prove, and it is decisive because the supported
 * removal always attempts to delete the checked-out branch: there is no
 * keep-branch flag to compose, so the whole target is retained instead.
 *
 * A row that carries no `baseRef` key cannot answer the question, and an
 * unanswered claim is a KEEP (F-028) rather than a row read as "no claim".
 */
function dependencyClaims({ run, checkout, path, branch }) {
  const list = run(['worktree', 'list', '--repo', `path:${checkout}`, '--json']);
  const receipt = list.receipt ?? {};
  const rows = (receipt.result ?? {}).worktrees;
  if (receipt.ok !== true || !Array.isArray(rows)) {
    const detail = (receipt.error ?? {}).message ?? receipt.unparseable ?? firstLine(list.stderr) ?? '';
    return {
      keep: {
        reason: `orca worktree list could not answer this repository's workspaces: ${String(detail).slice(0, 200) || `exit ${list.status}`} — whether anything claims this branch is unread`,
        repair: `orca worktree list --repo path:${shq(checkout)} --json   # then re-run`,
      },
    };
  }
  const others = rows.filter(row => row !== null && typeof row === 'object' && typeof row.path === 'string' && physical(row.path) !== physical(path));
  // THE PRIMARY CHECKOUT CARRIES NO baseRef, AND THAT IS NOT AN UNREAD CLAIM.
  // Measured 2026-09-06 on this repository: the main worktree's row omits the
  // key entirely (it was not created FROM a base ref — it is the repository),
  // while every linked workspace carries it. Reading that absence as "unknown"
  // refused every target on the repository forever, which is a false KEEP and
  // exactly as useless as a false RECLAIM. A row that does not ESTABLISH itself
  // as the main worktree stays in the unread set, so the exemption cannot be
  // inherited by a row that simply failed to answer.
  const unread = others.filter(row => !('baseRef' in row) && row.isMainWorktree !== true);
  if (unread.length > 0) {
    return {
      keep: {
        reason: `${unread.length} workspace row(s) carry no baseRef field, so whether they are based on ${branch} is unread: ${unread.slice(0, NAMED).map(row => row.path).join(', ')}`,
        repair: `orca worktree list --repo path:${shq(checkout)} --json   # establish every baseRef, then re-run`,
      },
    };
  }
  const claimants = others.filter(row => String(row.baseRef ?? '') === `refs/heads/${branch}`);
  if (claimants.length > 0) {
    return {
      keep: {
        reason:
          `${claimants.length} workspace(s) are based on ${branch}: ${claimants.slice(0, NAMED).map(row => row.path).join(', ')} — the supported Orca removal always attempts to delete the checked-out branch and offers no keep-branch operation, so the whole target is retained rather than risking a claimed branch`,
        repair: `orca worktree ps --json   # rebase or reclaim the dependent workspaces first, then re-run`,
      },
    };
  }
  return {};
}

/**
 * DID IT LAND, AND DID EVERYTHING ON THIS BRANCH LAND WITH IT?
 *
 * `{ pr, mergeCommit, record }` or `{ keep }`. Two reads, and neither substitutes
 * for the other: the tracker says a MERGED pull request closed with a named
 * merge commit, and the Gate's own merge record says which head that merge
 * validated. A current `headRefOid` is not offered as a fallback — it moves
 * after the merge, which is exactly the #204 shape this refuses.
 */
function provenLanding({ gh, git, slug, branch, path, head, storeRoot, owner, repoName }) {
  const listArgv = ['pr', 'list', '--repo', slug, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName'];
  const list = gh(listArgv);
  if (list.error || list.status !== 0) {
    const detail = list.error ? String(list.error.message ?? list.error) : firstLine(list.stderr) || `exit ${list.status}`;
    return { keep: { reason: `gh cannot say which pull request claims ${branch}: ${detail}`, repair: `gh ${listArgv.join(' ')}   # then re-run` } };
  }
  let rows;
  try {
    rows = JSON.parse(list.stdout);
  } catch {
    return { keep: { reason: `gh answered an unreadable pull-request list for ${branch}`, repair: `gh ${listArgv.join(' ')}   # then re-run` } };
  }
  if (!Array.isArray(rows)) {
    return { keep: { reason: `gh answered no pull-request list for ${branch}`, repair: `gh ${listArgv.join(' ')}   # then re-run` } };
  }
  const mine = rows.filter(row => String((row ?? {}).headRefName ?? '') === branch);
  if (mine.length === 0) {
    return {
      keep: {
        reason: `not landed yet: no pull request claims head ${branch}`,
        repair: `cd ${shq(path)} && ax pr gate --pr <n>   # this checkout is reclaimed once its pull request has MERGED, and never before`,
      },
    };
  }
  if (mine.length > 1) {
    return {
      keep: {
        reason: `${mine.length} pull requests claim head ${branch} (${mine.slice(0, NAMED).map(row => `#${row.number}`).join(', ')}), so nothing here can name the one that proves this checkout`,
        repair: `gh ${listArgv.join(' ')}   # close or retarget the duplicates: one head, one pull request`,
      },
    };
  }
  const pr = mine[0];
  const stateNow = String(pr.state ?? '').toUpperCase();
  if (stateNow === 'OPEN') {
    return {
      keep: {
        reason: `not landed yet: ${slug}#${pr.number} is still open`,
        repair: `cd ${shq(path)} && ax pr gate --pr ${pr.number}   # the gate names what still blocks that merge`,
      },
    };
  }
  if (stateNow !== 'MERGED') {
    return {
      keep: {
        reason: `${slug}#${pr.number} reads ${stateNow || 'no state'}, so nothing this checkout did ever landed`,
        repair: `gh pr view ${pr.number} --repo ${slug} --json state,mergeCommit   # decide that pull request's fate before this checkout's`,
      },
    };
  }

  const viewArgv = ['pr', 'view', String(pr.number), '--repo', slug, '--json', 'state,mergeCommit'];
  const view = gh(viewArgv);
  if (view.error || view.status !== 0) {
    const detail = view.error ? String(view.error.message ?? view.error) : firstLine(view.stderr) || `exit ${view.status}`;
    return { keep: { reason: `gh cannot confirm the merge of ${slug}#${pr.number}: ${detail}`, repair: `gh ${viewArgv.join(' ')}   # then re-run` } };
  }
  let landed;
  try {
    landed = JSON.parse(view.stdout);
  } catch {
    return { keep: { reason: `gh answered an unreadable view of ${slug}#${pr.number}`, repair: `gh ${viewArgv.join(' ')}   # then re-run` } };
  }
  const mergeCommit = String(((landed ?? {}).mergeCommit ?? {}).oid ?? '').trim();
  if (String((landed ?? {}).state ?? '').toUpperCase() !== 'MERGED' || mergeCommit === '') {
    return {
      keep: {
        reason: `cannot establish the landing of ${slug}#${pr.number}: it reads MERGED in the list and names no merge commit, which is an unread pair rather than a landing`,
        repair: `gh ${viewArgv.join(' ')}   # establish the merge commit, then re-run`,
      },
    };
  }

  // The head that ACTUALLY landed, from the record the gate wrote before it
  // mutated — bound to this pull request by the record's own identity.
  const request = `merge-${owner}-${repoName}-${pr.number}`;
  const record = join(storeRoot, 'merge', `${request}.json`);
  if (!existsSync(record)) {
    return {
      keep: {
        reason: `no Gate merge record at ${record}, so the head ${slug}#${pr.number} actually landed is unproven — a current headRefOid moves after a merge and does not stand in for it`,
        repair: `cd ${shq(path)} && git log --oneline origin/main..HEAD   # establish by hand that nothing on this branch is unlanded, then remove it with ax worktree rm`,
      },
    };
  }
  let recordedSha = '';
  try {
    if (recordedRequest(record) !== request) {
      return { keep: { reason: `the merge record ${record} names another request, so it proves nothing about ${slug}#${pr.number}`, repair: `cat ${shq(record)}   # move the impostor aside, then re-run` } };
    }
    const stages = phaseStages(record);
    const merge = [...stages].reverse().find(row => row.name === 'pr-merge');
    if (merge === undefined) {
      return { keep: { reason: `the merge record ${record} carries no pr-merge stage, so no validated head can be read from it`, repair: `cat ${shq(record)}   # then re-run` } };
    }
    if (merge.exit !== 0) {
      return {
        keep: {
          reason: `the merge recorded in ${record} did not conclude successfully (exit ${merge.exit ?? 'unknown'}), so the head it wrote is not a head this verb may treat as landed`,
          repair: `cat ${shq(record)}   # establish what that merge did, then re-run`,
        },
      };
    }
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    const phases = (Array.isArray(rec.attempts) ? rec.attempts : []).flatMap(attempt => (Array.isArray(attempt.phases) ? attempt.phases : []));
    const last = [...phases].reverse().find(phase => phase.name === 'pr-merge' && Array.isArray(phase.argv));
    recordedSha = String(argvValue(last?.argv ?? [], '--match-head-commit') ?? '').trim();
  } catch (error) {
    return { keep: { reason: `the merge record ${record} cannot be read: ${String(error.message ?? error)}`, repair: `cat ${shq(record)}   # then re-run` } };
  }
  if (recordedSha === '') {
    return { keep: { reason: `the merge record ${record} names no --match-head-commit, so the head that landed is unproven`, repair: `cat ${shq(record)}   # then re-run` } };
  }
  if (recordedSha !== head) {
    const log = git(path, ['log', '--format=%H %s', '-n', String(NAMED), `${recordedSha}..HEAD`]);
    const escaped = lines(log.stdout).map(line => `${line.slice(0, 12)}${line.slice(40)}`);
    for (const line of escaped) note(`undelivered: ${line}`);
    return {
      keep: {
        reason:
          `${escaped.length === 0 ? 'HEAD' : `${escaped.length} commit(s)`} on ${branch} never landed: the merge of ${slug}#${pr.number} validated ${recordedSha.slice(0, 12)} and HEAD is ${head.slice(0, 12)} — retained work whose repair is DELIVERY`,
        repair: `cd ${shq(path)} && ax pr gate --pr <n>   # open a follow-up pull request for those commits and land it; nothing here discards or stashes them`,
      },
    };
  }
  return { pr: pr.number, mergeCommit, record: `merge-${owner}-${repoName}-${pr.number}` };
}

/**
 * WHAT MUST SURVIVE THIS WORKTREE, inventoried from the governing records — and
 * every other `.scratch/` file, which is why this can refuse.
 *
 * The Report's path is one rule with one owner (../worker/report.mjs), crossed
 * here rather than re-derived, and the records that govern this worktree are the
 * ones whose own effects name it (../worker/transcript.mjs). Anything else under
 * `.scratch/` is UNCLASSIFIED: it is gitignored, so it is the only copy there
 * is, and this verb neither copies it blindly nor deletes it — it retains the
 * checkout and names the file.
 */
function requiredEvidence({ storeRoot, path }) {
  const scan = scanStore(storeRoot);
  if (scan.reason !== '' && !scan.missing) {
    return { keep: { reason: `the dispatch store ${storeRoot} cannot be enumerated (${scan.reason}), so what must survive this worktree is unknown`, repair: `ls ${shq(storeRoot)}   # then re-run` } };
  }
  if (scan.unreadable.length > 0) {
    return {
      keep: {
        reason: `${scan.unreadable.length} record(s) in ${storeRoot} cannot be read (${scan.unreadable.slice(0, NAMED).map(row => row.file).join(', ')}), and an unread record may be the one requiring an artifact from this worktree`,
        repair: `cat ${shq(join(storeRoot, scan.unreadable[0].file))}   # repair or move it aside, then re-run`,
      },
    };
  }

  const files = [];
  for (const { rec } of scan.records) {
    let owns = false;
    try {
      owns = worktreesOf(rec).some(named => physical(named) === physical(path));
    } catch {
      owns = false;
    }
    if (!owns) continue;
    const derived = reportPathFor({ worktree: path, request: rec.request });
    if (derived.path === undefined) {
      return { keep: { reason: `the record ${rec.request} governs this worktree and ${derived.reason}`, repair: `cat ${shq(join(storeRoot, `${rec.request}.json`))}   # then re-run` } };
    }
    if (!existsSync(derived.path)) {
      return {
        keep: {
          reason: `the record ${rec.request} governs this worktree and its required Report is missing at ${derived.path} — the only filesystem copy of it is inside the tree this would delete`,
          repair: `ls ${shq(join(path, '.scratch', 'report'))}   # establish where that Report went, then re-run`,
        },
      };
    }
    files.push({ request: rec.request, source: derived.path });
  }

  const scratch = join(path, '.scratch');
  const present = walkFiles(scratch);
  if (present.unreadable !== undefined) {
    return { keep: { reason: `${scratch} cannot be inventoried (${present.unreadable}), so whether it holds unpreserved work is unknown`, repair: `ls -R ${shq(scratch)}   # then re-run` } };
  }
  const classified = new Set(files.map(entry => physical(entry.source)));
  const unclassified = present.files.filter(file => !classified.has(physical(file)));
  if (unclassified.length > 0) {
    return {
      keep: {
        reason:
          `${unclassified.length} file(s) under ${scratch} are accounted for by no governing record: ${unclassified.slice(0, NAMED).map(file => file.slice(path.length + 1)).join(', ')} — gitignored content is the only copy there is, and this verb neither copies nor deletes what it cannot classify`,
        repair: `ls -R ${shq(scratch)}   # move what matters out of the worktree, or delete it deliberately, then re-run`,
      },
    };
  }
  return { files };
}

/** Every file under `root`, or the reason it could not be walked. `[]` when absent. */
function walkFiles(root) {
  if (!existsSync(root)) return { files: [] };
  const files = [];
  const stack = [root];
  try {
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) stack.push(full);
        else files.push(full);
      }
    }
  } catch (error) {
    return { unreadable: String(error.message ?? error), files };
  }
  return { files };
}

/**
 * The copy, and its proof. Scoped by repository, by the worktree the artifact
 * came from and by the record that required it, so two attempts of one request
 * in two worktrees preserve TWO files rather than flattening onto one name.
 *
 * An existing archive whose digest already matches is reused — a repeated run
 * neither duplicates nor destroys prior evidence — and one whose digest differs
 * is a KEEP, never an overwrite: the two are different bytes and this verb has
 * no way to know which of them somebody still needs.
 */
function preserve({ checkout, path, owner, repoName, files }) {
  const dir = join(checkout, ARCHIVE_DIR, `${owner}-${repoName}`, `${basename(path)}-${gitBlobSha(path).slice(0, 12)}`);
  const notes = [];
  const kept = [];

  for (const entry of files) {
    let bytes;
    try {
      bytes = readFileSync(entry.source);
    } catch (error) {
      return { keep: { reason: `the required artifact ${entry.source} cannot be read: ${String(error.message ?? error)}`, repair: `cat ${shq(entry.source)}   # then re-run` } };
    }
    const sha = digestOf(bytes);
    const destination = join(dir, entry.request, basename(entry.source));
    if (existsSync(destination)) {
      let already;
      try {
        already = digestOf(readFileSync(destination));
      } catch (error) {
        return { keep: { reason: `the existing archive ${destination} cannot be read: ${String(error.message ?? error)}`, repair: `cat ${shq(destination)}   # then re-run` } };
      }
      if (already !== sha) {
        return {
          keep: {
            reason: `the archive ${destination} and its source ${entry.source} differ (${already.slice(0, 12)} vs ${sha.slice(0, 12)}), and a preserved artifact is never overwritten`,
            repair: `diff ${shq(destination)} ${shq(entry.source)}   # keep both by hand, then re-run`,
          },
        };
      }
      notes.push(`evidence: ${destination} already preserves this artifact byte for byte`);
      kept.push({ source: entry.source, archive: destination, sha256: sha, bytes: bytes.length, request: entry.request });
      continue;
    }
    try {
      mkdirSync(join(dir, entry.request), { recursive: true });
      writeFileSync(destination, bytes);
    } catch (error) {
      return { keep: { reason: `the required artifact ${entry.source} could not be copied to ${destination}: ${String(error.message ?? error)}`, repair: `mkdir -p ${shq(join(dir, entry.request))}   # then re-run` } };
    }
    // Verified from the FILE, not from the write: a copy nobody read back is a
    // copy nobody has proven.
    let readBack;
    try {
      readBack = digestOf(readFileSync(destination));
    } catch (error) {
      return { keep: { reason: `the copy at ${destination} cannot be read back: ${String(error.message ?? error)}`, repair: `cat ${shq(destination)}   # then re-run` } };
    }
    if (readBack !== sha) {
      return {
        keep: {
          reason: `the copy at ${destination} does not match its source digest (${readBack.slice(0, 12)} vs ${sha.slice(0, 12)}), so this artifact is not preserved`,
          repair: `diff ${shq(destination)} ${shq(entry.source)}   # then re-run`,
        },
      };
    }
    notes.push(`evidence: ${entry.source} preserved at ${destination} (sha256 ${sha.slice(0, 12)}, ${bytes.length} bytes)`);
    kept.push({ source: entry.source, archive: destination, sha256: sha, bytes: bytes.length, request: entry.request });
  }

  // THE REFERENCE IS THE INDEX OF EVERYTHING PRESERVED, so an unreadable one is
  // a KEEP and never a reset. It used to be caught and replaced with
  // `{ files: [] }`: a half-written or hand-damaged file then lost the
  // source→archive mapping of every EARLIER run — the one record that says
  // where a deleted worktree's Report went. Absent and malformed are different
  // facts and route differently (F-028), and the malformed one keeps its bytes.
  const reference = join(dir, 'reference.json');
  let existing = { files: [] };
  if (existsSync(reference)) {
    let raw;
    try {
      raw = readFileSync(reference, 'utf8');
    } catch (error) {
      return {
        keep: {
          reason: `the archive reference ${reference} exists and cannot be read (${String(error.message ?? error)}), so the mappings it holds for earlier runs cannot be preserved`,
          repair: `cat ${shq(reference)}   # recover or move it aside, then re-run`,
        },
      };
    }
    try {
      existing = JSON.parse(raw);
    } catch (error) {
      return {
        keep: {
          reason: `the archive reference ${reference} is not readable JSON (${String(error.message ?? error)}) — an interrupted write, and rewriting it would destroy the source→archive mappings of every earlier run`,
          repair: `cat ${shq(reference)}   # recover the mappings or move the file aside, then re-run`,
        },
      };
    }
    if (existing === null || typeof existing !== 'object' || !Array.isArray(existing.files)) {
      return {
        keep: {
          reason: `the archive reference ${reference} parses but names no files list, so what it recorded for earlier runs cannot be established`,
          repair: `cat ${shq(reference)}   # recover the mappings or move the file aside, then re-run`,
        },
      };
    }
  }
  const merged = new Map(existing.files.map(row => [String((row ?? {}).archive ?? ''), row]));
  for (const row of kept) merged.set(row.archive, row);
  const payload = { worktree: path, repository: `${owner}/${repoName}`, files: [...merged.values()] };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  // ATOMIC, then READ BACK. A crash mid-write is what produced the damaged file
  // above, and a rename is the only way this index is never observed partial.
  const temporary = `${reference}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, body);
    renameSync(temporary, reference);
  } catch (error) {
    return { keep: { reason: `the archive reference ${reference} could not be written: ${String(error.message ?? error)}`, repair: `mkdir -p ${shq(dir)}   # then re-run` } };
  }
  if (readFileSync(reference, 'utf8') !== body) {
    return {
      keep: {
        reason: `the archive reference ${reference} does not read back as it was written, so the index of what survives this worktree is unverified`,
        repair: `cat ${shq(reference)}   # then re-run`,
      },
    };
  }
  notes.push(`evidence: the source→archive reference is ${reference}`);
  return { notes, receipt: payload };
}

/** The declaration, read through the two supported interfaces that answer it. */
function resolveStage({ run, checkout }) {
  const show = run(['repo', 'show', '--repo', `path:${checkout}`, '--json']);
  const receipt = show.receipt ?? {};
  const repo = (receipt.result ?? {}).repo ?? null;
  if (receipt.ok !== true || repo === null || typeof repo !== 'object') {
    const detail = (receipt.error ?? {}).message ?? receipt.unparseable ?? firstLine(show.stderr) ?? '';
    return { unknown: `orca repo show could not answer this repository's hook settings: ${String(detail).slice(0, 200) || `exit ${show.status}`}` };
  }
  const hookSettings = 'hookSettings' in repo ? (repo.hookSettings ?? null) : null;

  const yamlPath = join(checkout, 'orca.yaml');
  let yaml = null;
  if (existsSync(yamlPath)) {
    try {
      yaml = readFileSync(yamlPath, 'utf8');
    } catch (error) {
      return { unknown: `${yamlPath} exists and cannot be read: ${String(error.message ?? error)}` };
    }
  }
  return cleanupStage({ yaml, hookSettings });
}
