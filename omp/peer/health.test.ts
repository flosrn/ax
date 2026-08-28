import { describe, expect, test } from 'bun:test';
import {
  DOWN_AFTER_MS,
  type ChannelState,
  disable,
  freshChannel,
  markTurnCompleted,
  observe,
} from './health';

const T0 = 1_700_000_000_000;

/** Drive a run of consecutive failures and collect what was announced. */
function failFor(state: ChannelState, ms: number, step = 60_000) {
  const said = [];
  for (let t = 0; t <= ms; t += step) {
    const a = observe(state, false, T0 + t);
    if (a) said.push(a);
  }
  return said;
}

describe('receive-channel health', () => {
  test('a healthy loop says nothing, however long it runs', () => {
    const s = freshChannel();
    for (let t = 0; t < 10; t++)
      expect(observe(s, true, T0 + t * DOWN_AFTER_MS)).toBeNull();
  });

  test('a blip shorter than the threshold is not announced', () => {
    const s = freshChannel();
    // This is the guard that keeps the alarm readable: the loop fails and
    // retries routinely, and an Orca restart must not narrate itself.
    expect(failFor(s, DOWN_AFTER_MS - 1_000)).toEqual([]);
    expect(observe(s, true, T0 + DOWN_AFTER_MS)).toBeNull();
  });

  test('an outage in a session with no turn is visible but never starts the model', () => {
    const s = freshChannel();
    const [said] = failFor(s, DOWN_AFTER_MS * 2);
    expect(said.kind).toBe('down');
    expect(said.wake).toBe(false);
  });

  test('a cold outage wakes exactly once after the first real turn completes', () => {
    const s = freshChannel();
    failFor(s, DOWN_AFTER_MS * 2);
    markTurnCompleted(s);

    const wake = observe(s, false, T0 + DOWN_AFTER_MS * 3);
    expect(wake?.kind).toBe('down');
    expect(wake?.wake).toBe(true);
    expect(observe(s, false, T0 + DOWN_AFTER_MS * 4)).toBeNull();
  });

  test('an outage past the threshold is announced exactly once, and wakes', () => {
    const s = freshChannel();
    markTurnCompleted(s);
    const said = failFor(s, DOWN_AFTER_MS * 4);
    expect(said).toHaveLength(1);
    expect(said[0].kind).toBe('down');
    // The session it exists for has already ended its turn. Landing on the
    // next turn is landing never.
    expect(said[0].wake).toBe(true);
    expect(said[0].text).toContain('Do not end your turn expecting to be woken');
    expect(said[0].text).toContain('5 minutes');
  });

  test('recovery is announced once, and does not wake', () => {
    const s = freshChannel();
    failFor(s, DOWN_AFTER_MS * 2);
    const back = observe(s, true, T0 + DOWN_AFTER_MS * 3);
    expect(back?.kind).toBe('recovered');
    expect(back?.wake).toBe(false);
    // Silent from then on: the delivery that follows is the real signal.
    expect(observe(s, true, T0 + DOWN_AFTER_MS * 4)).toBeNull();
  });

  test('recovery before any announcement stays silent', () => {
    const s = freshChannel();
    failFor(s, 60_000);
    expect(observe(s, true, T0 + 120_000)).toBeNull();
  });

  test('a second outage is announced again, and timed from ITS own start', () => {
    const s = freshChannel();
    const from = (start: number, ms: number) => {
      const said = [];
      for (let t = 0; t <= ms; t += 60_000) {
        const a = observe(s, false, start + t);
        if (a) said.push(a);
      }
      return said;
    };

    // First outage, announced, then a recovery and a long healthy stretch.
    expect(from(T0, DOWN_AFTER_MS * 2)).toHaveLength(1);
    expect(observe(s, true, T0 + 3_600_000)?.kind).toBe('recovered');
    expect(observe(s, true, T0 + 7_200_000)).toBeNull();

    // Second outage, hours later. It must be announced again, and its elapsed
    // must be measured from the failure that started IT — not from the first
    // outage, and not from session start. A stale `downSince` here would
    // announce instantly and report hours.
    const second = from(T0 + 10_800_000, DOWN_AFTER_MS * 2);
    expect(second).toHaveLength(1);
    expect(second[0].text).toContain('5 minutes');
  });

  test('a disabled channel says so once and never flaps', () => {
    const s = freshChannel();
    const a = disable(s, 'the `orca-ide` binary is not on PATH');
    expect(a.kind).toBe('down');
    // Nothing is waiting yet at session_start; waking there would fire a turn
    // the operator never asked for.
    expect(a.wake).toBe(false);
    expect(a.text).toContain('orca-ide');
    expect(a.text).toContain('the dispatch itself still works');

    // The loop is not running, so nothing can contradict the disablement.
    // Drive a full outage past the threshold — with no terminal guard this
    // would announce a second time, on top of the one `disable` already made.
    expect(failFor(s, DOWN_AFTER_MS * 4)).toEqual([]);
    // And a stray healthy observation must not report a recovery that never
    // happened: the channel was never up.
    expect(observe(s, true, T0 + DOWN_AFTER_MS * 20)).toBeNull();
  });

  test('the outage text names both what still works and what does not', () => {
    const s = freshChannel();
    const [said] = failFor(s, DOWN_AFTER_MS * 2);
    expect(said.text).toContain('peer_send');
    expect(said.text).toContain('completion report');
    expect(said.text).toContain('peer_read');
  });
});
