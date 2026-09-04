// Placement: a ticket's worktree on THIS host — reuse, the repo's own tool, or
// Orca — then provisioning through `ax worktree setup`, then proof that the
// selector a dispatch will use actually resolves. Extracted from dispatch.mjs so
// the placement rules answer through their own interface instead of only
// through the whole dispatch pipeline; every machine answer (`exec`, `run`,
// `setupFn`, `now`, `sleep`, and now the worktree list and the runtime's own
// root) stays injected, so the tests need no Orca and no git.
//
// REUSE IS NOT SCOPED TO ONE DIRECTORY, and the version that was cost #84.
// The scan read `<root>/.worktrees` and nothing else, while this repository
// declares no `dispatch.worktreeTool` — so placement falls through to Orca,
// which places into ITS OWN workspaces root, a directory the scan never read.
// The stated idempotence below was therefore inert on the only placement path
// this repository uses: a dispatch that placed a tree and then failed
// `ax worktree setup` exited 3 with nothing recorded and the tree left on disk
// (correctly — the refusal precedes the mutation), and the retry asked for a
// second tree. Orca disambiguates a taken name by suffix, so the retry got
// `<request>-2` while the record kept the unsuffixed request id, and one ticket
// owned two worktrees and two branches whose names no human could map back.
//
// So the question "does this subject already have a tree" is grounded in the
// worktrees GIT has registered — every one of them, by absolute path, whatever
// root it lives under — and narrowed by where ax is allowed to lend from: a
// PLACEMENT ROOT, being `<root>/.worktrees` or the workspaces root the runtime
// reports for this repo. Both conditions, never either alone; a hand-made
// `~/scratch/71-help-is-a-read` matches the name and is nobody's dispatch.
// Reading git's whole registry also makes duplicate basenames across two roots
// reachable for the first time, which is why more than one candidate is a
// cannot-establish naming all of them rather than a pick by position.
//
// A PATH AN EXTERNAL TOOL PRINTS IS NOT ABSOLUTE UNTIL SOMETHING RESOLVES IT,
// and `existsSync` is not that something: it answers true for `.worktrees/<name>`
// whenever the dispatch runs from the repository. So `dispatch.worktreeTool`'s
// answer is resolved against the cwd it ran in, here, where it is accepted —
// no consumer downstream has to know it might have been relative (review of
// PR #141: a relative answer reached the Orca selector and the Report path).

import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { readWorktrees } from '../git.mjs';
import { physical, withinPath } from '../worktree/locate.mjs';
import { CONTEXT_PATH } from '../worktree/context.mjs';

