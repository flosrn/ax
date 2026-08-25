// `ax triage dispatch` — one Orca session per issue, and nothing else.
//
// It does not read the issue, judge it, or write a word about it. The session
// does that, from the preloaded triage playbook plus the project's own label
// mapping. This only puts a correctly-addressed, correctly-instructed session
// in front of each issue — and refuses every arrangement a human hand produced
// when told, in prose, that N issues is N sessions.
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
import { defaultStore, dispatchIndex, handlesByRequest, heldRepaired, report } from '../worker/record.mjs';
import { peerRun } from '../worker/peers.mjs';
import { terminalInventory } from '../worker/pane.mjs';
import { paneVerdict } from '../worker/ls.mjs';
import { start as startVerb } from '../worker/start.mjs';
import { launchProof } from '../worker/transcript.mjs';
import { DRAFT_DIR, draftPath, passesIn, passesOf, readDraft, requestFor } from './draft.mjs';

const USAGE =
  'ax triage dispatch --issue N [--issue M …] [--job triage|brief|custom|refine] [--instruction <file>] [--fresh --because <text>] [--repo <owner/repo>] [--model <alias>] [--force] [--dry-run]';

/** Jobs whose child may apply labels, so whose project vocabulary is required. */
const LABEL_JOBS = new Set(['triage', 'brief']);
/**
 * The session role and playbook each job's child must prove. One map feeds both
 * the spec marker and the verification below — two hardcoded strings is how a
 * marker and its proof drift apart (the same one-source rule the marker parser
 * itself follows, `omp/shared/alias.ts`).
 */
