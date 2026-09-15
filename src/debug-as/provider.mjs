// Which provider mints a confirmed Phone handoff, and what its answer may be.
//
// The relay never knows how authority is created: it hands over an identity, a
// destination path and the confirming login, and gets one URL back. Two rules
// are the whole contract. The final URL must live on THIS worktree's Tailscale
// origin — the path may differ, because a Supabase callback lands on
// `/auth/confirm` and carries the destination as a parameter — and no resolved
// credential ever reaches a child process AX spawns.

import { classifySupabaseUrl, supabaseHandoff, SUPABASE_DEADLINE_MS } from './supabase.mjs';
import { addSecrets, scrub } from './emit.mjs';

const refuse = (problem, fix, extra = {}) => Object.assign(new Error(scrub(problem)), { problem: scrub(problem), fix, ...extra });

const DEADLINE_SECONDS = SUPABASE_DEADLINE_MS / 1000;

/**
 * Classify the configured provider host without making a request or exposing
 * the key. Doctor uses this; the call path uses the same classifier.
 */
export function providerHost({ provider, readVariable, allowedHosts = [] } = {}) {
  if (provider?.type === 'command') {
    return { host: null, port: null, scheme: null, allowed: true, reason: 'command' };
  }
  if (provider?.type !== 'supabase') {
    return { host: null, port: null, scheme: null, allowed: false, reason: 'malformed' };
  }
  const value = readVariable?.(provider.urlEnv);
  if (typeof value !== 'string' || value === '') {
    return { host: null, port: null, scheme: null, allowed: false, reason: 'unresolved' };
  }
  return classifySupabaseUrl(value, allowedHosts);
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

async function commandHandoff({ provider, identity, destinationPath, login, tailnetOrigin, root, runAdapter }) {
  if (typeof runAdapter !== 'function') {
    throw refuse('the command provider has no adapter runner', 'this is an AX bug: inject runAdapter');
  }
  let answer;
  try {
    answer = await runAdapter({
      command: provider.command,
      timeoutSeconds: DEADLINE_SECONDS,
      cwd: root,
      at: 'debugAs.phone.provider.command',
      request: {
        kind: 'phone-handoff',
        identity: identity.name,
        email: identity.email,
        path: destinationPath,
        origin: tailnetOrigin,
        login,
      },
    });
  } catch (error) {
    throw refuse(scrub(error?.message ?? 'the command provider failed'), error?.fix ?? 'run the declared provider command by hand in this worktree', { fix: error?.fix ?? 'run the declared provider command by hand in this worktree' });
  }
  const url = answer?.url;
  if (typeof url !== 'string' || !sameOrigin(url, tailnetOrigin)) {
    throw refuse(
      'the command provider returned a URL that is not on this worktree\'s Tailscale origin',
      'return one https URL on this worktree\'s recorded AX_TAILNET_URL origin',
    );
  }
  return { url };
}

/**
 * Create the application callback URL. Called only after confirmation.
 */
export async function createHandoff({
  provider,
  identity,
  destinationPath,
  login,
  tailnetOrigin,
  root,
  readVariable,
  allowedHosts = [],
  fetchImpl,
  runAdapter,
  registerSecret = addSecrets,
} = {}) {
  if (provider?.type === 'supabase') {
    return supabaseHandoff({
      provider,
      email: identity.email,
      tailnetOrigin,
      destinationPath,
      readVariable,
      allowedHosts,
      fetchImpl,
      registerSecret,
    });
  }
  if (provider?.type === 'command') {
    return commandHandoff({ provider, identity, destinationPath, login, tailnetOrigin, root, runAdapter });
  }
  throw refuse(
    `provider type ${JSON.stringify(provider?.type ?? null)} is not "supabase" or "command"`,
    'declare debugAs.phone.provider.type as "supabase" or "command"',
  );
}
