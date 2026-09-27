# Changelog

## [0.4.1](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.4.0...rfc-pi-v0.4.1) (2026-09-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.5.0 to 0.5.1

## [0.4.0](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.3.1...rfc-pi-v0.4.0) (2026-09-25)


### Features

* **rfc:** add exact source text access ([9336fba](https://github.com/wyattjoh/rfc/commit/9336fba3d41cb50fcf1b46733bf08623a6b5827e))
* **rfc:** add exact source text access ([40274b3](https://github.com/wyattjoh/rfc/commit/40274b3ae9eeb86c49919585c7e0f0b67b65e161))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.4.1 to 0.5.0
    * @wyattjoh/rfc-core bumped from 0.2.1 to 0.3.0

## [0.3.1](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.3.0...rfc-pi-v0.3.1) (2026-09-23)


### Bug Fixes

* **rfc-pi:** avoid Redis import during Pi startup ([d108ee6](https://github.com/wyattjoh/rfc/commit/d108ee62d194e20945f5b058a099f513039b5541))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.4.0 to 0.4.1
    * @wyattjoh/rfc-core bumped from 0.2.0 to 0.2.1

## [0.3.0](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.2.2...rfc-pi-v0.3.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* **rfc:** expose one rfc_research tool over the ranked-retrieval contract

### Features

* **rfc-core:** add opt-in full-text topic discovery with Datatracker fallback ([03d3a6e](https://github.com/wyattjoh/rfc/commit/03d3a6e3cf5a78e8b7194181ec4f6d8bf006367f))
* **rfc-core:** make needs_split actionable instead of a bare refusal ([da85ecb](https://github.com/wyattjoh/rfc/commit/da85ecb535ed88dacc057aa65472221c7d260a7f))
* **rfc-pi:** allow RFC_CLI_COMMAND to run a local CLI ([dae34dd](https://github.com/wyattjoh/rfc/commit/dae34dd49e0f0e842e8d3baf7b4abf1928d4f55d))
* **rfc-pi:** return compact JSON from the Pi tools ([b4d8c5f](https://github.com/wyattjoh/rfc/commit/b4d8c5fc85630c4cfc6c8714032b8de8cfb13177))
* **rfc:** expose one rfc_research tool over the ranked-retrieval contract ([e560383](https://github.com/wyattjoh/rfc/commit/e560383911ddf3dd7766b7287daab005ce50d20d))
* **rfc:** lean agent-facing instructions, tool surface, and research output ([f28d09c](https://github.com/wyattjoh/rfc/commit/f28d09c5489892086952cb218a7a4a4d0a65fb22))
* **rfc:** return research answers positionally without echoing questions ([2801b1f](https://github.com/wyattjoh/rfc/commit/2801b1f4a11b745a0147f93ff76533ab0df7829c))


### Bug Fixes

* **rfc-core:** drop the heuristic compound-question splitter ([099446a](https://github.com/wyattjoh/rfc/commit/099446a6af8e5eeaf35d18ee6e73ef1772ce0754))
* **rfc-pi:** repair the auth tool and preserve CLI failure diagnostics ([7302ac8](https://github.com/wyattjoh/rfc/commit/7302ac81b124a0f680be09dad6a6988967b054ed))
* **rfc:** allow standard technical search terms while keeping private details out ([f3ed5a7](https://github.com/wyattjoh/rfc/commit/f3ed5a7b9581a985ea4a75d92bb6f16f8f9c55f2))
* **rfc:** tell callers that topic search terms are literal substrings ([60dccbc](https://github.com/wyattjoh/rfc/commit/60dccbcae4a359da56880068af2161775a5b0a88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.3.2 to 0.4.0
    * @wyattjoh/rfc-core bumped from 0.1.2 to 0.2.0

## [0.2.2](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.2.1...rfc-pi-v0.2.2) (2026-09-22)


### Bug Fixes

* expose agent entry points ([#5](https://github.com/wyattjoh/rfc/issues/5)) ([5c6e5ef](https://github.com/wyattjoh/rfc/commit/5c6e5efd42f9e18e4e3b479cd9552db124ed7ace))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.3.1 to 0.3.2
    * @wyattjoh/rfc-core bumped from 0.1.1 to 0.1.2

## [0.2.1](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.2.0...rfc-pi-v0.2.1) (2026-09-22)


### Bug Fixes

* expose agent entry points ([56dd351](https://github.com/wyattjoh/rfc/commit/56dd3510b439f59c5580cdf777114eebd8faf546))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.3.0 to 0.3.1
    * @wyattjoh/rfc-core bumped from 0.1.0 to 0.1.1

## [0.2.0](https://github.com/wyattjoh/rfc/compare/rfc-pi-v0.1.0...rfc-pi-v0.2.0) (2026-09-22)


### Features

* publish Pi integration package ([83dd266](https://github.com/wyattjoh/rfc/commit/83dd2664f241fd0476d7fda8aa06268b7b2b0440))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc bumped from 0.2.1 to 0.3.0
