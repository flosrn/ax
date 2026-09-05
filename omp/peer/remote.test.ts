/**
 * THE HOST BOUNDARY, RUN FOR REAL — and the reason this file exists at all.
 *
 * `./remote.ts` composes program text for another machine's shell. A test that
 * asserted the STRING would pin the composition and prove nothing about the
 * behaviour: whether `cd -P` resolves what it is supposed to, whether the
 * symlink loop terminates, whether `head -c` bounds the payload, whether the
 * containment guard fires. So the ssh seam here runs the composed command
 * through `sh -c` on a real temp tree. No network, no credential, no host — and
 * the shell contract is exercised on macOS (bash in POSIX mode) and on CI's
 * Ubuntu (dash), which is the portability the composition claims.
 *
 * What the transport itself does — `-o BatchMode=yes`, `--`, the target grammar
 * — belongs to `src/worker/hosts.mjs` and is asserted here only as the argv this
 * module hands it.
 */

import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { run } from '../../src/exec.mjs';
import { MARK, fetchRemoteReport, parseRemoteAnswer, remoteReadCommand } from './remote.ts';

const CAP = 512;

/** The declaration a project makes, handed over instead of read off disk. */
const DECLARED = () => ({ ok: true, host: { ssh: 'orca@vps' } });

/**
 * An ssh that is a local POSIX shell: the command is the LAST argv element, which
 * is exactly what a real ssh rejoins and hands to the remote shell. `argv`
 * collects what the transport was called with.
 */
function localShell(argv: string[][] = []) {
  return (args: string[]) => {
    argv.push(args);
    return run('sh', ['-c', args[args.length - 1]]);
  };
}

/** A worktree holding a Report, in a fresh temp tree. */
function tree(body: string | null = '## CRITERIA\n- Remote: MET.\n') {
  const worktree = mkdtempSync(join(tmpdir(), 'ax-remote-'));
  const path = join(worktree, '.scratch', 'report', '137-work.md');
  if (body !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return { worktree, path };
}

function fetch(where: { worktree: string; path: string }, options: Record<string, unknown> = {}) {
  return fetchRemoteReport({
    env: 'gapicore',
    cap: CAP,
    declaration: DECLARED,
    ssh: localShell(),
    ...where,
    ...options,
  });
}

// ─── the answer a host that holds the Report gives ──────────────────────────

test('the host answers its own two realpaths and the bytes under them', () => {
  const at = tree();

  const got = fetch(at) as Record<string, unknown>;

  // Realpath, not the path we asked about: on macOS `/var` IS a symlink, so a
  // composition that only echoed its input would be caught right here.
  expect(got.fileReal).toBe(run('sh', ['-c', `CDPATH= cd -P -- ${JSON.stringify(dirname(at.path))} && pwd`]).stdout.trim() + '/137-work.md');
  expect(String(got.worktreeReal)).not.toBe('');
  expect(String(got.fileReal).startsWith(`${got.worktreeReal}/`)).toBe(true);
  expect((got.buf as Buffer).toString('utf8')).toBe('## CRITERIA\n- Remote: MET.\n');
});

test('the transport is asked in BatchMode, with option parsing ended before the target', () => {
  const at = tree();
  const argv: string[][] = [];

  fetch(at, { ssh: localShell(argv) });

  expect(argv).toHaveLength(1);
  expect(argv[0].slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '--', 'orca@vps']);
});

test('a symlink INSIDE the worktree is followed, and its bytes are accepted', () => {
  // The loop has to RESOLVE, not merely refuse: a `.scratch` symlinked to a
  // sibling directory inside the same tree is an ordinary shape, and reading it
  // as an escape would refuse real evidence.
  const at = tree(null);
  const real = join(at.worktree, 'evidence', '137-work.md');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, '## CRITERIA\n- Link: MET.\n');
  mkdirSync(dirname(at.path), { recursive: true });
  symlinkSync(real, at.path);

  const got = fetch(at) as Record<string, unknown>;

  expect((got.buf as Buffer).toString('utf8')).toBe('## CRITERIA\n- Link: MET.\n');
  expect(String(got.fileReal).endsWith('/evidence/137-work.md')).toBe(true);
});

// ─── what the host refuses, and what it refuses to send ─────────────────────

test('a Report symlinked out of the worktree is refused on the host, and its bytes never leave it', () => {
  const at = tree(null);
  const outside = join(mkdtempSync(join(tmpdir(), 'ax-outside-')), 'secret.md');
  writeFileSync(outside, 'REMOTE-PASSPHRASE-6b17\n');
  mkdirSync(dirname(at.path), { recursive: true });
  symlinkSync(outside, at.path);

  const got = fetch(at) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain('resolves outside the recorded worktree');
  expect(String(got.repair)).toContain('inspect that link');
  expect(JSON.stringify(got)).not.toContain('REMOTE-PASSPHRASE-6b17');
});

