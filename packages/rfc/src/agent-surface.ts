/**
 * Static URI for the complete model-facing RFC workflow reference.
 */
export const rfcMcpAgentReferenceUri = "rfc://docs/agent-workflow" as const;

/**
 * Clients may truncate MCP server instructions; Claude Code keeps about 2 KB.
 */
export const rfcMcpInstructionsCharacterBudget = 2_000;

/**
 * Build the cross-tool workflow for one agent surface.
 *
 * Each rule is stated once. Search-term privacy lives in the `searchTerms`
 * parameter description and citation-verification limits in the
 * `rfc_verify_citation` description. The MCP variant adds the preflight,
 * secret-path, and resource rules; Pi has none of those tools or paths. Rules
 * that bound tool calls come first and the resource rule last, opening with
 * "Skip", so a client that truncates the instructions drops only guidance whose
 * absence is already the intended default.
 *
 * @param surface Agent surface the instructions are delivered to.
 * @returns Paragraphs of model-facing workflow instructions.
 */
const rfcAgentInstructions = (surface: "mcp" | "pi"): string =>
  [
    `For an ordinary known-RFC answer, call rfc_research_known_rfc exactly once, then answer and stop. Never call rfc_verify_citation to re-check research results, even under needs_review; use it only for a user-supplied quotation or an explicitly requested distinct paraphrase check.${surface === "mcp" ? " Do not run preflight tools." : ""}`,
    `Answer published IETF RFC questions only from ${surface === "mcp" ? "this server" : "these tools"}, never from memory or another provider. For an unknown RFC, call rfc_research_topic with one to four deliberate ordered technical search terms.`,
    "One simple atomic question gets one research call; only if it has neither usable accepted evidence nor a review candidate may you make at most one targeted follow-up. Never rephrase valid results to chase answered status or higher confidence. Research up to two explicit independent questions in separate calls; do not invent a split for an ambiguous request.",
    "Preserve the research status exactly. Accepted evidence may support an answer; quote a review candidate (canonical but unaccepted) only as qualified review material. Keep requested and current RFC contexts distinct; never silently substitute a successor.",
    "needs_split is an instruction, not a failure. The result names the RFC it selected and returns the canonical review candidates it already retrieved. Split the request yourself into one atomic question per requested fact, then research each in its own call against that RFC; the one-follow-up budget applies per sub-question, not to the compound request. Never rephrase and retry the compound request, never re-research an RFC this session already researched, and never refuse the whole request when the result already carries usable material.",
    `Tool errors are not research statuses: keep the typed error code and stop; never substitute stale text, another provider, or memory. For a missing credential, ask the human operator to run rfc auth login; never request or accept the secret${surface === "mcp" ? " through MCP" : ""}. Never retry a successful paid operation over a usage-accounting warning.`,
    ...(surface === "mcp"
      ? [
          `Skip ${rfcMcpAgentReferenceUri} for ordinary research; read it only for a non-answer status, operational failure, citation repair, or a provenance, privacy, cost, or cache question.`,
        ]
      : []),
  ].join("\n");

/**
 * Cross-tool instructions sent as the MCP server's initialization instructions.
 */
export const rfcMcpInstructions = rfcAgentInstructions("mcp");

/**
 * Cross-tool instructions injected into the Pi system prompt, without the
 * MCP-only preflight, secret-path, and resource rules.
 */
export const rfcPiInstructions = rfcAgentInstructions("pi");

/**
 * Model-facing tool parameter descriptions shared by the MCP and Pi schemas.
 */
export const rfcAgentParameterDescriptions = {
  knownQuestion: "One independently answerable RFC question",
  topicQuestion: "One independently answerable topic question",
  rfc: "Exact published RFC identifier, for example RFC9110",
  searchTerms:
    "One to four ordered topic-discovery terms; preserve caller order. Terms reach upstream logs, so never include private or user-specific details. Standard technical terms, including title words of an RFC you expect to match, are fine; never send the full question as a term unless the user explicitly chose it.",
  searchTerm:
    'Deliberate topic-discovery term sent verbatim in Datatracker query URLs and upstream logs. Matched as a literal case-insensitive substring of an RFC title or abstract, so use a short noun phrase such as "DNS over TLS"; a sentence fragment such as "DNS over TLS default port" matches nothing.',
  citationRfc: "Exact published RFC identifier containing the quotation",
  claim: "One factual claim to check",
  quote: "Exact unchanged RFC quotation",
  offset: "Absolute UTF-8 byte offset copied from research provenance; omit for a unique quotation",
  cacheRfc: "Exact named RFC source-cache entry, for example RFC9110",
  confirm: "Must be true to confirm removal of the named cache entry",
} as const;

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
      "Inputs: question, rfc. Research one atomic question against a known published RFC. Includes bounded RFC currency traversal, provenance, status, and diagnostics.",
    annotations: rfcAgentToolAnnotations.semantic,
  },
  researchTopic: {
    name: "rfc_research_topic",
    title: "Discover and research RFCs",
    description:
      "Inputs: question, searchTerms (1-4). Research one atomic topic question. Results include provenance, status, and diagnostics.",
    annotations: rfcAgentToolAnnotations.semantic,
  },
  verifyCitation: {
    name: "rfc_verify_citation",
    title: "Verify an RFC citation",
    description:
      "Inputs: rfc, claim, quote; optional offset. Check one factual claim against one exact RFC quotation. Returns a verified, unsupported, contradicted, or fabricated verdict with canonical provenance. Verify at most two paraphrased claims, once each, using the exact returned quote and its UTF-8 byte offset; never guess wording or offsets. If a direct verification verdict is fabricated, use at most one research call to locate current wording and one verification call for that replacement. Unsupported, contradicted, or fabricated verdicts cannot support an unqualified claim.",
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
