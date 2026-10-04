import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { reportGround } from '../src/pr/report.mjs';
import { gate } from '../src/pr-gate.mjs';

const SLUG = 'owner/project';
const CRITERIA = ['The command returns the observed value.', 'The preview leaves the host unchanged.'];
const body = criteria => `## Acceptance criteria\n${criteria.map(text => `- [ ] ${text}`).join('\n')}\n\n## Non-goals\nNo apply.\n`;
const reportText = rows => `## CRITERIA\n\n\`\`\`ax-report-v1\n${JSON.stringify({ repo: SLUG, issue: 12, criteria: rows }, null, 2)}\n\`\`\`\n\n## LEARNINGS\nNone.\n`;
const evidence = () => CRITERIA.map(criterion => ({ criterion, status: 'MET', evidence: { command: 'node bin/ax.mjs preview', observed: 'value=42; host receipt unchanged' } }));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ax-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => {
    try { return { status: 0, stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (error) { return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  };
  assert.equal(git(['init', '-q', '-b', 'main']).status, 0);
  writeFileSync(join(root, 'ax.config.json'), JSON.stringify({ project: { name: 'fixture' }, prGate: { checks: ['tests'], report: true } }));
  git(['add', 'ax.config.json']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).stdout.trim();
  git(['checkout', '-qb', 'feat/12-work']);
  git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'implementation']);
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const store = join(root, 'store');
  mkdirSync(store);
  const path = join(root, '.scratch', 'report', '12-work.md');
  mkdirSync(join(root, '.scratch', 'report'), { recursive: true });
  writeFileSync(path, reportText(evidence()));
  writeFileSync(join(store, '12-work.json'), JSON.stringify({ request: '12-work', host: hostname(), repo: SLUG, kind: 'implementation', attempts: [{ n: 1, phases: [{ name: 'worker-start', argv: ['orchestration', 'worker-start', '--worktree', `path:${root}`], receipt: { result: { effects: [{ kind: 'worktree', path: root, id: `repo::${root}` }] } } }] }] }));
  let assignment = body(CRITERIA);
  let comments = [];
  let permissions = {};
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 12, body: assignment, url: `https://github.com/${SLUG}/issues/12` }) };
    if (args[0] === 'api' && args[1].includes('/issues/12/comments')) {
      const page = Number(/[?&]page=([0-9]+)/.exec(args[1])[1]);
      const answer = typeof comments === 'function' ? comments(page) : page === 1 ? comments : [];
      return Array.isArray(answer) ? { status: 0, stdout: JSON.stringify(answer) } : answer;
    }
    if (args[0] === 'api' && args[1].includes('/collaborators/')) {
      const login = decodeURIComponent(/collaborators\/([^/]+)\/permission/.exec(args[1])[1]);
      const permission = Object.hasOwn(permissions, login) ? permissions[login] : 'write';
      return permission === null ? { status: 1, stderr: 'permission unreadable' } : { status: 0, stdout: JSON.stringify({ permission }) };
    }
    return { status: 1, stderr: `unstubbed ${args.join(' ')}` };
  };
  const input = { run, root, store, slug: SLUG, pr: '19', sha, baseCommit: base, binding: { ok: true, issue: 12, source: '--issue' }, branch: 'feat/12-work', adopted: true, accepted: '', reason: '', release: { ok: false } };
  return { root, path, input, git, calls, setBody: value => { assignment = value; }, setComments: value => { comments = value; }, setPermissions: value => { permissions = value; } };
}

