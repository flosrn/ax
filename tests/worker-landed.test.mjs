// The landed facts a next dispatch's notes carry (#195).
//
// Every proposition here is a behaviour of `src/worker/landed.mjs`: what the
// tracker has to say before a landing may be called merged, what git has to
// answer before a surface may be named, and what the notes channel renders when
// either read comes back short. The tracker and git are injected, so the suite
// is offline — but the surfaces half runs against a REAL temporary repository,
// because the whole point of that read is that a commit either is in this
// checkout or is not.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { defaultExec } from '../src/exec.mjs';
import { landedFor, landedNotes, landingsQuery, readLandings, renderLanded, specOf, surfacesOf } from '../src/worker/landed.mjs';

const SLUG = 'flosrn/ax';

/** `members` as the shared membership reader answers it: repository-qualified. */
const member = (number, repo = SLUG) => ({ repo, number });

/**
 * A tracker that answers the batched closing-PR read. `closers` maps an issue
 * number to the pull requests GitHub says closed it; anything not named is
 * answered as an issue with no closer at all.
 */
function fakeGh({ closers = {}, hasNextPage = {}, status = 0, stderr = '', data = undefined } = {}) {
  const calls = [];
  const gh = args => {
    calls.push(args.join(' '));
    if (data !== undefined) return { status, stdout: JSON.stringify(data), stderr };
    if (status !== 0) return { status, stdout: '', stderr };
    const query = args[args.length - 1];
    const repositories = {};
    for (const [alias, repo] of [...query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)].map(m => [m[1], `${m[2]}/${m[3]}`])) {
      const issues = {};
      for (const [, number] of query.matchAll(/i(\d+): issue\(/g)) {
        const key = `${repo}#${number}`;
        issues[`i${number}`] = {
          number: Number(number),
          state: 'CLOSED',
          closedByPullRequestsReferences: {
            pageInfo: { hasNextPage: hasNextPage[key] ?? false },
            // `raw` places a node on the wire exactly as given, so a null node
            // and a node with no `state` can be exercised as GitHub sends them.
            nodes: (closers[key] ?? []).map(pr =>
              pr === null || pr?.raw !== undefined
                ? (pr === null ? null : pr.raw)
                : {
                    number: pr.number,
                    state: pr.state,
                    mergedAt: pr.mergedAt === undefined ? '2026-09-01T00:00:00Z' : pr.mergedAt,
                    mergeCommit: pr.sha === undefined ? null : { oid: pr.sha },
                    repository: { nameWithOwner: pr.repo ?? repo },
                  },
            ),
          },
        };
      }
      repositories[alias] = issues;
    }
    return { status: 0, stdout: JSON.stringify({ data: repositories }), stderr: '' };
  };
  return { gh, calls };
}

const merged = (number, sha, extra = {}) => ({ number, state: 'MERGED', sha, ...extra });

/** A real repository whose HEAD commit touched `paths`. */
function checkout(paths) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-landed-')));
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'seed'), 'seed\n');
  execFileSync('git', [...identity, 'add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', [...identity, 'commit', '-qm', 'seed'], { cwd: dir, stdio: 'ignore' });
  for (const path of paths) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), `${path}\n`);
  }
  execFileSync('git', [...identity, 'add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', [...identity, 'commit', '-qm', 'landed'], { cwd: dir, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, sha, git: args => defaultExec('git', args, dir) };
}

/**
 * A real TWO-PARENT merge: the base moved on its own while the branch did, and
 * the merge commit has both as parents. `-m --first-parent` prints a per-parent
 * diff for a commit like this — measured 2026-09-06, it named the base-only path
 * as well — so this fixture is what keeps the surfaces read honest for a
 * `--method merge` landing.
 */
function mergedCheckout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ax-landed-merge-')));
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'seed'), 'seed\n');
  git(...identity, 'add', '-A');
  git(...identity, 'commit', '-qm', 'seed');
  git('checkout', '-qb', 'pr');
  writeFileSync(join(dir, 'pr-only.txt'), 'from the branch\n');
  git(...identity, 'add', '-A');
  git(...identity, 'commit', '-qm', 'pr');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'base-only.txt'), 'from the base\n');
  git(...identity, 'add', '-A');
  git(...identity, 'commit', '-qm', 'base');
  git(...identity, 'merge', '--no-ff', '-q', '-m', 'merge', 'pr');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, sha, git: args => defaultExec('git', args, dir) };
}

// ── the tracker read: what may be called merged ──────────────────────────────

