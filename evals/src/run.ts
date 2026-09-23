import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { type ArmId, armSetup } from "./arms";
import { evalsDir, piBinary, repoRoot } from "./paths";
import { pool } from "./pool";
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
  const startedAt = Date.now();
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
      timeout: options.trialTimeoutMs,
    },
  );
  const exitCode = await proc.exited;
  rmSync(cwd, { recursive: true, force: true });
  const timedOut = proc.signalCode !== null && Date.now() - startedAt >= options.trialTimeoutMs;
  const entries = readSession(sessionDir);
  const answer = entries === undefined ? undefined : extractAnswer(entries);
  const status: TrialStatus = timedOut
    ? "timeout"
    : exitCode !== 0
      ? "error"
      : answer === undefined
        ? "no-answer"
        : "ok";
  const record: TrialRecord = {
    arm: job.arm,
    task: job.task.id,
    trial: job.trial,
    status,
    exitCode: proc.signalCode === null ? exitCode : null,
    metrics: (entries === undefined ? undefined : measure(entries)) ?? null,
    answer: answer ?? null,
  };
  writeJson(join(dir, "trial.json"), record);
  return record;
};

/**
 * Runs every (arm, task, trial) in a fresh Pi process and writes `trial.json`
 * for each. With `resume`, trials that already finished with status `ok` are kept.
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
    const record = existing?.status === "ok" ? existing : await runTrial(options, job);
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