const HEX = /^[0-9a-f]{64}$/;
const STAMP = { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
const ordinary = id => ({ id, body: 'An ordinary comment.', user: { login: 'someone' }, ...STAMP });
const brief = ({ id, pass = 2, login = 'maintainer', criteria, marker = `<!-- ax:publication job=brief repo=${SLUG} issue=12 pass=${pass} -->` }) => ({ id, body: `${marker}\n${body(criteria)}`, user: { login }, ...STAMP });
const noted = result => result.notes.map(row => row.message);
const rowsNoted = result => noted(result).flatMap(message => { const hit = /^acceptance: criterion [0-9]+\/[0-9]+ (.*)$/.exec(message); return hit ? [JSON.parse(hit[1])] : []; });
const criteriaNoted = result => { const hit = noted(result).map(message => /^acceptance: criteria from .*?: (\[.*\])$/.exec(message)).find(Boolean); return hit ? JSON.parse(hit[1]) : undefined; };
const addressNoted = result => { const hit = noted(result).map(message => /^acceptance: raw Report (".*") on (.*)$/.exec(message)).find(Boolean); return hit ? { path: JSON.parse(hit[1]), where: hit[2] } : undefined; };

const messages = result => [...result.refusals, ...result.unknowns].map(row => row.message).join('\n');

test('a complete Report requires explicit judgment of its current evidence digest', t => {
  const { input } = fixture(t);
  const detector = reportGround(input);
  assert.match(detector.digest, /^[0-9a-f]{64}$/);
  assert.match(messages(detector), /accept.*judgment|judgment.*absent/i);
  const accepted = reportGround({ ...input, accepted: detector.digest, reason: 'Inspected preview output and unchanged host receipt against both criteria.' });
  assert.deepEqual(accepted.refusals, []);
  assert.deepEqual(accepted.unknowns, []);
});

test('omitted, added, reordered and paraphrased criteria cannot acquire a passing judgment', t => {
  const { input, path } = fixture(t);
  const variants = [evidence().slice(0, 1), [...evidence(), { ...evidence()[0], criterion: 'A new criterion.' }], evidence().reverse(), evidence().map((row, index) => index === 0 ? { ...row, criterion: 'The tests pass.' } : row)];
  for (const rows of variants) {
    writeFileSync(path, reportText(rows));
    const result = reportGround(input);
    assert.ok(result.refusals.length > 0, messages(result));
    assert.equal(result.digest, undefined);
  }
});

test('unmet or unobserved evidence refuses even when the caller supplies acceptance', t => {
  const { input, path } = fixture(t);
  for (const row of [{ ...evidence()[0], status: 'NOT MET' }, { ...evidence()[0], evidence: { command: 'node preview', observed: '' } }, { ...evidence()[0], evidence: { observed: 'Passed' } }]) {
    writeFileSync(path, reportText([row, evidence()[1]]));
    const result = reportGround({ ...input, accepted: 'a'.repeat(64), reason: 'Reviewed' });
    assert.ok(result.refusals.length > 0, messages(result));
    assert.equal(result.digest, undefined);
  }
});

test('Report, assignment, head and base changes each invalidate the judgment', t => {
  const f = fixture(t);
  const original = reportGround(f.input).digest;
  const approved = { ...f.input, accepted: original, reason: 'Observed both criteria.' };
  writeFileSync(f.path, reportText(evidence()) + '\nUpdated learnings.\n');
  assert.match(messages(reportGround(approved)), /digest|changed|stale/i);
  writeFileSync(f.path, reportText(evidence()));
  f.setBody(body(CRITERIA) + '\nAmended scope.\n');
  assert.match(messages(reportGround(approved)), /digest|changed|stale/i);
  f.setBody(body(CRITERIA));
  assert.match(messages(reportGround({ ...approved, sha: 'b'.repeat(40) })), /digest|changed|stale/i);
  assert.match(messages(reportGround({ ...approved, baseCommit: 'c'.repeat(40) })), /digest|changed|stale/i);
});

test('unadopted and classified release PRs do not acquire a new Report requirement', t => {
  const { input } = fixture(t);
  for (const over of [{ adopted: false }, { release: { ok: true } }]) {
    const result = reportGround({ ...input, ...over });
    assert.deepEqual(result.refusals, []);
    assert.deepEqual(result.unknowns, []);
  }
});

function mergeHarness(f, { onThreads = () => {} } = {}) {
  const calls = [];
  const state = { failedCi: false };
  const run = args => {
    calls.push(args);
    if (args[0] === 'repo') return { status: 0, stdout: args.includes('defaultBranchRef') ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : `${SLUG}\n` };
    if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 19, state: args.includes('state,mergeCommit,body,title') ? 'MERGED' : 'OPEN', mergeCommit: { oid: f.input.sha }, headRefOid: f.input.sha, headRefName: f.input.branch, baseRefName: 'main', body: 'Closes #12', title: 'fix: preview', createdAt: '2026-10-01T00:00:00Z', mergeStateStatus: 'CLEAN', author: { login: 'worker' }, labels: [] }) };
    if (args[0] === 'pr' && args[1] === 'merge') return { status: 0, stdout: 'merged' };
    if (args[0] === 'api' && args[1].includes('/check-runs')) return { status: 0, stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'tests', status: 'completed', conclusion: state.failedCi ? 'failure' : 'success' }] }) };
    if (args[0] === 'api' && args[1] === 'graphql') {
      onThreads();
      return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }) };
    }
    if (args[0] === 'api' && args[1].includes('/pulls/')) return { status: 0, stdout: '[]' };
    if (args[0] === 'api' && args[1] === `repos/${SLUG}`) return { status: 0, stdout: JSON.stringify({ squash_merge_commit_message: 'PR_BODY', squash_merge_commit_title: 'PR_TITLE', merge_commit_title: 'MERGE_MESSAGE', merge_commit_message: 'PR_BODY', allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false }) };
    if (args[0] === 'issue' && args.includes('state')) return { status: 0, stdout: '{"state":"CLOSED"}' };
    return f.input.run(args);
  };
  const deps = { gh: run, git: args => f.git(args), cwd: f.root, env: { HOME: f.root, ORCA_DISPATCH_STORE: f.input.store }, sleep: () => {} };
  const capture = fn => { const original = process.stdout.write; const out = []; process.stdout.write = chunk => { out.push(String(chunk)); return true; }; try { return { code: fn(), out: out.join('') }; } finally { process.stdout.write = original; } };
  return { calls, state, deps, gate: argv => capture(() => gate(argv, deps)) };
}

