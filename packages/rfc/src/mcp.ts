import {
  CitationVerificationResultSchema,
  ResearchResultSchema,
  InvalidInputError,
  RfcSourceCacheRemoveResultSchema,
  RfcSourceCacheStatusSchema,
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  retrievalPolicy,
  schemaVersion,
  type CitationVerificationResult,
  type ResearchResult,
} from "@wyattjoh/rfc-core";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Schema } from "effect";
import {
  rfcAgentParameterDescriptions as descriptions,
  rfcAgentToolMetadata,
  rfcMcpAgentReferenceUri,
  rfcMcpInstructions,
} from "./agent-surface";
import { AuthStatusSchema } from "./credentials";
import {
  executeAuthStatus,
  executeCitationVerification,
  executeResearch,
  executeSourceCacheRemove,
  executeSourceCacheStatus,
  renderAuthStatus,
  renderCitationVerification,
  renderResearchResult,
  renderSourceCacheRemove,
  renderSourceCacheStatus,
  toRfcOperationErrorEnvelope,
  type RfcOperationDependencies,
  type RfcOperationOptions,
  type RfcOperationResult,
  type RfcOperationWarning,
} from "./operations";

export { rfcAgentToolMetadata, rfcMcpAgentReferenceUri, rfcMcpInstructions } from "./agent-surface";

/**
 * Complete Markdown reference exposed as a static MCP resource.
 */
export const rfcMcpAgentReference = `# RFC MCP agent workflow

This MCP server is the complete RFC research backend. It owns live RFC discovery, RFC currency traversal, canonical RFC Editor source retrieval, relevance ranking, passage selection, citation verification, source caching, provider credential status, and usage accounting. Do not answer RFC claims from memory or another provider.

## Workflow

1. Call \`rfc_research\` once per user request. Put each fact you need in \`questions\` (up to four); each question is answered independently against the same candidate RFCs.
2. Pass \`rfcs\` when you know the RFC numbers and \`searchTerms\` when you do not; both may be combined. Named RFCs, their current successors, and topic matches form one candidate pool.
3. Answer from the returned passages. Each passage names its RFC, section, verdict, and UTF-8 byte range. Cite only the RFC and section shown.
4. When a question is not found, you may make one follow-up call with other \`rfcs\` or \`searchTerms\`. Never re-research or re-verify returned passages.

## Result

For each question the result lists hits: an RFC, its \`role\` (\`requested\`, \`current\` successor of a requested RFC, or \`discovered\` by topic search), its \`relevance\`, a \`verdict\`, and one to three exact passages. \`found: false\` means none of the \`searched\` RFCs contained an answer.

Verdicts use citation-check semantics:

- \`supports\`: the passage states the answer or directly implies it.
- \`partial\`: the passage answers only part of the question.
- \`says_nothing\`: the passage does not address the question.
- \`contradicts\`: the passage states the opposite of what the question presumes.

A \`current\` hit comes from the RFC that replaced the one named. Keep it distinct from the requested RFC and never silently substitute a successor. \`currency\` reports each named RFC's current successors and the relationship path.

## Tools

### rfc_research

Inputs are \`questions\`, optional \`rfcs\`, and optional \`searchTerms\`; at least one of \`rfcs\` or \`searchTerms\` is required. Supply one to four ordered non-empty terms, each no longer than ${datatrackerTopicSearchTermMaximumCharacters} characters. Each term is matched as a literal case-insensitive substring of an RFC title or abstract, so use short noun phrases such as \`DNS over TLS\`; a sentence fragment such as \`DNS over TLS default port\` matches nothing. If the operator enabled optional full-text search, terms additionally match RFC keywords and body text. Terms are transmitted verbatim in upstream query URLs and may appear in diagnostics, errors, and upstream access logs. Never include private or user-specific details in a term, and do not send a natural-language question upstream unless it was explicitly chosen as a term.

### rfc_verify_citation

Verify one factual claim against one exact RFC quotation. Inputs are \`rfc\`, \`claim\`, \`quote\`, and optional \`offset\`. The offset is an absolute UTF-8 byte offset into the exact source identified by \`sourceHash\`, not a JavaScript string index. Copy it from a research quote range or omit it for a unique quotation. Never guess wording or offsets. Use it only for a user-supplied quotation or an explicitly requested check.

- \`verified\`: the exact present quotation supports the claim.
- \`unsupported\`: the quotation does not establish the claim.
- \`contradicted\`: the quotation conflicts with the claim.
- \`fabricated\`: the supplied quotation is absent from the authoritative source.

### rfc_source_cache_status

Inspect one named RFC source-cache entry without network access.

### rfc_source_cache_remove

Remove one named RFC source-cache entry without network access. This destructive, idempotent tool requires \`confirm: true\`. There is no list-all, refresh-all, prefetch, bulk download, or bulk clear operation.

### rfc_auth_status

Report only whether the stable TypeSafe credential identity is configured. The MCP never accepts, returns, adds, or removes credentials. If missing, ask the human operator to run \`rfc auth login\` outside MCP.

## Fail-closed operations

Operational failures are returned as MCP tool errors containing the safe version-three RFC error envelope. Report the code and stop. In particular:

- \`invalid_input\`: correct the bounded tool input.
- \`credential_missing\`: ask the human to run \`rfc auth login\`.
- \`credential_store_unavailable\` or \`credential_access_denied\`: ask the human to unlock or authorize the OS credential store; never use plaintext fallback.
- \`discovery_failed\`: report the Datatracker failure; do not invent or use stale metadata.
- \`source_cache_failed\`, \`source_fetch_failed\`, or \`source_revalidation_failed\`: report the authoritative source failure; never serve stale text or substitute another representation.
- \`rfc_not_found\`: correct the exact identifier or use \`searchTerms\`.
- \`decision_model_failed\`: report the bounded provider failure; do not switch provider or model.
- \`citation_quote_ambiguous\` or \`citation_offset_mismatch\`: copy an exact research offset or stop; never guess.
- \`internal_error\` or \`configuration_error\`: report an operational failure rather than asserting an answer.

## Privacy, cost, and cache behavior

Questions and model responses are request-local and are not persisted. Topic search terms are sent to Datatracker, and to the IETF RFC search service when the operator enabled it, and can be retained in upstream logs. When \`retrieval.topicSearchFallback\` is true, full-text search was configured but failed and discovery matched titles and abstracts only, so an empty result is less conclusive than usual. Canonical RFC Editor text is cached per RFC with integrity and validator metadata. Fresh entries are reused; stale entries must revalidate successfully.

Research and citation results report provider input tokens and estimated input cost. A null estimate means unavailable, not zero. Each successful semantic operation updates per-user usage totals. If accounting fails, the tool still succeeds and adds a \`usage_accounting_failed\` warning; do not retry a successful paid operation because of that warning.
`;

