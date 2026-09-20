import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import type * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as PublicApi from "../src/index";
import {
  EvidenceBundleSchema,
  InvalidInputError,
  RfcClientClosedError,
  RfcDiscoveryError,
  RfcSourceFetchError,
  createRfcClient as createCoreRfcClient,
  decodeResearchRequest,
  hashRfcSource,
  toErrorEnvelope,
  type RfcClient,
  type RfcClientOptions,
} from "../src/index";

const clients: Array<RfcClient> = [];
type TestClientOptions = Omit<RfcClientOptions, "automaticAnswerActivation"> & {
  readonly automaticAnswerActivation?: RfcClientOptions["automaticAnswerActivation"];
};
const createRfcClient = (options: TestClientOptions) =>
  createCoreRfcClient({
    ...options,
    automaticAnswerActivation: options.automaticAnswerActivation,
  });

const makeCacheDirectory = async () => mkdtemp(join(tmpdir(), "rfc-core-test-"));

const seedLiveSourceCacheEntry = async (
  cacheDirectory: string,
  entry: {
    readonly text: string;
    readonly fetchedAt: string;
    readonly freshUntil: string;
    readonly etag?: string;
  },
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
      text: entry.text,
      contentHash: hashRfcSource(entry.text),
      etag: entry.etag ?? '"fixture"',
      fetchedAt: entry.fetchedAt,
      freshUntil: entry.freshUntil,
    }),
  );
};

const sourceText = [
  "1. Requirements",
  "",
  "The client MUST send a request containing the target resource.",
  "",
].join("\n");

