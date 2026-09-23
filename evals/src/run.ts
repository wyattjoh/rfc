import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { type ArmId, armSetup } from "./arms";
import { evalsDir, piBinary, repoRoot } from "./paths";
import { pool } from "./pool";
import { waitWithTimeout } from "./process";
import {
  type RunInfo,
  type TrialRecord,
  type TrialStatus,
  readJson,
  runDir,
  trialDir,
  writeJson,
} from "./results";
import type { Task } from "./tasks";
import { extractAnswer, measure, readSession } from "./transcript";

/**
 * Settings for one run of the suite.
 */
export type RunOptions = {
  runId: string;
  arms: ReadonlyArray<ArmId>;
  tasks: ReadonlyArray<Task>;
  trials: number;
  model: string;
  thinking: string;
  concurrency: number;
  trialTimeoutMs: number;
};

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * A sortable run id: local date and time plus the short git sha.
 */
export const newRunId = async (): Promise<string> => {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const { sha, dirty } = await gitState();
  return `${stamp}-${sha}${dirty ? "-dirty" : ""}`;
};

const gitState = async (): Promise<{ sha: string; dirty: boolean }> => {
  const sha = (await $`git rev-parse --short HEAD`.cwd(repoRoot).quiet().text()).trim();
  const status = (await $`git status --porcelain -- packages`.cwd(repoRoot).quiet().text()).trim();
  return { sha, dirty: status.length > 0 };
};

const runInfo = async (options: RunOptions): Promise<RunInfo> => {
  const { sha, dirty } = await gitState();
  const piVersion = (await $`${piBinary} --version`.quiet().text()).trim();
  const webAccess = JSON.parse(
    readFileSync(join(evalsDir, "node_modules", "pi-web-access", "package.json"), "utf8"),
  ) as { version: string };
  return {
    id: options.runId,
    startedAt: new Date().toISOString(),
    gitSha: sha,
    gitDirty: dirty,
    harness: "pi",
    piVersion,
    webAccessVersion: webAccess.version,
    model: options.model,
    thinking: options.thinking,
    trials: options.trials,
    arms: options.arms,
    tasks: options.tasks.map((task) => task.id),
  };
};

type Job = { arm: ArmId; task: Task; trial: number };

/**
 * A trial's status from how its Pi process ended and whether it answered.
 */
export const trialStatus = (end: {
  timedOut: boolean;
  exitCode: number | null;
  hasAnswer: boolean;
}): TrialStatus => {
  if (end.timedOut) return "timeout";
  if (end.exitCode !== 0) return "error";
  return end.hasAnswer ? "ok" : "no-answer";
};

/**
 * Settings a resumed run must keep from its `run.json`.
 */
export type ResumeSettings = Pick<RunInfo, "model" | "thinking" | "trials" | "tasks" | "arms">;

/**
 * Settings requested on the command line; undefined means the flag was not given.
 */
export type RequestedSettings = {
  model: string | undefined;
  thinking: string | undefined;
  trials: number | undefined;
  tasks: ReadonlyArray<string> | undefined;
  arms: ReadonlyArray<string> | undefined;
};

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, i) => value === right[i]);

/**
 * The settings a resumed run continues with: always the ones recorded in
 * `run.json`, so a resume can never mix models or grow the run. A flag that
 * conflicts with the recorded value is an error rather than silently ignored.
 */
export const resumeSettings = (
  info: ResumeSettings,
  requested: RequestedSettings,
): ResumeSettings => {
  const conflicts = [
    requested.model !== undefined && requested.model !== info.model && `--model ${info.model}`,
    requested.thinking !== undefined &&
      requested.thinking !== info.thinking &&
      `--thinking ${info.thinking}`,
    requested.trials !== undefined && requested.trials !== info.trials && `--trials ${info.trials}`,
    requested.tasks !== undefined &&
      !sameList(requested.tasks, info.tasks) &&
      `--tasks ${info.tasks.join(",")}`,
    requested.arms !== undefined &&
      !sameList(requested.arms, info.arms) &&
      `--arms ${info.arms.join(",")}`,
  ].filter((conflict): conflict is string => typeof conflict === "string");
  if (conflicts.length > 0)
    throw new Error(
      `a resumed run keeps its recorded settings; drop the conflicting flags or pass ${conflicts.join(" ")}`,
    );
  return {
    model: info.model,
    thinking: info.thinking,
    trials: info.trials,
    tasks: info.tasks,
    arms: info.arms,
  };
};

