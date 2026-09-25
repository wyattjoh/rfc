# `@wyattjoh/rfc`

This package exposes the RFC evidence engine through an agent-facing CLI and a self-describing local MCP server. It is the reference for the process protocol, the MCP surface, credential handling, and configuration; start from the [repository README](../../README.md) for what the tool is, how to install it, and what it sends where.

## MCP server

Run the MCP server over stdio:

```sh
rfc mcp
```

An MCP host should launch that command directly and treat standard output as protocol traffic. The server advertises the complete workflow in its initialization instructions and exposes the full Markdown reference at `rfc://docs/agent-workflow`, so a connected model does not need this repository's skill or direct CLI access.

The model-facing tools are:

- `rfc_research`
- `rfc_verify_citation`
- `rfc_source_text`
- `rfc_source_cache_status`
- `rfc_source_cache_remove`
- `rfc_auth_status`

Each successful tool call returns concise text plus the complete version-three result as validated structured content. Operational failures are MCP tool errors containing the same safe version-three error envelope as the CLI. A question that was not found and every citation verdict remain successful domain results. `rfc_source_cache_remove` requires `confirm: true` and is marked destructive and idempotent.

Provider credentials are intentionally outside the model-facing mutation surface. The MCP can inspect safe credential status but can never accept, reveal, add, or remove a key. Configure the credential through `rfc auth login` before launching the server. The stored key is resolved separately for every semantic tool call.

Trusted operators may select the same deterministic test or self-hosted boundaries at process startup:

```sh
rfc mcp \
  --cache-directory /path/to/cache \
  --datatracker-api-url https://datatracker.example/api/v1 \
  --typesafe-api-url https://typesafe.example/api
```

Those values are fixed for the MCP process and never appear in tool input schemas. This prevents a model from redirecting credential-bearing provider traffic, issuing arbitrary metadata requests, or selecting arbitrary filesystem paths. Each call creates and closes its own RFC client, preserving CLI isolation and allowing credential rotation while the server remains running.

## Process protocol

Research uses the version-three public protocol and accepts canonical JSON on standard input. A request supplies one to four `questions` plus `rfcs`, `searchTerms`, or both, each with one to four entries:

```json
{
  "schemaVersion": 3,
  "questions": ["What does the 429 status code mean?", "Which header says how long to wait?"],
  "rfcs": ["RFC6585", "RFC9110"]
}
```

```json
{
  "schemaVersion": 3,
  "questions": ["How long may a cache reuse a response?"],
  "searchTerms": ["HTTP caching"]
}
```

When standard input contains non-whitespace input, it is authoritative, convenience flags are ignored, and JSON output remains the default. When standard input is empty, pass `-q`/`--question` once per question, plus up to four `-r`/`--rfc` and up to four `--search-term` flags. Argument-based operations render human-readable output by default; pass `--format json` for machine-readable output or `--format human` to render structured standard input for a person. `--cache-directory`, `--datatracker-api-url`, and `--typesafe-api-url` are available for deterministic preflight and local testing. Corpus-wide metadata management and bulk source operations are not part of the public client or CLI.

Named RFCs are looked up exactly and their current successors are found by recursively following only bounded updating or obsoleting relationships. Topic research issues one bounded title query and one bounded abstract query for each caller-supplied term and deterministically merges candidates in term order. Named RFCs, their current successors, and topic hits form one candidate pool of at most 32 RFCs. Datatracker response bodies are streamed through a 1 MiB cap and decoded with bounded field lengths before any metadata reaches TypeSafe. Only the explicit search terms are sent to Datatracker; the questions are not. Search terms appear in full Datatracker request URLs and can therefore appear in retrieval diagnostics, errors, and upstream access logs. An empty pool returns every question as not found without invoking TypeSafe.

Retrieval then makes three kinds of TypeSafe Jev requests. One request ranks the pool for every question and keeps at most two RFCs per question that clear the relevance floor, plus the requested or current partner of a kept RFC when it also clears the floor; ranking is skipped when the pool holds one RFC, and that RFC's `relevance` is `null`. One request per kept RFC chooses up to three sections from its table of contents, using a two-level chapter-then-subsection choice for RFCs with more than 250 sections. One request per kept RFC chooses up to three paragraphs from those sections and assigns each a verdict; an RFC judged not to contain an answer is dropped for that question. The floors and limits live in the exported `retrievalPolicy` and are uncalibrated working values. [ADR 0005](../../docs/adr/0005-jev-ranked-retrieval-without-research-statuses.md) records the design.

