#!/usr/bin/env node
// Copy the two git option identifiers Orca's credential guard appends out of
// Orca's own helper and into `src/worktree/reclaim.mjs`, byte for byte.
//
// WHY A SCRIPT AND NOT A RETYPE. `ax worktree reclaim` runs a project's declared
// archive command, and running it under a weaker execution boundary than Orca's
// is a different command with the project's name on it. The boundary includes
// two static `credential.*=false` entries appended through git's indexed-config
// protocol (`shared/git-credential-prompt-env.ts`). Those are public option
// identifiers, not credential values — but some tooling renders them masked, so
// retyping them is guessing and guessing writes a config the project never set.
// This script never renders them either: it extracts the literal nodes and
// substitutes them, and its own output reports only positions and digests.
//
// WHY IT RUNS ONCE, AT AUTHORING TIME. ax has no runtime dependency on any Orca
// checkout — a verb whose safety depends on a sibling clone on one Mac is not a
// verb a released package can ship. The bytes live in `reclaim.mjs` afterwards,
// and `hookGuardEstablished` refuses to run a declared chain while the
// placeholders are still in place, so a fresh clone fails closed rather than
// silently running with a weaker guard.
//
//   node scripts/extract-hook-guard-keys.mjs --source <orca-checkout>
//
// Exit 0 written or already current · 1 the source nodes could not be located
// · 2 usage.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const HELPER = join('src', 'shared', 'git-credential-prompt-env.ts');
const TARGET = join('src', 'worktree', 'reclaim.mjs');

// The literal pair list `gitCredentialPromptGuardEnv` hands to
// `appendGitConfigEnv`: two `['<option>', 'false']` entries, in order. Matched
// as SOURCE NODES — quote style preserved, key text never inspected.
const PAIR = /\[\s*(['"])([A-Za-z][A-Za-z0-9.-]*)\1\s*,\s*(['"])false\3\s*\]/g;

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const source = flag('--source');
if (source === undefined) {
  process.stderr.write('usage: node scripts/extract-hook-guard-keys.mjs --source <orca-checkout>\n');
  process.exit(2);
}

const helperPath = resolve(source, HELPER);
let helper;
try {
  helper = readFileSync(helperPath, 'utf8');
} catch (error) {
  process.stderr.write(`cannot read ${helperPath}: ${error.message}\n`);
  process.exit(1);
}

const pairs = [...helper.matchAll(PAIR)];
if (pairs.length !== 2) {
  process.stderr.write(
    `expected exactly 2 ['<option>', 'false'] nodes in ${helperPath}, found ${pairs.length} — the helper's shape changed, so nothing was written\n`,
  );
  process.exit(1);
}

// The KEY TEXT is carried, never printed. Only its length and digest are
// reported, which is enough to verify a copy and useless for reconstructing one.
const keys = pairs.map(match => match[2]);
const digest = key => createHash('sha256').update(key).digest('hex').slice(0, 8);

const targetPath = resolve(process.cwd(), TARGET);
let target;
try {
  target = readFileSync(targetPath, 'utf8');
} catch (error) {
  process.stderr.write(`cannot read ${targetPath}: ${error.message}\n`);
  process.exit(1);
}

const BLOCK = /export const CREDENTIAL_GUARD_CONFIG = \[\n(\s*)\[[^\]]*\],\n\s*\[[^\]]*\],\n\];/;
const found = BLOCK.exec(target);
if (found === null) {
  process.stderr.write(`cannot find the CREDENTIAL_GUARD_CONFIG block in ${targetPath} — nothing was written\n`);
  process.exit(1);
}

const indent = found[1];
const replacement = `export const CREDENTIAL_GUARD_CONFIG = [\n${keys.map(key => `${indent}[${JSON.stringify(key)}, 'false'],`).join('\n')}\n];`;
const next = target.replace(BLOCK, replacement);

if (next === target) {
  process.stdout.write('CREDENTIAL_GUARD_CONFIG already carries these bytes; nothing written\n');
} else {
  writeFileSync(targetPath, next);
  process.stdout.write(`wrote 2 option identifiers into ${TARGET}\n`);
}

for (const [index, key] of keys.entries()) {
  process.stdout.write(`  entry ${index}: ${key.length} bytes, sha256 ${digest(key)}, prefix-shape credential.* ${key.startsWith('credential.') ? 'yes' : 'NO'}\n`);
}
