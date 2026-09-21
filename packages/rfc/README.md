# `@wyattjoh/rfc`

This package exposes the RFC evidence engine through an agent-facing CLI and a self-describing local MCP server. It is the reference for the process protocol, the MCP surface, credential handling, and configuration; start from the [repository README](../../README.md) for what the tool is, how to install it, and what it sends where.

## MCP server

Run the MCP server over stdio:

```sh
rfc mcp
```

An MCP host should launch that command directly and treat standard output as protocol traffic. The server advertises the complete bounded workflow in its initialization instructions and exposes the full Markdown reference at `rfc://docs/agent-workflow`, so a connected model does not need this repository's skill or direct CLI access.

The model-facing tools are:

- `research_known_rfc`
- `research_topic`
- `verify_citation`
- `source_cache_status`
- `source_cache_remove`
- `auth_status`

Each successful tool call returns concise text plus the complete version-two result as validated structured content. Operational failures are MCP tool errors containing the same safe version-two error envelope as the CLI. Valid fail-closed research statuses and citation verdicts remain successful domain results. `source_cache_remove` requires `confirm: true` and is marked destructive and idempotent.

Provider credentials are intentionally outside the model-facing mutation surface. The MCP can inspect safe credential status but can never accept, reveal, add, or remove a key. Configure the credential through `rfc auth add` before launching the server. The stored key is resolved separately for every semantic tool call.

Trusted operators may select the same deterministic test or self-hosted boundaries at process startup:

```sh
rfc mcp \
  --cache-directory /path/to/cache \
  --datatracker-api-url https://datatracker.example/api/v1 \
  --typesafe-api-url https://typesafe.example/api
```

Those values are fixed for the MCP process and never appear in tool input schemas. This prevents a model from redirecting credential-bearing provider traffic, issuing arbitrary metadata requests, or selecting arbitrary filesystem paths. Each call creates and closes its own RFC client, preserving CLI isolation and allowing credential rotation while the server remains running.

## Process protocol

Research uses the version-two public protocol and accepts canonical JSON on standard input. A known-RFC request supplies an RFC identifier:

```json
{
  "schemaVersion": 2,
  "question": "What does HTTP require of a client?",
  "rfc": "RFC9110"
}
```

A topic request sets `rfc` to `null` and supplies one to four ordered search terms:

```json
{
  "schemaVersion": 2,
  "question": "What does HTTP require of a client?",
  "rfc": null,
  "searchTerms": ["HTTP semantics", "client request"]
}
```

When standard input contains non-whitespace input, it is authoritative and convenience flags are ignored. When standard input is empty, use `--question` with either `--rfc` or one to four repeatable `--search-term` flags. `--cache-directory`, `--datatracker-api-url`, and `--typesafe-api-url` are available for deterministic preflight and local testing. JSON is always the automation default; human rendering is an explicit opt-in. Corpus-wide metadata management and bulk source operations are not part of the public client or CLI. Removed version-one `catalog status`, `catalog refresh`, and source-prefetch commands are rejected rather than emulated.

Known-RFC research fetches exact request-local metadata and recursively follows only bounded updating or obsoleting successors. Topic research issues one bounded title query and one bounded abstract query for each caller-supplied term, deterministically merges candidates in term order, and uses TypeSafe native multi-question scoring before source retrieval. Empty discovery returns `needs_review` without invoking TypeSafe and reports `atomicity: null` because no semantic judgment was made. Datatracker response bodies are streamed through a 1 MiB cap and decoded with bounded field lengths before any metadata reaches TypeSafe. Only the explicit search terms are sent to Datatracker; the natural-language question is not. Search terms appear in full Datatracker request URLs and can therefore appear in retrieval diagnostics, errors, and upstream access logs.

Requested RFC Editor plain text is cached individually with its canonical URL, integrity hash, ETag, and HTTP freshness deadline. Fresh text is reused without a network request. Stale text is conditionally revalidated and is never used when authoritative revalidation fails. `rfc cache status --rfc RFC9110` reports a local hit or miss, while `rfc cache remove --rfc RFC9110` removes only that named entry; neither command performs network access, and no bulk cache command is provided. Source retrieval accepts only a `200` body with an explicit `text/plain` Content-Type or a `304` conditional response, enforces one ten-second deadline across the complete operation, and rejects bodies above 8 MiB while streaming. Each evidence passage contains an exact quote, absolute UTF-8 byte offsets into the SHA-256 source, the declared `offsetUnit: "utf8-byte"`, canonical URLs, and a nullable best-effort section label. When a request ends without accepted evidence, the result can also include one request-local entry in `reviewCandidates`: the strongest semantically qualifying passage, falling back to the highest-ranked deterministic lexical passage, with exact canonical provenance and its semantic selection probability. The candidate is explicitly unaccepted and exists only to support bounded human or agent review without re-query loops. Human output labels them `Review candidate: not accepted evidence`. Version-two bundle diagnostics use `metadataMs` and `discoveredDocuments`, report full upstream URLs, attempts and statuses, request-local timings and counts, candidate or traversal bounds, explicit bounded traversal exits, and the source-cache outcome. Topic traces distinguish `upstreamRows`, all deduplicated `uniqueCandidates`, the 32-document `mergeLimit`, `semanticCandidates` sent to TypeSafe, and `selectedSources` advanced to RFC Editor retrieval. Public RFC documents omit relationship fields; currency paths and diagnostics carry only the relationships actually fetched. Topic discovery accepts each bounded first page and reports `topicTruncated: true` when Datatracker advertises additional rows or the deterministic merge reaches its cap; it never follows unbounded pagination.

