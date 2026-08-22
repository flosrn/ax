// `ax worker launch --issue <ref>` — a ticket becomes a working session, in one gesture.
//
// WHY THIS EXISTS (measured 2026-08-14)
// Both halves already existed and the SEAM did not: something turns an issue into
// a bootstrapped worktree, and `ax worker start` issues a recoverable dispatch.
// Between them sat six steps that lived as PROSE in a skill — and prose is not
// executable, so every launch retyped them. Measured over five hand-run
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
// URL comes from the proxy probe that already reads a project's config. Launch
// asks setup to run and reads its verdict; habitability is no longer a second
// implementation that can disagree with the first.
//
// What genuinely could not move into an existing verb is here, and nothing in it
// names a project: the ticket adapters (./ticket.mjs), the remote host grounds
// (./hosts.mjs), the brief (./brief.mjs), what is prepared in the child's
// worktree (./child.mjs). Everything host- or project-shaped arrives from
// `ax.config.json`'s `launch` block, and a ground a project does not declare is
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
//   5. lineage, the advisor mandate and the git identity: three things the child
//      cannot fix for itself, each degrading with an announcement, never silently
//   6. the brief, as a FILE
//   7. `ax worker start`, whose STRANDED exit is REPLAYED here rather than
//      reported — the recovery is the ordinary path for a remote launch
//   8. verify: the marker applied WITH a role, and the pane emitting
//
// Exit codes (ADR 0003 — per verb, never a shared alphabet):
//   0  dispatched, and the child verified (or --wait 0 asked for no proof)
//   1  refused, with a named reason — nothing was created
//   2  usage error
//   3  cannot establish. When the dispatch already happened the report says so
//      and names the recovery; do NOT relaunch, that is how a duplicate is born.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { createRunner, resolveOrca, runtimeReady } from '../orca-bin.mjs';
import { bad, fix, note, ok, raw, section } from '../log.mjs';
import { redactSecrets } from '../redact.mjs';
import { loadCheckoutConfig, repoPaths } from '../config.mjs';
import { CONTEXT_PATH } from '../worktree/context.mjs';
import { setup as setupVerb } from '../worktree/setup.mjs';
import { defaultStore, workerPane } from './record.mjs';
import { peerRun } from './peers.mjs';
import { readPane } from './pane.mjs';
import { modelMarker } from './transcript.mjs';
import { start as startVerb } from './start.mjs';
import { emptyBodyRefusal, needsRef, normalizeSlug, readCommand, readTicket, ticketKind } from './ticket.mjs';
import { hostFor, proveHost, quote, remote, repoIdFor } from './hosts.mjs';
import { MECHANICS, renderBrief } from './brief.mjs';
import { pinIdentity, writeMandate } from './child.mjs';
// `gh` and `git`, run for real. Imported rather than re-declared: this exact
// default was dropped in a refactor once and no test noticed, because every test
// injects `exec` — so there is ONE of them, and it has its own test.
import { defaultExec } from './release.mjs';

const USAGE =
  'ax worker launch (--issue <ref> [--slug <s>] | --name <name>) [--task <text>] [--brief <file>] ' +
  '[--model <alias>] [--agent <name>] [--run <id>] [--on <host>] [--repo-id <id>] [--worktree <abs>] ' +
  '[--needs-ref <ref>] [--wait <s>] [--probe] [--dry-run]';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleepDefault = ms => Atomics.wait(waitCell, 0, 0, ms);

