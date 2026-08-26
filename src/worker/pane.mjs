// `orca terminal read` — the one place in ax that knows how a pane answers.
//
// Four verbs need this receipt and each needs a different slice of it: `tail`
// shows the content, `start` watches the cursor to prove a held spec was
// submitted, `stall` watches it to tell a working session from a hung one, and
// `release` watches it to refuse closing a pane that is still moving. Before
// this file the argv and the key names existed three times over (tail, start,
// stall); the cartography of 2026-08-21 counted the fourth copy arriving with
// release and named this extraction instead.
//
// The receipt shape is the whole reason to centralise it. Measured 2026-08-09
// against one live handle, back to back:
//
//   read --terminal <h> --json            -> status: running, tail: [1 line]
//   read --terminal <h> --lines 60 --json -> status: null,    tail: absent
//
// INVARIANT F-041: `--lines` does not shorten the read, it ANNIHILATES it. It is
// therefore never composed here, and the null-status shape it produces is a
// NAMED inability rather than an empty terminal. `--limit <n>` is a different
// flag and is honoured: a cursor watcher wants one line, not the buffer.
//
// Every field is read by name (F-028). No caller is handed a default: this
// module reports what it found, `refusal` names what could not be established,
// and each verb keeps its own predicate on top — a cursor watcher accepts a
// receipt `tail` refuses, and that difference is deliberate rather than a
// disagreement between three copies.

const safeParse = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * `latestCursor`, the only liveness signal that crosses hosts.
 *
 * Lenient about ABSENCE and strict about VALUE. An absent key is `null`, because
 * 0 is a real cursor and reading absence as 0 makes a frozen pane and an
 * unreadable one the same measurement. But a present value outside the cursor
 * domain is not a cursor either: two equal malformed values would read as "this
 * pane did not move", which is how a working session gets closed.
 *
 * The domain is MEASURED, not assumed: Orca 1.4.185 answers a decimal STRING
 * (`"1325952"`), in both the full read and the `--limit 1` one. Rejecting
 * strings — a plausible-looking "must be an integer" rule — makes every pane
 * unreadable, which is exactly how it was caught. Both shapes are accepted and
 * normalised to a number, so a comparison never depends on which one arrived.
 */
export function terminalCursor(receipt) {
  const parsed = typeof receipt === 'string' ? safeParse(receipt) : receipt;
  const terminal = parsed?.result?.terminal;
  if (!terminal || !Object.hasOwn(terminal, 'latestCursor')) return null;
  const cursor = terminal.latestCursor;
  if (Number.isInteger(cursor) && cursor >= 0) return cursor;
  return typeof cursor === 'string' && /^[0-9]+$/.test(cursor) ? Number(cursor) : null;
}

/**
 * One pane read, decomposed. `run` is a createRunner product, so the caller's
 * binary and its injected exec are honoured and stderr is never lost (F-004).
 *
 * `refusal` is computed in the order a reader must ask the questions: text that
 * is not JSON, a receipt that refused, a receipt with no terminal object, the
 * `--lines` null-status shape, then a tail that is not a list. Callers that only
 * need the cursor ignore it; `tail` maps each kind to its own message.
 */
export function readPane(run, handle, { environment = '', limit = null } = {}) {
  const args = ['terminal', 'read', '--terminal', handle];
  if (environment) args.push('--environment', environment);
  if (limit !== null) args.push('--limit', String(limit));
  args.push('--json');

  const out = run(args);
  const receipt = out.receipt ?? {};
  const terminal = receipt.result !== null && typeof receipt.result === 'object' ? receipt.result.terminal : undefined;
  const hasTerminal = terminal !== null && typeof terminal === 'object';
  const paneStatus = hasTerminal ? terminal.status ?? null : null;
  const lines = hasTerminal && Array.isArray(terminal.tail) ? terminal.tail : null;

  return {
    exit: out.status,
    stderr: out.stderr ?? '',
    error: out.error,
    receipt,
    ok: out.status === 0 && receipt.ok === true,
    terminal: hasTerminal ? terminal : null,
    paneStatus,
    lines,
    cursor: terminalCursor(receipt),
    refusal: refusalOf(receipt, { hasTerminal, paneStatus, lines, terminal }),
  };
}

function refusalOf(receipt, { hasTerminal, paneStatus, lines, terminal }) {
  if (receipt.unparseable !== undefined) return { kind: 'unparseable', raw: receipt.unparseable, error: receipt.error };
  if (receipt.ok === false) {
    const error = receipt.error ?? {};
    return { kind: 'error', code: error.code ?? 'unknown', message: error.message ?? '' };
  }
  if (!hasTerminal) return { kind: 'no-terminal' };
  if (paneStatus === null) return { kind: 'null-status' };
  if (lines === null) return { kind: 'tail-not-list', got: terminal.tail === null ? 'null' : typeof terminal.tail };
  return null;
}

/**
 * Is that pane READABLE right now? The predicate `stall` and `release` share:
 * a receipt that came back ok and carried a terminal object. Neither needs the
 * content, so neither refuses the shapes `tail` refuses — an unreadable pane is
 * simply an absence of measurement, never a dead process.
 */
export const paneReadable = pane => pane.ok && pane.terminal !== null;

