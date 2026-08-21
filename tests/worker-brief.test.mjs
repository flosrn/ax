// The brief a dispatched child reads before it touches anything.
//
// Every proposition here is one an incident proved (F-027). The composition is a
// pure function of its arguments, so the whole file runs offline: no Orca, no
// git, no ticket, no host.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MECHANICS, renderBrief } from '../src/worker/brief.mjs';
import { progressOnly } from '../src/worker/stall.mjs';

const TICKET = { id: 'T-353', title: 'Loading states are missing on the dashboard', url: 'https://tracker.test/issue/T-353' };

const brief = (extra = {}) =>
  renderBrief({
    marker: '@task',
    instruction: '/entry T-353',
    ticket: TICKET,
    readCommand: 'tracker MCP `get_issue`, then `list_comments` on the same issue',
    run: 'run_abc',
    ...extra,
  });

test('the marker and the instruction are on ONE line, and it is the first', () => {
  // Field-proven shape: marker and instruction together is what applied
  // `role: default` on five measured dispatches. A marker alone on its own line
  // is untested, so it is never assumed.
  const first = brief().split('\n')[0];
  assert.equal(first, '[omp model=@task] /entry T-353');
});

test('a caller holding the composed marker gets the same single line', () => {
  // The seam carries either the alias or the marker, and neither end has to know
  // which the other keeps. What is refused is two lines.
  const first = brief({ marker: '[omp model=@default]' }).split('\n')[0];
  assert.equal(first, '[omp model=@default] /entry T-353');
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

test('the contract header names the coordinator Run and the execution host', () => {
  assert.match(brief(), /PILOT CONTRACT — coordinator Run run_abc, execution host here/);
  assert.match(brief({ host: 'other-host' }), /PILOT CONTRACT — coordinator Run run_abc, execution host other-host/);
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
    'blocks you goes to the coordinator',
    'net, not a leash',
    'say what you exercised',
  ];
  for (const proposition of propositions) {
    assert.ok(MECHANICS.includes(proposition), `MECHANICS lost: ${proposition}`);
  }
  // One bullet per proposition, and no eighth bullet nobody asked for.
  assert.equal(MECHANICS.split('\n').filter(line => line.startsWith('- ')).length, propositions.length);
});

test('the remote addendum appears only when the child runs on another host', () => {
  // Measured 2026-08-16: a child read its own depth, concluded correctly that it
  // had no peer channel, and posted its CI verdict where nobody was watching.
  // The facts are structural and it cannot derive them in time, so they arrive
  // before the first unattributed message does.
  const local = brief();
  assert.ok(!local.includes('ANOTHER HOST'));
  assert.ok(!local.includes('You cannot message them back'));

  const remote = brief({ host: 'other-host' });
  assert.ok(remote.includes('UNIDENTIFIED'));
  assert.ok(remote.includes('You cannot message them back'));
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
