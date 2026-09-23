import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evalsDir } from "./paths";

/**
 * One eval task: a prompt and the answer key its claims are graded against.
 */
export type Task = {
  /**
   * Directory name under `evals/tasks/`, such as `q7`.
   */
  id: string;
  /**
   * Full title shown in the report's prompt picker.
   */
  title: string;
  /**
   * Short label shown under per-task chart columns.
   */
  label: string;
  /**
   * Retrieval-difficulty factor ids; the report maps them to weights.
   */
  factors: ReadonlyArray<string>;
  /**
   * Prompt sent to the agent.
   */
  prompt: string;
  /**
   * Full answer key markdown, including notes that apply to every claim.
   */
  key: string;
  /**
   * Text of each numbered claim in the key, in order.
   */
  claims: ReadonlyArray<string>;
};

const tasksDir = join(evalsDir, "tasks");

/**
 * Splits an answer key into its top-level numbered claims. A claim runs from its
 * `N.` line through the indented or blank lines that follow it.
 */
export const parseClaims = (key: string): Array<string> => {
  const claims: Array<Array<string>> = [];
  let current: Array<string> | undefined;
  for (const line of key.split("\n")) {
    if (/^\d+\.\s/.test(line)) {
      current = [line];
      claims.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.trim() === "" || /^\s/.test(line)) {
      current.push(line);
      continue;
    }
    current = undefined;
  }
  return claims.map((lines) => lines.join("\n").trim());
};

const taskNumber = (id: string): number => Number(id.replace(/^\D+/, ""));

/**
 * Every task id under `evals/tasks/`, grouped by prefix and in numeric order.
 */
export const listTaskIds = (): Array<string> =>
  readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(
      (left, right) =>
        left.replace(/\d+$/, "").localeCompare(right.replace(/\d+$/, "")) ||
        taskNumber(left) - taskNumber(right),
    );

/**
 * Baseline tasks stay the default; recorded token-exchange queries are opt-in.
 */
export const listCohortTaskIds = (cohort: "baseline" | "token-exchange"): Array<string> =>
  listTaskIds().filter((id) => (cohort === "baseline" ? /^q\d+$/.test(id) : /^te\d+$/.test(id)));

/**
 * Loads one task from its directory.
 */
export const loadTask = (id: string): Task => {
  const dir = join(tasksDir, id);
  const meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as {
    title: string;
    label: string;
    factors: Array<string>;
  };
  const key = readFileSync(join(dir, "key.md"), "utf8");
  const claims = parseClaims(key);
  if (claims.length === 0) throw new Error(`evals/tasks/${id}/key.md has no numbered claims`);
  return {
    id,
    title: meta.title,
    label: meta.label,
    factors: meta.factors,
    prompt: readFileSync(join(dir, "prompt.md"), "utf8").trim(),
    key,
    claims,
  };
};

/**
 * Loads the given tasks, or every task when `ids` is undefined.
 */
export const loadTasks = (ids: ReadonlyArray<string> | undefined): Array<Task> =>
  (ids ?? listTaskIds()).map(loadTask);