const describedString = (description: string) =>
  Schema.NonEmptyString.pipe(Schema.annotate({ description }));

const TopicSearchTermSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(datatrackerTopicSearchTermMaximumCharacters),
).pipe(Schema.annotate({ description: descriptions.searchTerm }));

const ResearchInputSchema = Schema.Struct({
  questions: Schema.Array(describedString(descriptions.question))
    .check(Schema.isMinLength(1), Schema.isMaxLength(retrievalPolicy.maxQuestions))
    .pipe(Schema.annotate({ description: descriptions.questions })),
  rfcs: Schema.optionalKey(
    Schema.Array(describedString(descriptions.rfc))
      .check(Schema.isMinLength(1), Schema.isMaxLength(retrievalPolicy.maxRequestedRfcs))
      .pipe(Schema.annotate({ description: descriptions.rfcs })),
  ),
  searchTerms: Schema.optionalKey(
    Schema.Array(TopicSearchTermSchema)
      .check(Schema.isMinLength(1), Schema.isMaxLength(datatrackerTopicSearchTermLimit))
      .pipe(Schema.annotate({ description: descriptions.searchTerms })),
  ),
});

const CitationInputSchema = Schema.Struct({
  rfc: describedString(descriptions.citationRfc),
  claim: describedString(descriptions.claim),
  quote: describedString(descriptions.quote),
  offset: Schema.optionalKey(
    Schema.Natural.pipe(Schema.annotate({ description: descriptions.offset })),
  ),
});

const RfcInputSchema = Schema.Struct({
  rfc: describedString(descriptions.cacheRfc),
});

const SourceCacheRemoveInputSchema = Schema.Struct({
  rfc: describedString(descriptions.cacheRfc),
  confirm: Schema.Literal(true).pipe(Schema.annotate({ description: descriptions.confirm })),
});

const EmptyInputSchema = Schema.Struct({});

const toMcpSchema = <S extends Schema.ConstraintDecoder<unknown> & Schema.Constraint>(
  schema: S,
) => {
  const validation = Schema.toStandardSchemaV1(schema);
  const jsonSchema = Schema.toStandardJSONSchemaV1(schema);
  return {
    ...validation,
    "~standard": {
      ...validation["~standard"],
      jsonSchema: jsonSchema["~standard"].jsonSchema,
    },
  };
};

const renderAgentResearch = (value: ResearchResult): string =>
  renderResearchResult(value, { audience: "agent" });

const renderAgentCitation = (value: CitationVerificationResult): string =>
  renderCitationVerification(value, { audience: "agent" });

const warningContent = (warnings: ReadonlyArray<RfcOperationWarning>) =>
  warnings.map((warning) => ({ type: "text" as const, text: JSON.stringify(warning) }));

const semanticSuccess = <A extends object>(
  result: RfcOperationResult<A>,
  render: (value: A) => string,
): CallToolResult => ({
  content: [{ type: "text", text: render(result.value) }, ...warningContent(result.warnings)],
  structuredContent: result.value,
});

const plainSuccess = <A extends object>(
  value: A,
  render: (value: A) => string,
): CallToolResult => ({
  content: [{ type: "text", text: render(value) }],
  structuredContent: value,
});

