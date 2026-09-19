import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  RfcClientClosedError,
  createRfcClient,
  toErrorEnvelope,
  type RfcClient,
} from "../src/index";

const clients: Array<RfcClient> = [];

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
      refreshedAt: null,
      ageMs: null,
    });

    await rm(cacheDirectory, { recursive: true, force: true });
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
  });
});
