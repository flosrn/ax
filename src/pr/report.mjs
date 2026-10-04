// The adopted acceptance ground: a Report is evidence to judge, never a success
// claim that authorizes its own merge. The tracker owns the criterion text; the
// dispatch record owns the Report address; the orchestrator judges those bytes.
//
// One invocation-local digest binds repository, PR, ticket, head, observed base,
// assignment and raw Report. --accept-report plus --reason answers THIS read,
// like --ack-body, not a persisted permission. Pushes, assignment edits, Report
// repairs and base movement invalidate it. A merging gate reads this ground
// twice: once with the other grounds, then again under the merge lock just
// before journalling and issuing, and issues only on the identical accepted
// digest. The merge journal records the judgment.
//
// The detector shows what it judged: the authoritative criteria and the raw
// Report's address before validation, then every validated row as redacted JSON.
// Display redaction never touches the hashed bytes. Commands in evidence are
// never executed. This validates completeness and freshness, not the truth of
// arbitrary text or the caller's GitHub permissions. Every unread or ambiguity
// fails closed; remote evidence never falls back here.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, sep } from 'node:path';
import { payload, clean } from '../pr-grounds.mjs';
import { redactSecrets } from '../redact.mjs';
import { publicationIn } from '../triage/publication.mjs';
import { argvValue, requestIdOk } from '../worker/record.mjs';
import { reportPath } from '../worker/report.mjs';
import { fetchRemoteReport } from '../worker/remote-report.mjs';
import { worktreesOf } from '../worker/transcript.mjs';

const CAP = 16 * 1024;
const SHA = /^[0-9a-f]{40}$/;
// GitHub user logins, plus the `[bot]` suffix a GitHub App author carries.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const sameRepo = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const text = value => typeof value === 'string' && value.trim() !== '';
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
// One terminal line of valid JSON: control, separator and format characters are
// escaped, never stripped or truncated. The read cap bounds its length.
const shown = value => JSON.stringify(value).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ch => Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
const redacted = value => typeof value === 'string' ? redactSecrets(value)
  : Array.isArray(value) ? value.map(redacted)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [redactSecrets(key), redacted(inner)]))
  : value;
// Absent --on and --on here both place the child on this machine.
const remoteHost = argv => { const on = argvValue(argv, '--on') ?? ''; return on === 'here' ? '' : on; };

// A descriptor read, not stat-then-readFile: the bound applies before allocation,
// and O_NONBLOCK lets a malicious FIFO be rejected rather than hang this gate.
function bytesAt(path, cap) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const buf = Buffer.allocUnsafe(cap + 1);
    let count = 0;
    while (count < buf.length) {
      const n = readSync(fd, buf, count, buf.length - count, count);
      if (n === 0) break;
      count += n;
    }
    if (count > cap) throw new Error(`exceeds the ${cap}-byte input bound`);
    return buf.subarray(0, count);
  } finally { closeSync(fd); }
}

// Markdown structural lines only, ignoring fenced examples, as CommonMark has
// it: a fence opens with three or more backticks or tildes (up to three spaces
// of indent; a backtick info string holds no backtick) and closes only on the
// same character, at least as long, followed by nothing but whitespace. An
// opener carries its info string; content stays exact.
function linesOf(body) {
  let fence = null;
  return body.replace(/\r\n/g, '\n').split('\n').map(line => {
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) { fence = null; return { line, structural: false, closes: true }; }
      return { line, structural: false };
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], size: open[1].length };
      return { line, structural: false, info: open[2].trim() };
    }
    return { line, structural: true };
  });
}

function criteriaOf(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 64 * 1024) throw new Error('assignment body is absent or oversized');
  const lines = linesOf(body);
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].structural) continue;
    const heading = /^ {0,3}(#{1,6})\s+Acceptance criteria\s*:?(?:\s+#+)?\s*$/i.exec(lines[i].line);
    const bold = /^\s*\*\*Acceptance criteria:?\*\*:?[ \t]*$/i.test(lines[i].line);
    if (heading || bold) starts.push({ index: i, level: heading?.[1].length ?? 0 });
  }
  if (starts.length !== 1) throw new Error(`assignment carries ${starts.length} Acceptance criteria sections; exactly one is required`);
  const { index, level } = starts[0];
  const rows = [];
  let current = null;
  let indent = null;
  for (let i = index + 1; i < lines.length; i += 1) {
    const { line, structural } = lines[i];
    const heading = structural ? /^ {0,3}(#{1,6})\s+/.exec(line) : null;
    if ((heading && (level === 0 || heading[1].length <= level)) || (structural && /^\s*\*\*[^*]+\*\*:?[ \t]*$/.test(line))) break;
    const bullet = structural ? /^( *)(?:[-+*]|[0-9]+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line) : null;
    if (bullet && (indent === null || bullet[1].length <= indent)) {
      if (indent === null) indent = bullet[1].length;
      if (bullet[1].length !== indent) throw new Error('criteria list has inconsistent top-level indentation');
      current = [bullet[2]];
      rows.push(current);
    } else if (current !== null) {
      current.push(line);
    } else if (line.trim() !== '') {
      throw new Error('criteria section carries content outside its list');
    }
  }
  // Trailing blank lines separate items; every other byte is the criterion.
  const criteria = rows.map(row => {
    let last = row.length;
    while (last > 1 && row[last - 1].trim() === '') last -= 1;
    const rest = row.slice(1, last);
    const indents = rest.filter(line => line.trim() !== '').map(line => /^ */.exec(line)[0].length);
    const common = indents.length === 0 ? 0 : Math.min(...indents);
    return [row[0], ...rest.map(line => line.slice(common))].join('\n');
  });
  if (criteria.length === 0 || criteria.some(value => !text(value)) || new Set(criteria).size !== criteria.length) throw new Error('criteria list is empty or duplicates a criterion');
  return criteria;
}

