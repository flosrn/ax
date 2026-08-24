// `ax worker transcript` — the WHOLE of a child's conversation, structured and redacted.
//
// New verb: the bash coordinator had no equivalent, and the two things that
// look like one were measured on 2026-08-21 and are not:
//   - `peer_read` returns the TAIL, in prose — the last few turns as narrated
//     text, so the tool calls, the model moves and everything before the tail
//     are simply absent.
//   - `worker-read` returns the child's TUI, and a redrawn terminal answered
//     EMPTY: what the pane shows is a frame, not a history.
// The history exists on disk, as the session JSONL under
// `~/.omp/agent/sessions/<cwd-slug>/`, and this verb is the only reader of it.
//
// REDACTION IS THE POINT, not a courtesy (PORT.md invariant 11). The preamble
// Orca injects into every supervised worker embeds that worker's
// `--dispatch-capability` — measured twice in the preamble alone, before the
// child has done anything — and the child then retypes it into its own tool
// calls. So every byte this verb prints goes through `redactSecrets`, and there
// is deliberately NO bypass flag: the token is useless to a human reading a
// history, and a human who genuinely needs the raw bytes has the disk. That is
// why the source path is printed at the top — it is the escape hatch.
//
// FAIL-CLOSED, unlike `ax board`: an unresolvable target or an unreadable file
// is an inability to establish, never an empty rendering. A guessed session
// file is a transcript of the wrong agent, which is worse than no answer
// (F-028: named keys, refuse rather than default).
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  a transcript (or, under --last-message, a message) was rendered
//   1  --last-message only: the session is readable but holds no assistant
//      message with text yet — a real absence, never confused with a failure
//      to look (the same split tail draws between SILENT and CANNOT ESTABLISH)
//   2  usage error (no target, unknown flag)
//   3  cannot establish: no orca, runtime silent, target unresolvable or
//      ambiguous, source file unreadable
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad as badLine, fix as fixLine, note as noteLine, raw as rawLine, section as sectionLine } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { defaultStore } from './record.mjs';

// ONE redaction boundary, on the emitters themselves. Redacting field by field
// is how the leak gets in: it only takes the one field nobody thought carried
// child text — a customType, a path inside a diagnostic, an error message
// quoting the line it failed on. Nothing in this module writes to a stream
// except through these four.
const note = message => noteLine(redactSecrets(message));
const bad = message => badLine(redactSecrets(message));
const fix = command => fixLine(redactSecrets(command));
const section = title => sectionLine(redactSecrets(title));
// The marker mode's payload: one parseable line, redacted like everything else
// this module prints — a needle is a worktree name, but the line crosses a
// transport and every emission here goes through one boundary.
const raw = text => rawLine(redactSecrets(text));

/** `orca open` is the repair for every gate refusal of this verb. */
const OPEN = 'orca open   # start the Orca runtime, then re-run';

/**
 * Redact FIRST, then flatten and cap. The other order leaks: truncating a
 * `dcap_…` token mid-way still prints its prefix.
 */