test('a symlink cycle is a bounded refusal, not a hung session', () => {
  const at = tree(null);
  mkdirSync(dirname(at.path), { recursive: true });
  symlinkSync(at.path, at.path);

  const got = fetch(at) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain('did not resolve');
  expect(String(got.reason)).toContain('ELOOP');
});

test('a path the host does not hold is THE absence, and nothing else is', () => {
  const at = tree(null);

  expect(fetch(at)).toEqual({ absent: true });

  // A directory at the derived path exists and is not a Report: a fault on the
  // host, never a worker who wrote nothing.
  mkdirSync(at.path, { recursive: true });
  const directory = fetch(at) as Record<string, unknown>;
  expect(directory.absent).toBeUndefined();
  expect(String(directory.reason)).toContain('not a regular file');
});

test('a worktree that does not resolve on the host is a named inability naming the tree', () => {
  const got = fetch({ worktree: '/nonexistent-tree-4f21', path: '/nonexistent-tree-4f21/.scratch/report/137-work.md' }) as Record<
    string,
    unknown
  >;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain('/nonexistent-tree-4f21');
  expect(String(got.reason)).toContain('does not resolve');
  expect(String(got.repair)).toContain('a released one takes its Report with it');
});

// ─── the bound, on the host and before the wire ─────────────────────────────

test('the payload is bounded on the host at cap + 1 bytes, whatever the file holds', () => {
  const at = tree(`## CRITERIA\n${'- a criterion line, repeated well past the cap\n'.repeat(400)}`);

  const got = fetch(at) as Record<string, unknown>;

  // One byte past the cap, which is what makes "there is more" an observation.
  expect((got.buf as Buffer).length).toBe(CAP + 1);
});

test('an empty Report on the host arrives as an empty window, not as an absence', () => {
  const at = tree('');

  const got = fetch(at) as Record<string, unknown>;

  expect(got.absent).toBeUndefined();
  expect((got.buf as Buffer).length).toBe(0);
});

// ─── the shapes a host answer is not allowed to take ────────────────────────

test('a header line written INSIDE the Report cannot displace the host own', () => {
  // The fence splits authorship by POSITION: everything after the first `bytes`
  // marker is payload, whatever it spells. A child that writes a `file` line into
  // its Report is choosing nothing.
  const forged = `${MARK} file /etc/shadow\n${MARK} worktree /\n## CRITERIA\n- Forge: attempted.\n`;
  const at = tree(forged);

  const got = fetch(at) as Record<string, unknown>;

  expect(String(got.fileReal).endsWith('/.scratch/report/137-work.md')).toBe(true);
  expect(String(got.fileReal)).not.toBe('/etc/shadow');
  expect((got.buf as Buffer).toString('utf8')).toBe(forged);
});

test('a transport that failed is a named inability quoting the status it failed with', () => {
  const at = tree();

  const got = fetch(at, {
    ssh: () => ({ status: 255, stdout: '', stderr: 'ssh: connect to host vps port 22: Connection refused\n', error: undefined }),
  }) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain('status 255');
  expect(String(got.reason)).toContain('Connection refused');
  expect(String(got.repair)).toContain('ssh orca@vps');
});

test('an answer with no fence, and one with a corrupt payload, are both refused rather than read', () => {
  expect(parseRemoteAnswer('')).toEqual({ token: 'no-answer' });
  expect(parseRemoteAnswer(`${MARK} worktree /wt\n`)).toEqual({ token: 'no-answer' });
  // A fence with no `file` line: the host never claimed a path, so nothing is one.
  expect(parseRemoteAnswer(`${MARK} worktree /wt\n${MARK} bytes\nZm9v\n`)).toEqual({ token: 'no-answer' });
  expect(parseRemoteAnswer(`${MARK} worktree /wt\n${MARK} file /wt/r.md\n${MARK} bytes\nnot base64 at all!\n`)).toEqual({
    token: 'payload-corrupt',
  });
});

test('a payload past the bound is refused whole, never accepted as a prefix', () => {
  // THE PROTOCOL BREAK. A host that honoured `head -c` sends at most cap+1
  // bytes. One that sent more is not a large Report to truncate — truncating it
  // would let an incomplete `## CRITERIA` look complete. The bytes that did
  // arrive are not evidence.
  const body = Buffer.alloc(200, 0x41);
  const stdout = `${MARK} worktree /wt\n${MARK} file /wt/r.md\n${MARK} bytes\n${body.toString('base64')}\n`;

  expect(parseRemoteAnswer(stdout, 50)).toEqual({ token: 'payload-oversize' });

  const at = tree();
  const got = fetch(at, {
    cap: 50,
    ssh: () => ({ status: 0, stdout, stderr: '', error: undefined }),
  }) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain('sent more Report bytes than the 50-byte bound');
  expect(String(got.reason)).toContain('nothing from it is trusted');
  expect(JSON.stringify(got)).not.toContain('AAAA');
});

