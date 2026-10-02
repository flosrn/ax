// @ts-nocheck - runs under OMP's Bun runtime, not the repo TypeScript project.
/**
 * The peer view's seam to OMP: message renderers, tool renderers, the widget
 * above the editor and the footer status — all drawn by `view.ts` from
 * `details`, all fed by `ledger.ts`.
 *
 * Presentation only, and it fails OPEN to the old display: with no host kit
 * (`tui.ts`) nothing is registered, a message delivered before `details`
 * carried a `body` falls back to OMP's plain rendering, and a throw while
 * drawing the widget never reaches the receive loop or a tool call. The model's
 * `content` is never read to decide anything here except to show it verbatim
 * under "what the agent reads".
 */
import { DISMISS, freshLedger, type Ledger, needsYou, observe, rebuild, speakerOf } from './ledger.ts';
import { hostKit } from './tui.ts';
import { bubble, type Card, colorOf, type Kit, MAX_WIDTH, notice, type Paint, partition, status, widget } from './view.ts';

const KEY = 'ax-peers';

/** Each NoRoute reason in the operator's words; the model's version is `unanswerableBanner`. */
const REFUSED: Record<string, string> = {
  'no-id': 'no reply: the message carries no id',
  unattributed: 'no reply: Orca could not confirm the sender',
  'pane-unrouted': 'no reply: the sender stated no return address',
  'dispatch-unresolved': 'no reply: no unique route to this worker',
  watcher: 'no reply: the watcher has no inbox — act on the worker',
  'watcher-unresolved': 'no reply: no unique route to the worker',
};

const OUTCOME: Record<string, string> = {
  direct: 'sent',
  relay: 'sent through the shared parent',
  queued: "queued on the parent's Run, unread",
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const component = (draw: (w: number) => string[]) => ({ invalidate() {}, render: (w: number) => draw(Math.max(20, w)) });
const paintOf = (theme): Paint => ({ fg: (c, s) => theme.fg(c, s), bold: (s) => theme.bold(s) });
const textOf = (content): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c?.type === 'text' ? str(c.text) : '')).join('\n')
      : '';

export interface PeerViewDeps {
  /** The recorded reply route for a received message id (`peer_reply`'s only authority). */
  routeOf: (messageId: string) => { peer: string } | undefined;
  kit?: Kit | null;
}

