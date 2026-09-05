// The brief a dispatched child reads before it touches anything.
//
// IT IS A FILE, NEVER A PAYLOAD TYPED INTO A TUI. Measured 2026-08-01: three
// worktrees skipped every stage after the first while the sender reported
// success — the text reached a prompt that had already moved on, and nothing
// about the receipt said so. A file is read by the session itself, once, from a
// path that can be printed, pasted and re-read after the fact.
//
// ORDER IS LOAD-BEARING, and this is the whole reason the composition lives in
// one pure function instead of being appended by the caller as it goes:
//   1. the marker AND the instruction on ONE line. That single-line form is what
//      applied `role: default` on five measured dispatches. A marker alone on
//      its own line is untested, so it is not assumed.
//   2. the title as an H1, then the URL — the title stays where it cannot be
//      mistaken for an instruction.
//   3. how to read the ticket, and that the ticket is canonical. The command is
//      the CALLER's: which read shows a thread is a property of the tracker, not
//      of ax (see ./ticket.mjs).
//   4. which session dispatched it and where the child runs.
//   5. the PRECEDENCE rule, once. Two contracts govern a worker's completion —
//      the runtime's injected preamble and this brief — and until
//      `docs/adr/0002` they competed silently: measured on the 2026-09-03 wave,
//      eight of eight workers obeyed the preamble and none delivered its
//      criteria where the dispatching session reads them. One sentence saying
//      which text wins replaces every point-by-point override.
//   6. the REPORT: where it goes (derived, ./report.mjs), what shape it has,
//      what the completion carries, where a question goes, and what a refusal
//      arriving after that completion is. ax owns this because ax derives the
//      path and ax's receiver opens it — a project that declares its own
//      contract replaces the propositions below, never this.
//   7. the contract. The project's, when it declares one; MECHANICS when it does
//      not.
//   8. the remote addendum, when the child runs on another host.
//   9. the notes channel's DERIVED half: the landed facts of this Spec, read
//      from the tracker and this checkout's git rather than from any Report
//      (./landed.mjs). It is announced as derived, and it goes ABOVE the
//      operator's words because those are verbatim and last.
//  10. the operator's own notes, verbatim and last, under a heading naming the
//      file it came from — an operator's words are never paraphrased by ax and
//      never allowed to displace the contract above them.
//
// ax OWNS 5 THROUGH 8 ONLY AS MECHANICS. Anything that is one fleet's doctrine —
// which entry command, which review skill, which tracker convention — arrives
// through `contract`. MECHANICS therefore names no skill, no repository and no
// ticket. It names no ROLE either: `orchestrator` is one role that dispatches an
// implementation child, `omp/roles/worker.md` names it because a role file may,
// and a fleet whose parent is something else still gets a true contract here. It
// is what is true of an Orca dispatch in any repo.

/**
 * Where the operator's own notes start, so a child can tell them from ax's text.
 *
 * NOTES, not BRIEF: `Brief` names the Agent Brief comment that carries an inbound
 * issue's assignment, and one word for two artifacts is how a child reads wave
 * memory as its assignment. The flag that carries this file is `--notes`.
 */
const OPERATOR_HEADING = 'OPERATOR NOTES';

/**
 * Where the DERIVED half of the notes channel starts, and the sentence that says
 * it is derived.
 *
 * Two authorities share this channel and a reader must be able to tell them
 * apart at a glance: ax derived these facts from established artifacts, the
 * operator wrote everything under `OPERATOR_HEADING` by hand. The heading names
 * both the derivation and its sources, because a fact whose provenance a child
 * cannot see is one it has to go and re-establish (#195).
 */
export const LANDED_HEADING = "LANDED IN THIS SPEC (derived by ax from the tracker and this checkout's git, never from a Report)";

