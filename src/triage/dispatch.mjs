// `ax triage dispatch` — one Orca session per issue, and nothing else.
//
// It does not read the issue, judge it, or write a word about it. The session
// does that, from `skill://triage` plus the project's own label mapping. This
// only puts a correctly-addressed, correctly-instructed session in front of each
// issue — and refuses every arrangement a human hand produced when told, in
// prose, that N issues is N sessions.
//
// That instruction was given four times on 2026-08-10 and violated four
// different ways: one agent for four issues; three subagents, which cannot ask
// the orchestrator a question, so nothing could be orchestrated; a hand-rolled
// dispatch loop cancelled mid-mutation that stranded a worker-start; and
// `--worktree new-child`, which paid a full install and left a branch in the
// sidebar to produce one comment. Prose did not hold. This is the shape that
// does.
//
// What a triage session needs: the repo readable, `gh`, and a pane that can talk
// to its orchestrator. What it does not need: a worktree, a branch, a setup run,
// a PR. So it runs with `--worktree current` — a real session in the existing
// checkout, with nothing left behind, and several of them share the checkout
// without colliding because a triage child writes only its own draft.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { bad, dim, fix, note, ok, raw, section } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { defaultExec } from '../worker/release.mjs';
import { defaultStore, dispatchIndex } from '../worker/record.mjs';
import { peerRun } from '../worker/peers.mjs';
import { terminalInventory } from '../worker/pane.mjs';
import { start as startVerb } from '../worker/start.mjs';
import { launchProof } from '../worker/transcript.mjs';
import { draftPath, readDraft, requestFor } from './draft.mjs';

const USAGE =
  'ax triage dispatch --issue N [--issue M …] [--job triage|brief|custom] [--instruction <file>] [--repo <owner/repo>] [--model <alias>] [--force] [--dry-run]';

/** Jobs whose child may apply labels, so whose project vocabulary is required. */
const LABEL_JOBS = new Set(['triage', 'brief']);
/**
 * How many live child panes this machine tolerates. Counted, never remembered
 * (F-028), and counted by PANE rather than by `worker-list` (F-048: that counter
 * answered zero while children were working).
 *
 * An unreadable value is a refusal, not a default: `Number('bad')` is NaN, and
 * `live + new > NaN` is false for every input — the fence would vanish silently,
 * on the one guard whose whole job is to fail closed. Zero is legal, and means
 * "no new session on this machine right now".
 */
function capOf(env) {
  const raw = env.ORCA_TRIAGE_SESSION_CAP;
  if (raw === undefined || raw === '') return { ok: true, cap: 3 };
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) return { ok: false, raw: String(raw) };
  return { ok: true, cap };
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const defaultSleep = ms => Atomics.wait(waitCell, 0, 0, ms);

const roleWaitOf = env => {
  const value = Number(env.AX_TRIAGE_ROLE_WAIT ?? 30);
  return Number.isFinite(value) && value >= 0 ? value : 30;
};

/**
 * Prove the child-side effect, not the marker ax composed.
 *
 * A missing role cannot mutate — orca-model removes the tool surface and blocks
 * every tool call before the first provider turn — but the parent still needs
 * the exact refusal rather than a green "dispatch recorded" line.
 */
