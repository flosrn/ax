// The #188 verb seam: an admitted finding is not takeable until publication
// applies the ready label, and that publication must keep the birth source.
//
// Dispatch, publish and frontier each have their own suite. Running them
// separately cannot see the transition: a finding that `dispatch` admits is
// invisible to `frontier` until `publish` lands `ready-for-agent`, and a
// draft that adds inbound over the birth finding is refused before the
// frontier can classify a contradiction. This file is one tracker, three
// verbs, observed before/after.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunner } from '../src/orca-bin.mjs';
import { frontier } from '../src/frontier.mjs';
import { dispatch } from '../src/triage/dispatch.mjs';
import { publish } from '../src/triage/publish.mjs';

const REPO = 'acme/widgets';
const READY = 'ready-for-agent';
const FINDING = 'source:agent-found';
const INBOUND = 'source:user-report';
const NECESSITY =
  'Necessary for: #174 — the Gate ground "every check-run page is read" stays unsatisfied while the reader pages once.';
const PROVENANCE = { spec: ['source:roadmap'], inbound: [INBOUND], findings: [FINDING] };
const REPO_LABELS = [
  'category/bug',
  'needs-triage',
  'needs-info',
  FINDING,
  INBOUND,
  'source:roadmap',
  READY,
];

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

const receipt = result => ({ status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });

function fakeOrca() {
  return createRunner({
    bin: 'stub-orca',
    exec: (bin, args) => {
      if (args[0] === 'status') return receipt({ runtime: { reachable: true } });
      if (args.join(' ').startsWith('terminal list')) {
        return receipt({ terminals: [], hostScope: { omittedHostIds: [] } });
      }
      return receipt({});
    },
  });
}

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-seam-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(
    join(root, 'ax.config.json'),
    JSON.stringify({
      project: { name: 'widgets' },
      apps: { web: 'apps/web' },
      vendor: { repo: 'owner/kit' },
      triage: { labels: 'docs/agents/triage-labels.md', provenance: PROVENANCE },
    }),
  );
  mkdirSync(join(root, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(root, 'docs', 'agents', 'triage-labels.md'), '# groups\ncategory, source\n');
  return root;
}

function homeWithPeer() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ax-seam-home-')));
  mkdirSync(join(home, '.omp', 'run', 'orca-peers'), { recursive: true });
  writeFileSync(join(home, '.omp', 'run', 'orca-peers', 'term_me.json'), JSON.stringify({ run: 'run_owner' }));
  return home;
}

/** One issue's tracker row. Mutations from publish are applied here, then frontier reads them. */
function tracker(over = {}) {
  return {
    state: 'OPEN',
    title: 'check-run reader pages once',
    body: NECESSITY,
    comments: [],
    labels: [FINDING, 'needs-triage'],
    parent: null,
    ...over,
  };
}

function jsonFields(args) {
  const index = args.indexOf('--json');
  return index === -1 ? [] : String(args[index + 1] ?? '').split(',');
}

function issueView(issue, fields) {
  const body = {
    state: issue.state,
    title: issue.title,
    comments: issue.comments.map(text => ({ body: text })),
    labels: issue.labels.map(name => ({ name })),
  };
  if (fields.includes('body')) body.body = issue.body;
  if (fields.includes('parent')) body.parent = issue.parent;
  if (fields.includes('updatedAt')) body.updatedAt = '2020-01-01T00:00:00.000Z';
  return { status: 0, stdout: JSON.stringify(body), stderr: '' };
}

function applyEdit(issue, args) {
  const next = [...issue.labels];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--add-label' && args[i + 1]) {
      if (!next.includes(args[i + 1])) next.push(args[i + 1]);
    }
    if (args[i] === '--remove-label' && args[i + 1]) {
      const at = next.indexOf(args[i + 1]);
      if (at !== -1) next.splice(at, 1);
    }
  }
  issue.labels = next;
}

