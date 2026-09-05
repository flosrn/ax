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
import { bad, dim, fix, note, ok, section } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { defaultExec } from '../exec.mjs';
import { defaultStore, dispatchIndex } from '../worker/record.mjs';
import { peerRun } from '../worker/peers.mjs';
import { hostScopes, terminalInventory } from '../worker/pane.mjs';
import { livePanes } from '../worker/slots.mjs';
import { start as startVerb } from '../worker/start.mjs';
import { dispatchProof, slugOf } from '../worker/transcript.mjs';
import { repoSlug } from '../gh.mjs';
import { draftDirFor, draftPath, passesOf, readDraft, requestFor } from './draft.mjs';
import { capLines, capVerdict, machineCapOf, repoCapOf } from '../worker/capacity.mjs';
import { passPlan } from './capacity.mjs';
import { carriedClasses } from './provenance.mjs';
import { necessityOf } from './necessity.mjs';
import { publicationIn } from './publication.mjs';
import { READY_LABEL, REFINE_REMOVED, ROLE_BY_JOB, renderSpec } from './spec.mjs';

const USAGE =
  'ax triage dispatch --issue N [--issue M …] [--job triage|brief|custom] [--instruction <file>] [--fresh --because <text>] [--repo <owner/repo>] [--model <alias>] [--wait <s>] [--force] [--dry-run]';

/** Jobs whose child may apply labels, so whose project vocabulary is required. */
const LABEL_JOBS = new Set(['triage', 'brief']);

/**
 * Label identity and the declared class vocabulary both live in
 * `./provenance.mjs` — one rule for the three verbs that judge provenance
 * (this one, `./publish.mjs`, `../frontier.mjs`). A second list here is how a
 * third class came to be read by two consumers out of three (#179).
 */

/**
 * Whether a ticket's ORIGIN forbids the requested job, when the repository
 * declared the vocabulary that says so (`triage.provenance`). Returns the
 * refusal, or null when nothing in the ticket contradicts it.
 *
 * WHY THIS EXISTS. Triage is an ON-RAMP, not a step in the spec chain: it is
 * the pass for work that ARRIVED — a human's report, another agent's
 * follow-up — and `to-tickets` publishes its own tickets as `ready-for-agent`
 * by construction. So a spec-born ticket has nothing to gain from a triage
 * pass and something to lose: its categorization was decided by its spec, and a
 * triage or brief child writes label groups over it. Only prose said so — the
 * readiness role told the operator that "provenance decides the job" — and
 * `readIssue` asked for the sub-issue parent in the retired readiness lane
 * only, so the lanes that must refuse a spec-born ticket were the ones that
 * never looked. Measured 2026-08-30: ten tickets carrying the inbound triage
 * label, a spec label AND a parent spec at once, one sentence away from a triage
 * wave that would have re-decided a categorization their spec had already fixed.
 *
 * TWO SIGNALS, AND THE REFUSAL NEEDS BOTH. The `source:`-style label is the
 * repository's declaration of intent, read from config and never inferred. The
 * sub-issue parent is the tracker's own answer. Nesting alone proves nesting —
 * a follow-up nested under its origin ticket is inbound — and the label alone
 * proves an intention nobody linked. So the two are required to agree; a
 * disagreement and an unreadable parent both refuse, and say which one it was
 * (F-028: an unknown is not an absence).
 *
 * NO OVERRIDE, AND NO REDIRECT. There is no other lane to send the ticket to:
 * the readiness pass that used to be offered here was removed, because
 * `to-tickets` already did that work with the human in the room. What is left
 * is the two repairs the refusal names — apply the ready label the spec flow
 * owed the ticket, or fix the ticket where `to-tickets` left it incomplete.
 *
 * A THIRD CLASS, `findings`, OPT-IN. A finding your own agents filed while
 * working is inbound in the glossary's sense — it arrived instead of being
 * planned — but it arrives WITH its measurement: the friction contract carries
 * argv, raw output, expected state and cost, so the finder is the verifier and
 * a pass re-measures what is measured. Measured 2026-09-02 on the package's
 * own checkout: two dozen findings ran through a triage pass and a brief pass
 * each, hours of sessions for a pile where a third were ten-line repairs a
 * maintainer closes in an hour, and the passes minted carve-out tickets and a
 * duplicate. Before this class existed the rule lived in role prose, which is
 * the state ADR 0001 rejected for spec-born work. The repair names the channel
 * that owns what was found — a maintainer verdict for the instrument,
 * `to-tickets` for the product — never another pass.
 *
 * ONE ADMISSION (#188). The blanket had its own cost: a finding whose repair
 * an APPROVED spec cannot be satisfied without had no lane. So a finding is
 * admitted when its own issue names the approved obligation it serves, in the
 * one line `./necessity.mjs` defines. The tool grades the SHAPE — an identified
 * spec, a written obligation, read from the issue itself — and never the merit:
 * whether the work is genuinely necessary is the pass's analysis. An unreadable
 * justification is unknown, not absent (F-028), and a project that declares no
 * `findings` keeps the two-class behaviour to the byte. Admission to a pass is
 * not authorization to implement: the frontier remains that authority.
 */
