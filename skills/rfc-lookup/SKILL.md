---
name: rfc-lookup
description: Answer questions about published IETF RFCs from exact authoritative source text through the self-describing RFC MCP or linked typed `rfc` CLI. Use for RFC requirements, definitions, procedures, updates, obsoletions, or citations. For one atomic question, never exceed two research calls and two citation calls, never loop by rephrasing a valid result, and preserve the status of qualified review candidates.
argument-hint: "[RFC number or question]"
---

# RFC lookup

Use the RFC MCP when its tools are available; otherwise use the linked `rfc`
binary. Both are complete RFC research backends and own live RFC discovery,
source retrieval, evidence selection, RFC currency, and citation verification.
Compose only a short answer from returned canonical passages, preserving whether
each passage is accepted evidence or a qualified review candidate; never answer
from memory or a second provider.

## Self-describing MCP surface

Launch the local stdio server with `rfc mcp`. A model connected through MCP does
not need this skill or direct CLI access: initialization instructions contain the
bounded workflow, and `rfc://docs/agent-workflow` contains the complete agent
reference. The typed tools are `research_known_rfc`, `research_topic`,
`verify_citation`, `source_cache_status`, `source_cache_remove`, and
`auth_status`.

Successful calls return concise text plus complete version-two structured
content. Operational failures are MCP tool errors containing the same safe error
envelope as the CLI. Research status and citation verdict remain domain results,
not tool failures. `source_cache_remove` requires `confirm: true`.

The MCP deliberately excludes credential mutation and per-call cache or upstream
URL overrides. If `auth_status` or a tool error reports a missing credential, ask
the human operator to run `rfc auth add`; never solicit a key through MCP. Trusted
cache and upstream overrides may be set only when the operator launches
`rfc mcp`.

## Bounded agent workflow

Use the typed MCP tools directly when available. Otherwise use `rfc` directly;
do not resolve its installation path, invoke its TypeScript entrypoint with
`bun`, read source-cache internals, or use shell loops to probe wording and
offsets.

For each simple atomic user question, use this hard budget:

1. Call `research_known_rfc` or `research_topic` once, or run one
   `rfc research --format human` fallback call.
2. Only when that result has no usable evidence, run at most one targeted
   follow-up research call. Do not repeatedly rephrase a valid result to chase
   `answered` or a higher confidence.
3. If the result includes accepted evidence, quote it directly with provenance.
   If it includes a review candidate, quote it only as qualified, unaccepted
   evidence. Verify at most two paraphrased claims once each; exact reproduction
   of a returned passage does not require duplicate verification.
4. Stop after the budget. Do not say that no source passage was found when the
   backend returned a review candidate; report its status and qualification.
   Keep nearby protocol categories distinct rather than substituting one for
   another.

A direct quote-verification request starts with one `verify_citation` tool call
or `rfc verify-citation` fallback call and needs no research preflight. If the
quote is `fabricated`, use at most one research call to locate current wording
and at most one verification call for the replacement. Never guess or
brute-force byte offsets: copy an offset from research provenance, or omit it
when the quote occurs only once. If replacement research returns a review
candidate, report that exact candidate and its qualification instead of
re-querying for a higher score.