test('an adopted merge runs all grounds but never merges without acceptance or with failed CI', t => {
  const f = fixture(t);
  const { calls, state, gate: runGate } = mergeHarness(f);
  const argv = ['--pr', '19', '--issue', '12', '--merge'];
  assert.equal(runGate(argv).code, 1);
  assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
  assert.ok(calls.some(args => args[0] === 'api' && args[1] === 'graphql'), 'the acceptance refusal does not suppress reviews');
  const digest = reportGround(f.input).digest;
  const approved = [...argv, '--accept-report', digest, '--reason', 'Inspected observed preview value and unchanged host receipt.'];
  state.failedCi = true;
  assert.equal(runGate(approved).code, 1);
  assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
  state.failedCi = false;
  assert.equal(runGate(approved).code, 0);
  const merge = calls.find(args => args[0] === 'pr' && args[1] === 'merge');
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], f.input.sha);
});

test('a Report rewrite or assignment edit after the acceptance read refuses the merge under the lock', t => {
  const rewritten = [{ ...evidence()[0], evidence: { command: 'node bin/ax.mjs preview', observed: 'value=43 after rewrite' } }, evidence()[1]];
  for (const change of ['unmet', 'rewrite', 'assignment']) {
    const f = fixture(t);
    const digest = reportGround(f.input).digest;
    let armed = true;
    const { calls, gate: runGate } = mergeHarness(f, {
      onThreads: () => {
        if (!armed) return;
        armed = false;
        if (change === 'unmet') writeFileSync(f.path, reportText([{ ...evidence()[0], status: 'NOT MET' }, evidence()[1]]));
        else if (change === 'rewrite') writeFileSync(f.path, reportText(rewritten));
        else f.setBody(body(CRITERIA) + '\nAmended scope.\n');
      },
    });
    const { code, out } = runGate(['--pr', '19', '--issue', '12', '--merge', '--accept-report', digest, '--reason', 'Inspected both criteria.']);
    assert.equal(code, 1, `${change}: ${out}`);
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false, change);
    assert.match(out, /acceptance changed[\s\S]*merge lock[\s\S]*no merge was issued/, change);
    assert.equal(existsSync(join(f.input.store, 'merge', 'merge-owner-project-19.json')), false, `${change}: nothing journalled`);
    const reread = out.slice(out.indexOf('acceptance re-read under the merge lock'));
    assert.match(reread, /criteria from ticket #12 body/, `${change}: current criteria shown`);
    if (change === 'unmet') assert.match(reread, /criterion 1 is NOT MET/);
    else {
      const fresh = reportGround(f.input).digest;
      assert.notEqual(fresh, digest);
      assert.ok(reread.includes(`digest ${fresh}`), `${change}: new digest shown`);
      if (change === 'rewrite') assert.match(reread, /value=43 after rewrite/);
    }
  }
});

