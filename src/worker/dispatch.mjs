// `ax worker dispatch --issue <ref>` — a ticket becomes a working session, in one gesture.
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
//   4. placement: reuse | the repo's own tool | Orca, then `ax worktree setup`,
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
import { PACKAGE_NAME, loadCheckoutConfig, repoPaths } from '../config.mjs';
import { setup as setupVerb } from '../worktree/setup.mjs';
import { peerRun } from './peers.mjs';
import { databaseArgs, placeLocal, untilSeen } from './placement.mjs';
import { verify } from './verify.mjs';
import { start as startVerb } from './start.mjs';
import { emptyBodyRefusal, needsRef, normalizeSlug, readCommand, readTicket, readyAssignmentRefusal, ticketKind } from './ticket.mjs';
import { hostFor, proveHost, quote, repoIdFor } from './hosts.mjs';
import { MECHANICS, renderBrief } from './brief.mjs';
import { pinIdentity, untilEquipped, writeMandate } from './child.mjs';
// `gh` and `git`, run for real. Imported rather than re-declared: this exact
// default was dropped in a refactor once and no test noticed, because every test
// injects `exec` — so there is ONE of them (src/exec.mjs), and it has its own test.
import { defaultExec } from '../exec.mjs';

const USAGE =
  'ax worker dispatch (--issue <ref> [--slug <s>] | --name <name>) [--task <text> [--because <reason>]] [--notes <file>] ' +
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