/**
 * Which panes this runtime still owns, indexed by handle — the count no repair
 * path can forge (F-048), and the source `ls` and `release` both read liveness
 * from.
 *
 * It refuses rather than reporting an empty machine (F-028), and it refuses on a
 * TRUNCATED list too: absence in the list is what "the pane is gone" is read
 * from, and a partial list cannot prove an absence. `omitted` carries the other
 * half of that discipline — measured 2026-08-22, `hostScope.omittedHostIds` is
 * non-empty on this Mac, so a handle missing from a complete-looking list may
 * simply live on a host this call never asked.
 */
export function terminalInventory(run, { environment = '' } = {}) {
  const args = ['terminal', 'list'];
  if (environment) args.push('--environment', environment);
  args.push('--json');

  const out = run(args);
  const receipt = out.receipt ?? {};
  if (out.status !== 0 || receipt.ok !== true || !('result' in receipt)) {
    const detail = receipt.unparseable ?? out.stderr ?? '';
    return { ok: false, reason: `orca terminal list did not answer (exit ${out.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}` };
  }
  const result = receipt.result;
  if (!Array.isArray(result.terminals)) {
    return { ok: false, reason: 'orca terminal list answered without a "terminals" list — an absent container is not an empty one (F-028)' };
  }
  if (result.truncated === true) {
    return { ok: false, reason: 'orca terminal list is TRUNCATED — a partial list cannot prove a pane is dead' };
  }
  const byHandle = new Map();
  for (const terminal of result.terminals) {
    if (terminal !== null && typeof terminal === 'object' && typeof terminal.handle === 'string') byHandle.set(terminal.handle, terminal);
  }
  const scope = result.hostScope ?? {};
  const omittedHosts = Array.isArray(scope.omittedHostIds) ? scope.omittedHostIds : [];
  // The hosts this call DID cover, which is the other half of the same fact and
  // was thrown away. Measured on this Mac 2026-08-25:
  // `{"hostIds":["local"],"omittedHostIds":["runtime:7930a317-…"]}` — the local
  // runtime in scope, one paired remote runtime out of it. Without `hostIds` a
  // caller can only ask "was anything omitted", so a single unreachable remote
  // made every LOCAL pane unknowable too: `ax worker release` then refused to
  // close a locally-dispatched corpse whose PR was already merged. An absent
  // container is an absence of information (F-028), never an empty scope.
  const hosts = Array.isArray(scope.hostIds) ? scope.hostIds : null;
  return { ok: true, byHandle, omitted: omittedHosts.length > 0, omittedHosts, hosts };
}

/**
 * VIVANT / MORT / INCONNU for one recorded handle.
 *
 * The one definition of "is that pane dead", read by `ls`, `gate`, `repair`,
 * `triage dispatch --fresh` and `triage publish` — a second definition is how
 * one of the two ends up wrong. The third value is the whole point: a handle
 * missing from a terminal list that omits hosts is UNKNOWN, never dead (F-028),
 * and a caller about to create a rival child must not round that down. What a
 * verb DOES with a verdict stays the verb's own disposition, as this module's
 * header says of every predicate: `gate` maps INCONNU to "down, disclosed" and
 * stays fail-open; `stall` keeps its stricter `paneGone` (see its header).
 *
 * BUT OMISSION IS PER HOST, and reading it as global cost a real cleanup.
 * Measured 2026-08-25: one paired remote runtime was out of scope
 * (`{"hostIds":["local"],"omittedHostIds":["runtime:7930a317-…"]}`), and that
 * alone made a LOCALLY dispatched pane unknowable — so `ax worker release`
 * refused to close a corpse whose PR was already merged, and the record stayed
 * unclosable for as long as that unrelated remote slept.
 *
 * So ONE narrow exception, and deliberately no more: `host === ''` is a dispatch
 * this machine issued with no `--on`, and a receipt that explicitly names
 * `local` among the hosts it read has therefore covered that pane's runtime.
 * An absent handle is then a corpse (F-003), whatever else was omitted.
 *
 * REMOTE ROWS ARE UNTOUCHED. A record names its host by ENVIRONMENT NAME
 * (`--on gapicore`) while the receipt namespaces runtimes (`runtime:<uuid>`);
 * those are two vocabularies and no mapping between them is established here.
 * Matching them loosely would prove a remote pane dead on a coincidence of
 * substrings, and this verdict authorises closing panes.
 *
 * AND `host` HAS NO DEFAULT, on purpose. `''` is a caller ASSERTING "this record
 * dispatched locally"; an absent `host` is a caller that has not established the
 * owner, and that must keep the conservative answer rather than inherit the
 * exception through a default nobody chose.
 */
export function paneVerdict(handle, why, terminals, { host } = {}) {
  if (handle === null) return { pane: 'INCONNU', detail: why };
  const terminal = terminals.byHandle.get(handle);
  if (terminal === undefined) {
    const localProven = host === '' && Array.isArray(terminals.hosts) && terminals.hosts.includes('local');
    if (terminals.omitted && !localProven) {
      return { pane: 'INCONNU', detail: `${handle} is not in this host's terminal list, and hosts are omitted from its scope` };
    }
    return {
      pane: 'MORT',
      detail: localProven && terminals.omitted
        ? `${handle} is unknown to the local runtime, which this list did read (only remote hosts were omitted)`
        : `${handle} is unknown to the runtime`,
    };
  }
  if (terminal.orphaned === true) return { pane: 'MORT', detail: `${handle} orphaned` };
  return { pane: 'VIVANT', detail: handle };
}