export function provenanceVerdict({ job, issue, slug, labels = [], parent, parentCause, declared, text }) {
  // WHICH classes this ticket carries comes from the shared vocabulary; what
  // FOLLOWS from carrying one is this verb's own decision, below.
  const carried = carriedClasses(declared, labels);
  if (carried.length === 0) return null;

  if (carried.length > 1) {
    return {
      bad: `^ carries ${carried.map(({ names }) => names.join(', ')).join(' and ')} — one ticket cannot be both ${carried.map(({ kind }) => kind).join(' and ')}, and no pass follows from a contradiction`,
      fix: [`gh issue view ${issue} --repo ${slug} --json labels # remove whichever of the two is wrong, then re-dispatch`],
    };
  }

  // Exactly one class is carried past here, so a class the ticket does not
  // carry reads empty — the shape the clauses below were already written on.
  const namesOf = key => carried.find(entry => entry.key === key)?.names ?? [];
  const findings = namesOf('findings');
  const spec = namesOf('spec');

  if (LABEL_JOBS.has(job) && findings.length > 0) {
    const necessity = necessityOf(text ?? {});
    if (necessity.ok) {
      return {
        admit: true,
        notes: [
          `^ carries ${findings.join(', ')} — admitted for #${necessity.spec}: ${necessity.obligation}`,
          'admission is a pass, not the ready label: ax frontier remains the authority for implementation Dispatch',
        ],
      };
    }
    if (necessity.kind === 'unknown') {
      return {
        bad: `^ carries ${findings.join(', ')} and its necessity justification could not be read — ${necessity.why}`,
        fix: [`gh issue view ${issue} --repo ${slug} --json ${necessity.field}`],
      };
    }
    return {
      bad: `^ carries ${findings.join(', ')} — your own agents filed this with its measurement attached, so the finder is the verifier and a ${job} pass would re-measure what is measured`,
      fix: [
        `gh issue comment ${issue} --repo ${slug} --body-file <verdict.md> # in the instrument: the maintainer answers it — fixed, refused with the cheaper thing, or unreproducible`,
        `to-tickets on the amended spec # in the product: the spec flow publishes it ready-for-agent, with the human in the room`,
        `gh issue comment ${issue} --repo ${slug} --body "Necessary for: #<spec> — <obligation>" # only when an approved spec cannot be satisfied without this work; an agent recommending it is not necessity`,
        `gh issue edit ${issue} --repo ${slug} --remove-label ${findings[0]} # only if it truly arrived from outside, with no measurement of its own`,
      ],
    };
  }

  // EVERY label-applying lane, not just triage. `brief` is in `LABEL_JOBS` for
  // the same reason triage is — its child spec permits `Labels:` directives — so
  // a spec-born ticket briefed here writes label groups over a categorization
  // its spec already decided.
  if (LABEL_JOBS.has(job) && spec.length > 0) {
    if (parent === null) {
      return {
        bad: `^ carries ${spec.join(', ')} but links to no spec — the label says spec-born, the tracker says nothing, and a ${job} pass is not safe on that`,
        fix: [`gh issue edit ${issue} --repo ${slug} --remove-label ${spec[0]} # if it truly came from outside; otherwise link it to its spec first`],
      };
    }
    if (typeof parent !== 'number') {
      // An unknown parent has three causes and only ONE of them is a gh too old
      // to answer `--json parent`. Offering the upgrade for the other two sends
      // the operator after a binary that answered fine. And the label-removal
      // clause this repair used to carry was worse than useless: nothing has
      // been established here, and removing the spec label starts the very pass
      // the gate refused. Measured 2026-08-30: gh 2.97.0 answers `--json
      // parent` and `--json subIssues`.
      const why =
        parentCause === 'capability'
          ? 'this gh refuses the parent field outright'
          : parentCause === 'absent'
            ? 'gh answered with no parent key at all, which is an unknown and not a confirmed absence (F-028)'
            : parentCause === 'unparseable'
              ? 'gh answered a parent that is not a usable issue number'
              : 'the read established no parent number';
      return {
        bad: `^ carries ${spec.join(', ')} and its sub-issue parent could not be read — ${why} — so the ${job} lane is refused on the label alone`,
        fix: [
          parentCause === 'capability'
            ? 'gh --version # upgrade until --json parent answers'
            : `gh issue view ${issue} --repo ${slug} --json parent # read it directly: until a parent is established, this pass is not safe`,
        ],
      };
    }
    // Both signals agree, so the conclusion is the flat rule and not a
    // redirect: triage is the on-ramp for work that ARRIVED, and this ticket
    // was produced by this project's own spec flow, which publishes
    // `ready-for-agent` itself. There is no readiness pass to send it to and
    // there never should have been one — a spec-born ticket is agent-ready by
    // construction, quizzed by the human who cut it. So the two repairs are the
    // only two things that can actually be true here.
    return {
      bad: `^ ${spec.join(', ')}, a sub-issue of #${parent} — a spec-born ticket is published ready-for-agent by construction, so a ${job} pass would re-decide a categorization its spec already fixed`,
      fix: [
        `gh issue edit ${issue} --repo ${slug} --add-label ${READY_LABEL} # if the ticket is sound, this is all it was ever owed`,
        `gh issue view ${issue} --repo ${slug} # if it is NOT sound, that is a defect in the ticket its spec produced: fix it there, and dispatch nothing`,
      ],
    };
  }

  return null;
}

