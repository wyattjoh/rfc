---
name: rfc-lookup
description: Answer questions about published IETF RFCs from exact authoritative source text through the linked typed `rfc` CLI. Use for RFC requirements, definitions, procedures, updates, obsoletions, or citations.
argument-hint: "[RFC number or question]"
---

# RFC lookup

Use the linked `rfc` binary as the complete RFC research backend. The CLI owns
catalog discovery, source retrieval, evidence selection, RFC currency, and
citation verification. Compose only a short answer from the accepted evidence;
never answer an RFC question from memory or a second provider.

## Install and link the CLI

The CLI is the private `@wyattjoh/rfc` Bun workspace in this repository. From
the repository checkout:

```sh
bun install --frozen-lockfile
bun run build
(cd packages/rfc && bun link --global)
```

Make sure Bun's global bin directory is on `PATH` (`~/.bun/bin` on the usual
Bun installation), then verify the linked binary directly:

```sh
rfc --help
```

A Bun consumer can instead register the workspace with `bun link` and link
`@wyattjoh/rfc` into its local project. The skill's automation contract is the
`rfc` executable, not a legacy script or an embedded library call.

## Authenticate once with Bun.secrets

The TypeSafe key is stored only through Bun's OS credential manager. It is
never an argv value, an environment-variable authority, a repository file, or
part of output.

```sh
rfc auth status
rfc auth add
rfc auth remove
```

`auth add` uses a masked TTY prompt. For automation, read one protected,
single-line key from standard input without putting it in shell history:

```sh
cat /path/to/a/protected-key-file | rfc auth add --stdin
```

`--from-stdin` is an alias for `--stdin`. `auth status` reports only
`configured`, `service`, and `name`; `auth remove` reports only safe metadata.
The supported platform stores are macOS Keychain, Linux Secret Service
(libsecret, including GNOME Keyring or KWallet), and Windows Credential Manager.
The relevant service must be available and unlocked. If it is denied
or unavailable, report the typed credential error; do not bypass Bun.secrets
with `.env`, dotenv, Varlock, an argv flag, or a different provider.

## Preflight the catalog

Before semantic research, inspect the local seven-day metadata catalog:

```sh
rfc catalog status
```

If it is missing or stale, refresh it and retry the status check:

```sh
rfc catalog refresh
rfc catalog status
```

Catalog refresh is the only supported recovery for stale metadata. If refresh
fails, stop with the typed error and do not use stale results or answer from
recall. Catalog and source caches contain public RFC material only; questions,
semantic responses, and composed answers are not persisted.

## Versioned semantic protocol

Use JSON standard input for every automation request. The JSON input is
versioned with `schemaVersion: 1`; when standard input is non-empty it takes
precedence over convenience flags. Keep JSON output as the default and inspect
only standard output on success. A valid research status is a successful
process result even when the status is not `answered`.

### Research one atomic question

Known-RFC research supplies the RFC hint and skips document discovery:

```sh
cat <<'JSON' | rfc research
{
  "schemaVersion": 1,
  "question": "What does RFC 9110 require a client to send?",
  "rfc": "RFC9110"
}
JSON
```

A topic-only question sets `rfc` to `null`; the catalog discovers and ranks
published RFC candidates:

```sh
cat <<'JSON' | rfc research
{
  "schemaVersion": 1,
  "question": "Which published RFC defines HTTP caching requirements?",
  "rfc": null
}
JSON
```

The result is a versioned `evidence_bundle` containing `status`, exact
`evidence` passages, optional requested/current `contexts`, and bounded
`diagnostics`. Each evidence passage has a `relation`, an unchanged `quote`,
and `provenance` with RFC identity, nullable best-effort `section`, canonical
URLs, source hash, `offsetUnit`, and UTF-8 byte `startOffset`/`endOffset`.
Offsets are bytes in the hashed RFC Editor source, not JavaScript string
indices.

When the user supplies multiple explicit, independently answerable questions,
run one `rfc research` process per atomic question. Independent invocations may
run concurrently, but each input and output must remain separate. Do not merge
questions into one broad request and do not invent a split for an ambiguous
question.

### Verify every claim before presenting it

After selecting evidence, make one citation request for every factual claim in
the short answer. Use the exact evidence quote and its `provenance.startOffset`
when available; this disambiguates repeated quotations:

```sh
cat <<'JSON' | rfc verify-citation
{
  "schemaVersion": 1,
  "rfc": "RFC9110",
  "claim": "The client sends a request containing the target resource.",
  "quote": "The client MUST send a request containing the target resource.",
  "offset": 12345
}
JSON
```

