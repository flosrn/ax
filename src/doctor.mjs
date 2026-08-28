import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getJsonPath, readBlock, styleFor } from './blocks.mjs';
import { CONFIG_FILE, PACKAGE_NAME, assetPath, loadConfig, repoPaths, vendorRemote, version } from './config.mjs';
import { EXACT_VERSION } from './dispatch.mjs';
import { LEGACY_OMP_LOADER, OMP_SETTINGS, ompExtensionRoot } from './init.mjs';
import { bad, fix, note, ok, section } from './log.mjs';
import { worktreeFindings } from './worktree/doctor.mjs';

/**
 * Answer one question — "is this checkout coherent?" — and answer it with an
 * exit code, so a setup script can branch on it.
 *
 * Every finding names the command that repairs it. A check that reports a
 * problem without its fix gets ignored, which is the same as not existing.
 */
export function doctor(cwd = process.cwd()) {
  const { root, main, isWorktree } = repoPaths(cwd);
  if (!root) {
    section('ax doctor');
    bad(`${cwd} is not inside a git repository`);
    return 1;
  }

  section(`ax doctor — ${root}`);
  let failures = 0;
  const fail = (message, command) => {
    bad(message);
    if (command) fix(command);
    failures += 1;
  };

  note(isWorktree ? `worktree of ${main}` : 'primary checkout');

  const { config, errors, exists } = loadConfig(root);
  if (!exists) {
    fail(`${CONFIG_FILE} is missing — no project plan can be derived`, 'ax init');
    return failures;
  }
  if (errors.length > 0) {
    fail(`${CONFIG_FILE} is invalid`, `edit ${CONFIG_FILE}`);
    for (const error of errors) note(error);
    return failures;
  }
  ok(`${CONFIG_FILE}: ${config.project.display}, dev ports ${config.ports.dev[0]}-${config.ports.dev[1]}`);

  // 1. The bootstrap, because every other command is reached through it.
  const bootstrapPath = join(root, 'bin', 'ax');
  const shipped = readFileSync(assetPath('bootstrap', 'ax'), 'utf8');
  if (!existsSync(bootstrapPath)) fail('bin/ax is missing — no committed project-local bootstrap exists', 'ax init');
  else if (readFileSync(bootstrapPath, 'utf8') !== shipped) fail('bin/ax differs from the version this ax ships', 'ax init');
  else if (!(statSync(bootstrapPath).mode & 0o111)) fail('bin/ax is not executable', 'chmod +x bin/ax');
  else ok('bin/ax resolves this checkout, then the primary one');

  // 2. OMP loads the package root, then reads this release's own
  //    `omp.extensions` manifest. The settings file is shared with the project:
  //    grade the one array entry ax owns, never the whole document.
  const settingsPath = join(root, ...OMP_SETTINGS.split('/'));
  const expectedExtension = ompExtensionRoot(root);
  if (!existsSync(settingsPath)) {
    fail(`${OMP_SETTINGS} is missing — OMP loads no ax package in this project`, 'ax init');
  } else {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const extensions = settings?.extensions;
      if (!Array.isArray(extensions) || extensions.some(entry => typeof entry !== 'string')) {
        fail(`${OMP_SETTINGS}.extensions is not an array of package-root strings`, 'ax init');
      } else {
        const registrations = extensions.filter(entry => entry === expectedExtension).length;
        if (registrations !== 1) {
          fail(`${OMP_SETTINGS} registers ${expectedExtension} ${registrations} time(s) — OMP needs exactly one AX bundle`, 'ax init');
        } else {
          ok(`${OMP_SETTINGS}: OMP loads ${expectedExtension}`);
        }
      }
    } catch (error) {
      fail(`${OMP_SETTINGS} is not valid JSON (${error.message})`, 'ax init');
    }
  }
  const legacyLoaderPath = join(root, ...LEGACY_OMP_LOADER.split('/'));
  if (existsSync(legacyLoaderPath)) {
    fail(`${LEGACY_OMP_LOADER} is the retired wrapper — loading it beside the package root duplicates every AX handler`, 'ax init');
  }

  // 3. The managed touchpoints in files the vendor also owns.
  const manifestPath = join(root, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const pinned = getJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`);
  if (getJsonPath(manifest, 'scripts.ax') !== './bin/ax') fail('package.json: scripts.ax does not point at ./bin/ax', 'ax init');
  else if (!pinned) fail(`package.json: no ${PACKAGE_NAME} version pinned`, 'ax init');
  // A git pin resolves outside the registry and outside the lockfile's version
  // arithmetic, so the global CLI cannot tell which version it would delegate
  // to. ax is published now; the pin is a version.
  else if (pinned.startsWith('github:') || pinned.startsWith('git+')) fail(`package.json: ${PACKAGE_NAME} is pinned to ${pinned}, a git ref — ax is published to npm, and the pin is an exact version now`, `ax pin ${version}`);
  else if (pinned.startsWith('link:') || pinned.startsWith('file:')) note(`package.json: ${PACKAGE_NAME} pinned to ${pinned} — a local dev checkout, not a release`);
  else if (!EXACT_VERSION.test(pinned)) fail(`package.json: ${PACKAGE_NAME} is pinned to the range ${pinned} — a range changes this repo's tooling on someone else's install`, `ax pin ${version}`);
  else ok(`package.json: pinned to ${PACKAGE_NAME} ${pinned}`);

  for (const file of ['.gitignore', 'AGENTS.md']) {
    const path = join(root, file);
    if (!existsSync(path)) {
      fail(`${file} is missing`, 'ax init');
      continue;
    }
    const block = readBlock(readFileSync(path, 'utf8'), { id: 'ax', style: styleFor(file) });
    if (block === null) fail(`${file} carries no BEGIN:ax block`, 'ax init');
    else ok(`${file}: managed block present`);
  }

  // 4. Vendor ownership is optional. When declared, the remote is found by URL
  // and every guarded tree is checked; a plain repo simply skips this domain.
  //
  // A MISSING REMOTE IS NOT MEASURED, NOT A REFUSAL, and that distinction cost a
  // deployment. Measured 2026-08-28: `@flosrn/ax@0.14.4` was announced to
  // goodluckagency/ofmchat, its bump workflow checked out main with
  // `actions/checkout` — which configures `origin` and nothing else — and ran
  // `ax pin`, whose doctor gate refused the tree on this one line. The pin never
  // landed, so a published fix could not reach the repository that reported the
  // bug it fixes.
  //
  // The finding's own words were "vendor checks cannot run": an inability to
  // measure, reported as incoherence. The remote has exactly two consumers in
  // this package — `ax init`, which infers the vendor block from it, and this
  // grading — so nothing ax DOES breaks without it. And the guarded-tree
  // ownership checks below do not need it at all: they read the filesystem, so
  // they still run and still fail on an unclaimed path. Demoting this line loses
  // the remote's presence and nothing else, which is why it reports loudly with
  // its repair instead, exactly like the absent guarded trees do.
  if (config.vendor !== undefined) {
    const remote = vendorRemote(root, config.vendor.repo);
    if (!remote) {
      note(`no remote points at ${config.vendor.repo} — vendor checks NOT MEASURED here`);
      fix(`git remote add vendor git@github.com:${config.vendor.repo}.git   # then vendor ownership is graded again`);
    } else {
      ok(`vendor kit ${config.vendor.repo} on remote "${remote}"`);
    }

    for (const [tree, rule] of Object.entries(config.vendor.guarded ?? {})) {
      const treePath = join(root, tree);
      if (!existsSync(treePath)) {
        note(`${tree}/ declared guarded but absent here`);
        continue;
      }
      if (rule === 'vendor') {
        ok(`${tree}/ entirely vendor`);
        continue;
      }
      const entries = readdirSync(treePath).filter(entry => entry !== '.DS_Store');
      const claimed = new Set([...rule.ours, ...rule.vendor]);
      const undeclared = entries.filter(entry => !claimed.has(entry));
      if (undeclared.length > 0) {
        fail(`${tree}/: ${undeclared.length} path(s) claimed by neither side: ${undeclared.join(', ')}`, `add each to vendor.guarded["${tree}"].ours or .vendor in ${CONFIG_FILE}`);
      } else {
        ok(`${tree}/: ${rule.ours.length} ours, ${rule.vendor.length} vendor, none unclaimed`);
      }
    }
  }

  // 6. App paths, since every later command derives from them.
  for (const [key, relative] of Object.entries(config.apps)) {
    if (key === 'caches') continue;
    if (!existsSync(join(root, relative))) fail(`apps.${key} points at ${relative}, which does not exist`, `fix apps.${key} in ${CONFIG_FILE}`);
    else ok(`apps.${key}: ${relative}`);
  }

  // 7. The worktree half: the plan `ax worktree setup` writes, compared against
  //    what this checkout actually recorded. Here rather than behind a second
  //    command because it answers the same question this one already asks, and a
  //    coherence check nobody runs is not a check.
  section('worktree');
  for (const finding of worktreeFindings({ root, main, config })) {
    if (finding.level === 'bad') fail(finding.message, finding.fix);
    else if (finding.level === 'note') {
      note(finding.message);
      if (finding.fix) fix(finding.fix);
    } else {
      ok(finding.message);
    }
  }

  if (failures === 0) ok('checkout is coherent');
  return failures;
}
