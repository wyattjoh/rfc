import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";

const lockRetryMilliseconds = 10;
const lockAttemptLimit = 200;
const staleLockMilliseconds = 30_000;
const usdPrecision = 1_000_000_000_000;

const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Default per-user file containing cumulative RFC CLI usage.
 */
export const defaultUsageFile = join(homedir(), ".config", "rfc", "usage.json");

/**
 * Schema for the cumulative per-user RFC CLI usage file.
 */
export const UsageTotalsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("rfc_usage_totals"),
  updatedAt: Schema.String,
  operations: Schema.Natural,
  pricedOperations: Schema.Natural,
  unpricedOperations: Schema.Natural,
  operationsWithoutInputTokens: Schema.Natural,
  inputTokens: Schema.Natural,
  pricedInputTokens: Schema.Natural,
  unpricedInputTokens: Schema.Natural,
  estimatedInputCostUsd: NonNegativeFiniteSchema,
});

/**
 * Cumulative per-user RFC CLI usage persisted on disk.
 */
export type UsageTotals = Schema.Schema.Type<typeof UsageTotalsSchema>;

/**
 * One successful RFC CLI operation to include in cumulative usage.
 */
export interface UsageObservation {
  /**
   * Provider-reported input tokens, or null when no model call occurred or usage was unavailable.
   */
  readonly inputTokens: number | null;
  /**
   * Estimated USD input charge, or null when the resolved model has no known price.
   */
  readonly estimatedInputCostUsd: number | null;
}

/**
 * Function that records one successful RFC CLI operation.
 */
export type UsageRecorder = (observation: UsageObservation) => Promise<UsageTotals>;

const isFileSystemError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const releaseLock = async (path: string, handle: FileHandle): Promise<void> => {
  let failure: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    failure = error;
  }
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT") && failure === null) failure = error;
  }
  if (failure !== null) throw failure;
};

const acquireLock = async (path: string): Promise<FileHandle> => {
  for (let attempt = 0; attempt < lockAttemptLimit; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;

      try {
        const lock = await stat(path);
        if (Date.now() - lock.mtimeMs > staleLockMilliseconds) await unlink(path);
      } catch (inspectionError) {
        if (!isFileSystemError(inspectionError, "ENOENT")) throw inspectionError;
      }

      await wait(lockRetryMilliseconds);
      continue;
    }

    try {
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      return handle;
    } catch (error) {
      await releaseLock(path, handle);
      throw error;
    }
  }

  throw new Error("Timed out waiting for the RFC usage-store lock");
};

const emptyTotals = (updatedAt: string): UsageTotals => ({
  schemaVersion: 1,
  kind: "rfc_usage_totals",
  updatedAt,
  operations: 0,
  pricedOperations: 0,
  unpricedOperations: 0,
  operationsWithoutInputTokens: 0,
  inputTokens: 0,
  pricedInputTokens: 0,
  unpricedInputTokens: 0,
  estimatedInputCostUsd: 0,
});

const readTotals = async (path: string, updatedAt: string): Promise<UsageTotals> => {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return emptyTotals(updatedAt);
    throw error;
  }

  return Schema.decodeUnknownSync(UsageTotalsSchema)(JSON.parse(contents));
};

const validateObservation = (observation: UsageObservation): void => {
  if (
    observation.inputTokens !== null &&
    (!Number.isSafeInteger(observation.inputTokens) || observation.inputTokens < 0)
  ) {
    throw new Error("RFC usage input tokens must be a non-negative safe integer or null");
  }
  if (
    observation.estimatedInputCostUsd !== null &&
    (!Number.isFinite(observation.estimatedInputCostUsd) || observation.estimatedInputCostUsd < 0)
  ) {
    throw new Error("RFC usage input cost must be a non-negative finite number or null");
  }
};

const addObservation = (
  totals: UsageTotals,
  observation: UsageObservation,
  updatedAt: string,
): UsageTotals => {
  const inputTokens = observation.inputTokens ?? 0;
  const hasUsage = observation.inputTokens !== null;
  const isPriced = hasUsage && observation.estimatedInputCostUsd !== null;

  return Schema.decodeUnknownSync(UsageTotalsSchema)({
    ...totals,
    updatedAt,
    operations: totals.operations + 1,
    pricedOperations: totals.pricedOperations + (isPriced ? 1 : 0),
    unpricedOperations: totals.unpricedOperations + (hasUsage && !isPriced ? 1 : 0),
    operationsWithoutInputTokens: totals.operationsWithoutInputTokens + (hasUsage ? 0 : 1),
    inputTokens: totals.inputTokens + inputTokens,
    pricedInputTokens: totals.pricedInputTokens + (isPriced ? inputTokens : 0),
    unpricedInputTokens: totals.unpricedInputTokens + (hasUsage && !isPriced ? inputTokens : 0),
    estimatedInputCostUsd:
      Math.round(
        (totals.estimatedInputCostUsd + (observation.estimatedInputCostUsd ?? 0)) * usdPrecision,
      ) / usdPrecision,
  });
};

const writeTotals = async (path: string, totals: UsageTotals): Promise<void> => {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.usage-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(totals, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
};

/**
 * Create an atomic per-user usage recorder for a JSON totals file.
 *
 * @param path Destination JSON file. Defaults to `~/.config/rfc/usage.json`.
 * @param now Clock used for deterministic timestamps in tests.
 * @returns A recorder that serializes concurrent process updates through a lock file.
 */
export const makeUsageRecorder =
  (path: string = defaultUsageFile, now: () => Date = () => new Date()): UsageRecorder =>
  async (observation) => {
    validateObservation(observation);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    const lock = await acquireLock(lockPath);
    try {
      const updatedAt = now().toISOString();
      const totals = addObservation(await readTotals(path, updatedAt), observation, updatedAt);
      await writeTotals(path, totals);
      return totals;
    } finally {
      await releaseLock(lockPath, lock);
    }
  };
