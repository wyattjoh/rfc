import { chmod, mkdir, mkdtemp, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as PublicApi from "../src/index";
import {
  InvalidInputError,
  ResearchResultSchema,
  RfcClientClosedError,
  RfcDiscoveryError,
  RfcDocumentSchema,
  RfcSourceFetchError,
  createRfcClient,
  decodeResearchRequest,
  hashRfcSource,
  toErrorEnvelope,
  type RfcClient,
} from "../src/index";
import { makeRoutingModel, type RecordedCall } from "./helpers";

const clients: Array<RfcClient> = [];

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

const datatrackerDocument = {
  name: "rfc9110",
  rfc_number: 9110,
  title: "HTTP Semantics",
  abstract: "HTTP semantics.",
  resource_uri: "/api/v1/doc/document/rfc9110/",
  stream: "/api/v1/name/streamname/ietf/",
  states: ["/api/v1/doc/state/177/"],
};

const topicSearchDocument = {
  rfcNumber: 9110,
  title: "HTTP Semantics",
  abstract: "HTTP semantics.",
  type: "rfc",
  status: { name: "Internet Standard", slug: "std" },
  stream: { name: "IETF", slug: "ietf" },
};

const topicSearchPage = (
  documents: ReadonlyArray<unknown> = [topicSearchDocument],
  found: number = documents.length,
) => ({ found, hits: documents.map((document) => ({ document })) });

const emptyDatatrackerTopicPage = () =>
  Response.json({ meta: { limit: 20, offset: 0, total_count: 0, next: null }, objects: [] });

const isTopicSearchRequest = (url: URL) => url.pathname.endsWith("/documents/search");

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
    decisionModel: makeRoutingModel(),
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
    decisionModel: makeRoutingModel(),
    now: () => 30_000,
  });
  clients.push(client);
  const result = await client.research({
    schemaVersion: 3 as const,
    questions: ["What must the client send?"],
    rfcs: ["RFC9110"],
  });
  return { result, sourceRequests };
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("createRfcClient", () => {
  test("exposes only schema-version-two client operations", async () => {
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(client.sourceCacheStatus("9110")).resolves.toEqual({
      schemaVersion: 3,
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
      schemaVersion: 3,
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

  test("evicts the least recently written source-cache files once the budget is exceeded", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const sourceDirectory = join(cacheDirectory, "sources", "v2");
    await mkdir(sourceDirectory, { recursive: true });

    // Sparse fillers: `stat` reports the declared size while the files occupy
    // no blocks, so the 256 MiB budget can be crossed without writing 256 MiB.
    const filler = async (name: string, modifiedAtSeconds: number): Promise<string> => {
      const path = join(sourceDirectory, name);
      await writeFile(path, "");
      await truncate(path, 200 * 1024 * 1024);
      await utimes(path, modifiedAtSeconds, modifiedAtSeconds);
      return path;
    };
    const stranded = await filler("RFC1002.json.tmp-abandoned", 1_000);
    const oldest = await filler("RFC1000.json", 2_000);
    const newest = await filler("RFC1001.json", 3_000);

    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
            objects: [],
          }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeRoutingModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    await client.research({
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    // 600 MiB of fillers plus the new entry: eviction walks oldest first and
    // stops as soon as the remainder fits, so the newest filler survives.
    expect(await Bun.file(stranded).exists()).toBe(false);
    expect(await Bun.file(oldest).exists()).toBe(false);
    expect(await Bun.file(newest).exists()).toBe(true);
    // The entry that triggered the prune is never its own victim.
    expect(await Bun.file(join(sourceDirectory, "RFC9110.json")).exists()).toBe(true);

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
      decisionModel: makeRoutingModel(),
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
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    };
    const first = await client.research(request);
    const second = await client.research(request);

    expect(first).toMatchObject({
      schemaVersion: 3,
      kind: "research_result",
      currency: [
        {
          requested: "RFC9110",
          current: ["RFC9110"],
          complete: true,
          paths: [{ identifier: "RFC9110", path: [] }],
        },
      ],
      diagnostics: {
        policyVersion: "jev-retrieval-v1",
        requestedModel: "jev-test",
        candidates: { pool: 1, ranked: 1 },
        retrieval: {
          schemaVersion: 3,
          requestCount: 3,
          datatrackerRequestCount: 2,
          sourceRequestCount: 1,
          sourceCacheOutcome: "miss",
        },
      },
    });
    const serialized = JSON.parse(JSON.stringify(first));
    expect(Schema.decodeUnknownSync(ResearchResultSchema)(serialized)).toEqual(serialized);
    expect(() =>
      Schema.decodeUnknownSync(ResearchResultSchema)({ ...first, schemaVersion: 2 }),
    ).toThrow();
    expect("catalog" in first.diagnostics).toBe(false);
    expect("catalogMs" in first.diagnostics.timings).toBe(false);
    expect(JSON.stringify(first)).not.toContain('"catalog');
    expect(first.diagnostics.timings.metadataMs).toBeGreaterThanOrEqual(0);
    const hit = first.answers[0]?.hits[0];
    if (hit === undefined) throw new Error("Expected a research hit");
    expect(first.answers[0]).toMatchObject({ found: true, searched: ["RFC9110"] });
    expect(hit).toMatchObject({
      rfc: { identifier: "RFC9110" },
      role: "requested",
      relevance: null,
      verdict: "supports",
    });
    expect("updates" in hit.rfc).toBe(false);
    expect("obsoletes" in hit.rfc).toBe(false);
    expect(first.diagnostics.retrieval.sourceMs).toBe(7);
    expect(first.diagnostics.retrieval.requests[2]?.durationMs).toBe(7);
    expect(first.diagnostics.retrieval.requests.map(({ url }) => url)).toEqual([
      "https://datatracker.ietf.org/api/v1/doc/document/rfc9110/?format=json",
      "https://datatracker.ietf.org/api/v1/doc/relateddocument/?format=json&limit=64&offset=0&relationship__slug__in=obs%2Cupdates&target__name=rfc9110",
      "https://www.rfc-editor.org/rfc/rfc9110.txt",
    ]);
    const passage = hit.passages[0];
    if (passage === undefined) throw new Error("Expected an exact RFC passage");
    expect(passage).toMatchObject({
      quote: "The client MUST send a request containing the target resource.",
      section: "1. Requirements",
      provenance: {
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        sourceHash: hashRfcSource(sourceText),
        offsetUnit: "utf8-byte",
      },
    });
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
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    expect(result.currency).toEqual([
      {
        requested: "RFC9110",
        current: ["RFC9111"],
        complete: true,
        paths: [
          { identifier: "RFC9110", path: [] },
          {
            identifier: "RFC9111",
            path: [{ from: "RFC9110", to: "RFC9111", relationship: "updates" }],
          },
        ],
      },
    ]);
    expect(result.diagnostics.candidates).toEqual({ pool: 2, ranked: 2 });
    const hits = result.answers[0]?.hits ?? [];
    expect(hits.map(({ rfc, role }) => `${rfc.identifier}:${role}`)).toEqual([
      "RFC9110:requested",
      "RFC9111:current",
    ]);
    expect(hits.every(({ passages }) => passages.length > 0)).toBe(true);
    expect([...fixture.sourceIdentifiers].sort()).toEqual(["RFC9110", "RFC9111"]);
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
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    expect(result.currency).toMatchObject([
      { requested: "RFC9110", current: ["RFC9112"], complete: true },
    ]);
    expect(result.currency?.[0]?.paths).toContainEqual({
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
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    expect(result.currency?.[0]).toMatchObject({
      current: ["RFC9111", "RFC9112"],
      complete: true,
    });
    expect(result.currency?.[0]?.paths).toEqual([
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
    expect(result.diagnostics.candidates).toEqual({ pool: 3, ranked: 3 });
    expect(result.answers[0]?.hits.map(({ rfc, role }) => `${rfc.identifier}:${role}`)).toEqual([
      "RFC9110:requested",
      "RFC9111:current",
      "RFC9112:current",
    ]);
    expect([...fixture.sourceIdentifiers].sort()).toEqual(["RFC9110", "RFC9111", "RFC9112"]);
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
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    // A cycle has no terminal RFC, so no successor is claimed as current, but
    // every relationship was read, so the report is still complete.
    expect(result.currency).toEqual([
      {
        requested: "RFC9110",
        current: [],
        complete: true,
        paths: [{ identifier: "RFC9110", path: [] }],
      },
    ]);
    expect(result.answers[0]?.hits.map(({ rfc, role }) => `${rfc.identifier}:${role}`)).toEqual([
      "RFC9110:requested",
    ]);
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
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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

  test("claims no current RFC and reports the bounded successor depth exit", async () => {
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
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    // RFC9112 still has an unresolved successor, so it is not reported as current.
    expect(result.currency).toEqual([
      {
        requested: "RFC9110",
        current: [],
        complete: false,
        paths: [{ identifier: "RFC9110", path: [] }],
      },
    ]);
    expect(fixture.sourceIdentifiers).toEqual(["RFC9110"]);
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

  test("reports the eight-context traversal bound", async () => {
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
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    // RFC9118 was cut off by the context bound, so the current set is partial.
    expect(result.currency?.[0]?.complete).toBe(false);
    expect(result.currency?.[0]?.current).toEqual([
      "RFC9111",
      "RFC9112",
      "RFC9113",
      "RFC9114",
      "RFC9115",
      "RFC9116",
      "RFC9117",
    ]);
    expect(result.currency?.[0]?.paths.map(({ identifier }) => identifier)).not.toContain(
      "RFC9118",
    );
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
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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

  test("reports the bounded exit when successor relationship results hit their bound", async () => {
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    // Datatracker reported more relationship rows than it returned.
    expect(result.currency?.[0]).toMatchObject({ current: ["RFC9111"], complete: false });
    expect(result.diagnostics.retrieval).toMatchObject({
      traversalComplete: false,
      successorRows: 2,
      relationshipLimit: 64,
      boundedExits: ["relationship_limit"],
    });
  });

  test("queries only Datatracker when no search key is configured", async () => {
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
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["HTTP semantics"],
    });

    // Full-text search is opt-in. Without a key nothing may reach the search
    // host, and discovery must behave exactly as it did before it existed.
    expect(datatracker.urls.every((url) => !isTopicSearchRequest(new URL(url)))).toBe(true);
    expect(
      datatracker.urls.map((value) => {
        const url = new URL(value);
        return (
          url.searchParams.get("title__icontains") ?? url.searchParams.get("abstract__icontains")
        );
      }),
    ).toEqual(["HTTP semantics", "HTTP semantics"]);
    expect(result.diagnostics.retrieval).toMatchObject({ datatrackerRequestCount: 2 });
    expect(result.diagnostics.retrieval?.topicSearchFallback).toBeUndefined();
  });

  test("discovers an RFC from a term that appears only in its body text", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // "Retry-After" is defined in RFC 9110 but appears in neither its title nor
    // its abstract, so the Datatracker substring filters return nothing for it.
    // With search enabled, discovery reaches an index of the RFC body and finds
    // the RFC a caller named by the protocol element they actually care about.
    const datatracker = makeDatatrackerHttpClient((url) =>
      isTopicSearchRequest(url) ? Response.json(topicSearchPage()) : emptyDatatrackerTopicPage(),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSearchApiKey: "test-search-key",
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["How long should a client wait before retrying?"],
      searchTerms: ["Retry-After"],
    });

    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC9110"]);
    expect(datatracker.urls.map((value) => new URL(value).searchParams.get("q"))).toEqual([
      "Retry-After",
    ]);
    expect(datatracker.urls.every((value) => !value.includes("How+long"))).toBe(true);
    expect(result.diagnostics.retrieval?.topicSearchFallback).toBeUndefined();
  });

  test("sends the configured search key as a header and never in the URL", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const seenKeys: Array<string | undefined> = [];
    const urls: Array<string> = [];
    const datatracker = HttpClient.make((request, url) => {
      urls.push(url.toString());
      seenKeys.push(request.headers["x-typesense-api-key"]);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          isTopicSearchRequest(url)
            ? Response.json(topicSearchPage())
            : emptyDatatrackerTopicPage(),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker,
      rfcSearchApiKey: "secret-search-key",
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["Retry-After"],
    });

    expect(seenKeys).toContain("secret-search-key");
    // The key must stay out of request URLs so it cannot reach traces,
    // diagnostics, or the metadata cache key derived from the URL.
    expect(urls.every((url) => !url.includes("secret-search-key"))).toBe(true);
    expect(
      result.diagnostics.retrieval?.requests.every(({ url }) => !url.includes("secret-search-key")),
    ).toBe(true);
  });

  test("falls back to Datatracker and reports it when topic search fails", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) =>
      isTopicSearchRequest(url)
        ? new Response("forbidden", { status: 401 })
        : Response.json({
            meta: { limit: 20, offset: 0, total_count: 1, next: null },
            objects: [datatrackerDocument],
          }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSearchApiKey: "rotated-key",
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["HTTP semantics"],
    });

    // A revoked key must degrade discovery, never remove the tool.
    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC9110"]);
    expect(result.diagnostics.retrieval).toMatchObject({
      topicSearchFallback: true,
      datatrackerRequestCount: 2,
    });
    expect(result.diagnostics.retrieval?.topicSearchFallbackReason).toContain("401");
    // One failed search attempt, then both Datatracker field queries.
    expect(datatracker.urls).toHaveLength(3);
    expect(datatracker.urls.filter((url) => isTopicSearchRequest(new URL(url)))).toHaveLength(1);
  });

  test("falls back when topic search returns an unreadable body", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient((url) =>
      isTopicSearchRequest(url)
        ? new Response("<html>challenge</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : Response.json({
            meta: { limit: 20, offset: 0, total_count: 1, next: null },
            objects: [datatrackerDocument],
          }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      rfcSearchApiKey: "test-search-key",
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["HTTP semantics"],
    });

    // A bot-management interstitial is not JSON; discovery must survive it.
    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC9110"]);
    expect(result.diagnostics.retrieval?.topicSearchFallback).toBe(true);
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
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["HTTP/2 :method", "HTTP/2 :method"],
    });

    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC9110"]);
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

  test("enforces topic traffic, merge, rank, and source bounds", async () => {
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
    const calls: Array<RecordedCall> = [];
    const decisionModel = makeRoutingModel({}, calls);
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
      schemaVersion: 3,
      questions: ["Which requirements apply without disclosing this question?"],
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
          url.searchParams.get("order_by") === "-id" &&
          url.searchParams.get("type__slug") === "rfc" &&
          !value.includes("without+disclosing")
        );
      }),
    ).toBe(true);
    // One rank request judges the whole capped pool at once.
    const rankCalls = calls.filter(({ decisions }) => "rank_q0" in decisions);
    expect(rankCalls).toHaveLength(1);
    const ranked = Object.values(rankCalls[0]?.input.candidates ?? {}).map(
      ({ identifier }) => identifier,
    );
    expect(ranked).toHaveLength(32);
    expect(Object.keys(rankCalls[0]?.decisions ?? {})).toEqual([
      "rank_q0",
      ...Array.from({ length: 32 }, (_, index) => `relevant_q0_c${index}`),
    ]);
    expect(ranked.slice(0, 9)).toEqual([
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
    // Only the ranked RFCs have their source fetched.
    expect([...fetchedSources].sort()).toEqual(["RFC9860", "RFC9900"]);
    expect(result.diagnostics.candidates).toEqual({ pool: 32, ranked: 2 });
    expect(result.diagnostics.retrieval).toMatchObject({
      datatrackerRequestCount: 8,
      upstreamRows: 160,
      uniqueCandidates: 159,
      mergeLimit: 32,
      semanticCandidates: 32,
      selectedSources: 2,
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
      decisionModel: makeRoutingModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["HTTP semantics"],
    });

    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC9110"]);
    expect(result.diagnostics.retrieval).toMatchObject({
      upstreamRows: 2,
      uniqueCandidates: 1,
      topicTruncated: true,
    });
  });

  test("reports not found without model or source work when topic discovery finds no RFCs", async () => {
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
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["no matching RFC"],
    });

    expect(result.answers).toEqual([
      { question: "Which requirements apply?", found: false, searched: [], hits: [] },
    ]);
    expect(result.currency).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      usage: { inputTokens: null, outputTokens: null },
      candidates: { pool: 0, ranked: 0 },
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

  test("reports not found without fetching sources when ranking rejects every topic RFC", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(() =>
      Response.json({
        meta: { limit: 20, offset: 0, total_count: 2, next: null },
        objects: [datatrackerDocument, currencyDocument(9111)],
      }),
    );
    const calls: Array<RecordedCall> = [];
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
      decisionModel: makeRoutingModel({ relevance: () => 0.1 }, calls),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["Which requirements apply?"],
      searchTerms: ["HTTP semantics"],
    });

    expect(result.answers).toEqual([
      { question: "Which requirements apply?", found: false, searched: [], hits: [] },
    ]);
    expect(result.diagnostics.candidates).toEqual({ pool: 2, ranked: 0 });
    expect(result.diagnostics.retrieval).toMatchObject({
      upstreamRows: 4,
      uniqueCandidates: 2,
      semanticCandidates: 2,
      selectedSources: 0,
    });
    expect(calls).toHaveLength(1);
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
    const baseModel = makeRoutingModel();
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
        schemaVersion: 3,
        questions: ["Which requirements apply?"],
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
        meta: { limit: 20, offset: 0, total_count: 2, next: null },
        objects: [datatrackerDocument, currencyDocument(9111)],
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
              rank_q0: {
                label: "c0",
                probabilities: { c0: 0.9, c1: 0.1, none: 0 },
                confidence: 0.9,
              },
            },
            usage: { inputTokens: 2, outputTokens: 1 },
          }),
      } as DecisionModel.DecisionModel,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["Which requirements apply?"],
        searchTerms: ["HTTP semantics"],
      }),
    ).rejects.toMatchObject({
      _tag: "DecisionModelError",
      stage: "rank",
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["Which requirements apply?"],
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "decode",
      reason: expect.stringContaining("metadata exceeds"),
    });
  });

  test("rejects overlong metadata fields before ranking", async () => {
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    expect(documentAttempts).toBe(3);
    expect(result.diagnostics.retrieval).toMatchObject({
      requestCount: 3,
      datatrackerRequestCount: 2,
      sourceRequestCount: 1,
    });
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
      decisionModel: makeRoutingModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      attempts: 3,
    } satisfies Partial<RfcDiscoveryError>);
    expect(datatracker.urls).toHaveLength(3);
  });

  test("retries after an attempt that hangs past its share of the fetch deadline", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const clock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    let documentAttempts = 0;
    let firstAttemptStartedResolve: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      firstAttemptStartedResolve = resolve;
    });
    const relationships = Response.json({
      meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
      objects: [],
    });
    const http = HttpClient.make((request, url) => {
      if (url.pathname.endsWith("/document/rfc9110/")) {
        documentAttempts += 1;
        if (documentAttempts === 1) {
          firstAttemptStartedResolve?.();
          // A hung upstream connection, which is what consumed the budget in the
          // observed failure. It never answers and never fails on its own.
          return Effect.never as unknown as Effect.Effect<
            HttpClientResponse.HttpClientResponse,
            never
          >;
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(datatrackerDocument)),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, relationships));
    });
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: http,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeRoutingModel(),
      clock,
      rfcSourceFetcher: async () => ({
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        text: sourceText,
      }),
    });
    clients.push(client);

    const research = client
      .research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await firstAttemptStarted;

    // One attempt must not be able to spend the whole retry budget, so the
    // remaining attempts are still reachable after it times out.
    for (let elapsed = 0; elapsed < 30 && documentAttempts < 2; elapsed += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Effect.runPromise(clock.adjust(Duration.seconds(1)));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(documentAttempts).toBeGreaterThan(1);
    await Promise.race([research, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
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
      decisionModel: makeRoutingModel(),
      now: () => (clockReads++ < 3 ? 0 : 9_500),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => now,
    });
    clients.push(client);
    const request = {
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
    expect(replaced.answers[0]?.hits[0]?.passages[0]?.provenance.sourceHash).toBe(
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
    expect(result.answers[0]?.hits[0]?.passages[0]?.provenance.sourceHash).toBe(
      hashRfcSource(sourceText),
    );
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
      decisionModel: makeRoutingModel(),
      now: () => 30_000,
    });
    clients.push(client);
    const request = {
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    };

    const first = await client.research(request);
    const second = await client.research(request);

    expect(first.answers[0]?.hits[0]?.passages[0]?.provenance.sourceHash).toBe(
      hashRfcSource(sourceText),
    );
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
    // The unavailable successor is dropped rather than failing the named RFC.
    expect(result.answers[0]?.hits.map(({ rfc, role }) => `${rfc.identifier}:${role}`)).toEqual([
      "RFC9110:requested",
    ]);
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
      decisionModel: makeRoutingModel(),
      now: () => 30_000,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });

    expect(validators).toEqual([undefined]);
    expect(result.answers[0]?.hits[0]?.passages[0]?.provenance.sourceHash).toBe(
      hashRfcSource(replacement),
    );
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["Which requirements apply?"],
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["Which requirements apply?"],
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
      decisionModel: makeRoutingModel(),
      now: () => 30_000,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 30_000,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 30_000,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 30_000,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3 as const,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => 0,
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      now: () => now,
    });
    clients.push(client);
    const request = {
      schemaVersion: 3 as const,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return sourceText;
      },
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
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
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 3,
        questions: ["What must the client send?"],
        rfcs: ["RFC9110"],
      }),
    ).rejects.toMatchObject({
      _tag: "RfcDiscoveryError",
      stage: "request",
      attempts: 1,
    } satisfies Partial<RfcDiscoveryError>);
    expect(datatracker.urls).toHaveLength(1);
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("decodes versioned research input at the Promise facade boundary", () => {
    expect(
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        rfcs: ["RFC9110"],
      }),
    ).toEqual({
      schemaVersion: 3,
      questions: ["What is HTTP?"],
      rfcs: ["RFC9110"],
    });
    // Named RFCs and topic terms share one candidate pool.
    expect(
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?", "What is a request?"],
        rfcs: ["RFC9110"],
        searchTerms: ["HTTP"],
      }),
    ).toEqual({
      schemaVersion: 3,
      questions: ["What is HTTP?", "What is a request?"],
      rfcs: ["RFC9110"],
      searchTerms: ["HTTP"],
    });
    const decodeFailure = (input: unknown): unknown => {
      try {
        decodeResearchRequest(input);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    expect(decodeFailure({ schemaVersion: 3, questions: ["What is HTTP?"] })).toMatchObject({
      _tag: "InvalidInputError",
      reason: "Research input must include rfcs, searchTerms, or both",
    });
    for (const input of [
      { schemaVersion: 3, questions: ["What is HTTP?"], rfcs: [] },
      { schemaVersion: 3, questions: ["What is HTTP?"], searchTerms: [] },
      { schemaVersion: 3, questions: ["What is HTTP?"], rfcs: ["1", "2", "3", "4", "5"] },
      { schemaVersion: 3, questions: [""], rfcs: ["RFC9110"] },
    ]) {
      expect(decodeFailure(input)).toBeInstanceOf(InvalidInputError);
    }
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        searchTerms: ["one", "two", "three", "four", "five"],
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        searchTerms: [""],
      }),
    ).toThrow(InvalidInputError);
    expect(
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        searchTerms: ["   "],
      }),
    ).toMatchObject({ searchTerms: ["   "] });
    expect(
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        searchTerms: ["x".repeat(200)],
      }),
    ).toMatchObject({ searchTerms: ["x".repeat(200)] });
    expect(() =>
      decodeResearchRequest({
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        searchTerms: ["x".repeat(201)],
      }),
    ).toThrow(InvalidInputError);
    // Earlier protocol versions, including the single-question shape, are rejected.
    for (const input of [
      { schemaVersion: 2, questions: ["What is HTTP?"], rfcs: ["RFC9110"] },
      { schemaVersion: 2, question: "What is HTTP?", rfc: "RFC9110" },
      { schemaVersion: 1, question: "What is HTTP?", rfc: "RFC9110" },
    ]) {
      expect(() => decodeResearchRequest(input)).toThrow(InvalidInputError);
    }
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
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        rfcs: ["RFC9110"],
      }),
    ).rejects.toBeInstanceOf(RfcClientClosedError);

    await rm(cacheDirectory, { recursive: true, force: true });
  });

  test("close waits for an in-flight operation instead of disposing under it", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const base = makeRoutingModel();
    const datatracker = makeDatatrackerHttpClient((url) =>
      url.pathname.endsWith("/document/rfc9110/")
        ? Response.json(datatrackerDocument)
        : Response.json({
            meta: { limit: 64, offset: 0, total_count: 0, next: null, previous: null },
            objects: [],
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
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: (...args: Parameters<typeof base.decide>) =>
          Effect.gen(function* () {
            markStarted?.();
            yield* Effect.promise(() => released);
            return yield* base.decide(...args);
          }),
      } as unknown as DecisionModel.DecisionModel,
    });
    clients.push(client);

    const pending = client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });
    await started;

    let disposed = false;
    const closing = client.close().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disposed).toBe(false);

    release?.();
    // The operation returns its own result rather than failing against a
    // runtime that was torn down beneath it.
    await expect(pending).resolves.toMatchObject({ kind: "research_result" });
    await closing;
    expect(disposed).toBe(true);

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
        schemaVersion: 3,
        questions: ["What is HTTP?"],
        rfcs: ["RFC9110"],
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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
      schemaVersion: 3,
      kind: "error",
      error: {
        code: "source_fetch_failed",
        message:
          "Unable to fetch RFC source from https://www.rfc-editor.org/rfc/rfc9110.txt: RFC Editor returned HTTP 503",
      },
    });
  });

  test("toErrorEnvelope separates an unusable RFC identifier from a retrieval failure", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const datatracker = makeDatatrackerHttpClient(
      () => new Response("server failure", { status: 503 }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      datatrackerHttpClient: datatracker.client,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      decisionModel: makeRoutingModel(),
    });
    clients.push(client);

    const research = (rfc: string) =>
      client
        .research({
          schemaVersion: 3,
          questions: ["What must the client send?"],
          rfcs: [rfc],
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

    const identifierEnvelope = toErrorEnvelope(await research("BCP14"));
    expect(identifierEnvelope).toMatchObject({
      kind: "error",
      error: { code: "invalid_input" },
    });
    // Nothing was retrieved, so naming an endpoint would misattribute the
    // failure to Datatracker.
    const identifierMessage =
      identifierEnvelope.kind === "error" ? identifierEnvelope.error.message : "";
    expect(identifierMessage).not.toContain("http");
    expect(datatracker.urls).toEqual([]);

    expect(toErrorEnvelope(await research("RFC9110"))).toMatchObject({
      kind: "error",
      error: { code: "discovery_failed" },
    });
    expect(datatracker.urls.length).toBeGreaterThan(0);
  });

  test("bounds an upstream failure description carried into the envelope", () => {
    // A provider or platform reason can embed a response body of unknown size
    // and content, and the envelope reaches standard error and MCP tool errors.
    const envelope = toErrorEnvelope(
      new RfcSourceFetchError({
        stage: "request",
        url: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        reason: `leading\n\tdetail ${"x".repeat(5_000)}`,
      }),
    );
    const message = envelope.kind === "error" ? envelope.error.message : "";
    expect(message.length).toBeLessThan(300);
    expect(message).toContain("https://www.rfc-editor.org/rfc/rfc9110.txt");
    // Newlines and tabs are collapsed so one failure stays one line.
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\t");
    expect(message.endsWith("…")).toBe(true);
  });
});
