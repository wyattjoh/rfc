# Changelog

## [0.4.0](https://github.com/wyattjoh/rfc/compare/rfc-v0.3.2...rfc-v0.4.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* **rfc:** expose one rfc_research tool over the ranked-retrieval contract

### Features

* **rfc-core:** add opt-in full-text topic discovery with Datatracker fallback ([03d3a6e](https://github.com/wyattjoh/rfc/commit/03d3a6e3cf5a78e8b7194181ec4f6d8bf006367f))
* **rfc-core:** make needs_split actionable instead of a bare refusal ([da85ecb](https://github.com/wyattjoh/rfc/commit/da85ecb535ed88dacc057aa65472221c7d260a7f))
* **rfc-pi:** return compact JSON from the Pi tools ([b4d8c5f](https://github.com/wyattjoh/rfc/commit/b4d8c5fc85630c4cfc6c8714032b8de8cfb13177))
* **rfc:** expose one rfc_research tool over the ranked-retrieval contract ([e560383](https://github.com/wyattjoh/rfc/commit/e560383911ddf3dd7766b7287daab005ce50d20d))
* **rfc:** lean agent-facing instructions, tool surface, and research output ([f28d09c](https://github.com/wyattjoh/rfc/commit/f28d09c5489892086952cb218a7a4a4d0a65fb22))
* **rfc:** return research answers positionally without echoing questions ([2801b1f](https://github.com/wyattjoh/rfc/commit/2801b1f4a11b745a0147f93ff76533ab0df7829c))


### Bug Fixes

* **rfc-core:** drop the heuristic compound-question splitter ([099446a](https://github.com/wyattjoh/rfc/commit/099446a6af8e5eeaf35d18ee6e73ef1772ce0754))
* **rfc:** allow standard technical search terms while keeping private details out ([f3ed5a7](https://github.com/wyattjoh/rfc/commit/f3ed5a7b9581a985ea4a75d92bb6f16f8f9c55f2))
* **rfc:** say why a bundle names no RFC instead of "none discovered" ([aad18b8](https://github.com/wyattjoh/rfc/commit/aad18b85856931a153a76f4132fbc6bf904ec6ce))
* **rfc:** tell agents how to spend the follow-up when no RFC matched ([4698e56](https://github.com/wyattjoh/rfc/commit/4698e56acad8a7c3ea63e385731d6554b1ea58c7))
* **rfc:** tell callers that topic search terms are literal substrings ([60dccbc](https://github.com/wyattjoh/rfc/commit/60dccbcae4a359da56880068af2161775a5b0a88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc-core bumped from 0.1.2 to 0.2.0

## [0.3.2](https://github.com/wyattjoh/rfc/compare/rfc-v0.3.1...rfc-v0.3.2) (2026-09-22)


### Bug Fixes

* expose agent entry points ([#5](https://github.com/wyattjoh/rfc/issues/5)) ([5c6e5ef](https://github.com/wyattjoh/rfc/commit/5c6e5efd42f9e18e4e3b479cd9552db124ed7ace))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc-core bumped from 0.1.1 to 0.1.2

## [0.3.1](https://github.com/wyattjoh/rfc/compare/rfc-v0.3.0...rfc-v0.3.1) (2026-09-22)


### Bug Fixes

* expose agent entry points ([56dd351](https://github.com/wyattjoh/rfc/commit/56dd3510b439f59c5580cdf777114eebd8faf546))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @wyattjoh/rfc-core bumped from 0.1.0 to 0.1.1

## [0.3.0](https://github.com/wyattjoh/rfc/compare/rfc-v0.2.1...rfc-v0.3.0) (2026-09-22)


### Features

* publish Pi integration package ([83dd266](https://github.com/wyattjoh/rfc/commit/83dd2664f241fd0476d7fda8aa06268b7b2b0440))

## [0.2.1](https://github.com/wyattjoh/rfc/compare/rfc-v0.2.0...rfc-v0.2.1) (2026-09-22)


### Bug Fixes

* report package version in CLI ([fa5418a](https://github.com/wyattjoh/rfc/commit/fa5418a18529dbe2f3500b6118c88207658179c1))

## [0.2.0](https://github.com/wyattjoh/rfc/compare/rfc-v0.1.0...rfc-v0.2.0) (2026-09-22)


### Features

* add Pi RFC agent extension ([d74e525](https://github.com/wyattjoh/rfc/commit/d74e525adcac473009444dc1272bd1a8f924faa9))
* **cli:** support human-friendly arguments ([7b650d8](https://github.com/wyattjoh/rfc/commit/7b650d81a677ff568f06b24df53d32c39b2bb213))
