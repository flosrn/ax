// `ax worker tail <handle|request>` — is that pane ALIVE, and what has it printed?
//
// `orca terminal read` answers zero in three unrelated situations, and an
// orchestrator acts on that number. Measured 2026-08-09 on one live handle,
// back to back (port of orca-terminal-tail.sh + its suite):
//
//   read --terminal <h> --json            -> status: running, returnedLineCount: 1, tail: 1 line
//   read --terminal <h> --lines 60 --json -> status: null,    returnedLineCount: null, tail: absent
//
// INVARIANT F-041: `--lines` does not shorten the read, it ANNIHILATES it — so
// this verb never passes it, and the null-status shape it produces is refused BY
// NAME rather than read as an empty terminal. The content lives at
// `result.terminal.tail`; there is no `result.output`. That same day a session
// read the wrong key twice, concluded "nothing is running", and closed a
// terminal on that reading — nothing was lost, which was luck. A third
// near-miss: a finish signal nobody sent, followed by the prescribed release,
// on a child that was still working (F-043).
//
// Hence the answers never share a value (ADR 0003 — exit codes are
// per-verb):
//
//   0  ALIVE, with content — the tail is printed
//   1  ALIVE, SILENT — nothing printed yet; NEVER the answer given for absent
//   3  cannot establish — bad handle, unreachable runtime, error or non-JSON
//      receipt, a moved key, the `--lines` shape
//   4  EXITED — the pane is gone. Its last frame is printed when it has one,
//      and it is never called ALIVE: measured 2026-08-25 on 56-scores-r2, a
//      closed pane read `status=exited` and this verb answered `ALIVE, SILENT`
//      plus "This is not a dead terminal". A caller waiting for that pane to
//      speak waits for ever.
//
// Unlike `ax board` this verb is FAIL-CLOSED: it is read to decide whether a
// pane may be closed, so "I could not look" must never resemble "nothing is
// there". And every line it re-displays goes through redactSecrets: the
// preamble Orca injects into a supervised worker embeds that worker's `dcap_…`
// twice before the child has done anything (2026-08-21 probe), so a child's
// tail carries an authority token BY CONSTRUCTION.

