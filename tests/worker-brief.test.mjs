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

const brief = (extra = {}) =>
  renderBrief({
    model: '@task',
    instruction: '/entry T-353',
    ticket: TICKET,
    readCommand: 'tracker MCP `get_issue`, then `list_comments` on the same issue',
    run: 'run_abc',
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
  // never covered ROLES, and the omission cost the sentence `coordinator` in
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

test('a launch with NO ticket never tells the child to read one', () => {
  // `--name` dispatches work no tracker owns. The tracked shape says "read the
  // ticket, it is canonical" — rendered against nothing, that is the 2026-08-01
  // failure written into the brief itself: a child sent to improvise by a
  // pointer to nowhere. An empty `# ` heading and an empty read command are the
  // same defect, quieter.
  const text = brief({ ticket: null, name: 'loading-states', instruction: 'fix the skeletons', readCommand: '' });
  assert.doesNotMatch(text, /Read the ticket/);
  assert.doesNotMatch(text, /It is canonical/);
  assert.doesNotMatch(text, /^# $/m);
  // The name the coordinator dispatched is the heading, because it is the only
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

test('a ticketless launch still gets the mechanics, and a project contract still replaces them', () => {
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
  // `ax worker launch` REFUSES to dispatch into a tree without this file — "the
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
  // wakes the coordinator and nothing does.
  const remote = brief({ host: 'other-host' });
  assert.ok(remote.includes('DECISION:'));
  assert.equal(progressOnly('DECISION: the migration needs a call'), false);
  // And the shape the brief names as the one that does NOT wake anybody.
  assert.ok(remote.includes('`N/M · phase · task` shape'));
  assert.equal(progressOnly('3/7 · implement · loading states'), true);
});

test('the operator brief is last, verbatim, under a heading naming its file', () => {
  // An operator's words are never paraphrased by ax, and never allowed to
  // displace the contract above them.
  const text = brief({ operator: { name: 'brief.md', text: 'Do not touch the billing module.\n' } });
  assert.ok(text.includes('OPERATOR BRIEF (brief.md)'));
  assert.ok(text.includes('Do not touch the billing module.'));
  assert.ok(text.indexOf('OPERATOR BRIEF') > text.indexOf('PILOT CONTRACT'));
  assert.ok(!brief().includes('OPERATOR BRIEF'));
});

test('the operator brief follows the remote addendum, not the other way round', () => {
  // Order is load-bearing: the mechanics a child cannot derive come before the
  // instructions it is asked to apply.
  const text = brief({ host: 'other-host', operator: { name: 'brief.md', text: 'Ping me when CI is decided.' } });
  assert.ok(text.indexOf('OPERATOR BRIEF') > text.indexOf('BOARD CARD'));
});
