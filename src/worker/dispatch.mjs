// `ax worker dispatch --issue <ref>` — a ticket becomes a working session, in one gesture.
// Raw retired config keys and the retired env knobs refuse before validation
// or mutation; config.mjs owns that refusal, with Slots as its repair.
//
// ADMISSION IS BY SLOTS ONLY (ADR 0005). No repository cap and no machine cap:
// a remote host — named by `--on <host>` or chosen when no `--on` is given —
// is admitted by its own Slots under its host lock (./host-placement.mjs), and
// `--on here` or a local `--worktree` reads no capacity at all and has no
// ceiling. A named host that cannot take the worker is refused; it never falls
// back to another host or to this Mac.
//
// WHY THIS EXISTS (measured 2026-08-14)
// Both halves already existed and the SEAM did not: something turns an issue into
// a bootstrapped worktree, and `ax worker start` issues a recoverable dispatch.
// Between them sat six steps that lived as PROSE in a skill — and prose is not
// executable, so every dispatch retyped them. Measured over five hand-run
// dispatches on the night of 2026-08-13/14, retyping cost: one STRANDED dispatch
// (creation flags passed for a worktree that already existed, which Orca refuses
// with `invalid_argument`); two briefs left sitting unsent in a composer, each
// rescued by a hand-typed Enter; one worktree announcing a dev host nothing
// served, which hung a child's e2e cone until it guessed the real one; one
// worktree with no agent context file at all, so nothing announced any host.
// The prose was itself wrong twice in those same 24 hours. Every step is checked
// here instead.
//
// WHAT THE PORT CHANGED, and it is most of the file
// The Bash carried its own provisioner: it discovered the repo's setup script by
// glob, re-ran it when the agent context file was missing, and cross-checked the
// announced URL against a project-specific shell function whose argument shape
// differed per repo (so exactly one repo got the check). None of that is here,
// because `ax worktree setup` owns provisioning and writes that context file,
// `ax worktree doctor` re-derives the same plan and compares it, and the served
// URL comes from the proxy probe that already reads a project's config. This verb
// asks setup to run and reads its verdict; habitability is no longer a second
// implementation that can disagree with the first.
//
// What genuinely could not move into an existing verb is here, and nothing in it
// names a project: the ticket adapters (./ticket.mjs), the remote host grounds
// (./hosts.mjs), the brief (./brief.mjs), what is prepared in the child's
// worktree (./child.mjs). Everything host- or project-shaped arrives from
// `ax.config.json`'s `dispatch` block, and a ground a project does not declare is
// NOT MEASURED and says so — a floor measured for one fleet, inherited by a repo
// that never declared it, is the same bug in a new place.
//
// THE ORDER IS THE CONTRACT
//   1. refuse on arguments alone — nothing has been read yet
//   2. the ticket: unreadable creates nothing, and an EMPTY body creates nothing
//      either unless --task names a different entry point
//   3. --needs-ref: a ref the work is DEFINED by is proven on origin first
//   4. placement: with no --on, the compute host with the most free slots
//      (./host-placement.mjs, operator Mac only, never the Mac itself); then
//      reuse | the repo's own tool | Orca, then `ax worktree setup`,
//      then prove Orca can SEE the selector a dispatch will use
//   5. what the child cannot fix for itself. The AX bundle its worktree registers
//      is the one that REFUSES — waited for while an install lands, because a
//      child that boots without it is a different agent than the brief addressed
//      (./child.mjs equipment). Lineage, the advisor mandate and the git identity
//      each degrade with an announcement instead, never silently.
//   6. the brief, as a FILE
//   7. `ax worker start`, whose STRANDED exit is REPLAYED here rather than
//      reported — the recovery is the ordinary path for a remote dispatch
//   8. verify: the marker applied WITH a role, and the pane emitting
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  dispatched, and the child verified (or --wait 0 asked for no proof)
//   1  refused, with a named reason — nothing was created
//   2  usage error
//   3  cannot establish. When the dispatch already happened the report says so
//      and names the recovery; do NOT re-dispatch, that is how a duplicate is born.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok, raw, section } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { PACKAGE_NAME, loadCheckoutConfig, repoPaths, retiredCapKnob } from '../config.mjs';
import { checkoutSkew, installCommand } from '../delegation.mjs';
import { setup as setupVerb } from '../worktree/setup.mjs';
import { terminalInventory } from './pane.mjs';
import { peerRun, peerSessionId } from './peers.mjs';
import { databaseArgs, placeLocal, placeRemote, remoteSelectorFor, remoteTreeOf, untilSeen } from './placement.mjs';
import { acquireHostLock, defaultStore, readHostLock, recordRepoNaming, staleClaim } from './record.mjs';
import { liveCount } from './slots.mjs';
import { readRetired, retiredLine } from './retired-hosts.mjs';
import { reportPathFor, reportPathWithin } from './report.mjs';
import { verify } from './verify.mjs';
import { lockWaitMs, start as startVerb } from './start.mjs';
import { emptyBodyRefusal, needsRef, normalizeSlug, readCommand, readTicket, readyAssignmentRefusal, ticketKind } from './ticket.mjs';
import { hostFor, proveHost, quote, repoIdFor } from './hosts.mjs';
import { capacityOf, countedConfig, harnessosSource, hostDeclarations, NONE, operatorMac, placeHost, sleepingHost, verdictOf, wakeHost } from './host-placement.mjs';
import { renderBrief } from './brief.mjs';
import { pinIdentity, untilEquipped, writeMandate } from './child.mjs';
// The landed facts this dispatch's notes carry, and the SHARED reader that
// scopes them. Membership has one owner — `specMembership` — and this verb is
// the seam that hands its answer to the landing derivation: two readers of
// "who is in this Spec" is how one of them starts including a ticket the other
// excludes (#195).
import { specMembership } from '../completion.mjs';
import { landedNotes } from './landed.mjs';
import { MODEL_CAPABILITIES, MODEL_MODES, modelPolicy, modelConfirmationQuestion } from './model-policy.mjs';
import { readModelConfirmation } from './model-confirmation.mjs';
// `gh` and `git`, run for real. Imported rather than re-declared: this exact
// default was dropped in a refactor once and no test noticed, because every test
// injects `exec` — so there is ONE of them (src/exec.mjs), and it has its own test.
import { defaultExec } from '../exec.mjs';
import { repoSlug } from '../gh.mjs';

const USAGE =
  'ax worker dispatch (--issue <ref> [--slug <s>] | --name <name>) [--task <text>] [--because <reason>] [--notes <file>] ' +
  '[--delivery <child|parent>] [--capability <routine|standard|deep>] [--model-mode <auto|manual|ask>] [--model-confirmation <ref>] ' +
  '[--model <alias>] [--agent <name>] [--on <host>] [--repo-id <id>] [--worktree <abs>] ' +
  '[--needs-ref <ref>] [--wait <s>] [--probe] [--dry-run]';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

/** The dispatch tick, shared by placement's selector poll and verify's proof loop. */
const tickOf = env => Math.max(1, Number(env.AX_DISPATCH_TICK ?? 2000));

/**
 * The request id every later gesture is keyed on: the store record, the stall
 * watcher's log, the `--resume` an operator is told to type. Lowercased and
 * collapsed so it is a filename and a branch fragment at once.
 */
