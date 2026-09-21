import {
  CitationVerificationResultSchema,
  EvidenceBundleSchema,
  RfcSourceCacheRemoveResultSchema,
  RfcSourceCacheStatusSchema,
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  schemaVersion,
} from "@wyattjoh/rfc-core";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Schema } from "effect";
import { AuthStatusSchema } from "./credentials";
import {
  executeAuthStatus,
  executeCitationVerification,
  executeResearch,
  executeSourceCacheRemove,
  executeSourceCacheStatus,
  renderAuthStatus,
  renderCitationVerification,
  renderEvidenceBundle,
  renderSourceCacheRemove,
  renderSourceCacheStatus,
  toRfcOperationErrorEnvelope,
  type RfcOperationDependencies,
  type RfcOperationOptions,
  type RfcOperationResult,
  type RfcOperationWarning,
} from "./operations";

/**
 * Static URI for the complete model-facing RFC workflow reference.
 */
export const rfcMcpAgentReferenceUri = "rfc://docs/agent-workflow" as const;

/**
 * Cross-tool instructions advertised during MCP initialization.
 */
export const rfcMcpInstructions = `For an ordinary known-RFC answer, call research_known_rfc exactly once, then answer and stop. Do not call verify_citation after research to re-check returned evidence, including when status is needs_review. Do not run preflight tools. Do not read the agent-workflow resource.

Use this server as the complete backend for published IETF RFC questions. Do not answer RFC claims from memory or another provider. When the RFC identifier is unknown, call research_topic with { question, searchTerms } using one to four deliberate ordered technical terms. Use verify_citation only when the user supplied a quotation or explicitly requested a distinct paraphrase check.

For one simple atomic question, call one research tool once. Only when that result contains neither usable accepted evidence nor a review candidate may you make at most one targeted follow-up research call. Do not rephrase valid results to chase answered status or higher confidence. For up to two explicit independent questions, keep them as separate research calls; do not invent a split for an ambiguous request.

Topic search terms are transmitted verbatim in Datatracker URLs and may appear in upstream logs; never derive hidden terms or send the full question as a search term unless the user explicitly chose it.

Preserve research status exactly: answered, partial, unsupported, needs_review, or needs_split. Accepted evidence may support an answer. A review candidate is canonical but unaccepted and must be quoted only as qualified review material. Keep requested and current RFC contexts distinct and never silently substitute a successor.

Exact reproduction of accepted evidence needs no citation call. Verify at most two paraphrased claims once each with verify_citation, using the exact returned quote and its UTF-8 byte offset. If a direct verification verdict is fabricated, use at most one research call to locate current wording and one verification call for that replacement. Never guess wording or offsets. Unsupported, contradicted, or fabricated verdicts cannot support an unqualified claim.

Operational tool errors are not research statuses. Preserve their typed error code and stop rather than substituting stale text, another provider, or memory. If a tool error reports a missing credential, ask the human operator to run rfc auth add; never request or accept the secret through MCP. A usage-accounting warning follows a successful paid operation and must not trigger a retry.

Do not read the agent-workflow resource for ordinary research. Read ${rfcMcpAgentReferenceUri} only when handling a non-answer status, operational failure, citation-repair workflow, or a provenance, privacy, cost, or cache question.`;

/**
 * Complete Markdown reference exposed as a static MCP resource.
 */
