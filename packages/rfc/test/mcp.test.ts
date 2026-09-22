import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CitationOffsetMismatchError,
  CitationQuoteAmbiguousError,
  CitationVerificationResultSchema,
  InvalidInputError,
  ResearchResultSchema,
  citationOffsetUnit,
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  retrievalPolicy,
  type CitationVerificationRequest,
  type ResearchRequest,
  type RfcClient,
} from "@wyattjoh/rfc-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import type { CredentialStore } from "../src/credentials";
import { CredentialInputError, CredentialStoreError } from "../src/credentials";
import { rfcMcpInstructionsCharacterBudget } from "../src/agent-surface";
import { createRfcMcpServer, rfcMcpAgentReferenceUri, rfcMcpInstructions } from "../src/mcp";
import { toRfcOperationErrorEnvelope } from "../src/operations";
import type { RfcOperationDependencies, RfcOperationOptions } from "../src/operations";

const operationOptions: RfcOperationOptions = {
  cacheDirectory: "/tmp/rfc-mcp-test-cache",
  datatrackerApiUrl: "https://datatracker.example/api/v1",
  typeSafeApiUrl: "https://typesafe.example/api",
  rfcSearchApiUrl: undefined,
  rfcSearchApiKey: undefined,
};

const makeCredentialStore = (initial: string | null = "fixture-key"): CredentialStore => {
  let value = initial;
  return {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    delete: async () => {
      const existed = value !== null;
      value = null;
      return existed;
    },
  };
};

