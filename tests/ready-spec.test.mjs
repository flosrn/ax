// The spec a triage child receives, rendered pure: identity and context in,
// one line out. Zero stubs — this is the module's whole point, extracted from
// dispatch() where proving one sentence required a full Orca pipeline fake.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE_BY_JOB, renderSpec } from '../src/ready/spec.mjs';

const base = {
  model: '@default',
  issue: '41',
  repo: 'gapilabs/gapila',
  draft: '/tmp/drafts/triage-41.md',
  labels: '/tmp/labels.md',
  triaged: false,
  instruction: '',
};

test('the marker names the role the child must prove, from the one shared map', () => {
  for (const job of Object.keys(ROLE_BY_JOB)) {
    const spec = renderSpec({ ...base, job });
    assert.ok(spec.startsWith(`[omp role=${ROLE_BY_JOB[job].role} model=@default]`), `${job} opens on its own role marker`);
  }
});

test('a triage spec carries the label grammar and the mutate-nothing contract', () => {
  const spec = renderSpec({ ...base, job: 'triage' });
  assert.match(spec, /Labels: <name>\[, <name>…\]/);
  assert.match(spec, /write ONLY \/tmp\/drafts\/triage-41\.md/);
  assert.match(spec, /no open question/);
});

test('pass 1 says nothing about redo; pass 2 names the previous draft by path AND fingerprint', () => {
  const first = renderSpec({ ...base, job: 'triage', pass: 1, previous: null });
  assert.ok(!first.includes('PASS'), 'an ordinary dispatch is byte-identical to what it was');

  const second = renderSpec({
    ...base,
    job: 'triage',
    pass: 2,
    previous: { pass: 1, path: '/tmp/drafts/triage-41.md', sha: 'abc123' },
    because: 'the maintainer re-scoped the issue',
  });
  assert.match(second, /This is PASS 2/);
  assert.match(second, /git hash-object abc123/);
  assert.match(second, /WHAT CHANGED SINCE: the maintainer re-scoped the issue/);
});

test('a refine spec names the parent PRD when the precheck read it, and says so when it could not', () => {
  const known = renderSpec({ ...base, job: 'refine', parent: 7 });
  assert.match(known, /a sub-issue of issue:\/\/7/);
  const unknown = renderSpec({ ...base, job: 'refine', parent: undefined });
  assert.match(unknown, /identify its parent PRD from the issue itself/);
});

test('a custom spec on a triaged issue opens by forbidding a re-triage', () => {
  const spec = renderSpec({ ...base, job: 'custom', triaged: true, instruction: 'Measure the flaky test.\n' });
  assert.match(spec, /ALREADY had its triage pass/);
  assert.match(spec, /Measure the flaky test\./);
  const untouched = renderSpec({ ...base, job: 'custom', triaged: false, instruction: 'Measure it.' });
  assert.ok(!untouched.includes('ALREADY'));
});