function oneLine(text, cap) {
  const flat = redactSecrets(text)
    .replace(/[\n\r\t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 3)}...` : flat;
}

/** The session directory a cwd produces: `~/Code/flosrn/ax` -> `-Code-flosrn-ax`. */
export function slugOf(cwd, env = process.env) {
  const path = isAbsolute(cwd) ? cwd : resolvePath(cwd);
  const home = env.HOME ?? '';
  const relative = home !== '' && path.startsWith(home) ? path.slice(home.length) : path;
  return relative.replace(/\//g, '-');
}

const sessionsRootOf = (env, override) => override || env.AX_SESSIONS_ROOT || join(env.HOME ?? '', '.omp', 'agent', 'sessions');

/**
 * The timestamp Orca writes into a session filename
 * (`2026-08-21T15-53-16-056Z_<uuid>.jsonl`), as epoch ms. A name that does not
 * carry one answers null and is never silently ranked against those that do.
 */
export function stampOf(name) {
  const hit = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (!hit) return null;
  const at = Date.parse(`${hit[1]}T${hit[2]}:${hit[3]}:${hit[4]}.${hit[5]}Z`);
  return Number.isNaN(at) ? null : at;
}

/** Every phase of every attempt, oldest first — the records are small. */
function* phasesOf(rec) {
  for (const attempt of Array.isArray(rec.attempts) ? rec.attempts : []) {
    for (const phase of Array.isArray(attempt.phases) ? attempt.phases : []) yield phase;
  }
}

/** The dispatch ids a record carries, from the receipts it stored. */
function dispatchIdsOf(rec) {
  const ids = new Set();
  for (const phase of phasesOf(rec)) {
    const id = ((phase.receipt ?? {}).result ?? {}).dispatchId;
    if (id) ids.add(String(id));
  }
  return ids;
}

/**
 * The worktree paths a record's effects name. Orca reports them as
 * `{kind:'worktree', id:'<repoId>::<PATH>'}` — the path is the tail, and a
 * missing `effects` container is an absence, never an empty answer (F-028).
 */
function worktreesOf(rec) {
  const paths = new Set();
  for (const phase of phasesOf(rec)) {
    const effects = ((phase.receipt ?? {}).result ?? {}).effects;
    if (!Array.isArray(effects)) continue;
    for (const effect of effects) {
      if ((effect ?? {}).kind !== 'worktree' || typeof effect.id !== 'string') continue;
      const cut = effect.id.indexOf('::');
      const path = cut === -1 ? effect.id : effect.id.slice(cut + 2);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/** Records in the store whose request or dispatch id is `target`. Unreadable records are named, not skipped. */
function findRecords(store, target) {
  let names = [];
  try {
    names = readdirSync(store).filter(name => name.endsWith('.json'));
  } catch {
    return { hits: [], unreadable: [], store, missing: true };
  }
  const hits = [];
  const unreadable = [];
  for (const name of names.sort()) {
    const path = join(store, name);
    let rec;
    try {
      rec = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      unreadable.push(name);
      continue;
    }
    if (rec.request === target || dispatchIdsOf(rec).has(target)) hits.push({ name, path, rec });
  }
  return { hits, unreadable, store, missing: false };
}

/**
 * Which session file is the transcript of this dispatch?
 *
 * Two candidates is not "take the newest": these files are one per session of
 * one worktree, and picking wrong renders the WRONG agent's history under the
 * right agent's name. So the answer is either exactly one candidate or a
 * refusal that LISTS what it saw, and the human names the file.
 */
function sessionCandidates(dir, createdAt) {
  const after = Date.parse(createdAt ?? '');
  const floor = Number.isNaN(after) ? -Infinity : after;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { dir, missing: true, all: [], candidates: [] };
  }
  const all = names
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({ name, path: join(dir, name), at: stampOf(name) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { dir, missing: false, all, candidates: all.filter(file => file.at !== null && file.at >= floor) };
}

/** The `command`/`i` of a tool call — the two arguments that say what it DID. */
const gistOf = (args, intent) =>
  typeof args.command === 'string' ? args.command : typeof args.i === 'string' ? args.i : intent;

const callLine = (name, gist) => {
  const label = oneLine(String(name ?? '?'), 40);
  return gist ? `${label}(${oneLine(String(gist), 60)})` : label;
};

const toolLine = part => callLine(part.name, gistOf(part.arguments ?? {}, part.intent));

/** One rendered line for one JSONL entry. Every text field has been through redaction. */
export function renderEntry(entry) {
  const type = String(entry.type ?? '?');

  if (type === 'message') {
    const message = entry.message ?? {};
    const content = message.content;
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const texts = parts.filter(part => part.type === 'text' || part.type === 'thinking').map(part => part.text ?? part.thinking ?? '');
    const tools = parts.filter(part => part.type === 'toolCall').map(toolLine);
    const bits = [];
    if (texts.length > 0) bits.push(oneLine(texts.join(' '), 160));
    if (tools.length > 0) bits.push(`→ ${tools.join(' ')}`);
    return `${type} ${message.role ?? '?'}${bits.length > 0 ? `  ${bits.join('  ')}` : ''}`;
  }

  // A `custom_message` IS a message — an advisory, a mount notice — and its
  // customType is the only thing that says which, so it is displayed as the role.
  if (type === 'custom_message' || type === 'custom') {
    const label = `${type} ${entry.customType ?? '?'}`;
    const data = entry.data ?? {};
    // `tool_execution_start` is the OTHER place a tool call appears: it carries
    // the name and args of the call the assistant message also announces, and
    // the two do not always both survive a truncated session. So it is rendered
    // as the call it is, not as a bare label.
    if (entry.customType === 'tool_execution_start') return `${label}  ${callLine(data.toolName, gistOf(data.args ?? {}, data.intent))}`;
    const body = entry.content ?? data.intent ?? '';
    return body ? `${label}  ${oneLine(String(body), 160)}` : label;
  }

  if (type === 'model_change') {
    // `role` is the field that says WHO moved the model, and the distinction was
    // paid for: an early version of the model adapter was believed to work
    // because a quota fallback happened to land on the intended model, and this
    // field was the only thing that said otherwise.
    const role = entry.role;
    const who = role === undefined || role === null ? 'boot' : String(role);
    const gloss = { boot: 'session boot', default: 'model adapter', fallback: 'quota chain' }[who] ?? 'unknown mover';
    return `${type} ${oneLine(String(entry.model ?? '?'), 60)}  role=${oneLine(who, 20)} (${gloss})`;
  }

  if (type === 'thinking_level_change') return `${type} ${oneLine(String(entry.thinkingLevel ?? '?'), 20)}`;

  return type;
}

/**
 * The last assistant entry that carries TEXT, scanned from the end.
 *
 * Three deliberate exclusions. A toolCall-only turn is a move, not a word — the
 * measured tail of a real session (2026-08-23, 882 lines) ends on one, and
 * answering with it would hand the caller an argv instead of a report. A
 * thinking part is reasoning the models emit for themselves, not something the
 * agent said to anyone. And an unparseable line is SKIPPED, not fatal: the
 * crash-mid-append that truncates the FINAL line is precisely the situation
 * this mode exists to recover from, so aborting on it would make the reader
 * fail exactly when it is needed.
 */
export function lastMessageIn(lines) {
  let skipped = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message ?? {};
    if (message.role !== 'assistant') continue;
    const content = message.content;
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const texts = parts.filter(part => part.type === 'text').map(part => String(part.text ?? '')).filter(text => text.trim() !== '');
    if (texts.length === 0) continue;
    return { line: i + 1, text: texts.join('\n'), skipped };
  }
  return { line: 0, text: null, skipped };
}

export function transcript(argv = [], { resolve = resolveOrca, runner, env = process.env, sessionsRoot } = {}) {
  let target = '';
  // Launch verification is the one mode that reads a transcript WITHOUT
  // rendering it. It returns both independent proofs — model mover and session
  // role/skills — as one JSON line, locally or through the remote transport.
  // It asks no runtime question, so it answers before the readiness gate below.
  const proofAt = argv.indexOf('--launch-proof');
  if (proofAt !== -1) {
    const needle = argv[proofAt + 1];
    if (needle === undefined || needle.startsWith('-')) {
      bad('ax worker transcript --launch-proof expects the session needle (a worktree directory name)');
      return 2;
    }
    const rootAt = argv.indexOf('--sessions');
    const found = launchProof({
      needle,
      env,
      sessionsRoot: rootAt === -1 ? sessionsRoot : argv[rootAt + 1],
    });
    if (found === null) return 1;
    raw(JSON.stringify(found));
    return 0;
  }


  let wantLast = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      section('ax worker transcript <handle|dispatch_id|path.jsonl> [--last-message]');
      note('the full session history of one child, structured and redacted (no bypass flag)');
      note('--last-message: only the last thing the agent SAID — its final report, in full, still redacted');
      return 0;
    }
    if (arg === '--last-message') {
      wantLast = true;
      continue;
    }
    if (arg.startsWith('-')) {
      bad(`ax worker transcript: unknown argument: ${arg}`);
      fix('ax worker transcript <handle|dispatch_id|path.jsonl> [--last-message]');
      return 2;
    }
    if (target !== '') {
      bad(`ax worker transcript: one target at a time (got "${target}" and "${arg}")`);
      fix('ax worker transcript <handle|dispatch_id|path.jsonl>');
      return 2;
    }
    target = arg;
  }
  if (target === '') {
    bad('ax worker transcript: which child?');
    fix('ax worker transcript <handle|dispatch_id|path.jsonl>');
    return 2;
  }

  // Fail-closed gate, before any read: a transcript is the history of a session
  // this runtime hosts, so a machine that cannot answer for its sessions has no
  // business rendering one from a stale file.
  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) {
    bad('no orca CLI on this machine — a transcript is read from a session Orca hosts');
    fix(OPEN);
    return 3;
  }
  const run = runner ?? createRunner({ bin });
  const ready = runtimeReady(run);
  if (!ready.ready) {
    bad(ready.reason);
    fix(OPEN);
    return 3;
  }

  const found = resolveTarget(target, { env, sessionsRoot });
  if (!found.path) return 3;

  let lines;
  try {
    lines = readFileSync(found.path, 'utf8').split('\n');
  } catch (error) {
    bad(`cannot read ${found.path}: ${String(error.message ?? error)}`);
    fix(`ls -l ${found.path}   # the session file named above`);
    return 3;
  }

  // The last thing the agent SAID — not the last thing it DID. The measured
  // tail of a real session ends `toolCall → toolResult → assistant text →
  // session_exit`, so "last entry" would usually answer with a tool move, and
  // the caller of this mode wants the final report (the lost-peer-message case:
  // 8 reports lost in transit on 2026-08-23 alone — this file is the copy that
  // cannot be lost). Rendered IN FULL through the same redaction boundary,
  // because a report capped at 160 chars is a teaser, not a recovery.
  if (wantLast) {
    const last = lastMessageIn(lines);
    if (last.text === null) {
      bad(`no assistant message with text in ${found.path}${last.skipped > 0 ? ` (${last.skipped} unparseable line(s) skipped)` : ''}`);
      fix(`ax worker transcript ${target}   # the full history, to see what the session did instead`);
      return 1;
    }
    section(`last message ${found.path}`);
    if (found.via) note(found.via);
    note(`line ${last.line} of ${lines.length}${last.skipped > 0 ? ` — ${last.skipped} later line(s) unparseable and skipped` : ''}`);
    raw(last.text);
    return 0;
  }

  section(`transcript ${found.path}`);
  if (found.via) note(found.via);

  const width = String(lines.length).length;
  let corrupt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const number = String(i + 1).padStart(width, ' ');
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (error) {
      // One bad line is one bad line: it is named and the rendering CONTINUES.
      // A parse loop that aborts turns a single truncated write — the ordinary
      // shape of a crash mid-append — into a lost history.
      corrupt += 1;
      bad(`${number}  unparseable JSONL line: ${oneLine(String(error.message ?? error), 100)}`);
      fix(`sed -n '${i + 1}p' ${found.path}   # read the raw line yourself`);
      continue;
    }
    note(`${number}  ${renderEntry(entry)}`);
  }
  if (corrupt > 0) note(`${corrupt} line(s) could not be parsed and are reported above; every other entry is rendered`);
  return 0;
}

