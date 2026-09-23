#!/usr/bin/env bun
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { defaults } from "../config";
import { type ArmId, arms, isArmId } from "./arms";
import { gradeRun } from "./grade";
import { baselineDir, resultsDir } from "./paths";
import { writeReport } from "./report";
import {
  type RunInfo,
  type TrialRecord,
  readJson,
  resolveRunId,
  runDir,
  trialDir,
  writeJson,
} from "./results";
import { newRunId, resumeSettings, runSuite } from "./run";
import { type Summary, summarizeAll, summarizeRun } from "./summary";
import { listCohortTaskIds, listTaskIds, loadTasks } from "./tasks";
import { extractToolCalls, readSession } from "./transcript";

const usage = `usage: bun run eval <command> [options]

commands:
  run                 run trials, grade them, and write the report
  grade <run>         grade (or --regrade) a run's trials
  report [<run>|all]  rebuild a run's summary.json and report.html (default: all runs)
  answers <run> <task>  print every trial's final answer for one task (--calls adds tool calls)
  promote <run>       copy a run's summary.json to evals/baseline/summary.json

<run> is a run id under evals/results/, "latest", or (for report) "baseline".
Every run, grade, and report also rebuilds evals/results/index.html, one dashboard
with a run selector over every complete run plus the committed baseline.

run options:
  --arms <ids>        comma-separated: ${arms.map((a) => a.id).join(", ")} (default: both)
  --tasks <ids>       comma-separated task ids (default: baseline cohort)
  --cohort <name>     baseline or token-exchange (default: baseline; cannot combine with --tasks)
  --trials <n>        trials per task per arm (default: ${defaults.trials})
  --model <p/id>      model under test (default: ${defaults.model})
  --thinking <level>  thinking level (default: ${defaults.thinking})
  --concurrency <n>   trials in flight (default: ${defaults.concurrency})
  --resume <run>      continue a run with its recorded settings, keeping trials that finished ok
  --no-grade          skip grading and the report

grade options:
  --regrade           re-grade trials that already have grade.json
  --judge-model <p/id>  (default: ${defaults.judgeModel})

report options:
  --open              open the dashboard at this run in the default browser
`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    arms: { type: "string" },
    tasks: { type: "string" },
    cohort: { type: "string" },
    trials: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    concurrency: { type: "string" },
    resume: { type: "string" },
    "no-grade": { type: "boolean", default: false },
    regrade: { type: "boolean", default: false },
    "judge-model": { type: "string" },
    open: { type: "boolean", default: false },
    calls: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const positiveInt = (value: string | undefined, fallback: number, flag: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`--${flag} must be a positive integer`);
  return parsed;
};

const list = (value: string | undefined): Array<string> | undefined =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

const judgeOptions = () => ({
  model: values["judge-model"] ?? defaults.judgeModel,
  thinking: defaults.judgeThinking,
  timeoutMs: defaults.judgeTimeoutMs,
  concurrency: defaults.judgeConcurrency,
  regrade: values.regrade,
});

const indexPath = join(resultsDir, "index.html");

// The combined dashboard: every complete run plus the baseline, newest first.
const writeIndex = async (selected: string): Promise<void> => {
  const runs = summarizeAll();
  writeReport(runs, indexPath);
  console.log(`dashboard: ${indexPath} (${runs.length} runs)`);
  if (values.open)
    await $`open ${`file://${indexPath}?run=${encodeURIComponent(selected)}`}`.quiet();
};

const report = async (summary: Summary, dir: string): Promise<void> => {
  writeJson(join(dir, "summary.json"), summary);
  const path = join(dir, "report.html");
  writeReport([summary], path);
  console.log(`report: ${path}`);
  await writeIndex(summary.run.id);
};

const reportRun = (runId: string): Promise<void> => report(summarizeRun(runId), runDir(runId));

