// The one module that holds a service-role key.
//
// It speaks the documented Supabase Auth (GoTrue) admin wire contract —
// `POST /auth/v1/admin/generate_link` with `apikey` and bearer authorization,
// answering a root `hashed_token` — and nothing else. The JavaScript SDK's
// `properties` wrapper is a client-side construction and is tolerated; the
// `action_link` field is never used, because following it would land the phone
// on GoTrue's own verify URL instead of the application's callback.
//
// Host containment is exact: a loopback literal (`127.0.0.0/8`, `::1`,
// `localhost`) or an allowlisted `https` host+port matched verbatim. A hostname
// that merely resolves to loopback is not a literal, and a suffix is never a
// match. Redirects are refused rather than followed with the key attached.
//
// `tests/fixtures/supabase-generate-link.json` is a SIMULATED reference shape
// taken from the published self-hosting Auth response schema. It is not a byte
// capture from a real local stack; replacing it with one is U9's obligation,
// before Gapila's SDK-backed route is deleted.

import { randomBytes } from 'node:crypto';

import { pathProblem } from './config.mjs';
import { addSecrets, scrub } from './emit.mjs';

export const SUPABASE_DEADLINE_MS = 15000;
export const MAX_BODY = 64 * 1024;

const ADMIN_PATH = '/auth/v1/admin/generate_link';
const PARAM = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const TYPE_VALUE = 'magiclink';

const isLoopbackHost = host => {
  const name = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  const parts = name.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

const diagnostic = () => randomBytes(4).toString('hex');

const refuse = (problem, fix, extra = {}) => Object.assign(new Error(scrub(`${problem} (${extra.id ?? diagnostic()})`)), { problem: scrub(problem), fix, ...extra });

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Classify a provider URL without making a request or returning the key.
 * Shared with `providerHost` so doctor and the call agree.
 */
export function classifySupabaseUrl(value, allowedHosts = []) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { host: null, port: null, scheme: null, allowed: false, reason: 'unresolved' };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { host: null, port: null, scheme: null, allowed: false, reason: 'malformed' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { host: url.hostname, port: url.port ? Number(url.port) : null, scheme: url.protocol.replace(':', ''), allowed: false, reason: 'malformed' };
  }
  const host = url.hostname;
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  if (isLoopbackHost(host)) return { host, port, scheme, allowed: true, reason: 'loopback' };
  const listed = allowedHosts.some(entry => entry.host === host && entry.port === port);
  if (listed && scheme === 'https') return { host, port, scheme, allowed: true, reason: 'allowlisted' };
  if (listed && scheme !== 'https') return { host, port, scheme, allowed: false, reason: 'not-allowlisted' };
  return { host, port, scheme, allowed: false, reason: 'not-allowlisted' };
}

async function readBounded(response, max, id) {
  if (response.body == null) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw refuse('the Auth Admin response exceeded the 64 KiB cap', 'fix the Auth host so generate_link answers one small JSON object', { id });
    return text;
  }
  const reader = response.body.getReader();
  let chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw refuse('the Auth Admin response exceeded the 64 KiB cap', 'fix the Auth host so generate_link answers one small JSON object', { id });
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  } catch (error) {
    // A cap refusal, an aborted deadline or a broken transfer all leave the
    // socket open. Nothing more is buffered, and the stream is let go.
    chunks = null;
    try {
      await reader.cancel();
    } catch {
      // The stream is already errored; there is nothing left to release.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a reader whose stream is gone is not a failure.
    }
  }
}

function hashedToken(parsed, id) {
  const root = parsed?.hashed_token;
  const wrapped = isObject(parsed?.properties) ? parsed.properties.hashed_token : undefined;
  const present = [];
  if (root !== undefined) present.push(root);
  if (wrapped !== undefined && wrapped !== root) present.push(wrapped);
  if (present.length > 1) throw refuse('the Auth Admin response carried two different hashed_token values', 'fix the Auth host so generate_link answers one hashed_token', { id });
  const token = present[0] ?? (typeof wrapped === 'string' ? wrapped : root);
  if (typeof token !== 'string' || token === '') {
    throw refuse('the Auth Admin response did not carry a hashed_token string', 'fix the Auth host so generate_link answers a hashed_token at the root or under properties', { id });
  }
  return token;
}

function confirmShape(confirm) {
  if (!isObject(confirm)) throw refuse('the Supabase provider declares no confirm callback', 'declare debugAs.phone.provider.confirm with path and parameter names');
  for (const key of ['tokenParam', 'typeParam', 'nextParam']) {
    if (typeof confirm[key] !== 'string' || !PARAM.test(confirm[key])) {
      throw refuse(`confirm.${key} is not a safe parameter name`, 'use a name matching [a-zA-Z][a-zA-Z0-9_]*');
    }
  }
  if (confirm.typeValue !== TYPE_VALUE) {
    throw refuse('confirm.typeValue does not name the magiclink kind this call issues', `use "${TYPE_VALUE}": AX asks the Auth host for a magic link, so the callback must read it back as one`);
  }
  const problem = pathProblem(confirm.path);
  if (problem !== '') throw refuse(`confirm.path ${problem}`, 'use an absolute application path such as "/auth/confirm"');
  return confirm;
}