Use MCP's concise text content for agent-facing calls; the complete result also
remains available as structured content. For the CLI fallback, use
`--format human`. Both include status, accepted quotes, qualified review
candidates, source URLs, byte offsets, input tokens, and estimated cost without
dumping full model diagnostics into the conversation. Use CLI JSON only when
code needs to extract a specific field, and summarize it before returning it to
model context.

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
rfc auth status
rfc auth add
rfc auth remove
```

`auth add` uses a masked TTY prompt. Automation may pipe one protected,
single-line key through `rfc auth add --stdin`. If the credential store is
unavailable or denied, report the typed error; do not bypass `Bun.secrets` with
a plaintext fallback.

## Version-two semantic protocol

Use human output for normal agent work and JSON standard input only when a
multiline quote or programmatic extraction requires it. Non-whitespace standard
input is authoritative over convenience flags and positional arguments, and it
defaults to JSON output. Argument-based invocations default to human output;
pass `--format json` only for programmatic extraction. A valid research status
is a successful process result even when it is not `answered`.

### Research one known RFC

```sh
cat <<'JSON' | rfc research --format human
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
cat <<'JSON' | rfc research --format human
{
  "schemaVersion": 2,
  "question": "Which published RFC defines HTTP caching requirements?",
  "rfc": null,
  "searchTerms": ["HTTP caching", "cache control"]
}
JSON
```

The short form accepts the question positionally or through `--question`, then
uses repeatable `--search-term` flags. Preserve the caller's order. Do not generate hidden terms, rewrite phrases, infer a broad
query from the question, or run a catalog preflight: each supplied term appears
in Datatracker query URLs and can be retained in upstream access logs.

The result is a version-two `evidence_bundle` containing `status`, exact
`evidence`, optional exact `reviewCandidates`, optional requested/current
`contexts`, and bounded `diagnostics`. Review candidates are canonical source
passages surfaced only for bounded review; they are never accepted evidence and
must be labeled as qualified when quoted. Each human-rendered passage names its
RFC and whether it came from the requested or a current context. Do not answer a
question about the requested RFC with a current-context passage unless you
explicitly explain the distinction.
`diagnostics.usage.inputTokens` reports the provider-observed input tokens, while
`diagnostics.inputCost` reports the estimated USD charge and its per-million-token
rate. Treat a null estimate as unavailable rather than zero cost. Each successful
research or citation operation atomically updates the per-user running total in
`~/.config/rfc/usage.json`; its unpriced and missing-usage counters qualify the
cumulative estimate. Each evidence passage includes an unchanged quote and
provenance with RFC identity, nullable section, canonical URLs, source hash,
`offsetUnit`, and UTF-8 byte offsets.
Metadata, relationships, candidate collections, questions, and model responses
are request-local and are not persisted.

When the user supplies up to two explicit, independently answerable questions,
run one `rfc research` process per atomic question. For example, “Can the server
issue this?” and “What protections are required?” are two atomic questions even
when they share a topic. Keep each input and output separate. Do not merge
questions, split into more than two parts, or invent a split for an ambiguous
request.

### Verify accepted claims once

Keep a simple answer to at most two factual claims. Exact reproduction of a
returned passage with its status and provenance needs no duplicate citation
call. For a paraphrased claim, make one citation request, once, using the exact
returned quote and byte offset. Do not split one claim into multiple paraphrased
verification attempts:

```sh
cat <<'JSON' | rfc verify-citation --format human
{
  "schemaVersion": 2,
  "rfc": "RFC9110",
  "claim": "The client sends a request containing the target resource.",
  "quote": "The client MUST send a request containing the target resource.",
  "offset": 12345
}
JSON
```

Only accepted research evidence or a `verified` citation supports an
unqualified factual claim. A verified citation is an independent acceptance
path even when discovery was fail-closed. A review candidate may be reproduced
exactly only when explicitly labeled unaccepted or `needs_review`; do not turn it
into an unqualified paraphrase. Remove or qualify claims whose verdict is
`unsupported`, `contradicted`, or `fabricated`. Present each accepted normative
claim with its unchanged quote, RFC identifier, section when available, byte
offsets, and canonical source URL. Never repair quote wording, retry with guessed
offsets, or replace an evidence gap with recall.

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
| `citation_quote_ambiguous` / `citation_offset_mismatch`                      | Never guess. Copy the exact UTF-8 byte offset from research provenance, or stop if none exists.   |
| `internal_error` / `configuration_error`                                     | Report an operational failure instead of asserting an answer.                                     |

Never turn an operational failure into a research status or unverified
fail-closed evidence into an affirmative answer. A valid non-answer result is
not an operational failure and must not trigger a rephrasing loop.

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