/**
 * The contract ax itself owns: the mechanics of being a supervised child of the
 * session that dispatched it, with every fleet-specific instruction removed. A
 * project that declares `dispatch.contract` gets its own text instead of this one.
 *
 * Each line is a proposition an incident proved (F-027):
 *  - the extra worktree: a child that creates its own leaves the provisioned one
 *    unused and its dispatcher watching a tree nothing happens in. The same
 *    bullet names `.agent/worktree-context.local.md`, because a tree that is
 *    already prepared is only useful to a child that knows how it was prepared:
 *    `ax worker dispatch` REFUSES to place a child in a tree without that file — "the
 *    child would have no URL to test against" (./placement.mjs) — and until
 *    2026-08-26 never named it, so the one artifact written to answer "which
 *    port, which database, which branch" was read by the dispatching session and
 *    not by its reader.
 *  - the shipping tail: measured 2026-08-14, a child reported while its e2e was
 *    still queued and the dispatching session spent the wait. The wait is the child's.
 *  - never merging: the merge is the one decision a child cannot see the whole
 *    of — sibling branches, release order, what else is in flight.
 *  - the ticket: the dispatching session reads it, and a ticket left at its opening
 *    state is a queue lie that re-dispatches finished work.
 *  - blocking decisions: a child that decides alone has silently taken its
 *    dispatcher's job, and nobody is told. It carries HOW to escalate for a
 *    measured reason (2026-08-26): of two children refused by the same runtime
 *    error, the one that reported the summary — "the supervised channel is
 *    unavailable" — produced no repair across two dispatches, while the one that
 *    quoted `dispatch_capability_invalid` and named the flag it was missing had
 *    the cause found in the runtime source and fixed the same hour. An exact
 *    code makes a source findable; a summary makes it guessable.
 *  - the stall watcher: stated so prolonged silence is not read as a demand for
 *    heartbeat noise. It is a net, not a leash.
 *  - verification: what was exercised, not a project-wide sweep run for show.
 */
const BULLETS = [
  [
    '- The worktree you were started in is yours and is already bootstrapped. Do not create another.',
    '  It describes itself in `.agent/worktree-context.local.md` — its branch, its OWN dev port and',
    '  the state of its database. Read that file before you start a server, open a page or touch the',
    '  database: a hardcoded `localhost:3000` reaches another branch\u2019s app, and the wrong database',
    '  command rewrites what every other session is reading.',
  ].join('\n'),
  [
    '- **You own the shipping tail; the session that dispatched you owns only the merge.** Commit,',
    '  push and open the pull request yourself, then take CI to a DECISION before you report.',
    '  Measured 2026-08-14: a child reported while its end-to-end run was still queued, and that',
    '  session spent the wait instead. That wait is yours.',
  ].join('\n'),
  '- You do not merge, ever, even when everything is green. That decision belongs to the session that dispatched you.',
  [
    '- Keep the ticket current yourself: in progress when you start, final state and pull request link',
    '  when you finish. The session that dispatched you reads the ticket, and a ticket still showing',
    '  its opening state is a queue lie — a view that treats unfinished work as its input',
    '  re-dispatches finished work.',
  ].join('\n'),
  [
    '- Any decision that blocks you goes to the session that dispatched you; your report wakes it.',
    '  Deciding it alone is taking its job without telling it. Quote the exact error — its code, its',
    '  argv, the raw output — never a summary of it: a code makes the cause findable, "it does not',
    '  work" leaves it to be guessed.',
  ].join('\n'),
  [
    '- A stall watcher is armed on your dispatch: prolonged silence on your pane raises ONE alert on',
    '  the Run of the session that dispatched you. It is a net, not a leash — spend no turns on',
    '  heartbeats.',
  ].join('\n'),
  '- Verify what you changed and say what you exercised. No project-wide sweep for show.',
];

/** The bullet that only makes sense when a tracker owns the work. */
const TICKET_BULLET = 3;

export const MECHANICS = BULLETS.join('\n');

/**
 * The mechanics for a dispatch with NO ticket (`--name`, no tracker ref).
 *
 * The ticket bullet is not merely irrelevant there — it is an instruction the
 * child cannot carry out, and the cost is exact: it tells the child the
 * dispatching session READS the ticket, so a child with none either invents one or
 * concludes its report is being read somewhere it is not. What replaces it says
 * where the work is defined and where its record goes.
 */
export const MECHANICS_UNTRACKED = BULLETS.map((bullet, index) =>
  index === TICKET_BULLET
    ? [
        '- There is NO ticket for this work: this brief is its whole definition, and your board card',
        '  plus your pull request are its only record. Do not go looking for a ticket, and do not open',
        '  one — the session that dispatched you named this work, and that name is what it looks for.',
      ].join('\n')
    : bullet,
).join('\n');

/**
 * The one sentence that makes every line below it enforceable.
 *
 * The runtime's preamble is the first user message of every dispatched pane and
 * it rules the same completion this brief rules. Measured on the 2026-09-03
 * wave (`docs/adr/0002`): eight workers, two contracts, and eight preambles
 * obeyed — the ax side was prose in a playbook the child read earlier and
 * nothing said which text won. It is stated ONCE, at the head of the mechanics,
 * because a rule restated per point is a rule a reader has to reconcile per
 * point.
 */
const PRECEDENCE = 'The preamble above speaks for the runtime; where this brief says otherwise, this brief wins.';

