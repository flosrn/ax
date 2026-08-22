// The verbs of `ax triage`, and nothing else.
//
// This table is asserted equal to the `subcommands` declared in
// src/commands.mjs, which is what stops the help — and the AGENTS.md block
// generated from it — from advertising a verb that answers "unknown command".
//
// There is no default verb, on purpose. `ax triage --issue 7` could mean "put a
// session in front of it" or "publish what one already wrote", and guessing
// between a dispatch and a tracker mutation is not a guess worth making.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoPaths } from '../config.mjs';
import { bad, dim, fix, note, raw, section } from '../log.mjs';
import { defaultExec } from '../worker/release.mjs';
import { defaultStore, report } from '../worker/record.mjs';
import { dispatch } from './dispatch.mjs';
import { draftPath, requestFor } from './draft.mjs';
import { publish } from './publish.mjs';

const USAGE = 'ax triage status --issue N [--issue M …] [--job triage|brief|custom] [--repo <owner/repo>]';

/**
 * What each dispatch recorded, and the recovery it routes to.
 *
 * An unsettled record routes to `--resume`, never to a second dispatch: the
 * mutation may still be running, and no snapshot can see one in flight (F-001).
 * The draft is reported beside it, because "the session settled" and "the
 * session produced something" are two different questions.
 */
export function status(argv = [], { exec = defaultExec, env = process.env, cwd = process.cwd() } = {}) {
  const issues = [];
  let job = 'triage';
  let repo = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? '';
    if (arg === '--issue') issues.push(value());
    else if (arg === '--job') job = value();
    else if (arg === '--repo') repo = value();
    else if (arg === '-h' || arg === '--help') return (raw(`${USAGE}\n`), 0);
    else {
      process.stderr.write(`ax triage status: unknown argument "${arg}"\n${USAGE}\n`);
      return 2;
    }
  }
  if (issues.length === 0) {
    process.stderr.write(`ax triage status: no --issue given\n${USAGE}\n`);
    return 2;
  }
  for (const issue of issues) {
    if (!/^[1-9][0-9]*$/.test(issue)) {
      process.stderr.write(`ax triage status: --issue expects a number, got "${issue}"\n${USAGE}\n`);
      return 2;
    }
  }

  const paths = repoPaths(cwd);
  const root = paths.root ?? cwd;
  let slug = repo;
  if (slug === '') {
    const out = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root);
    slug = out.error || out.status !== 0 ? '' : String(out.stdout ?? '').trim().split('\n')[0];
  }
  if (slug === '') {
    bad('could not resolve the current repository');
    fix('ax triage status --repo <owner>/<repo> --issue N');
    return 1;
  }

  const store = defaultStore(env);
  for (const issue of issues) {
    const identity = { job, repo: slug, issue };
    const request = requestFor(identity);
    section(`issue #${issue} — request ${request}`);

    const path = join(store, `${request}.json`);
    if (!existsSync(path)) note('no dispatch record');
    else {
      try {
        const state = report(path);
        const summary = state.summary ?? {};
        note(`${state.mode} · ${summary.state ?? 'unnamed state'} · ${summary.terminal ?? 'no pane recorded'}${state.usable ? '' : ' — UNSETTLED'}`);
        // Never a fresh dispatch: the recorded mutation may still be running,
        // and no snapshot can see one in flight.
        if (!state.usable) fix(`ax worker start --resume --request ${request}   # replays the recorded call (F-001)`);
      } catch (error) {
        bad(`record unreadable: ${String(error.message ?? error)}`);
      }
    }

    const draft = draftPath(root, identity);
    if (existsSync(draft)) note(`draft ${draft}`);
    else note(dim(`no draft at ${draft} — nothing to publish yet`));
  }
  return 0;
}

export const SUBCOMMANDS = { dispatch, status, publish };

/** `ax triage <verb> [args]`. */
export function triage(argv = []) {
  const [verb, ...rest] = argv;
  const run = SUBCOMMANDS[verb];

  if (!run) {
    const known = Object.keys(SUBCOMMANDS).join(', ');
    process.stderr.write(verb ? `ax triage: unknown verb "${verb}" (${known})\n` : `ax triage: which one? (${known})\n`);
    return 2;
  }

  return run(rest);
}