// One fresh Pi process per trial: no extension/skill/context-file discovery, an
// empty working directory, and its own session directory. Bun.spawn is used here
// instead of Bun.$ because the trial needs a hard timeout.
const runTrial = async (options: RunOptions, job: Job): Promise<TrialRecord> => {
  const dir = trialDir(options.runId, job.arm, job.task.id, job.trial);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const sessionDir = join(dir, "session");
  const cwd = mkdtempSync(join(tmpdir(), "rfc-eval-"));
  const { extensionArgs, env } = armSetup(job.arm);
  try {
    const proc = Bun.spawn(
      [
        piBinary,
        "-p",
        "-ne",
        "-ns",
        "-nc",
        "-np",
        ...extensionArgs,
        "--model",
        options.model,
        "--thinking",
        options.thinking,
        "--session-dir",
        sessionDir,
        job.task.prompt,
      ],
      {
        cwd,
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: Bun.file(join(dir, "stdout.txt")),
        stderr: Bun.file(join(dir, "stderr.txt")),
      },
    );
    const end = await waitWithTimeout(proc, options.trialTimeoutMs);
    const entries = readSession(sessionDir);
    const answer = entries === undefined ? undefined : extractAnswer(entries);
    const record: TrialRecord = {
      arm: job.arm,
      task: job.task.id,
      trial: job.trial,
      status: trialStatus({ ...end, hasAnswer: answer !== undefined }),
      exitCode: end.exitCode,
      metrics: (entries === undefined ? undefined : measure(entries)) ?? null,
      answer: answer ?? null,
    };
    writeJson(join(dir, "trial.json"), record);
    return record;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

// A trial that throws is recorded as an error so the rest of the run, and the
// Pi processes other workers are waiting on, carry on.
const runTrialSafely = async (options: RunOptions, job: Job): Promise<TrialRecord> => {
  try {
    return await runTrial(options, job);
  } catch (error) {
    const dir = trialDir(options.runId, job.arm, job.task.id, job.trial);
    mkdirSync(dir, { recursive: true });
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await Bun.write(join(dir, "harness-error.txt"), `${message}\n`);
    const record: TrialRecord = {
      arm: job.arm,
      task: job.task.id,
      trial: job.trial,
      status: "error",
      exitCode: null,
      metrics: null,
      answer: null,
    };
    writeJson(join(dir, "trial.json"), record);
    return record;
  }
};

/**
 * Runs every (arm, task, trial) in a fresh Pi process and writes `trial.json`
 * for each. With `resume`, trials that already finished with status `ok` are
 * kept; callers resolve the resumed settings with `resumeSettings` first.
 */
export const runSuite = async (
  options: RunOptions,
  resume: boolean,
): Promise<Array<TrialRecord>> => {
  const infoPath = join(runDir(options.runId), "run.json");
  if (!resume || readJson<RunInfo>(infoPath) === undefined)
    writeJson(infoPath, await runInfo(options));
  // Interleave arms per task and trial so drift over time (provider load, caches) hits both arms alike.
  const jobs: Array<Job> = [];
  for (let trial = 1; trial <= options.trials; trial++)
    for (const task of options.tasks)
      for (const arm of options.arms) jobs.push({ arm, task, trial });
  let done = 0;
  return pool(jobs, options.concurrency, async (job) => {
    const existing = resume
      ? readJson<TrialRecord>(
          join(trialDir(options.runId, job.arm, job.task.id, job.trial), "trial.json"),
        )
      : undefined;
    const record = existing?.status === "ok" ? existing : await runTrialSafely(options, job);
    done++;
    const m = record.metrics;
    console.log(
      `[${done}/${jobs.length}] ${job.arm} ${job.task.id} t${job.trial} ${record.status}` +
        (m === null
          ? ""
          : ` ${m.lat}s ${m.calls} calls ${m.out}KB $${(m.cost + m.ts).toFixed(4)}`) +
        (existing?.status === "ok" ? " (kept)" : ""),
    );
    return record;
  });
};
