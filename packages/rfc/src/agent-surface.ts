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
 * `rfc_verify_citation` description. The MCP variant adds the secret-path and
 * resource rules; Pi has neither. Rules that bound tool calls come first and
 * the resource rule last, opening with "Skip", so a client that truncates the
 * instructions drops only guidance whose absence is already the default.
 *
 * @param surface Agent surface the instructions are delivered to.
 * @returns Paragraphs of model-facing workflow instructions.
 */
const rfcAgentInstructions = (surface: "mcp" | "pi"): string =>
  [
    `Answer published IETF RFC questions only from ${surface === "mcp" ? "this server" : "these tools"}, never from memory or another provider. Make one rfc_research call per user request, with each fact you need as its own entry in questions. Pass rfcs when you know the RFC numbers and searchTerms otherwise; both may be combined.`,
    "Answer from the returned passages and cite only the RFC and section shown. A passage marked current successor comes from the RFC that replaced the one named; say so rather than attributing it to the named RFC.",
    "When a question is not found, you may make one follow-up rfc_research call with other rfcs or searchTerms; RFC titles often differ from common names. Never re-research or re-verify returned passages. Use rfc_verify_citation only for a user-supplied quotation or an explicitly requested check.",
    `Tool errors are final: keep the typed error code and stop; never substitute memory or another provider. For a missing credential, ask the human operator to run rfc auth login; never request or accept the secret${surface === "mcp" ? " through MCP" : ""}. Never retry a successful paid call over a usage-accounting warning.`,
    ...(surface === "mcp"
      ? [
          `Skip ${rfcMcpAgentReferenceUri} for ordinary research; read it only for an operational failure or a provenance, privacy, cost, or cache question.`,
        ]
      : []),
  ].join("\n");

/**
 * Cross-tool instructions sent as the MCP server's initialization instructions.
 */
export const rfcMcpInstructions = rfcAgentInstructions("mcp");

/**
 * Cross-tool instructions injected into the Pi system prompt, without the
 * MCP-only secret-path and resource rules.
 */
export const rfcPiInstructions = rfcAgentInstructions("pi");

/**
 * Model-facing tool parameter descriptions shared by the MCP and Pi schemas.
 */
export const rfcAgentParameterDescriptions = {
  questions:
    "One to four questions, one per fact you need; each is answered independently from the same RFCs",
  question: "One self-contained question",
  rfcs: "One to four published RFC identifiers to search, for example RFC9110; their current successors are searched too",
  rfc: "Exact published RFC identifier, for example RFC9110",
  searchTerms:
    "One to four ordered topic-discovery terms for finding RFCs whose numbers you do not know; preserve caller order. Terms reach upstream logs, so never include private or user-specific details. Standard technical terms, including title words of an RFC you expect to match, are fine; never send a full question as a term unless the user explicitly chose it.",
  searchTerm:
    'Deliberate topic-discovery term sent verbatim in Datatracker query URLs and upstream logs. Matched as a literal case-insensitive substring of an RFC title or abstract, so use a short noun phrase such as "DNS over TLS"; a sentence fragment such as "DNS over TLS default port" matches nothing.',
  citationRfc: "Exact published RFC identifier containing the quotation",
  claim: "One factual claim to check",
  quote: "Exact unchanged RFC quotation",
  offset:
    "Absolute UTF-8 byte offset copied from a research quote range; omit for a unique quotation",
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
  research: {
    name: "rfc_research",
    title: "Research RFCs",
    description:
      "Inputs: questions (1-4) plus rfcs and/or searchTerms (1-4 each). Ranks the named RFCs, their current successors, and topic matches, then returns for each question the exact paragraphs that answer it with RFC, section, verdict (supports, partial, says_nothing, contradicts), and UTF-8 byte range, or the RFCs that did not contain an answer.",
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
