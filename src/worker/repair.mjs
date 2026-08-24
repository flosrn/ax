// `ax worker repair` — the composer-EMPTY sibling of the held-composer repair.
//
// The held case (start.mjs, repairHeld): Orca typed the brief into the composer
// and only the Enter was missing — one guarded Enter repairs it, automatically.
// This verb covers the variant measured 2026-08-23 on #59 pass 1: the replay
// created the worktree, the pane and the agent, and delivered NO input at all —
// pane alive, agent at its banner, composer empty. Nothing to Enter; the spec
// itself has to be re-delivered.
//
// It is delivered FROM THE RECORD, never recomposed: the worker-start argv
// carries the exact `--task` text, and a recomposed brief is a second identity
// (F-001). And the gesture stays explicit — a verb the operator invokes against
// one named request — because the entry condition cannot be proven from the
// receipt alone the way `heldComposer` can: an empty composer and a working
// session read the same in a summary, and only the pane's own cursor tells them
// apart, which this verb measures before it sends anything.
//
// `--delivered` records a repair the operator already performed by hand
// (measured the same day: a spec sent with `orca terminal send`, child working,
// and every ax verb still reporting the pass dead). It writes the same marker
// and arms the same watcher, and sends nothing.
//
// Exit codes mirror repairHeld's honesty: a repaired child is NOT a supervised
// worker — its Dispatch settled `failed`, its capability is revoked — so
// success here is 3, never 0. 1 refuses, 2 usage.

import { join } from 'node:path';

import { bad, fix, note, ok, raw } from '../log.mjs';
import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { redactSecrets } from '../redact.mjs';
import { paneVerdict } from './ls.mjs';
import { briefDelivered } from './delivered.mjs';
import { readPane, terminalInventory } from './pane.mjs';
import { defaultStore, heldRepaired, markHeldRepair, report, requestIdOk, workerPane, workerSpec } from './record.mjs';
import { armStallWatcher } from './start.mjs';

const USAGE = 'ax worker repair --request <id> [--delivered]';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

function cursorOf(run, handle, environment) {
  const pane = readPane(run, handle, { environment, limit: 1 });
  return pane.exit === 0 ? pane.cursor : null;
}