test('a landing is the tracker saying MERGED with a merge commit — the PR and the landed SHA', () => {
  const { gh, calls } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40))] } });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.unread, []);
  assert.equal(read.landings.length, 1);
  // The merge TIME rides with the landing: it is what orders two repositories
  // against each other under the cap (a PR number cannot).
  assert.deepEqual(read.landings[0], { repo: SLUG, issue: 190, pr: 196, sha: 'a'.repeat(40), mergedAt: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(calls.length, 1, 'one batched round-trip for the whole member set');
  assert.match(calls[0], /^api graphql -f query=/);
});

test('one round-trip covers every repository the member set names, each identity repository-qualified', () => {
  const { gh, calls } = fakeGh({
    closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40))], ['acme/widgets#7']: [merged(8, 'b'.repeat(40))] },
  });
  const read = readLandings({ members: [member(190), member(7, 'acme/widgets')], gh });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    read.landings.map(landing => `${landing.repo}#${landing.issue}→${landing.pr}`),
    [`${SLUG}#190→196`, 'acme/widgets#7→8'],
  );
});

test('an OPEN or CLOSED closing pull request is never described as merged, and is not an inability either', () => {
  const { gh } = fakeGh({
    closers: {
      [`${SLUG}#194`]: [{ number: 201, state: 'OPEN' }],
      [`${SLUG}#180`]: [{ number: 181, state: 'CLOSED' }],
    },
  });
  const read = readLandings({ members: [member(194), member(180)], gh });

  assert.deepEqual(read.landings, []);
  assert.deepEqual(read.unread, [], 'a slice that has not landed is ordinary, not an unread read');
  assert.equal(renderLanded({ landings: [], unread: [] }), '');
});

test('a MERGED pull request with no merge commit is an inability — never a landing with a blank SHA', () => {
  const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [{ number: 196, state: 'MERGED' }] } });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.landings, []);
  assert.equal(read.unread.length, 1);
  assert.match(read.unread[0].detail, /#190.*PR #196 reads MERGED and names no merge commit/);
  assert.match(read.unread[0].repair, /gh pr view 196 --repo flosrn\/ax --json mergeCommit/);

  const rendered = renderLanded({ landings: [], unread: read.unread });
  assert.match(rendered, /NOT ESTABLISHED/);
  assert.doesNotMatch(rendered, /landed as/);
});

test('two merged pull requests closing one issue is ambiguity, not a first-match landing', () => {
  const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40)), merged(202, 'c'.repeat(40))] } });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.landings, []);
  assert.match(read.unread[0].detail, /#196, #202/);
  assert.match(read.unread[0].detail, /which one governs/);
});

test('a closing-PR page that does not prove itself complete is unread, never a landing', () => {
  const { gh } = fakeGh({
    closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40))] },
    hasNextPage: { [`${SLUG}#190`]: true },
  });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.landings, []);
  assert.match(read.unread[0].detail, /another page/);
});

test('pagination that does not answer is unread too — a missing hasNextPage is not a complete page', () => {
  const { gh } = fakeGh({
    data: {
      data: {
        r0: {
          i190: {
            number: 190,
            state: 'CLOSED',
            closedByPullRequestsReferences: { nodes: [merged(196, 'a'.repeat(40))] },
          },
        },
      },
    },
  });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.landings, []);
  assert.equal(read.unread.length, 1);
  assert.match(read.unread[0].detail, /pagination/);
});

test('a tracker that refuses is a named inability for every member — never an empty landing set', () => {
  const { gh } = fakeGh({ status: 1, stderr: 'gh: HTTP 502\n' });
  const read = readLandings({ members: [member(190), member(191)], gh });

  assert.deepEqual(read.landings, []);
  assert.equal(read.unread.length, 1);
  assert.match(read.unread[0].detail, /HTTP 502/);
  assert.match(read.unread[0].detail, /2 member/);
});

test('an alias the batched read did not answer is unread per member, and its siblings still land', () => {
  const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40))] } });
  const read = readLandings({ members: [member(190), member(999)], gh });

  assert.deepEqual(read.landings.map(landing => landing.issue), [190]);
  assert.equal(read.unread.length, 0, 'an issue the read answered with no closer has simply not landed');

  // The payload shape gh really prints, written out here: this branch parses
  // stdout itself, so it must be exercised against the wire shape and not
  // against the harness's convenience mapping.
  const node = { number: 196, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', mergeCommit: { oid: 'a'.repeat(40) }, repository: { nameWithOwner: SLUG } };
  const carried = { data: { r0: { i190: { number: 190, state: 'CLOSED', closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [node] } } } } };
  const partial = readLandings({ members: [member(190), member(191)], gh: () => ({ status: 1, stdout: JSON.stringify(carried), stderr: 'gh: some aliases failed\n' }) });
  assert.deepEqual(partial.landings.map(landing => landing.pr), [196], 'a partial payload still classifies the aliases it carries');
  assert.equal(partial.unread.length, 1);
  assert.match(partial.unread[0].detail, /#191/);
});

