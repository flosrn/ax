// Which ax runs, decided before any command does anything.
//
// ax is installed globally so an agent can type `ax` anywhere, and pinned per
// project so a repo's tooling is versioned with the repo. Those two facts
// collide: without this delegation, upgrading the global copy silently changed
// what `ax doctor` graded in every checkout on the machine at once. Every test
// here is about that collision, and one of them runs the real `bin/ax.mjs`
// against a project whose install is a different package entirely.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { installCommand, installOrigin, resolveDelegation, runDelegated, versionLine } from '../src/delegation.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ax-delegation-')));

/** A project root: declares ax or not, installs it or not, split or not. */
function project({ pinned = '1.2.3', install = '1.2.3', split = true, body } = {}) {
  const root = temp();
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'consumer', ...(pinned === null ? {} : { devDependencies: { '@flosrn/ax': pinned } }) }, null, 2)}\n`);
  if (install !== null) {
    const dir = join(root, 'node_modules', '@flosrn', 'ax');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@flosrn/ax', version: install }));
    // The bin wrapper exists in every real install, and delegation must never
    // reach for it: that file IS the delegating entry, and handing argv back to
    // it is how a version loop starts. So it is planted here, and it throws.
    writeFileSync(join(dir, 'bin', 'ax.mjs'), '#!/usr/bin/env node\nthrow new Error("the bin wrapper must never be delegated to");\n');
    if (split) writeFileSync(join(dir, 'src', 'cli.mjs'), body ?? 'export const runCli = () => 0;\n');
  }
  return root;
}

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

/**
 * A RUNNABLE copy of this package at a chosen version — src, schema, manifest
 * and bin entry, nothing stubbed.
 *
 * The two tests that read a version LINE cannot use the stub install above:
 * what they assert is what this package's own code prints about itself, and a
 * `runCli` written by the test would print whatever the test decided. `src/`
 * carries no dependency of its own, so a copy of it plus the schema its config
 * reads at load is a complete install.
 */
function axPackage({ version = '1.2.3', at } = {}) {
  const dir = at ?? temp();
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(join(REPO, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(REPO, 'ax.schema.json'), join(dir, 'ax.schema.json'));
  cpSync(join(REPO, 'bin', 'ax.mjs'), join(dir, 'bin', 'ax.mjs'));
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: '@flosrn/ax', version, description: 'a copy under test', type: 'module', bin: { ax: './bin/ax.mjs' } }, null, 2)}\n`,
  );
  return dir;
}

const capture = async fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: await fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

test("the project's install answers, not the copy that was typed", () => {
  const root = project();
  const decision = resolveDelegation({ roots: [root], self: REPO, command: 'doctor' });

  assert.equal(decision.mode, 'local');
  assert.equal(decision.version, '1.2.3');
  assert.equal(decision.root, root);
  // The implementation, never the wrapper.
  assert.equal(decision.entry, join(root, 'node_modules', '@flosrn', 'ax', 'src', 'cli.mjs'));
});

test('a copy that IS the install runs itself, without importing a second one', () => {
  const root = project();
  const decision = resolveDelegation({ roots: [root], self: join(root, 'node_modules', '@flosrn', 'ax'), command: 'doctor' });

  assert.equal(decision.mode, 'self');
  assert.match(decision.why, /this copy is/);
});

test('nothing here declares ax, so the copy that was typed answers', () => {
  const bare = temp();
  writeFileSync(join(bare, 'package.json'), '{ "name": "unrelated" }\n');
  assert.equal(resolveDelegation({ roots: [bare], self: REPO, command: 'doctor' }).mode, 'self');
  // No manifest at all is the same answer, not a crash.
  assert.equal(resolveDelegation({ roots: [temp()], self: REPO, command: 'doctor' }).mode, 'self');
});

test('only an EXACT declaration is authority: a github:, range or link: pin is no wall', () => {
  // None of these names one version, so there is nothing for delegation to
  // insist on. `ax doctor` grades a non-exact pin and names the repair; turning
  // it into a refusal here would lock a developer out of the very project they
  // are linking ax into.
  for (const pinned of ['github:flosrn/ax#v1.2.3', '^1.2.3', 'link:../../flosrn/ax', 'next']) {
    const uninstalled = resolveDelegation({ roots: [project({ pinned, install: null })], self: REPO, command: 'doctor' });
    assert.equal(uninstalled.mode, 'self', `${pinned} must not refuse`);
    assert.match(uninstalled.why, /exact/);

    // Installed, though, the code on disk is what that project chose to run.
    const installed = resolveDelegation({ roots: [project({ pinned })], self: REPO, command: 'doctor' });
    assert.equal(installed.mode, 'local', `${pinned} is installed, so its install answers`);
  }

  // And a pre-split install under a non-exact pin is not a refusal either.
  const stale = resolveDelegation({ roots: [project({ pinned: 'github:flosrn/ax#v0.8.0', install: '0.8.0', split: false })], self: REPO, command: 'doctor' });
  assert.equal(stale.mode, 'self');
});

