# `@wyattjoh/rfc`

The private `rfc` package exposes the RFC evidence engine's agent-facing CLI.

## Process protocol

Catalog commands write versioned JSON responses to standard output by default:

```sh
rfc catalog status
rfc catalog refresh
rfc catalog refresh --format human
```

`catalog refresh` follows the paginated Datatracker RFC and relationship APIs, then atomically replaces the local version-one catalog. A failed refresh leaves the previous cache untouched. `catalog status` reports missing, fresh, or stale state, the cache identity, fetch time, age, and document count.

Research accepts canonical JSON on standard input. Set `rfc` to `null` for topic-only discovery:

```json
{
  "schemaVersion": 1,
  "question": "What does HTTP require of a client?",
  "rfc": null
}
```

When standard input contains non-whitespace input, it is authoritative and convenience flags are ignored. When standard input is empty, `--question` and `--rfc` provide the short interactive form. `--cache-directory`, `--datatracker-api-url`, and `--typesafe-api-url` are available for deterministic preflight and local testing. RFC research always fetches from the authoritative RFC Editor origin. JSON is always the automation default; human rendering is an explicit opt-in.

Research refreshes a missing or stale catalog, then reads authoritative RFC Editor plain text through a content-addressed cache and returns a versioned evidence bundle. Known-RFC research uses two semantic stages. Topic-only research lexically shortlists catalog identifiers, titles, and abstracts, uses one independent document-probability decision per candidate, and advances only bounded accepted documents through passage selection and answer-relation verification. Each evidence passage contains an exact quote, absolute UTF-8 byte offsets into the SHA-256 source, the declared `offsetUnit: "utf8-byte"`, canonical URLs, and a nullable best-effort section label. Bundle diagnostics include source hashes and fetch times, lexical and semantic candidate counts, accepted document probabilities, requested and provider-resolved model identifiers, token usage, probabilities, confidence, catalog freshness, and stage timings.

Known-RFC currency research never silently replaces the requested RFC: update and obsoletion relationships are traversed deterministically with bounded, cycle-safe paths, and terminal current RFC contexts are researched independently. Requested/current evidence retains context-aware provenance and diagnostics. Incomplete successor coverage is reported as `partial` or `needs_review`; changed or ambiguous normative wording is not accepted as compatible.

Citation verification accepts canonical JSON with an RFC identifier, factual claim, exact quotation, and optional offset:

```json
{
  "schemaVersion": 1,
  "rfc": "RFC9110",
  "claim": "The client must send a request.",
  "quote": "The client MUST send a request.",
  "offset": null
}
```

The optional `offset` is an absolute UTF-8 byte offset into the exact authoritative RFC Editor source identified by the returned SHA-256 `sourceHash`; it is not a JavaScript UTF-16 string index. Results declare this unit as `provenance.offsetUnit: "utf8-byte"`, and `startOffset`/`endOffset` can be used to slice the hashed source bytes and recover the exact returned quote. Use it with `rfc verify-citation < citation.json`, or provide `--rfc`, `--claim`, `--quote`, and optional `--offset` convenience flags. The verifier locates the quote in authoritative RFC Editor text before making a semantic request, returns `fabricated` for absent text without calling TypeSafe, and rejects ambiguous repeated quotes unless an exact offset selects one occurrence. Present quotes receive `verified`, `unsupported`, or `contradicted` verdicts with exact provenance, probabilities, confidence, model identity, usage, and timings.

Errors are versioned JSON envelopes on standard error and return a nonzero exit code. Valid domain outcomes, including `fabricated`, use standard output and a zero exit code.

The opt-in `bun run benchmark:topic` command warms the topic cache, records repeated research timings, reports p95 JSON, and fails when p95 reaches the three-second target. Set `RFC_TOPIC_BENCHMARK=1` and `RFC_CACHE_DIRECTORY` before running it; it never runs as part of the normal test suite.

## Provider credentials

The TypeSafe API key is stored by Bun's experimental `Bun.secrets` API under this stable identity:

- service: `com.wyattjoh.rfc`
- name: `typesafe-api-key`

Add it interactively with a masked prompt:

```sh
rfc auth add
```

