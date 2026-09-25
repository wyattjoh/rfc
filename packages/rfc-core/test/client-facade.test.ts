import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createRfcClient } from "../src/index";

test("the client exposes only request-local operations", async () => {
  const client = await createRfcClient({
    cacheDirectory: await mkdtemp(join(tmpdir(), "rfc-client-facade-test-")),
    modelAlias: undefined,
    typeSafeApiKey: undefined,
    typeSafeApiUrl: undefined,
  });

  try {
    expect(Object.keys(client).sort()).toEqual([
      "close",
      "research",
      "sourceCacheRemove",
      "sourceCacheStatus",
      "sourceText",
      "verifyCitation",
    ]);
    expect("catalogRefresh" in client).toBe(false);
    expect("prefetchSources" in client).toBe(false);
  } finally {
    await client.close();
  }
});
