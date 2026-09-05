// The DISPATCHED receipt and its four proofs — the model marker applied by the
// adapter, the worker role, the implementation playbook, and pane movement.
// Extracted from dispatch.mjs so the verification loop answers through its own
// interface (a record path, a transcript, a cursor sequence) instead of only
// through a full ticket-and-placement pipeline. The cursor predicate here is
// this verb's own disposition, as pane.mjs's header prescribes.

import { basename, join } from 'node:path';

import { bad, fix, note, ok, section, warn } from '../log.mjs';
import { defaultStore, workerPane } from './record.mjs';
import { equipment } from './child.mjs';
import { readPane } from './pane.mjs';
import { dispatchProof } from './transcript.mjs';
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
export function verify({ run, env, on, wait, worktree, request, ticket, instruction, lineage, sessionsRoot, host, exec, cwd, now, sleep, tickMs, equipmentProbe = equipment }) {
  const recordPath = join(defaultStore(env), `${request}.json`);
  let pane = '';
  try {
    pane = workerPane(recordPath).handle;
  } catch {
    pane = '';
  }

  // `ticket === null` is a dispatch made by name: there is no id, no title
  // and no url, and printing empty fields would read as a tracker that failed.
  section(ticket === null ? `DISPATCHED ${request} — ${instruction}` : `DISPATCHED ${ticket.id} — ${ticket.title}`);
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
  // three variables instead of one `proof`. `dispatchProof` answers non-null the
  // moment a session FILE exists, with both fields still null inside it — and
  // that file exists as soon as the child boots, carrying only the boot
  // `model_change` Orca writes before the spec marker applies and long before
  // the child-side role receipt is written. Measured 2026-08-26 across two
  // dispatches of one live wave: a loop that stopped re-reading once the OBJECT
  // was non-null printed `model …|` and `session unreadable`, exit 3, on two
  // children that were on the marker's model with the role applied twenty
  // seconds later. It reported the absence of a receipt as the absence of the
  // thing (F-028), and it cost the orchestrator a manual `tail` per launch to
  // disbelieve its own gate.
  //
  // So the loop is settled only when the model has a MOVER (`role !== ''`, i.e.
  // someone selected it) and the role receipt exists in either polarity —
  // `applied` or `refused`. A refusal is a real verdict and stops the wait; an
  // empty mover is indistinguishable from "not yet" and therefore keeps it.
  const settled = () => model !== null && model.role !== '' && sessionRole !== null;

  for (;;) {
    if (!settled()) {
      const proof = readProof({ needle, worktree, env, sessionsRoot, host, exec, cwd });
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

  // THE CAUSE, WHEN IT CAN BE NAMED. Both configuration proofs are written by the
  // child's own AX bundle, so a child that booted before that bundle was
  // installed writes NEITHER, ever — while its pane moves and `gate` calls it
  // LIVE. Measured 2026-08-28 (ofmchat #101): this verdict was correct and was
  // overruled by `--show`, `gate` and `tail`, because none of those three answers
  // who the session is and this line did not exist. `dispatch` now proves the bundle
  // before dispatching; a dispatch made any other way, or an install that relinks
  // mid-flight, still lands here. The probe is a NAMED dependency with a real
  // default, like every other machine answer this function takes.
  if (model?.role === '' && sessionRole === null && worktree !== '' && on === '') {
    const equip = equipmentProbe(worktree);
    if (equip.measured && !equip.ready) {
      bad(`CAUSE: this worktree cannot load its AX bundle (${equip.wiring ? equip.reason : equip.missing.join(', ')}), so nothing in that child ever consumed its role marker — it is working UNEQUIPPED, not still booting`);
      fix(equip.wiring ? 'ax init   # then settle this dispatch and re-dispatch' : `run your package manager's install in ${worktree}   # then settle this dispatch and re-dispatch`);
      note('Its work is real and its model is not the one you asked for: decide whether to keep it before anything else. A live pane is never dispatched over (F-001).');
    }
  }

  note('The dispatch DID happen. Do NOT re-dispatch (F-001) — inspect it:');
  fix(`ax worker start --show --request ${request}`);
  return 3;
}

/**
 * The same session proof read, wherever the transcript lives.
 *
 * The remote flag is `--dispatch-proof`, renamed with the glossary (issue
 * #57) — but the REMOTE ax is the remote project's pin, not this machine's
 * choice, and released 0.15.x only speaks `--launch-proof`. The remote's exit
 * code discriminates the three answers: 0 proof, 1 no proof yet, 2 unknown
 * flag. The retired spelling is retried ONLY on 2 — a pre-0.16 remote —
 * because retrying on 1 would double every SSH round-trip of the ordinary
 * boot-wait poll, and a transport failure is not a vocabulary problem. The
 * fallback retires with the alias, in the next breaking release.
 */
export function readProof({ needle, worktree = '', env, sessionsRoot, host, exec, cwd }) {
  // THE OWNING WORKTREE, when this loop holds one (#204). The needle is its
  // basename, and a second checkout whose slug ends in that basename made this
  // read refuse for the whole boot wait; `slugOf(worktree)` names one session
  // directory by construction. It travels ONLY on the local branch: a slug
  // computed here names nothing on another host, so the remote argv below is
  // unchanged. A dispatch that named no worktree holds no path and stays
  // needle-only.
  if (host === null) return dispatchProof({ needle, cwd: worktree, env, sessionsRoot });
  const root = host.sessions ?? '';
  if (root === '') return null;
  // Through ssh because ssh rejoins its arguments into one remote command.
  // Every value is quoted as data, and the target grammar is closed by remote().
  const ask = flag =>
    remote(
      args => exec('ssh', args, cwd),
      host.ssh,
      `ax worker transcript ${flag} ${quote(needle)} --sessions ${quote(root)}`,
    );
  let out = ask('--dispatch-proof');
  if (!out.error && out.status === 2) {
    warn(`the ax on ${host.ssh} does not speak --dispatch-proof (pre-0.16); answering through the retired --launch-proof — pin that project to the current release`);
    out = ask('--launch-proof');
  }
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
