---
name: rfc-lookup
description: Answer questions about published IETF RFCs from exact authoritative source text through the linked typed `rfc` CLI. Use for RFC requirements, definitions, procedures, updates, obsoletions, or citations.
argument-hint: "[RFC number or question]"
---

# RFC lookup

Use the linked `rfc` binary as the complete RFC research backend. The CLI owns
live RFC discovery, source retrieval, evidence selection, RFC currency, and
citation verification. Compose only a short answer from accepted evidence;
never answer an RFC question from memory or a second provider.

## Install and link the CLI

From the repository checkout:

```sh
bun install --frozen-lockfile
bun run build
(cd packages/rfc && bun link --global)
rfc --help
```

The skill's automation contract is the `rfc` executable, not a legacy script or
an embedded library call.

## Authenticate once with Bun.secrets

The TypeSafe key is stored only through Bun's OS credential manager. It is never
an argv value, environment-variable authority, repository file, or output.

```sh
rfc auth status
rfc auth add
rfc auth remove
```

`auth add` uses a masked TTY prompt. Automation may pipe one protected,
single-line key through `rfc auth add --stdin`. If the credential store is
unavailable or denied, report the typed error; do not bypass `Bun.secrets` with
a plaintext fallback.

## Version-two semantic protocol

Use JSON standard input for automation. Non-whitespace standard input is
authoritative over convenience flags. JSON is the default output. A valid
research status is a successful process result even when it is not `answered`.

### Research one known RFC

```sh
cat <<'JSON' | rfc research
{
  "schemaVersion": 2,
  "question": "What does RFC 9110 require a client to send?",
  "rfc": "RFC9110"
}
JSON
```

Known-RFC research retrieves only the requested RFC's metadata and the bounded
successor relationships needed for RFC currency.

### Discover RFCs for a topic

A topic request sets `rfc` to `null` and supplies one to four ordered, non-empty
search terms. Supply the technical phrases intentionally; they are transmitted
verbatim in Datatracker query URLs and may appear in upstream access logs. The
full natural-language question is not sent to Datatracker.

```sh
cat <<'JSON' | rfc research
{
  "schemaVersion": 2,
  "question": "Which published RFC defines HTTP caching requirements?",
  "rfc": null,
  "searchTerms": ["HTTP caching", "cache control"]
}
JSON
```

The short form uses repeatable `--search-term` flags with `--question`. Do not
generate hidden terms, rewrite phrases, or infer a broad query from the question.

The result is a version-two `evidence_bundle` containing `status`, exact
`evidence`, optional requested/current `contexts`, and bounded `diagnostics`.
Each evidence passage includes an unchanged quote and provenance with RFC
identity, nullable section, canonical URLs, source hash, `offsetUnit`, and UTF-8
byte offsets. Metadata, relationships, candidate collections, questions, and
model responses are request-local and are not persisted.

When the user supplies multiple explicit, independently answerable questions,
run one `rfc research` process per atomic question. Keep each input and output
separate. Do not merge questions or invent a split for an ambiguous request.

### Verify every claim

Make one citation request for every factual claim in the short answer. Use the
exact evidence quote and its `provenance.startOffset` when available:

```sh
cat <<'JSON' | rfc verify-citation
{
  "schemaVersion": 2,
  "rfc": "RFC9110",
  "claim": "The client sends a request containing the target resource.",
  "quote": "The client MUST send a request containing the target resource.",
  "offset": 12345
}
JSON
```

Only `verified` supports an unqualified factual claim. Remove or qualify claims
whose verdict is `unsupported`, `contradicted`, or `fabricated`. Present each
accepted normative claim with its unchanged quote, RFC identifier, section when
available, byte offsets, and canonical source URL. Never repair quote wording or
replace an evidence gap with recall.

## RFC source-cache operations

Canonical RFC Editor text is cached only after that RFC is requested. Inspect or
remove one named entry without network access:

```sh
rfc cache status --rfc RFC9110
rfc cache remove --rfc RFC9110
```

There is no list-all, refresh-all, download-all, prefetch, or bulk-clear
operation. Fresh entries are reused; stale entries are conditionally revalidated.
A revalidation failure is an operational error, never permission to serve stale
text.

## Fail-closed statuses and failures

Report research status exactly:

- `answered`: accepted direct evidence with no disqualifying uncertainty.
- `partial`: only part of the question or currency coverage is established.
- `unsupported`: bounded research found no accepted answering evidence.
- `needs_review`: confidence is low, evidence conflicts, discovery is empty, or
  RFC currency is uncertain.
- `needs_split`: the question is compound and requires atomic questions.

Keep requested and current RFC contexts distinct. Follow returned
`relationshipPath`, `isCurrent`, and currency diagnostics; never silently
substitute a successor for the requested RFC.

On a nonzero exit, parse the version-two JSON error envelope from standard error
and stop. Common recovery actions:

| Code                                                                         | Recovery                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `invalid_input`                                                              | Correct the version-two JSON, RFC, or ordered search terms.                                       |
| `credential_missing`                                                         | Run `rfc auth add` or `rfc auth add --stdin`.                                                     |
| `credential_store_unavailable` / `credential_access_denied`                  | Unlock or authorize the OS store; never use plaintext fallback.                                   |
| `discovery_failed`                                                           | Report the Datatracker failure and URL; do not use stale or invented metadata.                    |
| `source_cache_failed` / `source_fetch_failed` / `source_revalidation_failed` | Retry the authoritative source operation; do not substitute another representation or stale text. |
| `rfc_not_found`                                                              | Correct the exact RFC identifier or make a topic request with explicit search terms.              |
| `decision_model_failed`                                                      | Report provider failure after bounded retries; do not switch providers or models.                 |
| `citation_quote_ambiguous` / `citation_offset_mismatch`                      | Supply the exact UTF-8 byte offset from provenance.                                               |
| `internal_error` / `configuration_error`                                     | Report an operational failure instead of asserting an answer.                                     |

Never turn an operational failure into a research status or a fail-closed status
into an affirmative answer.

## Verification boundaries

Normal repository gates are deterministic and offline. They inject Datatracker,
RFC Editor, DecisionModel, clock, and credential behavior at public boundaries.
Live provider evaluation is opt-in and uses the same `Bun.secrets` boundary as
production.

## Required scenarios

1. **Known RFC:** pass an RFC hint, preserve exact evidence, and verify each claim.
2. **Topic discovery:** pass one to four explicit search terms and report evidence
   only when the returned status permits it.
3. **Compound request:** split only explicit independent subquestions; otherwise
   preserve `needs_split`.
4. **Updated RFC:** show requested and current contexts and relationship paths.
5. **Unsupported question:** report the evidence gap without recall.
6. **Provider or upstream failure:** preserve the typed nonzero error and stop.
7. **Citation rejection:** remove or qualify rejected claims and retain only exact
   verified citations.

The linked typed CLI and this skill are the supported RFC workflow.
