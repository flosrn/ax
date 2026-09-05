// `ax frontier --spec <ref>` — the Spec-scoped Completion read, and the two
// pure vocabularies it stands on (`src/mandate.mjs`, `src/completion.mjs`).
//
// Same discipline as the frontier suite this extends: the repository is a real
// `git init` in a temp dir, `gh` is a fixture dispatcher, the dispatch store is
// a temp directory named through ORCA_DISPATCH_STORE. Offline, no credential.
//
// The scenarios are #191's own acceptance criteria: an empty takeable list with
// an unfinished Spec, an excluded member still visible (including an
// established cycle), an incomplete membership read, an absent mandate
// observation, and established observations while unrelated issues stay open.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { COMMANDS } from '../src/commands.mjs';
import { completionOf, specMembership } from '../src/completion.mjs';
import { frontier } from '../src/frontier.mjs';
import { mandateOf, observationsOf } from '../src/mandate.mjs';

const SLUG = 'gapilabs/gapila';
const READY = 'ready-for-agent';
const FOUND = 'source:agent-found';
const SPEC = 174;

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

let base;
let root;
let store;

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ax-completion-')));
  root = join(base, 'repo');
  store = join(base, 'store');
  mkdirSync(root, { recursive: true });
  mkdirSync(store, { recursive: true });
  execFileSync('git', [...IDENTITY, 'init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({ triage: { provenance: { spec: ['source:roadmap'], inbound: ['source:user-report'], findings: [FOUND] } } }),
  );
});

after(() => rmSync(base, { recursive: true, force: true }));

const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const answer = value => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const failure = (stderr = 'boom', status = 1) => ({ status, stdout: '', stderr });

const MANDATE = [
  'Deployment target: the ax package on this machine',
  'Permitted operations: merge through the repository Gate, install the built bundle',
  'Observation: cli answers — `node bin/ax.mjs frontier --spec 174` prints a receipt',
  'Observation: bundle loads — the OMP suite passes on the merged head',
].join('\n');

/** One member node, in the exact shape the Spec read answers. */
const member = ({ number, title = `T${number}`, state = 'OPEN', stateReason = null, prs = [], prPage = false, repository = SLUG } = {}) => ({
  number,
  title,
  state,
  stateReason,
  repository: { nameWithOwner: repository },
  closedByPullRequestsReferences: {
    nodes: prs.map(([pr, merged, repository = SLUG]) => ({ number: pr, merged, repository: { nameWithOwner: repository } })),
    pageInfo: { hasNextPage: prPage },
  },
});

const comment = (body, login = 'flo') => ({ body, author: { login } });

/**
 * The Spec issue node: body, comments and sub-issues in one answer, with the
 * pagination proofs the read demands.
 */
const specNode = ({
  number = SPEC,
  title = 'Spec: Completion',
  state = 'OPEN',
  body = MANDATE,
  author = 'flo',
  comments = [],
  commentsPage = false,
  members = [],
  membersPage = false,
  totalCount,
} = {}) => ({
  number,
  title,
  state,
  body,
  author: author === null ? null : { login: author },
  comments: { nodes: comments, pageInfo: { hasNextPage: commentsPage } },
  subIssues: {
    totalCount: totalCount ?? members.length,
    nodes: members,
    pageInfo: { hasNextPage: membersPage },
  },
});

const issueRow = (number, title = `T${number}`, labels = [READY]) => ({ number, title, labels: labels.map(name => ({ name })) });

const issueNode = ({ state = 'OPEN', labels = [READY], subIssues = 0, blockers = [] } = {}) => ({
  state,
  lastEditedAt: null,
  labels: { nodes: labels.map(name => ({ name })) },
  subIssues: { totalCount: subIssues },
  blockedBy: {
    nodes: blockers.map(([n, blockerState, repository = SLUG]) => ({ number: n, state: blockerState, repository: { nameWithOwner: repository } })),
    pageInfo: { hasNextPage: false },
  },
  timelineItems: { nodes: [{ label: { name: READY }, actor: { login: 'flo' }, createdAt: '2026-01-01T00:00:00Z' }] },
});

/**
 * The dispatcher. `spec` is the Spec read's answer, `graph` the frontier's
 * aliased candidate nodes, `findings` the label-scoped read of admitted work.
 */