/**
 * `<path>.jsonl` is read verbatim; anything else is a request id or a dispatch
 * id, and is resolved THROUGH the record store — the only thing that ties a
 * dispatch to the worktree it created, and therefore to a session directory.
 */
function resolveTarget(target, { env, sessionsRoot }) {
  if (target.endsWith('.jsonl')) {
    const path = isAbsolute(target) ? target : resolvePath(target);
    if (existsSync(path)) return { path, via: null };
    bad(`no such session file: ${path}`);
    fix(`ls ${sessionsRootOf(env, sessionsRoot)}   # the session directories on this machine`);
    return {};
  }

  const store = defaultStore(env);
  const { hits, unreadable, missing } = findRecords(store, target);
  for (const name of unreadable) {
    bad(`record ${name} is not readable JSON — it cannot answer for "${target}"`);
    fix(`cat ${join(store, name)}   # repair or remove it`);
  }
  if (missing || hits.length === 0) {
    // A hex-and-dash target is what a session CARD shows (`01a0295c`), and no
    // record ever names one — so it is resolved under the sessions root
    // itself, with OMP's own `--resume <id>` semantics: the id after the
    // timestamp in `<timestamp>_<sessionId>.jsonl`, matched by prefix. One
    // match answers; zero or several are refusals by name (F-028) — two
    // sessions sharing a prefix is one keystroke away from rendering the
    // wrong agent's history.
    if (SESSION_ID.test(target)) {
      const root = sessionsRootOf(env, sessionsRoot);
      const sessions = sessionsById(root, target);
      if (sessions.length === 1) return { path: sessions[0], via: `resolved as a session id under ${root}` };
      if (sessions.length > 1) {
        bad(`"${target}" is a prefix of ${sessions.length} session ids — refusing to guess`);
        for (const path of sessions) note(`candidate: ${path}`);
        fix(`ax worker transcript ${target}…   # more of the id, or the path.jsonl directly`);
        return {};
      }
      bad(`no dispatch record names "${target}" in ${store}, and no session id under ${root} starts with it`);
      fix(`ls ${root}   # the session directories on this machine`);
      return {};
    }
    bad(`no dispatch record names "${target}" in ${store}`);
    fix(`ls ${store}   # the dispatch records on this host, then pass a request id, a session id, or a path.jsonl`);
    return {};
  }
  if (hits.length > 1) {
    bad(`"${target}" names ${hits.length} dispatch records — refusing to guess`);
    for (const hit of hits) note(`candidate: ${hit.path}`);
    fix('ax worker transcript <path.jsonl>   # name the session file directly');
    return {};
  }

  const [{ name, rec }] = hits;
  const worktrees = worktreesOf(rec);
  if (worktrees.length === 0) {
    bad(`record ${name} carries no worktree effect — the session directory cannot be established`);
    fix('ax worker transcript <path.jsonl>   # name the session file directly');
    return {};
  }
  if (worktrees.length > 1) {
    bad(`record ${name} names ${worktrees.length} worktrees — refusing to guess which session`);
    for (const path of worktrees) note(`candidate worktree: ${path}`);
    fix('ax worker transcript <path.jsonl>   # name the session file directly');
    return {};
  }

  const dir = join(sessionsRootOf(env, sessionsRoot), slugOf(worktrees[0], env));
  const { all, candidates } = sessionCandidates(dir, rec.createdAt);
  if (candidates.length !== 1) {
    bad(
      candidates.length === 0
        ? `no session file in ${dir} postdates the record (${rec.createdAt ?? 'no createdAt'})`
        : `${candidates.length} session files in ${dir} postdate the record — refusing to guess`,
    );
    for (const file of all) note(`candidate: ${file.path}${file.at === null ? '  (unstamped name)' : ''}`);
    fix('ax worker transcript <path.jsonl>   # name the session file directly');
    return {};
  }

  // The path is printed by the caller; this line says HOW we got there, so a
  // wrong answer is diagnosable without re-deriving the chain.
  return { path: candidates[0].path, via: `resolved from record ${name} → worktree ${worktrees[0]}` };
}

