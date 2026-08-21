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

/** Every known authority-token shape, replaced with an inert marker. */
export const redactSecrets = text => String(text).replace(CAPABILITY, 'dcap_<redacted>');