test('a member that arrived without a repository-qualified identity is unread, never dropped', () => {
  const { gh, calls } = fakeGh({});
  const read = readLandings({ members: [{ repo: 'ax', number: 190 }, { repo: SLUG, number: 0 }], gh });

  assert.deepEqual(read.landings, []);
  assert.equal(read.unread.length, 2);
  assert.match(read.unread[0].detail, /without a repository-qualified identity/);
  assert.deepEqual(calls, [], 'nothing is asked of the tracker about an identity it cannot be asked about');
});

test('a closing pull request in another repository is outside what this read establishes', () => {
  const { gh } = fakeGh({
    closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40), { repo: 'acme/widgets' })] },
  });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.landings, []);
  assert.match(read.unread[0].detail, /acme\/widgets#196, a pull request in another repository/);
});

test('an empty member set asks the tracker nothing', () => {
  const { gh, calls } = fakeGh({});
  const read = readLandings({ members: [], gh });
  assert.deepEqual(read, { landings: [], unread: [] });
  assert.deepEqual(calls, []);
});

// ── the git read: which surfaces the landed SHA changed ──────────────────────

test("surfaces are the landed commit's own changed paths, named from this checkout", () => {
  const repo = checkout(['src/worker/landed.mjs', 'tests/worker-landed.test.mjs']);
  const read = surfacesOf({ sha: repo.sha, git: repo.git });

  assert.equal(read.reason, '');
  assert.equal(read.text, 'src/worker/landed.mjs, tests/worker-landed.test.mjs');
});

test('a wide commit is grouped by directory with counts rather than listing every file', () => {
  const files = [
    'src/worker/a.mjs',
    'src/worker/b.mjs',
    'src/worker/c.mjs',
    'src/worker/d.mjs',
    'src/worker/e.mjs',
    'tests/a.test.mjs',
    'tests/b.test.mjs',
    'omp/roles/orchestrator.md',
    'README.md',
  ];
  const repo = checkout(files);
  const read = surfacesOf({ sha: repo.sha, git: repo.git });

  assert.equal(read.reason, '');
  assert.match(read.text, /src\/worker\/ \(5\)/);
  assert.match(read.text, /tests\/ \(2\)/);
  // A directory touched ONCE is named by its file: `omp/roles/ (1)` costs the
  // same characters and says less.
  assert.match(read.text, /omp\/roles\/orchestrator\.md/);
  assert.doesNotMatch(read.text, /omp\/roles\/ \(1\)/);
  assert.match(read.text, /README\.md/);
});

test('a commit this checkout does not carry is NOT READ with the fetch that would carry it', () => {
  const repo = checkout(['src/a.mjs']);
  const read = surfacesOf({ sha: 'f'.repeat(40), git: repo.git });

  assert.equal(read.text, '');
  assert.match(read.reason, /not in this checkout/);
  assert.match(read.reason, /git fetch/);
});

test('a commit whose diff reads empty says so rather than rendering no surface at all', () => {
  const repo = checkout(['src/a.mjs']);
  const read = surfacesOf({ sha: repo.sha, git: () => ({ status: 0, stdout: '\n', stderr: '' }) });

  assert.equal(read.text, '');
  assert.match(read.reason, /named no changed path/);
});

// ── the notes channel ────────────────────────────────────────────────────────

test('the channel carries the governing PR, the landed SHA and the surfaces — and says it derived them', () => {
  const repo = checkout(['src/frontier.mjs', 'tests/frontier.test.mjs']);
  const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, repo.sha)] } });
  const answered = landedFor({ members: [member(190)], slug: SLUG, gh, git: repo.git });

  assert.match(answered.text, new RegExp(`#190 landed as PR #196, at ${repo.sha.slice(0, 12)}`));
  assert.match(answered.text, /surfaces: src\/frontier\.mjs, tests\/frontier\.test\.mjs/);
  // Facts, and nothing that could read as an instruction or a permission.
  assert.match(answered.text, /Assignments and Rulings/);
  assert.ok(
    answered.notes.some(line => /1 landing/.test(line)),
    answered.notes.join(' | '),
  );
});

