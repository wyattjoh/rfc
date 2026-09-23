import { join } from "node:path";

/**
 * The `evals/` directory.
 */
export const evalsDir = join(import.meta.dir, "..");

/**
 * The repository root, whose `packages/` are the code under test.
 */
export const repoRoot = join(evalsDir, "..");

/**
 * Git-ignored directory holding one subdirectory per run.
 */
export const resultsDir = join(evalsDir, "results");

/**
 * Committed reference results that new runs are compared against.
 */
export const baselineDir = join(evalsDir, "baseline");

/**
 * The repo's pinned Pi binary.
 */
export const piBinary = join(repoRoot, "node_modules", ".bin", "pi");
