import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyBlock, getJsonPath, readBlock, setJsonPath, styleFor } from '../src/blocks.mjs';

test('a block is appended once, spaced off the existing content, then rewritten in place', () => {
  const first = applyBlock('node_modules/\n', { id: 'ax', body: '.worktrees/', style: 'hash' });
  assert.equal(first.changed, true);
  // A blank line before the block: the file stays readable for the human who
  // owns the rest of it.
  assert.equal(first.text, 'node_modules/\n\n# BEGIN:ax\n.worktrees/\n# END:ax\n');
  // Idempotence is the whole promise: a second `ax init` must be quiet, or the
  // block churns the file on every session start.
  const second = applyBlock(first.text, { id: 'ax', body: '.worktrees/', style: 'hash' });
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('rewriting a block touches nothing around it', () => {
  const source = 'keep-above\n\n# BEGIN:ax\nstale\n# END:ax\n\nkeep-below\n';
  const { text, changed } = applyBlock(source, { id: 'ax', body: 'fresh', style: 'hash' });
  assert.equal(changed, true);
  assert.equal(text, 'keep-above\n\n# BEGIN:ax\nfresh\n# END:ax\n\nkeep-below\n');
});

test('a markdown block uses the comment shape MakerKit already uses', () => {
  const { text } = applyBlock('# Title\n', { id: 'ax', body: '## Worktrees', style: 'markdown' });
  assert.equal(text, '# Title\n\n<!-- BEGIN:ax -->\n## Worktrees\n<!-- END:ax -->\n');
  assert.equal(readBlock(text, { id: 'ax', style: 'markdown' }), '## Worktrees');
});

test('a half-deleted block is refused, not silently duplicated', () => {
  // Appending a second block after a stray BEGIN would leave two openers and a
  // file no rewrite can ever repair.
  assert.throws(
    () => applyBlock('# BEGIN:ax\norphan\n', { id: 'ax', body: 'x', style: 'hash' }),
    /unterminated managed block "ax"/,
  );
});

test('readBlock reports absence rather than an empty body', () => {
  assert.equal(readBlock('nothing here\n', { id: 'ax', style: 'hash' }), null);
  assert.equal(readBlock('# BEGIN:ax\n# END:ax\n', { id: 'ax', style: 'hash' }), '');
});

test('comment style comes from the filename, and an unknown one is refused', () => {
  assert.equal(styleFor('.gitignore'), 'hash');
  assert.equal(styleFor('AGENTS.md'), 'markdown');
  assert.equal(styleFor('orca.yaml'), 'hash');
  assert.throws(() => styleFor('package.json'), /no managed-block comment style/);
});

test('json edits are structural and idempotent', () => {
  const manifest = { scripts: { dev: 'next dev' } };
  assert.equal(setJsonPath(manifest, 'scripts.ax', './bin/ax'), true);
  assert.equal(setJsonPath(manifest, 'scripts.ax', './bin/ax'), false);
  assert.equal(manifest.scripts.dev, 'next dev');
  assert.equal(getJsonPath(manifest, 'scripts.ax'), './bin/ax');

  assert.equal(setJsonPath(manifest, 'devDependencies.@flosrn/ax', 'github:flosrn/ax#v0.1.2'), true);
  assert.equal(getJsonPath(manifest, 'devDependencies.@flosrn/ax'), 'github:flosrn/ax#v0.1.2');
  assert.equal(getJsonPath(manifest, 'devDependencies.missing'), undefined);
});
