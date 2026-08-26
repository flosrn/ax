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

export type ChannelState = {
  /** First failure of the current outage; 0 while healthy. */
  downSince: number;
  /** An outage (or a permanent disablement) has already been announced. */
  announced: boolean;
  /** Non-empty when the loop never started at all, and why. */
  disabled: string;
};

export function freshChannel(): ChannelState {
  return { downSince: 0, announced: false, disabled: '' };
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
  downAfterMs: number = DOWN_AFTER_MS,
): Announcement | null {
  if (state.disabled) return null;

  if (healthy) {
    state.downSince = 0;
    if (!state.announced) return null;
    state.announced = false;
    // No wake on good news: the delivery that follows will wake the session
    // by itself, and this line is there to correct a conclusion it already
    // drew, not to interrupt it.
    return { kind: 'recovered', wake: false, text: RECOVERED_TEXT };
  }

  if (!state.downSince) state.downSince = now;
  const elapsed = now - state.downSince;
  if (state.announced || elapsed < downAfterMs) return null;
  state.announced = true;
  return {
    kind: 'down',
    // The session this exists for ended its turn to wait for a reply. A notice
    // that only lands on the next turn never reaches it, because for a session
    // waiting on a dead channel there is no next turn.
    wake: true,
    text: DOWN_TEXT(Math.round(elapsed / 60_000), 'the check loop keeps failing'),
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
