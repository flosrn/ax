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

// The pin is an exact npm version now, not a git ref: ax is published to the
// registry, and a `github:` pin resolves outside the lockfile's version
// arithmetic. Migrating one to a version is this verb's job, so the fixture
// starts on the old shape on purpose.
const LEGACY = 'github:flosrn/ax#v0.5.2';

function repo({ pinned = '0.5.2', manifest = true } = {}) {
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
function fakeExec({ install = { status: 0 }, doctor = { status: 0 }, onInstall = null, frozen = false } = {}) {
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
        // A workspace whose install is frozen by default: exactly what ofmchat
        // answered, and the only thing that distinguishes it is the flag.
        if (frozen && !args.includes('--no-frozen-lockfile')) {
          return { status: 1, stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"' };
        }
        if (onInstall) onInstall(at);
        return { stdout: '', stderr: '', ...install };
      }
      if (bin.endsWith('/bin/ax') && args[0] === 'doctor') return { stdout: '', stderr: '', ...doctor };
      return { status: 1, stdout: '', stderr: `unexpected: ${bin} ${args.join(' ')}` };
    },
  };
}

const run = (argv, { root = repo(), exec = fakeExec() } = {}) => {
  const result = capture(() => pin([...argv], { exec: exec.exec, cwd: root }));
  return { ...result, root, calls: exec.calls };
};

test('a full bump: exact version written, install proven from node_modules, doctor run, commit PRINTED not run', () => {
  const exec = fakeExec({ onInstall: at => installAs(at, '0.6.6') });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 0);
  const manifest = JSON.parse(readFileSync(join(r.root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@flosrn/ax'], '0.6.6', 'the tag form is an input; the manifest carries what npm resolves');
  assert.match(r.out, /installed @flosrn\/ax 0\.6\.6, proven from node_modules/);
  assert.match(r.out, /doctor coherent/);
  assert.match(r.out, /git add package\.json pnpm-lock\.yaml && git commit -m "chore\(deps\): bump @flosrn\/ax to 0\.6\.6" && git push/);
  assert.ok(r.calls.every(line => !line.startsWith('git commit') && !line.startsWith('git push')), 'the git gesture stays the caller\'s');
});

test('a frozen lockfile does not defeat the bump: the install is told the lockfile is changing', () => {
  // Measured 2026-08-24 on ofmchat (pnpm 11, a MakerKit workspace): `ax pin
  // 0.11.2` refused with "pnpm install refused the new pin: exit 1", because a
  // bare `pnpm install` there is frozen-lockfile and a version change
  // desynchronises the lockfile BY CONSTRUCTION. So the verb could never
  // succeed on that repo, and it left the manifest bumped with the old package
  // still installed — the exact half-state its own guard then refuses.
  //
  // `--no-frozen-lockfile` is not a loosening: the whole purpose of this verb is
  // to move that pin and rewrite that lockfile, which is why the printed commit
  // gesture stages `pnpm-lock.yaml`.
  const exec = fakeExec({
    frozen: true,
    onInstall: at => installAs(at, '0.6.6'),
  });
  const r = run(['0.6.6'], { exec });

  assert.equal(r.code, 0, r.out);
  const install = r.calls.find(line => line.startsWith('pnpm install'));
  assert.match(install, /--no-frozen-lockfile/, 'the flag is passed, so a workspace defaulting to frozen still installs the new pin');
  assert.match(r.out, /installed @flosrn\/ax 0\.6\.6, proven from node_modules/);
});

test('X.Y.Z and vX.Y.Z are the same pin, and a github: pin is migrated to it', () => {
  const exec = fakeExec({ onInstall: at => installAs(at, '0.6.6') });
  const r = run(['0.6.6'], { root: repo({ pinned: LEGACY }), exec });

  assert.equal(r.code, 0);
  assert.equal(JSON.parse(readFileSync(join(r.root, 'package.json'), 'utf8')).devDependencies['@flosrn/ax'], '0.6.6');
  assert.match(r.out, new RegExp(`${LEGACY.replace(/[.#/]/g, '\\$&')} → 0\\.6\\.6`));
});

test('an install that served another version is refused — the proof is the disk, not the receipt', () => {
  const exec = fakeExec({ onInstall: at => installAs(at, '0.5.2') });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 1);
  assert.match(r.out, /the installed package is 0\.5\.2/);
  assert.doesNotMatch(r.out, /git add/, 'no commit line for a bump that did not happen');
});

test('a doctor that refuses the new pin blocks the commit line AND prints what it found', () => {
  // Measured 2026-08-28: `@flosrn/ax@0.14.4` was announced to
  // goodluckagency/ofmchat, its bump workflow ran `ax pin 0.14.4`, and the run
  // failed with `ax doctor refuses this checkout under 0.14.4` and NOTHING else.
  // The doctor's findings went to a captured subprocess this verb discarded, so
  // the only artefact of a real blocked deployment named no cause — and the
  // repair it printed (`ax doctor`) is a command the CI runner cannot be asked to
  // type. The findings are the whole content of the refusal.
  const exec = fakeExec({
    onInstall: at => installAs(at, '0.6.6'),
    doctor: { status: 1, stdout: '  ✗ AGENTS.md carries no BEGIN:ax block\n      → ax init\n', stderr: '' },
  });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 1);
  assert.match(r.out, /do not commit a pin the doctor rejects/);
  assert.match(r.out, /AGENTS\.md carries no BEGIN:ax block/, 'the finding travels with the refusal');
  assert.doesNotMatch(r.out, /git add/);
});