const firstLine = text => String(text ?? '').split('\n')[0].trim();
/** A declared placement tool prints its path LAST; everything else it says is progress. */
const lastLine = text =>
  String(text ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .pop() ?? '';

/**
 * Which setup argv this ticket's labels earn.
 *
 * The worktree's database is decided by `planWorktree` from the DIFF of the tree
 * setup is provisioning, and that tree is empty: nothing has been written yet,
 * so `touchesDatabase` is false and the plan shares the primary checkout's
 * stack. That is right for most work and wrong for exactly the tickets that say
 * so in their labels — measured 2026-08-25 on ofmchat #71 (`domain:database`,
 * `domain:security`), whose brief required an isolated reset and a full pgTAP
 * run, and whose worktree was announced as "does not touch the database". The
 * guard in front of `ax supabase` promotes on the first write, so the child was
 * not going to destroy the shared stack THROUGH ax — but every path around it
 * (a raw `supabase` on PATH, a package script) resets the containers the primary
 * checkout and every other sharing worktree depend on, because a shared
 * worktree's `config.toml` is byte-identical to the primary's.
 *
 * The labels that mean "database" are the project's to declare
 * (`dispatch.databaseLabels`): a label vocabulary measured for one fleet and
 * inherited by a repo that never declared it is this file's own named mistake.
 */
export function databaseArgs(dispatchConfig, ticket) {
  const declared = Array.isArray(dispatchConfig.databaseLabels) ? dispatchConfig.databaseLabels : [];
  if (declared.length === 0 || ticket === null) return { argv: [], notes: [] };
  const carried = Array.isArray(ticket.labels) ? ticket.labels : [];
  const matched = declared.filter(label => carried.includes(label));
  if (matched.length === 0) return { argv: [], notes: [] };
  return {
    argv: ['--database'],
    notes: [`${matched.join(', ')} — this ticket says it touches the database, so its worktree gets its own stack instead of sharing the primary checkout's`],
  };
}

/** Place the worktree on THIS host: reuse, the repo's own tool, or Orca. */
export function placeLocal({ request, issue, slug, named, paths, dispatchConfig, ticket, exec, run, cwd, dry, probe, setupFn, trees }) {
  const notes = [];
  const base = join(paths.root, '.worktrees');
  // What this placement is FOR, in one word, for every line below. `issue` is ''
  // on a named dispatch, and a message naming nothing sends an operator grepping
  // for a tree that was reported without a name.
  const subject = named ? request : issue;

  const tool = dispatchConfig.worktreeTool ?? '';
  if (dry) {
    // A prediction, and it is labelled as one: the placement is the step a dry
    // run cannot perform, so the preview shows the selector it WOULD carry
    // rather than an empty passthrough that reads like a bug.
    const predicted = join(base, named ? request : `${issue}-${slug || 'work'}`);
    notes.push(
      tool === ''
        ? `dry-run: this project declares no worktree tool, so Orca would place it (worktree create --setup run) and ax worktree setup would provision it, predicted at ${predicted}`
        : `dry-run: would place it with \`${tool} ${[subject, ...(named || slug === '' ? [] : [slug])].join(' ')}\`, predicted at ${predicted}`,
    );
    return { worktree: '', predicted, notes };
  }

  // Idempotence first, and it is the only countermeasure available: `worktree
  // create` carries no `--retry-request` (PORT invariant 2), so a create that
  // strands cannot be replayed and the claim is bounded to THIS host. A second
  // dispatch for the same ticket finds the first tree — and still proves it
  // habitable below, because the dispatch that made it may be exactly the one that
  // died before provisioning it.
  const placement = placementRoots({ root: paths.root, main: paths.main, run });
  // Injected as a LIST by the tests, read from git otherwise — and the read
  // carries whether it answered at all: an unreadable registry is unknown, and
  // unknown must not authorise the create below (F-028).
  const registry = trees === undefined ? readWorktrees(paths.main ?? paths.root ?? cwd) : { known: true, trees };
  const candidates = existingFor(registry.trees, {
    roots: placement.roots,
    placed: placement.placed,
    never: placement.never,
    subject,
    exact: named,
  });
  // More than one lendable tree is an inability, never a pick: git's registry
  // spans both placement roots, so two trees CAN answer one subject — the
  // reporter's own host carries `71-help-is-a-read` and `71-help-is-a-read-2`
  // side by side — and choosing by position is how a child is dispatched into a
  // branch that is not its own. The shape is `locateWorktree`'s, for the same
  // reason it refuses there.
  if (candidates.length > 1) {
    return {
      notes,
      cannot: `${subject} has ${candidates.length} worktrees ax may lend on this host, so which one this dispatch means cannot be established: ${candidates.join(', ')}`,
      repair: `ax worker dispatch --worktree ${candidates[0]} …   # the one you mean, by path`,
    };
  }

  let worktree = candidates[0] ?? '';
  let created = false;
  if (worktree !== '') {
    notes.push(`reusing the worktree that already exists for ${subject}, and placing no second one: ${worktree}`);
  } else if (tool !== '') {
    // The declared tool BLOCKS until the tree is usable and prints the path on
    // its last stdout line; everything else it says is progress on stderr.
    const out = exec(tool, [subject, ...(named || slug === '' ? [] : [slug])], cwd);
    if (out.error) return { notes, cannot: `${tool} could not run: ${String(out.error.message ?? out.error)}` };
    if (out.status !== 0) {
      return { notes, refused: `${tool} failed for ${subject}; nothing was dispatched`, repair: firstLine(out.stderr) || `${tool} ${subject}` };
    }
    // RESOLVED WHERE IT IS ACCEPTED, once. The schema asks the tool to print
    // "the path" and never demands an absolute one, and `existsSync` answers
    // true for `.worktrees/<name>` whenever the dispatch runs from the
    // repository — so a relative answer used to travel intact to every consumer
    // that cannot resolve it: `--worktree path:.worktrees/…` for a runtime that
    // resolves selectors against its own cwd, and a Report path that cannot be
    // established while the placement succeeded (review of PR #141, P2). The
    // tool ran in `cwd`, so that is what its relative path is relative to.
    const printed = lastLine(out.stdout);
    worktree = printed === '' || isAbsolute(printed) ? printed : resolve(cwd, printed);
    if (worktree === '' || !existsSync(worktree)) {
      return { notes, cannot: `${tool} printed ${JSON.stringify(printed)}, which is not a directory` };
    }
    created = true;
  } else {
    // F-028, and the mutation it guards is the one this file exists to bound: an
    // unreadable list is UNKNOWN, not "this subject has no tree". Answering it
    // as empty is exactly what places a second worktree beside the first, and
    // BOTH reads can fail to answer — git's registry names the candidates, the
    // runtime says which of them ax may lend, and neither one alone decides.
    if (!registry.known) {
      return {
        notes,
        cannot: `git worktree list cannot say which worktrees this repository has, so whether ${subject} already has one is unknown — and placing a second one is what mints ${request}-2`,
        repair: `git -C ${paths.main ?? paths.root} worktree list --porcelain   # then re-run this dispatch`,
      };
    }
    if (!placement.known) {
      return {
        notes,
        cannot: `orca worktree list cannot say which worktrees this repository has (${placement.detail}), so whether ${subject} already has one is unknown — and placing a second one is what mints ${request}-2`,
        repair: `orca worktree list --repo path:${paths.main ?? paths.root} --json   # then re-run this dispatch`,
      };
    }
    const receipt = run(['worktree', 'create', '--name', request, '--no-parent', '--setup', 'run', '--json']);
    if (receipt.status !== 0 || receipt.receipt?.ok !== true) {
      const detail = receipt.receipt?.unparseable ?? firstLine(receipt.stderr) ?? '';
      return { notes, refused: `orca worktree create failed for ${request}; nothing was dispatched`, repair: String(detail).slice(0, 200) };
    }
    worktree = String(receipt.receipt.result?.worktree?.path ?? '');
    if (worktree === '') return { notes, cannot: 'the worktree receipt names no path, so there is nowhere to dispatch into' };
    if (!existsSync(worktree)) return { notes, cannot: `the receipt names ${JSON.stringify(worktree)}, which is not a directory on this host` };
    created = true;
    notes.push(`orca placed the worktree and its setup hook is running: ${worktree}`);
  }

  // Provisioning is `ax worktree setup`'s job, and asking it here is what
  // replaced this verb's own copy of it. A `--probe` session is throwaway and
  // says so; every other dispatch refuses a tree with no agent context file,
  // because a child with no URL to test against is what --setup skip produced.
  if (probe) {
    notes.push('--probe: no provisioning and no habitability proof — never for real work');
    return { worktree, notes };
  }

  // Once a tree EXISTS, a provisioning failure is no longer "nothing was
  // created": exit 1 promises that, so these answer cannot-establish and name
  // the tree, which is also what a second dispatch will reuse. NOTHING IS
  // REMOVED here — that was ruled on #84, where the report proposed reaping
  // what the refusal had just placed. Both routes the tree supports are named
  // instead: provision it where it stands, or point the retry straight at it.
  //
  // `cwd` is the whole contract with setup: it never chdirs, and it passes that
  // path down to every probe that answers per directory (the proxy route in
  // particular). This call used to add `env: { …env, PWD: worktree }`, which
  // `setup` does not read and which `child_process` ignores anyway — a
  // directory override that overrode nothing.
  const database = databaseArgs(dispatchConfig, ticket);
  notes.push(...database.notes);
  const setupCode = setupFn(database.argv, { cwd: worktree });
  if (setupCode !== 0) {
    return {
      notes,
      cannot: `ax worktree setup did not finish in ${worktree}${created ? ' (which this dispatch just created)' : ''}, so the child would start in a tree nobody prepared`,
      repair: retryRoutes(worktree),
    };
  }
  if (!existsSync(join(worktree, CONTEXT_PATH))) {
    return {
      notes,
      cannot: `${worktree} has no ${CONTEXT_PATH}, so the child would have no URL to test against`,
      repair: retryRoutes(worktree),
    };
  }
  notes.push(`provisioned: ${join(worktree, CONTEXT_PATH)} describes this worktree's own port and database`);
  return { worktree, notes };
}

/**
 * The two routes an existing-but-unprovisioned tree supports, on one line.
 *
 * `--worktree <abs>` was supported and undocumented: the refusal named only the
 * provision-in-place route, so an operator holding a tree ax had already placed
 * had no way to know a retry could be pointed straight at it.
 */
const retryRoutes = worktree =>
  `cd ${worktree} && ax worktree setup   # then re-run this dispatch; it reuses that tree — or ax worker dispatch --worktree ${worktree} … to point this retry at it`;

/**
 * Where ax may lend a worktree from, and the trees it may never lend whatever
 * their name.
 *
 * TWO PLACEMENT ROOTS, ASKED TWO DIFFERENT WAYS, because they are two different
 * kinds of claim. `<root>/.worktrees` is this package's OWN layout, so it is a
 * containing directory: anything git registered inside it was placed by ax's
 * own worktree verbs. The runtime's root is not ours to name — a
 * `~/orca/workspaces` hardcoded here is wrong on the next host and silently
 * wrong on this one after a settings change — so the runtime is asked, through
 * the `run` this file already injects, and its answer is taken as the tree
 * paths it gives: `placed`, matched EXACTLY.
 *
 * Exactly, and not by parent directory, which was the first version of this and
 * was too generous by a whole directory. A runtime may manage a tree outside its
 * workspaces root — a folder it adopted, an import — and promoting that tree's
 * parent to a placement root makes every registered worktree beside it lendable:
 * one adopted `/tmp/gap-35-work` would have made `/tmp` a place ax lends from.
 * The row IS the evidence; the directory it sits in proves nothing.
 *
 * The answer also carries which tree is the primary checkout, and that one is
 * never lendable: a `--name` equal to the checkout directory's own basename
 * would otherwise dispatch a child into `main`.
 *
 * `known: false` is the honest answer to an unreadable receipt, and the caller
 * must treat it as unknown rather than as "no trees" (F-028).
 */
export function placementRoots({ root, main, run }) {
  const roots = [physical(join(root, '.worktrees'))];
  // The checkout ax was invoked from is NOT excluded: the refusal above tells an
  // operator to `cd` into the stranded tree and re-run the dispatch, so the tree
  // the caller is standing in has to stay lendable to itself.
  const never = main ? [physical(main)] : [];
  const placed = new Set();

  const out = run(['worktree', 'list', '--repo', `path:${main || root}`, '--json']);
  const receipt = out.receipt ?? {};
  const rows = receipt.result?.worktrees;
  if (out.status !== 0 || receipt.ok !== true || !Array.isArray(rows)) {
    const detail = String(receipt.unparseable ?? receipt.error?.code ?? out.stderr ?? '').replace(/\s+/g, ' ').trim();
    return { roots, placed, never, known: false, detail: detail === '' ? 'no receipt' : detail };
  }
  for (const row of rows) {
    const path = String(row?.path ?? '');
    if (path === '') continue;
    if (row?.isMainWorktree === true) never.push(physical(path));
    else placed.add(physical(path));
  }
  return { roots: [...new Set(roots)], placed, never: [...new Set(never)], known: true, detail: '' };
}

/**
 * Every worktree this subject may be lent, sorted — none, one, or an ambiguity
 * the caller refuses.
 *
 * With a ticket the match is the request's OWN name plus the ticket segment
 * followed by a separator: `GAP-35` inside `gap-357-…` is a different ticket, and
 * reusing another ticket's tree dispatches a child into a branch that is not its
 * own, while a differently-slugged earlier dispatch of the SAME ticket is the tree
 * this dispatch must reuse.
 *
 * `exact` turns that prefix rule off, and `--name` needs it off. A name is not a
 * ticket segment with slugs hanging from it — it is the whole identity, so the
 * prefix rule would make `--name auth` reuse the tree of `auth-refactor`: a
 * different piece of work, already provisioned, already someone's.
 *
 * The rule is unchanged; its INPUT is what #84 widened, from the entries of one
 * directory to the absolute paths git has registered, narrowed to what
 * placement may lend: a tree inside `<root>/.worktrees`, or one the runtime
 * names as its own. Registration is the floor: an unregistered directory
 * sitting in a placement root is not a worktree, and lending it would send a
 * child into a tree the runtime resolves no selector for.
 */
function existingFor(trees, { roots, placed, never, subject, exact = false }) {
  const wanted = String(subject).toLowerCase();
  const blocked = new Set(never);
  const lendable = new Set();
  for (const tree of trees) {
    const declared = String(tree?.path ?? '');
    if (declared === '' || tree?.bare === true) continue;
    const path = physical(declared);
    if (blocked.has(path)) continue;
    if (!placed.has(path) && !roots.some(base => withinPath(path, base))) continue;
    const name = basename(path).toLowerCase();
    const matches = exact ? name === wanted : name === wanted || name.startsWith(`${wanted}-`) || name.startsWith(`${wanted}_`);
    if (matches) lendable.add(path);
  }
  return [...lendable].sort();
}

/** Poll the selector a dispatch will use, on evidence, against a deadline. */
export function untilSeen({ run, worktree, deadline, now, sleep, tickMs }) {
  for (;;) {
    const out = run(['worktree', 'show', '--worktree', `path:${worktree}`, '--json']);
    if (out.status === 0 && out.receipt?.ok === true) return true;
    if (now() >= deadline) return false;
    sleep(tickMs);
  }
}
