// The brief a dispatched child reads before it touches anything.
//
// Every proposition here is one an incident proved (F-027). The composition is a
// pure function of its arguments, so the whole file runs offline: no Orca, no
// git, no ticket, no host.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MECHANICS, MECHANICS_UNTRACKED, renderBrief } from '../src/worker/brief.mjs';
import { progressOnly } from '../src/worker/stall.mjs';

const TICKET = { id: 'T-353', title: 'Loading states are missing on the dashboard', url: 'https://tracker.test/issue/T-353' };

/** What the rule of the dispatch record answers for this dispatch (src/worker/report.mjs). */
const REPORT = '/Users/x/workspaces/353-work/.scratch/report/t-353-loading-states.md';

const brief = (extra = {}) =>
  renderBrief({
    model: '@task',
    instruction: '/entry T-353',
    ticket: TICKET,
    readCommand: 'tracker MCP `get_issue`, then `list_comments` on the same issue',
    run: 'run_abc',
    report: { path: REPORT },
    ...extra,
  });

test('the worker role, model marker and instruction are on ONE first line', () => {
  // The role and model share one order-independent marker. Keeping the instruction
  // on that line preserves the field-proven shape that the child adapter reads
  // before its first provider turn.
  const first = brief().split('\n')[0];
  assert.equal(first, '[omp role=worker model=@task] /entry T-353');
});

test('the contract ax owns names no session role, so it stays true of any parent', () => {
  // The header's own rule — MECHANICS names no skill, no repository, no ticket —
  // never covered ROLES, and the omission cost the retired role name in
  // child-facing text for the two releases after that role was deleted (0.15.0).
  // The repair was not the newer name: `orchestrator` is one role that dispatches
  // an implementation child, `omp/roles/worker.md` names it because a role file
  // may, and this text has to stay true for a parent that is something else.
  //
  // `parent` alone was tried and is wrong here: it is a LINEAGE word, and the
  // remote addendum's whole job is to say the cross-host child has none (`d0`).
  // Naming the dispatching session says who dispatched without claiming lineage,
  // which is why both assertions below live in one test.
  for (const [name, text] of [['MECHANICS', MECHANICS], ['MECHANICS_UNTRACKED', MECHANICS_UNTRACKED]]) {
    const named = text.split('\n').filter(line => /coordinator|orchestrator|readiness|maintainer|triage-worker/i.test(line));
    assert.deepEqual(named, [], `${name} names a session role`);
  }

  const remote = brief({ host: 'gapicore' });
  assert.match(remote, /you are `d0` with no parent/);
  assert.doesNotMatch(remote, /[Yy]our parent/);
});

test('the address line is the handle the child ACTS on, not a link it cannot read', () => {
  // A `https://…/issues/61` line is a second representation of the ticket, and it
  // is the one the child must NOT use: an https URL is not a read. When the
  // tracker answers with a handle the harness resolves, that handle is the line.
  // The clickable url stays on the dispatching session's own receipt, where a human reads it.
  const text = brief({ ticket: { ...TICKET, handle: 'issue://61' } });
  assert.match(text, /^issue:\/\/61$/m);
  assert.doesNotMatch(text, /https:\/\/tracker\.test/);

  // No handle — a Linear ticket — keeps the url, which is then the only address there is.
  assert.match(brief(), /^https:\/\/tracker\.test\/issue\/T-353$/m);
});