const firstLine = text => String(text ?? '').split('\n')[0].trim();
/** A declared placement tool prints its path LAST; everything else it says is progress. */
const lastLine = text =>
  String(text ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .pop() ?? '';

/**
 * The request id every later gesture is keyed on: the store record, the stall
 * watcher's log, the `--resume` an operator is told to type. Lowercased and
 * collapsed so it is a filename and a branch fragment at once.
 */
export const requestIdFor = (issue, slug) =>
  `${issue}${slug ? `-${slug}` : '-work'}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export function launch(
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
    process.stderr.write(`ax worker launch: ${message}\n${repair ? `\n  ${repair}\n\n` : ''}${USAGE}\n`);
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

  // ── 1. arguments alone ─────────────────────────────────────────────────────
  const flags = {
    issue: '',
    name: '',
    slug: '',
    run: '',
    brief: '',
    task: '',
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
    '--brief': 'brief',
    '--task': 'task',
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
    } else return usageError(`unknown argument "${arg}"`);
  }

  // Exactly one identity. `--issue` names work a tracker owns; `--name` names
  // work nothing owns yet. Both is not a richer launch, it is two identities for
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
    //   and one branch, and the second launch would dispatch a child into the
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
        suggestion === '' ? undefined : `ax worker launch --name ${suggestion}`,
      );
    }
    // The name carries the whole identity; a slug on top of it is a second knob
    // on one name, and `<name>-<slug>` is how two names become one request.
    if (flags.slug !== '') return usageError('--slug belongs to a ticket ref; with --name the name is the slug');
  }
  if (flags.brief !== '' && !existsSync(flags.brief)) {
    // Checked before anything is read or created: a brief pointing at nothing
    // sends a child to improvise (2026-08-01, three worktrees that never read
    // theirs), and the cheapest moment to say so is now.
    return refuse(`--brief file unreadable: ${flags.brief}`);
  }

  const { slug, note: slugNote } = normalizeSlug(flags.issue, flags.slug);
  if (slugNote) note(slugNote);
  if (kind === 'linear' && slug === '' && flags.worktree === '') {
    return refuse(
      'a Linear ref carries no branch name, so --slug is required: nothing here invents the name a worktree and a branch will be searched for later',
      `ax worker launch --issue ${flags.issue} --slug <slug>`,
    );
  }

  const paths = repoPaths(cwd);
  const loaded = loadCheckoutConfig({ root: paths.root, main: paths.main });
  if (!loaded.exists || loaded.errors.length > 0) {
    return refuse(
      loaded.exists ? `${loaded.errors.length} problem(s) in ax.config.json: ${loaded.errors[0]}` : 'no ax.config.json — launch reads this project\u2019s entry point, contract and hosts from it',
      'ax init   # in the primary checkout',
    );
  }
  const config = loaded.config;
  const launchConfig = config.launch ?? {};
  // A name IS the request, verbatim: that is what makes distinct names distinct
  // requests. A ticket ref goes through the normaliser, which is injective on the
  // two ref shapes `ticketKind` accepts.
  const request = named ? flags.name : requestIdFor(flags.issue, slug);

  const bin = runner ? 'injected' : resolve({ env });
  if (!bin) {
    return cannot('no Orca CLI on this machine, so neither the ticket nor a dispatch can be read here', 'ORCA_CLI_COMMAND=<binary> ax worker launch …');
  }
  const run = runner ?? createRunner({ bin });
  const ready = runtimeReady(run);
  if (!ready.ready) return cannot(ready.reason, 'orca open   # start the runtime, then re-run this launch');

  // ── 2. the ticket, when there is one ───────────────────────────────────────
  // `--name` dispatches work no tracker owns. There is nothing to read, so there
  // is also no title, no url, no state and no body — and every later step that
  // would have used them has to say so rather than render an empty field.
  const ticket = named ? null : readTicket(flags.issue, { kind, run, exec });
  if (ticket !== null && !ticket.ok) {
    return cannot(ticket.reason, `${kind === 'linear' ? 'orca linear issue' : 'gh issue view'} ${flags.issue}   # read it by hand first`);
  }

  const entry = launchConfig.entry ?? '';
  if (named) {
    // With a ticket, `launch.entry` composes an instruction from the ref
    // (`<entry> GAP-353`) and the ticket body carries the rest. With no ticket
    // there is no ref to compose and no body to fall back on, so the instruction
    // must be given explicitly — a child dispatched on `<entry> ` alone is the
    // 2026-08-01 failure with better spelling.
    if (flags.task === '' && flags.brief === '') {
      return refuse(
        `--name carries no ticket, so nothing here knows what "${flags.name}" means: the instruction has to be given`,
        `ax worker launch --name ${flags.name} --task "<instruction>"   # or --brief <file>`,
      );
    }
  } else if (flags.task === '' && entry === '') {
    return refuse(
      'this project declares no launch entry point, so there is no instruction to give the child',
      'ax.config.json: launch.entry "<verb>"   # or pass --task "<instruction>"',
    );
  }
  const instruction = named ? flags.task || `${entry} ${flags.name}`.trim() : flags.task || `${entry} ${ticket.id}`;

  const emptyBody = named ? '' : emptyBodyRefusal({ bodyLength: ticket.bodyLength, task: flags.task, id: ticket.id });
  if (emptyBody) return refuse(emptyBody, `ax worker launch --issue ${flags.issue} --task "<instruction> ${ticket.id}"`);

  // ── 3. everything else knowable BEFORE anything is created ─────────────────
  // A launch that can never dispatch must not leave a worktree, a mandate, a
  // pinned identity or a lineage behind: exit 1 says nothing was created, and it
  // has to be true. So the ref, the contract, the Run and the operator's brief —
  // all four knowable now — are settled before placement.
  if (flags.needsRef !== '') {
    const proven = needsRef(flags.needsRef, { exec, cwd });
    if (!proven.ok) return refuse(proven.reason, 'git ls-remote --refs origin   # what origin actually carries');
    note(`${flags.needsRef} resolves on origin, so a child on any clone of it is defined by something it can reach`);
  }

  const contract = readContract(launchConfig, paths.root);
  if (contract.missing) {
    return refuse(
      `launch.contract names ${contract.path}, which cannot be read — a brief pointing at nothing sends a child to improvise (2026-08-01)`,
      `ls ${contract.path}   # or drop launch.contract to use the mechanics-only contract`,
    );
  }

  const runId = flags.run || peerRun(env);
  if (runId === '') {
    return cannot(
      'no Run to own the Task: this session is in no peer registry and --run was not given',
      'ax worker launch --issue … --run <run_id>',
    );
  }

  let operator = null;
  if (flags.brief !== '') {
    try {
      operator = { name: basename(flags.brief), text: readFileSync(flags.brief, 'utf8') };
    } catch (error) {
      return refuse(`--brief ${flags.brief} could not be read: ${String(error.message ?? error)}`);
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
    if (!declared.ok) return refuse(declared.reason, `ax.config.json: launch.hosts.${on}.ssh "<target>"`);

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
      return cannot('not inside a git checkout, so there is no repository to place a worktree in', 'cd <repo> && ax worker launch …');
    }
    const placed = placeLocal({ request, issue: flags.issue, slug, named, paths, launchConfig, exec, run, cwd, dry, probe, setupFn, env });
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
  // worktree reused from an earlier launch reaches the same dispatch, and a
  // stranded earlier launch is exactly how an unseen one comes to exist.
  if (worktree !== '' && on === '' && !dry) {
    const seen = untilSeen({ run, worktree, deadline: now() + Number(env.AX_LAUNCH_SEE_WAIT ?? 120) * 1000, now, sleep, tickMs: tickOf(env) });
    if (!seen) {
      return cannot(
        `orca does not resolve path:${worktree}, so a dispatch would fail selector_not_found with nothing wrong in its arguments`,
        `orca worktree show --worktree path:${worktree} --json   # then re-run`,
      );
    }
    note(`orca resolves path:${worktree} — the dispatch selector is live`);
  }

  // ── 5. what the child cannot fix for itself ────────────────────────────────
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
  }

  // ── 6. the brief, as a FILE ────────────────────────────────────────────────
  const brief = renderBrief({
    marker: flags.model,
    instruction,
    ticket,
    name: flags.name,
    readCommand: named ? '' : readCommand({ kind, ref: flags.issue }),
    run: runId,
    host: on,
    contract: contract.text,
    operator,
  });

  if (dry) {
    section(named ? `dry run — ${flags.name}: ${instruction}` : `dry run — ${ticket.id}: ${ticket.title}`);
    raw(brief);
    // The preview is composed from the SAME array the dispatch would carry, so
    // it cannot drift from what runs. The Bash it replaces re-typed this line by
    // hand, which is a second implementation of the argv nobody tests.
    note(`would run: ax worker start ${['--request', request, '--run', runId, '--spec-file', '<spec>', '--', ...place].join(' ')}`);
    return 0;
  }

  const specDir = env.AX_LAUNCH_SPEC_DIR || env.TMPDIR || '/tmp';
  const spec = join(specDir.replace(/\/+$/, ''), `launch-${request}.spec.txt`);
  try {
    mkdirSync(specDir, { recursive: true });
    writeFileSync(spec, brief, { mode: 0o600 });
  } catch (error) {
    return cannot(`the brief could not be written to ${spec}: ${String(error.message ?? error)}`);
  }

  // ── 7. dispatch ────────────────────────────────────────────────────────────
  const startArgs = ['--request', request, '--run', runId, '--spec-file', spec, '--orca', bin, '--', ...place];
  let code = startFn(startArgs, { env, runner });
  if (code === 4) {
    // STRANDED: the mutation ran and the reply came back empty. That is not a
    // failure to report, it is exactly what --resume exists for, and BOTH remote
    // launches on record hit it — which makes the recovery the ordinary path for
    // `--on`, not an anomaly. Typing it by hand is what used to drop the
    // verification below, because the launch exited here and the operator
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
  });
}

