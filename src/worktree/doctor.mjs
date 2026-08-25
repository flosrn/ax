// Does this checkout still match what it claims?
//
// Setup writes three things down that must keep agreeing: the port and URLs in
// the env files, the Supabase endpoints beside them, and the `project_id` and
// port block in `config.toml`. Anything can pull them apart afterwards — a
// manual edit, a half-failed setup, a stack stopped by hand, a merge that
// restored `config.toml`.
//
// When they disagree the symptom is never the cause. A worktree whose env points
// at an isolated port block while its `config.toml` is back on the shared
// baseline just shows an app with no data; a worktree that shares the stack
// while believing it is isolated silently writes into everybody else's
// database.
//
// So this module RE-DERIVES the plan — `planWorktree`, with the same probes
// `setup` runs — and compares it against what the env files, `config.toml` and
// the machine actually recorded. It decides nothing itself. That is the whole
// design, and it is the fix for the most expensive bug class in the Bash version
// it replaces: there, setup decided a worktree's port, URL mode and Supabase
// block while provisioning it, and the doctor decided the same things again to
// check them. Two derivations drift, and they did — twice reporting a healthy
// worktree as broken, and once the reverse.
//
// Every finding is therefore a DIFFERENCE between a recorded value and the plan,
// which is why nearly every fix is the one command that writes the plan down.
//
// Read-only, and data rather than printed output: the caller decides how to
// render each level and whether a `bad` fails the exit code.

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { readConfigured, readKey } from '../dotenv.mjs';
import { isMainCheckout, listWorktrees } from '../git.mjs';
import { GUARDED_INVOCATION, invokesSupabaseCli, reachesGuard } from '../supabase-guard.mjs';
import { identify } from './identity.mjs';
import { KEYS, planWorktree } from './plan.mjs';
import { isReserved } from './ports.mjs';
import { envFiles, probeAll, readWorktreeRecord } from './probes.mjs';
import { SUPABASE_LABEL, commandNeedsIsolation, configProjectId, isIsolatedConfig } from './supabase.mjs';

/** The one command that reconciles a recorded value with the plan. */
const SETUP = 'ax worktree setup';

/**
 * Grade `root` against the plan `setup` would write there.
 *
 * @param root    the checkout being graded
 * @param main    the primary checkout behind it
 * @param config  the loaded `ax.config.json`
 * @param probes  injected for tests — omitted, the machine is probed exactly as
 *                `setup` probes it, which is what makes the two comparable
 * @param env     the process environment, which outranks the env files
 * @param run     injected command runner, forwarded to `isIsolatedConfig`
 * @returns {{ level: 'ok'|'note'|'bad', message: string, fix?: string }[]}
 */
export function worktreeFindings({ root, main, config, probes, env = process.env, run } = {}) {
  const findings = [];
  const add = (level, message, fix) => findings.push(fix === undefined ? { level, message } : { level, message, fix });

  // The primary checkout is settled first, because half the comparisons below
  // do not apply to it: it deliberately carries no per-checkout env file and
  // runs on the tracked defaults — the project's own port and the shared stack
  // every other checkout falls back to. Demanding a worktree's overrides here
  // reports the correct configuration as broken, which the Bash version did
  // until it grew the same guard.
  const primary = isMainCheckout(root) && root === main;

  modules(root, { add, primary });

  const identity = identify({
    worktreePath: root,
    branch: branchOf(root),
    // The same marker `setup` reads. A different identity is a different seed,
    // and a different seed is a different plan — which would report a healthy
    // worktree as misconfigured.
    marker: join(root, '.orca-worktree.json'),
  });

  const { values: recorded, legacy } = readWorktreeRecord(root, config, env);
  for (const { key, from } of legacy) {
    add('note', `${key} is still recorded under its older name ${from} — read, but only setup renames it`, SETUP);
  }

  const plan = planWorktree({
    identity,
    worktreePath: root,
    config,
    recorded,
    probes: probes ?? probeAll({ worktreePath: root, config, recorded }),
  });

  if (primary) {
    add('ok', 'primary checkout — it runs on the tracked env defaults and owns the shared database');
  } else {
    recordedFiles(root, { plan, add });
    recordedValues(root, { plan, config, env, add });
  }

  database(root, { plan, config, main, recorded, primary, run, add });
  guard(root, { config, add });

  return findings;
}

