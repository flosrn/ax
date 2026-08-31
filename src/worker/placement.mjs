// Placement: a ticket's worktree on THIS host — reuse, the repo's own tool, or
// Orca — then provisioning through `ax worktree setup`, then proof that the
// selector a dispatch will use actually resolves. Extracted from dispatch.mjs so
// the placement rules answer through their own interface instead of only
// through the whole dispatch pipeline; every machine answer (`exec`, `run`,
// `setupFn`, `now`, `sleep`) stays injected, so the tests need no Orca.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
export function placeLocal({ request, issue, slug, named, paths, dispatchConfig, ticket, exec, run, cwd, dry, probe, setupFn }) {
  const notes = [];
  const base = join(paths.root, '.worktrees');
  // What this placement is FOR, in one word, for every line below. `issue` is ''
  // on a named dispatch, and a message naming nothing sends an operator grepping
  // for a tree that was reported without a name.
  const subject = named ? request : issue;

  // Idempotence first, and it is the only countermeasure available: `worktree
  // create` carries no `--retry-request` (PORT invariant 2), so a create that
  // strands cannot be replayed and the claim is bounded to THIS host. A second
  // dispatch for the same ticket finds the first tree — and still proves it
  // habitable below, because the dispatch that made it may be exactly the one that
  // died before provisioning it.
  const existing = existingFor(base, subject, { exact: named });
  let created = false;

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

  let worktree = existing;
  if (existing !== '') {
    notes.push(`reusing the worktree that already exists for ${subject}, and placing no second one: ${existing}`);
  } else if (tool !== '') {
    // The declared tool BLOCKS until the tree is usable and prints the path on
    // its last stdout line; everything else it says is progress on stderr.
    const out = exec(tool, [subject, ...(named || slug === '' ? [] : [slug])], cwd);
    if (out.error) return { notes, cannot: `${tool} could not run: ${String(out.error.message ?? out.error)}` };
    if (out.status !== 0) {
      return { notes, refused: `${tool} failed for ${subject}; nothing was dispatched`, repair: firstLine(out.stderr) || `${tool} ${subject}` };
    }
    worktree = lastLine(out.stdout);
    if (worktree === '' || !existsSync(worktree)) {
      return { notes, cannot: `${tool} printed ${JSON.stringify(worktree)}, which is not a directory` };
    }
    created = true;
  } else {
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
  // the tree, which is also what a second dispatch will reuse.
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
      repair: `cd ${worktree} && ax worktree setup   # then re-run this dispatch; it reuses that tree`,
    };
  }
  if (!existsSync(join(worktree, CONTEXT_PATH))) {
    return {
      notes,
      cannot: `${worktree} has no ${CONTEXT_PATH}, so the child would have no URL to test against`,
      repair: `cd ${worktree} && ax worktree setup   # then re-run this dispatch; it reuses that tree`,
    };
  }
  notes.push(`provisioned: ${join(worktree, CONTEXT_PATH)} describes this worktree's own port and database`);
  return { worktree, notes };
}

/**
 * The worktree this ticket already has, or ''.
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
 */
function existingFor(base, subject, { exact = false } = {}) {
  let entries;
  try {
    entries = readdirNames(base);
  } catch {
    return '';
  }
  const wanted = String(subject).toLowerCase();
  const hit = entries
    .filter(name => {
      const lower = name.toLowerCase();
      if (exact) return lower === wanted;
      return lower === wanted || lower.startsWith(`${wanted}-`) || lower.startsWith(`${wanted}_`);
    })
    .sort();
  return hit.length === 0 ? '' : join(base, hit[0]);
}

const readdirNames = base =>
  readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

/** Poll the selector a dispatch will use, on evidence, against a deadline. */
export function untilSeen({ run, worktree, deadline, now, sleep, tickMs }) {
  for (;;) {
    const out = run(['worktree', 'show', '--worktree', `path:${worktree}`, '--json']);
    if (out.status === 0 && out.receipt?.ok === true) return true;
    if (now() >= deadline) return false;
    sleep(tickMs);
  }
}