const tickOf = env => Math.max(1, Number(env.AX_LAUNCH_TICK ?? 2000));

/** Place the worktree on THIS host: reuse, the repo's own tool, or Orca. */
function placeLocal({ request, issue, slug, named, paths, launchConfig, exec, run, cwd, dry, probe, setupFn, env }) {
  const notes = [];
  const base = join(paths.root, '.worktrees');
  // What this placement is FOR, in one word, for every line below. `issue` is ''
  // on a named launch, and a message naming nothing sends an operator grepping
  // for a tree that was reported without a name.
  const subject = named ? request : issue;

  // Idempotence first, and it is the only countermeasure available: `worktree
  // create` carries no `--retry-request` (PORT invariant 2), so a create that
  // strands cannot be replayed and the claim is bounded to THIS host. A second
  // launch for the same ticket finds the first tree — and still proves it
  // habitable below, because the launch that made it may be exactly the one that
  // died before provisioning it.
  const existing = existingFor(base, subject, { exact: named });
  let created = false;

  const tool = launchConfig.worktreeTool ?? '';
  if (dry) {
    // A prediction, and it is labelled as one: the placement is the step a dry
    // run cannot perform, so the preview shows the selector it WOULD carry
    // rather than an empty passthrough that reads like a bug.
    const predicted = join(base, named ? request : `${issue}-${slug || 'work'}`);
    notes.push(
      tool === ''
        ? `dry-run: this project declares no worktree tool, so Orca would place it (worktree create --setup run) and ax worktree setup would provision it, predicted at ${predicted}`
        : `dry-run: would place it with \`${tool} ${[subject, ...(named || slug === '' ? [] : [slug])].join(' ')}\`, predicted at ${predicted}`,
    );
    return { worktree: '', predicted, notes };
  }

  let worktree = existing;
  if (existing !== '') {
    notes.push(`reusing the worktree that already exists for ${subject}, and placing no second one: ${existing}`);
  } else if (tool !== '') {
    // The declared tool BLOCKS until the tree is usable and prints the path on
    // its last stdout line; everything else it says is progress on stderr.
    const out = exec(tool, [subject, ...(named || slug === '' ? [] : [slug])], cwd);
    if (out.error) return { notes, cannot: `${tool} could not run: ${String(out.error.message ?? out.error)}` };
    if (out.status !== 0) {
      return { notes, refused: `${tool} failed for ${subject}; nothing was dispatched`, repair: firstLine(out.stderr) || `${tool} ${subject}` };
    }
    worktree = lastLine(out.stdout);
    if (worktree === '' || !existsSync(worktree)) {
      return { notes, cannot: `${tool} printed ${JSON.stringify(worktree)}, which is not a directory` };
    }
    created = true;
  } else {
    const receipt = run(['worktree', 'create', '--name', request, '--no-parent', '--setup', 'run', '--json']);
    if (receipt.status !== 0 || receipt.receipt?.ok !== true) {
      const detail = receipt.receipt?.unparseable ?? firstLine(receipt.stderr) ?? '';
      return { notes, refused: `orca worktree create failed for ${request}; nothing was dispatched`, repair: String(detail).slice(0, 200) };
    }
    worktree = String(receipt.receipt.result?.worktree?.path ?? '');
    if (worktree === '') return { notes, cannot: 'the worktree receipt names no path, so there is nowhere to dispatch into' };
    if (!existsSync(worktree)) return { notes, cannot: `the receipt names ${JSON.stringify(worktree)}, which is not a directory on this host` };
    created = true;
    notes.push(`orca placed the worktree and its setup hook is running: ${worktree}`);
  }

  // Provisioning is `ax worktree setup`'s job, and asking it here is what
  // replaced this verb's own copy of it. A `--probe` session is throwaway and
  // says so; every other launch refuses a tree with no agent context file,
  // because a child with no URL to test against is what --setup skip produced.
  if (probe) {
    notes.push('--probe: no provisioning and no habitability proof — never for real work');
    return { worktree, notes };
  }

  // Once a tree EXISTS, a provisioning failure is no longer "nothing was
  // created": exit 1 promises that, so these answer cannot-establish and name
  // the tree, which is also what a second launch will reuse.
  const setupCode = setupFn([], { cwd: worktree, env: { ...env, PWD: worktree } });
  if (setupCode !== 0) {
    return {
      notes,
      cannot: `ax worktree setup did not finish in ${worktree}${created ? ' (which this launch just created)' : ''}, so the child would start in a tree nobody prepared`,
      repair: `cd ${worktree} && ax worktree setup   # then re-run this launch; it reuses that tree`,
    };
  }
  if (!existsSync(join(worktree, CONTEXT_PATH))) {
    return {
      notes,
      cannot: `${worktree} has no ${CONTEXT_PATH}, so the child would have no URL to test against`,
      repair: `cd ${worktree} && ax worktree setup   # then re-run this launch; it reuses that tree`,
    };
  }
  notes.push(`provisioned: ${join(worktree, CONTEXT_PATH)} describes this worktree's own port and database`);
  return { worktree, notes };
}

