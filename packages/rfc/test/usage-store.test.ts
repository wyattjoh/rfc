import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeUsageRecorder, UsageTotalsSchema } from "../src/usage-store";
import { Schema } from "effect";

const readTotals = async (path: string) =>
  Schema.decodeUnknownSync(UsageTotalsSchema)(JSON.parse(await readFile(path, "utf8")));

describe("per-user RFC usage store", () => {
  test("tracks priced, unpriced, and missing input usage separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-store-"));
    const path = join(directory, "usage.json");
    const record = makeUsageRecorder(path, () => new Date("2026-01-02T03:04:05.000Z"));

    await record({ inputTokens: 100, estimatedInputCostUsd: 0.0000042 });
    await record({ inputTokens: 50, estimatedInputCostUsd: null });
    await record({ inputTokens: null, estimatedInputCostUsd: null });

    expect(await readTotals(path)).toEqual({
      schemaVersion: 1,
      kind: "rfc_usage_totals",
      updatedAt: "2026-01-02T03:04:05.000Z",
      operations: 3,
      pricedOperations: 1,
      unpricedOperations: 1,
      operationsWithoutInputTokens: 1,
      inputTokens: 150,
      pricedInputTokens: 100,
      unpricedInputTokens: 50,
      estimatedInputCostUsd: 0.0000042,
    });
  });

  test("serializes concurrent updates without losing totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-concurrency-"));
    const path = join(directory, "usage.json");
    const record = makeUsageRecorder(path);

    await Promise.all(
      Array.from({ length: 16 }, () =>
        record({ inputTokens: 25, estimatedInputCostUsd: 0.00000105 }),
      ),
    );

    expect(await readTotals(path)).toMatchObject({
      operations: 16,
      pricedOperations: 16,
      inputTokens: 400,
      pricedInputTokens: 400,
      estimatedInputCostUsd: 0.0000168,
    });
  });

  test("does not overwrite a malformed totals file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-corrupt-"));
    const path = join(directory, "usage.json");
    const malformed = '{"schemaVersion":999}\n';
    await writeFile(path, malformed);

    await expect(
      makeUsageRecorder(path)({ inputTokens: 10, estimatedInputCostUsd: 0.00000042 }),
    ).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(malformed);
  });
});
