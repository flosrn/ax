// Drive the operator's existing Role browser through agent-browser.
//
// `drive` mutates a session, so every non-live state refuses with an operator
// repair before the binary is resolved. The child is spawned with no shell,
// inherits stdio so its stdout is byte-identical, and receives an environment
// from which every `AGENT_BROWSER_*` control has been dropped. AX prepends
// `--session` and `--cdp` from the receipt and refuses the caller supplying
// either. Help ownership stops at `--`; later arguments belong to the child.
//
// Every emission goes through ./emit.mjs.

import { spawn as spawnChild, spawnSync } from 'node:child_process';

import { emit as defaultEmit } from './emit.mjs';
import { probeCdp, readReceipt } from './receipt.mjs';

const defaultWhich = (name, env) => {
  const result = spawnSync('which', [name], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  const found = (result.stdout ?? '').trim();
  return result.status === 0 && found !== '' ? found : null;
};

const withoutAgentBrowser = env => {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('AGENT_BROWSER_')) delete next[key];
  }
  return next;
};

const callerOverride = argv => {
  for (const arg of argv) {
    if (arg === '--session' || arg === '--cdp' || arg.startsWith('--session=') || arg.startsWith('--cdp=')) return arg;
  }
  return null;
};

const waitExit = child =>
  new Promise(resolve => {
    const done = (code, signal) => resolve(code ?? (signal ? 1 : 0));
    if (typeof child.on === 'function') {
      child.on('exit', done);
      child.on('error', () => done(1, null));
      return;
    }
    resolve(1);
  });

export async function drive(context, { identity, childArgv = [] } = {}, deps = {}) {
  const output = deps.emit ?? defaultEmit;
  const root = context?.root;
  if (!root) {
    output.refuse('debug-as drive needs a worktree', 'run ax debug-as drive from the checkout whose Role browser you want to drive');
    return 1;
  }

  const current = readReceipt(root, deps);
  const repair = 'ax debug-as --as <identity>   # open a Role browser in this worktree first';

  if (current.state === 'absent') {
    output.refuse('no Role browser is published for this worktree', repair);
    return 1;
  }
  if (current.state === 'dead') {
    output.refuse('the Role browser receipt is stale — its owner is gone', repair);
    return 1;
  }
  if (current.state !== 'live') {
    output.refuse(
      current.refusal?.problem ?? 'the Role browser owner cannot be verified',
      current.refusal?.fix ?? repair,
    );
    return 1;
  }

  const receipt = current.receipt;
  if (identity && identity !== receipt.identity) {
    output.refuse(
      `drive --as ${identity} does not match the live identity ${receipt.identity}`,
      `ax debug-as drive --as ${receipt.identity} -- <argv>   # or close this window and open ${identity}`,
    );
    return 1;
  }

  const probe = deps.probe ?? (port => probeCdp(port, { open: deps.open }));
  const cdp = await probe(receipt.cdpPort);
  if (!cdp.alive) {
    output.refuse('the Role browser is not answering on its CDP port', repair);
    return 1;
  }

  const override = callerOverride(childArgv);
  if (override !== null) {
    output.refuse(
      `drive refuses caller-supplied ${override.split('=')[0]} — AX owns the session and CDP port`,
      'ax debug-as drive -- <agent-browser argv without --session or --cdp>',
    );
    return 1;
  }

  const env = context.env ?? process.env;
  const which = deps.which ?? (name => defaultWhich(name, env));
  const bin = which('agent-browser');
  if (!bin) {
    output.refuse(
      'agent-browser is not on PATH',
      'npm install -g agent-browser   # AX never installs it; the project or the operator does',
    );
    return 1;
  }

  const argv = ['--session', receipt.sessionName, '--cdp', String(receipt.cdpPort), ...childArgv];
  const spawn = deps.spawn ?? spawnChild;
  const child = spawn(bin, argv, {
    cwd: root,
    env: withoutAgentBrowser(env),
    stdio: 'inherit',
    shell: false,
  });
  return waitExit(child);
}