// A stamp that does not parse still names what it can: a field it carries that
// points at another job, repository or ticket proves it is no Brief for this one.
const possibleBrief = (pub, slug, issue) => pub.ok
  ? pub.job === 'brief' && sameRepo(pub.repo, slug) && pub.issue === String(issue)
  : (pub.job === '' || pub.job === 'brief') && (pub.repo === '' || sameRepo(pub.repo, slug)) && !(/^[1-9][0-9]*$/.test(pub.issue) && pub.issue !== String(issue));

function assignmentOf(run, slug, issue) {
  const read = payload(run(['issue', 'view', String(issue), '--repo', slug, '--json', 'number,body,url']));
  if (!read.ok) throw new Error(`ticket read ${read.reason}`);
  if (read.value?.number !== issue || typeof read.value.body !== 'string') throw new Error('ticket read did not answer its number and body');
  let source = { kind: 'body', body: read.value.body };
  const briefs = [];
  const seen = new Set();
  let ended = false;
  // One permission read per author per invocation; an unread one stays unread.
  const permissions = new Map();
  const authorized = login => {
    if (!permissions.has(login)) {
      const answer = payload(run(['api', `repos/${slug}/collaborators/${encodeURIComponent(login)}/permission`]));
      permissions.set(login, answer.ok && typeof answer.value?.permission === 'string' ? answer.value.permission : null);
    }
    const permission = permissions.get(login);
    if (permission === null) throw new Error('attributed Brief author permission is unreadable');
    return ['write', 'maintain', 'admin'].includes(permission);
  };
  for (let page = 1; page <= 50; page += 1) {
    const comments = payload(run(['api', `repos/${slug}/issues/${issue}/comments?per_page=100&page=${page}`]));
    if (!comments.ok || !Array.isArray(comments.value)) throw new Error(`ticket comments page ${page} ${comments.ok ? 'answered no list' : comments.reason}`);
    let fresh = 0;
    for (const comment of comments.value) {
      if (!Number.isInteger(comment?.id) || typeof comment.body !== 'string') throw new Error('ticket comments carry unreadable id or body');
      if (seen.has(comment.id)) throw new Error('ticket comments repeated a row; pagination is unestablished');
      seen.add(comment.id); fresh += 1;
      // Relevance and authority come before a malformed stamp may block: a
      // commenter without write access cannot veto the ticket's evidence.
      const pub = publicationIn(comment.body);
      if (pub === null || !possibleBrief(pub, slug, issue)) continue;
      const login = comment.user?.login;
      if (!text(login) || !LOGIN.test(login)) throw new Error('attributed Brief author is unreadable');
      if (!authorized(login)) continue;
      if (!pub.ok) throw new Error('an authorized author published malformed AX attribution on this ticket');
      if (!text(comment.created_at) || !text(comment.updated_at) || Number.isNaN(Date.parse(comment.created_at))) throw new Error('attributed Brief time is unreadable');
      briefs.push({ kind: 'brief', id: comment.id, pass: pub.pass, by: login, created: comment.created_at, updated: comment.updated_at, body: comment.body });
    }
    if (comments.value.length < 100) { ended = true; break; }
    if (fresh === 0) throw new Error('ticket comment pagination made no progress');
  }
  if (!ended) throw new Error('ticket comment pagination never reached its final page');
  if (briefs.length > 0) {
    briefs.sort((a, b) => b.pass - a.pass || Date.parse(b.created) - Date.parse(a.created));
    if (briefs.length > 1 && briefs[0].pass === briefs[1].pass) throw new Error('two authoritative Briefs claim the same latest pass');
    source = briefs[0];
  }
  return { source, criteria: criteriaOf(source.body) };
}