function verifyTriageRole({ request, root, env, sessionsRoot, proofFn, now, sleep }) {
  const wait = roleWaitOf(env);
  const deadline = now() + wait * 1000;
  let proof = null;
  do {
    try {
      proof = proofFn({ needle: basename(root), request, env, sessionsRoot });
    } catch {
      proof = null;
    }
    if (proof !== null || now() >= deadline) break;
    sleep(250);
  } while (true);

  if (proof === null) {
    bad(`CANNOT ESTABLISH — ${request}: no child-side role receipt appeared within ${wait}s`);
    note('The dispatch DID happen. Do NOT relaunch; inspect its recorded pane with `ax worker ls`.');
    return 'CANNOT-ESTABLISH';
  }

  const model = proof.model;
  const role = proof.sessionRole;
  const skills = role?.status === 'applied' ? role.skills : [];
  note(`proof ${request}: model ${model === null ? 'unreadable' : `${model.model}|${model.role}`} · session ${
    role === null
      ? 'unreadable'
      : role.status === 'refused'
        ? `${role.role}|REFUSED ${role.reason}`
        : `${role.role}|${skills.join(',') || 'no skills'}`
  }`);

  if (
    model?.role === 'default' &&
    role?.status === 'applied' &&
    role.role === 'triage-worker' &&
    skills.includes('triage')
  ) {
    ok(`${request}: triage-worker + triage reached the first turn`);
    return 'VERIFIED';
  }

  if (model?.role !== 'default') bad(`${request}: model marker unproven (${model === null ? 'no model receipt' : `${model.model}|${model.role}`})`);
  if (role === null) bad(`${request}: no session-role receipt`);
  else if (role.status === 'refused') {
    const missing = role.missingSkills.length === 0 ? '' : `; missing ${role.missingSkills.join(', ')}`;
    bad(`${request}: role ${role.role} refused — ${role.reason}${missing}`);
  } else if (role.role !== 'triage-worker') bad(`${request}: expected triage-worker, got ${role.role}`);
  else if (!skills.includes('triage')) bad(`${request}: triage skill was not applied`);
  note('The dispatch DID happen. Do NOT relaunch; inspect its recorded pane with `ax worker ls`.');
  return 'CANNOT-ESTABLISH';
}