For automation, explicitly pipe the key through standard input. It is never accepted as an argv value:

```sh
cat /path/to/a-protected-key-input | rfc auth add --stdin
```

`auth status` reports only whether a key is configured and the service/name identity. `auth remove` is deterministic: its versioned result reports `removed: true` when a key existed and `removed: false` when it was already absent. JSON is the default; add `--format human` only for human-readable output. The key is not included in command output, diagnostics, snapshots, or error envelopes.

Bun maps the store to the host credential service: macOS Keychain, Linux Secret Service (libsecret, such as GNOME Keyring or KWallet), or Windows Credential Manager. Linux requires a running and unlocked Secret Service daemon; macOS requires Keychain access; Windows requires Credential Manager. This repository pins Bun `1.4.2` in `package.json` and tests against that version because `Bun.secrets` is experimental and may change.

To migrate an existing setup, run `rfc auth add`, verify with `rfc auth status`, then delete the obsolete plaintext, `.env`, Varlock, dotenv, or 1Password-backed TypeSafe API-key configuration. Research, citation verification, and live evaluation all resolve this same credential lazily before constructing the provider.

## Precision calibration

The committed `@wyattjoh/rfc-core` evaluation corpus covers HTTP, TLS, OAuth, and DNS known-RFC research, topic research, currency changes, answer statuses, and citation verdicts, including an actual repeated quotation from RFC 9110. Each expected outcome carries a corpus rationale and an explicit allowed-outcome policy; only the recertified negative, updated-document, fully supported caching, and evidence-backed topic-discovery cases permit bounded alternatives; topic answers still require a document threshold, selected passage, and confident direct relation. The modern normative case remains an exact answered positive control and citation verdicts remain exact. Ambiguous or insufficient evidence stays fail-closed. Deterministic tests use injected fake credential and Effect services with recorded DecisionModel responses; they never require a provider credential, the real OS credential manager, or network access.

Run the live TypeSafe calibration only through the explicit evaluator command after storing a credential:

```sh
rfc auth status
bun run evaluate:live
```

The command starts with the typed `jev-latest` alias, refreshes the catalog, prefetches corpus sources, and runs an untimed pass over every live case before timing three sequential warm-cache iterations. It records every provider-resolved model and writes a sanitized report to `.scratch/rfc-evaluation-report.json` by default. The report contains policy/model identity, corpus and policy digests, authoritative source hashes, verdicts, probabilities, confidence, usage, timings, expected outcomes, the research answer rate, citation-only supported-claim coverage, separate status/verdict rates, positive-control status, and gate failures; it never writes prompts, questions, reasoning, or credentials. Precision must be at least 98%, fabricated or contradicted citations cannot be accepted, and p95 must remain strictly below 2 seconds for known-RFC research and 3 seconds for topic research. Automatic `answered` requires explicit enablement plus a release-bound attestation compiled into the current build: the exact report digest, build identity, corpus/policy digests, authoritative source hashes, and unexpired freshness window must all match. The coordinator-reviewed `rfc-evidence-precision-v4` attestation is accepted for the measured report (`7f2070e5040525f8794d6cee8cc2a4440f00836a2dc079de5c2cb3bcc9ee2f9b`), which recorded precision and supported coverage of 1, zero unsafe citation acceptances, known-RFC/topic p95 latencies of 1696/1111ms, and six RFCs with 19 authoritative source hashes through `2026-10-19T19:20:57.805Z`; any digest, identity, source, model, observation, or expiry mismatch remains fail-closed. The committed production default is the pinned `jev-1.13.0` model, and changing the pin requires a new passing evaluation and reviewed release attestation.

## Configuration

Non-secret model, policy, evaluation, cache, output, and automatic-answer settings use typed defaults in the CLI composition root. They are not loaded from Varlock, dotenv, `.env` files, or ordinary environment variables. `bunfig.toml` disables Bun dotenv loading. Use explicit CLI flags for command-specific values such as cache and provider URLs; the credential store is the only authority for the TypeSafe API key. Even with the accepted release attestation, automatic answering must be explicitly enabled and the local report must match every release-bound identity; missing, stale, or tampered artifacts remain fail-closed and report `needs_review`.
