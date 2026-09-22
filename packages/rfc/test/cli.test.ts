import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createRfcClient,
  hashRfcSource,
  RfcDiscoveryError,
  type ResearchResult,
} from "@wyattjoh/rfc-core";
import type { CredentialStore } from "../src/credentials";
import { makeDefaultCliDependencies, run, type RfcCliDependencies } from "../src/main";
import { renderResearchResult, researchResultAgentJson } from "../src/renderers";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

const repositoryRoot = join(import.meta.dir, "../../..");

const makeFixtureCredentialStore = (value: string | null = "fixture-key"): CredentialStore => {
  let stored = value;
  return {
    get: async () => stored,
    set: async (next) => {
      stored = next;
    },
    delete: async () => {
      const existed = stored !== null;
      stored = null;
      return existed;
    },
  };
};

const noUsageTotals = {
  schemaVersion: 1 as const,
  kind: "rfc_usage_totals" as const,
  updatedAt: "2026-01-01T00:00:00.000Z",
  operations: 0,
  pricedOperations: 0,
  unpricedOperations: 0,
  operationsWithoutInputTokens: 0,
  inputTokens: 0,
  pricedInputTokens: 0,
  unpricedInputTokens: 0,
  estimatedInputCostUsd: 0,
};

const readNoUsage: RfcCliDependencies["readUsage"] = async () => noUsageTotals;

const discardUsage: RfcCliDependencies["recordUsage"] = async () => noUsageTotals;