function execFor(issue) {
  const calls = [];
  return {
    calls,
    exec: (bin, args) => {
      calls.push(`${bin} ${args.join(' ')}`);
      if (bin !== 'gh') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: `${REPO}\n`, stderr: '' };
      if (args[0] === 'label' && args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify(REPO_LABELS.map(name => ({ name }))), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') return issueView(issue, jsonFields(args));
      if (args[0] === 'issue' && args[1] === 'edit') {
        applyEdit(issue, args);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'comment') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function frontierGh(issue) {
  const listed = issue.labels.includes(READY)
    ? [{ number: 7, title: issue.title, labels: issue.labels.map(name => ({ name })) }]
    : [];
  const node = {
    state: issue.state,
    lastEditedAt: null,
    labels: { nodes: issue.labels.map(name => ({ name })) },
    subIssues: { totalCount: 0 },
    blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
    timelineItems: {
      nodes: issue.labels.includes(READY)
        ? [{ label: { name: READY }, actor: { login: 'flo' }, createdAt: '2026-01-01T00:00:00Z' }]
        : [],
    },
  };
  return args => {
    if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.97.0 (2026-01-15)\n', stderr: '' };
    if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: `${REPO}\n`, stderr: '' };
    if (args[0] === 'issue' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return { status: 0, stdout: JSON.stringify({ data: { repository: { i7: node } } }), stderr: '' };
    }
    if (args[0] === 'api' && /collaborators/.test(args[1] ?? '')) {
      return { status: 0, stdout: JSON.stringify({ permission: 'write' }), stderr: '' };
    }
    throw new Error(`frontier fixture has no answer for: gh ${args.join(' ')}`);
  };
}

test('an admitted finding reaches the frontier only after publication keeps its birth source', () => {
  const root = repo();
  const home = homeWithPeer();
  const store = join(home, 'store');
  const env = { HOME: home, ORCA_TERMINAL_HANDLE: 'term_me', ORCA_DISPATCH_STORE: store };
  const issue = tracker();
  const gh = execFor(issue);
  const runner = fakeOrca();

  // ── BEFORE: admitted to a Pass, not on the frontier ──────────────────────
  const beforeDispatch = capture(() =>
    dispatch(['--issue', '7', '--dry-run'], {
      runner,
      exec: gh.exec,
      env,
      cwd: root,
      startFn: () => 0,
      proofFn: () => ({
        model: { model: 'claude-opus-5', role: 'default' },
        sessionRole: { status: 'applied', role: 'triage-worker', skills: ['triage'] },
      }),
      now: () => 0,
      sleep: () => {},
    }),
  );
  assert.equal(beforeDispatch.code, 0, beforeDispatch.out);
  assert.match(beforeDispatch.out, /admitted for #174/);
  assert.match(beforeDispatch.out, /source:agent-found/);
  assert.match(beforeDispatch.out, /ax frontier remains the authority/);
  assert.ok(issue.labels.includes(FINDING), 'admission does not relabel the birth source');
  assert.ok(!issue.labels.includes(READY), 'admission does not apply the ready label');

  const beforeFrontier = capture(() => frontier([], { gh: frontierGh(issue), env, cwd: root }));
  assert.equal(beforeFrontier.code, 0, beforeFrontier.out);
  assert.match(beforeFrontier.out, /candidates  0/);
  assert.match(beforeFrontier.out, /takeable — 0/);
  assert.doesNotMatch(beforeFrontier.out, /#7 /);

  // ── a draft that adds inbound over the birth finding is refused; tracker unchanged
  mkdirSync(join(root, '.scratch', 'triage'), { recursive: true });
  writeFileSync(
    join(root, '.scratch', 'triage', 'brief-acme-widgets-7.md'),
    `Labels: ${READY}, ${INBOUND}\nRemove labels: needs-triage\n\nSummary: relabel as inbound.\n`,
  );
  const relabel = capture(() => publish(['--issue', '7', '--job', 'brief'], { exec: gh.exec, env, cwd: root, resolve: () => null }));
  assert.equal(relabel.code, 1, relabel.out);
  assert.match(relabel.out, /source:user-report/);
  assert.match(relabel.out, /source:agent-found/);
  assert.deepEqual(issue.labels, [FINDING, 'needs-triage'], 'a refused publication mutates nothing');

  // ── AFTER: brief publication applies ready-for-agent, keeps the finding
  writeFileSync(
    join(root, '.scratch', 'triage', 'brief-acme-widgets-7.md'),
    `Labels: ${READY}, category/bug\nRemove labels: needs-triage\n\nSummary: page every check-run.\n`,
  );
  const published = capture(() => publish(['--issue', '7', '--job', 'brief'], { exec: gh.exec, env, cwd: root, resolve: () => null }));
  assert.equal(published.code, 0, published.out);
  assert.match(published.out, /makes the issue agent-grabbable/);
  assert.ok(issue.labels.includes(READY), `ready landed: ${issue.labels.join(',')}`);
  assert.ok(issue.labels.includes(FINDING), `birth source kept: ${issue.labels.join(',')}`);
  assert.ok(!issue.labels.includes(INBOUND), 'inbound was not added');
  assert.ok(!issue.labels.includes('needs-triage'), 'needs-triage was removed');

  const afterFrontier = capture(() => frontier([], { gh: frontierGh(issue), env, cwd: root }));
  assert.equal(afterFrontier.code, 0, afterFrontier.out);
  assert.match(afterFrontier.out, /takeable — 1/);
  assert.match(afterFrontier.out, /#7 /);
  assert.doesNotMatch(afterFrontier.out, /provenance-refused/);
});
