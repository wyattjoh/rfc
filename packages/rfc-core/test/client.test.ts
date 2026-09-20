import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  RfcDocumentSchema,
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
  identity: { readonly identifier: string; readonly rfcNumber: number } | undefined = undefined,
): Promise<void> => {
  const identifier = identity?.identifier ?? "RFC9110";
  const rfcNumber = identity?.rfcNumber ?? 9110;
  await mkdir(join(cacheDirectory, "sources", "v2"), { recursive: true });
  await writeFile(
    join(cacheDirectory, "sources", "v2", `${identifier}.json`),
    JSON.stringify({
      schemaVersion: 2,
      kind: "rfc_source_cache_entry",
      cacheIdentity: "rfc-source-v2",
      identifier,
      rfcNumber,
      sourceUrl: `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`,
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

type CurrencyRelationship = {
  readonly source: number;
  readonly relationship: "obs" | "updates";
};

const currencyDocument = (rfcNumber: number) => ({
  ...datatrackerDocument,
  name: `rfc${rfcNumber}`,
  rfc_number: rfcNumber,
  title: `RFC ${rfcNumber}`,
  resource_uri: `/api/v1/doc/document/rfc${rfcNumber}/`,
});

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

const makeCurrencyFixture = async (
  relationships: ReadonlyMap<number, ReadonlyArray<CurrencyRelationship>>,
  missingDocuments: ReadonlySet<number> = new Set(),
  currencyTraversalDepthLimit: number | undefined = undefined,
) => {
  const cacheDirectory = await makeCacheDirectory();
  const sourceIdentifiers: Array<string> = [];
  const datatracker = makeDatatrackerHttpClient((url) => {
    const exactNumber = url.pathname.match(/\/document\/rfc(\d+)\/$/)?.[1];
    if (exactNumber !== undefined) {
      const rfcNumber = Number(exactNumber);
      return missingDocuments.has(rfcNumber)
        ? new Response("not found", { status: 404 })
        : Response.json(currencyDocument(rfcNumber));
    }
    if (url.pathname.endsWith("/relateddocument/")) {
      const targetName = url.searchParams.get("target__name");
      const targetNumber = Number(targetName?.slice(3));
      const successors = relationships.get(targetNumber) ?? [];
      return Response.json({
        meta: { limit: 64, offset: 0, total_count: successors.length, next: null },
        objects: successors.map(({ source, relationship }) => ({
          source: `/api/v1/doc/document/rfc${source}/`,
          target: `/api/v1/doc/document/rfc${targetNumber}/`,
          relationship: `/api/v1/name/docrelationshipname/${relationship}/`,
        })),
      });
    }
    return new Response("not found", { status: 404 });
  });
  const client = await createRfcClient({
    cacheDirectory,
    datatrackerHttpClient: datatracker.client,
    currencyTraversalDepthLimit,
    modelAlias: "jev-test",
    typeSafeApiKey: undefined,
    typeSafeApiUrl: undefined,
    rfcSourceFetcher: async (document) => {
      sourceIdentifiers.push(document.identifier);
      return {
        sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
        text: sourceText,
      };
    },
    decisionModel: makeDecisionModel(),
  });
  clients.push(client);
  return { cacheDirectory, client, datatracker, sourceIdentifiers };
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
    expect(client.sourceCacheStatus).toBeFunction();
    expect(client.sourceCacheRemove).toBeFunction();
    expect("RfcDiscovery" in PublicApi).toBe(false);
    expect("LiveRfcSource" in PublicApi).toBe(false);
    expect("RfcSourceServiceTag" in PublicApi).toBe(false);
    expect("makeRfcSourceHttpLayer" in PublicApi).toBe(false);
    expect("researchKnownRfc" in PublicApi).toBe(false);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("inspects and removes only one named source-cache entry without network access", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetchedAt = new Date(0).toISOString();
    const freshUntil = new Date(60_000).toISOString();
    await seedLiveSourceCacheEntry(cacheDirectory, { text: sourceText, fetchedAt, freshUntil });
    await seedLiveSourceCacheEntry(
      cacheDirectory,
      {
        text: sourceText.replace("target", "selected"),
        fetchedAt,
        freshUntil,
      },
      { identifier: "RFC9111", rfcNumber: 9111 },
    );
    let networkRequests = 0;
    const networkClient = HttpClient.make((request) => {
      networkRequests += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("network access was not expected")),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: networkClient,
      rfcSourceHttpClient: networkClient,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(client.sourceCacheStatus("9110")).resolves.toEqual({
      schemaVersion: 2,
      kind: "source_cache_status",
      rfc: "RFC9110",
      state: "hit",
    });
    await expect(client.sourceCacheStatus("RFC9999")).resolves.toMatchObject({ state: "miss" });
    await expect(client.sourceCacheStatus("not-an-rfc")).rejects.toBeInstanceOf(InvalidInputError);

    const rfc9110Path = join(cacheDirectory, "sources", "v2", "RFC9110.json");
    await writeFile(rfc9110Path, "{corrupt");
    await expect(client.sourceCacheStatus("RFC9110")).resolves.toMatchObject({ state: "miss" });
    await expect(client.sourceCacheRemove("RFC9110")).resolves.toEqual({
      schemaVersion: 2,
      kind: "source_cache_remove",
      rfc: "RFC9110",
      removed: true,
    });
    await expect(client.sourceCacheRemove("RFC9110")).resolves.toMatchObject({ removed: false });
    await expect(client.sourceCacheStatus("RFC9111")).resolves.toMatchObject({ state: "hit" });
    expect(await Bun.file(join(cacheDirectory, "sources", "v2", "RFC9111.json")).exists()).toBe(
      true,
    );
    expect(networkRequests).toBe(0);

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

  test("researches a direct current successor as an independent RFC context", async () => {
    const fixture = await makeCurrencyFixture(
      new Map([
        [9110, [{ source: 9111, relationship: "updates" }]],
        [9111, []],
      ]),
    );

    const result = await fixture.client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.currency).toMatchObject({
      requested: "RFC9110",
      current: ["RFC9111"],
      complete: true,
      issues: [],
      unresolved: [],
    });
    expect(result.contexts).toEqual([
      expect.objectContaining({
        role: "requested",
        document: expect.objectContaining({ identifier: "RFC9110" }),
        relationshipPath: [],
        state: "researched",
      }),
      expect.objectContaining({
        role: "current",
        document: expect.objectContaining({ identifier: "RFC9111" }),
        relationshipPath: [{ from: "RFC9110", to: "RFC9111", relationship: "updates" }],
        state: "researched",
      }),
    ]);
    expect(new Set(result.evidence.map(({ provenance }) => provenance.identifier))).toEqual(
      new Set(["RFC9110", "RFC9111"]),
    );
    expect(
      result.evidence.find(({ provenance }) => provenance.identifier === "RFC9110")?.provenance,
    ).toMatchObject({ context: "requested", relationshipPath: [] });
    expect(
      result.evidence.find(({ provenance }) => provenance.identifier === "RFC9111")?.provenance,
    ).toMatchObject({
      context: "current",
      relationshipPath: [{ from: "RFC9110", to: "RFC9111", relationship: "updates" }],
    });
    expect(fixture.sourceIdentifiers).toEqual(["RFC9110", "RFC9111"]);
    expect(
      fixture.datatracker.urls
        .filter((url) => url.includes("/relateddocument/"))
        .map((url) => new URL(url).searchParams.get("target__name")),
    ).toEqual(["rfc9110", "rfc9111"]);
    expect(
      fixture.datatracker.urls
        .filter((url) => url.includes("/relateddocument/"))
        .every(
          (url) =>
            url.includes("relationship__slug__in=obs%2Cupdates") && !url.includes("source__name"),
        ),
    ).toBe(true);
    expect(await Bun.file(join(fixture.cacheDirectory, "catalog.json")).exists()).toBe(false);

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
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

  test("researches branching terminal successors with deterministic provenance", async () => {
    const fixture = await makeCurrencyFixture(
      new Map([
        [
          9110,
          [
            { source: 9112, relationship: "obs" },
            { source: 9111, relationship: "updates" },
          ],
        ],
        [9111, []],
        [9112, []],
      ]),
    );

    const result = await fixture.client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.currency).toMatchObject({
      current: ["RFC9111", "RFC9112"],
      complete: true,
      issues: [],
    });
    expect(result.currency?.paths).toEqual([
      { identifier: "RFC9110", path: [] },
      {
        identifier: "RFC9111",
        path: [{ from: "RFC9110", to: "RFC9111", relationship: "updates" }],
      },
      {
        identifier: "RFC9112",
        path: [{ from: "RFC9110", to: "RFC9112", relationship: "obsoletes" }],
      },
    ]);
    expect(result.contexts?.map(({ document }) => document.identifier)).toEqual([
      "RFC9110",
      "RFC9111",
      "RFC9112",
    ]);
    expect(fixture.sourceIdentifiers).toEqual(["RFC9110", "RFC9111", "RFC9112"]);
    expect(result.diagnostics.retrieval).toMatchObject({
      traversalComplete: true,
      traversalContexts: 3,
      traversalDepth: 1,
      successorRows: 2,
      boundedExits: [],
    });

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
  });

  test("fails closed and terminates when live successor relationships cycle", async () => {
    const fixture = await makeCurrencyFixture(
      new Map([
        [9110, [{ source: 9111, relationship: "updates" }]],
        [9111, [{ source: 9110, relationship: "updates" }]],
      ]),
    );

    const result = await fixture.client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.status).toBe("needs_review");
    expect(result.currency).toMatchObject({
      current: [],
      complete: false,
      issues: ["cycle_detected", "missing_current_context"],
    });
    expect(result.diagnostics.retrieval).toMatchObject({
      traversalComplete: true,
      traversalContexts: 2,
      traversalDepth: 1,
      successorRows: 2,
      boundedExits: [],
    });
    expect(fixture.datatracker.urls).toHaveLength(4);

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
  });

  test("fails the operation when required successor metadata cannot be resolved", async () => {
    const fixture = await makeCurrencyFixture(
      new Map([[9110, [{ source: 9111, relationship: "updates" }]]]),
      new Set([9111]),
    );

    await expect(
      fixture.client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      url: "https://datatracker.ietf.org/api/v1/doc/document/rfc9111/?format=json",
      attempts: 1,
    } satisfies Partial<RfcDiscoveryError>);
    expect(fixture.sourceIdentifiers).toEqual([]);
    expect(fixture.datatracker.urls).toEqual([
      "https://datatracker.ietf.org/api/v1/doc/document/rfc9110/?format=json",
      "https://datatracker.ietf.org/api/v1/doc/relateddocument/?format=json&limit=64&offset=0&relationship__slug__in=obs%2Cupdates&target__name=rfc9110",
      "https://datatracker.ietf.org/api/v1/doc/document/rfc9111/?format=json",
    ]);

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
  });

  test("forces review and reports the bounded successor depth exit", async () => {
    const fixture = await makeCurrencyFixture(
      new Map([
        [9110, [{ source: 9111, relationship: "updates" }]],
        [9111, [{ source: 9112, relationship: "updates" }]],
        [9112, [{ source: 9113, relationship: "updates" }]],
        [9113, []],
      ]),
      new Set(),
      2,
    );

    const result = await fixture.client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.status).toBe("needs_review");
    expect(result.currency).toMatchObject({
      complete: false,
      issues: expect.arrayContaining(["missing_successor", "traversal_limit"]),
      unresolved: ["RFC9113"],
    });
    expect(result.diagnostics.retrieval).toMatchObject({
      traversalComplete: false,
      traversalContexts: 3,
      traversalDepth: 2,
      successorRows: 3,
      depthLimit: 2,
      boundedExits: ["depth_limit"],
    });
    expect(fixture.datatracker.urls).toHaveLength(6);

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
  });

  test("forces review and reports the eight-context traversal bound", async () => {
    const successors = Array.from({ length: 8 }, (_, index) => ({
      source: 9111 + index,
      relationship: "updates" as const,
    }));
    const fixture = await makeCurrencyFixture(
      new Map<number, ReadonlyArray<CurrencyRelationship>>([
        [9110, successors],
        ...successors.map(({ source }) => [source, []] as const),
      ]),
    );

    const result = await fixture.client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.status).toBe("needs_review");
    expect(result.currency).toMatchObject({
      complete: false,
      issues: expect.arrayContaining(["missing_successor", "traversal_limit"]),
      unresolved: ["RFC9118"],
    });
    expect(result.diagnostics.retrieval).toMatchObject({
      traversalComplete: false,
      traversalContexts: 8,
      traversalDepth: 1,
      successorRows: 8,
      contextLimit: 8,
      depthLimit: 16,
      relationshipLimit: 64,
      boundedExits: ["context_limit"],
    });
    expect(fixture.datatracker.urls).toHaveLength(16);

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
  });

  test("rejects more than 64 successor relationship records without consuming metadata", async () => {
    const fixture = await makeCurrencyFixture(
      new Map([
        [
          9110,
          Array.from({ length: 65 }, () => ({
            source: 9111,
            relationship: "updates" as const,
          })),
        ],
      ]),
    );

    await expect(
      fixture.client.research({
        schemaVersion: 2,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: "Datatracker returned malformed or unbounded successor relationships",
      attempts: 1,
    } satisfies Partial<RfcDiscoveryError>);
    expect(fixture.sourceIdentifiers).toEqual([]);
    expect(fixture.datatracker.urls).toHaveLength(2);

    await rm(fixture.cacheDirectory, { recursive: true, force: true });
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
      boundedExits: ["relationship_limit"],
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
      searchTerms: ["HTTP/2 :method", "HTTP/2 :method"],
    });

    expect(result.rfc?.identifier).toBe("RFC9110");
    expect(
      datatracker.urls.map((value) => {
        const url = new URL(value);
        return (
          url.searchParams.get("title__icontains") ?? url.searchParams.get("abstract__icontains")
        );
      }),
    ).toEqual(["HTTP/2 :method", "HTTP/2 :method", "HTTP/2 :method", "HTTP/2 :method"]);
    expect(datatracker.urls.every((value) => !value.includes("Which+requirements"))).toBe(true);
    expect(result.diagnostics.retrieval).toMatchObject({
      datatrackerRequestCount: 4,
      upstreamRows: 4,
      uniqueCandidates: 1,
    });
  });

  test("enforces topic traffic, merge, semantic, and source bounds", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const searchTerms = ["HTTP semantics", "client request", "cache control", "status code"];
    const urls: Array<string> = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const datatracker = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        urls.push(url.toString());
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        yield* Effect.sleep(Duration.millis(5));

        const term =
          url.searchParams.get("title__icontains") ??
          url.searchParams.get("abstract__icontains") ??
          "";
        const termIndex = searchTerms.indexOf(term);
        const fieldIndex = url.searchParams.has("title__icontains") ? 0 : 1;
        const streamIndex = termIndex * 2 + fieldIndex;
        const objects = Array.from({ length: 20 }, (_, row) => {
          const generatedNumber = 9_900 - streamIndex * 20 - row;
          const rfcNumber = streamIndex === 1 && row === 0 ? 9_900 : generatedNumber;
          return {
            ...datatrackerDocument,
            name: `rfc${rfcNumber}`,
            rfc_number: rfcNumber,
            title: `Topic stream ${streamIndex} row ${row}`,
            abstract: `Metadata for RFC ${rfcNumber}.`,
            resource_uri: `/api/v1/doc/document/rfc${rfcNumber}/`,
          };
        });
        activeRequests -= 1;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            meta: { limit: 20, offset: 0, total_count: 20, next: null },
            objects,
          }),
        );
      }),
    );
    const documentBatches: Array<ReadonlyArray<string>> = [];
    const documentDecisionKeys: Array<ReadonlyArray<string>> = [];
    const decisionModel = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (
        definition: { readonly decisions: Readonly<Record<string, Decision.Any>> },
        options: {
          readonly input: {
            readonly documents:
              | Readonly<Record<string, { readonly identifier: string }>>
              | undefined;
          };
        },
      ) => {
        if (options.input.documents !== undefined) {
          documentBatches.push(
            Object.values(options.input.documents).map(({ identifier }) => identifier),
          );
          documentDecisionKeys.push(Object.keys(definition.decisions));
        }
        return Effect.succeed({
          answers: Object.fromEntries(
            Object.entries(definition.decisions).map(([key, decision]) =>
              key === "question_atomicity"
                ? [
                    key,
                    {
                      label: "atomic",
                      probabilities: { atomic: 0.99, compound: 0.01 },
                      confidence: 0.99,
                    },
                  ]
                : decision._tag === "Probability"
                  ? [key, { probability: 0.99 }]
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
        });
      },
    } as unknown as DecisionModel.DecisionModel;
    const fetchedSources: Array<string> = [];
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async (document) => {
        fetchedSources.push(document.identifier);
        return {
          sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
          text: sourceText,
        };
      },
      decisionModel,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "Which requirements apply without disclosing this question?",
      rfc: null,
      searchTerms,
    });

    expect(urls).toHaveLength(8);
    expect(maximumActiveRequests).toBeGreaterThan(1);
    expect(maximumActiveRequests).toBeLessThanOrEqual(4);
    expect(
      urls.every((value) => {
        const url = new URL(value);
        return (
          url.searchParams.get("limit") === "20" &&
          url.searchParams.get("offset") === "0" &&
          url.searchParams.get("order_by") === "-rfc_number" &&
          url.searchParams.get("type__slug") === "rfc" &&
          !value.includes("without+disclosing")
        );
      }),
    ).toBe(true);
    expect(documentBatches).toHaveLength(1);
    expect(documentBatches[0]).toHaveLength(32);
    expect(documentDecisionKeys).toHaveLength(1);
    expect(documentDecisionKeys[0]).toEqual([
      "question_atomicity",
      ...Array.from({ length: 32 }, (_, index) => `document_${index}`),
    ]);
    expect(documentBatches[0]?.slice(0, 9)).toEqual([
      "RFC9900",
      "RFC9860",
      "RFC9840",
      "RFC9820",
      "RFC9800",
      "RFC9780",
      "RFC9760",
      "RFC9899",
      "RFC9879",
    ]);
    expect(fetchedSources.length).toBeLessThanOrEqual(8);
    expect(result.status).toBe("needs_review");
    expect(result.diagnostics.retrieval).toMatchObject({
      datatrackerRequestCount: 8,
      upstreamRows: 160,
      uniqueCandidates: 159,
      mergeLimit: 32,
      semanticCandidates: 32,
      selectedSources: fetchedSources.length,
      topicTruncated: true,
    });
    const metadataRequests = result.diagnostics.retrieval?.requests.filter(
      ({ kind }) => kind === "metadata",
    );
    expect(metadataRequests).toHaveLength(8);
    expect(
      metadataRequests?.every(
        ({ attempts, durationMs, url }) => attempts === 1 && durationMs >= 0 && urls.includes(url),
      ),
    ).toBe(true);
    expect(await readdir(cacheDirectory)).toEqual(["sources"]);

    await rm(cacheDirectory, { recursive: true, force: true });
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

  test("returns needs_review when live topic discovery finds no RFCs", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 0, next: null },
        objects: [],
      }),
    );
    let sourceFetches = 0;
    let modelCalls = 0;
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => {
          modelCalls += 1;
          return Effect.die(new Error("TypeSafe must not run for empty discovery"));
        },
      } as DecisionModel.DecisionModel,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "Which requirements apply?",
      rfc: null,
      searchTerms: ["no matching RFC"],
    });

    expect(result).toMatchObject({ status: "needs_review", rfc: null, evidence: [] });
    expect(result.diagnostics).toMatchObject({
      resolvedModels: [],
      atomicity: null,
      documentSelection: [],
    });
    expect(result.diagnostics.retrieval).toMatchObject({
      datatrackerRequestCount: 2,
      upstreamRows: 0,
      uniqueCandidates: 0,
      mergeLimit: 32,
      semanticCandidates: 0,
      selectedSources: 0,
      topicTruncated: false,
    });
    expect(modelCalls).toBe(0);
    expect(sourceFetches).toBe(0);
    expect(await readdir(cacheDirectory)).toEqual([]);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("returns needs_review when semantic document selection rejects every RFC", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 1, next: null },
        objects: [datatrackerDocument],
      }),
    );
    let modelCalls = 0;
    const decisionModel = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
        modelCalls += 1;
        return Effect.succeed({
          answers: Object.fromEntries(
            Object.keys(definition.decisions).map((key) =>
              key === "question_atomicity"
                ? [
                    key,
                    {
                      label: "atomic",
                      probabilities: { atomic: 0.99, compound: 0.01 },
                      confidence: 0.99,
                    },
                  ]
                : [key, { probability: 0.1 }],
            ),
          ),
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      },
    } as unknown as DecisionModel.DecisionModel;
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      decisionModel,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "Which requirements apply?",
      rfc: null,
      searchTerms: ["HTTP semantics"],
    });

    expect(result).toMatchObject({ status: "needs_review", rfc: null, evidence: [] });
    expect(result.diagnostics.retrieval).toMatchObject({
      upstreamRows: 2,
      uniqueCandidates: 1,
      semanticCandidates: 1,
      selectedSources: 0,
    });
    expect(modelCalls).toBe(1);
    expect(sourceFetches).toBe(0);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("fails the whole topic request when one required Datatracker query exhausts retries", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) => {
      if (url.searchParams.get("title__icontains") === "second term") {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return Response.json({
        meta: { limit: 20, offset: 0, total_count: 1, next: null },
        objects: [datatrackerDocument],
      });
    });
    let modelCalls = 0;
    const baseModel = makeDecisionModel();
    const decisionModel = {
      ...baseModel,
      decide: (...args: Parameters<DecisionModel.DecisionModel["decide"]>) => {
        modelCalls += 1;
        return baseModel.decide(...args);
      },
    } as DecisionModel.DecisionModel;
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      decisionModel,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "Which requirements apply?",
        rfc: null,
        searchTerms: ["first term", "second term"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      attempts: 3,
    });
    expect(datatracker.urls.some((url) => url.includes("first+term"))).toBe(true);
    expect(
      datatracker.urls.filter((url) => url.includes("title__icontains=second+term")),
    ).toHaveLength(3);
    expect(datatracker.urls.some((url) => url.includes("second+term"))).toBe(true);
    expect(modelCalls).toBe(0);
    expect(sourceFetches).toBe(0);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("fails closed when TypeSafe omits a topic candidate answer", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 1, next: null },
        objects: [datatrackerDocument],
      }),
    );
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () =>
          Effect.succeed({
            answers: {
              question_atomicity: {
                label: "atomic",
                probabilities: { atomic: 0.99, compound: 0.01 },
                confidence: 0.99,
              },
            },
            usage: { inputTokens: 2, outputTokens: 1 },
          }),
      } as DecisionModel.DecisionModel,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "Which requirements apply?",
        rfc: null,
        searchTerms: ["HTTP semantics"],
      }),
    ).rejects.toMatchObject({
      _tag: "DecisionModelError",
      stage: "document",
      reason: expect.stringContaining("omitted"),
    });
    expect(sourceFetches).toBe(0);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("rejects a topic stream that exceeds its twenty-row bound", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 21, next: null },
        objects: Array.from({ length: 21 }, (_, index) => {
          const rfcNumber = 9_000 - index;
          return {
            ...datatrackerDocument,
            name: `rfc${rfcNumber}`,
            rfc_number: rfcNumber,
            resource_uri: `/api/v1/doc/document/rfc${rfcNumber}/`,
          };
        }),
      }),
    );
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      decisionModel: makeDecisionModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "Which requirements apply?",
        rfc: null,
        searchTerms: ["HTTP semantics"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: "Datatracker returned malformed or unbounded topic metadata",
    });
    expect(datatracker.urls.length).toBeLessThanOrEqual(2);
    expect(sourceFetches).toBe(0);

    await rm(cacheDirectory, { recursive: true, force: true });
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

  test("rejects a 304 whose validator does not match the conditional request", async () => {
    const cacheDirectory = await makeCacheDirectory();
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: new Date(1_000).toISOString(),
      etag: '"one"',
    });
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    // A 304 that names a different entity than the one we asked about.
    const sourceHttp = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: 304,
            headers: { etag: '"two"', "cache-control": "max-age=60" },
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
      now: () => 30_000,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2 as const,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({ _tag: "RfcSourceRevalidationError" });
  });

  test("rejects a 304 answered with a weak validator", async () => {
    const cacheDirectory = await makeCacheDirectory();
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: new Date(1_000).toISOString(),
      etag: '"one"',
    });
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    const sourceHttp = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: 304,
            headers: { etag: 'W/"one"', "cache-control": "max-age=60" },
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
      now: () => 30_000,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2 as const,
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({ _tag: "RfcSourceRevalidationError" });
  });

  test("counts the upstream request when persisting a fetched source fails", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // The requested RFC is served from a fresh entry, so only the successor
    // needs to write - and its directory is read-only by then.
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(0).toISOString(),
      freshUntil: new Date(600_000).toISOString(),
    });
    await chmod(join(cacheDirectory, "sources", "v2"), 0o500);
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
    const sourceHttp = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sourceText, {
            status: 200,
            headers: {
              etag: '"strong"',
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
      now: () => 30_000,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2 as const,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    const failed = (result.diagnostics.retrieval?.requests ?? []).find(
      (request) => request.kind === "source" && request.url.endsWith("rfc9111.txt"),
    );
    // The fetch succeeded and only persistence failed, so the attempt counts.
    expect(failed?.attempts).toBe(1);
    await chmod(join(cacheDirectory, "sources", "v2"), 0o700);
  });

  test("rejects Datatracker metadata that is not valid UTF-8", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // Valid JSON framing carrying an undecodable byte inside the title.
    const malformed = new Uint8Array([
      ...new TextEncoder().encode('{"name":"rfc9110","rfc_number":9110,"title":"'),
      0x80,
      ...new TextEncoder().encode('","abstract":"a","stream":"/api/v1/name/streamname/ietf/"}'),
    ]);
    // Only the document response is malformed; relationships decode normally, so
    // a lossy decode would let this request succeed.
    const datatracker = HttpClient.make((request, url) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith("/document/rfc9110/")
            ? new Response(malformed, {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : Response.json({
                meta: { limit: 64, offset: 0, total_count: 0, next: null },
                objects: [],
              }),
        ),
      ),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker,
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
        question: "What must the client send?",
        rfc: "RFC9110",
        searchTerms: undefined,
      }),
    ).rejects.toMatchObject({ _tag: "RfcDiscoveryError", stage: "decode" });
  });

  test("revalidates a cache entry dated in the future", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // Self-consistent and nominally fresh, but recorded ahead of the clock.
    await seedLiveSourceCacheEntry(cacheDirectory, {
      text: sourceText,
      fetchedAt: new Date(600_000).toISOString(),
      freshUntil: new Date(660_000).toISOString(),
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

    expect(result.diagnostics.retrieval?.sourceCacheOutcome).not.toBe("hit");
    expect(sourceRequests).toBe(1);
  });

  test("rejects a source media type that merely begins with text/plain", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null },
            objects: [],
          }),
    );
    const sourceHttp = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sourceText, {
            status: 200,
            headers: { "content-type": "text/plain-html" },
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
      reason: "RFC Editor returned a non-plain-text source",
    });
  });

  test("preserves the HTTP status of a failed successor source request", async () => {
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

    const failed = (result.diagnostics.retrieval?.requests ?? []).find(
      (request) => request.kind === "source" && request.url.endsWith("rfc9111.txt"),
    );
    expect(failed?.status).toBe(503);
    expect(failed?.statuses).toEqual([503]);
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
    expect(
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
        searchTerms: ["x".repeat(200)],
      }),
    ).toMatchObject({ searchTerms: ["x".repeat(200)] });
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
        searchTerms: ["x".repeat(201)],
      }),
    ).toThrow(InvalidInputError);
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

  test("rejects published RFC documents that break the identifier contract", () => {
    const valid = {
      identifier: "RFC9110",
      rfcNumber: 9110,
      title: "HTTP Semantics",
      abstract: "HTTP semantics.",
      status: "published",
      stream: "ietf",
      canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
    };

    expect(Schema.decodeUnknownSync(RfcDocumentSchema)(valid)).toEqual(valid);
    expect(() =>
      Schema.decodeUnknownSync(RfcDocumentSchema)({ ...valid, rfcNumber: 0, identifier: "RFC0" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RfcDocumentSchema)({ ...valid, identifier: "RFC9111" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RfcDocumentSchema)({ ...valid, rfcNumber: -9110 }),
    ).toThrow();
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
