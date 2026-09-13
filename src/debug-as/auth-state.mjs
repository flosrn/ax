// The authentication artifact, verified once and read once.
//
// Chromium receives a parsed VALUE, never a path (R9). Between the moment AX
// grades the file and the moment Playwright opens it, anything on disk can
// change — a parallel E2E run rewriting the same storage state, an operator
// swapping a production dump in — so the only value that cannot change is the
// one already in memory. The tests pin this by rewriting the file after a
// successful load and asserting the returned object is still the local one.
//
// EVERY CHECK IS A REFUSAL WITH A REPAIR, because a silent skip is how a
// production cookie reaches a Role browser. The one exception is a missing
// `origins` entry for the browser origin itself: that is an adapter refresh
// (the project knows how to mint the artifact), not a configuration error.
//
// WHAT "LOCAL" MEANS is one set, imported from `./address.mjs`, plus the
// hosts this checkout actually recorded. A suffix match is never a match —
// `.app.example.com` is production even if this checkout's host is
// `localhost`. The same rule the provider host uses, for the same reason.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { defaultExec } from '../exec.mjs';
import { LOCAL_HOSTS, originHost } from './address.mjs';

export { LOCAL_HOSTS };

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message, fix, extra = {}) => Object.assign(new Error(message), { fix, ...extra });

/** Strip a cookie's leading-dot convention; compare hosts, never suffixes. */
const cookieHost = domain => String(domain ?? '').replace(/^\./, '').toLowerCase();

/** The hosts this checkout may put in an artifact. */
function localHosts(browserOrigin, addresses) {
  const hosts = new Set(LOCAL_HOSTS);
  for (const origin of [browserOrigin, addresses?.directOrigin, addresses?.browserOrigin]) {
    const host = originHost(origin);
    if (host) hosts.add(host.toLowerCase());
  }
  return hosts;
}

/**
 * A path that is a regular file inside `root`, with no symlink anywhere on
 * the way there. `realpath` of a parent would follow a planted directory
 * symlink and then grade the target as "inside the worktree" — R9 forbids
 * that, so every component of the ORIGINAL candidate is `lstat`'d, and the
 * descriptor later opened is matched against that same inode.
 */
function containedFile(root, relativePath) {
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw fail(`the worktree ${JSON.stringify(root)} is not a directory`, 'run this command from a checkout `ax` already set up');
  }

  const candidate = isAbsolute(relativePath) ? relativePath : resolvePath(rootReal, relativePath);
  const inside = relative(rootReal, candidate);
  if (inside.startsWith('..') || isAbsolute(inside) || inside === '') {
    throw fail(
      `the authentication artifact ${JSON.stringify(relativePath)} is not inside this worktree`,
      `declare "browser.storageState" as a path inside this worktree, such as "apps/e2e/.auth/owner.json"`,
    );
  }

  const parts = inside.split('/').filter(Boolean);
  let file = rootReal;
  let stat;
  for (const part of parts) {
    file = join(file, part);
    try {
      stat = lstatSync(file);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        throw fail(
          `the authentication artifact ${inside} is missing`,
          `run the project's Debug adapter to create it, or declare this identity unauthenticated by dropping its "browser" block`,
          { code: 'MISSING' },
        );
      }
      throw fail(
        `the authentication artifact ${inside} could not be read (${error.code ?? error.message})`,
        `fix the path declared as "browser.storageState" so it names a regular file inside this worktree`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw fail(
        `the authentication artifact ${inside} crosses a symlink at ${relative(rootReal, file)}, so its target is not this worktree's to vouch for`,
        `replace the symlink with a regular file the project's Debug adapter writes`,
      );
    }
  }
  if (!stat || !stat.isFile()) {
    throw fail(
      `the authentication artifact ${inside} is not a regular file`,
      `declare "browser.storageState" as a regular file the project's Debug adapter writes`,
    );
  }

  return { file, inside, proof: { dev: stat.dev, ino: stat.ino } };
}

/** Git's own answer to "is this path ignored", never a guessed `.gitignore` parse. */
function assertIgnored(root, inside, exec) {
  const out = exec('git', ['check-ignore', '-q', '--', inside], root);
  if (out.status === 0) return;
  throw fail(
    `the authentication artifact ${inside} is not ignored by Git, so committing this worktree would publish a credential`,
    `add ${inside} to .gitignore (or the directory that contains it) and confirm with \`git check-ignore -v ${inside}\``,
  );
}

