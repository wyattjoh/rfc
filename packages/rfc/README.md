# `@wyattjoh/rfc`

The private `rfc` package exposes the RFC evidence engine's agent-facing CLI.

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

The committed `@wyattjoh/rfc-core` evaluation corpus covers HTTP, TLS, OAuth, and DNS known-RFC research, ordered multi-term topic research, candidate fan-out, empty discovery, currency changes, answer statuses, and citation verdicts. Its deterministic retrieval cases execute current RFCs, update chains, cycle safety, relationship bounds, a saturated 32-candidate/eight-source topic fan-out, source-cache misses and zero-network hits, `304` validator revalidation, changed-source replacement, corrupt-entry repair, typed metadata failure, and typed stale-source revalidation failure through the public `RfcClient` seam; a missing or failed retrieval observation closes the release gate. Retrieval request counts represent logical Datatracker and RFC Editor trace entries, while each entry records its bounded retry attempts separately. Every expected semantic outcome is exact while `precision-v2` remains uncalibrated; no bounded alternative or old release outcome is carried forward as certified. The modern normative case remains an answered positive control and citation verdicts remain exact. Deterministic tests inject Datatracker, RFC Editor, DecisionModel, clock, and credential behavior and never require a provider credential, the real OS credential manager, or network access.

Run the live TypeSafe calibration only through the explicit evaluator command after storing a credential:

```sh
rfc auth status
bun run evaluate:live
```

The command starts with the typed `jev-latest` alias and exercises the normal live RFC discovery and read-through RFC source-cache paths for every live case before timing three sequential iterations. Citation controls carry exact committed RFC text and therefore need no direct-fetch or prefetch bypass. The evaluator records every provider-resolved model and writes a sanitized report to `.scratch/rfc-evaluation-report.json` by default. The report contains the complete policy snapshot, model identity, corpus and policy digests, an authoritative RFC-identifier-to-source-hash manifest, executable retrieval-case observations, retrieval traces, cache before/after and returned-source hashes, source request counts, validator behavior, cache outcomes, semantic probabilities, confidence, usage, stage timings, expected outcomes, status/verdict rates, positive-control status, and gate failures; it never writes credentials, prompts, questions beyond the committed corpus, or provider reasoning. The command exits zero for a passing gate and two for a complete report that fails review, so the same command reproducibly produces the artifact for either release decision.

The reviewed 2026-09-21 report resolved `jev-latest` exclusively to the pinned `jev-1.13.0` model and passed supported-claim precision at 100%, citation safety with zero unsafe acceptances, every deterministic retrieval case, every retrieval bound, and topic warm-cache p95 at 719 ms against the 3,000 ms target. Topic observations stayed within eight Datatracker calls, 29 upstream rows, 21 merged and semantic candidates, two selected sources, and therefore 22 questions in the largest native TypeSafe bulk request (one atomicity question plus one per candidate). The report was rejected because observed outcomes left their committed sets, the answered positive control returned `needs_review` in all three repetitions, and known-RFC warm-cache p95 was 3,534 ms against the strict 2,000 ms target. The human release owner explicitly approved recording report digest `3ce4d88e7ee0450562679342fc3f9e4a27b545ca5a2b0d0dbb9f8955efe400f1` as rejected. The durable decision is committed in `packages/rfc-core/src/precision-v2-release-decision.ts`; the compiled release attestation references that decision and matches its digest, release identity, review time, expiry, and three gate failures. Thresholds remain unchanged and uncalibrated, and automatic answers remain disabled. A later activation requires a new passing report, explicit review, a compiled accepted attestation, and explicit runtime enablement; changing the model pin likewise requires recertification.

## Configuration

Non-secret model, policy, evaluation, cache, output, and automatic-answer settings use typed defaults in the CLI composition root. They are not loaded from Varlock, dotenv, `.env` files, or ordinary environment variables. `bunfig.toml` disables Bun dotenv loading. Use explicit CLI flags for command-specific values such as cache and provider URLs; the credential store is the only authority for the TypeSafe API key. After a release attestation is reviewed and accepted, automatic answering must still be explicitly enabled and the local report must match every release-bound identity; rejected, pending, missing, stale, or tampered artifacts remain fail-closed and report `needs_review`.
