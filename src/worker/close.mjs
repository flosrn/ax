// `ax worker close <handle|request>` ends one pane on the operator's word.
// It proves no landing and touches no branch, worktree or PR. The worker-start
// owns the immutable record/attempt/phase/dispatch/host/handle binding; a record
// lock protects re-validation through the additive ending against --replace.
//
// terminal close has no retry identity. Write issued BEFORE calling Orca, then
// persist its receipt before checking the host's own inventory. Recovery NEVER
// reissues once `issued` is saved: absence without a ptyKilled:true receipt
// cannot prove a process stop. A `prepared` operation was never sent, so its
// one close is issued on recovery.
// A closed operation survives an ending-save failure and can finish that write.
//
// Exit codes (ADR 0003 — per verb):
//   0 operator ending written, or that exact ending already recorded
//   1 refused: no/ambiguous tuple, pane already absent, stop-unverified
//   2 usage error
//   3 cannot establish: unreadable store/operation, held lock, unreachable host,
//     uncovered inventory, or a durable write failed; never permission to retry close
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRunner, resolveOrca } from '../orca-bin.mjs';
import { bad, fix, ok } from '../log.mjs';
import { declarationOf, quote } from './hosts.mjs';
import { terminalInventory } from './pane.mjs';
import { acquireLock, agentTerminal, argvValue, attemptEnd, CLOSE_NS, defaultStore, OPERATOR_CLOSE, saveCloseOperation, scanStore } from './record.mjs';

const USAGE = 'ax worker close <handle|request> [--store <dir>]';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every worker-start is a separate candidate, including older attempts. */
function tuples(store, subject) {
  const scanned = scanStore(store);
  if (scanned.missing || scanned.reason || scanned.unreadable.length) throw new Error(scanned.reason || scanned.unreadable.map(row => `${row.file}: ${row.error}`).join('; '));
  const found = [];
  for (const { file, rec } of scanned.records) {
    if (!Array.isArray(rec.attempts)) throw new Error(`${file}: attempts is not a list`);
    for (const attempt of rec.attempts) {
      if (!Number.isInteger(attempt?.n) || !Array.isArray(attempt.phases)) throw new Error(`${file}: malformed attempt`);
      attempt.phases.forEach((phase, index) => {
        if (phase?.name !== 'worker-start') return;
        if (!Array.isArray(phase.argv) || phase.argv.some(arg => typeof arg !== 'string')) throw new Error(`${file}: worker-start has no readable argv`);
        const result = phase.receipt?.result;
        const handle = agentTerminal(result);
        if (subject !== rec.request && subject !== handle) return;
        if (handle === null || typeof result?.dispatchId !== 'string' || !result.dispatchId || typeof phase.identity !== 'string') return;
        found.push({ path: join(store, file), request: rec.request, attempt: attempt.n, phase: index, identity: phase.identity, dispatchId: result.dispatchId, host: argvValue(phase.argv, '--on') ?? '', handle });
      });
    }
  }
  return found;
}