/**
 * `node_modules`, and the nastier of its two failures.
 *
 * A SYMLINK is the one that costs an afternoon: workspace packages then resolve
 * into another checkout, so this worktree silently runs another branch's code
 * and nothing looks wrong until an edit made here shows up over there. It is
 * never legitimate anywhere, so it fails in every checkout.
 *
 * ABSENCE is graded differently by checkout, because it means different things.
 * In a linked worktree it is a provisioning failure: `git worktree add` hands
 * you a directory with no dependencies, setup is what installs them, and nothing
 * there runs until it has. In the primary checkout it is the ordinary state of a
 * clone nobody has installed yet — the state `ax init` deliberately leaves
 * behind, one install away — so it is reported rather than failed.
 */
function modules(root, { add, primary }) {
  const path = join(root, 'node_modules');
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    stat = undefined;
  }

  if (!stat) {
    if (primary) add('note', 'node_modules is missing — this checkout has not been installed yet', 'install it with your package manager');
    else add('bad', 'node_modules is missing — nothing in this worktree can run', SETUP);
    return;
  }

  if (stat.isSymbolicLink()) {
    let target = '';
    try {
      target = ` → ${readlinkSync(path)}`;
    } catch {
      // An unreadable link is still a link; the target only sharpens the message.
    }
    add(
      'bad',
      `node_modules is a symlink${target} — workspace packages resolve into that checkout, so this one silently runs another branch's code`,
      `rm node_modules && ${SETUP}`,
    );
    return;
  }

  add('ok', 'node_modules present, and its own');
}

/**
 * Do the files the plan records into exist at all?
 *
 * Taken from the plan rather than from a list of names, so a project that moves
 * its app cannot leave this check grading a path nobody writes.
 */
function recordedFiles(root, { plan, add }) {
  const files = [...new Set(plan.env.map(write => write.file))];
  const missing = files.filter(file => !existsSync(join(root, file)));

  for (const file of missing) {
    add(
      'bad',
      `${file} is missing — nothing records this worktree's address, so its dev server takes the primary checkout's port and database`,
      SETUP,
    );
  }
  if (missing.length === 0) add('ok', `${files.join(', ')} present`);
}

/**
 * Every value the plan records, against what the files say.
 *
 * ONE loop, and no per-key rule: the plan already decided what each key must
 * hold, so a rule here would be a second derivation — the exact thing that
 * drifted before. Read through `readConfigured`, because the precedence it
 * implements (an exported variable beats `.env.local` beats the root file) is
 * what the app itself resolves; grading the planned file alone would pass a
 * worktree whose value is overridden elsewhere.
 *
 * The mirror image of that is worth a line of its own, which is why the planned
 * file is read separately: a key that agrees with the plan but lives further
 * down the chain is CURRENTLY right and permanently fragile, because the file
 * setup rewrites is not the file the answer comes from. Nothing announces that,
 * and the next setup run does not converge it.
 */
function recordedValues(root, { plan, config, env, add }) {
  const files = envFiles(config);
  const read = key => readConfigured(key, { cwd: root, files, env });

  for (const write of plan.env) {
    if (write.remove) {
      claimAbsent(read, { plan, add });
      continue;
    }

    for (const [key, expected] of Object.entries(write.keys)) {
      const value = read(key);
      const where = write.label === SUPABASE_LABEL ? ` (port block +${plan.supabase.offset})` : '';

      if (value === undefined || value === '') {
        add('bad', `${key} is not recorded — whatever reads it falls back to the tracked default instead of ${expected}${where}`, SETUP);
        continue;
      }
      if (value !== expected) {
        add('bad', `${key}=${value} but this worktree's plan says ${expected}${where}${reason(key, value, config)}`, SETUP);
        continue;
      }
      if (readKey(join(root, write.file), key) !== value) {
        add('note', `${key}=${value} agrees with the plan, but it is recorded outside ${write.file} — setup rewrites that file, not the one answering`, SETUP);
        continue;
      }
      add('ok', `${key}=${value}`);
    }
  }
}