const runCli = async (
  args: Array<string>,
  input: string | undefined = undefined,
  credentialStore: CredentialStore = makeFixtureCredentialStore(),
  createClient: RfcCliDependencies["createClient"] = createRfcClient,
  recordUsage: RfcCliDependencies["recordUsage"] = discardUsage,
  readUsage: RfcCliDependencies["readUsage"] = readNoUsage,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  let stdout = "";
  let stderr = "";
  const exitCode = await run(args, {
    credentialStore,
    createClient,
    readUsage,
    recordUsage,
    readStandardInput: async () => input ?? "",
    promptCredential: async () => "fixture-key",
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
};

const writeLiveSourceCache = async (
  cacheDirectory: string,
  sourceText: string,
  fetchedAt: string,
): Promise<void> => {
  await mkdir(join(cacheDirectory, "sources", "v2"), { recursive: true });
  await writeFile(
    join(cacheDirectory, "sources", "v2", "RFC9110.json"),
    JSON.stringify({
      schemaVersion: 2,
      kind: "rfc_source_cache_entry",
      cacheIdentity: "rfc-source-v2",
      identifier: "RFC9110",
      rfcNumber: 9110,
      sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
      text: sourceText,
      contentHash: hashRfcSource(sourceText),
      etag: '"fixture"',
      fetchedAt,
      // A bounded window: the cache reader rejects entries whose freshness
      // exceeds the maximum upstream lifetime, so a far-future sentinel would
      // be treated as corrupt rather than fresh.
      freshUntil: new Date(Date.parse(fetchedAt) + 24 * 60 * 60 * 1_000).toISOString(),
    }),
  );
};

const sourceUrl = "https://www.rfc-editor.org/rfc/rfc9110.txt";

const stubResearchResult = {
  schemaVersion: 3,
  kind: "research_result",
  answers: [
    {
      question: "What must the client send?",
      found: true,
      searched: ["RFC9110"],
      hits: [
        {
          rfc: { identifier: "RFC9110", rfcNumber: 9110, title: "HTTP Semantics" },
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
                sourceUrl,
                sourceHash: "fixture-source-hash",
                offsetUnit: "utf8-byte",
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
    usage: { inputTokens: 20, outputTokens: 12 },
    inputCost: { estimatedUsd: 0.00000084, rateUsdPerMillionTokens: 0.042 },
    candidates: { pool: 1, ranked: 1 },
  },
};

const makeStubClientFactory = (
  requests: Array<unknown>,
  onClose: () => void,
): RfcCliDependencies["createClient"] =>
  (async () => ({
    research: async (request: unknown) => {
      requests.push(request);
      return stubResearchResult;
    },
    verifyCitation: async () => {
      throw new Error("citation verification is not exercised by this test");
    },
    close: async () => {
      onClose();
    },
  })) as unknown as RfcCliDependencies["createClient"];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("rfc process protocol", () => {
  test("reports the published package version", async () => {
    const manifest = (await Bun.file(join(import.meta.dir, "../package.json")).json()) as {
      readonly version: string;
    };
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/bin.ts"), "--version"],
      { cwd: repositoryRoot },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`rfc v${manifest.version}\n`);
    expect(result.stderr.toString()).toBe("");
  });

  test("registers only live retrieval commands", async () => {
    const result = await runCli(["catalog", "status"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("prints cumulative global costs as JSON or human output", async () => {
    const totals = {
      ...noUsageTotals,
      updatedAt: "2026-01-02T03:04:05.000Z",
      operations: 3,
      pricedOperations: 1,
      unpricedOperations: 1,
      operationsWithoutInputTokens: 1,
      inputTokens: 150,
      pricedInputTokens: 100,
      unpricedInputTokens: 50,
      estimatedInputCostUsd: 0.0000042,
    };
    const readUsage: RfcCliDependencies["readUsage"] = async () => totals;

    const json = await runCli(
      ["costs", "--format", "json"],
      undefined,
      makeFixtureCredentialStore(),
      createRfcClient,
      discardUsage,
      readUsage,
    );
    const human = await runCli(
      ["costs"],
      undefined,
      makeFixtureCredentialStore(),
      createRfcClient,
      discardUsage,
      readUsage,
    );

    expect(json).toEqual({ exitCode: 0, stdout: `${JSON.stringify(totals)}\n`, stderr: "" });
    expect(human).toEqual({
      exitCode: 0,
      stdout: [
        "Updated: 2026-01-02T03:04:05.000Z",
        "Operations: 3",
        "Priced operations: 1",
        "Unpriced operations: 1",
        "Operations without input tokens: 1",
        "Input tokens: 150",
        "Priced input tokens: 100",
        "Unpriced input tokens: 50",
        "Estimated input cost (USD): $0.000004200",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("routes named-RFC cache status and removal through the client facade", async () => {
    const operations: Array<string> = [];
    let closed = 0;
    const createClient = (async () => ({
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
        throw new Error("citation verification is not exercised by this test");
      },
      close: async () => {
        closed += 1;
      },
    })) as unknown as RfcCliDependencies["createClient"];

    const status = await runCli(
      ["cache", "status", "RFC9110", "--format", "json"],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );
    const removed = await runCli(
      ["cache", "remove", "RFC9110"],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );

    expect(status.exitCode).toBe(0);
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout)).toEqual({
      schemaVersion: 3,
      kind: "source_cache_status",
      rfc: "RFC9110",
      state: "hit",
    });
    expect(removed.exitCode).toBe(0);
    expect(removed.stderr).toBe("");
    expect(removed.stdout).toBe("RFC: RFC9110\nCache: removed\n");
    expect(operations).toEqual(["status:RFC9110", "remove:RFC9110"]);
    expect(closed).toBe(2);
  });

  test("accepts version 3 JSON and repeatable convenience flags", async () => {
    const requests: Array<unknown> = [];
    let closed = 0;
    const createClient = makeStubClientFactory(requests, () => {
      closed += 1;
    });

    const canonical = await runCli(
      ["research", "--question", "ignored", "--rfc", "RFC9999"],
      JSON.stringify({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
      }),
      makeFixtureCredentialStore(),
      createClient,
    );
    const convenience = await runCli(
      [
        "research",
        "--question",
        "What does the 429 status code mean?",
        "-q",
        "Which header says how long to wait?",
        "--rfc",
        "RFC6585",
        "-r",
        "RFC9110",
        "--format",
        "json",
      ],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );
    const human = await runCli(
      ["research", "-q", "What must the client send?", "-r", "RFC9110"],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );

    expect(canonical.exitCode).toBe(0);
    expect(canonical.stderr).toBe("");
    // Structured standard input defaults to JSON output.
    expect(JSON.parse(canonical.stdout)).toMatchObject({
      schemaVersion: 3,
      kind: "research_result",
    });
    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(JSON.parse(convenience.stdout)).toMatchObject({ schemaVersion: 3 });
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toBe(
      `${renderResearchResult(stubResearchResult as unknown as ResearchResult)}\n`,
    );

    // Standard input outranks the convenience flags, repeated flags keep their
    // order, and an omitted searchTerms flag stays absent.
    expect(requests).toEqual([
      { schemaVersion: 3, questions: ["What must the client send?"], rfcs: ["RFC9110"] },
      {
        schemaVersion: 3,
        questions: ["What does the 429 status code mean?", "Which header says how long to wait?"],
        rfcs: ["RFC6585", "RFC9110"],
      },
      { schemaVersion: 3, questions: ["What must the client send?"], rfcs: ["RFC9110"] },
    ]);
    expect(closed).toBe(3);
  });

  test("rejects a positional question, a missing scope, and more than four repeats", async () => {
    const refuseClient: RfcCliDependencies["createClient"] = () => {
      throw new Error("a rejected research request must not construct a client");
    };
    const five = (flag: string, value: (index: number) => string) =>
      Array.from({ length: 5 }, (_, index) => [flag, value(index)]).flat();

    for (const argv of [
      ["research", "What must the client send?", "RFC9110"],
      ["research", "-q", "What must the client send?"],
      ["research", "-r", "RFC9110"],
      ["research", ...five("-q", (index) => `Question ${index}?`), "-r", "RFC9110"],
      ["research", "-q", "What?", ...five("-r", (index) => `RFC${9110 + index}`)],
      ["research", "-q", "What?", ...five("--search-term", (index) => `term ${index}`)],
    ]) {
      const result = await runCli(argv, undefined, makeFixtureCredentialStore(), refuseClient);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }

    const unscoped = await runCli(
      ["research", "-q", "What must the client send?"],
      undefined,
      makeFixtureCredentialStore(),
      refuseClient,
    );
    expect(JSON.parse(unscoped.stderr).error.message).toBe(
      "Research input must include rfcs, searchTerms, or both",
    );
  });

  test("preserves a successful result when usage accounting fails", async () => {
    const requests: Array<unknown> = [];
    const result = await runCli(
      [
        "research",
        "--question",
        "What must the client send?",
        "--rfc",
        "RFC9110",
        "--format",
        "json",
      ],
      undefined,
      makeFixtureCredentialStore(),
      makeStubClientFactory(requests, () => undefined),
      async () => {
        throw new Error("usage store unavailable");
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "research_result" });
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 3,
      kind: "warning",
      warning: {
        code: "usage_accounting_failed",
        message: "Unable to update the per-user RFC usage totals",
      },
    });
    expect(requests).toHaveLength(1);
  });

  test("decodes canonical and repeatable-flag topic requests", async () => {
    const requests: Array<unknown> = [];
    let closed = 0;
    const createClient = makeStubClientFactory(requests, () => {
      closed += 1;
    });

    const convenience = await runCli(
      [
        "research",
        "--question",
        "Which HTTP requirements apply?",
        "--search-term",
        "HTTP semantics",
        "--search-term",
        "client request",
      ],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );
    const combined = await runCli(
      [
        "research",
        "-q",
        "Which cache requirements apply?",
        "-r",
        "RFC9111",
        "--search-term",
        "cache control",
      ],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );
    const canonical = await runCli(
      ["research", "--question", "ignored", "--search-term", "ignored"],
      JSON.stringify({
        schemaVersion: 3,
        questions: ["Which cache requirements apply?"],
        searchTerms: ["cache control", "freshness lifetime"],
      }),
      makeFixtureCredentialStore(),
      createClient,
    );

    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(combined.exitCode).toBe(0);
    expect(combined.stderr).toBe("");
    expect(canonical.exitCode).toBe(0);
    expect(canonical.stderr).toBe("");
    expect(requests).toEqual([
      {
        schemaVersion: 3,
        questions: ["Which HTTP requirements apply?"],
        searchTerms: ["HTTP semantics", "client request"],
      },
      {
        schemaVersion: 3,
        questions: ["Which cache requirements apply?"],
        rfcs: ["RFC9111"],
        searchTerms: ["cache control"],
      },
      {
        schemaVersion: 3,
        questions: ["Which cache requirements apply?"],
        searchTerms: ["cache control", "freshness lifetime"],
      },
    ]);
    expect(closed).toBe(3);
  });

  test("researches a named RFC end to end and records its usage", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-research-test-"));
    const quote = "The client MUST send a request containing the target resource.";
    const sourceText = `1.  Requirements\n\n   ${quote}\n`;
    const fetchedAt = new Date().toISOString();
    await writeLiveSourceCache(cacheDirectory, sourceText, fetchedAt);

    const decisionKeys: Array<string> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/document/rfc9110/")) {
          return Response.json({
            name: "rfc9110",
            rfc_number: 9110,
            title: "HTTP Semantics",
            abstract: "HTTP semantics.",
            resource_uri: "/api/v1/doc/document/rfc9110/",
            stream: "/api/v1/name/streamname/ietf/",
            states: [],
          });
        }
        if (url.pathname.endsWith("/relateddocument/")) {
          return Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
            objects: [],
          });
        }
        if (url.pathname !== "/systemone") {
          return new Response("not found", { status: 404 });
        }
        // Answer every decision confidently for its first real option, so
        // the one section and paragraph are selected and judged as support.
        const payload = (await request.json()) as {
          readonly questions: Readonly<
            Record<string, { readonly type: string; readonly criteria?: Record<string, string> }>
          >;
        };
        const answers = Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => {
            decisionKeys.push(key);
            if (question.type === "noul") return [key, { type: "noul", noul: 0.95 }];
            const labels = Object.keys(question.criteria ?? {});
            const choice = labels.includes("supports")
              ? "supports"
              : (labels.find((label) => label !== "none") ?? "none");
            return [
              key,
              {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(
                  labels.map((label) => [label, label === choice ? 1 : 0]),
                ),
                confidence: 0.95,
              },
            ];
          }),
        );
        return Response.json({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      },
    });
    servers.push(server);
    const usageObservations: Array<Parameters<RfcCliDependencies["recordUsage"]>[0]> = [];
    const recordUsage: RfcCliDependencies["recordUsage"] = async (observation) => {
      usageObservations.push(observation);
      return discardUsage(observation);
    };
    const endpoints = [
      "--cache-directory",
      cacheDirectory,
      "--typesafe-api-url",
      server.url.toString(),
      "--datatracker-api-url",
      `${server.url}api/v1/`,
    ];

    const result = await runCli(
      ["research", ...endpoints],
      JSON.stringify({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
      }),
      makeFixtureCredentialStore(),
      createRfcClient,
      recordUsage,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout) as ResearchResult;
    expect(response).toMatchObject({
      schemaVersion: 3,
      kind: "research_result",
      answers: [{ question: "What must the client send?", found: true }],
    });
    const hit = response.answers[0]?.hits[0];
    expect(hit).toMatchObject({ rfc: { identifier: "RFC9110" }, role: "requested" });
    const passage = hit?.passages[0];
    expect(passage).toMatchObject({
      quote,
      section: "1.  Requirements",
      verdict: "supports",
      provenance: { sourceUrl, sourceHash: hashRfcSource(sourceText), offsetUnit: "utf8-byte" },
    });
    expect(
      Buffer.from(sourceText, "utf8")
        .subarray(passage?.provenance.startOffset ?? 0, passage?.provenance.endOffset ?? 0)
        .toString("utf8"),
    ).toBe(quote);
    const callCount = decisionKeys.length;
    expect(callCount).toBeGreaterThan(0);
    expect(response.diagnostics.usage.inputTokens).toBeGreaterThan(0);
    expect(response.diagnostics.resolvedModels).toEqual(["jev-1.13.0"]);

    const human = await runCli(
      ["research", ...endpoints, "-q", "What must the client send?", "-r", "RFC9110"],
      undefined,
      makeFixtureCredentialStore(),
      createRfcClient,
      recordUsage,
    );
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    const { startOffset, endOffset } = passage?.provenance ?? { startOffset: 0, endOffset: 0 };
    expect(human.stdout).toContain(
      `Q1: What must the client send?\nRFC9110 §1 Requirements · supports`,
    );
    expect(human.stdout).toContain(`Quote [${startOffset}-${endOffset}]: ${quote}\n`);
    expect(human.stdout).toContain(`Source: RFC9110 ${sourceUrl}`);
    expect(human.stdout).toContain(`Input tokens: ${response.diagnostics.usage.inputTokens}`);
    expect(human.stdout).toContain("Estimated input cost (USD): $");

    const observation = {
      inputTokens: response.diagnostics.usage.inputTokens,
      estimatedInputCostUsd: response.diagnostics.inputCost.estimatedUsd,
    };
    expect(usageObservations).toEqual([observation, observation]);
    // The same request makes the same decisions again.
    expect(decisionKeys).toHaveLength(callCount * 2);
  });

  test("verifies citations through canonical JSON and convenience flags", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-citation-test-"));
    const sourceText =
      "1. Requirements\\n\\nThe client MUST send a request containing the target resource.\\n";
    const fetchedAt = new Date().toISOString();
    const sourceHash = hashRfcSource(sourceText);
    await writeLiveSourceCache(cacheDirectory, sourceText, fetchedAt);

    let modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/doc/document/rfc9110/") {
          return Response.json({
            name: "rfc9110",
            rfc_number: 9110,
            title: "HTTP Semantics",
            abstract: "HTTP semantics.",
            resource_uri: "/api/v1/doc/document/rfc9110/",
            stream: "/api/v1/name/streamname/ietf/",
            states: [],
          });
        }
        if (url.pathname === "/api/v1/doc/relateddocument/") {
          return Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          });
        }
        if (url.pathname !== "/systemone") {
          return new Response("not found", { status: 404 });
        }
        modelCalls += 1;
        return Response.json({
          model: "jev-1.13.0",
          answers: {
            citation_verdict: {
              type: "choice",
              choice: "verified",
              probabilities: { verified: 0.99, unsupported: 0.005, contradicted: 0.005 },
              confidence: 0.99,
            },
          },
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      },
    });
    servers.push(server);
    const usageObservations: Array<Parameters<RfcCliDependencies["recordUsage"]>[0]> = [];
    const recordUsage: RfcCliDependencies["recordUsage"] = async (observation) => {
      usageObservations.push(observation);
      return discardUsage(observation);
    };
    const convenience = await runCli(
      [
        "verify-citation",
        "--cache-directory",
        cacheDirectory,
        "--typesafe-api-url",
        server.url.toString(),
        "--datatracker-api-url",
        `${server.url}api/v1/`,
        "--format",
        "json",
        "RFC9110",
        "The client sends a request.",
        "The client MUST send a request containing the target resource.",
      ],
      undefined,
      makeFixtureCredentialStore(),
      createRfcClient,
      recordUsage,
    );

    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(JSON.parse(convenience.stdout)).toMatchObject({
      schemaVersion: 3,
      kind: "citation_verification",
      verdict: "verified",
      provenance: {
        sourceHash,
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
      },
      diagnostics: {
        resolvedModel: "jev-1.13.0",
        usage: { inputTokens: 10 },
        inputCost: {
          estimatedUsd: 0.00000042,
          rateUsdPerMillionTokens: 0.042,
        },
      },
    });

    const fabricated = await runCli(
      [
        "verify-citation",
        "--cache-directory",
        cacheDirectory,
        "--typesafe-api-url",
        server.url.toString(),
        "--datatracker-api-url",
        `${server.url}api/v1/`,
      ],
      JSON.stringify({
        schemaVersion: 3,
        rfc: "RFC9110",
        claim: "The server caches requests.",
        quote: "The server MUST cache requests.",
      }),
      makeFixtureCredentialStore(),
      createRfcClient,
      recordUsage,
    );

    expect(fabricated.exitCode).toBe(0);
    const fabricatedResponse = JSON.parse(fabricated.stdout);
    expect(fabricatedResponse.verdict).toBe("fabricated");
    expect(fabricatedResponse.diagnostics.usage.inputTokens).toBeNull();
    expect(fabricatedResponse.diagnostics.inputCost).toEqual({
      estimatedUsd: null,
      rateUsdPerMillionTokens: null,
    });
    expect(usageObservations).toEqual([
      { inputTokens: 10, estimatedInputCostUsd: 0.00000042 },
      { inputTokens: null, estimatedInputCostUsd: null },
    ]);
    expect(modelCalls).toBe(1);
  });

  test("rejects version-two citation input at the process boundary", async () => {
    const result = await runCli(
      ["verify-citation"],
      JSON.stringify({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote: "The client MUST send a request.",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 3,
      kind: "error",
      error: {
        code: "invalid_input",
        message: "Citation input must use schema version 3",
      },
    });
  });

  test("returns a typed error envelope when live citation metadata fails", async () => {
    const createClient = (async () => ({
      verifyCitation: async () => {
        throw new RfcDiscoveryError({
          stage: "request",
          url: "https://datatracker.example/api/v1/doc/document/rfc9110/",
          reason: "upstream unavailable",
          attempts: 3,
        });
      },
      close: async () => undefined,
    })) as unknown as RfcCliDependencies["createClient"];
    const result = await runCli(
      ["verify-citation"],
      JSON.stringify({
        schemaVersion: 3,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote: "The client MUST send a request.",
      }),
      makeFixtureCredentialStore(),
      createClient,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 3,
      kind: "error",
      error: {
        code: "discovery_failed",
        message:
          "Unable to retrieve live RFC metadata from https://datatracker.example/api/v1/doc/document/rfc9110/: upstream unavailable",
      },
    });
  });

  test("writes versioned input failures to stderr and exits nonzero", async () => {
    const result = await runCli(
      ["research", "--question", "ignored"],
      JSON.stringify({ schemaVersion: 2, questions: ["What is HTTP?"], rfcs: ["RFC9110"] }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 3,
      kind: "error",
      error: {
        code: "invalid_input",
        message:
          "Research input must use schema version 3 with one to four questions, up to four rfcs, and up to four bounded search terms",
      },
    });
  });

  test("reports a missing credential before constructing a provider", async () => {
    const result = await runCli(
      ["research", "--question", "What is HTTP?", "--rfc", "RFC9110"],
      undefined,
      makeFixtureCredentialStore(null),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 3,
      kind: "error",
      error: {
        code: "credential_missing",
        message: "No TypeSafe API key is configured; run `rfc auth login`",
      },
    });
  });

  test("maps malformed convenience flags to invalid input", async () => {
    const result = await runCli(["research", "--question"]);
    const envelope = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(envelope.error.code).toBe("invalid_input");
  });

  test("bounds the process standard-input reader", async () => {
    const withFakeStdin = async <A>(stdin: unknown, body: () => Promise<A>): Promise<A> => {
      const original = Object.getOwnPropertyDescriptor(process, "stdin");
      Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
      try {
        return await body();
      } finally {
        if (original === undefined) delete (process as { stdin?: unknown }).stdin;
        else Object.defineProperty(process, "stdin", original);
      }
    };
    const { readStandardInput } = makeDefaultCliDependencies();

    const accepted = await withFakeStdin(Readable.from(["{", '"schemaVersion": 2', "}"]), () =>
      readStandardInput(),
    );
    expect(accepted).toBe('{"schemaVersion": 2}');

    const chunk = "x".repeat(600_000);
    const refused = await withFakeStdin(Readable.from([chunk, chunk]), () =>
      readStandardInput().then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    expect(refused).toMatchObject({
      _tag: "InvalidInputError",
      reason: "Standard input exceeds 1048576 bytes",
    });
  });

  test("echoes nothing while reading an interactive credential", async () => {
    const handlers: Array<(chunk: string) => void> = [];
    const stdin = {
      isTTY: true,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data") handlers.push(handler);
      },
      off: () => undefined,
    };
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const originalWrite = process.stderr.write.bind(process.stderr);
    let written = "";
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    process.stderr.write = ((value: string | Uint8Array) => {
      written += typeof value === "string" ? value : Buffer.from(value).toString("utf8");
      return true;
    }) as typeof process.stderr.write;

    try {
      const pending = makeDefaultCliDependencies().promptCredential();
      // The handler is registered synchronously by the prompt.
      for (const character of "sk-live-typed\u007f\n") {
        for (const handler of handlers) handler(character);
      }
      await expect(pending).resolves.toBe("sk-live-type");
    } finally {
      process.stderr.write = originalWrite;
      if (originalStdin !== undefined) Object.defineProperty(process, "stdin", originalStdin);
    }

    // Exactly the prompt and its terminating newline: no per-keystroke mask,
    // so the key's length never reaches the screen.
    expect(written).toBe("TypeSafe API key: \n");
  });

  test("refuses cleartext endpoint overrides outside loopback", async () => {
    const refuseClient: RfcCliDependencies["createClient"] = () => {
      throw new Error("a rejected endpoint override must not construct a client");
    };

    for (const [flag, value] of [
      ["--typesafe-api-url", "http://provider.example/api"],
      ["--datatracker-api-url", "http://datatracker.example/api/v1"],
    ] as const) {
      const result = await runCli(
        ["research", "--question", "What must the client send?", "--rfc", "RFC9110", flag, value],
        undefined,
        makeFixtureCredentialStore(),
        refuseClient,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 3,
        kind: "error",
        error: {
          code: "invalid_input",
          message: `${flag} must use https, or http on a loopback host`,
        },
      });
    }
  });

  test("allows loopback and https endpoint overrides", async () => {
    let constructed = 0;
    const countingClient: RfcCliDependencies["createClient"] = () => {
      constructed += 1;
      throw new RfcDiscoveryError({
        stage: "request",
        url: "https://example.test",
        reason: "stop here",
        attempts: 1,
      });
    };

    for (const value of [
      "http://localhost:4000/api",
      "http://127.0.0.1:4000/api",
      "http://[::1]:4000/api",
      "https://provider.example/api",
    ]) {
      const result = await runCli(
        [
          "research",
          "--question",
          "What must the client send?",
          "--rfc",
          "RFC9110",
          "--typesafe-api-url",
          value,
        ],
        undefined,
        makeFixtureCredentialStore(),
        countingClient,
      );

      expect(JSON.parse(result.stderr).error.message).not.toContain("loopback");
    }
    expect(constructed).toBe(4);
  });

  test("never copies argument text into a parse-failure envelope", async () => {
    // Effect's CliError messages interpolate the offending value verbatim
    // (`InvalidValue` renders `Invalid value for flag --x: "<value>"`), so the
    // envelope must be derived from the failure tag and never from argv.
    const marker = "sk-live-argv-marker";
    const invocations: ReadonlyArray<ReadonlyArray<string>> = [
      ["research", "--question", "--offset", marker],
      ["verify-citation", "--rfc", "RFC9110", "--offset", marker],
      ["source-cache", "status", `--unknown-flag=${marker}`],
      ["source-cache", "status", marker],
      [marker],
      ["auth", marker],
    ];

    for (const argv of invocations) {
      const result = await runCli([...argv]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(marker);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_input");
    }
  });
});

