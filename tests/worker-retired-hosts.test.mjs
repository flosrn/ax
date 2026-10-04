// Host retirement (`src/worker/retired-hosts.mjs`, KTD8): one policy fact under
// `<store>/hosts/retired.json`, written by `ax worker retire-host` only when the
// host does not answer, and applied by each reader in its own way — the frontier
// sets a claim aside, `ls` keeps the pane INCONNU, the gate authorises on an
// attestation, settle explains instead of naming a host repair, Slots skip it.
// Real records on a temp store, a real checkout for `ax.config.json`, and an
// injected Orca: nothing here reaches a host, a forge or a mutating CLI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { frontier } from '../src/frontier.mjs';
import { gate } from '../src/worker/gate.mjs';
import { hostSlots, hosts as hostsVerb } from '../src/worker/host-placement.mjs';
import { ls } from '../src/worker/ls.mjs';
import { claimRecord, initRecord, phaseBegin, phaseEnd } from '../src/worker/record.mjs';
import { readRetired, retireHost, retiredPath, unretireHost } from '../src/worker/retired-hosts.mjs';
import { settle } from '../src/worker/settle.mjs';
import { liveCount } from '../src/worker/slots.mjs';

const SLUG = 'flosrn/harnessos';
const HOSTS = { 'netcup-dev': { ssh: 'hos-dev@netcup-vie' }, gapicore: { ssh: 'gapicore' } };
const DOWN = { fail: 'remote_runtime_unavailable: Could not connect to the remote Orca runtime.' };
const AT = '2026-10-04T12:00:00.000Z';

const tmp = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function checkout() {
  const dir = tmp('ax-retired-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'ax.config.json'), JSON.stringify({ project: { name: 'probe' }, apps: { web: 'apps/web' }, vendor: { repo: 'owner/kit' }, dispatch: { entry: '/entry', hosts: HOSTS } }));
  return dir;
}

/** A record as `ax worker start` leaves it: task-create, then a worker-start placed `--on`. */
function record(store, request, { on = '', handle = `term_${request}`, dispatchId = `ctx_${request}`, task = `task_${request}`, settled = false } = {}) {
  const { path } = claimRecord(store, request);
  initRecord(path, { request, orca: 'orca', repo: SLUG });
  phaseBegin(path, { name: 'task-create', identity: `create-${request}`, argv: ['orca', 'orchestration', 'task-create', '--json'] });
  phaseEnd(path, 'last', { exit: 0, receiptText: JSON.stringify({ ok: true, result: { task: { id: task }, mutation: { requestId: 'r', replayed: false } } }) });
  phaseBegin(path, { name: 'worker-start', identity: `start-${request}`, argv: ['orca', 'orchestration', 'worker-start', ...(on === '' ? [] : ['--on', on]), '--json'] });
  phaseEnd(path, 'last', {
    exit: 0,
    receiptText: JSON.stringify({ ok: true, result: { runId: 'run_1', taskId: task, dispatchId, state: 'ready', effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: handle }], mutation: { requestId: 'r', replayed: false } } }),
  });
  if (settled) {
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    rec.attempts[rec.attempts.length - 1].settled = true;
    writeFileSync(path, JSON.stringify(rec));
  }
  return path;
}