const ghFor = ({
  version = '2.97.0',
  slug = SLUG,
  issues = [],
  graph = {},
  spec = specNode(),
  specOut,
  findings = [],
  findingsFails = false,
  permissions = { flo: 'write' },
} = {}) => {
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === '--version') return answer(`gh version ${version} (2026-01-15)\nhttps://github.com/cli/cli/releases`);
    if (args[0] === 'repo' && args[1] === 'view') return answer(`${slug}\n`);
    if (args[0] === 'issue' && args[1] === 'list') {
      if (args.includes(FOUND)) return findingsFails ? failure('connect: network is unreachable') : answer(findings);
      return answer(issues);
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = String(args.find(arg => arg.startsWith('query=')));
      // The Spec read is the only one that pages comments; the frontier's
      // batched candidate read also says `issue(number:`, aliased per ticket.
      if (/comments\(first:/.test(query)) {
        if (specOut !== undefined) return specOut;
        return answer({ data: { repository: { issue: spec } } });
      }
      return answer({ data: { repository: graph } });
    }
    if (args[0] === 'api' && /collaborators/.test(args[1])) {
      const login = /collaborators\/([^/]+)\/permission/.exec(args[1])[1];
      const permission = permissions[login];
      return permission === undefined ? failure('HTTP 404: Not Found') : answer({ permission });
    }
    throw new Error(`fixture has no answer for: gh ${args.join(' ')}`);
  };
  return { gh, calls };
};

const run = (fixture, argv = ['--spec', String(SPEC)]) => {
  const { gh, calls } = ghFor(fixture);
  const env = { HOME: base, ORCA_DISPATCH_STORE: store };
  const result = capture(() => frontier(argv, { gh, env, cwd: root }));
  return { ...result, calls };
};

// ── The mandate vocabulary ──────────────────────────────────────────────────

test('a mandate is read from the Spec’s own prose: target, operations and its observations', () => {
  const found = mandateOf({ body: MANDATE, comments: [] });
  assert.equal(found.ok, true);
  assert.equal(found.target, 'the ax package on this machine');
  assert.match(found.operations, /^merge through the repository Gate/);
  assert.deepEqual(
    found.observations.map(observation => observation.name),
    ['cli answers', 'bundle loads'],
  );
  assert.equal(found.from, 'the issue body');
  assert.equal(found.by, null);
});

test('a mandate missing any of its three parts is INCOMPLETE, never a partial authorization', () => {
  const missingObservations = mandateOf({ body: 'Deployment target: staging\nPermitted operations: deploy', comments: [] });
  assert.equal(missingObservations.ok, false);
  assert.equal(missingObservations.kind, 'incomplete');
  assert.deepEqual(missingObservations.missing, ['Observation']);

  const missingTarget = mandateOf({ body: 'Permitted operations: deploy\nObservation: a — b', comments: [] });
  assert.equal(missingTarget.kind, 'incomplete');
  assert.deepEqual(missingTarget.missing, ['Deployment target']);
});

test('an unreadable body or comment is UNKNOWN, and an absent mandate is absent (F-028)', () => {
  assert.equal(mandateOf({ body: undefined, comments: [] }).kind, 'unknown');
  assert.equal(mandateOf({ body: 'nothing here', comments: null }).kind, 'unknown');
  assert.equal(mandateOf({ body: 'nothing here', comments: [comment(null)] }).kind, 'unknown');
  assert.equal(mandateOf({ body: 'nothing here', comments: [comment('a plain comment')] }).kind, 'absent');
});

test('a mandate declared twice is AMBIGUOUS: which one authorizes is not inferable', () => {
  const found = mandateOf({ body: MANDATE, comments: [comment(MANDATE)] });
  assert.equal(found.ok, false);
  assert.equal(found.kind, 'ambiguous');
  assert.match(found.why, /two containers/);
});

test('two observations sharing one name are ambiguous — neither could be established alone', () => {
  const found = mandateOf({
    body: 'Deployment target: t\nPermitted operations: o\nObservation: same — a\nObservation: SAME — b',
    comments: [],
  });
  assert.equal(found.kind, 'ambiguous');
  assert.match(found.why, /same/i);
});

test('a comment-borne mandate names the comment and its author', () => {
  const found = mandateOf({ body: 'the spec prose', comments: [comment('unrelated'), comment(MANDATE, 'ops')] });
  assert.equal(found.ok, true);
  assert.equal(found.from, 'comment 2');
  assert.equal(found.by, 'ops');
});

