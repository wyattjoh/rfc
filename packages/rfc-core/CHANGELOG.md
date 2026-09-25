# Changelog

## [0.3.0](https://github.com/wyattjoh/rfc/compare/rfc-core-v0.2.1...rfc-core-v0.3.0) (2026-09-25)


### Features

* **rfc:** add exact source text access ([9336fba](https://github.com/wyattjoh/rfc/commit/9336fba3d41cb50fcf1b46733bf08623a6b5827e))
* **rfc:** add exact source text access ([40274b3](https://github.com/wyattjoh/rfc/commit/40274b3ae9eeb86c49919585c7e0f0b67b65e161))

## [0.2.1](https://github.com/wyattjoh/rfc/compare/rfc-core-v0.2.0...rfc-core-v0.2.1) (2026-09-23)


### Bug Fixes

* **rfc-pi:** avoid Redis import during Pi startup ([d108ee6](https://github.com/wyattjoh/rfc/commit/d108ee62d194e20945f5b058a099f513039b5541))

## [0.2.0](https://github.com/wyattjoh/rfc/compare/rfc-core-v0.1.2...rfc-core-v0.2.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* **rfc-core:** replace the research engine with Jev-ranked retrieval

### Features

* **rfc-core:** add opt-in full-text topic discovery with Datatracker fallback ([03d3a6e](https://github.com/wyattjoh/rfc/commit/03d3a6e3cf5a78e8b7194181ec4f6d8bf006367f))
* **rfc-core:** make needs_split actionable instead of a bare refusal ([da85ecb](https://github.com/wyattjoh/rfc/commit/da85ecb535ed88dacc057aa65472221c7d260a7f))
* **rfc-core:** parse RFC text into sections and exact paragraphs ([cd32a7e](https://github.com/wyattjoh/rfc/commit/cd32a7e1e18756b8c1f667dc88992dfeaafaae64))
* **rfc-core:** replace the research engine with Jev-ranked retrieval ([f920d40](https://github.com/wyattjoh/rfc/commit/f920d40fee7fa3cfe8ed5cf0b532811af2d772c5))


### Bug Fixes

* **rfc-core:** allow reviewed non-automatic outcomes for four precision cases ([5be8d84](https://github.com/wyattjoh/rfc/commit/5be8d847775ab6a11abf7febb230df02028a4579))
* **rfc-core:** append length-normalized passages to the lexical shortlist ([f6b2030](https://github.com/wyattjoh/rfc/commit/f6b20309684b723522554ad32d1fa2ada4e2ce0b))
* **rfc-core:** bound paragraph judgments per DecisionModel request ([ef1deae](https://github.com/wyattjoh/rfc/commit/ef1deae2302c6918ef14b5c4b3be1fed393a3fc4))
* **rfc-core:** drop the heuristic compound-question splitter ([099446a](https://github.com/wyattjoh/rfc/commit/099446a6af8e5eeaf35d18ee6e73ef1772ce0754))
* **rfc-core:** judge atomicity on the label probability alone ([38ea054](https://github.com/wyattjoh/rfc/commit/38ea054a24e52c9449b8c00adc303b7fb94bf266))
* **rfc-core:** report a compound question as needs_split when nothing is accepted ([f4fb008](https://github.com/wyattjoh/rfc/commit/f4fb008b2603cef4854377d2ebba866238f9bb51))
* **rfc-core:** report incomplete RFC currency and port core tests to v3 ([988c2c4](https://github.com/wyattjoh/rfc/commit/988c2c4f6494933d65ce4a29e1c37379ef413825))
* **rfc-core:** research the selected RFC even when the question is compound ([7c6137a](https://github.com/wyattjoh/rfc/commit/7c6137a7349e50fffbdf9ad921d7dac94f5e726e))
* **rfc-core:** separate bad RFC identifiers from retrieval failures ([acd8eac](https://github.com/wyattjoh/rfc/commit/acd8eaca887e8e8a8f8cf628cfe26e69f71c2d7f))
* **rfc-core:** stop counting a citation clause as a second question ([c4325ef](https://github.com/wyattjoh/rfc/commit/c4325ef92fce53988066e24eb1c632258062c33d))
* **rfc-core:** tolerate rounded provider distributions and judge defining text ([d699b4f](https://github.com/wyattjoh/rfc/commit/d699b4fe53133309842d5b2b1beb261132298493))

## [0.1.2](https://github.com/wyattjoh/rfc/compare/rfc-core-v0.1.1...rfc-core-v0.1.2) (2026-09-22)


### Bug Fixes

* expose agent entry points ([#5](https://github.com/wyattjoh/rfc/issues/5)) ([5c6e5ef](https://github.com/wyattjoh/rfc/commit/5c6e5efd42f9e18e4e3b479cd9552db124ed7ace))

## [0.1.1](https://github.com/wyattjoh/rfc/compare/rfc-core-v0.1.0...rfc-core-v0.1.1) (2026-09-22)


### Bug Fixes

* expose agent entry points ([56dd351](https://github.com/wyattjoh/rfc/commit/56dd3510b439f59c5580cdf777114eebd8faf546))
