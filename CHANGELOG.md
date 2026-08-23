# Changelog

Release Please writes this file from the Conventional Commit messages that
land on `main`, and inserts each new version immediately above the heading
below. Releases made before it took over are recorded only in the git tags:
`git log --oneline v0.1.0..v0.10.1`.

Versions are pre-1.0, so `feat:` and a breaking change both bump the minor and
`fix:` bumps the patch — see `release-please-config.json`.

## [0.11.0](https://github.com/flosrn/ax/compare/v0.10.1...v0.11.0) (2026-08-23)


### Features

* make ax the repository-scoped agent experience ([#1](https://github.com/flosrn/ax/issues/1)) ([697f66f](https://github.com/flosrn/ax/commit/697f66f36964d14833da9d2e7ad3cb464b5b11c8))
* **worker:** transcript --last-message — the last thing the agent SAID, in full ([f4e72f8](https://github.com/flosrn/ax/commit/f4e72f84648e7c47c4e7f22bf6cfd3f46efe41c0))
* **worker:** transcript resolves a bare session id — what the card shows is enough ([69c9cdd](https://github.com/flosrn/ax/commit/69c9cdd364557ddacc150442a909de531de04574))

## 0.10.1 (2026-08-23)

The baseline. This is the version recorded in `.release-please-manifest.json`
when Release Please took ownership of versioning; the notes for it and for
everything before it are in the tag history.
