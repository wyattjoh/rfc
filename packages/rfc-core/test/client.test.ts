import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CatalogRefreshError,
  InvalidInputError,
  RfcClientClosedError,
  createRfcClient as createCoreRfcClient,
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

  test("decodes research input at the Promise facade boundary", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 2,
        question: "What is HTTP?",
        rfc: null,
      } as never),
    ).rejects.toBeInstanceOf(InvalidInputError);
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
  });
});