test('observations and named blockers are read from the Spec, each with its author', () => {
  const found = observationsOf({
    body: MANDATE,
    comments: [comment('Observed: cli answers — receipt printed at 12:02'), comment('Blocked: bundle loads — no runner on this host', 'ops')],
  });
  assert.equal(found.ok, true);
  assert.deepEqual(found.observed, [{ name: 'cli answers', display: 'cli answers', evidence: 'receipt printed at 12:02', by: 'flo', from: 'comment 1' }]);
  assert.deepEqual(found.blocked, [{ name: 'bundle loads', display: 'bundle loads', why: 'no runner on this host', by: 'ops', from: 'comment 2' }]);
});

test('an unreadable comment makes the observation read UNKNOWN, not an empty one (F-028)', () => {
  assert.equal(observationsOf({ body: MANDATE, comments: [comment(null)] }).kind, 'unknown');
  assert.equal(observationsOf({ body: MANDATE, comments: undefined }).kind, 'unknown');
});

// ── The pure judgement ──────────────────────────────────────────────────────

const judged = overrides =>
  completionOf({
    spec: { number: SPEC, ref: `${SLUG}#${SPEC}` },
    mandate: mandateOf({ body: MANDATE, comments: [] }),
    mandateAuthority: { ok: true, login: 'flo' },
    members: [],
    necessary: [],
    observed: [],
    blocked: [],
    ...overrides,
  });

/**
 * One recorded observation, with its authority answered — the pure judgement
 * demands that answer rather than defaulting it, so an unread permission can
 * never pass for a proven one (F-028). The `authority: null` case has its own
 * test through the verb.
 */
const observedLine = (name, { by = 'flo', from = 'comment 1', authority = { ok: true } } = {}) => ({
  name,
  display: name,
  evidence: 'the receipt printed',
  by,
  from,
  authority,
});