// Local placement: a path selector on this machine resolving to this checkout.
function placedHere(argv, here) {
  const selector = argvValue(argv, '--worktree');
  if (!selector?.startsWith('path:') || remoteHost(argv) !== '') return false;
  try { return realpathSync(selector.slice(5)) === here; } catch { return false; }
}

// A record is a candidate when its request names the PR branch or its latest
// worker-start placed it in this checkout. Only a candidate must carry a
// worker-start and a repository; a readable record that can claim neither is
// another ticket's business. An identity that cannot be read is never skipped.
function dispatchOf(store, root, slug, issue, branch) {
  const candidates = [];
  const here = realpathSync(root);
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const request = entry.name.slice(0, -5);
    const rec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytesAt(join(store, entry.name), 1024 * 1024)));
    if (!requestIdOk(request) || rec?.request !== request) throw new Error('dispatch record request is missing or contradicts its filename');
    const legacy = rec.repo === undefined || rec.repo === null;
    if (!legacy && !text(rec.repo)) throw new Error('dispatch record repository is unreadable');
    if (!legacy && !sameRepo(rec.repo, slug)) continue;
    if (!Array.isArray(rec.attempts) || rec.attempts.some(attempt => !Array.isArray(attempt?.phases))) throw new Error('dispatch record attempts or phases are unreadable');
    const latest = rec.attempts.flatMap(attempt => attempt.phases).filter(phase => phase?.name === 'worker-start').at(-1);
    if (latest !== undefined && !Array.isArray(latest.argv)) throw new Error('dispatch record carries an unreadable worker-start');
    const named = branch === request || branch.endsWith(`/${request}`);
    if (!named && !(latest !== undefined && placedHere(latest.argv, here))) continue;
    if (legacy) throw new Error('dispatch record repository is absent');
    if (latest === undefined) throw new Error('dispatch record carries no readable worker-start');
    if (!request.startsWith(`${issue}-`)) throw new Error('the PR dispatch record names another ticket or untracked work');
    candidates.push({ rec, phase: latest });
  }
  if (candidates.length !== 1) throw new Error(`${candidates.length} dispatch records name this PR; exactly one Report address is required`);
  return candidates[0];
}

function addressOf(record) {
  const derived = reportPath(record.rec);
  if (!derived.path) throw new Error(derived.reason);
  return { path: derived.path, worktree: worktreesOf(record.rec)[0], host: remoteHost(record.phase.argv) };
}

function reportBytes({ address, record, root, ssh, machine }) {
  const { path, worktree, host } = address;
  if (host !== '') {
    const answer = fetchRemoteReport({ env: host, worktree, path, cap: CAP, cwd: root, ssh });
    if (!answer.buf) throw new Error(answer.absent ? 'the derived remote Report is absent' : answer.reason);
    if (typeof answer.worktreeReal !== 'string' || typeof answer.fileReal !== 'string' || !answer.fileReal.startsWith(`${answer.worktreeReal.replace(/\/$/, '')}/`)) throw new Error('remote Report escapes its recorded worktree');
    if (answer.buf.length > CAP) throw new Error('remote Report is incomplete at its input bound');
    return answer.buf;
  }
  if (record.rec.host !== machine) throw new Error('the local Report record names another machine or no owning host');
  const treeReal = realpathSync(worktree);
  const fileReal = realpathSync(path);
  if (!within(treeReal, fileReal)) throw new Error('Report escapes its recorded worktree');
  return bytesAt(fileReal, CAP);
}