test('a dispatch with NO ticket never tells the child to read one', () => {
  // `--name` dispatches work no tracker owns. The tracked shape says "read the
  // ticket, it is canonical" — rendered against nothing, that is the 2026-08-01
  // failure written into the brief itself: a child sent to improvise by a
  // pointer to nowhere. An empty `# ` heading and an empty read command are the
  // same defect, quieter.
  const text = brief({ ticket: null, name: 'loading-states', instruction: 'fix the skeletons', readCommand: '' });
  assert.doesNotMatch(text, /Read the ticket/);
  assert.doesNotMatch(text, /It is canonical/);
  assert.doesNotMatch(text, /^# $/m);
  // The name the orchestrator dispatched is the heading, because it is the only
  // handle they will later search for.
  assert.match(text, /^# loading-states$/m);
  assert.match(text, /carries NO ticket/);
});

test('a ticketless brief drops the keep-the-ticket-current bullet, and only that one', () => {
  // The bullet is not merely irrelevant: it states the dispatching session READS
  // the ticket, so a child with none either invents one or concludes its report
  // lands somewhere it does not. Every other mechanic still applies.
  assert.match(MECHANICS, /Keep the ticket current yourself/);
  assert.doesNotMatch(MECHANICS_UNTRACKED, /Keep the ticket current/);
  assert.match(MECHANICS_UNTRACKED, /There is NO ticket for this work/);
  // And it says what to do INSTEAD, which is the half a bare deletion loses: the
  // child must not open a ticket to fill the gap either.
  assert.match(MECHANICS_UNTRACKED, /do not open\s+one/);
  assert.match(MECHANICS_UNTRACKED, /named this work, and that name is what it looks for/);

  const bullets = text => text.split('\n').filter(line => line.startsWith('- ')).length;
  assert.equal(bullets(MECHANICS_UNTRACKED), bullets(MECHANICS));
  for (const kept of ['already bootstrapped', 'You do not merge, ever', 'A stall watcher is armed', 'No project-wide sweep']) {
    assert.match(MECHANICS_UNTRACKED, new RegExp(kept));
  }
});

test('a ticketless dispatch still gets the mechanics, and a project contract still replaces them', () => {
  const text = brief({ ticket: null, name: 'loading-states' });
  assert.match(text, /There is NO ticket for this work/);
  const owned = brief({ ticket: null, name: 'loading-states', contract: 'OUR RULES' });
  assert.match(owned, /OUR RULES/);
  assert.doesNotMatch(owned, /There is NO ticket for this work/);
});

test('the caller supplies a model alias, never a hand-composed marker', () => {
  const first = brief({ model: '@default' }).split('\n')[0];
  assert.equal(first, '[omp role=worker model=@default] /entry T-353');
});

test('the taught read command and the ticket URL are both in the brief', () => {
  // Measured on three dispatches: a child obeying a truncating read command
  // never saw the thread where half the decisions lived, while its own command
  // exited 0. WHICH read shows a thread is the caller's knowledge, so the brief
  // must carry the caller's command verbatim rather than a command of its own.
  const text = brief();
  assert.match(text, /Read the ticket before you plan: tracker MCP `get_issue`, then `list_comments` on the same issue/);
  assert.ok(text.includes(TICKET.url));
  assert.ok(text.includes(`# ${TICKET.title}`));
  // The title is an H1 under the instruction line, where it cannot be read as one.
  const lines = text.split('\n');
  assert.equal(lines[1], `# ${TICKET.title}`);
  assert.equal(lines[2], TICKET.url);
});

test('the contract header names the dispatching Run and the execution host', () => {
  assert.match(brief(), /PILOT CONTRACT — dispatching Run run_abc, execution host here/);
  assert.match(brief({ host: 'other-host' }), /PILOT CONTRACT — dispatching Run run_abc, execution host other-host/);
});

// ── the Report, and the one precedence rule that lets it override the preamble ─
//
// Two contracts govern a worker's completion, and until `docs/adr/0002` they
// competed: Orca's injected preamble rules the lifecycle message (three
// sentences in `--body`, long-form in `--report-path`), while ax's playbook
// ruled that "every report opens on `## CRITERIA`" and named no artifact.
// Measured on the 2026-09-03 wave: of eight workers, none delivered that
// section in the channel their dispatcher reads, and no send used
// `--report-path`. Every one of them obeyed the preamble. So the brief — the
// LAST text the child reads — states the precedence once and then names the
// artifact.

test('the mechanics section opens on the precedence rule, and nothing else overrides the preamble', () => {
  const lines = brief().split('\n');
  const header = lines.findIndex(line => line.startsWith('PILOT CONTRACT'));
  assert.notEqual(header, -1);
  assert.equal(lines[header + 1], 'The preamble above speaks for the runtime; where this brief says otherwise, this brief wins.');

  // ONCE. A rule restated per point is how the eight-worker wave came to have
  // two contracts and obey the older one; the ADR's whole repair is that this
  // sentence REPLACES point-by-point overrides, so a second mention of the
  // preamble anywhere in ax's own text is the defect returning.
  assert.equal(brief().split(/preamble/i).length - 1, 1);
});

test('the brief carries the Report path it was GIVEN, and derives none of its own', () => {
  const text = brief();
  assert.ok(text.includes(REPORT), 'the derived path is what the child is told');

  // The rule lives in one module (src/worker/report.mjs). A renderer that knew
  // `.scratch/report/<request>.md` would be a second copy of it, and two copies
  // disagree the day one moves — which is the same failure `draftPath` exists to
  // prevent. So the path arrives as data and nothing here reconstructs it.
  const elsewhere = brief({ report: { path: '/tmp/elsewhere/anything.md' } });
  assert.ok(elsewhere.includes('/tmp/elsewhere/anything.md'));
  assert.ok(!elsewhere.includes('.scratch'), 'the brief must not know how the path is built');
});

test('the brief states the Report shape, and that a failed outcome writes one too', () => {
  const text = brief();
  assert.match(text, /`## CRITERIA`/);
  assert.match(text, /`NOT MET: <what you observed instead>`/);
  assert.match(text, /`## LEARNINGS`/);
  assert.match(text, /--outcome failed/, 'the outcome that needs the Report most is the one a worker skips');
});

test('the brief says what the completion carries, where a question goes, and what a late refusal is', () => {
  const text = brief();
  // The two contracts nest instead of competing: the preamble's body stays the
  // Summary, the Report travels by reference.
  assert.match(text, /Summary in `--body`/);
  assert.match(text, /Report in `--report-path`/);
  // The preamble offers `orca orchestration ask`; nothing on the dispatching
  // session's side waits on it, so a question sent there is a question nobody
  // answers.
  assert.match(text, /never through `orca orchestration ask`/);
  // And the repair round the runtime cannot express: one settled Task, one
  // living Report file (`96-work` sent six completions for one slice).
  assert.match(text, /rewrite the Report in place/);
  assert.match(text, /board card/);
  assert.match(text, /[Nn]ever a second `worker_done`/);
});

test('a dispatch that cannot name the Report path says so, and guesses none', () => {
  // A child placed on another host has no path this host can derive, and the
  // absence must arrive as an absence: a guessed path sends the Report where the
  // receiver does not look, and an empty one reads as "here" (F-028).
  const named = brief({ report: { reason: 'the record names no worktree, so the Report path cannot be established' } });
  assert.match(named, /cannot be established/);
  assert.ok(!named.includes('.scratch'));
  // Same for a caller that passed nothing at all: silence is not a pass.
  const missing = brief({ report: undefined });
  assert.match(missing, /Report/);
  assert.match(missing, /cannot be established/);
});

test("the Report contract survives a project's own contract, because ax is what reads it", () => {
  // `contract` replaces ax's PROPOSITIONS — one fleet's doctrine on how it ships.
  // The Report is not doctrine: ax derives its path from the dispatch record and
  // ax's receiver opens that path and no other. A fleet that declared a contract
  // and lost this block would have children writing Reports nothing reads.
  const text = brief({ contract: '- Ship it the way this repo ships things.\n' });
  assert.ok(text.includes(REPORT));
  assert.match(text, /this brief wins/);
  assert.ok(!text.includes('You do not merge'), 'the propositions are still replaced, and never both');
});

test("a project's own contract replaces MECHANICS, and never both", () => {
  // Declared and appended-alongside was the first shape, and it sent children a
  // contract that contradicted itself on who merges.
  const text = brief({ contract: '- Ship it the way this repo ships things.\n' });
  assert.ok(text.includes('- Ship it the way this repo ships things.'));
  assert.ok(!text.includes('You do not merge'));
  // And with no contract declared, ax's own mechanics are there.
  assert.ok(brief().includes('You do not merge'));
});

test("a project's contract and an operator's brief are placed VERBATIM", () => {
  // Both were written by someone who meant them, and both were being trimmed
  // here before this test existed. A renderer that tidies its inputs is one that
  // has to be audited before anything is put through it — and the tidying is
  // invisible in the output, so nothing downstream ever reports it.
  //
  // Both directions are asserted, because both are ways of not being verbatim:
  // trimming a caller's trailing blank line, and appending a newline the caller
  // did not write.
  const contract = '  - indented on purpose\n\nand a blank line inside it\n\n';
  const operatorText = '\tDo not touch the billing module.\n\n';
  const text = brief({ contract, operator: { name: 'brief.md', text: operatorText } });
  assert.ok(text.includes(contract), 'the contract was altered on its way in');
  assert.ok(text.endsWith(operatorText), 'the operator brief was altered on its way in');

  // The one thing the renderer does own: the document ends in a newline, added
  // only when the last block did not already supply one.
  const bare = brief({ operator: { name: 'brief.md', text: 'no trailing newline here' } });
  assert.ok(bare.endsWith('no trailing newline here\n'));
  assert.ok(!bare.endsWith('here\n\n'));
  assert.ok(brief().endsWith('for show.\n'));
});

test('MECHANICS names no skill, no repository and no ticket', () => {
  // It is the contract ax OWNS, so it has to be true of an Orca dispatch in any
  // repo. Every fleet-specific instruction — which entry command, which review
  // skill, which tracker convention — arrives through `contract`.
  for (const forbidden of [/\bce-[a-z]/, /lfg/i, /gapila/i, /ofmchat/i, /gapicore/i, /\bGAP-\d+/, /#\d{3,}/]) {
    assert.ok(!forbidden.test(MECHANICS), `MECHANICS must not carry ${forbidden}`);
  }
  // The propositions are a CLOSED SET: only what this port was asked to carry.
  // A rule ax cannot back — how to delegate a CI wait, which agent answers review
  // bots — is one fleet's doctrine and belongs in `contract`. It arrived here once
  // by being ported along with the sentence next to it.
  assert.ok(!/[Dd]elegate/.test(MECHANICS));
  assert.ok(!/CI logs/.test(MECHANICS));
  const propositions = [
    'Do not create another',
    'You own the shipping tail',
    'You do not merge',
    'Keep the ticket current',
    'blocks you goes to the session that dispatched you',
    'net, not a leash',
    'say what you exercised',
  ];
  for (const proposition of propositions) {
    assert.ok(MECHANICS.includes(proposition), `MECHANICS lost: ${proposition}`);
  }
  // One bullet per proposition, and no eighth bullet nobody asked for.
  assert.equal(MECHANICS.split('\n').filter(line => line.startsWith('- ')).length, propositions.length);
  // The worktree describes itself, and until 2026-08-26 nothing told the child so.
  // `ax worker dispatch` REFUSES to place a child in a tree without this file — "the
  // child would have no URL to test against" — and then never named it, so the
  // one artifact written to answer "which port, which database, which branch"
  // was read by the dispatching session and not by its reader. It rides bullet 1: same
  // proposition, the tree you were given is prepared and it says how.
  assert.match(MECHANICS, /\.agent\/worktree-context\.local\.md/);
});

test('the remote addendum appears only when the child runs on another host', () => {
  // Measured 2026-08-16: a child read its own depth, concluded correctly that it
  // had no peer channel, and posted its CI verdict where nobody was watching.
  // The facts are structural and it cannot derive them in time, so they arrive
  // before the first unattributed message does.
  const local = brief();
  assert.ok(!local.includes('ANOTHER HOST'));
  assert.ok(!local.includes('You cannot message it back'));

  const remote = brief({ host: 'other-host' });
  assert.ok(remote.includes('UNIDENTIFIED'));
  assert.ok(remote.includes('You cannot message it back'));
  // The channel that DOES cross, as a runnable command with a placeholder the
  // child fills — never a path guessed here.
  assert.ok(remote.includes('orca worktree set --worktree path:<your worktree> --comment "DECISION: <one line>"'));
});

test("the remote addendum's DECISION grammar is the one progressOnly() implements", () => {
  // The brief teaches a sentinel the watcher must honour. Two copies of one
  // grammar drift, and the drift is silent: the child writes a card it believes
  // wakes the orchestrator and nothing does.
  const remote = brief({ host: 'other-host' });
  assert.ok(remote.includes('DECISION:'));
  assert.equal(progressOnly('DECISION: the migration needs a call'), false);
  // And the shape the brief names as the one that does NOT wake anybody.
  assert.ok(remote.includes('`N/M · phase · task` shape'));
  assert.equal(progressOnly('3/7 · implement · loading states'), true);
});

test('the operator notes are last, verbatim, under a heading naming their file', () => {
  // An operator's words are never paraphrased by ax, and never allowed to
  // displace the contract above them. NOTES, not BRIEF: the flag that carries
  // this file is `--notes`, and `Brief` names the Agent Brief comment alone —
  // one word for two artifacts is how a child reads wave memory as its
  // assignment.
  const text = brief({ operator: { name: 'wave-39-memory.md', text: 'Do not touch the billing module.\n' } });
  assert.ok(text.includes('OPERATOR NOTES (wave-39-memory.md)'));
  assert.ok(text.includes('Do not touch the billing module.'));
  assert.ok(text.indexOf('OPERATOR NOTES') > text.indexOf('PILOT CONTRACT'));
  assert.ok(!brief().includes('OPERATOR NOTES'));
  assert.ok(!text.includes('OPERATOR BRIEF'), 'the retired heading is gone, not aliased');
});

test('the operator notes follow the remote addendum, not the other way round', () => {
  // Order is load-bearing: the mechanics a child cannot derive come before the
  // instructions it is asked to apply.
  const text = brief({ host: 'other-host', operator: { name: 'notes.md', text: 'Ping me when CI is decided.' } });
  assert.ok(text.indexOf('OPERATOR NOTES') > text.indexOf('BOARD CARD'));
});
