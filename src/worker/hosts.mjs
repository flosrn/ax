// The grounds a REMOTE dispatch stands on: which host a project declared, and
// whether that host can actually carry one more session.
//
// WHY EVERY GROUND HERE IS A GROUND
// A child placed on a host that cannot hold it does not fail visibly. It gets
// killed mid-build and reads the kill as its own build breaking, so the operator
// debugs the branch instead of the machine. Each check below refuses BEFORE the
// dispatch, or announces itself as unproven — never silently passes.
//
// FAIL OPEN ON AN UNREADABLE PROBE, FAIL CLOSED ON A MEASURED SHORTAGE.
// A path that moved, a host with no such unit and a dead transport are one
// output here, and none of them is a shortage. Only a number that was really
// read may stop a dispatch; everything else is a NOTE. A transport change must
// not stop remote work.
//
// NOTHING IS DEFAULTED. A floor measured for one fleet, inherited by a repo that
// never declared it, is the same bug in a new place — so a ground the project
// did not declare is reported as NOT MEASURED, which is not the same as passed.

import { spawnSync } from 'node:child_process';

/** MiB, the unit every `memory.*` file and every floor in this file speaks. */
const MB = 1048576;

/**
 * `ssh`, run for real. Injected everywhere so the suite proves the arithmetic
 * and the ordering with no host, no network and no credential.
 */
const defaultSsh = args => {
  const out = spawnSync('ssh', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error };
};

