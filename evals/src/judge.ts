import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piBinary } from "./paths";
import type { Verdict } from "./results";
import type { Task } from "./tasks";

/**
 * Judge settings.
 */
export type JudgeOptions = {
  model: string;
  thinking: string;
  timeoutMs: number;
};

/**
 * One claim's verdict with the judge's one-sentence reason and the call's cost.
 */
export type ClaimGrade = { verdict: Verdict; reason: string; cost: number };

/**
 * The prompt for grading one claim. Each claim gets its own isolated call so a
 * judgment on one claim cannot leak into another.
 */
export const judgePrompt = (task: Task, claim: number, answer: string): string =>
  [
    "You are grading one claim of an answer to a question about IETF RFCs.",
    "",
    "<question>",
    task.prompt,
    "</question>",
    "",
    "The answer key below was read from the canonical rfc-editor.org text. Its numbered items are the claims;",
    "notes outside the numbered items apply to every claim. Where the key names alternates (for example",
    '"also accepted" or "Added during grading"), each alternate counts as correct.',
    "",
    "<answer-key>",
    task.key.trim(),
    "</answer-key>",
    "",
    `Grade only claim ${claim}:`,
    "<claim>",
    task.claims[claim - 1],
    "</claim>",
    "",
    "Rules:",
    "- The claim is correct only if the answer states its value and cites an RFC and section the key accepts,",
    "  unless the key says a citation is not needed for that claim.",
    "- Require only what the question asked for. Detail the key adds as context (quoted wording, line numbers,",
    "  parenthetical explanations, related values the question did not ask about) is not required.",
    "- For a claim about which RFC is current, or which RFC obsoletes or is obsoleted by another, naming the right",
    "  RFC numbers is enough; any section or the RFC header is an acceptable citation.",
    "- A paraphrase counts when it means the same thing. Normative strength matters: SHOULD is not MUST.",
    "- An answer that declines, hedges without committing, or says it could not find the fact is incorrect.",
    "- Ignore other claims. Errors elsewhere in the answer only matter if the key says they do for this claim.",
    '- If you cannot decide from the answer and the key, use "unknown".',
    "",
    "<answer>",
    answer,
    "</answer>",
    "",
    'Reply with only a JSON object: {"verdict": "correct" | "incorrect" | "unknown", "reason": "<one sentence>"}',
  ].join("\n");

const verdicts: ReadonlyArray<Verdict> = ["correct", "incorrect", "unknown"];

/**
 * Extracts the verdict object from the judge's reply, or undefined when the
 * reply holds no valid one.
 */
export const parseVerdict = (text: string): { verdict: Verdict; reason: string } | undefined => {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
    if (!verdicts.includes(parsed.verdict as Verdict)) return undefined;
    return {
      verdict: parsed.verdict as Verdict,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return undefined;
  }
};

type JsonEvent = {
  type: string;
  messages?: Array<{
    role: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { cost?: { total?: number } };
  }>;
};

// Pi's JSON mode streams events; `agent_end` carries the whole conversation.
const finalReply = (stdout: string): { text: string; cost: number } => {
  const end = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as JsonEvent)
    .findLast((event) => event.type === "agent_end");
  const assistant = (end?.messages ?? []).filter((m) => m.role === "assistant");
  const text = (assistant.at(-1)?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const cost = assistant.reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0);
  return { text, cost };
};

const callJudge = async (
  options: JudgeOptions,
  prompt: string,
): Promise<{ text: string; cost: number } | undefined> => {
  const cwd = mkdtempSync(join(tmpdir(), "rfc-eval-judge-"));
  try {
    // Bun.spawn rather than Bun.$ for the hard timeout.
    const proc = Bun.spawn(
      [
        piBinary,
        "-p",
        "--mode",
        "json",
        "-nt",
        "-ne",
        "-ns",
        "-nc",
        "-np",
        "--no-session",
        "--model",
        options.model,
        "--thinking",
        options.thinking,
        prompt,
      ],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return undefined;
    return finalReply(stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

/**
 * Grades one claim of one answer, retrying once when the judge fails or replies
 * without a valid verdict. A second failure is recorded as `unknown`.
 */
export const gradeClaim = async (
  options: JudgeOptions,
  task: Task,
  claim: number,
  answer: string,
): Promise<ClaimGrade> => {
  const prompt = judgePrompt(task, claim, answer);
  let cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callJudge(options, prompt);
    cost += reply?.cost ?? 0;
    const parsed = reply === undefined ? undefined : parseVerdict(reply.text);
    if (parsed !== undefined) return { ...parsed, cost };
  }
  return { verdict: "unknown", reason: "judge failed to return a verdict twice", cost };
};
