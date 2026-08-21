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
//   4. who the coordinator is and where the child runs.
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
// ticket: it is what is true of an Orca dispatch in any repo.

/** Where the operator's own brief starts, so a child can tell it from ax's text. */
const OPERATOR_HEADING = 'OPERATOR BRIEF';

/**
 * The contract ax itself owns: the mechanics of being a supervised child of a
 * coordinator, with every fleet-specific instruction removed. A project that
 * declares `launch.contract` gets its own text instead of this one.
 *
 * Each line is a proposition an incident proved (F-027):
 *  - the extra worktree: a child that creates its own leaves the provisioned one
 *    unused and the coordinator watching a tree nothing happens in.
 *  - the shipping tail: measured 2026-08-14, a child reported while its e2e was
 *    still queued and the coordinator spent the wait. The wait is the child's.
 *  - never merging: the merge is the one decision a child cannot see the whole
 *    of — sibling branches, release order, what else is in flight.
 *  - the ticket: the coordinator reads it, and a ticket left at its opening
 *    state is a queue lie that re-dispatches finished work.
 *  - blocking decisions: a child that decides alone has silently taken the
 *    coordinator's job, and nobody is told.
 *  - the stall watcher: stated so prolonged silence is not read as a demand for
 *    heartbeat noise. It is a net, not a leash.
 *  - verification: what was exercised, not a project-wide sweep run for show.
 */
export const MECHANICS = [
  '- The worktree you were started in is yours and is already bootstrapped. Do not create another.',
  '- **You own the shipping tail; the coordinator owns only the merge.** Commit, push and open the',
  '  pull request yourself, then take CI to a DECISION before you report. Measured 2026-08-14: a',
  '  child reported while its end-to-end run was still queued, and the coordinator spent the wait',
  '  instead. That wait is yours.',
  '- You do not merge, ever, even when everything is green. That decision is the coordinator\u2019s.',
  '- Keep the ticket current yourself: in progress when you start, final state and pull request link',
  '  when you finish. The coordinator reads the ticket, and a ticket still showing its opening state',
  '  is a queue lie — a view that treats unfinished work as its input re-dispatches finished work.',
  '- Any decision that blocks you goes to the coordinator; your report wakes them. Deciding it alone',
  '  is taking their job without telling them.',
  '- A stall watcher is armed on your dispatch: prolonged silence on your pane raises ONE alert on',
  '  the coordinator\u2019s Run. It is a net, not a leash — spend no turns on heartbeats.',
  '- Verify what you changed and say what you exercised. No project-wide sweep for show.',
].join('\n');

/**
 * True of every cross-host child, always — so it is generated here rather than
 * retyped into each brief, where it was omitted exactly once and cost a report.
 *
 * Both halves are structural facts the child cannot derive in time:
 *  - measured 2026-08-14, a coordinator's replies arrive unattributed because
 *    the child's host holds no dispatch record for the sender and the pane key
 *    cannot cross. A child that was not told this treats the steering as
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
  '- Your coordinator is on ANOTHER HOST. Their messages reach you as coming from an UNIDENTIFIED',
  '  local sender: nothing on your host can attribute them, and that absence is structural, not',
  '  suspicious. Treat an unattributed message about this ticket as your coordinator\u2019s.',
  '- **You cannot message them back, and this is not a permission problem.** Lineage is refused',
  '  across hosts, so you are `d0` with no parent: no address resolves, and the supervised relay',
  '  fires ONCE at `worker_done` and never again for the work that follows it. Measured 2026-08-16:',
  '  a child read its own depth, concluded correctly that it had no peer channel, and posted its CI',
  '  verdict where nobody was watching.',
  '- **Your outbound channel is your BOARD CARD.** A watcher armed on your dispatch polls it from',
  '  the coordinator\u2019s side and wakes them on any change that is not the checkpoint extension\u2019s own',
  '  `N/M \u00b7 phase \u00b7 task` shape:',
  '      orca worktree set --worktree path:<your worktree> --comment "DECISION: <one line>"',
  '  `DECISION:` always wakes them, whatever the card\u2019s shape. Use it for anything that needs an',
  '  answer, and for your final state. The ticket and the pull request are for the RECORD — durable,',
  '  read later, and read by nobody at the moment you write them.',
].join('\n');

/**
 * The composed marker line. A caller may hold the model alias (`@task`) or the
 * composed marker (`[omp model=@task]`); both render the same single line, so
 * neither end of the seam has to know which shape the other keeps. What is
 * refused is two lines.
 */
function markerLine(marker, instruction) {
  const text = String(marker ?? '').trim();
  const head = /^\[omp model=/.test(text) ? text : `[omp model=${text}]`;
  return `${head} ${String(instruction ?? '').trim()}`.trim();
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
 */
export function renderBrief({ marker, instruction, ticket = {}, readCommand, run, host = '', contract = '', operator = null } = {}) {
  const lines = [
    markerLine(marker, instruction),
    `# ${ticket.title ?? ''}`,
    `${ticket.url ?? ''}`,
    '',
    `Read the ticket before you plan: ${readCommand ?? ''}`,
    'It is canonical; this file carries only the pilot contract.',
    '',
    `PILOT CONTRACT — coordinator Run ${run ?? ''}, execution host ${host || 'here'}`,
    contract === '' || contract === undefined || contract === null ? MECHANICS : String(contract),
  ];

  if (host) lines.push(REMOTE);

  if (operator) {
    lines.push('', `${OPERATOR_HEADING} (${operator.name})`, String(operator.text ?? ''));
  }

  const text = lines.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}