`verify-citation` first locates the quotation deterministically in the
authoritative RFC Editor source. Its result is a versioned
`citation_verification` value with a `verdict`, exact provenance, probabilities,
confidence, and diagnostics. A missing quotation is `fabricated` without a
semantic judgment. A repeated quotation without the exact byte offset is a
typed `citation_quote_ambiguous` failure.

Only `verified` supports an unqualified factual claim. Remove or explicitly
qualify claims whose verdict is `unsupported`, `contradicted`, or `fabricated`;
never replace the gap with recall. Present each accepted normative claim with
its unchanged exact quote, RFC identifier, section when non-null, byte offsets,
and canonical source URL. Do not tidy whitespace, repair wording, or generate a
quote from a summary. Keep the final prose brief and agent-owned; evidence
selection and citation verification are TypeSafe-owned.

## Fail-closed statuses and failures

Report the research status exactly as returned:

- `answered`: at least one accepted direct answer and no disqualifying
  uncertainty or contradiction. Compose only from accepted passages.
- `partial`: only part of the question is established, or safe coverage is
  incomplete. State the gap and qualify the answer.
- `unsupported`: the bounded search completed without accepted answering
  evidence. Say what was searched; do not speculate.
- `needs_review`: confidence is low, evidence conflicts, or RFC currency is
  uncertain. Do not present a definitive answer.
- `needs_split`: the question is compound. Ask for atomic questions, unless the
  user already supplied those explicit subquestions and they can be researched
  independently.

When an RFC has `updates` or `obsoletes` relationships, distinguish the
requested context from each `current` context. Use the returned
`relationshipPath`, `isCurrent`, and currency report; never silently substitute
the current RFC for the requested one. If successor coverage is unavailable or
wording conflicts, preserve the returned `partial` or `needs_review` status.

On a nonzero exit, parse the versioned JSON error envelope from standard error
and stop. Common recovery actions are:

| Code                                                               | Recovery                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `invalid_input`                                                    | Correct the version-one JSON or required fields.                                             |
| `credential_missing`                                               | Run `rfc auth add` or `rfc auth add --stdin`.                                                |
| `credential_store_unavailable` / `credential_access_denied`        | Start/unlock or authorize the OS credential store; never use a plaintext fallback.           |
| `catalog_read_failed` / `catalog_refresh_failed` / `catalog_stale` | Retry the catalog preflight; do not research with stale metadata.                            |
| `source_cache_failed` / `source_fetch_failed`                      | Retry the authoritative source operation; do not substitute HTML or another source.          |
| `rfc_not_found`                                                    | Correct the exact published RFC identifier or rerun with `"rfc": null`.                      |
| `decision_model_failed`                                            | Report provider failure after the CLI's bounded retries; do not fall back to a larger model. |
| `citation_quote_ambiguous` / `citation_offset_mismatch`            | Supply the exact UTF-8 byte offset from the evidence provenance.                             |
| `internal_error` / `configuration_error`                           | Report an operational failure rather than asserting an answer.                               |

Never turn an operational failure into a research status, and never turn a
fail-closed status into an affirmative answer.

## Verification boundaries

The normal repository gates are deterministic: they inject RFC sources,
DecisionModel responses, and the credential boundary. They must not contact the
network or TypeSafe, call the provider, or read the real OS credential store.
Live provider evaluation is opt-in only and uses the same Bun.secrets boundary
as production; it is never a normal test or a reason to weaken a fail-closed
result.

## Required scenarios

Use these scenarios when exercising or reviewing the skill workflow:

1. **Known RFC:** pass an RFC hint, preserve exact selected evidence, and verify
   each composed claim.
2. **Topic discovery:** pass `"rfc": null`, preflight the catalog, and report
   the discovered RFC and evidence only if the returned status permits it.
3. **Compound request:** split only explicit independent subquestions into
   separate JSON requests; otherwise report `needs_split`.
4. **Obsolete or updated RFC:** show requested and current contexts and their
   relationship paths; do not silently replace historical text.
5. **Unsupported question:** report `unsupported` and the evidence gap without
   recall.
6. **Provider failure:** preserve the typed nonzero error and stop; do not use a
   larger-model or network-independent fallback.
7. **Citation rejection:** remove or qualify claims rejected as unsupported,
   contradicted, or fabricated, and retain only exact verified citations.

The linked typed CLI and this skill are the supported RFC workflow. Legacy
retrieval paths are not part of the workflow.
