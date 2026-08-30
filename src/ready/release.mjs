// `ax ready release` — free a finished pass's pane, keyed by the vocabulary the
// dispatching parent already thinks in.
//
// That parent thinks in ISSUES; `ax worker release` is keyed by DISPATCH
// id. Between the two sat a manual lookup — scroll old output for the ctx_ id
// of the pane you meant — measured as a per-ticket friction on the first real
// wave (2026-08-23). The mapping is mechanical and already on disk: issue →
// newest pass → request → record → `summary.dispatchId`. So this verb resolves
// and DELEGATES; every guard about panes, proofs and landings stays in
// `worker/release.mjs`, which owns them. A second copy of any of those rules
// here is how one of the two ends up wrong.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoPaths } from '../config.mjs';
import { bad, fix, note, raw } from '../log.mjs';
import { defaultExec } from '../exec.mjs';
import { repoSlug } from '../gh.mjs';
import { defaultStore, report } from '../worker/record.mjs';
import { release } from '../worker/release.mjs';
import { draftDirFor, passesOf, requestFor } from './draft.mjs';
import { REFINE_REMOVED } from './spec.mjs';

const USAGE = 'ax ready release --issue N [--pass P] [--job triage|brief|custom] [--repo <owner/repo>] [--no-proof]';

export function readyRelease(argv = [], { exec = defaultExec, env = process.env, cwd = process.cwd(), releaseFn = release, ...rest } = {}) {
  const usageError = message => {
    process.stderr.write(`ax ready release: ${message}\n${USAGE}\n`);
    return 2;
  };
  const refuse = (message, repair) => {
    bad(message);
    if (repair) fix(repair);
    return 1;
  };

  let issue = '';
  let job = 'triage';
  let repo = '';
  let passArg = '';
  let noProof = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--issue') issue = value();
    else if (arg === '--job') job = value();
    else if (arg === '--repo') repo = value();
    else if (arg === '--pass') passArg = value();
    else if (arg === '--no-proof') noProof = true;
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else return usageError(`unknown argument "${arg}"`);
  }
  if (job === 'refine') return usageError(REFINE_REMOVED);
  if (issue === '') return usageError('no --issue given');
  if (!/^[1-9][0-9]*$/.test(issue)) return usageError(`--issue expects a number, got "${issue}"`);
  if (passArg !== '' && !/^[1-9][0-9]*$/.test(passArg)) return usageError(`--pass expects a number, got "${passArg}"`);

  const paths = repoPaths(cwd);
  if (!paths.root) return refuse('not inside a git repository — the pass this frees was dispatched from one');

  const slug = repo === '' ? repoSlug(args => exec('gh', args, paths.root)) : repo;
  if (slug === '') return refuse('could not resolve the current repository', `ax ready release --issue ${issue} --repo <owner>/<repo>`);

  const base = { job, repo: slug, issue };
  const store = defaultStore(env);
  const passes = passesOf(store, draftDirFor(paths.root), base);
  if (passes.length === 0) return refuse(`no pass of #${issue} exists here — nothing was dispatched, so there is no pane to free`);
  const pass = passArg === '' ? passes[passes.length - 1] : Number(passArg);
  if (!passes.includes(pass)) return refuse(`pass ${pass} of #${issue} does not exist (existing: ${passes.join(', ')})`, `ax ready status --issue ${issue} --job ${job}`);

  const request = requestFor({ ...base, pass });
  const path = join(store, `${request}.json`);
  if (!existsSync(path)) {
    return refuse(
      `pass ${pass} of #${issue} has no dispatch record — a draft written by hand holds no pane, so there is nothing to free`,
      `ax ready status --issue ${issue} --job ${job}`,
    );
  }
  let dispatchId;
  try {
    dispatchId = report(path).summary?.dispatchId;
  } catch (error) {
    return refuse(`pass ${pass} record unreadable: ${String(error.message ?? error)}`, `cat ${path}`);
  }
  if (typeof dispatchId !== 'string' || dispatchId === '') {
    return refuse(
      `pass ${pass} of #${issue} recorded no dispatch id — its worker-start never named a Dispatch this machine can address`,
      `ax worker ls   # what this record actually holds`,
    );
  }

  note(`pass ${pass} — request ${request} → dispatch ${dispatchId}`);
  // Delegation, not reimplementation: --close and the pane/landing proofs are
  // worker/release.mjs's contract, exercised there. The injectables ride along
  // so tests reach this verb without an Orca.
  return releaseFn(['--close', '--dispatch', dispatchId, ...(noProof ? ['--no-proof'] : [])], { exec, env, cwd, ...rest });
}
