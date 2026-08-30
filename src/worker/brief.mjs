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
//   5. the contract. The project's, when it declares one; MECHANICS when it does
//      not.
//   6. the remote addendum, when the child runs on another host.
//   7. the operator's own brief, verbatim and last, under a heading naming the
//      file it came from — an operator's words are never paraphrased by ax and
//      never allowed to displace the contract above them.
//
// ax OWNS 5 AND 6 ONLY AS MECHANICS. Anything that is one fleet's doctrine —
// which entry command, which review skill, which tracker convention — arrives
// through `contract`. MECHANICS therefore names no skill, no repository and no
// ticket. It names no ROLE either: `orchestrator` is one role that dispatches an
// implementation child, `omp/roles/worker.md` names it because a role file may,
// and a fleet whose parent is something else still gets a true contract here. It
// is what is true of an Orca dispatch in any repo.

/** Where the operator's own brief starts, so a child can tell it from ax's text. */
const OPERATOR_HEADING = 'OPERATOR BRIEF';

/**
 * The contract ax itself owns: the mechanics of being a supervised child of the
 * session that dispatched it, with every fleet-specific instruction removed. A
 * project that declares `launch.contract` gets its own text instead of this one.
 *
 * Each line is a proposition an incident proved (F-027):
 *  - the extra worktree: a child that creates its own leaves the provisioned one
 *    unused and its dispatcher watching a tree nothing happens in. The same
 *    bullet names `.agent/worktree-context.local.md`, because a tree that is
 *    already prepared is only useful to a child that knows how it was prepared:
 *    `ax worker launch` REFUSES to dispatch into a tree without that file — "the
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
 * The mechanics for a launch with NO ticket (`--name`, no tracker ref).
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
 *
 * A project's contract and an operator's brief are placed VERBATIM — not
 * trimmed, not re-wrapped, not re-indented. They were written by someone who
 * meant them, and a renderer that tidies its inputs is a renderer that has to be
 * checked before anything is put through it. Nothing is appended to them either:
 * the document is terminated with a newline only when its last block does not
 * already end in one, so a caller's bytes survive in both directions.
 *
 * `ticket: null` says the launch HAS no ticket, which renders differently from a
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
export function renderBrief({ model, instruction, ticket = {}, readCommand, run, host = '', contract = '', operator = null, name = '' } = {}) {
  // `ticket: null` is not "a ticket I could not read" — it is a launch that has
  // none (`--name`). The two must not render the same: the tracked shape says
  // "read the ticket, it is canonical", and pointing that at nothing is how a
  // child is sent to improvise (2026-08-01, three worktrees that never read
  // theirs). So the couplet is replaced rather than emitted empty, and the
  // heading falls back to the name it was dispatched under.
  const tracked = ticket !== null;
  const head = tracked
    ? [`# ${ticket.title ?? ''}`, `${ticket.handle || ticket.url || ''}`, '', `Read the ticket before you plan: ${readCommand ?? ''}`, 'It is canonical; this file carries only the pilot contract.']
    : [`# ${name}`, '', 'This launch carries NO ticket: what follows is the whole definition of the work.'];

  const lines = [
    markerLine(model, instruction),
    ...head,
    '',
    `PILOT CONTRACT — dispatching Run ${run ?? ''}, execution host ${host || 'here'}`,
    contract === '' || contract === undefined || contract === null ? (tracked ? MECHANICS : MECHANICS_UNTRACKED) : String(contract),
  ];

  if (host) lines.push(REMOTE);

  if (operator) {
    lines.push('', `${OPERATOR_HEADING} (${operator.name})`, String(operator.text ?? ''));
  }

  const text = lines.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}
