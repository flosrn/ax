/**
 * Supabase stack isolation for parallel worktrees.
 *
 * One local Supabase stack serves the whole machine by default, and that is the
 * single most expensive property of parallel worktrees: a `db reset`, a
 * migration, a `db diff` or a typegen run from one branch rewrites the database
 * every other concurrent session is reading. There is no error, no warning, and
 * the damage is only visible later as tests failing in a branch that changed
 * nothing.
 *
 * So a worktree that touches the database gets its OWN stack: its own
 * project_id (which is what Docker names the containers after) and its own port
 * block. A worktree that does not touch the database keeps sharing, because an
 * isolated stack is seven containers and about a gigabyte.
 *
 * Nothing numeric lives here. The base port, the block width and the slot count
 * arrive from `ax.config.json` (`ports.supabaseBase`, `ports.step`,
 * `ports.maxSlot`); the project prefix arrives from `project.name`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { gitBlobSha } from '../hash.mjs';
import { isPortBound } from './ports.mjs';

/**
 * Every port the isolation rewrite has to move, in ascending order from the
 * base. Enumerated ONCE: this single list is why the config rewrite, the
 * free-block probe and the doctor cannot drift apart, and the index of a name
 * here is its offset from `ports.supabaseBase`.
 */
export const SERVICES = ['shadow', 'api', 'db', 'studio', 'inbucket', 'smtp', 'pop3', 'analytics'];

/**
 * Where each service's port is written in a `config.toml`.
 *
 * Section-and-key rather than the old "match the committed base value at
 * end-of-line" trick: matching on the value only works on a pristine file, and
 * an absolute assignment is what makes a second rewrite byte-identical instead
 * of offsetting already-offset ports. `sections` lists aliases because the
 * mail-catcher table was renamed `[inbucket]` -> `[local_smtp]` upstream.
 */
const SERVICE_LOCATIONS = {
  shadow: { sections: ['db'], key: 'shadow_port' },
  api: { sections: ['api'], key: 'port' },
  db: { sections: ['db'], key: 'port' },
  studio: { sections: ['studio'], key: 'port' },
  inbucket: { sections: ['local_smtp', 'inbucket'], key: 'port' },
  smtp: { sections: ['local_smtp', 'inbucket'], key: 'smtp_port' },
  pop3: { sections: ['local_smtp', 'inbucket'], key: 'pop3_port' },
  analytics: { sections: ['analytics'], key: 'port' },
};

const PROJECT_ID_MAX_LENGTH = 40; // Supabase truncates past this, silently.
const PROJECT_ID_HASH_LENGTH = 8;

/** The committed baseline block: `shadow` sits on the base, the rest follow it. */
export function basePorts(base) {
  const ports = {};
  for (const [index, service] of SERVICES.entries()) ports[service] = base + index;
  return ports;
}

/** The same block shifted into the slot this worktree owns. */
export function blockPorts(base, offset) {
  const ports = {};
  for (const [index, service] of SERVICES.entries()) ports[service] = base + index + offset;
  return ports;
}

/**
 * Deterministic preferred slot: the issue number, or a stable hash of the
 * branch when there is none. Same reasoning as the dev port — stable beats
 * tidy, because a worktree that keeps its block across re-runs keeps its
 * containers.
 */
export function preferredSlot(identity, maxSlot) {
  const issue = Number.parseInt(String(identity?.issue ?? ''), 10);
  const seed = Number.isInteger(issue) && issue > 0 ? issue : Number(identity?.seed ?? 0);
  return (seed % maxSlot) + 1;
}

/** Is every port in the block for a given offset unbound? */
export function blockFree(offset, { base, isBound = isPortBound } = {}) {
  for (const port of Object.values(blockPorts(base, offset))) {
    if (isBound(port)) return false;
  }
  return true;
}

/**
 * A free offset: start at the deterministic slot, scan upward, wrap around.
 *
 * The shell version returned a bare non-zero exit here, which every caller then
 * had to remember to check. A thrown error carrying the exhausted range says
 * what happened and what to do about it.
 */
export function findOffset({ identity, base, step, maxSlot, isBound = isPortBound }) {
  const preferred = preferredSlot(identity, maxSlot);
  for (let i = 0; i < maxSlot; i += 1) {
    const slot = ((preferred - 1 + i) % maxSlot) + 1;
    const offset = slot * step;
    if (blockFree(offset, { base, isBound })) return offset;
  }
  throw new Error(
    `every Supabase port block from +${step} to +${maxSlot * step} is bound; stop an unused worktree stack and retry`,
  );
}