const makeDecisionModel = (): DecisionModel.DecisionModel =>
  ({
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) =>
      Effect.succeed({
        answers: Object.fromEntries(
          Object.entries(definition.decisions).map(([key, decision]) =>
            decision._tag === "Probability"
              ? [key, { probability: 0.99 }]
              : "atomic" in decision.criteria
                ? [
                    key,
                    {
                      label: "atomic",
                      probabilities: { atomic: 0.99, compound: 0.01 },
                      confidence: 0.99,
                    },
                  ]
                : [
                    key,
                    {
                      label: "direct_answer",
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
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
  }) as DecisionModel.DecisionModel;

const datatrackerDocument = {
  name: "rfc9110",
  rfc_number: 9110,
  title: "HTTP Semantics",
  abstract: "HTTP semantics.",
  resource_uri: "/api/v1/doc/document/rfc9110/",
  stream: "/api/v1/name/streamname/ietf/",
  states: ["/api/v1/doc/state/177/"],
};

const makeDatatrackerHttpClient = (
  handler: (url: URL, call: number) => Response,
): { readonly client: HttpClient.HttpClient; readonly urls: ReadonlyArray<string> } => {
  const urls: Array<string> = [];
  return {
    urls,
    client: HttpClient.make((request, url) => {
      urls.push(url.toString());
      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(url, urls.length)));
    }),
  };
};

const researchWithSeededCache = async (
  cacheDirectory: string,
): Promise<{
  readonly result: Awaited<ReturnType<RfcClient["research"]>>;
  readonly sourceRequests: number;
}> => {
  const datatracker = makeDatatrackerHttpClient((url) =>
    url.pathname.endsWith("/document/rfc9110/")
      ? Response.json(datatrackerDocument)
      : Response.json({
          meta: { limit: 64, offset: 0, total_count: 0, next: null },
          objects: [],
        }),
  );
  let sourceRequests = 0;
  const sourceHttp = HttpClient.make((request) => {
    sourceRequests += 1;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(sourceText, {
          status: 200,
          headers: {
            etag: '"fresh"',
            "cache-control": "max-age=60",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
      ),
    );
  });
  const client = await createRfcClient({
    cacheDirectory,
    datatrackerHttpClient: datatracker.client,
    rfcSourceHttpClient: sourceHttp,
    modelAlias: "jev-test",
    typeSafeApiKey: undefined,
    typeSafeApiUrl: undefined,
    decisionModel: makeDecisionModel(),
    now: () => 30_000,
  });
  clients.push(client);
  const result = await client.research({
    schemaVersion: 2 as const,
    question: "What must the client send?",
    rfc: "RFC9110",
    searchTerms: undefined,
  });
  return { result, sourceRequests };
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("createRfcClient", () => {
  test("does not expose catalog or bulk-prefetch operations", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });
    clients.push(client);

    expect("catalogStatus" in client).toBe(false);
    expect("catalogRefresh" in client).toBe(false);
    expect("prefetchSources" in client).toBe(false);
    expect("RfcDiscovery" in PublicApi).toBe(false);
    expect("LiveRfcSource" in PublicApi).toBe(false);
    expect("RfcSourceServiceTag" in PublicApi).toBe(false);
    expect("makeRfcSourceHttpLayer" in PublicApi).toBe(false);
    expect("researchKnownRfc" in PublicApi).toBe(false);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("researches a current RFC through request-local live discovery", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) => {
      if (url.pathname.endsWith("/document/rfc9110/")) {
        return Response.json(datatrackerDocument);
      }
      if (url.pathname.endsWith("/relateddocument/")) {
        return Response.json({
          meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
          objects: [],
        });
      }
      return new Response("not found", { status: 404 });
    });
    let sourceFetches = 0;
    const clock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        await Effect.runPromise(clock.adjust(Duration.millis(7)));
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      clock,
    });
    clients.push(client);

    const request = {
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    };
    const first = await client.research(request);
    const second = await client.research(request);

    expect(first).toMatchObject({
      schemaVersion: 2,
      kind: "evidence_bundle",
      rfc: { identifier: "RFC9110" },
      diagnostics: {
        schemaVersion: 2,
        retrieval: {
          requestCount: 3,
          datatrackerRequestCount: 2,
          sourceRequestCount: 1,
          sourceCacheOutcome: "miss",
        },
      },
    });
    const serialized = JSON.parse(JSON.stringify(first));
    expect(Schema.decodeUnknownSync(EvidenceBundleSchema)(serialized)).toEqual(serialized);
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleSchema)({ ...first, schemaVersion: 1 }),
    ).toThrow();
    expect("catalog" in first.diagnostics).toBe(false);
    expect("catalogMs" in first.diagnostics.timings).toBe(false);
    expect("catalogDocuments" in first.diagnostics.candidates).toBe(false);
    expect(JSON.stringify(first)).not.toContain('"catalog');
    expect("discoveredDocuments" in first.diagnostics.candidates).toBe(true);
    expect(first.diagnostics.candidates.discoveredDocuments).toBe(1);
    expect(first.diagnostics.timings.metadataMs).toBeGreaterThanOrEqual(0);
    expect(first.rfc).not.toBeNull();
    if (first.rfc === null) throw new Error("Expected discovered RFC metadata");
    expect("updates" in first.rfc).toBe(false);
    expect("obsoletes" in first.rfc).toBe(false);
    expect(
      first.contexts?.every(
        ({ document }) => !("updates" in document) && !("obsoletes" in document),
      ),
    ).toBe(true);
    expect(first.diagnostics.retrieval?.sourceMs).toBe(7);
    expect(first.diagnostics.retrieval?.requests[2]?.durationMs).toBe(7);
    expect(first.diagnostics.retrieval?.requests.map(({ url }) => url)).toEqual([
      "https://datatracker.ietf.org/api/v1/doc/document/rfc9110/?format=json",
      "https://datatracker.ietf.org/api/v1/doc/relateddocument/?format=json&limit=64&offset=0&relationship__slug__in=obs%2Cupdates&target__name=rfc9110",
      "https://www.rfc-editor.org/rfc/rfc9110.txt",
    ]);
    expect(first.evidence[0]).toMatchObject({
      provenance: {
        identifier: "RFC9110",
        sourceHash: hashRfcSource(sourceText),
        offsetUnit: "utf8-byte",
      },
    });
    const passage = first.evidence[0];
    if (passage === undefined) throw new Error("Expected exact RFC evidence");
    expect(passage.quote).toContain(
      "The client MUST send a request containing the target resource.",
    );
    expect(
      Buffer.from(sourceText)
        .subarray(passage.provenance.startOffset, passage.provenance.endOffset)
        .toString("utf8"),
    ).toBe(passage.quote);
    expect(second.diagnostics.retrieval).toMatchObject({
      requestCount: 2,
      datatrackerRequestCount: 2,
      sourceRequestCount: 0,
      sourceCacheOutcome: "hit",
    });
    expect(second.diagnostics.retrieval?.requests).toHaveLength(2);
    expect(second.diagnostics.retrieval?.requests.every(({ kind }) => kind !== "source")).toBe(
      true,
    );
    expect(sourceFetches).toBe(1);
    expect(datatracker.urls).toHaveLength(4);
    expect(await Bun.file(join(cacheDirectory, "catalog.json")).exists()).toBe(false);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("recursively discovers successor metadata before resolving current RFCs", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const documents = new Map([
      ["rfc9110", datatrackerDocument],
      [
        "rfc9111",
        {
          ...datatrackerDocument,
          name: "rfc9111",
          rfc_number: 9111,
          title: "HTTP Update",
          resource_uri: "/api/v1/doc/document/rfc9111/",
        },
      ],
      [
        "rfc9112",
        {
          ...datatrackerDocument,
          name: "rfc9112",
          rfc_number: 9112,
          title: "HTTP Replacement",
          resource_uri: "/api/v1/doc/document/rfc9112/",
        },
      ],
    ]);
    const datatracker = makeDatatrackerHttpClient((url) => {
      const name = url.pathname.match(/\/document\/(rfc\d+)\/$/)?.[1];
      if (name !== undefined) return Response.json(documents.get(name));
      if (url.pathname.endsWith("/relateddocument/")) {
        const target = url.searchParams.get("target__name");
        const successor =
          target === "rfc9110" ? "rfc9111" : target === "rfc9111" ? "rfc9112" : null;
        return Response.json({
          meta: { limit: 64, offset: 0, total_count: successor === null ? 0 : 1, next: null },
          objects:
            successor === null
              ? []
              : [
                  {
                    source: `/api/v1/doc/document/${successor}/`,
                    target: `/api/v1/doc/document/${target}/`,
                    relationship:
                      target === "rfc9110"
                        ? "/api/v1/name/docrelationshipname/updates/"
                        : "/api/v1/name/docrelationshipname/obs/",
                  },
                ],
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async (document) => ({
        sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
        text: sourceText,
      }),
      decisionModel: makeDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.currency).toMatchObject({
      requested: "RFC9110",
      current: ["RFC9112"],
      complete: true,
      unresolved: [],
    });
    expect(result.currency?.paths).toContainEqual({
      identifier: "RFC9112",
      path: [
        { from: "RFC9110", to: "RFC9111", relationship: "updates" },
        { from: "RFC9111", to: "RFC9112", relationship: "obsoletes" },
      ],
    });
    expect(result.diagnostics.retrieval).toMatchObject({
      datatrackerRequestCount: 6,
      traversalComplete: true,
      traversalContexts: 3,
      traversalDepth: 2,
      successorRows: 2,
      contextLimit: 8,
      depthLimit: 16,
      relationshipLimit: 64,
    });
  });

  test("forces review when successor relationship results hit their bound", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) => {
      const name = url.pathname.match(/\/document\/(rfc\d+)\/$/)?.[1];
      if (name !== undefined) {
        return Response.json(
          name === "rfc9110"
            ? datatrackerDocument
            : {
                ...datatrackerDocument,
                name: "rfc9111",
                rfc_number: 9111,
                resource_uri: "/api/v1/doc/document/rfc9111/",
              },
        );
      }
      const target = url.searchParams.get("target__name");
      return Response.json(
        target === "rfc9110"
          ? {
              meta: {
                limit: 64,
                offset: 0,
                total_count: 65,
                next: "/api/v1/doc/relateddocument/?offset=64",
              },
              objects: [
                {
                  source: "/api/v1/doc/document/rfc9111/",
                  target: "/api/v1/doc/document/rfc9110/",
                  relationship: "/api/v1/name/docrelationshipname/updates/",
                },
                {
                  source: "/api/v1/doc/document/rfc9111/",
                  target: "/api/v1/doc/document/rfc9110/",
                  relationship: "/api/v1/name/docrelationshipname/updates/",
                },
              ],
            }
          : { meta: { limit: 64, offset: 0, total_count: 0, next: null }, objects: [] },
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async (document) => ({
        sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
        text: sourceText,
      }),
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.status).toBe("needs_review");
    expect(result.currency).toMatchObject({
      complete: false,
      issues: expect.arrayContaining(["traversal_limit"]),
    });
    expect(result.diagnostics.retrieval).toMatchObject({
      traversalComplete: false,
      successorRows: 2,
      relationshipLimit: 64,
    });
  });

  test("discovers topic candidates from ordered bounded caller-supplied terms", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 1, next: null },
        objects: [datatrackerDocument],
      }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "Which requirements apply?",
      rfc: null,
      searchTerms: ["HTTP semantics", "client request"],
    });

    expect(result.rfc?.identifier).toBe("RFC9110");
    expect(
      datatracker.urls.map((value) => {
        const url = new URL(value);
        return (
          url.searchParams.get("title__icontains") ?? url.searchParams.get("abstract__icontains")
        );
      }),
    ).toEqual(["HTTP semantics", "HTTP semantics", "client request", "client request"]);
    expect(datatracker.urls.every((value) => !value.includes("Which+requirements"))).toBe(true);
    expect(result.diagnostics.retrieval).toMatchObject({
      datatrackerRequestCount: 4,
      upstreamRows: 4,
      uniqueCandidates: 1,
    });
  });

  test("accepts bounded topic pages and reports upstream truncation", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: {
          limit: 20,
          offset: 0,
          total_count: 42,
          next: "/api/v1/doc/document/?offset=20",
        },
        objects: [datatrackerDocument],
      }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "Which requirements apply?",
      rfc: null,
      searchTerms: ["HTTP semantics"],
    });

    expect(result.status).toBe("needs_review");
    expect(result.diagnostics.retrieval).toMatchObject({
      upstreamRows: 2,
      uniqueCandidates: 1,
      topicTruncated: true,
    });
  });

  test("rejects metadata bodies above the byte limit before decoding", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: expect.stringContaining("metadata exceeds"),
    });
  });

  test("stops streamed metadata that exceeds the byte limit without Content-Length", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(
      () =>
        new Response("x".repeat(1024 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: expect.stringContaining("metadata exceeds"),
    });
  });

  test("rejects overlong metadata fields before semantic evaluation", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({ ...datatrackerDocument, title: "x".repeat(2_001) }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toMatchObject({ _tag: "RfcDiscoveryError", stage: "decode" });
    expect(datatracker.urls).toHaveLength(1);
  });

  test("retries transient Datatracker responses within three attempts", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let documentAttempts = 0;
    const datatracker = makeDatatrackerHttpClient((url) => {
      if (url.pathname.endsWith("/document/rfc9110/")) {
        documentAttempts += 1;
        return documentAttempts < 3
          ? new Response("temporarily unavailable", { status: 503 })
          : Response.json(datatrackerDocument);
      }
      return Response.json({
        meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
        objects: [],
      });
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(documentAttempts).toBe(3);
    expect(result.diagnostics.retrieval?.requests[0]).toMatchObject({
      attempts: 3,
      status: 200,
      statuses: [503, 503, 200],
    });
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("honors Retry-After for 429 responses and records the retry", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let documentAttempts = 0;
    const datatracker = makeDatatrackerHttpClient((url) => {
      if (url.pathname.endsWith("/document/rfc9110/")) {
        documentAttempts += 1;
        return documentAttempts === 1
          ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
          : Response.json(datatrackerDocument);
      }
      return Response.json({
        meta: { limit: 64, offset: 0, total_count: 0, next: null },
        objects: [],
      });
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(documentAttempts).toBe(2);
    expect(result.diagnostics.retrieval?.requests[0]).toMatchObject({
      attempts: 2,
      statuses: [429, 200],
    });
  });

  test("retries timeout failures before succeeding", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let documentAttempts = 0;
    const http = HttpClient.make((request, url) => {
      if (url.pathname.endsWith("/document/rfc9110/")) {
        documentAttempts += 1;
        if (documentAttempts === 1) {
          return Effect.fail(new Cause.TimeoutError()) as unknown as Effect.Effect<
            HttpClientResponse.HttpClientResponse,
            never
          >;
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(datatrackerDocument)),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: http,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(documentAttempts).toBe(2);
    expect(result.diagnostics.retrieval?.requests[0]?.statuses).toEqual([null, 200]);
  });

  test("exhausts three attempts across the full server-error range", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(
      () => new Response("server failure", { status: 599 }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      attempts: 3,
    } satisfies Partial<RfcDiscoveryError>);
    expect(datatracker.urls).toHaveLength(3);
  });

  test("refuses a retry whose delay would cross the ten-second fetch deadline", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let clockReads = 0;
    const datatracker = makeDatatrackerHttpClient(
      () => new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => (clockReads++ < 3 ? 0 : 9_500),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      attempts: 1,
    } satisfies Partial<RfcDiscoveryError>);
    expect(datatracker.urls).toHaveLength(1);
  });

  test("uses freshness and ETag validators for the RFC source cache", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let now = 0;
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    const validators: Array<string | undefined> = [];
    let sourceRequests = 0;
    const sourceHttp = HttpClient.make((request) => {
      sourceRequests += 1;
      validators.push(request.headers["if-none-match"]);
      if (sourceRequests === 2) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 304,
              headers: { etag: '"one"', "cache-control": "max-age=60" },
            }),
          ),
        );
      }
      const text = sourceRequests === 1 ? sourceText : sourceText.replace("target", "selected");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(text, {
            status: 200,
            headers: {
              etag: sourceRequests === 1 ? '"one"' : '"two"',
              "cache-control": "max-age=60",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSourceHttpClient: sourceHttp,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => now,
    });
    clients.push(client);
    const request = {
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    };

    const miss = await client.research(request);
    now = 30_000;
    const hit = await client.research(request);
    now = 61_000;
    const revalidated = await client.research(request);
    now = 122_000;
    const replaced = await client.research(request);

    expect(
      [miss, hit, revalidated, replaced].map(
        (result) => result.diagnostics.retrieval?.sourceCacheOutcome,
      ),
    ).toEqual(["miss", "hit", "revalidated", "replaced"]);
    expect(validators).toEqual([undefined, '"one"', '"one"']);
    expect(sourceRequests).toBe(3);
    expect(replaced.evidence[0]?.provenance.sourceHash).toBe(
      hashRfcSource(sourceText.replace("target", "selected")),
    );
  });

  test("repairs a cache entry whose freshness exceeds the maximum upstream lifetime", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // A far-future freshUntil would otherwise suppress revalidation forever.
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: "9999-12-31T23:59:59.999Z",
    });
    const { result, sourceRequests } = await researchWithSeededCache(cacheDirectory);

    expect(result.diagnostics.retrieval?.sourceCacheOutcome).toBe("repaired");
    expect(sourceRequests).toBe(1);
  });

  test("repairs an oversized cache entry without decoding it", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // Otherwise valid and fresh: only its size makes it unreadable, so a hit
    // here would prove the reader allocated the whole file before bounding it.
    const oversizedText = "a".repeat(17 * 1024 * 1024);
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: oversizedText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: new Date(60_000).toISOString(),
    });
    const { result, sourceRequests } = await researchWithSeededCache(cacheDirectory);

    expect(result.diagnostics.retrieval?.sourceCacheOutcome).toBe("repaired");
    expect(sourceRequests).toBe(1);
    expect(result.evidence[0]?.provenance.sourceHash).toBe(hashRfcSource(sourceText));
  });

  test("does not persist a source response marked no-store", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // A previously stored entry must also be removed once upstream forbids storage.
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: new Date(0).toISOString(),
    });
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    let sourceRequests = 0;
    const sourceHttp = HttpClient.make((request) => {
      sourceRequests += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sourceText, {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSourceHttpClient: sourceHttp,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => 30_000,
    });
    clients.push(client);
    const request = {
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    };

    const first = await client.research(request);
    const second = await client.research(request);

    expect(first.evidence[0]?.provenance.sourceHash).toBe(hashRfcSource(sourceText));
    expect(await Bun.file(join(cacheDirectory, "sources", "v2", "RFC9110.json")).exists()).toBe(
      false,
    );
    // Nothing was stored, so the second read cannot be served from cache.
    expect(second.diagnostics.retrieval?.sourceCacheOutcome).not.toBe("hit");
    expect(sourceRequests).toBe(2);
  });

  test("rejects RFC source text that is not valid UTF-8", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    // A lone continuation byte is not decodable UTF-8.
    const invalid = new Uint8Array([0x31, 0x2e, 0x20, 0x80, 0x0a]);
    const sourceHttp = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(invalid, {
            status: 200,
            headers: {
              "cache-control": "max-age=60",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
        ),
      ),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSourceHttpClient: sourceHttp,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2 as const,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcSourceFetchError",
      stage: "decode",
      reason: "RFC Editor source is not valid UTF-8",
    });
    // Nothing decodable was produced, so nothing may be stored.
    expect(await Bun.file(join(cacheDirectory, "sources", "v2", "RFC9110.json")).exists()).toBe(
      false,
    );
  });

  test("reports a failed current-context source attempt in the retrieval trace", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const documents = new Map([
      ["rfc9110", datatrackerDocument],
      [
        "rfc9111",
        {
          ...datatrackerDocument,
          name: "rfc9111",
          rfc_number: 9111,
          title: "HTTP Replacement",
          resource_uri: "/api/v1/doc/document/rfc9111/",
        },
      ],
    ]);
    const datatracker = makeDatatrackerHttpClient((url) => {
      const name = url.pathname.match(/\/document\/(rfc\d+)\/$/)?.[1];
      if (name !== undefined) return Response.json(documents.get(name));
      if (url.pathname.endsWith("/relateddocument/")) {
        const target = url.searchParams.get("target__name");
        return Response.json({
          meta: { limit: 64, offset: 0, total_count: target === "rfc9110" ? 1 : 0, next: null },
          objects:
            target === "rfc9110"
              ? [
                  {
                    source: "/api/v1/doc/document/rfc9111/",
                    target: "/api/v1/doc/document/rfc9110/",
                    relationship: "/api/v1/name/docrelationshipname/obs/",
                  },
                ]
              : [],
        });
      }
      return new Response("not found", { status: 404 });
    });
    // The requested RFC resolves; only its successor's source is unavailable.
    const sourceHttp = HttpClient.make((request, url) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith("rfc9111.txt")
            ? new Response("unavailable", { status: 503 })
            : new Response(sourceText, {
                status: 200,
                headers: {
                  "cache-control": "max-age=60",
                  "content-type": "text/plain; charset=utf-8",
                },
              }),
        ),
      ),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSourceHttpClient: sourceHttp,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => 0,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    const sourceRequests = (result.diagnostics.retrieval?.requests ?? []).filter(
      (request) => request.kind === "source",
    );
    expect(sourceRequests.map((request) => request.url)).toContain(
      "https://www.rfc-editor.org/rfc/rfc9111.txt",
    );
    const failed = sourceRequests.find((request) => request.url.endsWith("rfc9111.txt"));
    expect(failed?.attempts).toBeGreaterThan(0);
    expect(failed?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("does not send a weak validator in a conditional request", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // Stale, so revalidation is due, but the stored validator is weak.
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: new Date(1_000).toISOString(),
      etag: 'W/"weak"',
    });
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    const validators: Array<string | undefined> = [];
    const replacement = sourceText.replace("target", "selected");
    const sourceHttp = HttpClient.make((request) => {
      validators.push(request.headers["if-none-match"]);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(replacement, {
            status: 200,
            headers: {
              etag: '"strong"',
              "cache-control": "max-age=60",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSourceHttpClient: sourceHttp,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => 30_000,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(validators).toEqual([undefined]);
    expect(result.evidence[0]?.provenance.sourceHash).toBe(hashRfcSource(replacement));
  });

  test("rejects topic metadata whose name and RFC number disagree", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // The exact-lookup path already matches name against the requested RFC; a
    // topic row has no requested identifier to check against, so the published
    // RFC boundary has to be enforced while decoding the page.
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 1, next: null },
        objects: [{ ...datatrackerDocument, rfc_number: 9111 }],
      }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeDecisionModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2 as const,
        question: "Which requirements apply?",
        rfc: null,
        searchTerms: ["HTTP semantics"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: "Datatracker returned malformed or unbounded topic metadata",
    });
  });

  test("rejects topic metadata reporting RFC number zero", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 1, next: null },
        objects: [{ ...datatrackerDocument, name: "rfc0", rfc_number: 0 }],
      }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeDecisionModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2 as const,
        question: "Which requirements apply?",
        rfc: null,
        searchTerms: ["HTTP semantics"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: "Datatracker returned malformed or unbounded topic metadata",
    });
  });

  test("fails closed when stale RFC text cannot be revalidated", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let now = 0;
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    let sourceRequests = 0;
    const sourceHttp = HttpClient.make((request) => {
      sourceRequests += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          sourceRequests === 1
            ? new Response(sourceText, {
                status: 200,
                headers: {
                  etag: '"one"',
                  "cache-control": "max-age=0",
                  "content-type": "text/plain",
                },
              })
            : new Response("unavailable", { status: 503 }),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSourceHttpClient: sourceHttp,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => now,
    });
    clients.push(client);
    const request = {
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    };

    await client.research(request);
    now = 1;
    await expect(client.research(request)).rejects.toMatchObject({
      _tag: "RfcSourceRevalidationError",
    });
    expect(sourceRequests).toBe(2);
  });

  test("fails malformed Datatracker metadata immediately without local fallback", async () => {
    const cacheDirectory = await makeCacheDirectory();
    await writeFile(
      join(cacheDirectory, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_catalog",
        cacheIdentity: "rfc-catalog-v1",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        documents: [
          {
            identifier: "RFC9110",
            rfcNumber: 9110,
            title: "Local fallback must not be used",
            abstract: "",
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
    const datatracker = makeDatatrackerHttpClient(() => Response.json({ name: "rfc9110" }));
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return sourceText;
      },
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      attempts: 1,
    } satisfies Partial<RfcDiscoveryError>);
    expect(datatracker.urls).toHaveLength(1);
    expect(sourceFetches).toBe(0);
    expect(await Bun.file(join(cacheDirectory, "catalog.json")).exists()).toBe(true);
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("does not retry deterministic Datatracker client failures", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() => new Response("not found", { status: 404 }));
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      attempts: 1,
    } satisfies Partial<RfcDiscoveryError>);
    expect(datatracker.urls).toHaveLength(1);
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("decodes versioned research input at the Promise facade boundary", async () => {
    expect(
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: "RFC9110",
      }),
    ).toEqual({
      schemaVersion: 2,
      question: "What is HTTP?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: "RFC9110",
        searchTerms: ["HTTP"],
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
        searchTerms: ["one", "two", "three", "four", "five"],
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
        searchTerms: [""],
      }),
    ).toThrow(InvalidInputError);
    expect(
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
        searchTerms: ["   "],
      }),
    ).toMatchObject({ searchTerms: ["   "] });
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 1,
        question: "What is HTTP?",
        rfc: "RFC9110",
      }),
    ).toThrow(InvalidInputError);
  });

  test("rejects work after explicit close and makes close idempotent", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });

    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    await expect(
      client.research({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toBeInstanceOf(RfcClientClosedError);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("supports async disposal as an explicit lifecycle boundary", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });

    await client[Symbol.asyncDispose]();
    await expect(
      client.research({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toBeInstanceOf(RfcClientClosedError);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("maps typed failures to a safe versioned error envelope", () => {
    expect(toErrorEnvelope(new RfcClientClosedError({}))).toEqual({
      schemaVersion: 2,
      kind: "error",
      error: {
        code: "client_closed",
        message: "The RFC client is already closed",
      },
    });

    expect(
      toErrorEnvelope(
        new RfcDiscoveryError({
          stage: "request",
          url: "https://datatracker.example/api/v1/doc/document/rfc9110/?format=json",
          reason: "Datatracker returned HTTP 503",
          attempts: 3,
        }),
      ),
    ).toEqual({
      schemaVersion: 2,
      kind: "error",
      error: {
        code: "discovery_failed",
        message:
          "Unable to retrieve live RFC metadata from https://datatracker.example/api/v1/doc/document/rfc9110/?format=json: Datatracker returned HTTP 503",
      },
    });

    expect(
      toErrorEnvelope(
        new RfcSourceFetchError({
          stage: "request",
          url: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          reason: "RFC Editor returned HTTP 503",
        }),
      ),
    ).toEqual({
      schemaVersion: 2,
      kind: "error",
      error: {
        code: "source_fetch_failed",
        message:
          "Unable to fetch RFC source from https://www.rfc-editor.org/rfc/rfc9110.txt: RFC Editor returned HTTP 503",
      },
    });
  });
});