export const requestIdFor = (issue, slug) =>
  `${issue}${slug ? `-${slug}` : '-work'}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The `owner/repo` a GitHub ticket lives in, read from its own URL — '' when
 * the tracker is not GitHub-shaped or the URL does not parse. Recorded on the
 * dispatch record (`--tracker-repo`, ax-owned) so the frontier can tell THIS
 * repository's records from another checkout's in the host-global store.
 */
export const trackerRepoOf = url => {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/.exec(String(url ?? ''));
  return match === null ? '' : match[1];
};

/**
 * The knobs this verb renamed with itself, REFUSED rather than read past.
 *
 * A retired name that is merely ignored becomes a silent default — the rule
 * `../triage/dispatch.mjs` states at its own reader, paid for when the triage
 * role-wait knob survived a rename in someone's shell. That knob has now been
 * renamed in both directions (`../triage/capacity.mjs` records why the refusal
 * is keyed on the retired spelling rather than on "the one that is not mine"),
 * which is exactly why these are refused and never read past. These four decide
 * how long a dispatch waits for a selector, for an install, and where the spec
 * file lands: read past, `AX_LAUNCH_SEE_WAIT=0` turns a two-second preview into
 * a two-minute one and the operator has no way to see why.
 *
 * Empty is absence, exactly as `capOf` reads it: an exported-but-empty variable
 * is a shell artefact, not an instruction.
 */
export const retiredKnobs = (env = {}) =>
  ['AX_LAUNCH_TICK', 'AX_LAUNCH_SEE_WAIT', 'AX_LAUNCH_EQUIP_WAIT', 'AX_LAUNCH_SPEC_DIR'].filter(name => (env[name] ?? '') !== '');

/**
 * The FLAGS this vocabulary retired, refused BY NAME rather than fallen through
 * as unknown arguments — the argument-lane twin of `retiredKnobs` above.
 *
 * 0.16.0 renamed both flags and published the contract that "every retired name
 * refuses with the replacement named rather than falling back silently". Three
 * layers paid it — the retired VERB (`worker launch` → `dispatch`, in
 * `../commands.mjs`), the retired ENV knobs (above, `capOf`, `roleWaitOf`) and
 * the retired CONFIG keys (`retiredConfigKeyFixes`, shared by `init` and
 * `doctor` so neither can name a repair the other does not). The flag layer did
 * not: `--brief` landed on `unknown argument "--brief"` and a usage line, which
 * names the wrong name and never the right one.
 *
 * Keyed on the VERB-AND-FLAG pair, because the same retired name has a
 * different repair per verb: `--brief` → `--notes` here, `--brief` →
 * `--oneline` on `ax triage status` (`../triage/index.mjs`, the second reader).
 * One source, two answers, so a third retired flag is one entry rather than two
 * edits in two files that can then disagree.
 *
 * A name absent from this map is NOT retired and buys no repair (F-028): it
 * keeps each verb's own `unknown argument "<arg>"` refusal, unchanged. Neither
 * verb ever ACCEPTS a retired name — the refusal is the whole deliverable.
 */
export const RETIRED_FLAGS = {
  'worker dispatch': { '--brief': '--notes' },
  'triage status': { '--brief': '--oneline' },
};

/** The live flag a retired one became, or '' when that verb never retired the name. */
export const retiredFlagRepair = (verb, flag) => RETIRED_FLAGS[verb]?.[flag] ?? '';

export function dispatch(argv = [], deps = {}) {
  // The admission lock a remote placement holds through the write-ahead of its
  // start (KTD3). Every return path releases it, whichever one is taken.
  const admission = { release: () => {} };
  try {
    return dispatchOnce(argv, deps, admission);
  } finally {
    admission.release();
  }
}

function dispatchOnce(
  argv,
  {
    resolve = resolveOrca,
    runner,
    exec = defaultExec,
    env = process.env,
    cwd = process.cwd(),
    sleep = sleepDefault,
    now = () => Date.now(),
    startFn = startVerb,
    setupFn = setupVerb,
    // The shared Spec-membership reader, injected so this verb's suite stays
    // offline. Its DEFAULT is the one implementation there is (#191): a second
    // one here would be the duplicate representation the ruling refused.
    membership = specMembership,
    sessionsRoot,
    // The machine answer placement depends on: only the operator Mac places a
    // dispatch that names no target (./host-placement.mjs).
    platform = process.platform,
    // HarnessOS's capacity report, read for real; the suite injects a fixture
    // of its contract. Read only for a remote host (KTD10).
    capacity = capacityOf,
    wake = wakeHost,
  },
  admission,
) {
  const usageError = (message, repair) => {
    process.stderr.write(`ax worker dispatch: ${message}\n${repair ? `\n  ${repair}\n\n` : ''}${USAGE}\n`);
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

  // ── 0. the environment, before the arguments ───────────────────────────────
  // Nothing has been read or created, and a knob under its retired name is the
  // one input this verb cannot honour and cannot see the effect of.
  const stale = retiredKnobs(env);
  if (stale.length > 0) {
    const one = stale.length === 1;
    return refuse(
      `${stale.join(', ')} ${one ? 'is' : 'are'} set, and this verb reads AX_DISPATCH_* now — ${one ? 'it' : 'they'} would be read past in silence`,
      `unset ${stale.join(' ')} and export ${stale.map(name => name.replace('AX_LAUNCH_', 'AX_DISPATCH_')).join(' ')} instead`,
    );
  }

  // ── 1. arguments alone ─────────────────────────────────────────────────────
  const flags = {
    issue: '',
    name: '',
    slug: '',
    run: '',
    notes: '',
    task: '',
    // WHO owns the shipping tail of this slice: the child (the default, and
    // every dispatch before this mode existed) or the session dispatching it.
    // A MODE, read from this flag alone — never inferred from the prose of a
    // note, which is the channel the brief places last and forbids from
    // displacing the contract above it.
    delivery: 'child',
    because: '',
    model: '',
    capability: '',
    modelMode: '',
    modelConfirmation: '',
    agent: 'omp',
    on: '',
    repoId: '',
    worktree: '',
    needsRef: '',
    wait: 120,
  };
  let probe = false;
  let dry = false;

  const NAMED = {
    '--issue': 'issue',
    '--name': 'name',
    '--slug': 'slug',
    '--run': 'run',
    '--notes': 'notes',
    '--task': 'task',
    '--delivery': 'delivery',
    '--because': 'because',
    '--model': 'model',
    '--capability': 'capability',
    '--model-mode': 'modelMode',
    '--model-confirmation': 'modelConfirmation',
    '--agent': 'agent',
    '--on': 'on',
    '--repo-id': 'repoId',
    '--worktree': 'worktree',
    '--needs-ref': 'needsRef',
    '--wait': 'wait',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--probe') probe = true;
    else if (arg === '--dry-run') dry = true;
    // No help branch: `runCli` answers the flag from the registry, anywhere in
    // this noun's argv, before the verb is reached (../cli.mjs, #89).
    else if (NAMED[arg] !== undefined) {
      // A valued flag with no value is a caller bug, and it is refused rather
      // than consumed: the Bash this ports had to guard the same thing, where a
      // lone trailing flag made the parse loop spin instead of stopping.
      i += 1;
      if (argv[i] === undefined) return usageError(`${arg} expects a value`);
      flags[NAMED[arg]] = argv[i];
    } else {
      // A retired flag is named, with its replacement, before the fall-through
      // can call it merely unknown. The value behind it is never consumed and
      // never read: the NAME is what refuses, so `--brief <path>` answers the
      // same whether the path exists or not.
      const repair = retiredFlagRepair('worker dispatch', arg);
      if (repair !== '') return usageError(`${arg} was retired and is not aliased — ${repair} is the flag now`, `pass ${repair} where you passed ${arg}`);
      return usageError(`unknown argument "${arg}"`);
    }
  }

  // `--run` is kept parseable ONLY to answer the operator who was told to pass
  // it. The Run is never a flag (see ./peers.mjs): it is the one this pane's own
  // receiver consumes, and any other value dispatches a child whose completion
  // report is delivered to a session that will never read it. Measured
  // 2026-08-24: this verb's own refusal prescribed `--run <run_id>`, an operator
  // minted one by hand from a session with no adapter at all, and three children
  // ran with no route home.
  if (flags.run !== '') {
    return usageError(
      '--run is not a dispatch input: the Run is the one this pane\'s receiver consumes, and naming another dispatches a child that reports into silence',
      'ax init   # then RESTART this session so its pane joins the peer registry, and drop --run',
    );
  }

  // `--because` is provenance on the dispatch record, and it has two legitimate
  // shapes: WITH `--task` it records why a ticket's own assignment was
  // overridden (R4/KTD3); ALONE it records why a ticket is being dispatched
  // AGAIN — KTD6's dead-route recovery, where a fresh `--slug` mints the fresh
  // request id, the ticket stays the assignment, and the reason is the one
  // sentence a later reader needs. Both land on the record root; neither ever
  // reaches the child (KD4).

  // Exactly one identity. `--issue` names work a tracker owns; `--name` names
  // work nothing owns yet. Both is not a richer dispatch, it is two identities for
  // one worktree, and neither is then the one later gestures are keyed on.
  if (flags.issue !== '' && flags.name !== '') {
    return usageError('--issue and --name are two identities for one worktree; pass exactly one');
  }
  if (flags.issue === '' && flags.name === '') return usageError('no --issue and no --name given');
  if (!/^[0-9]+$/.test(String(flags.wait))) return usageError('--wait expects a number of seconds');
  // A typo read leniently would default to the mode that SHIPS, putting a child
  // on a branch the dispatching session is already delivering.
  if (!['child', 'parent'].includes(flags.delivery)) {
    return usageError(`--delivery expects child or parent, not "${flags.delivery}"`);
  }
  if (flags.capability !== '' && !MODEL_CAPABILITIES.includes(flags.capability)) {
    return usageError(`--capability expects routine, standard or deep, not "${flags.capability}"`);
  }
  if (flags.modelMode !== '' && !MODEL_MODES.includes(flags.modelMode)) {
    return usageError(`--model-mode expects ${MODEL_MODES.join(', ')}, not "${flags.modelMode}"`);
  }
  if (argv.includes('--model') && !/^[^\s\[\]]+$/.test(flags.model)) {
    return usageError('--model expects one non-empty OMP selector without whitespace or brackets');
  }
  const wait = Number(flags.wait);
  // `here` is a synonym for local placement, the way Orca's own CLI reads it,
  // and it reads no capacity. NO TARGET is neither: `--on` absent and no local
  // `--worktree` means the compute host with the most Slots, chosen from
  // HarnessOS capacity on the operator Mac and refused anywhere else
  // (./host-placement.mjs, R2). A NAMED remote host is admitted by its own
  // Slots alone (`onHost`, KTD10). The Mac takes a worker only when the
  // operator names it.
  let on = flags.on === 'here' ? '' : flags.on;
  const placing = flags.on === '' && flags.worktree === '';
  const onHost = on;

  const named = flags.name !== '';
  const kind = named ? null : ticketKind(flags.issue);
  if (!named && kind === null) {
    return usageError(`--issue expects a Linear ref (ABC-123) or a GitHub issue number, not "${flags.issue}"`);
  }
  if (placing && flags.repoId !== '') {
    return usageError('--repo-id names a repository on ONE host, and a dispatch with no --on has not chosen its host yet', 'pass --on <host> with --repo-id');
  }
  if (placing && !operatorMac(platform)) {
    return refuse(
      `a dispatch with no --on is placed by capacity from the operator Mac only, and this machine is ${platform} — a worker lands where somebody named it or where capacity chose it, never by default on whatever ran the command`,
      'ax worker dispatch … --on here   # this machine, or --on <host> for a declared host',
    );
  }
  if (named) {
    // The name IS the request id, and the request id is a directory name under
    // `.worktrees/` and a branch fragment. Two properties have to hold, and
    // neither survives a round-trip through `requestIdFor`:
    //
    //   INJECTIVE. That function lowercases and collapses every run of unusable
    //   characters to one `-`, so `My Feature`, `my/feature` and `my@@feature`
    //   all become `my-feature`. Two names would key one record, one directory
    //   and one branch, and the second dispatch would place a child into the
    //   first one's tree.
    //
    //   A PLAIN SEGMENT. `.` and `..` pass a round-trip unchanged (`..` becomes
    //   `..-work`, and stripping the suffix gives `..` back), which makes
    //   `.worktrees/<request>` resolve to the worktree base or its parent. A
    //   trailing dot survives too, and is a name no filesystem agrees about.
    //
    // So the rule is stated as a pattern instead: first and last character
    // alphanumeric, single separators between. It is also the answer to "what may
    // I type", which a round-trip could never be.
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(flags.name)) {
      const suggestion = requestIdFor(flags.name, '')
        .replace(/-work$/, '')
        .replace(/[^a-z0-9]+$/, '')
        .replace(/^[^a-z0-9]+/, '');
      return usageError(
        `--name is the request id itself, so it must be lowercase alphanumerics with single . _ - between them: "${flags.name}" is not`,
        suggestion === '' ? undefined : `ax worker dispatch --name ${suggestion}`,
      );
    }
    // The name carries the whole identity; a slug on top of it is a second knob
    // on one name, and `<name>-<slug>` is how two names become one request.
    if (flags.slug !== '') return usageError('--slug belongs to a ticket ref; with --name the name is the slug');
  }
  if (flags.notes !== '' && !existsSync(flags.notes)) {
    // Checked before anything is read or created: a notes file pointing at
    // nothing sends a child into a wave whose findings it cannot see (2026-08-01,
    // three worktrees that never read theirs), and the cheapest moment to say so
    // is now. The flag is `--notes` rather than `--brief` because Brief has one
    // meaning in this vocabulary — the Agent Brief comment on an inbound issue —
    // and wave memory is not it.
    return refuse(`--notes file unreadable: ${flags.notes}`);
  }

  const { slug, note: slugNote } = normalizeSlug(flags.issue, flags.slug);
  if (slugNote) note(slugNote);
  if (kind === 'linear' && slug === '' && flags.worktree === '') {
    return refuse(
      'a Linear ref carries no branch name, so --slug is required: nothing here invents the name a worktree and a branch will be searched for later',
      `ax worker dispatch --issue ${flags.issue} --slug <slug>`,
    );
  }

  // A name IS the request, verbatim: that is what makes distinct names distinct
  // requests. A ticket ref goes through the normaliser, which is injective on the
  // two ref shapes `ticketKind` accepts.
  //
  // WHOSE RECORD IS IT. The store is host-global and a request id carries no
  // repository, so "a record with this name exists" does not mean "this
  // checkout's work is already recorded". `--resume` replays the RECORDED
  // policy, placement and Run, so handing that repair out for another
  // repository's record aims this caller's mutation at a foreign consumer —
  // the collision `ax worker start` already refuses at claim time
  // (./start.mjs, measured on flosrn/ax 2026-09-03). This fence runs first, so
  // it answers the same question the same way, and reads the caller's identity
  // from `gh` BEFORE the configuration is parsed: a checkout whose
  // ax.config.json is broken mid-flight must still be told to resume its own
  // work rather than recompute it.
  const paths = repoPaths(cwd);
  const request = named ? flags.name : requestIdFor(flags.issue, slug);
  const recorded = join(defaultStore(env), `${request}.json`);
  if (existsSync(recorded)) {
    const caller = repoSlug(args => exec('gh', args, paths.root ?? cwd));
    let naming;
    try {
      naming = recordRepoNaming(recorded);
    } catch (error) {
      naming = { state: 'unreadable', repo: '', detail: String(error) };
    }
    if (naming.state === 'malformed' || naming.state === 'unreadable') {
      // Absence is not permission (F-028): a record this dispatch cannot read
      // is an owner it cannot name, and neither repair below is true of it.
      return cannot(
        `dispatch ${request} is already recorded, and its record cannot be attributed: ${naming.detail}`,
        `ax worker start --show --request ${request}   # read it, then resume it or dispatch a distinct name`,
      );
    }
    if (caller === '' || naming.state === 'none') {
      return cannot(`matching repository ownership cannot be established for recorded dispatch ${request}`, `ax worker start --show --request ${request}   # inspect and establish both record and checkout ownership before dispatching`);
    }
    if (naming.state === 'named' && caller !== '' && naming.repo.toLowerCase() !== caller.trim().toLowerCase()) {
      return refuse(
        `request ${request} is already recorded by another repository (${naming.repo}) — the store is host-global and request ids carry no repository, so this is a name collision, not a resume`,
        named
          ? 'ax worker dispatch --name <distinct-name>   # mints a request id the other repository\u2019s record does not hold'
          : `ax worker dispatch --issue ${flags.issue} --slug <distinct-name>   # mints a request id the other repository\u2019s record does not hold`,
      );
    }
    // Matching ownership is established before exposing the recorded decision.
    //
    // `--dry-run` is the READ of a dispatch, and the honest answer to "what
    // would this do" for work already recorded is the decision ON THE RECORD —
    // never a recomputation against a configuration that has moved, and never a
    // refusal that hides the recorded decision behind its repair. So the read
    // is served by the reader that already exists: `ax worker start --show`
    // prints this record, and printing it a second way here would be a second
    // reading of one file that could disagree with the first.
    if (dry) return startFn(['--show', '--request', request], { env, runner });
    // Only a positively empty claim from another Run may proceed to start(),
    // which rechecks ownership and emptiness under its existing claim lock.
    // This read is not takeover authority; a completed dispatch stays frozen.
    let reclaimable = false;
    const callerRun = peerRun(env);
    if (callerRun !== '' && naming.state === 'named' && caller !== '') {
      try {
        reclaimable = staleClaim(recorded, callerRun).stale;
      } catch {
        // Unreadable evidence cannot authorize recomputation or takeover.
      }
    }
    if (!reclaimable) {
      return cannot(`dispatch ${request} is already recorded; its model policy and placement must not be recomputed`, `ax worker start --resume --request ${request}`);
    }
  }

  const loaded = loadCheckoutConfig({ root: paths.root, main: paths.main });
  if (loaded.retired) return refuse(loaded.retired.problem, loaded.retired.fix);
  const retiredCap = retiredCapKnob(env);
  if (retiredCap) return refuse(retiredCap.problem, retiredCap.fix);
  if (!loaded.exists || loaded.errors.length > 0) {
    // The same refusal `ax worktree setup` prints, and the same #84 correction:
    // a checkout publishing another ax than the one running earns the repair
    // that applies — its own copy — instead of "edit ax.config.json".
    const skew = loaded.exists ? checkoutSkew({ root: paths.root }) : null;
    return refuse(
      loaded.exists
        ? `${loaded.errors.length} problem(s) in ax.config.json: ${loaded.errors[0]}${skew === null ? '' : ` — ${skew.finding}`}`
        : 'no ax.config.json — a dispatch reads this project\u2019s entry point, contract and hosts from it',
      skew === null ? 'ax init   # in the primary checkout' : skew.repair,
    );
  }
  const config = loaded.config;
  const dispatchConfig = config.dispatch ?? {};

  // ── the ask mode's own two grounds, established BEFORE anything is created ──
  // The mode is knowable from the flag and this project's config alone, so both
  // answers below are argument errors and both belong before the ticket is read
  // and before a worktree, a record or a pane exists.
  //
  // A STRAY APPROVAL IS A USAGE ERROR, on EVERY path. An approval reference in
  // any other mode is an input this verb cannot honour, and reading past it in
  // silence would file a dispatch as though a question had gated it.
  const effectiveMode = flags.modelMode || String(dispatchConfig.modelMode ?? '');
  if (flags.modelConfirmation !== '' && effectiveMode !== 'ask') {
    return usageError(
      `--model-confirmation is the answer to a --model-mode ask question, and this dispatch is ${effectiveMode === '' ? 'in no ask mode' : `in ${effectiveMode} mode`} — an approval no question gated would be filed as though it had`,
      'ax worker dispatch … --model-mode ask --model-confirmation <session.jsonl#toolCallId>',
    );
  }
  // AND THE SCOPE THE ANSWER WILL BE READ UNDER. `readModelConfirmation` binds
  // the reference to THIS session's own transcript, which takes two grounds it
  // cannot invent: where the runtime writes sessions, and which session is ours.
  // Neither is discoverable later — the sessions root is this verb's injected
  // seam or the environment, and the session id is the peer registry's
  // (./peers.mjs) — so an ask dispatch that cannot name its own session refuses
  // now, with nothing created, rather than after a worktree exists.
  let confirmationScope = null;
  if (effectiveMode === 'ask' && !dry) {
    const root = sessionsRoot || env.AX_SESSIONS_ROOT || (env.HOME ? join(env.HOME, '.omp', 'agent', 'sessions') : '');
    if (root === '') {
      return cannot(
        'ask mode reads the answer out of a transcript under the runtime\u2019s sessions directory, and no HOME names one here',
        'AX_SESSIONS_ROOT=<dir> ax worker dispatch … --model-mode ask',
      );
    }
    const sessionId = peerSessionId(env);
    if (sessionId === '') {
      return cannot(
        'ask mode attributes the answer to THIS session, and this pane publishes no session id — so a choice made in any pane on this machine would read as this one\u2019s',
        'ax init   # register the installed adapter in .omp/settings.json, then RESTART this session so its pane publishes its session id',
      );
    }
    confirmationScope = { sessionsRoot: root, sessionId };
  }

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) {
    return cannot('no Orca CLI on this machine, so neither the ticket nor a dispatch can be read here', 'ORCA_CLI_COMMAND=<binary> ax worker dispatch …');
  }
  const run = runner ?? createRunner({ bin });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # start the runtime, then re-run this dispatch');

  // ── 2. the ticket, when there is one ───────────────────────────────────────
  // `--name` dispatches work no tracker owns. There is nothing to read, so there
  // is also no title, no url, no state and no body — and every later step that
  // would have used them has to say so rather than render an empty field.
  const ticket = named ? null : readTicket(flags.issue, { kind, run, exec });
  if (ticket !== null && !ticket.ok) {
    return cannot(ticket.reason, `${kind === 'linear' ? 'orca linear issue' : 'gh issue view'} ${flags.issue}   # read it by hand first`);
  }
  // A closed ticket has nothing to dispatch, and this is the verb's own check:
  // `ax frontier` already excludes `no-longer-open`, but the `--slug` +
  // `--because` path reaches here without the frontier. Measured 2026-09-03:
  // #78, closed by the operator at 05:19Z, dispatched at 13:xx — the child
  // refused at its decision gate, posted nothing, and a pane was minted and
  // released for a ticket nobody could work.
  // The repair is the tracker's: `ax frontier` reads GitHub only (it lists by
  // label through `gh`), so a closed Linear ticket is sent back to Linear. And
  // a state the tracker did not answer is UNKNOWN, never open: absence is not
  // permission to mint a worktree, a task and a pane (AGENTS.md).
  const readByHand = kind === 'linear' ? `orca linear issue ${flags.issue} --json` : `gh issue view ${flags.issue} --json state`;
  if (ticket !== null && ticket.closed === null) {
    return cannot(
      `${ticket.id} answered no workflow state type this verb knows${ticket.state ? ` (state "${ticket.state}")` : ''}, so whether it is closed cannot be established`,
      `${readByHand}   # read its state by hand; dispatch again once the tracker names it`,
    );
  }
  if (ticket !== null && ticket.closed) {
    return refuse(
      `${ticket.id} is closed (${ticket.state}) — nothing to dispatch`,
      kind === 'linear'
        ? `${readByHand}   # its state and who closed it; dispatch an open ticket, or reopen this one first`
        : `ax frontier   # the takeable set; a closed ticket is never in it`,
    );
  }

  // ── the class, and who decided it ──────────────────────────────────────────
  // `auto` is the default, so a project that states no mode dispatches exactly
  // as it did before modes existed. `manual` carries the class the operator
  // named. `ask` decides nothing here: it prints the question, and only a
  // verified answer from THIS session's own transcript authorizes a class.
  const policyOptions = {
    model: flags.model,
    capability: flags.capability,
    models: dispatchConfig.models,
    floors: dispatchConfig.modelFloors,
    labels: ticket?.labels,
    because: flags.because,
    mode: effectiveMode || undefined,
  };
  let policy;
  try {
    policy = modelPolicy(policyOptions);
    if (policy.pending === true) {
      const question = modelConfirmationQuestion(request, policy);
      if (dry) {
        // The READ of an ask dispatch is the question it would pose. Printed as
        // the native tool's own argument shape, so the orchestrator asks the
        // question ax built rather than retyping one that would hash differently.
        raw(`model confirmation: ${JSON.stringify({ questions: [question] })}`);
        note('model policy: ask — undecided; no class chosen and no worker created');
        return 0;
      } else {
        // THE WHOLE QUESTION, not just its id: the id hashes the decision and
        // none of the words, so an ask that carried it while asking something
        // else — other prose, a superset menu, another recommendation — would
        // otherwise read as approval of this dispatch.
        const approval = readModelConfirmation(flags.modelConfirmation, {
          questionId: question.id, choices: policy.classes, expectedQuestion: question, ...confirmationScope,
        });
        if (!approval.ok) {
          return cannot(approval.reason, 'run this dispatch with --dry-run, ask its question with the ask tool, then pass --model-confirmation <session.jsonl#toolCallId>');
        }
        policy = modelPolicy({ ...policyOptions, approval: { capability: approval.choice, reference: approval.reference } });
      }
    }
  } catch (error) {
    return refuse(String(error.message ?? error), 'check dispatch.models, the mode and the class this dispatch asks for');
  }
  // FAIL-CLOSED AT THE BOUNDARY. `--dry-run` is the only path that may hold an
  // undecided policy, and it creates nothing. Anything else reaching placement
  // with a pending decision would place on the RECOMMENDATION — the one outcome
  // ask mode exists to prevent — so the state is refused rather than trusted to
  // be unreachable.
  if (policy.pending === true && !dry) {
    return cannot(
      `the class for ${request} was never chosen: ask mode places nothing without a verified answer`,
      'ax worker dispatch … --model-mode ask --model-confirmation <session.jsonl#toolCallId>',
    );
  }
  note(redactSecrets(`model policy: ${policy.mode} ${policy.capability} -> ${policy.selector} — ${policy.reason}`));
  const entry = dispatchConfig.entry ?? '';
  if (named) {
    // With a ticket, `dispatch.entry` composes an instruction from the ref
    // (`<entry> GAP-353`) and the ticket body carries the rest. With no ticket
    // there is no ref to compose and no body to fall back on, so the instruction
    // must be given explicitly — a child dispatched on `<entry> ` alone is the
    // 2026-08-01 failure with better spelling.
    if (flags.task === '' && flags.notes === '') {
      return refuse(
        `--name carries no ticket, so nothing here knows what "${flags.name}" means: the instruction has to be given`,
        `ax worker dispatch --name ${flags.name} --task "<instruction>"   # or --notes <file>`,
      );
    }
  } else if (flags.task === '' && entry === '') {
    // The repair is the JSON, not the key path: `dispatch` may not exist in this
    // file at all, so `dispatch.entry "<verb>"` names a setting without saying
    // where it goes, and is accepted by nothing if pasted as printed.
    return refuse(
      'this project declares no dispatch entry point, so there is no instruction to give the child',
      'ax.config.json: { "dispatch": { "entry": "<verb>" } }   # or pass --task "<instruction>"',
    );
  }
  // A project's `entry` is its SHIPPING verb by construction — the one command
  // its agents answer to, and every one measured so far reads "take this ticket
  // end to end". Composing it for a slice the dispatching session delivers puts
  // "ship it" on line one of a brief whose contract says the opposite, and ax
  // cannot invent this project's implementation-only verb. So the instruction
  // is asked for rather than guessed.
  if (flags.delivery === 'parent' && flags.task === '') {
    return refuse(
      'this project\u2019s dispatch entry is its SHIPPING verb, so --delivery parent needs --task: nothing here can invent an implementation-only instruction',
      named
        ? `ax worker dispatch --name ${flags.name} --delivery parent --task "<instruction>"`
        : `ax worker dispatch --issue ${flags.issue}${slug === '' ? '' : ` --slug ${slug}`} --delivery parent --task "<instruction>"`,
    );
  }
  const instruction = named ? flags.task || `${entry} ${flags.name}`.trim() : flags.task || `${entry} ${ticket.id}`;

  const emptyBody = named ? '' : emptyBodyRefusal({ bodyLength: ticket.bodyLength, task: flags.task, id: ticket.id });
  if (emptyBody) return refuse(emptyBody, `ax worker dispatch --issue ${flags.issue} --task "<instruction> ${ticket.id}"`);

  // The tracker's own completeness assertion, read BEFORE anything is created —
  // and after the empty-body gate, which owns the one shape where the label
  // cannot be true (R4/KTD3). `--name` carries no ticket and therefore no label.
  const overridden = named
    ? ''
    : readyAssignmentRefusal({
        labels: ticket.labels,
        task: flags.task,
        because: flags.because,
        id: ticket.id,
        entry,
        bodyLength: ticket.bodyLength,
      });
  if (overridden) {
    return refuse(
      overridden,
      `ax worker dispatch --issue ${flags.issue}${slug === '' ? '' : ` --slug ${slug}`} --task ${quote(flags.task)} --because '<reason>'`,
    );
  }

  // ── 3. everything else knowable BEFORE anything is created ─────────────────
  // A dispatch that can never be issued must not leave a worktree, a mandate, a
  // pinned identity or a lineage behind: exit 1 says nothing was created, and it
  // has to be true. So the remote Slot measurement, the ref, the contract, the
  // Run and the operator's notes — all knowable now — are settled before
  // placement.
  //
  // The repository is read HERE, once, because it is what the record names
  // (`--tracker-repo`, §7). It admits and refuses nothing: no repository count
  // gates a dispatch (R1).
  const trackerRepo = repoSlug(args => exec('gh', args, paths.root ?? cwd)) || (named ? '' : trackerRepoOf(ticket.url));

  // These refusals spend nothing, so they run before a named sleeping host is
  // woken: a dispatch refused afterward would have resumed a billable host for
  // nothing.
  if (flags.needsRef !== '') {
    const proven = needsRef(flags.needsRef, { exec, cwd });
    if (!proven.ok) return refuse(proven.reason, 'git ls-remote --refs origin   # what origin actually carries');
    note(`${flags.needsRef} resolves on origin, so a child on any clone of it is defined by something it can reach`);
  }

  const contract = readContract(dispatchConfig, paths.root);
  if (contract.missing) {
    return refuse(
      `dispatch.contract names ${contract.path}, which cannot be read — a brief pointing at nothing sends a child to improvise (2026-08-01)`,
      `ls ${contract.path}   # or drop dispatch.contract to use the mechanics-only contract`,
    );
  }

  // A REMOTE HOST IS MEASURED FIRST (KTD10): its report, then the live workers
  // on it, through the one reader `ax worker ls` prints (./slots.mjs). The
  // report comes before the count because the count needs it: a pane placed
  // earlier on a compute host this repository never declared is asked of that
  // host through the declaration capacity carries. A named host's count asks
  // that host alone, so an unreachable sibling is never even asked (R5).
  // `--on here` and a local `--worktree` measure nothing (R4).
  let fleet = null;
  let declarations = {};
  let counted = config;
  let measured = null;
  if (placing || onHost !== '') {
    const source = harnessosSource({ env, config });
    if (!source.ok) return cannot(source.reason, source.repair);
    fleet = capacity({ source: source.path });
    if (!fleet.ok) return cannot(fleet.reason, fleet.repair);
    const namedEntries = fleet.capacity.hosts.filter(entry => entry?.host === onHost);
    if (onHost !== '' && namedEntries.length === 1 && sleepingHost(namedEntries[0]) && namedEntries[0].cordoned !== true) {
      // A retirement is the operator's; a malformed policy is an inability,
      // never no retirement (F-028). Either refuses before the host is woken.
      const policy = readRetired(defaultStore(env));
      if (!policy.ok) return cannot(policy.reason, policy.repair);
      const retired = policy.hosts.get(onHost);
      if (retired) return refuse(`${retiredLine(retired)}; a retired host is never woken`, `ax worker unretire-host ${onHost}   # if it may take workers again`);
      if (dry) {
        process.stderr.write(`ax: would wake ${onHost}; placement requires awake capacity\n`);
        return 0;
      }
      process.stderr.write(`ax: waking ${onHost}…\n`);
      const woken = wake({ source: source.path, host: onHost });
      if (!woken.ok) return refuse(`'${onHost}' could not be woken: ${woken.reason}; a named host never falls back to another host or to this Mac`, `bun ${join(source.path, 'scripts', 'capacity.ts')} wake ${onHost} --json`);
      fleet = capacity({ source: source.path });
      if (!fleet.ok) return cannot(fleet.reason, fleet.repair);
    }
    declarations = hostDeclarations(fleet.capacity, dispatchConfig.hosts);
    const own = declarations[onHost] ?? dispatchConfig.hosts?.[onHost];
    counted = onHost === '' ? countedConfig(config, declarations) : { ...config, dispatch: { ...dispatchConfig, hosts: own === undefined ? {} : { [onHost]: own } } };
    if (onHost !== '') {
      const declared = hostFor(counted, onHost);
      if (!declared.ok) return refuse(declared.reason, `ax.config.json: dispatch.hosts.${onHost}.ssh "<target>"`);
    }
    measured = measureLive({ run, env, config: counted, only: onHost });
    // An unreadable store or record is exit 3, never a count of zero (F-028):
    // the host's live workers are what its Slots are spent from.
    if (measured.cannot) return cannot(measured.cannot, measured.repair);
    for (const line of measured.lines) note(line);
  }
  // THE HOST LOCK (KTD3): taken on the admitted host only once it is proven
  // (§7), its count read again under it — a start another dispatch wrote ahead
  // meanwhile now spends its Slot — and held until this dispatch's own start is
  // written ahead. A live holder on this machine is waited out; anything else
  // that keeps it is an inability, named with the holder's own repair.
  const admit = host => {
    const store = defaultStore(env);
    let lock;
    try {
      lock = acquireHostLock(store, host, { waitMs: Number(env.AX_LOCK_WAIT_MS ?? lockWaitMs), sleep, clock: now });
    } catch (error) {
      return { cannot: `the admission lock of '${host}' could not be taken: ${String(error?.message ?? error)}`, repair: `ls -ld ${join(store, 'hosts')}` };
    }
    if (!lock.held) {
      let holder = null;
      try {
        holder = readHostLock(store, host);
      } catch {
        // The refusal below still names the lock; the holder is a courtesy.
      }
      return {
        cannot: `the admission lock of '${host}' could not be taken: ${lock.reason}${holder === null ? '' : ` — ${holder.text}`}`,
        repair: holder?.repair ?? `ax worker hosts ${host}   # then re-run this dispatch`,
      };
    }
    const again = measureLive({ run, env, config: counted, only: host });
    if (again.cannot) {
      lock.release();
      return { cannot: again.cannot, repair: again.repair };
    }
    return { lock, count: again.hosts.get(host) ?? NONE };
  };

  // ONE source, and it is not an argument (./peers.mjs). An empty entry means
  // nothing in this session consumes a Run, so there is no address a child's
  // completion report could be sent to — measured 2026-08-24 on ofmchat, where
  // `node_modules/@flosrn/ax` was installed and no `.omp/settings.json` named
  // it, so the machine-wide bridge stood down and the project loaded nothing.
  // Every session in that checkout had no adapter, which is why this reads as a
  // resume defect and is not one.
  const runId = peerRun(env);
  if (runId === '') {
    bad(redactSecrets('CANNOT ESTABLISH — no Run to own the Task: this session is in no peer registry, so nothing here consumes a Run and no child dispatched from it could report back'));
    fix('ax init   # register the installed adapter in .omp/settings.json, then RESTART this session so its pane joins the registry');
    note('A Run minted by hand does not help: the report would be addressed, accepted, and read by nobody.');
    return 3;
  }

  let operator = null;
  if (flags.notes !== '') {
    try {
      operator = { name: basename(flags.notes), text: readFileSync(flags.notes, 'utf8') };
    } catch (error) {
      return refuse(`--notes ${flags.notes} could not be read: ${String(error.message ?? error)}`);
    }
  }

  // ── the DERIVED half of the notes channel ──────────────────────────────────
  // The landed pull request, the SHA that landed and the surfaces it moved, for
  // every established landing of this ticket's Spec — read here rather than
  // retyped by the orchestrator out of each Report (#195). It is a READ: it
  // creates nothing, it writes nothing (the operator's own file is opened
  // read-only above and never rewritten), and a tracker that cannot answer
  // about a SIBLING never stops this dispatch — the inability travels into the
  // brief and onto this receipt instead, because a missing section is
  // indistinguishable from "this Spec landed nothing".
  //
  // `--name` carries no ticket, and a Linear ref carries no GitHub parent edge:
  // neither names a Spec this read can scope, so neither derives anything.
  const landed = landedNotes({
    ticket: named || kind !== 'github' ? null : { number: flags.issue, repo: trackerRepo },
    slug: trackerRepo,
    gh: args => exec('gh', args, paths.root ?? cwd),
    git: args => exec('git', args, paths.main ?? paths.root ?? cwd),
    membership,
  });
  for (const line of landed.notes) note(line);
  // A CLASS THAT DECIDED NOTHING IS A FINDING, not a note. The opt-out is
  // ratified and the worker is dispatched, so this does not refuse — but the
  // policy line reads as a route somebody chose, and on gapila #2061 that
  // cost 22 minutes of live implementation before the operator spotted by eye
  // that `deep` had landed on the interactive default. Printed HERE, after the
  // non-mutating refusal gates: an earlier emission claimed “the dispatch still
  // happens” on receipts that then returned without creating a worker. The
  // repair is the JSON rather than the key path, for the reason `entry` states:
  // `dispatch` may not exist in that file at all.
  if (policy.unrouted === true) {
    bad(`the ${policy.capability} class routed nowhere: this project declares no dispatch.models, so ${policy.selector} answered and the class decided no role`);
    fix('ax.config.json: { "dispatch": { "models": { "routine": "@<role>", "standard": "@<role>", "deep": "@<role>" } } }   # OMP role aliases, never models');
    note('The dispatch still happens: a project that declares no class roles keeps @default by design. Settle it and dispatch again if that is not what you wanted.');
  }

  // ── 4. placement ───────────────────────────────────────────────────────────
  const place = [];
  let worktree = '';
  // The tree this dispatch will place the child in, AS THIS HOST CAN NAME IT —
  // which is not always `worktree`: a dry run predicts a path it does not
  // create, and a child on another host is named only by a selector that
  // carries its path (reuse, or an exact `--worktree`). It is what the Report
  // path is derived from, so the brief cannot name a tree the dispatch did not
  // use.
  let selector = '';
  // The per-worktree identity pin for a child on another host, as the command
  // the operator runs THERE: nothing on this side can write into a tree there.
  let remotePin = '';

  // A remote host — the one with the most Slots when no `--on` names it, or
  // the named host alone — passes one contract (KTD10): its Slots from the
  // measurement §3 took, then its repository and its grounds, then, outside a
  // dry run, its host lock and its Slots read AGAIN under it (KTD3, §7). The
  // proof is ssh-bound and spends nothing, so no lock is held across it. Never
  // this Mac (R2), and a named host never falls back to another (R3).
  const repoName = basename(paths.root || cwd);
  const proveOn = declaration => proveHost(declaration, { ssh: args => exec('ssh', args, cwd), kind, ref: flags.issue, sweep: !dry });
  let target = null;
  if (placing || onHost !== '') {
    const chosen = placeHost({
      capacity: fleet.capacity,
      declarations: onHost === '' ? declarations : { [onHost]: counted.dispatch.hosts[onHost] },
      only: onHost,
      liveOn: host => measured.hosts.get(host) ?? NONE,
      // A named host's repository is resolved below, exactly as before: an
      // explicit `--repo-id` is taken as given.
      repoFor: host => (onHost === '' ? repoIdFor(repoName, { run, env: host }) : { ok: true, id: flags.repoId }),
      prove: (host, declaration) => proveOn(declaration),
    });
    for (const line of chosen.lines) note(line);
    if (!chosen.ok) {
      const why = chosen.skipped.length === 0 ? 'the capacity report lists no compute host' : chosen.skipped.map(row => `${row.host}: ${row.reason}`).join(' | ');
      return onHost === ''
        ? refuse(
            `no compute host can take this worker, and this Mac is never the fallback — ${why}`,
            'ax worker dispatch … --on <host>   # a host you choose, or --on here to run it on this Mac',
          )
        : refuse(
            `'${onHost}' cannot take this worker, and a named host never falls back to another host or to this Mac — ${why}`,
            `ax worker hosts   # each host's Slots and why; then --on <a host with a Slot>, or --on here for this Mac`,
          );
    }
    target = chosen;
    on = chosen.host;
  }

  // `--worktree` means two different things on either side of `--on`, and until
  // #103 it meant only the local one: a directory on THIS machine, which can
  // never name a tree on the host the same argv is dispatching to.
  if (flags.worktree !== '' && on === '') {
    if (!existsSync(flags.worktree)) return refuse(`--worktree ${flags.worktree} is not a directory on this host`);
    worktree = flags.worktree;
    selector = worktree;
    place.push('--worktree', `path:${worktree}`, '--agent', flags.agent);
  } else if (on !== '') {
    const declared = { ok: true, host: target.declaration };

    let repoId = target.repoId;
    if (repoId === '') {
      const resolved = repoIdFor(repoName, { run, env: on });
      if (!resolved.ok) return cannot(resolved.reason, `orca repo list --environment ${on} --json`);
      repoId = resolved.id;
    } else if (!repoId.startsWith('id:')) repoId = `id:${repoId}`;

    // `sweep: !dry` — the browser sweep is the one MUTATION among the grounds,
    // and a preview that reclaims processes on another machine is not a preview.
    // The admitted host was proven by the placement that admitted it.
    const grounds = target.grounds;
    for (const line of grounds.notes ?? []) note(line);
    if ((grounds.unproven ?? 0) > 0) {
      note(`${grounds.unproven} ground(s) on '${on}' are UNPROVEN rather than passed — a transport that cannot answer never blocks remote work, but it never proves it either`);
    }

    // The tree the host already carries for this subject, or today's argv byte
    // for byte. An explicit `--worktree` is the operator having discovered that
    // selector themselves — it is the second repair every remote refusal names,
    // so it asks the host nothing and is taken as given.
    let remote = 'new-top-level';
    if (flags.worktree !== '') {
      const exact = remoteSelectorFor(flags.worktree);
      if (!exact.ok) return refuse(exact.reason, exact.repair);
      remote = exact.selector;
    } else {
      const placed = placeRemote({ repoId, env: on, request, issue: flags.issue, named, run });
      for (const line of placed.notes) note(line);
      if (placed.cannot) return cannot(placed.cannot, placed.repair);
      if (placed.selector !== '') remote = placed.selector;
    }

    // A tree the host already carries is named in the pin command; a tree the
    // dispatch has yet to create is a placeholder, never a guessed path.
    const tree = /^(?:id:[^:]+::|path:)(\/.+)$/.exec(remote)?.[1] ?? '<worktree>';
    remotePin = `ssh ${declared.host.ssh} 'git -C ${tree} config extensions.worktreeConfig true && git -C ${tree} config --worktree user.name "<name>" && git -C ${tree} config --worktree user.email "<email>"'`;
    // The flags that CREATE a tree travel with `new-top-level` only: Orca
    // refuses them beside an existing remote tree (placement.mjs,
    // CREATION_FLAGS), and the repository is already inside `id:<repo>::<path>`.
    place.push('--on', on, '--worktree', remote);
    if (remote === 'new-top-level') place.push('--repo', repoId, '--name', request);
    place.push('--agent', flags.agent);
    selector = remoteTreeOf(remote);
    // `--setup skip` is exactly what left a child with no URLs, so it is only
    // ever composed for a throwaway probe.
    if (probe && remote === 'new-top-level') place.push('--setup', 'skip');
  } else {
    if (paths.root === null) {
      return cannot('not inside a git checkout, so there is no repository to place a worktree in', 'cd <repo> && ax worker dispatch …');
    }
    const placed = placeLocal({ request, issue: flags.issue, slug, named, paths, dispatchConfig, ticket, exec, run, cwd, dry, probe, setupFn });
    for (const line of placed.notes) note(line);
    if (placed.refused) return refuse(placed.refused, placed.repair);
    if (placed.cannot) return cannot(placed.cannot, placed.repair);
    worktree = placed.worktree;
    selector = worktree || placed.predicted || '';
    if (selector !== '') place.push('--worktree', `path:${selector}`, '--agent', flags.agent);
  }

  // The selector a dispatch will use, proven to RESOLVE before anything is
  // dispatched into it. A worktree created with plain `git worktree add` exists
  // on disk while Orca still resolves nothing for it: measured 2026-08-21,
  // `worker-start` answered `selector_not_found` five seconds after placement
  // and the same recorded call replayed clean three minutes later, with no
  // argument changed. That failure is indistinguishable from a bad selector,
  // which is what makes it expensive — it sends you auditing argv instead of
  // waiting. It guards EVERY local placement, not only a freshly created one: a
  // worktree reused from an earlier dispatch reaches the same one, and a
  // stranded earlier dispatch is exactly how an unseen one comes to exist.
  if (worktree !== '' && on === '' && !dry) {
    const seen = untilSeen({ run, worktree, deadline: now() + Number(env.AX_DISPATCH_SEE_WAIT ?? 120) * 1000, now, sleep, tickMs: tickOf(env) });
    if (!seen) {
      return cannot(
        `orca does not resolve path:${worktree}, so a dispatch would fail selector_not_found with nothing wrong in its arguments`,
        `orca worktree show --worktree path:${worktree} --json   # then re-run`,
      );
    }
    note(`orca resolves path:${worktree} — the dispatch selector is live`);
  }

  // ── 5. what the child cannot fix for itself ────────────────────────────────
  // The OMP bundle FIRST: it is the only one of these whose absence changes WHO
  // the child is. Measured 2026-08-28 (ofmchat #101) — a dispatch five seconds
  // ahead of its worktree's install produced a child with no worker role, no
  // playbook and its boot model, which then implemented a ticket for real while
  // `gate` and `tail` showed a healthy agent.
  //
  // `ax worktree setup` INSTALLS NOW (../worktree/setup.mjs), so the placement
  // above leaves an equipped tree and this ground normally passes on its first
  // read. It still WAITS rather than refusing: a tree placed by the repo's own
  // tool or reused from an earlier dispatch can carry an install started
  // elsewhere, and the measured window for one of those was five seconds. What
  // it no longer waits for is an install nobody was ever asked to run — that was
  // 180 seconds of budget followed by a refusal of a worktree ax had just
  // provisioned (reported from a consumer at 0.21.1).
  if (worktree !== '' && !dry) {
    const equip = untilEquipped({
      worktree,
      deadline: now() + Number(env.AX_DISPATCH_EQUIP_WAIT ?? 180) * 1000,
      now,
      sleep,
      tickMs: tickOf(env),
    });
    if (!equip.measured) note(equip.reason);
    else if (equip.wiring) {
      // Nothing here can be waited out, and the repair is not an install: this
      // worktree would load OMP and consume no role marker at all.
      return cannot(
        `${equip.reason} — a child dispatched into it boots with no worker role, no playbook and its BOOT model, and implements the ticket anyway`,
        `ax init   # register exactly one ${PACKAGE_NAME} bundle, then re-run this dispatch`,
      );
    } else if (!equip.ready) {
      return cannot(
        `this worktree registers an AX bundle it does not carry (${equip.missing.join(', ')}), so a child dispatched into it boots with no worker role, no playbook and its BOOT model — and implements the ticket anyway`,
        `${installCommand(worktree)}   # then re-run this dispatch`,
      );
    } else note('the AX bundle this worktree registers is loadable, so the child can apply its role marker');
  }

  const lineage = setLineage({ run, worktree, on, dry, env });
  note(`lineage ${lineage}`);
  if (worktree !== '' && !dry) {
    const mandate = writeMandate(worktree, {
      exec: (b, a, at) => exec(b, a, at ?? worktree),
      write: (path, text) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
    });
    for (const line of mandate.notes) note(line);
    const identity = pinIdentity(worktree, { exec: (b, a, at) => exec(b, a, at ?? worktree) });
    for (const line of identity.notes) note(line);
  } else if (on !== '' && !dry) {
    note(`no advisor mandate for a child on '${on}': its worktree is created inside the dispatch, after the roster is read — expect to tell it by hand, or move it into that repo's setup hook on that host`);
    // NOT "no identity": the child commits as that host's own user, global
    // config included, and this side reads none of it. What is missing is the
    // SCOPE ./child.mjs pinIdentity writes locally, and a global identity does
    // not stand in for it — a babysitter's rename lands in the repository's
    // shared .git/config, which outranks the global for every sibling tree.
    // Measured on gapicore: `harness` carries a global user.email, and the old
    // line read as if it did not.
    note(`no per-worktree git identity pinned for a child on '${on}', and a global identity there does not cover it: its commits carry that host's own git identity, but a babysitter's rename lands in the repository's SHARED .git/config, which outranks any global, so a sibling's babysitter can sign this child's commits until its identity is pinned in the child's own worktree scope — once the tree exists: ${remotePin}`);
    // Same shape, and worth its own line because the consequence is a shared
    // database rather than a missing courtesy: nothing here provisions that
    // remote tree, so a ticket that says it touches the database cannot be
    // honoured from this side.
    if (databaseArgs(dispatchConfig, ticket).argv.length > 0) {
      note(`this ticket's labels ask for an isolated database, and a child on '${on}' is provisioned by that host's own setup hook — verify its stack there before it writes`);
    }
  }

  // ── 6. the brief, as a FILE ────────────────────────────────────────────────
  // The Report's location is DERIVED, never named by the worker (`docs/adr/0002`),
  // and the rule lives once in ./report.mjs — the same function the receiver
  // crosses when the completion arrives. It is derived from the two values this
  // dispatch is about to record: the tree it places the child in and the request
  // id. A child on another host whose tree the host has yet to create
  // (`new-top-level`, or a selector the host resolves) has no path this side can
  // name, but the brief is pasted into the agent terminal Orca created IN that
  // tree — so it is told the path under its own worktree root, which is the file
  // the receiver derives from the record's effect once the host has named it
  // (reported from gapila #2120: an inability here left the child asking twice
  // and its orchestrator rebuilding the path by hand).
  const report = on !== '' && selector === '' ? reportPathWithin(request) : reportPathFor({ worktree: selector, request });
  const brief = renderBrief({
    model: policy.selector,
    instruction,
    ticket,
    name: flags.name,
    readCommand: named ? '' : readCommand({ kind, ref: flags.issue }),
    run: runId,
    host: on,
    contract: contract.text,
    landed: landed.text,
    operator,
    report,
    delivery: flags.delivery,
  });
  note(
    report.path
      ? `the child's Report goes to ${report.path}, and the brief says so`
      : report.within
        ? `the child's Report goes to ${report.within} under the tree '${on}' creates for it, and the brief says so — the receipt below names it once the record does`
        : `no Report path for this dispatch: ${report.reason}`,
  );

  // The options `ax worker start` owns and RECORDS, as against the placement
  // argv forwarded to Orca after `--`. `--because` and `--tracker-repo` belong
  // here and only here: they are provenance for this dispatch, not an input to
  // the child, and the child reads the ticket (KD4). A reason nobody kept is a
  // reason nobody asked for; a record that does not name its repository hides
  // another checkout's ticket from the frontier and leaves its pane unplaceable
  // by `ax worker release`.
  //
  // The repository a record names is the CHECKOUT THAT DISPATCHES — `gh repo
  // view`'s nameWithOwner, the very read the frontier, release and settle
  // compare against — never the tracker's. Until 2026-09-03 it came from the
  // ticket URL, so `--name` and every Linear ticket recorded none and took the
  // `unknown` branch forever (review of #118). The URL is now only the fallback
  // for a checkout whose forge `gh` cannot name; with neither, the record stays
  // unknown, and nothing here guesses one (F-028).
  //
  // `trackerRepo` was read once in §3: the record names the repository by that
  // read, and nothing here admits or refuses on it.
  const owned = [
    '--request', request,
    '--run', runId,
    ...(flags.because === '' ? [] : ['--because', flags.because]),
    ...(trackerRepo === '' ? [] : ['--tracker-repo', trackerRepo]),
    // The mode this dispatch chose, recorded like `--because`: the brief is
    // written once into /tmp and the pane outlives it, so without this the one
    // fact that says whether a missing pull request is a failure or the plan is
    // unreadable the moment the spec file is gone. Additive, and the DEFAULT is
    // an absence — every record written before the mode existed was delivered
    // by its child.
    ...(flags.delivery === 'child' ? [] : ['--delivery', flags.delivery]),
    '--kind',
    'implementation',
  ];

  if (dry) {
    section(named ? `dry run — ${flags.name}: ${instruction}` : `dry run — ${ticket.id}: ${ticket.title}`);
    raw(brief);
    // The preview is composed from the SAME array the dispatch would carry, so
    // it cannot drift from what runs. The Bash it replaces re-typed this line by
    // hand, which is a second implementation of the argv nobody tests.
    note(redactSecrets(`would run: ax worker start ${[...owned, '--spec-file', '<spec>', '--', ...place].join(' ')}`));
    return 0;
  }

  const specDir = env.AX_DISPATCH_SPEC_DIR || env.TMPDIR || '/tmp';
  const spec = join(specDir.replace(/\/+$/, ''), `dispatch-${request}.spec.txt`);
  try {
    mkdirSync(specDir, { recursive: true });
    writeFileSync(spec, brief, { mode: 0o600 });
  } catch (error) {
    return cannot(`the brief could not be written to ${spec}: ${String(error.message ?? error)}`);
  }

  // ── 7. dispatch ────────────────────────────────────────────────────────────
  // The host lock (KTD3), taken last: a Slot another dispatch wrote ahead while
  // this one proved the host is refused here, never spent twice, and a named
  // host still never falls back (R3). Released by start the moment its
  // worker-start is on disk — written ahead, answered or STRANDED, that start
  // spends the host's Slot from the record — so the remote call behind it, up
  // to 120s, never holds a sibling waiting.
  if (target !== null) {
    const admitted = admit(on);
    if (admitted.cannot) return cannot(admitted.cannot, admitted.repair);
    admission.release = admitted.lock.release;
    const again = verdictOf(target.entry, admitted.count);
    if (again.reason !== undefined) {
      return refuse(
        `'${on}' has no Slot left for this worker — host '${on}' skipped: ${again.reason}, read again under the host lock`,
        onHost === '' ? 'ax worker hosts   # then re-run this dispatch: placement chooses again' : `ax worker hosts ${on}   # then --on <a host with a Slot>, or --on here for this Mac`,
      );
    }
  }
  const released = () => {
    admission.release();
    admission.release = () => {};
  };
  const startArgs = [...owned, '--spec-file', spec, '--orca', bin, '--', ...place];
  let code = startFn(startArgs, { env, runner, modelPolicy: policy, onWriteAhead: released });
  if (code === 4) {
    // STRANDED: the mutation ran and the reply came back empty. That is not a
    // failure to report, it is exactly what --resume exists for, and BOTH remote
    // dispatches on record hit it — which makes the recovery the ordinary path for
    // `--on`, not an anomaly. Typing it by hand is what used to drop the
    // verification below, because this verb exited here and the operator
    // resumed from a fresh shell.
    note('STRANDED — the recorded mutation may still be running; replaying the recorded call (F-001: never a second request)');
    code = startFn(['--resume', '--request', request, '--orca', bin], { env, runner });
  }
  // A start that never reached its worker-start gives the lock back here.
  released();
  if (code !== 0) return code;

  // ── 8. verify ──────────────────────────────────────────────────────────────
  return verify({
    run,
    env,
    on,
    wait,
    worktree,
    request,
    ticket,
    instruction,
    lineage,
    sessionsRoot,
    host: on === '' ? null : (target?.declaration ?? hostFor(config, on).host ?? null),
    exec,
    cwd,
    now,
    sleep,
    tickMs: tickOf(env),
  });
}