test('declared and not installed: refused by name, with the install that repairs it', async () => {
  const root = project({ install: null });
  const decision = resolveDelegation({ roots: [root], self: REPO, command: 'doctor' });

  assert.equal(decision.mode, 'refuse');
  assert.match(decision.message, /declares @flosrn\/ax 1\.2\.3 and has not installed it/);
  assert.equal(decision.repair, `pnpm install --dir '${root}'`);

  const { code, out } = await capture(() => runDelegated(decision, ['doctor']));
  assert.equal(code, 1);
  assert.match(out, /has not installed it/);
  assert.match(out, /pnpm install --dir/);
});

test('a path carrying a single quote is printed raw rather than as a command that would split', () => {
  assert.equal(installCommand("/tmp/flo's repo"), "pnpm install --dir /tmp/flo's repo   # quote this path yourself");
});

test('init bootstraps an unconfigured repo but never overrides a declared release', () => {
  const configured = project({ install: null });
  assert.equal(resolveDelegation({ roots: [configured], self: REPO, command: 'init' }).mode, 'refuse');

  const unconfigured = project({ pinned: null, install: null });
  const initial = resolveDelegation({ roots: [unconfigured], self: REPO, command: 'init' });
  assert.equal(initial.mode, 'self', 'no project version exists yet, so the global copy may create one');

});

test("a fresh worktree has no node_modules, so the primary checkout's install answers", () => {
  // The normal case, not the exception: a worktree created seconds ago declares
  // ax (its package.json is tracked) and carries nothing to run it with.
  const primary = project();
  const worktree = project({ install: null });

  const decision = resolveDelegation({ roots: [worktree, primary], self: REPO, command: 'doctor' });
  assert.equal(decision.mode, 'local');
  assert.equal(decision.root, primary, 'the refusal must not fire before the primary checkout has been looked at');
});

test("a primary install answers only when it matches the worktree's release", () => {
  const primary = project({ pinned: '2.0.0', install: '2.0.0' });
  const worktree = project({ pinned: '1.2.3', install: null });

  const decision = resolveDelegation({ roots: [worktree, primary], self: REPO, command: 'doctor' });
  assert.equal(decision.mode, 'refuse');
  assert.match(decision.message, /declares @flosrn\/ax 1\.2\.3/);
  assert.match(decision.message, /is 2\.0\.0/);
  assert.equal(decision.repair, `pnpm install --dir '${worktree}'`);
});

test('an install too old to have the split is refused, never spawned through its bin', () => {
  const root = project({ pinned: '0.8.0', install: '0.8.0', split: false });
  const decision = resolveDelegation({ roots: [root], self: REPO, command: 'doctor' });

  assert.equal(decision.mode, 'refuse');
  assert.match(decision.message, /ships no src\/cli\.mjs/);
  assert.equal(decision.repair, `pnpm add -D @flosrn/ax@${SELF_VERSION} --dir '${root}'`);
});

test('delegation hands the argv to the local implementation and returns its exit code', async () => {
  const root = project({
    body: `import { writeFileSync } from 'node:fs';
export const runCli = argv => {
  writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify(argv));
  return 7;
};
`,
  });
  const decision = resolveDelegation({ roots: [root], self: REPO, command: 'worktree' });

  assert.equal(await runDelegated(decision, ['worktree', 'ls', '--json']), 7);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'node_modules', '@flosrn', 'ax', 'src', 'argv.json'), 'utf8')), ['worktree', 'ls', '--json']);
});

test('an install whose implementation exports no runCli is named, not thrown', async () => {
  const root = project({ body: 'export const nothing = true;\n' });
  const decision = resolveDelegation({ roots: [root], self: REPO, command: 'doctor' });

  const { code, out } = await capture(() => runDelegated(decision, ['doctor']));
  assert.equal(code, 1);
  assert.match(out, /exports no runCli/);
});

