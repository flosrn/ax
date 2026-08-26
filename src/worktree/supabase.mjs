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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { run as execRun } from '../exec.mjs';
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
 * The claim a worktree's own `config.toml` records: which block it took, and
 * under which project id its containers are running.
 *
 * This exists because the offset used to live in ONE place only — an untracked
 * `AX_SUPABASE_OFFSET` in `.env.local` — while the containers themselves are
 * named after the `project_id` in `config.toml` and bound to the ports that
 * same file assigns. Wipe the env file (`git clean -xdf` does it) and the
 * "recorded wins before any scan" protection evaporated: the next setup read
 * this worktree's OWN running stack as a collision, moved to another block and
 * started a second one, leaving seven containers nothing could address.
 *
 * The config is the durable artefact, so read the claim back out of it:
 *   - the offset is any service port minus that service's baseline
 *     (`base` + its index in SERVICES), and every port present must AGREE on
 *     it — a file whose ports disagree is hand-mangled, and guessing which
 *     half is right is how you stop the wrong stack;
 *   - the id is its `project_id`.
 *
 * A zero offset is not a claim: that is the committed baseline, i.e. the SHARED
 * stack, whose id belongs to the primary checkout and must never be adopted or
 * torn down by a worktree.
 *
 * The id here is EVIDENCE, never authority: `ownsStack` compares it against the
 * id this worktree is expected to run, and nothing derives an expectation from
 * it. A config copied out of a sibling worktree carries that sibling's id, and
 * no property of the file tells that copy apart from a legitimate rewrite.
 *
 * @returns {{ offset: number, projectId: string } | undefined}
 */
export function recordedClaim({ cwd, relativePath, base }) {
  const configToml = join(cwd, relativePath);
  if (!existsSync(configToml) || !Number.isInteger(base)) return undefined;

  const id = configProjectId(configToml);
  if (!id) return undefined;

  let offset;
  for (const [service, port] of Object.entries(configPorts(readFileSync(configToml, 'utf8')))) {
    const candidate = port - (base + SERVICES.indexOf(service));
    if (offset === undefined) offset = candidate;
    else if (candidate !== offset) return undefined; // ports disagree: no claim.
  }

  return offset > 0 ? { offset, projectId: id } : undefined;
}

/** Every service port a `config.toml` actually assigns, by service name. */
function configPorts(text) {
  const ports = {};
  let section = '';
  for (const line of text.split('\n')) {
    // Exact section names, not prefixes — `[db.migrations]` is a sibling of
    // `[db]`, and a prefix match would hunt for ports in it.
    const header = line.match(/^[ \t]*\[([^\]]+)\][ \t]*$/);
    if (header) {
      section = header[1];
      continue;
    }
    const assignment = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(\d+)/);
    if (!assignment) continue;
    const service = keyOwner(section, assignment[1]);
    if (service) ports[service] = Number(assignment[2]);
  }
  return ports;
}

/** Which service owns `key` inside `[section]`, if any. */
function keyOwner(section, key) {
  for (const [service, where] of Object.entries(SERVICE_LOCATIONS)) {
    if (where.key === key && where.sections.includes(section)) return service;
  }
  return undefined;
}

/**
 * The offset this worktree owns.
 *
 * A recorded positive offset wins BEFORE any scan. Without that precedence,
 * re-running setup reads this worktree's OWN running stack as a collision and
 * moves it to another block — orphaning seven containers that nothing then
 * knows how to stop.
 *
 * The `config.toml` claim outranks the env record, and is consulted whenever the
 * caller supplies `cwd`/`relativePath`: the config is what `supabase start`
 * read, so its ports are the ones the running containers actually hold, and it
 * survives the wipe of an untracked env file that used to lose the block
 * entirely. The two only disagree after a hand edit or a half-written promotion
 * (`applyConfig` runs before the env write), and in both cases the config is the
 * one naming ports something is really bound to.
 */
export function resolveOffset({ identity, recorded, base, step, maxSlot, isBound = isPortBound, cwd, relativePath }) {
  if (cwd && relativePath) {
    const claim = recordedClaim({ cwd, relativePath, base });
    if (claim) return { offset: claim.offset, source: 'config' };
  }

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
 * Is the rewrite still in place — does the working-tree `project_id` differ
 * from the COMMITTED one?
 *
 * A SECONDARY signal only, and nothing destructive may depend on it alone. It
 * answers "this file was rewritten locally", which is neither necessary nor
 * sufficient for "this worktree owns the stack that id names", and it lies in
 * both directions:
 *   - a `config.toml` carrying ANOTHER checkout's id (copied between worktrees,
 *     or hand-edited) differs from HEAD, so this reads as isolated and a
 *     teardown driven by it stops someone else's — or the shared — stack;
 *   - a branch that legitimately COMMITS its own project id does NOT differ
 *     from HEAD, so this reads as shared and teardown leaves seven containers
 *     running when the worktree is deleted.
 *
 * `ownsStack` is the authority in front of anything that stops containers. Use
 * this one only to report whether the local rewrite survived, e.g. next to a
 * recorded offset in the doctor.
 */