import { join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { briefDelivered } from './delivered.mjs';
import { readPane } from './pane.mjs';
import { defaultStore, dispatchIndex, requestIdOk } from './record.mjs';

/**
 * The terminal-handle grammar, closed.
 *
 * The bash era's deliberate consequence — "there is no `--help` here, because
 * `--help` is not a `term_…` handle and is refused as one" — is REVERSED as a
 * surface contract (#89): `ax worker tail --help` answered CANNOT ESTABLISH
 * about a pane named `--help`, and `runCli` now answers the flag from the
 * registry before this verb is reached (../cli.mjs). Nothing changes in this
 * grammar: a `--help` handed to this function directly still names no pane.
 */
export const TERMINAL_HANDLE = /^term_[A-Za-z0-9_-]+$/;

/** Cannot establish. The one verdict this verb may never confuse with silence. */
const CANNOT = 3;

/**
 * The id `ax worker transcript` can actually take for this pane.
 *
 * A request or dispatch id is already that id. A `term_…` handle is not:
 * transcript resolves through the record store, and a handle is a pane. The
 * store may still name a unique request (or dispatch) that opened this pane;
 * zero or two owners is an inability, never a guess (F-028).
 */
function transcriptOwner(target, handle, env) {
  if (!TERMINAL_HANDLE.test(target)) return target;
  const index = dispatchIndex(defaultStore(env));
  const hits = [...index.byDispatch.entries()].filter(([, row]) => row.handle === handle);
  const requests = new Set(hits.map(([, row]) => row.request));
  if (requests.size === 1) return [...requests][0];
  if (hits.length === 1) return hits[0][0];
  return '';
}

/**
 * What the child's OWN session says about the messages it received, or ''.
 *
 * ALIVE was never a claim about the correction channel, and on 2026-08-26 that
 * gap cost an orchestrator two canonical ticket amendments and three direct
 * steerings: the pane was VIVANT, the transcript readable, `worker-list`
 * succeeded — and all five injections sat at `delivered_at: null` while the
 * child opened its pull request without them. The loss surfaced at review.
 *
 * A send receipt cannot separate "queued" from "never", and neither can a
 * cursor. The child's session can: a delivered injection lands there as another
 * `role: 'user'` entry. So this verb, which is read to decide whether a pane can
 * be left alone, says how many arrived and when the last one did — and names the
 * case where only the brief ever did.
 *
 * Silent when the witness cannot testify: a handle with no unique owner, a
 * record that names no session, an unreadable file. An inability to look is not
 * a finding, and this line is an addition to a verdict, never the verdict.
 */
function channelWitness(target, handle, env) {
  const owner = transcriptOwner(target, handle, env);
  if (owner === '') return '';
  const seen = briefDelivered(join(defaultStore(env), `${owner}.json`), { env });
  if (!seen.known || !seen.delivered) return '';
  return seen.count === 1
    ? `channel   the child's session records ONLY its brief (${seen.at}). Nothing sent since has been recorded — check before assuming a steering landed.`
    : `channel   ${seen.count} message(s) recorded by the child, last at ${seen.lastAt}. Anything you sent after that has not been recorded.`;
}

export function tail(argv = [], { resolve = resolveOrca, runner, env = process.env } = {}) {
  const refuse = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    fix(repair);
    return CANNOT;
  };

  // Argument shape FIRST, before the resolution and before any runtime call: a
  // target that is neither a handle nor a request id is refused without the
  // runtime ever being asked, so a typo can never be reported as a terminal's
  // state.
  const target = argv[0] ?? '';
  if (argv.length === 0) return refuse('no terminal handle or request id given (usage: ax worker tail <term_…|request>)', 'ax worker ls   # the live handles of this machine');
  if (argv.length > 1) return refuse(`unexpected extra argument: ${argv[1]}`, 'ax worker tail <term_…|request>   # one target, no flags');

  // A REQUEST ID IS A TARGET TOO. Measured 2026-08-25: `ax worker ls` names no
  // handle for a record whose worker-start never settled, `ax worker transcript
  // 55-work` reads that same record happily, and `ax worker tail 55-work` was
  // refused on its argument shape — so the one verb that says whether the pane
  // is still emitting was unreachable for exactly the records that needed it.
  // The store is what ties a request to its pane, and `dispatchIndex` records
  // the handle of every worker-start receipt, settled or not.
  //
  // THE RUNTIME COMES WITH THE HANDLE, from the SAME row. A remote dispatch's
  // pane lives on the host its `worker-start --on` named, so a handle read
  // against the local runtime interrogates the wrong machine — and taking the
  // runtime from the record's newest worker-start instead would mispair them the
  // moment a `--replace` moved a child between hosts.
  let handle = target;
  let environment;
  if (!TERMINAL_HANDLE.test(target)) {
    if (!requestIdOk(target)) return refuse(`'${target}' is neither a terminal handle (term_…) nor a request id`, 'ax worker ls   # the requests and live handles of this machine');
    const index = dispatchIndex(defaultStore(env));
    const rows = [...index.byDispatch.entries()]
      .filter(([dispatchId, row]) => row.handle !== null && (dispatchId === target || row.request === target))
      .map(([, row]) => row);
    const handles = new Set(rows.map(row => row.handle));
    // Zero is an inability, never a death: rows exist here only where a
    // parseable worker-start receipt named a dispatch, so a stranded record maps
    // nothing at all (F-028).
    if (handles.size === 0) {
      // AND A RECORD THIS SCAN COULD NOT READ MAY BE THE ONE ASKED FOR. Saying
      // "no record names a pane for X" after failing to read X's own file is an
      // absence claimed out of a failed look — the exact shape F-028 is about.
      // The unreadable list is named, and the one whose stem IS the target
      // first, because that is the file to go and look at.
      const unreadable = index.unreadable ?? [];
      const mine = unreadable.filter(entry => entry.file === `${target}.json`);
      if (unreadable.length > 0) {
        const named = (mine.length > 0 ? mine : unreadable).slice(0, 3).map(entry => `${entry.file} (${entry.error})`).join('; ');
        return refuse(
          mine.length > 0
            ? `the record for '${target}' cannot be read, so nothing here knows which pane it opened: ${named}`
            : `no record names a pane for '${target}', and ${unreadable.length} record(s) in this store could not be read at all: ${named}`,
          `ax worker start --show --request ${target}   # read the record itself before concluding anything about its pane`,
        );
      }
      return refuse(
        `no dispatch record on this host names a pane for '${target}'${index.missing ? ' (there is no dispatch store here)' : ''}`,
        `ax worker transcript ${target}   # the session history needs no pane; ax worker ls names what this store holds`,
      );
    }
    if (handles.size > 1) {
      return refuse(
        `'${target}' names ${handles.size} panes (${[...handles].join(', ')}) — a replaced dispatch keeps both, and tailing a guess reads the wrong child`,
        `ax worker tail ${[...handles][0]}   # name the pane you mean`,
      );
    }
    const row = rows.reduce((newest, next) => ((next.issuedAt ?? 0) >= (newest.issuedAt ?? 0) ? next : newest), rows[0]);
    handle = row.handle;
    environment = row.env || undefined;
    note(`${target} → ${handle}${environment ? ` on '${environment}'` : ''} (from this host's dispatch store)`);
  }

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) return refuse('no Orca CLI on this machine — the pane state cannot be read here', 'ORCA_CLI_COMMAND=<binary> ax worker tail ' + handle);

  const run = runner ?? createRunner({ bin });

  // The execution gate of the socle. Probed BEFORE the read, because an
  // unreachable runtime and a silent terminal are the two readings this verb
  // exists to keep apart.
  const ready = runtimeReady(run);
  if (!ready.ready) return refuse(ready.reason, 'orca open   # start the runtime, then re-run this tail');

  // The shape of the read, the flags it may carry and the key names all live in
  // ./pane.mjs — one reader for the four verbs that need this receipt. This one
  // maps every named inability to its own repair, because "I could not look"
  // must never resemble "nothing is there".
  const pane = readPane(run, handle, { environment });
  const refusal = pane.refusal;

  if (refusal !== null) {
    if (refusal.kind === 'unparseable') {
      const code = refuse(`the receipt for ${handle} is not JSON: ${refusal.error}`, 'orca open   # then re-run; if this persists the CLI answered something else entirely');
      note(redactSecrets(String(refusal.raw).slice(0, 400)));
      return code;
    }
    if (refusal.kind === 'error') {
      return refuse(`${handle}: ${refusal.code} ${refusal.message}`.trim(), 'ax worker ls   # the handle may have moved or the pane may be gone');
    }
    // F-028: an absent container is a NAMED inability, never a silent zero.
    // This is the exact key that got read as `result.output` and cost a live pane.
    if (refusal.kind === 'no-terminal') {
      return refuse(
        `no result.terminal in the receipt for ${handle}. The key moved, or this is not a terminal receipt. Do NOT read this as an empty terminal.`,
        'ax worker ls   # re-establish the handle from a receipt whose shape is known',
      );
    }
    if (refusal.kind === 'null-status') {
      return refuse(
        `${handle} returned no status. That is the shape \`--lines\` produces, and it is not an empty terminal.`,
        'orca terminal read --terminal ' + handle + ' --json   # never with --lines',
      );
    }
    return refuse(`${handle}: result.terminal.tail is ${refusal.got}, not a list.`, 'ax worker ls   # the receipt shape changed; re-establish before acting on it');
  }

  // ESTABLISHED facts — the ✓ is about having established them, and the exit
  // code carries which one it is.
  //
  // AND `exited` IS NOT ONE OF THE LIVING. Measured 2026-08-25 on
  // 56-scores-r2: the child's pane had closed, `terminal read` answered
  // `status=exited cursor=0` with no line, and this verb printed `ALIVE,
  // SILENT` followed by "This is not a dead terminal" — about a terminal that
  // was exactly that. The status was in the receipt and printed on the same
  // line; nothing read it. An orchestrator waiting for that pane to speak waits
  // forever, and the reassurance argues against the only correct action.
  const { lines, cursor, paneStatus: status } = pane;
  const exited = status === 'exited';
  if (lines.length > 0) {
    ok(`${exited ? 'EXITED' : 'ALIVE'} — ${handle}  status=${status}  cursor=${cursor}  ${lines.length} line(s)`);
    for (const line of lines) note(redactSecrets(line));
    if (exited) note('The pane has EXITED: this tail is its last frame, not a session between turns.');
    else {
      const channel = channelWitness(target, handle, env);
      if (channel !== '') note(redactSecrets(channel));
    }
    return exited ? 4 : 0;
  }

  if (exited) {
    ok(`EXITED, SILENT — ${handle}  status=${status}  cursor=${cursor}  no line to show.`);
    note('The pane is gone and printed nothing this read can show. Its session outlives it:');
    // `transcript` resolves a request or a dispatch id through the store, never
    // a `term_…` handle. Suggesting `transcript <handle>` is an inexecutable
    // next action — measured 2026-08-25, the EXITED path printed exactly that
    // after resolving 56-scores-r2. Reverse-map when the store has a unique
    // owner; otherwise name a verb that does not need one.
    const owner = transcriptOwner(target, handle, env);
    if (owner) fix(redactSecrets(`ax worker transcript ${owner}   # what that child did, from its own history`));
    else fix('ax worker ls   # this handle has no unique request in the store, so transcript cannot take it');
    return 4;
  }

  ok(`ALIVE, SILENT — ${handle}  status=${status}  cursor=${cursor}  no line yet.`);
  note('This is not a dead terminal and not a finished one. A session between turns prints');
  note('nothing, and closing a pane on this reading is how a live agent\u2019s work gets destroyed.');
  const silentChannel = channelWitness(target, handle, env);
  if (silentChannel !== '') note(redactSecrets(silentChannel));
  return 1;
}