export const rfcMcpAgentReference = `# RFC MCP agent workflow

This MCP server is the complete RFC research backend. It owns live RFC discovery, RFC currency traversal, canonical RFC Editor source retrieval, bounded evidence selection, citation verification, source caching, provider credential status, and usage accounting. Do not answer RFC claims from memory or another provider.

## Bounded workflow

For one atomic question:

1. Call \`research_known_rfc\` when the RFC is known, otherwise call \`research_topic\` with one to four deliberate ordered technical search terms.
2. Make at most one targeted follow-up research call, and only when the first result has neither usable accepted evidence nor a review candidate. Never loop by rephrasing a valid result to chase \`answered\` or higher confidence.
3. When accepted evidence or a review candidate is returned, answer from that result and stop. Quote accepted evidence unchanged with provenance. Quote a review candidate only as explicitly unaccepted or \`needs_review\`.
4. Never call \`verify_citation\` after research to re-check returned evidence, normalize formatting, or obtain alternate provenance. Use it only for a user-supplied quotation or an explicitly requested distinct paraphrase check, at most twice.
5. Stop after the budget. Preserve non-answer statuses and typed operational failures.

For up to two explicit independently answerable questions, use one research call per question and keep their inputs and outputs separate. Do not invent a split for an ambiguous request; preserve \`needs_split\`.

## Tools

### research_known_rfc

Research one atomic question against a known published RFC. The server performs bounded live metadata lookup and currency traversal, researches requested and applicable current RFC contexts independently, and never silently substitutes a successor.

Inputs are \`question\` and \`rfc\`. Use the exact RFC identifier, such as \`RFC9110\`.

### research_topic

Discover and research published RFCs for one atomic topic question. Inputs are \`question\` and \`searchTerms\`. Supply one to four ordered non-empty terms, each no longer than ${datatrackerTopicSearchTermMaximumCharacters} characters. Terms are transmitted verbatim in Datatracker query URLs and may appear in diagnostics, errors, and upstream access logs. Do not generate hidden terms, rewrite the caller's phrases, or send the natural-language question upstream unless it was explicitly chosen as a term.

### verify_citation

Verify one factual claim against one exact RFC quotation. Inputs are \`rfc\`, \`claim\`, \`quote\`, and optional \`offset\`. The offset is an absolute UTF-8 byte offset into the exact source identified by \`sourceHash\`, not a JavaScript string index. Copy it from research provenance or omit it for a unique quotation. Never guess wording or offsets.

### source_cache_status

Inspect one named RFC source-cache entry without network access.

### source_cache_remove

Remove one named RFC source-cache entry without network access. This destructive, idempotent tool requires \`confirm: true\`. There is no list-all, refresh-all, prefetch, bulk download, or bulk clear operation.

### auth_status

Report only whether the stable TypeSafe credential identity is configured. The MCP never accepts, returns, adds, or removes credentials. If missing, ask the human operator to run \`rfc auth add\` outside MCP.

## Research statuses

- \`answered\`: accepted direct evidence with no disqualifying uncertainty.
- \`partial\`: only part of the question or RFC currency coverage is established.
- \`unsupported\`: bounded research found no accepted answering evidence.
- \`needs_review\`: confidence is low, evidence conflicts, discovery is empty, or RFC currency is uncertain.
- \`needs_split\`: the question is compound and requires atomic questions.

A valid non-answer status is a successful tool result, not an operational failure. Review candidates are canonical source passages surfaced for bounded review but are not accepted evidence. Never turn them into unqualified claims.

## Citation verdicts

- \`verified\`: the exact present quotation supports the claim.
- \`unsupported\`: the quotation does not establish the claim.
- \`contradicted\`: the quotation conflicts with the claim.
- \`fabricated\`: the supplied quotation is absent from the authoritative source.

Only accepted research evidence or a \`verified\` citation supports an unqualified factual claim. If a quote is fabricated, make at most one research call to locate current wording and at most one verification call for that replacement.

## Provenance and RFC currency

Preserve exact quotes, RFC identifiers, requested/current context roles, relationship paths, nullable section labels, canonical source URLs, source hashes, \`offsetUnit: "utf8-byte"\`, and byte offsets. Do not answer a question about the requested RFC with current-context evidence without explicitly explaining the distinction.

## Fail-closed operations

Operational failures are returned as MCP tool errors containing the safe version-two RFC error envelope. Report the code and stop. In particular:

- \`invalid_input\`: correct the bounded tool input.
- \`credential_missing\`: ask the human to run \`rfc auth add\`.
- \`credential_store_unavailable\` or \`credential_access_denied\`: ask the human to unlock or authorize the OS credential store; never use plaintext fallback.
- \`discovery_failed\`: report the Datatracker failure; do not invent or use stale metadata.
- \`source_cache_failed\`, \`source_fetch_failed\`, or \`source_revalidation_failed\`: report the authoritative source failure; never serve stale text or substitute another representation.
- \`rfc_not_found\`: correct the exact identifier or use topic discovery with explicit terms.
- \`decision_model_failed\`: report the bounded provider failure; do not switch provider or model.
- \`citation_quote_ambiguous\` or \`citation_offset_mismatch\`: copy an exact research offset or stop; never guess.
- \`internal_error\` or \`configuration_error\`: report an operational failure rather than asserting an answer.

## Privacy, cost, and cache behavior

Questions and model responses are request-local and are not persisted. Topic search terms are sent to Datatracker and can be retained in upstream logs. Canonical RFC Editor text is cached per RFC with integrity and validator metadata. Fresh entries are reused; stale entries must revalidate successfully.

Research and citation results report provider input tokens and estimated input cost. A null estimate means unavailable, not zero. Each successful semantic operation updates per-user usage totals. If accounting fails, the tool still succeeds and adds a \`usage_accounting_failed\` warning; do not retry a successful paid operation because of that warning.
`;

const describedString = (description: string) =>
  Schema.NonEmptyString.pipe(Schema.annotate({ description }));