export function repair(argv = [], { resolve = resolveOrca, runner, env = process.env, sleep = sleepDefault, arm = armStallWatcher } = {}) {
  const usageError = message => {
    process.stderr.write(`ax worker repair: ${message}\n${USAGE}\n`);
    return 2;
  };
  const refuse = (message, repairLine) => {
    bad(redactSecrets(message));
    if (repairLine) fix(redactSecrets(repairLine));
    return 1;
  };
  const cannot = (message, repairLine) => {
    bad(redactSecrets(`CANNOT ESTABLISH — ${message}`));
    if (repairLine) fix(redactSecrets(repairLine));
    return 3;
  };

  let request = '';
  let delivered = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request') request = argv[(i += 1)] ?? '';
    else if (arg === '--delivered') delivered = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }
  if (request === '') return usageError('no --request given');
  if (!requestIdOk(request)) return usageError(`invalid --request "${request}"`);

  const path = join(defaultStore(env), `${request}.json`);
  let state;
  try {
    state = report(path);
  } catch (error) {
    if (error.code === 'ENOENT') return cannot(`no record at ${path} — a repair replays a recorded dispatch, and absence is not permission to invent one`);
    return cannot(`record at ${path} is unreadable: ${String(error.message ?? error)}`);
  }
  if (state.usable) {
    return refuse('this record already names a working dispatch — there is nothing to repair', `ax worker tail ${request}   # what its pane is doing`);
  }
  // Idempotent, like an identical re-answer: the truth is already on record.
  if (heldRepaired(path)) {
    ok('already repaired — the record already says a child runs behind this failed Dispatch, and status reads it');
    return 0;
  }

  let pane;
  try {
    pane = workerPane(path);
  } catch (error) {
    return refuse(
      `this record names no pane (${String(error.message ?? error)}) — there is nothing to deliver into`,
      `ax worker start --resume --request ${request}   # settle the mutation first (F-001)`,
    );
  }

  // ── the machine, and the pane's REAL state ─────────────────────────────────
  const bin = runner ? null : resolve({ env });
  if (!runner && bin === null) return cannot('no Orca CLI on this machine — a pane cannot be repaired blind');
  const run = runner ?? createRunner({ bin });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # nothing was sent — re-run once the runtime answers');

  const inventory = terminalInventory(run, { environment: pane.env });
  if (!inventory.ok) return cannot(inventory.reason, 'orca open   # a pane that cannot be read is never repaired into');
  const verdict = paneVerdict(pane.handle, 'this record names a pane the inventory cannot see', inventory);
  if (verdict.pane === 'MORT') {
    return refuse(
      `the recorded pane is gone (${verdict.detail}) — there is no session to deliver a brief into`,
      `ax triage dispatch --issue <n> --fresh --because <text>   # a triage pass; or ax worker start --replace --request ${request}`,
    );
  }
  if (verdict.pane === 'INCONNU') {
    return cannot(`${verdict.detail} — an absence from a partial terminal list is not a death, and not a pane either (F-028)`, 'ax worker ls   # read the pane\'s real state first');
  }

  // ── the two modes ──────────────────────────────────────────────────────────
  // `finish` is where the marker gets written, and the marker asserts something
  // strong: this failed Dispatch has a child behind it that is genuinely
  // running, so the watcher must not report its ordinary end as a death. Two
  // sources may support that, and no third:
  //
  //   MEASURED — an emitting pane (cursor movement, the liveness proof
  //   AGENTS.md names) whose session holds the brief, or an Enter/spec this verb
  //   sent that made the pane advance.
  //
  //   ASSERTED — `--delivered`, where the operator states they watched it work.
  //   That is deliberately not a cursor read: the flag exists for the case
  //   measured 2026-08-23, a spec delivered by hand with the child plainly
  //   working while every ax verb reported the pass dead. The claim is the
  //   operator's, the flag names them, and ax records it as theirs.
  //
  // What may never write it is an INFERENCE by ax — a receipt with no liveness,
  // or a still cursor read as a held composer.
  const finish = () => {
    // WRITE-AHEAD before arming, for the watcher-race reason start.mjs records:
    // the watcher reads this marker ONCE at startup.
    markHeldRepair(path);
    arm({ request, bin: bin ?? 'injected', env });
    bad('NOT A SUPERVISED WORKER — this Dispatch settled `failed`, so its capability is revoked and any worker_done it sends will be rejected.');
    note('The child is running: its own peer report, and the watcher armed above, are the channels that still reach you.');
    fix(redactSecrets(`ax worker transcript ${request}   # what it is doing. Do NOT relaunch: that is a second agent in one worktree.`));
    return 3;
  };

  if (delivered) {
    note('--delivered: recording a repair the operator already performed, on their word — nothing is sent and no cursor is read.');
    return finish();
  }

  // THE SESSION SAYS WHETHER THE BRIEF ARRIVED; THE CURSOR SAYS WHETHER ANYONE
  // IS THERE. Neither answers the other's question, so both are read and the
  // decision waits for both.
  //
  // Measured 2026-08-24: `agent_prompt_stalled` normally covers a child that
  // already HAS the brief and is waiting on a model — Orca allows the pane 5s to
  // report `working` through its status title and a cold OMP session cannot (see
  // ./delivered.mjs). Such a child is silent, so the cursor probes below read it
  // as idle and the Enter probe finds an empty composer; the send that follows
  // would put the whole spec in front of a session already working on it.
  //
  // A silent witness does NOT stop this verb, unlike the automatic path in
  // start.mjs: an operator aimed it at one named request, and the measured
  // empty-composer case (#59, 2026-08-23) has no other repair. What it does get
  // is the truth about what is being decided on — a remote child's session lives
  // on its own host, so this line is the normal answer for `--on`.
  const witness = briefDelivered(path, { env });
  if (witness.known && witness.delivered) {
    note(redactSecrets(`the child's own session recorded the brief${witness.at ? ` at ${witness.at}` : ''}, so nothing may be delivered into that pane again.`));
  } else if (!witness.known) {
    note(redactSecrets(`NO SESSION WITNESS — ${witness.reason}; what follows is decided on the pane's cursor alone, which cannot tell an idle composer from a child waiting on a model.`));
  }

  let spec;
  try {
    spec = workerSpec(path);
  } catch (error) {
    return refuse(`${String(error.message ?? error)} — with no recorded brief there is nothing to deliver, and recomposing one is a second identity (F-001)`);
  }

  // A spec sent into a WORKING session is a second prompt injected mid-task, so
  // the cursor decides first: sampled twice, a moving pane refuses.
  const gapMs = Math.max(0, Number(env.ORCA_DISPATCH_AUTOSUBMIT_GAP ?? 8) * 1000);
  // The brief travels on `--text`, ONE argv element, and that is a decision to
  // keep straight against the package's own "bodies go to files" rule: that
  // rule holds where a file channel EXISTS (`gh --body-file`, `--spec-file`) or
  // where a SHELL could mangle the text. Neither is true here — the live CLI
  // exposes no file or stdin payload for `terminal send` (measured 2026-08-23:
  // `--text` is its only transport), and this runner is spawnSync over an argv
  // ARRAY with no shell anywhere between. The exact gesture was field-proven
  // the same day: 3298 bytes of spec, accepted, child working.
  const send = extra => {
    const args = ['terminal', 'send', '--terminal', pane.handle];
    if (pane.env) args.push('--environment', pane.env);
    return run([...args, ...extra, '--json']);
  };
  const before = cursorOf(run, pane.handle, pane.env);
  if (before === null) return cannot('the pane\'s cursor cannot be read — emitting and idle are indistinguishable, and only an idle pane may be repaired into');
  sleep(gapMs);
  const again = cursorOf(run, pane.handle, pane.env);
  if (again === null) return cannot('the pane\'s cursor cannot be re-read — nothing proves the pane is idle');
  const emitting = again !== before;

  // ALIVE and it HAS the brief: that is the one state where a marker is honest,
  // and it is why the emitting pane is no longer a flat refusal. Cursor movement
  // is the liveness proof AGENTS.md demands, the session is the receipt proof,
  // and only together do they license silencing the watcher's death check for a
  // Dispatch Orca settled `failed`.
  if (emitting && witness.known && witness.delivered) {
    ok('the pane is EMITTING and its session holds the brief — the child is alive and working on it; nothing was sent.');
    return finish();
  }
  if (emitting) {
    return refuse(
      'the pane is EMITTING — a brief sent into a working session is a second prompt, not a repair',
      `ax worker tail ${request}   # read what it is doing; if that is not the task, release it and redo`,
    );
  }

  // IDLE, but the brief is already in its session: a child between turns, or one
  // that recorded the brief and then died. Receipt is not liveness, so nothing is
  // sent and NOTHING IS RECORDED — the marker would silence the one check that
  // can still tell those two apart. The watcher itself is armed, because this is
  // the state most in need of it, and because a line promising a death report
  // while arming nothing is the same class of false claim as the phantom Enter
  // this whole change removed.
  if (witness.known && witness.delivered) {
    arm({ request, bin: bin ?? 'injected', env });
    bad('the pane is IDLE while its session already holds the brief — the child received it, but nothing here proves it is still alive.');
    note('No repair is recorded, so the watcher armed above keeps its right to report this pane as a death.');
    fix(redactSecrets(`ax worker transcript ${request}   # what it did with the brief`));
    fix(redactSecrets(`ax worker repair --request ${request} --delivered   # if you can SEE it working, record that yourself`));
    return 3;
  }

  // An idle pane is still TWO different worlds, and no receipt tells them
  // apart: a HELD composer (the brief typed, Enter missing — the case
  // start.mjs repairs with one Enter) and an EMPTY one (nothing typed at all,
  // measured 2026-08-23 on #59). Injecting the spec into a held composer would
  // append a SECOND copy above the one already typed. The discriminator is
  // measurable: an Enter alone SUBMITS a held composer and is a no-op on an
  // empty one — so the Enter goes first, and the text only after the no-op has
  // proven the emptiness.
  const probed = send(['--enter']);
  if (probed.status !== 0 || probed.receipt?.ok !== true) {
    return cannot(`orca refused the Enter probe (exit ${probed.status}): ${String(probed.receipt?.error?.message ?? probed.stderr ?? '').slice(0, 200)} — nothing was sent beyond it`);
  }
  sleep(gapMs);
  const afterEnter = cursorOf(run, pane.handle, pane.env);
  if (afterEnter === null) return cannot('the pane cannot be read after the Enter probe — whether it submitted a held brief is unknown, and no repair is recorded');
  if (afterEnter !== before) {
    ok('the composer was HELD — the brief was already typed, and one Enter submitted it.');
    return finish();
  }

  const sent = send(['--text', spec, '--enter']);
  if (sent.status !== 0 || sent.receipt?.ok !== true) {
    return cannot(`orca refused the send (exit ${sent.status}): ${String(sent.receipt?.error?.message ?? sent.stderr ?? '').slice(0, 200)} — nothing was proven delivered`);
  }

  sleep(gapMs);
  const after = cursorOf(run, pane.handle, pane.env);
  if (after === null || after === before) {
    // The send was ACCEPTED and the pane did not advance: the one state that
    // must never be recorded as a repair — an unproven submission buried the
    // 2026-08-22 briefs, and the marker would tell the watcher to trust it.
    return cannot(
      `the send was accepted but the pane did not advance (cursor ${before} → ${after ?? 'unreadable'}) — the brief is NOT proven delivered, and no repair is recorded`,
      `orca terminal read --terminal ${pane.handle} --limit 60 --json   # look, then re-run or --delivered if you see it running`,
    );
  }

  ok(`the composer was EMPTY (the Enter probe moved nothing) — the recorded brief (${spec.length} bytes) was delivered into ${pane.handle}, and the pane advanced.`);
  return finish();
}
