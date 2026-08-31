// The one instruction a triage child receives, and the role map its marker is
// built from — identity and context in, one line out. Pure and offline:
// extracted from dispatch.mjs so a sentence of the child's contract can be
// proved without an Orca pipeline behind it. Every string's incident history
// moved here intact; dispatch keeps the machine, the gates and the loop.

/**
 * The session role and playbook each job's child must prove. One map feeds both
 * the spec marker and dispatch's role verification — two hardcoded strings is how a
 * marker and its proof drift apart (the same one-source rule the marker parser
 * itself follows, `omp/shared/alias.ts`).
 */
export const ROLE_BY_JOB = {
  triage: { role: 'triage-worker', skill: 'triage' },
  brief: { role: 'triage-worker', skill: 'triage' },
  custom: { role: 'triage-worker', skill: 'triage' },
};

/**
 * The label that says an issue is agent-grabbable — the artifact the spec chain
 * and the triage on-ramp both converge on.
 *
 * It lives HERE, next to the job vocabulary, because two parties need the same
 * name and neither may spell it itself: the `brief` child is TOLD to write it
 * into its own `Labels:` directive (below), and `publish` applies exactly what
 * a draft names. A second literal in either place is how the instruction and
 * the applied label drift apart — the same one-source rule as `ROLE_BY_JOB`.
 *
 * There is deliberately no ax-composed label: a name no draft author wrote is
 * the whole failure mode `publish` exists to prevent, so `brief` earns the
 * label the same way it earns every other one, through a directive a human can
 * read and correct before it lands.
 */
export const READY_LABEL = 'ready-for-agent';

/**
 * The one sentence every `--job` reader prints for a retired lane, so six verbs
 * cannot drift apart — the same one-source rule as `retiredConfigKeyFixes`,
 * which `doctor` and `init` share.
 *
 * `refine` was this repo's own Definition-of-Ready pass over spec sub-issues,
 * and it contradicted the methodology it was built beside: `to-tickets`
 * publishes `ready-for-agent` itself, so its tickets are agent-grabbable by
 * construction, and triage is an on-ramp for work you did NOT create. A pass
 * between the two had nothing left to decide. So the name is refused BY NAME
 * rather than swept into the unknown-job usage error: an operator with the old
 * command in their shell history is owed the reason and the repair, not a list
 * of three words that no longer contains theirs.
 *
 * The sentence names no "readiness pass". `refine` was the last thing that word
 * described here, and it went; leaving the noun in the refusal that retires it
 * pointed a reader at a lane they could not find in the help, in the config or
 * in `--job`. CONTEXT.md retires the word (_Avoid_: readiness), and this string
 * is what an operator reads instead of that glossary.
 */
export const REFINE_REMOVED =
  '--job refine no longer exists: `to-tickets` publishes ready-for-agent itself, so a spec-born ticket is already agent-ready and there is no pass left here for it — and triage is for inbound work only. A ticket that genuinely is not ready is a `to-tickets` defect: fix it on the ticket, then dispatch nothing.';

/**
 * The one instruction a session gets, on one line.
 *
 * The model marker travels HERE and never as a `worker-start --model` flag: the
 * marker is what the child's own model adapter reads, and a flag would name a
 * model for the dispatch instead of for the session.
 *
 * Under this contract the child mutates NOTHING. Everything the Bash spec spent
 * its length on — apply five groups with `gh issue edit`, never wontfix, never
 * close, never the bare size labels — is the publisher's contract now, and
 * belongs to `ax triage publish`. What the child owes is one file.
 */
