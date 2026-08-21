// `ax worker tail <handle>` — is that pane ALIVE, and what has it printed?
//
// `orca terminal read` answers zero in three unrelated situations, and a
// coordinator acts on that number. Measured 2026-08-09 on one live handle, back
// to back (port of orca-terminal-tail.sh + its suite):
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
// Hence the three answers never share a value (ADR 0003 — exit codes are
// per-verb):
//
//   0  ALIVE, with content — the tail is printed
//   1  ALIVE, SILENT — nothing printed yet; NEVER the answer given for absent
//   3  cannot establish — bad handle, unreachable runtime, error or non-JSON
//      receipt, a moved key, the `--lines` shape
//
// Unlike `ax board` this verb is FAIL-CLOSED: it is read to decide whether a
// pane may be closed, so "I could not look" must never resemble "nothing is
// there". And every line it re-displays goes through redactSecrets: the
// preamble Orca injects into a supervised worker embeds that worker's `dcap_…`
// twice before the child has done anything (2026-08-21 probe), so a child's
// tail carries an authority token BY CONSTRUCTION.

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';

/**
 * The terminal-handle grammar, closed. It lands on argv, and the bash era's
 * deliberate consequence is kept: there is no `--help` here, because `--help`
 * is not a `term_…` handle and is refused as one.
 */
export const TERMINAL_HANDLE = /^term_[A-Za-z0-9_-]+$/;

/** Cannot establish. The one verdict this verb may never confuse with silence. */
const CANNOT = 3;

export function tail(argv = [], { resolve = resolveOrca, runner, env = process.env } = {}) {
  const refuse = (message, repair) => {
    bad(`CANNOT ESTABLISH — ${message}`);
    fix(repair);
    return CANNOT;
  };

  // Argument shape FIRST, before the resolution and before any runtime call: a
  // handle that is not a handle is refused without the runtime ever being
  // asked, so a typo can never be reported as a terminal's state.
  const handle = argv[0] ?? '';
  if (argv.length === 0) return refuse('no terminal handle given (usage: ax worker tail <term_…>)', 'ax worker ls   # the live handles of this machine');
  if (argv.length > 1) return refuse(`unexpected extra argument: ${argv[1]}`, 'ax worker tail <term_…>   # one handle, no flags');
  if (!TERMINAL_HANDLE.test(handle)) return refuse(`'${handle}' is not a terminal handle (expected term_…)`, 'ax worker ls   # the live handles of this machine');

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) return refuse('no Orca CLI on this machine — the pane state cannot be read here', 'ORCA_CLI_COMMAND=<binary> ax worker tail ' + handle);

  const run = runner ?? createRunner({ bin });

  // The execution gate of the socle. Probed BEFORE the read, because an
  // unreachable runtime and a silent terminal are the two readings this verb
  // exists to keep apart.
  const ready = runtimeReady(run);
  if (!ready.ready) return refuse(ready.reason, 'orca open   # start the runtime, then re-run this tail');

  // No `--lines`, ever (F-041). And the receipt is read as data: the runner
  // carries stderr and the raw text back, so no diagnostic is lost (F-004).
  const out = run(['terminal', 'read', '--terminal', handle, '--json']);
  const receipt = out.receipt;

  if (receipt.unparseable !== undefined) {
    const code = refuse(`the receipt for ${handle} is not JSON: ${receipt.error}`, 'orca open   # then re-run; if this persists the CLI answered something else entirely');
    note(redactSecrets(String(receipt.unparseable).slice(0, 400)));
    return code;
  }

  if (receipt.ok === false) {
    const error = receipt.error ?? {};
    return refuse(`${handle}: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim(), 'ax worker ls   # the handle may have moved or the pane may be gone');
  }

  // Named-key read, F-028: an absent container is a NAMED inability, never a
  // silent zero. This is the exact key that got read as `result.output` and
  // cost a live pane.
  const terminal = (receipt.result ?? {}).terminal;
  if (terminal === null || typeof terminal !== 'object') {
    return refuse(
      `no result.terminal in the receipt for ${handle}. The key moved, or this is not a terminal receipt. Do NOT read this as an empty terminal.`,
      'ax worker ls   # re-establish the handle from a receipt whose shape is known',
    );
  }

  const status = terminal.status ?? null;
  if (status === null) {
    return refuse(
      `${handle} returned no status. That is the shape \`--lines\` produces, and it is not an empty terminal.`,
      'orca terminal read --terminal ' + handle + ' --json   # never with --lines',
    );
  }

  const lines = terminal.tail;
  if (!Array.isArray(lines)) {
    return refuse(`${handle}: result.terminal.tail is ${lines === null ? 'null' : typeof lines}, not a list.`, 'ax worker ls   # the receipt shape changed; re-establish before acting on it');
  }

  // Both remaining answers are ESTABLISHED facts about a living pane — the ✓ is
  // about having established it, and the exit code carries which one it is.
  const cursor = terminal.latestCursor ?? null;
  if (lines.length > 0) {
    ok(`ALIVE — ${handle}  status=${status}  cursor=${cursor}  ${lines.length} line(s)`);
    for (const line of lines) note(redactSecrets(line));
    return 0;
  }

  ok(`ALIVE, SILENT — ${handle}  status=${status}  cursor=${cursor}  no line yet.`);
  note('This is not a dead terminal and not a finished one. A session between turns prints');
  note('nothing, and closing a pane on this reading is how a live agent\u2019s work gets destroyed.');
  return 1;
}
