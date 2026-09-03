import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getJsonPath, readBlock, styleFor } from './blocks.mjs';
import { CONFIG_FILE, PACKAGE_NAME, assetPath, loadConfig, repoPaths, vendorRemote, version } from './config.mjs';
import { EXACT_VERSION } from './delegation.mjs';
import { BLOCK_BODIES, LEGACY_OMP_LOADER, OMP_SETTINGS, retiredConfigKeyFixes } from './init.mjs';
import { bad, fix, note, ok, section } from './log.mjs';
import { CONTRACTS, planProject, readManifest } from './plan.mjs';
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

  const { config, errors, exists, declared } = loadConfig(root);
  if (!exists) {
    fail(`${CONFIG_FILE} is missing — no project plan can be derived`, 'ax init');
    return failures;
  }
  if (errors.length > 0) {
    fail(`${CONFIG_FILE} is invalid`, `edit ${CONFIG_FILE}`);
    for (const error of errors) note(error);
    // Where each retired key WENT, root level only. The table, both bounds and
    // their measured cost live in ./init.mjs, which `ax init` reads on the same
    // refusal so neither verb can name a repair the other does not.
    for (const repair of retiredConfigKeyFixes(errors)) fix(repair);
    return failures;
  }
  ok(`${CONFIG_FILE}: ${config.project.display}, dev ports ${config.ports.dev[0]}-${config.ports.dev[1]}`);

  // The project plan, derived once from this checkout's own manifest and the
  // contracts its configuration declares (./plan.mjs). Everything below grades a
  // recorded value against one of its fields — which is what makes a finding
  // repairable by the verb that writes the plan, and what keeps two states off
  // the findings list entirely: the checkout that IS the package, and a contract
  // this project never adopted.
  const manifest = readManifest(root);
  const plan = planProject({ manifest, declared });

  // The `$schema` pointer is a plan value `ax init` writes, so it is compared
  // like every other one. It resolves nothing at runtime and everything in an
  // editor, which is exactly why it went wrong in silence: on a checkout that
  // publishes ax, an older release of that verb wrote
  // `./node_modules/@flosrn/ax/…`, a path that cannot exist there, and both
  // verbs exited 0 over it (caught in review on #85).
  //
  // ABSENT IS NOT DRIFT. The key is optional, and a config that never declared
  // one has no recorded value to disagree with the plan — reporting it would be
  // this package demanding a line it does not own.
  if (config.$schema !== undefined && config.$schema !== plan.schemaRef) {
    fail(`${CONFIG_FILE}: $schema points at ${config.$schema}, and the plan for this checkout is ${plan.schemaRef}`, 'ax init');
  }

  // NOT ADOPTED IS NOT A FINDING. gapila declares `prGate` and nothing else, by
  // design: it provisions itself and asks ax for the merge gate only. Grading
  // the provisioning contract there produced five findings, every one naming
  // `ax init` as the repair for a contract nobody opted into — advice that, if
  // followed, changes a project against its own decision. So the contract is
  // reported as unadopted, with the verb that adopts it, and nothing it covers
  // is measured. An unrun check is never a passed one either: the lines below
  // simply do not run, and the report says so.
  if (!plan.adopted.provisioning) {
    const provisioning = CONTRACTS.find(contract => contract.id === 'provisioning');
    const adopted = CONTRACTS.filter(contract => plan.adopted[contract.id]).map(contract => `${contract.name} (${contract.declaration})`);
    const declares = adopted.length > 0 ? `${adopted.join(', ')} and no "${provisioning.declaration}"` : 'no contract at all';
    note(`${provisioning.name} — NOT ADOPTED here: ${CONFIG_FILE} declares ${declares}, so NONE of it is measured — ${provisioning.covers}`);
    fix(`${provisioning.verb}   # adopt it — declares "${provisioning.declaration}" and writes everything that contract covers`);
    return failures;
  }

  // 1. The bootstrap, because every other command is reached through it — except
  //    in the checkout that publishes ax, where the shim would exec
  //    `node_modules/.bin/ax` and no package is an install of itself.
  const bootstrapPath = join(root, 'bin', 'ax');
  if (!plan.bootstrap) {
    if (existsSync(bootstrapPath)) {
      fail(
        `bin/ax exists and this checkout IS ${PACKAGE_NAME} — that shim execs node_modules/.bin/ax, an install of this very package`,
        'rm bin/ax',
      );
    } else {
      note(`this checkout IS ${PACKAGE_NAME} — it reaches its own CLI through the "bin" field it publishes, so no shim and no self-pin belong here`);
    }
  } else {
    const shipped = readFileSync(assetPath('bootstrap', 'ax'), 'utf8');
    if (!existsSync(bootstrapPath)) fail('bin/ax is missing — no committed project-local bootstrap exists', 'ax init');
    else if (readFileSync(bootstrapPath, 'utf8') !== shipped) fail('bin/ax differs from the version this ax ships', 'ax init');
    else if (!(statSync(bootstrapPath).mode & 0o111)) fail('bin/ax is not executable', 'chmod +x bin/ax');
    else ok('bin/ax resolves this checkout, then the primary one');
  }

  // 2. OMP loads the package root, then reads this release's own
  //    `omp.extensions` manifest. The settings file is shared with the project:
  //    grade the one array entry ax owns, never the whole document.
  const settingsPath = join(root, ...OMP_SETTINGS.split('/'));
  const expectedExtension = plan.ompExtension;
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
  const pinned = getJsonPath(manifest, `devDependencies.${PACKAGE_NAME}`);
  if (!plan.pin) {
    // A self-pin is a recorded value the plan refuses, so it IS graded — the
    // state `ax init` used to write here and no install could ever resolve.
    if (pinned !== undefined) {
      fail(`package.json pins ${PACKAGE_NAME} ${pinned} in the checkout that publishes it — no install resolves a package as its own dependency`, `remove devDependencies["${PACKAGE_NAME}"] from package.json`);
    }
    if (getJsonPath(manifest, 'scripts.ax') !== undefined) {
      fail(`package.json declares scripts.ax in the checkout that publishes ${PACKAGE_NAME} — it would call a bootstrap this plan does not write`, 'remove scripts.ax from package.json');
    }
  } else if (getJsonPath(manifest, 'scripts.ax') !== './bin/ax') fail('package.json: scripts.ax does not point at ./bin/ax', 'ax init');
  else if (!pinned) fail(`package.json: no ${PACKAGE_NAME} version pinned`, 'ax init');
  // A git pin resolves outside the registry and outside the lockfile's version
  // arithmetic, so the global CLI cannot tell which version it would delegate
  // to. ax is published now; the pin is a version.
  else if (pinned.startsWith('github:') || pinned.startsWith('git+')) fail(`package.json: ${PACKAGE_NAME} is pinned to ${pinned}, a git ref — ax is published to npm, and the pin is an exact version now`, `ax pin ${version}`);
  else if (pinned.startsWith('link:') || pinned.startsWith('file:')) note(`package.json: ${PACKAGE_NAME} pinned to ${pinned} — a local dev checkout, not a release`);
  else if (!EXACT_VERSION.test(pinned)) fail(`package.json: ${PACKAGE_NAME} is pinned to the range ${pinned} — a range changes this repo's tooling on someone else's install`, `ax pin ${version}`);
  else ok(`package.json: pinned to ${PACKAGE_NAME} ${pinned}`);

  // WHICH blocks belong here is the plan's answer (./plan.mjs), and it is per
  // FILE. This loop graded a hardcoded pair, so on the checkout that publishes
  // ax it named `ax init` as the repair for a block whose body is consumer
  // instruction and whose file is that package's own authored doctrine — a fix
  // nobody could run, red for seven tickets (#96).
  //
  // AN EXEMPT FILE IS STILL MEASURED, AND SILENT WHEN IT IS RIGHT. The plan
  // refusing the block makes its PRESENCE the finding, exactly like the
  // self-pin above — an exemption that stopped reading the file would trade one
  // unrunnable repair for one unmeasured file. But the correct state prints
  // NOTHING (ruled on #96): a `·` line saying a file the plan wants nothing in
  // has nothing in it is one more line on the report for every reader, forever,
  // and the exemption is already legible where it is decided — `ax init` names
  // the file it skipped and why, every run. Loud when wrong, quiet when right.
  //
  // `ax init` cannot remove what it never writes, so the repair here is the
  // removal itself and never this verb.
  for (const [file, wanted] of Object.entries(plan.blocks)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      if (wanted) fail(`${file} is missing`, 'ax init');
      continue;
    }
    // MALFORMED IS ITS OWN ANSWER, neither a body nor an absence. An orphaned
    // opening marker — half a conflict resolution — used to read as null, so a
    // wanted file was told `ax init`, the one call that THROWS on it, and an
    // exempt file passed in silence while carrying a marker the plan refuses.
    // The repair names the marker, because removing it is what both states
    // need and no verb here can do it: `ax init` cannot rewrite a block whose
    // end it cannot find, and it writes nothing at all in an exempt file.
    let block;
    try {
      block = readBlock(readFileSync(path, 'utf8'), { id: 'ax', style: styleFor(file) });
    } catch (error) {
      const repair = `remove the orphaned BEGIN:ax marker from ${file}`;
      fail(`${file} — ${error.message}`, wanted ? `${repair}, then ax init` : repair);
      continue;
    }
    if (!wanted) {
      if (block !== null) {
        fail(`${file} carries a BEGIN:ax block and the plan for this checkout wants none — ${BLOCK_BODIES[file].reason}`, `remove the BEGIN:ax block from ${file}`);
      }
      continue;
    }
    if (block === null) fail(`${file} carries no BEGIN:ax block`, 'ax init');
    // PRESENCE IS NOT CONTENT, and for `.gitignore` the difference is a pane
    // nobody can release. Every line of `plan.ignore` is a path ax's own tooling
    // writes, so one missing from a block written by an older release leaves
    // that file reading as uncommitted work — `ax worker release` then KEEPS the
    // child worktree forever (#83, measured over the `.env.local` `ax worktree
    // setup` provisions). Recorded value vs PLAN value, like every other finding
    // here: the list lives in ./plan.mjs, which `ax init` writes from.
    //
    // AGENTS.md is graded on presence alone: its body is generated prose,
    // rewritten by every release, and diffing it would report drift on every
    // consumer that has not re-run `ax init`.
    else if (file === '.gitignore') {
      const lines = block.split('\n').map(line => line.trim());
      const missing = plan.ignore.filter(line => !lines.includes(line));
      if (missing.length > 0) fail(`${file}: the managed block does not list ${missing.join(', ')} — paths ax writes and this checkout does not ignore`, 'ax init');
      else ok(`${file}: managed block lists the ${plan.ignore.length} paths ax writes`);
    } else ok(`${file}: managed block present`);
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