/** What a session card shows: a hex-and-dash id prefix, at least four characters. */
const SESSION_ID = /^[0-9a-f][0-9a-f-]{3,}$/i;

/** Every session file under `root` whose id starts with `target`, any slug. */
function sessionsById(root, target) {
  const needle = target.toLowerCase();
  const matches = [];
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return matches;
  }
  for (const dir of dirs) {
    let files = [];
    try {
      files = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const at = file.indexOf('_');
      if (at === -1) continue;
      if (file.slice(at + 1, -'.jsonl'.length).toLowerCase().startsWith(needle)) matches.push(join(root, dir, file));
    }
  }
  return matches;
}

/**
 * The launch proof written by the child session itself.
 *
 * The model mover and the session role are independent. `model_change.role`
 * says who selected the model (`default` is the spec adapter); a hidden custom
 * message says whether the top-level role and every declared autoload skill
 * reached the first turn. Neither proposition can stand in for the other.
 */
export function launchProof({ needle, request = '', env = process.env, sessionsRoot } = {}) {
  const file = sessionFileForNeedle({ needle, request, env, sessionsRoot });
  if (file === null) return null;

  let model = null;
  let sessionRole = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '' || (!line.includes('model_change') && !line.includes('skill-prompt') && !line.includes('role-refused'))) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // The LAST model mover wins: a quota fallback after the marker is the model
    // the child actually serves, and must not be reported as marker-applied.
    if (entry?.type === 'model_change') {
      model = { model: String(entry.model ?? ''), role: entry.role ?? '' };
      continue;
    }
    if (!['custom', 'custom_message'].includes(entry?.type)) continue;
    const details = entry?.details;
    if (entry.customType === 'skill-prompt' && details?.status === 'applied' && typeof details.role === 'string' && Array.isArray(details.skills)) {
      sessionRole = {
        status: 'applied',
        role: details.role,
        skills: details.skills.filter(skill => typeof skill === 'string'),
      };
    } else if (entry.customType === 'role-refused' && typeof details?.role === 'string') {
      sessionRole = {
        status: 'refused',
        role: details.role,
        reason: String(details.reason ?? 'unknown'),
        missingSkills: Array.isArray(details.missingSkills)
          ? details.missingSkills.filter(skill => typeof skill === 'string')
          : [],
      };
    }
  }
  return { model, sessionRole };
}