/**
 * Has a triage pass already produced something a brief can distil?
 *
 * A comment count cannot answer: a `Necessary for:` ruling is a comment, and
 * treating it as a completed pass lets `--job brief` skip the necessity
 * assessment the triage child is assigned. The evidence is a recorded dispatch,
 * an unpublished draft, or a comment that carries this package's own triage
 * publication stamp — never "there is at least one comment".
 */
function triagePassEvidence({ store, root, slug, issue, comments = [] }) {
  const triageBase = { job: 'triage', repo: slug, issue };
  const passes = passesOf(store, draftDirFor(root), triageBase);
  if (passes.length > 0) return { kind: 'record', pass: passes[passes.length - 1] };
  const draft = readDraft(root, { ...triageBase, pass: 1 });
  if (existsSync(draft.path)) return { kind: 'draft', path: draft.path };
  for (const body of comments) {
    const found = publicationIn(body);
    if (found !== null && found.ok === true && String(found.job).trim().toLowerCase() === 'triage' && found.issue === String(issue)) {
      return { kind: 'publication', pass: found.pass };
    }
  }
  return null;
}


const waitCell = new Int32Array(new SharedArrayBuffer(4));
const defaultSleep = ms => Atomics.wait(waitCell, 0, 0, ms);

/**
 * How long `verifyPassRole` waits for the child's own receipts. Consumed
 * there; refused here at the reader so a retired name cannot become a silent
 * default. Empty is absence.
 *
 * THREE LAYERS, and the order is the same one every valued flag in the worker
 * family uses: an explicit `--wait` is the per-invocation override, then
 * `AX_TRIAGE_ROLE_WAIT` is the machine default, then the built-in.
 *
 * THE BUILT-IN IS 120, the worker family's number (`../worker/dispatch.mjs`),
 * and it was 30 — one proposition given two windows by two callers of the same
 * reader and the same `settled()` predicate. Measured 2026-09-02 on this
 * repository's own pile (#97): a healthy triage child was settled
 * CANNOT-ESTABLISH at 34.5 s, and reads ~60 s later found its pane live, the
 * mover `role=default` and the triage playbook applied. The window was the
 * whole defect; nothing about that child was wrong. 120 is not a fresh guess
 * either — it is the number the family beside this one already proves children
 * against, so a boot that fits there fits here.
 *
 * THE NUMBER IS MEASURED, not folklore, and this is the measurement the brief
 * for #97 handed to the implementation. 20 triage passes recorded on this
 * host's own dispatch store, each paired with the ONE child session whose first
 * task spec names its request id, timed from that dispatch's `worker-start`
 * `beganAt` to the later of its two receipts:
 *
 *   min 7.5s · median 44.7s · 13 of 20 over 30s · 6 of 20 over 120s
 *   (7.5, 18.7, 20.1, 20.2, 22.0, 22.2, 22.3, 35.7, 43.9, 44.1, 44.7, 46.8,
 *    63.9, 73.6, 524.0, 529.5, 534.5, 1411.2, 1416.9, 1423.1)
 *
 * TWO THINGS FOLLOW, and only the first is settled here. The old 30 s failed
 * the MEDIAN pass on this host, so it was never a window — it was a coin toss,
 * and #97 is what losing it looks like. 120 s covers 14 of 20 outright.
 *
 * The six past 120 s are a REPORTED FINDING, not a number this default is sized
 * to: their own session-boot-to-receipt time is ~3 s, so what is long is the
 * gap between `worker start` returning and the pane booting at all, which no
 * role-wait can shorten. Widening the window to cover them would pay that gap
 * serially, per pass, on every wave (see the verification loop below). `--wait`
 * is the operator's control for the wave that needs it; the built-in stays the
 * worker family's proven number.
 *
 * The override is a NUMBER, already validated by the caller that parsed it, so
 * this reader keeps exactly one job: refuse the retired name, and layer the
 * three sources.
 */
export function roleWaitOf(env, override = null) {
  const retired = env.AX_READY_ROLE_WAIT;
  if (retired !== undefined && retired !== '') {
    return { ok: false, from: 'AX_READY_ROLE_WAIT', to: 'AX_TRIAGE_ROLE_WAIT' };
  }
  if (override !== null) return { ok: true, wait: override };
  const value = Number(env.AX_TRIAGE_ROLE_WAIT ?? 120);
  return { ok: true, wait: Number.isFinite(value) && value >= 0 ? value : 120 };
}

/**
 * Prove the child-side effect, not the marker ax composed.
 *
 * A missing role cannot mutate — orca-model removes the tool surface and blocks
 * every tool call before the first provider turn — but the parent still needs
 * the exact refusal rather than a green "dispatch recorded" line.
 *
 * EACH PROPOSITION LATCHES SEPARATELY, and that is why this is two variables
 * and not one `proof` — the rule `../worker/verify.mjs` states at length, on
 * the reader both verbs share. `dispatchProof` answers non-null the moment the
 * session FILE exists, and that file exists as soon as the child boots: it then
 * carries only the boot `model_change` Orca writes, which has no mover, and no
 * role receipt at all. Measured 2026-08-27 on goodluckagency/ofmchat#101: a
 * loop that stopped reading at the first non-null object printed
 * `model omniroute/or-opus|` and `session unreadable`, exit 1, on a child that
 * was reading the issue with its role applied — and `ax worker gate` was the
 * only thing standing between that verdict and the re-dispatch of a live agent
 * (F-001). An absent receipt is not a refused receipt (F-028).
 */
