# Changelog

Release Please writes this file from the Conventional Commit messages that
land on `main`, and inserts each new version immediately above the heading
below. Releases made before it took over are recorded only in the git tags:
`git log --oneline v0.1.0..v0.10.1`.

Versions are pre-1.0, so `feat:` and a breaking change both bump the minor and
`fix:` bumps the patch — see `release-please-config.json`.

## [0.12.3](https://github.com/flosrn/ax/compare/v0.12.2...v0.12.3) (2026-08-26)


### Bug Fixes

* **config:** repoPaths reads root and main from git.mjs, the one derivation ([439ce13](https://github.com/flosrn/ax/commit/439ce137ac4341c15b8054b883f2e3849e4486df))
* **worktree:** a promotion writes the plan's stack, never a fresh mint ([800a817](https://github.com/flosrn/ax/commit/800a8178815b0313ad8910a003fa6f1e48fe70f8))

## [0.12.2](https://github.com/flosrn/ax/compare/v0.12.1...v0.12.2) (2026-08-25)


### Bug Fixes

* **report:** announce undeliverable reports in the session that produced ([f771ecb](https://github.com/flosrn/ax/commit/f771ecb2083512823bdce7d5f8286634e0884629))

## [0.12.1](https://github.com/flosrn/ax/compare/v0.12.0...v0.12.1) (2026-08-25)


### Bug Fixes

* **tests:** the release gate no longer races the watcher's pidfile removal ([0eee2b8](https://github.com/flosrn/ax/commit/0eee2b8d3c9840ee1d811d0230f9d54369376c4f))

## [0.12.0](https://github.com/flosrn/ax/compare/v0.11.3...v0.12.0) (2026-08-25)


### Features

* **launch:** a ticket that says it touches the database gets its own stack ([4098143](https://github.com/flosrn/ax/commit/4098143dd82bfdd82e8f559bc3a74c39d395c372))
* **peer:** resolve a peer by the session id Orca shows on its card ([941d91d](https://github.com/flosrn/ax/commit/941d91d5e8a85ff809b0d521f55e56dffd3decf5))
* **triage:** add refine readiness pass for PRD tickets ([#7](https://github.com/flosrn/ax/issues/7)) ([c5e850d](https://github.com/flosrn/ax/commit/c5e850da6089775572bed7a43ae6a13fca25c32b))


### Bug Fixes

* **peer:** a recorded route, not attribution, decides that a message can be answered ([fd73724](https://github.com/flosrn/ax/commit/fd7372477caf293ba883b2da4afb40707eb413ca))
* **peer:** say when a message cannot be answered, where the model reads it ([2434467](https://github.com/flosrn/ax/commit/2434467680bed67a77e373227768bb3d28eb87fa))
* **pr-gate:** the next action a PASS prints carries the acks that PASS stood on ([1bbebf6](https://github.com/flosrn/ax/commit/1bbebf6848fc5a7dc57be8f209461fca691e9d3d))
* **report:** a second finish is still a finish, and an unfinished cycle is not one ([dac362d](https://github.com/flosrn/ax/commit/dac362db10106fd2ddfda3bbd5f2118d6e3b039c))
* **stall:** read the repair marker every tick, not once before it exists ([c3863cb](https://github.com/flosrn/ax/commit/c3863cb21403358328f2de91689c6251edf0e398))
* **worker:** a record tail could not READ is not a record that does not exist ([92fd5e6](https://github.com/flosrn/ax/commit/92fd5e67351451f55420f9187ed988cb559139c0))
* **worker:** an EXITED pane is never called alive ([ba62ab7](https://github.com/flosrn/ax/commit/ba62ab711b6a5f8d2cf0f395a9a4ab3343b930d3))
* **worker:** name the unsettled pane, and let tail take the request that owns it ([19bffd2](https://github.com/flosrn/ax/commit/19bffd2305dd262950534139d222384b64182db1))
* **worker:** never point transcript at a term_ handle, and name EXITED in help ([deadfbf](https://github.com/flosrn/ax/commit/deadfbffedfabd523b6e2efdeb0f37ceb146fd18))
* **worker:** omission is PER HOST, so a covered runtime's absent pane is a corpse ([4ab5a2b](https://github.com/flosrn/ax/commit/4ab5a2bcbe332aabf06f0dface1609f333a383bf))
* **worktree:** ask the proxy for its route from inside the worktree ([b9f96d9](https://github.com/flosrn/ax/commit/b9f96d9176c618b2bbf11b3da20a17e7fbc58206))

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