const mtime = path => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Exactly one session file under the cwd slug ending in `needle`.
 *
 * A worker owns a unique worktree, so newest is unambiguous. Triage sessions
 * share the current checkout; there the recorded request id appears in the
 * first task spec and selects exactly one file. Zero or two matches is an
 * inability to establish, never newest-wins.
 */
function sessionFileForNeedle({ needle, request = '', env = process.env, sessionsRoot } = {}) {
  const root = sessionsRootOf(env, sessionsRoot);
  const tail = String(needle ?? '');
  if (tail === '') return null;
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter(entry => {
        if (!entry.isDirectory()) return false;
        const slug = entry.name.replace(/-+$/, '');
        return slug === tail || slug.endsWith(`-${tail}`);
      })
      .map(entry => join(root, entry.name));
  } catch {
    return null;
  }
  if (dirs.length !== 1) return null;

  let files;
  try {
    files = readdirSync(dirs[0])
      .filter(name => name.endsWith('.jsonl') && !name.startsWith('__advisor.'))
      .map(name => join(dirs[0], name));
  } catch {
    return null;
  }
  if (request !== '') {
    const matching = files.filter(path => {
      try {
        return readFileSync(path, 'utf8').includes(request);
      } catch {
        return false;
      }
    });
    return matching.length === 1 ? matching[0] : null;
  }
  return files.reduce((best, path) => (best === null || mtime(path) > mtime(best) ? path : best), null);
}

/** Exported for the doctor of a wrong answer: which files a target would consider. */
export { findRecords, sessionCandidates, worktreesOf };

/**
 * Exported for `./delivered.mjs`, which asks the same question this file
 * answers — WHICH session file is this dispatch's child — and must not own a
 * second resolver that can disagree with this one.
 */
export { sessionFileForNeedle };