/**
 * The worktree this ticket already has, or ''.
 *
 * With a ticket the match is the request's OWN name plus the ticket segment
 * followed by a separator: `GAP-35` inside `gap-357-…` is a different ticket, and
 * reusing another ticket's tree dispatches a child into a branch that is not its
 * own, while a differently-slugged earlier launch of the SAME ticket is the tree
 * this launch must reuse.
 *
 * `exact` turns that prefix rule off, and `--name` needs it off. A name is not a
 * ticket segment with slugs hanging from it — it is the whole identity, so the
 * prefix rule would make `--name auth` reuse the tree of `auth-refactor`: a
 * different piece of work, already provisioned, already someone's.
 */
function existingFor(base, subject, { exact = false } = {}) {
  let entries;
  try {
    entries = readdirNames(base);
  } catch {
    return '';
  }
  const wanted = String(subject).toLowerCase();
  const hit = entries
    .filter(name => {
      const lower = name.toLowerCase();
      if (exact) return lower === wanted;
      return lower === wanted || lower.startsWith(`${wanted}-`) || lower.startsWith(`${wanted}_`);
    })
    .sort();
  return hit.length === 0 ? '' : join(base, hit[0]);
}

const readdirNames = base =>
  readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

/** Poll the selector a dispatch will use, on evidence, against a deadline. */
function untilSeen({ run, worktree, deadline, now, sleep, tickMs }) {
  for (;;) {
    const out = run(['worktree', 'show', '--worktree', `path:${worktree}`, '--json']);
    if (out.status === 0 && out.receipt?.ok === true) return true;
    if (now() >= deadline) return false;
    sleep(tickMs);
  }
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
 * coordinator's own worktree comes from Orca's witness of this session's
 * terminal, never from the directory the launcher happened to run in, because a
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
  // earlier launch already carries a parent, so reading "some parent" back would
  // report success over a `set` Orca discarded — which is exactly the shape
  // F-002 is about. The recorded id ends with the path it was set to.
  if (!recorded.endsWith(parent)) {
    return `NOT SET — parentWorktreeId reads ${recorded}, not the ${parent} this launch set (F-002: the set was discarded and answered ok); this child reports to whoever that is, not to this session`;
  }
  return recorded;
}