/**
 * The address a child's completion report is sent to.
 *
 * `parentWorktreeId` is the only source, and it is READ BACK rather than
 * trusted: `worktree create --parent-worktree` answers ok:true while silently
 * discarding a parent it dislikes (F-002), and `worktree show` on a `path:`
 * selector is the only surface that carries the field back at all (F-005).
 *
 * A failure here is announced, never refused: a child with no lineage still does
 * its work and still lands its report on its Run, and refusing would trade a
 * whole slice for a degraded report channel. What is refused is a GUESS — the
 * orchestrator's own worktree comes from Orca's witness of this session's
 * terminal, never from the directory this verb happened to run in, because a
 * guessed parent addresses this child's report to a stranger.
 */
function setLineage({ run, worktree, on, dry, env }) {
  if (on !== '') return 'impossible (cross-host: Orca binds lineage to one repository, host and project)';
  if (dry) return 'would be set to this session\u2019s worktree';
  if (worktree === '') return 'no local worktree path to set it on';

  const handle = env.ORCA_TERMINAL_HANDLE ?? '';
  if (handle === '') return 'NOT SET — this session has no terminal handle, and a guessed parent would send this child\u2019s report to a stranger';

  const terminals = run(['terminal', 'list', '--json']);
  const rows = Array.isArray(terminals.receipt?.result?.terminals) ? terminals.receipt.result.terminals : [];
  const mine = rows.find(row => row?.handle === handle);
  const parent = String(mine?.worktreePath ?? '');
  if (parent === '') {
    return 'NOT SET — Orca witnesses no worktree for this session, and a guessed parent would send this child\u2019s report to a stranger';
  }

  run(['worktree', 'set', '--worktree', `path:${worktree}`, '--parent-worktree', `path:${parent}`, '--json']);
  const readBack = run(['worktree', 'show', '--worktree', `path:${worktree}`, '--json']);
  const recorded = String(readBack.receipt?.result?.worktree?.parentWorktreeId ?? readBack.receipt?.result?.parentWorktreeId ?? '');
  if (recorded === '') {
    return 'NOT SET — the set call returned but parentWorktreeId still reads empty (F-002); this child cannot report home, and its Run is the only channel left';
  }
  // A non-empty field is not the field this call asked for. A tree reused from an
  // earlier dispatch already carries a parent, so reading "some parent" back would
  // report success over a `set` Orca discarded — which is exactly the shape
  // F-002 is about. The recorded id ends with the path it was set to.
  if (!recorded.endsWith(parent)) {
    return `NOT SET — parentWorktreeId reads ${recorded}, not the ${parent} this dispatch set (F-002: the set was discarded and answered ok); this child reports to whoever that is, not to this session`;
  }
  return recorded;
}