function verifyPassRole({ request, job = 'triage', root, wait, env, sessionsRoot, store, proofFn, now, sleep }) {
  const expected = ROLE_BY_JOB[job];
  const deadline = now() + wait * 1000;
  let model = null;
  let role = null;

  // Settled means the model has a MOVER (`role !== ''`, i.e. someone selected
  // it) and the receipt exists in either polarity. A refusal is a real verdict
  // and stops the wait; an empty mover is indistinguishable from "not yet".
  const settled = () => model !== null && model.role !== '' && role !== null;

  for (;;) {
    let proof = null;
    try {
      // THE PATH, not its basename (#204). `root` is the whole checkout this
      // pass placed its child in, and `slugOf(root)` names one session
      // directory by construction — measured 2026-09-05, two directories on
      // this host end in `-ax`, so the basename made the resolver refuse and
      // the whole 120 s window was spent on a question no read inside it could
      // answer. The needle rides along for the one case exact-cwd cannot
      // serve: a session recorded under a different HOME than this process
      // sees, where the directory genuinely is not there.
      proof = proofFn({ needle: basename(root), cwd: root, request, env, sessionsRoot, store });
    } catch {
      proof = null;
    }
    // The session file is cumulative, so a later read supersedes an earlier
    // one — and a read that carries only one of the two fields must never
    // erase the other.
    if (proof !== null) {
      if (proof.model !== null) model = proof.model;
      if (proof.sessionRole !== null) role = proof.sessionRole;
    }
    if (settled() || now() >= deadline) break;
    sleep(250);
  }

  if (model === null && role === null) {
    bad(`CANNOT ESTABLISH — ${request}: no child-side role receipt appeared within ${wait}s`);
    note('The dispatch DID happen. Do NOT re-dispatch; inspect its recorded pane with `ax worker ls`.');
    // THE ONE EXIT THAT FIRES ON A HEALTHY CHILD, and until #97 it was the one
    // naming no repair — while the CANNOT-ESTABLISH below it named `ax worker
    // ls`. AGENTS.md: a `bad` without a `fix` is a finding neither an agent nor
    // a human can act on. Measured 2026-09-02: an operator met this line at
    // 34.5 s, and it cost three follow-up reads and a source read of this
    // function to establish that the child was fine and that a knob existed.
    //
    // Both repairs, because the verdict is point-in-time and the window is a
    // guess: the first RE-DERIVES the proof for exactly this pass, and it must
    // carry `--request` — every pass of a wave shares this needle, so the
    // unscoped read answers whichever session file was touched last. The second
    // widens the window that closed too early, and names the flag before the
    // env knob because a flag is discoverable from the command surface and the
    // env name is what nobody could find.
    // THE KEY IS THE CHECKOUT'S OWN SLUG, with its leading dashes stripped,
    // because the CLI refuses a proof value beginning with `-` before it reads
    // anything. `basename(root)` stood here until #204 and reproduced the
    // inability it repairs on any host holding a second checkout whose slug
    // ends in the same basename; a slug names one directory by construction.
    fix(`ax worker transcript --dispatch-proof ${slugOf(root, env).replace(/^-+/, '')} --request ${request}   # re-derive THIS pass's proof: the receipts may have landed since`);
    fix(`ax triage dispatch --wait <s>   # a wider window for a slow boot (or AX_TRIAGE_ROLE_WAIT=<s> for this machine); the pass above is unaffected`);
    return 'CANNOT-ESTABLISH';
  }

  const skills = role?.status === 'applied' ? role.skills : [];
  note(`proof ${request}: model ${model === null ? 'unreadable' : `${model.model}|${model.role}`} · session ${
    role === null
      ? 'unreadable'
      : role.status === 'refused'
        ? `${role.role}|REFUSED ${role.reason}`
        : `${role.role}|${skills.join(',') || 'no skills'}`
  }`);

  // THE VERDICT IS A POINT-IN-TIME PROOF, and the success line names the model
  // it proved so a later mover is legible against it. A quota fallback is
  // written when the FIRST PROVIDER CALL fails, which can be after the receipt
  // this loop settles on, so no bounded wait here can prove the selection final
  // — a fallback at wait+1s exists for every wait. What the channel does
  // instead is keep the evidence durable: `dispatchProof` reads the whole
  // session file and the LAST mover wins, so a later read sees a fallback this
  // line could not have seen, and a `fallback` mover observed at ANY time fails
  // below rather than passing.
  //
  // THE LATER READER IS `ax worker transcript --dispatch-proof <needle>
  // --request <id>`, and naming any other verb here is a false claim that cost
  // #97 a diagnosis: this sentence used to name `ax triage status`, which never
  // calls `dispatchProof` at all — it answers from the dispatch record, the
  // draft, the Orca mailbox and, for unfinished rows only, the pane cursor, and
  // stays usable on a machine with no Orca. It is the ONLY verb that reads the
  // session file, and `--request` is what lets it name one pass of a wave.
  if (
    model?.role === 'default' &&
    role?.status === 'applied' &&
    role.role === expected.role &&
    skills.includes(expected.skill)
  ) {
    ok(`${request}: ${expected.role} + ${expected.skill} reached the first turn on ${model.model}`);
    return 'VERIFIED';
  }

  if (model === null) bad(`${request}: model marker unproven (no model receipt)`);
  else if (model.role === '') {
    bad(`${request}: the child still runs its BOOT model after ${wait}s (${model.model}) — the spec marker did not apply`);
  } else if (model.role === 'fallback') {
    bad(`${request}: model marker unproven — the quota chain moved this session to ${model.model}, so the marker is not what decided`);
  } else if (model.role !== 'default') bad(`${request}: model marker unproven (${model.model}|${model.role})`);
  if (role === null) bad(`${request}: no session-role receipt`);
  else if (role.status === 'refused') {
    const missing = role.missingSkills.length === 0 ? '' : `; missing ${role.missingSkills.join(', ')}`;
    bad(`${request}: role ${role.role} refused — ${role.reason}${missing}`);
  } else if (role.role !== expected.role) bad(`${request}: expected ${expected.role}, got ${role.role}`);
  else if (!skills.includes(expected.skill)) bad(`${request}: the ${expected.skill} playbook was not applied`);
  fix('ax worker ls   # inspect the recorded pane and role receipt; do not re-dispatch');
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
    proofFn = dispatchProof,
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
  // `null` is "no flag", distinct from a flag whose value is missing — `value()`
  // answers `''` for a lone trailing flag, and that empty string has to reach
  // the same refusal as `--wait soon` rather than reading as absence.
  let waitFlag = null;

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
    else if (arg === '--wait') waitFlag = value();
    // No help branch: `runCli` answers the flag from the registry, anywhere in
    // this noun's argv, before the verb is reached (../cli.mjs, #89).
    else return usageError(`unknown argument "${arg}"`);
  }

  if (issues.length === 0) return usageError('no --issue given');
  for (const issue of issues) {
    if (!/^[1-9][0-9]*$/.test(issue)) return usageError(`--issue expects a number, got "${issue}"`);
  }
  if (job === '') job = 'triage';
  if (job === 'refine') return usageError(REFINE_REMOVED);
  if (!Object.hasOwn(ROLE_BY_JOB, job)) return usageError(`--job expects ${Object.keys(ROLE_BY_JOB).join('|')}, got "${job}"`);
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
  // Validated exactly as `../worker/dispatch.mjs` validates its own `--wait`,
  // with that verb's own words: one flag, one grammar, one message. Never
  // silently defaulted — a window that reads back as 120 because the value was
  // malformed is the same silence as the env knob nobody could discover, and
  // this whole flag exists because a window closed without saying why (#97).
  if (waitFlag !== null && !/^[0-9]+$/.test(waitFlag)) return usageError('--wait expects a number of seconds');
  const waitOverride = waitFlag === null ? null : Number(waitFlag);

  // ── 2. the machine, before the tracker ────────────────────────────────────
  const bin = runner ? null : resolve({ env });
  if (!runner && bin === null) return cannot('no Orca CLI on this machine — a triage session is an Orca session, so none can be created here');
  const run = runner ?? createRunner({ bin, exec });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open # start the runtime, then re-run this dispatch');

  const paths = repoPaths(cwd);
  if (!paths.root) return refuse('not inside a git repository — a triage session reads this checkout, so it needs one');

  const gh = args => exec('gh', args, paths.root);
  const slug = repo || repoSlug(gh);
  if (slug === '') return refuse('could not resolve the current repository', 'ax triage dispatch --repo <owner>/<repo>');

  // ── 3. the vocabulary the child is answerable to ──────────────────────────
  // Declared and unreadable is a refusal, exactly like `dispatch.contract`: a spec
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

  // ── 4. the caps, counted by live pane — this repository's, then the machine's
  // `terminal list` answers for every pane the runtime owns: this session's, an
  // editor's, an unrelated worker's. Counting those as capacity would let a busy
  // sidebar fence the work. So the count is the record↔pane association `ls`
  // reads liveness from — a dispatch record whose recorded handle is still
  // alive — which is what F-048 actually fixed: `worker-list` answered zero
  // while those same children were working.
  //
  // And it is counted TWICE (#88), because one number cannot answer both
  // questions: the store is host-global, so the machine total includes the panes
  // of every other checkout on this Mac. `dispatch.cap` gates this
  // repository's own; `dispatch.machineCap` gates the total, and only once an
  // operator has armed it (../worker/capacity.mjs).
  //
  // Fail-closed, like `ls` and for its reason: the caller is about to decide
  // whether it has room for another child. But `ls`'s own exit-3 list names an
  // unreadable terminal list and an unreadable store — NOT omitted hosts, which
  // it renders UNKNOWN and still answers. That distinction is measured: on this
  // Mac `hostScope.omittedHostIds` is non-empty, so refusing on it would refuse
  // every ordinary dispatch (the same fail-closed hole `gate` had, where 155 of
  // 218 panes were absent because of a stale runtime).
  const local = terminalInventory(run);
  if (!local.ok) return cannot(local.reason, 'orca open # the cap is counted, never assumed — it does not fail open');
  const store = defaultStore(env);
  const machineCap = machineCapOf(config, env);
  if (!machineCap.ok) {
    return refuse(
      `${machineCap.from} is set — the cap is declared in ax.config.json now, and this repository's own cap is what binds`,
      `unset ${machineCap.from} and declare ${machineCap.to} in ax.config.json if this machine needs a ceiling`,
    );
  }
  // The same liveness `ax worker ls` prints and `ax worker dispatch` refuses on,
  // from the one reader all three read (../worker/slots.mjs): every recorded
  // agent pane this runtime's list or a named host reports as up, keyed on the
  // pane and never on the dispatch that owns it. A fence counting only the local
  // list, beside a listing that counts a remote pane as capacity, promises a
  // number it does not enforce — which is #88 in a new place; a fence counting
  // the dispatch index misses the pane a repair phase recorded, which is #161.
  // The pass gates below read the same inventory, so a live remote rival is not
  // read as free either.
  const scopes = hostScopes(run, () => ({ ok: true, config }));
  const slots = livePanes({ store, local, scopes, repo: slug });
  // An ENOENT store is a machine that has never dispatched: zero is the true
  // count, and refusing would block the first dispatch ever. A store that
  // exists and cannot be read is the opposite — zero would be a lie.
  if (slots.reason !== '' && !slots.missing) {
    return cannot(`the dispatch store ${store} cannot be read, so live children cannot be counted: ${slots.reason.slice(0, 160)}`, `ls -ld ${store}`);
  }
  if (slots.unreadable.length > 0) {
    const first = slots.unreadable[0];
    return cannot(
      `${slots.unreadable.length} dispatch record(s) in ${store} cannot be read, so the number of live children cannot be established — an absence of information is not an absence of a child (F-028). First: ${first.file} — ${String(first.error).slice(0, 160)}`,
      `ax worker ls --store ${store} # see every record, then repair or remove the unreadable one`,
    );
  }
  const inventory = slots.inventory;
  const live = slots.live;

  // ── 4b. which PASS each issue is about to run ─────────────────────────────
  // The plan and its two anti-rival gates (F-001, F-028) live in
  // ./capacity.mjs; an outcome maps to this verb's own exit codes here.
  //
  // THE DISPATCH INDEX IS READ HERE AND NOWHERE ELSE IN THIS VERB (#161): the
  // rival gate asks which handles a PREVIOUS PASS's dispatch recorded, which is
  // a provenance question and stays a `worker-start` fact. The cap above asks
  // whether a pane is consuming a slot, and reads its own reader.
  const planned = passPlan({ store, root: paths.root, index: dispatchIndex(store), inventory, issues, job, slug, freshPass });
  if (!planned.ok) return planned.kind === 'refuse' ? refuse(planned.message, planned.repair) : cannot(planned.message, planned.repair);
  const plan = planned.plan;

  const newSessions = plan.filter(entry => !existsSync(join(store, `${requestFor({ job, repo: slug, issue: entry.issue, pass: entry.pass })}.json`)));
  // ONE read, and it decides the window every pass of this invocation gets:
  // the flag layers over the env here, so `verifyPassRole` consumes a number
  // and never re-derives it (a second reader is a second precedence order).
  const wait = roleWaitOf(env, waitOverride);
  if (!wait.ok) {
    // Reachable from the same place the wait is consumed: before any session
    // starts. Putting it only in verifyPassRole would start children first.
    return refuse(
      `${wait.from} is set — the umbrella is ax triage now, so the wait is ${wait.to}`,
      `unset ${wait.from} and export ${wait.to} instead`,
    );
  }
  const repoCap = repoCapOf(config);
  const room = capVerdict({ live, adding: newSessions.length, repo: slug, repoCap, machineCap: machineCap.cap });
  for (const line of capLines({ live, repo: slug, repoCap, machineCap: machineCap.cap })) note(line);
  for (const line of room.notes) note(line);
  for (const [host, scope] of scopes.unaskable()) {
    note(`host '${host}' could not be asked, so its panes are in neither count: ${scope.reason}`);
  }
  if (inventory.omitted) note('hosts are omitted from this terminal list: a child on one of them is UNKNOWN here, not counted');
  // An inability is exit 3, a full cap is exit 1 — this verb's own alphabet says
  // 1 means "the input was wrong and NOTHING was dispatched, fix it and re-run"
  // and 3 means "could not be established". A count that could not be read is
  // the second (../worker/capacity.mjs, ADR 0003).
  if (!room.ok) return room.kind === 'cannot' ? cannot(room.message, room.repair) : refuse(room.message, room.repair);

  // ── 5. every issue prechecked before any is dispatched ────────────────────
  section(`precheck — ${slug} (job: ${job})`);
  let blocked = false;
  const state = new Map();
  for (const issue of issues) {
    const meta = readIssue(gh, slug, issue, job);
    if (!meta.ok) {
      bad(`#${issue} UNREADABLE — ${meta.reason}`);
      // The routed lanes ask for `--json parent`, which an older gh refuses by
      // failing the whole view. Only one stderr is matched as that capability
      // gap, so the narrower read is what separates it from a token, a network
      // or a permission failure: both arrive here as a non-zero exit.
      fix(`gh issue view ${issue} --repo ${slug} --json state,title,comments # if this answers, the parent field is what failed`);
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
    // The routing question comes before every state question: a pass that should
    // never run in this lane is not made safe by having no comments yet.
    const routing = provenanceVerdict({
      job,
      issue,
      slug,
      labels: meta.labels,
      parent: meta.parent,
      parentCause: meta.parentCause,
      declared: config.triage?.provenance,
      text: meta.text,
    });
    if (routing !== null) {
      if (routing.admit) {
        if (job === 'brief') {
          const evidence = triagePassEvidence({
            store,
            root: paths.root,
            slug,
            issue,
            comments: meta.text?.comments ?? [],
          });
          if (evidence === null) {
            bad('^ a Necessary for: line admits a triage pass, not a brief — a comment is not a recorded draft or a published triage artifact');
            fix(`ax triage dispatch --issue ${issue} # run the triage pass first; brief distils that, it does not replace it`);
            blocked = true;
            continue;
          }
        }
        for (const line of routing.notes) note(line);
      } else {
        bad(routing.bad);
        for (const repair of routing.fix) fix(repair);
        blocked = true;
        continue;
      }
    }
    if (job === 'triage' && meta.comments > 0 && !force) {
      // WHICH refusal this is depends on whether a triage pass ever ran, and the
      // evidence is the same the `brief` job reads below: a dispatch record, or a
      // draft. The comment count cannot tell them apart — measured 2026-08-26 on
      // an issue whose single comment was a stale coordination note, with no
      // Triage Notes, no Agent Brief and still `needs-triage`. The refusal was
      // right; its repair was not. `--job brief` would have distilled a brief out
      // of a pass that never happened.
      //
      // It still fails CLOSED in both branches: a HUMAN verdict in those comments
      // is one this tool cannot see, so what changes is the repair, never the
      // refusal.
      const seen = { job: 'triage', repo: slug, issue };
      const triaged = passesOf(store, draftDirFor(paths.root), seen).length > 0;
      bad('^ F-030: this issue already carries comment(s), and the label cannot tell "never triaged" from "triaged, awaiting a human"');
      if (triaged) {
        note('  a full pass sent here re-measures finished work and returns a competing verdict');
        fix(`ax triage dispatch --issue ${issue} --job brief # the pass is recorded here, so distil it — not --force`);
      } else {
        note('  no triage pass is recorded here and no draft exists, so those comment(s) are not a pass this tool wrote');
        note('  read them first: a coordination note is not a verdict, and a human verdict is one this tool cannot see');
        fix(`ax triage dispatch --issue ${issue} --force # once you have read them and they are not a triage pass`);
      }
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
      const triagePasses = passesOf(store, draftDirFor(paths.root), triageBase);
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
      const specDir = draftDirFor(paths.root);
      const path = join(specDir, `${request}.spec.txt`);
      mkdirSync(specDir, { recursive: true });
      writeFileSync(path, `${spec}\n`);
      // `--tracker-repo` is RECORDED, never forwarded (ax-owned, like
      // `--because`): it is what places this pane in a repository. The dispatch
      // store is host-global, and `ax worker release` scopes by that key — a
      // record naming no repository is UNKNOWN and authorizes no close (F-028,
      // #83), so a pass dispatched without it hands `ax triage release` a pane
      // it can never free.
      code = startFn(
        ['--request', request, '--run', runId, '--spec-file', path, '--tracker-repo', slug, '--kind', job, ...(bin ? ['--orca', bin] : []), '--', '--worktree', 'current', '--agent', 'omp'],
        { env, runner: run },
      );
    }
    results.push({ issue, request, verdict: verdictOf(code) });
  }

  // Start the whole batch before waiting on any child. Triage sessions share
  // the current checkout, and each pass's record names the `ctx_…` Orca wrote
  // into the first turn of the one session it created, so the transcript
  // reader can distinguish them without a worktree per comment (#126 — the
  // request id in the child's prose was a prefix of its neighbours', and a
  // pass 2 named pass 1's draft path).
  //
  // THIS PASS IS SERIAL, and widening the window widened its worst case with
  // it: N children that never write a receipt pay up to N × window before the
  // summary prints. That is the accepted cost of the aligned default (#97), not
  // an oversight — `--wait` is the operator's control over it, and the reason
  // the flag is per-invocation rather than only an env knob.
  if (!dry) {
    for (const result of results) {
      if (result.verdict !== 'DISPATCHED') continue;
      result.verdict = verifyPassRole({
        request: result.request,
        job,
        root: paths.root,
        wait: wait.wait,
        env,
        sessionsRoot,
        store,
        proofFn,
        now,
        sleep,
      });
    }
  }

  // ── 8. summary ───────────────────────────────────────────────────────────
  // ADR 0003 — this verb's own alphabet, and the summary has to speak it too.
  // 1 is `refuse`: the input was wrong and NOTHING was dispatched, so running
  // again after fixing it is correct. 3 is `cannot`: a child IS running and its
  // effects could not be proven, so a re-run duplicates a live agent (F-001).
  // Printing CANNOT-ESTABLISH under exit 1 gave a caller the one code that
  // reads as "safe to retry" for the one state where retrying is the hazard.
  section('summary');
  let unproven = false;
  let failed = false;
  for (const { issue, verdict } of results) {
    note(`#${issue} ${verdict}`);
    if (verdict === 'CANNOT-ESTABLISH') unproven = true;
    else if (verdict !== 'VERIFIED' && verdict !== 'DRY') failed = true;
  }
  if (!dry) {
    note('each session wakes you when it reports — do not poll, and never run `orchestration check --wait`: the peer extension owns the only consuming loop on this Run');
    note('a report is a signal, not a verdict: the evidence is the draft it wrote, and nothing lands until you publish it');
  }
  return unproven ? 3 : failed ? 1 : 0;
}

