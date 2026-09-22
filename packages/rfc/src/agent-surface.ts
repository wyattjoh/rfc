/**
 * Static URI for the complete model-facing RFC workflow reference.
 */
export const rfcMcpAgentReferenceUri = "rfc://docs/agent-workflow" as const;

/**
 * Cross-tool instructions shared by MCP and native agent integrations.
 */
export const rfcMcpInstructions = `For an ordinary known-RFC answer, call rfc_research_known_rfc exactly once, then answer and stop. Do not call rfc_verify_citation after research to re-check returned evidence, including when status is needs_review. Do not run preflight tools. Do not read the agent-workflow resource.

Use this server as the complete backend for published IETF RFC questions. Do not answer RFC claims from memory or another provider. When the RFC identifier is unknown, call rfc_research_topic with { question, searchTerms } using one to four deliberate ordered technical terms. Use rfc_verify_citation only when the user supplied a quotation or explicitly requested a distinct paraphrase check.

For one simple atomic question, call one research tool once. Only when that result contains neither usable accepted evidence nor a review candidate may you make at most one targeted follow-up research call. Do not rephrase valid results to chase answered status or higher confidence. For up to two explicit independent questions, keep them as separate research calls; do not invent a split for an ambiguous request.

Topic search terms are transmitted verbatim in Datatracker URLs and may appear in upstream logs; never derive hidden terms or send the full question as a search term unless the user explicitly chose it.

Preserve research status exactly: answered, partial, unsupported, needs_review, or needs_split. Accepted evidence may support an answer. A review candidate is canonical but unaccepted and must be quoted only as qualified review material. Keep requested and current RFC contexts distinct and never silently substitute a successor.

Exact reproduction of accepted evidence needs no citation call. Verify at most two paraphrased claims once each with rfc_verify_citation, using the exact returned quote and its UTF-8 byte offset. If a direct verification verdict is fabricated, use at most one research call to locate current wording and one verification call for that replacement. Never guess wording or offsets. Unsupported, contradicted, or fabricated verdicts cannot support an unqualified claim.

Operational tool errors are not research statuses. Preserve their typed error code and stop rather than substituting stale text, another provider, or memory. If a tool error reports a missing credential, ask the human operator to run rfc auth login; never request or accept the secret through MCP. A usage-accounting warning follows a successful paid operation and must not trigger a retry.

Do not read the agent-workflow resource for ordinary research. Read ${rfcMcpAgentReferenceUri} only when handling a non-answer status, operational failure, citation-repair workflow, or a provenance, privacy, cost, or cache question.`;

const rfcAgentToolAnnotations = {
  semantic: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  localRead: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  localRemove: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

/**
 * Shared model-facing metadata for the MCP server and native agent integrations.
 */
export const rfcAgentToolMetadata = {
  researchKnownRfc: {
    name: "rfc_research_known_rfc",
    title: "Research a known RFC",
    description:
      "Inputs: question, rfc. Research one atomic question against a known published RFC. If evidence or a review candidate is returned, answer from it without a verification call. Includes bounded RFC currency traversal, provenance, status, and diagnostics.",
    annotations: rfcAgentToolAnnotations.semantic,
  },
  researchTopic: {
    name: "rfc_research_topic",
    title: "Discover and research RFCs",
    description:
      "Inputs: question, searchTerms (1-4). Research one atomic topic question. If evidence or a review candidate is returned, answer from it without a verification call. Terms are sent verbatim to Datatracker; results include provenance, status, and diagnostics.",
    annotations: rfcAgentToolAnnotations.semantic,
  },
  verifyCitation: {
    name: "rfc_verify_citation",
    title: "Verify an RFC citation",
    description:
      "Inputs: rfc, claim, quote; optional offset. Check one factual claim against one exact RFC quotation. Returns a verified, unsupported, contradicted, or fabricated verdict with canonical provenance.",
    annotations: rfcAgentToolAnnotations.semantic,
  },
  sourceCacheStatus: {
    name: "rfc_source_cache_status",
    title: "Inspect an RFC source cache entry",
    description:
      "Input: rfc. Inspect one named canonical RFC source-cache entry locally without network access.",
    annotations: rfcAgentToolAnnotations.localRead,
  },
  sourceCacheRemove: {
    name: "rfc_source_cache_remove",
    title: "Remove an RFC source cache entry",
    description:
      "Inputs: rfc, confirm=true. Remove one named canonical RFC source-cache entry locally without network access; never performs bulk removal.",
    annotations: rfcAgentToolAnnotations.localRemove,
  },
  authStatus: {
    name: "rfc_auth_status",
    title: "Inspect RFC provider credential status",
    description:
      "No inputs. Report only whether the stable TypeSafe credential identity is configured. Never returns, accepts, adds, or removes the credential.",
    annotations: rfcAgentToolAnnotations.localRead,
  },
} as const;
