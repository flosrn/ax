// `ax worktree panes <name> [--close <handle>…]` — the panes that keep a
// worktree from being reclaimed, and closing the ones the operator names.
//
// WHY THIS EXISTS. `ax worktree reclaim` KEEPs a tree while any pane is still
// in it (term 4 of its conjunction, ./reclaim.mjs), and nothing in a pane list
// attributes a pane to whoever opened it (#233): Orca's placement shell and its
// `Setup` hook pane read exactly like a human's shell. So the KEEP printed raw
// `orca terminal …` commands, one per pane, and an agent that had created the
// worktree itself had no ax verb to finish the job — it stopped and asked.
// This verb is that job: it shows what holds the tree and closes exactly what
// the operator names, whoever created the worktree.
//
// THE OPERATOR'S WORD, BY HANDLE, NEVER A SWEEP. `--close` takes the handles
// to close and refuses without one. A bulk close would sweep whatever is open
// at the moment it runs — including a shell somebody opened after the listing
// was read — which is the reason reclaim never printed `--all`. Every named
// handle must be one of THIS worktree's panes in the list read now; one that is
// not refuses the whole call before anything is closed.
//
// THE PANE READER IS SHARED with reclaim (`worktreePanes`), with its coverage
// rule: an unreadable, truncated or host-omitting list is never "nobody is
// there" (F-028), so it closes nothing. A close is proven by the pane's
// absence from a fresh list, never by Orca's acknowledgement alone.
//
// Exit codes (ADR 0003 — per verb):
//   0  listed; or every named pane closed and proven absent
//   1  refused: the primary checkout, a handle not in this worktree, or a close
//      asked from inside the worktree it would close
//   2  usage error
//   3  cannot establish: no git repository, no Orca CLI, a silent runtime, an
//      unreadable worktree or pane list, a refused close or a pane still listed

import { resolve as resolvePath } from 'node:path';

import { repoPaths } from '../config.mjs';
import { defaultExec } from '../exec.mjs';
import { readWorktrees } from '../git.mjs';
import { bad, fix, note, ok, section } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { terminalInventory } from '../worker/pane.mjs';
import { locateWorktree, physical, withinPath } from './locate.mjs';

const USAGE = 'ax worktree panes <name-or-path> [--close <handle>...]';

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shq = value => {
  const text = String(value);
  return SHELL_SAFE.test(text) && text !== '' ? text : `'${text.replaceAll("'", `'\\''`)}'`;
};

/**
 * The Orca row for the worktree at `path`: `{ worktree }`, or `{ unread }`
 * carrying the reason and the read that would answer it.
 */
export function showWorktree(run, path) {
  const show = run(['worktree', 'show', '--worktree', `path:${path}`, '--json']);
  const receipt = show.receipt ?? {};
  const worktree = (receipt.result ?? {}).worktree ?? null;
  if (receipt.ok === true && worktree !== null && typeof worktree === 'object') return { worktree };
  const detail = (receipt.error ?? {}).message ?? receipt.unparseable ?? String(show.stderr ?? '').split('\n')[0].trim() ?? '';
  return {
    unread: {
      reason: `orca worktree show could not answer for ${path}: ${String(detail).slice(0, 200) || `exit ${show.status}`}`,
      repair: `orca worktree show --worktree path:${shq(path)} --json   # then re-run`,
    },
  };
}

/**
 * Every live pane of `worktree` (its Orca row), read through the shared
 * inventory and judged covered for the worktree's OWN host only: an unrelated
 * sleeping runtime must not make a local tree unreadable (#83), and an omitted
 * owner is never an empty one. `{ host, panes }`, or `{ unread }`.
 */
export function worktreePanes({ run, worktree, path }) {
  const inventory = terminalInventory(run);
  if (!inventory.ok) {
    return { unread: { reason: `${inventory.reason} — an absent or partial pane list cannot prove nobody is still in ${path}`, repair: 'orca terminal list --json   # then re-run' } };
  }
  const host = String(worktree.hostId ?? (worktree.identity ?? {}).executionHostId ?? '');
  if (host === '') {
    return {
      unread: {
        reason: `the Orca receipt for ${path} names no execution host, so which runtime had to be asked about its panes is unread`,
        repair: `orca worktree show --worktree path:${shq(path)} --json   # establish hostId, then re-run`,
      },
    };
  }
  const covered = Array.isArray(inventory.hosts) && inventory.hosts.includes(host);
  if (!covered) {
    const omitted = Array.isArray(inventory.omittedHosts) ? inventory.omittedHosts : [];
    return {
      unread: {
        reason: `${path} is owned by execution host '${host}', which this pane list did not read (it covered ${(inventory.hosts ?? []).join(', ') || 'nothing it named'}${omitted.length > 0 ? `, omitting ${omitted.slice(0, 5).join(', ')}` : ''}) — an unqueried host is not an empty one`,
        repair: `orca terminal list --environment ${shq(host)} --json   # ask the host that owns it, then re-run`,
      },
    };
  }
  const mine = pane =>
    (typeof pane.worktreeId === 'string' && worktree.id !== undefined && pane.worktreeId === worktree.id) ||
    (typeof pane.worktreePath === 'string' && physical(pane.worktreePath) === physical(path));
  const panes = [...inventory.byHandle.values()].filter(pane => pane !== null && typeof pane === 'object' && mine(pane) && pane.orphaned !== true);
  return { host, panes };
}

/**
 * One pane as the three signals a list carries: its title (a hook names its
 * pane), whether an agent runs there, and when it last said anything. Not
 * evidence of who opened it — nothing in the list is (#233).
 */
