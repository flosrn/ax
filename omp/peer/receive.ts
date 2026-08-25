// @ts-nocheck — runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * The one consuming `check --wait` loop, and the backoff that restarts it.
 *
 * WHY IT IS ITS OWN MODULE
 * Commit `d3e6d1a` fixed a session-killing defect in here — a throw in the
 * detached promise's bare parse/health region escaped as an unhandled
 * rejection, which OMP's postmortem handler treats as fatal (measured: exit
 * code 1). Its commit message claimed the existing peer tests covered the
 * regression. They did not, and could not: `loop` and `scheduleRetry` were
 * module-private inside `orca-peer.ts`, so no test could reach them. Reverting
 * the fix left the suite 58/58 green.
 *
 * So the loop takes its collaborators at construction instead of reading a web
 * of module-level state. Nothing about the runtime behaviour changed; what
 * changed is that a test can now supply a fake `pi`, a fake spawn and a fake
 * timer, and observe that a throw is absorbed into a retry rather than
 * escaping.
 *
 * ONE CONSUMER, EVER. `check --wait` consumes a delivery, so a second receiver
 * on the same Run would race this one and swallow its messages. `orca-peer.ts`
 * constructs exactly one.
 */

// `check --wait` holds the socket for this long, then returns an empty
// delivery. Long enough that the loop is not a poll; short enough that a dead
// runtime is noticed and retried.
export const WAIT_MS = 300_000;
export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

// A reply route is an Orca Run address and nothing else. The value is
// peer-controlled, so it is shape-checked before it can ever be handed to
// `orca orchestration send --to`.
//
// ONE shape, both sinks. Reply routes and relay targets reach the identical
// argv, and until 2026-08-11 the relay branch used an uncapped variant of this
// pattern - so the same argument was bounded on one path and unbounded on the
// other. Two shapes for one sink is the defect, not the length.
const RUN_ADDRESS = /^run:[A-Za-z0-9_-]{1,64}$/;

export interface SenderInfo {
  name: string;
  model: string;
  attributed: boolean;
  /**
   * How the sender was established. `pane` (or absent) is Orca's witness of a
   * live pane on THIS runtime. `dispatch` is a worker we started, named from our
   * own write-ahead record because a worker has no pane key by contract.
   *
   * The distinction is load-bearing below: being NAMED is not being AUTHORISED.
   * A dispatch sender may be read and answered, and it may not hand this session
   * a reply address nor borrow its authority to relay to a third party.
   */
  kind?: 'pane' | 'dispatch';
}

/**
 * Everything the loop needs from the outside, passed in rather than imported.
 *
 * Mutable session state arrives as a getter (`runId`) because the Run is bound
 * during `session_start`, after the receiver is constructed — re-exporting the
 * live binding would put the module state back where it was untestable.
 */
export interface ReceiveDeps {
  /** Resolved Orca binary. `orca-ide` on the VPS, never the bare name. */
  orca: string;
  /** Read at each iteration: the Run is bound after construction. */
  runId: () => string;
  spawn: (argv: string[], opts: Record<string, unknown>) => unknown;
  sh: (argv: string[], timeoutMs?: number) => string;
  parse: (raw: string) => unknown;
  note: (line: string) => void;
  reportHealth: (pi: unknown, healthy: boolean) => void;
  senderIdentity: (msg: Record<string, unknown>) => SenderInfo;
  /**
   * The peer's words as the model sees them. `answerable` is passed rather than
   * re-derived: whether `peer_reply` will work is decided above, from whether a
   * route was recorded, and the prose must not make a second guess at it.
   */
  peerContent: (msg: Record<string, unknown>, who: SenderInfo, answerable: boolean) => string;
  /** Already handed to the model; a replayed delivery must not inject twice. */
  wasInjected: (id: string) => boolean;
  rememberInjected: (id: string) => void;
  /** Ack succeeded: durable replay ids may now be reduced to the live window. */
  compactInjected: () => void;
  recordRoute: (id: string, route: { run: string; peer: string; environment?: string }) => void;
  /**
   * Where to write back to a worker we dispatched, DERIVED rather than read off the
   * message. Optional: a host that cannot resolve it simply has no route, and
   * `peer_reply` refuses with the message it already has.
   */
  deriveRoute?: (
    msg: Record<string, unknown>,
  ) => { run: string; peer: string; environment?: string } | null;
  /**
   * The Run a witnessed pane publishes for itself, as `run:<id>`, or `''`.
   *
   * The return address for a sender that stated none — which is every worker
   * following Orca's own preamble. Optional: a host that cannot look one up
   * simply has no route and says so, exactly as before.
   */
  paneRoute?: (handle: string) => string;
}

