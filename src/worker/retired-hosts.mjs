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
// proven up, under the host's admission lock so no dispatch admits onto it
// meanwhile; any answer refuses and points to `ax worker close`, which ends a
// pane on a host that can still say it ended. Only a receipt naming a dialled
// host that did not answer is silence: a silent local runtime, an undeclared
// or unpaired host, an unreadable config, a held admission lock or any other
// Orca error cannot establish it, so they write nothing. Unretiring needs no
// reachability: it only withdraws the operator's word.
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
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok } from '../log.mjs';
import { declarationOf } from './hosts.mjs';
import { acquireHostLock, acquireLock, argvValue, defaultStore, HOSTS_NS, requestIdOk, saveJson } from './record.mjs';
import { lockWaitMs } from './start.mjs';

// The receipt codes that mean the paired host was dialled and did not answer.
// `--environment` sends straight over the pairing's websocket, never through
// the local runtime (orca src/cli/runtime/client.ts:118-122), so these name the
// remote: `remote_runtime_unavailable` is "Could not connect to the remote Orca
// runtime." or a closed connection (orca src/shared/remote-runtime-request-
// socket.ts:206-208, remote-runtime-request-frames.ts:24-27), and
// `runtime_timeout` is "Timed out waiting for the remote Orca runtime to
// respond." (remote-runtime-request-frames.ts:30-34). Anything else — an
// unpaired or ambiguous selector (`invalid_argument`, orca src/cli/execution-
// host-flag.ts:162-206, raised before any host is contacted), a malformed
// response, or no receipt at all — establishes no silence.
const SILENT_CODES = new Set(['remote_runtime_unavailable', 'runtime_timeout']);

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

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

/** The retirement entry `policy` holds for `host`, or undefined for a non-string or empty host. */
export const retiredEntry = (policy, host) => (typeof host === 'string' && host !== '' ? policy.hosts.get(host) : undefined);

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
    if (result.changed) saveJson({ hosts: [...policy.hosts.values()] }, path);
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
export function retireHost(argv = [], { resolve = resolveOrca, runner, env = process.env, cwd = process.cwd(), declarations = declarationOf(cwd), now = () => new Date().toISOString(), waitMs = Number(env.AX_LOCK_WAIT_MS ?? lockWaitMs), sleep = sleepDefault, clock = Date.now } = {}) {
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

  // Admission holds this lock from its Slot re-read through the worker-start
  // write-ahead; retirement takes it before asking the host and keeps it
  // through the policy write (host lock first, then the policy lock), so no
  // admission lands on a host between "it is silent" and "it is retired".
  let lock;
  try {
    lock = acquireHostLock(store, host, { waitMs, sleep, clock });
  } catch (error) {
    return cannot(`the admission lock of '${host}' cannot be taken: ${String(error?.message ?? error)}`, `ax worker hosts ${host}   # then ${rerun}`);
  }
  if (!lock.held) return cannot(`the admission lock of '${host}' is held — ${lock.reason}`, `ax worker hosts ${host}   # once its admission finishes, ${rerun}`);
  try {
    const out = run(['terminal', 'list', '--environment', host, '--json']);
    if (out.status === 0 && out.receipt?.ok === true) {
      bad(`REFUSED — '${host}' answered its own terminal list, so it is not retired: a host that answers ends its panes one by one`);
      fix(`ax worker ls   # then ax worker close <handle> for each pane on '${host}'`);
      return 1;
    }
    const code = out.receipt?.error?.code;
    const said = String(out.receipt?.error?.message ?? out.stderr ?? '').trim().slice(0, 200);
    if (!SILENT_CODES.has(code)) {
      return cannot(`Orca's terminal list for '${host}' ${typeof code === 'string' ? `failed ${code}` : 'returned no error receipt'}${said === '' ? '' : `: ${said}`} — not a host that was dialled and did not answer`, `orca host list   # check '${host}' is a paired Orca server (orca environment show --environment ${host}), then ${rerun}`);
    }
    note(`'${host}' did not answer its terminal list (${code})${said === '' ? '' : `: ${said}`}`);

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
  } finally {
    lock.release();
  }
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