/**
 * The offset this worktree owns.
 *
 * A recorded positive offset wins BEFORE any scan. Without that precedence,
 * re-running setup reads this worktree's OWN running stack as a collision and
 * moves it to another block — orphaning seven containers that nothing then
 * knows how to stop.
 */
export function resolveOffset({ identity, recorded, base, step, maxSlot, isBound = isPortBound }) {
  const kept = Number.parseInt(String(recorded ?? ''), 10);
  if (/^\d+$/.test(String(recorded ?? '').trim()) && kept > 0) {
    return { offset: kept, source: 'recorded' };
  }
  return { offset: findOffset({ identity, base, step, maxSlot, isBound }), source: 'scan' };
}

/**
 * Unique, Docker-name-safe project id derived from the branch — the isolation
 * key, since Supabase names every container after it.
 *
 * Supabase silently truncates project ids past 40 characters. Preserve a hash
 * suffix when shortening, so a long branch name yields something still valid
 * and still distinct rather than being cut at an arbitrary character (which can
 * also leave an invalid trailing '-').
 */
export function projectId(identity, prefix) {
  const raw = String(identity?.branch || identity?.name || '').split('/').pop() ?? '';
  const slugify = text =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  let slug = slugify(raw) || 'worktree';
  const maxSlug = PROJECT_ID_MAX_LENGTH - prefix.length;
  if (maxSlug < PROJECT_ID_HASH_LENGTH + 2) {
    throw new Error(`project id prefix "${prefix}" leaves no room for a distinguishing suffix within ${PROJECT_ID_MAX_LENGTH} characters`);
  }

  if (slug.length > maxSlug) {
    const hash = gitBlobSha(raw).slice(0, PROJECT_ID_HASH_LENGTH);
    const head = slug.slice(0, maxSlug - PROJECT_ID_HASH_LENGTH - 1).replace(/-+$/, '');
    slug = `${head || 'worktree'}-${hash}`;
  }

  return `${prefix}${slug}`;
}

/** The `project_id` recorded in a `config.toml`, or `undefined`. */
export function configProjectId(configTomlPath) {
  if (!existsSync(configTomlPath)) return undefined;
  const match = readFileSync(configTomlPath, 'utf8').match(/^[ \t]*project_id[ \t]*=[ \t]*"([^"]+)"/m);
  return match?.[1];
}

/**
 * Is this checkout's `config.toml` an ISOLATED one?
 *
 * Answered by comparing the working-tree `project_id` against the COMMITTED
 * one, which is the only rule that holds without a naming convention: the
 * committed id is whatever the vendor kit shipped (in one real repository it is
 * `next-supabase-saas-kit-turbo`, nothing like the project's own name), and the
 * isolated id is written by `applyConfig`. Different means promoted.
 *
 * The alternative — trusting a recorded offset — is what makes a stale env key
 * dangerous: `supabase stop` against a shared project id takes the database out
 * from under every other session on the machine. A caller must have THIS answer
 * before it stops anything.
 */
export function isIsolatedConfig({ cwd, relativePath, run = defaultRun }) {
  const working = configProjectId(join(cwd, relativePath));
  if (!working) return false;

  const committed = run('git', ['-C', cwd, 'show', `HEAD:${relativePath}`]);
  if (committed.status !== 0) return false;

  const match = String(committed.stdout ?? '').match(/^[ \t]*project_id[ \t]*=[ \t]*"([^"]+)"/m);
  return match ? working !== match[1] : false;
}

/** Local origins the auth allow-list may still be pointing at the shared checkout with. */
const LOCAL_ORIGIN = /http:\/\/(?:localhost|127\.0\.0\.1):\d+/g;

/**
 * Rewrite a `config.toml` in place: unique `project_id`, own port block, own
 * site origin.
 *
 * Every assignment is written ABSOLUTELY (base + index + offset), never
 * incremented, so running this again on an already-rewritten file reproduces
 * the same bytes. The shell version had to `git checkout` the baseline first to
 * get that property, which meant a rewrite could not survive a dirty file.
 *
 * Returns the previous values so the caller can report what moved.
 */
