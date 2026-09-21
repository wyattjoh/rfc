import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeUsageRecorder, UsageTotalsSchema, type UsageObservation } from "../src/usage-store";
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

    // The specific decode failure, not merely "some rejection": a broader
    // assertion would pass for a lock timeout or a permission error too.
    await expect(
      makeUsageRecorder(path)({ inputTokens: 10, estimatedInputCostUsd: 0.00000042 }),
    ).rejects.toMatchObject({
      name: "SchemaError",
      message: expect.stringContaining("schemaVersion"),
    });
    expect(await readFile(path, "utf8")).toBe(malformed);
    // The lock is released even when the read inside it throws.
    expect(await readdir(directory)).toEqual(["usage.json"]);
  });

  test("rejects an unusable observation without touching the totals file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-observation-"));
    const path = join(directory, "usage.json");
    const record = makeUsageRecorder(path);

    const rejected: ReadonlyArray<readonly [UsageObservation, string]> = [
      [{ inputTokens: -1, estimatedInputCostUsd: null }, "non-negative safe integer"],
      [{ inputTokens: 1.5, estimatedInputCostUsd: null }, "non-negative safe integer"],
      [{ inputTokens: Number.NaN, estimatedInputCostUsd: null }, "non-negative safe integer"],
      [
        { inputTokens: Number.MAX_SAFE_INTEGER + 2, estimatedInputCostUsd: null },
        "non-negative safe integer",
      ],
      [{ inputTokens: 1, estimatedInputCostUsd: -0.5 }, "non-negative finite number"],
      [
        { inputTokens: 1, estimatedInputCostUsd: Number.POSITIVE_INFINITY },
        "non-negative finite number",
      ],
      [{ inputTokens: 1, estimatedInputCostUsd: Number.NaN }, "non-negative finite number"],
    ];
    for (const [observation, reason] of rejected) {
      await expect(record(observation)).rejects.toThrow(reason);
    }

    // Validation runs before the directory and lock are created, so nothing
    // reaches the filesystem.
    expect(existsSync(path)).toBe(false);
  });

  test("reclaims a stale lock left behind by a dead writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-stale-lock-"));
    const path = join(directory, "usage.json");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "999999\n");
    const stale = Date.now() / 1_000 - 60;
    await utimes(lockPath, stale, stale);

    const totals = await makeUsageRecorder(path)({
      inputTokens: 10,
      estimatedInputCostUsd: 0.00000042,
    });

    expect(totals).toMatchObject({ operations: 1, inputTokens: 10 });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("times out rather than waiting forever on a live lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-live-lock-"));
    const path = join(directory, "usage.json");
    const lockPath = `${path}.lock`;
    // Written now, so it stays well inside the 30 s staleness window for the
    // whole 200 x 10 ms retry budget and is never reclaimed.
    await writeFile(lockPath, "1\n");

    await expect(
      makeUsageRecorder(path)({ inputTokens: 10, estimatedInputCostUsd: null }),
    ).rejects.toThrow("Timed out waiting for the RFC usage-store lock");
    // The live holder's lock is left in place rather than stolen.
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(path)).toBe(false);
  }, 15_000);

  test("records through a temporary file stranded by a crashed writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfc-usage-stranded-tmp-"));
    const path = join(directory, "usage.json");
    const stranded = join(directory, ".usage-1-00000000-0000-4000-8000-000000000000.tmp");
    await writeFile(stranded, "partial");

    const totals = await makeUsageRecorder(path)({
      inputTokens: 10,
      estimatedInputCostUsd: 0.00000042,
    });

    expect(totals).toMatchObject({ operations: 1 });
    expect(await readTotals(path)).toMatchObject({ operations: 1 });
    // Each write picks a fresh random temporary name, so a stranded file can
    // never collide with one. It is also never reclaimed: leftovers accumulate
    // until the user removes them.
    expect(existsSync(stranded)).toBe(true);
  });
});
