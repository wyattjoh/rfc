import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  evaluationCorpus,
  evaluationSchemaVersion,
  hashRfcSource,
  makeEvaluationReport,
} from "@wyattjoh/rfc-core";
import { automaticAnswerActivationFor, type RfcCliConfig } from "../src/config";
import type { CredentialStore } from "../src/credentials";
import { run } from "../src/main";

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

const runCli = async (
  args: Array<string>,
  input: string | undefined = undefined,
  credentialStore: CredentialStore = makeFixtureCredentialStore(),
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  let stdout = "";
  let stderr = "";
  const exitCode = await run(args, {
    credentialStore,
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
      freshUntil: "9999-12-31T23:59:59.999Z",
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
      sourceHashes: ["fixture"],
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      resolvedModels: evaluationCase.category === "fabricated_quotation" ? [] : ["jev-1.13.0"],
      policyVersion: "precision-v1",
      usage:
        evaluationCase.category === "fabricated_quotation"
          ? { inputTokens: null, outputTokens: null }
          : { inputTokens: 1, outputTokens: 1 },
      timings: {
        catalogMs: 1,
        documentMs: evaluationCase.kind === "research" ? 1 : null,
        sourceMs: 1,
        lexicalMs: evaluationCase.kind === "research" ? 1 : null,
        selectionMs: evaluationCase.kind === "research" ? 1 : null,
        relationMs: evaluationCase.kind === "research" ? 1 : null,
        verificationMs: evaluationCase.kind === "citation" ? 1 : null,
        totalMs: 1,
      },
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
      makeEvaluationReport(timedCorpus, timedObservations, {
        origin: "live",
        releaseBuildId: "rfc-evidence-precision-v4",
        corpusDigest: "fixture-corpus-digest",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
        authoritativeSourceHashes: {},
        policyVersion: "precision-v1",
        requestedModel: "jev-latest",
        pinnedModel: "jev-1.13.0",
        minimumSupportedClaimPrecision: undefined,
        maxKnownRfcP95LatencyMilliseconds: undefined,
        maxTopicP95LatencyMilliseconds: undefined,
      }),
    )}\n`,
  );
};

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("rfc process protocol", () => {
  test("does not register the removed catalog command", async () => {
    const result = await runCli(["catalog", "status"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("accepts version 2 known-RFC JSON and convenience input", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-live-research-test-"));
    const sourceText =
      "1. Requirements\n\nThe client MUST send a request containing the target resource.\n";
    const fetchedAt = new Date().toISOString();
    const sourceHash = hashRfcSource(sourceText);
    await mkdir(join(cacheDirectory, "sources"), { recursive: true });
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

    const datatrackerUrls: Array<string> = [];
    let modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/document/rfc9110/")) {
          datatrackerUrls.push(url.toString());
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
          datatrackerUrls.push(url.toString());
          return Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
            objects: [],
          });
        }
        if (url.pathname === "/systemone") {
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
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const commonArgs = [
      "research",
      "--cache-directory",
      cacheDirectory,
      "--datatracker-api-url",
      `${server.url}api/v1/`,
      "--typesafe-api-url",
      server.url.toString(),
    ];

    const canonical = await runCli(
      [...commonArgs, "--question", "ignored", "--rfc", "RFC9999"],
      JSON.stringify({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    );
    const convenience = await runCli([
      ...commonArgs,
      "--question",
      "What must the client send?",
      "--rfc",
      "RFC9110",
    ]);

    expect(canonical.exitCode).toBe(0);
    expect(canonical.stderr).toBe("");
    expect(JSON.parse(canonical.stdout)).toMatchObject({
      schemaVersion: 2,
      rfc: { identifier: "RFC9110" },
      diagnostics: {
        schemaVersion: 2,
        retrieval: { sourceCacheOutcome: "hit", sourceRequestCount: 0 },
      },
    });
    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(JSON.parse(convenience.stdout)).toMatchObject({
      schemaVersion: 2,
      rfc: { identifier: "RFC9110" },
    });
    expect(datatrackerUrls).toHaveLength(4);
    expect(datatrackerUrls.every((url) => url.includes("rfc9110"))).toBe(true);
    expect(await Bun.file(join(cacheDirectory, "catalog.json")).exists()).toBe(false);
  });

  test("routes repeatable topic terms through bounded live discovery", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-live-topic-test-"));
    const sourceText =
      "1. Requirements\n\nThe client MUST send a request containing the target resource.\n";
    const fetchedAt = new Date().toISOString();
    await writeLiveSourceCache(cacheDirectory, sourceText, fetchedAt);
    const topicUrls: Array<string> = [];
    let modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/document/")) {
          topicUrls.push(url.toString());
          return Response.json({
            meta: { limit: 20, offset: 0, total_count: 1, next: null, previous: null },
            objects: [
              {
                name: "rfc9110",
                rfc_number: 9110,
                title: "HTTP Semantics",
                abstract: "HTTP semantics.",
                resource_uri: "/api/v1/doc/document/rfc9110/",
                stream: "/api/v1/name/streamname/ietf/",
                states: [],
              },
            ],
          });
        }
        if (url.pathname !== "/systemone") return new Response("not found", { status: 404 });
        modelCalls += 1;
        const payload = (await request.json()) as {
          readonly questions: Readonly<Record<string, unknown>>;
        };
        return Response.json({
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(payload.questions).map((key) =>
              key === "question_atomicity"
                ? [
                    key,
                    {
                      type: "choice",
                      choice: "atomic",
                      probabilities: { atomic: 0.99, compound: 0.01 },
                      confidence: 0.99,
                    },
                  ]
                : modelCalls < 3
                  ? [key, { type: "noul", noul: 0.99 }]
                  : [
                      key,
                      {
                        type: "choice",
                        choice: "direct_answer",
                        probabilities: {
                          direct_answer: 0.99,
                          partial_answer: 0.0025,
                          background_only: 0.0025,
                          contradictory: 0.0025,
                          irrelevant: 0.0025,
                        },
                        confidence: 0.99,
                      },
                    ],
            ),
          ),
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      },
    });
    servers.push(server);

    const result = await runCli([
      "research",
      "--cache-directory",
      cacheDirectory,
      "--datatracker-api-url",
      `${server.url}api/v1/`,
      "--typesafe-api-url",
      server.url.toString(),
      "--question",
      "Which HTTP requirements apply?",
      "--search-term",
      "HTTP semantics",
      "--search-term",
      "client request",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 2,
      kind: "evidence_bundle",
      rfc: { identifier: "RFC9110" },
    });
    expect(
      topicUrls.map((value) => {
        const url = new URL(value);
        return (
          url.searchParams.get("title__icontains") ?? url.searchParams.get("abstract__icontains")
        );
      }),
    ).toEqual(["HTTP semantics", "HTTP semantics", "client request", "client request"]);
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
    );
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Status: needs_review");
    expect(human.stdout).toContain("RFC: RFC9110");
    expect(human.stdout).toContain("The client MUST send");
    expect(modelCalls).toBe(4);
  });

  if (existsSync(reviewedReleaseReportPath)) {
    test("activates the exact measured report only with explicit opt-in", () => {
      const config = {
        modelAlias: "jev-1.13.0",
        policyPreset: "precision-v1",
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
      expect(automaticAnswerActivationFor(config)).toBeDefined();
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
    const convenience = await runCli([
      "verify-citation",
      "--cache-directory",
      cacheDirectory,
      "--typesafe-api-url",
      server.url.toString(),
      "--datatracker-api-url",
      `${server.url}api/v1/`,
      "--rfc",
      "RFC9110",
      "--claim",
      "The client sends a request.",
      "--quote",
      "The client MUST send a request containing the target resource.",
    ]);

    expect(convenience.exitCode).toBe(0);
    expect(convenience.stderr).toBe("");
    expect(JSON.parse(convenience.stdout)).toMatchObject({
      kind: "citation_verification",
      verdict: "verified",
      provenance: {
        sourceHash,
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
      },
      diagnostics: { resolvedModel: "jev-1.13.0" },
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
        schemaVersion: 1,
        rfc: "RFC9110",
        claim: "The server caches requests.",
        quote: "The server MUST cache requests.",
      }),
    );

    expect(fabricated.exitCode).toBe(0);
    expect(JSON.parse(fabricated.stdout).verdict).toBe("fabricated");
    expect(modelCalls).toBe(1);
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
        message: "No TypeSafe API key is configured; run `rfc auth add`",
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
});