export function applyConfig({ configToml, projectId: id, offset, base, apiUrl }) {
  if (!existsSync(configToml)) throw new Error(`no Supabase config at ${configToml}`);

  const original = readFileSync(configToml, 'utf8');
  const target = blockPorts(base, offset);
  const previous = { projectId: undefined, ports: {} };

  const keyOwner = (section, key) => {
    for (const [service, where] of Object.entries(SERVICE_LOCATIONS)) {
      if (where.key === key && where.sections.includes(section)) return service;
    }
    return undefined;
  };

  let section = '';
  let dbHeaderLine = -1;
  const lines = original.split('\n');
  for (const [index, line] of lines.entries()) {
    // Exact section names, not prefixes: `[db.migrations]` and `[db.seed]` are
    // siblings of `[db]`, and a prefix match would hunt for ports in them.
    const header = line.match(/^[ \t]*\[([^\]]+)\][ \t]*$/);
    if (header) {
      section = header[1];
      if (section === 'db') dbHeaderLine = index;
      continue;
    }

    const projectIdLine = line.match(/^([ \t]*project_id[ \t]*=[ \t]*")([^"]*)(".*)$/);
    if (projectIdLine && section === '') {
      previous.projectId = projectIdLine[2];
      lines[index] = `${projectIdLine[1]}${id}${projectIdLine[3]}`;
      continue;
    }

    const assignment = line.match(/^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(\d+)(.*)$/);
    if (!assignment) continue;
    const service = keyOwner(section, assignment[2]);
    if (!service) continue;
    previous.ports[service] = Number(assignment[4]);
    lines[index] = `${assignment[1]}${assignment[2]}${assignment[3]}${target[service]}${assignment[5]}`;
  }

  // `db diff` needs a shadow port inside this block too, and the committed file
  // does not pin one — it relies on Supabase's own default, which every
  // isolated stack on the machine would then fight over.
  if (previous.ports.shadow === undefined && dbHeaderLine >= 0) {
    lines.splice(dbHeaderLine + 1, 0, `shadow_port = ${target.shadow}`);
  }

  let text = lines.join('\n');

  // The dev server of THIS worktree is the only client of this stack, so the
  // auth allow-list and the links in its emails must point at its own origin.
  // Wildcard entries (`http://localhost:*`) have no numeric port and are left
  // alone, which is what keeps the allow-list usable.
  if (apiUrl) text = text.replace(LOCAL_ORIGIN, apiUrl);

  const changed = text !== original;
  if (changed) writeFileSync(configToml, text);
  return { changed, previous, ports: target, projectId: id };
}

/**
 * Put the committed `config.toml` back and clear the skip-worktree bit.
 *
 * The bit is what stops the local rewrite from showing up as a modified tracked
 * file and leaking into a feature PR. Leaving it set on a worktree that is
 * about to be deleted is a known trap: git then carries an assume-unchanged
 * entry pointing at a tree that no longer exists.
 */
export function restoreConfig({ cwd, relativePath, run = defaultRun }) {
  run('git', ['-C', cwd, 'update-index', '--no-skip-worktree', relativePath]);
  run('git', ['-C', cwd, 'checkout', '--', relativePath]);
}

/**
 * The trigger for reactive isolation: a worktree on the shared stack earns its
 * own the first time one of these commands runs. PURE policy, no I/O — the
 * wrapper that consults it is an exec shim with nowhere to hang a test.
 *
 * Deliberately NOT triggering: start / stop / status, because promotion itself
 * runs `supabase start` through the same wrapper and would recurse; and
 * anything explicitly aimed at a remote database.
 */
export function commandNeedsIsolation(argv = []) {
  const args = argv.map(String);
  if (args.includes('--linked') || args.includes('--db-url')) return false;

  // Subcommands that act on the local stack with no flag at all.
  const alwaysLocal = new Set(['reset', 'diff', 'test', 'lint', 'seed']);
  // Subcommands whose DEFAULT target is remote, and which only reach the local
  // stack with an explicit --local. Omitting push/query here would let a
  // shared-stack worktree mutate the shared database without promotion, which
  // is the exact drift this guard exists to stop.
  const localOnlyWithFlag = new Set(['push', 'query', 'dump']);
  const explicitLocal = args.includes('--local');

  switch (args[0]) {
    case 'db':
      if (!args[1]) return false;
      if (alwaysLocal.has(args[1])) return true;
      return localOnlyWithFlag.has(args[1]) && explicitLocal;
    case 'migration':
    case 'migrations':
      return true;
    // `gen types --local` reads the local schema; the remote form does not.
    case 'gen':
      return explicitLocal;
    default:
      return false;
  }
}

/**
 * Does this worktree's TREE contain database changes?
 *
 * This asks about evidence, not intent. The tempting version predicts — it
 * reads the ticket and looks for the words "migration", "schema", "supabase" —
 * and it is wrong in the expensive direction: a pure UI ticket whose
 * description mentions Supabase spins seven containers it never touches.
 *
 * Evidence is: files under the database directory that are staged, dirty,
 * untracked, or differ from the merge base. `git diff` against the merge base
 * rather than the base tip, so unrelated commits landing on the base ref do not
 * make every worktree look like it touches the database.
 *
 * At CREATION time every probe is necessarily empty — the branch has just
 * forked and the tree is clean. That is intentional: a new worktree starts
 * shared and costs nothing, then earns its own stack the moment it runs a
 * database command, through `commandNeedsIsolation`.
 *
 * `force` is the caller's env override: `true` forces isolation on, `false`
 * forces it off, `undefined` asks the tree.
 */
