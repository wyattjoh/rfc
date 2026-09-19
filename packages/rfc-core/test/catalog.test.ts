import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  CatalogRefreshError,
  CatalogStaleError,
  CatalogStore,
  catalogStoreLayer,
  createRfcClient,
  makeCatalog,
  type RfcClient,
} from "../src/index";

const clients: Array<RfcClient> = [];

const makeCacheDirectory = async () => mkdtemp(join(tmpdir(), "rfc-core-catalog-test-"));

const makeHttpClient = (handler: (url: URL) => Response) => {
  const requests: Array<string> = [];
  const client = HttpClient.make((request, url) => {
    requests.push(url.toString());
    return Effect.succeed(HttpClientResponse.fromWeb(request, handler(url)));
  });
  return { client, requests };
};

const document = (number: number, title: string) => ({
  name: `rfc${number}`,
  rfc_number: number,
  title,
  abstract: `Abstract for ${title}`,
  state: "Published",
  resource_uri: `/api/v1/doc/document/rfc${number}/`,
  stream: "/api/v1/name/streamname/ietf/",
  states: ["/api/v1/doc/state/177/"],
});

const page = (objects: ReadonlyArray<unknown>, next: string | null, totalCount: number) => ({
  meta: {
    limit: 500,
    offset: 0,
    total_count: totalCount,
    next,
    previous: null,
  },
  objects,
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("catalog refresh", () => {
  test("follows Datatracker pagination, deduplicates documents, and normalizes relationships", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const http = makeHttpClient((url) => {
      if (url.pathname.endsWith("/document/")) {
        return Response.json(
          url.searchParams.get("offset") === "0"
            ? page(
                [document(2, "Second"), document(1, "First"), document(1, "First")],
                "/api/v1/doc/document/?type__slug=rfc&limit=500&offset=3&format=json",
                4,
              )
            : page([document(3, "Third")], null, 4),
        );
      }

      if (url.pathname.endsWith("/relateddocument/")) {
        return Response.json(
          page(
            [
              {
                source: "/api/v1/doc/document/rfc3/",
                target: "/api/v1/doc/document/rfc1/",
                relationship: "/api/v1/name/docrelationshipname/updates/",
              },
              {
                source: "/api/v1/doc/document/rfc3/",
                target: "/api/v1/doc/document/rfc2/",
                relationship: "/api/v1/name/docrelationshipname/obs/",
              },
            ],
            null,
            2,
          ),
        );
      }

      return new Response("not found", { status: 404 });
    });

    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: "https://example.test/api/v1/",
      catalogHttpClient: http.client,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.catalogRefresh();
    const cached = JSON.parse(await readFile(join(cacheDirectory, "catalog.json"), "utf8"));

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "catalog_refresh",
      state: "fresh",
      documentCount: 3,
      cacheIdentity: "rfc-catalog-v1",
    });
    expect(cached.documents).toEqual([
      expect.objectContaining({
        identifier: "RFC1",
        status: "published",
        canonicalUrl: "https://datatracker.ietf.org/doc/rfc1/",
        updates: [],
        updatedBy: ["RFC3"],
        obsoletes: [],
        obsoletedBy: [],
      }),
      expect.objectContaining({
        identifier: "RFC2",
        obsoletes: [],
        obsoletedBy: ["RFC3"],
      }),
      expect.objectContaining({
        identifier: "RFC3",
        updates: ["RFC1"],
        obsoletes: ["RFC2"],
      }),
    ]);
    expect(http.requests.filter((request) => request.includes("/document/"))).toHaveLength(2);
    expect(http.requests.filter((request) => request.includes("/relateddocument/"))).toHaveLength(
      1,
    );
  });

  test("rejects malformed upstream metadata without creating a cache", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const http = makeHttpClient((url) => {
      if (url.pathname.endsWith("/document/")) {
        return Response.json(page([{ name: "rfc1", rfc_number: 1 }], null, 1));
      }
      return Response.json(page([], null, 0));
    });

    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: "https://example.test/api/v1/",
      catalogHttpClient: http.client,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(client.catalogRefresh()).rejects.toBeInstanceOf(CatalogRefreshError);
    await expect(client.catalogStatus()).resolves.toMatchObject({ state: "missing" });
  });

  test("rejects cross-origin pagination and preserves the previous cache", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let crossOriginNext = false;
    const http = makeHttpClient((url) => {
      if (url.pathname.endsWith("/document/")) {
        return Response.json(
          crossOriginNext
            ? page(
                [document(1, "First")],
                "https://evil.example/api/v1/doc/document/?type__slug=rfc&limit=500&offset=1&format=json",
                2,
              )
            : page([document(1, "First")], null, 1),
        );
      }
      if (url.pathname.endsWith("/relateddocument/")) {
        return Response.json(page([], null, 0));
      }
      return new Response("not found", { status: 404 });
    });

    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: "https://example.test/api/v1/",
      catalogHttpClient: http.client,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await client.catalogRefresh();
    const previous = await readFile(join(cacheDirectory, "catalog.json"), "utf8");
    crossOriginNext = true;

    await expect(client.catalogRefresh()).rejects.toMatchObject({
      _tag: "CatalogRefreshError",
      reason: "Datatracker returned a next-page URL outside the configured API origin",
    });
    await expect(readFile(join(cacheDirectory, "catalog.json"), "utf8")).resolves.toBe(previous);
    expect(http.requests.some((request) => request.includes("evil.example"))).toBe(false);
  });

  test("rejects cross-origin redirects before consuming a response", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let redirecting = false;
    let crossOriginResponseConsumed = false;
    const requests: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
    const catalogFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, redirect: init?.redirect });

      if (redirecting) {
        if (init?.redirect === "error") {
          throw new TypeError("cross-origin redirect rejected");
        }
        crossOriginResponseConsumed = true;
        return url.includes("/relateddocument/")
          ? Response.json(page([], null, 0))
          : Response.json(page([document(2, "Cross-origin")], null, 1));
      }

      return url.includes("/relateddocument/")
        ? Response.json(page([], null, 0))
        : Response.json(page([document(1, "First")], null, 1));
    }) as typeof globalThis.fetch;

    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: "https://example.test/api/v1/",
      catalogFetch,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await client.catalogRefresh();
    const previous = await readFile(join(cacheDirectory, "catalog.json"), "utf8");
    redirecting = true;

    await expect(client.catalogRefresh()).rejects.toMatchObject({
      _tag: "CatalogRefreshError",
      stage: "request",
    });
    await expect(readFile(join(cacheDirectory, "catalog.json"), "utf8")).resolves.toBe(previous);
    expect(crossOriginResponseConsumed).toBe(false);
    expect(requests.every((request) => request.redirect === "error")).toBe(true);
  });

  test("preserves a previous catalog when a later page fails", async () => {
    const cacheDirectory = await makeCacheDirectory();
    let failSecondPage = false;
    const http = makeHttpClient((url) => {
      if (url.pathname.endsWith("/document/")) {
        if (url.searchParams.get("offset") === "0") {
          return Response.json(
            page(
              [document(1, "First")],
              "/api/v1/doc/document/?type__slug=rfc&limit=500&offset=1&format=json",
              2,
            ),
          );
        }
        if (failSecondPage) {
          return new Response("upstream unavailable", { status: 503 });
        }
        return Response.json(page([document(2, "Second")], null, 2));
      }
      if (url.pathname.endsWith("/relateddocument/")) {
        return Response.json(page([], null, 0));
      }
      return new Response("not found", { status: 404 });
    });

    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: "https://example.test/api/v1/",
      catalogHttpClient: http.client,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await client.catalogRefresh();
    const previous = await readFile(join(cacheDirectory, "catalog.json"), "utf8");
    failSecondPage = true;

    await expect(client.catalogRefresh()).rejects.toBeInstanceOf(CatalogRefreshError);
    await expect(readFile(join(cacheDirectory, "catalog.json"), "utf8")).resolves.toBe(previous);
  });
});