export function dispatch(
  argv = [],
  {
    resolve = resolveOrca,
    runner,
    exec = defaultExec,
    env = process.env,
    cwd = process.cwd(),
    startFn = startVerb,
    proofFn = launchProof,
    sessionsRoot,
    now = Date.now,
    sleep = defaultSleep,
  } = {},
) {
  const usageError = message => {
    process.stderr.write(`ax triage dispatch: ${message}\n${USAGE}\n`);
    return 2;
  };
  const refuse = (message, repair) => {
    bad(redactSecrets(message));
    if (repair) fix(redactSecrets(repair));
    return 1;
  };
  const cannot = (message, repair) => {
    bad(redactSecrets(`CANNOT ESTABLISH — ${message}`));
    if (repair) fix(redactSecrets(repair));
    return 3;
  };

  // ── 1. arguments, before anything is read ─────────────────────────────────
  const issues = [];
  let job = '';
  let instruction = '';
  let repo = '';
  let model = '@default';
  let force = false;
  let dry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--issue') issues.push(value());
    else if (arg === '--job') job = value();
    else if (arg === '--instruction') instruction = value();
    else if (arg === '--repo') repo = value();
    else if (arg === '--model') model = value();
    else if (arg === '--force') force = true;
    else if (arg === '--dry-run') dry = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }

  if (issues.length === 0) return usageError('no --issue given');
  for (const issue of issues) {
    if (!/^[1-9][0-9]*$/.test(issue)) return usageError(`--issue expects a number, got "${issue}"`);
  }
  if (job === '') job = 'triage';
  if (!['triage', 'brief', 'custom'].includes(job)) return usageError(`--job expects triage|brief|custom, got "${job}"`);
  if (job === 'custom' && instruction === '') return usageError('--job custom needs --instruction <file> holding the one-line task');
  if (job === 'custom' && !existsSync(instruction)) return refuse(`--instruction file unreadable: ${instruction}`);

  // ── 2. the machine, before the tracker ────────────────────────────────────
  const bin = runner ? null : resolve({ env });
  if (!runner && bin === null) return cannot('no Orca CLI on this machine — a triage session is an Orca session, so none can be created here');
  const run = runner ?? createRunner({ bin, exec });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open # start the runtime, then re-run this dispatch');

  const paths = repoPaths(cwd);
  if (!paths.root) return refuse('not inside a git repository — a triage session reads this checkout, so it needs one');

  const gh = args => exec('gh', args, paths.root);
  const slug = repo || resolveRepo(gh);
  if (slug === '') return refuse('could not resolve the current repository', 'ax triage dispatch --repo <owner>/<repo>');

  // ── 3. the vocabulary the child is answerable to ──────────────────────────
  // Declared and unreadable is a refusal, exactly like `launch.contract`: a spec
  // pointing at nothing sends a child to improvise, and improvising here means
  // recommending in prose and stopping.
  const loaded = loadCheckoutConfig({ root: paths.root, main: paths.main });
  if (!loaded.exists) return refuse(`no ax.config.json for ${paths.root}`, 'ax init # a triage session reads this project\'s contract, so the project has to have one');
  if (loaded.errors.length > 0) return refuse(`ax.config.json has ${loaded.errors.length} problem(s): ${loaded.errors.join('; ')}`, 'ax doctor');
  const config = loaded.config ?? {};
  const labels = readLabels(config.triage?.labels ?? '', paths.root);
  if (LABEL_JOBS.has(job) && labels.missing) {
    return refuse(
      `ax.config.json declares triage.labels ${labels.why} — a ${job} child would have no group vocabulary and would land an incomplete verdict (2026-08-10: four issues, three empty groups each)`,
      labels.path ? `create or repair ${labels.path} # the file that names this project's label groups` : "declare triage.labels in ax.config.json # the file that names this project's label groups",
    );
  }

  // ── 4. the cap, counted by live pane — and only OUR panes ─────────────────
  // `terminal list` answers for every pane the runtime owns: this session's, an
  // editor's, an unrelated worker's. Counting those as triage capacity would let
  // a busy sidebar fence the work. So the count is the record↔pane association
  // `ls` reads liveness from — a dispatch record whose recorded handle is still
  // alive — which is what F-048 actually fixed: `worker-list` answered zero
  // while those same children were working.
  //
  // Fail-closed, like `ls` and for its reason: the caller is about to decide
  // whether it has room for another child. But `ls`'s own exit-3 list names an
  // unreadable terminal list and an unreadable store — NOT omitted hosts, which
  // it renders UNKNOWN and still answers. That distinction is measured: on this
  // Mac `hostScope.omittedHostIds` is non-empty, so refusing on it would refuse
  // every ordinary dispatch (the same fail-closed hole `gate` had, where 155 of
  // 218 panes were absent because of a stale runtime).
  const inventory = terminalInventory(run);
  if (!inventory.ok) return cannot(inventory.reason, 'orca open # the cap is counted, never assumed — it does not fail open');
  const store = defaultStore(env);
  const index = dispatchIndex(store);
  // An ENOENT store is a machine that has never dispatched: zero is the true
  // count, and refusing would block the first dispatch ever. A store that
  // exists and cannot be read is the opposite — zero would be a lie.
  if (!index.missing && index.reason !== '') {
    return cannot(`the dispatch store ${store} cannot be read, so live children cannot be counted: ${index.reason.slice(0, 160)}`, `ls -ld ${store}`);
  }
  if (index.unreadable.length > 0) {
    const first = index.unreadable[0];
    return cannot(
      `${index.unreadable.length} dispatch record(s) in ${store} cannot be read, so the number of live children cannot be established — an absence of information is not an absence of a child (F-028). First: ${first.file} — ${String(first.error).slice(0, 160)}`,
      `ax worker ls --store ${store} # see every record, then repair or remove the unreadable one`,
    );
  }
  const alive = new Set();
  for (const row of index.byDispatch.values()) {
    if (row.handle === null) continue;
    const terminal = inventory.byHandle.get(row.handle);
    if (terminal !== undefined && terminal.orphaned !== true) alive.add(row.handle);
  }
  const live = alive.size;
  if (inventory.omitted) note('hosts are omitted from this terminal list: a child on one of them is UNKNOWN here, not counted');

  const fresh = issues.filter(issue => !existsSync(join(store, `${requestFor({ job, repo: slug, issue })}.json`)));
  const cap = capOf(env);
  if (!cap.ok) {
    return refuse(
      `ORCA_TRIAGE_SESSION_CAP is ${JSON.stringify(cap.raw)}, which is not a whole number of sessions — refusing rather than dispatching with no cap at all`,
      'unset ORCA_TRIAGE_SESSION_CAP # the default is 3, and 0 means "no new session here"',
    );
  }
  if (live + fresh.length > cap.cap) {
    return refuse(
      `cap: ${live} live child pane(s) + ${fresh.length} new > ${cap.cap}`,
      'let a session finish, dispatch fewer issues, or raise ORCA_TRIAGE_SESSION_CAP',
    );
  }

  // ── 5. every issue prechecked before any is dispatched ────────────────────
  section(`precheck — ${slug} (job: ${job})`);
  let blocked = false;
  const state = new Map();
  for (const issue of issues) {
    const meta = readIssue(gh, slug, issue);
    if (!meta.ok) {
      bad(`#${issue} UNREADABLE — ${meta.reason}`);
      blocked = true;
      continue;
    }
    state.set(issue, meta);
    note(`#${issue} ${meta.state} ${meta.comments} comment(s) ${dim(meta.title.slice(0, 62))}`);

    if (meta.state !== 'OPEN') {
      bad('^ not OPEN — a closed issue is not triage work');
      blocked = true;
      continue;
    }
    if (job === 'triage' && meta.comments > 0 && !force) {
      bad('^ F-030: this issue already carries comment(s), and the label cannot tell "never triaged" from "triaged, awaiting a human"');
      note('  a full pass sent here re-measures finished work and returns a competing verdict');
      fix(`ax triage dispatch --issue ${issue} --job brief # if the pass is done, you want a brief — not --force`);
      blocked = true;
      continue;
    }
    if (job === 'brief') {
      // A pass exists if it was published as a comment OR still sits in its
      // draft: publication happens at the end of a chain, so refusing on the
      // comment count alone would refuse the ordinary sequence.
      const draft = readDraft(paths.root, { job: 'triage', repo: slug, issue });
      if (meta.comments === 0 && !draft.ok && !existsSync(draft.path)) {
        bad('^ no comment and no triage draft — there is no pass to distil into a brief');
        fix(`ax triage dispatch --issue ${issue} # run the triage pass first`);
        blocked = true;
        continue;
      }
      if (meta.comments === 0) note(`  distilling the unpublished draft at ${draft.path}`);
    }
    if (job === 'custom' && meta.comments > 0) note('  ^ already triaged — the spec opens by saying so, and forbids a re-triage');
  }
  if (blocked) return refuse('precheck refused — nothing was dispatched');

  // ── 6. the Run this session's own receiver consumes ───────────────────────
  const runId = peerRun(env);
  if (runId === '') {
    return cannot(
      'no Run in the peer registry for this pane — nothing dispatched from here could report back',
      'restart this session so the peer extension registers it, then re-run',
    );
  }

  note(`run ${runId}`);
  note(`model ${model}`);
  note(`where ${paths.root} (current worktree — no tree, no branch, no setup)`);

  // ── 7. one session per issue ──────────────────────────────────────────────
  const results = [];
  for (const issue of issues) {
    const request = requestFor({ job, repo: slug, issue });
    const draft = draftPath(paths.root, { job, repo: slug, issue });
    section(`issue #${issue} → session '${request}'`);

    const spec = renderSpec({
      job,
      model,
      issue,
      draft,
      labels: labels.path,
      triaged: (state.get(issue)?.comments ?? 0) > 0,
      instruction: job === 'custom' ? readFileSync(instruction, 'utf8') : '',
    });
    note(`spec: ${spec}`);

    if (dry) {
      results.push({ issue, request, verdict: 'DRY' });
      continue;
    }

    const recorded = existsSync(join(store, `${request}.json`));
    let code;
    if (recorded) {
      note('an earlier attempt is recorded — replaying it rather than creating a second task (F-001)');
      code = startFn(['--resume', '--request', request, ...(bin ? ['--orca', bin] : [])], { env, runner: run });
    } else {
      // Free text never touches argv: the spec goes to a file, always. A pasted
      // multi-line prompt is what left two briefs unsent in a composer.
      const path = join(paths.root, '.scratch', 'triage', `${request}.spec.txt`);
      mkdirSync(join(paths.root, '.scratch', 'triage'), { recursive: true });
      writeFileSync(path, `${spec}\n`);
      code = startFn(
        ['--request', request, '--run', runId, '--spec-file', path, ...(bin ? ['--orca', bin] : []), '--', '--worktree', 'current', '--agent', 'omp'],
        { env, runner: run },
      );
    }
    results.push({ issue, request, verdict: verdictOf(code) });
  }

  // Start the whole batch before waiting on any child. Triage sessions share
  // the current checkout, and each request id appears in exactly one first task
  // spec, so the transcript reader can distinguish them without a worktree per
  // comment.
  if (!dry) {
    for (const result of results) {
      if (result.verdict !== 'DISPATCHED') continue;
      result.verdict = verifyTriageRole({
        request: result.request,
        root: paths.root,
        env,
        sessionsRoot,
        proofFn,
        now,
        sleep,
      });
    }
  }

  // ── 8. summary ───────────────────────────────────────────────────────────
  section('summary');
  let failed = 0;
  for (const { issue, verdict } of results) {
    note(`#${issue} ${verdict}`);
    if (verdict !== 'VERIFIED' && verdict !== 'DRY') failed = 1;
  }
  if (!dry) {
    note('each session wakes you when it reports — do not poll, and never run `orchestration check --wait`: the peer extension owns the only consuming loop on this Run');
    note('a report is a signal, not a verdict: the evidence is the draft it wrote, and nothing lands until you publish it');
  }
  return failed;
}

