# Changelog

Release Please writes this file from the Conventional Commit messages that
land on `main`, and inserts each new version immediately above the heading
below. Releases made before it took over are recorded only in the git tags:
`git log --oneline v0.1.0..v0.10.1`.

Versions are pre-1.0, so `feat:` and a breaking change both bump the minor and
`fix:` bumps the patch — see `release-please-config.json`.

## [0.24.0](https://github.com/flosrn/ax/compare/v0.23.0...v0.24.0) (2026-09-06)


### Features

* **frontier:** derive Completion from the Spec and its mandate ([#202](https://github.com/flosrn/ax/issues/202)) ([20bd93d](https://github.com/flosrn/ax/commit/20bd93de4c3993b79d9be73c99a559f838f590f3))
* **frontier:** name established dependency cycles without rewriting edges ([#196](https://github.com/flosrn/ax/issues/196)) ([59cecca](https://github.com/flosrn/ax/commit/59cecca29fa9f76d7d6b5714402e0c409dbb6de8))
* **peer:** persist diagnostic reasons across session restart ([#201](https://github.com/flosrn/ax/issues/201)) ([f446f22](https://github.com/flosrn/ax/commit/f446f2297a110a77cfba33927a0bba78f3b9b9d6))
* **worker:** derive a Spec's landed PR, SHA and surfaces into the next dispatch's notes ([#203](https://github.com/flosrn/ax/issues/203)) ([4dd7e47](https://github.com/flosrn/ax/commit/4dd7e47fa78e89ef001070b5b82db0a61e779109))
* **worktree:** reclaim a landed slice's worktree, or KEEP it with a named reason ([#214](https://github.com/flosrn/ax/issues/214)) ([2339a50](https://github.com/flosrn/ax/commit/2339a50a205469ca8e0d2d7a4dc5bed0d8c3891a))


### Bug Fixes

* **orchestrator:** keep technical repair with agents after a second refusal ([#199](https://github.com/flosrn/ax/issues/199)) ([c1e44fa](https://github.com/flosrn/ax/commit/c1e44fa4ae9fccfd528c4f113d81cbbb6d5b4da2))
* **peer:** a custom Pass keeps its Draft identity ([#207](https://github.com/flosrn/ax/issues/207)) ([#211](https://github.com/flosrn/ax/issues/211)) ([46d08d7](https://github.com/flosrn/ax/commit/46d08d7364e1f2c8bc1e386c2b305151df966fba))
* **peer:** bound the Report's input before decoding it ([#183](https://github.com/flosrn/ax/issues/183)) ([792da16](https://github.com/flosrn/ax/commit/792da163c6a45f31e5ad2588d04010af82edbc00)), closes [#180](https://github.com/flosrn/ax/issues/180)
* **peer:** retrieve a remote worker's Report from the host its record names ([#198](https://github.com/flosrn/ax/issues/198)) ([3fcd85e](https://github.com/flosrn/ax/commit/3fcd85ec9b61c83876d6346f5cd302165c54bdb8))
* **pin:** --dry-run withholds the init write, and the header says a flag here is parsed by the version being left ([9ade53c](https://github.com/flosrn/ax/commit/9ade53cdf1340cbecc25f1bc115b59467cfd64ec)), closes [#170](https://github.com/flosrn/ax/issues/170)
* **pin,init:** a refused pin names the findings' own repair, and --init lands managed state a release adds ([b622119](https://github.com/flosrn/ax/commit/b622119850d2550b7275ef0b84e091392c1ea827)), closes [#170](https://github.com/flosrn/ax/issues/170) [#171](https://github.com/flosrn/ax/issues/171)
* **pr-gate:** bind every git-backed ground to the validated head and the observed base ([#187](https://github.com/flosrn/ax/issues/187)) ([a18c98d](https://github.com/flosrn/ax/commit/a18c98d7af5cbbad0d52a2e17a9a6fa579a4bf11))
* **pr-gate:** read every check-run page before authorizing merge ([#186](https://github.com/flosrn/ax/issues/186)) ([7fc1417](https://github.com/flosrn/ax/commit/7fc1417c8040034d979b8a620d32d00a3f82ed03))
* **pr-gate:** refuse a review-thread read with no observed final page ([#181](https://github.com/flosrn/ax/issues/181)) ([d4421a9](https://github.com/flosrn/ax/commit/d4421a95fae4ad17e8cdd4350cea6cc74d0b9f35))
* **triage:** admit a finding that names the approved obligation it serves ([#197](https://github.com/flosrn/ax/issues/197)) ([da13f0b](https://github.com/flosrn/ax/commit/da13f0be47916f8074bfcda15a9bc0722f276f4b))
* **triage:** prove each job and Pass by its own published artifact ([#184](https://github.com/flosrn/ax/issues/184)) ([06cdb6e](https://github.com/flosrn/ax/commit/06cdb6ea991a6ae596840135c0e400ecd4c5936f))
* **triage:** publish grades provenance on the proposed result, from one class vocabulary ([#182](https://github.com/flosrn/ax/issues/182)) ([e7c2552](https://github.com/flosrn/ax/commit/e7c2552c922d43f7d930bc5cdcc1fdafbf09591c)), closes [#179](https://github.com/flosrn/ax/issues/179)
* **worker:** a record that created no task blocks no recovery ([#205](https://github.com/flosrn/ax/issues/205)) ([#209](https://github.com/flosrn/ax/issues/209)) ([9c21d49](https://github.com/flosrn/ax/commit/9c21d49f94af0d6866d75120cb3a676f6f926a23))
* **worker:** never authorize re-dispatch from unknown liveness ([#200](https://github.com/flosrn/ax/issues/200)) ([6e24537](https://github.com/flosrn/ax/commit/6e245378f35c977e11a18ff126626ff6c2532123))
* **worker:** resolve session proof by the checkout the caller holds ([#204](https://github.com/flosrn/ax/issues/204)) ([#208](https://github.com/flosrn/ax/issues/208)) ([08377a4](https://github.com/flosrn/ax/commit/08377a4f5a93008b7ad0092543a6fdb9e889cf31))

## [0.23.0](https://github.com/flosrn/ax/compare/v0.22.0...v0.23.0) (2026-09-05)


### Features

* **dispatch:** a --on dispatch reuses the worktree the host reports ([#154](https://github.com/flosrn/ax/issues/154)) ([a133598](https://github.com/flosrn/ax/commit/a133598465497f9a1a58e3e981f6f6991f52717c))
* **worker:** settle --repo backfills a record that names no repository ([#155](https://github.com/flosrn/ax/issues/155)) ([0ef6240](https://github.com/flosrn/ax/commit/0ef6240be34018371f3e4274e569fd0812926ca9))


### Bug Fixes

* **peer:** a witnessed local worker_done carries its Report, keyed on the record's own pane ([57c431d](https://github.com/flosrn/ax/commit/57c431de97ba88ff513eb7a777c8a47bb91fcc31)), closes [#168](https://github.com/flosrn/ax/issues/168)
* **worker:** --replace takes the claim lock before its own ([#153](https://github.com/flosrn/ax/issues/153)) ([dfda7a3](https://github.com/flosrn/ax/commit/dfda7a36396367fb4fa4afbb0ca88f915eb2f02e)), closes [#148](https://github.com/flosrn/ax/issues/148)
* **worker:** a --replace inherits the recorded placement or refuses ([#166](https://github.com/flosrn/ax/issues/166)) ([65d0a21](https://github.com/flosrn/ax/commit/65d0a21e4708d81b30003c4783ca756533e15605))
* **worker:** a live terminal is capacity in ls, whichever phase recorded it ([a77e40b](https://github.com/flosrn/ax/commit/a77e40b2c1dc3aa09ab0e43dd273a9e0600006de)), closes [#152](https://github.com/flosrn/ax/issues/152)
* **worker:** a release KEEP names its repair, and a dirty tree says which kind ([#157](https://github.com/flosrn/ax/issues/157)) ([ac064de](https://github.com/flosrn/ax/commit/ac064de120d77a1bec90c470d021b3177449e92d))
* **worker:** an unaskable leaked pane is an inability, and the note stops contradicting the count ([a65d11d](https://github.com/flosrn/ax/commit/a65d11d2175110bc76374eecde6526ed5442e979))
* **worker:** capacity counts recorded panes through one reader, not the dispatch index ([#163](https://github.com/flosrn/ax/issues/163)) ([#167](https://github.com/flosrn/ax/issues/167)) ([c1fd8c4](https://github.com/flosrn/ax/commit/c1fd8c4c5cf66c7a35c3d8795f71ccc9b547cc87))
* **worker:** ls and tail name the verb that continues a gone pane's record ([#169](https://github.com/flosrn/ax/issues/169)) ([0c94893](https://github.com/flosrn/ax/commit/0c94893d8b87e761f63f0b72eafd33ac4c9ae161))
* **worker:** settle judges a pane from the host its record names; a named gone pane says what survives it ([f38edc8](https://github.com/flosrn/ax/commit/f38edc8f021207512d983ebdba06784f9fb3449d)), closes [#160](https://github.com/flosrn/ax/issues/160)
* **worker:** the stall watcher's alert arrives as a message, not as its rejection ([#159](https://github.com/flosrn/ax/issues/159)) ([a2bd478](https://github.com/flosrn/ax/commit/a2bd47815477ba8913d6ce6fbe465c6771c2f22c))
* **worker:** the worktree-scoped advisor ax writes is named ax, not pilot ([b1b2b06](https://github.com/flosrn/ax/commit/b1b2b0656cd8fec28815406afd900a2d615939bd))

## [0.22.0](https://github.com/flosrn/ax/compare/v0.21.1...v0.22.0) (2026-09-04)


### Features

* **peer:** deliver the Report with a worker's completion ([#142](https://github.com/flosrn/ax/issues/142)) ([d5b6c90](https://github.com/flosrn/ax/commit/d5b6c909bf000f1f2dd8f9f21e27ea1622c476ff))
* **worker:** derive the Report path from the dispatch record ([#138](https://github.com/flosrn/ax/issues/138)) ([c1fbafc](https://github.com/flosrn/ax/commit/c1fbafca2ceb1db87692fbcc1dd84f17ccd62288))
* **worker:** the brief names the Report's path and what worker_done carries ([#141](https://github.com/flosrn/ax/issues/141)) ([087c3be](https://github.com/flosrn/ax/commit/087c3bee7bbe1ca82429cefcb5610209bd19bf0b))


### Bug Fixes

* **dispatch:** a --name dispatch gets the untracked mechanics, not "keep the ticket current" ([6b8b89a](https://github.com/flosrn/ax/commit/6b8b89a5aac55dc209a1cc1a499a36c6861d9d9a)), closes [#144](https://github.com/flosrn/ax/issues/144)

## [0.21.1](https://github.com/flosrn/ax/compare/v0.21.0...v0.21.1) (2026-09-03)


### Bug Fixes

* **worker:** a worker-start that recorded no argv is an unreadable phase, never a local one ([#131](https://github.com/flosrn/ax/issues/131)) ([d9854dc](https://github.com/flosrn/ax/commit/d9854dc520da9a6f794ece5b56429804063ddba2))

## [0.21.0](https://github.com/flosrn/ax/compare/v0.20.0...v0.21.0) (2026-09-03)


### ⚠ BREAKING CHANGES

* **dispatch:** `ORCA_TRIAGE_SESSION_CAP` and `ORCA_READY_SESSION_CAP` are no longer read. Both are refused by name, with the repair naming `dispatch.machineCap` in ax.config.json. A checkout that relied on the old implicit machine-wide 3 loses it: the per-repository `dispatch.cap` default of 3 takes over, and the machine ceiling is unset until it is declared.

### Bug Fixes

* **dispatch:** cap panes per repository, with an opt-in machine ceiling ([#129](https://github.com/flosrn/ax/issues/129)) ([6a4e128](https://github.com/flosrn/ax/commit/6a4e12876860c06d4c006ec02a6eac64cd8e092f))
* **dispatch:** reuse the worktree a subject already has, wherever ax placed it ([#122](https://github.com/flosrn/ax/issues/122)) ([f3fdb9c](https://github.com/flosrn/ax/commit/f3fdb9ce594c36166148a79f314524a81bf6d644))
* **pr-gate:** a clean merge from the base is movement, not a commit to acknowledge ([#119](https://github.com/flosrn/ax/issues/119)) ([33e616e](https://github.com/flosrn/ax/commit/33e616e7209f87bd25227a2f3aa90d5edd711acd))
* **pr-gate:** a release PR is a recognized shape, not a PR whose ticket is missing ([#127](https://github.com/flosrn/ax/issues/127)) ([ddb0fe7](https://github.com/flosrn/ax/commit/ddb0fe7086e6d62150e5db1564db838683b41180))
* **triage:** size the role window to a measurement, and make its verdict re-derivable ([#124](https://github.com/flosrn/ax/issues/124)) ([20cbc56](https://github.com/flosrn/ax/commit/20cbc56df74d8dc997298c2104b4cc94d332e669))
* **worker:** a dispatch record names the checkout that dispatched it, whatever the tracker ([#123](https://github.com/flosrn/ax/issues/123)) ([08d0ef5](https://github.com/flosrn/ax/commit/08d0ef5157926b11d0549877c4e5c7f392c4a1a1))
* **worker:** a request names its pass through the record's dispatch id, never the prose the child was handed ([#128](https://github.com/flosrn/ax/issues/128)) ([4936899](https://github.com/flosrn/ax/commit/4936899d2c921c48767cb2ee88dc318e0044bd5e))
* **worker:** release places a row by the repository its record names ([#83](https://github.com/flosrn/ax/issues/83)) ([#118](https://github.com/flosrn/ax/issues/118)) ([518a36b](https://github.com/flosrn/ax/commit/518a36b990b8f5130e6c0ceccd0e8f262cfbbd8f))

## [0.20.0](https://github.com/flosrn/ax/compare/v0.19.0...v0.20.0) (2026-09-03)


### Features

* **omp:** the worker's report opens on its CRITERIA, and the merge decision reads them first ([#113](https://github.com/flosrn/ax/issues/113)) ([fa5e2d4](https://github.com/flosrn/ax/commit/fa5e2d4bf4b99b434dd66978e76fbfbfb567e5a5))
* **worker:** ax worker settle writes the ending the gate can prove ([#112](https://github.com/flosrn/ax/issues/112)) ([effe105](https://github.com/flosrn/ax/commit/effe1055f5bc85ac257934c81256c07bbf333e76))


### Bug Fixes

* **cli:** --help is a read anywhere in a command's own argv ([#115](https://github.com/flosrn/ax/issues/115)) ([777cc7f](https://github.com/flosrn/ax/commit/777cc7f006bb2aac72e8c41c567e6a6bf3366724))
* **pr-gate:** read every channel a merge closes issues from, not the body alone ([#114](https://github.com/flosrn/ax/issues/114)) ([056b556](https://github.com/flosrn/ax/commit/056b556be5cbe4229c261d9c6724a56c11a58889))
* **schema:** refuse patternProperties instead of admitting it unimplemented ([#110](https://github.com/flosrn/ax/issues/110)) ([6c723be](https://github.com/flosrn/ax/commit/6c723be69c8fd63d2e795d1dcbb930c288320f15))
* the project plan decides managed blocks per file, not per checkout ([#117](https://github.com/flosrn/ax/issues/117)) ([7962007](https://github.com/flosrn/ax/commit/79620075136e70665cce916402c6c148e3e979e6))
* **worker:** dispatch refuses a closed ticket and a foreign record before any mutation; the claim winner mints under the lock ([#95](https://github.com/flosrn/ax/issues/95)) ([#116](https://github.com/flosrn/ax/issues/116)) ([bcc30a1](https://github.com/flosrn/ax/commit/bcc30a13a2dd0bb40916454e2802536ab21ce444))

## [0.19.0](https://github.com/flosrn/ax/compare/v0.18.0...v0.19.0) (2026-09-03)


### Features

* **triage:** a findings provenance class refuses a pass over what your own agents filed ([#105](https://github.com/flosrn/ax/issues/105)) ([eda90a2](https://github.com/flosrn/ax/commit/eda90a2016848827dadf07ffd669c36db89f2564))


### Bug Fixes

* four maintainer repairs — retired flags, ignore scope, redundant labels, release_unknown reason ([#106](https://github.com/flosrn/ax/issues/106)) ([f17f85c](https://github.com/flosrn/ax/commit/f17f85caf636b6d911eed53f4c0ebc888fef150c))
* **worker:** the stall watcher obeys Orca's lifecycle refusal instead of retrying it ([#108](https://github.com/flosrn/ax/issues/108)) ([87f6e3c](https://github.com/flosrn/ax/commit/87f6e3cc1da30b3bb3cf6132c2c5dd86aa2e4d4a))

## [0.18.0](https://github.com/flosrn/ax/compare/v0.17.0...v0.18.0) (2026-09-02)


### Features

* answer --help as a read on every verb, from the registry ([#87](https://github.com/flosrn/ax/issues/87)) ([f66a666](https://github.com/flosrn/ax/commit/f66a6663049f936879aba55c31e9c070561e92f6)), closes [#71](https://github.com/flosrn/ax/issues/71)
* **cli:** name where the running ax came from in --version ([#81](https://github.com/flosrn/ax/issues/81)) ([51e9b6d](https://github.com/flosrn/ax/commit/51e9b6da8d77f5e1d11aec76e5318448b6470a14))
* **plan:** the project plan knows a self-hosted checkout and partial adoption ([#85](https://github.com/flosrn/ax/issues/85)) ([0ae8593](https://github.com/flosrn/ax/commit/0ae85935771f0d190b869962eabd962c2ffdad78))
* **pr gate:** bind closure verification to the dispatched ticket ([#77](https://github.com/flosrn/ax/issues/77)) ([bcf24b1](https://github.com/flosrn/ax/commit/bcf24b130856112dbc9431739b7cb6e557fb5585))
* **worker:** ls answers capacity first, archaeology behind --all ([#82](https://github.com/flosrn/ax/issues/82)) ([a59d75d](https://github.com/flosrn/ax/commit/a59d75d7388b76a688469c151a1fc3f9ceffa088))
* **worker:** ls asks the declared hosts instead of reporting them omitted ([#91](https://github.com/flosrn/ax/issues/91)) ([16700d8](https://github.com/flosrn/ax/commit/16700d8cb010a3198d8ad1166fdc5de15aee99d2))


### Bug Fixes

* **config:** drop the $comment the dispatch section does not admit ([28f1018](https://github.com/flosrn/ax/commit/28f1018b58a556392e59944ec18aca7790f52f40))
* **schema:** admit a reserved annotation on any object, and refuse with the shape ([#79](https://github.com/flosrn/ax/issues/79)) ([dd223b5](https://github.com/flosrn/ax/commit/dd223b5b42c773d7b33c565ea8073b9ec35ed8be)), closes [#73](https://github.com/flosrn/ax/issues/73)

## [0.17.0](https://github.com/flosrn/ax/compare/v0.16.0...v0.17.0) (2026-09-01)


### Features

* autonomous frontier orchestration for the implementation lane ([#65](https://github.com/flosrn/ax/issues/65)) ([4ff4a77](https://github.com/flosrn/ax/commit/4ff4a775ad41a98b4ffe47a1db28933b483ea191))

## [0.16.0](https://github.com/flosrn/ax/compare/v0.15.3...v0.16.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* `ax ready <verb>` is now `ax triage <verb>`; the `ax.config.json` key `ready.{labels,provenance}` is now `triage.{…}`; the environment knobs `ORCA_READY_SESSION_CAP` and `AX_READY_ROLE_WAIT` are now `ORCA_TRIAGE_SESSION_CAP` and `AX_TRIAGE_ROLE_WAIT`; `ax triage status --brief` is now `--oneline`; and the exported entry `ready()` is now `triage()` (`readyRelease` -> `triageRelease`, `launchProof` -> `dispatchProof`). A consuming repo renames one config key and moves its exports; every retired name refuses with the replacement named rather than falling back silently.
* `ax worker launch` no longer runs; use `ax worker dispatch`. The `ax.config.json` key `launch.{entry,contract,hosts,databaseLabels,worktreeTool}` is now `dispatch.{...}`, `--brief <file>` on that verb is `--notes <file>`, and `AX_LAUNCH_{TICK,SEE_WAIT,EQUIP_WAIT,SPEC_DIR}` are `AX_DISPATCH_{...}`.

### Features

* ax --help groups commands by domain section, and the docs speak the glossary ([#54](https://github.com/flosrn/ax/issues/54)) ([2318e57](https://github.com/flosrn/ax/commit/2318e572cee2af2882093987beedd9d4589c697d)), closes [#45](https://github.com/flosrn/ax/issues/45)
* ax triage is the on-ramp noun ([#52](https://github.com/flosrn/ax/issues/52)) ([3835cc0](https://github.com/flosrn/ax/commit/3835cc09d333655b08eb9320023d5ebc41a31c45))
* **omp:** one operator role — delete readiness, absorb the triage lane ([#48](https://github.com/flosrn/ax/issues/48)) ([35fa806](https://github.com/flosrn/ax/commit/35fa8065fdba6408fb33e5926574d9eb042e837d))
* the code speaks the glossary — comments say orchestrator, never coordinator ([#55](https://github.com/flosrn/ax/issues/55)) ([6f6005e](https://github.com/flosrn/ax/commit/6f6005e9f4789555983ce9b2740afa7cf5354662)), closes [#46](https://github.com/flosrn/ax/issues/46)
* worker dispatch is the one implementation creation verb ([#51](https://github.com/flosrn/ax/issues/51)) ([f52475a](https://github.com/flosrn/ax/commit/f52475a13ef95431fd4b32f94ec7a217e006317e)), closes [#42](https://github.com/flosrn/ax/issues/42)
* worker start is plumbing, not an agent-facing verb ([#53](https://github.com/flosrn/ax/issues/53)) ([5b1d891](https://github.com/flosrn/ax/commit/5b1d89129f37e102c9584ec03ad5687864220f9b)), closes [#44](https://github.com/flosrn/ax/issues/44)


### Bug Fixes

* **worker:** --dispatch-proof is the flag; the retired spelling survives one release ([#64](https://github.com/flosrn/ax/issues/64)) ([feb21b7](https://github.com/flosrn/ax/commit/feb21b78ebff958a24bae78594d1ace690a1cab6))
* **worktree:** the context file teaches the workflow-scope push escape ([#61](https://github.com/flosrn/ax/issues/61)) ([09df78b](https://github.com/flosrn/ax/commit/09df78b8479f9c1705b99b6d7a6e79116c64a979))

## [0.15.3](https://github.com/flosrn/ax/compare/v0.15.2...v0.15.3) (2026-08-31)


### Bug Fixes

* **peer:** a parent running several panes resolves through the dispatch record ([478e443](https://github.com/flosrn/ax/commit/478e443a8c0583d31d04577087d56436a50d5a07))
* **ready:** the ask body names its own reply route ([5ef6808](https://github.com/flosrn/ax/commit/5ef6808859e10fd556486ed043d0212b65109e23))

## [0.15.2](https://github.com/flosrn/ax/compare/v0.15.1...v0.15.2) (2026-08-30)


### Bug Fixes

* **worker:** the contract ax owns names the dispatching session, not a deleted role ([983636f](https://github.com/flosrn/ax/commit/983636fb8cae567c50adbd02968bbcdf59251d5d))

## [0.15.1](https://github.com/flosrn/ax/compare/v0.15.0...v0.15.1) (2026-08-30)


### Bug Fixes

* **roles:** a spec-born ticket carries its assignment in the body, not in a Brief comment ([b3aaab4](https://github.com/flosrn/ax/commit/b3aaab4e06dd7112cfdb473a4ba501a5be44d6ef))

## [0.15.0](https://github.com/flosrn/ax/compare/v0.14.6...v0.15.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* `--job refine` is removed from `ax ready dispatch|ask|answer|publish|status|release`, and the `refine-worker` session role no longer exists. A project whose tickets were waiting on a refine pass publishes them from its spec flow instead: `to-tickets` applies `ready-for-agent` at publish time. `ready.provenance` keeps its meaning and gains teeth — a spec label now means "this work needs no pass", and a triage dispatch over it is refused.
* `ax triage <verb>` is now `ax ready <verb>`; the `ax.config.json` key `triage.{labels,provenance}` is now `ready.{...}`; the session role `coordinator` is now `readiness` (`/role readiness`); the exported entry `triage()` is now `ready()` (`triageRelease` -> `readyRelease`, `verifyTriageRole` -> `verifyPassRole`); and the environment knobs `ORCA_TRIAGE_SESSION_CAP` and `AX_TRIAGE_ROLE_WAIT` are now `ORCA_READY_SESSION_CAP` and `AX_READY_ROLE_WAIT`. A consuming repo edits `ax.config.json` and moves its pin in the same commit: each ax version refuses the other's config, so a split commit leaves the repo unable to run either. `ax doctor` and `ax init` both name the rename when they meet the old key, and the two env knobs refuse by name rather than falling back to a default.

### Features

* drop the refine lane — a ticket the spec flow published is already agent-ready ([728541e](https://github.com/flosrn/ax/commit/728541e4af1cdd20e15bc75115b6215b420cc2fa))
* rename the readiness umbrella from `ax triage` to `ax ready`, and gate a pass on its ticket's provenance ([2b9cb5d](https://github.com/flosrn/ax/commit/2b9cb5d1b717dc6ead9b2c32137b45008925b7c7))

## [0.14.6](https://github.com/flosrn/ax/compare/v0.14.5...v0.14.6) (2026-08-29)


### Bug Fixes

* **triage:** refuse publishing a second verdict on one issue ([#33](https://github.com/flosrn/ax/issues/33)) ([cfcc774](https://github.com/flosrn/ax/commit/cfcc774723faf2b6b1b4c933a9f8bda8f5796dbf))

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
