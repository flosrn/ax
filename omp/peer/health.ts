/**
 * Receive-channel health for the peer extension.
 *
 * A DEAF SESSION MUST NOT LOOK LIKE A PATIENT ONE. The documented way to await
 * a peer is to end your turn and let the reply wake you, so a session doing
 * exactly that with a dead receiver waits forever — and nothing on its screen
 * separates the two states. Every failure used to go to a log file nobody
 * reads and back into backoff.
 *
 * The decision lives here, apart from the extension, for the same reason
 * addressing lives in `address.ts`: it is the part worth pinning with tests,
 * and it must not need a running Orca, a `pi` facade or a clock to be checked.
 * Callers pass `now`; nothing here reads the wall clock or performs I/O.
 */

/** What the session should be told, or `null` for "say nothing". */
export type Announcement = {
  kind: 'down' | 'recovered';
  /** Wake the session. Only an outage does — see `wake` below. */
  wake: boolean;
  text: string;
};

/**
 * The pane consumes another Run: this session's peer Run was fenced because a
 * `run-create` or `run-use` in this pane rebound it. Unlike every other failure
 * it does not heal by waiting, so it is said at once, with its repair.
 */
export type Fence = {
  /** The Run peers address this session on (the registry's). */
  ownRun: string;
  /** The Run `run-current` now reports for this pane. */
  boundRun: string;
  boundObjective: string;
};

export type ChannelState = {
  /** First failure of the current outage; 0 while healthy. */
  downSince: number;
  /** The current outage has been shown at least once. */
  announced: boolean;
  /** The current outage has triggered a model turn. */
  woken: boolean;
  /** At least one model turn has completed in this session. */
  turnCompleted: boolean;
  /** Non-empty when the loop never started at all, and why. */
  disabled: string;
  /**
   * The fence behind the current outage, as last announced. Sticky until
   * healthy: a later check whose `run-current` could not be read is the same
   * outage, and must not downgrade it to "the check loop keeps failing".
   */
  fence: Fence | null;
};

export function freshChannel(): ChannelState {
  return {
    downSince: 0,
    announced: false,
    woken: false,
    turnCompleted: false,
    disabled: '',
    fence: null,
  };
}

/** Arm outage wakeups only after this session has completed a real turn. */
export function markTurnCompleted(state: ChannelState): void {
  state.turnCompleted = true;
}

/**
 * Long enough that an Orca restart does not announce itself. The threshold is
 * the whole reason this is not a hair trigger: the loop fails and retries
 * routinely, and an alarm on every blip is an alarm nobody reads.
 */
export const DOWN_AFTER_MS = 300_000;

const DOWN_TEXT = (minutes: number, reason: string) =>
  `Peer messaging has been unable to receive for ${minutes} minute${minutes === 1 ? '' : 's'} (${reason}). ` +
  'You can still SEND — `peer_send` and `peer_reply` are separate calls and may work. ' +
  'What you cannot do is wait: no reply, and no completion report from a session you dispatched, ' +
  'will reach you until this recovers. Do not end your turn expecting to be woken. Say so rather ' +
  'than reporting the peer silent, and read a transcript directly with `peer_read` if you need their state.';

const RECOVERED_TEXT =
  'Peer messaging is receiving again. Anything a peer sent during the outage was retained by Orca ' +
  'and is being delivered now.';

const DISABLED_TEXT = (reason: string) =>
  `Peer messaging is not receiving in this session: ${reason}. ` +
  'Nothing a peer sends will reach you, and no completion report from a session you dispatch will ' +
  'arrive — the dispatch itself still works. Do not wait to be woken, and say this rather than ' +
  'reporting a peer silent.';

/**
 * THE RECEIVER WILL NOT FOLLOW THE PANE, and the text says so. The Run the pane
 * moved to belongs to another workflow — the tag guard in `ensureRun` exists
 * because consuming such a Run acknowledges its worker traffic before that
 * workflow reads it. Peers keep addressing `ownRun`, where Orca retains what
 * they send, so rebinding delivers the backlog. One pane consumes one Run: the
 * operator chooses which, and each choice is named with what it costs.
 */
