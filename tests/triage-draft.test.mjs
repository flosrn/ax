// The draft is the deliverable of a triage session, and the only thing that
// crosses from the child to the human. Three parties derive its path without
// being told: the child writes it, `publish` reads it, and the operator looks at
// it. So the path is a pure function of the dispatch identity — the same
// `--request` the record is already keyed on — and nothing here may invent a
// second naming rule.
//
// Every proposition below is one refusal `publish` owes its caller. The Bash it
// replaces had no draft at all: the child applied labels itself, and the four
// issues of 2026-08-10 landed with three empty label groups each while the
// maintainer did the data entry by hand.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { draftDirFor, draftPath, parseDraft, parseRequest, passesIn, readDraft, requestFor } from '../src/triage/draft.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ax-draft-'));

// ── the identity, which is the record's identity ──────────────────────────────

test('the request names the job, the repo and the issue, in that order', () => {
  // A `brief` run on an issue already dispatched as `triage` must create its own
  // request rather than replay the triage record and re-send its instruction.
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7' }), 'triage-acme-widgets-7');
  assert.equal(requestFor({ job: 'brief', repo: 'acme/widgets', issue: '7' }), 'brief-acme-widgets-7');
});

test('the draft path is the request, under the repo’s own .scratch', () => {
  // `.scratch/` is gitignored, so a draft never reaches a diff — and never a
  // client repo's history. It is work in progress, not a deliverable file.
  assert.equal(draftPath('/w', { job: 'triage', repo: 'acme/widgets', issue: '7' }), '/w/.scratch/triage/triage-acme-widgets-7.md');
});

test('pass 1 is unsuffixed, so every record written before passes existed still resolves', () => {
  // The suffix is append-only: nothing is renamed to make room for pass 2, which
  // is what keeps a status already copied into notes, or a brief already sent,
  // pointing at the file it named.
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7' }), 'triage-acme-widgets-7');
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7', pass: 1 }), 'triage-acme-widgets-7');
  assert.equal(requestFor({ job: 'triage', repo: 'acme/widgets', issue: '7', pass: 2 }), 'triage-acme-widgets-7-p2');
});

// ── the identity, READ BACK: what the mint composes, the proof takes apart ────

test('every legal request one job mints is read back, pass 1 unsuffixed and pass 2 suffixed', () => {
  // The reader that consumed this grammar by hand — `request.split('-').pop()`
  // — read `p2` as the issue number and refused every suffixed pass as naming
  // no issue. So the mint and the reader are proved against each other here:
  // whatever `requestFor` composes for a job and a pass, `parseRequest` names.
  for (const job of ['triage', 'brief', 'custom']) {
    for (const pass of [1, 2, 11]) {
      const request = requestFor({ job, repo: 'acme/widgets', issue: '7', pass });
      assert.deepEqual(parseRequest(request, 'acme/widgets'), { job, issue: '7', pass, problem: '' }, request);
    }
  }
});

test('a repository whose name carries hyphens is not guessed apart from the issue', () => {
  // `owner/ax-tools` slugifies to `owner-ax-tools`, and nothing in the text says
  // where the repository stops. The recorded identity does, which is why it is
  // an argument here rather than something reconstructed from the hyphens.
  assert.deepEqual(parseRequest('triage-flosrn-ax-tools-7-p2', 'flosrn/ax-tools'), { job: 'triage', issue: '7', pass: 2, problem: '' });
  assert.deepEqual(parseRequest('brief-flosrn-ax-tools-190', 'flosrn/ax-tools'), { job: 'brief', issue: '190', pass: 1, problem: '' });
});