test('a landing in another repository names it, and asks THIS checkout for no surface it cannot hold', () => {
  const repo = checkout(['src/a.mjs']);
  const { gh } = fakeGh({ closers: { ['acme/widgets#7']: [merged(8, 'b'.repeat(40))] } });
  const answered = landedFor({ members: [member(7, 'acme/widgets')], slug: SLUG, gh, git: repo.git });

  assert.match(answered.text, /acme\/widgets#7 landed as PR #8/);
  assert.match(answered.text, /surfaces: NOT READ/);
  assert.match(answered.text, /another repository/);
});

test('deriving the same established landing twice carries it once, and says the same thing both times', () => {
  const repo = checkout(['src/a.mjs']);
  const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, repo.sha)] } });
  const first = landedFor({ members: [member(190)], slug: SLUG, gh, git: repo.git });
  const again = landedFor({ members: [member(190), member(190)], slug: SLUG, gh, git: repo.git });

  assert.equal(again.text, first.text);
  assert.equal(again.text.match(/#190 landed as PR #196/g).length, 1);
});

test('nothing landed is an EMPTY channel: no heading, no reassuring blank section', () => {
  const repo = checkout(['src/a.mjs']);
  const { gh } = fakeGh({ closers: {} });
  const answered = landedFor({ members: [member(190)], slug: SLUG, gh, git: repo.git });

  assert.equal(answered.text, '');
  assert.ok(
    answered.notes.some(line => /0 landing/.test(line)),
    'the dispatching receipt still accounts for the read it made',
  );
});

test('the channel is capped, and a cap that hides a landing says how many it hid', () => {
  const repo = checkout(['src/a.mjs']);
  const closers = {};
  const members = [];
  for (let n = 1; n <= 12; n += 1) {
    closers[`${SLUG}#${n}`] = [merged(100 + n, repo.sha)];
    members.push(member(n));
  }
  const { gh } = fakeGh({ closers });
  const answered = landedFor({ members, slug: SLUG, gh, git: repo.git, cap: 4 });

  assert.equal(answered.text.match(/landed as PR/g).length, 4);
  assert.match(answered.text, /8 older landing\(s\) of this Spec are not carried here/);
  // The newest landings are the ones the next worker steps on.
  assert.match(answered.text, /#12 landed as PR #112/);
  assert.doesNotMatch(answered.text, /#1 landed as PR #101/);
});

test('the query names identifiers only — no member text, no operator text', () => {
  const query = landingsQuery([{ owner: 'flosrn', name: 'ax', numbers: [190, 191] }]);
  assert.match(query, /r0: repository\(owner: "flosrn", name: "ax"\)/);
  assert.match(query, /i190: issue\(number: 190\)/);
  assert.match(query, /closedByPullRequestsReferences\(first: \d+, includeClosedPrs: true\)/);
  assert.match(query, /pageInfo \{ hasNextPage \}/);
  assert.match(query, /mergeCommit \{ oid \}/);
  assert.doesNotMatch(query, /[^\w"](title|body)[^\w]/);
});

// ── which Spec scopes the channel ────────────────────────────────────────────

test('the Spec is the dispatched ticket’s own parent, repository-qualified', () => {
  const answers = [];
  const gh = args => {
    answers.push(args.join(' '));
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { parent: { number: 174, repository: { nameWithOwner: SLUG } } } } } }), stderr: '' };
  };
  const read = specOf({ number: 195, slug: SLUG, gh });

  assert.deepEqual(read, { ok: true, spec: { repo: SLUG, number: 174 } });
  assert.match(answers[0], /issue\(number: 195\) \{ parent \{ number repository \{ nameWithOwner \} \} \}/);
});

test('a ticket that PROVABLY has no parent scopes nothing — and is not an inability', () => {
  const gh = () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { issue: { parent: null } } } }), stderr: '' });
  assert.deepEqual(specOf({ number: 195, slug: SLUG, gh }), { ok: true, spec: null });
});

