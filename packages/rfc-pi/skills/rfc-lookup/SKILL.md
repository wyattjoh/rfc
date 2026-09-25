---
name: rfc-lookup
description: Answer questions about published IETF RFCs from exact authoritative source text through the self-describing RFC MCP or linked typed `rfc` CLI. Use for RFC requirements, definitions, procedures, updates, obsoletions, or citations. Make one rfc_research call per user request with each fact as its own question, answer from the returned passages, and make at most one follow-up call when a question is not found.
argument-hint: "[RFC number or question]"
---

# RFC lookup

Use the RFC MCP when its tools are available; otherwise use the linked `rfc`
binary. Both are complete RFC retrieval backends: they own live RFC discovery,
RFC currency, canonical source retrieval, relevance ranking, passage selection,
and citation verification. The tool finds the RFCs and exact paragraphs that
bear on each question; you do the reasoning and write the answer. Never answer
from memory or a second provider.

## Self-describing MCP surface

Launch the local stdio server with `rfc mcp`. A model connected through MCP does
not need this skill or direct CLI access: initialization instructions contain the
workflow, and `rfc://docs/agent-workflow` contains the complete agent reference.
The typed tools are `rfc_research`, `rfc_verify_citation`, `rfc_source_text`,
`rfc_source_cache_status`, `rfc_source_cache_remove`, and `rfc_auth_status`.

Successful calls return concise text plus complete version-three structured
content. Operational failures are MCP tool errors containing the same safe error
envelope as the CLI. A question that was not found and a citation verdict are
domain results, not tool failures. `rfc_source_cache_remove` requires
`confirm: true`.

The MCP deliberately excludes credential mutation and per-call cache or upstream
URL overrides. If `rfc_auth_status` or a tool error reports a missing credential, ask
the human operator to run `rfc auth login`; never solicit a key through MCP. Trusted
cache and upstream overrides may be set only when the operator launches
`rfc mcp`.

## Workflow

Use the typed MCP tools directly when available. Otherwise use `rfc` directly;
do not resolve its installation path, invoke its TypeScript entrypoint with
`bun`, read source-cache internals, or use shell loops to probe wording and
offsets.

1. Make one `rfc_research` call, or one `rfc research` fallback call, per user
   request. Put each fact you need in `questions` as its own entry, up to four.
   Each question is answered independently against the same candidate RFCs, so
   split a compound request yourself rather than sending it as one question.
2. Pass `rfcs` when you know the RFC numbers and `searchTerms` when you do not;
   both may be combined. Named RFCs, their current successors, and topic hits
   form one candidate pool.
3. Answer from the returned passages. Cite only the RFC and section shown with
   each passage; do not attribute a passage to a section or RFC it did not come
   from.
4. When a question is not found, you may make one follow-up call with other
   `rfcs` or `searchTerms`; RFC titles often differ from common names. Then
   stop and report what was searched.
5. Never re-research or re-verify returned passages. Reproducing or paraphrasing
   a returned passage needs no citation call.

