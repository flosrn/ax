import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getJsonPath, readBlock, styleFor } from './blocks.mjs';
import { CONFIG_FILE, PACKAGE_NAME, assetPath, loadConfig, repoPaths, vendorRemote } from './config.mjs';
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
    fail(`${CONFIG_FILE} is missing — no port band, no app paths, no vendor kit`, 'pnpm ax init');
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
  if (!existsSync(bootstrapPath)) fail('bin/ax is missing — `pnpm ax` cannot resolve in a fresh worktree', 'pnpm ax init');
  else if (readFileSync(bootstrapPath, 'utf8') !== shipped) fail('bin/ax differs from the version this ax ships', 'pnpm ax init');
  else if (!(statSync(bootstrapPath).mode & 0o111)) fail('bin/ax is not executable', 'chmod +x bin/ax');
  else ok('bin/ax resolves this checkout, then the primary one');

  // 2. The four managed touchpoints in files the vendor also owns.
  const manifestPath = join(root, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  if (getJsonPath(manifest, 'scripts.ax') !== './bin/ax') fail('package.json: scripts.ax does not point at ./bin/ax', 'pnpm ax init');
  else if (!getJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`)) fail(`package.json: no ${PACKAGE_NAME} version pinned`, 'pnpm ax init');
  else ok(`package.json: pinned to ${getJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`)}`);

  for (const file of ['.gitignore', 'AGENTS.md']) {
    const path = join(root, file);
    if (!existsSync(path)) {
      fail(`${file} is missing`, 'pnpm ax init');
      continue;
    }
    const block = readBlock(readFileSync(path, 'utf8'), { id: 'ax', style: styleFor(file) });
    if (block === null) fail(`${file} carries no BEGIN:ax block`, 'pnpm ax init');
    else ok(`${file}: managed block present`);
  }

  // 3. The vendor kit, found by URL — a renamed remote must not read as absent.
  const remote = vendorRemote(root, config.vendor.repo);
  if (!remote) {
    fail(`no remote points at ${config.vendor.repo} — vendor checks cannot run`, `git remote add vendor git@github.com:${config.vendor.repo}.git`);
  } else {
    ok(`vendor kit ${config.vendor.repo} on remote "${remote}"`);
  }

  // 4. Guarded trees: every top-level path must be claimed by one side. An
  //    unclaimed path is how vendor content starts drifting unnoticed.
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

  // 5. App paths, since every later command derives from them.
  for (const [key, relative] of Object.entries(config.apps)) {
    if (key === 'caches') continue;
    if (!existsSync(join(root, relative))) fail(`apps.${key} points at ${relative}, which does not exist`, `fix apps.${key} in ${CONFIG_FILE}`);
    else ok(`apps.${key}: ${relative}`);
  }

  // 6. The worktree half: the plan `ax worktree setup` writes, compared against
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