describe("catalog storage", () => {
  test("does not replace a valid cache when atomic rename fails", async () => {
    const catalogPath = "/cache/catalog.json";
    const previous = "previous catalog";
    const files = new Map([[catalogPath, previous]]);
    const fileSystem = FileSystem.makeNoop({
      makeDirectory: () => Effect.void,
      writeFileString: (path, contents) =>
        Effect.sync(() => {
          files.set(path, contents);
        }),
      rename: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "test",
            method: "rename",
            pathOrDescriptor: catalogPath,
          }),
        ),
      remove: () => Effect.void,
    });
    const catalog = makeCatalog(
      [
        {
          identifier: "RFC1",
          rfcNumber: 1,
          title: "First",
          abstract: "First",
          status: "published",
          stream: "ietf",
          canonicalUrl: "https://datatracker.ietf.org/doc/rfc1/",
          updates: [],
          updatedBy: [],
          obsoletes: [],
          obsoletedBy: [],
        },
      ],
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    const program = Effect.gen(function* () {
      const store = yield* CatalogStore;
      yield* store.write(catalogPath, catalog);
    });
    const layer = Layer.merge(catalogStoreLayer, Layer.succeed(FileSystem.FileSystem, fileSystem));

    await expect(Effect.runPromise(Effect.provide(program, layer))).rejects.toMatchObject({
      _tag: "CatalogWriteError",
    });
    expect(files.get(catalogPath)).toBe(previous);
  });
});

describe("catalog status", () => {
  test("treats exactly seven days as fresh and older catalogs as stale", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetchedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => fetchedAt + 7 * 24 * 60 * 60 * 1000,
    });
    clients.push(client);

    await writeFile(
      join(cacheDirectory, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_catalog",
        cacheIdentity: "rfc-catalog-v1",
        fetchedAt: new Date(fetchedAt).toISOString(),
        documents: [],
      }),
    );

    await expect(client.catalogStatus()).resolves.toMatchObject({
      state: "fresh",
      ageMs: 7 * 24 * 60 * 60 * 1000,
      documentCount: 0,
    });

    const staleClient = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => fetchedAt + 7 * 24 * 60 * 60 * 1000 + 1,
    });
    clients.push(staleClient);

    await expect(staleClient.catalogStatus()).resolves.toMatchObject({ state: "stale" });
  });

  test("rejects malformed cached metadata as a typed read failure", async () => {
    const cacheDirectory = await makeCacheDirectory();
    await writeFile(join(cacheDirectory, "catalog.json"), '{"schemaVersion": 1}');
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.now(),
    });
    clients.push(client);

    await expect(client.catalogStatus()).rejects.toMatchObject({ _tag: "CatalogReadError" });
  });

  test("does not make stale catalog data research-ready", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      datatrackerApiUrl: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      now: () => Date.parse("2026-01-09T00:00:01.000Z"),
    });
    clients.push(client);

    await writeFile(
      join(cacheDirectory, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_catalog",
        cacheIdentity: "rfc-catalog-v1",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        documents: [],
      }),
    );

    await expect(
      client.research({ schemaVersion: 1, question: "What is HTTP?", rfc: null }),
    ).rejects.toBeInstanceOf(CatalogStaleError);
  });
});
