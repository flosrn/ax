/**
 * Session roles and their playbooks, resolved from THIS PACKAGE — never from
 * the host's discovery.
 *
 * WHY THIS REPLACED `pi.pi.discoverAgents`
 * The four session roles used to be OMP task-agent files in `~/.omp/agent/agents`,
 * found through the host's own agent loader. That reused a mechanism built for a
 * different thing, and the reuse cost three separate defects, all measured:
 *
 *   1. A role committed on a branch did not exist for any session until it landed
 *      in the main checkout — discovery reads `<cwd>/.omp/agents` and the user
 *      root, and a worktree checkout matches neither. So a trial dispatch before
 *      merge proved nothing (2026-08-07).
 *   2. Every one of these roles ALSO appeared in task-agent discovery, where it is
 *      not merely useless but wrong: `readiness` and `orchestrator` are operator
 *      session roles that dispatch top-level Orca children, and offering them as
 *      in-process `task` subagents invites a spawn that cannot do the job. Keeping
 *      them out needed `task.disabledAgents`, which suppresses a symptom the
 *      mechanism itself created.
 *   3. A shipped package cannot write to `~/.omp` at all, so discovery-backed
 *      roles are unshippable by construction.
 *
 * A role is a session's identity, not a subagent template. Owning the files is
 * what makes it one: they ship inside the package, they are versioned with the
 * code that applies them, and no host root can shadow or hide them.
 *
 * WHY THE PARSER IS SMALL ON PURPOSE
 * Only the fields the four roles actually use are read. A general YAML front
 * matter parser here would accept shapes nothing produces and nothing tests, and
 * every one of those shapes is a way for a role to be silently half-applied.
 * Unreadable, unknown and malformed are three different named refusals — the
 * caller locks the session on all three, but the operator gets told which.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RoleDefinition } from './role.ts';

/**
 * A role name that can only ever address one file in one directory.
 *
 * The name arrives from a `[omp role=…]` marker written by another session, so
 * it is untrusted input reaching a path join. `..`, `/`, a leading dot and an
 * absolute path are all rejected here rather than normalised — a normaliser
 * decides what a caller meant, and there is exactly one thing a role name may
 * mean.
 */
const SAFE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Where the role files live.
 *
 * `import.meta.url` and not `process.cwd()`: these files ship with the package,
 * and a session's cwd is its worktree. Deriving the directory from the module
 * means an installed copy under `node_modules` finds its own roles and a
 * checkout finds the checkout's.
 *
 * The env override exists for the same reason every other store in this bundle
 * has one — a test must be able to point the loader at a fixture without moving
 * the package, and an operator must be able to try a role file before it ships.
 */
export function rolesDir(env: Record<string, string | undefined> = process.env): string {
  const declared = env.AX_OMP_ROLES_DIR;
  if (declared !== undefined && declared !== '') return declared;
  return fileURLToPath(new URL('../roles', import.meta.url));
}

/**
 * Where the playbooks live — the bodies a role is handed before its first turn.
 *
 * A playbook is this package's own procedure, NOT an OMP skill. It is resolved
 * here and only here: the host's skill discovery reads roots the package does
 * not own, so a role's required procedure would otherwise depend on what happens
 * to be installed on the machine. A role whose playbook can go missing depending
 * on the host is a role whose authority boundary goes missing the same way.
 */
export function playbooksDir(env: Record<string, string | undefined> = process.env): string {
  const declared = env.AX_OMP_PLAYBOOKS_DIR;
  if (declared !== undefined && declared !== '') return declared;
  return fileURLToPath(new URL('../playbooks', import.meta.url));
}

/** What one front matter block yielded, for the four keys that are read. */
interface FrontMatter {
  name?: string;
  description?: string;
  autoloadSkills?: string[];
  tools?: string[];
}

/** Strip one layer of matching quotes, the only quoting these files use. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const head = trimmed[0];
    if ((head === '"' || head === "'") && trimmed.endsWith(head)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `[a, b]` or a bare scalar, both of which the role files use. */
function scalarOrInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter((entry) => entry !== '');
  }
  const single = unquote(trimmed);
  return single === '' ? [] : [single];
}

/**
 * Split a role file into its front matter and its body.
 *
 * A missing or unclosed fence is MALFORMED, not empty, and the caller says so:
 * a role file that lost its fence would otherwise hand the session its own front
 * matter as the role body — a plausible-looking prompt that grants nothing the
 * role was supposed to grant.
 */
