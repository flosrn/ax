// `ax pin` — the mechanical half of a bump, and the git gesture it refuses to
// own. Measured 2026-08-23: seven bumps in one day, four manual gestures each.
//
// The boundary under test: this verb edits package.json and proves the install,
// but NEVER runs git commit or push — a push publishes every local commit on
// the branch, including another actor's unpushed work, and the checkout it runs
// in is shared with dispatched children by design.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pin } from '../src/pin.mjs';

// A NON-flosrn source on purpose: the target is derived from the pin already
// there, never from a constant — a fork distributes ax under its own owner.
const SOURCE = 'github:someone-else/ax-fork';

function repo({ pinned = `${SOURCE}#v0.5.2`, manifest = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-pin-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  if (manifest) {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'consumer', devDependencies: { '@flosrn/ax': pinned } }, null, 2)}\n`);
    execFileSync('git', ['add', 'package.json'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
  }
  return root;
}

/** Simulates a successful install by materialising the version the pin names. */
const installAs = (root, version) => {
  const dir = join(root, 'node_modules', '@flosrn', 'ax');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@flosrn/ax', version }));
};

const capture = fn => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = chunk => (written.push(String(chunk)), true);
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    return { code: fn(), out: written.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
};

/** Real git answers for real; pnpm is scripted per-verb. */
function fakeExec({ install = { status: 0 }, doctor = { status: 0 }, onInstall = null } = {}) {
  const calls = [];
  return {
    calls,
    exec: (bin, args, at) => {
      calls.push(`${bin} ${args.join(' ')}`);
      if (bin === 'git') {
        try {
          return { status: 0, stdout: execFileSync('git', args, { cwd: at, encoding: 'utf8' }), stderr: '' };
        } catch (error) {
          return { status: error.status ?? 1, stdout: '', stderr: String(error.stderr ?? error) };
        }
      }
      if (bin === 'pnpm' && args[0] === 'install') {
        if (onInstall) onInstall(at);
        return { stdout: '', stderr: '', ...install };
      }
      if (bin === 'pnpm' && args[0] === 'ax') return { stdout: '', stderr: '', ...doctor };
      return { status: 1, stdout: '', stderr: `unexpected: ${bin} ${args.join(' ')}` };
    },
  };
}

const run = (argv, { root = repo(), exec = fakeExec() } = {}) => {
  const result = capture(() => pin([...argv], { exec: exec.exec, cwd: root }));
  return { ...result, root, calls: exec.calls };
};

test('a full bump: pin edited, install proven from node_modules, doctor run, commit PRINTED not run', () => {
  const exec = fakeExec({ onInstall: at => installAs(at, '0.6.6') });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 0);
  const manifest = JSON.parse(readFileSync(join(r.root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@flosrn/ax'], `${SOURCE}#v0.6.6`, 'the source is the pin\'s own, not a constant');
  assert.match(r.out, /installed @flosrn\/ax v0\.6\.6, proven from node_modules/);
  assert.match(r.out, /doctor coherent/);
  assert.match(r.out, /git add package\.json pnpm-lock\.yaml && git commit -m "chore\(deps\): bump @flosrn\/ax to v0\.6\.6" && git push/);
  assert.ok(r.calls.every(line => !line.startsWith('git commit') && !line.startsWith('git push')), 'the git gesture stays the caller\'s');
});

test('an install that served another version is refused — the proof is the disk, not the receipt', () => {
  const exec = fakeExec({ onInstall: at => installAs(at, '0.5.2') });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 1);
  assert.match(r.out, /the installed package is v0\.5\.2/);
  assert.doesNotMatch(r.out, /git add/, 'no commit line for a bump that did not happen');
});

test('a doctor that refuses the new pin blocks the commit line', () => {
  const exec = fakeExec({ onInstall: at => installAs(at, '0.6.6'), doctor: { status: 1 } });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 1);
  assert.match(r.out, /do not commit a pin the doctor rejects/);
  assert.doesNotMatch(r.out, /git add/);
});

test('a dirty package.json refuses before anything moves — the diff must be its own', () => {
  const root = repo();
  writeFileSync(join(root, 'package.json'), `${readFileSync(join(root, 'package.json'), 'utf8')}\n`);
  const r = run(['v0.6.6'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /refuses to weld its diff/);
  assert.ok(r.calls.every(line => !line.includes('pnpm install')), 'nothing was installed');
});

test('a pin with no #tag — the link: dev workflow — is refused by name', () => {
  const r = run(['v0.6.6'], { root: repo({ pinned: 'link:../../flosrn/ax' }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /carries no #tag/);
});

test('already on the tag is a no-op that says so', () => {
  const r = run(['v0.5.2']);
  assert.equal(r.code, 0);
  assert.match(r.out, /already pinned to v0\.5\.2/);
  assert.ok(r.calls.every(line => !line.includes('pnpm')), 'nothing installed for a pin already there');
});

test('--dry-run names the move and touches nothing', () => {
  const r = run(['v0.6.6', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /#v0\.5\.2 → .*#v0\.6\.6/);
  const manifest = JSON.parse(readFileSync(join(r.root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@flosrn/ax'], `${SOURCE}#v0.5.2`);
  assert.ok(r.calls.every(line => !line.includes('pnpm install')));
});

test('usage: a tag is required and must be shaped vX.Y.Z; no pin key routes to init', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['0.6.6']).code, 2);
  assert.equal(run(['v0.6.6', 'v0.6.7']).code, 2);
  const bare = repo({ manifest: false });
  writeFileSync(join(bare, 'package.json'), '{}');
  const r = run(['v0.6.6'], { root: bare });
  assert.equal(r.code, 1);
  assert.match(r.out, /declares no @flosrn\/ax pin/);
  assert.match(r.out, /ax init/);
});