export function close(argv = [], { resolve = resolveOrca, runner, env = process.env, cwd = process.cwd(), declarations = declarationOf(cwd), endAttempt = attemptEnd, now = () => new Date().toISOString() } = {}) {
  let subject = '', store = defaultStore(env);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--store' && argv[i + 1] && !argv[i + 1].startsWith('-')) store = argv[++i];
    else if (!argv[i].startsWith('-') && !subject) subject = argv[i];
    else { process.stderr.write(`${USAGE}\n`); return 2; }
  }
  if (!subject) { process.stderr.write(`${USAGE}\n`); return 2; }
  const refuse = (code, reason, repair) => { bad(reason); fix(repair); return code; };
  const rerun = `ax worker close ${quote(subject)} --store ${quote(store)}`;
  let candidates;
  try { candidates = tuples(store, subject); }
  catch (error) { return refuse(3, `CANNOT ESTABLISH — ${error.message}`, 'ax worker ls --all   # repair the unreadable dispatch store first'); }
  if (candidates.length !== 1) return refuse(1, candidates.length === 0
    ? `REFUSED — no worker-start tuple names ${subject}`
    : `REFUSED — ${subject} names several panes: ${candidates.map(t => `${t.handle} (${t.request}, attempt ${t.attempt}, phase ${t.phase}, ${t.host || 'here'})`).join('; ')}`,
    candidates.length ? 'ax worker close <handle>   # choose one of the named panes' : 'ax worker ls --all   # name a recorded pane or request');
  const tuple = candidates[0];
  let lock;
  try { lock = acquireLock(tuple.path); }
  catch (error) { return refuse(3, `CANNOT ESTABLISH — ${error.message}`, rerun); }
  if (!lock.held) return refuse(3, `CANNOT ESTABLISH — ${lock.reason}`, `${rerun}   # once the record's holder finishes`);
  try {
    const rebound = tuples(store, subject);
    if (rebound.length !== 1 || !same(rebound[0], tuple)) return refuse(3, 'CANNOT ESTABLISH — the bound worker-start changed under the record lock', rerun);
    const id = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
    const operationPath = join(store, CLOSE_NS, `${id}.json`);
    let operation;
    try { operation = read(operationPath); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      operation = null;
    }
    if (operation && (!same(operation.tuple, tuple) || !['prepared', 'issued', 'closed', 'ended', 'stop-unverified'].includes(operation.state))) return refuse(3, 'CANNOT ESTABLISH — the close operation does not bind this tuple', `cat ${quote(operationPath)}   # never issue another close`);
    const stopReceipt = operation?.receipt?.result?.close;
    if (operation && ['closed', 'ended'].includes(operation.state) &&
        (operation.receipt?.ok !== true || operation.exit !== 0 || stopReceipt?.handle !== tuple.handle ||
         stopReceipt.ptyKilled !== true || operation.absence?.handle !== tuple.handle ||
         operation.absence?.host !== tuple.host || operation.absence?.covered !== true ||
         operation.ending?.operation !== operationPath)) {
      return refuse(3, 'CANNOT ESTABLISH — closed operation lacks its bound stop receipt and covering absence proof', `cat ${quote(operationPath)}   # process check; never issue another close`);
    }
    const processRepair = `orca orchestration worker-show --dispatch ${quote(tuple.dispatchId)} --json   # process check on ${tuple.host || 'here'}: inspect the recorded worktree and its processes; pane absence is not a stopped PTY`;
    const stopped = () => refuse(1, `STOP-UNVERIFIED — ${tuple.handle}: no confirmed process stop; no ending written`, processRepair);
    if (operation?.state === 'ended') { ok(`${tuple.handle}: operator ending already recorded`); return 0; }
    if (operation?.state === 'stop-unverified') return stopped();
    let run = runner;
    if (!run) {
      const bin = resolve({ env });
      if (!bin) return refuse(3, 'CANNOT ESTABLISH — no Orca CLI', 'orca open   # then re-run close');
      run = createRunner({ bin });
    }
    // Always ask a remote binding's OWN host, even if a local union lists it.
    // A fresh inventory for each read: the pre-close pane must not survive into
    // the post-close proof.
    const inventory = () => {
      const scope = terminalInventory(run, { environment: tuple.host });
      return { scope, covered: scope.ok && Array.isArray(scope.hosts) && scope.hosts.includes('local') };
    };
    if (operation?.state !== 'closed') {
      if (tuple.host) {
        const declared = declarations();
        if (!declared.ok) return refuse(3, `CANNOT ESTABLISH — ${declared.reason}`, rerun);
        if (!Object.hasOwn(declared.config?.dispatch?.hosts ?? {}, tuple.host)) return refuse(3, `CANNOT ESTABLISH — ${tuple.host} is not declared in dispatch.hosts`, rerun);
      }
      const before = inventory();
      if (!before.covered) return refuse(3, `CANNOT ESTABLISH — ${tuple.host || 'here'} did not answer for its own panes: ${before.scope.reason || 'inventory scope uncovered'}`, rerun);
      // `prepared` is saved before `issued`: the close was provably never sent,
      // so it is issued once here exactly as a fresh operation would be.
      if (!operation || operation.state === 'prepared') {
        if (!before.scope.byHandle.has(tuple.handle)) return refuse(1, `REFUSED — ${tuple.handle} is already absent; nothing closed`, `ax worker settle ${quote(tuple.request)}`);
        const argv = ['terminal', 'close', '--terminal', tuple.handle, ...(tuple.host ? ['--environment', tuple.host] : []), '--json'];
        if (operation && !same(operation.argv, argv)) return refuse(3, 'CANNOT ESTABLISH — the prepared close does not name this pane', `cat ${quote(operationPath)}   # never issue another close`);
        if (!operation) {
          operation = { tuple, state: 'prepared', at: now(), receipt: null, argv };
          saveCloseOperation(operationPath, operation);
        }
        operation.state = 'issued';
        saveCloseOperation(operationPath, operation);
        let out;
        try { out = run(operation.argv); }
        catch (error) { out = { status: null, receipt: null, stderr: String(error) }; }
        operation.receipt = out.receipt ?? null;
        operation.exit = out.status ?? null;
        saveCloseOperation(operationPath, operation);
      }
      const receipt = operation.receipt;
      const closeReceipt = receipt?.result?.close ?? receipt?.error?.data?.close;
      if (receipt?.ok !== true || closeReceipt?.handle !== tuple.handle || closeReceipt?.ptyKilled !== true || operation.exit !== 0) {
        operation.state = 'stop-unverified';
        saveCloseOperation(operationPath, operation);
        return stopped();
      }
      const after = inventory();
      if (!after.covered) return refuse(3, `CANNOT ESTABLISH — post-close inventory of ${tuple.host || 'here'} is uncovered`, rerun);
      if (after.scope.byHandle.has(tuple.handle)) return refuse(3, `CANNOT ESTABLISH — ${tuple.handle} is still listed; no ending written`, processRepair);
      operation.state = 'closed';
      operation.absence = { handle: tuple.handle, host: tuple.host, covered: true, at: now() };
      operation.ending = { cause: OPERATOR_CLOSE, handle: tuple.handle, host: tuple.host, at: now(), operation: operationPath };
      saveCloseOperation(operationPath, operation);
    }
    endAttempt(tuple.path, tuple, operation.ending);
    operation.state = 'ended';
    saveCloseOperation(operationPath, operation);
    ok(`${tuple.handle}: operator ending recorded on ${tuple.request} attempt ${tuple.attempt}`);
    return 0;
  } catch (error) {
    return refuse(3, `CANNOT ESTABLISH — ${error.message}; no second terminal close is permitted`, rerun);
  } finally { lock.release(); }
}
