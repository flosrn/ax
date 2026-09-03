// Managed blocks: the only thing ax is allowed to write inside a file the
// vendor also owns.
//
// A merge conflict costs whatever the two sides touched. ofmchat carries AX
// tooling spread through ten vendor files, so upstream and Flo edit the same
// lines and git asks a question every time. A fenced block moves the answer:
// upstream edits the file around it, ax rewrites only between its markers, and
// `ax init` can restore the block after any resolution — including "keep
// theirs", which is now always the safe choice.
//
// MakerKit already uses this shape in AGENTS.md (`<!-- BEGIN:nextjs-agent-rules -->`),
// so the convention is the kit's, not an import.

const STYLES = {
  hash: { open: id => `# BEGIN:${id}`, close: id => `# END:${id}` },
  markdown: { open: id => `<!-- BEGIN:${id} -->`, close: id => `<!-- END:${id} -->` },
};

/** Comment style for a path, by extension and by well-known filename. */
export function styleFor(filename) {
  if (/\.mdx?$/.test(filename)) return 'markdown';
  if (/(^|\/)(\.gitignore|\.dockerignore|\.aiignore|\.cursorignore)$/.test(filename)) return 'hash';
  if (/\.(sh|ya?ml|toml|env|conf)$/.test(filename)) return 'hash';
  throw new Error(`no managed-block comment style for ${filename}`);
}

/**
 * The one condition both readers refuse, so they refuse it identically: an
 * opening marker with no closing one. A file in that state cannot be rewritten
 * (a second block after a stray BEGIN leaves two openers and a file no rewrite
 * repairs) and it cannot be READ as an absence either — that reading let
 * `ax doctor` grade a half-resolved conflict as "no block here" and name
 * `ax init`, the very call that throws on it (PR #117).
 */
const unterminated = (id, open, close) => new Error(`unterminated managed block "${id}": found ${open} without ${close}`);

/**
 * Write `body` into the `id` block of `source`, in place if the block exists,
 * appended otherwise. Returns `{ text, changed }`; `changed` is false when the
 * file already says exactly this, which is what makes a second `ax init` quiet.
 */
export function applyBlock(source, { id, body, style }) {
  const marks = STYLES[style];
  if (!marks) throw new Error(`unknown comment style ${style}`);
  const open = marks.open(id);
  const close = marks.close(id);
  const lines = body.trimEnd().split('\n');
  const block = [open, ...lines, close].join('\n');

  const startIndex = source.indexOf(open);
  if (startIndex !== -1) {
    const endIndex = source.indexOf(close, startIndex);
    if (endIndex === -1) throw unterminated(id, open, close);
    const before = source.slice(0, startIndex);
    const after = source.slice(endIndex + close.length);
    const text = `${before}${block}${after}`;
    return { text, changed: text !== source };
  }

  const separator = source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  const text = `${source}${separator}${block}\n`;
  return { text, changed: true };
}

/**
 * Read back the body of a block, `null` when the file carries no opening marker
 * — and a THROW when it carries one with no close, because that is neither a
 * body nor an absence. A caller that grades files it does not own catches it
 * and reports the orphan (`src/doctor.mjs`); the disposition is `applyBlock`'s
 * above, for the same condition in the same file.
 */
export function readBlock(source, { id, style }) {
  const marks = STYLES[style];
  const open = marks.open(id);
  const close = marks.close(id);
  const startIndex = source.indexOf(open);
  if (startIndex === -1) return null;
  const endIndex = source.indexOf(close, startIndex);
  if (endIndex === -1) throw unterminated(id, open, close);
  return source.slice(startIndex + open.length, endIndex).replace(/^\n/, '').replace(/\n$/, '');
}

/**
 * Set a value at a dotted path in a parsed JSON document, in place.
 *
 * JSON carries no comments, so package.json gets structural edits instead of a
 * fenced block: ax owns named keys, never the file. Returns true when something
 * actually changed.
 */
export function setJsonPath(document, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cursor = document;
  for (const key of keys) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  if (cursor[last] === value) return false;
  cursor[last] = value;
  return true;
}

export function getJsonPath(document, path) {
  return path.split('.').reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), document);
}
