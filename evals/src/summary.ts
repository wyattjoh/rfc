import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Arm, arms } from "./arms";
import {
  type GradeRecord,
  type Overrides,
  type RunInfo,
  type TrialRecord,
  type TrialStatus,
  type Verdict,
  overrideKey,
  readJson,
  runDir,
  trialDir,
} from "./results";
import { baselineDir, resultsDir } from "./paths";
import { type Task, loadTask } from "./tasks";

/**
 * One trial as the report sees it.
 */
export type SummaryTrial = {
  arm: string;
  task: string;
  trial: number;
  status: TrialStatus;
  lat: number;
  calls: number;
  out: number;
  cost: number;
  ts: number;
  correct: number;
  /**
   * Per-claim verdicts after overrides; null when only a hand-graded total exists.
   */
  claims: Array<Verdict | null> | null;
};

/**
 * Everything the report renders, written to `summary.json`. The committed
 * baseline uses the same shape.
 */
export type Summary = {
  run: RunInfo & { judgeModel: string | null; note: string | null };
  arms: ReadonlyArray<Arm>;
  tasks: Array<Pick<Task, "id" | "title" | "label" | "factors" | "prompt"> & { claims: number }>;
  trials: Array<SummaryTrial>;
};

/**
 * Summary fields describing one task.
 */
export const summaryTask = (task: Task): Summary["tasks"][number] => ({
  id: task.id,
  title: task.title,
  label: task.label,
  factors: task.factors,
  prompt: task.prompt,
  claims: task.claims.length,
});

/**
 * Builds a run's summary from its trial and grade files, applying the run's
 * `overrides.json`. Ungraded claims are null and count as not correct.
 */
export const summarizeRun = (runId: string): Summary => {
  const dir = runDir(runId);
  const info = readJson<RunInfo>(join(dir, "run.json"));
  if (info === undefined) throw new Error(`run ${runId} has no run.json`);
  const overrides = readJson<Overrides>(join(dir, "overrides.json")) ?? {};
  const tasks = info.tasks.map(loadTask);
  const trials: Array<SummaryTrial> = [];
  let judgeModel: string | null = null;
  for (let trial = 1; trial <= info.trials; trial++)
    for (const task of tasks)
      for (const arm of info.arms) {
        const tdir = trialDir(runId, arm, task.id, trial);
        const record = readJson<TrialRecord>(join(tdir, "trial.json"));
        if (record === undefined) continue;
        const grade = readJson<GradeRecord>(join(tdir, "grade.json"));
        judgeModel ??= grade?.judgeModel ?? null;
        const claims = task.claims.map(
          (_, i) =>
            overrides[overrideKey(arm, task.id, trial, i + 1)]?.verdict ??
            grade?.claims.find((c) => c.claim === i + 1)?.verdict ??
            null,
        );
        const m = record.metrics;
        trials.push({
          arm,
          task: task.id,
          trial,
          status: record.status,
          lat: m?.lat ?? 0,
          calls: m?.calls ?? 0,
          out: m?.out ?? 0,
          cost: m?.cost ?? 0,
          ts: m?.ts ?? 0,
          correct: claims.filter((v) => v === "correct").length,
          claims,
        });
      }
  return {
    run: { ...info, harness: info.harness ?? "pi", judgeModel, note: null },
    arms: arms.filter((arm) => info.arms.includes(arm.id)),
    tasks: tasks.map(summaryTask),
    trials,
  };
};

/**
 * Why a run can't be shown yet, or undefined when every trial ran and every
 * claim has a verdict. Hand-graded trials (claims null) count as graded.
 */
export const incompleteReason = (summary: Summary): string | undefined => {
  const expected = summary.run.trials * summary.run.tasks.length * summary.run.arms.length;
  if (summary.trials.length < expected) return `${summary.trials.length}/${expected} trials ran`;
  const ungraded = summary.trials.filter(
    (t) => t.claims !== null && t.claims.some((v) => v === null),
  ).length;
  return ungraded === 0
    ? undefined
    : `${ungraded} trials have ungraded claims; run "bun run eval grade" on it`;
};

// A run that fails to summarize (for example, it names a task that no longer
// exists) or is incomplete is left off the dashboard with a warning instead of
// breaking the rebuild.
const summarizeForDashboard = (runId: string): Array<Summary> => {
  try {
    const summary = summarizeRun(runId);
    const reason = incompleteReason(summary);
    if (reason === undefined) return [summary];
    console.warn(`dashboard: skipping ${runId}: ${reason}`);
  } catch (error) {
    console.warn(
      `dashboard: skipping ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return [];
};

/**
 * Every complete run under `evals/results/`, newest first, followed by the
 * committed baseline under the id `baseline`. Skipped runs are reported on stderr.
 */
export const summarizeAll = (): Array<Summary> => {
  const runs = existsSync(resultsDir)
    ? readdirSync(resultsDir)
        .filter((id) => existsSync(join(runDir(id), "run.json")))
        .flatMap(summarizeForDashboard)
        .sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt))
    : [];
  const baseline = readJson<Summary>(join(baselineDir, "summary.json"));
  if (baseline === undefined) return runs;
  return [
    ...runs,
    {
      ...baseline,
      run: {
        ...baseline.run,
        id: "baseline",
        note: `Baseline, promoted from ${baseline.run.id}. ${baseline.run.note ?? ""}`.trim(),
      },
    },
  ];
};