const ROLE_BY_JOB = {
  triage: { role: 'triage-worker', skill: 'triage' },
  brief: { role: 'triage-worker', skill: 'triage' },
  custom: { role: 'triage-worker', skill: 'triage' },
  refine: { role: 'refine-worker', skill: 'refine' },
};
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
function verifyTriageRole({ request, job = 'triage', root, env, sessionsRoot, proofFn, now, sleep }) {
  const expected = ROLE_BY_JOB[job];
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
    role.role === expected.role &&
    skills.includes(expected.skill)
  ) {
    ok(`${request}: ${expected.role} + ${expected.skill} reached the first turn`);
    return 'VERIFIED';
  }

  if (model?.role !== 'default') bad(`${request}: model marker unproven (${model === null ? 'no model receipt' : `${model.model}|${model.role}`})`);
  if (role === null) bad(`${request}: no session-role receipt`);
  else if (role.status === 'refused') {
    const missing = role.missingSkills.length === 0 ? '' : `; missing ${role.missingSkills.join(', ')}`;
    bad(`${request}: role ${role.role} refused — ${role.reason}${missing}`);
  } else if (role.role !== expected.role) bad(`${request}: expected ${expected.role}, got ${role.role}`);
  else if (!skills.includes(expected.skill)) bad(`${request}: the ${expected.skill} playbook was not applied`);
  fix('ax worker ls   # inspect the recorded pane and role receipt; do not relaunch');
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
  let freshPass = false;
  let because = '';

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
    else if (arg === '--fresh') freshPass = true;
    else if (arg === '--because') because = value();
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }

  if (issues.length === 0) return usageError('no --issue given');
  for (const issue of issues) {
    if (!/^[1-9][0-9]*$/.test(issue)) return usageError(`--issue expects a number, got "${issue}"`);
  }
  if (job === '') job = 'triage';
  if (!['triage', 'brief', 'custom', 'refine'].includes(job)) return usageError(`--job expects triage|brief|custom|refine, got "${job}"`);
  if (job === 'custom' && instruction === '') return usageError('--job custom needs --instruction <file> holding the one-line task');
  if (job === 'custom' && !existsSync(instruction)) return refuse(`--instruction file unreadable: ${instruction}`);
  // A fresh pass with no stated reason is a child redoing the work the last one
  // already did. The text is not paperwork: it becomes the "what changed" line
  // in the new child's own brief, which is the only thing telling it which parts
  // of the previous pass still stand.
  if (freshPass && because.trim() === '') {
    return usageError('--fresh needs --because <text> — the reason is what the new child is told changed since the last pass');
  }
  // Refused rather than ignored: the caller wrote down why they were redoing the
  // work, and silence would carry none of it.
  if (!freshPass && because !== '') return usageError('--because only means something with --fresh');

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

  // ── 4b. which PASS each issue is about to run ─────────────────────────────
  // A plain dispatch targets the CURRENT pass — the newest one on disk — so it
  // replays what is there (F-001) exactly as it did before passes existed. Only
  // `--fresh` moves the number, and only behind two gates.
  const handlesOf = handlesByRequest(index);

  const plan = [];
  for (const issue of issues) {
    const base = { job, repo: slug, issue };
    const existing = passesIn(store, base, '.json');
    const latest = existing.length === 0 ? 0 : existing[existing.length - 1];

    if (!freshPass) {
      plan.push({ issue, pass: Math.max(latest, 1), previous: null });
      continue;
    }
    if (latest === 0) {
      return refuse(
        `#${issue} has no recorded pass, so there is nothing to redo`,
        `ax triage dispatch --issue ${issue} --job ${job}   # a first pass is an ordinary dispatch`,
      );
    }

    // GATE 1 — F-001, and `--fresh` must never be the way around it. An
    // unsettled record may still be mutating: `worker-start` has answered
    // `runtime_unavailable` twice while its mutation ran on, which is how two
    // agents landed in one worktree. A second pass on top of that is the same
    // duplicate under a new name. Note this cannot be decided from the handle
    // index: it only holds rows built from a parseable `worker-start` receipt,
    // so a stranded record maps NO handle at all — the very case where a child
    // is most likely to exist unseen.
    const previousRequest = requestFor({ ...base, pass: latest });
    let previousState;
    try {
      previousState = report(join(store, `${previousRequest}.json`));
    } catch (error) {
      return cannot(`pass ${latest} of #${issue} has an unreadable record: ${String(error.message ?? error)}`, `cat ${join(store, `${previousRequest}.json`)}`);
    }
    if (!previousState.usable) {
      return refuse(
        `pass ${latest} of #${issue} never settled, so it may still be mutating — a fresh pass here is a second agent under a new number`,
        heldRepaired(join(store, `${previousRequest}.json`))
          ? `ax worker transcript ${previousRequest}   # its child IS running and reports by peer; never --resume, never --fresh`
          : `ax worker start --resume --request ${previousRequest}   # settle it first (F-001), then redo it`,
      );
    }

    // GATE 2 — the pane, on the shared three-valued definition rather than the
    // cap's. The cap deliberately leaves an omitted host UNCOUNTED, which is
    // right for "have I room for one more" and wrong here: this call is about to
    // create a RIVAL child, so an absence that proves nothing must stop it.
    const handles = [...(handlesOf.get(previousRequest) ?? [])];
    // Zero handles is not zero panes, and this is REACHABLE — not a theoretical
    // guard. `report()` treats a Bash-era record as usable on
    // `terminal !== null || legacyUsable`, where `legacyUsable` is just a
    // non-empty `receiptPath` (record.mjs:367). So a settled legacy record can
    // name no agent pane at all, clear gate 1, and map no handle here — which is
    // "nothing on this machine can tell", exactly what `paneVerdict`'s null case
    // answers. Probing through it routes the gap to the shared third value
    // instead of falling through to "go ahead".
    const probed = handles.length === 0 ? [null] : handles;
    const why = `pass ${latest} has no pane recorded against it, so nothing on this machine can say whether its child is gone`;
    const verdicts = probed.map(handle => paneVerdict(handle, why, inventory));
    const living = probed.find((_, at) => verdicts[at].pane === 'VIVANT');
    if (living !== undefined) {
      return refuse(
        `pass ${latest} of #${issue} still holds a live pane (${living}) — two children on one issue is the duplicate this whole subsystem exists to prevent`,
        `ax worker release --close --dispatch <id>   # or let it finish; then redo it`,
      );
    }
    const unknown = verdicts.find(verdict => verdict.pane === 'INCONNU');
    if (unknown !== undefined) {
      return cannot(
        `pass ${latest} of #${issue} cannot be proven finished: ${unknown.detail} — an absence from a partial terminal list is not a death (F-028)`,
        `ax worker ls   # read the pane's real state, close it if it is there, then redo`,
      );
    }

    const previous = readDraft(paths.root, { ...base, pass: latest });
    plan.push({ issue, pass: latest + 1, previous: { pass: latest, path: previous.path, sha: previous.sha } });
  }

  const newSessions = plan.filter(entry => !existsSync(join(store, `${requestFor({ job, repo: slug, issue: entry.issue, pass: entry.pass })}.json`)));
  const cap = capOf(env);
  if (!cap.ok) {
    return refuse(
      `ORCA_TRIAGE_SESSION_CAP is ${JSON.stringify(cap.raw)}, which is not a whole number of sessions — refusing rather than dispatching with no cap at all`,
      'unset ORCA_TRIAGE_SESSION_CAP # the default is 3, and 0 means "no new session here"',
    );
  }
  if (live + newSessions.length > cap.cap) {
    return refuse(
      `cap: ${live} live child pane(s) + ${newSessions.length} new > ${cap.cap}`,
      'let a session finish, dispatch fewer issues, or raise ORCA_TRIAGE_SESSION_CAP',
    );
  }

  // ── 5. every issue prechecked before any is dispatched ────────────────────
  section(`precheck — ${slug} (job: ${job})`);
  let blocked = false;
  const state = new Map();
  for (const issue of issues) {
    const meta = readIssue(gh, slug, issue, job);
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
      // The NEWEST triage pass, from the records-and-drafts union. Reading `.md`
      // alone would distil pass 1 while pass 2's child is still writing — a brief
      // built on a verdict its own author is in the middle of replacing.
      const triageBase = { job: 'triage', repo: slug, issue };
      const triagePasses = passesOf(store, join(paths.root, DRAFT_DIR), triageBase);
      const from = triagePasses.length === 0 ? 1 : triagePasses[triagePasses.length - 1];
      const draft = readDraft(paths.root, { ...triageBase, pass: from });
      if (triagePasses.length > 0 && !existsSync(draft.path)) {
        bad(`^ triage pass ${from} is dispatched but has written no draft yet — there is nothing to distil, and falling back to an older pass would brief a verdict being replaced`);
        fix(`ax triage status --issue ${issue} --job triage   # wait for pass ${from} to write, then run the brief`);
        blocked = true;
        continue;
      }
      if (meta.comments === 0 && !draft.ok && !existsSync(draft.path)) {
        bad('^ no comment and no triage draft — there is no pass to distil into a brief');
        fix(`ax triage dispatch --issue ${issue} # run the triage pass first`);
        blocked = true;
        continue;
      }
      if (meta.comments === 0) note(`  distilling the unpublished draft at ${draft.path}`);
    }
    if (job === 'custom' && meta.comments > 0) note('  ^ already triaged — the spec opens by saying so, and forbids a re-triage');
    if (job === 'refine') {
      // Inbound gates do not apply here: comments on a spec-born issue are the
      // ordinary state (rulings folded into bodies), so F-030 stays triage-only.
      if (meta.labels.includes('ready-for-agent') && !force) {
        bad('^ already ready-for-agent — a second refine pass on a published verdict needs to be deliberate');
        fix(`ax triage dispatch --issue ${issue} --job refine --force # or --fresh --because <what moved> for a new pass`);
        blocked = true;
        continue;
      }
      if (meta.parent === undefined) note('  parent unknown — this gh cannot read the sub-issue parent; the child will identify the PRD itself');
      else if (meta.parent === null) note('  ^ no parent issue — refine expects a PRD sub-issue; a bug or inbound request belongs to --job triage');
      else note(`  parent #${meta.parent}`);
    }
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
  for (const { issue, pass, previous } of plan) {
    const identity = { job, repo: slug, issue, pass };
    const request = requestFor(identity);
    const draft = draftPath(paths.root, identity);
    // The pass is printed even when there is only one of it. A number that
    // appears only once it matters is a number nobody learns to read, and the
    // silence on which version was in play is what cost draft #54.
    section(`issue #${issue} → session '${request}' (pass ${pass})`);

    const spec = renderSpec({
      job,
      model,
      issue,
      repo: slug,
      draft,
      labels: labels.path,
      triaged: (state.get(issue)?.comments ?? 0) > 0,
      parent: state.get(issue)?.parent,
      instruction: job === 'custom' ? readFileSync(instruction, 'utf8') : '',
      pass,
      previous,
      because,
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
        job,
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

/**
 * State, comment count and title in one read — plus, for refine only, the labels
 * and the sub-issue parent.
 *
 * The parent read is best-effort and advisory: a gh older than the sub-issues
 * API fails the WHOLE view when asked for the field (it does not answer with the
 * field missing), so the naive read would turn a capability gap into a refusal.
 * On that exact failure the read retries with the base fields and the parent
 * stays `undefined` — unknown, which is not `null`, confirmed absent (F-028).
 */
function readIssue(gh, repo, issue, job = 'triage') {
  const refine = job === 'refine';
  const fields = refine ? 'state,title,comments,labels,parent' : 'state,title,comments';
  let out = gh(['issue', 'view', issue, '--repo', repo, '--json', fields]);
  let parentReadable = refine;
  if (refine && !out.error && out.status !== 0 && /unknown json field.*parent/i.test(String(out.stderr ?? ''))) {
    parentReadable = false;
    out = gh(['issue', 'view', issue, '--repo', repo, '--json', 'state,title,comments,labels']);
  }
  if (out.error) return { ok: false, reason: `gh could not run: ${String(out.error.message ?? out.error)}` };
  if (out.status !== 0) return { ok: false, reason: `not found in ${repo}` };
  let body;
  try {
    body = JSON.parse(out.stdout);
  } catch {
    return { ok: false, reason: 'gh answered something that is not JSON' };
  }
  if (!Array.isArray(body.comments)) return { ok: false, reason: 'gh answered no comments array — an absent container is not an empty one' };
  const meta = { ok: true, state: String(body.state ?? ''), title: String(body.title ?? ''), comments: body.comments.length };
  if (refine) {
    if (!Array.isArray(body.labels)) return { ok: false, reason: 'gh answered no labels array — an absent container is not an empty one' };
    meta.labels = body.labels.map(label => String(label?.name ?? ''));
    meta.parent = !parentReadable ? undefined : body.parent === null || body.parent === undefined ? null : Number(body.parent.number);
  }
  return meta;
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
function renderSpec({ job, model, issue, repo = '', draft, labels, triaged, parent, instruction, pass = 1, previous = null, because = '' }) {
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
  // broke the answer channel, and the coordinator measured both halves of it on
  // 2026-08-22: children's `ask` refused because the stall had revoked their
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
  // The global command is the stable entry point a fresh child receives; its
  // dispatcher hands this argv to the exact project package.
  const askCommand = `ax triage ask --issue ${issue} --job ${job}${repo ? ` --repo ${repo}` : ''} --pass ${pass}`;
  // The routing tag lives INSIDE the question text, never between the number
  // and the colon: `Q<n> [technical]:` would break the one Q-line grammar
  // (draft.mjs), while `Q<n>: [technical] …` travels verbatim through ask and
  // answer with zero code. The categories are the maintainer's own ruling
  // (2026-08-23, measured on 24/24 answers that merely confirmed the
  // coordinator's technical recommendation): the coordinator RULES technical
  // questions itself, reversibly; product and high-stakes ones go up. The tag
  // is advisory, not validated — an untagged question costs the parent one
  // extra read, which is not a defect worth a refusal.
  const asking = `When something load-bearing is underdetermined, do not decide it alone and do not bury the ask in prose: write one \`Q<n>: <question>\` line per open decision, numbered from 1 with no gaps and no repeats, each answerable on its own, and OPEN each question's text with its routing tag — \`[technical]\` for representation, cardinality, file placement, versioning, pure/impure, type unions or SQL mechanics, which the coordinator rules itself and reversibly; \`[product]\` for scope, user-visible behavior, security, money, data, or business taxonomy, which goes up to the maintainer — so the parent routes each question without reading it twice. Keep those lines in the draft so the decision is on record. Then run \`${askCommand}\`, which sends the draft's own Q lines to the parent that dispatched you and blocks until they are answered; if it exits 4 the question is PENDING under a printed message id, so go back to waiting on it with \`ax triage ask --resume <message_id>\` rather than giving up or deciding it yourself. Do not report and do not end your turn while a question is open — with ONE exception: if the ask refuses saying this Dispatch is not supervised (its capability died at a composer stall, and no ask can ever land from this session), follow that refusal instead of this sentence — keep the \`Q<n>:\` lines in the draft and report immediately, quoting them and saying the supervised channel is unavailable; your report is then the only channel left, and the parent answers by peer. You hold the issue and the code you have already read; that context is why the answer comes to you rather than to a later session. When the answers arrive, revise the draft into a final verdict, drop the \`Q<n>:\` lines the answers close, and only then report.`;

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

  if (job === 'refine') {
    // The parent PRD is named when the precheck could read it; a child told to
    // find it itself is the degraded path, not the ordinary one.
    const lineage = typeof parent === 'number'
      ? `Then run the Definition-of-Ready pass on issue #${issue} (issue://${issue}), a sub-issue of issue://${parent} — read both before scoring.`
      : `Then run the Definition-of-Ready pass on issue #${issue} (issue://${issue}); identify its parent PRD from the issue itself before scoring.`;
    return [
      marker,
      redo,
      'Use the preloaded refine playbook: score its five Definition-of-Ready gates against this checkout and the parent ticket.',
      lineage,
      `Write your verdict to ${draft}: exactly one \`Ready: yes\` or \`Ready: no\` line, then one \`## Agent Brief\` section — published verbatim on the issue, so it carries no line numbers and no file-placement instructions — then one \`## Verification\` section, which is never published: your per-gate evidence, where file:line reads belong.`,
      'Never write `Labels:`, `Remove labels:` or `Close:` — a refine draft that names labels is refused whole; publication applies only ready-for-agent, and the PRD already decided the categorization.',
      'On a failed gate the verdict is `Ready: no` and the draft carries the diagnosis plus a concrete repair proposal — corrected acceptance criteria, or a split. You recommend; the coordinator arbitrates.',
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