export function dispatch(
  argv = [],
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
    sessionsRoot,
  } = {},
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
    because: '',
    model: '@default',
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
    '--because': 'because',
    '--model': 'model',
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
    else if (arg === '-h' || arg === '--help') {
      raw(USAGE);
      return 0;
    } else if (NAMED[arg] !== undefined) {
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
  const wait = Number(flags.wait);
  // `here` is a synonym for local placement, the way Orca's own CLI reads it.
  const on = flags.on === 'here' ? '' : flags.on;

  const named = flags.name !== '';
  const kind = named ? null : ticketKind(flags.issue);
  if (!named && kind === null) {
    return usageError(`--issue expects a Linear ref (ABC-123) or a GitHub issue number, not "${flags.issue}"`);
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

  const paths = repoPaths(cwd);
  const loaded = loadCheckoutConfig({ root: paths.root, main: paths.main });
  if (!loaded.exists || loaded.errors.length > 0) {
    return refuse(
      loaded.exists ? `${loaded.errors.length} problem(s) in ax.config.json: ${loaded.errors[0]}` : 'no ax.config.json — a dispatch reads this project\u2019s entry point, contract and hosts from it',
      'ax init   # in the primary checkout',
    );
  }
  const config = loaded.config;
  const dispatchConfig = config.dispatch ?? {};
  // A name IS the request, verbatim: that is what makes distinct names distinct
  // requests. A ticket ref goes through the normaliser, which is injective on the
  // two ref shapes `ticketKind` accepts.
  const request = named ? flags.name : requestIdFor(flags.issue, slug);

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
  // has to be true. So the ref, the contract, the Run and the operator's notes —
  // all four knowable now — are settled before placement.
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
  // ── 4. placement ───────────────────────────────────────────────────────────
  const place = [];
  let worktree = '';

  if (flags.worktree !== '') {
    if (!existsSync(flags.worktree)) return refuse(`--worktree ${flags.worktree} is not a directory on this host`);
    worktree = flags.worktree;
    place.push('--worktree', `path:${worktree}`, '--agent', flags.agent);
  } else if (on !== '') {
    const declared = hostFor(config, on);
    if (!declared.ok) return refuse(declared.reason, `ax.config.json: dispatch.hosts.${on}.ssh "<target>"`);

    let repoId = flags.repoId;
    if (repoId === '') {
      const resolved = repoIdFor(basename(paths.root || cwd), { run, env: on });
      if (!resolved.ok) return cannot(resolved.reason, `orca repo list --environment ${on} --json`);
      repoId = resolved.id;
    } else if (!repoId.startsWith('id:')) repoId = `id:${repoId}`;

    // `sweep: !dry` — the browser sweep is the one MUTATION among the grounds,
    // and a preview that reclaims processes on another machine is not a preview.
    const grounds = proveHost(declared.host, { ssh: args => exec('ssh', args, cwd), kind, ref: flags.issue, sweep: !dry });
    for (const line of grounds.notes ?? []) note(line);
    if (!grounds.ok) return refuse(grounds.reason);
    if ((grounds.unproven ?? 0) > 0) {
      note(`${grounds.unproven} ground(s) on '${on}' are UNPROVEN rather than passed — a transport that cannot answer never blocks remote work, but it never proves it either`);
    }

    place.push('--on', on, '--worktree', 'new-top-level', '--repo', repoId, '--name', request, '--agent', flags.agent);
    // `--setup skip` is exactly what left a child with no URLs, so it is only
    // ever composed for a throwaway probe.
    if (probe) place.push('--setup', 'skip');
  } else {
    if (paths.root === null) {
      return cannot('not inside a git checkout, so there is no repository to place a worktree in', 'cd <repo> && ax worker dispatch …');
    }
    const placed = placeLocal({ request, issue: flags.issue, slug, named, paths, dispatchConfig, ticket, exec, run, cwd, dry, probe, setupFn });
    for (const line of placed.notes) note(line);
    if (placed.refused) return refuse(placed.refused, placed.repair);
    if (placed.cannot) return cannot(placed.cannot, placed.repair);
    worktree = placed.worktree;
    const selector = worktree || placed.predicted || '';
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
  // `gate` and `tail` showed a healthy agent. `ax worktree setup` installs
  // nothing (../worktree/setup.mjs only notes the absence), so the install is
  // concurrent by construction and this ground WAITS for it rather than refusing
  // a fresh worktree outright.
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
        `run your package manager's install in ${worktree}   # then re-run this dispatch`,
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
    note(`no advisor mandate and no pinned git identity for a child on '${on}': its worktree is created inside the dispatch, after the roster is read — expect to tell it by hand, or move both into that repo's setup hook on that host`);
    // Same shape, and worth its own line because the consequence is a shared
    // database rather than a missing courtesy: nothing here provisions that
    // remote tree, so a ticket that says it touches the database cannot be
    // honoured from this side.
    if (databaseArgs(dispatchConfig, ticket).argv.length > 0) {
      note(`this ticket's labels ask for an isolated database, and a child on '${on}' is provisioned by that host's own setup hook — verify its stack there before it writes`);
    }
  }

  // ── 6. the brief, as a FILE ────────────────────────────────────────────────
  const brief = renderBrief({
    model: flags.model,
    instruction,
    ticket,
    name: flags.name,
    readCommand: named ? '' : readCommand({ kind, ref: flags.issue }),
    run: runId,
    host: on,
    contract: contract.text,
    operator,
  });

  // The options `ax worker start` owns and RECORDS, as against the placement
  // argv forwarded to Orca after `--`. `--because` and `--tracker-repo` belong
  // here and only here: they are provenance for this dispatch, not an input to
  // the child, and the child reads the ticket (KD4). A reason nobody kept is a
  // reason nobody asked for; a record that does not name its repository hides
  // another checkout's ticket from the frontier.
  const trackerRepo = named ? '' : trackerRepoOf(ticket.url);
  const owned = [
    '--request', request,
    '--run', runId,
    ...(flags.because === '' ? [] : ['--because', flags.because]),
    ...(trackerRepo === '' ? [] : ['--tracker-repo', trackerRepo]),
  ];

  if (dry) {
    section(named ? `dry run — ${flags.name}: ${instruction}` : `dry run — ${ticket.id}: ${ticket.title}`);
    raw(brief);
    // The preview is composed from the SAME array the dispatch would carry, so
    // it cannot drift from what runs. The Bash it replaces re-typed this line by
    // hand, which is a second implementation of the argv nobody tests.
    note(`would run: ax worker start ${[...owned, '--spec-file', '<spec>', '--', ...place].join(' ')}`);
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
  const startArgs = [...owned, '--spec-file', spec, '--orca', bin, '--', ...place];
  let code = startFn(startArgs, { env, runner });
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
    host: on === '' ? null : (hostFor(config, on).host ?? null),
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

/** The contract a project declares, or ax's own mechanics when it declares none. */
function readContract(dispatchConfig, root) {
  const declared = dispatchConfig.contract ?? '';
  if (declared === '') return { text: MECHANICS, path: '' };
  const path = isAbsolute(declared) ? declared : join(root ?? '', declared);
  try {
    return { text: readFileSync(path, 'utf8'), path };
  } catch {
    return { missing: true, path };
  }
}
