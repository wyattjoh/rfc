import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import {
  evaluationCorpus,
  evaluationSchemaVersion,
  createRfcClient,
  hashRfcSource,
  makeEvaluationReport,
  RfcDiscoveryError,
} from "@wyattjoh/rfc-core";
import { automaticAnswerActivationFor, type RfcCliConfig } from "../src/config";
import type { CredentialStore } from "../src/credentials";
import { makeDefaultCliDependencies, run, type RfcCliDependencies } from "../src/main";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

const repositoryRoot = join(import.meta.dir, "../../..");
const reviewedReleaseReportPath = join(repositoryRoot, ".scratch/rfc-evaluation-report.json");

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

const writeUnattestedCalibrationReport = async (path: string): Promise<void> => {
  const observations = evaluationCorpus.cases.map((evaluationCase) => {
    const expectedOutcome =
      evaluationCase.kind === "research"
        ? evaluationCase.expectedStatus
        : evaluationCase.expectedVerdict;
    if (expectedOutcome === null)
      throw new Error(`Missing expected outcome for ${evaluationCase.id}`);
    return {
      schemaVersion: evaluationSchemaVersion,
      caseId: evaluationCase.id,
      category: evaluationCase.category,
      kind: evaluationCase.kind,
      mode: evaluationCase.mode,
      expectedOutcome,
      observedOutcome: expectedOutcome,
      allowedOutcomes: evaluationCase.allowedOutcomes,
      acceptedByPolicy:
        expectedOutcome === "answered" ||
        (evaluationCase.kind === "citation" && evaluationCase.expectedVerdict === "verified"),
      unsafeCitationAccepted: false,
      sourceProvenance: [{ identifier: evaluationCase.rfc ?? "RFC9110", sourceHash: "fixture" }],
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      resolvedModels: evaluationCase.category === "fabricated_quotation" ? [] : ["jev-1.13.0"],
      policyVersion: "precision-v2",
      usage:
        evaluationCase.category === "fabricated_quotation"
          ? { inputTokens: null, outputTokens: null }
          : { inputTokens: 1, outputTokens: 1 },
      timings: {
        metadataMs: 1,
        documentMs: evaluationCase.kind === "research" ? 1 : null,
        sourceMs: 1,
        lexicalMs: evaluationCase.kind === "research" ? 1 : null,
        selectionMs: evaluationCase.kind === "research" ? 1 : null,
        relationMs: evaluationCase.kind === "research" ? 1 : null,
        verificationMs: evaluationCase.kind === "citation" ? 1 : null,
        totalMs: 1,
      },
      retrieval: null,
      totalLatencyMs: 1,
      probabilities: (expectedOutcome === "answered"
        ? {
            "selection.fixture.probability": 0.99,
            "classification.fixture.direct_answer": 0.99,
          }
        : {}) as Readonly<Record<string, number>>,
      confidence: 1,
      errorKind: null,
    };
  });
  const timedCorpus = {
    ...evaluationCorpus,
    cases: evaluationCorpus.cases.flatMap((evaluationCase) =>
      Array.from({ length: 3 }, (_, index) => ({
        ...evaluationCase,
        id: `${evaluationCase.id}:iteration-${index + 1}`,
      })),
    ),
  };
  const timedObservations = Array.from({ length: 3 }, (_, index) =>
    observations.map((observation) => ({
      ...observation,
      caseId: `${observation.caseId}:iteration-${index + 1}`,
    })),
  ).flat();
  await writeFile(
    path,
    `${JSON.stringify(
      makeEvaluationReport(
        timedCorpus,
        timedObservations,
        evaluationCorpus.retrievalCases.map((retrievalCase) => ({
          schemaVersion: evaluationSchemaVersion,
          caseId: retrievalCase.id,
          category: retrievalCase.category,
          seam: retrievalCase.seam,
          passed: true,
          traces: [],
          cacheEvidence: null,
          errorKind: null,
        })),
        {
          origin: "live",
          releaseBuildId: "rfc-evidence-precision-v2",
          corpusDigest: "fixture-corpus-digest",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
          authoritativeSourceHashes: undefined,
          policyVersion: "precision-v2",
          requestedModel: "jev-latest",
          pinnedModel: "jev-1.13.0",
          minimumSupportedClaimPrecision: undefined,
          maxKnownRfcP95LatencyMilliseconds: undefined,
          maxTopicP95LatencyMilliseconds: undefined,
        },
      ),
    )}\n`,
  );
};

