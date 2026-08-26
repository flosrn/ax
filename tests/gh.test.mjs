// One repo-slug resolver instead of seven copies. The runner is injected, so
// this stays offline like every consumer's own suite.

import assert from 'node:assert/strict';
import test from 'node:test';

import { repoSlug, repoView } from '../src/gh.mjs';

test('repoSlug trims the first line gh answers', () => {
  const calls = [];
  const gh = args => {
    calls.push(args);
    return { status: 0, stdout: '  gapilabs/gapila\n' };
  };
  assert.equal(repoSlug(gh), 'gapilabs/gapila');
  assert.deepEqual(calls, [['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']]);
});

test('a gh that failed or did not run answers the empty string, never a guess', () => {
  assert.equal(repoSlug(() => ({ status: 1, stdout: '', stderr: 'no remote' })), '');
  assert.equal(repoSlug(() => ({ error: new Error('ENOENT'), status: null })), '');
});

test('repoView carries the failure detail a named inability needs', () => {
  assert.deepEqual(repoView(() => ({ status: 1, stdout: '', stderr: 'HTTP 401: bad credentials\nhint: run gh auth login' })), {
    slug: '',
    detail: 'HTTP 401: bad credentials',
  });
  assert.deepEqual(repoView(() => ({ error: new Error('spawn gh ENOENT'), status: null })), { slug: '', detail: 'spawn gh ENOENT' });
  assert.deepEqual(repoView(() => ({ status: 0, stdout: '\n' })), { slug: '', detail: 'exit 0' }, 'a successful empty answer still names something');
  assert.deepEqual(repoView(() => ({ status: 0, stdout: 'gapilabs/gapila\n' })), { slug: 'gapilabs/gapila', detail: '' });
});
