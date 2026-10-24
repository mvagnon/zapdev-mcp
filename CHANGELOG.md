# Changelog

## [2.4.0](https://github.com/mvagnon/zapdev-mcp/compare/v2.3.0...v2.4.0) (2026-10-24)


### Features

* **commit-workflow:** Introduce push option for zapdev commit; update tests and docs to support pushing after commit. ([0888b39](https://github.com/mvagnon/zapdev-mcp/commit/0888b397ba670fb4b559be5db75fdc29535d3786))
* **servers:** Add list_services tool to list configured services for a prepared checkout or group. ([bfff185](https://github.com/mvagnon/zapdev-mcp/commit/bfff1856d86a2a7ce86795bc8b4f55fd01cb2712))

## [2.3.0](https://github.com/mvagnon/zapdev-mcp/compare/v2.2.4...v2.3.0) (2026-10-23)


### Features

* **commit:** Add optional --pull flag to zapdev commit to pull before committing ([26976b0](https://github.com/mvagnon/zapdev-mcp/commit/26976b0bc3be7f78e3c5fc65ebadb4a954c36f90))


### Bug Fixes

* **documentation:** Clarify explicit invocation requirements and E2E context in tool and server descriptions. ([efe1ab3](https://github.com/mvagnon/zapdev-mcp/commit/efe1ab3a4ced908a11ab2ef91838a52c849358b3))

## [2.2.4](https://github.com/mvagnon/zapdev-mcp/compare/v2.2.3...v2.2.4) (2026-10-22)


### Bug Fixes

* Verify complete shutdown and unit release; clear old failed state and expose cleanup/verification failures as errors. ([0fad9df](https://github.com/mvagnon/zapdev-mcp/commit/0fad9df78545db63228aa5441832c8ee0e4c804d))

## [2.2.3](https://github.com/mvagnon/zapdev-mcp/compare/v2.2.2...v2.2.3) (2026-10-22)


### Bug Fixes

* **config:** Prefer group config for prepareCommand when present; fall back to checkout config otherwise. ([145ed39](https://github.com/mvagnon/zapdev-mcp/commit/145ed39bba731ff09351d9258272887528a3d2cd))

## [2.2.2](https://github.com/mvagnon/zapdev-mcp/compare/v2.2.1...v2.2.2) (2026-10-22)


### Bug Fixes

* **checkout-names:** switch checkout naming from owner$repo to owner__repo ([e555022](https://github.com/mvagnon/zapdev-mcp/commit/e5550225d038839e0940b3d1502154b89731fbbd))

## [2.2.1](https://github.com/mvagnon/zapdev-mcp/compare/v2.2.0...v2.2.1) (2026-10-22)


### Bug Fixes

* Require repo for prepare_repo and simplify preparation flow. ([442603d](https://github.com/mvagnon/zapdev-mcp/commit/442603da18bfc4aa7fdbc14de36617b8d8aee3ef))
* **service-manager:** Improve error handling for service status checks and preserve failures. ([ed438c2](https://github.com/mvagnon/zapdev-mcp/commit/ed438c25706525f55d188054dc8141f91e4f5bab))

## [2.2.0](https://github.com/mvagnon/zapdev-mcp/compare/v2.1.1...v2.2.0) (2026-10-22)


### Features

* **server_logs:** Read timestamped logs from the latest invocation of the user unit. ([6d450a7](https://github.com/mvagnon/zapdev-mcp/commit/6d450a7847c6fae411b3a545d3d7235a8ae8ab52))

## [2.1.1](https://github.com/mvagnon/zapdev-mcp/compare/v2.1.0...v2.1.1) (2026-10-22)


### Bug Fixes

* **server_logs:** Use scoped journal logs for server diagnostics and simplify stop/start flow. ([621dc2a](https://github.com/mvagnon/zapdev-mcp/commit/621dc2a764835073c9f6421f7a97388808def699))

## [2.1.0](https://github.com/mvagnon/zapdev-mcp/compare/v2.0.1...v2.1.0) (2026-10-22)


### Features

* **preparation:** Refine grouped preparation: link group-root secrets prior to checkout command and clarify behavior. ([9413f38](https://github.com/mvagnon/zapdev-mcp/commit/9413f38bc557607cc860a917578d37f57a6f9990))


### Bug Fixes

* Clarify tool descriptions and input schemas across index.ts, repositories.ts, and servers.ts with simplified text and no breaking changes. ([1bd0a09](https://github.com/mvagnon/zapdev-mcp/commit/1bd0a0924fc429b94d6191fd49d2e75b3346a9a2))
* **logs:** Read logs from the user journal for named services and expose status ([26ba3b5](https://github.com/mvagnon/zapdev-mcp/commit/26ba3b5429bfaa8373a604e94349ce1f454822b6))
* **repositories:** Introduce repositorySelectionSchema and switch commands to path-based selection for repo/group, allowing empty values and requiring at least one nonempty target ([aa9a45c](https://github.com/mvagnon/zapdev-mcp/commit/aa9a45cacb8d73c45a9599771489415305eb02ae))

## [2.0.1](https://github.com/mvagnon/zapdev-mcp/compare/v2.0.0...v2.0.1) (2026-10-22)


### Bug Fixes

* **preparation:** Introduce preparation module and integrate selection-based repository/group preparation flow ([5b8a171](https://github.com/mvagnon/zapdev-mcp/commit/5b8a171d4997a95bb977ce5dd6238df3d0ae9f96))

## [2.0.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.6.0...v2.0.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **named-services:** Add named service lifecycle and log retrieval tooling for MCP servers

### Features

* **named-services:** Add named service lifecycle and log retrieval tooling for MCP servers ([5e71ef0](https://github.com/mvagnon/zapdev-mcp/commit/5e71ef0247dc8e4e4398cef827911bf591f05b2b))


### Bug Fixes

* **commit:** Always uses --yes --pull --no-push; adds --branch when supplied, otherwise uses the current branch. ([a70f859](https://github.com/mvagnon/zapdev-mcp/commit/a70f85911d6e7bdf598dd11d60170254cc37d6c3))
* Switch to using ExecStopPost and KillSignal=SIGINT for controlled stop. ([1b30dc7](https://github.com/mvagnon/zapdev-mcp/commit/1b30dc72514eb8ee739d0e8abc8e3fa499aeca34))

## [1.6.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.5.1...v1.6.0) (2026-10-22)


### Features

* **server:** Switch startCommand to an array and improve server startup handling. ([14dc1b4](https://github.com/mvagnon/zapdev-mcp/commit/14dc1b487f9fcc40ea31172e4fd56cfb8c027c14))

## [1.5.1](https://github.com/mvagnon/zapdev-mcp/compare/v1.5.0...v1.5.1) (2026-10-22)


### Bug Fixes

* **index.ts:** Link secrets directly by removing temporary directory usage in helper ([8b06280](https://github.com/mvagnon/zapdev-mcp/commit/8b0628045da87ebbf587fa2fad12396e0b02dbcc))

## [1.5.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.4.0...v1.5.0) (2026-10-22)


### Features

* **config:** Run optional prepareCommand after linking secrets, preferring group config, with 180s timeout. ([5adf5bd](https://github.com/mvagnon/zapdev-mcp/commit/5adf5bd32d6009a188a06dcca8f3d49719a9be1e))

## [1.4.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.3.0...v1.4.0) (2026-10-22)


### Features

* **repos:** Add repositories and servers modules to prepare repos and manage start/stop server tooling. ([e943ed7](https://github.com/mvagnon/zapdev-mcp/commit/e943ed702e0ade54c7c1ec26a76b600c52bdbd94))

## [1.3.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.2.1...v1.3.0) (2026-10-22)


### Features

* **secrets:** Link matching files from ~/.zapdev/secrets into the group root after refresh. ([950efa3](https://github.com/mvagnon/zapdev-mcp/commit/950efa3f673605a509cf03b260cab4932b454af0))

## [1.2.1](https://github.com/mvagnon/zapdev-mcp/compare/v1.2.0...v1.2.1) (2026-10-22)


### Bug Fixes

* **get_repo:** Checkout GitHub repos into an optional group directory using owner-repo naming. ([dabaaca](https://github.com/mvagnon/zapdev-mcp/commit/dabaaca3ad03e2f13de2f3df70653b43f24d6385))

## [1.2.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.1.0...v1.2.0) (2026-10-21)


### Features

* **get_repo:** support ZD_REPOS_DIR override for checkout root ([39f7b37](https://github.com/mvagnon/zapdev-mcp/commit/39f7b3714a4fc78f8956e91d4e54fa7a8cac4e26))

## [1.1.0](https://github.com/mvagnon/zapdev-mcp/compare/v1.0.0...v1.1.0) (2026-10-21)


### Features

* Added CI and release workflows, .gitignore, manifest, README, and TypeScript files. ([01a9c03](https://github.com/mvagnon/zapdev-mcp/commit/01a9c03fc1997d6e2bfb7de8dadbfa815a6ff09c))


### Bug Fixes

* Adds test for commit tool and updates index.ts to include new command with --branch support ([84b2bfa](https://github.com/mvagnon/zapdev-mcp/commit/84b2bfad1c440547faea57e1ce6962178d56cad3))
* Changed server name and package name to 'zapdev-mcp' ([36b5c13](https://github.com/mvagnon/zapdev-mcp/commit/36b5c1337b23e2b1b8ceb234965ebf64de20f576))
* Corrected incorrect behavior in CI and release workflows; updated README, added new ESLint config file, and improved test suite. ([df22915](https://github.com/mvagnon/zapdev-mcp/commit/df22915e238703b7a22691ffd3a380d9701fd0bc))
* Fix commit and PR commands to use npx --yes zapdev ([cc8da68](https://github.com/mvagnon/zapdev-mcp/commit/cc8da681b01083e4e9e41f6fe532d8be00ff7f76))
* Fixed a typo in the README file ([50fe781](https://github.com/mvagnon/zapdev-mcp/commit/50fe781a3883e366b4163a5d2c91a22bc1cb8e95))