test('a job request that does not name the recorded repository is refused BY NAME, never re-read as an implementation', () => {
  // The dangerous direction: a mismatched identity falling through to the
  // implementation rule asks for a merged pull request in the parent checkout
  // and can find one that has nothing to do with this pass.
  const foreign = parseRequest('triage-other-repo-7', 'acme/widgets');
  assert.equal(foreign.job, 'triage');
  assert.match(foreign.problem, /acme\/widgets/);
  const legacy = parseRequest('triage-7', 'acme/widgets');
  assert.equal(legacy.job, 'triage');
  assert.notEqual(legacy.problem, '');
  const ragged = parseRequest('triage-acme-widgets-7-p2-again', 'acme/widgets');
  assert.equal(ragged.job, 'triage');
  assert.notEqual(ragged.problem, '');
  // A record naming no repository establishes no identity to read against.
  assert.notEqual(parseRequest('triage-acme-widgets-7', '').problem, '');
});

test('an implementation request names no triage job, and says so rather than a problem', () => {
  for (const request of ['178-release-pass-proof', 'ws-merged', 'feat-triage-loop', 'custom-migration', 'custom-migration-2025', 'custom-one-two-three']) {
    assert.deepEqual(parseRequest(request, 'acme/widgets'), { job: null, issue: '', pass: 0, problem: '' }, request);
  }
});

test('the passes present in a directory are found, oldest first, whatever order the disk lists them', () => {
  const dir = scratch();
  for (const name of ['triage-acme-widgets-7-p3.json', 'triage-acme-widgets-7.json', 'triage-acme-widgets-7-p2.json']) {
    writeFileSync(join(dir, name), '{}');
  }
  assert.deepEqual(passesIn(dir, { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), [1, 2, 3]);
});

test('a neighbouring issue, job or extension is not a pass of this one', () => {
  // `…-7` is a prefix of `…-70`, and that near-miss would report a pass that
  // belongs to another ticket — then refuse a fresh dispatch on a collision that
  // does not exist.
  const dir = scratch();
  for (const name of ['triage-acme-widgets-70.json', 'brief-acme-widgets-7.json', 'triage-acme-widgets-7.md', 'triage-acme-widgets-7-p2.json']) {
    writeFileSync(join(dir, name), '{}');
  }
  assert.deepEqual(passesIn(dir, { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), [2]);
});

test('a directory that cannot be read has no passes, because a first run has none', () => {
  assert.deepEqual(passesIn(join(scratch(), 'never'), { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), []);
});

test('`-p1` is ignored rather than folded into pass 1, because one pass has one path', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'triage-acme-widgets-7-p1.json'), '{}');
  writeFileSync(join(dir, 'triage-acme-widgets-7-px.json'), '{}');
  assert.deepEqual(passesIn(dir, { job: 'triage', repo: 'acme/widgets', issue: '7' }, '.json'), []);
});

// ── what a draft has to say to be publishable ────────────────────────────────

test('a draft names its labels on one line per group, and publish applies exactly those', () => {
  // ax cannot require "five groups": `category, priority, complexity, source,
  // domains` is one project's vocabulary, declared in its own docs. What ax
  // knows is weaker and true everywhere — a draft names labels, or it names none.
  const draft = parseDraft(['Labels: category/bug, priority/P2', 'Labels: domains/api', '', '## Verdict', 'It reproduces.'].join('\n'));
  assert.deepEqual(draft.labels, ['category/bug', 'priority/P2', 'domains/api']);
  assert.equal(draft.body, '## Verdict\nIt reproduces.');
});