Known-RFC currency research never silently replaces the requested RFC: update and obsoletion relationships are traversed deterministically with bounded, cycle-safe paths, and terminal current RFC contexts are researched independently. Requested/current evidence retains context-aware provenance and diagnostics. Incomplete successor coverage is reported as `partial` or `needs_review`; changed or ambiguous normative wording is not accepted as compatible.

Citation verification accepts canonical JSON with an RFC identifier, factual claim, exact quotation, and optional offset:

```json
{
  "schemaVersion": 2,
  "rfc": "RFC9110",
  "claim": "The client must send a request.",
  "quote": "The client MUST send a request.",
  "offset": null
}
```

The optional `offset` is an absolute UTF-8 byte offset into the exact authoritative RFC Editor source identified by the returned SHA-256 `sourceHash`; it is not a JavaScript UTF-16 string index. Results declare this unit as `provenance.offsetUnit: "utf8-byte"`, and `startOffset`/`endOffset` can be used to slice the hashed source bytes and recover the exact returned quote. Use it with `rfc verify-citation < citation.json`, or provide `--rfc`, `--claim`, `--quote`, and optional `--offset` convenience flags. The verifier performs one request-local exact Datatracker document lookup without successor traversal, loads the live source, locates the quote before making a semantic request, returns `fabricated` for absent text without calling TypeSafe, and rejects ambiguous repeated quotes unless an exact offset selects one occurrence. Present quotes receive version-two `verified`, `unsupported`, or `contradicted` results with exact provenance, probabilities, confidence, model identity, usage, timings, and retrieval traces including source-cache outcomes.

Errors are versioned JSON envelopes on standard error and return a nonzero exit code. Valid domain outcomes, including `fabricated`, use standard output and a zero exit code.

Research and citation results report provider usage in `diagnostics.usage`. They also include `diagnostics.inputCost.estimatedUsd` and the `rateUsdPerMillionTokens` used for the estimate. Jev 1.13 input is priced at $0.042 per million tokens; output tokens are free. Missing usage or an unknown provider-resolved model leaves the estimate null rather than applying an assumed price. Human output prints the input-token count and estimated USD cost directly.

Every successful research or citation operation also updates the per-user running total at `~/.config/rfc/usage.json`. The versioned JSON file separates priced tokens, unpriced tokens, and operations with no provider-reported usage so `estimatedInputCostUsd` is never mistaken for a complete estimate when pricing is unavailable. Updates use a lock and atomic rename to preserve concurrent CLI invocations. A persistence failure leaves the successful result on standard output and emits a version-two `usage_accounting_failed` warning on standard error instead of encouraging a retry that could incur the provider charge again.

The opt-in `bun run benchmark:topic` command performs a normal topic research warm-up and then repeats the same schema-version-two request; it has no prefetch-only path. Set `RFC_TOPIC_BENCHMARK=1`, `RFC_CACHE_DIRECTORY`, and optionally `RFC_TOPIC_BENCHMARK_SEARCH_TERMS` as a JSON array of ordered terms. The JSON report separates live RFC discovery, RFC source-cache, document-selection, lexical, passage-selection, relation, semantic, and total p95 timings and includes the warm-up and measured retrieval traces. The current latency target is reported only as provisional while `precision-v2` is uncalibrated, so this explicit benchmark does not claim a release pass and never runs in the normal test suite.

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

Automatic answering is off. `answered` requires a locally present calibration report proving a passing release gate, a recorded human acceptance, and explicit runtime enablement; anything weaker fails closed to `needs_review`. The most recent calibration was **rejected**, so a published install returns evidence, provenance, and a non-answer status.

Run a calibration against the live provider only through the explicit evaluator, after storing a credential. It costs money and reaches the network:

```sh
rfc auth status
bun run evaluate:live
```

It writes a sanitized report to `.scratch/rfc-evaluation-report.json`, exiting zero for a passing gate and two for a complete report that fails review. The report never contains credentials, prompts, questions beyond the committed corpus, or provider reasoning.

What the corpus measures, what the report contains, and the recorded 2026-09-21 rejection are in [ADR 0004](../../docs/adr/0004-gate-automatic-answers-on-a-reviewed-calibration.md). The durable decision itself is committed in `packages/rfc-core/src/precision-v2-release-decision.ts`.

## Configuration

Non-secret model, policy, evaluation, cache, output, and automatic-answer settings use typed defaults in the CLI composition root. They are not loaded from Varlock, dotenv, `.env` files, or ordinary environment variables. `bunfig.toml` disables Bun dotenv loading. Use explicit CLI flags for command-specific values such as cache and provider URLs; the credential store is the only authority for the TypeSafe API key. After a release attestation is reviewed and accepted, automatic answering must still be explicitly enabled and the local report must match every release-bound identity; rejected, pending, missing, stale, or tampered artifacts remain fail-closed and report `needs_review`.