export function touchesDatabase({ cwd, supabaseDir, force, baseRefs = ['origin/main', 'main'], run = defaultRun }) {
  if (force === true) return true;
  if (force === false) return false;
  if (!cwd || !supabaseDir) return false;

  const git = args => run('git', ['-C', cwd, ...args]);

  if (git(['status', '--porcelain', '--', supabaseDir]).stdout.trim() !== '') return true;

  for (const ref of baseRefs) {
    if (!ref) continue;
    if (git(['rev-parse', '--verify', '--quiet', ref]).status !== 0) continue;
    const mergeBase = git(['merge-base', 'HEAD', ref]).stdout.trim();
    if (!mergeBase) continue;
    return git(['diff', '--name-only', mergeBase, '--', supabaseDir]).stdout.trim() !== '';
  }

  return false;
}

/**
 * The env keys that point an app at a Supabase stack.
 *
 * `127.0.0.1` rather than `localhost`: on a host that resolves localhost to
 * ::1 first, the Supabase container only listens on IPv4 and every request
 * fails with ECONNREFUSED.
 *
 * The offset key is the durable record of which block this worktree owns — read
 * back by `resolveOffset`, by teardown to decide whether there is a stack to
 * stop, and by the doctor. It is the ONLY record; a second marker file would
 * just be a third source of truth to disagree with the other two.
 */
export function envKeys({ ports, offset, envPrefix = '' }) {
  const keys = {
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${ports.api}`,
    SUPABASE_URL: `http://127.0.0.1:${ports.api}`,
    SUPABASE_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${ports.db}/postgres`,
    EMAIL_HOST: 'localhost',
    EMAIL_PORT: String(ports.smtp),
    [`${envPrefix}SUPABASE_INBUCKET_PORT`]: String(ports.inbucket),
  };
  if (offset) keys[`${envPrefix}SUPABASE_OFFSET`] = String(offset);
  return keys;
}

/**
 * Promote a shared worktree to its own isolated stack without a full setup run.
 * This is what the reactive guard calls the first time a worktree actually
 * touches its database.
 *
 * The ORDER is the contract, and it cannot be swapped: `config.toml` and the
 * env files are rewritten BEFORE the stack starts, so a start that dies
 * half-way still leaves the app and the config naming the same project. The
 * reverse order produces an isolated stack the app cannot see.
 *
 * `run` and `write` are injected so that order is testable without Docker.
 */
export function promote({
  cwd,
  identity,
  base,
  step,
  maxSlot,
  recorded,
  relativePath,
  envFiles = [],
  envLabel,
  envPrefix = '',
  apiUrl,
  prefix,
  start,
  isBound = isPortBound,
  run = defaultRun,
  write,
}) {
  if (!start) throw new Error('promote needs a `start` descriptor: { command, args }');
  if (!write) throw new Error('promote needs an injected `writeBlock`');

  const steps = [];
  const id = projectId(identity, prefix);
  const { offset, source } = resolveOffset({ identity, recorded, base, step, maxSlot, isBound });
  const ports = blockPorts(base, offset);

  const config = applyConfig({ configToml: join(cwd, relativePath), projectId: id, offset, base, apiUrl });
  steps.push('config');

  // Hide the rewrite from git, so a local port block can never leak into a
  // feature PR as a modified tracked file.
  run('git', ['-C', cwd, 'update-index', '--skip-worktree', relativePath]);
  steps.push('skip-worktree');

  const keys = envKeys({ ports, offset, envPrefix });
  for (const file of envFiles) {
    write(isAbsolute(file) ? file : join(cwd, file), { label: envLabel, keys });
    steps.push(`env:${file}`);
  }

  const started = run(start.command, start.args ?? [], { cwd: start.cwd ?? cwd });
  steps.push('start');

  return { projectId: id, offset, offsetSource: source, ports, config, steps, started: started.status === 0 };
}

/**
 * Stop a worktree's isolated stack, addressed by project id.
 *
 * By id and not by working directory: the id is what Docker named the
 * containers after, so it still reaches them after the config.toml that
 * produced it has been restored — which is the order teardown has to run in.
 */
export function teardown({ cwd, projectId: id, cli = 'supabase', run = defaultRun }) {
  const result = run(cli, ['stop', '--project-id', id], { cwd });
  return { stopped: result.status === 0, projectId: id };
}

/** Default command runner. Never throws: a missing binary is a status, not a crash. */
function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