export function isIsolatedConfig({ cwd, relativePath, run = defaultRun }) {
  const working = configProjectId(join(cwd, relativePath));
  if (!working) return false;

  const committed = run('git', ['-C', cwd, 'show', `HEAD:${relativePath}`]);
  if (committed.status !== 0) return false;

  const match = String(committed.stdout ?? '').match(/^[ \t]*project_id[ \t]*=[ \t]*"([^"]+)"/m);
  return match ? working !== match[1] : false;
}

/**
 * Does THIS worktree own the stack its `config.toml` names?
 *
 * The one question a caller must answer before `supabase stop --project-id`,
 * and it is answered by IDENTITY, not by difference: the id in the file must be
 * exactly the id this tooling would run for this worktree (`expectedProjectId`,
 * i.e. `projectId(identity, prefix)` as the plan mints it, or the id this
 * worktree recorded when it took the block). Anything else — a foreign id, the
 * committed vendor baseline, the machine's shared id, a hand edit — is someone
 * else's stack, and stopping it takes the database out from under every other
 * session on the machine.
 *
 * `owned: false` is never an error state on its own: `reason` says which id was
 * found and which was expected, so the caller can report a stack it must NOT
 * stop rather than silently stopping the wrong one, or silently nothing.
 *
 * Never throws — an unreadable config or a missing git is a `reason`, because a
 * crash here aborts a teardown half-way through.
 *
 * @returns {{ owned: boolean, projectId?: string, expected?: string, rewritten?: boolean, reason?: string }}
 */