The result is a `research_result` whose `answers` hold, per question, `found`, the `searched` RFC identifiers, and ranked `hits`. Each hit carries the `rfc` document, its `role` (`requested`, `current`, or `discovered`), `relevance`, an overall `verdict`, and its `passages`. Each passage contains an exact paragraph `quote`, a nullable section heading, its selection `probability`, a `verdict` (`supports`, `partial`, `says_nothing`, or `contradicts`), and provenance with absolute UTF-8 byte offsets into the SHA-256 source, the declared `offsetUnit: "utf8-byte"`, the canonical URL, and the fetch time. Paragraphs never include page furniture; a paragraph interrupted by a page break is returned as two paragraphs. When `rfcs` were supplied, `currency` holds one `{ requested, current, complete, paths }` report per named RFC: its current successors and the relationship path to each, with `complete: false` when a successor was unresolved or cut off by a traversal bound (agent output then appends "(incomplete: some successors were not fetched)"), so a `current` hit is never silently substituted for the RFC the caller named. Human output prints one line per passage naming the RFC, section, verdict, relevance, and `current successor` when applicable, followed by the quote and its byte range.

When full RFC text is explicitly required or requested, use `rfc source-text RFC9110 --format json` or `rfc_source_text` instead of relying on research excerpts. With just `rfc`, the tool returns the canonical URL, source hash, total byte length, and parsed section headings with half-open UTF-8 byte ranges; it returns no text. Supply both `--start-offset` and `--end-offset` (or `startOffset` and `endOffset` in MCP/Pi) to read the exact, untruncated `[startOffset,endOffset)` slice. Use `--expected-source-hash` (or `expectedSourceHash`) on later requests to reject revalidated text that differs from the initial snapshot. Citation offsets use the same byte unit. Prefer research and citation tools unless full source text is explicitly necessary. This operation needs no TypeSafe credential and makes no provider call.

Requested RFC Editor plain text is cached individually with its canonical URL, integrity hash, ETag, and HTTP freshness deadline. Fresh text is reused without a network request. Stale text is conditionally revalidated and is never used when authoritative revalidation fails. `rfc cache status RFC9110` reports a local hit or miss, while `rfc cache remove RFC9110` removes only that named entry; `--rfc RFC9110` remains an equivalent flag form. Neither command performs network access, and no bulk cache command is provided. Source retrieval accepts only a `200` body with an explicit `text/plain` Content-Type or a `304` conditional response, enforces one ten-second deadline across the complete operation, and rejects bodies above 8 MiB while streaming. A named RFC whose source cannot be loaded fails the request; a successor or topic hit whose source cannot be fetched is dropped.

Research diagnostics report the policy version, requested and resolved models, usage and estimated cost, per-stage timings (`metadataMs`, `sourceMs`, `rankMs`, `sectionMs`, `paragraphMs`, `totalMs`), the candidate pool and ranked counts, and a retrieval trace with full upstream URLs, attempts and statuses, the source-cache outcome, and traversal bounds. Topic traces distinguish `upstreamRows`, deduplicated `uniqueCandidates`, the 32-document `mergeLimit`, `semanticCandidates` sent to TypeSafe, and `selectedSources` loaded from the RFC Editor. Public RFC documents omit relationship fields. Topic discovery accepts each bounded first page and reports `topicTruncated: true` when Datatracker advertises additional rows or the deterministic merge reaches its cap; it never follows unbounded pagination.

Citation verification accepts canonical JSON with an RFC identifier, factual claim, exact quotation, and optional offset:

```json
{
  "schemaVersion": 3,
  "rfc": "RFC9110",
  "claim": "The client must send a request.",
  "quote": "The client MUST send a request.",
  "offset": null
}
```

