// HOST RETIREMENT IS ONE POLICY FACT, AND AN ATTESTATION, NEVER A PROOF (KTD8).
//
// `ax worker retire-host <host>` records that the operator wrote a host off on
// purpose; `ax worker unretire-host <host>` reverses it. The fact lives in
// `<store>/hosts/retired.json` — the store namespace the admission locks
// already use, outside every root `*.json` scan — as `{"hosts":[{host, at,
// by?}]}`, behind this one reader and one locked writer. Nothing else reads or
// writes that file.
//
// RETIRE ONLY A HOST THAT DOES NOT ANSWER. The host's own terminal list is
// asked (`terminal list --environment <host>`) after the local runtime is
// proven up; any answer refuses and points to `ax worker close`, which ends a
// pane on a host that can still say it ended. A silent local runtime, an
// undeclared host or an unreadable config cannot establish the silence, so
// they write nothing. Unretiring needs no reachability: it only withdraws the
// operator's word.
//
// WHAT IT NEVER DOES. It writes no MORT, rewrites no dispatch record, settles no
// attempt and closes no pane. Each reader decides its own disposition, matching
// a record's host from its worker-start `--on`, never the record root `host`:
// the frontier sets aside a claim on a retired host while any other claim still
// wins, `ls` keeps the pane INCONNU with the retirement, the gate authorises on
// the attestation (never "proven corpses") and refuses once a pane there is
// seen VIVANT, settle explains the retirement instead of a host repair, and
// Slots skip the host.
//
// ABSENCE IS NOT ZERO (F-028). No file is the one "nothing retired" answer: only
// this writer creates it. A file that cannot be read, or whose shape or keys
// are not exactly the named ones, is a named inability for every reader — never
// an empty policy, which would put a retired host's records back in every count
// without anyone saying so.
//
// Exit codes (ADR 0003 — per verb):
//   retire-host    0 recorded or already recorded · 1 the host answered ·
//                  2 usage · 3 cannot establish (config, runtime, policy, lock, write)
//   unretire-host  0 removed or was not retired · 2 usage · 3 cannot establish
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok } from '../log.mjs';
import { declarationOf } from './hosts.mjs';
import { acquireLock, argvValue, defaultStore, HOSTS_NS, requestIdOk } from './record.mjs';

const RETIRED_FILE = 'retired.json';
const ENTRY_KEYS = ['host', 'at', 'by'];

/** Where the policy lives: under the store's `hosts/` namespace, never at its root. */
export const retiredPath = store => join(store, HOSTS_NS, RETIRED_FILE);

const repairOf = path => `the policy ${path} must read {"hosts":[{"host":"<name>","at":"<iso time>","by":"<who>"}]} — repair it by hand; nothing reads past a malformed policy`;

/** Why the parsed document is not the policy, or ''. */
function invalid(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'it is not an object';
  const extra = Object.keys(doc).filter(key => key !== 'hosts');
  if (extra.length > 0) return `unknown key '${extra[0]}'`;
  if (!Array.isArray(doc.hosts)) return "'hosts' is not a list";
  const seen = new Set();
  for (const [index, entry] of doc.hosts.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return `hosts[${index}] is not an object`;
    const unknown = Object.keys(entry).filter(key => !ENTRY_KEYS.includes(key));
    if (unknown.length > 0) return `hosts[${index}] has unknown key '${unknown[0]}'`;
    if (typeof entry.host !== 'string' || !requestIdOk(entry.host)) return `hosts[${index}].host is not a host name`;
    if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) return `hosts[${index}].at is not a time`;
    if (entry.by !== undefined && (typeof entry.by !== 'string' || entry.by === '')) return `hosts[${index}].by is not a name`;
    if (seen.has(entry.host)) return `host '${entry.host}' is listed twice`;
    seen.add(entry.host);
  }
  return '';
}

/**
 * The policy: `{ ok: true, path, hosts: Map<host, {host, at, by?}> }`, or
 * `{ ok: false, path, reason, repair }` — the one inability every reader prints.
 */
export function readRetired(store) {
  const path = retiredPath(store);
  const cannot = why => ({ ok: false, path, reason: `the host retirement policy ${path} is malformed: ${why} — a malformed policy is never read as no retirement (F-028)`, repair: repairOf(path) });
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, path, hosts: new Map() };
    return cannot(`it cannot be read (${String(error?.message ?? error)})`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return cannot(`it is not JSON (${String(error?.message ?? error)})`);
  }
  const why = invalid(doc);
  if (why !== '') return cannot(why);
  return { ok: true, path, hosts: new Map(doc.hosts.map(entry => [entry.host, entry])) };
}

/** The sentence every reader prints for a retired host. */
export const retiredLine = entry => `host retired by operator at ${entry.at}${entry.by ? ` by ${entry.by}` : ''}`;

/**
 * The host a record's last attempt placed its worker-start on (`--on`, `''`
 * local), or undefined when no worker-start phase recorded an argv. Throws on
 * an argv this walk cannot read, as `argvValue` does.
 */
export function startHost(rec) {
  const attempts = Array.isArray(rec?.attempts) ? rec.attempts : [];
  const phases = Array.isArray(attempts[attempts.length - 1]?.phases) ? attempts[attempts.length - 1].phases : [];
  for (let i = phases.length - 1; i >= 0; i -= 1) {
    if (phases[i]?.name === 'worker-start' && Array.isArray(phases[i].argv)) return argvValue(phases[i].argv, '--on') ?? '';
  }
  return undefined;
}

/** temp + fsync + rename: a reader sees the old policy or the new one, never half. */
function save(path, doc) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temporary); } catch { /* nothing left to clean */ }
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
}