test('a parent read that failed is not a ticket without a parent', () => {
  const failed = specOf({ number: 195, slug: SLUG, gh: () => ({ status: 1, stdout: '', stderr: 'gh: HTTP 502\n' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.why, /HTTP 502/);
  assert.match(failed.repair, /gh issue view 195 --repo flosrn\/ax/);

  // An issue the read did not answer at all, and a parent it answered
  // unreadably, are inabilities too — never "no Spec".
  for (const data of [{ repository: { issue: null } }, { repository: { issue: { parent: { number: 'x' } } } }]) {
    const read = specOf({ number: 195, slug: SLUG, gh: () => ({ status: 0, stdout: JSON.stringify({ data }), stderr: '' }) });
    assert.equal(read.ok, false, JSON.stringify(data));
  }
});

/**
 * The shared membership reader's answer, as `src/completion.mjs` declares it:
 * `{ ok, spec, members: { ok, total, nodes: [{ number, repo, ref, … }] }, comments }`.
 * Only the `members` half is consumed here — `comments` are the mandate's.
 */
const membershipOf = numbers => () => ({
  ok: true,
  spec: { number: 174, ref: `${SLUG}#174` },
  comments: { ok: true, nodes: [] },
  members: { ok: true, total: numbers.length, nodes: numbers.map(number => ({ number, repo: SLUG, ref: `${SLUG}#${number}` })) },
});

const parentGh = (spec = 174) => ({ status: 0, stdout: JSON.stringify({ data: { repository: { issue: { parent: { number: spec, repository: { nameWithOwner: SLUG } } } } } }), stderr: '' });

test('a dispatch of a Spec member carries that Spec’s established landings, and nothing else', () => {
  const repo = checkout(['src/frontier.mjs']);
  const { gh: landingGh } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, repo.sha)] } });
  const asked = [];
  const gh = args => {
    asked.push(args.join(' '));
    return args.join(' ').includes('parent') ? parentGh() : landingGh(args);
  };
  const membership = (number, options) => {
    assert.equal(number, 174, 'the Spec read is the parent the ticket named');
    assert.equal(options.slug, SLUG);
    return membershipOf([190, 195])(number, options);
  };

  const answered = landedNotes({ ticket: { number: 195, repo: SLUG }, slug: SLUG, gh, git: repo.git, membership });
  assert.match(answered.text, new RegExp(`#190 landed as PR #196, at ${repo.sha.slice(0, 12)}`));
  assert.match(answered.text, /surfaces: src\/frontier\.mjs/);
  assert.doesNotMatch(answered.text, /#195 landed/, 'the ticket being dispatched has not landed, and nothing pretends it did');
});

test('a ticket in no Spec gets no derived section at all — no heading over a claim nobody made', () => {
  const repo = checkout(['src/a.mjs']);
  const gh = () => ({ status: 0, stdout: JSON.stringify({ data: { repository: { issue: { parent: null } } } }), stderr: '' });
  const answered = landedNotes({ ticket: { number: 195, repo: SLUG }, slug: SLUG, gh, git: repo.git, membership: () => assert.fail('membership must not be read without a Spec') });

  assert.equal(answered.text, '');
  assert.ok(answered.notes.some(line => /no parent Spec/.test(line)), answered.notes.join(' | '));
});

test('a membership read that could not be established says so IN the channel — absence would read as "nothing landed"', () => {
  const repo = checkout(['src/a.mjs']);
  const gh = args => (args.join(' ').includes('parent') ? parentGh() : assert.fail('no landing read is made without a member set'));
  const membership = () => ({ ok: true, members: { ok: false, why: 'the sub-issue read for flosrn/ax#174 could not be proved complete', repair: 'gh issue view 174 --repo flosrn/ax --json subIssues' } });

  const answered = landedNotes({ ticket: { number: 195, repo: SLUG }, slug: SLUG, gh, git: repo.git, membership });
  assert.match(answered.text, /NOT ESTABLISHED/);
  assert.match(answered.text, /could not be proved complete/);
  assert.doesNotMatch(answered.text, /landed as PR/);
  assert.ok(answered.notes.some(line => /gh issue view 174/.test(line)));
});

test('a Spec whose own read failed is named, and never rendered as a Spec with no landings', () => {
  const repo = checkout(['src/a.mjs']);
  const gh = () => ({ status: 1, stdout: '', stderr: 'gh: HTTP 502\n' });
  const answered = landedNotes({ ticket: { number: 195, repo: SLUG }, slug: SLUG, gh, git: repo.git, membership: () => assert.fail('membership must not be read when the Spec is unknown') });

  assert.match(answered.text, /NOT ESTABLISHED/);
  assert.match(answered.text, /HTTP 502/);
  assert.ok(answered.notes.some(line => /HTTP 502/.test(line)));
});