const KnownRfcResearchInputSchema = Schema.Struct({
  question: describedString("One independently answerable RFC question"),
  rfc: describedString("Exact published RFC identifier, for example RFC9110"),
});

const TopicSearchTermSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(datatrackerTopicSearchTermMaximumCharacters),
).pipe(
  Schema.annotate({
    description:
      "Deliberate topic-discovery term sent verbatim in Datatracker query URLs and upstream logs",
  }),
);

const TopicResearchInputSchema = Schema.Struct({
  question: describedString("One independently answerable topic question"),
  searchTerms: Schema.Array(TopicSearchTermSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(datatrackerTopicSearchTermLimit))
    .pipe(
      Schema.annotate({
        description: "One to four ordered topic-discovery terms; preserve caller order",
      }),
    ),
});

const CitationInputSchema = Schema.Struct({
  rfc: describedString("Exact published RFC identifier containing the quotation"),
  claim: describedString("One factual claim to check"),
  quote: describedString("Exact unchanged RFC quotation"),
  offset: Schema.optionalKey(
    Schema.Natural.pipe(
      Schema.annotate({
        description:
          "Absolute UTF-8 byte offset copied from research provenance; omit for a unique quotation",
      }),
    ),
  ),
});

const RfcInputSchema = Schema.Struct({
  rfc: describedString("Exact named RFC source-cache entry, for example RFC9110"),
});

const SourceCacheRemoveInputSchema = Schema.Struct({
  rfc: describedString("Exact named RFC source-cache entry, for example RFC9110"),
  confirm: Schema.Literal(true).pipe(
    Schema.annotate({ description: "Must be true to confirm removal of the named cache entry" }),
  ),
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
        "Reference for non-answer statuses, failures, citation repair, provenance, privacy, cache, and cost; skip for ordinary research",
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
    "research_known_rfc",
    {
      title: "Research a known RFC",
      description:
        "Inputs: question, rfc. Research one atomic question against a known published RFC. If evidence or a review candidate is returned, answer from it without a verification call. Includes bounded RFC currency traversal, provenance, status, and diagnostics.",
      inputSchema: toMcpSchema(KnownRfcResearchInputSchema),
      outputSchema: toMcpSchema(EvidenceBundleSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ question, rfc }) => {
      try {
        return semanticSuccess(
          await executeResearch({ schemaVersion, question, rfc }, options, dependencies),
          renderEvidenceBundle,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "research_topic",
    {
      title: "Discover and research RFCs",
      description:
        "Inputs: question, searchTerms (1-4). Research one atomic topic question. If evidence or a review candidate is returned, answer from it without a verification call. Terms are sent verbatim to Datatracker; results include provenance, status, and diagnostics.",
      inputSchema: toMcpSchema(TopicResearchInputSchema),
      outputSchema: toMcpSchema(EvidenceBundleSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ question, searchTerms }) => {
      try {
        return semanticSuccess(
          await executeResearch(
            { schemaVersion, question, rfc: null, searchTerms },
            options,
            dependencies,
          ),
          renderEvidenceBundle,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "verify_citation",
    {
      title: "Verify an RFC citation",
      description:
        "Inputs: rfc, claim, quote; optional offset. Check one factual claim against one exact RFC quotation. Returns a verified, unsupported, contradicted, or fabricated verdict with canonical provenance.",
      inputSchema: toMcpSchema(CitationInputSchema),
      outputSchema: toMcpSchema(CitationVerificationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ rfc, claim, quote, offset }) => {
      try {
        return semanticSuccess(
          await executeCitationVerification(
            { schemaVersion, rfc, claim, quote, offset: offset ?? null },
            options,
            dependencies,
          ),
          renderCitationVerification,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "source_cache_status",
    {
      title: "Inspect an RFC source cache entry",
      description:
        "Input: rfc. Inspect one named canonical RFC source-cache entry locally without network access.",
      inputSchema: toMcpSchema(RfcInputSchema),
      outputSchema: toMcpSchema(RfcSourceCacheStatusSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
    "source_cache_remove",
    {
      title: "Remove an RFC source cache entry",
      description:
        "Inputs: rfc, confirm=true. Remove one named canonical RFC source-cache entry locally without network access; never performs bulk removal.",
      inputSchema: toMcpSchema(SourceCacheRemoveInputSchema),
      outputSchema: toMcpSchema(RfcSourceCacheRemoveResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ rfc }) => {
      try {
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
    "auth_status",
    {
      title: "Inspect RFC provider credential status",
      description:
        "No inputs. Report only whether the stable TypeSafe credential identity is configured. Never returns, accepts, adds, or removes the credential.",
      inputSchema: toMcpSchema(EmptyInputSchema),
      outputSchema: toMcpSchema(AuthStatusSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
