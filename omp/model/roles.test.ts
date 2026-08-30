/**
 * The loader that replaced OMP's agent and skill discovery.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `model.test.ts`
 * That file drives the APPLIER through injected seams, which is right for it and
 * useless here: a seam-driven suite cannot tell whether the package's own files
 * parse, whether a name can escape the roles directory, or whether the five roles
 * this package ships are still loadable after somebody edits one. Those are
 * questions about DATA, so they are asked against real files.
 *
 * The five shipped roles are asserted by name. A role that stops loading is not a
 * red somewhere in the applier — it is five sessions that refuse to start, and
 * the refusal is correct behaviour, so nothing else in the suite would go red.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listRoles,
  loadPlaybook,
  loadRole,
  parseRoleFile,
  playbooksDir,
  rolesDir,
} from './roles.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ax-roles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function role(name: string, body: string): void {
  writeFileSync(join(dir, `${name}.md`), body);
}

// ── the roles this package actually ships ────────────────────────────────────
test('the five session roles load from the package, with no host discovery at all', async () => {
  // The whole point of the migration: these resolve from files inside the
  // package, so an installed copy under node_modules and a fresh checkout answer
  // identically, and a role on a branch is visible to the session on that branch.
  for (const name of ['readiness', 'maintainer', 'orchestrator', 'worker', 'triage-worker']) {
    const found = await loadRole(name);
    expect(found.reason).toBe('ok');
    expect(found.role?.name).toBe(name);
    expect(found.role?.systemPrompt.trim()).not.toBe('');
  }
});

test('the shipped roles are exactly the five, so a stray file cannot become a session identity', async () => {
  // `maintainer` was admitted on 2026-08-26, and admitting it meant editing this
  // list on purpose — which is the whole value of a closed set. It owns the
  // INSTRUMENT rather than any work done with it: the sideways direction of
  // reporting, which had no role and therefore turned tool defects into silent
  // workarounds carried in one consumer's memory for six minor versions.
  // `refine-worker` was removed the same way, on purpose: `to-tickets` publishes
  // `ready-for-agent` itself, so a spec-born ticket needs no readiness pass.
  expect(await listRoles()).toEqual([
    'maintainer',
    'orchestrator',
    'readiness',
    'triage-worker',
    'worker',
  ]);
});

test('each declared playbook is one this package ships - there is no host fallback to cover a miss', async () => {
  // A role whose playbook is absent REFUSES, by design. So an autoloadSkills name
  // that no longer matches a file is not a degraded session, it is a dead one —
  // and nothing else in the suite notices, because refusing is correct.
  for (const name of ['worker', 'triage-worker']) {
    const found = await loadRole(name);
    for (const wanted of found.role?.autoloadSkills ?? []) {
      const playbook = await loadPlaybook(wanted);
      expect(`${wanted}: ${playbook.reason}`).toBe(`${wanted}: ok`);
    }
  }
});

test('the operator roles declare no playbook, so activating one costs no file read', async () => {
  for (const name of ['readiness', 'orchestrator']) {
    expect((await loadRole(name)).role?.autoloadSkills).toBeUndefined();
  }
});

// ── the parser, on the shapes the role files actually use ────────────────────

test('a scalar autoloadSkills is one name, which is how every shipped role writes it', () => {
  const parsed = parseRoleFile('r', '---\nname: r\nautoloadSkills: implementation\n---\n# Body\n');
  expect(parsed).toEqual({ role: { name: 'r', systemPrompt: '# Body\n', autoloadSkills: ['implementation'] } });
});

test('an inline list and a block list mean the same thing', () => {
  const inline = parseRoleFile('r', '---\nname: r\ntools: [read, bash]\n---\nbody\n');
  const block = parseRoleFile('r', '---\nname: r\ntools:\n  - read\n  - bash\n---\nbody\n');
  expect(inline).toEqual({ role: { name: 'r', systemPrompt: 'body\n', tools: ['read', 'bash'] } });
  expect(block).toEqual(inline);
});

test('a quoted description does not leak its quotes into anything, and is not part of the body', () => {
  const parsed = parseRoleFile('r', '---\nname: r\ndescription: "one: two"\n---\nbody\n');
  expect(parsed).toEqual({ role: { name: 'r', systemPrompt: 'body\n' } });
});

test('a front matter that never closes is malformed, not a body', () => {
  // The dangerous reading is the other one: treating the whole file as the body
  // hands the session its own front matter as its role, which looks plausible and
  // grants none of what the role was supposed to grant.
  const parsed = parseRoleFile('r', '---\nname: r\nbody with no fence\n');
  expect(parsed).toEqual({ error: 'front matter is never closed by a `---` line' });
});

test('a file with no body is refused rather than applied as an empty role', () => {
  expect(parseRoleFile('r', '---\nname: r\n---\n\n  \n')).toEqual({
    error: 'role file declares no body below its front matter',
  });
});

test('a file whose declared name disagrees with its filename is refused', () => {
  // "Close enough" here means handing a session a different role than the one its
  // parent named — the one mismatch that must never resolve.
  expect(parseRoleFile('worker', '---\nname: orchestrator\n---\nbody\n')).toEqual({
    error: 'file declares name `orchestrator`, not `worker`',
  });
});

// ── refusals are named, because the operator's next move differs ─────────────

test('an unknown role names the roles that do exist', async () => {
  role('real', '---\nname: real\n---\nbody\n');
  const found = await loadRole('ghost', dir);
  expect(found.reason).toBe('role-not-found');
  // A bare "not found" leaves the operator unable to tell a typo from a package
  // that shipped without the role. The name was written by a parent session that
  // cannot see this directory.
  expect(found.detail).toContain('real');
});

test('an empty roles directory says so instead of implying a typo', async () => {
  const found = await loadRole('worker', dir);
  expect(found.reason).toBe('role-not-found');
  expect(found.detail).toContain('no roles at all');
});

test('a malformed role file is its own refusal, distinct from an absent one', async () => {
  role('broken', 'no front matter here\n');
  const found = await loadRole('broken', dir);
  expect(found.reason).toBe('role-malformed');
  expect(found.detail).toContain('front matter fence');
});

test('a directory where a role file should be is a load failure, not a missing role', async () => {
  // ENOENT is a fact about the request; anything else is a fault of the
  // installation. Reporting a broken package as a user typo sends the operator
  // looking for a name that is spelled correctly.
  mkdirSync(join(dir, 'lumpy.md'));
  const found = await loadRole('lumpy', dir);
  expect(found.reason).toBe('role-load-failed');
});

// ── the name reaches a path join, so it is untrusted input ───────────────────

test('a role name cannot escape the roles directory', async () => {
  // The name arrives from `[omp role=…]`, written by another session. Rejected
  // rather than normalised: a normaliser decides what a caller meant, and there is
  // exactly one thing a role name may mean.
  for (const attack of ['../secrets', '/etc/passwd', 'a/b', '..', '.hidden']) {
    const found = await loadRole(attack, dir);
    expect(`${attack}: ${found.reason}`).toBe(`${attack}: role-not-found`);
    expect(found.role).toBeNull();
  }
});

test('a playbook name cannot escape the playbooks directory either', async () => {
  for (const attack of ['../../package', 'a/b', '..']) {
    expect((await loadPlaybook(attack, dir)).content).toBeNull();
  }
});

// ── playbooks ────────────────────────────────────────────────────────────────

test('a playbook body arrives fenced and named, so it reads as delivered content', async () => {
  writeFileSync(join(dir, 'flow.md'), '# Flow\nDo the thing.\n');
  const found = await loadPlaybook('flow', dir);
  expect(found.reason).toBe('ok');
  expect(found.content).toBe('<playbook name="flow">\n# Flow\nDo the thing.\n</playbook>');
});

test('an absent playbook is a visible refusal that names the path it looked at', async () => {
  const found = await loadPlaybook('nope', dir);
  expect(found.reason).toBe('playbook-not-found');
  expect(found.detail).toContain('nope');
  expect(found.content).toBeNull();
});

test('an empty playbook file is a load failure, not a body of zero length', async () => {
  // Delivering an empty body would satisfy the caller's "content !== null" check
  // and hand the role nothing, which is the silent version of the refusal.
  writeFileSync(join(dir, 'hollow.md'), '\n\n');
  expect((await loadPlaybook('hollow', dir)).reason).toBe('playbook-load-failed');
});

// ── both stores stay overridable ─────────────────────────────────────────────

test('both directories are env-overridable, and default inside this package', () => {
  expect(rolesDir({ AX_OMP_ROLES_DIR: '/tmp/elsewhere' })).toBe('/tmp/elsewhere');
  expect(playbooksDir({ AX_OMP_PLAYBOOKS_DIR: '/tmp/other' })).toBe('/tmp/other');
  // Derived from `import.meta.url`, never from cwd: a session's cwd is its
  // worktree, and these files ship with the package.
  expect(rolesDir({})).toMatch(/omp\/roles$/);
  expect(playbooksDir({})).toMatch(/omp\/playbooks$/);
});