/**
 * Re-read under the policy lock, apply `change(hosts)` and save when it says
 * so: `{ ok: true, changed, entry }` or `{ ok: false, reason, repair }`.
 */
function mutate(store, change) {
  const path = retiredPath(store);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: `the policy directory ${dirname(path)} cannot be created: ${String(error?.message ?? error)}`, repair: `ls -ld ${store}` };
  }
  let lock;
  try {
    lock = acquireLock(path);
  } catch (error) {
    return { ok: false, reason: `the policy lock cannot be taken: ${String(error?.message ?? error)}`, repair: `ls -l ${path}.lock` };
  }
  if (!lock.held) return { ok: false, reason: lock.reason, repair: `ls -l ${path}.lock   # re-run once its holder has finished` };
  try {
    const policy = readRetired(store);
    if (!policy.ok) return policy;
    const result = change(policy.hosts);
    if (result.changed) save(path, { hosts: [...policy.hosts.values()] });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, reason: `the policy ${path} could not be written: ${String(error?.message ?? error)}`, repair: `ls -l ${path}` };
  } finally {
    lock.release();
  }
}

/** `<host> [--store <dir>]`, or the usage error. */
function parse(verb, argv, env) {
  let host = '';
  let store = defaultStore(env);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--store' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) store = argv[++i];
    else if (!argv[i].startsWith('-') && host === '') host = argv[i];
    else return { usage: `ax worker ${verb}: unexpected argument "${argv[i]}"` };
  }
  if (host === '') return { usage: `ax worker ${verb}: which host?` };
  if (!requestIdOk(host)) return { usage: `ax worker ${verb}: "${host}" is not a host name` };
  return { host, store };
}

const usage = (verb, message) => {
  process.stderr.write(`${message}\nax worker ${verb} <host> [--store <dir>]\n`);
  return 2;
};
const cannot = (reason, repair) => {
  bad(`CANNOT ESTABLISH — ${reason}`);
  fix(repair);
  return 3;
};

/** `ax worker retire-host <host>` — write the host off, only while it does not answer. */
export function retireHost(argv = [], { resolve = resolveOrca, runner, env = process.env, cwd = process.cwd(), declarations = declarationOf(cwd), now = () => new Date().toISOString() } = {}) {
  const parsed = parse('retire-host', argv, env);
  if (parsed.usage) return usage('retire-host', parsed.usage);
  const { host, store } = parsed;
  const rerun = `ax worker retire-host ${host} --store ${store}`;

  const policy = readRetired(store);
  if (!policy.ok) return cannot(policy.reason, policy.repair);
  const already = policy.hosts.get(host);
  if (already !== undefined) {
    ok(`host '${host}' is already retired — ${retiredLine(already)}`);
    return 0;
  }

  const declared = declarations();
  if (declared.retired) {
    bad(declared.retired.problem);
    fix(declared.retired.fix);
    return 1;
  }
  if (!declared.ok) return cannot(`${declared.reason}, so whether '${host}' answers cannot be asked`, rerun);
  if (!Object.hasOwn(declared.config?.dispatch?.hosts ?? {}, host)) {
    return cannot(`'${host}' is not declared in this checkout's dispatch.hosts, so whether it answers cannot be asked`, `ax.config.json: dispatch.hosts.${host}   # declare it, then ${rerun}`);
  }

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) return cannot('no Orca CLI on this machine, so the host cannot be asked', `orca open   # then ${rerun}`);
  const run = runner ?? createRunner({ bin });
  // A silent LOCAL runtime makes every host look silent: proven up first.
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(`${ready.reason} — a host asked through a silent runtime is not a silent host`, `orca open   # then ${rerun}`);

  const out = run(['terminal', 'list', '--environment', host, '--json']);
  if (out.status === 0 && out.receipt?.ok === true) {
    bad(`REFUSED — '${host}' answered its own terminal list, so it is not retired: a host that answers ends its panes one by one`);
    fix(`ax worker ls   # then ax worker close <handle> for each pane on '${host}'`);
    return 1;
  }
  const silence = String(out.receipt?.error?.message ?? out.stderr ?? '').trim().slice(0, 200);
  note(`'${host}' did not answer its terminal list${silence === '' ? '' : `: ${silence}`}`);

  const entry = { host, at: now(), ...(env.USER ? { by: env.USER } : {}) };
  const written = mutate(store, hosts => {
    const existing = hosts.get(host);
    if (existing !== undefined) return { changed: false, entry: existing };
    hosts.set(host, entry);
    return { changed: true, entry };
  });
  if (!written.ok) return cannot(written.reason, written.repair);
  ok(`host '${host}' retired — ${retiredLine(written.entry)}: its records leave the frontier and its Slots; every pane on it stays INCONNU, never MORT, and nothing is settled`);
  note(`ax worker unretire-host ${host}   # reverses it, should '${host}' ever answer again`);
  return 0;
}

/** `ax worker unretire-host <host>` — withdraw the operator's word; no host is asked. */
export function unretireHost(argv = [], { env = process.env } = {}) {
  const parsed = parse('unretire-host', argv, env);
  if (parsed.usage) return usage('unretire-host', parsed.usage);
  const { host, store } = parsed;
  const written = mutate(store, hosts => ({ changed: hosts.delete(host) }));
  if (!written.ok) return cannot(written.reason, written.repair);
  if (!written.changed) {
    ok(`host '${host}' was not retired — nothing changed`);
    return 0;
  }
  ok(`host '${host}' unretired: its records claim their tickets and count in its Slots again`);
  note(`a successor dispatched while '${host}' was retired keeps its record too: ax worker gate <task> reports the duplicate, and ax worker close <handle> ends one`);
  return 0;
}
