// The LAUNCHED receipt and its four proofs — the model marker applied by the
// adapter, the worker role, the implementation playbook, and pane movement.
// Extracted from launch.mjs so the verification loop answers through its own
// interface (a record path, a transcript, a cursor sequence) instead of only
// through a full ticket-and-placement pipeline. The cursor predicate here is
// this verb's own disposition, as pane.mjs's header prescribes.

import { basename, join } from 'node:path';

import { bad, fix, note, ok, section } from '../log.mjs';
import { defaultStore, workerPane } from './record.mjs';
import { readPane } from './pane.mjs';
import { launchProof } from './transcript.mjs';
import { quote, remote } from './hosts.mjs';

const firstLine = text => String(text ?? '').split('\n')[0].trim();

/**
 * Four proofs, one verdict shape on both hosts: the model marker was applied by
 * the adapter, the `worker` role and its implementation playbook reached the
 * first turn, and the pane emitted.
 *
 * The transcript is authoritative for both configuration effects. A child's
 * own model word is stale after a switch; a composed `[omp role=…]` line proves
 * only that the parent wrote an intention. The hidden role receipt is written
 * by the child-side extension after OMP discovery and skill loading. Remotely
 * the identical reader runs on the machine holding that transcript.
 *
 * Liveness is CURSOR MOVEMENT, never duration: two samples, and any advance
 * proves the pty emitted.
 */
