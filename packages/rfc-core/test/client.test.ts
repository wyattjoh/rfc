import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  CatalogRefreshError,
  InvalidInputError,
  RfcClientClosedError,
  RfcDiscoveryError,
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

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("createRfcClient", () => {
  test("reports a missing catalog through the Promise facade", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });
    clients.push(client);

    await expect(client.catalogStatus()).resolves.toEqual({
      schemaVersion: 1,
      kind: "catalog_status",
      state: "missing",
      catalogPath: join(cacheDirectory, "catalog.json"),
      cacheIdentity: "rfc-catalog-v1",
      fetchedAt: null,
      refreshedAt: null,
      ageMs: null,
      documentCount: 0,
    });

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("prefetches and caches authoritative sources through the Promise facade", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [
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
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: "cached source",
        };
      },
    });
    clients.push(client);

    await client.catalogRefresh();
    await client.prefetchSources(["RFC9110"]);
    await client.prefetchSources(["RFC9110"]);

    expect(sourceFetches).toBe(1);
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
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
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
    expect(first.diagnostics.catalog).toBeUndefined();
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
    expect(sourceFetches).toBe(1);
    expect(datatracker.urls).toHaveLength(4);
    expect(await Bun.file(join(cacheDirectory, "catalog.json")).exists()).toBe(false);

    await rm(cacheDirectory, { recursive: true, force: true });
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
      catalogPath: undefined,
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
      catalogPath: undefined,
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
      catalogPath: undefined,
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
  });

  test("rejects work after explicit close and makes close idempotent", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });

    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.catalogStatus()).rejects.toBeInstanceOf(RfcClientClosedError);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("supports async disposal as an explicit lifecycle boundary", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });

    await client[Symbol.asyncDispose]();
    await expect(client.catalogStatus()).rejects.toBeInstanceOf(RfcClientClosedError);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("maps typed failures to a safe versioned error envelope", () => {
    expect(toErrorEnvelope(new RfcClientClosedError({}))).toEqual({
      schemaVersion: 1,
      kind: "error",
      error: {
        code: "client_closed",
        message: "The RFC client is already closed",
      },
    });

    expect(
      toErrorEnvelope(
        new CatalogRefreshError({
          stage: "decode",
          url: "https://datatracker.example/api/v1/doc/document/",
          reason: "Malformed response",
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      kind: "error",
      error: {
        code: "catalog_refresh_failed",
        message: "Unable to refresh catalog: Malformed response",
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
      schemaVersion: 1,
      kind: "error",
      error: {
        code: "discovery_failed",
        message:
          "Unable to retrieve live RFC metadata from https://datatracker.example/api/v1/doc/document/rfc9110/?format=json: Datatracker returned HTTP 503",
      },
    });
  });
});