test('a draft that names no label cannot be published', () => {
  const draft = parseDraft('## Verdict\nLooks fine to me.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /names no label/);
});

test('a draft with labels and no body cannot be published either', () => {
  // The comment IS the artifact a human reads later. A label set alone is data
  // entry with no reasoning attached, which is what the label groups were
  // supposed to stop being.
  const draft = parseDraft('Labels: category/bug\n\n\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /names no verdict/);
});

test('the same label named twice is applied once, in first-seen order', () => {
  const draft = parseDraft('Labels: category/bug, priority/P2\nLabels: priority/P2, category/bug\n\nWhy.\n');
  assert.deepEqual(draft.labels, ['category/bug', 'priority/P2']);
});

test('a label line with an empty entry is a refusal, not a silently dropped label', () => {
  // A trailing comma is how a hand-edited draft loses a group without saying so.
  const draft = parseDraft('Labels: category/bug, , priority/P2\n\nWhy.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /empty label/);
});

test('a close verdict is read, and carried as a refusal to close', () => {
  // The child may conclude wontfix. Publish escalates it — it never closes an
  // issue, because closing is the one gesture a human owes the reporter.
  const draft = parseDraft('Labels: category/enhancement, state/wontfix\nClose: yes\n\nAlready built.\n');
  assert.equal(draft.ok, true);
  assert.equal(draft.close, true);
});

// ── the questions a child leaves open ────────────────────────────────────────

test('a question is collected AND left in the body, because the human reads it on the issue', () => {
  // The one directive that is not consumed. Measured 2026-08-22: three children
  // asked in three layouts ("What we still need from you", a/b/c sub-points,
  // inline forks), so answering them meant a bespoke markdown edit per ticket.
  // The number makes a ruling addressable; staying in the body is what keeps the
  // escalation visible to the person who has to answer it.
  const draft = parseDraft(
    ['Labels: state/needs-info', '', 'Two rulings are missing.', 'Q1: Does the audit event carry the actor id?', 'Q2: Is the 500 cap a floor or a ceiling?'].join('\n'),
  );
  assert.equal(draft.ok, true);
  assert.deepEqual(
    draft.questions,
    [
      { n: 1, text: 'Does the audit event carry the actor id?' },
      { n: 2, text: 'Is the 500 cap a floor or a ceiling?' },
    ],
  );
  assert.match(draft.body, /Q1: Does the audit event carry the actor id\?/);
  assert.match(draft.body, /Q2: Is the 500 cap a floor or a ceiling\?/);
});

test('an empty question is refused — an empty ask cannot be answered', () => {
  const draft = parseDraft('Labels: state/needs-info\n\nQ1:\n\nSomething is missing.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /carries no question/);
});

test('two questions on one number are refused, because a ruling could reach neither', () => {
  const draft = parseDraft('Labels: state/needs-info\n\nQ1: First?\nQ1: Second?\n\nBoth open.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /numbered Q1/);
});

test('questions that skip a number are refused, because answers are paired by number', () => {
  // `Q1, Q3` reads as three asks with one lost, or two asks misnumbered, and the
  // difference decides whether a ruling lands on the right question.
  const draft = parseDraft('Labels: state/needs-info\n\nQ1: First?\nQ3: Third?\n\nTwo open.\n');
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /1, 3/);
  assert.match(draft.reason, /run 1\.\.2 in order/);
});

test('a draft that asks nothing carries an empty question list, not an absent one', () => {
  // Callers read `.questions` unconditionally; an undefined here would be a
  // crash on the ordinary case.
  assert.deepEqual(parseDraft('Labels: category/bug\n\nIt reproduces.\n').questions, []);
});

// ── reading one off disk ─────────────────────────────────────────────────────

test('a draft that was never written is named as missing, with the path the child owed', () => {
  const root = scratch();
  const found = readDraft(root, { job: 'triage', repo: 'acme/widgets', issue: '7' });
  assert.equal(found.ok, false);
  assert.match(found.reason, /\.scratch\/triage\/triage-acme-widgets-7\.md/);
  assert.match(found.reason, /nothing to publish/);
});

test('a draft is read with its own path attached, so a refusal can name the file to fix', () => {
  const root = scratch();
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md'), 'Labels: category/bug\n\nIt reproduces.\n');
  const found = readDraft(root, { job: 'triage', repo: 'acme/widgets', issue: '7' });
  assert.equal(found.ok, true);
  assert.deepEqual(found.labels, ['category/bug']);
  assert.equal(found.path, join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md'));
});

test('a draft carries git’s own fingerprint, so an operator can re-check the version they hold', () => {
  // `git hash-object`, not an invented digest: an orchestrator reads a draft,
  // decides against it, and the child that owns it may rewrite it meanwhile.
  // Measured 2026-08-22: #54 went from 106 to 117 lines after its own peer
  // report, with no signal, and every anchor taken against it was stale. A
  // fingerprint only helps if it can be verified with a command already trusted,
  // so this asserts against real `git hash-object` rather than against itself.
  const root = scratch();
  const body = 'Labels: state/needs-info\n\nQ1: Floor or ceiling?\n';
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  const path = join(root, '.scratch', 'triage', 'triage-acme-widgets-7.md');
  writeFileSync(path, body);

  const found = readDraft(root, { job: 'triage', repo: 'acme/widgets', issue: '7' });
  const git = execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();
  assert.equal(found.sha, git);
  assert.equal(found.lines, body.split('\n').length);
  assert.equal(found.questions.length, 1);
});

test('a draft that does not exist has no fingerprint, rather than a fingerprint of nothing', () => {
  // The empty string is what `status` reads to decide between "no draft yet" and
  // "this exact draft" — a hash of `''` would be a real-looking answer to a
  // question nobody could ask.
  const found = readDraft(scratch(), { job: 'triage', repo: 'acme/widgets', issue: '7' });
  assert.equal(found.sha, '');
  assert.equal(found.lines, 0);
});

// ── one directory, one grammar ───────────────────────────────────────────────
// The readiness lane took its `Ready: yes|no` / `## Agent Brief` /
// `## Verification` grammar and its own `.scratch/refine/` with it. What is
// asserted here is that nothing survived halfway: there is one grammar, one
// directory derived from the root alone, and no verdict field left for a caller
// to branch on.

test('the drafts of every job live in one directory, derived from the root alone', () => {
  assert.equal(draftDirFor('/repo'), join('/repo', '.scratch', 'triage'));
  for (const job of ['triage', 'brief', 'custom']) {
    assert.equal(
      draftPath('/repo', { job, repo: 'acme/widgets', issue: '7' }),
      join('/repo', '.scratch', 'triage', `${job}-acme-widgets-7.md`),
      `${job} keeps its request id inside the shared directory`,
    );
  }
});

test('a leftover .scratch/refine/ is inert — it is never read, and reading the real dir does not trip over it', () => {
  // No migration code, on purpose: a draft is a transient per-machine artifact.
  // What must hold is that an old directory left behind by a previous version
  // costs nothing — `passesIn` and `readDraft` answer off the one directory.
  const root = scratch();
  mkdirSync(join(root, '.scratch', 'refine'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'refine', 'refine-acme-widgets-7.md'), 'Ready: yes\n\n## Agent Brief\n\nStale.\n');
  const identity = { job: 'triage', repo: 'acme/widgets', issue: '7' };
  assert.deepEqual(passesIn(draftDirFor(root), identity, '.md'), []);
  const found = readDraft(root, identity);
  assert.equal(found.ok, false);
  assert.match(found.reason, /\.scratch\/triage\/triage-acme-widgets-7\.md/);
});

test('a parse result carries no readiness verdict — the only grammar left says publishable or why not', () => {
  // `status` used to render a third row, NOT-READY, off a `ready` field only the
  // retired grammar set. A field no producer writes is a branch that can only
  // ever be dead, so both went.
  const publishable = parseDraft('Labels: category/bug\n\nIt reproduces.\n');
  assert.equal(publishable.ok, true);
  assert.ok(!('ready' in publishable));
  const refused = parseDraft('Ready: yes\n\n## Agent Brief\n\nWire the widget.\n\n## Verification\n\nG3 pass.\n');
  assert.equal(refused.ok, false, 'the readiness grammar is no grammar at all now');
  assert.match(refused.reason, /names no label/);
  assert.ok(!('ready' in refused));
});
