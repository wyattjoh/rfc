import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createRfcCalibrationClient } from "../src/internal-calibration";

test("private calibration exposes only request-local client operations", async () => {
  const client = await createRfcCalibrationClient({
    cacheDirectory: await mkdtemp(join(tmpdir(), "rfc-calibration-client-test-")),
    modelAlias: undefined,
    typeSafeApiKey: undefined,
    typeSafeApiUrl: undefined,
  });

  try {
    expect(Object.keys(client).sort()).toEqual(["close", "research", "verifyCitation"]);
    expect("catalogRefresh" in client).toBe(false);
    expect("prefetchSources" in client).toBe(false);
  } finally {
    await client.close();
  }
});
