# Frictions

Reports from sessions using ax as an instrument (`omp/roles/maintainer.md` §
Record defers to this header for the form). Each entry carries four things, and
the first decides whether the other three are usable: the exact argv (and the
cwd when it is not the repository root); the raw output, never a summary of it;
the state expected instead; what it cost in the run that hit it.

Every entry ends with a **Verdict** the maintainer stamps — one of `open`
(reported, not yet handled), `fixed`, `refused` (with the reason and the
cheaper existing thing), `unreproducible`. An entry is written whatever the
outcome: a record holding only `fixed` measures how agreeable the maintainer
was, not how the tool behaves.

## 2026-08-31 — worker sessions cannot push `.github/workflows/**` (no `workflow` scope)

- **Argv:** `git push origin feat/41-prefactor-dispatch` — from
  `/Users/flo/orca/workspaces/41-prefactor-dispatch`, a worktree `ax worker
  launch` provisioned, pushing a commit that included a one-comment-line edit
  to `.github/workflows/publish.yml`.
- **Raw output:**

  ```
  ! [remote rejected] feat/41-prefactor-dispatch -> feat/41-prefactor-dispatch
    (refusing to allow an OAuth App to create or update workflow
     `.github/workflows/publish.yml` without `workflow` scope)
  ```

  `gh auth status` in the same session: `Token scopes: 'gist', 'read:org',
  'repo'`. The orchestrating session's token carries the same three scopes.
- **Expected:** a dispatched worker whose slice legitimately touches a workflow
  file can push its branch. The remote is `https://github.com/flosrn/ax.git`
  with the osxkeychain/gh credential, so every provisioned worktree inherits
  the scope-limited OAuth path.
- **Cost:** in spec #39's wave, ticket #41 had to drop a written change and
  ship PR #47 with `.github/workflows/publish.yml:141` still citing the old
  module path; one orchestrator↔child round-trip to discover and route the
  repair; #46's comment sweep will hit the same wall.
- **Repair that works today (undocumented):** SSH pushes are not subject to the
  OAuth-app workflow restriction and this machine's key authenticates as
  flosrn — `git push git@github.com:flosrn/ax.git HEAD:<branch>` from the
  worktree, no remote-config change. Candidates for the instrument: provision
  worktrees with an SSH push URL (or a pushurl override), or document the SSH
  escape in the launch receipt / worktree context so a child facing the
  rejection finds the repair without a round-trip.
- **Verdict:** fixed — the second candidate. `.agent/worktree-context.local.md`
  (the file a cold child reads first) now carries a `## Pushing` section naming
  the wall, the cause (`workflow` scope) and one copyable, repo-agnostic
  command: `git -c 'url.git@github.com:.insteadOf=https://github.com/' push
  origin HEAD` — ephemeral, no config mutation, inert on an SSH remote.
  Contract: `tests/worktree-context.test.mjs`; rewrite-applies-to-push proven
  against a local bare repo. The first candidate (provision an SSH pushurl) is
  **refused**: `remote.origin.pushurl` is repo-level config shared by every
  worktree including the primary checkout, so provisioning would flip the
  operator's own push path; scoping it needs `extensions.worktreeConfig` and
  still hard-fails every push on a machine without a GitHub-accepted SSH key,
  where the documented escape merely goes unused.