const verdictOf = code => (code === 0 ? 'DISPATCHED' : code === 2 ? 'DUPLICATE' : code === 3 ? 'CANNOT-ESTABLISH' : 'REFUSED');

/**
 * State, comment count, title and labels in one read — plus, for every lane
 * that is routed by provenance, the sub-issue parent and the issue's own prose.
 *
 * EVERY LABEL-APPLYING LANE, and that used to be the retired readiness lane
 * only. The asymmetry is what let a triage pass start on a spec sub-issue: the
 * lanes that must refuse a spec-born ticket were the ones that never asked what
 * they were looking at. The routed set IS `LABEL_JOBS` rather than a second
 * list kept beside it — the second list had already drifted, so `--job brief`
 * read no labels and the gate ran on an empty set. See `provenanceVerdict`.
 *
 * LABELS FOR EVERY JOB, THE PARENT FOR THE ROUTED ONES. The contradiction rule
 * in `provenanceVerdict` is job-independent — no pass follows from two classes
 * on one ticket — and it can only hold if every lane sees the labels. Measured
 * 2026-09-02 on review of the findings class: labels were read in the routed
 * lanes only, so `--job custom` handed the gate an empty list and dispatched a
 * contradictory ticket. The parent read stays scoped to the routed lanes: it is
 * the expensive, capability-gated half, and only the spec branch consumes it.
 *
 * THE BODY TOO, ON THE SAME READ (#188). A finding is admitted on a necessity
 * justification written in the issue, so the routed lanes ask for `body` with
 * the labels — a second round-trip after seeing the class would be a second
 * chance to fail closed on a read the first one already had. The comments
 * field was already requested; each comment's `body` is what the admission
 * scans. An unanswered body or comment is unknown, never empty (F-028).
 *
 * The parent read is best-effort and advisory: a gh older than the sub-issues
 * API fails the WHOLE view when asked for the field (it does not answer with the
 * field missing), so the naive read would turn a capability gap into a refusal.
 * On that exact failure the read retries with the base fields and the parent
 * stays `undefined` — unknown, which is not `null`, confirmed absent (F-028).
 *
 * An unknown parent carries WHY it is unknown, because the three causes have
 * three different repairs: `capability` (this gh refused the field),
 * `absent` (the answer carried no `parent` key) and `unparseable`
 * (`parent.number` was not a safe issue number). Only the first is repaired by
 * upgrading gh.
 */