const verdictOf = code => (code === 0 ? 'DISPATCHED' : code === 2 ? 'DUPLICATE' : code === 3 ? 'CANNOT-ESTABLISH' : 'REFUSED');

/** The repository this checkout pushes to, as `gh` names it. */
function resolveRepo(gh) {
  const out = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (out.error || out.status !== 0) return '';
  return String(out.stdout ?? '').trim().split('\n')[0] ?? '';
}

/** State, comment count and title in one read. Anything else is not our business. */
function readIssue(gh, repo, issue) {
  const out = gh(['issue', 'view', issue, '--repo', repo, '--json', 'state,title,comments']);
  if (out.error) return { ok: false, reason: `gh could not run: ${String(out.error.message ?? out.error)}` };
  if (out.status !== 0) return { ok: false, reason: `not found in ${repo}` };
  let body;
  try {
    body = JSON.parse(out.stdout);
  } catch {
    return { ok: false, reason: 'gh answered something that is not JSON' };
  }
  if (!Array.isArray(body.comments)) return { ok: false, reason: 'gh answered no comments array — an absent container is not an empty one' };
  return { ok: true, state: String(body.state ?? ''), title: String(body.title ?? ''), comments: body.comments.length };
}

/**
 * The project's label vocabulary, proven readable — not merely present.
 *
 * `existsSync` says yes to a directory and to a file this user cannot open, and
 * the child reads this path for real. A declared-and-unopenable contract is the
 * same failure as a declared-and-absent one: a session that improvises its
 * groups. An empty file is that failure too — it names nothing.
 */