/** An Orca answering status, the local list, each host's own list, and the two Run lists. */
function orca({ local = [], hosts = {}, workers = [], tasks = [] } = {}) {
  const calls = [];
  const yes = result => ({ status: 0, stdout: '', stderr: '', receipt: { ok: true, result } });
  const list = rows => yes({ terminals: rows.map(handle => ({ handle, worktreePath: '/x' })), hostScope: { hostIds: ['local'], omittedHostIds: [] }, truncated: false });
  const run = args => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return yes({ runtime: { reachable: true } });
    if (args[0] === 'terminal' && args[1] === 'list') {
      const at = args.indexOf('--environment');
      if (at === -1) return list(local);
      const host = hosts[args[at + 1]] ?? DOWN;
      if (host.fail !== undefined) return { status: 1, stdout: '', stderr: host.fail, receipt: { ok: false, error: { code: 'remote_runtime_unavailable', message: host.fail } } };
      return list(host.terminals ?? []);
    }
    if (args.includes('worker-list')) return yes({ workers });
    if (args.includes('task-list')) return yes({ tasks: tasks.map(id => ({ id })) });
    if (args.includes('worker-show')) return { status: 1, stdout: '', stderr: 'unknown dispatch', receipt: { ok: false } };
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}`, receipt: { ok: false } };
  };
  run.calls = calls;
  return run;
}

const worker = (request, state = 'running') => ({ taskId: `task_${request}`, dispatchId: `ctx_${request}`, workerState: state, terminalState: 'active', agentTerminalHandle: `term_${request}` });

const gh = (bin, args) => (bin === 'gh' && args[0] === 'repo' ? { status: 0, stdout: `${SLUG}\n`, stderr: '' } : { status: 1, stdout: '', stderr: `no ${bin} here\n` });

function capture(fn) {
  const chunks = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = process.stderr.write = chunk => (chunks.push(String(chunk)), true);
  try {
    return { code: fn(), out: chunks.join('').replace(/\u001B\[\d+m/g, '') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const retire = (store, run, cwd, host = 'netcup-dev') => capture(() => retireHost([host, '--store', store], { runner: run, cwd, env: { USER: 'flo' }, now: () => AT }));
const unretire = (store, host = 'netcup-dev') => capture(() => unretireHost([host, '--store', store], { env: {} }));

// ── the verbs ──────────────────────────────────────────────────────────────────

test('AE12: retire-host refuses a host that answers its own terminal list, and the policy is unchanged', () => {
  const store = tmp('ax-retired-store-');
  const run = orca({ hosts: { 'netcup-dev': { terminals: ['term_one'] } } });
  const r = retire(store, run, checkout());
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /netcup-dev/);
  assert.match(r.out, /ax worker close/);
  assert.ok(run.calls.includes('terminal list --environment netcup-dev --json'), 'the host itself was asked');
  assert.equal(existsSync(retiredPath(store)), false, 'no policy written over a host that answered');
});

test('retire-host on a silent host writes {host, at, by} once; unretire-host removes it without asking anything', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  const r = retire(store, orca(), cwd);
  assert.equal(r.code, 0, r.out);
  assert.equal(retiredPath(store), join(store, 'hosts', 'retired.json'));
  assert.deepEqual(JSON.parse(readFileSync(retiredPath(store), 'utf8')), { hosts: [{ host: 'netcup-dev', at: AT, by: 'flo' }] });
  const again = retire(store, orca(), cwd);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already retired/);
  assert.equal(JSON.parse(readFileSync(retiredPath(store), 'utf8')).hosts.length, 1);

  const back = unretire(store);
  assert.equal(back.code, 0, back.out);
  assert.deepEqual(JSON.parse(readFileSync(retiredPath(store), 'utf8')), { hosts: [] });
  assert.equal(readRetired(store).hosts.size, 0);
});

test('retire-host refuses a host this checkout does not declare, and a silent runtime, rather than reading them as silent hosts', () => {
  const store = tmp('ax-retired-store-');
  const undeclared = retire(store, orca(), checkout(), 'typo-box');
  assert.equal(undeclared.code, 3, undeclared.out);
  const down = orca();
  const silent = capture(() => retireHost(['netcup-dev', '--store', store], { runner: args => (args[0] === 'status' ? { status: 1, stdout: '', stderr: 'down', receipt: { ok: false } } : down(args)), cwd: checkout(), env: {}, now: () => AT }));
  assert.equal(silent.code, 3, silent.out);
  assert.equal(existsSync(retiredPath(store)), false);
});

// ── the readers ────────────────────────────────────────────────────────────────

test('ls keeps a retired host\'s pane INCONNU with the retirement, never MORT, and names no settle for it', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  record(store, 'hos-u3-pins', { on: 'netcup-dev' });
  assert.equal(retire(store, orca(), cwd).code, 0);
  const r = capture(() => ls([], { runner: orca(), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(r.code, 0, r.out);
  const row = r.out.split('\n').find(line => line.includes('hos-u3-pins')) ?? '';
  assert.match(row, /pane INCONNU/);
  assert.match(row, new RegExp(`host retired by operator at ${AT}`));
  assert.doesNotMatch(r.out, /pane MORT/);
  assert.doesNotMatch(r.out, /ax worker settle hos-u3-pins/);
  assert.doesNotMatch(r.out, /host 'netcup-dev' could not be asked/, 'the retirement replaces the ask-it repair');
});

const candidates = numbers => (bin, args) => {
  if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.97.0 (2026-01-15)\n', stderr: '' };
  if (args[0] === 'repo') return { status: 0, stdout: `${SLUG}\n`, stderr: '' };
  if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(numbers.map(number => ({ number, title: `T${number}`, labels: [{ name: 'ready-for-agent' }] }))), stderr: '' };
  if (args[0] === 'api' && args[1] === 'graphql') {
    const node = { state: 'OPEN', lastEditedAt: null, labels: { nodes: [{ name: 'ready-for-agent' }] }, subIssues: { totalCount: 0 }, blockedBy: { nodes: [], pageInfo: { hasNextPage: false } }, timelineItems: { nodes: [{ label: { name: 'ready-for-agent' }, actor: { login: 'flo' }, createdAt: '2026-01-01T00:00:00Z' }] } };
    return { status: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries(numbers.map(n => [`i${n}`, node])) } }), stderr: '' };
  }
  if (args[0] === 'api') return { status: 0, stdout: JSON.stringify({ permission: 'write' }), stderr: '' };
  throw new Error(`no gh answer for ${args.join(' ')}`);
};
const runFrontier = (store, cwd, numbers) => capture(() => frontier([], { gh: args => candidates(numbers)('gh', args), env: { HOME: store, ORCA_DISPATCH_STORE: store }, cwd }));

test('AE13: a sole claim on a retired host makes the ticket takeable with the retirement named; a second claim elsewhere keeps it excluded', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  record(store, '75-doc', { on: 'netcup-dev' });
  record(store, '76-old', { on: 'netcup-dev' });
  record(store, '76-new', { on: 'gapicore' });
  const before = runFrontier(store, cwd, [75, 76]);
  assert.match(before.out, /#75 T75 — already-dispatched/);

  assert.equal(retire(store, orca(), cwd).code, 0);
  const after = runFrontier(store, cwd, [75, 76]);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /takeable — 1/);
  assert.match(after.out, new RegExp(`#75 T75 — .*75-doc on 'netcup-dev', host retired by operator at ${AT}`));
  assert.match(after.out, /#76 T76 — already-dispatched/, 'a live claim on another host still wins');
});