/** The contract a project declares, or ax's own mechanics when it declares none. */
function readContract(launchConfig, root) {
  const declared = launchConfig.contract ?? '';
  if (declared === '') return { text: MECHANICS, path: '' };
  const path = isAbsolute(declared) ? declared : join(root ?? '', declared);
  try {
    return { text: readFileSync(path, 'utf8'), path };
  } catch {
    return { missing: true, path };
  }
}

/**
 * Two proofs, one verdict shape on both hosts: the marker applied WITH a role,
 * and the pane emitting.
 *
 * The marker is read from the child's own transcript because its own word for
 * its model is stale the moment it switches, and `role` is what says WHO moved
 * it — `default` is the spec's marker applying, `fallback` is the quota chain
 * moving the session on its own, and absence is the boot model. Remotely that
 * transcript lives on the other machine, so the same read runs there over the
 * declared transport rather than being replaced by a weaker check; a transport
 * that cannot answer is UNPROVEN, never a pass.
 *
 * Liveness is CURSOR MOVEMENT, never duration: two samples, and any advance
 * proves the pty emitted.
 */
function verify({ run, env, on, wait, worktree, request, ticket, instruction, lineage, sessionsRoot, host, exec, cwd, now, sleep }) {
  const recordPath = join(defaultStore(env), `${request}.json`);
  let pane = '';
  try {
    pane = workerPane(recordPath).handle;
  } catch {
    pane = '';
  }

  // `ticket === null` is a launch dispatched by name: there is no id, no title
  // and no url, and printing empty fields would read as a tracker that failed.
  section(ticket === null ? `LAUNCHED ${request} — ${instruction}` : `LAUNCHED ${ticket.id} — ${ticket.title}`);
  if (ticket === null) note('ticket    none — dispatched by name, and the brief is the whole definition of the work');
  else note(`ticket    ${ticket.url}  (${ticket.state})`);
  note(`host      ${on === '' ? 'here' : on}`);
  if (worktree !== '') note(`worktree  ${worktree}`);
  note(`request   ${request}`);
  note(`pane      ${pane === '' ? 'unnamed by the receipt' : pane}`);
  note(`lineage   ${lineage}`);

  if (wait === 0) {
    note('verified  skipped (--wait 0)');
    return 0;
  }

  const needle = basename(worktree === '' ? request : worktree);
  const deadline = now() + wait * 1000;
  const tickMs = tickOf(env);
  let marker = null;
  let first = null;
  let moved = null;

  for (;;) {
    if (marker === null) marker = readMarker({ needle, env, sessionsRoot, host, exec, cwd });
    if (pane !== '') {
      const sample = readPane(run, pane, { limit: 1, environment: on });
      const cursor = sample.cursor;
      if (cursor !== null) {
        if (first === null) first = cursor;
        else if (cursor !== first) moved = cursor;
      }
    }
    if (marker !== null && moved !== null) break;
    if (now() >= deadline) break;
    sleep(tickMs);
  }

  note(`model     ${marker === null ? 'unreadable' : `${marker.model}|${marker.role}`}`);
  note(`liveness  cursor ${first === null ? 'unreadable' : first} -> ${moved === null ? 'unchanged' : moved}`);

  if (marker !== null && marker.role === 'default' && moved !== null) {
    ok('verified  the marker applied with role=default, and the pane advanced');
    fix(`ax worker tail ${pane || '<pane>'}`);
    return 0;
  }

  if (marker === null) {
    bad('UNPROVEN model: no transcript yet. The child may still be booting, or its transcript sits on another host and was unreadable from here.');
  } else if (marker.role === '') {
    bad('UNPROVEN model: the child runs its BOOT model — the spec marker did not apply.');
  } else if (marker.role === 'fallback') {
    bad('UNPROVEN model: the quota chain moved this session, so the marker is not what decided.');
  } else {
    bad(`UNPROVEN model: ${marker.model}|${marker.role}`);
  }
  if (moved === null) {
    bad(`UNPROVEN liveness: the pane cursor did not advance within ${wait}s. A live in-place spinner also emits no new line — read the pane before concluding.`);
  }
  note('The dispatch DID happen. Do NOT relaunch (F-001) — inspect it:');
  fix(`ax worker start --show --request ${request}`);
  return 3;
}

/** The same marker read, wherever the transcript lives. */
function readMarker({ needle, env, sessionsRoot, host, exec, cwd }) {
  if (host === null) return modelMarker({ needle, env, sessionsRoot });
  const root = host.sessions ?? '';
  if (root === '') return null;
  // The identical question, asked on the machine the transcript lives on: `ax`
  // is there too, so this is the same verb rather than a weaker proxy for it.
  //
  // Through the ssh boundary, because ssh rejoins its arguments into ONE remote
  // shell command: the needle and the declared sessions root are quoted there,
  // and a target that would be read as a local option is refused.
  const out = remote(args => exec('ssh', args, cwd), host.ssh, `ax worker transcript --marker ${quote(needle)} --sessions ${quote(root)}`);
  if (out.error || out.status !== 0) return null;
  const answer = firstLine(out.stdout);
  if (answer === '') return null;
  const [model, role = ''] = answer.split('|');
  return { model, role };
}