test('a closed member is satisfied by the pull request that merged it, and by nothing else', () => {
  const verdict = judged({
    members: [member({ number: 1, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })],
    observed: [observedLine('cli answers'), observedLine('bundle loads')],
  });
  assert.equal(verdict.established, true);
  assert.ok(verdict.satisfied.some(entry => /#1 T1/.test(entry.what) && /merged gapilabs\/gapila#20/.test(entry.proof)));
});

test('a member closed NOT_PLANNED is Wave-closure proof and NOT Completion — the Spec stays unfinished', () => {
  const verdict = judged({ members: [member({ number: 3, state: 'CLOSED', stateReason: 'NOT_PLANNED' })] });
  assert.equal(verdict.established, false);
  const entry = verdict.unfinished.find(row => /#3 T3/.test(row.what));
  assert.match(entry.why, /closed NOT_PLANNED/);
  assert.match(entry.why, /Wave closure is not Completion/);
  assert.ok(entry.repair, 'dropping approved work is the operator’s decision, so the line carries its repair');
});


test('a closed member whose state reason nobody could read is unestablished, never a landing', () => {
  const verdict = judged({ members: [member({ number: 4, state: 'CLOSED', stateReason: null })] });
  assert.equal(verdict.established, false);
  assert.ok(verdict.unestablished.some(entry => /#4 T4/.test(entry.what) && /state reason/.test(entry.read)));
});

test('an observation nobody with write permission stated does not satisfy the mandate', () => {
  const verdict = judged({
    observed: [
      observedLine('cli answers', { by: 'drive-by', authority: { ok: false, why: 'drive-by has no write permission' } }),
      observedLine('bundle loads'),
    ],
  });
  assert.equal(verdict.established, false);
  assert.ok(verdict.unfinished.some(entry => /cli answers/.test(entry.what) && /no write permission/.test(entry.why)));
});

test('an Observed line the mandate never declared is a named blocker, never a silent widening', () => {
  const verdict = judged({
    observed: [observedLine('cli answers'), observedLine('bundle loads'), observedLine('shipped to prod', { from: 'comment 3' })],
  });
  assert.equal(verdict.established, false);
  assert.ok(verdict.unfinished.some(entry => /shipped to prod/.test(entry.what) && /outside the mandate/.test(entry.why)));
});

test('an impossible verification is a named blocker carrying its repair, and never satisfies its observation', () => {
  const verdict = judged({
    observed: [observedLine('cli answers')],
    blocked: [{ name: 'bundle loads', display: 'bundle loads', why: 'no runner on this host', by: 'flo', from: 'comment 2' }],
  });
  assert.equal(verdict.established, false);
  const entry = verdict.unfinished.find(row => /bundle loads/.test(row.what));
  assert.match(entry.why, /no runner on this host/);
  assert.ok(entry.repair, 'a named blocker carries its repair');
});

test('a Spec with no member read at all is never established', () => {
  assert.equal(judged({ observed: [observedLine('cli answers'), observedLine('bundle loads')] }).established, false);
});

// ── The verb ────────────────────────────────────────────────────────────────

test('--spec is a declared value flag, so asking the verb for help never runs it', () => {
  const entry = COMMANDS.find(command => command.name === 'frontier');
  assert.ok(
    entry.options.some(([declaration]) => declaration.startsWith('--spec <')),
    '--spec must be declared WITH its value slot, or `ax frontier --spec --help` runs the read',
  );
});

test('--spec refuses a value that is not an issue number', () => {
  const { code, out } = run({}, ['--spec', 'ready-for-agent']);
  assert.equal(code, 2);
  assert.match(out, /--spec/);
});

test('an empty takeable list leaves an unfinished Spec visible in the same receipt (AC5)', () => {
  const { code, out } = run({
    issues: [],
    spec: specNode({ members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] }), member({ number: 176 })] }),
  });
  assert.equal(code, 0);
  assert.match(out, /takeable — 0/);
  assert.match(out, /unfinished — /);
  assert.match(out, /#176 T176 — open/);
  assert.match(out, /NOT ESTABLISHED/);
  assert.match(out, /Wave closure is not Completion/);
});

test('an excluded member — including one in an established cycle — stays visible as unfinished work (AC5)', () => {
  const { code, out } = run({
    issues: [issueRow(176), issueRow(177)],
    graph: {
      i176: issueNode({ blockers: [[177, 'OPEN']] }),
      i177: issueNode({ blockers: [[176, 'OPEN']] }),
    },
    spec: specNode({ members: [member({ number: 176 }), member({ number: 177 })] }),
  });
  assert.equal(code, 0);
  assert.match(out, /excluded — 2/);
  assert.match(out, /#176 T176 — open, excluded: blocked-by-cycle:/);
  assert.match(out, /#177 T177 — open, excluded: blocked-by-cycle:/);
});

test('an incomplete membership read is unestablished, never a shorter Spec (AC2)', () => {
  const truncated = run({ spec: specNode({ members: [member({ number: 175 })], membersPage: true }) });
  assert.equal(truncated.code, 0);
  assert.match(truncated.out, /completion cannot establish — 1/);
  assert.match(truncated.out, /membership/);

  const shortCount = run({ spec: specNode({ members: [member({ number: 175 })], totalCount: 4 }) });
  assert.match(shortCount.out, /completion cannot establish — 1/);
  assert.match(shortCount.out, /4/);
});

test('an absent mandate is a named blocker with its repair, never an implicit authorization (AC1)', () => {
  const { code, out } = run({ spec: specNode({ body: 'A Spec with no mandate.', members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })] }) });
  assert.equal(code, 0);
  assert.match(out, /deployment mandate — absent/);
  assert.match(out, /Deployment target:/);
  assert.match(out, /NOT ESTABLISHED/);
});

test('a declared observation nobody recorded leaves the Spec unfinished (AC1, AC8)', () => {
  const { code, out } = run({
    spec: specNode({
      members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })],
      comments: [comment('Observed: cli answers — receipt printed')],
    }),
  });
  assert.equal(code, 0);
  assert.match(out, /observation "cli answers" — observed by flo/);
  assert.match(out, /observation "bundle loads" — not observed/);
  assert.match(out, /NOT ESTABLISHED/);
});

test('established observations complete the Spec while unrelated issues stay open (AC6, AC8)', () => {
  const { code, out } = run({
    issues: [issueRow(900)],
    graph: { i900: issueNode() },
    spec: specNode({
      members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })],
      comments: [comment('Observed: cli answers — receipt printed'), comment('Observed: bundle loads — 415 tests passed')],
    }),
  });
  assert.equal(code, 0);
  assert.match(out, /takeable — 1/, 'an unrelated ready issue is still takeable');
  assert.match(out, /#900 T900/);
  assert.match(out, /COMPLETION ESTABLISHED/);
});