export function ownsStack({ cwd, relativePath, expectedProjectId, run = defaultRun }) {
  try {
    if (!cwd || !relativePath) return { owned: false, reason: 'no config.toml path to check ownership against' };

    const found = configProjectId(join(cwd, relativePath));
    if (!found) return { owned: false, reason: `${relativePath} records no project_id, so no stack is addressable from it` };

    const expected = expectedProjectId ? String(expectedProjectId) : '';
    if (!expected) {
      return { owned: false, projectId: found, reason: `no project id was derived for this worktree, so "${found}" cannot be shown to belong to it` };
    }

    if (found !== expected) {
      return {
        owned: false,
        projectId: found,
        expected,
        reason: `${relativePath} carries project id "${found}", but this worktree's stack is "${expected}" — "${found}" belongs to another checkout or to the shared stack`,
      };
    }

    // Secondary, informational: whether the local rewrite is still in place. A
    // branch may legitimately commit its isolated id, so `false` here does NOT
    // withdraw ownership — it only tells the caller how the id got there.
    return { owned: true, projectId: found, expected, rewritten: isIsolatedConfig({ cwd, relativePath, run }) };
  } catch (error) {
    return { owned: false, reason: `could not establish stack ownership: ${error.message}` };
  }
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

  // `keyOwner` is the module's, shared with `configPorts`: the read-back of a
  // claim and the rewrite that wrote it must agree on where a port lives.

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
 * The command NAMES here are the real CLI's, read from `supabase --help` and
 * not from the shape of the wrapper. That distinction was a live hole: `test`
 * and `seed` were listed as `db` subcommands, which the CLI does not have, so
 * `supabase test db` (pgTAP) and `supabase seed buckets` fell through to "no
 * isolation needed" and ran fixtures and seeds against the SHARED database from
 * an unpromoted worktree. Verbatim from `supabase --help` (CLI 2.109.1):
 *
 *     seed                Seed a Supabase project
 *     test                Run tests on local Supabase containers
 *
 * and the complete `supabase db --help` list, in which no `test` and no `seed`
 * appear:
 *
 *     diff | dump | push | pull | reset | lint | start | query | advisors | schema
 *
 * Deliberately NOT triggering: start / stop / status (and `db start`), because
 * promotion itself runs `supabase start` through the same wrapper and would
 * recurse; and anything explicitly aimed at a remote database.
 */
export function commandNeedsIsolation(argv = []) {
  const args = argv.map(String);

  // `db pull` is decided BEFORE the remote-target flags, because for this one
  // command those flags name the SOURCE of the pull and not where the work
  // happens: the migration is computed by diffing through the LOCAL shadow
  // database (`supabase db pull --help` offers `--diff-engine migra|pg-delta`
  // for exactly that), and that shadow is a container in this project's own
  // port block. `db pull --linked` from an unpromoted worktree therefore still
  // reaches the shared stack.
  if (args[0] === 'db' && args[1] === 'pull') return true;

  if (args.includes('--linked') || args.includes('--db-url')) return false;

  // `db` subcommands that reach the local stack with no flag at all.
  const alwaysLocal = new Set(['reset', 'diff', 'lint']);
  // Subcommands whose DEFAULT target is remote, and which only reach the local
  // stack with an explicit --local. Omitting push/query here would let a
  // shared-stack worktree mutate the shared database without promotion, which
  // is the exact drift this guard exists to stop.
  const localOnlyWithFlag = new Set(['push', 'query', 'dump']);
  const explicitLocal = args.includes('--local');

  switch (args[0]) {
    // Top-level, and local by definition: `test` runs "on local Supabase
    // containers", `seed` seeds the project the local `config.toml` describes.
    // Their subcommands (`test db`, `test new`, `seed buckets`) do not change
    // the target, so the first word is the whole decision.
    case 'test':
    case 'seed':
      return true;
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
 * Two keys are the durable RECORD of what this worktree claimed, and both are
 * needed. The offset says which block it took; the project id says what Docker
 * named the containers, which is the only handle anything has on them. Before
 * the id was recorded it was re-derived from the CURRENT branch on every run, so
 * a `git branch -m` minted a second name for a stack that was already running —
 * the config was rewritten, `supabase start` collided with its own ports, and
 * every later teardown addressed an id Docker had never used.
 */
export function envKeys({ ports, offset, projectId: id, envPrefix = '' }) {
  const keys = {
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${ports.api}`,
    SUPABASE_URL: `http://127.0.0.1:${ports.api}`,
    SUPABASE_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${ports.db}/postgres`,
    EMAIL_HOST: 'localhost',
    EMAIL_PORT: String(ports.smtp),
    [`${envPrefix}SUPABASE_INBUCKET_PORT`]: String(ports.inbucket),
  };
  // Offset 0 is the shared baseline; recording it would claim isolation, and an
  // id without a block is the same false claim.
  if (offset) keys[`${envPrefix}SUPABASE_OFFSET`] = String(offset);
  if (offset && id) keys[`${envPrefix}SUPABASE_PROJECT`] = String(id);
  return keys;
}

/**
 * The label the Supabase env block carries, for every writer that must agree
 * on it: the plan's env writes, the promotion path, and the erase step. It
 * lives beside `envKeys` because the key set it labels is owned here — a
 * second spelling of either is how two writers drift.
 */
export const SUPABASE_LABEL = 'Supabase endpoints';

/** A project id this tooling could have written: Docker-name-safe and not truncated. */
const PLAUSIBLE_PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The project id this worktree's stack runs under.
 *
 * Never a bare derivation from the current branch, which is what made a
 * `git branch -m` mint a second name for a stack that was already running. The
 * order, and the reason for each step:
 *
 *  1. the id in `config.toml`, but ONLY when it equals the id this worktree
 *     would mint. That is agreement with our own derivation, not adoption of
 *     whatever the file says, and it is the half-written-promotion case:
 *     `promote` writes the config BEFORE the env block, so a run that died in
 *     between leaves a config newer than the record, naming containers that are
 *     up. Preferring the stale record there would strand them.
 *  2. the id this worktree RECORDED when it took the block. The containers are
 *     named after it, so a rename must not rename them.
 *  3. a fresh mint from the branch — the only option for a worktree that has
 *     never claimed anything.
 *
 * What is deliberately NOT here is authority for an unrecognised `project_id`,
 * however isolated the file looks. A config copied out of a sibling worktree
 * carries that sibling's id, and no property of the file tells that copy apart
 * from a rename whose record was wiped. One of the two has to lose, and it is
 * the rename: adopting a foreign id puts two worktrees on ONE database with no
 * error at all, while declining it leaves containers running under a name this
 * checkout does not use. So the id is compared, never adopted, and the leak is
 * REPORTED — `conflict` names the stack nothing here addresses, for the caller
 * to print. Silence is the only outcome that is never acceptable.
 *
 * @returns {{ projectId: string, source: 'config'|'recorded'|'branch', conflict?: string }}
 */
export function resolveProjectId({ identity, prefix = '', recorded, cwd, relativePath, base }) {
  const minted = projectId(identity, prefix);
  const claim = cwd && relativePath ? recordedClaim({ cwd, relativePath, base }) : undefined;

  const kept = String(recorded ?? '').trim();
  const usable = kept.length > 0 && kept.length <= PROJECT_ID_MAX_LENGTH && PLAUSIBLE_PROJECT_ID.test(kept);

  let resolved;
  if (claim?.projectId === minted) resolved = { projectId: minted, source: 'config' };
  else if (usable) resolved = { projectId: kept, source: 'recorded' };
  else resolved = { projectId: minted, source: 'branch' };

  if (claim && claim.projectId !== resolved.projectId) {
    resolved.conflict = `${relativePath} names stack "${claim.projectId}" on block +${claim.offset}, but this worktree resolves to "${resolved.projectId}" — nothing here addresses the containers of "${claim.projectId}"`;
  }

  return resolved;
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
 * Both halves of the claim arrive DECIDED, never derived here: the plan is the
 * one resolver of `projectId` and `offset` (resolveProjectId / resolveOffset,
 * recorded claims included), and this verb only renders and writes. Deriving
 * the id from the current branch on every run is what used to start a second
 * stack on the first stack's ports and leave the first unaddressable — and
 * both real callers had forgotten the optional parameter that prevented it,
 * which is why the decided values now arrive through `promoteFromPlan`, read
 * off the plan structurally instead of remembered ninth at every call site.
 *
 * `run` and `write` are injected so that order is testable without Docker.
 */
export function promote({
  cwd,
  projectId: id,
  offset,
  base,
  relativePath,
  envFiles = [],
  envLabel,
  envPrefix = '',
  apiUrl,
  start,
  run = defaultRun,
  write,
}) {
  if (!start) throw new Error('promote needs a `start` descriptor: { command, args }');
  if (!write) throw new Error('promote needs an injected `writeBlock`');

  const steps = [];
  const ports = blockPorts(base, offset);

  const config = applyConfig({ configToml: join(cwd, relativePath), projectId: id, offset, base, apiUrl });
  steps.push('config');

  // Hide the rewrite from git, so a local port block can never leak into a
  // feature PR as a modified tracked file.
  run('git', ['-C', cwd, 'update-index', '--skip-worktree', relativePath]);
  steps.push('skip-worktree');

  const keys = envKeys({ ports, offset, projectId: id, envPrefix });
  for (const file of envFiles) {
    write(isAbsolute(file) ? file : join(cwd, file), { label: envLabel, keys });
    steps.push(`env:${file}`);
  }

  const started = run(start.command, start.args ?? [], { cwd: start.cwd ?? cwd });
  steps.push('start');

  return { projectId: id, offset, ports, config, steps, started: started.status === 0 };
}

/**
 * The plan-shaped door to `promote`, and the only one the verbs use.
 *
 * It owns the assembly each caller used to hand-write a dozen options for —
 * the label, the config.toml path, the env file — so the field that carries
 * the invariant (the plan's own resolved `projectId`) is read structurally
 * here instead of remembered at every call site.
 */
export function promoteFromPlan({ plan, config, root, start, envPrefix, run = defaultRun, write }) {
  // Both callers decide the mode before calling (setup's isolated branch, the
  // guard's refusal on a shared plan) — an isolated plan is this door's input,
  // not something it re-checks.
  return promote({
    cwd: root,
    projectId: plan.supabase.projectId,
    offset: plan.supabase.offset,
    base: config.ports.supabaseBase,
    relativePath: join(config.apps.web, 'supabase', 'config.toml'),
    envFiles: [join(config.apps.web, '.env.local')],
    envLabel: SUPABASE_LABEL,
    envPrefix,
    apiUrl: plan.urls.publishedUrl,
    start,
    run,
    write,
  });
}

/**
 * Stop a worktree's isolated stack, addressed by project id.
 *
 * By id and not by working directory: the id is what Docker named the
 * containers after, so it still reaches them after the config.toml that
 * produced it has been restored — which is the order teardown has to run in.
 *
 * The caller MUST have established ownership of that id first (`ownsStack`).
 * An absent id is refused here rather than passed on, because
 * `supabase stop --project-id ""` is not a no-op: with no id to match, the CLI
 * falls back to the project the working directory describes, which for an
 * unpromoted worktree is the SHARED stack every other session is reading.
 */
export function teardown({ cwd, projectId: id, cli = 'supabase', run = defaultRun }) {
  const target = String(id ?? '').trim();
  if (!target) return { stopped: false, projectId: undefined, refused: 'no project id to stop — refusing to let the CLI pick one' };

  const result = run(cli, ['stop', '--project-id', target], { cwd });
  return { stopped: result.status === 0, projectId: target };
}

/** Default command runner — the shared adapter (src/exec.mjs). Never throws: a missing binary is a status, not a crash. */
const defaultRun = (command, args, options = {}) => execRun(command, args, options);