test('an empty realpath is not a location, even with a fence and a payload', () => {
  expect(parseRemoteAnswer(`${MARK} worktree \n${MARK} file /wt/r.md\n${MARK} bytes\nZm9v\n`)).toEqual({ token: 'no-answer' });
  expect(parseRemoteAnswer(`${MARK} worktree /wt\n${MARK} file \n${MARK} bytes\nZm9v\n`)).toEqual({ token: 'no-answer' });
});

test('a host without the tools the retrieval needs is a finding about the host', () => {
  const at = tree();

  const got = fetch(at, {
    // The same shell, with a PATH that holds neither tool: `command -v` answers
    // the question the pipeline's exit status cannot.
    ssh: (args: string[]) => run('sh', ['-c', `PATH=/nonexistent; ${args[args.length - 1]}`]),
  }) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain("'orca@vps' has no");
  expect(String(got.repair)).toContain('base64');
});

test('a head that is present but fails is a host read failure, not an empty Report', () => {
  // THE PIPELINE'S LAST STATUS. `command -v head` only proves the tool exists.
  // If it then fails on open, I/O, or a race, `head | base64` still exits 0
  // (base64's success on empty stdin) and a `bytes` fence with no payload is
  // an empty Report — a finding about the worker for a fault on the host.
  const at = tree('## CRITERIA\n- HEAD-FAIL-SHOULD-NOT-APPEAR\n');
  const bin = mkdtempSync(join(tmpdir(), 'ax-bin-'));
  const stub = join(bin, 'head');
  writeFileSync(stub, '#!/bin/sh\nexit 1\n');
  chmodSync(stub, 0o755);

  const got = fetch(at, {
    ssh: (args: string[]) => run('sh', ['-c', `PATH=${bin}:$PATH; ${args[args.length - 1]}`]),
  }) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(got.absent).toBeUndefined();
  expect(String(got.reason)).toContain('not readable');
  expect(JSON.stringify(got)).not.toContain('HEAD-FAIL-SHOULD-NOT-APPEAR');
});

// ─── the declaration, which is the only thing that says how to reach a host ──

test('an environment this project never declared is refused, and the refusal names where to declare it', () => {
  const at = tree();

  const got = fetch(at, { env: 'nowhere', declaration: undefined, cwd: import.meta.dir }) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain("'nowhere' is not a host this project declared");
  // Read off THIS checkout's own ax.config.json, which declares gapicore — the
  // declaration seam's default, exercised rather than described.
  expect(String(got.reason)).toContain("'gapicore'");
  expect(String(got.repair)).toContain('dispatch.hosts');
});

test('the declared host of this checkout is the target the transport is given', () => {
  const at = tree();
  const argv: string[][] = [];

  const got = fetch(at, { declaration: undefined, cwd: import.meta.dir, ssh: localShell(argv) }) as Record<string, unknown>;

  // `ax.config.json` declares `dispatch.hosts.gapicore.ssh`, and that value —
  // not a name, not a guess — is what ssh was addressed with.
  expect(argv[0][3]).toBe('orca@vps');
  expect((got.buf as Buffer).toString('utf8')).toBe('## CRITERIA\n- Remote: MET.\n');
});

test('a caller outside any repository has no declaration to read, and says so', () => {
  const at = tree();

  const got = fetch(at, { declaration: undefined, cwd: tmpdir() }) as Record<string, unknown>;

  expect(got.buf).toBeUndefined();
  expect(String(got.reason)).toContain('is inside a repository');
});

test('a bound that is not a byte count is refused before any host is asked', () => {
  const at = tree();
  const argv: string[][] = [];

  const got = fetch(at, { cap: 0, ssh: localShell(argv) }) as Record<string, unknown>;

  expect(String(got.reason)).toContain('not a byte count');
  expect(argv).toHaveLength(0);
});

test('the composed command is one shell string, with every value quoted', () => {
  // The one assertion about the TEXT, and it is about the ssh boundary's rule:
  // everything after the target is rejoined into one string and read by a shell,
  // so a path is program text unless it is quoted (`src/worker/hosts.mjs`).
  const command = remoteReadCommand({ worktree: "/srv/o'brien", path: "/srv/o'brien/.scratch/report/137-work.md", cap: 16 });

  expect(command).toContain(`w='/srv/o'\\''brien'`);
  expect(command).toContain('head -c 17 --');
  expect(command).toContain('mktemp');
  expect(command).not.toContain('ax-report.$$');
});