/**
 * Why the plan refused a recorded value, when the reason is knowable.
 *
 * A recorded port normally WINS — that is what keeps a published URL from
 * moving — so a disagreement about `PORT` means the plan threw the recorded one
 * out, and the only reasons it does that are "not a number" and "reserved". The
 * reserved list is where a project declares the port its primary checkout owns,
 * so this is also the "not the primary's port" check: same value, same list, one
 * finding instead of two.
 */
function reason(key, value, config) {
  if (key !== 'PORT') return '';
  if (isReserved(value, config.ports.reserved)) {
    return ' — that port is reserved (the primary checkout owns it), so two dev servers would fight over one socket';
  }
  return Number.isInteger(Number(value)) ? '' : ' — that is not a port number';
}

/**
 * A plan that SHARES the database also says the isolated endpoints must go.
 *
 * Only the two tooling-private keys are demanded absent, and deliberately: they
 * are written by nothing but this tooling, so their presence is unambiguous.
 * The endpoint keys beside them (`SUPABASE_URL` and friends) are names the app
 * or a framework owns and a project may legitimately declare elsewhere — a
 * checkout would be failed for someone else's line. They travel in the same
 * block as the offset anyway, so the offset is a faithful witness for all of
 * them.
 */
function claimAbsent(read, { plan, add }) {
  for (const key of [KEYS.supabaseMode, KEYS.supabaseOffset]) {
    const value = read(key);
    if (value === undefined || value === '') continue;
    add(
      'bad',
      `${key}=${value} still claims an isolated database, but this worktree's plan shares the primary stack — the app dials ports nothing answers on`,
      SETUP,
    );
  }
  if (plan.supabase.mode !== 'isolated') add('ok', 'no stale isolated endpoints recorded');
}

/**
 * The two records of one decision, compared.
 *
 * `isIsolatedConfig` is the authority on the `config.toml` half: it compares the
 * working-tree `project_id` against the COMMITTED one, which is the only rule
 * that holds without a naming convention. Trusting the recorded offset instead
 * is what makes a stale env key dangerous — a `stop` against a shared project
 * id takes the database out from under every other session.
 *
 * A disagreement is the state this whole file exists to catch, and the reason a
 * caller should be able to fail on it.
 */
function database(root, { plan, config, main, recorded, primary, run, add }) {
  const relativePath = `${config.apps.web}/supabase/config.toml`;
  const configToml = join(root, relativePath);
  if (!existsSync(configToml)) return;

  const isolatedConfig = isIsolatedConfig({ cwd: root, relativePath, run });
  const projectId = configProjectId(configToml);
  // The recorded claim, spelled as `planSupabase` spells it: a positive offset
  // is what a checkout writes down when it takes a block.
  const claimed = /^[1-9][0-9]*$/.test(String(recorded[KEYS.supabaseOffset] ?? ''));

  if (claimed !== isolatedConfig) {
    add(
      'bad',
      `env records ${claimed ? 'an isolated database' : 'the shared database'} while ${relativePath} is ${
        isolatedConfig ? `isolated (project_id ${projectId})` : 'the committed shared one'
      } — either this checkout dials ports nothing answers on, or it believes it is isolated while writing into the database every other session reads`,
      // The primary checkout is the one case setup cannot reconcile: its plan is
      // shared, and setup never rewrote the tracked file it would have to restore.
      primary ? `git -C ${main} checkout -- ${relativePath}` : SETUP,
    );
    return;
  }

  if (!claimed) {
    add('ok', primary ? `shared database, project_id ${projectId}` : 'sharing the primary checkout database — no containers of its own');
    return;
  }

  // Both halves claim isolation, so the remaining question is WHICH block. The
  // plan keeps a recorded offset, so a disagreement here means the plan refused
  // it — and every endpoint would then be graded against a block this checkout
  // does not own, which is one defect reported six times.
  if (String(recorded[KEYS.supabaseOffset]) !== String(plan.supabase.offset)) {
    add('bad', `env records port block +${recorded[KEYS.supabaseOffset]}, but this worktree's plan owns +${plan.supabase.offset}`, SETUP);
    return;
  }

  add('ok', `isolated database ${projectId} on port block +${plan.supabase.offset} (API ${plan.supabase.ports.api})`);
}

