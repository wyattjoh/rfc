import { join } from "node:path";
import { type JudgeOptions, gradeClaim } from "./judge";
import { pool } from "./pool";
import {
  type GradeRecord,
  type RunInfo,
  type TrialRecord,
  readJson,
  runDir,
  trialDir,
  writeJson,
} from "./results";
import { loadTask } from "./tasks";

/**
 * Grades every trial of a run that has no `grade.json` yet (or all of them with
 * `regrade`). Trials without an answer get every claim marked incorrect without
 * a judge call.
 */
export const gradeRun = async (
  runId: string,
  options: JudgeOptions & { concurrency: number; regrade: boolean },
): Promise<void> => {
  const info = readJson<RunInfo>(join(runDir(runId), "run.json"));
  if (info === undefined) throw new Error(`run ${runId} has no run.json`);
  const tasks = new Map(info.tasks.map((id) => [id, loadTask(id)]));
  const pending: Array<{ record: TrialRecord; path: string }> = [];
  for (let trial = 1; trial <= info.trials; trial++)
    for (const task of info.tasks)
      for (const arm of info.arms) {
        const dir = trialDir(runId, arm, task, trial);
        const record = readJson<TrialRecord>(join(dir, "trial.json"));
        const path = join(dir, "grade.json");
        if (record === undefined) continue;
        if (!options.regrade && readJson<GradeRecord>(path) !== undefined) continue;
        pending.push({ record, path });
      }

  const jobs = pending.flatMap(({ record }, trialIndex) =>
    tasks.get(record.task)!.claims.map((_, i) => ({ trialIndex, record, claim: i + 1 })),
  );
  let done = 0;
  const grades = await pool(jobs, options.concurrency, async ({ record, claim }) => {
    const grade =
      record.answer === null
        ? { verdict: "incorrect" as const, reason: `no answer (${record.status})`, cost: 0 }
        : await gradeClaim(options, tasks.get(record.task)!, claim, record.answer);
    done++;
    console.log(
      `[${done}/${jobs.length}] ${record.arm} ${record.task} t${record.trial} claim ${claim}: ${grade.verdict}`,
    );
    return grade;
  });

  pending.forEach(({ path }, trialIndex) => {
    const own = jobs.flatMap((job, i) =>
      job.trialIndex === trialIndex ? [{ claim: job.claim, ...grades[i]! }] : [],
    );
    const record: GradeRecord = {
      judgeModel: options.model,
      judgeCost: Number(own.reduce((sum, g) => sum + g.cost, 0).toFixed(4)),
      claims: own.map(({ claim, verdict, reason }) => ({ claim, verdict, reason })),
    };
    writeJson(path, record);
  });
};
