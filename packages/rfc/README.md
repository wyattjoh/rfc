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

Research accepts canonical JSON on standard input:

```json
{
  "schemaVersion": 1,
  "question": "What does RFC 9110 require?",
  "rfc": "RFC9110"
}
```

When standard input contains non-whitespace input, it is authoritative and convenience flags are ignored. When standard input is empty, `--question` and `--rfc` provide the short interactive form. `--cache-directory`, `--datatracker-api-url`, and `--typesafe-api-url` are available for deterministic preflight and local testing. RFC research always fetches from the authoritative RFC Editor origin. JSON is always the automation default; human rendering is an explicit opt-in.

Known-RFC research refreshes a missing or stale catalog, reads authoritative RFC Editor plain text through a content-addressed cache, and returns a versioned evidence bundle. Each evidence passage contains an exact quote, absolute UTF-8 byte offsets into the SHA-256 source, the declared `offsetUnit: "utf8-byte"`, canonical URLs, and a nullable best-effort section label. The bundle diagnostics include source hash and fetch time, the two semantic stages, bounded candidate counts, requested and provider-resolved model identifiers, token usage, probabilities, confidence, catalog freshness, and timings.

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

## Configuration

Varlock is loaded and validated before the application module for every command. The committed `.env.schema` declares the sensitive required `TYPESAFE_API_KEY`; catalog status does not make a provider request, but it still requires the validated configuration boundary. Missing configuration is reported as a versioned JSON error envelope. Bun's automatic dotenv loading is disabled in `bunfig.toml`.