export function createPeerView(deps: PeerViewDeps) {
  const kit = deps.kit === undefined ? hostKit() : deps.kit;
  let ledger = freshLedger();
  let ui = null;

  function refresh(): void {
    if (!ui || !kit) return;
    try {
      const rows = () => ({ owed: [...ledger.owed.values()], awaiting: [...ledger.awaiting.values()], alerts: ledger.alerts });
      const now = partition(rows(), Date.now());
      ui.setStatus(KEY, status(now, paintOf(ui.theme)));
      ui.setWidget(
        KEY,
        now.counts.owed + now.counts.awaiting + now.counts.alerts + now.old === 0
          ? undefined
          : (_tui, theme) =>
              component((w) => {
                const at = Date.now();
                return widget(partition(rows(), at), w, at, kit, paintOf(theme));
              }),
      );
    } catch {}
  }

  function cardOf(d): Card | null {
    if (!d || typeof d.body !== 'string') return null;
    const id = str(d.messageId);
    const thread = str(d.threadId);
    const inReplyTo = thread && thread !== id ? ledger.asked.get(thread) : undefined;
    let body = d.body;
    let via: string | undefined;
    if (d.kind === 'watcher') {
      // A card's first column is the worker's board status; it is provenance, not words.
      const column = /^([\w-]+)\t/.exec(body);
      if (column) body = body.slice(column[0].length);
      via = `relayed by your watcher${column ? ` · ${column[1]}` : ''}`;
    } else if (d.kind === 'dispatch') via = 'your worker';
    else if (d.attributed === false) via = 'unidentified sender';
    else via = str(d.model) || undefined;
    const label =
      d.kind === 'watcher'
        ? /\bDECISION:/.test(body) ? 'decision' : str(d.alert) || 'alert'
        : inReplyTo
          ? 'reply'
          : str(d.type) || 'status';
    const notes: string[] = [];
    const lost = Number(d.lostBefore) || 0;
    if (lost > 0) notes.push(`! ${lost} earlier message${lost > 1 ? 's' : ''} from ${speakerOf(d)} never arrived`);
    if (str(d.refused)) notes.push(REFUSED[d.refused] ?? `no reply: ${d.refused}`);
    return {
      dir: 'in',
      peer: speakerOf(d),
      label,
      via,
      body,
      inReplyTo,
      needsYou: needsYou(d),
      notes,
      route: str(d.route) ? `peer_reply → ${d.route}` : undefined,
      at: Number(d.at) || undefined,
    };
  }

  const out = (peer: string, label: string, body: string, inReplyTo?: string): Card => ({
    dir: 'out',
    peer,
    label,
    body,
    inReplyTo,
  });

  /** `╰ outcome` under an outgoing bubble, or the refusal Orca or this adapter gave. */
  function receipt(result, theme, w: number): string[] {
    const p = paintOf(theme);
    const d = result?.details ?? {};
    const fit = (l: string) => kit.truncate(l, Math.min(w, MAX_WIDTH));
    if (result?.isError || !d.outcome) return [fit(p.fg('muted', '╰ ') + p.fg('error', `✗ ${textOf(result?.content).split('\n')[0]}`))];
    const to = d.peer ? p.fg('dim', ` to ${d.peer}`) : '';
    const waiting = d.type === 'question' && d.messageId && !d.unattributed ? p.fg('dim', ' · waiting for the answer') : '';
    const lines = [p.fg('muted', '╰ ') + p.fg(d.outcome === 'queued' ? 'warning' : 'success', `✓ ${OUTCOME[d.outcome] ?? d.outcome}`) + to + waiting];
    if (d.unattributed)
      lines.push(p.fg('muted', '  ') + p.fg('warning', '! the recipient cannot answer: this pane publishes no ORCA_PANE_KEY'));
    return lines.map(fit);
  }

  const title = (name: string, tool: string, theme, extra = '') =>
    component(() => [`${theme.bold(name)}${extra}${theme.fg('dim', `  ${tool}`)}`]);

  const toolViews = {
    peer_send: {
      renderCall: (args, _o, theme) =>
        component((w) => bubble(out(str(args?.peer), str(args?.type) || 'status', str(args?.text ?? args?.message ?? args?.body)), { expanded: true }, w, kit, paintOf(theme))),
      renderResult: (result, _o, theme) => component((w) => receipt(result, theme, w)),
    },
    peer_reply: {
      renderCall: (args, _o, theme) =>
        component((w) => {
          const id = str(args?.message_id);
          const peer = deps.routeOf(id)?.peer ?? id;
          return bubble(out(peer, 'reply', str(args?.text ?? args?.message ?? args?.body), ledger.asked.get(id) || undefined), { expanded: true }, w, kit, paintOf(theme));
        }),
      renderResult: (result, _o, theme) => component((w) => receipt(result, theme, w)),
    },
    peer_list: {
      renderCall: (_a, _o, theme) => title('peers', 'peer_list', theme),
      renderResult: (result, _o, theme) =>
        component((w) => {
          const p = paintOf(theme);
          const rows = result?.details?.rows;
          if (!Array.isArray(rows)) return textOf(result?.content).split('\n').map((l) => kit.truncate(l, w));
          const indent = (d: number) => (d > 0 ? `${'  '.repeat(d - 1)}└ ` : '');
          const nameW = Math.max(...rows.map((r) => indent(r.depth).length + r.peer.length)) + 2;
          const modelW = Math.max(...rows.map((r) => `${r.model || '?'}${r.level ? `:${r.level}` : ''}`.length)) + 2;
          return rows.map((r) => {
            const name = `${indent(r.depth)}${r.peer}`;
            const model = `${r.model || '?'}${r.level ? `:${r.level}` : ''}`;
            return kit.truncate(
              `  ${p.fg('success', '●')} ${p.bold(p.fg(r.self ? 'text' : colorOf(r.peer), name))}${' '.repeat(nameW - name.length)}` +
                `${r.self ? p.fg('accent', 'you ') : '    '}${p.fg('muted', model.padEnd(modelW))}${p.fg('dim', `${r.id || '?'}  ${r.depth < 0 ? 'depth ?  ' : ''}${r.worktree}`)}`,
              Math.min(w, MAX_WIDTH),
            );
          });
        }),
    },
    peer_children: {
      renderCall: (_a, _o, theme) => title('children', 'peer_children', theme),
      renderResult: (result, _o, theme) =>
        component((w) => {
          const p = paintOf(theme);
          const rows = result?.details?.rows;
          if (!Array.isArray(rows)) return textOf(result?.content).split('\n').map((l) => kit.truncate(l, w));
          const nameW = Math.max(...rows.map((r) => r.name.length)) + 2;
          return rows.map((c) =>
            kit.truncate(
              `  ${c.live ? p.fg('success', '●') : p.fg('dim', '○')} ${p.bold(c.name.padEnd(nameW))}` +
                `${p.fg(c.live ? 'muted' : 'error', (c.live ? c.status : `gone · ${c.status}`).padEnd(22))}${p.fg('dim', c.checkpoint)}`,
              Math.min(w, MAX_WIDTH),
            ),
          );
        }),
    },
    peer_read: {
      renderCall: (args, _o, theme) => title(`read ${str(args?.peer)}`, 'peer_read', theme),
      renderResult: (result, { expanded }, theme) =>
        component((w) => {
          const d = result?.details;
          if (result?.isError || !Array.isArray(d?.messages)) return textOf(result?.content).split('\n').map((l) => kit.truncate(l, w));
          const p = paintOf(theme);
          return [
            kit.truncate(p.fg('dim', `  transcript ${d.path}`), Math.min(w, MAX_WIDTH)),
            ...d.messages.flatMap((m) => bubble({ dir: 'in', peer: d.peer, label: 'said', body: m }, { expanded }, w, kit, p)),
          ];
        }),
    },
    peer_diagnostics: {
      renderCall: (_a, _o, theme) => title('delivery diagnostics', 'peer_diagnostics', theme),
    },
  };

  return {
    /** Attach to the lead session's UI and rebuild the ledger from its active branch. */
    bind(ctx): void {
      const candidate = ctx?.ui;
      ui = typeof candidate?.setWidget === 'function' && typeof candidate?.setStatus === 'function' ? candidate : null;
      try {
        const sm = ctx?.sessionManager;
        const entries =
          typeof sm?.getBranch === 'function' ? sm.getBranch() : typeof sm?.getEntries === 'function' ? sm.getEntries() : [];
        ledger = rebuild(entries);
      } catch {
        ledger = freshLedger();
      }
      refresh();
    },
    delivered(details): void {
      if (observe(ledger, { type: 'custom_message', customType: 'peer-message', details })) refresh();
    },
    toolResult(event): void {
      if (observe(ledger, { type: 'message', message: { role: 'toolResult', ...event } })) refresh();
    },
    /** The ledger as it stands, for `/peers`. Read-only by contract. */
    ledger(): Ledger {
      return ledger;
    },
    /** Apply an operator dismissal the caller has already recorded as a session entry. */
    dismiss(data: { ids: string[]; alerts: boolean }): void {
      if (observe(ledger, { type: 'custom', customType: DISMISS, data })) refresh();
    },
    /** `{renderCall, renderResult}` for one peer tool, or nothing when the host has no kit. */
    tool(name: keyof typeof toolViews) {
      return kit ? toolViews[name] : {};
    },
    registerRenderers(pi): void {
      if (!kit || typeof pi.registerMessageRenderer !== 'function') return;
      pi.registerMessageRenderer('peer-message', (msg, { expanded }, theme) => {
        const card = cardOf(msg?.details);
        if (!card) return undefined;
        return component((w) => bubble(card, { expanded, agentText: textOf(msg.content) }, w, kit, paintOf(theme)));
      });
      pi.registerMessageRenderer('peer-channel', (msg, { expanded }, theme) =>
        component((w) => {
          const p = paintOf(theme);
          const text = textOf(msg?.content);
          const line =
            msg?.details?.kind === 'recovered'
              ? notice('●', 'success', `peer channel back${msg.details.peer ? ` · ${msg.details.peer}` : ''}`, w, kit, p)
              : notice('!', 'error', text.split('\n')[0], w, kit, p);
          return expanded ? [line, ...kit.markdown(text, Math.min(w, MAX_WIDTH) - 2).map((l) => `  ${p.fg('dim', l)}`)] : [line];
        }),
      );
    },
  };
}