export function verify({ run, env, on, wait, worktree, request, ticket, instruction, lineage, sessionsRoot, host, exec, cwd, now, sleep, tickMs }) {
  const recordPath = join(defaultStore(env), `${request}.json`);
  let pane = '';
  try {
    pane = workerPane(recordPath).handle;
  } catch {
    pane = '';
  }

  // `ticket === null` is a launch dispatched by name: there is no id, no title
  // and no url, and printing empty fields would read as a tracker that failed.
  section(ticket === null ? `LAUNCHED ${request} — ${instruction}` : `LAUNCHED ${ticket.id} — ${ticket.title}`);
  if (ticket === null) note('ticket    none — dispatched by name, and the brief is the whole definition of the work');
  else note(`ticket    ${ticket.url}  (${ticket.state})`);
  note(`host      ${on === '' ? 'here' : on}`);
  if (worktree !== '') note(`worktree  ${worktree}`);
  note(`request   ${request}`);
  note(`pane      ${pane === '' ? 'unnamed by the receipt' : pane}`);
  note(`lineage   ${lineage}`);

  if (wait === 0) {
    note('verified  skipped (--wait 0)');
    return 0;
  }

  const needle = basename(worktree === '' ? request : worktree);
  const deadline = now() + wait * 1000;
  let model = null;
  let sessionRole = null;
  let first = null;
  let moved = null;

  // EACH PROPOSITION IS LATCHED SEPARATELY, and that is the whole reason this is
  // three variables instead of one `proof`. `launchProof` answers non-null the
  // moment a session FILE exists, with both fields still null inside it — and
  // that file exists as soon as the child boots, carrying only the boot
  // `model_change` Orca writes before the spec marker applies and long before
  // the child-side role receipt is written. Measured 2026-08-26 across two
  // launches of one live wave: a loop that stopped re-reading once the OBJECT
  // was non-null printed `model …|` and `session unreadable`, exit 3, on two
  // children that were on the marker's model with the role applied twenty
  // seconds later. It reported the absence of a receipt as the absence of the
  // thing (F-028), and it cost the coordinator a manual `tail` per launch to
  // disbelieve its own gate.
  //
  // So the loop is settled only when the model has a MOVER (`role !== ''`, i.e.
  // someone selected it) and the role receipt exists in either polarity —
  // `applied` or `refused`. A refusal is a real verdict and stops the wait; an
  // empty mover is indistinguishable from "not yet" and therefore keeps it.
  const settled = () => model !== null && model.role !== '' && sessionRole !== null;

  for (;;) {
    if (!settled()) {
      const proof = readProof({ needle, env, sessionsRoot, host, exec, cwd });
      // The file is cumulative, so a later read supersedes an earlier one: the
      // quota fallback that follows a marker is the model the child serves.
      if (proof !== null) {
        if (proof.model !== null) model = proof.model;
        if (proof.sessionRole !== null) sessionRole = proof.sessionRole;
      }
    }
    if (pane !== '') {
      const sample = readPane(run, pane, { limit: 1, environment: on });
      const cursor = sample.cursor;
      if (cursor !== null) {
        if (first === null) first = cursor;
        else if (cursor !== first) moved = cursor;
      }
    }
    if (settled() && moved !== null) break;
    if (now() >= deadline) break;
    sleep(tickMs);
  }

  const skillNames = sessionRole?.status === 'applied' ? sessionRole.skills : [];
  note(`model     ${model === null ? 'unreadable' : `${model.model}|${model.role}`}`);
  note(
    `session   ${
      sessionRole === null
        ? 'not written within the window'
        : sessionRole.status === 'refused'
          ? `${sessionRole.role}|REFUSED ${sessionRole.reason}`
          : `${sessionRole.role}|${skillNames.join(',') || 'no skills'}`
    }`,
  );
  note(`liveness  cursor ${first === null ? 'unreadable' : first} -> ${moved === null ? 'unchanged' : moved}`);

  const roleReady =
    sessionRole?.status === 'applied' &&
    sessionRole.role === 'worker' &&
    skillNames.includes('implementation');
  if (model !== null && model.role === 'default' && roleReady && moved !== null) {
    ok('verified  the role, playbook, model marker, and pane movement are proven');
    fix(`ax worker tail ${pane || '<pane>'}`);
    return 0;
  }

  if (model === null) {
    bad('UNPROVEN model: no transcript yet. The child may still be booting, or its transcript sits on another host and was unreadable from here.');
  } else if (model.role === '') {
    bad(`UNPROVEN model: the child still runs its BOOT model after ${wait}s — the spec marker did not apply.`);
  } else if (model.role === 'fallback') {
    bad('UNPROVEN model: the quota chain moved this session, so the marker is not what decided.');
  } else {
    bad(`UNPROVEN model: ${model.model}|${model.role}`);
  }
  if (sessionRole === null) {
    bad(`UNPROVEN session role: no child-side role receipt was written within ${wait}s.`);
  } else if (sessionRole.status === 'refused') {
    const missing = sessionRole.missingSkills.length === 0 ? '' : `; missing ${sessionRole.missingSkills.join(', ')}`;
    bad(`REFUSED session role ${sessionRole.role}: ${sessionRole.reason}${missing}`);
  } else if (sessionRole.role !== 'worker') {
    bad(`UNPROVEN session role: expected worker, got ${sessionRole.role}`);
  } else if (!skillNames.includes('implementation')) {
    bad(`UNPROVEN session playbook: worker did not receive implementation (received ${skillNames.join(', ') || 'none'})`);
  }
  if (moved === null) {
    bad(`UNPROVEN liveness: the pane cursor did not advance within ${wait}s. A live in-place spinner also emits no new line — read the pane before concluding.`);
  }
  note('The dispatch DID happen. Do NOT relaunch (F-001) — inspect it:');
  fix(`ax worker start --show --request ${request}`);
  return 3;
}

/** The same launch proof read, wherever the transcript lives. */
function readProof({ needle, env, sessionsRoot, host, exec, cwd }) {
  if (host === null) return launchProof({ needle, env, sessionsRoot });
  const root = host.sessions ?? '';
  if (root === '') return null;
  // Through ssh because ssh rejoins its arguments into one remote command.
  // Every value is quoted as data, and the target grammar is closed by remote().
  const out = remote(
    args => exec('ssh', args, cwd),
    host.ssh,
    `ax worker transcript --launch-proof ${quote(needle)} --sessions ${quote(root)}`,
  );
  if (out.error || out.status !== 0) return null;
  const answer = firstLine(out.stdout);
  if (answer === '') return null;
  try {
    const parsed = JSON.parse(answer);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}