function callbackUrl({ origin, confirm, token, destinationPath }) {
  const problem = pathProblem(destinationPath);
  if (problem !== '') throw refuse(`the destination path ${problem}`, 'pass an absolute path of this application, such as "/home"');
  const url = new URL(origin);
  url.pathname = confirm.path;
  url.search = '';
  url.hash = '';
  url.searchParams.set(confirm.tokenParam, token);
  url.searchParams.set(confirm.typeParam, confirm.typeValue);
  url.searchParams.set(confirm.nextParam, destinationPath);
  return url.toString();
}

/**
 * Mint a magic-link callback on the worktree's Tailscale origin. Called only
 * after a confirmed POST: no credential is read before that.
 */
export async function supabaseHandoff({
  provider,
  email,
  tailnetOrigin,
  destinationPath,
  readVariable,
  allowedHosts = [],
  fetchImpl = fetch,
  timeoutMs = SUPABASE_DEADLINE_MS,
  registerSecret = addSecrets,
} = {}) {
  const id = diagnostic();
  const confirm = confirmShape(provider?.confirm);
  const rawUrl = readVariable?.(provider.urlEnv);
  const key = readVariable?.(provider.serviceRoleKeyEnv);

  if (typeof rawUrl !== 'string' || rawUrl === '') {
    throw refuse(`${provider.urlEnv} is not set`, `assign ${provider.urlEnv} to this project's Auth URL`, { id, at: provider.urlEnv, problem: `${provider.urlEnv} is not set` });
  }
  if (typeof key !== 'string' || key === '') {
    throw refuse(`${provider.serviceRoleKeyEnv} is not set`, `assign ${provider.serviceRoleKeyEnv} in this project's env files — AX never writes the value`, { id, at: provider.serviceRoleKeyEnv, problem: `${provider.serviceRoleKeyEnv} is not set` });
  }

  const classified = classifySupabaseUrl(rawUrl, allowedHosts);
  if (!classified.allowed) {
    const problem =
      classified.reason === 'malformed'
        ? `${provider.urlEnv} is not a URL AX can call`
        : `${classified.host ?? provider.urlEnv} is not a loopback literal and is not an exact https allowlist entry`;
    throw refuse(problem, 'use a loopback Auth URL, or add the exact host:port to allowedSupabaseHosts and serve it over https', { id });
  }

  registerSecret?.([key]);

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw refuse(`${provider.urlEnv} is not a URL`, `assign ${provider.urlEnv} to an origin such as http://127.0.0.1:54321`, { id });
  }
  const endpoint = new URL(ADMIN_PATH, parsedUrl.origin).toString();

  // One budget over the whole call. A host can answer 200 headers instantly and
  // then never finish the body, so the timer is cleared after the last byte AX
  // is willing to read, not when the headers arrive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const budget = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
  const expired = error => controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError' || /aborted/i.test(String(error?.message ?? ''));
  const overdue = () => refuse(`the Auth Admin call exceeded its ${budget} deadline`, 'check that the Auth host answers on the loopback URL', { id });
  const discard = async body => {
    try {
      await body?.cancel();
    } catch {
      // Refused already; the rest of that body is never read.
    }
  };

  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          apikey: key,
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ type: TYPE_VALUE, email }),
      });
    } catch (error) {
      if (expired(error)) throw overdue();
      throw refuse('the Auth Admin call failed before an answer', 'check that the Auth host is running', { id });
    }

    if (response.status < 200 || response.status >= 300) {
      await discard(response.body);
      throw refuse('the Auth Admin call did not succeed', 'check this project\'s Auth Admin configuration', { id });
    }

    let text;
    try {
      text = await readBounded(response, MAX_BODY, id);
    } catch (error) {
      if (error?.fix) throw error;
      if (expired(error)) throw overdue();
      throw refuse('the Auth Admin answer stopped before it was complete', 'check that the Auth host is running', { id });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw refuse('the Auth Admin response was not JSON', 'check this project\'s Auth Admin configuration', { id });
    }
    if (!isObject(parsed)) throw refuse('the Auth Admin response was not an object', 'check this project\'s Auth Admin configuration', { id });

    const token = hashedToken(parsed, id);
    registerSecret?.([token]);
    return { url: callbackUrl({ origin: tailnetOrigin, confirm, token, destinationPath }) };
  } finally {
    clearTimeout(timer);
  }
}