const stubResearchResult = Schema.decodeUnknownSync(ResearchResultSchema)({
  schemaVersion: 3,
  kind: "research_result",
  answers: [
    {
      question: "What does HTTP require?",
      found: true,
      searched: ["RFC9110"],
      hits: [
        {
          rfc: {
            identifier: "RFC9110",
            rfcNumber: 9110,
            title: "HTTP Semantics",
            abstract: "HTTP semantics.",
            status: "published",
            stream: "ietf",
            canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
          },
          role: "requested",
          relevance: 0.93,
          verdict: "supports",
          passages: [
            {
              quote: "The client MUST send a request containing the target resource.",
              section: "1. Requirements",
              probability: 0.9,
              verdict: "supports",
              provenance: {
                sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
                sourceHash: "fixture-source-hash",
                offsetUnit: citationOffsetUnit,
                startOffset: 17,
                endOffset: 79,
                fetchedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
        },
      ],
    },
  ],
  diagnostics: {
    policyVersion: retrievalPolicy.policyVersion,
    requestedModel: "jev-1.13.0",
    resolvedModels: ["jev-1.13.0"],
    usage: { inputTokens: 20, outputTokens: 4 },
    inputCost: { estimatedUsd: 0.00000084, rateUsdPerMillionTokens: 0.042 },
    timings: {
      metadataMs: 1,
      sourceMs: 0,
      rankMs: 0,
      sectionMs: 0,
      paragraphMs: 0,
      totalMs: 1,
    },
    retrieval: {
      schemaVersion: 3,
      requestCount: 1,
      datatrackerRequestCount: 1,
      sourceRequestCount: 0,
      metadataMs: 1,
      sourceMs: 0,
      sourceCacheOutcome: "not_requested",
      requests: [
        {
          kind: "metadata",
          url: "https://datatracker.example/api/v1/doc/document/rfc9110/",
          attempts: 1,
          status: 200,
          statuses: [200],
          durationMs: 1,
        },
      ],
    },
    candidates: { pool: 1, ranked: 1 },
  },
});

const stubCitationVerification = Schema.decodeUnknownSync(CitationVerificationResultSchema)({
  schemaVersion: 3,
  kind: "citation_verification",
  verdict: "verified",
  rfc: {
    identifier: "RFC9110",
    rfcNumber: 9110,
    title: "HTTP Semantics",
    abstract: "HTTP semantics.",
    status: "published",
    stream: "ietf",
    canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
  },
  claim: "The client sends a request.",
  quote: "The client MUST send a request containing the target resource.",
  provenance: {
    identifier: "RFC9110",
    rfcNumber: 9110,
    sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
    canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
    sourceHash: "fixture-source-hash",
    offsetUnit: citationOffsetUnit,
    startOffset: 17,
    endOffset: 79,
    section: "1. Requirements",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  },
  probabilities: { verified: 0.95, unsupported: 0.025, contradicted: 0.025 },
  confidence: 0.95,
  diagnostics: {
    schemaVersion: 3,
    policyVersion: "citation-v2",
    requestedModel: "jev-1.13.0",
    resolvedModel: "jev-1.13.0",
    resolvedModels: ["jev-1.13.0"],
    usage: { inputTokens: 12, outputTokens: 8 },
    inputCost: { estimatedUsd: 0.0000005, rateUsdPerMillionTokens: 0.042 },
    timings: { metadataMs: 1, sourceMs: 1, verificationMs: 1, totalMs: 3 },
    probabilities: { verified: 0.95, unsupported: 0.025, contradicted: 0.025 },
    confidence: 0.95,
  },
});

const makeDependencies = (overrides?: {
  readonly credentialStore?: CredentialStore;
  readonly createClient?: RfcOperationDependencies["createClient"];
  readonly recordUsage?: RfcOperationDependencies["recordUsage"];
}): RfcOperationDependencies => ({
  credentialStore: overrides?.credentialStore ?? makeCredentialStore(),
  createClient:
    overrides?.createClient ??
    ((async () => {
      throw new Error("Unexpected RFC client construction");
    }) as RfcOperationDependencies["createClient"]),
  recordUsage:
    overrides?.recordUsage ??
    (async () => ({
      schemaVersion: 1,
      kind: "rfc_usage_totals",
      updatedAt: "2026-01-01T00:00:00.000Z",
      operations: 1,
      pricedOperations: 1,
      unpricedOperations: 0,
      operationsWithoutInputTokens: 0,
      inputTokens: 20,
      pricedInputTokens: 20,
      unpricedInputTokens: 0,
      estimatedInputCostUsd: 0.00000084,
    })),
});

const connect = async (dependencies: RfcOperationDependencies) => {
  const server = createRfcMcpServer(operationOptions, dependencies);
  const client = new Client({ name: "rfc-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

const textContent = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  result.content
    .filter(
      (content): content is Extract<(typeof result.content)[number], { type: "text" }> =>
        content.type === "text",
    )
    .map(({ text }) => text)
    .join("\n");

describe("RFC MCP agent surface", () => {
  // The only test in this file that runs against real production
  // dependencies: spawning `rfc mcp` reaches makeDefaultCliDependencies(), so
  // the server behind this transport holds the real Bun.secrets store, a real
  // ~/.config/rfc/usage.json recorder with no injected path, and live network
  // access. Handlers are lazy, so listTools/listResources touch none of them.
  // Keep it to handshake assertions: one callTool here would hit the operator's
  // keychain, write their config, and go to the network. Everything else in
  // this file goes through `connect`, which injects fakes.
  test("serves the registered surface through the rfc mcp stdio subcommand", async () => {
    const client = new Client({ name: "rfc-mcp-process-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../src/bin.ts"), "mcp"],
      cwd: join(import.meta.dir, "../../.."),
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("rfc_research");
      expect((await client.listResources()).resources).toContainEqual(
        expect.objectContaining({ uri: rfcMcpAgentReferenceUri }),
      );
    } finally {
      await client.close();
    }
  });

  test("keeps every call-bounding rule inside the client truncation budget", () => {
    // Claude Code keeps roughly the first 2 KB of server instructions. Only the
    // resource pointer may fall past the cut, and it opens with "Skip" so a
    // truncated prefix still reads as the intended default.
    const paragraphs = rfcMcpInstructions.split("\n");
    const resourceRule = paragraphs.at(-1) ?? "";
    expect(resourceRule).toStartWith(`Skip ${rfcMcpAgentReferenceUri}`);
    expect(rfcMcpInstructions.length - resourceRule.length).toBeLessThan(
      rfcMcpInstructionsCharacterBudget,
    );
    for (const rule of [
      "Make one rfc_research call per user request",
      "with each fact you need as its own entry in questions",
      "cite only the RFC and section shown",
      "A passage marked current successor comes from the RFC that replaced the one named",
      "you may make one follow-up rfc_research call",
      "Never re-research or re-verify returned passages",
      "Use rfc_verify_citation only for a user-supplied quotation or an explicitly requested check",
      "keep the typed error code and stop",
      "never request or accept the secret through MCP",
      "Never retry a successful paid call over a usage-accounting warning",
    ]) {
      const end = rfcMcpInstructions.indexOf(rule) + rule.length;
      expect(end).toBeGreaterThan(rule.length - 1);
      expect(end).toBeLessThanOrEqual(rfcMcpInstructionsCharacterBudget);
    }
  });

  test("advertises the safe typed tool surface and complete agent reference", async () => {
    const connection = await connect(makeDependencies());
    try {
      expect(connection.client.getInstructions()).toBe(rfcMcpInstructions);
      expect(rfcMcpInstructions).toStartWith(
        "Answer published IETF RFC questions only from this server, never from memory or another provider.",
      );
      expect(rfcMcpInstructions).toContain("never request or accept the secret through MCP");
      expect(rfcMcpInstructions).toContain(`Skip ${rfcMcpAgentReferenceUri} for ordinary research`);
      // The call-count rule leads, so even a heavily truncated prefix keeps it.
      expect(
        rfcMcpInstructions.indexOf("Make one rfc_research call per user request"),
      ).toBeLessThan(300);
      // The retired tools and status vocabulary are gone from the instructions.
      for (const retired of [
        "rfc_research_known_rfc",
        "rfc_research_topic",
        "needs_review",
        "needs_split",
      ]) {
        expect(rfcMcpInstructions).not.toContain(retired);
      }

      const { tools } = await connection.client.listTools();
      expect(tools.map(({ name }) => name)).toEqual([
        "rfc_research",
        "rfc_verify_citation",
        "rfc_source_cache_status",
        "rfc_source_cache_remove",
        "rfc_auth_status",
      ]);
      expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
      const research = tools.find(({ name }) => name === "rfc_research");
      expect(research?.description).toStartWith(
        "Inputs: questions (1-4) plus rfcs and/or searchTerms (1-4 each).",
      );
      expect(research?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      expect(Object.keys(research?.inputSchema.properties ?? {})).toEqual([
        "questions",
        "rfcs",
        "searchTerms",
      ]);
      expect(research?.inputSchema.required).toEqual(["questions"]);
      expect(tools.find(({ name }) => name === "rfc_verify_citation")?.description).toStartWith(
        "Inputs: rfc, claim, quote; optional offset.",
      );
      expect(
        tools.find(({ name }) => name === "rfc_source_cache_remove")?.annotations,
      ).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(JSON.stringify(tools)).not.toContain("typesafeApiUrl");
      expect(JSON.stringify(tools)).not.toContain("datatrackerApiUrl");
      expect(JSON.stringify(tools)).not.toContain("cacheDirectory");

      const resources = await connection.client.listResources();
      expect(resources.resources).toContainEqual(
        expect.objectContaining({ uri: rfcMcpAgentReferenceUri, mimeType: "text/markdown" }),
      );
      const reference = await connection.client.readResource({ uri: rfcMcpAgentReferenceUri });
      expect(reference.contents[0]).toMatchObject({
        uri: rfcMcpAgentReferenceUri,
        mimeType: "text/markdown",
      });
      expect("text" in reference.contents[0]! ? reference.contents[0]!.text : "").toContain(
        "## Fail-closed operations",
      );
    } finally {
      await connection.close();
    }
  });

  test("routes safe local tools and requires explicit cache-removal confirmation", async () => {
    const operations: Array<string> = [];
    let closes = 0;
    const createClient = (async () =>
      ({
        sourceCacheStatus: async (rfc: string) => {
          operations.push(`status:${rfc}`);
          return {
            schemaVersion: 3 as const,
            kind: "source_cache_status" as const,
            rfc,
            state: "hit" as const,
          };
        },
        sourceCacheRemove: async (rfc: string) => {
          operations.push(`remove:${rfc}`);
          return {
            schemaVersion: 3 as const,
            kind: "source_cache_remove" as const,
            rfc,
            removed: true,
          };
        },
        research: async () => stubResearchResult,
        verifyCitation: async () => {
          throw new Error("Unexpected citation call");
        },
        close: async () => {
          closes += 1;
        },
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies RfcClient) as RfcOperationDependencies["createClient"];
    const connection = await connect(makeDependencies({ createClient }));
    try {
      const auth = await connection.client.callTool({ name: "rfc_auth_status", arguments: {} });
      expect(auth.isError).not.toBe(true);
      expect(auth.structuredContent).toMatchObject({ kind: "auth_status", configured: true });

      const status = await connection.client.callTool({
        name: "rfc_source_cache_status",
        arguments: { rfc: "RFC9110" },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toEqual({
        schemaVersion: 3,
        kind: "source_cache_status",
        rfc: "RFC9110",
        state: "hit",
      });

      const unconfirmed = await connection.client.callTool({
        name: "rfc_source_cache_remove",
        arguments: { rfc: "RFC9110" },
      });
      expect(unconfirmed.isError).toBe(true);
      expect(operations).toEqual(["status:RFC9110"]);

      const removed = await connection.client.callTool({
        name: "rfc_source_cache_remove",
        arguments: { rfc: "RFC9110", confirm: true },
      });
      expect(removed.isError).not.toBe(true);
      expect(removed.structuredContent).toMatchObject({ removed: true });
      expect(operations).toEqual(["status:RFC9110", "remove:RFC9110"]);
      expect(closes).toBe(2);
    } finally {
      await connection.close();
    }
  });

  test("constructs version-three research requests per call and surfaces usage warnings", async () => {
    const requests: Array<ResearchRequest> = [];
    const clientOptions: Array<unknown> = [];
    let closes = 0;
    const createClient = (async (options: unknown) => {
      clientOptions.push(options);
      return {
        sourceCacheStatus: async () => {
          throw new Error("Unexpected cache call");
        },
        sourceCacheRemove: async () => {
          throw new Error("Unexpected cache call");
        },
        research: async (request: ResearchRequest) => {
          requests.push(request);
          return stubResearchResult;
        },
        verifyCitation: async () => {
          throw new Error("Unexpected citation call");
        },
        close: async () => {
          closes += 1;
        },
        [Symbol.asyncDispose]: async () => undefined,
      } satisfies RfcClient;
    }) as RfcOperationDependencies["createClient"];
    const connection = await connect(
      makeDependencies({
        createClient,
        recordUsage: async () => {
          throw new Error("fixture usage failure");
        },
      }),
    );
    try {
      const named = await connection.client.callTool({
        name: "rfc_research",
        arguments: { questions: ["What does HTTP require?"], rfcs: ["RFC9110"] },
      });
      expect(named.isError).not.toBe(true);
      expect(named.structuredContent).toEqual(stubResearchResult);
      const [rendered, warning] = named.content.map((content) =>
        content.type === "text" ? content.text : "",
      );
      // Models get the agent format: no source URL, usage, or cost footer.
      expect(rendered).toBe(
        [
          "Q1: What does HTTP require?",
          "RFC9110 §1 Requirements · supports · rel 0.93",
          "Quote [17-79]: The client MUST send a request containing the target resource.",
        ].join("\n"),
      );
      expect(JSON.parse(warning ?? "")).toMatchObject({
        schemaVersion: 3,
        kind: "warning",
        warning: { code: "usage_accounting_failed" },
      });

      const combined = await connection.client.callTool({
        name: "rfc_research",
        arguments: {
          questions: ["Which RFC defines HTTP caching?", "How long is a response fresh?"],
          rfcs: ["RFC9111"],
          searchTerms: ["HTTP caching", "cache control"],
        },
      });
      expect(combined.isError).not.toBe(true);

      const topic = await connection.client.callTool({
        name: "rfc_research",
        arguments: {
          questions: ["Which RFC defines HTTP caching?"],
          searchTerms: ["HTTP caching"],
        },
      });
      expect(topic.isError).not.toBe(true);

      // Omitted optional inputs stay absent rather than reaching the client as
      // undefined or empty arrays.
      expect(requests).toEqual([
        { schemaVersion: 3, questions: ["What does HTTP require?"], rfcs: ["RFC9110"] },
        {
          schemaVersion: 3,
          questions: ["Which RFC defines HTTP caching?", "How long is a response fresh?"],
          rfcs: ["RFC9111"],
          searchTerms: ["HTTP caching", "cache control"],
        },
        {
          schemaVersion: 3,
          questions: ["Which RFC defines HTTP caching?"],
          searchTerms: ["HTTP caching"],
        },
      ]);
      expect(requests.map((request) => Object.keys(request))).toEqual([
        ["schemaVersion", "questions", "rfcs"],
        ["schemaVersion", "questions", "rfcs", "searchTerms"],
        ["schemaVersion", "questions", "searchTerms"],
      ]);
      const expectedOptions = expect.objectContaining({
        cacheDirectory: operationOptions.cacheDirectory,
        datatrackerApiUrl: operationOptions.datatrackerApiUrl,
        typeSafeApiUrl: operationOptions.typeSafeApiUrl,
        typeSafeApiKey: "fixture-key",
      });
      expect(clientOptions).toEqual([expectedOptions, expectedOptions, expectedOptions]);
      expect(closes).toBe(3);
    } finally {
      await connection.close();
    }
  });

  test("verifies citations through the MCP layer and normalizes the optional offset", async () => {
    const requests: Array<CitationVerificationRequest> = [];
    let closes = 0;
    const createClient = (async () =>
      ({
        sourceCacheStatus: async () => {
          throw new Error("Unexpected cache call");
        },
        sourceCacheRemove: async () => {
          throw new Error("Unexpected cache call");
        },
        research: async () => {
          throw new Error("Unexpected research call");
        },
        verifyCitation: async (request: CitationVerificationRequest) => {
          requests.push(request);
          return stubCitationVerification;
        },
        close: async () => {
          closes += 1;
        },
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies RfcClient) as RfcOperationDependencies["createClient"];
    const connection = await connect(makeDependencies({ createClient }));

    try {
      const withOffset = await connection.client.callTool({
        name: "rfc_verify_citation",
        arguments: {
          rfc: "RFC9110",
          claim: "The client sends a request.",
          quote: "The client MUST send a request containing the target resource.",
          offset: 17,
        },
      });

      expect(withOffset.isError).not.toBe(true);
      expect(withOffset.structuredContent).toMatchObject({
        schemaVersion: 3,
        kind: "citation_verification",
        verdict: "verified",
        rfc: { identifier: "RFC9110" },
        provenance: { offsetUnit: citationOffsetUnit, startOffset: 17, endOffset: 79 },
      });
      const rendered = textContent(withOffset);
      expect(rendered).toContain("Verdict: verified");
      expect(rendered).toContain("Offsets: 17-79");
      expect(rendered).toContain("Section: 1. Requirements");
      expect(rendered).not.toContain("Input tokens");

      const withoutOffset = await connection.client.callTool({
        name: "rfc_verify_citation",
        arguments: {
          rfc: "RFC9110",
          claim: "The client sends a request.",
          quote: "The client MUST send a request containing the target resource.",
        },
      });
      expect(withoutOffset.isError).not.toBe(true);

      // An omitted offset reaches the client as an explicit null, not as a
      // missing key, so the unique-occurrence path is chosen deliberately.
      expect(requests).toEqual([
        {
          schemaVersion: 3,
          rfc: "RFC9110",
          claim: "The client sends a request.",
          quote: "The client MUST send a request containing the target resource.",
          offset: 17,
        },
        {
          schemaVersion: 3,
          rfc: "RFC9110",
          claim: "The client sends a request.",
          quote: "The client MUST send a request containing the target resource.",
          offset: null,
        },
      ]);
      expect(closes).toBe(2);
    } finally {
      await connection.close();
    }
  });

  test("maps citation retrieval failures to their typed MCP error codes", async () => {
    const failures = [
      {
        error: new CitationQuoteAmbiguousError({ rfc: "RFC9110", occurrences: 3 }),
        code: "citation_quote_ambiguous",
        message: "The quotation occurs 3 times in RFC RFC9110; provide an exact offset",
      },
      {
        error: new CitationOffsetMismatchError({ rfc: "RFC9110", offset: 17 }),
        code: "citation_offset_mismatch",
        message: "The supplied offset does not identify the exact quotation in RFC RFC9110",
      },
    ] as const;

    for (const { error, code, message } of failures) {
      const createClient = (async () =>
        ({
          sourceCacheStatus: async () => {
            throw new Error("Unexpected cache call");
          },
          sourceCacheRemove: async () => {
            throw new Error("Unexpected cache call");
          },
          research: async () => {
            throw new Error("Unexpected research call");
          },
          verifyCitation: async () => {
            throw error;
          },
          close: async () => undefined,
          [Symbol.asyncDispose]: async () => undefined,
        }) satisfies RfcClient) as RfcOperationDependencies["createClient"];
      const connection = await connect(makeDependencies({ createClient }));

      try {
        const result = await connection.client.callTool({
          name: "rfc_verify_citation",
          arguments: {
            rfc: "RFC9110",
            claim: "The client sends a request.",
            quote: "The client MUST send a request containing the target resource.",
            offset: 17,
          },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.parse(textContent(result))).toEqual({
          schemaVersion: 3,
          kind: "error",
          error: { code, message },
        });
      } finally {
        await connection.close();
      }
    }
  });

  test("enforces the research input bounds before dispatching a call", async () => {
    const createClient = (async () => {
      throw new Error("A rejected research request must not construct a client");
    }) as RfcOperationDependencies["createClient"];
    const connection = await connect(makeDependencies({ createClient }));
    const question = "Which RFC defines HTTP caching?";

    try {
      const rejected: ReadonlyArray<Record<string, unknown>> = [
        { questions: [], rfcs: ["RFC9111"] },
        {
          questions: Array.from({ length: retrievalPolicy.maxQuestions + 1 }, () => question),
          rfcs: ["RFC9111"],
        },
        { questions: [""], rfcs: ["RFC9111"] },
        { questions: [question], rfcs: [] },
        {
          questions: [question],
          rfcs: Array.from(
            { length: retrievalPolicy.maxRequestedRfcs + 1 },
            (_, index) => `RFC${9110 + index}`,
          ),
        },
        { questions: [question], searchTerms: [] },
        {
          questions: [question],
          searchTerms: Array.from(
            { length: datatrackerTopicSearchTermLimit + 1 },
            (_, index) => `term-${index}`,
          ),
        },
        {
          questions: [question],
          searchTerms: ["x".repeat(datatrackerTopicSearchTermMaximumCharacters + 1)],
        },
        { questions: [question], searchTerms: [""] },
      ];
      for (const args of rejected) {
        const result = await connection.client.callTool({ name: "rfc_research", arguments: args });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
      }

      // Neither rfcs nor searchTerms passes the schema but fails the request
      // contract, with the typed envelope and before any client exists.
      const unscoped = await connection.client.callTool({
        name: "rfc_research",
        arguments: { questions: [question] },
      });
      expect(unscoped.isError).toBe(true);
      expect(JSON.parse(textContent(unscoped))).toEqual({
        schemaVersion: 3,
        kind: "error",
        error: {
          code: "invalid_input",
          message: "Research input must include rfcs, searchTerms, or both",
        },
      });

      // The upper bounds themselves are accepted, so the guard rejects only
      // what is past them.
      const accepted = await connection.client.callTool({
        name: "rfc_research",
        arguments: {
          questions: Array.from({ length: retrievalPolicy.maxQuestions }, () => question),
          rfcs: Array.from(
            { length: retrievalPolicy.maxRequestedRfcs },
            (_, index) => `RFC${9110 + index}`,
          ),
          searchTerms: Array.from({ length: datatrackerTopicSearchTermLimit }, () =>
            "x".repeat(datatrackerTopicSearchTermMaximumCharacters),
          ),
        },
      });
      // The client construction above is what fails, which proves the request
      // passed schema validation and was dispatched.
      expect(JSON.parse(textContent(accepted)).error.code).toBe("internal_error");
    } finally {
      await connection.close();
    }
  });

  test("reports an absent credential and an unconfirmed removal with their exact envelopes", async () => {
    const createClient = (async () => {
      throw new Error("Neither call may construct a client");
    }) as RfcOperationDependencies["createClient"];
    const connection = await connect(
      makeDependencies({ credentialStore: makeCredentialStore(null), createClient }),
    );

    try {
      const auth = await connection.client.callTool({ name: "rfc_auth_status", arguments: {} });
      expect(auth.isError).not.toBe(true);
      expect(auth.structuredContent).toMatchObject({
        schemaVersion: 2,
        kind: "auth_status",
        configured: false,
      });
      expect(JSON.stringify(auth)).not.toContain("fixture-key");

      const unconfirmed = await connection.client.callTool({
        name: "rfc_source_cache_remove",
        arguments: { rfc: "RFC9110" },
      });
      expect(unconfirmed.isError).toBe(true);
      expect(unconfirmed.structuredContent).toBeUndefined();
      // The refusal names the missing confirmation rather than failing
      // opaquely, and never reaches the client.
      expect(textContent(unconfirmed)).toContain("confirm");
    } finally {
      await connection.close();
    }
  });

  test("maps credential input and store failures to their typed envelopes", async () => {
    expect(
      toRfcOperationErrorEnvelope(new CredentialInputError({ reason: "multiline secret" })),
    ).toEqual({
      schemaVersion: 3,
      kind: "error",
      error: { code: "invalid_input", message: "The TypeSafe API key input is invalid" },
    });

    const storeFailures = [
      [
        "unavailable",
        "credential_store_unavailable",
        "The platform credential store is unavailable",
      ],
      ["denied", "credential_access_denied", "Access to the platform credential store was denied"],
      ["storage", "credential_storage_failed", "Unable to store the TypeSafe API key"],
      ["deletion", "credential_deletion_failed", "Unable to remove the TypeSafe API key"],
    ] as const;
    for (const [kind, code, message] of storeFailures) {
      expect(
        toRfcOperationErrorEnvelope(new CredentialStoreError({ kind, operation: "get" })),
      ).toEqual({ schemaVersion: 3, kind: "error", error: { code, message } });
    }
  });

  test("returns safe MCP tool errors while preserving valid domain results as successes", async () => {
    const connection = await connect(
      makeDependencies({
        credentialStore: makeCredentialStore(null),
        createClient: (async () => {
          throw new InvalidInputError({ reason: "Provider construction should not run" });
        }) as RfcOperationDependencies["createClient"],
      }),
    );
    try {
      const result = await connection.client.callTool({
        name: "rfc_research",
        arguments: { questions: ["What does HTTP require?"], rfcs: ["RFC9110"] },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textContent(result))).toEqual({
        schemaVersion: 3,
        kind: "error",
        error: {
          code: "credential_missing",
          message: "No TypeSafe API key is configured; run `rfc auth login`",
        },
      });
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await connection.close();
    }
  });
});