function reportOf(bytes, slug, issue, criteria) {
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lines = linesOf(body);
  const starts = lines.flatMap((row, index) => row.structural && /^## CRITERIA[ \t]*$/.test(row.line) ? [index] : []);
  if (starts.length !== 1) throw new Error('Report needs exactly one ## CRITERIA section');
  let end = starts[0] + 1;
  while (end < lines.length && !(lines[end].structural && /^## /.test(lines[end].line))) end += 1;
  // Only a true fence opener inside CRITERIA counts; a block quoted inside
  // another fence is example content, whatever it spells.
  const blocks = [];
  for (let i = starts[0] + 1; i < end; i += 1) {
    if (lines[i].info !== 'ax-report-v1') continue;
    let close = i + 1;
    while (close < end && !lines[close].closes) close += 1;
    if (close === end) throw new Error('Report ax-report-v1 fence never closes inside CRITERIA');
    blocks.push(lines.slice(i + 1, close).map(row => row.line).join('\n'));
  }
  if (blocks.length !== 1) throw new Error('Report needs exactly one fenced ax-report-v1 object inside CRITERIA');
  let report;
  try { report = JSON.parse(blocks[0]); } catch { throw new Error('Report ax-report-v1 block is not valid JSON'); }
  if (!sameRepo(report?.repo, slug) || report.issue !== issue || !Array.isArray(report.criteria)) throw new Error('Report repository, ticket or criterion list contradicts the assignment');
  if (report.criteria.length !== criteria.length) throw new Error('Report criterion count does not match the authoritative assignment');
  for (let i = 0; i < criteria.length; i += 1) {
    const row = report.criteria[i];
    if (row?.criterion !== criteria[i]) throw new Error(`Report criterion ${i + 1} is missing, reordered or reformulated`);
    if (row.status !== 'MET') throw new Error(`Report criterion ${i + 1} is NOT MET or has no status`);
    if (!text(row.evidence?.observed) || (!text(row.evidence?.command) && !text(row.evidence?.artifact))) throw new Error(`Report criterion ${i + 1} has no command/artifact and observed result`);
  }
  return report;
}

/** One non-short-circuiting merge ground; never prints or mutates. */
export function reportGround({ run, root, store, slug, pr, sha, baseCommit, binding, branch, adopted, accepted = '', reason = '', release, ssh, machine = hostname() } = {}) {
  const result = { notes: [], unknowns: [], refusals: [] };
  const note = message => result.notes.push({ message });
  const refuse = (message, repair) => result.refusals.push({ message: `acceptance: ${message}`, repair });
  const repair = `ax pr gate --pr ${pr} --issue ${binding?.issue ?? '<n>'}   # inspect the Report and current criteria`;
  if (adopted === undefined || adopted === false) { note('acceptance: NOT RUN — prGate.report is not adopted'); return result; }
  if (adopted !== true) { refuse('prGate.report must be true or false', 'ax doctor   # correct prGate.report'); return result; }
  if (release?.ok) { note('acceptance: NOT RUN — recognised release PR has no ticket by construction'); return result; }
  if (!binding?.ok || !Number.isInteger(binding.issue)) {
    result.unknowns.push({ message: 'acceptance: no unambiguous ticket binding', repair }); return result;
  }
  if (!SHA.test(sha ?? '') || !SHA.test(baseCommit ?? '')) {
    result.unknowns.push({ message: 'acceptance: validated head or observed base is unreadable', repair }); return result;
  }
  const unread = error => { result.unknowns.push({ message: `acceptance: cannot read authoritative evidence — ${clean(redactSecrets(String(error.message ?? error)))}`, repair }); return result; };
  let assignment;
  try { assignment = assignmentOf(run, slug, binding.issue); } catch (error) { return unread(error); }
  const { source } = assignment;
  const from = source.kind === 'brief' ? `Brief comment ${source.id} pass ${source.pass} by ${shown(redacted(source.by))}` : `ticket #${binding.issue} body`;
  note(`acceptance: criteria from ${from}: ${shown(redacted(assignment.criteria))}`);
  let raw;
  try {
    const record = dispatchOf(store, root, slug, binding.issue, branch);
    const address = addressOf(record);
    note(`acceptance: raw Report ${shown(redacted(address.path))} on ${address.host !== '' ? `declared host ${shown(redacted(address.host))} over ssh` : `local host ${shown(redacted(record.rec.host ?? null))}`}`);
    raw = reportBytes({ address, record, root, ssh, machine });
  } catch (error) { return unread(error); }
  let report;
  try { report = reportOf(raw, slug, binding.issue, assignment.criteria); }
  catch (error) { refuse(clean(redactSecrets(String(error.message ?? error))), 'repair the derived Report to prove every authoritative criterion, then re-run the gate'); return result; }
  report.criteria.forEach((row, index) => note(`acceptance: criterion ${index + 1}/${report.criteria.length} ${shown(redacted(row))}`));
  const digest = hash(JSON.stringify({ repo: slug.toLowerCase(), pr: String(pr), issue: binding.issue, head: sha, base: baseCommit, assignment: assignment.source, report: hash(raw) }));
  result.digest = digest;
  note(`acceptance: ${assignment.criteria.length} criteria with observed evidence; digest ${digest} (head ${sha.slice(0, 12)}, base ${baseCommit.slice(0, 12)})`);
  if (accepted === '') {
    refuse('explicit acceptance judgment is absent', `ax pr gate --pr ${pr} --issue ${binding.issue} --merge --accept-report ${digest} --reason '<judgment after inspecting each criterion and its evidence>'`);
  } else if (accepted !== digest) {
    refuse('the accepted digest is stale or differs from this read', repair);
  } else if (!text(reason)) {
    refuse('the acceptance judgment has no reason', `${repair}   # supply --reason after judging the evidence`);
  } else {
    note(`acceptance: explicit judgment for digest ${digest} — ${clean(redactSecrets(reason))}`);
    result.judgment = { digest, reason: redactSecrets(reason) };
  }
  return result;
}
