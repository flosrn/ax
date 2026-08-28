# Changelog

Release Please writes this file from the Conventional Commit messages that
land on `main`, and inserts each new version immediately above the heading
below. Releases made before it took over are recorded only in the git tags:
`git log --oneline v0.1.0..v0.10.1`.

Versions are pre-1.0, so `feat:` and a breaking change both bump the minor and
`fix:` bumps the patch — see `release-please-config.json`.

## [0.14.5](https://github.com/flosrn/ax/compare/v0.14.4...v0.14.5) (2026-08-28)


### Bug Fixes

* a published fix could not reach the repository that reported the bug ([#31](https://github.com/flosrn/ax/issues/31)) ([c9d18d0](https://github.com/flosrn/ax/commit/c9d18d0a4d624b09d24258d99b390dcca6d664c1))

## [0.14.4](https://github.com/flosrn/ax/compare/v0.14.3...v0.14.4) (2026-08-28)


### Bug Fixes

* three grounds a coordinator had to hold by hand ([#29](https://github.com/flosrn/ax/issues/29)) ([b541e75](https://github.com/flosrn/ax/commit/b541e75de171410de1fdce4212b32670cff92c39))

## [0.14.3](https://github.com/flosrn/ax/compare/v0.14.2...v0.14.3) (2026-08-28)


### Bug Fixes

* **triage:** find a question by the key its sender stamped, not the pane a record stores ([#27](https://github.com/flosrn/ax/issues/27)) ([b4fcd12](https://github.com/flosrn/ax/commit/b4fcd1283f2503103cd046df0c83ab4ce96ef4b6))
* **triage:** wait out a booting child instead of reading its boot state as a verdict ([#26](https://github.com/flosrn/ax/issues/26)) ([ca2c4e8](https://github.com/flosrn/ax/commit/ca2c4e8eef3449f8b83c2468ab2c8ff655e650c3))

## [0.14.2](https://github.com/flosrn/ax/compare/v0.14.1...v0.14.2) (2026-08-28)


### Bug Fixes

* **omp:** keep foreign sessions off the peer receiver ([#23](https://github.com/flosrn/ax/issues/23)) ([e3ae77e](https://github.com/flosrn/ax/commit/e3ae77e68fb071f0a91b4cd6b9ecc8b883755f10))
* **omp:** only a LIVE owner may keep a session off its peer Run ([#25](https://github.com/flosrn/ax/issues/25)) ([1234d18](https://github.com/flosrn/ax/commit/1234d182eb1276731533fdc0cb319d12b415cce5))

## [0.14.1](https://github.com/flosrn/ax/compare/v0.14.0...v0.14.1) (2026-08-27)


### Bug Fixes

* **worker:** mint under the recovery lock, so no recorded phase is lost ([#21](https://github.com/flosrn/ax/issues/21)) ([a1e689a](https://github.com/flosrn/ax/commit/a1e689a1dac1d810dbf5dea952e492daef4d058c))

## [0.14.0](https://github.com/flosrn/ax/compare/v0.13.0...v0.14.0) (2026-08-27)


### Features

* **omp:** the maintainer role, and the reporting direction that had no contract ([9615e71](https://github.com/flosrn/ax/commit/9615e71a5ed6aa7b42b2f1d7100631e4265b6e5e))


### Bug Fixes

* **commands:** the transcript row names its argument in the help's own language ([b1e92eb](https://github.com/flosrn/ax/commit/b1e92eb05a5f9b242f445383445cfd300de35f4c))
* **scripts:** deploy reaches its own checkout and the VPS adapter ([e7f39ec](https://github.com/flosrn/ax/commit/e7f39ecc6fe63ed9f10b473d2dc864d3326f05a3))
* **triage:** repair the question channel — eight defects one live wave paid for ([#19](https://github.com/flosrn/ax/issues/19)) ([ae8cbac](https://github.com/flosrn/ax/commit/ae8cbac660df4f3b72812381620820053346fb20))

## [0.13.0](https://github.com/flosrn/ax/compare/v0.12.3...v0.13.0) (2026-08-26)


### Features

* **worker:** tail says what the child RECORDED, because ALIVE is not a channel ([3f8b30b](https://github.com/flosrn/ax/commit/3f8b30b70e7c06ff9d52b8e1c396dd3eb31a7ec4))
* **worker:** the escalation bullet says to quote the error, not summarize it ([3fe9405](https://github.com/flosrn/ax/commit/3fe940538d579c3cf351e2b61e007ca381499ecf))


### Bug Fixes

* **triage:** ask carries the dispatch capability it was stripping ([8623894](https://github.com/flosrn/ax/commit/8623894db23db361225085418fa1aebc87fc5a1e))
* **triage:** F-030 names which refusal it is, so its repair is the right one ([9655e3e](https://github.com/flosrn/ax/commit/9655e3ee82fdc8ede04d6a99b9738a312f25fa51))
* **triage:** status says WHY no ask is answerable, instead of printing a count ([e512358](https://github.com/flosrn/ax/commit/e51235855af392b5e0a44d3706fe3bdffdf11e3e))
* **worker:** a child gets the address it can act on, and the file describing its tree ([b7bfe60](https://github.com/flosrn/ax/commit/b7bfe6013b58ecfac2f74b51051fd7dd269a23f3))
* **worker:** a launch verdict re-reads its proofs instead of latching the first ([0c1c5c1](https://github.com/flosrn/ax/commit/0c1c5c15d56a5bdfedabe24c8446e383ec1beb6d))
* **worker:** a user_owned pane is offered the command that can close it ([2116df2](https://github.com/flosrn/ax/commit/2116df2038a7ddb4d4d1949ba19971d4e65d3d36))
* **worker:** the preamble bound is the discriminant, and it is measured ([f647dc8](https://github.com/flosrn/ax/commit/f647dc84f4275b45b74d2652aeb5192d96fe8ef7))
* **worker:** worker gate resolves a request id, and names the third cause ([0821a21](https://github.com/flosrn/ax/commit/0821a2126afca1659d7f450bfeb83678288bebac))

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