const FENCED_TEXT = (f: Fence) =>
  `Peer messaging stopped receiving: this pane was rebound from its peer Run \`${f.ownRun}\` to ` +
  `\`${f.boundRun}\`${f.boundObjective ? ` ("${f.boundObjective}")` : ''} — an ` +
  '`orca orchestration run-create` or `run-use` in this pane did that. Orca lets one pane consume ' +
  `one Run, so every \`check --run ${f.ownRun}\` is now refused (\`consumer_fenced\`). The receiver ` +
  `will not follow the pane to \`${f.boundRun}\`: that Run belongs to another workflow, and consuming ` +
  'it would acknowledge its worker traffic before that workflow reads it. Peers still address ' +
  `\`${f.ownRun}\`, and Orca retains what they send. Choose one: (1) hear peers again with ` +
  `\`orca orchestration run-use --id ${f.ownRun}\` — the backlog is delivered, and this pane stops ` +
  `reading \`${f.boundRun}\`'s mailbox; or (2) stay on \`${f.boundRun}\`, and no peer message, reply ` +
  'or completion report reaches you until you rebind — do not end your turn expecting to be woken. ' +
  'To orchestrate without losing peers, create Tasks and start workers on the Run ' +
  '`orca orchestration run-current` reported before, not on a new one.';

/**
 * Fold one loop outcome into the state and return what to say, if anything.
 *
 * Announces an outage once and its recovery once, so a channel that flaps does
 * not narrate itself. A state already `disabled` is terminal for the session:
 * the loop is not running, so it can never contradict the disablement.
 */
export function observe(
  state: ChannelState,
  healthy: boolean,
  now: number,
  fence: Fence | null = null,
  downAfterMs: number = DOWN_AFTER_MS,
): Announcement | null {
  if (state.disabled) return null;

  if (healthy) {
    state.downSince = 0;
    state.woken = false;
    state.fence = null;
    if (!state.announced) return null;
    state.announced = false;
    // No wake on good news: the delivery that follows will wake the session
    // by itself, and this line is there to correct a conclusion it already
    // drew, not to interrupt it.
    return { kind: 'recovered', wake: false, text: RECOVERED_TEXT };
  }

  if (!state.downSince) state.downSince = now;
  const elapsed = now - state.downSince;
  // A fence is not a blip, so it skips the threshold. A new bound Run is new
  // information and is said even mid-outage; the same one is said once.
  const known = state.fence;
  const moved = fence !== null && fence.boundRun !== known?.boundRun;
  const current = moved ? fence : known;
  if (current === null && elapsed < downAfterMs) return null;

  // A cold outage is shown without spending a model turn. If a real turn later
  // completes while that same outage continues, it earns exactly one wake:
  // `announced` and `woken` are separate because displaying is not waking.
  const wake = state.turnCompleted && !state.woken;
  if (state.announced && !wake && !moved) return null;
  state.announced = true;
  state.fence = current;
  if (wake) state.woken = true;
  return {
    kind: 'down',
    wake,
    text: current
      ? FENCED_TEXT(current)
      : DOWN_TEXT(Math.round(elapsed / 60_000), 'the check loop keeps failing'),
  };
}

/**
 * The loop will not start in a pane that should have had one. Not transient,
 * so it is said at once rather than after `downAfterMs` — but without waking
 * anything: a session that has not run a turn yet is not waiting on a peer.
 */
export function disable(state: ChannelState, reason: string): Announcement {
  // `disabled` alone is the terminal flag — `observe` returns on it before it
  // reads anything else, so there is no second latch to keep in step.
  state.disabled = reason;
  return { kind: 'down', wake: false, text: DISABLED_TEXT(reason) };
}