export function renderSpec({ job, model, issue, repo = '', draft, labels, triaged, instruction, pass = 1, previous = null, because = '' }) {
  const marker = `[omp role=${ROLE_BY_JOB[job].role} model=${model}]`;
  // The write-failure ladder exists because #60 (2026-08-23) could not write
  // its draft at all, put the verdict in its terminal, and its report was the
  // day's sixth lost peer message: the wave stalled on finished work nobody
  // could see. The pane transcript is the one channel on this machine that
  // never loses — `ax worker transcript` reads it back — so a verdict that
  // cannot reach its file must land there IN FULL, between markers a recovery
  // can find, with the exact error that kept it out of the file.
  const nothing = `Apply no label, post no comment, close nothing, and modify no file in the repository: write ONLY ${draft}. The human reads that file, corrects it, and publishes it — a verdict that lands the moment it is rendered cannot be adjusted. If that write FAILS, retry it once; if it still fails, do not let the verdict live only in prose: print the exact error (errno and path) and then the COMPLETE draft between a line reading BEGIN DRAFT and a line reading END DRAFT in your final message — the pane transcript is the recovery channel, and an unwritten draft reported without its full text is a verdict lost.`;

  // HOW to ask, and — the part that was wrong on the first cut — WHEN to stop.
  //
  // The shape is declared because three children escalated in three layouts
  // ("What we still need from you", a/b/c sub-points, inline forks), and a
  // numbered ask is one a parent can answer by number without quoting it.
  //
  // But the first version of this string ended on "Report when the draft is
  // written", which told a child with open questions to FINISH. That is what
  // broke the answer channel, and the orchestrator measured both halves of it
  // on 2026-08-22: children's `ask` refused because the stall had revoked their
  // capability, and its own replies with no route left "after their report".
  // Both are consequences of the child ending its turn.
  //
  // The command is ax's OWN, fully rendered, for the same reason the label
  // grammar is named: an unnamed gesture gets improvised, and three children
  // improvising an escalation is what produced three layouts. One commit of
  // this string named `orca orchestration ask` raw instead, and that put the
  // whole middle of the loop outside the tool that knows the rules — a child
  // typing its own `--question` can ask something other than what its draft
  // records. `ax triage ask` reads the Q lines off the draft itself, so the
  // wire and the record cannot diverge; underneath it is the same measured
  // transport (blocks until answered; from an active Dispatch it defaults to
  // the owning Run's mailbox; a timeout leaves the question PENDING and a
  // resume goes back to waiting on the same one, which is what makes an
  // unbounded human latency survivable without the child dying or deciding).
  //
  // The global command is the stable entry point a fresh child receives, and it
  // delegates this argv to the exact project package (`src/delegation.mjs`).
  const askCommand = `ax triage ask --issue ${issue} --job ${job}${repo ? ` --repo ${repo}` : ''} --pass ${pass}`;
  // The routing tag lives INSIDE the question text, never between the number
  // and the colon: `Q<n> [technical]:` would break the one Q-line grammar
  // (draft.mjs), while `Q<n>: [technical] …` travels verbatim through ask and
  // answer with zero code. The categories are the maintainer's own ruling
  // (2026-08-23, measured on 24/24 answers that merely confirmed the
  // orchestrator's technical recommendation): the orchestrator RULES,
  // reversibly. `[product]` is advisory — escalate only when the ruling would
  // change what users see, commit money, legal position or personal data, or
  // contradict an expressed intention. The tag is not validated — an untagged
  // question costs
  const asking = `When something load-bearing is underdetermined, do not decide it alone and do not bury the ask in prose: write one \`Q<n>: <question>\` line per open decision, numbered from 1 with no gaps and no repeats, each answerable on its own, and OPEN each question's text with its routing tag — \`[technical]\` for representation, cardinality, file placement, versioning, pure/impure, type unions or SQL mechanics, which the parent that dispatched you rules itself and reversibly; \`[product]\` for scope, user-visible behavior, security, money, data, or business taxonomy — advisory for that parent, who still rules unless the answer would change what users see, commit money, legal position or personal data, or contradict an expressed intention — so the parent routes each question without reading it twice. Keep those lines in the draft so the decision is on record. Then run \`${askCommand}\`, which sends the draft's own Q lines to the parent that dispatched you and blocks until they are answered; if it exits 4 the question is PENDING under a printed message id, so go back to waiting on it with \`ax triage ask --resume <message_id>\` rather than giving up or deciding it yourself. Do not report and do not end your turn while a question is open — with ONE exception, and THE ASK ITSELF DECLARES IT: when its repair line tells you to report, that line outranks this sentence. Two refusals say so today — this Dispatch is not supervised (its capability died at a composer stall), and the runtime refusing to admit any ask after the verb's own retries (\`runtime_busy\`, long-poll capacity) — and in both, no ask can land from this session at all, so retrying by hand buys nothing. Then keep the \`Q<n>:\` lines in the draft and report immediately, quoting them verbatim and saying exactly why the supervised channel is unavailable; your report is the only channel left, and the parent answers by peer. On every other refusal, and on a timeout, you do NOT report: exit 4 is pending, not dead. You hold the issue and the code you have already read; that context is why the answer comes to you rather than to a later session. When the answers arrive, revise the draft into a final verdict, drop the \`Q<n>:\` lines the answers close, and only then report.`;

  // What a SECOND pass is told, and it is told before anything else it reads.
  // Empty on pass 1, so the ordinary dispatch is byte-identical to what it was.
  //
  // The previous draft is named by path AND by fingerprint. The path lets the
  // child read what its predecessor concluded instead of re-deriving it; the
  // `git hash-object` value is what lets a human afterwards prove which version
  // it actually read, which is the same question #54 could not answer. Both are
  // immutable: no pass is ever renamed to make room for the next one.
  const redo = previous === null
    ? ''
    : `This is PASS ${pass} on this issue. Pass ${previous.pass} already ran and its verdict is at ${previous.path} (git hash-object ${previous.sha || 'unwritten'}) — read it first. You are not starting over and you are not reviewing it: keep everything it established that the following still supports, and change only what follows from it. WHAT CHANGED SINCE: ${because.replace(/\s+/g, ' ').trim()}`;

  if (job === 'triage') {
    return [
      marker,
      redo,
      `Use the preloaded triage playbook AND ${labels}, which overrides the playbook wherever the two diverge.`,
      `Then triage issue #${issue} (issue://${issue}).`,
      `Write your verdict to ${draft}. It opens with directive lines, then the comment body a human will read on the issue months from now, with your justification at one line per group.`,
      `A directive carries label NAMES ONLY — never a group name, never a parenthetical: \`Labels: <name>[, <name>…]\`, repeatable so one line per group stays cheap to correct; \`Remove labels: <name>[, <name>…]\` for the labels your transition supersedes; \`Close: yes\` if you conclude wontfix, and say why — you are recommending it, not doing it.`,
      `Leaving a group empty means you have not finished. Every name is checked against this repository's own label list before anything is applied, so \`Labels: state → needs-info\` and \`Remove labels: needs-triage (superseded)\` are both refused: they name no label that exists.`,
      nothing,
      asking,
      'Report when the draft is FINAL — which means it carries no open question.',
    ].filter(Boolean).join(' ');
  }

  if (job === 'brief') {
    return [
      marker,
      redo,
      `Use the preloaded triage playbook, especially its Agent Brief section, and ${labels}.`,
      `Issue #${issue} (issue://${issue}) has ALREADY had its triage pass: do not redo it, do not re-measure what is established, and do not render a competing verdict.`,
      `Write the Agent Brief that follows from that pass to ${draft}, absorbing everything its "what is missing" section asks for, with a \`Labels:\` line for any label the pass left unapplied and a \`Remove labels:\` line for any state label your transition supersedes — label names only, no group prefix and no parenthetical, each checked against this repository's label list before it is applied.`,
      // `brief` is the ONLY pass that produces a brief, so it is the only pass
      // that can make an issue agent-grabbable: the label and the brief are one
      // artifact, and an AFK launcher dispatches on both together. The child
      // writes the name itself, in the same directive grammar as every other
      // label, because `publish` applies exactly what a draft names and nothing
      // it composed. A brief the pass judges incomplete is the one case where
      // the name is withheld — and then the draft says why, in its body.
      `Your \`Labels:\` line MUST include \`${READY_LABEL}\`: this brief is what makes the issue grabbable by an agent, and the label plus the brief are one artifact. Withhold it only if the brief is not something you would hand an implementer, and then say in the body what is missing.`,
      `An underdetermined acceptance criterion is not something to fill in: write no criterion for it and ask instead. If you find the pass itself is wrong, do not correct it silently — ask.`,
      asking,
      nothing,
      'Report when the draft is FINAL — which means it carries no open question.',
    ].filter(Boolean).join(' ');
  }

  // The caller's own one-line task, prefixed by the issue's triage state. That
  // prefix is not decoration: hand-rolling this dispatch outside the script on
  // 2026-08-10 produced a spec opening on "read skill://triage" for an
  // already-triaged issue, and the session had to be steered off mid-flight.
  const prefix = triaged
    ? `Issue #${issue} (issue://${issue}) has ALREADY had its triage pass; it is in its comments: do not re-triage it, render no verdict, apply no label or state. `
    : '';
  return `${marker} ${prefix}${instruction.replace(/\s+/g, ' ').trim()} Write what you find to ${draft}. ${nothing}`;
}
