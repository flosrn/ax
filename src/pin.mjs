// `ax pin` — move a consuming project onto an ax RELEASE, without owning its git.
//
// The bump ritual was measured at four manual gestures, seven times in one day
// (2026-08-23): edit the pin, install, verify, commit-and-push. This verb does
// the mechanical half — edit, install, PROVE the installed version is the one
// asked for, run doctor — and then PRINTS the commit it earned, ready to paste.
//
// The pin is an exact npm version, not a git tag: ax is published to the
// registry, so `0.9.0` is what the lockfile resolves and what the global CLI
// delegates to. `vX.Y.Z` is accepted as an argument because that is what the
// release tag and the changelog say, and typing what you just read should not
// be an error — but the manifest is written without the `v`, because that is
// the only form npm understands.
//
// It deliberately never runs `git commit` or `git push`. A push publishes every
// local commit on the branch, including another actor's unpushed work, and no
// two-file staging rule prevents that; the checkout this runs in is shared with
// dispatched children by design. So the boundary is: ax mutates package.json
// and node_modules (which an install mutates anyway), and the git gesture stays
// a human-or-orchestrator decision, with its message already written.
//
// A FLAG ON THIS VERB IS PARSED BY THE VERSION BEING LEFT, and that makes every
// new option unadoptable for exactly one release. The copy reading the argv is
// the one already installed, so a consumer that writes `ax pin "$V" --init`
// today breaks its very next bump: the release it is leaving answers `unknown
// argument "--init"` and refuses before it installs anything. Measured
// 2026-09-05 (#170), from gapila under 0.23.0. A receiving workflow therefore
// PROBES rather than assumes — `ax pin --help`, and pass the flag only when it
// is advertised (gapila PR #2043, commit 2202197) — which needs no second edit
// when the release carrying the flag lands. The same holds for any future
// option here, so a release note that announces one is announcing it for the
// bump AFTER the next.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { setJsonPath } from './blocks.mjs';
import { PACKAGE_NAME, repoPaths } from './config.mjs';
import { run as execRun } from './exec.mjs';
import { bad, fix, note, ok, raw } from './log.mjs';
import { planProject } from './plan.mjs';

const USAGE = 'ax pin <X.Y.Z|vX.Y.Z> [--init] [--dry-run]';

/** A release, however it was typed: `0.9.0` or the tag `v0.9.0`. */
const RELEASE = /^v?([0-9]+\.[0-9]+\.[0-9]+)$/;

/**
 * Installs take minutes, not the 30 seconds every other exec in this package
 * budgets for — a pnpm install over a MakerKit workspace was measured near a
 * minute on the machine this was written for, cold caches worse.
 */
const INSTALL_TIMEOUT_MS = 600_000;
export const pinExec = (bin, args, at) => execRun(bin, args, { cwd: at, timeout: INSTALL_TIMEOUT_MS });

/**
 * The package manager that owns this consumer's lockfile, and every file a bump
 * with it may change: the pin, its lockfile, and the workspace file pnpm
 * rewrites (#274). The lockfile decides, never a default: measured 2026-10-04
 * rolling 0.30.0 out, HarnessOS carries bun.lock, `pnpm install` left it on the
 * old version beside the new package.json, and every frozen `bun install` on
 * that main refused. A repository with no lockfile keeps pnpm, as before.
 */
function managerOf(root) {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    const lock = existsSync(join(root, 'bun.lock')) ? 'bun.lock' : 'bun.lockb';
    return { name: 'bun', install: ['install'], lock, files: ['package.json', lock], run: 'bunx' };
  }
  if (existsSync(join(root, 'package-lock.json')) && !existsSync(join(root, 'pnpm-lock.yaml'))) {
    return { name: 'npm', install: ['install'], lock: 'package-lock.json', files: ['package.json', 'package-lock.json'], run: 'npx' };
  }
  return { name: 'pnpm', install: ['install', '--no-frozen-lockfile'], lock: 'pnpm-lock.yaml', files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], run: 'pnpm exec' };
}