const toolError = (error: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(toRfcOperationErrorEnvelope(error)) }],
  isError: true,
});

/**
 * Construct one self-describing RFC MCP server instance.
 *
 * @param options Trusted startup configuration that tool callers cannot override.
 * @param dependencies Injectable credential, usage, and RFC-client boundaries.
 * @returns An unconnected MCP server with tools and the agent reference registered.
 */
export const createRfcMcpServer = (
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
): McpServer => {
  const server = new McpServer(
    { name: "rfc", version: "0.1.0" },
    { instructions: rfcMcpInstructions },
  );

  server.registerResource(
    "agent_workflow",
    rfcMcpAgentReferenceUri,
    {
      title: "RFC MCP agent workflow",
      description:
        "Reference for result fields, verdicts, failures, provenance, privacy, cache, and cost; skip for ordinary research",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: rfcMcpAgentReference,
        },
      ],
    }),
  );

  server.registerTool(
    rfcAgentToolMetadata.research.name,
    {
      title: rfcAgentToolMetadata.research.title,
      description: rfcAgentToolMetadata.research.description,
      inputSchema: toMcpSchema(ResearchInputSchema),
      outputSchema: toMcpSchema(ResearchResultSchema),
      annotations: rfcAgentToolMetadata.research.annotations,
    },
    async ({ questions, rfcs, searchTerms }) => {
      try {
        return semanticSuccess(
          await executeResearch(
            {
              schemaVersion,
              questions,
              ...(rfcs === undefined ? {} : { rfcs }),
              ...(searchTerms === undefined ? {} : { searchTerms }),
            },
            options,
            dependencies,
          ),
          renderAgentResearch,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    rfcAgentToolMetadata.verifyCitation.name,
    {
      title: rfcAgentToolMetadata.verifyCitation.title,
      description: rfcAgentToolMetadata.verifyCitation.description,
      inputSchema: toMcpSchema(CitationInputSchema),
      outputSchema: toMcpSchema(CitationVerificationResultSchema),
      annotations: rfcAgentToolMetadata.verifyCitation.annotations,
    },
    async ({ rfc, claim, quote, offset }) => {
      try {
        return semanticSuccess(
          await executeCitationVerification(
            { schemaVersion, rfc, claim, quote, offset: offset ?? null },
            options,
            dependencies,
          ),
          renderAgentCitation,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    rfcAgentToolMetadata.sourceCacheStatus.name,
    {
      title: rfcAgentToolMetadata.sourceCacheStatus.title,
      description: rfcAgentToolMetadata.sourceCacheStatus.description,
      inputSchema: toMcpSchema(RfcInputSchema),
      outputSchema: toMcpSchema(RfcSourceCacheStatusSchema),
      annotations: rfcAgentToolMetadata.sourceCacheStatus.annotations,
    },
    async ({ rfc }) => {
      try {
        return plainSuccess(
          await executeSourceCacheStatus(rfc, options, dependencies),
          renderSourceCacheStatus,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    rfcAgentToolMetadata.sourceCacheRemove.name,
    {
      title: rfcAgentToolMetadata.sourceCacheRemove.title,
      description: rfcAgentToolMetadata.sourceCacheRemove.description,
      inputSchema: toMcpSchema(SourceCacheRemoveInputSchema),
      outputSchema: toMcpSchema(RfcSourceCacheRemoveResultSchema),
      annotations: rfcAgentToolMetadata.sourceCacheRemove.annotations,
    },
    async ({ rfc, confirm }) => {
      try {
        // The schema already requires `confirm: true`, but this is the only
        // destructive operation on the surface and its enforcement must not
        // rest entirely on the SDK validating before dispatch.
        if (confirm !== true) {
          throw new InvalidInputError({
            reason: "Removing a source-cache entry requires confirm: true",
          });
        }
        return plainSuccess(
          await executeSourceCacheRemove(rfc, options, dependencies),
          renderSourceCacheRemove,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    rfcAgentToolMetadata.authStatus.name,
    {
      title: rfcAgentToolMetadata.authStatus.title,
      description: rfcAgentToolMetadata.authStatus.description,
      inputSchema: toMcpSchema(EmptyInputSchema),
      outputSchema: toMcpSchema(AuthStatusSchema),
      annotations: rfcAgentToolMetadata.authStatus.annotations,
    },
    async () => {
      try {
        return plainSuccess(await executeAuthStatus(dependencies), renderAuthStatus);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
};

/**
 * Serve the RFC MCP over process standard input and output until the client disconnects.
 *
 * @param options Trusted startup configuration that tool callers cannot override.
 * @param dependencies Injectable credential, usage, and RFC-client boundaries.
 * @param reportError Out-of-band error reporter; production writes only to stderr.
 * @returns A promise that resolves when the MCP connection closes.
 */
export const runRfcMcpServer = async (
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
  reportError: (error: Error) => void,
): Promise<void> => {
  const server = createRfcMcpServer(options, dependencies);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    server.server.onerror = reportError;
  });
  await server.connect(new StdioServerTransport());
  await closed;
};
