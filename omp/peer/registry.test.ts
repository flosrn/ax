/**
 * Registry ownership: a second process sharing ORCA_TERMINAL_HANDLE must not
 * overwrite the entry of a live owner. Under last-writer-wins the newcomer
 * republishes its own model over the live owner's, and every peer that session
 * speaks to is then told the wrong model.
 *
 * These drive the module directly, so a refusal arrives as a returned
 * discriminant: "another live session owns this" and "the arguments were
 * incomplete" are distinguishable here, and the extension branches on exactly
 * that difference.
 *
 * No Orca binary is required: `register` only consults Orca to derive the
 * display NAME, and a name it cannot derive is explicitly not a failed
 * registration — conflating the two is the defect `published` separates.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { register, setModel } from './address.ts';
import { artifactNote, REPORT_SHAPE } from './report.ts';
import { runAddressOfHandle } from './store.ts';

const HANDLE = 'term_victim';
/** Unassignable on every supported host, so `kill -0` always reports it dead. */
const DEAD_PID = 2147483646;

let dir = '';
let registry = '';
let savedRegistryDir: string | undefined;
let savedHandle: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'peer-reg-'));
  registry = join(dir, 'peers');
  // The module reads both of these per call, never caching them, which is what
  // makes a temp registry possible at all.
  savedRegistryDir = process.env.ORCA_PEER_REGISTRY_DIR;
  savedHandle = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_PEER_REGISTRY_DIR = registry;
  process.env.ORCA_TERMINAL_HANDLE = HANDLE;
});