test('gate authorises on the attestation when only retired-host rows remain, never "proven corpse"; a VIVANT pane there refuses', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  record(store, 'hos-u5-build-gate', { on: 'netcup-dev' });
  const fixture = { workers: [worker('hos-u5-build-gate')], tasks: ['task_hos-u5-build-gate'] };
  const blocked = capture(() => gate(['hos-u5-build-gate'], { runner: orca(fixture), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(blocked.code, 3, blocked.out);

  assert.equal(retire(store, orca(), cwd).code, 0);
  const attested = capture(() => gate(['hos-u5-build-gate'], { runner: orca(fixture), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(attested.code, 0, attested.out);
  assert.match(attested.out, /attestation/);
  assert.match(attested.out, new RegExp(`netcup-dev.*retired by operator at ${AT}`));
  assert.doesNotMatch(attested.out, /proven corpse/i);

  const answering = capture(() => gate(['hos-u5-build-gate'], { runner: orca({ ...fixture, hosts: { 'netcup-dev': { terminals: ['term_hos-u5-build-gate'] } } }), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(answering.code, 1, answering.out);
  assert.match(answering.out, /ax worker unretire-host netcup-dev/);
  assert.match(answering.out, /ax worker close term_hos-u5-build-gate/);
});

test('settle on a retired-host record names the retirement, close and unretire-host — never "make the host answer"', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  record(store, 'hos-u6-linux-builder', { on: 'netcup-dev' });
  assert.equal(retire(store, orca(), cwd).code, 0);
  const r = capture(() => settle(['hos-u6-linux-builder'], { runner: orca({ workers: [worker('hos-u6-linux-builder')] }), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`retired by operator at ${AT}`));
  assert.match(r.out, /ax worker unretire-host netcup-dev/);
  assert.match(r.out, /ax worker close/);
  assert.doesNotMatch(r.out, /orca terminal list --environment netcup-dev/);
  assert.equal(JSON.parse(readFileSync(join(store, 'hos-u6-linux-builder.json'), 'utf8')).attempts[0].settled, false, 'retirement never settles');
});

test('unretire restores the claim; with a successor dispatched both records stay and gate reports the duplicate', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  record(store, '77-old', { on: 'netcup-dev', task: 'task_77', dispatchId: 'ctx_old', handle: 'term_old' });
  assert.equal(retire(store, orca(), cwd).code, 0);
  assert.match(runFrontier(store, cwd, [77]).out, /takeable — 1/);
  record(store, '77-new', { task: 'task_77', dispatchId: 'ctx_new', handle: 'term_new' });

  assert.equal(unretire(store).code, 0);
  assert.match(runFrontier(store, cwd, [77]).out, /#77 T77 — already-dispatched/);
  const rows = [
    { taskId: 'task_77', dispatchId: 'ctx_old', workerState: 'running', terminalState: 'active', agentTerminalHandle: 'term_old' },
    { taskId: 'task_77', dispatchId: 'ctx_new', workerState: 'running', terminalState: 'active', agentTerminalHandle: 'term_new' },
  ];
  const r = capture(() => gate(['task_77'], { runner: orca({ workers: rows, tasks: ['task_77'], local: ['term_new'], hosts: { 'netcup-dev': { terminals: ['term_old'] } } }), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /DUPLICATE/);
  assert.ok(existsSync(join(store, '77-old.json')) && existsSync(join(store, '77-new.json')), 'neither record is rewritten or removed');
});

const ENTRY = name => ({
  host: name, state: 'ok', eligible: true, reasons: [], cordoned: false,
  declaration: { ssh: name }, maxWorkers: 8, footprint: { memoryMb: 1000, cpuPercent: 100 },
  memory: { maxMb: 12288, workMb: 288, freeMb: 12000, hostAvailableMb: 20000, peakMb: null },
  oom: { killCount: 0, acknowledged: null, acknowledgedAt: null, baseline: 0 },
  cpu: { freePercent: 600 }, gateway: { surface: `omp-${name}`, healthy: true, detail: 'ok' },
});

test('Slots skip a retired host even when its report entry is eligible, and the live count carries the retirement', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  assert.equal(retire(store, orca(), cwd).code, 0);
  const counted = liveCount({ run: orca(), env: { ORCA_DISPATCH_STORE: store }, config: { dispatch: { hosts: HOSTS } }, local: { ok: true, byHandle: new Map(), hosts: ['local'], omitted: false } });
  assert.equal(counted.cannot, undefined, counted.cannot);
  const count = counted.slots.hosts.get('netcup-dev');
  assert.equal(count.retired.at, AT);

  const { candidates: chosen, skipped } = hostSlots({ capacity: { hosts: [ENTRY('netcup-dev'), ENTRY('gapicore')] }, liveOn: host => counted.slots.hosts.get(host) ?? { live: 0, unmeasured: 0 } });
  assert.deepEqual(chosen.map(row => row.host), ['gapicore']);
  assert.match(skipped.find(row => row.host === 'netcup-dev').reason, new RegExp(`retired by operator at ${AT}`));
});

const readHosts = (argv, store, cwd, report) => capture(() => hostsVerb(argv, { runner: orca(), env: { HOME: store, ORCA_DISPATCH_STORE: store, HARNESSOS_SOURCE: '/src/harnessos' }, cwd, capacity: () => ({ ok: true, capacity: report }) }));

test('ax worker hosts <retired> is a known name: 0 Slots, the retirement, and metrics unavailable when unmeasured', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  assert.equal(retire(store, orca(), cwd).code, 0);
  const unmeasured = readHosts(['netcup-dev'], store, cwd, { hosts: [ENTRY('gapicore')] });
  assert.equal(unmeasured.code, 0, unmeasured.out);
  assert.match(unmeasured.out, /0 Slots/);
  assert.match(unmeasured.out, new RegExp(`retired by operator at ${AT}`));
  assert.match(unmeasured.out, /memory and OOM unavailable/);

  const measured = readHosts(['netcup-dev'], store, cwd, { hosts: [ENTRY('netcup-dev')] });
  assert.equal(measured.code, 0, measured.out);
  assert.match(measured.out, /0 Slots/);
  assert.match(measured.out, /slice max 12288 MB/);
});

test('a malformed policy file refuses frontier, ls, gate, settle, placement and the verbs with the same repair', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  record(store, '78-x', { on: 'netcup-dev' });
  mkdirSync(join(store, 'hosts'), { recursive: true });
  writeFileSync(retiredPath(store), JSON.stringify({ hosts: [{ host: 'netcup-dev', at: AT, why: 'typo' }] }));
  const env = { HOME: store, ORCA_DISPATCH_STORE: store };
  const outs = {
    frontier: runFrontier(store, cwd, [78]),
    ls: capture(() => ls([], { runner: orca(), env, cwd, exec: gh })),
    gate: capture(() => gate(['78-x'], { runner: orca({ workers: [worker('78-x')], tasks: ['task_78-x'] }), env, cwd, exec: gh })),
    settle: capture(() => settle(['78-x'], { runner: orca({ workers: [worker('78-x')] }), env, cwd, exec: gh })),
    hosts: readHosts([], store, cwd, { hosts: [ENTRY('gapicore')] }),
    retire: retire(store, orca(), cwd),
    unretire: unretire(store),
  };
  for (const [verb, r] of Object.entries(outs)) {
    assert.equal(r.code, 3, `${verb}: ${r.out}`);
    assert.match(r.out, /host retirement policy .*retired\.json is malformed: .*'why'/, verb);
    assert.match(r.out, /repair it by hand/, `${verb} names the one repair`);
  }
  const counted = liveCount({ run: orca(), env, config: { dispatch: { hosts: HOSTS } }, local: { ok: true, byHandle: new Map(), hosts: ['local'], omitted: false } });
  assert.match(counted.cannot, /is malformed/);
  assert.match(counted.repair, /repair it by hand/);
});

// ── flosrn/ax#292, the seven-record shape ──────────────────────────────────────

test('#292: retiring netcup-dev unblocks the frontier and the gate over its seven records', () => {
  const store = tmp('ax-retired-store-');
  const cwd = checkout();
  const seven = ['hos-prep-fresh-netcup', 'hos-prep-proof-netcup', 'hos-u3-pins', 'hos-u5-build-gate', 'hos-u6-linux-builder', 'hos-u17-patches-page'];
  for (const request of seven) record(store, request, { on: 'netcup-dev' });
  record(store, 'hos-u1-series', { on: 'netcup-dev', settled: true });
  // The ticket the wave wanted, claimed by a record on the same stopped slot.
  record(store, '75-doc-reconciliation', { on: 'netcup-dev' });
  const workers = [...seven, '75-doc-reconciliation'].map(request => worker(request));

  assert.match(runFrontier(store, cwd, [73, 75]).out, /#75 T75 — already-dispatched/);
  assert.equal(capture(() => gate(['75-doc-reconciliation'], { runner: orca({ workers, tasks: ['task_75-doc-reconciliation'] }), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh })).code, 3);

  assert.equal(retire(store, orca(), cwd).code, 0);
  const after = runFrontier(store, cwd, [73, 75]);
  assert.match(after.out, /takeable — 2/, after.out);
  const g = capture(() => gate(['75-doc-reconciliation'], { runner: orca({ workers, tasks: ['task_75-doc-reconciliation'] }), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.equal(g.code, 0, g.out);
  const listed = capture(() => ls(['--all'], { runner: orca({ workers }), env: { ORCA_DISPATCH_STORE: store }, cwd, exec: gh }));
  assert.doesNotMatch(listed.out, /pane MORT/);
  for (const request of seven) assert.match(listed.out, new RegExp(`${request} .*host retired by operator`));
});