The optional `offset` is an absolute UTF-8 byte offset into the exact authoritative RFC Editor source identified by the returned SHA-256 `sourceHash`; it is not a JavaScript UTF-16 string index. Results declare this unit as `provenance.offsetUnit: "utf8-byte"`, and `startOffset`/`endOffset` can be used to slice the hashed source bytes and recover the exact returned quote. Use it with `rfc verify-citation < citation.json`, pass positional `RFC`, `claim`, and `quote` arguments, or provide `--rfc`, `--claim`, `--quote`, and optional `--offset` convenience flags. The verifier performs one request-local exact Datatracker document lookup without successor traversal, loads the live source, locates the quote before making a semantic request, returns `fabricated` for absent text without calling TypeSafe, and rejects ambiguous repeated quotes unless an exact offset selects one occurrence. Present quotes receive version-three `verified`, `unsupported`, or `contradicted` results with exact provenance, probabilities, confidence, model identity, usage, timings, and retrieval traces including source-cache outcomes.

Errors are versioned JSON envelopes on standard error and return a nonzero exit code. Valid domain outcomes, including `fabricated`, use standard output and a zero exit code.

Research and citation results report provider usage in `diagnostics.usage`. They also include `diagnostics.inputCost.estimatedUsd` and the `rateUsdPerMillionTokens` used for the estimate. Jev 1.13 input is priced at $0.042 per million tokens; output tokens are free. Missing usage or an unknown provider-resolved model leaves the estimate null rather than applying an assumed price. Human output prints the input-token count and estimated USD cost directly.

Every successful research or citation operation also updates the per-user running total at `~/.config/rfc/usage.json`. The versioned JSON file separates priced tokens, unpriced tokens, and operations with no provider-reported usage so `estimatedInputCostUsd` is never mistaken for a complete estimate when pricing is unavailable. Updates use a lock and atomic rename to preserve concurrent CLI invocations. A persistence failure leaves the successful result on standard output and emits a version-three `usage_accounting_failed` warning on standard error instead of encouraging a retry that could incur the provider charge again.

Run `rfc costs` to read those cumulative global totals without changing them. Its default human output prints the update timestamp, operation and token coverage, and estimated USD total. `rfc costs --format json` emits the same validated `rfc_usage_totals` document stored on disk. When the usage file does not exist yet, the command reports zero totals and does not create it.

The opt-in `bun run benchmark:topic` command performs a normal topic research warm-up and then repeats the same schema-version-three request; it has no prefetch-only path. Set `RFC_TOPIC_BENCHMARK=1`, `RFC_CACHE_DIRECTORY`, and optionally `RFC_TOPIC_BENCHMARK_SEARCH_TERMS` as a JSON array of ordered terms. The JSON report separates live RFC discovery, RFC source-cache, rank, section, paragraph, semantic, and total p95 timings and includes the warm-up and measured retrieval traces. Its latency target is provisional, so this explicit benchmark does not claim a release pass and never runs in the normal test suite.

## Provider credentials

The TypeSafe API key is stored by Bun's experimental `Bun.secrets` API under this stable identity:

- service: `com.wyattjoh.rfc`
- name: `typesafe-api-key`

Store it interactively with a masked login prompt:

```sh
rfc auth login
```

For automation, explicitly pipe the key through standard input. It is never accepted as an argv value:

```sh
cat /path/to/a-protected-key-input | rfc auth login --stdin
```

Bare `auth` reports only whether a key is configured and the service/name identity. `auth remove` is deterministic: its versioned JSON result reports `removed: true` when a key existed and `removed: false` when it was already absent. Human output is the default for auth commands; add `--format json` for the versioned process result. The key is not included in command output, diagnostics, snapshots, or error envelopes.

Bun maps the store to the host credential service: macOS Keychain, Linux Secret Service (libsecret, such as GNOME Keyring or KWallet), or Windows Credential Manager. Linux requires a running and unlocked Secret Service daemon; macOS requires Keychain access; Windows requires Credential Manager. This repository pins Bun `1.4.2` in `package.json` and tests against that version because `Bun.secrets` is experimental and may change.

To migrate an existing setup, run `rfc auth login`, verify with `rfc auth`, then delete the obsolete plaintext, `.env`, Varlock, dotenv, or 1Password-backed TypeSafe API-key configuration. Research and citation verification both resolve this same credential lazily before constructing the provider.

## Configuration

Non-secret model, cache, and output settings use typed defaults in the CLI composition root. They are not loaded from Varlock, dotenv, `.env` files, or ordinary environment variables. `bunfig.toml` disables Bun dotenv loading. Use explicit CLI flags for command-specific values such as cache and provider URLs; the credential store is the only authority for the TypeSafe API key.