/** A ref is about to be pasted into a remote shell. Anything else is refused a probe. */
const SAFE_REF = /^[A-Za-z0-9._#/-]+$/;

/** A ref is data, never a pattern: it is compared literally wherever it is matched. */
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const lastSegment = value =>
  String(value ?? '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();

/**
 * The host `--on <env>` names, exactly as the project declared it.
 *
 * An environment the project never declared is a refusal, not a bare ssh guess:
 * dispatching to an undeclared host is how a floor goes unmeasured, and an
 * unmeasured floor is indistinguishable from a floor that passed.
 */
export function hostFor(config, env) {
  const hosts = config?.launch?.hosts ?? {};
  const declared = Object.keys(hosts);
  const host = env ? hosts[env] : undefined;
  if (!host || typeof host !== 'object')
    return {
      ok: false,
      reason: `'${env}' is not a host this project declared${declared.length ? ` (it declares ${declared.map(name => `'${name}'`).join(', ')})` : ''}. Declare it under launch.hosts.${env} in ax.config.json with at least its ssh target, plus the diskPath/diskFloorGb and cgroup/memFreeFloorMb pairs you want measured — a host reached without those floors is dispatched to blind.`,
    };
  if (!host.ssh)
    return {
      ok: false,
      reason: `launch.hosts.${env} declares no ssh target, and every ground on a remote host is read over ssh. Add "ssh" to launch.hosts.${env} in ax.config.json.`,
    };
  return { ok: true, host };
}

/**
 * THE arithmetic: how much of a cgroup's ceiling is held by memory the kernel
 * cannot reclaim. Pure, so the measurement below is a test and not a story.
 *
 *   work = current - inactive_file - active_file - slab_reclaimable + shmem
 *   free = max - work
 *
 * The number that decides a launch is NOT `memory.current`. Measured on the real
 * host 2026-08-14 16:05, 40 minutes after a sweep:
 *     memory.current  10 909 MB = 88 %   ← what a naive reading refuses on
 *     unreclaimable    1 814 MB = 14 %   ← what the OOM-killer has to work with
 *     reclaimable cache 9 095 MB
 * `memory.current` counts page cache, which the kernel drops under pressure. A
 * guard on it refuses every launch onto a host that has merely READ a lot of
 * files — a git clone and a pnpm install do exactly that.
 *
 * The formula is the fleet's own, not one invented here: `mem-watch.sh` sources
 * `base/cron-scripts/lib/cgroup-verdict.sh:29-33`, whose alert reads
 * "Irrécupérable : 7.3/12.0 Go" where a `memory.current` reading said 85 %. It
 * deducts the two reclaimable file LRUs rather than the `file` counter, because
 * `file` also holds unevictable mlocked pages, and adds `shmem` back because
 * tmpfs is accounted there but needs swap to go. That library lives in another
 * repository and cannot be imported, so the arithmetic is repeated here against
 * the same `memory.stat` — and this comment names the source so a future change
 * to one is findable from the other.
 *
 * The deduction is from CURRENT, never from max: taking it from max yields a
 * near-constant work whatever the host is doing, so the check passes always —
 * worse than absent, because it reads as a proof.
 *
 * null, meaning "no verdict", for the two reads that are not witnesses:
 *   * no `anon` line — a truncated read must not be mistaken for a measurement
 *     of zero.
 *   * `memory.max` is the literal `max` — an uncapped cgroup has no ceiling to
 *     be near and must not be refused for one.
 */
export function unreclaimableMb(statText, { current, max } = {}) {
  const max_ = Number(max);
  const current_ = Number(current);
  if (!Number.isFinite(max_) || max_ <= 0) return null;
  if (!Number.isFinite(current_) || current_ < 0) return null;

  const counters = { inactive_file: 0, active_file: 0, slab_reclaimable: 0, shmem: 0 };
  let witnessed = false;
  for (const line of String(statText ?? '').split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === 'anon') witnessed = true;
    if (key in counters) counters[key] = Number(value) || 0;
  }
  if (!witnessed) return null;

  const work = current_ - counters.inactive_file - counters.active_file - counters.slab_reclaimable + counters.shmem;
  // The unreclaimable set can exceed the ceiling transiently; clamp so free
  // never goes negative and the refusal below stays readable.
  return {
    maxMb: Math.floor(max_ / MB),
    workMb: Math.floor(Math.max(0, work) / MB),
    freeMb: Math.floor(Math.max(0, max_ - work) / MB),
  };
}

/**
 * Every ground on a declared host, IN THIS ORDER — disk, sweep, memory, tracker
 * — each one announced in `notes` whether it passed, was skipped for want of a
 * declaration, or could not be read.
 *
 * Order is load-bearing: the sweep runs BEFORE memory is measured, because a
 * browser an earlier stage left open is not a tenant and refusing a launch over
 * 825 MB of dead renderers would be a refusal about garbage.
 *
 * A refusal carries the notes taken before it: the grounds already proven are
 * what tells the operator whether the shortage is the whole story.
 */
export function proveHost(host, { ssh = defaultSsh, kind, ref } = {}) {
  const notes = [];
  const at = host.ssh;
  const refuse = reason => ({ ok: false, reason, notes });

  // A worktree on that host installs its own dependencies — pnpm's store is
  // shared, the tree is not. Measured 2026-08-14: 42G of 301G free is why this
  // floor exists at all. An unreadable `df` is a NOTE, deliberately.
  if (host.diskPath && Number.isInteger(host.diskFloorGb)) {
    const read = ssh([at, `df -BG --output=avail ${host.diskPath} 2> /dev/null | tail -1`]);
    // Digits of the LAST non-empty line, so a header or a warning above it
    // cannot be concatenated into a number that reads like free space.
    const digits = String(read.stdout ?? '')
      .split('\n')
      .map(line => line.replace(/\D/g, ''))
      .filter(Boolean)
      .pop();
    const availGb = Number(digits);
    if (digits !== undefined) {
      if (availGb < host.diskFloorGb)
        return refuse(
          `only ${availGb}G free on ${host.diskPath} at '${at}', and every worktree placed there installs its own dependencies (floor ${host.diskFloorGb}G). Free space on that mount, or lower launch.hosts.*.diskFloorGb once you have measured that the smaller floor still fits an install.`,
        );
      notes.push(`free disk on '${at}': ${availGb}G on ${host.diskPath}, over the ${host.diskFloorGb}G floor`);
    } else {
      notes.push(
        `free disk on '${at}' could not be read over ssh — that ground is unproven, not passed. Check launch.hosts.*.diskPath exists there, or run df yourself before dispatching.`,
      );
    }
  } else {
    notes.push(
      `free disk on '${at}' was NOT MEASURED: it needs both diskPath and diskFloorGb under launch.hosts in ax.config.json. Declare the pair to have it measured.`,
    );
  }

  // Failure is silent about WHY on purpose, and announced as not-swept: a sweep
  // that cannot run must never be why a dispatch stops.
  if (Array.isArray(host.sweep) && host.sweep.length > 0) {
    const swept = ssh([at, host.sweep.join(' ')]);
    if (swept.status === 0) notes.push(`swept stale browsers on '${at}' before measuring memory`);
    else
      notes.push(
        `the browser sweep on '${at}' did not run, so memory is measured with whatever an earlier stage left open — this never blocks a dispatch. Run launch.hosts.*.sweep there by hand if the memory ground below refuses.`,
      );
  } else {
    notes.push(
      `no browser sweep declared for '${at}', so memory is measured with whatever is still running. Declare launch.hosts.*.sweep to reclaim dead renderers before the measurement.`,
    );
  }

  // Not `free`, which reads the HOST and is blind to a cgroup against its own
  // wall. One round trip: the three files come back together and the arithmetic
  // stays here, rather than in a remote shell whose quoting is a second thing to
  // get right. Unreadable is a NOTE, matching the disk ground above.
  if (host.cgroup && Number.isInteger(host.memFreeFloorMb)) {
    const read = ssh([at, `cat ${host.cgroup}/memory.current ${host.cgroup}/memory.max ${host.cgroup}/memory.stat 2> /dev/null`]);
    const lines = String(read.stdout ?? '').split('\n');
    const verdict = unreclaimableMb(lines.slice(2).join('\n'), { current: lines[0], max: lines[1] });
    if (verdict === null) {
      notes.push(
        `cgroup memory on '${at}' could not be read as a measurement — that ground is unproven, not passed (an uncapped memory.max reads this way too, and an uncapped cgroup has no ceiling to be near). Check launch.hosts.*.cgroup still names the unit every session there shares.`,
      );
    } else if (verdict.freeMb < host.memFreeFloorMb) {
      // No apostrophe in a refusal: this text crosses shells, and a refusal
      // that cannot be printed is a refusal nobody can act on.
      return refuse(
        `only ${verdict.freeMb} MB of unreclaimable headroom left in the cgroup on '${at}' (${verdict.workMb} of ${verdict.maxMb} MB already held, floor ${host.memFreeFloorMb} MB). A child placed now is not given a share of the shortage: the kernel kills the largest RSS in the cgroup, so the newcomer is killed for the appetite of an incumbent and reads it as its own build failing. Free or sweep that host first, or place this child somewhere else.`,
      );
    } else {
      notes.push(
        `memory on '${at}': ${verdict.freeMb} MB of unreclaimable headroom (${verdict.workMb} of ${verdict.maxMb} MB held), over the ${host.memFreeFloorMb} MB floor`,
      );
    }
  } else {
    notes.push(
      `cgroup memory on '${at}' was NOT MEASURED: it needs both cgroup and memFreeFloorMb under launch.hosts in ax.config.json. Declare the pair to have it measured.`,
    );
  }

  // The child is told its ticket is canonical and sent to read it ITSELF — on
  // THAT host, not on the one that built the brief. A Linear credential is per
  // host: measured, `linear_not_connected` came back from the remote host while
  // the local CLI answered the ticket in full. A child that cannot read its
  // ticket improvises from the brief alone while every other ground passes.
  //
  // Linear only, deliberately: `gh issue view` needs a repository context, and
  // before placement there is no checkout on that host to give it one — a probe
  // that invented its own context would test something other than what the
  // child will do.
  if (kind === 'linear' && ref) {
    if (!SAFE_REF.test(ref)) {
      notes.push(`the tracker on '${at}' was not probed: '${ref}' carries characters this refuses to paste into a remote shell. Read it there by hand before dispatching.`);
    } else {
      const probe = ssh([at, `bash -lc 'command -v orca-ide > /dev/null 2>&1 && O=orca-ide || O=orca; "$O" linear issue ${ref} --json'`]);
      const answer = String(probe.stdout ?? '');
      // The ref is matched LITERALLY. `SAFE_REF` admits `.`, `#` and `/`, and an
      // unescaped `.` in a pattern is a wildcard: probing `ABC.1` would take an
      // answer identifying `ABCX1` as the ticket echoing back, which is the one
      // outcome that has to refuse.
      if (new RegExp(`"identifier"\\s*:\\s*"${escapeRegExp(ref)}"`).test(answer)) {
        // Name WHICH path was proven, because there are two and they
        // authenticate separately. This proves the `orca linear` CLI, the one
        // the brief tells the child to use, backed by a Personal API key in that
        // host's Orca settings. It says NOTHING about the Linear MCP server,
        // which is OAuth and answers 401 on a headless host — measured
        // 2026-08-15, where a child's boot banner read `linear ...
        // invalid_token` while the CLI answered the ticket in full. A verdict
        // that did not name its path would let the next reader take the banner
        // as this guard being wrong, or worse, the reverse.
        notes.push(
          `tracker on '${at}' reads ${ref} over the orca CLI — the child can open its own ticket (the Linear MCP server authenticates separately and is not covered by this)`,
        );
      } else if (answer.trim() === '') {
        // Nothing came back. A dead transport, a host with no runtime and a
        // tracker that answered nothing are one output here, and only the last
        // is a wall — so this is unproven, never a refusal. Empty is an absence
        // of information, not an absence of problem.
        notes.push(
          `the tracker on '${at}' answered nothing — that ground is unproven, not passed. Run \`orca linear issue ${ref} --json\` there yourself if the child later plans without its acceptance criteria.`,
        );
      } else {
        return refuse(
          `the tracker on '${at}' answered, but not with ${ref} — so the child placed there cannot read the ticket this brief calls canonical. It would plan from the brief alone and never see the acceptance criteria, while disk, memory and the model marker all pass. Connect it before dispatching: the credential and the agent skill are two separate halves, and a green badge beside an unusable CLI is what half a setup looks like. What came back: ${answer.slice(0, 200).replace(/\n/g, ' ')}`,
        );
      }
    }
  }

  return { ok: true, notes };
}

/**
 * The remote repository id a `--repo id:<uuid>` placement needs, matched on the
 * LAST PATH SEGMENT of each repository — `/srv/orca/acme` answers to `acme`.
 *
 * Matched on the path rather than on `displayName`, which an operator renames in
 * the UI without anything noticing. Zero matches and two matches are both
 * refusals: an id guessed here creates a worktree in the wrong repository on
 * another machine, which is the one mistake no local check catches afterwards.
 */
export function repoIdFor(base, { run, env } = {}) {
  const want = lastSegment(base);
  const listing = `orca repo list --environment ${env} --json`;
  if (!want) return { ok: false, reason: `no repository name to match on '${env}'. Pass --repo-id, or launch from inside a git checkout whose directory name matches the repository there.` };

  const out = run(['repo', 'list', '--environment', env, '--json']);
  const repos = out?.receipt?.result?.repos;
  if (!Array.isArray(repos))
    return {
      ok: false,
      reason: `could not list the repositories on '${env}'${out?.stderr ? `: ${String(out.stderr).trim().split('\n')[0]}` : ''}. Run \`${listing}\` and pass the id with --repo-id.`,
    };

  const hits = repos.filter(repo => lastSegment(repo?.path) === want && repo?.id);
  if (hits.length !== 1)
    return {
      ok: false,
      reason: `${hits.length === 0 ? 'no repository' : `${hits.length} repositories`} named '${want}' on '${env}', and a guessed id creates the worktree in the wrong repository on another machine. List them with \`${listing}\`, then pass the right one with --repo-id.`,
    };
  return { ok: true, id: `id:${hits[0].id}` };
}