test('a doctor that could not RUN is not reported as a checkout it refused', () => {
  // Two different states: "the checkout is incoherent" and "nothing graded it".
  // Collapsing them sends an operator to repair findings that were never
  // produced — the same class as reporting an absence as a verdict (F-028).
  const exec = fakeExec({
    onInstall: at => installAs(at, '0.6.6'),
    doctor: { error: new Error('spawn ENOENT'), status: null, stdout: '', stderr: '' },
  });
  const r = run(['v0.6.6'], { exec });

  assert.equal(r.code, 1);
  assert.match(r.out, /could not run/);
  assert.match(r.out, /ENOENT/);
  assert.doesNotMatch(r.out, /do not commit a pin the doctor rejects/, 'nothing graded this checkout, so nothing refused it');
});

test('a dirty package.json refuses before anything moves — the diff must be its own', () => {
  const root = repo();
  writeFileSync(join(root, 'package.json'), `${readFileSync(join(root, 'package.json'), 'utf8')}\n`);
  const r = run(['v0.6.6'], { root });

  assert.equal(r.code, 1);
  assert.match(r.out, /refuses to weld its diff/);
  assert.ok(r.calls.every(line => !line.includes('pnpm install')), 'nothing was installed');
});

test('a link: pin — the dev workflow — is refused by name, not overwritten', () => {
  const root = repo({ pinned: 'link:../../flosrn/ax' });
  const r = run(['v0.6.6'], { root });
  assert.equal(r.code, 1);
  assert.match(r.out, /a local checkout rather than a release/);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies['@flosrn/ax'], 'link:../../flosrn/ax');
});

test('already on the version re-proves disk and doctor without reinstalling', () => {
  const root = repo();
  installAs(root, '0.5.2');
  const r = run(['v0.5.2'], { root });
  assert.equal(r.code, 0);
  assert.match(r.out, /already pinned to 0\.5\.2 — re-proving/);
  assert.match(r.out, /installed @flosrn\/ax 0\.5\.2, proven/);
  assert.match(r.out, /doctor coherent/);
  assert.ok(r.calls.every(line => !line.startsWith('pnpm install')), 'verification does not reinstall an unchanged pin');
  assert.ok(r.calls.some(line => line.endsWith('/bin/ax doctor')));
  assert.doesNotMatch(r.out, /git add/, 'verification-only runs earn no commit');
});

test('--dry-run names the move and touches nothing', () => {
  const r = run(['v0.6.6', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /0\.5\.2 → 0\.6\.6/);
  const manifest = JSON.parse(readFileSync(join(r.root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@flosrn/ax'], '0.5.2');
  assert.ok(r.calls.every(line => !line.includes('pnpm install')));
});

test('usage: a version is required, and X.Y.Z is accepted where a tag once was', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['0.6.6'], { root: repo({ pinned: LEGACY }), exec: fakeExec({ onInstall: at => installAs(at, '0.6.6') }) }).code, 0);
  assert.equal(run(['0.6']).code, 2);
  assert.equal(run(['^0.6.6']).code, 2);
  assert.equal(run(['v0.6.6', 'v0.6.7']).code, 2);
  const bare = repo({ manifest: false });
  writeFileSync(join(bare, 'package.json'), '{}');
  const r = run(['v0.6.6'], { root: bare });
  assert.equal(r.code, 1);
  assert.match(r.out, /declares no @flosrn\/ax pin/);
  assert.match(r.out, /ax init/);
});