export function describePane(pane) {
  const title = typeof pane.title === 'string' && pane.title.trim() !== '' ? `"${pane.title.trim()}"` : 'untitled';
  const agent = typeof pane.agentIdentity === 'string' && pane.agentIdentity !== '' ? pane.agentIdentity : 'no agent';
  const spoke = typeof pane.lastOutputAt === 'string' && pane.lastOutputAt !== '' ? pane.lastOutputAt : 'never observed';
  return `${pane.handle} ${title} · ${agent} · last output ${spoke}`;
}

export function panes(argv = [], { cwd = process.cwd(), env = process.env, platform = process.platform, resolve: resolveBin = resolveOrca, runner, exec = defaultExec, worktrees = readWorktrees } = {}) {
  const usage = message => (bad(message), fix(USAGE), 2);
  const refuse = (reason, repair) => (bad(`REFUSED — ${reason}`), fix(repair), 1);
  const cannot = (reason, repair) => (bad(`CANNOT ESTABLISH — ${reason}`), fix(repair), 3);

  const closeAt = argv.indexOf('--close');
  const head = closeAt === -1 ? argv : argv.slice(0, closeAt);
  const handles = closeAt === -1 ? [] : argv.slice(closeAt + 1);
  const unknown = [...head, ...handles].filter(arg => arg.startsWith('-'));
  if (unknown.length > 0) return usage(`unknown flag ${unknown[0]}`);
  if (head.length === 0) return usage('which worktree? this verb takes one exact target');
  if (head.length > 1) return usage(`one target, not ${head.length} (${head.join(', ')})`);
  if (closeAt !== -1 && handles.length === 0) {
    return usage('--close names the handles to close — never a sweep of whatever is open when it runs');
  }
  const target = head[0];

  const { root, main } = repoPaths(cwd);
  if (root === null) return cannot('this is not inside a git repository, so no worktree of it can be named', `cd <checkout> && ${USAGE}`);
  const checkout = main ?? root;
  const registry = worktrees(checkout);
  if (!registry.known) return cannot('git cannot enumerate this repository’s worktrees', `git -C ${shq(checkout)} worktree list --porcelain`);
  const located = locateWorktree(target, { cwd, root, main, trees: registry.trees });
  if (located.error !== undefined) return refuse(located.error, 'ax worktree ls   # every checkout this repository registers');
  const path = located.path;
  if (physical(path) === physical(checkout)) return refuse(`${path} is the primary checkout — its panes are not a worktree's leftovers`, 'ax worktree ls   # name one of the linked checkouts instead');
  if (handles.length > 0 && withinPath(physical(resolvePath(cwd)), physical(path))) {
    return refuse(`you are standing in ${path}, so the pane running this command is one of the panes it would close`, `cd ${shq(checkout)} && ax worktree panes ${shq(target)} --close ${handles.map(shq).join(' ')}`);
  }

  const bin = resolveBin({ env, platform });
  if (bin === null) return cannot('this machine resolves no Orca CLI, and panes are Orca’s to list', 'orca open   # then re-run');
  const run = runner ?? createRunner({ bin, exec });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # then re-run');

  const shown = showWorktree(run, path);
  if (shown.unread) return cannot(shown.unread.reason, shown.unread.repair);
  const read = () => worktreePanes({ run, worktree: shown.worktree, path });
  const before = read();
  if (before.unread) return cannot(before.unread.reason, before.unread.repair);

  section(`panes ${path}`);
  if (handles.length === 0) {
    if (before.panes.length === 0) {
      ok('no pane holds this worktree');
      fix(`ax worktree reclaim ${shq(target)}`);
      return 0;
    }
    for (const pane of before.panes) note(describePane(pane));
    ok(`${before.panes.length} pane(s) hold this worktree — close the ones you own, by handle`);
    fix(`ax worktree panes ${shq(target)} --close ${before.panes.map(pane => shq(pane.handle)).join(' ')}`);
    return 0;
  }

  const listed = new Set(before.panes.map(pane => pane.handle));
  const foreign = handles.filter(handle => !listed.has(handle));
  if (foreign.length > 0) {
    return refuse(
      `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not a pane of ${path} in the list just read — nothing was closed`,
      `ax worktree panes ${shq(target)}   # the handles this worktree holds now`,
    );
  }

  const environment = before.host === 'local' ? [] : ['--environment', before.host];
  const refused = [];
  for (const handle of handles) {
    const closed = run(['terminal', 'close', '--terminal', handle, ...environment, '--json']);
    const receipt = closed.receipt ?? {};
    if (closed.status !== 0 || receipt.ok !== true) {
      const detail = (receipt.error ?? {}).message ?? String(closed.stderr ?? '').split('\n')[0].trim();
      refused.push(`${handle}: ${detail || `exit ${closed.status}`}`);
    }
  }
  const after = read();
  if (after.unread) return cannot(`${after.unread.reason} — the closes were issued, and their effect is unread`, after.unread.repair);
  const still = handles.filter(handle => after.panes.some(pane => pane.handle === handle));
  for (const handle of handles.filter(handle => !still.includes(handle))) note(`${handle} closed — absent from a fresh pane list`);
  if (refused.length > 0 || still.length > 0) {
    const reasons = [...(refused.length > 0 ? [`Orca refused ${refused.join('; ')}`] : []), ...still.filter(h => !refused.some(r => r.startsWith(`${h}:`))).map(h => `${h} is still listed after its close`)];
    return cannot(reasons.join('; '), `ax worktree panes ${shq(target)}   # what still holds it`);
  }
  ok(`${handles.length} pane(s) closed`);
  fix(after.panes.length === 0 ? `ax worktree reclaim ${shq(target)}` : `ax worktree panes ${shq(target)}   # ${after.panes.length} pane(s) still hold it`);
  return 0;
}