/** The host `ctx` handed to `session_start`, of which only timers are used. */
export interface TimerCtx {
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export interface Receiver {
  /** Begin (or resume) consuming. Returns immediately; the work is detached. */
  start(pi: unknown): void;
  /** `session_shutdown`: short-circuit the loop and kill the held child. */
  stop(): void;
  /**
   * Hand over the host's managed timers. `ctx.setTimeout` runs its callback
   * with the same isolation as a handler, is unref'd, and is cleared on
   * `session_shutdown`; a raw timer is none of those. Measured 2026-08-11 in an
   * isolated `omp --mode rpc` sandbox: a throw inside a RAW timer callback
   * exits the whole session with code 1 and `[Unhandled Rejection]`, while the
   * same throw inside `ctx.setTimeout` leaves the session answering
   * `get_state`.
   */
  useTimers(ctx: TimerCtx | null): void;
}

/**
 * WHY A SEQUENCE IS CHECKED AT ALL.
 *
 * Orca's receipt for `orchestration send` cannot be used to detect loss. On
 * 1.4.182 a dispatched worker on a second host sent 6 messages home, 3 arrived,
 * and every receipt read `Queued relay_<id> for Run home` with exit 0; on
 * 1.4.183 the same probe delivered 10/10 with the IDENTICAL receipt string
 * (measured 2026-08-15). Delivery improved, the receipt did not, so the working
 * and the broken case are indistinguishable from the wire. The sender's own
 * counter is the one signal that differs: a hole in it is loss, and the alarm
 * below is the only way the coordinator learns that something is missing —
 * which is all it can learn, since the content is gone.
 *
 * SCOPE, HONESTLY. Only messages sent through `sendToPeer` carry `seq`. A
 * worker that hand-rolls `orca orchestration send --dispatch … --task-id …`,
 * which is exactly what Orca's supervised spec boilerplate teaches, carries no
 * sequence at all and its losses stay invisible here. That gap cannot be closed
 * from this side; it is the argument for the upstream request in
 * `docs/upstream/orca-ordinary-send-receipt.md`.
 */
export interface SequenceVerdict {
  /** The number carried, or `null` when the sender does not sequence. */
  seq: number | null;
  /** How many messages went missing immediately before this one. */
  lost: number;
  /** The number that should have arrived. */
  expected: number | null;
  /** This number has already been seen: a stale or replayed message. */
  repeat: boolean;
}

/** The `seq` a payload carries, or `null` — never a coerced guess. */
export function sequenceOf(payload: unknown): number | null {
  const raw = (payload as Record<string, unknown> | null)?.seq;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The visible half of the alarm: a line the model cannot skim past. */
export function gapBanner(sender: string, v: SequenceVerdict): string {
  return (
    `[PEER MESSAGE LOST] ${v.lost} message(s) from ${sender} never arrived ` +
    `(expected #${v.expected}, this is #${v.seq}). Their content is unrecoverable ` +
    `from here — ask ${sender} to resend if it mattered.\n\n`
  );
}

/**
 * The other thing a reader must not discover by failing: this message cannot be
 * answered with `peer_reply`.
 *
 * Measured 2026-08-25 on ofmchat #55. Its Dispatch had settled `failed`, so Orca
 * revoked the capability and rejected the child's escalation outright — and then
 * delivered its body here anyway. The route derivation refused (correctly: a
 * join it cannot make unique is not a destination), noted that on the log, and
 * injected the words with nothing said about answerability. The coordinator
 * answered a load-bearing question, was refused with `No reply route for
 * msg_…`, and had to resolve the child's pane out of `orca terminal list --json`
 * by hand. The refusal is right; discovering it by failing is not.
 *
 * NO ADDRESS IS OFFERED HERE, deliberately. The recorded pane of a dispatch that
 * never settled is a suspicion, not an association (`ls.mjs`), and typing into
 * it is a mutation that can steer a stranger or interrupt a mid-turn child. The
 * operator establishes the destination; this banner only says that they must.
 */
export function unanswerableBanner(sender: string): string {
  return (
    `[NO REPLY ROUTE] ${sender} sent this over a channel with no verified way back. ` +
    `Either its Dispatch settled \`failed\` and Orca revoked the capability, or the ` +
    `pane it came from publishes no Run of its own — so nothing here can be resolved ` +
    `into a destination. \`peer_reply\` will refuse it, and no address may be guessed. ` +
    `Establish the destination yourself before answering, and treat the question as ` +
    `unanswered until you have.\n\n`
  );
}

export function createReceiver(deps: ReceiveDeps): Receiver {
  let child: { stdout: unknown; stderr: unknown; exited: unknown; exitCode?: number; kill?: () => void } | null = null;
  let stopped = false;
  let retryDelay = RETRY_MIN_MS;
  let timerCtx: TimerCtx | null = null;
  /**
   * The last sequence accepted from each sender.
   *
   * Process-lifetime, deliberately: a restarted receiver has no baseline and
   * therefore does not alarm on the first message it sees. A missed check is a
   * silence we already live with; a false alarm would teach the coordinator to
   * ignore the real one.
   */
  const lastSeq = new Map<string, number>();

  function checkSequence(sender: string, seq: number | null): SequenceVerdict {
    if (seq === null) return { seq: null, lost: 0, expected: null, repeat: false };
    const last = lastSeq.get(sender);
    if (last === undefined) {
      lastSeq.set(sender, seq);
      return { seq, lost: 0, expected: null, repeat: false };
    }
    if (seq <= last) return { seq, lost: 0, expected: last + 1, repeat: true };
    lastSeq.set(sender, seq);
    return { seq, lost: seq - last - 1, expected: last + 1, repeat: false };
  }

  function scheduleRetry(pi: unknown): void {
    if (stopped) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    const managed = timerCtx?.setTimeout;
    if (typeof managed === 'function') {
      managed.call(timerCtx, () => loop(pi), delay);
      return;
    }
    // Only before `session_start` has handed us a ctx. Kept so the receiver still
    // retries in a host that never supplies one, never as the normal path.
    const t = setTimeout(() => loop(pi), delay);
    t?.unref?.();
  }

  function loop(pi): void {
    if (stopped) return;

    try {
      // --run is explicit on purpose. Relying on Orca inferring the caller's
      // bound Run from the environment is exactly the ambiguity that made the
      // first version fail silently in a split pane.
      child = deps.spawn(
        [
          deps.orca,
          'orchestration',
          'check',
          '--run',
          deps.runId(),
          '--wait',
          '--timeout-ms',
          String(WAIT_MS),
          '--json',
        ],
        { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
    } catch (err) {
      deps.note(`spawn failed: ${err}`);
      deps.reportHealth(pi, false);
      scheduleRetry(pi);
      return;
    }

    void (async () => {
      let raw = '';
      let errText = '';
      try {
        raw = await new Response(child.stdout).text();
        errText = await new Response(child.stderr).text();
        await child.exited;
      } catch (err) {
        deps.note(`read failed: ${err}`);
      }
      if (stopped) return;

      // `orca --json` PRETTY-PRINTS one object to stdout; the `_keepalive`
      // frames `--wait` emits go to stderr, not stdout. Parsing stdout
      // line-by-line as NDJSON — the obvious guess — silently turned every
      // successful delivery into a parse miss, so the loop replayed the same
      // unacked delivery forever and nothing was ever injected.
      const payload = deps.parse(raw);

      if (payload?.ok) {
        // A `check --wait` that returns ok — even with an empty delivery — is
        // the proof the receive path works. That is what makes the health
        // signal free: it rides the loop that already runs.
        deps.reportHealth(pi, true);
        const messages = Array.isArray(payload.result?.messages)
          ? payload.result.messages
          : [];
        deps.note(`delivery: ${messages.length} message(s)`);
        // Two failure modes live here, and they pull in opposite directions:
        // acking a delivery whose injection threw consumes that message forever
        // without the model ever seeing it, while NOT acking replays the whole
        // delivery and re-injects the messages that did land. Neither is
        // acceptable, so track what was injected and require both conditions.
        let allInjected = true;
        for (const msg of messages) {
          try {
            // Group traffic (@all/@idle/@worktree:…) is recorded, never injected.
            if (String(msg.to_handle ?? '').startsWith('@')) continue;
            // Heartbeats are liveness telemetry from orchestrated dispatches
            // (the injected preamble sends `alive`, empty body, but the payload
            // carries `phase`: investigating → implementing → reviewing). They
            // are consumed and logged WITH that phase, never injected: waking
            // the coordinator with an empty custom message per beat is pure
            // noise. Progress on demand:
            // `orca orchestration inbox --limit 100 --json` reads the same
            // payloads back out of the Run inbox.
            if (String(msg.type ?? '') === 'heartbeat') {
              const hbId = String(msg.id ?? '');
              if (hbId) deps.rememberInjected(hbId);
              let phase = '';
              try {
                const hb = msg.payload;
                const bag = typeof hb === 'string' ? deps.parse(hb) : hb;
                phase = String(
                  (bag as Record<string, unknown> | null)?.phase ?? '',
                );
              } catch {}
              deps.note(
                `heartbeat from ${deps.senderIdentity(msg).name}${phase ? ` — phase: ${phase}` : ''} (consumed, not injected)`,
              );
              continue;
            }
            // SIBLING RELAY. Orca refuses lateral sends from dispatch-bound
            // workers (`dispatch_run_mismatch`), so `sendToPeer` falls back to the
            // shared parent with a `forwardTo` envelope. This session — the
            // parent — re-posts to the target with the origin it VERIFIED
            // itself (senderIdentity, witnessed pane), logs the relay, and does
            // not wake its own model: the coordinator's guarantee is the audit
            // line plus the two hard gates (decision escalation, merge review),
            // not reading every sibling exchange.
            //
            // Two fences: an unattributed sender is never relayed (a forged
            // origin would otherwise ride the parent's authority), and the
            // re-posted payload carries no forwardTo, so a relay can never
            // cascade.
            {
              const rawFw = msg.payload;
              const fwBag = (
                typeof rawFw === 'string' ? deps.parse(rawFw) : rawFw
              ) as Record<string, unknown> | null;
              const forwardTo = String(fwBag?.forwardTo ?? '').trim();
              if (forwardTo) {
                const fwId = String(msg.id ?? '');
                if (fwId && deps.wasInjected(fwId)) continue;
                const origin = deps.senderIdentity(msg);
                if (!origin.attributed) {
                  if (fwId) deps.rememberInjected(fwId);
                  deps.note(`forward REFUSED: unattributed sender asked to relay to ${forwardTo}`);
                  continue;
                }
                // A worker we started is NAMED, not authorised. Only a
                // pane-witnessed sender may borrow this session's relay.
                if (origin.kind === 'dispatch') {
                  if (fwId) deps.rememberInjected(fwId);
                  deps.note(`forward REFUSED: dispatch sender ${origin.name} is named, not pane-witnessed — no borrowed authority`);
                  continue;
                }
                if (!RUN_ADDRESS.test(forwardTo)) {
                  if (fwId) deps.rememberInjected(fwId);
                  deps.note(`forward REFUSED: malformed target '${forwardTo}'`);
                  continue;
                }
                try {
                  const relayPayload = JSON.stringify({
                    peer: origin.name,
                    relayedByParent: true,
                    ...(sequenceOf(fwBag) === null ? {} : { seq: sequenceOf(fwBag) }),
                    ...(String(fwBag?.replyTo ?? '').trim()
                      ? { replyTo: String(fwBag?.replyTo).trim() }
                      : {}),
                  });
                  const relay = deps.spawn(
                    [
                      deps.orca,
                      'orchestration',
                      'send',
                      '--to',
                      forwardTo,
                      '--type',
                      String(msg.type ?? 'status'),
                      '--subject',
                      `peer:${origin.name} (via parent relay)`,
                      '--body',
                      String(msg.body ?? ''),
                      '--payload',
                      relayPayload,
                      '--json',
                    ],
                    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000 },
                  ) as { stdout: unknown; stderr: unknown; exited: Promise<number>; exitCode?: number };
                  const relayOut = await new Response(relay.stdout).text();
                  const relayErr = await new Response(relay.stderr).text();
                  const exitCode = await relay.exited;
                  const receipt = deps.parse(relayOut) as { ok?: boolean } | null;
                  if (exitCode !== 0 || receipt?.ok !== true) {
                    allInjected = false;
                    deps.note(`forward relay failed: ${relayErr.trim() || relayOut.trim() || `exit ${exitCode}`}`);
                  } else {
                    if (fwId) deps.rememberInjected(fwId);
                    deps.note(`relayed ${origin.name} → ${String(fwBag?.forwardToName ?? forwardTo)} (sibling forward)`);
                  }
                } catch (err) {
                  allInjected = false;
                  deps.note(`forward relay failed: ${err}`);
                }
                continue;
              }
            }
            const msgId = String(msg.id ?? '');
            const who = deps.senderIdentity(msg);

            // A MESSAGE THIS SESSION SENT ITSELF. Orca's supervised spec teaches
            // a worker to report with `orchestration send --from <its own handle>
            // --dispatch <id> --task-id <id>`, and on a remote child part of that
            // traffic comes back down the very channel this receiver consumes.
            // Injecting one wakes the child with its own words and burns a turn:
            // measured 2026-08-15, a gapicore child wrote `my own report echoed
            // back through the relay — nothing to answer there` twice in four
            // minutes, having sent nine reports of which its coordinator saw three.
            // Dropping is the whole fix available HERE — the delivery is consumed
            // by the time this code runs, so this ends the noise, not the loss.
            const selfHandle = (process.env.ORCA_TERMINAL_HANDLE ?? '').trim();
            if (selfHandle && String(msg.from_handle ?? '') === selfHandle) {
              deps.note(`dropped a message this session sent itself (${msgId || 'no id'})`);
              continue;
            }

            // The route rides in the message and is trusted only because the
            // message is attributed: a witnessed `sender_pane_key` means Orca
            // resolved this sender, so its payload is that pane's own words.
            // Recording it BEFORE the replay check is what makes a question
            // survive an OMP restart — `.seen` restores the id, and the retained
            // delivery restores the route, so `peer_reply` still lands.
            const rawPayload = msg.payload;
            const msgPayload =
              typeof rawPayload === 'string' ? deps.parse(rawPayload) : rawPayload;
            const replyTo = String(
              (msgPayload as Record<string, unknown> | null)?.replyTo ?? '',
            ).trim();
            // ANSWERABLE IS "A ROUTE WAS RECORDED", NEVER "THE SENDER WAS NAMED".
            //
            // This used to start `true` and be falsified only on the dispatch
            // path, so a pane message with no return address was announced as
            // repliable and then refused by `peer_reply`. That is most of the real
            // traffic: Orca's supervised preamble teaches `orca orchestration send
            // --type worker_done`, which carries no payload at all. Measured
            // 2026-08-25 on ofmchat, three times in one day — each cost the
            // coordinator a turn and then a hand-built address.
            let answerable = false;
            const paneHandle = String(msg.from_handle ?? '').trim();
            // `kind !== 'dispatch'` and not merely `attributed`: a dispatch sender
            // is named from our own record, but the payload it carries came over
            // the relay, and a reply ADDRESS is exactly the field a hostile
            // payload would want us to keep. An absent kind is the pane path.
            if (msgId && who.attributed && who.kind !== 'dispatch') {
              // The sender's own statement first: it is the more specific answer,
              // and honouring it means the fallback below can only fill a silence.
              if (RUN_ADDRESS.test(replyTo)) {
                deps.recordRoute(msgId, { run: replyTo, peer: who.name });
                answerable = true;
              } else {
                // No return address stated. The pane that sent this was witnessed
                // by Orca, so the Run IT published for itself is a route this side
                // resolves from a key the sender did not choose — see
                // `runAddressOfHandle` in `registry.ts` for the bound on that.
                const published = deps.paneRoute?.(paneHandle) ?? '';
                if (RUN_ADDRESS.test(published)) {
                  deps.recordRoute(msgId, { run: published, peer: who.name });
                  answerable = true;
                  deps.note(
                    `reply route for ${who.name} from its own registered Run (${published}) — the message stated none`,
                  );
                } else {
                  deps.note(
                    `no reply route for ${who.name} — it stated none and its pane publishes none`,
                  );
                }
              }
            }
            // A dispatch sender's address is DERIVED, from our own dispatch record joined
            // against Orca's view of that worker — never from the payload above, which
            // travelled the relay. So this branch reads nothing the sender wrote, and the
            // resolver returns null rather than a guess whenever the join is not unique.
            else if (msgId && who.kind === 'dispatch' && deps.deriveRoute !== undefined) {
              const derived = deps.deriveRoute(msg);
              if (derived === null) {
                deps.note(`no reply route derived for ${who.name} — refusing rather than guessing`);
              } else {
                deps.recordRoute(msgId, derived);
                answerable = true;
              }
            }

            if (msgId && deps.wasInjected(msgId)) continue; // replayed, already seen

            // SEQUENCE GAP. Checked here and not earlier, so it is evaluated
            // exactly once per message the model is about to see: an id-deduped
            // replay must not be counted twice, and a message that was dropped
            // above (self-send, heartbeat, relay) carries no sequence of ours.
            const verdict = checkSequence(who.name, sequenceOf(msgPayload));
            if (verdict.repeat) {
              // A duplicate the id dedup could not catch — same number, new id.
              // Saying so beats injecting the same words twice.
              deps.note(
                `duplicate sequence ${verdict.seq} from ${who.name} — not injecting twice`,
              );
              if (msgId) deps.rememberInjected(msgId);
              continue;
            }
            if (verdict.lost > 0) {
              deps.note(
                `PEER MESSAGE LOST: ${verdict.lost} message(s) from ${who.name} never arrived ` +
                  `(expected #${verdict.expected}, got #${verdict.seq})`,
              );
            }

            // `sendMessage` with a customType, NOT `sendUserMessage`: the former
            // is `role: "custom"`, the latter is `role: "user"` and therefore
            // indistinguishable from the operator. `triggerTurn` wakes an idle
            // session; a streaming one takes it as a steer, same as before.
            pi.sendMessage(
              {
                customType: 'peer-message',
                content:
                  (verdict.lost > 0 ? gapBanner(who.name, verdict) : '') +
                  (answerable ? '' : unanswerableBanner(who.name)) +
                  deps.peerContent(msg, who, answerable),
                display: true,
                details: {
                  peer: who.name,
                  model: who.model,
                  attributed: who.attributed,
                  // Two different claims, and conflating them is what produced
                  // three refused replies in one day: named by Orca, versus a
                  // destination this session actually holds.
                  answerable,
                  messageId: msgId,
                  type: String(msg.type ?? 'status'),
                  ...(verdict.seq === null ? {} : { sequence: verdict.seq }),
                  ...(verdict.lost > 0 ? { lostBefore: verdict.lost } : {}),
                },
              },
              { triggerTurn: true },
            );
            if (msgId) deps.rememberInjected(msgId);
            deps.note(
              `injected from ${who.name}${who.model ? ` (${who.model})` : ''}`,
            );
          } catch (err) {
            allInjected = false;
            deps.note(`inject failed: ${err}`);
          }
        }

        const deliveryId =
          payload.result?.deliveryId ?? payload.result?.delivery_id;

        // Ack only once every directed message reached the model. A retained
        // delivery is replayed by Orca, and the injected-id set keeps that
        // replay from showing the same message twice.
        let ackOk = false;
        if (deliveryId && allInjected) {
          const ack = deps.parse(
            deps.sh(
              [
                deps.orca,
                'orchestration',
                'check',
                '--run',
                deps.runId(),
                '--ack',
                String(deliveryId),
                '--json',
              ],
              10_000,
            ),
          );
          ackOk = ack?.ok === true;
          if (ackOk) {
            deps.compactInjected();
          } else {
            deps.note(`ack failed for ${deliveryId} — will replay, dedup by message id`);
          }
        } else if (deliveryId) {
          deps.note(`ack withheld for ${deliveryId}: an injection failed`);
        }

        // A delivery Orca still holds replays immediately, so going straight
        // back to `check` after a failed injection or ack spins: subprocess,
        // log line, 10s synchronous ack attempt, repeat. Dedup keeps the model
        // from seeing duplicates but does nothing about the storm. Only an
        // actually-completed delivery earns the fast path.
        if (allInjected && (!deliveryId || ackOk)) {
          retryDelay = RETRY_MIN_MS;
          queueMicrotask(() => loop(pi));
        } else {
          scheduleRetry(pi);
        }
        return;
      }

      deps.note(
        `wait failed: exit=${child?.exitCode} err=${payload?.error?.code ?? '?'} ` +
          `msg=${String(payload?.error?.message ?? '').slice(0, 160)} ` +
          `stderr=${errText.slice(0, 160)} raw=${raw.slice(0, 200)}`,
      );
      deps.reportHealth(pi, false);
      scheduleRetry(pi);
    })().catch((err) => {
      // The detached promise's own safety net. Its body has a guarded await
      // section and a guarded per-message loop, but the parse/health/report
      // region between them was bare: a throw there escaped the IIFE as an
      // unhandled rejection, which OMP's postmortem handler treats as fatal —
      // measured, it exits the session with code 1. Recovering like any other
      // wait failure keeps the receiver alive instead.
      deps.note(`receive loop threw: ${err}`);
      deps.reportHealth(pi, false);
      scheduleRetry(pi);
    });
  }

  return {
    start: loop,
    stop(): void {
      stopped = true;
      child?.kill?.();
    },
    useTimers(ctx: TimerCtx | null): void {
      timerCtx = ctx;
    },
  };
}