test('an admitted necessary finding keeps the Spec unfinished after every original ticket closed (AC6)', () => {
  const { code, out } = run({
    spec: specNode({
      members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })],
      comments: [comment('Observed: cli answers — e'), comment('Observed: bundle loads — e')],
    }),
    findings: [
      {
        number: 300,
        title: 'the gate misreads a page',
        state: 'OPEN',
        stateReason: null,
        body: `Necessary for: #${SPEC} — the merge Gate obligation`,
        comments: [],
        closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    ],
  });
  assert.equal(code, 0);
  assert.match(out, /necessary/);
  assert.match(out, /#300 the gate misreads a page — open/);
  assert.match(out, /the merge Gate obligation/);
  assert.match(out, /NOT ESTABLISHED/);
});

test('a finding whose necessity names another Spec is not this Spec’s work', () => {
  const { code, out } = run({
    spec: specNode({
      members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })],
      comments: [comment('Observed: cli answers — e'), comment('Observed: bundle loads — e')],
    }),
    findings: [
      {
        number: 301,
        title: 'someone else’s obligation',
        state: 'OPEN',
        stateReason: null,
        body: 'Necessary for: #99 — another spec',
        comments: [],
        closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    ],
  });
  assert.equal(code, 0);
  assert.doesNotMatch(out, /#301/);
  assert.match(out, /COMPLETION ESTABLISHED/);
});

test('an unreadable admitted-work read is unestablished, never an empty admission list (F-028)', () => {
  const { code, out } = run({
    findingsFails: true,
    spec: specNode({ members: [member({ number: 175, state: 'CLOSED', stateReason: 'COMPLETED', prs: [[20, true]] })] }),
  });
  assert.equal(code, 0);
  assert.match(out, /completion cannot establish/);
  assert.match(out, /admitted necessary work/);
});

test('a Spec the tracker could not answer is cannot-establish at the declaration level', () => {
  const { code, out } = run({ specOut: { status: 1, stdout: '', stderr: 'HTTP 404' } });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH/);
  assert.match(out, new RegExp(`${SPEC}`));
});

test('the read issues no mutation: every gh call is a read', () => {
  const { calls } = run({ spec: specNode({ members: [member({ number: 175 })] }) });
  for (const args of calls) {
    assert.doesNotMatch(args.join(' '), /\b(create|edit|comment|close|reopen|merge|delete|--method (POST|PATCH|PUT|DELETE))\b/);
  }
});

// ── The one membership reader (#195 consumes this; do not add a second) ─────

const membership = fixture => {
  const { gh } = ghFor(fixture);
  return specMembership(SPEC, { run: args => gh(args), slug: SLUG, owner: 'gapilabs', name: 'gapila' });
};

test('specMembership returns repository-qualified identities and a proved-complete page', () => {
  const found = membership({ spec: specNode({ members: [member({ number: 175 }), member({ number: 176, repository: 'other/elsewhere' })] }) });
  assert.equal(found.ok, true);
  assert.equal(found.members.ok, true);
  assert.equal(found.members.total, 2);
  assert.deepEqual(
    found.members.nodes.map(node => ({ repo: node.repo, number: node.number, ref: node.ref })),
    [
      { repo: SLUG, number: 175, ref: `${SLUG}#175` },
      { repo: 'other/elsewhere', number: 176, ref: 'other/elsewhere#176' },
    ],
  );
});

test('a Spec that declares no members is complete with total 0, not a failed read and not an absent Spec', () => {
  const found = membership({ spec: specNode({ members: [] }) });
  assert.equal(found.ok, true);
  assert.equal(found.members.ok, true);
  assert.equal(found.members.total, 0);
  assert.deepEqual(found.members.nodes, []);
});

test('a truncated membership page is members.ok false, not a shorter Spec', () => {
  const found = membership({ spec: specNode({ members: [member({ number: 175 })], membersPage: true }) });
  assert.equal(found.ok, true);
  assert.equal(found.members.ok, false);
  assert.match(found.members.why, /truncated/);
  assert.ok(found.members.repair);
});

test('a failed Spec read is kind unknown; a tracker that answered no issue is kind absent', () => {
  const unread = membership({ specOut: { status: 1, stdout: '', stderr: 'HTTP 502' } });
  assert.equal(unread.ok, false);
  assert.equal(unread.kind, 'unknown');

  const missing = membership({ specOut: { status: 0, stdout: JSON.stringify({ data: { repository: { issue: null } } }), stderr: '' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'absent');
});
