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
// a human-or-coordinator decision, with its message already written.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { setJsonPath } from './blocks.mjs';
import { PACKAGE_NAME, repoPaths } from './config.mjs';
import { run as execRun } from './exec.mjs';
import { bad, fix, note, ok, raw } from './log.mjs';

const USAGE = 'ax pin <X.Y.Z|vX.Y.Z> [--dry-run]';

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
  for (const arg of argv) {
    if (arg === '--dry-run') dry = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
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
    return refuse(
      `ax doctor could not run under ${target}, so nothing graded this checkout: ${String(doctor.error.message ?? doctor.error).trim()}`,
      `${join(root, 'bin', 'ax')} doctor   # make the bootstrap runnable, then re-run this verb`,
    );
  }
  if (doctor.status !== 0) {
    const findings = `${String(doctor.stdout ?? '')}${String(doctor.stderr ?? '')}`
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.trim() !== '');
    bad(`ax doctor refuses this checkout under ${target} — do not commit a pin the doctor rejects`);
    for (const line of findings) raw(line);
    if (findings.length === 0) note(`ax doctor exited ${doctor.status} and printed nothing — run it by hand to see why`);
    fix('ax doctor   # repair the findings above, then re-run this verb');
    return 1;
  }
  ok('doctor coherent under the new pin');

  // The git gesture stays yours, message included — see the header for why this
  // verb never runs it. A verification-only invocation earned no diff.
  if (changing) fix(`git add package.json pnpm-lock.yaml && git commit -m "chore(deps): bump ${PACKAGE_NAME} to ${target}" && git push`);
  return 0;
}