A passage from a hit whose role is `current` comes from the RFC that replaced
the one named. Say so rather than attributing it to the named RFC, and never
silently substitute a successor. `currency` reports, per named RFC, `requested`,
its `current` successors, `complete`, and the relationship `paths` that led to
them. When `complete` is false, a successor was unresolved or cut off by a
traversal bound (the concise text says "incomplete: some successors were not
fetched"); say that the successor list may be partial rather than presenting it
as final.

Use MCP's concise text content for agent-facing calls; the complete result also
remains available as structured content. For the CLI fallback, argument-based
invocations already print the concise human layout. Use CLI JSON only when code
needs to extract a specific field, and summarize it before returning it to model
context.

## Search-term privacy

Search terms are transmitted verbatim in Datatracker query URLs, and to the IETF
RFC search service when the operator enabled it, and may appear in diagnostics,
errors, and upstream access logs. Never put private or user-specific details in
a term, derive hidden terms, or send the full question as a term unless the user
explicitly chose it. Standard technical terms, including title words of an RFC
you expect to match, are fine. Preserve the caller's order.

Datatracker matches each term as a literal case-insensitive substring of an RFC
title or abstract. A short noun phrase such as `DNS over TLS` finds documents; a
sentence fragment such as `DNS over TLS default port` matches nothing, because
no title or abstract contains that exact string.

If the operator enabled optional full-text search, terms additionally match RFC
keywords and body text, so a term naming a protocol element such as
`Retry-After` also resolves. Write terms that work under either configuration.
When `retrieval.topicSearchFallback` is true, full-text search was configured but
failed and discovery ran on titles and abstracts alone, so an empty result is
less conclusive than usual.

## Install and link the CLI

From the repository checkout:

```sh
bun install --frozen-lockfile
bun run build
(cd packages/rfc && bun link)
rfc --help
```

The MCP contract is the `rfc mcp` stdio process and its advertised metadata. The
CLI fallback contract is the `rfc` executable, not a legacy script, its resolved
installation path, or an embedded library call.

## Authenticate once with Bun.secrets

The TypeSafe key is stored only through Bun's OS credential manager. It is never
an argv value, environment-variable authority, repository file, or output.

```sh
rfc auth
rfc auth login
rfc auth remove
```

`auth login` uses a masked TTY prompt. Automation may pipe one protected,
single-line key through `rfc auth login --stdin`. If the credential store is
unavailable or denied, report the typed error; do not bypass `Bun.secrets` with
a plaintext fallback.

## Version-three CLI protocol

Use flags for normal agent work and JSON standard input only when programmatic
extraction or a multiline quote requires it. Non-whitespace standard input is
authoritative over flags and positional arguments, and it defaults to JSON
output. Argument-based invocations default to human output; pass
`--format json` only for programmatic extraction.

### Research

Repeat `-q`/`--question` once per fact, and add `-r`/`--rfc` or
`--search-term` up to four times each:

```sh
rfc research \
  -q "What does the 429 status code mean?" \
  -q "Which header says how long to wait?" \
  -r RFC6585 -r RFC9110

rfc research \
  -q "Which port does DNS over TLS use by default?" \
  --search-term "DNS over TLS"
```

The same request as JSON on standard input:

```sh
cat <<'JSON' | rfc research --format human
{
  "schemaVersion": 3,
  "questions": [
    "What does the 429 status code mean?",
    "Which header says how long to wait?"
  ],
  "rfcs": ["RFC6585", "RFC9110"]
}
JSON
```

`questions` holds one to four entries; at least one of `rfcs` or `searchTerms`
is required, each with one to four entries.

The result is a version-three `research_result`. For each question, `answers`
reports `found`, the `searched` RFCs, and ranked `hits`. Each hit names its
`rfc`, its `role` (`requested`, `current`, or `discovered`), its `relevance`,
a `verdict`, and one to three exact `passages`. Verdicts are:

- `supports`: the passage states the answer or directly implies it.
- `partial`: the passage answers only part of the question.
- `says_nothing`: the passage does not address the question.
- `contradicts`: the passage states the opposite of what the question presumes.

Each passage includes an unchanged quote, its nullable section, and provenance
with the canonical source URL, source hash, `offsetUnit`, and UTF-8 byte
offsets. `found: false` means none of the `searched` RFCs contained an answer;
it is a successful result, not a failure.

`diagnostics.usage.inputTokens` reports the provider-observed input tokens, while
`diagnostics.inputCost` reports the estimated USD charge and its per-million-token
rate. Treat a null estimate as unavailable rather than zero cost. Each successful
research or citation operation atomically updates the per-user running total in
`~/.config/rfc/usage.json`; its unpriced and missing-usage counters qualify the
cumulative estimate. Metadata, relationships, candidate pools, questions, and
model responses are request-local and are not persisted.

### Verify a supplied quotation

Use `rfc_verify_citation` or `rfc verify-citation` only for a quotation the user
supplied or a check the user explicitly requested; it needs no research
preflight. Never verify passages research already returned.

```sh
cat <<'JSON' | rfc verify-citation --format human
{
  "schemaVersion": 3,
  "rfc": "RFC9110",
  "claim": "The client sends a request containing the target resource.",
  "quote": "The client MUST send a request containing the target resource.",
  "offset": 12345
}
JSON
```

Verify at most two paraphrased claims, once each. Never guess or brute-force
byte offsets: copy an offset from research provenance, or omit it when the quote
occurs only once. If the quote is `fabricated`, use at most one research call to
locate current wording and at most one verification call for the replacement.
Remove or qualify claims whose verdict is `unsupported`, `contradicted`, or
`fabricated`; never repair quote wording or replace a gap with recall.

## Exact RFC source text

Use `rfc_source_text` or `rfc source-text` only when the full RFC text is explicitly
required or requested; otherwise prefer `rfc_research` and `rfc_verify_citation`.
An identifier-only call returns the authoritative source hash, total UTF-8 bytes,
and parsed headings with half-open byte ranges, but no text. Request the exact
untruncated text with both `startOffset` (inclusive) and `endOffset` (exclusive),
using citation ranges or heading ranges directly. On later calls provide the
`expectedSourceHash` from the initial response; if the cached source is
revalidated and changes, start again from fresh metadata instead of mixing
snapshots. A full RFC can be read with the range `[0,totalBytes)`, although
large results consume substantial context.

```sh
rfc source-text RFC9110 --format json
rfc source-text RFC9110 --start-offset 0 --end-offset 2048 --expected-source-hash <hash>
```

## RFC source-cache operations

Canonical RFC Editor text is cached only after that RFC is requested. Inspect or
remove one named entry without network access:

```sh
rfc cache status RFC9110
rfc cache remove RFC9110
```

There is no list-all, refresh-all, download-all, prefetch, or bulk-clear
operation. Fresh entries are reused; stale entries are conditionally revalidated.
A revalidation failure is an operational error, never permission to serve stale
text.

## Failures

Tool errors are final. On a nonzero exit, parse the version-three JSON error
envelope from standard error, report the code, and stop; never substitute memory
or another provider. Never retry a successful paid call over a
`usage_accounting_failed` warning. Common recovery actions:

| Code                                                                         | Recovery                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `invalid_input`                                                              | Correct the version-three JSON, RFC identifiers, or ordered search terms.                        |
| `credential_missing`                                                         | Ask the human operator to run `rfc auth login`; never request or accept the secret.              |
| `credential_store_unavailable` / `credential_access_denied`                  | Unlock or authorize the OS store; never use plaintext fallback.                                  |
| `discovery_failed`                                                           | Report the Datatracker failure and URL; do not use stale or invented metadata.                   |
| `source_cache_failed` / `source_fetch_failed` / `source_revalidation_failed` | Report the authoritative source failure; do not substitute another representation or stale text. |
| `rfc_not_found`                                                              | Correct the exact RFC identifier or use `searchTerms`.                                           |
| `decision_model_failed`                                                      | Report provider failure after bounded retries; do not switch providers or models.                |
| `citation_quote_ambiguous` / `citation_offset_mismatch`                      | Never guess. Copy the exact UTF-8 byte offset from research provenance, or stop if none exists.  |
| `internal_error` / `configuration_error`                                     | Report an operational failure instead of asserting an answer.                                    |

A question that was not found is not an operational failure and must not
trigger a rephrasing loop beyond the one follow-up call.

## Verification boundaries

Normal repository gates are deterministic and offline. They inject Datatracker,
RFC Editor, DecisionModel, clock, and credential behavior at public boundaries.

## Required scenarios

1. **Known RFC:** pass `rfcs`, answer from the returned passages, and cite the
   RFC and section shown.
2. **Topic discovery:** pass one to four explicit `searchTerms` and answer only
   from returned passages.
3. **Several facts:** put each fact in its own entry in `questions` in one call.
4. **Updated RFC:** keep `current` hits distinct from the named RFC and report
   the currency path.
5. **Not found:** make at most one follow-up call, then report what was searched
   without recall.
6. **Provider or upstream failure:** preserve the typed error and stop.
7. **Supplied quotation:** verify it once and remove or qualify rejected claims.

The linked typed CLI and this skill are the supported RFC workflow.