function readLabels(declared, root) {
  if (declared === '') return { missing: true, path: '', why: 'nowhere' };
  const path = isAbsolute(declared) ? declared : join(root, declared);
  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') return { missing: true, path, why: `at ${path}, which is empty` };
    return { missing: false, path };
  } catch (error) {
    return { missing: true, path, why: `at ${path}, which cannot be read: ${String(error.code ?? error.message ?? error)}` };
  }
}

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
function renderSpec({ job, model, issue, draft, labels, triaged, instruction }) {
  const marker = `[omp role=triage-worker model=${model}]`;
  const nothing = `Apply no label, post no comment, close nothing, and modify no file in the repository: write ONLY ${draft}. The human reads that file, corrects it, and publishes it — a verdict that lands the moment it is rendered cannot be adjusted.`;

  if (job === 'triage') {
    return [
      marker,
      `Read skill://triage AND ${labels}, which overrides the skill wherever the two diverge.`,
      `Then triage issue #${issue} (issue://${issue}).`,
      `Write your verdict to ${draft}: one \`Labels:\` line per group naming the labels you concluded, then the comment body a human will read on the issue months from now, with your justification at one line per group.`,
      `Leaving a group empty means you have not finished. If you conclude wontfix, add \`Close: yes\` and say why — you are recommending it, not doing it.`,
      nothing,
      'If anything load-bearing is underdetermined, ask me rather than deciding alone. Report when the draft is written.',
    ].join(' ');
  }

  if (job === 'brief') {
    return [
      marker,
      `Read skill://triage and its reference file AGENT-BRIEF.md, and ${labels}.`,
      `Issue #${issue} (issue://${issue}) has ALREADY had its triage pass: do not redo it, do not re-measure what is established, and do not render a competing verdict.`,
      `Write the Agent Brief that follows from that pass to ${draft}, absorbing everything its "what is missing" section asks for, with a \`Labels:\` line for any label the pass left unapplied.`,
      `If ANY acceptance criterion is underdetermined, write nothing and ask me. If you find the pass itself is wrong, do not correct it silently: ask me.`,
      nothing,
      'Report when the draft is written.',
    ].join(' ');
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
