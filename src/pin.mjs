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
  if (!existsSync(packagePath)) return refuse('no package.json at the repository root — there is no pin to move');

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
  if (changing) {
    // Ownership of the DIFF this verb creates, not of the repo: if the two
    // files it is about to change already carry someone's edits, moving the
    // pin would weld this bump to work that is not its own.
    const dirty = exec('git', ['status', '--porcelain', '--', 'package.json', 'pnpm-lock.yaml'], root);
    if (dirty.error || dirty.status !== 0) {
      return refuse(`git cannot answer whether package.json is clean: ${String(dirty.error ?? dirty.stderr ?? '').trim() || `exit ${dirty.status}`}`);
    }
    if (String(dirty.stdout ?? '').trim() !== '') {
      return refuse(
        'package.json or pnpm-lock.yaml already carries uncommitted changes — this bump refuses to weld its diff to work that is not its own',
        'commit or stash those changes first, then re-run',
      );
    }

    note(`${current} → ${target}`);
    if (dry) {
      note('dry run — package.json untouched, nothing installed');
      return 0;
    }

    setJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`, target);
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

    // `--no-frozen-lockfile`, because moving the pin IS a lockfile change.
    // Measured 2026-08-24 on ofmchat (pnpm 11, MakerKit workspace): a bare
    // `pnpm install` there is frozen by default, so it refused with
    // ERR_PNPM_OUTDATED_LOCKFILE — the manifest already rewritten above, the old
    // package still on disk, which is precisely the half-state the proof below
    // then refuses. This verb could never succeed on that repo. The flag is not
    // a loosening: rewriting `pnpm-lock.yaml` is the job, which is why the commit
    // gesture printed at the end stages it.
    const installed = exec('pnpm', ['install', '--no-frozen-lockfile'], root);
    if (installed.error || installed.status !== 0) {
      const detail = String(installed.error ?? '').trim() || String(installed.stderr ?? '').split('\n').filter(Boolean).slice(-3).join(' | ') || `exit ${installed.status}`;
      return refuse(`pnpm install refused the new pin: ${detail}`, `git checkout -- package.json && pnpm install   # back to ${current}`);
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
    return refuse(`the pin says ${target} but the installed package is ${onDisk} — the install served something else`, 'pnpm install --force   # then re-run this verb to re-prove');
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
  if (doInit) {
    const written = exec(join(root, 'bin', 'ax'), ['init'], root);
    if (written.error || written.status !== 0) {
      const reason = String(written.error?.message ?? written.stderr ?? '').trim();
      bad(`ax init could not run under ${target}, so the managed state this pin needs was never written${reason ? `: ${reason}` : ''}`);
      fix(`pnpm exec ax init   # by hand, then re-run: pnpm exec ax pin ${asked}`);
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
  const doctor = exec(join(root, 'bin', 'ax'), ['doctor'], root);
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
    fix(`pnpm exec ax init   # rewrite bin/ax from the installed ${PACKAGE_NAME} ${target}`);
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
    for (const repair of named) fix(repair.startsWith('ax ') ? `pnpm exec ${repair}` : repair);
    if (named.length === 0) note('the findings above named no repair — read them by hand, then re-run this verb');
    else fix(`pnpm exec ax pin ${asked}   # re-prove the pin once those are done`);
    return 1;
  }
  ok('doctor coherent under the new pin');

  // The git gesture stays yours, message included — see the header for why this
  // verb never runs it. A verification-only invocation earned no diff.
  if (changing) fix(`git add package.json pnpm-lock.yaml && git commit -m "chore(deps): bump ${PACKAGE_NAME} to ${target}" && git push`);
  return 0;
}
