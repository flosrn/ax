# Changelog

Release Please writes this file from the Conventional Commit messages that
land on `main`, and inserts each new version immediately above the heading
below. Releases made before it took over are recorded only in the git tags:
`git log --oneline v0.1.0..v0.10.1`.

Versions are pre-1.0, so `feat:` and a breaking change both bump the minor and
`fix:` bumps the patch — see `release-please-config.json`.

## [0.11.3](https://github.com/flosrn/ax/compare/v0.11.2...v0.11.3) (2026-08-25)


### Bug Fixes

* **pin:** a version bump is a lockfile change, so the install is told so ([945256a](https://github.com/flosrn/ax/commit/945256af04f2ecb63aac13f231fe1c40d003c100))

## [0.11.2](https://github.com/flosrn/ax/compare/v0.11.1...v0.11.2) (2026-08-24)


### Bug Fixes

* **launch:** refuse --run, and name the receiver as the repair ([51f4fdd](https://github.com/flosrn/ax/commit/51f4fdd7364cde132ec2ac864b3f852c0f661ad2))
* **repair:** arm the watcher on unknown liveness, and take the floor from the dispatching phase ([597ceaf](https://github.com/flosrn/ax/commit/597ceafd6d1fa435bc3b01ee908eead9db3479b4))
* **worker:** prove a brief was delivered from the child's session, never the cursor ([592120c](https://github.com/flosrn/ax/commit/592120cc1d540fa86974d1ab459edc7f1222a769))
* **worker:** the witness names one dispatch, and receipt is not liveness ([6dcccf2](https://github.com/flosrn/ax/commit/6dcccf2b5310f40c14fe1d3e88ef6cfbd59f612f))

## [0.11.1](https://github.com/flosrn/ax/compare/v0.11.0...v0.11.1) (2026-08-23)


### Bug Fixes

* **test:** bun owns omp/, and stops grading the node suite ([f8f406e](https://github.com/flosrn/ax/commit/f8f406e76e97ad6b294a855a42f66d6d99a3af89))

## [0.11.0](https://github.com/flosrn/ax/compare/v0.10.1...v0.11.0) (2026-08-23)


### Features

* make ax the repository-scoped agent experience ([#1](https://github.com/flosrn/ax/issues/1)) ([697f66f](https://github.com/flosrn/ax/commit/697f66f36964d14833da9d2e7ad3cb464b5b11c8))
* **worker:** transcript --last-message — the last thing the agent SAID, in full ([f4e72f8](https://github.com/flosrn/ax/commit/f4e72f84648e7c47c4e7f22bf6cfd3f46efe41c0))
* **worker:** transcript resolves a bare session id — what the card shows is enough ([69c9cdd](https://github.com/flosrn/ax/commit/69c9cdd364557ddacc150442a909de531de04574))

## 0.10.1 (2026-08-23)

The baseline. This is the version recorded in `.release-please-manifest.json`
when Release Please took ownership of versioning; the notes for it and for
everything before it are in the tag history.
