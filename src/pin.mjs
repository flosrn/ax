// `ax pin` — move a consuming project onto an ax tag, without owning its git.
//
// The bump ritual was measured at four manual gestures, seven times in one day
// (2026-08-23): edit the pin, install, verify, commit-and-push. This verb does
// the mechanical half — edit, install, PROVE the installed version is the tag,
// run doctor — and then PRINTS the commit it earned, ready to paste.
//
// It deliberately never runs `git commit` or `git push`. A push publishes every
// local commit on the branch, including another actor's unpushed work, and no
// two-file staging rule prevents that; the checkout this runs in is shared with
// dispatched children by design. So the boundary is: ax mutates package.json
// and node_modules (which an install mutates anyway), and the git gesture stays
// a human-or-coordinator decision, with its message already written.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { setJsonPath } from './blocks.mjs';
import { PACKAGE_NAME, repoPaths } from './config.mjs';
import { bad, fix, note, ok, raw } from './log.mjs';

const USAGE = 'ax pin <vX.Y.Z> [--dry-run]';

/**
 * Installs take minutes, not the 30 seconds every other exec in this package
 * budgets for — a pnpm install over a MakerKit workspace was measured near a
 * minute on the machine this was written for, cold caches worse.
 */
const INSTALL_TIMEOUT_MS = 600_000;
export const pinExec = (bin, args, at) => {
  const out = spawnSync(bin, args, { cwd: at, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error };
};

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

  let tag = '';
  let dry = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dry = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else if (arg.startsWith('-')) return usageError(`unknown argument "${arg}"`);
    else if (tag !== '') return usageError(`one tag only, got "${tag}" and "${arg}"`);
    else tag = arg;
  }
  if (tag === '') return usageError('no tag given');
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) return usageError(`a pin is a release tag shaped vX.Y.Z, got "${tag}"`);

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
  // The SOURCE comes from the pin already there, never from a constant: a fork
  // or mirror distributes ax under its own owner, and a `link:` pin — the dev
  // workflow AGENTS.md itself teaches — carries no tag to move at all. Only the
  // fragment after `#` is this verb's business.
  const hash = current.lastIndexOf('#');
  if (hash === -1) {
    return refuse(
      `the current pin is "${current}", which carries no #tag — a link: or branchless pin is not moved by tag`,
      'edit package.json by hand if this checkout is meant to leave that pin',
    );
  }
  const target = `${current.slice(0, hash)}#${tag}`;
  if (current === target) {
    ok(`already pinned to ${tag} — nothing to move`);
    return 0;
  }

  // Ownership of the DIFF this verb creates, not of the repo: if the two files
  // it is about to change already carry someone's edits, moving the pin would
  // weld this bump to work that is not its own, and the printed commit below
  // would invite committing both. Refused, named.
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

  const installed = exec('pnpm', ['install'], root);
  if (installed.error || installed.status !== 0) {
    const detail = String(installed.error ?? '').trim() || String(installed.stderr ?? '').split('\n').filter(Boolean).slice(-3).join(' | ') || `exit ${installed.status}`;
    return refuse(`pnpm install refused the new pin: ${detail}`, `git checkout -- package.json && pnpm install   # back to ${current}`);
  }

  // The PROOF, not the receipt: an install can exit 0 while a lockfile override
  // or a cache serves yesterday's build. The version on disk is what will run.
  const installedManifest = join(root, 'node_modules', PACKAGE_NAME, 'package.json');
  let version = '';
  try {
    version = JSON.parse(readFileSync(installedManifest, 'utf8')).version;
  } catch {
    return refuse(`installed, but ${installedManifest} is unreadable — nothing proves which ax is on disk`);
  }
  if (`v${version}` !== tag) {
    return refuse(`the pin says ${tag} but the installed package is v${version} — the install served something else`, 'pnpm install --force   # then re-run this verb to re-prove');
  }
  ok(`installed ${PACKAGE_NAME} ${tag}, proven from node_modules`);

  const doctor = exec('pnpm', ['ax', 'doctor'], root);
  if (doctor.error || doctor.status !== 0) {
    return refuse(`ax doctor refuses this checkout under ${tag} — do not commit a pin the doctor rejects`, 'pnpm ax doctor   # read the findings, repair, then re-run this verb');
  }
  ok('doctor coherent under the new pin');

  // The git gesture stays yours, message included — see the header for why this
  // verb never runs it.
  fix(`git add package.json pnpm-lock.yaml && git commit -m "chore(deps): bump ${PACKAGE_NAME} to ${tag}" && git push`);
  return 0;
}
