// The redaction pass exists because a supervised child's transcript carries its
// dispatch-capability token BY CONSTRUCTION (the Orca preamble embeds it in
// every taught command — measured twice in the preamble alone, 2026-08-21).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactSecrets } from '../src/redact.mjs';

test('capability tokens are replaced everywhere they appear', () => {
  const line =
    'orca orchestration send --from term_x --dispatch-capability dcap_Ri2Hq4GmCmbcPILrXl_paVDOrLB7J3MQwroDVnDLPMU ' +
    'and again dcap_abc-123';
  const out = redactSecrets(line);
  assert.doesNotMatch(out, /dcap_[A-Za-z0-9_-]{4,}/);
  assert.equal(out.match(/dcap_<redacted>/g).length, 2);
  assert.match(out, /--from term_x/, 'non-secret content survives verbatim');
});

test('text without tokens is returned unchanged', () => {
  const text = 'PROBE-ACK cwd=/x handle=term_y — sent via orchestration send';
  assert.equal(redactSecrets(text), text);
});