/**
 * THE pnpm PATCHES KEYED ON A VERSION OF ax OTHER THAN THE ONE BEING PINNED.
 *
 * A patch is keyed on an exact `name@version`, and pnpm refuses an install in
 * which a declared patch matches nothing (ERR_PNPM_UNUSED_PATCH). So a consumer
 * carrying a local patch of the ax it has cannot move to any other ax until the
 * patch goes. Measured 2026-09-29 rolling 0.28.0 out: ofmchat and a worktree of
 * it carried `'@flosrn/ax@0.26.3': patches/@flosrn__ax@0.26.3.patch`, and this
 * verb rewrote the manifest, ran the install and said only "exit 1". Whether
 * the release carries what the patch changed is the consumer's judgement, so
 * this names the patch and both ways past it, before anything moves.
 *
 * pnpm keeps the map in two places: `patchedDependencies` in
 * pnpm-workspace.yaml, read here as the indented lines under that top-level
 * key (no YAML parser: this package has no runtime dependencies), and
 * `pnpm.patchedDependencies` in package.json.
 */
function stalePatches(root, manifest, target) {
  const own = `${PACKAGE_NAME}@`;
  const found = [];
  const workspace = join(root, 'pnpm-workspace.yaml');
  if (existsSync(workspace)) {
    let inside = false;
    for (const line of readFileSync(workspace, 'utf8').split('\n')) {
      if (/^patchedDependencies:\s*$/.test(line)) {
        inside = true;
        continue;
      }
      if (/^\S/.test(line)) inside = false;
      const entry = inside ? /^\s+(['"]?)([^'"\s:]+)\1\s*:\s*(.*)$/.exec(line) : null;
      if (entry && entry[2].startsWith(own)) found.push({ key: entry[2], file: entry[3].trim().replace(/^(['"])(.*)\1$/, '$2'), where: 'pnpm-workspace.yaml' });
    }
  }
  const declared = manifest.pnpm?.patchedDependencies;
  if (declared !== null && typeof declared === 'object') {
    for (const [key, file] of Object.entries(declared)) if (key.startsWith(own)) found.push({ key, file: String(file), where: 'package.json' });
  }
  return found.filter(patch => patch.key !== `${own}${target}`);
}

/**
 * Why an install refused, in pnpm's own words. pnpm prints its `ERR_PNPM_*`
 * line on STDOUT, so a detail read from stderr alone was "exit 1" — the cause
 * sat in the other stream.
 */
function installRefusal(installed) {
  const lines = stream => String(stream ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const both = [...lines(installed.stderr), ...lines(installed.stdout)];
  const coded = both.find(line => /ERR_PNPM_|^ERR!|\bERROR\b/.test(line));
  return String(installed.error ?? '').trim() || coded || lines(installed.stderr).slice(-3).join(' | ') || lines(installed.stdout).slice(-3).join(' | ') || `exit ${installed.status}`;
}

export function pin(argv = [], { exec = pinExec, cwd = process.cwd() } = {}) {
  const usageError = message => {
    process.stderr.write(`ax pin: ${message}\n${USAGE}\n`);
    return 2;
  };
  const refuse = (message, repair) => {
    bad(message);
    if (repair) fix(repair);
    return 1;
  };

  let asked = '';
  let dry = false;
  let doInit = false;
  // No `--help` branch: `runCli` answers the flag from the registry before this
  // verb is reached, anywhere in its argv (../src/cli.mjs). This loop used to
  // scan the whole argv for it — the precedent the central read generalised —
  // and a second code path answering one question is how twenty subverbs came
  // to answer it five different ways (#89, #93).
  for (const arg of argv) {
    if (arg === '--dry-run') dry = true;
    else if (arg === '--init') doInit = true;
    else if (arg.startsWith('-')) return usageError(`unknown argument "${arg}"`);
    else if (asked !== '') return usageError(`one version only, got "${asked}" and "${arg}"`);
    else asked = arg;
  }
  if (asked === '') return usageError('no version given');
  const matched = RELEASE.exec(asked);
  if (!matched) return usageError(`a pin is a release shaped X.Y.Z, or its tag vX.Y.Z, got "${asked}"`);
  // Stored without the `v`: npm resolves versions, and the tag form is only an
  // input convenience so the string on the release page can be pasted as-is.
  const target = matched[1];

  const paths = repoPaths(cwd);
  if (!paths.root) return refuse('not inside a git repository');
  const root = paths.root;
  const packagePath = join(root, 'package.json');
  // `ax init` SEEDS a manifest now (./plan.mjs, FINDING THREE), so the absence
  // has a repair and this refusal names it — the same verb the "declares no
  // pin" refusal below points at, for the same missing pair.
  if (!existsSync(packagePath)) {
    return refuse('no package.json at the repository root — there is no pin to move', 'ax init   # writes the manifest, the pin and the ax script this verb moves');
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    return refuse(`package.json unreadable: ${String(error.message ?? error)}`);
  }
  // THE CHECKOUT THAT PUBLISHES ax HAS NO PIN TO MOVE, and `ax init` writes
  // none there by plan (./plan.mjs). The generic "declares no pin → ax init"
  // refusal below would therefore name a verb that will not write it: advice
  // that cannot come true is the same dead end as a finding with no fix.
  if (planProject({ manifest }).selfHosted) {
    return refuse(
      `this checkout IS ${PACKAGE_NAME} — its version is decided by the release, not by a pin, and a package cannot depend on itself`,
      `ax pin ${target}   # from the project that CONSUMES ax — this one publishes it`,
    );
  }
  const current = manifest.devDependencies?.[PACKAGE_NAME];
  if (typeof current !== 'string') {
    return refuse(`package.json declares no ${PACKAGE_NAME} pin`, 'ax init   # writes the pin and the ax script this verb moves');
  }
  // A `link:` or `file:` pin — the dev workflow AGENTS.md itself teaches — names
  // a checkout on this machine, not a release. Moving it to a version would
  // silently end that workflow, so it is refused by name. A `github:` pin is
  // NOT refused: migrating it to the registry is exactly this verb's job now.
  if (current.startsWith('link:') || current.startsWith('file:')) {
    return refuse(
      `the current pin is "${current}", a local checkout rather than a release — a version does not replace it`,
      'edit package.json by hand if this checkout is meant to leave that pin',
    );
  }
  const changing = current !== target;
  const pm = managerOf(root);
  const BUMP_FILES = pm.files;
  if (changing) {
    // Ownership of the DIFF this verb creates, not of the repo: if the files
    // it is about to change already carry someone's edits, moving the pin
    // would weld this bump to work that is not its own. pnpm-workspace.yaml is
    // one of them (#274): pnpm appends the new version to a
    // `minimumReleaseAgeExclude` entry that enumerates them.
    const dirty = exec('git', ['status', '--porcelain', '--', ...BUMP_FILES], root);
    if (dirty.error || dirty.status !== 0) {
      return refuse(`git cannot answer whether package.json is clean: ${String(dirty.error ?? dirty.stderr ?? '').trim() || `exit ${dirty.status}`}`);
    }
    if (String(dirty.stdout ?? '').trim() !== '') {
      return refuse(
        `${BUMP_FILES.join(', ')} already carry uncommitted changes — this bump refuses to weld its diff to work that is not its own`,
        'commit or stash those changes first, then re-run',
      );
    }

    note(`${current} → ${target}`);
    // Asked before the dry short-circuit on purpose: a dry run answers what the
    // real run would do, and the real run cannot install past this patch.
    // Answering 0 there would print a plan that the next command refutes.
    const stale = stalePatches(root, manifest, target);
    if (stale.length > 0) {
      const [patch] = stale;
      bad(
        `${patch.where} patches ${patch.key} (${patch.file}), and pnpm refuses any install in which a declared patch matches nothing — no other ${PACKAGE_NAME} can be installed while it stands`,
      );
      fix(`pnpm patch-remove ${patch.key}   # when ${target} already carries what the patch changed, then re-run: ax pin ${asked}`);
      fix(`pnpm patch ${PACKAGE_NAME}@${target}   # otherwise re-cut it against ${target}, commit it, then re-run: ax pin ${asked}`);
      return 1;
    }
    if (dry) {
      note('dry run — package.json untouched, nothing installed');
      return 0;
    }

    setJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`, target);
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

    // `--no-frozen-lockfile` for pnpm, because moving the pin IS a lockfile
    // change. Measured 2026-08-24 on ofmchat (pnpm 11, MakerKit workspace): a
    // bare `pnpm install` there is frozen by default, so it refused with
    // ERR_PNPM_OUTDATED_LOCKFILE — the manifest already rewritten above, the old
    // package still on disk, which is precisely the half-state the proof below
    // then refuses. The flag is not a loosening: rewriting the lockfile is the
    // job, which is why the commit gesture printed at the end stages it. bun
    // and npm rewrite theirs on a plain install.
    const installed = exec(pm.name, pm.install, root);
    if (installed.error || installed.status !== 0) {
      // AN INSTALL THAT REFUSED LEAVES NOTHING BEHIND. Both files were proven
      // clean above, so restoring them from git undoes exactly this verb's
      // write and nothing else. Measured 2026-09-29 rolling 0.28.0 out: two
      // consumers were left declaring 0.28.0 with 0.26.3 on disk, the half-state
      // the guard above then refuses on the next run, until a human restored
      // them — the repair used to be printed, never performed.
      const reason = installRefusal(installed);
      // Every tracked bump file, all proven clean above (#274 adds the workspace
      // file pnpm may rewrite before it refuses).
      const tracked = String(exec('git', ['ls-files', '--', ...BUMP_FILES], root).stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean);
      const restoring = tracked.includes('package.json') ? tracked : ['package.json', ...tracked];
      const restored = exec('git', ['checkout', '--', ...restoring], root);
      if (restored.error || restored.status !== 0) {
        return refuse(
          `${pm.name} install refused the new pin: ${reason} — and package.json could not be restored: ${String(restored.error ?? restored.stderr ?? '').trim() || `exit ${restored.status}`}`,
          `git checkout -- ${restoring.join(' ')} && ${pm.name} install   # back to ${current}`,
        );
      }
      return refuse(`${pm.name} install refused the new pin: ${reason} — ${restoring.join(' and ')} ${restoring.length === 1 ? 'is' : 'are'} back on ${current}`, `${pm.name} install   # only if the refused install touched node_modules; then re-run: ax pin ${asked}`);
    }
  } else {
    note(`already pinned to ${target} — re-proving the installed package and doctor`);
  }

  // The PROOF, not the receipt: an install can exit 0 while a lockfile override
  // or a cache serves yesterday's build. The version on disk is what will run.
  const installedManifest = join(root, 'node_modules', PACKAGE_NAME, 'package.json');
  let onDisk = '';
  try {
    onDisk = JSON.parse(readFileSync(installedManifest, 'utf8')).version;
  } catch {
    return refuse(`installed, but ${installedManifest} is unreadable — nothing proves which ax is on disk`);
  }
  if (onDisk !== target) {
    return refuse(`the pin says ${target} but the installed package is ${onDisk} — the install served something else`, `${pm.name} install --force   # then re-run this verb to re-prove`);
  }
  ok(`installed ${PACKAGE_NAME} ${target}, proven from node_modules`);

  // `--init` REGENERATES BEFORE IT GRADES, and only when asked. A release may
  // add a line to a managed block — 0.23.0 added `.env.local` to the ignore
  // block — and `ax doctor` then refuses the checkout for state only `ax init`
  // writes, so every automatic bump in every consumer went red until a human
  // committed init's output (#170: ofmchat 49cb36e0, gapila PR #2043). This
  // flag is what a receiving workflow can ask for; a plain `ax pin` still
  // rewrites nothing but the manifest, because rewriting a project's managed
  // files is a mutation nobody asked for. It runs AFTER the install proof —
  // init must be the version being pinned — and before the grading it exists
  // to satisfy.
  //
  // AND IT IS A WRITE, so `--dry-run` withholds it out loud. The dry
  // short-circuit above lives inside the `changing` branch — an unchanged pin
  // still has reads worth doing, the install proof and the grading — so a flag
  // that mutates cannot ride that fall through: `ax pin <same version>
  // --dry-run --init` reached this exec and rewrote a project's managed files
  // under the one flag that promises nothing moves.
  if (doInit && dry) note('dry run — ax init NOT run, so the grading below reads the checkout as it stands');
  if (doInit && !dry) {
    const written = exec(join(root, 'bin', 'ax'), ['init'], root);
    if (written.error || written.status !== 0) {
      const reason = String(written.error?.message ?? written.stderr ?? '').trim();
      bad(`ax init could not run under ${target}, so the managed state this pin needs was never written${reason ? `: ${reason}` : ''}`);
      fix(`${pm.run} ax init   # by hand, then re-run: ${pm.run} ax pin ${asked}`);
      return 1;
    }
    ok('managed state regenerated under the new pin (--init)');
  }

  // THE FINDINGS ARE THE REFUSAL. Measured 2026-08-28: 0.14.4 was announced to
  // goodluckagency/ofmchat, its bump workflow ran this verb, and the only artefact
  // of a blocked deployment was `ax doctor refuses this checkout under 0.14.4` —
  // the grading itself went to a captured subprocess and was dropped here. A
  // refusal whose cause is discarded cannot be acted on by the CI that hit it, and
  // the repair it names (`ax doctor`) is a command no runner will type.
  //
  // And a doctor that could not RUN is a different state from a checkout it
  // refused: one is incoherent, the other was never graded (F-028). Reporting the
  // second as the first sends someone to repair findings that do not exist.
  //
  // AND IT GRADES WHAT THE PIN COMMIT CARRIES (#276): `--project`. This
  // checkout's recorded worktree state (`.env.local`, node_modules) is no
  // commit's content, and a bump made from a fresh worktree of the default
  // branch — where scripts/deploy.mjs makes every bump (#286) — failed on
  // exactly that, whatever version it pinned. The doctor called here is the
  // NEW version's; one older than the flag ignores it and grades both halves,
  // which is how this verb behaved before.
  const doctor = exec(join(root, 'bin', 'ax'), ['doctor', '--project'], root);
  if (doctor.error) {
    // The repair must NOT be the path that just failed. This branch is reached on
    // ENOENT (no committed bootstrap) and EACCES (present, not executable), and
    // both are repaired by something else: `ax init` rewrites `bin/ax` from the
    // package that was just proven installed, and `chmod +x` fixes the mode. The
    // installed package is reachable here by construction — the proof above read
    // its manifest — so the repair runs through it rather than through the file
    // that is broken.
    const reason = String(doctor.error.message ?? doctor.error).trim();
    bad(`ax doctor could not run under ${target}, so nothing graded this checkout: ${reason}`);
    note(`${join(root, 'bin', 'ax')} is the bootstrap this verb calls — missing, or present and not executable`);
    fix(`${pm.run} ax init   # rewrite bin/ax from the installed ${PACKAGE_NAME} ${target}`);
    fix(`chmod +x ${join(root, 'bin', 'ax')}   # if it exists already and only the mode is wrong`);
    return 1;
  }
  if (doctor.status !== 0) {
    const output = `${String(doctor.stdout ?? '')}${String(doctor.stderr ?? '')}`;
    const findings = output
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.trim() !== '');
    bad(`ax doctor refuses this checkout under ${target} — do not commit a pin the doctor rejects`);
    for (const line of findings) raw(line);
    if (findings.length === 0) note(`ax doctor exited ${doctor.status} and printed nothing — run it by hand to see why`);
    // THE REPAIR IS THE ONE THE FINDINGS NAME. `ax doctor` was printed here
    // until 2026-09-05 (#170) — a read, which grades and repairs nothing, and
    // the one line a CI runner would have to type. Every finding already carries
    // its own `→ <command>` (`../log.mjs`: a `bad` without a `fix` is a finding
    // nobody can act on), so those are lifted, deduped in the order they were
    // printed, and `pnpm exec` prefixes the ax ones because the consumer's ax is
    // the installed package, not a global. A finding that named no repair is
    // said out loud rather than given an invented one.
    const named = [...new Set(findings.filter(line => line.trim().startsWith('→')).map(line => line.replace(/^\s*→\s*/, '')))];
    for (const repair of named) fix(repair.startsWith('ax ') ? `${pm.run} ${repair}` : repair);
    if (named.length === 0) note('the findings above named no repair — read them by hand, then re-run this verb');
    else fix(`${pm.run} ax pin ${asked}   # re-prove the pin once those are done`);
    return 1;
  }
  ok('doctor coherent under the new pin');

  // The git gesture stays yours, message included — see the header for why this
  // verb never runs it. A verification-only invocation earned no diff. It
  // stages every bump file the install actually changed (#274), no more.
  if (changing) {
    const changed = exec('git', ['status', '--porcelain', '--', ...BUMP_FILES], root);
    const touched = String(changed.stdout ?? '')
      .split('\n')
      .map(line => line.slice(3).trim())
      .filter(Boolean);
    const files = ['package.json', pm.lock, ...BUMP_FILES.filter(file => !['package.json', pm.lock].includes(file) && touched.includes(file))];
    fix(`git add ${files.join(' ')} && git commit -m "chore(deps): bump ${PACKAGE_NAME} to ${target}" && git push`);
  }
  return 0;
}