/**
 * The Report: the work artifact, as against the Summary the completion carries.
 *
 * `report` is `{ path }` | `{ reason }` — the answer of ./report.mjs, never a
 * recipe this renderer applies. Nothing here knows how the path is built, so
 * there is exactly one rule and the brief cannot drift from what the receiver
 * opens.
 *
 * An inability is rendered as one: a child on another host has no path this host
 * can name (`--worktree new-top-level`), and inventing one would send the Report
 * where nothing looks while reading like an answer (F-028).
 */
function reportContract(report) {
  const { path = '', reason = '' } = report ?? {};
  const shape = [
    '  `## CRITERIA` is its FIRST section: one line per acceptance criterion your ticket names,',
    '  quoted closely enough to be found again, each followed by the evidence you observed for it —',
    '  the command you ran and the value you read back, or the artifact and what it says. A criterion',
    '  you could not prove reads `NOT MET: <what you observed instead>`. `## LEARNINGS` is its LAST',
    '  section. Write it on `--outcome failed` too: a slice that stopped short is the one whose',
    '  criteria are read hardest.',
  ];
  const head =
    path === ''
      ? [
          '- **Your REPORT is a file, and this dispatch cannot name where it goes:**',
          `      ${reason || 'nothing derived one, so the Report path cannot be established'}.`,
          '  Say that on your completion instead of choosing a path — a location nothing derived is a',
          '  location nothing reads. Its shape is unchanged:',
        ]
      : [
          '- **Your REPORT is a file, and this dispatch already decided where it goes:**',
          `      ${path}`,
          '  Write it there and nowhere else — never a path you pick, never pane text.',
        ];
  return [
    ...head,
    ...shape,
    '- **Your completion carries both: the Summary in `--body`, the Report in `--report-path`.** The',
    '  Summary is the three sentences the runtime asks for; it points at the Report and never stands',
    '  in for it.',
    '- A question goes to the session that dispatched you through your PEER TOOLS, where it arrives',
    '  attributed and is drained with the rest of that session\u2019s inbox —',
    '  never through `orca orchestration ask`, which nothing on its side is waiting on.',
    '- A refusal that arrives AFTER your completion — a merge gate\u2019s, a reviewer\u2019s — is supervised',
    '  work on the same slice: repair it, rewrite the Report in place at the same path, and report by',
    '  your board card. Never a second `worker_done`: the runtime settled the first, and the ones',
    '  after it land nowhere.',
  ].join('\n');
}

/**
 * True of every cross-host child, always — so it is generated here rather than
 * retyped into each brief, where it was omitted exactly once and cost a report.
 *
 * Both halves are structural facts the child cannot derive in time:
 *  - measured 2026-08-14, a dispatching session's replies arrive unattributed
 *    because the child's host holds no dispatch record for the sender and the
 *    pane key cannot cross. A child that was not told this treats the steering as
 *    untrusted — correctly, which is why the fact has to arrive first.
 *  - measured 2026-08-16, a child read its own depth, concluded correctly that
 *    it had no peer channel, and posted its CI verdict where nobody was
 *    watching. Lineage is refused across hosts, so it sat at `d0` with no
 *    parent, and the supervised relay had already spent its single shot at
 *    `worker_done`.
 *
 * The card is the one channel measured to cross hosts every time. `DECISION:` is
 * not invented here: it is the grammar `progressOnly()` in ./stall.mjs
 * implements, where anything that is not the checkpoint extension's own
 * `N/M · phase · task` shape wakes the Run, and that prefix wakes it whatever
 * the shape.
 */
const REMOTE = [
  '- The session that dispatched you is on ANOTHER HOST. Its messages reach you as coming from an',
  '  UNIDENTIFIED local sender: nothing on your host can attribute them, and that absence is',
  '  structural, not suspicious. Treat an unattributed message about this ticket as that session\u2019s.',
  '- **You cannot message it back, and this is not a permission problem.** Lineage is refused',
  '  across hosts, so you are `d0` with no parent: no address resolves, and the supervised relay',
  '  fires ONCE at `worker_done` and never again for the work that follows it. Measured 2026-08-16:',
  '  a child read its own depth, concluded correctly that it had no peer channel, and posted its CI',
  '  verdict where nobody was watching.',
  '- **Your outbound channel is your BOARD CARD.** A watcher armed on your dispatch polls it from',
  '  that session\u2019s side and wakes it on any change that is not the checkpoint extension\u2019s own',
  '  `N/M \u00b7 phase \u00b7 task` shape:',
  '      orca worktree set --worktree path:<your worktree> --comment "DECISION: <one line>"',
  '  `DECISION:` always wakes it, whatever the card\u2019s shape. Use it for anything that needs an',
  '  answer, and for your final state. The ticket and the pull request are for the RECORD — durable,',
  '  read later, and read by nobody at the moment you write them.',
].join('\n');

