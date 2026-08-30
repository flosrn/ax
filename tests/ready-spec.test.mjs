// The spec a triage child receives, rendered pure: identity and context in,
// one line out. Zero stubs — this is the module's whole point, extracted from
// dispatch() where proving one sentence required a full Orca pipeline fake.

import assert from 'node:assert/strict';
import test from 'node:test';

import { READY_LABEL, REFINE_REMOVED, ROLE_BY_JOB, renderSpec } from '../src/ready/spec.mjs';

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

test('the job vocabulary is the three passes, and the retired lane is not one of them', () => {
  assert.deepEqual(Object.keys(ROLE_BY_JOB), ['triage', 'brief', 'custom']);
  assert.ok(!Object.hasOwn(ROLE_BY_JOB, 'refine'));
});

test('the removal refusal names its reason and its repair, in one shared sentence', () => {
  // Shared by six verbs, so its content is asserted once, here: a caller with
  // the old command in their shell history is owed why the lane went and what
  // to do instead — never a bare list of the three words that remain.
  assert.match(REFINE_REMOVED, /--job refine no longer exists/);
  assert.match(REFINE_REMOVED, /to-tickets` publishes ready-for-agent itself/);
  assert.match(REFINE_REMOVED, /triage is for inbound work only/);
  assert.match(REFINE_REMOVED, /fix it on the ticket/);
});

test('the brief child is told to name ready-for-agent itself, in its own Labels directive', () => {
  // `brief` is the only pass that produces a brief, so it is the only pass that
  // can make an issue agent-grabbable. The label travels through the ordinary
  // directive grammar — never composed by ax — so the instruction and the
  // applied name come from ONE constant and cannot drift.
  const spec = renderSpec({ ...base, job: 'brief' });
  assert.match(spec, /`Labels:` line MUST include `ready-for-agent`/);
  assert.equal(READY_LABEL, 'ready-for-agent');
  assert.ok(spec.includes(READY_LABEL), 'the instruction is built from the shared constant');
  assert.match(spec, /Withhold it only if the brief is not something you would hand an implementer/);
  // No other pass claims it: triage decides categorization, custom reports.
  for (const job of ['triage', 'custom']) {
    assert.ok(!renderSpec({ ...base, job, instruction: 'x' }).includes(READY_LABEL), `${job} does not apply the ready label`);
  }
});

test('a custom spec on a triaged issue opens by forbidding a re-triage', () => {
  const spec = renderSpec({ ...base, job: 'custom', triaged: true, instruction: 'Measure the flaky test.\n' });
  assert.match(spec, /ALREADY had its triage pass/);
  assert.match(spec, /Measure the flaky test\./);
  const untouched = renderSpec({ ...base, job: 'custom', triaged: false, instruction: 'Measure it.' });
  assert.ok(!untouched.includes('ALREADY'));
});