export function parseRoleFile(
  name: string,
  source: string,
): { role: RoleDefinition } | { error: string } {
  const lines = source.split('\n');
  if ((lines[0] ?? '').trim() !== '---')
    return { error: 'file does not open with a `---` front matter fence' };
  const close = lines.indexOf('---', 1);
  if (close < 0) return { error: 'front matter is never closed by a `---` line' };

  const front: FrontMatter = {};
  /** The key a `- item` block list is currently filling, or null between keys. */
  let listKey: 'autoloadSkills' | 'tools' | null = null;

  for (const line of lines.slice(1, close)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item !== null && listKey !== null) {
      const entry = unquote(item[1] ?? '');
      if (entry !== '') (front[listKey] ??= []).push(entry);
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    // Neither a key nor a list item under one. Ignored BY SHAPE rather than
    // guessed at: the four keys below are the whole contract, and a line that is
    // neither says nothing about them.
    if (pair === null) {
      listKey = null;
      continue;
    }
    const key = pair[1] ?? '';
    const raw = pair[2] ?? '';
    listKey = null;

    if (key === 'name') front.name = unquote(raw);
    else if (key === 'description') front.description = unquote(raw);
    else if (key === 'autoloadSkills' || key === 'tools') {
      const values = scalarOrInlineList(raw);
      // An empty value opens a block list; a value on the line closes the key.
      if (values.length === 0) listKey = key;
      else front[key] = values;
    }
  }

  const body = lines.slice(close + 1).join('\n');
  if (body.trim() === '') return { error: 'role file declares no body below its front matter' };

  // The declared name must be the name that was asked for. A file whose front
  // matter disagrees with its filename is the one case where "close enough"
  // hands a session a different role than the one its parent named.
  const declared = front.name ?? name;
  if (declared !== name) return { error: `file declares name \`${declared}\`, not \`${name}\`` };

  return {
    role: {
      name,
      systemPrompt: body,
      ...(front.autoloadSkills === undefined ? {} : { autoloadSkills: front.autoloadSkills }),
      ...(front.tools === undefined ? {} : { tools: front.tools }),
    },
  };
}

/** Every named refusal a role lookup can produce. The caller locks on all of them. */
export type RoleFailure = 'role-not-found' | 'role-load-failed' | 'role-malformed';

export type RoleLookup =
  | { role: RoleDefinition; reason: 'ok'; detail: '' }
  | { role: null; reason: RoleFailure; detail: string };

/** The roles this package ships, so a refusal can name them. */
export async function listRoles(dir: string = rolesDir()): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load one session role from this package.
 *
 * An unknown name is answered with the names that DO exist. The name was written
 * by a parent session that cannot see this directory, so a bare "role-not-found"
 * leaves the operator unable to tell a typo from a package that shipped without
 * the role.
 */
export async function loadRole(name: string, dir: string = rolesDir()): Promise<RoleLookup> {
  if (!SAFE_NAME.test(name)) {
    return { role: null, reason: 'role-not-found', detail: `\`${name}\` is not a role name` };
  }

  let source: string;
  try {
    source = await readFile(join(dir, `${name}.md`), 'utf8');
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    // ENOENT is "no such role", which is a fact about the request. Anything else
    // — a permission error, a directory where a file should be — is a fault of
    // the installation, and merging the two reports a broken package as a typo.
    if (code !== 'ENOENT') {
      return {
        role: null,
        reason: 'role-load-failed',
        detail: `${name}.md could not be read: ${String(error)}`,
      };
    }
    const known = await listRoles(dir);
    return {
      role: null,
      reason: 'role-not-found',
      detail:
        known.length === 0
          ? `no role \`${name}\` in ${dir}, which declares no roles at all`
          : `no role \`${name}\`; this package declares ${known.join(', ')}`,
    };
  }

  const parsed = parseRoleFile(name, source);
  if ('error' in parsed) {
    return { role: null, reason: 'role-malformed', detail: `${name}.md is unusable: ${parsed.error}` };
  }
  return { role: parsed.role, reason: 'ok', detail: '' };
}

/** A playbook body, or the named reason there is none. */
export type PlaybookLookup =
  | { content: string; reason: 'ok'; detail: '' }
  | { content: null; reason: 'playbook-not-found' | 'playbook-load-failed'; detail: string };

/**
 * Load one playbook body from this package.
 *
 * THERE IS NO HOST FALLBACK, and that is a decision rather than an omission.
 * The obvious shape was "try the package, then ask `pi.loadSkills`", and it makes
 * a role's required procedure depend on which skills happen to be installed on
 * the machine — silently, with no way for the role file to say which one it got.
 * This bundle resolves what it ships and refuses what it does not, so a name that
 * is absent here is absent everywhere and says so once, loudly.
 */
export async function loadPlaybook(
  name: string,
  dir: string = playbooksDir(),
): Promise<PlaybookLookup> {
  if (!SAFE_NAME.test(name)) {
    return {
      content: null,
      reason: 'playbook-not-found',
      detail: `\`${name}\` is not a playbook name`,
    };
  }
  const path = join(dir, `${name}.md`);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      return {
        content: null,
        reason: 'playbook-not-found',
        detail: `this package ships no playbook \`${name}\` (${path})`,
      };
    }
    return {
      content: null,
      reason: 'playbook-load-failed',
      detail: `${name}.md could not be read: ${String(error)}`,
    };
  }
  if (source.trim() === '') {
    return { content: null, reason: 'playbook-load-failed', detail: `playbook \`${name}\` is empty` };
  }
  // Named and fenced, the way OMP fences an autoloaded skill body, so the model
  // reads it as delivered content rather than as something the operator typed.
  return {
    content: `<playbook name="${name}">\n${source.trim()}\n</playbook>`,
    reason: 'ok',
    detail: '',
  };
}