/**
 * The composed marker line. A worker role and a model alias are two independent
 * obligations in the same order-independent bracket; neither may be inferred
 * from the other. The caller supplies the model as data, never a precomposed
 * marker, so one renderer owns the grammar.
 */
function markerLine(model, instruction) {
  const value = String(model ?? '').trim();
  return `[omp role=worker model=${value}] ${String(instruction ?? '').trim()}`.trim();
}

/**
 * The brief, as text. Pure: every host-, project- and tracker-specific value
 * arrives as an argument, which is what lets the whole composition be asserted
 * offline with no Orca, no git and no ticket.
 *
 * `host` is '' for a local child. `contract` is '' when the project declares
 * none, and MECHANICS takes its place. `operator` is `{ name, text }` or null.
 * `report` is what ./report.mjs answered for this dispatch — `{ path }` or
 * `{ reason }` — and a caller that passes neither gets the inability, because a
 * brief that silently drops the artifact is how the artifact went missing in the
 * first place.
 *
 * A project's contract and an operator's notes are placed VERBATIM — not
 * trimmed, not re-wrapped, not re-indented. They were written by someone who
 * meant them, and a renderer that tidies its inputs is a renderer that has to be
 * checked before anything is put through it. Nothing is appended to them either:
 * the document is terminated with a newline only when its last block does not
 * already end in one, so a caller's bytes survive in both directions.
 *
 * `landed` is the derived half of the notes channel (./landed.mjs), placed under
 * `LANDED_HEADING` and above the operator's words. `''` renders NOTHING, heading
 * included: a wave with no established landing has none to announce, and an empty
 * section under that heading would read as a read that found nothing.
 *
 * `ticket: null` says the dispatch HAS no ticket, which renders differently from a
 * ticket that could not be read.
 *
 * THE ADDRESS LINE IS `ticket.handle` WHEN THE TRACKER GIVES ONE, and the url
 * only when it does not. A child cannot act on `https://…/issues/61` — an https
 * link is not a read — so printing it beside a handle that IS one puts two
 * representations of the same ticket in front of the one reader who must pick the
 * right one. The clickable url is not lost: it stays on the dispatching session's
 * own receipt (`ticket <url> (<state>)` in ./verify.mjs), where a human reads it.
 * Linear answers no handle, so there the url is the only address there is.
 */
export function renderBrief({ model, instruction, ticket = {}, readCommand, run, host = '', contract = '', landed = '', operator = null, name = '', report = {} } = {}) {
  // `ticket: null` is not "a ticket I could not read" — it is a dispatch that has
  // none (`--name`). The two must not render the same: the tracked shape says
  // "read the ticket, it is canonical", and pointing that at nothing is how a
  // child is sent to improvise (2026-08-01, three worktrees that never read
  // theirs). So the couplet is replaced rather than emitted empty, and the
  // heading falls back to the name it was dispatched under.
  const tracked = ticket !== null;
  const head = tracked
    ? [`# ${ticket.title ?? ''}`, `${ticket.handle || ticket.url || ''}`, '', `Read the ticket before you plan: ${readCommand ?? ''}`, 'It is canonical; this file carries only the pilot contract.']
    : [`# ${name}`, '', 'This dispatch carries NO ticket: what follows is the whole definition of the work.'];

  const lines = [
    markerLine(model, instruction),
    ...head,
    '',
    `PILOT CONTRACT — dispatching Run ${run ?? ''}, execution host ${host || 'here'}`,
    // The precedence rule and the Report are ax's own, and they stay when a
    // project replaces the propositions: ax derives that path and ax's receiver
    // opens it, so a fleet contract that displaced this block would leave a
    // child writing a Report nothing reads.
    PRECEDENCE,
    '',
    reportContract(report),
    contract === '' || contract === undefined || contract === null ? (tracked ? MECHANICS : MECHANICS_UNTRACKED) : String(contract),
  ];

  if (host) lines.push(REMOTE);

  // The DERIVED half of the notes channel, above the verbatim half: a fact ax
  // read is not an instruction the operator wrote, and the operator keeps the
  // last word here (#195).
  if (String(landed ?? '') !== '') lines.push('', LANDED_HEADING, '', String(landed));

  if (operator) {
    lines.push('', `${OPERATOR_HEADING} (${operator.name})`, String(operator.text ?? ''));
  }

  const text = lines.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}