test('a Spec in another repository keeps its identity, and its members keep theirs', () => {
  const repo = checkout(['src/a.mjs']);
  const gh = args =>
    args.join(' ').includes('parent')
      ? { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { parent: { number: 9, repository: { nameWithOwner: 'acme/specs' } } } } } }), stderr: '' }
      : { status: 0, stdout: JSON.stringify({ data: { r0: { i7: { number: 7, state: 'CLOSED', closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [{ number: 8, state: 'MERGED', mergedAt: '2026-09-02T00:00:00Z', mergeCommit: { oid: 'b'.repeat(40) }, repository: { nameWithOwner: 'acme/widgets' } }] } } } } }), stderr: '' };
  const membership = (number, options) => {
    assert.equal(number, 9);
    assert.equal(options.slug, 'acme/specs');
    return { ok: true, members: { ok: true, total: 1, nodes: [{ number: 7, repo: 'acme/widgets', ref: 'acme/widgets#7' }] } };
  };

  const answered = landedNotes({ ticket: { number: 195, repo: SLUG }, slug: SLUG, gh, git: repo.git, membership });
  assert.match(answered.text, /acme\/widgets#7 landed as PR #8/);
  assert.match(answered.text, /surfaces: NOT READ/);
});


// ── the three gate findings on PR #203 ───────────────────────────────────────

test('a MERGE commit’s surfaces are what it brought in, not what the base moved beside it', () => {
  // Measured 2026-09-06 on a real two-parent merge: `diff-tree -m
  // --first-parent <sha>` prints a per-parent diff and named `base-only.txt`
  // as well as `pr-only.txt` — so a `--method merge` landing would advertise a
  // surface it never touched, and a worker would go looking for its change in
  // the wrong file. The comparison is the landed SHA against its FIRST PARENT.
  const repo = mergedCheckout();
  const read = surfacesOf({ sha: repo.sha, git: repo.git });

  assert.equal(read.reason, '');
  assert.equal(read.text, 'pr-only.txt');
  assert.doesNotMatch(read.text, /base-only/);
});

test('a closing-PR node with no readable state is NOT ESTABLISHED — never quietly "not landed"', () => {
  // OPEN and CLOSED are answers; a null node, an absent `state` and a state
  // nobody taught this are not. A filter on `state === 'MERGED'` read all three
  // as "this sibling has not landed yet", which is the one thing they do not say.
  for (const [name, node] of [
    ['a null node', null],
    ['no state at all', { raw: { number: 196, mergeCommit: { oid: 'a'.repeat(40) } } }],
    ['a state nobody taught it', { raw: { number: 196, state: 'DRAFT', mergeCommit: { oid: 'a'.repeat(40) } } }],
  ]) {
    const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [node] } });
    const read = readLandings({ members: [member(190)], gh });
    assert.deepEqual(read.landings, [], name);
    assert.equal(read.unread.length, 1, name);
    assert.match(read.unread[0].detail, /state/, name);
  }
});

test('a MERGED pull request with no readable merge time is named, not silently ranked', () => {
  const { gh } = fakeGh({ closers: { [`${SLUG}#190`]: [merged(196, 'a'.repeat(40), { mergedAt: null })] } });
  const read = readLandings({ members: [member(190)], gh });

  assert.deepEqual(read.landings, []);
  assert.match(read.unread[0].detail, /merge time/);
});

test('landings are ordered by when they MERGED, never by a number two repositories both use', () => {
  // A pull request number is repository-local: #900 in one repository is older
  // than #12 in another as often as not. Under the cap that arithmetic hides a
  // landing — here a foreign #900 merged last year against a local #12 merged
  // today, which is the pair a numeric sort gets backwards.
  const repo = checkout(['src/a.mjs']);
  const { gh } = fakeGh({
    closers: {
      ['acme/legacy#5']: [merged(900, 'b'.repeat(40), { mergedAt: '2025-01-01T00:00:00Z' })],
      [`${SLUG}#7`]: [merged(12, repo.sha, { mergedAt: '2026-09-06T10:00:00Z' })],
    },
  });
  const answered = landedFor({ members: [member(5, 'acme/legacy'), member(7)], slug: SLUG, gh, git: repo.git, cap: 1 });

  assert.match(answered.text, /#7 landed as PR #12/);
  assert.doesNotMatch(answered.text, /PR #900/, 'the older foreign landing may not displace the newer local one');
  assert.match(answered.text, /1 older landing\(s\) of this Spec are not carried here/);

  // And the merge time is what the query asks for.
  assert.match(landingsQuery([{ owner: 'flosrn', name: 'ax', numbers: [190] }]), /mergedAt/);
});