/** Owner-only: any group or other bit is a credential another user on this machine can read. */
function assertPrivate(stat, inside) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw fail(
      `the authentication artifact ${inside} is not owned by the invoking user`,
      `chown it to the user that runs \`ax debug-as\`, then \`chmod 600 ${inside}\``,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw fail(
      `the authentication artifact ${inside} is readable by another user on this machine`,
      `chmod 600 ${inside}`,
    );
  }
}

/** Every cookie domain and every `origins` entry stays inside the local set. */
function assertLocal(state, { browserOrigin, hosts, inside }) {
  if (!isObject(state) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw fail(
      `the authentication artifact ${inside} is not a Playwright storage state (an object with "cookies" and "origins" arrays)`,
      `run the project's Debug adapter so it rewrites ${inside} as a Playwright storageState`,
    );
  }
  const { cookies, origins } = state;

  for (const cookie of cookies) {
    const host = cookieHost(cookie?.domain);
    if (host === '' || !hosts.has(host)) {
      throw fail(
        `the authentication artifact ${inside} carries a cookie for ${JSON.stringify(cookie?.domain)}, which is not a local address of this checkout`,
        `run the project's Debug adapter so it rewrites ${inside} against this checkout's own loopback origin, or delete the production cookie from it`,
      );
    }
  }

  for (const entry of origins) {
    const host = originHost(entry?.origin);
    if (host === null || !hosts.has(host.toLowerCase())) {
      throw fail(
        `the authentication artifact ${inside} carries an origins entry for ${JSON.stringify(entry?.origin)}, which is not a local address of this checkout`,
        `run the project's Debug adapter so it rewrites ${inside} against this checkout's own loopback origin, or delete the production entry from it`,
      );
    }
  }

  const refreshNeeded = !origins.some(entry => entry?.origin === browserOrigin);
  return { cookies, origins, refreshNeeded };
}

/**
 * Resolve, prove and parse the configured authentication artifact, once.
 *
 * Returns `{ state, refreshNeeded, path }`. `state` is the parsed object
 * Chromium receives as `storageState`. `refreshNeeded` is true when the
 * artifact is local and well-formed but does not yet include the Role
 * browser origin — the adapter, not a refusal. A missing file throws with
 * `code: 'MISSING'` so a launch can run the adapter first.
 */
export async function loadStorageState({ root, relativePath, browserOrigin, addresses = {}, exec = defaultExec }) {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw fail(
      'this identity declares no authentication artifact',
      'declare "browser.storageState" on the identity, or drop its "browser" block to declare it unauthenticated',
      { code: 'MISSING' },
    );
  }

  const { file, inside, proof } = containedFile(root, relativePath);
  assertIgnored(root, inside, exec);

  // Open with O_NOFOLLOW so a symlink planted between lstat and open cannot
  // change whose bytes we read; then fstat THAT descriptor so a chmod or
  // rewrite after open cannot change the mode we graded or the bytes we parse.
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw fail(
        `the authentication artifact ${inside} is missing`,
        `run the project's Debug adapter to create it, or declare this identity unauthenticated by dropping its "browser" block`,
        { code: 'MISSING' },
      );
    }
    throw fail(
      `the authentication artifact ${inside} could not be opened (${error.code ?? error.message})`,
      `replace it with a regular file the project's Debug adapter writes`,
    );
  }

  try {
    const stat = fstatSync(fd);
    if (stat.dev !== proof.dev || stat.ino !== proof.ino) {
      throw fail(
        `the authentication artifact ${inside} changed between the path proof and the open`,
        `replace it with a regular file the project's Debug adapter writes`,
      );
    }
    if (!stat.isFile()) {
      throw fail(
        `the authentication artifact ${inside} is not a regular file`,
        `declare "browser.storageState" as a regular file the project's Debug adapter writes`,
      );
    }
    assertPrivate(stat, inside);

    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const text = buf.subarray(0, offset).toString('utf8');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail(
        `the authentication artifact ${inside} is not valid JSON`,
        `run the project's Debug adapter so it rewrites ${inside} as a Playwright storageState`,
      );
    }

    const hosts = localHosts(browserOrigin, addresses);
    const { refreshNeeded } = assertLocal(parsed, { browserOrigin, hosts, inside });
    return { state: parsed, refreshNeeded, path: inside };
  } finally {
    closeSync(fd);
  }
}