/**
 * Do the app's database commands still go through the guard?
 *
 * This is the check with the widest blast radius, and it grades a tracked file
 * rather than local state: a script that invokes the Supabase CLI directly skips
 * the promotion that gives a worktree its own stack, so a migration, a `db
 * reset` or a typegen run from a shared worktree rewrites the database every
 * other concurrent session is reading. There is no error and no warning; the
 * damage surfaces later as tests failing in a branch that changed nothing.
 *
 * Both predicates come from the guard itself. Recognising a guarded command line
 * here with a regex of its own is how a doctor starts grading a rule nobody
 * enforces: the guard would accept an invocation this file calls unguarded, or
 * the reverse.
 */
function guard(root, { config, add }) {
  const manifest = join(root, config.apps.web, 'package.json');
  if (!existsSync(manifest)) return;

  let scripts;
  try {
    scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
  } catch {
    // An unparseable manifest is a different finding in a different section.
    return;
  }

  // Unguarded is not the same as dangerous. A script aimed at a REMOTE project,
  // or one that only starts and stops containers, cannot contaminate anyone's
  // data — and `commandNeedsIsolation` is already the authority on that
  // distinction, because it is the predicate the guard itself consults before
  // promoting. Grading every unguarded line instead would flag the deliberate
  // escape hatches (`supabase:raw`), the CI path, and `db push --project-ref`,
  // which teaches a reader to ignore this section.
  const named = Object.entries(scripts)
    .filter(([, command]) => invokesSupabaseCli(command) && !reachesGuard(command) && commandNeedsIsolation(argsOf(command)))
    .map(([name]) => name);

  const relative = `${config.apps.web}/package.json`;
  if (named.length === 0) {
    if (Object.values(scripts).some(command => reachesGuard(command))) {
      add('ok', `${relative}: every database command routes through \`${GUARDED_INVOCATION}\``);
    }
    return;
  }

  add(
    'bad',
    `${relative}: ${named.join(', ')} ${named.length === 1 ? 'calls' : 'call'} the Supabase CLI directly — a migration or reset from this checkout would contaminate every other session's database`,
    `route ${named.join(', ')} through \`pnpm -w ${GUARDED_INVOCATION} ...\`, which promotes this checkout to its own stack first`,
  );
}

/**
 * The arguments a package script hands the Supabase CLI.
 *
 * Everything after the `supabase` command word, so `commandNeedsIsolation` sees
 * what the CLI would see. Shell noise beyond the first pipeline stage is not
 * modelled: a script that pipes `gen types` into a file is still `gen types`,
 * and a script complex enough to defeat this is one a human should be reading
 * anyway.
 */
function argsOf(script) {
  const words = String(script).split(/\s+/);
  const at = words.indexOf('supabase');
  return at === -1 ? [] : words.slice(at + 1).filter(word => !['>', '|', '&&', ';'].includes(word));
}

/**
 * This checkout's branch, taken from git's own worktree list.
 *
 * Read from there rather than asked separately because the list already answers
 * it for every checkout, including the detached case (no branch at all), and the
 * plan's seed depends on this value — a second way of getting it is a second way
 * of getting it wrong. Paths are compared physically: a checkout under a
 * symlinked temp dir is the ordinary case on macOS.
 */
function branchOf(root) {
  const target = physical(root);
  return listWorktrees(root).find(tree => physical(tree.path) === target)?.branch;
}

const physical = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
