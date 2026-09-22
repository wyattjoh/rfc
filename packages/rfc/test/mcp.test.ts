import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CitationOffsetMismatchError,
  CitationQuoteAmbiguousError,
  CitationVerificationResultSchema,
  EvidenceBundleSchema,
  InvalidInputError,
  citationOffsetUnit,
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
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
import { createRfcMcpServer, rfcMcpAgentReferenceUri, rfcMcpInstructions } from "../src/mcp";
import { toRfcOperationErrorEnvelope } from "../src/operations";
import type { RfcOperationDependencies, RfcOperationOptions } from "../src/operations";

const operationOptions: RfcOperationOptions = {
  cacheDirectory: "/tmp/rfc-mcp-test-cache",
  datatrackerApiUrl: "https://datatracker.example/api/v1",
  typeSafeApiUrl: "https://typesafe.example/api",
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

const stubEvidenceBundle = Schema.decodeUnknownSync(EvidenceBundleSchema)({
  schemaVersion: 2,
  kind: "evidence_bundle",
  status: "needs_review",
  question: "What does HTTP require?",
  rfc: null,
  evidence: [],
  reviewCandidates: [],
  diagnostics: {
    schemaVersion: 2,
    policyVersion: "precision-v2",
    requestedModel: "jev-1.13.0",
    resolvedModel: "jev-1.13.0",
    resolvedModels: ["jev-1.13.0"],
    usage: { inputTokens: 20, outputTokens: 4 },
    inputCost: { estimatedUsd: 0.00000084, rateUsdPerMillionTokens: 0.042 },
    timings: {
      metadataMs: 1,
      sourceMs: 0,
      lexicalMs: 0,
      selectionMs: 0,
      relationMs: 0,
      totalMs: 1,
    },
    source: null,
    retrieval: {
      schemaVersion: 2,
      requestCount: 1,
      datatrackerRequestCount: 1,
      sourceRequestCount: 0,
      metadataMs: 1,
      sourceMs: 0,
      sourceCacheOutcome: "not_requested",
      upstreamRows: 0,
      uniqueCandidates: 0,
      mergeLimit: 32,
      semanticCandidates: 0,
      selectedSources: 0,
      topicTruncated: false,
      requests: [
        {
          kind: "metadata",
          url: "https://datatracker.example/api/v1/doc/document/?name__startswith=rfc",
          attempts: 1,
          status: 200,
          statuses: [200],
          durationMs: 1,
        },
      ],
    },
    candidates: {
      sourceBlocks: 0,
      passageCandidates: 0,
      selectedPassages: 0,
      discoveredDocuments: 0,
    },
    atomicity: null,
    selection: [],
    classification: [],
  },
});

const stubCitationVerification = Schema.decodeUnknownSync(CitationVerificationResultSchema)({
  schemaVersion: 2,
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
    schemaVersion: 2,
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
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(
        "rfc_research_known_rfc",
      );
      expect((await client.listResources()).resources).toContainEqual(
        expect.objectContaining({ uri: rfcMcpAgentReferenceUri }),
      );
    } finally {
      await client.close();
    }
  });

  test("advertises the safe typed tool surface and complete agent reference", async () => {
    const connection = await connect(makeDependencies());
    try {
      expect(connection.client.getInstructions()).toBe(rfcMcpInstructions);
      expect(rfcMcpInstructions).toStartWith(
        "For an ordinary known-RFC answer, call rfc_research_known_rfc exactly once, then answer and stop.",
      );
      expect(rfcMcpInstructions).toContain("at most one targeted follow-up research call");
      expect(rfcMcpInstructions).toContain("never request or accept the secret through MCP");
      expect(rfcMcpInstructions).toContain("Do not run preflight tools");
      expect(rfcMcpInstructions).toContain(
        "Do not call rfc_verify_citation after research to re-check returned evidence",
      );
      expect(rfcMcpInstructions).toContain("Do not read the agent-workflow resource");
      expect(
        rfcMcpInstructions.indexOf(
          "Do not call rfc_verify_citation after research to re-check returned evidence",
        ),
      ).toBeLessThan(300);

      const { tools } = await connection.client.listTools();
      expect(tools.map(({ name }) => name)).toEqual([
        "rfc_research_known_rfc",
        "rfc_research_topic",
        "rfc_verify_citation",
        "rfc_source_cache_status",
        "rfc_source_cache_remove",
        "rfc_auth_status",
      ]);
      expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
      expect(tools.find(({ name }) => name === "rfc_research_known_rfc")?.description).toStartWith(
        "Inputs: question, rfc.",
      );
      expect(tools.find(({ name }) => name === "rfc_research_topic")?.description).toStartWith(
        "Inputs: question, searchTerms (1-4).",
      );
      expect(tools.find(({ name }) => name === "rfc_verify_citation")?.description).toStartWith(
        "Inputs: rfc, claim, quote; optional offset.",
      );
      expect(
        tools.find(({ name }) => name === "rfc_source_cache_remove")?.annotations,
      ).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(
        tools.find(({ name }) => name === "rfc_research_topic")?.inputSchema.properties,
      ).toHaveProperty("searchTerms");
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
            schemaVersion: 2 as const,
            kind: "source_cache_status" as const,
            rfc,
            state: "hit" as const,
          };
        },
        sourceCacheRemove: async (rfc: string) => {
          operations.push(`remove:${rfc}`);
          return {
            schemaVersion: 2 as const,
            kind: "source_cache_remove" as const,
            rfc,
            removed: true,
          };
        },
        research: async () => stubEvidenceBundle,
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
        schemaVersion: 2,
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

  test("constructs version-two research requests per call and surfaces usage warnings", async () => {
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
          return { ...stubEvidenceBundle, question: request.question };
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
      const known = await connection.client.callTool({
        name: "rfc_research_known_rfc",
        arguments: { question: "What does HTTP require?", rfc: "RFC9110" },
      });
      expect(known.isError).not.toBe(true);
      expect(known.structuredContent).toMatchObject({
        schemaVersion: 2,
        kind: "evidence_bundle",
        status: "needs_review",
      });
      expect(textContent(known)).toContain("Status: needs_review");
      expect(textContent(known)).toContain("usage_accounting_failed");

      const topic = await connection.client.callTool({
        name: "rfc_research_topic",
        arguments: {
          question: "Which RFC defines HTTP caching?",
          searchTerms: ["HTTP caching", "cache control"],
        },
      });
      expect(topic.isError).not.toBe(true);
      expect(requests).toEqual([
        {
          schemaVersion: 2,
          question: "What does HTTP require?",
          rfc: "RFC9110",
          searchTerms: undefined,
        },
        {
          schemaVersion: 2,
          question: "Which RFC defines HTTP caching?",
          rfc: null,
          searchTerms: ["HTTP caching", "cache control"],
        },
      ]);
      expect(clientOptions).toEqual([
        expect.objectContaining({
          cacheDirectory: operationOptions.cacheDirectory,
          datatrackerApiUrl: operationOptions.datatrackerApiUrl,
          typeSafeApiUrl: operationOptions.typeSafeApiUrl,
          typeSafeApiKey: "fixture-key",
        }),
        expect.objectContaining({
          cacheDirectory: operationOptions.cacheDirectory,
          datatrackerApiUrl: operationOptions.datatrackerApiUrl,
          typeSafeApiUrl: operationOptions.typeSafeApiUrl,
          typeSafeApiKey: "fixture-key",
        }),
      ]);
      expect(closes).toBe(2);
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
        schemaVersion: 2,
        kind: "citation_verification",
        verdict: "verified",
        rfc: { identifier: "RFC9110" },
        provenance: { offsetUnit: citationOffsetUnit, startOffset: 17, endOffset: 79 },
      });
      const rendered = textContent(withOffset);
      expect(rendered).toContain("Verdict: verified");
      expect(rendered).toContain("Offsets: 17-79");
      expect(rendered).toContain("Section: 1. Requirements");

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
          schemaVersion: 2,
          rfc: "RFC9110",
          claim: "The client sends a request.",
          quote: "The client MUST send a request containing the target resource.",
          offset: 17,
        },
        {
          schemaVersion: 2,
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
          schemaVersion: 2,
          kind: "error",
          error: { code, message },
        });
      } finally {
        await connection.close();
      }
    }
  });

  test("enforces the topic search-term bounds before dispatching a call", async () => {
    const createClient = (async () => {
      throw new Error("A rejected topic request must not construct a client");
    }) as RfcOperationDependencies["createClient"];
    const connection = await connect(makeDependencies({ createClient }));

    try {
      const rejected: ReadonlyArray<ReadonlyArray<string>> = [
        [],
        Array.from({ length: datatrackerTopicSearchTermLimit + 1 }, (_, index) => `term-${index}`),
        ["x".repeat(datatrackerTopicSearchTermMaximumCharacters + 1)],
        [""],
      ];
      for (const searchTerms of rejected) {
        const result = await connection.client.callTool({
          name: "rfc_research_topic",
          arguments: { question: "Which RFC defines HTTP caching?", searchTerms },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
      }

      // The upper bounds themselves are accepted, so the guard rejects only
      // what is past them.
      const accepted = await connection.client.callTool({
        name: "rfc_research_topic",
        arguments: {
          question: "Which RFC defines HTTP caching?",
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
      schemaVersion: 2,
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
      ).toEqual({ schemaVersion: 2, kind: "error", error: { code, message } });
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
        name: "rfc_research_known_rfc",
        arguments: { question: "What does HTTP require?", rfc: "RFC9110" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textContent(result))).toEqual({
        schemaVersion: 2,
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
