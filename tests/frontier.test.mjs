// `ax frontier` and its propositions — the receipt is a TRIAD, and every list
// is structurally distinct.
//
// Same discipline as the gate's suite: the repository is a real `git init` in a
// temp dir (repoPaths reads git for real), `gh` is a fixture dispatcher, and the
// dispatch store is a temp directory named through ORCA_DISPATCH_STORE. Offline,
// no tracker credential.
//
// The scenarios are the plan's own (U1, KTD1/KTD2): classification per
// candidate, one named reason per exclusion, and the two rules everything else
// leans on — a failed read is cannot-establish for THAT candidate and never an
// empty answer, and a dead attempt (settled record, ticket still open) stays
// visible as `attempt-ended-unmerged` instead of vanishing from the loop.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { COMMANDS } from '../src/commands.mjs';
import { frontier, ghVersionOf } from '../src/frontier.mjs';
import { requestIdFor } from '../src/worker/dispatch.mjs';

const SLUG = 'gapilabs/gapila';
const READY = 'ready-for-agent';

// ── Sandbox ─────────────────────────────────────────────────────────────────

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

let base;
let root;
let store;

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ax-frontier-')));
  root = join(base, 'repo');
  store = join(base, 'store');
  mkdirSync(root, { recursive: true });
  mkdirSync(store, { recursive: true });
  execFileSync('git', [...IDENTITY, 'init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
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

const LABEL_AT = '2026-01-01T00:00:00Z';

/** One aliased GraphQL issue node, in the exact shape the batched read answers. */
const issueNode = ({
  state = 'OPEN',
  labels = [READY],
  lastEditedAt = null,
  subIssues = 0,
  blockers = [],
  labeler = 'flo',
  labelAt = LABEL_AT,
  labelerEvents,
} = {}) => ({
  state,
  lastEditedAt,
  labels: { nodes: labels.map(name => ({ name })) },
  subIssues: { totalCount: subIssues },
  blockedBy: {
    nodes: blockers.map(([number, state]) => ({ number, state })),
    pageInfo: { hasNextPage: false },
  },
  timelineItems: {
    nodes: labelerEvents ?? (labeler === null ? [] : [{ label: { name: READY }, actor: { login: labeler }, createdAt: labelAt }]),
  },
});

/**
 * The fixture dispatcher. `issues` is the `gh issue list` answer; `graph` the
 * aliased nodes keyed `i<number>`; `permissions` the per-login legacy
 * permission strings.
 */
const ghFor = ({
  version = '2.97.0',
  issues = [],
  graph = {},
  permissions = { flo: 'write' },
  listFails = false,
  graphFails = false,
  graphOut,
} = {}) => {
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === '--version') return answer(`gh version ${version} (2026-01-15)\nhttps://github.com/cli/cli/releases`);
    if (args[0] === 'repo' && args[1] === 'view') return answer(`${SLUG}\n`);
    if (args[0] === 'issue' && args[1] === 'list') return listFails ? failure('connect: network is unreachable') : answer(issues);
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (graphOut !== undefined) return graphOut;
      return graphFails ? failure('502') : answer({ data: { repository: graph } });
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

const issueRow = (number, title = `T${number}`, labels = [READY]) => ({ number, title, labels: labels.map(name => ({ name })) });

const runFrontier = (fixture, argv = []) => {
  const { gh, calls } = ghFor(fixture);
  const env = { HOME: base, ORCA_DISPATCH_STORE: store };
  const result = capture(() => frontier(argv, { gh, env, cwd: root }));
  return { ...result, calls };
};

// ── Registry ────────────────────────────────────────────────────────────────

test('frontier is a registered ungated ORCHESTRATION command with an agent line', () => {
  const entry = COMMANDS.find(command => command.name === 'frontier');
  assert.ok(entry, 'frontier is in the registry');
  assert.equal(entry.section, 'ORCHESTRATION');
  assert.equal(entry.gated, undefined);
  assert.match(entry.agentLine, /ax frontier/);
});

test('ghVersionOf reads the version line and rejects everything else', () => {
  assert.deepEqual(ghVersionOf('gh version 2.97.0 (2026-01-15)'), [2, 97, 0]);
  assert.equal(ghVersionOf('zsh: command not found'), null);
});

// ── Classification ──────────────────────────────────────────────────────────

test('closed blockers are takeable, an open blocker is excluded blocked-by (happy path)', () => {
  const { code, out } = runFrontier({
    issues: [issueRow(10), issueRow(11), issueRow(12)],
    graph: {
      i10: issueNode({ blockers: [[5, 'CLOSED']] }),
      i11: issueNode(),
      i12: issueNode({ blockers: [[5, 'CLOSED'], [6, 'OPEN']] }),
    },
  });
  assert.equal(code, 0);
  assert.match(out, /takeable — 2/);
  assert.match(out, /#10 T10 — blockers #5 all closed/);
  assert.match(out, /#11 T11 — no blockers declared/);
  assert.match(out, /excluded — 1/);
  assert.match(out, /#12 T12 — blocked-by:#6/);
  assert.match(out, /cannot establish — 0/);
});

test('a candidate becomes takeable on the receipt after its last blocker closes (AE1 precondition)', () => {
  const blocked = runFrontier({ issues: [issueRow(20)], graph: { i20: issueNode({ blockers: [[7, 'OPEN']] }) } });
  assert.equal(blocked.code, 0);
  assert.match(blocked.out, /#20 T20 — blocked-by:#7/);

  const freed = runFrontier({ issues: [issueRow(20)], graph: { i20: issueNode({ blockers: [[7, 'CLOSED']] }) } });
  assert.equal(freed.code, 0);
  assert.match(freed.out, /takeable — 1/);
  assert.match(freed.out, /#20 T20 — blockers #7 all closed/);
});

test('a spec parent carrying the ready label is excluded is-spec-parent', () => {
  const { code, out } = runFrontier({ issues: [issueRow(30)], graph: { i30: issueNode({ subIssues: 4 }) } });
  assert.equal(code, 0);
  assert.match(out, /#30 T30 — is-spec-parent/);
  assert.match(out, /takeable — 0/);
});

test('a declared provenance contradiction is excluded provenance-refused', () => {
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ triage: { provenance: { spec: ['source:spec'], inbound: ['source:report'] } } }));
  try {
    const { code, out } = runFrontier({
      issues: [issueRow(40, 'T40', [READY, 'source:spec', 'source:report'])],
      graph: { i40: issueNode() },
    });
    assert.equal(code, 0);
    assert.match(out, /#40 T40 — provenance-refused \(carries source:spec and source:report at once\)/);
  } finally {
    rmSync(join(root, 'ax.config.json'), { force: true });
  }
});

test('an UNSETTLED record is already-dispatched, a settled one on an open ticket is attempt-ended-unmerged — structurally distinct', () => {
  const record = (request, settled) => ({ request, host: 'h', orca: 'orca', createdAt: 'now', attempts: [{ n: 1, settled, phases: [] }] });
  const write = (number, suffix, settled) => {
    const id = requestIdFor(number, suffix);
    writeFileSync(join(store, `${id}.json`), JSON.stringify(record(id, settled)));
  };
  write('50', '', false);
  write('51', 'fix-thing', true);
  // A neighbour's record must not leak across the `<issue>-` boundary: #5 is
  // not #50, and #52's only record is unreadable — an unknown, not a state.
  write('5', '', false);
  writeFileSync(join(store, `${requestIdFor('52', '')}.json`), '{ not json');
  // A record whose `request` does not name its own file, and one whose
  // `settled` is not a boolean: neither says anything about #54 or #55.
  writeFileSync(join(store, `${requestIdFor('54', '')}.json`), JSON.stringify(record('somewhere-else', false)));
  writeFileSync(join(store, `${requestIdFor('55', '')}.json`), JSON.stringify(record(requestIdFor('55', ''), 'true')));
  const { code, out } = runFrontier({
    issues: [issueRow(50), issueRow(51), issueRow(52), issueRow(53), issueRow(54), issueRow(55)],
    graph: { i50: issueNode(), i51: issueNode(), i52: issueNode(), i53: issueNode(), i54: issueNode(), i55: issueNode() },
  });
  assert.equal(code, 0);
  assert.match(out, /#50 T50 — already-dispatched/);
  assert.match(out, /#51 T51 — attempt-ended-unmerged/);
  assert.match(out, /excluded — 2/);
  assert.match(out, /CANNOT ESTABLISH — #52: the dispatch record at .*52-work\.json is unreadable/);
  assert.match(out, /CANNOT ESTABLISH — #54: the dispatch record at .*54-work\.json is unreadable \(dispatch record: 'request' is somewhere-else but the file is named 54-work\)/);
  assert.match(out, /CANNOT ESTABLISH — #55: the dispatch record at .*55-work\.json is unreadable \(last attempt: 'settled' is not a boolean\)/);
  assert.match(out, /cannot establish — 3/);
  assert.match(out, /takeable — 1/);
  assert.match(out, /#53 T53 — no blockers declared/);
});

test('a ready label applied without write permission is excluded untrusted-labeler', () => {
  const { code, out } = runFrontier({
    issues: [issueRow(60)],
    graph: { i60: issueNode({ labeler: 'drive-by' }) },
    permissions: { 'drive-by': 'read' },
  });
  assert.equal(code, 0);
  assert.match(out, /#60 T60 — untrusted-labeler \(drive-by has no write permission\)/);
});

test('a truncated blocker page is cannot-establish naming the truncated read, never a classification', () => {
  const node = issueNode();
  node.blockedBy.pageInfo.hasNextPage = true;
  const { code, out } = runFrontier({ issues: [issueRow(70)], graph: { i70: node } });
  assert.equal(code, 0);
  assert.match(out, /cannot establish — 1/);
  assert.match(out, /CANNOT ESTABLISH — #70: the blocker read for #70 truncated at 50/);
  assert.match(out, /→ .*--json blockedBy/);
});

test('one failed candidate read lands in cannot-establish while the others classify', () => {
  const { code, out } = runFrontier({
    issues: [issueRow(80), issueRow(81)],
    graph: { i80: issueNode({ blockers: [[9, 'CLOSED']] }) }, // i81 absent from the answer
  });
  assert.equal(code, 0);
  assert.match(out, /takeable — 1/);
  assert.match(out, /#80 T80 — blockers #9 all closed/);
  assert.match(out, /CANNOT ESTABLISH — #81: the batched read answered nothing for #81/);
});

// ── Declaration-level inability ─────────────────────────────────────────────

test('gh below 2.97 is exit 3 naming the version and the repair', () => {
  const { code, out } = runFrontier({ version: '2.94.0' });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — gh 2\.94\.0 is below 2\.97/);
  assert.match(out, /→ upgrade gh to ≥ 2\.97/);
  assert.doesNotMatch(out, /takeable/);
});

test('an unreachable tracker is exit 3, never an empty takeable list', () => {
  const { code, out } = runFrontier({ listFails: true });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — 'gh issue list --label ready-for-agent' failed/);
  assert.doesNotMatch(out, /takeable — 0/);
});

test('--dry-run names the reads and issues none of them', () => {
  const { gh } = ghFor({});
  const calls = [];
  const spy = (args, at) => (calls.push(args), gh(args, at));
  const { code, out } = capture(() => frontier(['--dry-run'], { gh: spy, env: { HOME: base, ORCA_DISPATCH_STORE: store }, cwd: root }));
  assert.equal(code, 0);
  assert.match(out, /dry run \(nothing read from the tracker\)/);
  assert.match(out, /would list {4}open issues carrying ready-for-agent/);
  assert.equal(calls.length, 0, 'a dry run issues no gh call');
});

test('an unreadable declared config is exit 3, not a run with guessed vocabulary', () => {
  writeFileSync(join(root, 'ax.config.json'), '{ not json');
  try {
    const { code, out } = runFrontier({});
    assert.equal(code, 3);
    assert.match(out, /CANNOT ESTABLISH — .*not readable JSON/);
  } finally {
    rmSync(join(root, 'ax.config.json'), { force: true });
  }
});

test('an unknown argument is a usage error', () => {
  const { code, out } = runFrontier({}, ['--label']);
  assert.equal(code, 2);
  assert.match(out, /unknown argument "--label"/);
});

test('an empty candidate list is still a receipt — exit 0, three sections, nothing claimed', () => {
  const { code, out } = runFrontier({ issues: [] });
  assert.equal(code, 0);
  assert.match(out, /candidates {2}0 open issue/);
  assert.match(out, /takeable — 0/);
  assert.match(out, /excluded — 0/);
  assert.match(out, /cannot establish — 0/);
});

// ── Truncation, shape and freshness ─────────────────────────────────────────

test('a candidate list filling the cap is exit 3 naming the possibly-truncated read', () => {
  const rows = Array.from({ length: 200 }, (_, index) => issueRow(1000 + index));
  const { code, out, calls } = runFrontier({ issues: rows });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — .*candidate read .*200/);
  assert.match(out, /→ gh issue list --repo gapilabs\/gapila --label ready-for-agent --limit 1000/);
  assert.doesNotMatch(out, /takeable — /);
  const list = calls.find(args => args[0] === 'issue' && args[1] === 'list');
  assert.equal(list[list.indexOf('--limit') + 1], '200', 'the read requests exactly the named cap');
});

test('a candidate list one short of the cap is a normal receipt', () => {
  const rows = Array.from({ length: 199 }, (_, index) => issueRow(1000 + index));
  const { code, out } = runFrontier({ issues: rows });
  assert.equal(code, 0);
  assert.match(out, /candidates {2}199 open issue/);
  assert.doesNotMatch(out, /truncat/);
});

test('a DECLARED provenance mapping of the wrong shape is exit 3, never a silently-off gate', () => {
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ triage: { provenance: { spec: 'source:spec' } } }));
  try {
    const { code, out } = runFrontier({ issues: [issueRow(110)], graph: { i110: issueNode() } });
    assert.equal(code, 3);
    assert.match(out, /CANNOT ESTABLISH — .*triage\.provenance\.spec is not a list of strings/);
    assert.match(out, /→ cat .*ax\.config\.json/);
    assert.doesNotMatch(out, /takeable — /);
  } finally {
    rmSync(join(root, 'ax.config.json'), { force: true });
  }
});

test('a candidate the batched read reports CLOSED is excluded no-longer-open', () => {
  const { code, out } = runFrontier({ issues: [issueRow(120)], graph: { i120: issueNode({ state: 'CLOSED' }) } });
  assert.equal(code, 0);
  assert.match(out, /#120 T120 — no-longer-open/);
  assert.match(out, /takeable — 0/);
});

test('a candidate no longer carrying the ready label is excluded label-removed', () => {
  const { code, out } = runFrontier({ issues: [issueRow(121)], graph: { i121: issueNode({ labels: ['bug'] }) } });
  assert.equal(code, 0);
  assert.match(out, /#121 T121 — label-removed/);
  assert.match(out, /takeable — 0/);
});

test('the ready label is matched case-insensitively on the batched read', () => {
  const { code, out } = runFrontier({ issues: [issueRow(122)], graph: { i122: issueNode({ labels: ['Ready-For-Agent'] }) } });
  assert.equal(code, 0);
  assert.match(out, /takeable — 1/);
});

test('a body edited after the ready label was applied is excluded body-edited-after-label', () => {
  const { code, out } = runFrontier({
    issues: [issueRow(130)],
    graph: { i130: issueNode({ lastEditedAt: '2026-02-01T00:00:00Z' }) },
  });
  assert.equal(code, 0);
  assert.match(out, /#130 T130 — body-edited-after-label/);
  assert.match(out, /takeable — 0/);
});

test('a body edited BEFORE the ready label is takeable, and a never-edited one too', () => {
  const edited = runFrontier({ issues: [issueRow(131)], graph: { i131: issueNode({ lastEditedAt: '2025-12-01T00:00:00Z' }) } });
  assert.equal(edited.code, 0);
  assert.match(edited.out, /takeable — 1/);

  const never = runFrontier({ issues: [issueRow(132)], graph: { i132: issueNode({ lastEditedAt: null }) } });
  assert.equal(never.code, 0);
  assert.match(never.out, /takeable — 1/);
});

test('an unreadable edit or label timestamp is cannot-establish, never a freshness verdict', () => {
  const unreadable = runFrontier({ issues: [issueRow(133)], graph: { i133: issueNode({ lastEditedAt: 'whenever' }) } });
  assert.equal(unreadable.code, 0);
  assert.match(unreadable.out, /CANNOT ESTABLISH — #133: .*edit timestamp/);

  const noLabelAt = runFrontier({ issues: [issueRow(134)], graph: { i134: issueNode({ lastEditedAt: '2026-02-01T00:00:00Z', labelAt: null }) } });
  assert.equal(noLabelAt.code, 0);
  assert.match(noLabelAt.out, /CANNOT ESTABLISH — #134: .*label event/);
});

test('absent or malformed blocker pagination is cannot-establish, never treated as a complete page', () => {
  const missing = issueNode({ blockers: [[9, 'CLOSED']] });
  delete missing.blockedBy.pageInfo;
  const absent = runFrontier({ issues: [issueRow(140)], graph: { i140: missing } });
  assert.equal(absent.code, 0);
  assert.match(absent.out, /cannot establish — 1/);
  assert.match(absent.out, /CANNOT ESTABLISH — #140: .*pagination/);

  const malformed = issueNode({ blockers: [[9, 'CLOSED']] });
  malformed.blockedBy.pageInfo = { hasNextPage: 'false' };
  const wrong = runFrontier({ issues: [issueRow(141)], graph: { i141: malformed } });
  assert.equal(wrong.code, 0);
  assert.match(wrong.out, /CANNOT ESTABLISH — #141: .*pagination/);
});

// ── Partial GraphQL answers ─────────────────────────────────────────────────

test('a partial graphql answer classifies what it carries and cannot-establishes the rest', () => {
  const stdout = JSON.stringify({
    data: { repository: { i150: issueNode({ blockers: [[9, 'CLOSED']] }) } },
    errors: [{ message: 'Something went wrong while executing your query' }],
  });
  const { code, out } = runFrontier({
    issues: [issueRow(150), issueRow(151)],
    graphOut: { status: 1, stdout, stderr: 'gh: Something went wrong while executing your query' },
  });
  assert.equal(code, 0);
  assert.match(out, /answered partially/);
  assert.match(out, /takeable — 1/);
  assert.match(out, /#150 T150 — blockers #9 all closed/);
  assert.match(out, /CANNOT ESTABLISH — #151: the batched read answered nothing for #151/);
});

test('a failed graphql answer carrying no data is still exit 3', () => {
  const { code, out } = runFrontier({
    issues: [issueRow(152)],
    graphOut: { status: 1, stdout: JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), stderr: 'gh: Bad credentials' },
  });
  assert.equal(code, 3);
  assert.match(out, /CANNOT ESTABLISH — the batched blocker read/);
  assert.doesNotMatch(out, /takeable/);
});

// ── Labeler permission ──────────────────────────────────────────────────────

test('a labeler absent from the permission read is cannot-establish, never untrusted-labeler', () => {
  const { code, out } = runFrontier({
    issues: [issueRow(160)],
    graph: { i160: issueNode({ labeler: 'ghost' }) },
    permissions: {},
  });
  assert.equal(code, 0);
  assert.match(out, /CANNOT ESTABLISH — #160: the permission read for ghost failed/);
  assert.match(out, /→ .*collaborators\/ghost\/permission/);
  assert.doesNotMatch(out, /untrusted-labeler/);
  assert.match(out, /excluded — 0/);
});

test("a labeler with 'admin' permission is trusted, 'none' is untrusted-labeler", () => {
  const admin = runFrontier({ issues: [issueRow(161)], graph: { i161: issueNode({ labeler: 'boss' }) }, permissions: { boss: 'admin' } });
  assert.equal(admin.code, 0);
  assert.match(admin.out, /takeable — 1/);

  const none = runFrontier({ issues: [issueRow(162)], graph: { i162: issueNode({ labeler: 'stranger' }) }, permissions: { stranger: 'none' } });
  assert.equal(none.code, 0);
  assert.match(none.out, /#162 T162 — untrusted-labeler \(stranger has no write permission\)/);
});

test('an unattributable ready label is cannot-establish, not a trusted one', () => {
  const { code, out } = runFrontier({ issues: [issueRow(163)], graph: { i163: issueNode({ labeler: null }) } });
  assert.equal(code, 0);
  assert.match(out, /CANNOT ESTABLISH — #163: no labeled event attributes ready-for-agent on #163/);
  assert.match(out, /takeable — 0/);
  assert.match(out, /excluded — 0/);
});
