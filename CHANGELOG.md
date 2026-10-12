# [0.6.0](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.5.0...v0.6.0) (2026-10-12)


### Bug Fixes

* **agents:** scope an agent template's model key to its harness family ([f5fed47](https://github.com/electric-dragon-80000v/pi-cowboy/commit/f5fed477fdfcc8f3654c01b158823f174ae2e551))
* **models:** offer each picker only its own harness's models ([6999092](https://github.com/electric-dragon-80000v/pi-cowboy/commit/6999092a6f344f343a1194568a61180f87b29828))
* **models:** resolve a spawn's model against the launching harness ([bc91d66](https://github.com/electric-dragon-80000v/pi-cowboy/commit/bc91d66de4d28607e19edf4ea0a074ac2f5379da))
* **ui:** stop claiming an unset model inherits the parent ([356dcca](https://github.com/electric-dragon-80000v/pi-cowboy/commit/356dcca395d6c506af5e184b04fdc60b4686b66d))


### Features

* **agents:** accept a per-item harness_type on cowboy_agent ([d6203ea](https://github.com/electric-dragon-80000v/pi-cowboy/commit/d6203ead11b4c45020e5c16c7625b8f36b1d521e))
* **concurrency:** scope pools by harness and add the harness level ([6d08211](https://github.com/electric-dragon-80000v/pi-cowboy/commit/6d08211008fecfcd75a90e7f7a573f0bdb1fae7d))
* **harness:** detect opencode without launching it ([434feec](https://github.com/electric-dragon-80000v/pi-cowboy/commit/434feecd83bd8f1feb0e78ee059a3e6b9630ac5a))
* **harness:** key the launch request by family and stage opencode's variant ([7ca7fb4](https://github.com/electric-dragon-80000v/pi-cowboy/commit/7ca7fb471ff71b34bce6c8e45ce0923cb7b6f04a))
* **harness:** launch opencode from its staged definition ([ddaa8e2](https://github.com/electric-dragon-80000v/pi-cowboy/commit/ddaa8e21d49ce9691fd17952e5a203fa9e214204))
* **harness:** own each harness's model list and default model ([3304732](https://github.com/electric-dragon-80000v/pi-cowboy/commit/330473218803b8842ee9ac8391f78ee7f33e4463))
* **harness:** prefetch opencode models at boot ([8673583](https://github.com/electric-dragon-80000v/pi-cowboy/commit/867358395d7e39d0869677e86eccf9fee5eaf68e))
* **harness:** stage the opencode config directory ([f8d5755](https://github.com/electric-dragon-80000v/pi-cowboy/commit/f8d5755e45279d78dd306c9edec6a256de816d22))

# [0.5.0](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.4.1...v0.5.0) (2026-10-10)


### Features

* **git:** require a git repository for extension activation ([b78875d](https://github.com/electric-dragon-80000v/pi-cowboy/commit/b78875dd0f29bb4855c235a88c5e9e85d56fab82))

## [0.4.1](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.4.0...v0.4.1) (2026-10-10)


### Bug Fixes

* **ci:** remove invalid asset checks from test workflow ([11e16e7](https://github.com/electric-dragon-80000v/pi-cowboy/commit/11e16e7dea65de99167c84d45cfdf1e216827a43))

# [0.4.0](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.7...v0.4.0) (2026-10-10)


### Features

* **protocol:** include settled headline in blocking agent results ([bafd1b0](https://github.com/electric-dragon-80000v/pi-cowboy/commit/bafd1b0601e5ca153995583229de8b98759d2014))
* **subagent:** replace IPC with file deliverable and clean paths ([329a3d3](https://github.com/electric-dragon-80000v/pi-cowboy/commit/329a3d3909efb3eeda0de90650a9d36ca7e26591))

## [0.3.7](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.6...v0.3.7) (2026-10-08)


### Bug Fixes

* trigger release ([42b3202](https://github.com/electric-dragon-80000v/pi-cowboy/commit/42b32021294763cd39bf8641788e483d8c175273))

## [0.3.6](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.5...v0.3.6) (2026-10-08)


### Bug Fixes

* **logger:** remove unused logger method parameter from write function ([73e69f4](https://github.com/electric-dragon-80000v/pi-cowboy/commit/73e69f45fba0cb0962de1d42fec322230130bf1a))

## [0.3.5](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.4...v0.3.5) (2026-10-07)


### Bug Fixes

* **ci:** use release token for checkout so git push bypasses ruleset ([af82828](https://github.com/electric-dragon-80000v/pi-cowboy/commit/af82828f595b8925ab39ca93e4cef95b812c3894))

## [0.3.4](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.3...v0.3.4) (2026-10-07)


### Bug Fixes

* **ci:** update test workflow asset path ([2d39932](https://github.com/electric-dragon-80000v/pi-cowboy/commit/2d39932fa63f19fd967b00311a476cf12b0e2b7a))
* **ci:** use release token for publishing ([72c0254](https://github.com/electric-dragon-80000v/pi-cowboy/commit/72c025406dbae14adbcaa77960044fbe2fd250ae))

## [0.3.3](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.2...v0.3.3) (2026-10-07)


### Bug Fixes

* **deps:** update brace-expansion to 5.0.12 ([c4314b6](https://github.com/electric-dragon-80000v/pi-cowboy/commit/c4314b6ccf4bd5b6172283b8016bc89826e70e74))

## [0.3.2](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.1...v0.3.2) (2026-10-07)


### Bug Fixes

* switch host packages to static imports and add linter rule ([72bdbd5](https://github.com/electric-dragon-80000v/pi-cowboy/commit/72bdbd53046d8fd254a0dedeb5e39a0f8527d2a1))

## [0.3.1](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.3.0...v0.3.1) (2026-10-07)


### Bug Fixes

* **deps:** move typebox from dependencies to peer dependencies ([9926259](https://github.com/electric-dragon-80000v/pi-cowboy/commit/9926259602a352902b6f1e96764e26f1e0c3136b))

# [0.3.0](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.2.0...v0.3.0) (2026-10-07)


### Features

* **command:** add /cowboy worktree subcommand for standalone worktrees ([11561b0](https://github.com/electric-dragon-80000v/pi-cowboy/commit/11561b07d1ce4e2cf87b44911d0ae1a3dd07bda1))

# [0.2.0](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.1.0...v0.2.0) (2026-10-06)


### Features

* **git:** apply parent tracked changes to checkout worktrees when dirty ([ce2755d](https://github.com/electric-dragon-80000v/pi-cowboy/commit/ce2755d8d69235d2856f225486611dbdf3cf7941))

# [0.2.0](https://github.com/electric-dragon-80000v/pi-cowboy/compare/v0.1.0...v0.2.0) (2026-10-06)


### Features

* **git:** apply parent tracked changes to checkout worktrees when dirty ([ce2755d](https://github.com/electric-dragon-80000v/pi-cowboy/commit/ce2755d8d69235d2856f225486611dbdf3cf7941))
