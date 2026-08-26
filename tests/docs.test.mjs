// This repository's own docs were the one surface it never graded.
//
// `tests/commands.test.mjs` refuses a block `ax init` writes into SOMEBODY
// ELSE's repo when it names a command the CLI cannot answer. Nothing did the
// same for README.md and AGENTS.md, and both drifted: the README's opening
// sentence advertised `debug-as` — never a command, it is a config section the
// schema validates and nothing implements — and its install pin still read
// v0.3.0 eight releases after 0.8.0. "Documentation that outruns the binary is
// worse than none" is the sentence src/commands.mjs opens with; these are the
// docs an agent reads BEFORE it installs anything, so the rule applies here
// first.
//
// Prose is not scanned, only what a reader would copy: fenced blocks and inline
// code spans. A sentence may say "ax grades itself"; a code span may not say
// `ax grade`.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { commandNames, renderUsage, subcommandNames } from '../src/commands.mjs';
import { description, version } from '../src/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'AGENTS.md'];
const read = file => readFileSync(join(ROOT, file), 'utf8');

/**
 * The copyable parts of a document: fenced-block bodies with their `#` comments
 * stripped, plus every inline code span. A span may wrap across a line, so the
 * capture is newline-tolerant.
 */
function copyable(source) {
  const blocks = [];
  const prose = source.replace(/```[a-z]*\n([\s\S]*?)```/g, (_, body) => {
    blocks.push(body.replace(/#.*$/gm, ''));
    return '\n';
  });
  return [...blocks, ...[...prose.matchAll(/`([^`]+)`/g)].map(match => match[1])];
}

/** `ax <command> [verb]`, however it is invoked: bare, `pnpm -w ax`, `node bin/ax.mjs`. */
const INVOCATION = /\bax(?:\.mjs)?\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;

/** Paths inside this repository, excluding globs — `tests/*.test.mjs` names no one file. */
const REPO_PATH = /(?<!\.)\b(?:src|bin|tests|assets|omp)\/[\w./-]+\.[a-z]+\b/g;

test('every command the docs tell you to type is one the CLI carries', () => {
  for (const file of DOCS) {
    for (const chunk of copyable(read(file))) {
      for (const [match, command, verb] of chunk.matchAll(INVOCATION)) {
        const shown = match.trim();
        assert.ok(commandNames.includes(command), `${file}: "${shown}" names no command in the registry`);

        // Only a noun that declares verbs can advertise a wrong one: `ax pin
        // vX.Y.Z` and `ax supabase db reset` carry arguments ax never parses.
        const verbs = subcommandNames(command);
        if (verbs.length > 0 && verb !== undefined) {
          assert.ok(verbs.includes(verb), `${file}: "${shown}" is no verb of \`ax ${command}\` — ${verbs.join(', ')}`);
        }
      }
    }
  }
});

test('every path the docs point at exists', () => {
  for (const file of DOCS) {
    const pointed = new Set([...read(file).matchAll(REPO_PATH)].map(match => match[0]).filter(path => !path.includes('*')));
    assert.ok(pointed.size > 0, `${file} points at no module — the routing table is the point of that file`);
    for (const path of pointed) {
      assert.ok(existsSync(join(ROOT, path)), `${file} points at ${path}, which is not in this checkout`);
    }
  }
});

test('the docs hand out npm releases, never the retired git pin', () => {
  for (const file of DOCS) {
    const source = read(file);
    assert.doesNotMatch(source, /github:flosrn\/ax#/, `${file} still teaches the git dependency retired by npm releases`);
    for (const [, pinned] of source.matchAll(/@flosrn\/ax@([0-9]+\.[0-9]+\.[0-9]+)/g)) {
      assert.equal(pinned, version, `${file} hands out ${pinned}, and this package is ${version}`);
    }
  }
});

test('the help and the manifest describe the same tool', () => {
  // They did not: the help carried its own copy of the tagline, so the package
  // said one thing and `ax help` another for eight releases.
  assert.ok(renderUsage('0.0.0', { orca: true }).includes(description), 'the help renders a tagline the manifest does not carry');
});

// ── the routing table's completeness, which is the half a machine can hold ────
//
// Measured 2026-08-26: `src/worker/capability.mjs` was added — a module owning a
// security boundary — and no table row named it. The omission was defended on
// the belief that "no test can guard this: a test can check a row points at a
// real file, never that a real file has its row." The first half is true; the
// second is not, and it was an unverified claim that produced a design decision.
//
// A routing table maps a DIRECTORY LISTING, and a listing is enumerable. So
// completeness is mechanizable and lives here. What stays untestable is the
// other direction — whether a row DESCRIBES its module correctly — and nothing
// below pretends otherwise.
//
// A barrel that only dispatches verbs to a SUBCOMMANDS table routes nothing a
// reader needs, so it is exempt BY NAME. A new file is exempt by nobody: it
// fails here until someone either routes it or adds it to this list on purpose.
const UNROUTED = new Set([
  'src/index.mjs',
  'src/pr/index.mjs',
  'src/worker/index.mjs',
  'src/worktree/index.mjs',
]);

const ROUTED = /`(src\/[A-Za-z0-9_/-]+\.mjs)`/g;

const modules = dir =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? modules(`${dir}/${entry.name}`) : entry.name.endsWith('.mjs') ? [`${dir}/${entry.name}`] : [],
  );

test('every src module is routed by AGENTS.md, or exempt on purpose', () => {
  const named = new Set([...read('AGENTS.md').matchAll(ROUTED)].map(match => match[1]));
  const unrouted = modules('src').filter(file => !named.has(file) && !UNROUTED.has(file));

  assert.deepEqual(unrouted, [], 'add a row to the AGENTS.md table, or name the file in UNROUTED with a reason');
});

test('no table row points at a module that does not exist', () => {
  const ghosts = [...read('AGENTS.md').matchAll(ROUTED)].map(match => match[1]).filter(file => !existsSync(join(ROOT, file)));

  assert.deepEqual(ghosts, [], 'a renamed or deleted module left its row behind');
});

test('the exemption list itself cannot rot', () => {
  // An exemption for a file that no longer exists is a stale permission, and the
  // next file to take that path inherits it silently.
  const stale = [...UNROUTED].filter(file => !existsSync(join(ROOT, file)));

  assert.deepEqual(stale, [], 'drop the exemption: its file is gone');
});
