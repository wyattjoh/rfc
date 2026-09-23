import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArmId } from "./arms";
import { resultsDir } from "./paths";
import type { TrialMetrics } from "./transcript";

/**
 * Settings and provenance of one run, written to `run.json`.
 */
export type RunInfo = {
  id: string;
  startedAt: string;
  gitSha: string;
  gitDirty: boolean;
  /**
   * Agent harness driving the trials. Runs written before this field existed were all Pi.
   */
  harness: string;
  piVersion: string;
  webAccessVersion: string;
  model: string;
  thinking: string;
  trials: number;
  arms: ReadonlyArray<ArmId>;
  tasks: ReadonlyArray<string>;
};

/**
 * How a trial ended.
 */
export type TrialStatus = "ok" | "no-answer" | "timeout" | "error";

/**
 * One trial's outcome, written to `trial.json`.
 */
export type TrialRecord = {
  arm: ArmId;
  task: string;
  trial: number;
  status: TrialStatus;
  exitCode: number | null;
  metrics: TrialMetrics | null;
  answer: string | null;
};

/**
 * A judge verdict on one claim.
 */
export type Verdict = "correct" | "incorrect" | "unknown";

/**
 * One trial's claim grades, written to `grade.json`.
 */
export type GradeRecord = {
  judgeModel: string;
  judgeCost: number;
  claims: Array<{ claim: number; verdict: Verdict; reason: string }>;
};

/**
 * A human verdict that replaces the judge's for one claim, keyed `arm/task/tN/claimN`.
 */
export type Overrides = Record<string, { verdict: Verdict; note: string }>;

/**
 * Directory of one run.
 */
export const runDir = (runId: string): string => join(resultsDir, runId);

/**
 * Directory of one trial within a run.
 */
export const trialDir = (runId: string, arm: ArmId, task: string, trial: number): string =>
  join(runDir(runId), arm, task, `t${trial}`);

/**
 * Key of one claim in an overrides file.
 */
export const overrideKey = (arm: ArmId, task: string, trial: number, claim: number): string =>
  `${arm}/${task}/t${trial}/${claim}`;

/**
 * Reads a JSON file, or returns undefined when it does not exist.
 */
export const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;

/**
 * Writes pretty JSON, creating parent directories.
 */
export const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

/**
 * Resolves `latest` to the newest run id; other values pass through after an existence check.
 */
export const resolveRunId = (value: string): string => {
  if (value !== "latest") {
    if (!existsSync(join(runDir(value), "run.json")))
      throw new Error(`no run ${value} in ${resultsDir}`);
    return value;
  }
  const ids = existsSync(resultsDir)
    ? readdirSync(resultsDir).filter((id) => existsSync(join(runDir(id), "run.json")))
    : [];
  const latest = ids.sort().at(-1);
  if (latest === undefined) throw new Error(`no runs in ${resultsDir}`);
  return latest;
};