afterEach(async () => {
  if (savedRegistryDir === undefined) delete process.env.ORCA_PEER_REGISTRY_DIR;
  else process.env.ORCA_PEER_REGISTRY_DIR = savedRegistryDir;
  if (savedHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
  else process.env.ORCA_TERMINAL_HANDLE = savedHandle;
  await rm(dir, { recursive: true, force: true });
});

async function entry() {
  return JSON.parse(await readFile(join(registry, `${HANDLE}.json`), 'utf8'));
}

async function seed(overrides: Record<string, unknown>) {
  await mkdir(registry, { recursive: true });
  await writeFile(
    join(registry, `${HANDLE}.json`),
    JSON.stringify({
      handle: HANDLE,
      run: 'run_old',
      model: 'claude-opus-5',
      sessionId: 'sess_dead',
      ownerPid: DEAD_PID,
      modelSource: 'fallback',
      startedAt: '2026-08-06T06:00:00Z',
      ...overrides,
    }),
  );
}

describe('register ownership', () => {
  test('first writer publishes run, session, model and owner pid', async () => {
    const r = register({
      run: 'run_a',
      sessionId: 'sess_a',
      model: 'grok-4.5',
      modelSource: 'transcript',
    });
    expect(r.published).toBe(true);
    expect(r.refused).toBeUndefined();

    const written = await entry();
    expect(written.run).toBe('run_a');
    expect(written.sessionId).toBe('sess_a');
    expect(written.model).toBe('grok-4.5');
    expect(written.modelSource).toBe('transcript');
    // Defaulted from the calling process, which is the OMP session that owns
    // the entry — the liveness probe every later writer is fenced against.
    expect(written.ownerPid).toBe(process.pid);
  });

  test('a live registration lock refuses a competing writer before either can publish', async () => {
    await mkdir(registry, { recursive: true });
    await writeFile(
      join(registry, `.${HANDLE}.register.lock`),
      `${JSON.stringify({ ownerPid: process.pid, token: 'live-owner' })}\n`,
    );

    const result = register({ run: 'run_race', sessionId: 'sess_race' });
    expect(result).toEqual({ published: false, peer: '', refused: 'foreign' });
    expect(existsSync(join(registry, `${HANDLE}.json`))).toBe(false);
  });

  test('a registration lock is reclaimed only when its recorded owner is dead', async () => {
    await mkdir(registry, { recursive: true });
    const lock = join(registry, `.${HANDLE}.register.lock`);
    await writeFile(lock, `${JSON.stringify({ ownerPid: DEAD_PID, token: 'dead-owner' })}\n`);

    const result = register({ run: 'run_reclaimed', sessionId: 'sess_reclaimed' });
    expect(result.published).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect((await entry()).sessionId).toBe('sess_reclaimed');
  });

  test('a handle shaped like a path is invalid before filesystem access', () => {
    process.env.ORCA_TERMINAL_HANDLE = '../foreign';
    const result = register({ run: 'run_a', sessionId: 'sess_a' });
    expect(result).toEqual({ published: false, peer: '', refused: 'invalid' });
    expect(existsSync(join(dir, 'foreign.json'))).toBe(false);
  });

  test('refuses without a session id, and writes nothing', () => {
    const r = register({ run: 'run_a', sessionId: '', model: 'grok-4.5' });
    expect(r.published).toBe(false);
    expect(r.refused).toBe('invalid');
    // Fail CLOSED: an entry with no owner key is one any sibling process could
    // later claim without proving anything.
    expect(existsSync(join(registry, `${HANDLE}.json`))).toBe(false);
  });

  test('refuses without a run, and writes nothing', () => {
    const r = register({ run: '', sessionId: 'sess_a' });
    expect(r.published).toBe(false);
    expect(r.refused).toBe('invalid');
    expect(existsSync(join(registry, `${HANDLE}.json`))).toBe(false);
  });

  test('a live foreign owner blocks a second register on the same handle', async () => {
    // Owner = this test process, which is alive by construction.
    register({
      run: 'run_a',
      sessionId: 'sess_a',
      model: 'grok-4.5',
      modelSource: 'transcript',
    });

    const attack = register({
      run: 'run_evil',
      sessionId: 'sess_evil',
      model: 'claude-opus-5',
      modelSource: 'transcript',
      // The attacker's own pid is irrelevant; the fence is the RECORDED owner's
      // liveness compared against a differing session id.
      ownerPid: process.pid,
    });
    expect(attack.published).toBe(false);
    expect(attack.refused).toBe('foreign');

    const written = await entry();
    expect(written.model).toBe('grok-4.5');
    expect(written.sessionId).toBe('sess_a');
    expect(written.run).toBe('run_a');
  });

  test('a dead foreign owner is reclaimable', async () => {
    await seed({});
    const r = register({
      run: 'run_new',
      sessionId: 'sess_new',
      model: 'grok-4.5',
      modelSource: 'transcript',
    });
    expect(r.published).toBe(true);

    const written = await entry();
    expect(written.run).toBe('run_new');
    expect(written.sessionId).toBe('sess_new');
    expect(written.model).toBe('grok-4.5');
  });

  test('re-registering the same session is a refresh, not a foreign write', async () => {
    register({ run: 'run_a', sessionId: 'sess_a', model: 'grok-4.5' });
    const again = register({ run: 'run_b', sessionId: 'sess_a', model: 'grok-4.20' });
    expect(again.published).toBe(true);
    expect((await entry()).run).toBe('run_b');
  });

  test('an unparseable existing entry does not block the real owner', async () => {
    await mkdir(registry, { recursive: true });
    await writeFile(join(registry, `${HANDLE}.json`), '{ truncated');
    // A half-written file records no owner, so it must fail OPEN. Failing closed
    // here would strand a session behind a corrupt file it cannot delete.
    const r = register({ run: 'run_a', sessionId: 'sess_a', model: 'grok-4.5' });
    expect(r.published).toBe(true);
    expect((await entry()).sessionId).toBe('sess_a');
  });
});

describe('setModel ownership', () => {
  test('the owner can refresh the model, keeping the run', async () => {
    register({
      run: 'run_a',
      sessionId: 'sess_a',
      model: 'grok-4.5',
      modelSource: 'transcript',
    });
    const r = setModel({ model: 'grok-4.20', sessionId: 'sess_a' });
    expect(r.ok).toBe(true);

    const written = await entry();
    expect(written.model).toBe('grok-4.20');
    // The address must survive a model refresh: a dropped run silently
    // unreachable-s the session while it still appears in the peer list.
    expect(written.run).toBe('run_a');
    expect(written.sessionId).toBe('sess_a');
  });

  test('a foreign session cannot set the model', async () => {
    register({
      run: 'run_a',
      sessionId: 'sess_a',
      model: 'grok-4.5',
      modelSource: 'transcript',
    });
    const r = setModel({ model: 'claude-opus-5', sessionId: 'sess_evil' });
    expect(r.ok).toBe(false);
    expect(r.refused).toBe('foreign');
    expect((await entry()).model).toBe('grok-4.5');
  });

  test('a legacy entry carrying no session id may be claimed once', async () => {
    // Repair, not a steal: entries predating the ownership key have nobody to
    // defend, and refusing them would leave them permanently stale.
    await seed({ sessionId: '' });
    const r = setModel({ model: 'grok-4.5', sessionId: 'sess_new' });
    expect(r.ok).toBe(true);

    const written = await entry();
    expect(written.sessionId).toBe('sess_new');
    expect(written.model).toBe('grok-4.5');

    // Claimed means owned: the next foreign writer is now fenced out.
    expect(setModel({ model: 'evil', sessionId: 'sess_evil' }).refused).toBe('foreign');
  });

  test('refuses when no entry exists yet', () => {
    const r = setModel({ model: 'grok-4.5', sessionId: 'sess_a' });
    expect(r.ok).toBe(false);
    expect(r.refused).toBe('invalid');
    // set-model REFRESHES; it must never be a back door that publishes an
    // address, because it carries no run to publish.
    expect(existsSync(join(registry, `${HANDLE}.json`))).toBe(false);
  });

  test('refuses an empty model rather than erasing the published label', async () => {
    register({ run: 'run_a', sessionId: 'sess_a', model: 'grok-4.5' });
    const r = setModel({ model: '', sessionId: 'sess_a' });
    expect(r.ok).toBe(false);
    expect((await entry()).model).toBe('grok-4.5');
  });
});

/**
 * The report SHAPE is a contract with the orchestrator, so it is asserted
 * rather than left to prose. The regression it guards is a merge, not a typo:
 * folding `turn-ended` back into `done` because they look like the same event
 * from inside the child. They are not the same proposition, and the difference
 * is what an orchestrator acts on.
 *
 * Measured 2026-08-15: two of three dispatched children sent "finished its
 * work" within minutes of launch, zero commits each, one showing `0/10 · Plan`
 * on its board seconds later — the todo list appeared AFTER the report. The
 * signal was the no-todo-list first-turn boundary and it wore a completion's
 * words. Answering one of those interrupts a child that just started, and an
 * interruption can make it skip its very next tool call.
 */
describe('report shape', () => {
  test('done is the only state whose first line claims the work is finished', () => {
    expect(REPORT_SHAPE.done.head).toContain('finished its work');
    for (const state of ['blocked', 'interrupted', 'turn-ended'] as const) {
      expect(REPORT_SHAPE[state].head).not.toContain('finished its work');
    }
  });

  test('turn-ended denies being a completion, in its first line', () => {
    // The first line is the whole message for a reader who acts on it, so the
    // denial cannot live further down.
    expect(REPORT_SHAPE['turn-ended'].head).toContain('NOT a claim');
    expect(REPORT_SHAPE['turn-ended'].head).toContain('no todo list');
  });

  test('turn-ended informs rather than handing over', () => {
    // `handoff` invites the orchestrator to take the work over, which is the
    // expensive reflex for a child that is still reading its ticket. `done`
    // keeps the handoff because there the invitation is correct.
    expect(REPORT_SHAPE['turn-ended'].type).toBe('status');
    expect(REPORT_SHAPE.done.type).toBe('handoff');
    expect(REPORT_SHAPE.blocked.type).toBe('question');
  });

  test('turn-ended carries the instruction that replaces the wrong reflex', () => {
    // Naming the signal is not enough: an orchestrator needs the next action,
    // and it is to measure the artifact instead of answering.
    const tail = REPORT_SHAPE['turn-ended'].tail ?? '';
    expect(tail).toContain('prove the artifact');
    expect(tail).toContain('skip its very next tool call');
  });

  test('only turn-ended needs a tail, so the others stay one-liners', () => {
    expect(REPORT_SHAPE.done.tail).toBeUndefined();
    expect(REPORT_SHAPE.blocked.tail).toBeUndefined();
    expect(REPORT_SHAPE.interrupted.tail).toBeUndefined();
  });

  test('turn-ended does NOT move the board, and the other three do', () => {
    // The board's `in-review` means "no longer working, needs someone". That is
    // true of the three states that stopped and false of the one that usually
    // means "just started", so writing it for `turn-ended` fixes the report's
    // sentence and keeps the sidebar's lie. Measured 2026-08-15: GAP-370's card
    // read `in-review · 0/10 · Plan` while the session was actively working, and
    // the orchestrator quoted that card as evidence.
    //
    // Asserted on the table rather than by intercepting the spawn: the decision
    // is the contract, the spawn is plumbing, and a test that stubbed Bun.spawn
    // would pass while the table said the opposite.
    expect(REPORT_SHAPE['turn-ended'].movesBoard).toBe(false);
    expect(REPORT_SHAPE.done.movesBoard).toBe(true);
    expect(REPORT_SHAPE.blocked.movesBoard).toBe(true);
    expect(REPORT_SHAPE.interrupted.movesBoard).toBe(true);
  });
});

/**
 * `turn-ended` tells its reader to prove the artifact. The child is standing in the
 * worktree, so it answers that itself — measured 2026-08-16, an orchestrator with five
 * children paid two git round-trips per ping, three times in twenty minutes, for facts
 * that were already under the sender's feet.
 *
 * The reader is injected, so these tests are about the one thing that can go wrong in a
 * way nobody notices: a git that REFUSED must never be rendered as a zero.
 */
describe('artifact note', () => {
  const reader = (answers: Record<string, string | null>) => (args: string[]) => {
    const key = args[0] === 'rev-parse' ? `rev-parse ${args[3]}` : args[0];
    return key in answers ? answers[key] : null;
  };

  test('counts commits against the base ref origin actually carries', () => {
    const note = artifactNote(
      reader({ status: '', 'rev-parse origin/main': 'abc123', 'rev-list': '2' }),
    );
    expect(note).toBe('Artifact so far: 2 commits ahead of origin/main, 0 files uncommitted.');
  });

  test('a started child reads as work in progress, not as nothing', () => {
    const note = artifactNote(
      reader({ status: 'M a.ts\nM b.ts\n?? c.ts', 'rev-parse origin/HEAD': 'abc', 'rev-list': '0' }),
    );
    expect(note).toContain('0 commits');
    expect(note).toContain('3 files uncommitted');
  });

  test('a git that REFUSED is named unmeasured, never rendered as zero', () => {
    // The defect this whole channel exists to stop: `git` declines a worktree owned by
    // another uid and prints nothing, which is byte-identical to a clean tree. Rendering
    // that as `0 files uncommitted` is the flattering reading of an absence — two audits
    // concluded "nothing to save" that way before a third found 116 unpushed commits.
    const note = artifactNote(() => null);
    expect(note).toBe('Artifact unmeasured: git refused in this worktree.');
    expect(note).not.toContain('0 ');
  });

  test('no base ref on origin is said, not rounded to zero commits', () => {
    // A fresh clone with no `origin/main` is a fact about the clone, not about the work.
    const note = artifactNote(reader({ status: 'M a.ts' }));
    expect(note).toContain('no base ref on origin');
    expect(note).toContain('1 file uncommitted');
    expect(note).not.toContain('commits ahead');
  });
});

/**
 * THE RETURN ADDRESS OF A SENDER THAT STATED NONE.
 *
 * Every other address here is resolved from a NAME, which a peer shell can claim
 * by overwriting an entry — hence the module's refusal to look one up. This one
 * is keyed by a handle Orca witnessed, so these tests pin the two properties that
 * make it sound: it reads only under a well-formed handle, and an absence is an
 * empty answer rather than a fabricated one.
 */
describe('run address of a witnessed handle', () => {
  test('returns the Run that handle published, as an addressable run:<id>', async () => {
    register({ run: 'run_child', sessionId: 's1', model: 'claude-opus-5' });
    expect(runAddressOfHandle(HANDLE)).toBe('run:run_child');
  });

  test('a handle with no entry answers empty, never a guess', () => {
    expect(runAddressOfHandle('term_never_registered')).toBe('');
  });

  test('an entry carrying no run answers empty rather than `run:`', async () => {
    // A malformed or half-written file is normal to read here: entries are
    // written by independent processes. `run:` alone would pass a shape check at
    // the call site and then address nothing.
    await mkdir(registry, { recursive: true });
    await writeFile(join(registry, `${HANDLE}.json`), JSON.stringify({ handle: HANDLE }));
    expect(runAddressOfHandle(HANDLE)).toBe('');
  });

  test('anything that is not a handle is refused before it reaches the disk', () => {
    // The argument arrives off the wire as `from_handle`. A path fragment in it
    // must never become a file read outside the registry directory.
    for (const bad of ['', 'term', '../../etc/passwd', 'term_../x', 'run_abc'])
      expect(runAddressOfHandle(bad)).toBe('');
  });
});
