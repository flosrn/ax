// Child-authored text carries authority tokens BY CONSTRUCTION, not by accident:
// the preamble Orca injects into every supervised worker embeds that worker's
// `--dispatch-capability` in every command it teaches, and the worker retypes it
// into its tool calls. Measured on the 2026-08-21 probe: the token appears twice
// in the preamble alone, before the child has done anything. A verb that
// re-displays such text without this pass turns a dispatch authority token into
// routine copy-paste output.
//
// One implementation, imported by every displaying verb — never a per-verb copy.
// And no bypass flag on purpose: the token is useless to a human READING a
// transcript, and a human who truly needs it has disk access to the source file,
// which the displaying verb names.

const CAPABILITY = /\bdcap_[A-Za-z0-9_-]+/g;

// A debug session mints and reads authority that is not a dispatch token, and
// each shape below is one an operator's terminal has no use for:
//
//   * a three-segment `eyJ...` JWT is a Supabase service-role key or an access
//     token — the credential that can mint any session in the project;
//   * `token_hash=` in a URL is the one-use magic-link material the phone
//     handoff creates AFTER confirmation, and a relay URL is printed for the
//     operator by design, so the line it travels on is a line ax writes;
//   * `hashed_token` and `action_link` are the same value in the provider's own
//     JSON, which reaches ax as an adapter or provider response body;
//   * `apikey:` and `authorization:` carry it again in a header dump, which is
//     exactly what a diagnostic tail of a failed request contains.
//
// The vocabulary is extended HERE rather than copied into `src/debug-as/`,
// because a second redactor is a second answer to "what is a secret" — and the
// one that lags is the one that prints.
const SHAPES = [
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '<redacted>'],
  [/\b(token_hash|access_token|refresh_token|token|apikey|api_key)=[^&\s"'<>]+/gi, '$1=<redacted>'],
  [/"(hashed_token|action_link|access_token|refresh_token|service_role_key)"(\s*:\s*)"[^"]*"/gi, '"$1"$2"<redacted>"'],
  [/^([^\S\n]*)(apikey|authorization)(\s*:\s*).+$/gim, '$1$2$3<redacted>'],
];

/**
 * A value short enough to be an ordinary word is not redactable: substituting
 * it would black out prose without protecting anything.
 */
const MIN_REGISTERED = 8;

/**
 * Every known authority-token shape, replaced with an inert marker — plus the
 * exact values a caller resolved at runtime.
 *
 * `values` exists because a pattern cannot recognize an arbitrary secret: a
 * project's service-role key is whatever its `.env.local` says, and R35 asks
 * for the RESOLVED value to be unprintable, not merely the shapes that usually
 * carry it. Callers register through `src/debug-as/emit.mjs`; this signature is
 * the one place that knows how a registered value is spelled out.
 */
export function redactSecrets(text, { values } = {}) {
  let out = String(text);
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.trim().length < MIN_REGISTERED) continue;
    out = out.split(value).join('<redacted>');
  }
  out = out.replace(CAPABILITY, 'dcap_<redacted>');
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  return out;
}