function readIssue(gh, repo, issue, job = 'triage') {
  const routed = LABEL_JOBS.has(job);
  const base = 'state,title,comments,labels';
  const fields = routed ? `${base},parent,body` : base;
  let out = gh(['issue', 'view', issue, '--repo', repo, '--json', fields]);
  let parentReadable = routed;
  if (routed && !out.error && out.status !== 0 && /unknown json field.*parent/i.test(String(out.stderr ?? ''))) {
    parentReadable = false;
    out = gh(['issue', 'view', issue, '--repo', repo, '--json', `${base},body`]);
  }
  if (out.error) return { ok: false, reason: `gh could not run: ${String(out.error.message ?? out.error)}` };
  if (out.status !== 0) {
    // The retry above matches ONE stderr. Every other non-zero exit used to be
    // reported as `not found in <repo>` — a guess, and since this diff widened
    // the parent-bearing read to every routed lane, a guess the default lane can
    // now reach where its old `state,title,comments` read would have answered.
    // A token, network or permission failure read as a missing issue sends the
    // operator to look for a ticket that is sitting right there, so the exit and
    // gh's own words travel instead.
    const detail = String(out.stderr ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    return {
      ok: false,
      reason: `gh issue view failed (exit ${out.status})${detail === '' ? ' and said nothing' : `: ${detail}`} — a non-zero exit is not evidence the issue is absent`,
    };
  }
  let body;
  try {
    body = JSON.parse(out.stdout);
  } catch {
    return { ok: false, reason: 'gh answered something that is not JSON' };
  }
  if (!Array.isArray(body.comments)) return { ok: false, reason: 'gh answered no comments array — an absent container is not an empty one' };
  const meta = { ok: true, state: String(body.state ?? ''), title: String(body.title ?? ''), comments: body.comments.length };
  if (!Array.isArray(body.labels)) return { ok: false, reason: 'gh answered no labels array — an absent container is not an empty one' };
  meta.labels = body.labels.map(label => String(label?.name ?? ''));
  if (routed) {
    if (!parentReadable) {
      meta.parent = undefined;
      meta.parentCause = 'capability';
    } else if (!Object.hasOwn(body, 'parent')) {
      meta.parent = undefined;
      meta.parentCause = 'absent';
    } else if (body.parent === null) meta.parent = null;
    else {
      const parent = Number(body.parent?.number);
      if (Number.isSafeInteger(parent) && parent > 0) meta.parent = parent;
      else {
        meta.parent = undefined;
        meta.parentCause = 'unparseable';
      }
    }
    meta.text = {
      body: Object.hasOwn(body, 'body') ? body.body : undefined,
      comments: body.comments.map(comment =>
        comment !== null && typeof comment === 'object' && Object.hasOwn(comment, 'body') ? comment.body : undefined,
      ),
    };
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
