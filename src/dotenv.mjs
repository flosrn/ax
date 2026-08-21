// ONE dotenv grammar for the whole toolchain.
//
// This exists as a module, rather than inline in each reader, because the
// alternative was measured twice and both times it cost a debugging session: a
// shell reader and a JS launcher graded the same two files with grammars that
// differed in one detail each, so the doctor and the dev server disagreed about
// the same worktree. `KEY = 0` was a value to one and no assignment to the
// other; `KEY="0" # note` yielded `0` to one and `0"` to the other.
//
// The order below is the order that agrees: comment first, THEN quotes.
//
// Values are trimmed, never stripped of inner whitespace. Every key read through
// here is a port, a URL, a name or a flag, so a value containing a space is
// malformed — and a malformed value must reach the comparison that reports it
// instead of being silently glued back together.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Keys are interpolated into a RegExp, so they must be bare identifiers. */
function assertKey(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`refusing to read a non-identifier env key "${key}"`);
  }
}

/**
 * The value assigned to `key` in dotenv `text`, or `undefined` when the key is
 * never assigned.
 *
 * An assigned-but-empty key returns `''`. That distinction is the point: absent
 * means "nothing recorded, derive it", empty means "someone recorded nothing on
 * purpose", and collapsing the two turns an explicit opt-out into a re-derivation.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string | undefined}
 */
export function parseValue(text, key) {
  assertKey(key);
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`);

  /** @type {string | undefined} */
  let found;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    // Last assignment wins, matching both dotenv and shell behaviour.
    found = stripQuotes(match[1].replace(/\s+#.*$/, '')).trim();
  }
  return found;
}

/** Remove one balanced pair of surrounding quotes; an unbalanced quote is data. */
function stripQuotes(value) {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * `parseValue` against a file. A file that does not exist is not an error — most
 * callers ask about `.env.local` files that are only written on demand.
 *
 * @param {string} file
 * @param {string} key
 * @returns {string | undefined}
 */
export function readKey(file, key) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return parseValue(contents, key);
}

/**
 * The effective value of a key, in the precedence a Next.js app documents: an
 * already-exported variable outranks every file, then the files in the order the
 * caller lists them, first non-empty winning.
 *
 * The file list is the caller's, not this module's: which files carry a project's
 * configuration is a property of that project, and hardcoding a guess here is how
 * a shared helper starts lying to the second repo that uses it.
 *
 * Empty counts as absent at this layer, because an exported `KEY=` is how a shell
 * spells "unset" and every recorded value here is non-empty when it means anything.
 *
 * @param {string} key
 * @param {{ cwd: string, files: string[], env?: Record<string, string | undefined> }} options
 * @returns {string | undefined}
 */
export function readConfigured(key, { cwd, files, env = process.env }) {
  assertKey(key);
  if (env[key]) return env[key];

  for (const file of files) {
    const value = readKey(resolve(cwd, file), key);
    if (value) return value;
  }
  return undefined;
}

/**
 * Append — or rewrite in place — a labelled block of assignments at the end of
 * `file`.
 *
 * Replacing rather than appending is the whole reason this is not two lines of
 * `>>`: setup runs again on an existing worktree, and a second block of the same
 * label leaves two assignments for every key. The last one still wins for a
 * dotenv reader, so nothing breaks loudly — the file just becomes unreadable and
 * every subsequent hand-edit lands in the stale copy.
 *
 * The block is re-emitted at the tail even when it was found mid-file, so the
 * managed keys always sit after anything the developer wrote by hand.
 *
 * @param {string} file
 * @param {{ label: string, keys: Record<string, unknown> | Array<[string, unknown]> }} options
 * @returns {boolean} true when the file changed on disk
 */
export function writeBlock(file, { label, keys }) {
  const entries = Array.isArray(keys) ? keys : Object.entries(keys);
  const header = `# --- ${label} ---`;

  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    // A file that is not there yet is an empty one.
  }

  const preserved = withoutBlock(existing, header);
  const head = preserved.replace(/\n+$/, '');
  const body = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const text = `${head ? `${head}\n` : ''}\n${header}\n${body}\n`;

  if (text === existing) return false;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}

/**
 * Delete a labelled block, if it is there.
 *
 * The counterpart to `writeBlock`, and load-bearing for exactly one situation:
 * a checkout that WAS isolated and is now shared. Its env still records the
 * endpoints of a stack that has been stopped, and a reader cannot tell a stale
 * record from a current one — so the app keeps dialling ports nothing answers
 * on, while every other source of truth says shared. Writing the new state
 * without erasing the old one leaves the two disagreeing, which is worse than
 * either being wrong alone.
 *
 * @returns {boolean} true when the file changed on disk
 */
export function removeBlock(file, label) {
  let existing;
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  const text = `${withoutBlock(existing, `# --- ${label} ---`).replace(/\n+$/, '')}\n`;
  if (text === existing) return false;

  writeFileSync(file, text);
  return true;
}

/**
 * Drop the block introduced by `header`, wherever it sits.
 *
 * A block runs to the next block header or to end of file. Blank lines and
 * comments inside it belong to it; the next `# --- … ---` does not.
 */
function withoutBlock(text, header) {
  const lines = text.split('\n');
  const kept = [];
  let inside = false;

  for (const line of lines) {
    const isHeader = /^# --- .* ---$/.test(line.trim());
    if (isHeader) inside = line.trim() === header;
    if (!inside) kept.push(line);
  }
  return kept.join('\n');
}