describe("research result rendering", () => {
  const successorUrl = "https://www.rfc-editor.org/rfc/rfc9999.txt";
  // Quote bytes a formatter could plausibly disturb: a line break, runs of
  // spaces, trailing whitespace, and non-ASCII.
  const requestedQuote = "The client MUST send\n   a request  containing the target — resource. ";
  const secondQuote = "A server MAY  reject the request.\n";
  const successorQuote = "Successors SHOULD mention “this”.";
  const passage = (
    quote: string,
    section: string | null,
    url: string,
    startOffset: number,
    endOffset: number,
    verdict = "supports",
  ) => ({
    quote,
    section,
    probability: 0.9,
    verdict,
    provenance: {
      sourceUrl: url,
      sourceHash: "fixture-source-hash",
      offsetUnit: "utf8-byte",
      startOffset,
      endOffset,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const result = (overrides: object = {}) =>
    ({
      ...stubResearchResult,
      answers: [
        {
          question: "Which section says what the client must send?",
          found: true,
          searched: ["RFC9110", "RFC9999"],
          hits: [
            {
              rfc: { identifier: "RFC9110" },
              role: "requested",
              relevance: 0.931,
              verdict: "supports",
              passages: [
                passage(requestedQuote, "3.1.  Requests", sourceUrl, 120, 193),
                passage(secondQuote, null, sourceUrl, 400, 434, "partial"),
              ],
            },
            {
              rfc: { identifier: "RFC9999" },
              role: "current",
              relevance: null,
              verdict: "supports",
              passages: [passage(successorQuote, "Appendix A.  Updates", successorUrl, 50, 87)],
            },
          ],
        },
        {
          question: "Does HTTP define a teapot?",
          found: false,
          searched: ["RFC9110", "RFC9999"],
          hits: [],
        },
      ],
      ...overrides,
    }) as unknown as ResearchResult;

  test("renders one exact line per passage and a not-found line per question", () => {
    expect(renderResearchResult(result(), { audience: "agent" })).toBe(
      [
        "Q1: Which section says what the client must send?",
        "RFC9110 §3.1 Requests · supports · rel 0.93",
        `Quote [120-193]: ${requestedQuote}`,
        "RFC9110 front matter · partial · rel 0.93",
        `Quote [400-434]: ${secondQuote}`,
        "RFC9999 §A Updates · supports · current successor",
        `Quote [50-87]: ${successorQuote}`,
        "Q2: Does HTTP define a teapot?",
        "not found in RFC9110, RFC9999",
      ].join("\n"),
    );
  });

  test("adds each source once per question and the usage footer only for humans", () => {
    const human = renderResearchResult(result());

    expect(human).toContain(
      `Quote [50-87]: ${successorQuote}\nSource: RFC9110 ${sourceUrl}\nSource: RFC9999 ${successorUrl}\nQ2:`,
    );
    expect(human.split(sourceUrl).length - 1).toBe(1);
    expect(human).toEndWith(
      "not found in RFC9110, RFC9999\nInput tokens: 20\nEstimated input cost (USD): $0.000000840",
    );

    const agent = renderResearchResult(result(), { audience: "agent" });
    expect(agent).not.toContain("Source:");
    expect(agent).not.toContain("Input tokens");
    expect(agent).not.toContain("Estimated input cost");

    const unpriced = renderResearchResult(
      result({
        diagnostics: {
          ...stubResearchResult.diagnostics,
          usage: { inputTokens: null, outputTokens: null },
          inputCost: { estimatedUsd: null, rateUsdPerMillionTokens: null },
        },
      }),
    );
    expect(unpriced).toEndWith(
      "Input tokens: unavailable\nEstimated input cost (USD): unavailable",
    );
  });

  test("explains why a topic question found nothing", () => {
    const topic = (pool: number) =>
      renderResearchResult(
        result({
          answers: [
            { question: "Which RFC defines teapots?", found: false, searched: [], hits: [] },
          ],
          diagnostics: { ...stubResearchResult.diagnostics, candidates: { pool, ranked: 0 } },
        }),
        { audience: "agent" },
      );

    // Discovery found nothing: the caller should change search terms.
    expect(topic(0)).toBe(
      "Q1: Which RFC defines teapots?\nnot found: no RFC title or abstract matched the search terms",
    );
    // Discovery worked and ranking rejected every candidate.
    expect(topic(3)).toBe(
      "Q1: Which RFC defines teapots?\nnot found: none of 3 candidate RFCs specifies this",
    );
  });

  test("leads with currency only when a named RFC has a different or uncertain current RFC", () => {
    const rendered = renderResearchResult(
      result({
        currency: [
          { requested: "RFC7231", current: ["RFC9110"], complete: true, paths: [] },
          { requested: "RFC9110", current: ["RFC9110"], complete: true, paths: [] },
          { requested: "RFC2616", current: ["RFC9110", "RFC9111"], complete: true, paths: [] },
          { requested: "RFC1234", current: [], complete: false, paths: [] },
          { requested: "RFC6585", current: ["RFC6585"], complete: false, paths: [] },
        ],
      }),
      { audience: "agent" },
    );

    expect(rendered).toStartWith(
      [
        "Currency: RFC7231 → RFC9110",
        "Currency: RFC2616 → RFC9110, RFC9111",
        "Currency: RFC1234 → current RFC unresolved (incomplete: some successors were not fetched)",
        "Currency: RFC6585 → RFC6585 (incomplete: some successors were not fetched)",
        "Q1: Which section says what the client must send?",
      ].join("\n"),
    );
    // A complete report whose current RFC is the one named adds nothing.
    expect(rendered).not.toContain("Currency: RFC9110");
  });

  test("projects the agent JSON without diagnostics or trivial currency", () => {
    const json = JSON.parse(
      researchResultAgentJson(
        result({
          currency: [
            { requested: "RFC7231", current: ["RFC9110"], complete: true, paths: [] },
            { requested: "RFC9110", current: ["RFC9110"], complete: true, paths: [] },
          ],
        }),
      ),
    );
    expect(json.currency).toEqual([{ requested: "RFC7231", current: ["RFC9110"], complete: true }]);
    expect(
      json.answers[0].hits.map((hit: { rfc: string; relevance: number | null }) => [
        hit.rfc,
        hit.relevance,
      ]),
    ).toEqual([
      ["RFC9110", 0.93],
      ["RFC9999", null],
    ]);
    expect(json.answers[0].hits[0].passages[0]).toEqual({
      section: "§3.1 Requests",
      verdict: "supports",
      quote: requestedQuote,
      bytes: [120, 193],
    });
    expect(json.answers[0].searched).toBeUndefined();
    // Answers are positional: answers[i] answers questions[i], so the question is not echoed.
    expect(json.answers[0].question).toBeUndefined();
    expect(json.answers[1]).toEqual({
      found: false,
      searched: ["RFC9110", "RFC9999"],
      hits: [],
    });
    expect(json.diagnostics).toBeUndefined();
  });
});