test('the real bin entry delegates: a project pinned elsewhere gets its own ax', () => {
  const root = project({
    body: "export const runCli = argv => { process.stdout.write(`local 1.2.3 ran ${argv.join(' ')}\\n`); return 3; };\n",
  });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });

  let status = 0;
  let out = '';
  try {
    out = execFileSync('node', [join(REPO, 'bin', 'ax.mjs'), 'doctor'], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    status = error.status;
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  assert.equal(status, 3, "the local CLI's exit code is the process's");
  assert.match(out, /local 1\.2\.3 ran doctor/);
  // This repo's own doctor never ran — its first line names the checkout.
  assert.doesNotMatch(out, /ax doctor —/);
  rmSync(root, { recursive: true, force: true });
});

test('inside ax itself, ax is its own tooling and nothing delegates', () => {
  assert.equal(resolveDelegation({ cwd: REPO, command: 'doctor' }).mode, 'self');
});

// ── which of the two copies answered, which is what `ax --version` discloses ──
//
// The collision at the top of this file has a silent form, and it is the one
// that cost a full minor: this machine ran a symlink into a development
// checkout AND a package-manager global, they drifted apart, and neither said
// so — the symlink served whatever branch the checkout happened to be on.

test('a checkout names its branch; an install names WHICH install it is', () => {
  const checkout = temp();
  execFileSync('git', ['init', '-q', '-b', 'feat/known'], { cwd: checkout });
  execFileSync('git', [...IDENTITY, 'commit', '-qm', 'init', '--allow-empty'], { cwd: checkout });
  assert.deepEqual(installOrigin({ self: checkout, roots: [] }), { kind: 'checkout', path: checkout, branch: 'feat/known' });

  // A directory git cannot answer for names no branch rather than guessing one
  // from its own name.
  assert.equal(installOrigin({ self: temp(), roots: [] }).branch, null);

  const root = project();
  const installed = join(root, 'node_modules', '@flosrn', 'ax');
  assert.deepEqual(installOrigin({ self: installed, roots: [root] }), { kind: 'project', path: installed, root });

  // THE SAME BYTES, seen from a project that did not put them there, are a
  // global install — that pair is the whole point of the disclosure.
  assert.equal(installOrigin({ self: installed, roots: [project()] }).kind, 'global');
});

test('the first token of the version line stays the bare version', () => {
  const origins = [
    { kind: 'checkout', path: '/w/ax', branch: 'feat/x' },
    { kind: 'checkout', path: '/w/ax', branch: null },
    { kind: 'project', path: '/w/app/node_modules/@flosrn/ax', root: '/w/app' },
    { kind: 'global', path: '/g/node_modules/@flosrn/ax' },
  ];
  for (const origin of origins) {
    const line = versionLine('0.0.9', origin);
    // A hook verifying a consumer's pin reads field one, and that reader
    // existed before this line carried anything else.
    assert.equal(line.split(' ')[0], '0.0.9', `${origin.kind}: field one must still be the version`);
    assert.doesNotMatch(line, /\n/, `${origin.kind}: one line`);
    assert.ok(line.includes(origin.path), `${origin.kind}: the path is what a hook checks against its pin`);
  }

  assert.match(versionLine('0.0.9', origins[0]), /checkout feat\/x at /);
  assert.match(versionLine('0.0.9', origins[1]), /checkout at /);
  assert.match(versionLine('0.0.9', origins[2]), /project install at /);
  assert.match(versionLine('0.0.9', origins[3]), /global install at /);
});

test('run from a checkout, the real entry names the branch that checkout is on', () => {
  const copy = axPackage({ version: '9.9.9' });
  execFileSync('git', ['init', '-q', '-b', 'feat/known'], { cwd: copy });
  execFileSync('git', [...IDENTITY, 'commit', '-qm', 'init', '--allow-empty'], { cwd: copy });
  // A directory declaring nothing, so this copy answers for itself.
  const elsewhere = temp();

  const out = execFileSync('node', [join(copy, 'bin', 'ax.mjs'), '--version'], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(out.trim(), `9.9.9 — checkout feat/known at ${copy}`);

  rmSync(copy, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('the DELEGATED version is the one reported, never the copy that was typed', () => {
  const root = project({ install: null });
  const installed = axPackage({ version: '1.2.3', at: join(root, 'node_modules', '@flosrn', 'ax') });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const out = execFileSync('node', [join(REPO, 'bin', 'ax.mjs'), '--version'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.trim(), `1.2.3 — project install at ${installed}`);
  assert.notEqual(out.split(' ')[0], SELF_VERSION, 'the global copy reported its own number, which is the drift this discloses');

  rmSync(root, { recursive: true, force: true });
});
