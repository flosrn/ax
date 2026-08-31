// The dispatch capacity rules: how many children this machine tolerates,
// counted by live pane (F-048), and which PASS each issue is about to run,
// with the two anti-rival gates in front of `--fresh` (F-001, F-028).
// Extracted from dispatch.mjs so the duplicate-prevention state machine
// answers through its own interface; dispatch maps the outcomes back to its
// own exit codes and printing.

import { join } from 'node:path';

import { paneVerdict } from '../worker/pane.mjs';
import { handlesByRequest, heldRepaired, report } from '../worker/record.mjs';
import { passesIn, readDraft, requestFor } from './draft.mjs';

/**
 * How many live child panes this machine tolerates. Counted, never remembered
 * (F-028), and counted by PANE rather than by `worker-list` (F-048: that counter
 * answered zero while children were working).
 *
 * An unreadable value is a refusal, not a default: `Number('bad')` is NaN, and
 * `live + new > NaN` is false for every input — the fence would vanish silently,
 * on the one guard whose whole job is to fail closed. Zero is legal, and means
 * "no new session on this machine right now".
 *
 * `ORCA_READY_SESSION_CAP` is not read as a fallback. A silent fallback would
 * drop a still-exported cap to the default of 3; refusing and naming
 * `ORCA_TRIAGE_SESSION_CAP` is the migration, the same way `ax doctor` refuses
 * the legacy `ready` config key rather than reading it. Empty is absence.
 *
 * BOTH NAMES HAVE NOW BEEN THE LIVE ONE, and that is why the refusal is keyed
 * on the retired spelling rather than on "the one that is not mine": the knob
 * followed the noun to `ready` in 0.15 and back to `triage` in 0.16
 * (`docs/adr/0001`). A shell that exported the 0.15 name keeps exporting it, so
 * it is refused BY NAME — a fallback chain reading whichever is set would make
 * the two spellings interchangeable, which is precisely how a rename stops
 * being one.
 */
export function capOf(env) {
  const retired = env.ORCA_READY_SESSION_CAP;
  if (retired !== undefined && retired !== '') {
    return { ok: false, from: 'ORCA_READY_SESSION_CAP', to: 'ORCA_TRIAGE_SESSION_CAP' };
  }
  const raw = env.ORCA_TRIAGE_SESSION_CAP;
  if (raw === undefined || raw === '') return { ok: true, cap: 3 };
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) return { ok: false, raw: String(raw) };
  return { ok: true, cap };
}

/**
 * The record↔pane association `ls` reads liveness from: a dispatch record
 * whose recorded handle is still alive. Never `worker-list` (F-048: that
 * counter answered zero while children were working), and never the raw pane
 * count — an editor's pane is not triage capacity.
 */
export function liveCount({ index, inventory }) {
  const alive = new Set();
  for (const row of index.byDispatch.values()) {
    if (row.handle === null) continue;
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal !== undefined && terminal.orphaned !== true) alive.add(row.handle);
  }
  return alive.size;
}

/**
 * Which PASS each issue is about to run — `{ ok: true, plan }`, or
 * `{ ok: false, kind: 'refuse' | 'cannot', message, repair }` when a gate
 * stops the batch. A plain dispatch targets the CURRENT pass — the newest one
 * on disk — so it replays what is there (F-001) exactly as it did before
 * passes existed. Only `--fresh` moves the number, and only behind two gates.
 */
export function passPlan({ store, root, index, inventory, issues, job, slug, freshPass }) {
  const refuse = (message, repair) => ({ ok: false, kind: 'refuse', message, repair });
  const cannot = (message, repair) => ({ ok: false, kind: 'cannot', message, repair });

  const handlesOf = handlesByRequest(index);

  const plan = [];
  for (const issue of issues) {
    const base = { job, repo: slug, issue };
    const existing = passesIn(store, base, '.json');
    const latest = existing.length === 0 ? 0 : existing[existing.length - 1];

    if (!freshPass) {
      plan.push({ issue, pass: Math.max(latest, 1), previous: null });
      continue;
    }
    if (latest === 0) {
      return refuse(
        `#${issue} has no recorded pass, so there is nothing to redo`,
        `ax triage dispatch --issue ${issue} --job ${job}   # a first pass is an ordinary dispatch`,
      );
    }

    // GATE 1 — F-001, and `--fresh` must never be the way around it. An
    // unsettled record may still be mutating: `worker-start` has answered
    // `runtime_unavailable` twice while its mutation ran on, which is how two
    // agents landed in one worktree. A second pass on top of that is the same
    // duplicate under a new name. Note this cannot be decided from the handle
    // index: it only holds rows built from a parseable `worker-start` receipt,
    // so a stranded record maps NO handle at all — the very case where a child
    // is most likely to exist unseen.
    const previousRequest = requestFor({ ...base, pass: latest });
    let previousState;
    try {
      previousState = report(join(store, `${previousRequest}.json`));
    } catch (error) {
      return cannot(`pass ${latest} of #${issue} has an unreadable record: ${String(error.message ?? error)}`, `cat ${join(store, `${previousRequest}.json`)}`);
    }
    if (!previousState.usable) {
      return refuse(
        `pass ${latest} of #${issue} never settled, so it may still be mutating — a fresh pass here is a second agent under a new number`,
        heldRepaired(join(store, `${previousRequest}.json`))
          ? `ax worker transcript ${previousRequest}   # its child IS running and reports by peer; never --resume, never --fresh`
          : `ax worker start --resume --request ${previousRequest}   # settle it first (F-001), then redo it`,
      );
    }

    // GATE 2 — the pane, on the shared three-valued definition rather than the
    // cap's. The cap deliberately leaves an omitted host UNCOUNTED, which is
    // right for "have I room for one more" and wrong here: this call is about to
    // create a RIVAL child, so an absence that proves nothing must stop it.
    const handles = [...(handlesOf.get(previousRequest) ?? [])];
    // Zero handles is not zero panes, and this is REACHABLE — not a theoretical
    // guard. `report()` treats a Bash-era record as usable on
    // `terminal !== null || legacyUsable`, where `legacyUsable` is just a
    // non-empty `receiptPath` (record.mjs:367). So a settled legacy record can
    // name no agent pane at all, clear gate 1, and map no handle here — which is
    // "nothing on this machine can tell", exactly what `paneVerdict`'s null case
    // answers. Probing through it routes the gap to the shared third value
    // instead of falling through to "go ahead".
    const probed = handles.length === 0 ? [null] : handles;
    const why = `pass ${latest} has no pane recorded against it, so nothing on this machine can say whether its child is gone`;
    const verdicts = probed.map(handle => paneVerdict(handle, why, inventory));
    const living = probed.find((_, at) => verdicts[at].pane === 'VIVANT');
    if (living !== undefined) {
      return refuse(
        `pass ${latest} of #${issue} still holds a live pane (${living}) — two children on one issue is the duplicate this whole subsystem exists to prevent`,
        `ax worker release --close --dispatch <id>   # or let it finish; then redo it`,
      );
    }
    const unknown = verdicts.find(verdict => verdict.pane === 'INCONNU');
    if (unknown !== undefined) {
      return cannot(
        `pass ${latest} of #${issue} cannot be proven finished: ${unknown.detail} — an absence from a partial terminal list is not a death (F-028)`,
        `ax worker ls   # read the pane's real state, close it if it is there, then redo`,
      );
    }

    const previous = readDraft(root, { ...base, pass: latest });
    plan.push({ issue, pass: latest + 1, previous: { pass: latest, path: previous.path, sha: previous.sha } });
  }
  return { ok: true, plan };
}