/**
 * The live workers per host that a remote admission spends Slots from,
 * counted through the one reader `ax worker ls` prints (./slots.mjs) —
 * `{ hosts, lines }` or `{ cannot, repair }`.
 *
 * FAIL-CLOSED: the caller is about to admit a worker onto a host, so an
 * unreadable terminal list or an unreadable record is cannot-establish rather
 * than a count of zero — an absence of information is not an absence of a
 * child (F-028). An ENOENT store is the one real zero: a machine that has
 * never dispatched. `lines` name each host that could not be asked, because
 * that host then offers no Slot (R5) and the reader deserves to know why — for
 * a named host (`only`), that host alone: no other host is this dispatch's. A
 * retired host is left out: its retirement skip already names it (KTD8), and
 * asking it is no repair for a host the operator wrote off.
 */
function measureLive({ run, env, config, only = '' }) {
  const local = terminalInventory(run);
  if (!local.ok) return { cannot: local.reason, repair: 'orca open   # live workers are counted, never assumed — admission does not fail open' };
  const counted = liveCount({ run, env, config, local });
  if (counted.cannot) return { cannot: counted.cannot, repair: counted.repair };
  const lines = [];
  for (const [host, scope] of counted.scopes.unaskable()) {
    if (only !== '' && host !== only) continue;
    if (counted.slots.hosts.get(host)?.retired) continue;
    lines.push(`host '${host}' could not be asked, so its live workers cannot be counted and it offers no Slot: ${scope.reason}`);
  }
  return { hosts: counted.slots.hosts, lines };
}

/**
 * The contract a project declares, or NOTHING when it declares none — never
 * ax's own MECHANICS. `renderBrief` picks between the tracked and the untracked
 * mechanics by whether the dispatch has a ticket, and it can only do that when
 * the contract slot arrives empty. Substituting MECHANICS here was how a
 * `--name` dispatch read "This dispatch carries NO ticket" in its heading and
 * "Keep the ticket current yourself" in its mechanics from one brief (measured
 * 2026-09-04 on #136's branch, `--name probe-untracked --dry-run`).
 */
function readContract(dispatchConfig, root) {
  const declared = dispatchConfig.contract ?? '';
  if (declared === '') return { text: '', path: '' };
  const path = isAbsolute(declared) ? declared : join(root ?? '', declared);
  try {
    return { text: readFileSync(path, 'utf8'), path };
  } catch {
    return { missing: true, path };
  }
}