const stubEvidenceBundle = {
  schemaVersion: 2,
  kind: "evidence_bundle",
  status: "answered",
  question: "What must the client send?",
  rfc: { identifier: "RFC9110", rfcNumber: 9110, title: "HTTP Semantics" },
  evidence: [],
  contexts: [],
  issues: [],
  diagnostics: {
    schemaVersion: 2,
    usage: { inputTokens: 20, outputTokens: 12 },
    inputCost: { estimatedUsd: 0.00000084, rateUsdPerMillionTokens: 0.042 },
  },
};

const makeStubClientFactory = (
  requests: Array<unknown>,
  onClose: () => void,
): RfcCliDependencies["createClient"] =>
  (async () => ({
    research: async (request: unknown) => {
      requests.push(request);
      return stubEvidenceBundle;
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
      schemaVersion: 2,
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

  test("accepts version 2 known-RFC JSON and convenience input", async () => {
    const requests: Array<unknown> = [];
    let closed = 0;
    const createClient = makeStubClientFactory(requests, () => {
      closed += 1;
    });

    const canonical = await runCli(
      ["research", "--question", "ignored", "--rfc", "RFC9999"],
      JSON.stringify({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
      makeFixtureCredentialStore(),
      createClient,
    );
    const convenience = await runCli(
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
      createClient,
    );
    const human = await runCli(
      ["research", "What must the client send?", "RFC9110"],
      undefined,
      makeFixtureCredentialStore(),
      createClient,
    );

    expect(canonical.exitCode).toBe(0);
    expect(canonical.stderr).toBe("");
    expect(JSON.parse(canonical.stdout)).toMatchObject({
      schemaVersion: 2,
      rfc: { identifier: "RFC9110" },
    });
    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(JSON.parse(convenience.stdout)).toMatchObject({
      schemaVersion: 2,
      rfc: { identifier: "RFC9110" },
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("RFC9110");
    expect(human.stdout.trimStart().startsWith("{")).toBe(false);

    // Standard input outranks the convenience flags.
    expect(requests.map((request) => (request as { readonly rfc: string }).rfc)).toEqual([
      "RFC9110",
      "RFC9110",
      "RFC9110",
    ]);
    expect(
      (requests[0] as { readonly question: string; readonly schemaVersion: number }).question,
    ).toBe("What must the client send?");
    expect((requests[0] as { readonly schemaVersion: number }).schemaVersion).toBe(2);
    expect(closed).toBe(3);
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
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "evidence_bundle" });
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 2,
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
    const canonical = await runCli(
      ["research", "--question", "ignored", "--search-term", "ignored"],
      JSON.stringify({
        schemaVersion: 2,
        question: "Which cache requirements apply?",
        rfc: null,
        searchTerms: ["cache control", "freshness lifetime"],
      }),
      makeFixtureCredentialStore(),
      createClient,
    );

    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(canonical.exitCode).toBe(0);
    expect(canonical.stderr).toBe("");
    expect(requests).toEqual([
      {
        schemaVersion: 2,
        question: "Which HTTP requirements apply?",
        rfc: null,
        searchTerms: ["HTTP semantics", "client request"],
      },
      {
        schemaVersion: 2,
        question: "Which cache requirements apply?",
        rfc: null,
        searchTerms: ["cache control", "freshness lifetime"],
      },
    ]);
    expect(closed).toBe(2);
  });

  test("requires the exact release attestation even when automatic answers are enabled", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-research-test-"));
    const sourceText =
      "1. Requirements\n\nThe client MUST send a request containing the target resource.\n";
    const fetchedAt = new Date().toISOString();
    const sourceHash = hashRfcSource(sourceText);
    await mkdir(join(cacheDirectory, "sources"), { recursive: true });
    await writeFile(
      join(cacheDirectory, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_catalog",
        cacheIdentity: "rfc-catalog-v1",
        fetchedAt,
        documents: [
          {
            identifier: "RFC9110",
            rfcNumber: 9110,
            title: "HTTP Semantics",
            abstract: "HTTP semantics.",
            status: "published",
            stream: "ietf",
            canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
            updates: [],
            updatedBy: [],
            obsoletes: [],
            obsoletedBy: [],
          },
        ],
      }),
    );
    await writeFile(
      join(cacheDirectory, "sources", `${sourceHash}.json`),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_source_content",
        contentHash: sourceHash,
        text: sourceText,
      }),
    );
    await writeFile(
      join(cacheDirectory, "sources", "RFC9110.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_source_index",
        identifier: "RFC9110",
        rfcNumber: 9110,
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        contentHash: sourceHash,
        fetchedAt,
      }),
    );
    await writeLiveSourceCache(cacheDirectory, sourceText, fetchedAt);

    const evaluationOutput = join(cacheDirectory, "accepted-evaluation.json");
    await writeUnattestedCalibrationReport(evaluationOutput);

    let modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
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
        modelCalls += 1;
        const answers = Object.fromEntries([
          [
            "question_atomicity",
            {
              type: "choice",
              choice: "atomic",
              probabilities: { atomic: 0.99, compound: 0.01 },
              confidence: 0.99,
            },
          ],
          ...Array.from({ length: 8 }, (_, index) => [
            `passage_${index}`,
            modelCalls % 2 === 1
              ? { type: "noul", noul: 0.99 }
              : {
                  type: "choice",
                  choice: "direct_answer",
                  probabilities: {
                    direct_answer: 0.99,
                    partial_answer: 0.005,
                    background_only: 0.001,
                    contradictory: 0.001,
                    irrelevant: 0.003,
                  },
                  confidence: 0.99,
                },
          ]),
        ]);
        return Response.json({
          model: "jev-1.13.0",
          answers,
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

    const result = await runCli(
      [
        "research",
        "--cache-directory",
        cacheDirectory,
        "--typesafe-api-url",
        server.url.toString(),
        "--datatracker-api-url",
        `${server.url}api/v1/`,
      ],
      JSON.stringify({ schemaVersion: 2, question: "What must the client send?", rfc: "9110" }),
      makeFixtureCredentialStore(),
      createRfcClient,
      recordUsage,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout);
    expect(response.status).toBe("needs_review");
    expect(response.rfc.identifier).toBe("RFC9110");
    expect(response.evidence[0].provenance.sourceUrl).toBe(
      "https://www.rfc-editor.org/rfc/rfc9110.txt",
    );
    expect(response.diagnostics.resolvedModel).toBe("jev-1.13.0");
    expect(response.diagnostics.usage.inputTokens).toBe(20);
    expect(response.diagnostics.inputCost).toEqual({
      estimatedUsd: 0.00000084,
      rateUsdPerMillionTokens: 0.042,
    });

    const human = await runCli(
      [
        "research",
        "--cache-directory",
        cacheDirectory,
        "--typesafe-api-url",
        server.url.toString(),
        "--datatracker-api-url",
        `${server.url}api/v1/`,
        "--format",
        "human",
      ],
      JSON.stringify({ schemaVersion: 2, question: "What must the client send?", rfc: "9110" }),
      makeFixtureCredentialStore(),
      createRfcClient,
      recordUsage,
    );
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Status: needs_review");
    expect(human.stdout).toContain("RFC: RFC9110");
    expect(human.stdout).toContain("Evidence RFC: RFC9110 (requested context)");
    expect(human.stdout).toContain("The client MUST send");
    expect(human.stdout).toContain("Source: https://www.rfc-editor.org/rfc/rfc9110.txt");
    expect(human.stdout).toContain("Offsets: 0-80 (utf8-byte)");
    expect(human.stdout).toContain("Input tokens: 20");
    expect(human.stdout).toContain("Estimated input cost (USD): $0.000000840");
    expect(usageObservations).toEqual([
      { inputTokens: 20, estimatedInputCostUsd: 0.00000084 },
      { inputTokens: 20, estimatedInputCostUsd: 0.00000084 },
    ]);
    expect(modelCalls).toBe(4);
  });

  if (existsSync(reviewedReleaseReportPath)) {
    test("keeps automatic answers disabled for the reviewed rejected report", () => {
      const config = {
        modelAlias: "jev-1.13.0",
        policyPreset: "precision-v2",
        evaluationModel: "jev-latest",
        pinnedModel: "jev-1.13.0",
        liveEvaluation: false,
        automaticAnswerEnabled: true,
        evaluationCacheDirectory: "/tmp/rfc-evaluation-cache",
        evaluationOutput: reviewedReleaseReportPath,
      } satisfies RfcCliConfig;

      expect(
        automaticAnswerActivationFor({ ...config, automaticAnswerEnabled: false }),
      ).toBeUndefined();
      expect(automaticAnswerActivationFor(config)).toBeUndefined();
    });
  }

  test("returns every valid non-answer status successfully through JSON process semantics", async () => {
    const cases = [
      { status: "partial", question: "What must the client send?" },
      { status: "unsupported", question: "What must the client send?" },
      { status: "needs_review", question: "What must the client send?" },
      { status: "needs_split", question: "What must the client send?" },
    ] as const;
    let caseIndex = 0;
    let requestCount = 0;
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
        requestCount += 1;
        const payload = (await request.json()) as {
          readonly questions: Readonly<Record<string, unknown>>;
        };
        const currentCase = cases[caseIndex];
        if (currentCase === undefined) return new Response("unexpected case", { status: 500 });
        const isSelection = Object.prototype.hasOwnProperty.call(
          payload.questions,
          "question_atomicity",
        );
        const compound = currentCase.status === "needs_split";
        const answers = Object.fromEntries(
          Object.keys(payload.questions).map((key) => {
            if (key === "question_atomicity") {
              return [
                key,
                {
                  type: "choice",
                  choice: compound ? "compound" : "atomic",
                  probabilities: compound
                    ? { atomic: 0.01, compound: 0.99 }
                    : { atomic: 0.99, compound: 0.01 },
                  confidence: 0.99,
                },
              ];
            }
            if (isSelection) {
              return [
                key,
                {
                  type: "noul",
                  noul: currentCase.status === "unsupported" ? 0.1 : 0.99,
                },
              ];
            }
            const uncertain = currentCase.status === "needs_review";
            const relation = currentCase.status === "partial" ? "partial_answer" : "direct_answer";
            const probability = uncertain ? 0.5 : 0.99;
            const remainder = (1 - probability) / 4;
            return [
              key,
              {
                type: "choice",
                choice: relation,
                probabilities: {
                  direct_answer: relation === "direct_answer" ? probability : remainder,
                  partial_answer: relation === "partial_answer" ? probability : remainder,
                  background_only: remainder,
                  contradictory: remainder,
                  irrelevant: remainder,
                },
                confidence: uncertain ? 0.5 : 0.99,
              },
            ];
          }),
        );
        return Response.json({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      },
    });
    servers.push(server);

    for (const currentCase of cases) {
      const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-status-test-"));
      const sourceText =
        "1. Requirements\\n\\nThe client MUST send a request containing the target resource.\\n";
      const fetchedAt = new Date().toISOString();
      const sourceHash = hashRfcSource(sourceText);
      await mkdir(join(cacheDirectory, "sources"), { recursive: true });
      await writeFile(
        join(cacheDirectory, "catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "rfc_catalog",
          cacheIdentity: "rfc-catalog-v1",
          fetchedAt,
          documents: [
            {
              identifier: "RFC9110",
              rfcNumber: 9110,
              title: "HTTP Semantics",
              abstract: "HTTP semantics.",
              status: "published",
              stream: "ietf",
              canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
              updates: [],
              updatedBy: [],
              obsoletes: [],
              obsoletedBy: [],
            },
          ],
        }),
      );
      await writeFile(
        join(cacheDirectory, "sources", `${sourceHash}.json`),
        JSON.stringify({
          schemaVersion: 1,
          kind: "rfc_source_content",
          contentHash: sourceHash,
          text: sourceText,
        }),
      );
      await writeFile(
        join(cacheDirectory, "sources", "RFC9110.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "rfc_source_index",
          identifier: "RFC9110",
          rfcNumber: 9110,
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          contentHash: sourceHash,
          fetchedAt,
        }),
      );
      await writeLiveSourceCache(cacheDirectory, sourceText, fetchedAt);

      const result = await runCli(
        [
          "research",
          "--cache-directory",
          cacheDirectory,
          "--typesafe-api-url",
          server.url.toString(),
          "--datatracker-api-url",
          `${server.url}api/v1/`,
        ],
        JSON.stringify({ schemaVersion: 2, question: currentCase.question, rfc: "9110" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 2,
        kind: "evidence_bundle",
        status: currentCase.status,
      });
      caseIndex += 1;
    }

    expect(requestCount).toBe(6);
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
      schemaVersion: 2,
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
        schemaVersion: 2,
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

  test("rejects version-one citation input at the process boundary", async () => {
    const result = await runCli(
      ["verify-citation"],
      JSON.stringify({
        schemaVersion: 1,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote: "The client MUST send a request.",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 2,
      kind: "error",
      error: {
        code: "invalid_input",
        message: "Citation input must use schema version 2",
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
        schemaVersion: 2,
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
      schemaVersion: 2,
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
      JSON.stringify({ schemaVersion: 2, question: "What is HTTP?", rfc: null }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 2,
      kind: "error",
      error: {
        code: "invalid_input",
        message:
          "Research input must use schema version 2 with an RFC or one to four bounded search terms",
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
      schemaVersion: 2,
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
        schemaVersion: 2,
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