test('an attributed authorized Brief supersedes body criteria and an unread permission fails closed', t => {
  const f = fixture(t);
  const changed = ['Inspect the deployed value, not just tests.'];
  f.setComments([{ id: 7, body: `<!-- ax:publication job=brief repo=${SLUG} issue=12 pass=2 -->\n${body(changed)}`, user: { login: 'maintainer' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }]);
  assert.match(messages(reportGround(f.input)), /criterion count/);
  writeFileSync(f.path, reportText([{ criterion: changed[0], status: 'MET', evidence: { artifact: 'deployed receipt', observed: 'value=42' } }]));
  assert.match(reportGround(f.input).digest, /^[0-9a-f]{64}$/);
  const run = args => args[0] === 'api' && args[1].includes('/collaborators/') ? { status: 1, stderr: 'permission unreadable' } : f.input.run(args);
  const unread = reportGround({ ...f.input, run });
  assert.equal(unread.digest, undefined);
  assert.match(messages(unread), /permission.*unreadable/);
});

test('criteria extraction accepts bold checkbox lists and preserves wrapped content', t => {
  const f = fixture(t);
  f.setBody('**Acceptance criteria:**\n- [ ] Verify the value\n  on the installed host.\n- Preserve its receipt.\n\n**Non-goals:**\nNo apply.');
  writeFileSync(f.path, reportText([{ criterion: 'Verify the value\non the installed host.', status: 'MET', evidence: { artifact: 'host value', observed: '42' } }, { criterion: 'Preserve its receipt.', status: 'MET', evidence: { artifact: 'receipt', observed: 'unchanged sha' } }]));
  assert.match(reportGround(f.input).digest, /^[0-9a-f]{64}$/);
  f.setBody(body(CRITERIA) + body(CRITERIA));
  assert.equal(reportGround(f.input).digest, undefined);
});

test('a record without --on cannot authorize reading another machine local impostor', t => {
  const f = fixture(t);
  const file = join(f.input.store, '12-work.json');
  const rec = JSON.parse(readFileSync(file));
  rec.host = 'another-machine';
  writeFileSync(file, JSON.stringify(rec));
  const result = reportGround(f.input);
  assert.equal(result.digest, undefined);
  assert.match(messages(result), /host|machine/);
});

test('escaped, incomplete and ambiguous derived Reports never authorize acceptance', t => {
  const f = fixture(t);
  rmSync(f.path);
  const outside = join(f.root, '..', `${f.root.split('/').at(-1)}-outside.md`);
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(outside, reportText(evidence()));
  symlinkSync(outside, f.path);
  assert.match(messages(reportGround(f.input)), /escape/);
  rmSync(f.path);
  writeFileSync(f.path, reportText(evidence()) + 'x'.repeat(17 * 1024));
  assert.equal(reportGround(f.input).digest, undefined);
  assert.match(messages(reportGround(f.input)), /bound/);
  writeFileSync(f.path, reportText(evidence()));
  const original = JSON.parse(readFileSync(join(f.input.store, '12-work.json')));
  const second = { ...original, request: '12-other' };
  writeFileSync(join(f.input.store, '12-other.json'), JSON.stringify(second));
  assert.match(messages(reportGround(f.input)), /2 dispatch records/);
});

test('an unrelated or legacy record that cannot claim this PR never blocks it; a matching or unreadable one stays unknown', t => {
  const f = fixture(t);
  const file = name => join(f.input.store, `${name}.json`);
  const write = (name, rec) => writeFileSync(file(name), typeof rec === 'string' ? rec : JSON.stringify(rec));
  const original = readFileSync(file('12-work'), 'utf8');
  const taskCreateOnly = { attempts: [{ n: 1, phases: [{ name: 'task-create' }] }] };
  write('40-other', { request: '40-other', host: hostname(), repo: SLUG, kind: 'implementation', ...taskCreateOnly });
  write('41-legacy', { request: '41-legacy', host: hostname(), attempts: [{ n: 1, phases: [{ name: 'worker-start', argv: ['orchestration', 'worker-start', '--worktree', `path:${join(f.root, 'gone')}`] }] }] });
  write('42-legacy', { request: '42-legacy', host: hostname(), ...taskCreateOnly });
  assert.match(reportGround(f.input).digest ?? '', HEX, messages(reportGround(f.input)));

  write('12-work', { ...JSON.parse(original), ...taskCreateOnly });
  const matching = reportGround(f.input);
  assert.equal(matching.digest, undefined);
  assert.match(messages(matching), /worker-start/);
  const { repo, ...legacy } = JSON.parse(original);
  assert.equal(repo, SLUG);
  write('12-work', legacy);
  const legacyTarget = reportGround(f.input);
  assert.equal(legacyTarget.digest, undefined);
  assert.match(messages(legacyTarget), /repository is absent/);
  write('12-work', original);

  for (const [name, rec, pattern] of [
    ['43-bad', { request: '43-other', repo: SLUG, ...taskCreateOnly }, /filename/],
    ['44-bad', { request: '44-bad', repo: SLUG, attempts: 'unreadable' }, /attempts or phases/],
    ['45-bad', '{', /cannot read/],
    ['46-legacy', { request: '46-legacy', host: hostname(), attempts: JSON.parse(original).attempts }, /repository is absent/],
  ]) {
    write(name, rec);
    const result = reportGround(f.input);
    assert.equal(result.digest, undefined, name);
    assert.match(messages(result), pattern, name);
    rmSync(file(name));
  }
});

test('an explicit --on here placement is local; another host never claims this checkout', t => {
  const f = fixture(t);
  const file = join(f.input.store, '12-work.json');
  const rec = JSON.parse(readFileSync(file));
  const placed = on => { rec.attempts[0].phases[0].argv = ['orchestration', 'worker-start', ...on, '--worktree', `path:${f.root}`]; writeFileSync(file, JSON.stringify(rec)); };
  const elsewhere = { ...f.input, branch: 'topic/unrelated-name' };
  placed(['--on', 'here']);
  assert.match(reportGround(elsewhere).digest ?? '', HEX, messages(reportGround(elsewhere)));
  placed(['--on', 'builder']);
  const remote = reportGround(elsewhere);
  assert.equal(remote.digest, undefined);
  assert.match(messages(remote), /0 dispatch records/);
});

test('a malformed attribution blocks only from an authorized author of a possible Brief', t => {
  const f = fixture(t);
  const malformed = (id, login, marker = '<!-- ax:publication job=brief -->') => ({ id, body: `${marker}\n${body(['Drive-by criterion.'])}`, user: login === null ? null : { login }, ...STAMP });
  f.setPermissions({ 'drive-by': 'read' });
  f.setComments([malformed(1, 'drive-by')]);
  const ignored = reportGround(f.input);
  assert.match(ignored.digest ?? '', HEX, messages(ignored));
  assert.deepEqual(criteriaNoted(ignored), CRITERIA);

  const permissionCalls = () => f.calls.filter(args => args[0] === 'api' && args[1].includes('/collaborators/')).length;
  const before = permissionCalls();
  f.setComments([
    { ...brief({ id: 2, criteria: ['Foreign job.'], marker: `<!-- ax:publication job=triage repo=${SLUG} issue=12 pass=1 -->` }), user: null },
    malformed(3, 'x', '<!-- ax:publication job=brief repo=other/repo issue=12 -->'),
    malformed(4, null, `<!-- ax:publication job=brief repo=${SLUG} issue=99 -->`),
    { ...brief({ id: 5, criteria: ['Another repository.'], marker: `<!-- ax:publication job=brief repo=other/repo issue=12 pass=4 -->` }), user: null },
  ]);
  const foreign = reportGround(f.input);
  assert.match(foreign.digest ?? '', HEX, messages(foreign));
  assert.equal(permissionCalls(), before, 'a foreign attribution needs no permission read');

  for (const [comments, permissions, pattern] of [
    [[malformed(6, 'maintainer')], {}, /malformed/],
    [[malformed(7, 'drive-by')], { 'drive-by': null }, /permission.*unreadable/],
    [[malformed(8, null)], {}, /author is unreadable/],
  ]) {
    f.setComments(comments);
    f.setPermissions(permissions);
    const result = reportGround(f.input);
    assert.equal(result.digest, undefined);
    assert.match(messages(result), pattern);
  }
});

test('a GitHub App author can publish the Brief and each author permission is read once', t => {
  const f = fixture(t);
  const app = 'ax-publisher[bot]';
  f.setPermissions({ [app]: 'maintain' });
  f.setComments([brief({ id: 7, pass: 2, login: app, criteria: ['Older pass.'] }), brief({ id: 8, pass: 3, login: app, criteria: ['Latest pass.'] })]);
  const result = reportGround(f.input);
  assert.deepEqual(criteriaNoted(result), ['Latest pass.']);
  assert.equal(f.calls.filter(args => args[0] === 'api' && args[1].includes('/collaborators/')).length, 1);
});

test('authoritative Brief selection reads every comment page and refuses ambiguity', t => {
  const f = fixture(t);
  const changed = ['Inspect the deployed value, not just tests.'];
  const firstPage = Array.from({ length: 100 }, (_, index) => ordinary(index + 1));
  f.setComments(page => page === 1 ? firstPage : page === 2 ? [brief({ id: 101, criteria: changed })] : []);
  assert.deepEqual(criteriaNoted(reportGround(f.input)), changed);

  for (const [comments, pattern] of [
    [page => page === 1 ? firstPage : { status: 1, stderr: 'HTTP 502' }, /page 2/],
    [page => page === 1 ? firstPage : [ordinary(1)], /repeated/],
    [[brief({ id: 7, pass: 2, criteria: ['One.'] }), brief({ id: 8, pass: 2, criteria: ['Two.'] })], /same latest pass/],
  ]) {
    f.setComments(comments);
    const result = reportGround(f.input);
    assert.equal(result.digest, undefined);
    assert.match(messages(result), pattern);
  }

  f.setPermissions({ reader: 'read' });
  f.setComments([brief({ id: 7, login: 'reader', criteria: changed })]);
  const nonwriter = reportGround(f.input);
  assert.deepEqual(criteriaNoted(nonwriter), CRITERIA);
  assert.match(nonwriter.digest ?? '', HEX);

  f.setComments([brief({ id: 7, pass: 3, criteria: ['Latest.'] }), brief({ id: 8, pass: 2, criteria: ['Earlier.'] })]);
  assert.deepEqual(criteriaNoted(reportGround(f.input)), ['Latest.']);
});

test('malformed machine evidence and fenced impostors never acquire a digest', t => {
  const f = fixture(t);
  const machine = rows => `\`\`\`ax-report-v1\n${JSON.stringify({ repo: SLUG, issue: 12, criteria: rows }, null, 2)}\n\`\`\``;
  const nested = rows => `~~~~markdown\n${machine(rows)}\n~~~~`;
  const report = blocks => `## CRITERIA\n\n${blocks.join('\n\n')}\n\n## LEARNINGS\nNone.\n`;
  const unmet = evidence().map(row => ({ ...row, status: 'NOT MET' }));
  for (const bytes of [
    report(['```ax-report-v1\n{"repo":\n```']),
    report([machine(evidence()), machine(evidence())]),
    report([nested(evidence())]),
  ]) {
    writeFileSync(f.path, bytes);
    const result = reportGround(f.input);
    assert.equal(result.digest, undefined);
    assert.ok(result.refusals.length > 0, bytes);
  }
  writeFileSync(f.path, report([nested(unmet), machine(evidence())]));
  assert.match(reportGround(f.input).digest ?? '', HEX, messages(reportGround(f.input)));
  writeFileSync(f.path, `\`\`\`not a \`fence\` opener\n${reportText(evidence())}`);
  assert.match(reportGround(f.input).digest ?? '', HEX, messages(reportGround(f.input)));
});

test('an empty, duplicated or fenced criteria source is never authoritative', t => {
  const f = fixture(t);
  for (const source of ['## Acceptance criteria\n- \n- [ ] Real.\n', body(['Same.', 'Same.']), '## Acceptance criteria\n\n## Next\nText.\n', '```md\n## Acceptance criteria\n- Fake.\n```\n']) {
    f.setBody(source);
    const result = reportGround(f.input);
    assert.equal(result.digest, undefined, source);
    assert.ok(result.unknowns.length > 0, source);
  }
  f.setBody(`\`\`\`md\n## Acceptance criteria\n- Fake.\n\`\`\`\n${body(CRITERIA)}`);
  const real = reportGround(f.input);
  assert.deepEqual(criteriaNoted(real), CRITERIA);
  assert.match(real.digest ?? '', HEX);
});

test('wrapped, nested and blank-separated criterion content is preserved exactly', t => {
  const f = fixture(t);
  f.setBody('## Acceptance criteria\n- [ ] First line  \n  continued\n\n  after a blank line\n    nested detail  \n- Second.\n\n## Non-goals\nNo apply.\n');
  const exact = ['First line  \ncontinued\n\nafter a blank line\n  nested detail  ', 'Second.'];
  const rows = criteria => criteria.map(criterion => ({ criterion, status: 'MET', evidence: { artifact: 'receipt', observed: 'seen' } }));
  writeFileSync(f.path, reportText(rows(exact)));
  const result = reportGround(f.input);
  assert.deepEqual(criteriaNoted(result), exact);
  assert.match(result.digest ?? '', HEX, messages(result));
  writeFileSync(f.path, reportText(rows(['First line  \ncontinued\nafter a blank line\n  nested detail', 'Second.'])));
  assert.equal(reportGround(f.input).digest, undefined);
});

test('a mismatched Report shows the authoritative criteria and its raw address before refusing', t => {
  const f = fixture(t);
  writeFileSync(f.path, reportText(evidence().map((row, index) => index === 0 ? { ...row, criterion: 'The tests pass.' } : row)));
  const result = reportGround(f.input);
  assert.equal(result.digest, undefined);
  assert.ok(result.refusals.length > 0);
  assert.deepEqual(criteriaNoted(result), CRITERIA);
  assert.equal(addressNoted(result).path, f.path);
});

test('a passing read returns complete redacted evidence and the raw Report address, never executing it', t => {
  const f = fixture(t);
  const executed = join(f.root, 'executed');
  const long = 'v'.repeat(400);
  const rows = secret => evidence().map((row, index) => index === 0 ? { ...row, evidence: { command: `touch ${executed}`, observed: `${long} dcap_${secret}` } } : row);
  writeFileSync(f.path, reportText(rows('firstsecret123')));
  const first = reportGround(f.input);
  assert.match(first.digest ?? '', HEX, messages(first));
  const shown = rowsNoted(first);
  assert.deepEqual(shown, [{ ...rows('')[0], evidence: { ...rows('')[0].evidence, observed: `${long} dcap_<redacted>` } }, evidence()[1]]);
  assert.deepEqual(addressNoted(first).path, f.path);
  assert.ok(addressNoted(first).where.includes(hostname()));
  assert.equal(existsSync(executed), false);

  writeFileSync(f.path, reportText(rows('othersecret456')));
  const second = reportGround(f.input);
  assert.deepEqual(rowsNoted(second), shown);
  assert.notEqual(second.digest, first.digest);

  writeFileSync(f.path, reportText(evidence().map(row => ({ ...row, evidence: { ...row.evidence, observed: 'repaired value=43' } }))));
  assert.deepEqual(rowsNoted(reportGround(f.input)).map(row => row.evidence.observed), ['repaired value=43', 'repaired value=43']);
});

test('a remote record authorizes only the declared host bytes, never a local impostor', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'ax.config.json'), JSON.stringify({ project: { name: 'fixture' }, prGate: { checks: ['tests'], report: true }, dispatch: { hosts: { builder: { ssh: 'builder' } } } }));
  const file = join(f.input.store, '12-work.json');
  const rec = JSON.parse(readFileSync(file));
  rec.attempts[0].phases[0].argv = ['orchestration', 'worker-start', '--on', 'builder', '--worktree', 'new-top-level'];
  writeFileSync(file, JSON.stringify(rec));
  writeFileSync(f.path, reportText(evidence().map(row => ({ ...row, status: 'NOT MET' }))));
  const remoteRows = observed => evidence().map(row => ({ ...row, evidence: { ...row.evidence, observed } }));
  const fenced = (bytes, fileReal = f.path) => ({ status: 0, stdout: `AX-REPORT/1 worktree ${f.root}\nAX-REPORT/1 file ${fileReal}\nAX-REPORT/1 bytes\n${Buffer.from(bytes).toString('base64')}\n`, stderr: '' });
  const targets = [];
  let answer = fenced(reportText(remoteRows('remote value=99')));
  const ssh = args => { targets.push(args[3]); return answer; };

  const remote = reportGround({ ...f.input, ssh });
  assert.match(remote.digest ?? '', HEX, messages(remote));
  assert.deepEqual(rowsNoted(remote).map(row => row.evidence.observed), ['remote value=99', 'remote value=99']);
  assert.equal(addressNoted(remote).path, f.path);
  assert.ok(addressNoted(remote).where.includes('builder'));
  assert.deepEqual([...new Set(targets)], ['builder']);

  answer = fenced(reportText(remoteRows('remote value=100')));
  const changed = reportGround({ ...f.input, ssh });
  assert.notEqual(changed.digest, remote.digest);
  assert.deepEqual(rowsNoted(changed).map(row => row.evidence.observed), ['remote value=100', 'remote value=100']);

  for (const [over, pattern] of [
    [fenced('x'.repeat(16 * 1024 + 1)), /bound/],
    [{ status: 255, stdout: '', stderr: 'ssh: connect to host builder port 22: Connection refused' }, /ssh/],
    [{ status: 0, stdout: `AX-REPORT/1 worktree ${f.root}\nAX-REPORT/1 file-absent\n`, stderr: '' }, /absent/],
    [fenced(reportText(remoteRows('escaped')), '/elsewhere/12-work.md'), /escape/],
  ]) {
    answer = over;
    const result = reportGround({ ...f.input, ssh });
    assert.equal(result.digest, undefined);
    assert.ok(result.unknowns.length > 0);
    assert.match(messages(result), pattern);
  }
});

test('the raw Report address never displays a credential spelled in its path or host', t => {
  const f = fixture(t);
  const tree = join(f.root, 'dcap_treesecret123');
  mkdirSync(join(tree, '.scratch', 'report'), { recursive: true });
  writeFileSync(join(tree, '.scratch', 'report', '12-work.md'), reportText(evidence()));
  const file = join(f.input.store, '12-work.json');
  const rec = JSON.parse(readFileSync(file));
  rec.host = 'dcap_hostsecret456';
  rec.attempts[0].phases[0].argv = ['orchestration', 'worker-start', '--worktree', `path:${tree}`];
  rec.attempts[0].phases[0].receipt.result.effects = [{ kind: 'worktree', path: tree, id: `repo::${tree}` }];
  writeFileSync(file, JSON.stringify(rec));
  const result = reportGround({ ...f.input, machine: rec.host });
  assert.match(result.digest ?? '', HEX, messages(result));
  assert.doesNotMatch(noted(result).join('\n'), /treesecret123|hostsecret456/);
  assert.equal(addressNoted(result).path, join(f.root, 'dcap_<redacted>', '.scratch', 'report', '12-work.md'));
});