const commands: Record<string, () => Promise<void>> = {
  run: async () => {
    const armIds = list(values.arms) ?? arms.map((a) => a.id);
    const unknownArm = armIds.find((id) => !isArmId(id));
    if (unknownArm !== undefined) throw new Error(`unknown arm ${unknownArm}`);
    if (values.cohort !== undefined && !["baseline", "token-exchange"].includes(values.cohort))
      throw new Error(`unknown cohort ${values.cohort}`);
    if (values.cohort !== undefined && values.tasks !== undefined)
      throw new Error("--cohort and --tasks cannot be combined");
    const taskIds =
      values.cohort === undefined
        ? list(values.tasks)
        : listCohortTaskIds(values.cohort as "baseline" | "token-exchange");
    const known = new Set(listTaskIds());
    const unknownTask = taskIds?.find((id) => !known.has(id));
    if (unknownTask !== undefined) throw new Error(`unknown task ${unknownTask}`);
    const trials =
      values.trials === undefined ? undefined : positiveInt(values.trials, 1, "trials");
    // A resumed run always continues with the settings recorded in its run.json.
    const resumed =
      values.resume === undefined
        ? undefined
        : (() => {
            const runId = resolveRunId(values.resume);
            const info = readJson<RunInfo>(join(runDir(runId), "run.json"))!;
            const settings = resumeSettings(info, {
              model: values.model,
              thinking: values.thinking,
              trials,
              tasks: taskIds,
              arms: list(values.arms),
            });
            return { runId, settings };
          })();
    const runId = resumed?.runId ?? (await newRunId());
    console.log(`run ${runId} -> ${runDir(runId)}${resumed === undefined ? "" : " (resumed)"}`);
    await runSuite(
      {
        runId,
        arms: (resumed?.settings.arms ?? armIds) as Array<ArmId>,
        tasks: loadTasks(resumed?.settings.tasks ?? taskIds ?? listCohortTaskIds("baseline")),
        trials: resumed?.settings.trials ?? trials ?? defaults.trials,
        model: resumed?.settings.model ?? values.model ?? defaults.model,
        thinking: resumed?.settings.thinking ?? values.thinking ?? defaults.thinking,
        concurrency: positiveInt(values.concurrency, defaults.concurrency, "concurrency"),
        trialTimeoutMs: defaults.trialTimeoutMs,
      },
      resumed !== undefined,
    );
    if (values["no-grade"]) return;
    await gradeRun(runId, judgeOptions());
    await reportRun(runId);
  },
  grade: async () => {
    const runId = resolveRunId(positionals[1] ?? "latest");
    await gradeRun(runId, judgeOptions());
    await reportRun(runId);
  },
  report: async () => {
    const target = positionals[1] ?? "all";
    if (target === "all") return writeIndex(summarizeAll()[0]?.run.id ?? "baseline");
    if (target !== "baseline") return reportRun(resolveRunId(target));
    if (readJson<Summary>(join(baselineDir, "summary.json")) === undefined)
      throw new Error("evals/baseline/summary.json is missing");
    return writeIndex("baseline");
  },
  answers: async () => {
    const runId = resolveRunId(positionals[1] ?? "latest");
    const task = positionals[2];
    if (task === undefined) throw new Error("answers needs a task id");
    const summary = summarizeRun(runId);
    for (const trial of summary.trials.filter((t) => t.task === task)) {
      const arm = trial.arm as ArmId;
      const dir = trialDir(runId, arm, task, trial.trial);
      const record = readJson<TrialRecord>(join(dir, "trial.json"));
      console.log(
        `===== ${arm} t${trial.trial} (${trial.status}, ${trial.correct}/${trial.claims?.length ?? "?"})`,
      );
      if (values.calls)
        for (const call of extractToolCalls(readSession(join(dir, "session")) ?? []))
          console.log("CALL", call.name, JSON.stringify(call.arguments));
      console.log(record?.answer ?? "(no answer)");
    }
  },
  promote: async () => {
    const runId = resolveRunId(positionals[1] ?? "latest");
    await reportRun(runId);
    copyFileSync(join(runDir(runId), "summary.json"), join(baselineDir, "summary.json"));
    console.log(`baseline <- ${runId}`);
  },
};

const command = positionals[0];
if (values.help || command === undefined || commands[command] === undefined) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
await commands[command]!();
